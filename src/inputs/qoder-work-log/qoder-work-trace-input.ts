/**
 * 当前 Qoder Work CN 的多源 Trace 聚合 Input。
 *
 * 本文件也导出名为 `QoderWorkTraceInput` 的类，但它与
 * `src/inputs/qoder-work-trace/qoder-work-trace-input.ts` 是两个互不继承、互不调用的独立实现：
 * Orchestrator 把本类重命名导入为 `QoderWorkCNTraceInput`，仅为 CN 实例传入
 * `ClientType.QoderWorkCN` 和 CN dataRoot；另一个文件才是国际版当前的 `qoder-work-trace`。
 * 本类仍保留默认国际版参数的历史原因和是否有仓库外调用均待确认，判断生产链应以 Orchestrator
 * 注册关系为准。
 *
 * 数据流：增量读取 SDK 纯文本日志 -> 按 result/TTL 切出 session window -> 从 agents.db 匹配
 * 用户 prompt/工具结果 -> 以 PostToolUse 内存结果和 `tool-results/<id>.txt` 继续补全 -> 输出
 * other + 多 STEP 的 LLM/TOOL 标准事件。StateStore 保存每文件 offset/inode/model policy、物理窗口
 * 去重键、已消费 prompt ID 和 fallback turn 计数。BaseInput 负责轮询、串行化、停止等待和落盘；
 * SQLite/文件错误按源隔离，不启动子进程、不访问网络，文件和数据库连接均在每次操作后关闭。
 */
// 内置模块用于随机 trace/event ID、异步文件访问、home 路径和跨平台路径拼接。
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';
// sqlite3 提供回调式只读查询，底部 helper 将其包装成 Promise。
import sqlite3 from 'sqlite3';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
// entry-builder 生成统一字段；directoryExists 用于国际版静态 discovery 默认实现。
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { directoryExists } from '../../utils/fs-utils.js';
// 继承 SessionFilePolling 生命周期，但覆盖 collect 自行解析 SDK 纯文本。
import {
  BaseSessionInput,
  type SessionInputOptions,
} from '../base/base-session-input.js';
// 与独立 SDK Log Input 共用日志行 parser、平台数据根解析和构造参数类型。
import {
  parseSdkLogLine,
  resolveQoderWorkRoot,
  type QoderWorkLogInputOptions,
  type SdkEvent,
} from './qoder-work-log-input.js';

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** 模型缺失占位、单轮读取上限和各种内存/持久化窗口限制。 */
const UNKNOWN_MODEL = 'unknown';
const MAX_READ_BYTES = 16 * 1024 * 1024;
// 未收到 result 的 session 超过 30 分钟时按完成窗口输出，避免永久滞留。
const SESSION_TTL_MS = 30 * 60 * 1000;
// SQLite prompt 与 SDK window 时间匹配的最大容差。
const PROMPT_MATCH_TOLERANCE_MS = 5 * 60 * 1000;
// 状态数组/计数 Map 只保留最近项，防止 StateStore 文件无限增长。
const WINDOW_STATE_LIMIT = 500;
const TURN_COUNTER_STATE_LIMIT = 500;
// fallback messages 查询的单 session 上限和数据库固定相对路径。
const DB_MESSAGE_LIMIT = 2000;
const DB_REL_PATH = path.join('data', 'agents.db');

/** 把 epoch 毫秒精确转成 Unix 纳秒字符串，避免 number 无法安全表示纳秒整数。 */
function msToNanos(ms: number): string {
  return String(BigInt(Math.trunc(ms)) * 1_000_000n);
}

// ─── 内部状态类型 ────────────────────────────────────────────────────────────

/** SDK tool_use block 在一个 ActiveTurn 内的内容和时序。 */
interface ToolCallSlot {
  id: string;
  name: string;
  argumentsJson: string;
  startTs: number;
  endTs: number;
}

/** 从 message_start 到下一个边界之间累积的一次 LLM/工具步骤。 */
interface ActiveTurn {
  messageId: string;
  model: string;
  startTimestamp: number;
  endTimestamp: number;
  thinkingContent: string;
  textContent: string;
  toolCalls: ToolCallSlot[];
  toolIndexMap: Map<number, number>;
  toolArgJsonMap: Map<number, string>;
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
}

/** 一个 result 窗口内的 session 元数据和多个已完成 ActiveTurn。 */
interface SessionState {
  subscriptionTier: string;
  cwd: string;
  agents: string[];
  tools: string[];
  startTime: number;
  lastSeenMs: number;
  turns: ActiveTurn[];
}

/** 从 SQLite 匹配出的用户 prompt 候选；时间为 epoch 毫秒。 */
interface DbUserPrompt {
  id: string;
  text: string;
  updatedAtMs: number;
  sequence: number;
}

/** 单 session 从 SQLite 读取的 prompt 与工具结果集合。 */
interface DbSessionData {
  userPrompts: DbUserPrompt[];
  toolResults: Array<{ toolCallId: string; result: string }>;
}

/** result 事件或 TTL 淘汰产生的待输出物理窗口。 */
interface CompletedSessionWindow {
  session: SessionState;
  sessionId: string;
  resultId?: string;
  resultTimestamp?: number;
}

/**
 * 物理窗口映射到标准 turn 后的身份。
 * prompt 可用时 turnId 采用稳定消息 ID，否则使用 StateStore 中递增 fallbackCounter。
 */
interface TurnIdentity {
  sessionId: string;
  turnId: string;
  emitKey: string;
  userPrompt?: DbUserPrompt;
  fallbackCounter?: number;
}

// ─── 主 Input ────────────────────────────────────────────────────────────────

/**
 * SDK Log + SQLite + tool-results 的 Qoder Work CN Trace 聚合状态机。
 *
 * Orchestrator 当前以 `QoderWorkCNTraceInput` 别名创建本类；启用时关闭 CN 的 Hook/Log/SQLite
 * 三个回退 Input，保证每个窗口只由聚合器输出一次。一个 SDK result window 被视为一个标准 turn，
 * 其中每个 message_start/message_delta 生命周期变成一个 STEP。
 *
 * 内存生命周期：sessions/activeTurns/model policy/tool result cache 随进程存在，result 输出或 TTL
 * 淘汰后清理；跨重启必要状态位于 StateStore。类不持有 watcher、timer 或打开的 DB/file handle，
 * 这些由 BaseInput 周期和局部 finally/close 管理。
 */
export class QoderWorkTraceInput extends BaseSessionInput {
  /** 通常为 `qoder-work-cn-trace`；默认参数会得到 `qoder-work-trace`。 */
  readonly id: string;
  readonly agentType: ClientType;

