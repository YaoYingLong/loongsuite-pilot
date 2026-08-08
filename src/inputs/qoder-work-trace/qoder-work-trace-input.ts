/**
 * 国际版 Qoder Work 当前主 Trace Input：以 Hook canonical JSONL 为结构，叠加多种 enrich 源。
 *
 * Orchestrator 直接从本目录导入 `QoderWorkTraceInput`，注册 ID `qoder-work-trace`；启用时关闭
 * 国际版 Hook/SDK Log/SQLite 三个回退 Input。另一个同名类位于 `qoder-work-log` 目录，当前仅以
 * `QoderWorkCNTraceInput` 别名服务 CN。两者没有继承/委托关系；历史上保留同名实现的原因待确认。
 *
 * 数据优先级：Hook processor JSONL 决定 turn/step/消息/工具结构；session segments 决定精确
 * LLM/工具时序、模型和 token；runtime intercept 在 segment token 缺失时补 token，并提供 system
 * prompt；旧 SDK 日志只作为最后 token fallback。每个 turn 再补 Git 上下文和共享 trace_id，输出
 * `AgentActivityEntry[]` 给 InputManager。StateStore 保存 Hook/segments/SDK 各文件 byte offset 与
 * inode；内存配对状态有一小时 TTL。所有 I/O 都是只读增量文件访问，无网络和子进程，句柄在
 * finally 中关闭；单行坏 JSON 只告警，不中断其他行。
 */
// 内置模块分别用于 trace ID、异步文件 I/O 和跨平台路径。
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
// 产品类型和采集方式用于 discovery/监控；事件类型描述标准输出。
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
// 本类直接继承 BaseInput，自行管理多个不同格式的文件游标和跨行状态机。
import { BaseInput, type InputOptions } from '../base/base-input.js';
// 冷启动 helpers 防止 StateStore 丢失后回灌旧 Hook history。
import { filterBootstrapHistoryTurns } from '../base/bootstrap-turn-filter.js';
import { createHookHistoryStartupCheckpoint } from '../base/hook-history-checkpoint.js';
// canonical 记录完成 enrich 后再进入 InputManager；Git helper 根据 cwd 补仓库/分支信息。
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';
import { resolveHome, directoryExists, ensureDir } from '../../utils/fs-utils.js';
import { getTodayDateString } from '../../utils/fs-utils.js';
// 复用 SDK 日志 parser，仅提取旧版本 token fallback；不使用其模型/时序。
import {
  parseSdkLogLine,
  resolveQoderWorkRoot,
  type SdkEvent,
} from '../qoder-work-log/qoder-work-log-input.js';
// runtime wrapper intercept 文件提供 provider response ID 对应 token 和 system prompt。
import { readInterceptFile, getInterceptFile, type InterceptData, type InterceptTokenData } from '../qoder-trace/intercept-token-reader.js';

/** 纳秒/毫秒换算常量，以及配对容差和内存状态 TTL。 */
const NANO_PER_MILLI = 1_000_000n;
// segment 与 Hook 时序允许 5 分钟偏差；SDK token fallback 只允许 5 秒邻近匹配。
const SEGMENT_TIMING_TOLERANCE_MS = 5 * 60 * 1000;
const SDK_TOKEN_MATCH_TOLERANCE_MS = 5 * 1000;
const SEGMENT_STATE_TTL_MS = 60 * 60 * 1000;

/**
 * Qoder Work 国际版 Hook JSONL + segments enrich 输入。
 *
 * 处理流程：
 *   1. Hook JSONL 提供 event 顺序、turn/step ID 和 message delta；
 *   2. `~/.qoderwork/logs/sessions/<工作区>/<session>/segments` 提供精确时序、模型和 usage；
 *   3. 每 session 以 turn ID 优先、时间容差兜底，把 request/response 与 segment LLM 对配对；
 *   4. intercept/SDK 补 token，system prompt 与 Git 上下文 enrich，最后注入 turn 级 trace_id。
 *
 * Hook transcript 只含主 Agent 对话，因此 segment 中显式 subagent 和 memory-sink turn 必须过滤，
 * 否则 FIFO 会错配。生命周期由 BaseInput 管理；本类没有类级外部资源需要 onStop 释放。
 */
export class QoderWorkTraceInput extends BaseInput {
  /** Orchestrator/listener/StateStore 使用的固定国际版 ID。 */
  readonly id = 'qoder-work-trace';
  readonly agentType = ClientType.QoderWork;
  readonly collectionMethod = CollectionMethod.HookJsonl;

  /** 主 Hook 日志、segment 根、SDK fallback 日志和 runtime intercept 文件。 */
  private readonly logDir: string;
  private readonly segmentsRoot: string;
  private readonly sdkLogDir: string;
  private readonly interceptFile: string;
  private readonly logPrefix = 'qoder-work';

  // 每 session 的主 Agent segment LLM 完成对，按观察顺序保留，等待 Hook STEP 消费。
  private readonly segmentPairs: Map<string, SegmentLlmPair[]> = new Map();
  // 每 session 的工具精确时序，以 tool_call_id 为键。
  private readonly segmentToolTimings: Map<string, Map<string, SegmentToolTiming>> = new Map();
  // 已确认是 subagent 的 turn_id 及最近观察时间；缺席视为主 Agent，以兼容 turn.started 跨文件。
  private readonly subagentTurns: Map<string, Map<string, number>> = new Map();
  // 已看到 model.request.started、尚未看到 completed 的在途 LLM 请求。
  private readonly inFlightPairs: Map<string, Map<string, InFlightPair>> = new Map();
  // 旧 SDK fallback 仅补 token，绝不能覆盖 segment 的模型或时序。
  private readonly sdkTokenPairs: Map<string, SdkTokenPair[]> = new Map();
  private readonly sdkInFlightMessages: Map<string, SdkInFlightMessage> = new Map();
  // 工作区编码路径是快速路径；session ID 全目录搜索兼容 writer 编码变化和非 POSIX 路径。
  private readonly segmentDirBySession: Map<string, CachedSegmentDir> = new Map();

