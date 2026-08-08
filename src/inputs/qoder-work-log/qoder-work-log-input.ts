/**
 * Qoder Work / Qoder Work CN 的 SDK 纯文本日志增量输入与共享解析器。
 *
 * 本文件中的 `QoderWorkLogInput` 扫描平台数据目录下各 session 的 `main.log` 或旧版
 * `main/sdk-*.log`，从异步写入的 SDK 行恢复 session、turn、模型策略、token 和工具调用元数据。
 * 因 delta 的物理落盘顺序不可靠，本 Input 有意不拼接 prompt/response/tool arguments；Trace
 * 关闭时，Orchestrator 会同时启用 Hook 与 SQLite Input 来补足这些内容。
 *
 * `parseSdkLogLine` / `SdkEvent` 还被两个 Trace 实现复用。BaseInput 管理轮询和停止；本类按文件
 * 保存 byte offset、inode 与内存状态机，轮转时重置。输出标准事件经 InputManager 进入统一策略
 * 和 MultiFlusher。所有文件和 JSON 解析错误均按单文件/单行隔离，不持有跨周期文件句柄。
 */
// 内置模块分别用于 event.id/trace_id、异步文件读取、home/平台目录和路径拼接。
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';
// 产品类型决定实例 ID 与标准事件中的 gen_ai.agent.type。
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
// builder 统一时间、ID、gen_ai 字段和 Agent 私有 attributes。
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';
// 继承 Session Input 只为复用生命周期/collectionMethod；纯文本读取路径由本类覆盖。
import {
  BaseSessionInput,
  type SessionInputOptions,
} from '../base/base-session-input.js';

/** 国际版/CN 在 macOS 和 Linux 下的默认应用数据根目录。 */
const DEFAULT_QODERWORK_ROOT_MAC = '~/Library/Application Support/QoderWork';
const DEFAULT_QODERWORK_ROOT_LINUX = '~/.config/QoderWork';
const DEFAULT_QODERWORK_CN_ROOT_MAC = '~/Library/Application Support/QoderWork CN';
const DEFAULT_QODERWORK_CN_ROOT_LINUX = '~/.config/QoderWork CN';
/** 事件来源标记和缺失模型时的显式占位值。 */
const SOURCE = 'qoder-work-sdk-log';
const UNKNOWN_MODEL = 'unknown';
/** 每文件单轮最大读取量，以及无活动 session 的内存保留时间。 */
const MAX_READ_BYTES = 16 * 1024 * 1024;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** 匹配 SDK 发给客户端的已接收消息行，捕获时间、日志级别、消息类型和 JSON。 */
const RECEIVED_MSG_RE =
  /^\[([^\]]+)\] \[(\w+)\] \[SDK\] \[QueryHandler\] Received message: (\w+) (.+)$/;
/**
 * `Sending control request: set_model_policy` 是客户端发给 SDK 的模型策略请求。
 * payload 的 chat/compact/scene_model 槽位携带真实模型键，例如主对话的 `qwork-ultimate`；
 * 收到 `message_start` 时会按 session 订阅层级选择槽位并快照，避免后续策略变化改写旧 turn。
 */
const SET_MODEL_POLICY_RE =
  /^\[([^\]]+)\] \[(\w+)\] \[SDK\] \[QueryHandler\] Sending control request: set_model_policy (.+)$/;

/** SDK Log Input 参数；dataRoot/agentType 使同一实现可服务国际版和 CN。 */
export interface QoderWorkLogInputOptions extends Omit<SessionInputOptions, 'sessionDir' | 'filePattern'> {
  /** 覆盖 Qoder Work 数据根目录；默认按产品变体和平台解析。 */
  dataRoot?: string;
  /** 当前实例的 Agent 类型；默认国际版 QoderWork。 */
  agentType?: ClientType;
}

/** SDK system init 建立的会话级状态；常驻到 TTL 淘汰或进程退出。 */
interface SessionState {
  /**
   * `system init.model` 在国际版表示订阅层级（Standard/Premium），不是实际 LLM 模型键。
   * 真正模型来自 set_model_policy，并在 message_start 时写入 ActiveTurn；订阅层级仍保存在
   * attributes.subscription_tier。CN 可能把实际策略名放在此字段，代码会在无显式策略时兜底。
   */
  subscriptionTier: string;
  /** 会话工作目录和宿主声明的 Agent/工具清单。 */
  cwd: string;
  agents: string[];
  tools: string[];
  /** 最近事件时间用于 TTL 淘汰；traceId/turnCounter 用于同 session 内层级关联。 */
  lastSeenMs: number;
  traceId: string;
  turnCounter: number;
}

/** 一个 tool_use block 的最小配对信息；本路径不重建参数。 */
interface ToolCallSlot {
  id: string;
  name: string;
}

/** 从 message_start 到下一 turn/result 之间累积的 LLM turn 状态。 */
interface ActiveTurn {
  messageId: string;
  /** turn 开始时按订阅层级选出的模型策略快照。 */
  model: string;
  toolCalls: ToolCallSlot[];
  /** content block index -> toolCalls 数组下标；当前只为状态结构兼容保留。 */
  toolIndexMap: Map<number, number>;
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  startTimestamp: number;
  endTimestamp: number;
}

