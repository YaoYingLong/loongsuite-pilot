/** Qoder CN canonical Hook trace Input，包含 CN SQLite token enrich 与 bootstrap 历史保护。 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { resolveHome, directoryExists, ensureDir } from '../../utils/fs-utils.js';
import { getTodayDateString } from '../../utils/fs-utils.js';
import { buildCanonicalHookEntry } from '../base/canonical-hook-record.js';
import { filterBootstrapHistoryTurns } from '../base/bootstrap-turn-filter.js';
import { createHookHistoryStartupCheckpoint } from '../base/hook-history-checkpoint.js';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';
import { readSqliteTokensForSession } from './sqlite-token-reader.js';
import { enrichIdeTurn, injectTraceId } from '../qoder-trace/token-enricher.js';

export interface QoderCnTraceInputOptions extends InputOptions {
  logDir?: string;
}

/**
 * Qoder CN IDE 的多来源合并 Input。
 *
 * Hook JSONL 提供内容与结构，SQLite 提供 IDE token；按 session 合并后输出给 SLS 事件日志和 ARMS
 * trace 转换。本实现与国际版 qoder-trace-input 对齐：每周期立即返回事件，不跨周期缓冲完整 turn。
 * token enricher 对未匹配事件使用 token=0 的时间戳回退，保证下游仍能消费结构完整的事件。
 */
export class QoderCnTraceInput extends BaseInput {
  readonly id = 'qoder-cn-trace';
  readonly agentType = ClientType.QoderCn;
  readonly collectionMethod = CollectionMethod.HookJsonl;

  private readonly logDir: string;
  private readonly logPrefix = 'qoder-cn';

  // 该 Map 跨 collect 周期保留每个 session 最近的锚点 turn 及最大 step 序号，使后续没有用户输入的
  // orphan turn 可以合并回正确 turn；Input 实例停止后 Map 随实例释放，不写入持久化状态。
  private readonly sessionAnchor = new Map<string, { turnId: string; maxStep: number }>();

  /** 保存 StateStore、Hook 日志目录和轮询间隔，构造阶段不访问文件或 SQLite。 */
  constructor(opts: QoderCnTraceInputOptions) {
    super({ ...opts, pollIntervalMs: opts.pollIntervalMs ?? 30_000 });
    this.logDir = opts.logDir ?? resolveHome('~/.loongsuite-pilot/logs/qoder-cn/history');
  }