  /**
   * 保存可覆盖数据路径，并设置默认 30 秒轮询。
   * @param opts Orchestrator 注入的 StateStore；测试可覆盖四类文件位置和轮询周期。
   */
  constructor(opts: QoderWorkTraceInputOptions) {
    super({ ...opts, pollIntervalMs: opts.pollIntervalMs ?? 30_000 });
    this.logDir = opts.logDir ?? resolveHome('~/.loongsuite-pilot/logs/qoder-work/history');
    this.segmentsRoot = opts.segmentsRoot ?? resolveHome('~/.qoderwork/logs/sessions');
    this.sdkLogDir = opts.sdkLogDir ?? resolveQoderWorkSdkLogDir();
    this.interceptFile = opts.interceptFile ?? getInterceptFile('qoderwork-intercept.jsonl');
  }

  /**
   * 检查国际版 `~/.qoderwork` 是否存在。
   * @returns 目录存在为 true；异常由 directoryExists 折叠为 false。
   */
  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.qoderwork'));
  }

  /** 返回 Hook history 和 session segments 两个 discovery watch path。 */
  static getWatchPaths(): string[] {
    return [
      resolveHome('~/.loongsuite-pilot/logs/qoder-work/history'),
      resolveHome('~/.qoderwork/logs/sessions'),
    ];
  }

  /**
   * 创建 Hook history 目录并建立首启 checkpoint。
   *
   * 无状态且文件已有内容时 baseline 到现有末尾，避免重放旧 daemon 已发送历史；文件为空时从 0
   * 等待首条 Hook。checkpoint 只更新内存 StateStore，BaseInput 周期末负责实际保存。
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
   * 单轮总控：读取 fallback token -> Hook 主结构 -> 相关 segment -> enrich/group/Git/trace。
   *
   * 同一 Input 的 collect 由 BaseInput 保证不重入。finally 总会清理一小时以上的内存配对状态，
   * 即使某个文件操作抛错也不会让 Map 无限增长。
   *
   * @returns 按 Hook 原顺序分组展开的所有新 turn 事件。
   */
  protected async collect(): Promise<AgentActivityEntry[]> {
    try {
      // 先更新旧 SDK token 缓冲；segment 仍是模型和 LLM/工具时序的权威来源。
      await this.readSdkTokenState();

      // 第一步：读取 Hook JSONL 主结构并推进其 checkpoint。
      const rawEntries = await this.readHookJsonl();
      if (rawEntries.length === 0) return [];

      const entries = filterBootstrapHistoryTurns(rawEntries);

      // 第二步：只为本批出现的 session/cwd 懒加载新 segments，避免扫描无关会话。
      const sessionCwd = this.collectSessionCwd(entries);
      for (const [sessionId, cwd] of sessionCwd) {
        await this.readSegmentsForSession(sessionId, cwd);
      }

      // 第三步：按 turn 分组，保证每组共用 trace_id 且 enrich 不跨 turn。
      const turnGroups = this.groupByTurn(entries);
      // intercept 是 segment token 全 0 时的 fallback，并携带 system prompt；每个非空周期只读一次。
      let interceptData: InterceptData | null = null;
      const allEntries: AgentActivityEntry[] = [];
      for (const [, turnEntries] of turnGroups) {
        interceptData ??= await this.readInterceptData();
        this.enrichTurn(turnEntries, interceptData);
        this.injectTraceId(turnEntries);
        // Git enrich 可能访问仓库文件；逐事件 await，保持输出顺序和错误边界一致。
        for (const entry of turnEntries) {
          await enrichCanonicalEntryWithGit(
            entry as Record<string, unknown>,
            entry as Record<string, unknown>,
            'qoder-work',
          );
        }
        allEntries.push(...turnEntries);
      }
      return allEntries;
    } finally {
      this.evictStaleState();
    }
  }

  // ─── Hook JSONL 主结构读取 ─────────────────────────────────────────────────

  /**
   * 增量读取今天的 canonical Hook history JSONL。
   *
   * 使用 Input 自身 lastFile/lastOffset；文件 truncate 时归零。单轮最多 16 MiB，达到上限只消费
   * 到最后完整换行。offset 在解析前推进，因此坏 JSON 行只告警并永久跳过，不会卡住后续数据。
   * 文件句柄始终在 finally 中关闭。
   *
   * @returns 含 event.name 的原始 canonical 事件；文件不存在或无新增字节时为空。
   */
  private async readHookJsonl(): Promise<AgentActivityEntry[]> {
    // Hook writer 按本地日期轮转；文件名必须与 qoder-work processor 前缀一致。
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

    // size 回退表示 truncate/替换，旧 offset 已无效。
    if (offset > 0 && stat.size < offset) {
      this.logger.info('file truncated, resetting offset', { file: logFile });
      offset = 0;
    }
    if (stat.size <= offset) return [];

    const handle = await fs.open(logFile, 'r');
    const entries: AgentActivityEntry[] = [];
    try {
      const maxReadSize = 16 * 1024 * 1024;
      const readSize = Math.min(stat.size - offset, maxReadSize);
      const buf = Buffer.alloc(readSize);
      await handle.read(buf, 0, readSize, offset);
      let text = buf.toString('utf-8');
      let consumedBytes = readSize;
      // 读满上限时保留末尾半行，下轮从最后完整换行后续读。
      if (readSize < stat.size - offset) {
        const lastNL = text.lastIndexOf('\n');
        if (lastNL >= 0) { text = text.substring(0, lastNL); consumedBytes = Buffer.byteLength(text, 'utf-8') + 1; }
      }
      this.setState({ lastFile: logFileName, lastOffset: offset + consumedBytes });

      // 单行 parse 失败不抛出到整轮；没有 event.name 的辅助记录不进入 Trace。
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as AgentActivityEntry;
          if (record['event.name']) entries.push(record);
        } catch {
          this.logger.warn('invalid JSONL line');
        }
      }
    } finally {
      await handle.close();
    }

    return entries;
  }

  // ─── Session segments enrich 读取 ──────────────────────────────────────────

  /**
   * 从 Hook 批次提取唯一 sessionId -> cwd 映射，供定位 segments 目录。
   * 同 session 后续重复事件不会覆盖第一条 cwd。
   */
  private collectSessionCwd(entries: AgentActivityEntry[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const e of entries) {
      const sid = e['gen_ai.session.id'] as string | undefined;
      const cwd = e['agent.qoderwork.cwd'] as string | undefined;
      if (sid && cwd && !map.has(sid)) map.set(sid, cwd);
    }
    return map;
  }

  /**
   * 将 macOS Qoder Work 1.0.21 的 cwd 编码为 session 目录名，作为快速定位路径。
   * 后续仍会按 session ID 全目录搜索，避免 writer/平台编码变化静默禁用 enrich。
   * @param cwd 原始工作目录。
   * @returns 把 `/` 和 `.` 替换为 `-` 的目录名。
   */
  private encodeWorkspace(cwd: string): string {
    return cwd.replace(/\//g, '-').replace(/\./g, '-');
  }

  /**
   * 定位一个 session 的 segments 目录，按文件名时间顺序增量读取所有 JSONL。
   * @param sessionId Hook 记录中的 session ID。
   * @param cwd 用于首选工作区编码路径。
   */
  private async readSegmentsForSession(sessionId: string, cwd: string): Promise<void> {
    const segDir = await this.resolveSegmentsDir(sessionId, cwd);
    if (!segDir) return;

    let files: string[];
    try {
      const dirEntries = await fs.readdir(segDir, { withFileTypes: true });
      files = dirEntries
        .filter(d => d.isFile() && d.name.endsWith('.jsonl'))
        .map(d => path.join(segDir, d.name))
        .sort(); // 文件名以 ISO 时间开头，因此字典序即时间序。
    } catch {
      return; // session 的 segments 目录可能尚未创建，等待下轮。
    }

    for (const filePath of files) {
      await this.readSegmentsFile(sessionId, filePath);
    }
  }

  /**
   * 解析 session segments 目录：缓存 -> 编码 cwd 快速路径 -> 遍历工作区目录。
   * @returns 存在的 segments 目录；根目录不可读或未命中时 undefined。
   */
  private async resolveSegmentsDir(sessionId: string, cwd: string): Promise<string | undefined> {
    const cached = this.segmentDirBySession.get(sessionId);
    if (cached) {
      cached.seenAtMs = Date.now();
      return cached.path;
    }

    // 先试当前已知 writer 的编码规则，避免每轮 O(工作区数) 扫描。
    const preferred = path.join(this.segmentsRoot, this.encodeWorkspace(cwd), sessionId, 'segments');
    if (await isDirectory(preferred)) {
      this.segmentDirBySession.set(sessionId, { path: preferred, seenAtMs: Date.now() });
      return preferred;
    }

    let workspaceDirs: import('node:fs').Dirent[];
    try {
      workspaceDirs = await fs.readdir(this.segmentsRoot, { withFileTypes: true });
    } catch {
      return undefined;
    }

    // fallback 仅比较固定 session 子路径，不解析工作区目录名本身。
    for (const workspaceDir of workspaceDirs) {
      if (!workspaceDir.isDirectory()) continue;
      const candidate = path.join(this.segmentsRoot, workspaceDir.name, sessionId, 'segments');
      if (await isDirectory(candidate)) {
        this.segmentDirBySession.set(sessionId, { path: candidate, seenAtMs: Date.now() });
        return candidate;
      }
    }
    return undefined;
  }

  /**
   * 按独立 state key 增量读取一个 segment JSONL 文件并驱动配对状态机。
   * inode 变化和 truncate 都归零；单轮最多 16 MiB 并保留半行。坏 JSON 只跳过当前行。
   */
  private async readSegmentsFile(sessionId: string, filePath: string): Promise<void> {
    const fileStateKey = `${this.id}:seg:${filePath}`;

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return;
    }

    const prevState = this.stateStore.get(fileStateKey);
    const prevInode = (prevState.extra as { inode?: number } | undefined)?.inode;
    const currentInode = (stat as unknown as { ino: number }).ino;

    // 文件路径复用但 inode 改变时，从新文件头重新消费。
    if (prevInode !== undefined && prevInode !== currentInode) {
      this.stateStore.setOffset(fileStateKey, 0);
      this.stateStore.update(fileStateKey, { extra: { inode: currentInode } });
    } else if (prevInode === undefined) {
      this.stateStore.update(fileStateKey, { extra: { inode: currentInode } });
    }

    let offset = this.stateStore.getOffset(fileStateKey);
    if (offset > 0 && stat.size < offset) offset = 0; // 文件被截断时重置游标。
    if (stat.size <= offset) return;

    const handle = await fs.open(filePath, 'r');
    try {
      const maxReadSize = 16 * 1024 * 1024;
      const readSize = Math.min(stat.size - offset, maxReadSize);
      const buf = Buffer.alloc(readSize);
      await handle.read(buf, 0, readSize, offset);
      let text = buf.toString('utf-8');

      let consumedBytes = readSize;
      // 只提交完整 JSONL 行，残片留到下一轮继续读取。
      if (readSize < stat.size - offset) {
        const lastNL = text.lastIndexOf('\n');
        if (lastNL >= 0) { text = text.substring(0, lastNL); consumedBytes = Buffer.byteLength(text, 'utf-8') + 1; }
      }
      this.stateStore.setOffset(fileStateKey, offset + consumedBytes);
      this.stateStore.update(fileStateKey, { extra: { inode: currentInode } });

      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as SegmentEvent;
          this.handleSegmentEvent(sessionId, event);
        } catch {
          this.logger.warn('invalid segments JSONL line');
        }
      }
    } finally {
      await handle.close();
    }
  }

  /**
   * Segment 事件配对状态机。
   *
   * turn.started 标记 subagent；model request/completed 以 request_id 配对；tool requested/finished
   * 以 call ID 配对。时间转成纳秒字符串，完成对进入 session 缓冲等待 Hook STEP 消费。
   *
   * @param sessionId 当前 segments 目录所属 session。
   * @param event 单行 JSON 解析结果；字段缺失时对应分支直接忽略。
   */
  private handleSegmentEvent(sessionId: string, event: SegmentEvent): void {
    const seenAtMs = Date.now();
    switch (event.type) {
      case 'turn.started': {
        // is_subagent 或固定 memory-sink 前缀都表示不应与主 Hook transcript 配对。
        if (event.turn_id && (event.data?.is_subagent === true || isIgnoredSegmentTurn(event.turn_id))) {
          const turns = this.subagentTurns.get(sessionId) ?? new Map<string, number>();
          turns.set(event.turn_id, seenAtMs);
          this.subagentTurns.set(sessionId, turns);
        }
        return;
      }
      case 'model.request.started': {
        if (!event.turn_id || !event.request_id || !event.ts) return;
        // Hook transcript 只含主 Agent，因此必须过滤 subagent LLM 请求。
        if (this.shouldSkipSegmentTurn(sessionId, event.turn_id)) return;
        const startNano = isoToNano(event.ts);
        if (!startNano) return;
        // request_id 在一个 session 内定位在途调用；response 到达时移除。
        let m = this.inFlightPairs.get(sessionId);
        if (!m) { m = new Map(); this.inFlightPairs.set(sessionId, m); }
        m.set(event.request_id, {
          turnId: event.turn_id,
          startNano,
          model: event.data?.model || '',
          seenAtMs,
        });
        return;
      }
      case 'model.response.completed': {
        if (!event.turn_id || !event.request_id || !event.ts) return;
        if (this.shouldSkipSegmentTurn(sessionId, event.turn_id)) return;
        const inFlightForSession = this.inFlightPairs.get(sessionId);
        const inFlight = inFlightForSession?.get(event.request_id);
        if (!inFlight) return; // Collector 中途启动时可能只看到孤立 response，无法可靠配对。
        inFlightForSession!.delete(event.request_id);
        const endNano = isoToNano(event.ts);
        if (!endNano) return;
        // 完成对保留观察顺序；enrich 时优先 turn ID，再按时间容差选择。
        const list = this.segmentPairs.get(sessionId) ?? [];
        list.push({
          turnId: inFlight.turnId,
          startNano: inFlight.startNano,
          endNano,
          model: event.data?.model || inFlight.model || '',
          usage: extractSegmentUsage(event.data),
          seenAtMs,
        });
        this.segmentPairs.set(sessionId, list);
        return;
      }
      case 'tool.requested':
      case 'tool.execution.finished': {
        if (!event.turn_id || !event.tool_call_id || !event.ts) return;
        if (this.shouldSkipSegmentTurn(sessionId, event.turn_id)) return;
        const nano = isoToNano(event.ts);
        if (!nano) return;
        const timings = this.segmentToolTimings.get(sessionId) ?? new Map<string, SegmentToolTiming>();
        // requested/finished 可跨行到达，复用同一可变 timing 槽位逐步补齐。
        const existing = timings.get(event.tool_call_id) ?? { turnId: event.turn_id, seenAtMs };
        existing.turnId = event.turn_id;
        existing.seenAtMs = seenAtMs;
        if (event.data?.tool_name) existing.toolName = String(event.data.tool_name);
        if (event.type === 'tool.requested') {
          existing.requestedNano = nano;
        } else {
          existing.finishedNano = nano;
        }
        timings.set(event.tool_call_id, existing);
        this.segmentToolTimings.set(sessionId, timings);
        return;
      }
      default:
        return;
    }
  }

  /** 判断 segment turn 是否属于固定内部任务或已知 subagent。 */
  private shouldSkipSegmentTurn(sessionId: string, turnId: string): boolean {
    return isIgnoredSegmentTurn(turnId) || this.subagentTurns.get(sessionId)?.has(turnId) === true;
  }

  // ─── Turn 数据补全 ──────────────────────────────────────────────────────────

  /**
   * 原地 enrich 一个 Hook turn 的各 STEP。
   *
   * segment 覆盖 request/response 时序、真实模型和 usage；token 缺失时按 intercept response ID，
   * 再按 SDK 请求时间 fallback。intercept 还把 system prompt 挂到首个有 step ID 的 request。
   * 最后修正跨 STEP 工具结果时间。该方法只改事件字段，不创建或删除 Hook 事件。
   *
   * @param entries 同一 gen_ai.turn.id 的 canonical Hook 事件数组。
   * @param interceptData 本轮只读一次的 runtime intercept 快照。
   */
  private enrichTurn(entries: AgentActivityEntry[], interceptData: InterceptData): void {
    const sessionId = entries.find(e => e['gen_ai.session.id'])?.['gen_ai.session.id'] as string | undefined;
    const turnId = entries.find(e => e['gen_ai.turn.id'])?.['gen_ai.turn.id'] as string | undefined;

    const steps = this.groupByStep(entries);
    const stepOrder = [...steps.keys()].filter((k): k is string => k !== undefined);

    // 每 turn 建一次 response ID -> token Map，使长会话每个 response 查询为 O(1)。
    const interceptTokens = new Map<string, InterceptTokenData>(
      interceptData.tokens.map(t => [t.id, t]),
    );

    // 按 Hook transcript 的 STEP 顺序消费 segment LLM 对，维持 ReAct 先后关系。
    if (sessionId) {
      for (const stepId of stepOrder) {
        const stepEntries = steps.get(stepId);
        if (!stepEntries) continue;
        const request = stepEntries.find(e => e['event.name'] === 'llm.request');
        const response = stepEntries.find(e => e['event.name'] === 'llm.response');
        let hasSegmentUsage = false;
        if (request && response) {
          const pair = this.takeSegmentPair(sessionId, turnId, request, response);
          if (pair) {
            (request as Record<string, unknown>)['time_unix_nano'] = pair.startNano;
            (response as Record<string, unknown>)['time_unix_nano'] = pair.endNano;

            if (pair.model) {
              for (const e of stepEntries) {
                if (!e['gen_ai.request.model'] || e['gen_ai.request.model'] === 'auto') {
                  (e as Record<string, unknown>)['gen_ai.request.model'] = pair.model;
                }
                if (e['event.name'] === 'llm.response') {
                  (e as Record<string, unknown>)['gen_ai.response.model'] = pair.model;
                }
              }
            }
            hasSegmentUsage = this.applyUsage(response, pair.usage);
          }
          // segment 无 token 或未配到 pair 时，先按 response ID 用 intercept，再用 SDK 时间邻近对。
          if (!hasSegmentUsage) {
            if (!this.applyInterceptUsage(response, interceptTokens)) {
              this.applySdkTokenUsage(sessionId, request, response);
            }
          } else {
            // segment 已提供主要 token 时只从 intercept 补缺失 cache_read；reasoning_tokens 不在
            // 当前 OTel GenAI 字段契约内，因此有意不传播。
            this.applyInterceptCacheReadOverlay(response, interceptTokens);
          }
        }

        this.applySegmentToolTiming(sessionId, stepEntries);
      }
    }

    // runtime wrapper 通过 JSON.stringify 拦截捕获 system prompt；与 qoder-trace 一致，挂到首个
    // 拥有 step ID 的 llm.request，避免 ENTRY 级 request 误承载模型系统指令。
    if (interceptData.systemPrompt) {
      const firstReq = entries.find(e =>
        e['event.name'] === 'llm.request' && !!e['gen_ai.step.id'],
      );
      if (firstReq) {
        (firstReq as Record<string, unknown>)['gen_ai.system_instructions'] = [
          { type: 'text', content: interceptData.systemPrompt.content },
        ];
      }
    }

    // 防御性 STEP 重叠修正：enrich 后 step N 的 tool.result 不得晚于 N+1 request。
    for (let i = 0; i < stepOrder.length - 1; i++) {
      const currentStepEntries = steps.get(stepOrder[i]);
      const nextStepEntries = steps.get(stepOrder[i + 1]);
      if (!currentStepEntries || !nextStepEntries) continue;

      const nextRequest = nextStepEntries.find(e => e['event.name'] === 'llm.request');
      if (!nextRequest) continue;
      const nextStartNano = nextRequest['time_unix_nano'] as string | undefined;
      if (!nextStartNano) continue;
      const nextStartBig = BigInt(nextStartNano);
      const capNano = String(nextStartBig - 1_000_000n); // 减 1ms

      for (const e of currentStepEntries) {
        if (e['event.name'] !== 'tool.result') continue;
        const ts = e['time_unix_nano'] as string | undefined;
        if (ts && BigInt(ts) > nextStartBig) {
          (e as Record<string, unknown>)['time_unix_nano'] = capNano;
        }
      }
    }
  }

  /**
   * 把非零 usage 字段写入 llm.response。
   * @returns 至少写入一个 input/output/cache 字段时为 true；全空/全零为 false。
   */
  private applyUsage(response: AgentActivityEntry, usage: TokenUsage): boolean {
    const inputTokens = positiveNumber(usage.inputTokens);
    const outputTokens = positiveNumber(usage.outputTokens);
    const cacheReadTokens = positiveNumber(usage.cacheReadInputTokens);
    const cacheCreationTokens = positiveNumber(usage.cacheCreationInputTokens);
    if (!inputTokens && !outputTokens && !cacheReadTokens && !cacheCreationTokens) return false;

    const target = response as Record<string, unknown>;
    if (inputTokens) target['gen_ai.usage.input_tokens'] = inputTokens;
    if (outputTokens) target['gen_ai.usage.output_tokens'] = outputTokens;
    // 仅依据可用 input/output 计算 total；cache 字段按 OTel 约定单独记录。
    if (inputTokens || outputTokens) target['gen_ai.usage.total_tokens'] = (inputTokens ?? 0) + (outputTokens ?? 0);
    if (cacheReadTokens) target['gen_ai.usage.cache_read.input_tokens'] = cacheReadTokens;
    if (cacheCreationTokens) target['gen_ai.usage.cache_creation.input_tokens'] = cacheCreationTokens;
    return true;
  }

  /**
   * 最后一级 SDK token fallback：按 request 起点 5 秒容差选最近 token 对，并消费一次。
   * 只调用 applyUsage，不改模型和时间。
   */
  private applySdkTokenUsage(
    sessionId: string,
    request: AgentActivityEntry,
    response: AgentActivityEntry,
  ): void {
    const requestNano = request['time_unix_nano'] as string | undefined;
    const requestMs = nanoToMillis(requestNano);
    if (requestMs === undefined) return;

    const pairs = this.sdkTokenPairs.get(sessionId);
    if (!pairs?.length) return;
    let index = -1;
    let smallestDelta = Number.POSITIVE_INFINITY;
    // 多个候选满足容差时选择绝对时间差最小者，而不是简单 FIFO。
    for (let i = 0; i < pairs.length; i++) {
      const delta = Math.abs(pairs[i].startMs - requestMs);
      if (delta <= SDK_TOKEN_MATCH_TOLERANCE_MS && delta < smallestDelta) {
        index = i;
        smallestDelta = delta;
      }
    }
    if (index < 0) return;

    const [pair] = pairs.splice(index, 1);
    if (pairs.length === 0) this.sdkTokenPairs.delete(sessionId);
    this.applyUsage(response, pair);
  }

  // ─── Runtime intercept token / system prompt 兼容 ─────────────────────────

  /**
   * 读取 qoderwork runtime wrapper 的 intercept JSONL 快照。
   * @returns 解析失败时返回空结构，使主 Hook/segment 链仍可继续。
   */
  private async readInterceptData(): Promise<InterceptData> {
    try {
      return await readInterceptFile(this.interceptFile);
    } catch {
      return { tokens: [], systemPrompt: null };
    }
  }

  /**
   * segment usage 缺失时，按 gen_ai.response.id 应用 intercept token。
   * provider total 可能包含未单列的 reasoning token，因此 intercept 明确提供 total 时覆盖计算值。
   * @returns ID 命中且至少应用一个 token 字段时为 true。
   */
  private applyInterceptUsage(
    response: AgentActivityEntry,
    tokensById: Map<string, InterceptTokenData>,
  ): boolean {
    const respId = response['gen_ai.response.id'] as string | undefined;
    if (!respId) return false;
    const match = tokensById.get(respId);
    if (!match) return false;
    const applied = this.applyUsage(response, {
      inputTokens: match.promptTokens,
      outputTokens: match.completionTokens,
      cacheReadInputTokens: match.cachedTokens,
      cacheCreationInputTokens: undefined,
    });
    if (applied && match.totalTokens) {
      (response as Record<string, unknown>)['gen_ai.usage.total_tokens'] = match.totalTokens;
    }
    return applied;
  }

  /**
   * segment 已有主要 usage 时仅补 intercept cache_read，保持其余 segment 值权威。
   * reasoning_tokens 不属于当前 OTel GenAI 契约，明确跳过。
   */
  private applyInterceptCacheReadOverlay(
    response: AgentActivityEntry,
    tokensById: Map<string, InterceptTokenData>,
  ): void {
    const respId = response['gen_ai.response.id'] as string | undefined;
    if (!respId) return;
    const match = tokensById.get(respId);
    if (!match) return;
    const target = response as Record<string, unknown>;
    // 已有非空 cache_read 时不覆盖，防止低优先级来源改写权威值。
    if (match.cachedTokens && !target['gen_ai.usage.cache_read.input_tokens']) {
      target['gen_ai.usage.cache_read.input_tokens'] = match.cachedTokens;
    }
  }

  // ─── 旧 SDK 日志 token 兼容 ────────────────────────────────────────────────

  /** 发现并增量读取所有 SDK 日志，仅更新 token fallback 状态，不直接输出事件。 */
  private async readSdkTokenState(): Promise<void> {
    for (const filePath of await this.discoverSdkLogFiles()) {
      await this.readSdkTokenFile(filePath);
    }
  }

  /**
   * 发现新布局 `<session>/main.log` 和旧布局 `<session>/main/sdk-*.log`。
   * @returns 排序后的文件列表；日志根不可读时为空。
   */
  private async discoverSdkLogFiles(): Promise<string[]> {
    let sessionDirs: import('node:fs').Dirent[];
    try {
      sessionDirs = await fs.readdir(this.sdkLogDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const files: string[] = [];
    for (const dir of sessionDirs) {
      if (!dir.isDirectory()) continue;
      const sessionDir = path.join(this.sdkLogDir, dir.name);
      const mainLog = path.join(sessionDir, 'main.log');
      if (await isFile(mainLog)) {
        files.push(mainLog);
        continue;
      }
      const legacyDir = path.join(sessionDir, 'main');
      try {
        const legacyFiles = await fs.readdir(legacyDir, { withFileTypes: true });
        for (const file of legacyFiles) {
          if (file.isFile() && file.name.startsWith('sdk-') && file.name.endsWith('.log')) {
            files.push(path.join(legacyDir, file.name));
          }
        }
      } catch {
        // session 目录可能先出现，legacy main 子目录稍后才创建；等待下轮。
      }
    }
    return files.sort();
  }

  /**
   * 按独立 StateStore key 增量读取一个 SDK 文件。
   * inode/截断重置 offset，单轮最多 16 MiB 且保留半行；解析出的共享 SdkEvent 只进入 token 状态机。
   */
  private async readSdkTokenFile(filePath: string): Promise<void> {
    const stateKey = `${this.id}:sdk-token:${filePath}`;
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return;
    }
    const currentInode = (stat as unknown as { ino: number }).ino;
    const previous = this.stateStore.get(stateKey);
    const previousInode = (previous.extra as { inode?: number } | undefined)?.inode;
    // 同路径轮转到新 inode 后从头读取，不复用旧字节位置。
    if (previousInode !== undefined && previousInode !== currentInode) {
      this.stateStore.setOffset(stateKey, 0);
    }

    let offset = previousInode !== undefined && previousInode !== currentInode
      ? 0
      : this.stateStore.getOffset(stateKey);
    if (offset > 0 && stat.size < offset) offset = 0;
    if (stat.size <= offset) {
      this.stateStore.update(stateKey, { extra: { inode: currentInode } });
      return;
    }

    const handle = await fs.open(filePath, 'r');
    let text = '';
    try {
      const readSize = Math.min(stat.size - offset, 16 * 1024 * 1024);
      const buffer = Buffer.alloc(readSize);
      await handle.read(buffer, 0, readSize, offset);
      text = buffer.toString('utf-8');
      let consumedBytes = readSize;
      // 达到读取上限时只推进到最后完整行。
      if (readSize < stat.size - offset) {
        const lastNewLine = text.lastIndexOf('\n');
        if (lastNewLine >= 0) {
          text = text.substring(0, lastNewLine);
          consumedBytes = Buffer.byteLength(text, 'utf-8') + 1;
        }
      }
      this.stateStore.setOffset(stateKey, offset + consumedBytes);
      this.stateStore.update(stateKey, { extra: { inode: currentInode } });
    } finally {
      await handle.close();
    }

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const event = parseSdkLogLine(line);
      if (event) this.handleSdkTokenEvent(event);
    }
  }

  /**
   * 用 message_start/message_delta 组成 token 对。
   * completed pair 记录 request 起点和 token；缺起点的孤立 delta 无法匹配，直接忽略。
   */
  private handleSdkTokenEvent(event: SdkEvent): void {
    const seenAtMs = Date.now();
    if (event.kind === 'message_start') {
      if (!event.sessionId) return;
      this.sdkInFlightMessages.set(event.sessionId, { startMs: event.ts, seenAtMs });
      return;
    }
    if (event.kind !== 'message_delta') return;
    if (!event.sessionId) return;
    const inFlight = this.sdkInFlightMessages.get(event.sessionId);
    if (!inFlight) return;
    this.sdkInFlightMessages.delete(event.sessionId);
    const pairs = this.sdkTokenPairs.get(event.sessionId) ?? [];
    pairs.push({
      startMs: inFlight.startMs,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      seenAtMs,
    });
    this.sdkTokenPairs.set(event.sessionId, pairs);
  }

  /**
   * 删除一小时前未消费的 segment/SDK 配对、subagent 标记、目录缓存和在途状态。
   * 每次 collect 的 finally 都调用，因此异常周期也会执行。
   */
  private evictStaleState(): void {
    const cutoff = Date.now() - SEGMENT_STATE_TTL_MS;
    evictMapValues(this.segmentPairs, pair => pair.seenAtMs >= cutoff);
    evictNestedMapValues(this.segmentToolTimings, timing => timing.seenAtMs >= cutoff);
    evictNestedMapValues(this.subagentTurns, seenAtMs => seenAtMs >= cutoff);
    evictNestedMapValues(this.inFlightPairs, pair => pair.seenAtMs >= cutoff);
    evictMapValues(this.sdkTokenPairs, pair => pair.seenAtMs >= cutoff);
    for (const [sessionId, message] of this.sdkInFlightMessages) {
      if (message.seenAtMs < cutoff) this.sdkInFlightMessages.delete(sessionId);
    }
    for (const [sessionId, cachedDir] of this.segmentDirBySession) {
      if (cachedDir.seenAtMs < cutoff) this.segmentDirBySession.delete(sessionId);
    }
  }

  /**
   * 从 session segment 缓冲中取出最匹配的一对 LLM 时序。
   * 优先精确 turnId；找不到时再要求 Hook request/response 都落在五分钟容差内。匹配项只消费一次。
   */
  private takeSegmentPair(
    sessionId: string,
    turnId: string | undefined,
    request: AgentActivityEntry,
    response: AgentActivityEntry,
  ): SegmentLlmPair | undefined {
    const buffer = this.segmentPairs.get(sessionId);
    if (!buffer?.length) return undefined;

    let idx = turnId ? buffer.findIndex(pair => pair.turnId === turnId) : -1;
    if (idx < 0) {
      idx = buffer.findIndex(pair => this.isSegmentPairCompatible(pair, request, response));
    }
    if (idx < 0) return undefined;

    const [pair] = buffer.splice(idx, 1);
    if (buffer.length === 0) this.segmentPairs.delete(sessionId);
    return pair;
  }

  /** 判断 segment 起止纳秒是否都与 Hook request/response 位于允许时间容差内。 */
  private isSegmentPairCompatible(
    pair: SegmentLlmPair,
    request: AgentActivityEntry,
    response: AgentActivityEntry,
  ): boolean {
    const requestNano = request['time_unix_nano'] as string | undefined;
    const responseNano = response['time_unix_nano'] as string | undefined;
    if (!requestNano || !responseNano) return false;
    return isWithinTolerance(pair.startNano, requestNano, SEGMENT_TIMING_TOLERANCE_MS)
      && isWithinTolerance(pair.endNano, responseNano, SEGMENT_TIMING_TOLERANCE_MS);
  }

  /**
   * 按 tool call ID 用 segment requested/finished 时间覆盖 Hook 工具事件。
   * call 与 result 都存在且 timing 两端齐全后删除缓存；只看到一端则保留给后续批次。
   */
  private applySegmentToolTiming(sessionId: string, stepEntries: AgentActivityEntry[]): void {
    const timings = this.segmentToolTimings.get(sessionId);
    if (!timings?.size) return;

    const usedCallIds = new Set<string>();
    for (const entry of stepEntries) {
      const eventName = entry['event.name'];
      if (eventName !== 'tool.call' && eventName !== 'tool.result') continue;
      const callId = entry['gen_ai.tool.call.id'] as string | undefined;
      if (!callId) continue;
      const timing = timings.get(callId);
      if (!timing) continue;

      if (eventName === 'tool.call' && timing.requestedNano) {
        (entry as Record<string, unknown>)['time_unix_nano'] = timing.requestedNano;
        usedCallIds.add(callId);
      } else if (eventName === 'tool.result' && timing.finishedNano) {
        (entry as Record<string, unknown>)['time_unix_nano'] = timing.finishedNano;
        usedCallIds.add(callId);
      }
    }

    // 必须确认同一 STEP 同时具备 call/result，才安全释放完整 timing。
    for (const callId of usedCallIds) {
      const timing = timings.get(callId);
      const hasCallEntry = stepEntries.some(entry =>
        entry['event.name'] === 'tool.call' && entry['gen_ai.tool.call.id'] === callId
      );
      const hasResultEntry = stepEntries.some(entry =>
        entry['event.name'] === 'tool.result' && entry['gen_ai.tool.call.id'] === callId
      );
      if (hasCallEntry && hasResultEntry && timing?.requestedNano && timing.finishedNano) {
        timings.delete(callId);
      }
    }
    if (timings.size === 0) this.segmentToolTimings.delete(sessionId);
  }

  /** 按 gen_ai.step.id 保持插入顺序分组；缺 step ID 的 ENTRY 事件归到 undefined 组。 */
  private groupByStep(entries: AgentActivityEntry[]): Map<string | undefined, AgentActivityEntry[]> {
    const groups = new Map<string | undefined, AgentActivityEntry[]>();
    for (const entry of entries) {
      const stepId = (entry['gen_ai.step.id'] as string) || undefined;
      const group = groups.get(stepId) ?? [];
      group.push(entry);
      groups.set(stepId, group);
    }
    return groups;
  }

  // ─── Trace ID 注入 ─────────────────────────────────────────────────────────

  /** 为同一 turn 的全部事件生成并原地写入一个 32 位十六进制 trace_id。 */
  private injectTraceId(entries: AgentActivityEntry[]): void {
    if (entries.length === 0) return;
    const traceId = crypto.randomBytes(16).toString('hex');
    for (const entry of entries) {
      (entry as Record<string, unknown>).trace_id = traceId;
    }
  }

  // ─── Turn 分组 ─────────────────────────────────────────────────────────────

  /**
   * 按 gen_ai.turn.id 分组并保留首次出现顺序；缺失 ID 的记录归入 `unknown` 组。
   * Hook processor 正常记录应都有 turn ID，unknown 仅作兼容防护。
   */
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
}