/**
 * `parseSdkLogLine` 的判别联合返回值。
 * kind 让 TypeScript 在 switch 中收窄字段；时间统一为 epoch 毫秒。
 */
export type SdkEvent =
  | {
      kind: 'system_init';
      ts: number;
      sessionId: string;
      subscriptionTier: string;
      cwd: string;
      agents: string[];
      tools: string[];
    }
  | {
      /**
       * 客户端为后续 turn 固定的模型策略。chat 用于主对话，compact/scene_model 用于摘要或
       * 场景任务；三个槽位都保留，message_start 再按 session 层级选择。
       */
      kind: 'set_model_policy';
      ts: number;
      chatModel: string;
      compactModel: string;
      sceneModel: string;
    }
  | { kind: 'message_start'; ts: number; sessionId: string; messageId: string }
  | {
      kind: 'block_start';
      ts: number;
      sessionId: string;
      blockType: 'thinking' | 'text' | 'tool_use';
      index: number;
      toolName?: string;
      toolId?: string;
    }
  | {
      kind: 'delta';
      ts: number;
      sessionId: string;
      deltaType: 'thinking_delta' | 'text_delta' | 'input_json_delta';
      content: string;
      blockIndex?: number;
    }
  | { kind: 'message_delta'; ts: number; sessionId: string; stopReason: string; inputTokens: number; outputTokens: number }
  | { kind: 'message_stop'; ts: number; sessionId: string }
  | {
      kind: 'result';
      ts: number;
      sessionId: string;
      resultId: string;
      subtype: string;
      durationMs: number;
      durationApiMs: number;
      numTurns: number;
      contextUsageRatio: number;
    }
  | { kind: 'post_tool_use'; ts: number; sessionId: string; toolUseId: string; toolName: string; toolResponse: string; transcriptPath: string };

/**
 * Qoder Work SDK 日志 tail Input。
 *
 * SDK 异步写日志，文件中的 thinking/text/input_json delta 顺序不等于模型真实生成顺序；按文件
 * 顺序拼接会得到乱码或错序内容。因此本类在 turn 关闭时仅输出 LLM/工具元数据，正文由并行启用
 * 的 Hook/SQLite 回退 Input 提供。
 *
 * 模型归属来自 set_model_policy 的 chat/compact/scene_model 槽位：Premium 主对话优先 chat，
 * Standard 场景任务优先 scene_model，再逐级回退。每次 message_start 将当时值快照进 ActiveTurn，
 * 最终写到 gen_ai.request.model / gen_ai.response.model。
 *
 * 每个 turn 输出 llm.request、带 token/finish reason/message_id 的 llm.response，以及每个
 * tool_use 的 tool.call；工具参数同样因异步顺序问题有意省略。result 还输出 session 级 other。
 * 类继承 BaseSessionInput，但覆盖 collect 读取纯文本；生命周期中无后台子进程或网络 I/O。
 */
export class QoderWorkLogInput extends BaseSessionInput {
  /** 根据变体生成 `qoder-work-log` 或 `qoder-work-cn-log`。 */
  readonly id: string;
  readonly agentType: ClientType;

  /** session 元数据与当前未完成 turn，key 均为 SDK session_id。 */
  private readonly sessions: Map<string, SessionState> = new Map();
  private readonly activeTurns: Map<string, ActiveTurn> = new Map();
  /** handleEvent 之外暂存的事件；当前代码没有写入点，保留原因待确认。 */
  private pendingEntries: AgentActivityEntry[] = [];
  /** 当前处理文件路径；当前仅在 collect 中赋值，其他逻辑未读取，保留原因待确认。 */
  private currentFilePath: string = '';
  /**
   * 每文件模型策略。不同 SDK 日志可能来自各自进程和 set_model_policy，因此按路径隔离；
   * processLogFile 开始恢复、结束保存，既跨轮询连续，又不把一个文件的策略泄漏到另一个文件。
   */
  private readonly fileModelPolicies: Map<string, { chat: string; compact: string; scene: string }> = new Map();
  private currentModelPolicy: { chat: string; compact: string; scene: string } = {
    chat: '',
    compact: '',
    scene: '',
  };
  /**
   * 解析变体数据目录并配置 SDK 日志扫描根目录。
   * @param opts StateStore、轮询周期及可选 dataRoot/agentType。
   */
  constructor(opts: QoderWorkLogInputOptions) {
    // Orchestrator 为 CN 实例显式传 agentType/dataRoot；其他调用默认国际版。
    const agentType = opts.agentType ?? ClientType.QoderWork;
    const dataRoot = opts.dataRoot ?? resolveQoderWorkRoot(agentType === ClientType.QoderWorkCN ? 'cn' : 'standard');
    super({
      stateStore: opts.stateStore,
      sessionDir: path.join(dataRoot, 'logs'),
      filePattern: 'sdk-*.log',
      pollIntervalMs: opts.pollIntervalMs ?? 30_000,
    });
    this.agentType = agentType;
    this.id = `${agentType}-log`;
  }