  /** 通过 `~/.qoder-cn` 是否存在判断 Qoder CN 是否可用。 */
  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.qoder-cn'));
  }

  /** 返回 Qoder CN Hook history 目录，供发现服务监听。 */
  static getWatchPaths(): string[] {
    return [
      resolveHome('~/.loongsuite-pilot/logs/qoder-cn/history'),
    ];
  }

  /** 创建日志目录并初始化不回放旧历史的启动 checkpoint。 */
  protected override async onStart(): Promise<void> {
    await ensureDir(this.logDir);
    const checkpoint = await createHookHistoryStartupCheckpoint(
      this.getState(),
      this.logDir,
      this.logPrefix,
    );
    if (!checkpoint) return;
    this.setState(checkpoint.state);
    if (checkpoint.skippedExistingBytes > 0) {
      this.logger.warn('history checkpoint missing, baselining existing file without replay', {
        skippedBytes: checkpoint.skippedExistingBytes,
      });
    } else {
      this.logger.info('history checkpoint initialized before first hook record');
    }
  }

  /**
   * 执行一次完整合并：读取 Hook、新旧 turn 合并、去重、按 session 查询 SQLite、后处理并排序输出。
   */
  protected async collect(): Promise<AgentActivityEntry[]> {
    const rawEntries = await this.readHookJsonl();
    if (rawEntries.length === 0) return [];

    const turnGroups = this.groupByTurn(rawEntries);

    // 跨周期 orphan 合并：没有用户输入边界的 turn 归到该 session 最近的锚点 turn。锚点可能在
    // 上一次 collect 已输出，因此必须使用实例级 sessionAnchor 记住 turn.id 和已用最大 step 序号。
    for (const [turnId, entries] of turnGroups) {
      const sessionId = this.extractSessionId(entries);
      if (!sessionId) continue;

      const hasUserInput = entries.some(e =>
        e['event.name'] === 'other' && e['gen_ai.input.messages_delta'],
      );

      if (hasUserInput) {
        // 含用户输入的是锚点 turn；记录其最大 step 序号，未来 orphan 从下一序号继续。
        let maxStep = 0;
        for (const e of entries) {
          const m = ((e['gen_ai.step.id'] as string) || '').match(/:s(\d+)$/);
          if (m) { const n = parseInt(m[1]); if (n > maxStep) maxStep = n; }
        }
        this.sessionAnchor.set(sessionId, { turnId, maxStep });
      } else {
        // orphan turn 只有在该 session 已有锚点时才重写；无锚点时保留原始 turn，避免错误猜测。
        const anchor = this.sessionAnchor.get(sessionId);
        if (!anchor) continue;

        // 先排序并去重 orphan step.id，使相同输入的重新编号结果确定、可测试。
        const orphanStepIds = [...new Set(
          entries.map(e => (e['gen_ai.step.id'] as string) || '').filter(Boolean),
        )].sort();

        const stepRemap = new Map<string, string>();
        for (const sid of orphanStepIds) {
          anchor.maxStep += 1;
          stepRemap.set(sid, `${anchor.turnId}:s${anchor.maxStep}`);
        }

        for (const e of entries) {
          e['gen_ai.turn.id'] = anchor.turnId;
          const sid = e['gen_ai.step.id'] as string | undefined;
          if (sid && stepRemap.has(sid)) {
            e['gen_ai.step.id'] = stepRemap.get(sid)!;
          }
        }
      }
    }

    // 上一步可能原地改写 turn.id，必须重新分组后才能做 turn 级去重和 trace 注入。
    const mergedGroups = this.groupByTurn(rawEntries);

    // enrich 前先去重，确保 enrichIdeTurn 只看到 canonical 事件。Hook processor 在 partial retry
    // 与最终 Stop 时可能重复写同一 turn；按 step/event/tool key 保留最后一条完整版本。
    for (const [, turnEntries] of mergedGroups) {
      dedupeEventsInTurn(turnEntries);
    }

    // 同 session 的所有 turn 合并查询，使 enrichIdeTurn 可用 SQLite request 顺序跨 turn 对齐 token，
    // 与国际版 qoder-trace-input 的 ideSessionGroups 策略一致。
    const ideSessionGroups = new Map<string, AgentActivityEntry[]>();
    const noSessionEntries: AgentActivityEntry[] = [];
    for (const [, turnEntries] of mergedGroups) {
      const sessionId = this.extractSessionId(turnEntries);
      if (sessionId) {
        const sessionEntries = ideSessionGroups.get(sessionId) ?? [];
        sessionEntries.push(...turnEntries);
        ideSessionGroups.set(sessionId, sessionEntries);
      } else {
        noSessionEntries.push(...turnEntries);
      }
    }

    for (const [sessionId, sessionEntries] of ideSessionGroups) {
      const sqliteRows = await readSqliteTokensForSession(sessionId);
      enrichIdeTurn(sessionEntries, sqliteRows);
      // token/时间 enrich 后，再修正容器时间、模型传播、工具耗时和用户边界。
      expandContainerTimes(sessionEntries);
      propagateModelToToolEvents(sessionEntries);
      computeToolCallDurations(sessionEntries);
      alignUserBoundaryToFirstLlmRequest(sessionEntries);
    }

    // 汇总有 session 的事件，随后重新按 turn 注入 trace_id。
    const allSessionEntries: AgentActivityEntry[] = [];
    for (const sessionEntries of ideSessionGroups.values()) {
      allSessionEntries.push(...sessionEntries);
    }

    const allTurnGroups = this.groupByTurn(allSessionEntries);
    for (const [, turnEntries] of allTurnGroups) {
      injectTraceId(turnEntries);
    }

    // 无 session 事件无法查 SQLite，但仍执行 turn 去重和 trace_id 注入。
    const noSessionTurnGroups = this.groupByTurn(noSessionEntries);
    for (const [, turnEntries] of noSessionTurnGroups) {
      dedupeEventsInTurn(turnEntries);
      injectTraceId(turnEntries);
    }

    // 输出时保证同 turn 连续。OTLP flusher 看到另一 turn 就会 flush 当前 turn；若交错排列，后续
    // 合成的 tool.result/llm.request 会被视为已 flush turn 的“迟到事件”而丢弃。
    const ordered: AgentActivityEntry[] = [];
    for (const [, turnEntries] of allTurnGroups) {
      ordered.push(...turnEntries);
    }
    for (const [, turnEntries] of noSessionTurnGroups) {
      ordered.push(...turnEntries);
    }
    return ordered;
  }

  // ─── Hook JSONL 增量读取。 ───

  /** 按 StateStore offset 读取当天日志，坏行隔离、句柄 finally 关闭，并过滤 bootstrap 历史 turn。 */
  private async readHookJsonl(): Promise<AgentActivityEntry[]> {
    const today = getTodayDateString();
    const logFileName = `${this.logPrefix}-${today}.jsonl`;
    const logFile = path.join(this.logDir, logFileName);

    let stat;
    try {
      stat = await fs.stat(logFile);
    } catch {
      return [];
    }

    const state = this.getState();
    let offset = state.lastFile === logFileName ? (state.lastOffset ?? 0) : 0;

    if (offset > 0 && stat.size < offset) {
      this.logger.info('file truncated, resetting offset', { file: logFile, recorded: offset, actual: stat.size });
      offset = 0;
    }
    if (stat.size <= offset) return [];

    const handle = await fs.open(logFile, 'r');
    const entries: AgentActivityEntry[] = [];
    try {
      const buf = Buffer.alloc(stat.size - offset);
      await handle.read(buf, 0, buf.length, offset);
      const text = buf.toString('utf-8');
      this.setState({ lastFile: logFileName, lastOffset: stat.size });

      const lines = text.split('\n').filter(l => l.trim().length > 0);

      for (const line of lines) {
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          const entry = await this.transformRecord(record);
          if (entry) entries.push(entry);
        } catch (err) {
          this.logger.warn('invalid JSONL line', { error: String(err) });
        }
      }
    } finally {
      await handle.close();
    }

    return filterBootstrapHistoryTurns(entries);
  }

  // ─── canonical 记录转换与 Git enrich。 ───

  /** 将 canonical Hook record 转成 QoderCn 标准事件，未知格式返回 null。 */
  private async transformRecord(record: Record<string, unknown>): Promise<AgentActivityEntry | null> {
    const canonicalEntry = buildCanonicalHookEntry(record, ClientType.QoderCn);
    if (canonicalEntry) {
      await enrichCanonicalEntryWithGit(canonicalEntry, record, 'qodercn');
      return canonicalEntry;
    }
    return null;
  }

  // ─── turn/session 分组辅助。 ───

  /** 按 turn.id 保持输入顺序分组，缺失 ID 的旧事件统一使用 unknown。 */
  private groupByTurn(entries: AgentActivityEntry[]): Map<string, AgentActivityEntry[]> {
    const groups = new Map<string, AgentActivityEntry[]>();
    for (const entry of entries) {
      const turnId = (entry['gen_ai.turn.id'] as string) || 'unknown';
      const group = groups.get(turnId) ?? [];
      group.push(entry);
      groups.set(turnId, group);
    }
    return groups;
  }

  /** 返回 turn 中第一条非空 session ID。 */
  private extractSessionId(entries: AgentActivityEntry[]): string | undefined {
    for (const entry of entries) {
      const sid = entry['gen_ai.session.id'] as string;
      if (sid) return sid;
    }
    return undefined;
  }
}