  /** SDK session 状态、在途 turn 和逐文件模型策略。 */
  private readonly sessions: Map<string, SessionState> = new Map();
  private readonly activeTurns: Map<string, ActiveTurn> = new Map();
  private readonly fileModelPolicies: Map<string, { chat: string; compact: string; scene: string }> = new Map();
  private currentModelPolicy = { chat: '', compact: '', scene: '' };
  /** PostToolUse 提供的结果，以及由 transcript_path 推导出的文件 fallback 目录。 */
  private sessionToolResults = new Map<string, Map<string, string>>();
  private sessionToolResultDirs = new Map<string, string>();
  /** 当前变体的 SQLite、CLI projects 和事件 source 路径/标识。 */
  private readonly dbPath: string;
  private readonly projectsDir: string;
  private readonly source: string;
  /**
   * 可选直接写入 entry 的 user.id。仓库内未发现此方法调用，当前生产 user.id 由 InputManager
   * 后处理补充；该 setter 是否供外部嵌入调用待确认。
   */
  private configuredUserId = '';

  /**
   * 根据 agentType/dataRoot 初始化扫描路径和状态 ID。
   * @param opts StateStore、轮询周期与产品变体配置；当前 Orchestrator 传入 CN 参数。
   */
  constructor(opts: QoderWorkLogInputOptions) {
    const agentType = opts.agentType ?? ClientType.QoderWork;
    const dataRoot = opts.dataRoot ?? resolveQoderWorkRoot(agentType === ClientType.QoderWorkCN ? 'cn' : 'standard');
    super({
      stateStore: opts.stateStore,
      sessionDir: path.join(dataRoot, 'logs'),
      filePattern: 'sdk-*.log',
      pollIntervalMs: opts.pollIntervalMs ?? 30_000,
    });
    this.agentType = agentType;
    this.id = `${agentType}-trace`;
    this.source = agentType === ClientType.QoderWorkCN ? 'qoder-work-cn-trace' : 'qoder-work-trace';
    this.dbPath = path.join(dataRoot, DB_REL_PATH);
    const cliHome = path.join(os.homedir(), agentType === ClientType.QoderWorkCN ? '.qoderworkcn' : '.qoderwork');
    this.projectsDir = path.join(cliHome, 'projects');
  }

  /**
   * 保存兼容调用方提供的 user ID，后续 emitSessionSpans 写入所有事件。
   * @param userId 非空约束由调用方负责；传空字符串表示交给 InputManager 补充。
   */
  setUserId(userId: string): void {
    this.configuredUserId = userId;
  }

  /** 返回国际版默认 logs watch path；CN 注册处由 Orchestrator 覆盖为 CN dataRoot。 */
  static getWatchPaths(): string[] {
    return [path.join(resolveQoderWorkRoot('standard'), 'logs')];
  }

  /** 检查国际版默认 logs 目录；CN 注册使用 Orchestrator 自定义 availability。 */
  static async checkAvailability(): Promise<boolean> {
    return directoryExists(path.join(resolveQoderWorkRoot('standard'), 'logs'));
  }

  /**
   * 首次启动把每个日志 offset 基线设到最近 result 之后，跳过已完成历史并保留在途窗口。
   * 已有 offset 不覆盖；轮转竞态和文件消失仅跳过当前文件。
   */
  protected override async onStart(): Promise<void> {
    const files = await this.discoverSessionFiles();
    for (const filePath of files) {
      try {
        const stat = await fs.stat(filePath);
        const stateKey = `${this.id}:${filePath}`;
        const prev = this.stateStore.get(stateKey);
        if (prev.lastOffset !== undefined) continue;
        const baselineOffset = await findLastResultBoundary(filePath, stat.size);
        this.stateStore.setOffset(stateKey, baselineOffset);
        this.stateStore.update(stateKey, { extra: { inode: (stat as unknown as { ino: number }).ino } });
      } catch { /* 文件可能在扫描时轮转；留到下轮重试。 */ }
    }
  }

  /**
   * 发现新布局 `<session>/main.log` 与旧布局 `<session>/main/sdk-*.log`。
   * @returns 按路径排序的完整文件名；根目录不可读时返回空数组。
   */
  protected async discoverSessionFiles(): Promise<string[]> {
    const files: string[] = [];
    let sessionDirs: Dirent[];
    try {
      sessionDirs = await fs.readdir(this.sessionDir, { withFileTypes: true });
    } catch {
      return files;
    }
    // 第一层只接受 session 目录，普通文件和符号布局不参与。
    for (const dir of sessionDirs) {
      if (!dir.isDirectory()) continue;
      const sessionPath = path.join(this.sessionDir, dir.name);
      const mainLogPath = path.join(sessionPath, 'main.log');
      try {
        const st = await fs.stat(mainLogPath);
        if (st.isFile()) { files.push(mainLogPath); continue; }
      } catch { /* 新布局不存在时继续尝试旧布局。 */ }
      const mainDir = path.join(sessionPath, 'main');
      let entries: Dirent[];
      try { entries = await fs.readdir(mainDir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.startsWith('sdk-') && entry.name.endsWith('.log')) {
          files.push(path.join(mainDir, entry.name));
        }
      }
    }
    return files.sort();
  }

  /**
   * 满足 BaseSessionInput 抽象契约的占位回调。
   * 本源是纯文本 SDK 日志，实际解析由覆盖的 collect/processLogFile 完成。
   * @returns 恒为 null。
   */
  protected async processSessionLine(): Promise<AgentActivityEntry | null> {
    return null;
  }

  /**
   * 执行单轮多源聚合的第一阶段：读取 SDK 文件、关闭 result/TTL 窗口，再逐窗口异步 enrich。
   * @returns 所有新完成窗口生成的标准事件；没有完整窗口时为空数组。
   */
  protected override async collect(): Promise<AgentActivityEntry[]> {
    const files = await this.discoverSessionFiles();
    const completedSessions: CompletedSessionWindow[] = [];

    // 文件串行处理，保证同一轮内完成窗口和 per-file model policy 更新顺序稳定。
    for (const filePath of files) {
      const completed = await this.processLogFile(filePath);
      completedSessions.push(...completed);
    }

    // 没有 result 的异常/中断 session 在 TTL 后也形成可输出窗口。
    const evicted = this.evictStaleSessions();
    completedSessions.push(...evicted);

    const allEntries: AgentActivityEntry[] = [];
    // SQLite 和 tool-result 文件读取是异步的，因此逐窗口 await 后保持发现顺序。
    for (const completed of completedSessions) {
      const entries = await this.emitSessionSpans(completed);
      allEntries.push(...entries);
    }
    return allEntries;
  }

  // ─── SDK 日志处理 ──────────────────────────────────────────────────────────