/** 国际版 Trace Input 构造参数；路径覆盖主要供测试或非默认安装。 */
export interface QoderWorkTraceInputOptions extends InputOptions {
  /** Hook processor canonical history 目录。 */
  logDir?: string;
  /** Qoder Work session segments 根目录。 */
  segmentsRoot?: string;
  /** 旧 SDK token fallback 日志根目录。 */
  sdkLogDir?: string;
  /** runtime wrapper intercept JSONL 文件。 */
  interceptFile?: string;
}

/** Qoder Work segment JSONL 的最小兼容结构；未知 data 字段保留但不解释。 */
interface SegmentEvent {
  ts?: string;
  type?: string;
  turn_id?: string;
  request_id?: string;
  tool_call_id?: string;
  data?: {
    model?: string;
    is_subagent?: boolean;
    tool_name?: string;
    [key: string]: unknown;
  };
}

/** 已看到 segment request、等待 completed 的配对左侧。 */
interface InFlightPair {
  turnId: string;
  startNano: string;
  model: string;
  seenAtMs: number;
}

/** 已完成且等待 Hook STEP 消费的 segment LLM 对。 */
interface SegmentLlmPair {
  turnId: string;
  startNano: string;
  endNano: string;
  model: string;
  usage: TokenUsage;
  seenAtMs: number;
}