  /**
   * 返回国际版默认 SDK 日志目录，供 discovery watcher 使用。
   * @returns 单元素绝对路径数组；CN 注册由 Orchestrator 提供专用路径。
   */
  static getWatchPaths(): string[] {
    return [path.join(resolveQoderWorkRoot(), 'logs')];
  }

  /**
   * 判断国际版默认 logs 目录是否存在。
   * @returns 目录存在为 true；CN 实例在 Orchestrator 中使用自定义检查。
   */
  static async checkAvailability(): Promise<boolean> {
    return directoryExists(path.join(resolveQoderWorkRoot(), 'logs'));
  }

  /**
   * 首次启动为每个 SDK 日志建立 offset/inode 基线。
   *
   * offset 定位到最近 result 行之后，因此已完成历史不会回放；尚无 result 的文件从 0 读取，
   * 使正在进行的 turn 结束时仍能完整输出。已有 offset 时不覆盖。轮转竞态只跳过该文件。
   */
  protected override async onStart(): Promise<void> {
    // 首次基线跳过已完成 turn，但保留尚未出现 result 的在途 turn。
    const files = await this.discoverSessionFiles();
    for (const filePath of files) {
      try {
        const stat = await fs.stat(filePath);
        const stateKey = `${this.id}:${filePath}`;
        const prev = this.stateStore.get(stateKey);
        if (prev.lastOffset !== undefined) continue;

        const baselineOffset = await findLastResultBoundary(filePath, stat.size);
        this.stateStore.setOffset(stateKey, baselineOffset);
        this.stateStore.update(stateKey, {
          extra: { inode: (stat as unknown as { ino: number }).ino },
        });
      } catch {
        // 扫描与 stat 之间可能发生日志轮转；下轮 discovery 会重新发现。
      }
    }
  }