  /**
   * 按 StateStore offset 增量读取一个 SDK 日志，并返回新闭合的 session windows。
   *
   * inode 变化或 truncate 会重置游标；单轮限制 16 MiB，并只提交到最后完整换行。模型策略同时
   * 保存在内存 Map 和该文件 state.extra，确保进程重启后仍可为新 turn 选模型。
   *
   * @param filePath main.log 或 sdk-*.log 路径。
   * @returns result 事件闭合出的窗口列表；文件不可读或无新字节时为空。
   */
  private async processLogFile(filePath: string): Promise<CompletedSessionWindow[]> {
    const stateKey = `${this.id}:${filePath}`;
    let stat;
    try { stat = await fs.stat(filePath); } catch { return []; }

    const prevState = this.stateStore.get(stateKey);
    const prevInode = prevState.extra?.inode as number | undefined;
    const currentInode = (stat as unknown as { ino: number }).ino;

    // inode 变化说明相同路径已经轮转为新文件，旧 offset/内存策略失效。
    if (prevInode !== undefined && prevInode !== currentInode) {
      this.stateStore.setOffset(stateKey, 0);
      this.stateStore.update(stateKey, { extra: { inode: currentInode } });
      this.fileModelPolicies.delete(filePath);
      this.currentModelPolicy = { chat: '', compact: '', scene: '' };
    } else if (prevInode === undefined) {
      this.stateStore.update(stateKey, { extra: { inode: currentInode } });
    }

    // 优先使用本进程该文件策略，否则恢复持久化策略，实现跨进程重启连续。
    const persistedPolicy = prevState.extra?.modelPolicy as { chat?: string; compact?: string; scene?: string } | undefined;
    this.currentModelPolicy = this.fileModelPolicies.get(filePath)
      ?? (persistedPolicy ? { chat: persistedPolicy.chat ?? '', compact: persistedPolicy.compact ?? '', scene: persistedPolicy.scene ?? '' }
        : { chat: '', compact: '', scene: '' });

    const offset = this.stateStore.getOffset(stateKey);
    if (stat.size <= offset) return [];

    const handle = await fs.open(filePath, 'r');
    let text: string;
    try {
      const readSize = Math.min(stat.size - offset, MAX_READ_BYTES);
      const buf = Buffer.alloc(readSize);
      await handle.read(buf, 0, readSize, offset);
      text = buf.toString('utf-8');
      let consumedBytes = readSize;
      // 触及读取上限时只消费完整行，末尾残行下轮重读。
      if (readSize < stat.size - offset) {
        const lastNL = text.lastIndexOf('\n');
        if (lastNL >= 0) { text = text.substring(0, lastNL); consumedBytes = Buffer.byteLength(text, 'utf-8') + 1; }
      }
      this.stateStore.setOffset(stateKey, offset + consumedBytes);
      this.stateStore.update(stateKey, { extra: { inode: currentInode } });
    } finally {
      await handle.close();
    }

    const completed: CompletedSessionWindow[] = [];
    // 无法识别的文本行由共享 parser 返回 null，不影响其他行。
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const event = parseSdkLogLine(line);
      if (!event) continue;
      const result = this.handleEvent(event);
      if (result) completed.push(result);
    }