/**
 * 按 `(step_id, event_name, tool_call_id)` 原地去重单个 turn。
 *
 * Hook processor 可能先写 partial retry，之后 Stop 重试又写完整 turn；倒序删除时保留每个 key
 * 最后一条，也就是通常更完整的新版本。此函数会修改传入数组。
 */
function dedupeEventsInTurn(entries: AgentActivityEntry[]): void {
  const seen = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const stepId = (e['gen_ai.step.id'] as string) || '';
    const eventName = e['event.name'] as string;
    const toolCallId = (e['gen_ai.tool.call.id'] as string) || '';
    const key = `${stepId}|${eventName}|${toolCallId}`;
    seen.set(key, i);
  }

  const keepIndices = new Set(seen.values());
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!keepIndices.has(i)) {
      entries.splice(i, 1);
    }
  }
}

/**
 * 把 `other` 用户边界事件对齐到同 turn 的第一个 llm.request。
 *
 * 时间改为 request 时间可去掉导致转换器插入空 STEP 的 1ms 间隙；补上 step.id 可避免转换器为
 * 无 step 事件创建 0ms 空容器并触发“STEP 没有 LLM 子节点”校验错误。同时传播真实模型/provider。
 */
function alignUserBoundaryToFirstLlmRequest(entries: AgentActivityEntry[]): void {
  const byTurn = new Map<string, AgentActivityEntry[]>();
  for (const e of entries) {
    const tid = (e['gen_ai.turn.id'] as string) || '';
    if (!tid) continue;
    const list = byTurn.get(tid) ?? [];
    list.push(e);
    byTurn.set(tid, list);
  }
  for (const list of byTurn.values()) {
    const firstReq = list.find(e => e['event.name'] === 'llm.request' && e['gen_ai.step.id']);
    if (!firstReq || !firstReq.time_unix_nano) continue;
    for (const e of list) {
      if (e['event.name'] === 'other' && !e['gen_ai.step.id']) {
        e.time_unix_nano = firstReq.time_unix_nano;
        e['gen_ai.step.id'] = firstReq['gen_ai.step.id'];
        // 使用真实 LLM request 的模型，让用户边界事件不再显示 unknown。
        if (firstReq['gen_ai.request.model'] && firstReq['gen_ai.request.model'] !== 'unknown') {
          e['gen_ai.request.model'] = firstReq['gen_ai.request.model'];
          e['gen_ai.response.model'] = firstReq['gen_ai.request.model'];
        }
        if (firstReq['gen_ai.provider.name'] && firstReq['gen_ai.provider.name'] !== 'unknown') {
          e['gen_ai.provider.name'] = firstReq['gen_ai.provider.name'];
        }
      }
    }
  }
}