  /**
   * 发现新旧两种 SDK 日志布局。
   * @returns 排序后的完整文件路径；根目录不可读时返回空数组。
   */
  protected async discoverSessionFiles(): Promise<string[]> {
    const files: string[] = [];
    let sessionDirs: Dirent[];
    try {
      sessionDirs = await fs.readdir(this.sessionDir, { withFileTypes: true });
    } catch {
      return files;
    }

    // 第一层每个目录代表一个 SDK session；非目录项不参与。
    for (const dir of sessionDirs) {
      if (!dir.isDirectory()) continue;
      const sessionPath = path.join(this.sessionDir, dir.name);

      // 新布局：`<session>/main.log`，所有 SDK 事件混在单一文件。
      const mainLogPath = path.join(sessionPath, 'main.log');
      try {
        const st = await fs.stat(mainLogPath);
        if (st.isFile()) {
          files.push(mainLogPath);
          continue;
        }
      } catch { /* 未找到新布局时继续尝试旧布局。 */ }

      // 旧布局：`<session>/main/sdk-*.log`，一个 session 下可能有多个轮转文件。
      const mainDir = path.join(sessionPath, 'main');
      let entries: Dirent[];
      try {
        entries = await fs.readdir(mainDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (entry.name.startsWith('sdk-') && entry.name.endsWith('.log')) {
          files.push(path.join(mainDir, entry.name));
        }
      }
    }
    return files.sort();
  }

  /**
   * BaseSessionInput 要求实现的 JSON 行回调；本类的源文件是纯文本，所以始终返回 null。
   * 真正路径是下面覆盖的 collect -> processLogFile -> parseSdkLogLine。
   * @param record 偶然可解析成 JSON 的行，当前忽略。
   * @param filePath 来源路径，当前忽略。
   * @returns 恒为 null。
   */
  protected async processSessionLine(
    record: Record<string, unknown>,
    filePath: string,
  ): Promise<AgentActivityEntry | null> {
    // SDK 行不是 JSON，必须绕开 BaseSessionInput 的逐行 JSON.parse；此方法只满足抽象契约。
    void record;
    void filePath;
    return null;
  }

  /**
   * 执行一轮全部 SDK 文件增量读取、事件状态机处理和 TTL 清理。
   * @returns 本轮已闭合 turn/result 生成的标准事件；文件按路径串行处理以保持策略状态确定性。
   */
  protected override async collect(): Promise<AgentActivityEntry[]> {
    const files = await this.discoverSessionFiles();
    const allEntries: AgentActivityEntry[] = [];

    // 顺序处理使单文件内部事件顺序稳定；跨文件策略由 fileModelPolicies 隔离。
    for (const filePath of files) {
      this.currentFilePath = filePath;
      const fileEntries = await this.processLogFile(filePath);
      allEntries.push(...fileEntries);
    }
    this.currentFilePath = '';

    // 兼容预留队列存在数据时一次性转移并清空，避免重复发射。
    if (this.pendingEntries.length > 0) {
      allEntries.push(...this.pendingEntries);
      this.pendingEntries = [];
    }

    this.evictStaleSessions();
    return allEntries;
  }

  /** 删除 24 小时无事件的 session/turn 内存状态，防止常驻进程 Map 无界增长。 */
  private evictStaleSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeenMs > SESSION_TTL_MS) {
        this.sessions.delete(id);
        this.activeTurns.delete(id);
      }
    }
  }

  /**
   * 增量读取一个日志文件，并把可识别行送入状态机。
   *
   * inode 改变视为路径轮转并重置 offset/模型策略；单轮最多读取 16 MiB，达到上限时回退到
   * 最后完整换行，残行留到下轮。文件句柄在 finally 中关闭。
   *
   * @param filePath SDK main.log 或 sdk-*.log 完整路径。
   * @returns 本文件本轮闭合出的事件数组。
   */
  private async processLogFile(filePath: string): Promise<AgentActivityEntry[]> {
    // 每次处理前恢复该文件自己的模型策略，避免多个 SDK 进程互相污染。
    this.currentModelPolicy = this.fileModelPolicies.get(filePath)
      ?? { chat: '', compact: '', scene: '' };
    const stateKey = `${this.id}:${filePath}`;
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return [];
    }

    const prevState = this.stateStore.get(stateKey);
    const prevInode = prevState.extra?.inode as number | undefined;
    const currentInode = (stat as unknown as { ino: number }).ino;

    // inode 变化说明同路径已换成新文件，旧 byte offset 不再有效。
    if (prevInode !== undefined && prevInode !== currentInode) {
      this.stateStore.setOffset(stateKey, 0);
      this.stateStore.update(stateKey, { extra: { inode: currentInode } });
      this.fileModelPolicies.delete(filePath);
      this.currentModelPolicy = { chat: '', compact: '', scene: '' };
    } else if (prevInode === undefined) {
      this.stateStore.update(stateKey, { extra: { inode: currentInode } });
    }

    const offset = this.stateStore.getOffset(stateKey);
    if (stat.size <= offset) return [];

    const handle = await fs.open(filePath, 'r');
    let text: string;
    try {
      const readSize = Math.min(stat.size - offset, MAX_READ_BYTES);
      const buf = Buffer.alloc(readSize);
      await handle.read(buf, 0, readSize, offset);
      text = buf.toString('utf-8');

      // 触及 16 MiB 上限时末尾通常是半行；只推进到最后换行，残行下轮重读。
      let consumedBytes = readSize;
      if (readSize < stat.size - offset) {
        const lastNL = text.lastIndexOf('\n');
        if (lastNL >= 0) {
          text = text.substring(0, lastNL);
          consumedBytes = Buffer.byteLength(text, 'utf-8') + 1; // 加 1 计入换行字节。
        }
      }

      this.stateStore.setOffset(stateKey, offset + consumedBytes);
      this.stateStore.update(stateKey, { extra: { inode: currentInode } });
    } finally {
      await handle.close();
    }

    const out: AgentActivityEntry[] = [];
    // 无法识别或 JSON 损坏的 SDK 行由 parser 返回 null，只跳过该行。
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const event = parseSdkLogLine(line);
      if (!event) continue;
      this.handleEvent(event, filePath, out);
    }

    // 保存副本而不是对象引用，保证下个文件修改 currentModelPolicy 时不会反向改写。
    this.fileModelPolicies.set(filePath, { ...this.currentModelPolicy });
    return out;
  }

  /**
   * SDK 判别事件状态机：创建 session、更新模型策略、累积 active turn，并在边界生成事件。
   * @param event parseSdkLogLine 返回的已验证判别联合。
   * @param filePath 参与稳定 event.id 的来源文件。
   * @param out 当前文件的输出数组，函数会原地追加。
   */
  private handleEvent(
    event: SdkEvent,
    filePath: string,
    out: AgentActivityEntry[],
  ): void {
    switch (event.kind) {
      case 'system_init':
        // init 重新建立 session 元数据和新的 trace；同 ID 旧状态会被覆盖。
        this.sessions.set(event.sessionId, {
          subscriptionTier: event.subscriptionTier,
          cwd: event.cwd,
          agents: event.agents,
          tools: event.tools,
          lastSeenMs: event.ts,
          traceId: crypto.randomBytes(16).toString('hex'),
          turnCounter: 0,
        });
        // CN 可能只在 SDK 进程启动时发送一次 set_model_policy，而启动基线可能跳过它；尚无任何
        // 显式策略时，用 init.model 中非 Premium/Standard 的值作为 chat 策略种子。
        if (event.subscriptionTier &&
            !this.currentModelPolicy.chat &&
            !this.currentModelPolicy.scene &&
            !this.currentModelPolicy.compact) {
          const candidate = event.subscriptionTier.toLowerCase();
          if (candidate !== 'premium' && candidate !== 'standard') {
            this.currentModelPolicy.chat = candidate;
          }
        }
        return;

      case 'set_model_policy':
        // 纯状态更新，不输出事件；后续 message_start 才按 session 层级选择并快照槽位。
        if (event.chatModel) this.currentModelPolicy.chat = event.chatModel;
        if (event.compactModel) this.currentModelPolicy.compact = event.compactModel;
        if (event.sceneModel) this.currentModelPolicy.scene = event.sceneModel;
        return;

      case 'message_start': {
        // 同 session 新 message 开始前先关闭旧 active turn，防止状态被覆盖丢失。
        this.finalizeTurn(event.sessionId, filePath, out);
        const sess = this.sessions.get(event.sessionId);
        if (sess) {
          sess.lastSeenMs = event.ts;
          sess.turnCounter++;
        }
        this.activeTurns.set(event.sessionId, {
          messageId: event.messageId,
          model: this.pickModelForSession(event.sessionId),
          toolCalls: [],
          toolIndexMap: new Map(),
          stopReason: '',
          inputTokens: 0,
          outputTokens: 0,
          startTimestamp: event.ts,
          endTimestamp: event.ts,
        });
        return;
      }

      case 'block_start': {
        const turn = this.activeTurns.get(event.sessionId);
        if (!turn) return;
        // thinking/text 只更新时间；完整 tool_use 身份才进入工具列表。
        if (event.blockType === 'tool_use' && event.toolId && event.toolName) {
          const idx = turn.toolCalls.length;
          turn.toolIndexMap.set(event.index, idx);
          turn.toolCalls.push({ id: event.toolId, name: event.toolName });
        }
        turn.endTimestamp = event.ts;
        return;
      }

      case 'delta': {
        // 有意丢弃 thinking/text/input_json 内容，只刷新活动结束时间；原因见类注释。
        const turn = this.activeTurns.get(event.sessionId);
        if (!turn) return;
        turn.endTimestamp = event.ts;
        return;
      }

      case 'message_delta': {
        // message_delta 提供本 turn 的停止原因与 token，是 response 元数据权威来源。
        const turn = this.activeTurns.get(event.sessionId);
        if (!turn) return;
        turn.stopReason = event.stopReason;
        turn.inputTokens = event.inputTokens;
        turn.outputTokens = event.outputTokens;
        turn.endTimestamp = event.ts;
        return;
      }

      case 'message_stop': {
        const turn = this.activeTurns.get(event.sessionId);
        if (turn) turn.endTimestamp = event.ts;
        // 不能在此 finalize：SDK 日志中 message_delta 可能晚于 message_stop 落盘。
        return;
      }

      case 'result': {
        // result 是可靠 session 窗口边界：先输出最后 active turn，再输出汇总 other。
        this.finalizeTurn(event.sessionId, filePath, out);
        const session = this.sessions.get(event.sessionId);
        const resultModel = this.pickModelForSession(event.sessionId);
        out.push(
          buildAgentActivityEntry({
            timestamp: event.ts,
            'event.id': hashId([
              filePath,
              event.sessionId,
              'result',
              String(event.ts),
            ]),
            'event.name': 'other',
            trace_id: session?.traceId,
            'gen_ai.session.id': event.sessionId,
            'gen_ai.agent.type': this.agentType,
            'gen_ai.request.model': resultModel,
            'gen_ai.response.model': resultModel,
            attributes: {
              source: SOURCE,
              event_kind: 'result',
              result_subtype: event.subtype,
              duration_ms: event.durationMs,
              duration_api_ms: event.durationApiMs,
              num_turns: event.numTurns,
              context_usage_ratio: event.contextUsageRatio,
              ...sessionAttributes(session),
            },
          }),
        );
        // result 后同一 SDK 进程仍可能追加 message_start，因此保留 session；仅 TTL/硬重置清理。
        return;
      }
    }
  }

  /**
   * 按 session subscriptionTier 从当前策略选择实际 LLM 模型。
   * Standard 优先 scene -> compact -> chat；Premium、未知层级和缺 session 时优先主 chat 槽位。
   * @param sessionId SDK session_id。
   * @returns 非空模型键；所有槽位缺失时返回 `unknown`。
   */
  private pickModelForSession(sessionId: string): string {
    const tier = this.sessions.get(sessionId)?.subscriptionTier ?? '';
    const policy = this.currentModelPolicy;
    if (tier === 'Standard') {
      return policy.scene || policy.compact || policy.chat || UNKNOWN_MODEL;
    }
    // Premium、其他层级和未知值都默认使用主对话 chat 槽位。
    return policy.chat || policy.scene || policy.compact || UNKNOWN_MODEL;
  }

  /**
   * 关闭一个 active turn，把累积状态展开为 request、response 和 tool.call 事件。
   *
   * 本方法同步修改 `activeTurns` 并向 out 原地追加；没有 active turn 时幂等返回。工具参数和正文
   * 有意缺失，token/模型/时序来自 SDK 元数据。request 与 response 共用 turn/step/trace 关联字段。
   *
   * @param sessionId 要关闭的 SDK session。
   * @param filePath 参与确定性 event.id 的日志路径。
   * @param out 当前收集周期输出数组。
   */
  private finalizeTurn(
    sessionId: string,
    filePath: string,
    out: AgentActivityEntry[],
  ): void {
    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;
    this.activeTurns.delete(sessionId);

    // session init 可能因基线或截断缺失；此时仍输出事件，但关联字段允许 undefined。
    const session = this.sessions.get(sessionId);
    const model = turn.model || UNKNOWN_MODEL;
    const sharedAttrs = sessionAttributes(session);

    const traceId = session?.traceId;
    const turnId = session ? `${sessionId}:t${session.turnCounter}` : undefined;
    const stepId = turnId ? `${turnId}:s1` : undefined;

    // turn 起点显式输出 llm.request，OTLP converter 才能计算 LLM span 时长。
    // turn 终点输出 response，携带 token、结束原因和可用于配对的 message ID。
    out.push(
      buildAgentActivityEntry({
        timestamp: turn.startTimestamp,
        'event.id': hashId([filePath, sessionId, turn.messageId, 'request']),
        'event.name': 'llm.request',
        trace_id: traceId,
        'gen_ai.session.id': sessionId,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': stepId,
        'gen_ai.agent.type': this.agentType,
        'gen_ai.request.model': model,
        attributes: { source: SOURCE, event_kind: 'request', ...sharedAttrs },
      }),
    );

    out.push(
      buildAgentActivityEntry({
        timestamp: turn.endTimestamp,
        'event.id': hashId([filePath, sessionId, turn.messageId, 'response']),
        'event.name': 'llm.response',
        trace_id: traceId,
        'gen_ai.session.id': sessionId,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': stepId,
        'gen_ai.response.id': turn.messageId,
        'gen_ai.agent.type': this.agentType,
        'gen_ai.request.model': model,
        'gen_ai.response.model': model,
        'gen_ai.usage.input_tokens': finiteNum(turn.inputTokens),
        'gen_ai.usage.output_tokens': finiteNum(turn.outputTokens),
        'gen_ai.usage.total_tokens': sumIfPresent(
          finiteNum(turn.inputTokens),
          finiteNum(turn.outputTokens),
        ),
        'gen_ai.response.finish_reasons': turn.stopReason ? [turn.stopReason] : undefined,
        attributes: {
          source: SOURCE,
          event_kind: 'response',
          message_id: turn.messageId,
          tool_use_count: turn.toolCalls.length,
          ...sharedAttrs,
        },
      }),
    );

    // 每个 tool_use block 输出独立 tool.call；本路径没有可靠 result/arguments。
    for (let i = 0; i < turn.toolCalls.length; i++) {
      const tc = turn.toolCalls[i];
      out.push(
        buildAgentActivityEntry({
          timestamp: turn.endTimestamp,
          'event.id': hashId([
            filePath,
            sessionId,
            turn.messageId,
            'tool_use',
            tc.id,
            String(i),
          ]),
          'event.name': 'tool.call',
          trace_id: traceId,
          'gen_ai.session.id': sessionId,
          'gen_ai.turn.id': turnId,
          'gen_ai.step.id': stepId,
          'gen_ai.response.id': turn.messageId,
          'gen_ai.agent.type': this.agentType,
          'gen_ai.request.model': model,
          'gen_ai.response.model': model,
          'gen_ai.tool.name': tc.name,
          'gen_ai.tool.call.id': tc.id,
          'gen_ai.tool.call.exec.id': tc.id,
          attributes: {
            source: SOURCE,
            event_kind: 'tool_use',
            message_id: turn.messageId,
            tool_index: i,
            ...sharedAttrs,
          },
        }),
      );
    }
  }
}