    this.fileModelPolicies.set(filePath, { ...this.currentModelPolicy });
    // 同时持久化 inode 和模型策略；BaseInput 在周期末统一保存 StateStore 文件。
    this.stateStore.update(stateKey, {
      extra: { inode: currentInode, modelPolicy: { ...this.currentModelPolicy } },
    });
    return completed;
  }

  /**
   * 取得现有 session 或用当前事件时间创建最小状态，并刷新 lastSeenMs。
   * @param sessionId SDK session ID。
   * @param ts 当前事件 epoch 毫秒。
   * @returns Map 中的可变 SessionState；调用方会继续更新它。
   */
  private ensureSession(sessionId: string, ts: number): SessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { subscriptionTier: '', cwd: '', agents: [], tools: [], startTime: ts, lastSeenMs: ts, turns: [] };
      this.sessions.set(sessionId, session);
    }
    session.lastSeenMs = ts;
    return session;
  }

  /**
   * SDK 事件状态机。
   *
   * system/policy 维护会话与模型；message/block/delta 累积 turn；result 原子取走完整 session
   * window；PostToolUse 缓存工具结果。返回 null 表示尚未到输出边界。
   *
   * @param event 共享 parseSdkLogLine 解析出的判别联合。
   * @returns result 完成窗口，其他事件返回 null。
   */
  private handleEvent(event: SdkEvent): CompletedSessionWindow | null {
    switch (event.kind) {
      case 'system_init': {
        const session = this.ensureSession(event.sessionId, event.ts);
        session.subscriptionTier = event.subscriptionTier;
        session.cwd = event.cwd;
        session.agents = event.agents;
        session.tools = event.tools;
        // CN 可能只在 SDK 进程启动时发送一次 set_model_policy，而基线会跳过旧行；在所有槽位
        // 为空时，用 init.model 中非 Premium/Standard 的值作为 chat 模型种子。
        if (event.subscriptionTier &&
            !this.currentModelPolicy.chat &&
            !this.currentModelPolicy.scene &&
            !this.currentModelPolicy.compact) {
          const candidate = event.subscriptionTier.toLowerCase();
          if (candidate !== 'premium' && candidate !== 'standard') {
            this.currentModelPolicy.chat = candidate;
          }
        }
        return null;
      }

      case 'set_model_policy':
        // 纯策略状态，不输出事件；message_start 会快照当时选中的槽位。
        if (event.chatModel) this.currentModelPolicy.chat = event.chatModel;
        if (event.compactModel) this.currentModelPolicy.compact = event.compactModel;
        if (event.sceneModel) this.currentModelPolicy.scene = event.sceneModel;
        return null;

      case 'message_start': {
        // 同 session 的上一条 active turn 先落入 session.turns，再创建新 turn。
        this.ensureSession(event.sessionId, event.ts);
        this.finalizeTurn(event.sessionId);
        this.activeTurns.set(event.sessionId, {
          messageId: event.messageId,
          model: this.pickModelForSession(event.sessionId),
          startTimestamp: event.ts,
          endTimestamp: event.ts,
          thinkingContent: '',
          textContent: '',
          toolCalls: [],
          toolIndexMap: new Map(),
          toolArgJsonMap: new Map(),
          stopReason: '',
          inputTokens: 0,
          outputTokens: 0,
        });
        return null;
      }

      case 'block_start': {
        const turn = this.activeTurns.get(event.sessionId);
        if (!turn) return null;
        // 工具 block 建立 block index 到 toolCalls 下标的映射，供 input_json_delta 追加参数。
        if (event.blockType === 'tool_use' && event.toolId && event.toolName) {
          const idx = turn.toolCalls.length;
          turn.toolIndexMap.set(event.index, idx);
          turn.toolCalls.push({
            id: event.toolId, name: event.toolName, argumentsJson: '',
            startTs: event.ts, endTs: event.ts,
          });
        }
        turn.endTimestamp = event.ts;
        return null;
      }

      case 'delta': {
        const turn = this.activeTurns.get(event.sessionId);
        if (!turn) return null;
        turn.endTimestamp = event.ts;
        // 本实现按日志观察顺序拼接文本/推理；国际版当前 Trace 使用 segments + Hook 主结构。
        if (event.deltaType === 'thinking_delta') {
          turn.thinkingContent += event.content;
        } else if (event.deltaType === 'text_delta') {
          turn.textContent += event.content;
        } else if (event.deltaType === 'input_json_delta' && event.blockIndex !== undefined) {
          const tcIdx = turn.toolIndexMap.get(event.blockIndex);
          if (tcIdx !== undefined) {
            const prev = turn.toolArgJsonMap.get(event.blockIndex) ?? '';
            turn.toolArgJsonMap.set(event.blockIndex, prev + event.content);
            turn.toolCalls[tcIdx].endTs = event.ts;
          }
        }
        return null;
      }

      case 'message_delta': {
        // 停止原因、token 和 turn 终点来自 message_delta；同时收束所有工具的当前结束时间。
        const turn = this.activeTurns.get(event.sessionId);
        if (!turn) return null;
        turn.stopReason = event.stopReason;
        turn.inputTokens = event.inputTokens;
        turn.outputTokens = event.outputTokens;
        turn.endTimestamp = event.ts;
        for (const tc of turn.toolCalls) tc.endTs = event.ts;
        return null;
      }

      case 'message_stop': {
        // 只更新时间，不 finalize；message_delta/result 仍可能随后到达。
        const turn = this.activeTurns.get(event.sessionId);
        if (!turn) return null;
        turn.endTimestamp = event.ts;
        for (const tc of turn.toolCalls) tc.endTs = event.ts;
        return null;
      }

      case 'result': {
        // result 是正常窗口边界：关闭 active turn，从 Map 取走 session，交给 emit 阶段。
        this.finalizeTurn(event.sessionId);
        const session = this.sessions.get(event.sessionId);
        if (!session) return null;
        this.sessions.delete(event.sessionId);
        this.activeTurns.delete(event.sessionId);
        return {
          session,
          sessionId: event.sessionId,
          resultId: event.resultId,
          resultTimestamp: event.ts,
        };
      }

      case 'post_tool_use': {
        // Hook 控制请求提供真实工具结果；按 call ID 缓存在 session 内，输出后清理。
        if (!event.sessionId || !event.toolUseId) return null;
        this.ensureSession(event.sessionId, event.ts);
        let map = this.sessionToolResults.get(event.sessionId);
        if (!map) { map = new Map(); this.sessionToolResults.set(event.sessionId, map); }
        map.set(event.toolUseId, event.toolResponse);
        // 第一次看到 transcript_path 时推导 `<project>/<session>/tool-results` fallback 目录。
        if (event.transcriptPath && !this.sessionToolResultDirs.has(event.sessionId)) {
          const dir = path.join(path.dirname(event.transcriptPath), event.sessionId, 'tool-results');
          this.sessionToolResultDirs.set(event.sessionId, dir);
        }
        return null;
      }
    }
  }

  /**
   * 把 active turn 中分块累积的参数合并到工具槽位，并追加到 session.turns。
   * 空 turn 被丢弃以避免生成没有内容、token 和工具的虚假 STEP。
   * @param sessionId 要关闭的 session。
   */
  private finalizeTurn(sessionId: string): void {
    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;
    this.activeTurns.delete(sessionId);

    // 按 block index 将分片 JSON 参数合并回对应工具槽位。
    for (const [blockIndex, json] of turn.toolArgJsonMap) {
      const tcIdx = turn.toolIndexMap.get(blockIndex);
      if (tcIdx !== undefined && turn.toolCalls[tcIdx]) {
        turn.toolCalls[tcIdx].argumentsJson = json;
      }
    }

    // 无内容、token、工具的 turn 不产生幽灵 span。
    if (!turn.thinkingContent && !turn.textContent && turn.toolCalls.length === 0
        && turn.inputTokens === 0 && turn.outputTokens === 0) {
      return;
    }

    const session = this.sessions.get(sessionId);
    if (session) session.turns.push(turn);
  }

  /**
   * 按订阅层级选择当前模型策略槽位。
   * @returns Standard 优先 scene/compact，其他层级优先 chat；全空时为 unknown。
   */
  private pickModelForSession(sessionId: string): string {
    const tier = this.sessions.get(sessionId)?.subscriptionTier ?? '';
    const policy = this.currentModelPolicy;
    if (tier === 'Standard') return policy.scene || policy.compact || policy.chat || UNKNOWN_MODEL;
    return policy.chat || policy.scene || policy.compact || UNKNOWN_MODEL;
  }

  /**
   * 把超过 30 分钟无活动的 session 强制闭合为待输出窗口，并清理相关缓存。
   * @returns 仅包含至少一个有效 turn 的过期窗口。
   */
  private evictStaleSessions(): CompletedSessionWindow[] {
    const now = Date.now();
    const evicted: CompletedSessionWindow[] = [];
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeenMs > SESSION_TTL_MS) {
        this.finalizeTurn(id);
        if (session.turns.length > 0) {
          evicted.push({ session, sessionId: id });
        }
        this.sessions.delete(id);
        this.activeTurns.delete(id);
        this.cleanupSessionCaches(id);
      }
    }
    return evicted;
  }

  /**
   * 在所有 CLI project 目录中查找指定 session 的 `tool-results` 目录。
   * @returns 第一个存在的目录；projects 不存在、权限错误或未命中时为 null。
   */
  private async findToolResultDir(sessionId: string): Promise<string | null> {
    try {
      const projectDirs = await fs.readdir(this.projectsDir, { withFileTypes: true });
      for (const d of projectDirs) {
        if (!d.isDirectory()) continue;
        const candidate = path.join(this.projectsDir, d.name, sessionId, 'tool-results');
        try {
          const st = await fs.stat(candidate);
          if (st.isDirectory()) return candidate;
        } catch { /* 当前 project 未找到，继续下一个。 */ }
      }
    } catch { /* projects 根目录可能尚不存在或不可读。 */ }
    return null;
  }

  // ─── SQLite 数据补全 ───────────────────────────────────────────────────────

  /**
   * 从 agents.db 读取一个 session 的用户 prompt 和工具结果。
   *
   * 优先解析旧/标准布局 `sub_chats.messages`；它完全为空时，再查询新布局独立 messages 表。
   * 数据库不存在返回 null，SQL/连接错误记录 warn 后返回 null，使 SDK 元数据仍可输出。
   *
   * @param sessionId 与 sub_chats.session_id 匹配的 SDK session。
   * @returns 至少含一个 prompt/工具结果时返回数据，否则 null。
   */
  private async readDbSessionData(sessionId: string): Promise<DbSessionData | null> {
    try {
      await fs.access(this.dbPath);
    } catch {
      return null;
    }

    try {
      const userPrompts: DbUserPrompt[] = [];
      const toolResults: DbSessionData['toolResults'] = [];

      // 策略一：旧/标准 Qoder Work 把整个消息数组放在 sub_chats.messages。
      const rows = await queryReadonly<{ messages: string }>(
        this.dbPath,
        `SELECT sc.messages FROM sub_chats sc WHERE sc.session_id = ? AND sc.messages IS NOT NULL AND sc.messages != '[]'`,
        [sessionId],
      );

      // 单条坏 JSON 只跳过该 sub_chat，其他行继续解析。
      for (const row of rows) {
        let messages: unknown[];
        try { messages = JSON.parse(row.messages); } catch { continue; }
        if (!Array.isArray(messages)) continue;

        // sequence fallback 使用数组下标，以便 prompt 候选保持稳定顺序。
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          if (!msg || typeof msg !== 'object') continue;
          const m = msg as Record<string, unknown>;

          if (m.role === 'user') {
            const text = extractUserText(m);
            if (text) {
              userPrompts.push({
                id: stringFrom(m.id) || stringFrom(m.uuid) || `subchat-${i}`,
                text,
                updatedAtMs: millisFromUnknown(m.timestamp) ?? millisFromUnknown(m.created_at) ?? 0,
                sequence: i,
              });
            }
          }

          if (m.role === 'assistant' && Array.isArray(m.parts)) {
            collectToolResultsFromParts(m.parts as Array<Record<string, unknown>>, toolResults);
          }
        }
      }

      // 策略二：现代布局 sub_chats.messages 为 []，真实消息在 messages 表。
      if (userPrompts.length === 0 && toolResults.length === 0) {
        const msgRows = await queryReadonly<{ id: string; role: string; parts: string; updatedAt: number; sequence: number }>(
          this.dbPath,
          `SELECT m.id AS id, m.role AS role, m.parts AS parts, m.updated_at AS updatedAt, m.sequence AS sequence
           FROM messages m
           JOIN sub_chats sc ON m.sub_chat_id = sc.id
           WHERE sc.session_id = ?
             AND m.parts IS NOT NULL
             AND m.parts != ''
             AND m.parts != '[]'
           ORDER BY m.sequence ASC, m.updated_at ASC
           LIMIT ${DB_MESSAGE_LIMIT}`,
          [sessionId],
        );

        for (const row of msgRows) {
          let parsed: unknown;
          try { parsed = JSON.parse(row.parts); } catch { continue; }
          if (!Array.isArray(parsed)) continue;

          if (row.role === 'user') {
            const text = extractUserText({ parts: parsed });
            if (text) {
              userPrompts.push({
                id: row.id,
                text,
                updatedAtMs: row.updatedAt > 0 ? row.updatedAt * 1000 : 0,
                sequence: row.sequence,
              });
            }
          } else if (row.role === 'assistant') {
            collectToolResultsFromParts(parsed as Array<Record<string, unknown>>, toolResults);
          }
        }
      }

      // 先按会话 sequence，再用更新时间打破并列，供窗口匹配确定性选择。
      userPrompts.sort((a, b) => a.sequence - b.sequence || a.updatedAtMs - b.updatedAtMs);
      return userPrompts.length > 0 || toolResults.length > 0 ? { userPrompts, toolResults } : null;
    } catch (err) {
      this.logger.warn('failed to read qoder-work sqlite for trace', { error: String(err) });
      return null;
    }
  }

  // ─── 标准事件树输出 ────────────────────────────────────────────────────────

  /**
   * 将一个完成窗口补全并展开为 ENTRY/STEP/LLM/TOOL 所需的扁平事件序列。
   *
   * 补全优先级：PostToolUse 内存结果 -> SQLite 工具结果 -> tool-results 文件。物理窗口先去重，再
   * 匹配尚未消费的 prompt 生成稳定 turn ID；每个 SDK ActiveTurn 变为一个 STEP。成功构建后才
   * 持久化 emit/prompt/counter 状态并清 session cache。
   *
   * @param completed result 或 TTL 产生的完成窗口。
   * @returns 已按 ENTRY、各 STEP 内 request/response/tool 顺序排列的标准事件。
   */
  private async emitSessionSpans(completed: CompletedSessionWindow): Promise<AgentActivityEntry[]> {
    const { session, sessionId, resultId, resultTimestamp } = completed;
    if (session.turns.length === 0) {
      this.cleanupSessionCaches(sessionId);
      return [];
    }

    // 先用只依赖物理窗口的 key 快速挡住 result/TTL 重复观察。
    const physicalEmitKey = this.resolvePhysicalEmitKey(sessionId, session, resultId, resultTimestamp);
    if (this.hasEmittedWindow(physicalEmitKey)) {
      this.cleanupSessionCaches(sessionId);
      return [];
    }

    // DB 不可用时仍可 fallback turn 计数并输出 SDK 结构。
    const dbData = await this.readDbSessionData(sessionId);
    const identity = this.resolveTurnIdentity(sessionId, session, physicalEmitKey, dbData, resultTimestamp);
    if (!identity || this.hasEmittedWindow(identity.emitKey)) {
      this.cleanupSessionCaches(sessionId);
      return [];
    }

    // 工具结果来源按可靠性合并；先写入的 PostToolUse 不被 SQLite 覆盖。
    const toolResultMap = new Map<string, string>();
    const sdkToolResults = this.sessionToolResults.get(sessionId);
    if (sdkToolResults) {
      for (const [k, v] of sdkToolResults) toolResultMap.set(k, v);
    }
    if (dbData?.toolResults) {
      for (const tr of dbData.toolResults) {
        if (!toolResultMap.has(tr.toolCallId)) toolResultMap.set(tr.toolCallId, tr.result);
      }
    }

    // 最后回退读取 tool-results 文件；CN 会把部分结果按 `<toolId>.txt` 单独保存。
    const missingIds: string[] = [];
    for (const turn of session.turns) {
      for (const tc of turn.toolCalls) {
        if (!toolResultMap.has(tc.id)) missingIds.push(tc.id);
      }
    }
    if (missingIds.length > 0) {
      const toolResultDir = this.sessionToolResultDirs.get(sessionId) ?? await this.findToolResultDir(sessionId);
      if (toolResultDir) {
        for (const toolId of missingIds) {
          try {
            const content = await fs.readFile(path.join(toolResultDir, `${toolId}.txt`), 'utf-8');
            toolResultMap.set(toolId, content);
          } catch { /* 单个结果文件可能不存在或尚未写完，保留无内容 result 结构。 */ }
        }
      }
    }

    // 每个标准 turn 生成一次 traceId，窗口内所有事件共享。
    const traceId = crypto.randomBytes(16).toString('hex');

    const startTime = session.turns[0].startTimestamp;
    const model = session.turns[0].model || UNKNOWN_MODEL;
    const userId = this.configuredUserId || undefined;
    const turnId = identity.turnId;

    const entries: AgentActivityEntry[] = [];

    const baseFields = {
      trace_id: traceId,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.agent.type': this.agentType,
      'gen_ai.request.model': model,
      'user.id': userId,
    };

    // 用户 prompt 输出为 other 并挂到 s1，避免 converter 额外创建空 STEP。
    const matchedPrompt = identity.userPrompt;
    const firstStepId = `${turnId}:s1`;
    // 有 DB 时间用真实 prompt 时间；否则放在首个 LLM 前 100ms 或 session 更早的起点。
    const entryTime = matchedPrompt?.updatedAtMs && matchedPrompt.updatedAtMs > 0
      ? matchedPrompt.updatedAtMs
      : session.startTime < startTime ? session.startTime : startTime - 100;
    entries.push(buildAgentActivityEntry({
      ...baseFields,
      'gen_ai.request.model': undefined,
      'gen_ai.step.id': firstStepId,
      time_unix_nano: msToNanos(entryTime),
      'event.id': crypto.randomUUID(),
      'event.name': 'other',
      'gen_ai.input.messages_delta': matchedPrompt?.text
        ? [{ role: 'user', parts: [{ type: 'text', content: matchedPrompt.text }] }]
        : undefined,
      attributes: { source: this.source },
    }));

    // 按 STEP 保存引用，末尾对跨 STEP 工具结果做时间上界修正。
    const stepEntryGroups: Array<{ stepId: string; entries: AgentActivityEntry[] }> = [];

    // 每 STEP 输出扁平事件，不显式写 span_id；OTLP converter 根据 turn/step/call ID 推断层级。
    for (let round = 0; round < session.turns.length; round++) {
      const turn = session.turns[round];
      const stepId = `${turnId}:s${round + 1}`;
      const turnModel = turn.model || model;
      const isLastStep = round === session.turns.length - 1;

      const stepFields = { ...baseFields, 'gen_ai.step.id': stepId, 'gen_ai.request.model': turnModel };
      const stepEntries: AgentActivityEntry[] = [];

      // s1 输入是用户 prompt；后续 STEP 输入是上一 STEP 已找到的工具结果。
      let inputDelta: JsonValue | undefined;
      if (round === 0 && matchedPrompt?.text) {
        inputDelta = [{ role: 'user', parts: [{ type: 'text', content: matchedPrompt.text }] }];
      } else if (round > 0) {
        const prevTurn = session.turns[round - 1];
        if (prevTurn && prevTurn.toolCalls.length > 0) {
          const toolParts: JsonValue[] = [];
          for (const tc of prevTurn.toolCalls) {
            const result = toolResultMap.get(tc.id);
            if (result) {
              toolParts.push({ type: 'tool_call_response', id: tc.id, response: result });
            }
          }
          if (toolParts.length > 0) {
            inputDelta = [{ role: 'tool', parts: toolParts }];
          }
        }
      }

      // request 时间取 SDK message_start，并携带本步增量上下文。
      const stepRequest = buildAgentActivityEntry({
        ...stepFields,
        time_unix_nano: msToNanos(turn.startTimestamp),
        'event.id': crypto.randomUUID(),
        'event.name': 'llm.request',
        'gen_ai.input.messages_delta': inputDelta,
        attributes: { source: this.source },
      });
      entries.push(stepRequest);
      stepEntries.push(stepRequest);

      // response parts 按 reasoning、text、tool_call 顺序组合；工具参数做容错 JSON 解析。
      const outputParts: JsonValue[] = [];
      if (turn.thinkingContent) outputParts.push({ type: 'reasoning', content: turn.thinkingContent });
      if (turn.textContent) outputParts.push({ type: 'text', content: turn.textContent });
      if (turn.toolCalls.length > 0) {
        for (const tc of turn.toolCalls) {
          const toolPart: Record<string, JsonValue> = {
            type: 'tool_call',
            id: tc.id,
            name: tc.name,
          };
          const args = safeParseJson(tc.argumentsJson);
          if (args !== undefined) toolPart.arguments = args;
          outputParts.push(toolPart);
        }
      }

      // 有工具表示模型请求执行工具；无工具的最终步视为 end_turn，中间步保守为 stop。
      const finishReason = turn.toolCalls.length > 0 ? 'tool_calls' : (isLastStep ? 'end_turn' : 'stop');
      const outputMessages: JsonValue | undefined = outputParts.length > 0
        ? [{ role: 'assistant', parts: outputParts, finish_reason: finishReason }]
        : undefined;

      // response 携带 message ID、模型、token、结束原因和完整输出 parts。
      const llmResponse = buildAgentActivityEntry({
        ...stepFields,
        time_unix_nano: msToNanos(turn.endTimestamp),
        'event.id': crypto.randomUUID(),
        'event.name': 'llm.response',
        'gen_ai.response.id': turn.messageId,
        'gen_ai.response.model': turnModel,
        'gen_ai.usage.input_tokens': finiteNum(turn.inputTokens),
        'gen_ai.usage.output_tokens': finiteNum(turn.outputTokens),
        'gen_ai.usage.total_tokens': sumIfPresent(finiteNum(turn.inputTokens), finiteNum(turn.outputTokens)),
        'gen_ai.response.finish_reasons': [finishReason],
        'gen_ai.output.messages': outputMessages,
        attributes: { source: this.source },
      });
      entries.push(llmResponse);
      stepEntries.push(llmResponse);

      // 每个工具固定输出 call/result 结构；结果内容允许缺失，但 call ID 始终可用于配对。
      for (const tc of turn.toolCalls) {
        const toolResult = toolResultMap.get(tc.id);

        const toolCall = buildAgentActivityEntry({
          ...stepFields,
          time_unix_nano: msToNanos(tc.startTs),
          'event.id': crypto.randomUUID(),
          'event.name': 'tool.call',
          'gen_ai.tool.name': tc.name,
          'gen_ai.tool.call.id': tc.id,
          'gen_ai.tool.call.arguments': safeParseJson(tc.argumentsJson),
          attributes: { source: this.source },
        });
        entries.push(toolCall);
        stepEntries.push(toolCall);

        const toolResultEntry = buildAgentActivityEntry({
          ...stepFields,
          time_unix_nano: msToNanos(tc.endTs),
          'event.id': crypto.randomUUID(),
          'event.name': 'tool.result',
          'gen_ai.tool.name': tc.name,
          'gen_ai.tool.call.id': tc.id,
          'gen_ai.tool.call.result': toolResult ?? undefined,
          'gen_ai.tool.call.duration': tc.endTs > tc.startTs ? tc.endTs - tc.startTs : undefined,
          attributes: { source: this.source },
        });
        entries.push(toolResultEntry);
        stepEntries.push(toolResultEntry);
      }

      stepEntryGroups.push({ stepId, entries: stepEntries });
    }

    // STEP 时间重叠修正：若 step N 的 tool.result 晚于 N+1 request，则截到其前 1ms。
    for (let i = 0; i < stepEntryGroups.length - 1; i++) {
      const currentStep = stepEntryGroups[i];
      const nextStep = stepEntryGroups[i + 1];
      const nextRequest = nextStep.entries.find(e => e['event.name'] === 'llm.request');
      if (!nextRequest) continue;
      const nextStartNano = nextRequest.time_unix_nano;
      if (!nextStartNano) continue;
      const nextStartBig = BigInt(nextStartNano);
      const capNano = String(nextStartBig - 1_000_000n);

      for (const e of currentStep.entries) {
        if (e['event.name'] !== 'tool.result') continue;
        const ts = e.time_unix_nano;
        if (ts && BigInt(ts) > nextStartBig) {
          (e as Record<string, unknown>)['time_unix_nano'] = capNano;
        }
      }
    }

    // 只有事件全部构造完成后才标记已发送；BaseInput 随后负责 StateStore.save。
    this.markWindowEmitted(identity);
    this.cleanupSessionCaches(sessionId);
    return entries;
  }

  /**
   * 为完成窗口选择标准 turn ID，并同时检查物理窗口是否已输出。
   * @returns 匹配 prompt 时使用 `<session>:<promptId>`；否则分配 `<session>:t<N>`；重复窗口为 null。
   */
  private resolveTurnIdentity(
    sessionId: string,
    session: SessionState,
    physicalEmitKey: string,
    dbData: DbSessionData | null,
    resultTimestamp?: number,
  ): TurnIdentity | null {
    const prompt = this.matchUserPrompt(session, dbData, resultTimestamp);
    if (this.hasEmittedWindow(physicalEmitKey)) return null;

    if (prompt?.id) {
      return {
        sessionId,
        turnId: `${sessionId}:${prompt.id}`,
        emitKey: physicalEmitKey,
        userPrompt: prompt,
      };
    }

    const fallbackCounter = this.nextFallbackTurnCounter(sessionId);
    return {
      sessionId,
      turnId: `${sessionId}:t${fallbackCounter}`,
      emitKey: physicalEmitKey,
      fallbackCounter,
    };
  }

  /**
   * 构造不依赖 SQLite 的物理窗口去重键。
   * 优先级为 resultId -> 最后 messageId -> result 时间 -> session 时间窗口。
   */
  private resolvePhysicalEmitKey(
    sessionId: string,
    session: SessionState,
    resultId?: string,
    resultTimestamp?: number,
  ): string {
    const lastMessageId = [...session.turns].reverse().find(turn => turn.messageId)?.messageId;
    if (resultId) return `${sessionId}:result:${resultId}`;
    if (lastMessageId) return `${sessionId}:last-message:${lastMessageId}`;
    if (resultTimestamp) return `${sessionId}:result-ts:${resultTimestamp}`;
    return `${sessionId}:window:${session.startTime}:${session.lastSeenMs}`;
  }

  /**
   * 从未消费 prompt 中选择最符合当前 SDK 窗口的一条。
   *
   * 先选不晚于窗口上界的候选并按与首 STEP 距离排序；没有时再在 5 分钟容差内比较窗口首尾。
   * @returns 最佳候选；无可用 prompt 时 undefined，调用方使用 fallback turn counter。
   */
  private matchUserPrompt(
    session: SessionState,
    dbData: DbSessionData | null,
    resultTimestamp?: number,
  ): DbUserPrompt | undefined {
    const prompts = dbData?.userPrompts ?? [];
    if (prompts.length === 0) return undefined;

    // 已消费 ID 从 StateStore 恢复，避免同一 DB prompt 被后续 result window 重用。
    const consumed = new Set(this.getStringArrayState('consumedPromptIds'));
    const unconsumed = prompts.filter(prompt => prompt.id && !consumed.has(prompt.id));
    if (unconsumed.length === 0) return undefined;

    const windowStart = session.turns[0]?.startTimestamp ?? session.startTime;
    const resultTime = resultTimestamp ?? session.lastSeenMs;
    const upperBound = Math.max(windowStart, resultTime) + 30_000;
    // 先处理时间落在窗口上界之前的常规候选，未知时间放到末尾。
    const orderedCandidates = unconsumed
      .filter(prompt => prompt.updatedAtMs === 0 || prompt.updatedAtMs <= upperBound)
      .sort((a, b) => {
        const da = a.updatedAtMs > 0 ? Math.abs(a.updatedAtMs - windowStart) : Number.MAX_SAFE_INTEGER;
        const db = b.updatedAtMs > 0 ? Math.abs(b.updatedAtMs - windowStart) : Number.MAX_SAFE_INTEGER;
        return da - db || a.sequence - b.sequence;
      });
    if (orderedCandidates.length > 0) return orderedCandidates[0];

    // 常规候选为空时，允许在固定容差内匹配略晚落盘的 SQLite 行。
    const nearest = unconsumed
      .filter(prompt => prompt.updatedAtMs > 0)
      .map(prompt => ({ prompt, delta: Math.min(Math.abs(prompt.updatedAtMs - windowStart), Math.abs(prompt.updatedAtMs - resultTime)) }))
      .filter(item => item.delta <= PROMPT_MATCH_TOLERANCE_MS)
      .sort((a, b) => a.delta - b.delta || a.prompt.sequence - b.prompt.sequence)[0];
    return nearest?.prompt;
  }

  /** 查询持久化的最近 emittedWindowKeys；数组很小，线性 includes 足够。 */
  private hasEmittedWindow(emitKey: string): boolean {
    return this.getStringArrayState('emittedWindowKeys').includes(emitKey);
  }

  /**
   * 原地更新当前 Input 的去重窗口、已消费 prompt 和 fallback turn 计数，并裁剪状态大小。
   * @param identity 已成功构造事件的窗口身份。
   */
  private markWindowEmitted(identity: TurnIdentity): void {
    const state = this.getState();
    const extra = toPlainObject(state.extra);
    const emittedWindowKeys = capArray([...this.getStringArrayState('emittedWindowKeys'), identity.emitKey], WINDOW_STATE_LIMIT);
    const consumedPromptIds = identity.userPrompt?.id
      ? capArray([...this.getStringArrayState('consumedPromptIds'), identity.userPrompt.id], WINDOW_STATE_LIMIT)
      : this.getStringArrayState('consumedPromptIds');
    const turnCounters = toNumberRecord(extra.turnCounters);
    if (identity.fallbackCounter !== undefined) {
      turnCounters[identity.sessionId] = Math.max(turnCounters[identity.sessionId] ?? 0, identity.fallbackCounter);
    }
    this.setState({
      extra: {
        ...extra,
        emittedWindowKeys,
        consumedPromptIds,
        turnCounters: capNumberRecord(turnCounters, TURN_COUNTER_STATE_LIMIT),
      },
    });
  }

  /** 读取指定 session 当前 fallback 计数并返回下一个值；真正持久化在 markWindowEmitted。 */
  private nextFallbackTurnCounter(sessionId: string): number {
    const extra = toPlainObject(this.getState().extra);
    const turnCounters = toNumberRecord(extra.turnCounters);
    return (turnCounters[sessionId] ?? 0) + 1;
  }

  /** 从当前 InputState.extra 安全读取非空字符串数组。 */
  private getStringArrayState(key: string): string[] {
    const value = toPlainObject(this.getState().extra)[key];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
  }

  /** 完成/跳过窗口后释放 PostToolUse 结果和目录缓存。 */
  private cleanupSessionCaches(sessionId: string): void {
    this.sessionToolResults.delete(sessionId);
    this.sessionToolResultDirs.delete(sessionId);
  }
}