/**
 * 把同 step 的 llm.response 模型/provider 传播到 model 为 unknown 的 tool.call/tool.result。
 * Hook processor 生成工具事件时看不到 LLM 模型，但相同 step_id 明确表示它们属于同一次响应波次。
 */
function propagateModelToToolEvents(entries: AgentActivityEntry[]): void {
  const byStep = new Map<string, AgentActivityEntry[]>();
  for (const e of entries) {
    const sid = (e['gen_ai.step.id'] as string) || '';
    if (!sid) continue;
    const list = byStep.get(sid) ?? [];
    list.push(e);
    byStep.set(sid, list);
  }

  for (const list of byStep.values()) {
    const resp = list.find(e => e['event.name'] === 'llm.response');
    if (!resp) continue;
    const model = resp['gen_ai.request.model'] as string | undefined;
    const respModel = resp['gen_ai.response.model'] as string | undefined;
    const provider = resp['gen_ai.provider.name'] as string | undefined;
    if (!model || model === 'unknown') continue;

    for (const e of list) {
      if (e['event.name'] !== 'tool.call' && e['event.name'] !== 'tool.result') continue;
      const curModel = e['gen_ai.request.model'] as string | undefined;
      if (!curModel || curModel === 'unknown') {
        e['gen_ai.request.model'] = model;
        if (respModel && respModel !== 'unknown') e['gen_ai.response.model'] = respModel;
        if (provider && provider !== 'unknown') e['gen_ai.provider.name'] = provider;
      }
    }
  }
}