/**
 * 提取所有事件共享的 session attributes（订阅层级、cwd、Agent 和工具清单）。
 * @param session 可选 session 状态；init 行缺失时可能为 undefined。
 * @returns 仅包含非空字段的普通 JSON 对象；无状态时返回空对象。
 */
function sessionAttributes(session: SessionState | undefined): Record<string, JsonValue> {
  if (!session) return {};
  const out: Record<string, JsonValue> = {};
  if (session.subscriptionTier) out.subscription_tier = session.subscriptionTier;
  if (session.cwd) out.cwd = session.cwd;
  if (session.agents.length > 0) out.agents = session.agents;
  if (session.tools.length > 0) out.tools = session.tools;
  return out;
}

/**
 * 按平台和产品变体解析 Qoder Work 应用数据根目录。
 *
 * Windows 优先 APPDATA，Linux 优先 XDG_CONFIG_HOME，macOS 使用 Application Support；所有
 * fallback 都通过 home 目录构造，不访问文件系统。
 *
 * @param variant `standard` 为国际版，`cn` 为 CN；默认国际版。
 * @returns 当前平台的绝对目录路径。
 */
export function resolveQoderWorkRoot(variant: 'standard' | 'cn' = 'standard'): string {
  if (process.platform === 'darwin') {
    return resolveHome(variant === 'cn' ? DEFAULT_QODERWORK_CN_ROOT_MAC : DEFAULT_QODERWORK_ROOT_MAC);
  }
  const dirName = variant === 'cn' ? 'QoderWork CN' : 'QoderWork';
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), dirName);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, dirName);
  return resolveHome(variant === 'cn' ? DEFAULT_QODERWORK_CN_ROOT_LINUX : DEFAULT_QODERWORK_ROOT_LINUX);
}