// ─── 辅助函数 ────────────────────────────────────────────────────────────────

/**
 * 从 assistant parts 中收集具有 call ID 和非空结果的真实工具结果。
 * @param parts SQLite JSON 解析出的消息 parts。
 * @param toolResults 调用方提供的输出数组；函数原地追加。
 */
function collectToolResultsFromParts(
  parts: Array<Record<string, unknown>>,
  toolResults: Array<{ toolCallId: string; result: string }>,
): void {
  for (const part of parts) {
    const partType = typeof part.type === 'string' ? part.type : '';
    // Thinking 不是工具执行；字段名兼容多版本 schema。
    if (!partType.startsWith('tool-') || partType === 'tool-Thinking') continue;
    const callId = typeof part.toolCallId === 'string' ? part.toolCallId
      : typeof part.tool_call_id === 'string' ? part.tool_call_id
      : typeof part.id === 'string' ? part.id : '';
    const result = typeof part.output === 'string' ? part.output
      : typeof part.result === 'string' ? part.result
      : part.output !== undefined ? JSON.stringify(part.output) : '';
    if (callId && result) toolResults.push({ toolCallId: callId, result });
  }
}

/** 把未知值收窄为非空字符串，否则返回 undefined。 */
function stringFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 把秒/毫秒数字、数字字符串或 ISO 时间转成 epoch 毫秒。
 * 绝对值大于 1e12 的数视为已经是毫秒，其余数值按秒处理。
 */
