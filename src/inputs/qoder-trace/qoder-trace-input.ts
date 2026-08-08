/**
 * Qoder 国际版 canonical Hook trace Input。
 *
 * BaseHookInput 读取 qoder trace JSONL，本类组合多种 TokenReader 进行 usage enrich，并使用
 * bootstrap turn 过滤保护历史重放。Orchestrator 在可用时优先于 SQLite/普通 Hook 输入。
 */
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
import { readSegmentTokensForSession } from './segment-token-reader.js';
import { readSqliteTokensForSession, isIdeaDbPath } from './sqlite-token-reader.js';
import { readInterceptData, type InterceptData } from './intercept-token-reader.js';
import { enrichCliTurn, enrichIdeTurn, injectTraceId } from './token-enricher.js';

export interface QoderTraceInputOptions extends InputOptions {
  logDir?: string;
}

/**
 * Qoder IDE、Qoder for JetBrains 与 Qoder CLI 的多来源合并 Input。
 *
 * Hook JSONL 提供内容和事件结构，CLI session segments 与 intercept 提供 CLI token，SQLite 提供
 * IDE token。本类按 turn/session 选择对应 enrich 策略，输出同时供 SLS 事件日志和 ARMS trace 转换。
 * 生命周期直接继承 BaseInput，因为采集周期需要协调多个来源而非只 tail 单一 Hook 文件。
 */
export class QoderTraceInput extends BaseInput {
  readonly id = 'qoder-trace';
  readonly agentType = ClientType.QoderCli;
  // 主来源是 Hook JSONL；session segments、intercept 和 SQLite 只为已有事件补充 token/模型等字段。
  readonly collectionMethod = CollectionMethod.HookJsonl;

  private readonly logDir: string;
  private readonly logPrefix = 'qoder';

  /** 保存状态存储、Hook 日志目录和轮询周期；构造时不打开文件或数据库。 */
  constructor(opts: QoderTraceInputOptions) {
    super({ ...opts, pollIntervalMs: opts.pollIntervalMs ?? 30_000 });
    this.logDir = opts.logDir ?? resolveHome('~/.loongsuite-pilot/logs/qoder/history');
  }