/**
 * 把一行 SDK 纯文本解析为共享 SdkEvent 判别联合。
 *
 * 先匹配出站 set_model_policy，再匹配入站 Received message。时间无法解析时回退 Date.now；
 * payload JSON 损坏、未知消息类型或结构不完整时返回 null。`post_tool_use` 主要供 CN Trace 聚合器
 * 获取工具结果；QoderWorkLogInput 自身当前不在 handleEvent 中消费该 kind。
 *
 * @param line SDK 日志中的完整单行文本。
 * @returns 可识别事件或 null；不抛出 JSON 解析异常。
 */
export function parseSdkLogLine(line: string): SdkEvent | null {
  const policyMatch = SET_MODEL_POLICY_RE.exec(line);
  if (policyMatch) {
    const [, tsStr, , jsonStr] = policyMatch;
    const ts = Date.parse(tsStr);
    const tsNum = Number.isNaN(ts) ? Date.now() : ts;
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(jsonStr) as Record<string, unknown>;
    } catch {
      return null;
    }
    // payload 结构：
    //   { requestId, request: { type, request_id,
    //       request: { subtype: 'set_model_policy', chat:{model}, compact:{model}, scene_model:{model} } } }
    const outer = (envelope.request && typeof envelope.request === 'object'
      ? (envelope.request as Record<string, unknown>).request
      : undefined);
    const inner = (outer && typeof outer === 'object' ? outer : {}) as Record<string, unknown>;
    return {
      kind: 'set_model_policy',
      ts: tsNum,
      chatModel: extractModel(inner.chat),
      compactModel: extractModel(inner.compact),
      sceneModel: extractModel(inner.scene_model),
    };
  }

  const match = RECEIVED_MSG_RE.exec(line);
  if (!match) return null;
  const [, tsStr, , msgType, jsonStr] = match;
  const ts = Date.parse(tsStr);
  const tsNum = Number.isNaN(ts) ? Date.now() : ts;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    return null;
  }

  // system init 建立会话元数据；部分版本用 subtype，部分版本用 type。
  if (msgType === 'system' && (data.subtype === 'init' || data.type === 'init')) {
    return {
      kind: 'system_init',
      ts: tsNum,
      sessionId: stringOr(data.session_id, ''),
      subscriptionTier: stringOr(data.model, ''),
      cwd: stringOr(data.cwd, ''),
      agents: arrayOfString(data.agents),
      tools: arrayOfString(data.tools),
    };
  }

  // stream_event 继续交给专用 parser 按 event.type 收窄。
  if (msgType === 'stream_event' && data.event && typeof data.event === 'object') {
    return parseStreamEvent(tsNum, stringOr(data.session_id, ''), data.event as Record<string, unknown>);
  }

  if (msgType === 'result') {
    return {
      kind: 'result',
      ts: tsNum,
      sessionId: stringOr(data.session_id, ''),
      resultId: stringOr(data.uuid, ''),
      subtype: stringOr(data.subtype, ''),
      durationMs: numberOr(data.duration_ms, 0),
      durationApiMs: numberOr(data.duration_api_ms, 0),
      numTurns: numberOr(data.num_turns, 0),
      contextUsageRatio: numberOr(data.context_usage_ratio, 0),
    };
  }

  // control_request 里只有 PostToolUse 对遥测有用，其他控制消息跳过。
  if (msgType === 'control_request') {
    const req = data.request as Record<string, unknown> | undefined;
    const input = (req && typeof req === 'object'
      ? (req as Record<string, unknown>).input
      : undefined) as Record<string, unknown> | undefined;
    if (input && input.hook_event_name === 'PostToolUse') {
      return {
        kind: 'post_tool_use',
        ts: tsNum,
        sessionId: stringOr(input.session_id, ''),
        toolUseId: stringOr(input.tool_use_id, ''),
        toolName: stringOr(input.tool_name, ''),
        toolResponse: stringOr(input.tool_response, ''),
        transcriptPath: stringOr(input.transcript_path, ''),
      };
    }
    return null;
  }

  return null;
}