function millisFromUnknown(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return asNumber > 1e12 ? asNumber : asNumber * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** 只保留数组最后 max 项，限制持久化窗口。 */
function capArray<T>(values: T[], max: number): T[] {
  return values.length > max ? values.slice(values.length - max) : values;
}

/** 把未知值收窄为非数组普通对象；null/数组/原始值返回空对象。 */
function toPlainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** 对计数对象按属性插入顺序只保留最后 max 项。 */
function capNumberRecord(values: Record<string, number>, max: number): Record<string, number> {
  const entries = Object.entries(values);
  return Object.fromEntries(entries.length > max ? entries.slice(entries.length - max) : entries);
}

/** 从未知对象中过滤有限 number 属性，丢弃损坏的持久化值。 */
function toNumberRecord(value: unknown): Record<string, number> {
  const input = toPlainObject(value);
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
  }
  return out;
}

/** 仅返回大于 0 的有限 token 数，0/坏值转 undefined 以省略字段。 */
function finiteNum(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 两侧 token 都存在时求和；任一缺失时不伪造 total。 */
function sumIfPresent(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined || b === undefined) return undefined;
  return a + b;
}

/**
 * 兼容 content 字符串、parts 数组和 content 数组，提取全部 text/content 后换行合并。
 */
function extractUserText(msg: Record<string, unknown>): string {
  if (typeof msg.content === 'string') return msg.content;
  const parts = Array.isArray(msg.parts) ? msg.parts : Array.isArray(msg.content) ? msg.content : [];
  const texts: string[] = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    const part = p as Record<string, unknown>;
    if (typeof part.text === 'string' && part.text) texts.push(part.text);
    else if (typeof part.content === 'string' && part.content) texts.push(part.content);
  }
  return texts.join('\n');
}