/** 一次 segment 工具执行的可选起止时序。 */
interface SegmentToolTiming {
  turnId: string;
  toolName?: string;
  requestedNano?: string;
  finishedNano?: string;
  seenAtMs: number;
}

/** 多来源统一的 token 用量结构。 */
interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/** 旧 SDK token 对额外携带 request 毫秒时间和 TTL 时间。 */
interface SdkTokenPair extends TokenUsage {
  startMs: number;
  seenAtMs: number;
}

/** 旧 SDK 尚待 message_delta 的 message_start 状态。 */
interface SdkInFlightMessage {
  startMs: number;
  seenAtMs: number;
}

/** session segments 目录缓存及最近命中时间。 */
interface CachedSegmentDir {
  path: string;
  seenAtMs: number;
}

/** 把 ISO 时间转为 Unix 纳秒字符串；无效时间返回 undefined。 */
function isoToNano(iso: string): string | undefined {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  return String(BigInt(ms) * 1_000_000n);
}

/** 从 segment data 提取并过滤四类正 token 字段。 */
function extractSegmentUsage(data: SegmentEvent['data']): TokenUsage {
  return {
    inputTokens: positiveNumber(data?.input_tokens),
    outputTokens: positiveNumber(data?.output_tokens),
    cacheReadInputTokens: positiveNumber(data?.cache_read_input_tokens),
    cacheCreationInputTokens: positiveNumber(data?.cache_creation_input_tokens),
  };
}