/**
 * 按 `(step_id, tool.call.id)` 配对 call/result，用纳秒时间差计算毫秒级工具耗时。
 * 时间无效、找不到配对或结果早于调用时保持原字段不变。
 */
function computeToolCallDurations(entries: AgentActivityEntry[]): void {
  // 先建立工具调用开始时间索引，BigInt 可避免纳秒时间戳超出安全整数范围。
  const callTimes = new Map<string, bigint>();
  for (const e of entries) {
    if (e['event.name'] !== 'tool.call') continue;
    const sid = (e['gen_ai.step.id'] as string) || '';
    const callId = (e['gen_ai.tool.call.id'] as string) || '';
    const t = e.time_unix_nano;
    if (typeof t !== 'string') continue;
    try { callTimes.set(`${sid}|${callId}`, BigInt(t)); } catch { /* 跳过无效纳秒字符串。 */ }
  }

  // 再遍历结果，从索引中找相同 step/callId 的开始时间。
  for (const e of entries) {
    if (e['event.name'] !== 'tool.result') continue;
    const sid = (e['gen_ai.step.id'] as string) || '';
    const callId = (e['gen_ai.tool.call.id'] as string) || '';
    const resultTimeStr = e.time_unix_nano;
    if (typeof resultTimeStr !== 'string') continue;
    const callTime = callTimes.get(`${sid}|${callId}`);
    if (callTime === undefined) continue;
    let resultTime: bigint;
    try { resultTime = BigInt(resultTimeStr); } catch { continue; }
    const durationNs = resultTime - callTime;
    if (durationNs < 0n) continue;
    // 整数除法把纳秒转换为毫秒，小于 1ms 的部分按 schema 精度舍去。
    e['gen_ai.tool.call.duration'] = Number(durationNs / 1_000_000n);
  }
}

/**
 * 将容器类事件时间扩展到所在 turn 的最大时间，确保派生 ENTRY/AGENT span 覆盖最后一个子 STEP。
 *
 * 转换器从事件时间推导容器边界；若数组最后事件反而更早，容器可能得到 0 duration。LLM、工具和
 * `other` 的时间具有真实 start/end 语义，不能移动；这里只调整未来可能出现的其他容器类事件。
 */
function expandContainerTimes(entries: AgentActivityEntry[]): void {
  const ms = (e: AgentActivityEntry): bigint => {
    const v = e.time_unix_nano;
    try { return typeof v === 'string' ? BigInt(v) : BigInt(0); } catch { return BigInt(0); }
  };

  const byTurn = new Map<string, AgentActivityEntry[]>();
  for (const e of entries) {
    const tid = (e['gen_ai.turn.id'] as string) || '';
    if (!tid) continue;
    const list = byTurn.get(tid) ?? [];
    list.push(e);
    byTurn.set(tid, list);
  }
  for (const list of byTurn.values()) {
    let max = BigInt(0);
    for (const e of list) {
      const t = ms(e);
      if (t > max) max = t;
    }
    for (const e of list) {
      // llm.request/response 是 LLM span 起止，tool.call/result 是 TOOL span 起止；移动会改变真实耗时。
      // other 是 step-1 用户边界，enrichIdeTurn 用它作为 request 时间；移到 turn 末尾会让 LLM 耗时归零。
      const name = e['event.name'] as string;
      if (name === 'llm.request' || name === 'llm.response' || name === 'tool.call' || name === 'tool.result' || name === 'other') continue;
      if (ms(e) < max) {
        e.time_unix_nano = max.toString();
      }
    }
  }
}