/**
 * 容错解析工具参数分片；合法 JSON 返回结构化 JsonValue，坏 JSON 保留原字符串。
 */
function safeParseJson(value: string): JsonValue | undefined {
  if (!value) return undefined;
  try { return JSON.parse(value); } catch { return value; }
}

/**
 * 用只读 sqlite3 连接执行参数化查询，并在 query 后关闭连接。
 * open/query/close 任一失败都会 reject，由 readDbSessionData 捕获并降级。
 */
function queryReadonly<T>(dbPath: string, sql: string, params: unknown[]): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (openErr) => {
      if (openErr) { reject(openErr); return; }
      // Promise 只在 close 回调中 settle，确保上层继续前资源已释放。
      db.all(sql, params, (queryErr: Error | null, rows: T[]) => {
        db.close((closeErr) => {
          if (queryErr) { reject(queryErr); return; }
          if (closeErr) { reject(closeErr); return; }
          resolve(rows);
        });
      });
    });
  });
}

/**
 * 从 SDK 文件尾以 64 KiB 分块反向查找最后 result 行，返回其结束换行后的 byte offset。
 * 没有 result 时返回 0 以保留在途 turn；句柄始终在 finally 关闭。
 */
async function findLastResultBoundary(filePath: string, size: number): Promise<number> {
  if (size <= 0) return 0;
  const CHUNK = 64 * 1024;
  const handle = await fs.open(filePath, 'r');
  try {
    let cursor = size;
    let tail = '';
    while (cursor > 0) {
      const readSize = Math.min(CHUNK, cursor);
      cursor -= readSize;
      const buf = Buffer.alloc(readSize);
      await handle.read(buf, 0, readSize, cursor);
      tail = buf.toString('utf-8') + tail;
      const lines = tail.split('\n');
      // 首行可能横跨当前块与更早块，暂存 fragment 下轮拼接。
      const fragment = cursor > 0 ? lines.shift() ?? '' : '';
      const offsets: number[] = [];
      let off = cursor + Buffer.byteLength(fragment, 'utf-8');
      // UTF-8 字符字节数不等于 JS 字符长度，必须用 Buffer.byteLength 计算真实 offset。
      for (const line of lines) { offsets.push(off); off += Buffer.byteLength(line, 'utf-8') + 1; }
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].includes('Received message: result ')) {
          return offsets[i] + Buffer.byteLength(lines[i], 'utf-8') + 1;
        }
      }
      tail = fragment;
    }
    return 0;
  } finally {
    await handle.close();
  }
}