/** 仅接受大于 0 的有限 number，其他值返回 undefined。 */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 将纳秒字符串安全降为 epoch 毫秒；缺失或 BigInt 解析失败返回 undefined。 */
function nanoToMillis(nano: string | undefined): number | undefined {
  if (!nano) return undefined;
  try {
    return Number(BigInt(nano) / NANO_PER_MILLI);
  } catch {
    return undefined;
  }
}

/** 复用平台数据根规则得到国际版 SDK logs 目录。 */
function resolveQoderWorkSdkLogDir(): string {
  return path.join(resolveQoderWorkRoot(), 'logs');
}

/** 异步判断路径是否为目录；任何 stat 异常返回 false。 */
async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/** 异步判断路径是否为普通文件；任何 stat 异常返回 false。 */
async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/**
 * 对 Map<string,T[]> 原地过滤；数组清空时同时删除外层 key。
 * @param keep TTL 判定回调。
 */
function evictMapValues<T>(map: Map<string, T[]>, keep: (value: T) => boolean): void {
  for (const [key, values] of map) {
    const retained = values.filter(keep);
    if (retained.length === 0) map.delete(key);
    else map.set(key, retained);
  }
}

/** 对二层 Map 原地过滤；内层清空后删除对应 session key。 */
function evictNestedMapValues<T>(map: Map<string, Map<string, T>>, keep: (value: T) => boolean): void {
  for (const [sessionId, values] of map) {
    for (const [key, value] of values) {
      if (!keep(value)) values.delete(key);
    }
    if (values.size === 0) map.delete(sessionId);
  }
}

/** Qoder Work 内部 memory-sink turn 不属于用户主对话，不能参与 Hook STEP 配对。 */
function isIgnoredSegmentTurn(turnId: string): boolean {
  return turnId.startsWith('qoderwork-memory-sink');
}

/**
 * 用 BigInt 比较两个纳秒时间的绝对差是否在毫秒容差内；坏字符串返回 false。
 */
function isWithinTolerance(leftNano: string, rightNano: string, toleranceMs: number): boolean {
  try {
    const delta = BigInt(leftNano) - BigInt(rightNano);
    const abs = delta < 0n ? -delta : delta;
    return abs <= BigInt(toleranceMs) * NANO_PER_MILLI;
  } catch {
    return false;
  }
}