/**
 * 解析 stream_event 内层对象，映射 message/block/delta/stop 生命周期。
 * @param ts 外层日志时间（epoch 毫秒）。
 * @param sessionId 外层携带的 session ID。
 * @param event stream_event.event 对象。
 * @returns 对应 SdkEvent；未知 block/delta/type 返回 null。
 */
function parseStreamEvent(
  ts: number,
  sessionId: string,
  event: Record<string, unknown>,
): SdkEvent | null {
  const type = stringOr(event.type, '');
  switch (type) {
    case 'message_start': {
      const message = (event.message && typeof event.message === 'object'
        ? event.message
        : {}) as Record<string, unknown>;
      return {
        kind: 'message_start',
        ts,
        sessionId,
        messageId: stringOr(message.id, ''),
      };
    }
    case 'content_block_start': {
      // block 类型决定后续 delta 如何解释；tool_use 还携带 name/id。
      const block = (event.content_block && typeof event.content_block === 'object'
        ? event.content_block
        : null) as Record<string, unknown> | null;
      if (!block) return null;
      const blockType = stringOr(block.type, '');
      if (blockType === 'thinking' || blockType === 'text') {
        return {
          kind: 'block_start',
          ts,
          sessionId,
          blockType,
          index: numberOr(event.index, 0),
        };
      }
      if (blockType === 'tool_use') {
        return {
          kind: 'block_start',
          ts,
          sessionId,
          blockType: 'tool_use',
          index: numberOr(event.index, 0),
          toolName: stringOr(block.name, ''),
          toolId: stringOr(block.id, ''),
        };
      }
      return null;
    }
    case 'content_block_delta': {
      // 三种 delta 内容字段名不同，统一成 content，并保留工具 block index。
      const delta = (event.delta && typeof event.delta === 'object'
        ? event.delta
        : null) as Record<string, unknown> | null;
      if (!delta) return null;
      const deltaType = stringOr(delta.type, '');
      if (deltaType === 'thinking_delta') {
        return {
          kind: 'delta',
          ts,
          sessionId,
          deltaType: 'thinking_delta',
          content: stringOr(delta.thinking, ''),
        };
      }
      if (deltaType === 'text_delta') {
        return {
          kind: 'delta',
          ts,
          sessionId,
          deltaType: 'text_delta',
          content: stringOr(delta.text, ''),
        };
      }
      if (deltaType === 'input_json_delta') {
        return {
          kind: 'delta',
          ts,
          sessionId,
          deltaType: 'input_json_delta',
          content: stringOr(delta.partial_json, ''),
          blockIndex: numberOr(event.index, -1),
        };
      }
      return null;
    }
    case 'message_delta': {
      // stop_reason 位于 delta，token 位于并列 usage 对象。
      const delta = (event.delta && typeof event.delta === 'object'
        ? event.delta
        : {}) as Record<string, unknown>;
      const usage = (event.usage && typeof event.usage === 'object'
        ? event.usage
        : {}) as Record<string, unknown>;
      return {
        kind: 'message_delta',
        ts,
        sessionId,
        stopReason: stringOr(delta.stop_reason, ''),
        inputTokens: numberOr(usage.input_tokens, 0),
        outputTokens: numberOr(usage.output_tokens, 0),
      };
    }
    case 'message_stop':
      return { kind: 'message_stop', ts, sessionId };
    default:
      return null;
  }
}