  /** 以 `~/.qoder` 是否存在判断 Qoder 系列是否可采集。 */
  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.qoder'));
  }

  /** 返回 Hook history 与 CLI session 两个发现路径。 */
  static getWatchPaths(): string[] {
    return [
      resolveHome('~/.loongsuite-pilot/logs/qoder/history'),
      resolveHome('~/.qoder/logs/sessions'),
    ];
  }

  /**
   * 创建日志目录并初始化安全启动 checkpoint：已有日志 baseline 到 EOF，新文件从 0 开始。
   * 这样安装或状态丢失后不会把历史 Hook 数据突然全部重放。
   */
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
   * 执行一次多来源采集：读取新 Hook 行、按 turn 分组、按变体 enrich，再注入稳定 trace_id。
   * 辅助来源读取失败时各 reader 会返回空结果，canonical Hook 事件仍可正常输出。
   */
  protected async collect(): Promise<AgentActivityEntry[]> {
    // 1. 先读取新的 canonical Hook JSONL；没有主事件时无需查询其他较昂贵的数据源。
    const rawEntries = await this.readHookJsonl();
    if (rawEntries.length === 0) return [];

    // 2. 按 turn.id 分组，保证 token 与 trace ID 在一次完整 turn 内统一处理。
    const turnGroups = this.groupByTurn(rawEntries);

    // 3. CLI 逐 turn enrich；IDE 先按 session 合并，使 SQLite request_id 顺序可直接对齐 Hook turn
    // 顺序，不依赖误差较大的时间戳 join。intercept 只在首次遇到 CLI turn 时惰性加载一次。
    let interceptData: InterceptData | null = null;
    const ideSessionGroups = new Map<string, AgentActivityEntry[]>();
    for (const [, turnEntries] of turnGroups) {
      const variant = this.inferTurnVariant(turnEntries);
      const sessionId = this.extractSessionId(turnEntries);

      if (variant === 'qoder-cli' && sessionId) {
        interceptData ??= await readInterceptData();
        const segments = await readSegmentTokensForSession(sessionId);
        enrichCliTurn(turnEntries, segments, interceptData.systemPrompt?.content);
      } else if ((variant === 'qoder' || variant === 'qoder-idea') && sessionId) {
        const sessionEntries = ideSessionGroups.get(sessionId) ?? [];
        sessionEntries.push(...turnEntries);
        ideSessionGroups.set(sessionId, sessionEntries);
      }
    }

    for (const [sessionId, sessionEntries] of ideSessionGroups) {
      const { rows: sqliteRows, matchedDbPath } = await readSqliteTokensForSession(sessionId);
      enrichIdeTurn(sessionEntries, sqliteRows);

      // Node.js < 22 的 Hook fallback 可能无法识别 qoder-idea。若整组仍标为 qoder，但 token 确实
      // 来自 IntelliJ 专用数据库，就把该 session 的 Agent 类型修正为 QoderIdea。
      const needsRelabel = sessionEntries.every(
        e => (e['gen_ai.agent.type'] as string) === ClientType.Qoder,
      );
      if (needsRelabel && isIdeaDbPath(matchedDbPath)) {
        for (const entry of sessionEntries) {
          entry['gen_ai.agent.type'] = ClientType.QoderIdea;
        }
      }
    }

    // 4. enrich 完成后再按 turn 注入 trace_id，使所有同 turn 事件落入同一条 trace。
    for (const turnEntries of turnGroups.values()) {
      injectTraceId(turnEntries);
    }

    return rawEntries;
  }

  // ─── Hook JSONL 读取：逻辑源自 BaseHookInput，但为多来源合并保留在本类。 ───

  /**
   * 按 StateStore offset 读取当天 Hook JSONL，逐行转换并执行 bootstrap 历史过滤。
   * 文件截断时 offset 归零；文件句柄通过 finally 关闭，坏行记录警告后继续。
   */
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
    let entries: AgentActivityEntry[] = [];
    try {
      // 当前不设 MAX_READ_BYTES：Hook JSONL 每日轮转且通常小于 100 KiB。若以后增加上限，必须把
      // 读取终点回退到最后一个换行，不能把一条 JSON 拆开后仍推进 offset。
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

    entries = filterBootstrapHistoryTurns(entries);

    return entries;
  }

  // ─── 记录转换：只接受 canonical schema，并补充 Git 上下文。 ───

  /** canonical 记录转换成功后异步补 Git 字段；旧/未知格式返回 null。 */
  private async transformRecord(record: Record<string, unknown>): Promise<AgentActivityEntry | null> {
    const canonicalEntry = buildCanonicalHookEntry(record, ClientType.QoderCli);
    if (canonicalEntry) {
      await enrichCanonicalEntryWithGit(canonicalEntry, record, 'qoder');
      return canonicalEntry;
    }
    return null;
  }

  // ─── turn 分组和 Qoder 变体识别。 ───

  /** 按 `gen_ai.turn.id` 保持输入顺序分组；旧记录缺 ID 时统一进入 unknown 组。 */
  private groupByTurn(entries: AgentActivityEntry[]): Map<string, AgentActivityEntry[]> {
    // unknown 会把缺少 turn.id 的旧记录合并；当前 Hook processor 始终写 turn.id，因此只影响历史数据。
    const groups = new Map<string, AgentActivityEntry[]>();
    for (const entry of entries) {
      const turnId = (entry['gen_ai.turn.id'] as string) || 'unknown';
      const group = groups.get(turnId) ?? [];
      group.push(entry);
      groups.set(turnId, group);
    }
    return groups;
  }

  /** 从 turn 内第一条可识别 agent.type 推断 enrich 分支，完全未知时兼容回退到 qoder-cli。 */
  private inferTurnVariant(entries: AgentActivityEntry[]): 'qoder-cli' | 'qoder' | 'qoder-idea' {
    for (const entry of entries) {
      const agentType = entry['gen_ai.agent.type'] as string;
      if (agentType === ClientType.QoderCli || agentType === 'qoder-cli') return 'qoder-cli';
      if (agentType === ClientType.QoderIdea || agentType === 'qoder-idea') return 'qoder-idea';
      if (agentType === ClientType.Qoder || agentType === 'qoder') return 'qoder';
    }
    return 'qoder-cli';
  }

  /** 返回 turn 中第一条非空 session ID，供 segment/SQLite 查询。 */
  private extractSessionId(entries: AgentActivityEntry[]): string | undefined {
    for (const entry of entries) {
      const sid = entry['gen_ai.session.id'] as string;
      if (sid) return sid;
    }
    return undefined;
  }
}