/** 对关键字段做 NUL 分隔后计算 SHA-256，生成跨重读稳定的 event.id。 */
function hashId(parts: Array<string | number | undefined>): string {
  return crypto
    .createHash('sha256')
    .update(parts.map(p => p ?? '').join('\0'))
    .digest('hex');
}

/** 返回非空字符串，否则使用 fallback。 */
function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** 返回有限 number，否则使用 fallback。 */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 仅保留大于 0 的有限 token 数；0/坏值转 undefined 以省略字段。 */
function finiteNum(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 从未知值中过滤出字符串数组；非数组返回空数组。 */
function arrayOfString(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/** 从模型策略槽位对象读取非空 model 字段。 */
function extractModel(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const obj = value as Record<string, unknown>;
  return stringOr(obj.model, '');
}

/** 两侧 token 都存在时求和；任一缺失则不伪造 total。 */
function sumIfPresent(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined || right === undefined) return undefined;
  return left + right;
}

/**
 * 从文件尾反向扫描最近一条 `Received message: result`，返回其结束换行后的 byte offset。
 *
 * 每次只读 64 KiB，并把跨块行片段留给下一轮拼接，避免首次启动把超大日志全部载入内存。
 * 没有 result 时返回 0，以便保留可能正在进行的 turn；文件句柄始终在 finally 关闭。
 *
 * @param filePath SDK 日志路径。
 * @param size 调用方 stat 得到的本轮文件大小边界。
 * @returns 最近完成窗口之后的 offset，或 0。
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
      // 保留块首残片，与更早一个块拼接，处理行跨块情况。
      const fragment = cursor > 0 ? lines.shift() ?? '' : '';
      // 除待拼接首残片外，assembled tail 中其余行已经完整，可以从尾向前查找。
      let runningOffset = cursor + Buffer.byteLength(fragment, 'utf-8');
      // 为得到命中行的 byte offset，从完整行数组头部重新累计 UTF-8 字节数。
      const offsets: number[] = [];
      let off = runningOffset;
      for (const line of lines) {
        offsets.push(off);
        off += Buffer.byteLength(line, 'utf-8') + 1; // 加 1 计入换行字节。
      }
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].includes('Received message: result ')) {
          // 基线位于命中行终止换行之后，下一次从后续字节开始读取。
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
