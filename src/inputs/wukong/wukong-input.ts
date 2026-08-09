/**
 * Wukong 本地 CLI API 轮询采集器，是当前 Orchestrator 会实际创建并注册的主实现。
 *
 * 所属位置：输入源模块。`Orchestrator.registerAllInputs()` 在发现 Wukong 可用后创建本类，
 * `BaseInput` 再通过定时器调用 `collect()`，并把返回的 `AgentActivityEntry` 以 `entries` 事件交给
 * `InputManager`，最终进入统一归一化与输出链路。
 *
 * 数据来源：使用 Node.js `child_process.execFile` 启动 `wukong-cli` 子进程，先分页调用
 * `list_tasks`，再按会话调用 `get_spark_agui_messages`。本文件使用 ES Module `import`；源码中
 * 的 `.js` 后缀对应 TypeScript 编译后的模块名，`import type` 只参与类型检查、运行时不会加载。
 *
 * 状态与生命周期：首次 `start()` 只记录既有消息数量，避免重放历史；运行中保存每个 session
 * 已处理条数和暂时消失次数；`stop()` 会通过 `AbortController` 取消尚未退出的 CLI 子进程。
 * CLI 不可用、响应为空或单个任务解析失败时尽量 fail-open，让下一轮轮询恢复；真正的响应结构
 * 错误会抛给当前任务或轮询层记录。所有子进程都有超时和最大输出缓冲限制。
 */
import * as crypto from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { buildAgentActivityEntry, toJsonValue } from '../../normalization/entry-builder.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';

const execFile = promisify(execFileCb);

const CLI_TIMEOUT_MS = 10_000;
const TASK_BATCH_LIMIT = 50;
const MAX_TASKS = 500;
const BASELINE_CONCURRENCY = 5;
const COLLECT_CONCURRENCY = 5;
const DAEMON_SOCK_REL = '.real/daemon.sock';
// 会话连续多次未出现在 list_tasks 中才删除游标，避免分页抖动或 daemon 短暂异常造成重复采集。
const STALE_PRUNE_THRESHOLD = 5;
// listAllTasks 可能返回完整任务元数据的大 JSON，maxBuffer 与 getMessages 保持同一上限。
const CLI_MAX_BUFFER = 10 * 1024 * 1024;

/** `list_tasks` 返回的原始任务 DTO；时间字段均由 Wukong CLI 提供，单位为毫秒。 */
interface WukongTask {
  id: string;
  session_id: string | null;
  name: string;
  status: string;
  agent_type: string;
  created_at: number;
  completed_at: number | null;
  started_at: number | null;
  last_active_at: number | null;
  metadata: {
    modelName?: string;
    modelProvider?: string;
    sandbox_level?: string;
    [key: string]: unknown;
  };
}

/** 经过空值过滤后的任务类型；后续读取消息时可安全把 `session_id` 当作字符串。 */
type ValidWukongTask = WukongTask & { session_id: string };

/** `list_tasks` 单页响应；`hasMore/nextCursor` 控制下一次子进程调用的分页参数。 */
interface ListTasksResponse {
  hasMore: boolean;
  items: WukongTask[];
  nextCursor?: string;
}

/** 一个会话中的原始消息；assistant 的 `events` 是转换 LLM、step 和工具事件的主要输入。 */
interface WukongMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string | null;
  events: AguiEvent[] | null;
  createdAt: number;
  timestamp: number;
  turnIndex: number;
  userMsgId?: string;
}

/** Wukong 使用的 AG-UI 事件开放结构；不同 `type` 会携带不同扩展字段。 */
interface AguiEvent {
  type: string;
  timestamp: number;
  [key: string]: unknown;
}

/** `get_spark_agui_messages` 的最小响应结构。 */
interface GetMessagesResponse {
  messages: WukongMessage[];
}

/** assistant turn 转换期间的当前 step 上下文，只在一次同步转换调用内存在。 */
interface StepContext {
  stepIndex: number;
  stepId: string;
  stepMessageId: string;
  hasToolCalls: boolean;
  startTimestamp: number;
  stepSpanId: string;
}

/** 将 Wukong activity 类型映射为标准化事件使用的稳定工具名。 */
const ACTIVITY_TYPE_TO_TOOL_NAME: Record<string, string> = {
  TERMINAL: 'terminal',
  FILE_WRITE: 'file_write',
  FILE_READ: 'file_read',
  GREP_SEARCH: 'grep_search',
  SEARCH: 'search',
  DIRECTORY_LIST: 'directory_list',
  SKILL: 'skill',
  ARTIFACT: 'artifact',
};

/**
 * Wukong 采集器配置。
 * `cliPath` 主要用于非默认安装位置和测试；其余轮询、日志、状态存储配置继承自 `InputOptions`。
 */
export interface WukongInputOptions extends InputOptions {
  cliPath?: string;
}

/**
 * 通过 Wukong CLI API 增量采集会话并转换为标准活动事件。
 *
 * 类由 Orchestrator 创建，由 `BaseInput.start()/stop()` 管理生命周期。实例不维护常驻子进程；
 * 每次 API 请求临时创建一个 `wukong-cli` 子进程。`_collectInFlight` 防止慢请求造成轮询重入，
 * `_abortController` 让停止流程可以取消本轮所有尚未完成的子进程。
 *
 * 典型流程：`onStart()` 建立历史基线 -> 定时 `collect()` -> `doCollect()` 分页列任务并并发读取消息
 * -> `transformMessages()` 生成事件 -> BaseInput 发出 `entries` 并持久化 StateStore -> `onStop()`
 * 取消并等待正在执行的轮询。
 */
export class WukongInput extends BaseInput {
  readonly id = 'wukong';
  readonly agentType = ClientType.Wukong;
  readonly collectionMethod = CollectionMethod.CliApiPolling;

  private readonly cliPath: string;
  private _collectInFlight: Promise<AgentActivityEntry[]> | null = null;
  private _abortController = new AbortController();
  private _lastSkipWarnAt = 0;

  /**
   * 创建采集器，但此时不访问文件、网络或 CLI。
   * @param opts 状态存储、日志和轮询配置；未指定 `cliPath` 时按当前平台选择默认命令。
   */
  constructor(opts: WukongInputOptions) {
    super(opts);
    this.cliPath = opts.cliPath ?? WukongInput.getCliPath();
    this.pollIntervalMs = opts.pollIntervalMs ?? 60_000;
  }

  /**
   * 解析默认 CLI 可执行文件：macOS 使用应用包内绝对路径，其他平台依赖 `PATH` 查找。
   * @returns 传给 `execFile` 的可执行文件路径或命令名。
   */
  static getCliPath(): string {
    if (process.platform === 'darwin') {
      return '/Applications/Wukong.app/Contents/MacOS/wukong-cli';
    }
    return 'wukong-cli';
  }

  /**
   * 向发现服务声明 Wukong daemon socket；路径出现后才值得进一步做可用性探测。
   * @returns 当前用户主目录下 daemon socket 的绝对路径数组。
   */
  static getWatchPaths(): string[] {
    return [path.join(os.homedir(), DAEMON_SOCK_REL)];
  }

  /**
   * 检查 daemon socket 是否存在，并执行 `wukong-cli service status` 确认服务处于 running。
   * @returns 异步返回可用状态；文件不存在、命令失败、超时或输出不匹配均返回 `false`，不向上抛错。
   * @remarks 会读取文件系统并创建一个短生命周期子进程。
   */
  static async checkAvailability(): Promise<boolean> {
    const sockPath = path.join(os.homedir(), DAEMON_SOCK_REL);
    try {
      await fsp.access(sockPath);
    } catch {
      return false;
    }
    try {
      const cliPath = WukongInput.getCliPath();
      const { stdout } = await execFile(cliPath, ['service', 'status'], {
        timeout: CLI_TIMEOUT_MS,
      });
      return /running/i.test(stdout);
    } catch {
      return false;
    }
  }

  /**
   * 首次启动时建立消息数量基线，避免把安装前的全部历史会话当作新增数据发送。
   * 已存在 `seenCounts` 时说明曾初始化过，直接沿用持久化游标。任务按五个一组并发读取；
   * 单个会话失败记为 0，整体列举失败则写入空基线，使后续轮询仍可自恢复。
   * @returns 初始化完成后兑现的 Promise；不返回业务事件。
   */
  protected override async onStart(): Promise<void> {
    const state = this.stateStore.get(this.id);
    if (state.extra?.seenCounts != null && typeof state.extra.seenCounts === 'object') return;

    try {
      const tasks = await this.listAllTasks();
      const seenCounts: Record<string, number> = {};
      let baselined = 0;
      for (let i = 0; i < tasks.length; i += BASELINE_CONCURRENCY) {
        const batch = tasks.slice(i, i + BASELINE_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(task => this.getMessages(task.session_id)),
        );
        for (let j = 0; j < batch.length; j++) {
          const r = results[j];
          if (r.status === 'fulfilled') {
            seenCounts[batch[j].session_id] = r.value.messages.length;
            baselined++;
          } else {
            seenCounts[batch[j].session_id] = 0;
          }
        }
      }
      this.stateStore.update(this.id, { extra: { seenCounts } });
      this.logger.info('baseline complete', { total: tasks.length, baselined });
    } catch (err) {
      this.logger.warn('failed to baseline wukong cursor', { error: String(err) });
      this.stateStore.update(this.id, { extra: { seenCounts: {} } });
    }
  }

  /**
   * BaseInput 定时器调用的单轮入口。
   * 如果上一轮仍在执行则立即返回空数组，避免两个轮次同时读写同一游标；否则等待 `doCollect()`。
   * `finally` 无论成功或异常都会清除进行中标记，异常会按 async/await 规则继续交给 BaseInput 处理。
   * @returns 本轮新增的标准事件 Promise。
   */
  protected async collect(): Promise<AgentActivityEntry[]> {
    if (this._collectInFlight) {
      // 上一轮尚未结束时跳过本轮；告警限制为每分钟一次，避免慢 CLI 持续刷日志。
      const now = Date.now();
      if (now - this._lastSkipWarnAt > 60_000) {
        this._lastSkipWarnAt = now;
        this.logger.warn('skip collect: previous cycle still running', {
          pollIntervalMs: this.pollIntervalMs,
        });
      }
      return [];
    }
    const startedAt = Date.now();
    this._collectInFlight = this.doCollect();
    try {
      const result = await this._collectInFlight;
      const elapsed = Date.now() - startedAt;
      if (elapsed > this.pollIntervalMs) {
        this.logger.warn('collect cycle exceeded poll interval', {
          elapsedMs: elapsed,
          pollIntervalMs: this.pollIntervalMs,
        });
      }
      return result;
    } finally {
      this._collectInFlight = null;
    }
  }

  /**
   * 停止阶段先触发 AbortSignal 终止 CLI 子进程，再等待当前轮询释放资源。
   * 已在采集层记录的异常不会在停止时重复抛出；最后重建控制器以支持同一实例再次启动。
   * @returns 所有在途采集结束后的 Promise。
   */
  protected override async onStop(): Promise<void> {
    // 先通过 AbortController 取消正在运行的 execFile 子进程，再等待当前轮询完成收尾。
    this._abortController.abort();
    if (this._collectInFlight) {
      try {
        await this._collectInFlight;
      } catch {
        // 异常已在 doCollect 内记录，停止阶段不重复抛出或打印。
      }
    }
    // 重建 AbortController，使同一实例后续再次 start() 时仍可调用 CLI。
    this._abortController = new AbortController();
  }

  /**
   * 执行真正的轮询：复制持久化游标、分页取任务、分批并发取消息、转换事件并清理陈旧会话。
   * 单个任务失败由 `Promise.allSettled` 隔离；daemon 暂停导致的列任务失败按空结果处理。
   * 状态只在整轮末尾更新，随后由 BaseInput 的周期逻辑统一保存，减少频繁磁盘同步。
   * @returns 本轮所有成功任务产生的标准事件。
   */
  private async doCollect(): Promise<AgentActivityEntry[]> {
    const state = this.stateStore.get(this.id);
    const seenCounts: Record<string, number> =
      (state.extra?.seenCounts != null && typeof state.extra.seenCounts === 'object')
        ? { ...(state.extra.seenCounts as Record<string, number>) }
        : {};

    let tasks: ValidWukongTask[];
    try {
      tasks = await this.listAllTasks();
    } catch (err) {
      this.logger.debug('wukong list_tasks failed (daemon may be stopped)', { error: String(err) });
      return [];
    }

    if (tasks.length === 0) return [];

    const entries: AgentActivityEntry[] = [];
    let stateChanged = false;

    // 任务按固定大小分批：批内并发、批间串行，与首次 baseline 的并发策略一致。
    for (let i = 0; i < tasks.length; i += COLLECT_CONCURRENCY) {
      // 收到停止信号后协作式退出，不再启动后续批次的子进程。
      if (!this.running) break;
      const batch = tasks.slice(i, i + COLLECT_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(task => this.processOneTask(task, seenCounts[task.session_id] ?? 0)),
      );
      let batchChanged = false;
      for (let j = 0; j < batch.length; j++) {
        const r = results[j];
        const task = batch[j];
        if (r.status === 'fulfilled') {
          if (r.value) {
            entries.push(...r.value.entries);
            seenCounts[task.session_id] = r.value.newSeenCount;
            batchChanged = true;
          }
        } else {
          this.logger.warn('failed to process task', {
            taskId: task.id,
            sessionId: task.session_id,
            error: String(r.reason),
          });
        }
      }
      if (batchChanged) stateChanged = true;
      // BaseInput.runCycle 只在 collect() 返回后保存一次 StateStore；批次中间进度仅驻留内存，整轮结束时原子提交，避免每批 fsync。
    }

    // 清理 API 不再返回的 seenCounts 时保留宽限窗口：连续达到阈值才删除，避免分页暂时漏项造成游标反复重建。
    const staleCounters: Record<string, number> =
      (state.extra?.staleCounters != null && typeof state.extra.staleCounters === 'object')
        ? { ...(state.extra.staleCounters as Record<string, number>) }
        : {};
    const activeIds = new Set(tasks.map(t => t.session_id));
    for (const key of Object.keys(seenCounts)) {
      if (activeIds.has(key)) {
        if (staleCounters[key] !== undefined) {
          delete staleCounters[key];
          stateChanged = true;
        }
        continue;
      }
      const missed = (staleCounters[key] ?? 0) + 1;
      if (missed >= STALE_PRUNE_THRESHOLD) {
        delete seenCounts[key];
        delete staleCounters[key];
        stateChanged = true;
      } else {
        staleCounters[key] = missed;
        stateChanged = true;
      }
    }
    // 移除已不对应任何 seenCounts 游标的 staleCounters，防止状态长期膨胀。
    for (const key of Object.keys(staleCounters)) {
      if (seenCounts[key] === undefined) {
        delete staleCounters[key];
        stateChanged = true;
      }
    }

    if (stateChanged) {
      this.stateStore.update(this.id, { extra: { seenCounts, staleCounters } });
    }
    return entries;
  }

  /**
   * 根据会话游标截取一个任务的新增消息，并只提交已经完整结束且完成 user/assistant 配对的前缀。
   * @param task 已确认带有 `session_id` 的任务。
   * @param prevCount 上轮已消费的消息条数，必须是非负游标。
   * @returns 有可提交消息时返回事件和新游标；没有新增或末尾仍在流式写入时返回 `null`。
   * @throws CLI 执行失败或响应结构无效；调用方用 `Promise.allSettled` 隔离该任务。
   */
  private async processOneTask(
    task: ValidWukongTask,
    prevCount: number,
  ): Promise<{ entries: AgentActivityEntry[]; newSeenCount: number } | null> {
    const messagesResp = await this.getMessages(task.session_id);
    const messages = messagesResp.messages;

    if (messages.length <= prevCount) return null;

    const newMessages = messages.slice(prevCount);

    // 只处理已完整结束的消息，避免 assistant 仍在流式写入时读取到不完整 token；下一轮会重试。
    const lastCompleteIdx = findLastCompleteIndex(newMessages);
    if (lastCompleteIdx < 0) return null;

    const processable = newMessages.slice(0, lastCompleteIdx + 1);
    const entries = this.transformMessages(task, processable);
    return { entries, newSeenCount: prevCount + processable.length };
  }

  /**
   * 把一个任务的完整消息前缀按 turn 组织，并为每条 assistant 消息调用细粒度事件转换。
   * 连续 user 内容会合并到下一条 assistant 的首个 `llm.request`；单条转换失败只记录并跳过。
   * @param task 提供 session、Agent 和模型元数据。
   * @param messages 已通过完整性检查的新增消息。
   * @returns 可交给归一化/输出链路的事件数组；该函数同步执行且不读写外部资源。
   */
  private transformMessages(task: ValidWukongTask, messages: WukongMessage[]): AgentActivityEntry[] {
    const entries: AgentActivityEntry[] = [];
    const sessionId = task.session_id;
    const meta = (task.metadata && typeof task.metadata === 'object')
      ? task.metadata as Record<string, unknown>
      : {};
    const model = (typeof meta.modelName === 'string' && meta.modelName) ? meta.modelName : 'unknown';
    const provider = (typeof meta.modelProvider === 'string' && meta.modelProvider) ? meta.modelProvider : undefined;
    const hostname = os.hostname();

    const commonFields = {
      'host.name': hostname,
      'service.name': 'wukong',
      'gen_ai.session.id': sessionId,
      'gen_ai.agent.type': ClientType.Wukong,
      'gen_ai.agent.id': task.id,
      // 使用稳定的 Agent 类型作为 OTLP agent.name；用户会话标题 task.name 会变化，否则一致性校验会失败。
      'gen_ai.agent.name': ClientType.Wukong,
      ...(provider ? { 'gen_ai.provider.name': provider } : {}),
    } as const;

    // 将连续 user 消息暂存并关联到下一条 assistant 的 trace，保证一个 turn 的输入输出在同一棵树中。
    let pendingUserMessages: WukongMessage[] = [];

    for (const msg of messages) {
      try {
        if (msg.role === 'user') {
          if (msg.content) pendingUserMessages.push(msg);
          continue;
        }

        if (msg.role !== 'assistant') continue;
        const events = msg.events;
        if (!events || events.length === 0) {
          // assistant 没有可转换事件时丢弃待配对 user，避免把它错误关联到后续 turn。
          pendingUserMessages = [];
          continue;
        }

        const turnId = resolveTurnId(sessionId, msg);
        const userContent = pendingUserMessages.map(m => m.content).filter(Boolean).join('\n');
        const turnEntries = this.transformAssistantMessage(task, msg, events, model, turnId, commonFields, userContent);

        // assistant 未生成 entry（例如没有内容的 RUN_ERROR）时，把待处理 user 消息留给下一条 assistant。
        if (turnEntries.length === 0) {
          continue;
        }

        // user 内容已合并到 step 1 的 llm.request messages_delta，OTLP converter 会据此恢复 ENTRY 输入；不再额外生成缺少 step.id 的 user-hook 请求。
        pendingUserMessages = [];

        entries.push(...turnEntries);
      } catch (err) {
        this.logger.warn('failed to transform message', {
          taskId: task.id,
          sessionId: task.session_id,
          msgId: msg.id,
          error: String(err),
        });
      }
    }

    // 尾部尚无 assistant 回复的 user 消息属于未完成会话，本轮不生成零时长孤立 ENTRY/AGENT；doCollect 的完整性游标会让下轮继续处理。

    return entries;
  }

  /**
   * 将一条 assistant 消息的 AG-UI 事件流还原为 trace -> step -> LLM/tool 的标准事件树。
   * 方法会处理显式/合成 step、流式文本、token、工具参数增量、activity 快照、错误和时间修正，
   * 并补齐下游 OTLP 校验需要的父子 Span、工具响应增量和结束原因。
   * @param task 当前 Wukong 任务。
   * @param msg assistant 原始消息。
   * @param events 按 Wukong 返回顺序排列的 AG-UI 事件。
   * @param model 从任务元数据解析的模型名。
   * @param turnId 当前 turn 的稳定标识。
   * @param common 所有输出事件共享的主机、服务、session 和 Agent 字段。
   * @param userContent 应写入首个 step 请求的用户内容。
   * @returns 当前 assistant turn 产生的标准事件；不执行异步 I/O。
   */
  private transformAssistantMessage(
    task: ValidWukongTask,
    msg: WukongMessage,
    events: AguiEvent[],
    model: string,
    turnId: string,
    common: Record<string, unknown>,
    userContent: string,
  ): AgentActivityEntry[] {
    const entries: AgentActivityEntry[] = [];
    const sessionId = task.session_id;

    // 为当前 turn 生成 trace 级 ID，后续所有 step/tool entry 共用。
    const traceId = generateTraceId();
    const agentSpanId = generateSpanId();

    // 跟踪当前 step 的序号、稳定 ID、父 Span 和开始时间。
    let stepIndex = 0;
    let currentStep: StepContext | null = null;
    const hasStepEvents = events.some(e => e.type === 'STEP_STARTED');

    // 以下累加器只属于当前 step；进入新 step 时全部重置。
    let runId: string | undefined;
    let textContent = '';
    let usageEvent: AguiEvent | undefined;
    let firstTokenEvent: AguiEvent | undefined;
    let runStartedTs: number | undefined;
    let runFinishedTs: number | undefined;
    let runError: { code: string; message: string } | undefined;
    let toolIdx = 0;
    let toolStartCount = 0;
    const toolStartTimestamps = new Map<string, number>();
    const allToolStartTimes: number[] = [];
    const allToolEndTimes: number[] = [];
    const toolArgsAccumulator = new Map<string, string>();
    const toolNames = new Map<string, string>();
    const toolCallParts: Array<{ type: string; id: string; name: string }> = [];

    /** 根据 `STEP_STARTED` 创建新的 step 上下文，并清空只属于上一步的累加器。 */
    const startNewStep = (evt: AguiEvent): void => {
      stepIndex++;
      const stepSpanId = generateSpanId();
      currentStep = {
        stepIndex,
        stepId: `${turnId}:s${stepIndex}`,
        stepMessageId: (evt.messageId as string) ?? `step-${stepIndex}`,
        hasToolCalls: false,
        startTimestamp: evt.timestamp,
        stepSpanId,
      };
      // 开始新 step 时重置文本、token、工具和错误累加状态。
      textContent = '';
      usageEvent = undefined;
      firstTokenEvent = undefined;
      toolCallParts.length = 0;
      // 工具时间数组按 step 隔离，flushStepLlm 才能为当前 step 计算正确响应时间。
      allToolStartTimes.length = 0;
      allToolEndTimes.length = 0;
    };

    // 没有 STEP_STARTED，或首个 STEP_STARTED 前已有有效事件时，预创建合成 step s1 承接这些事件。
    const firstStepStartedIdx = events.findIndex(e => e.type === 'STEP_STARTED');
    const eventsBeforeFirstStep = firstStepStartedIdx >= 0
      ? events.slice(0, firstStepStartedIdx)
      : events;
    const hasContentBeforeStep = eventsBeforeFirstStep.some(e =>
      e.type === 'TOOL_CALL_START' || e.type === 'ACTIVITY_SNAPSHOT' || e.type === 'TEXT_MESSAGE_CONTENT'
    );
    if (!hasStepEvents || hasContentBeforeStep) {
      stepIndex = 1;
      currentStep = {
        stepIndex: 1,
        stepId: `${turnId}:s1`,
        stepMessageId: `synth-step-1`,
        hasToolCalls: false,
        startTimestamp: msg.createdAt,
        stepSpanId: generateSpanId(),
      };
    }

    // 记录已由 flushStepLlm 输出的 step.id，避免循环结束后的主输出块重复生成 LLM 对。
    const flushedStepIds = new Set<string>();

    // flushStepLlm 使用当前累加状态为一个 step 成对生成 llm.request/response，然后清空 step 状态；STEP_FINISHED 调用它可保留每步真实 token、文本和错误。
    /**
     * 把当前累积状态配对输出为 `llm.request/llm.response`，随后重置 step 局部状态。
     * @returns 实际输出事件时为 `true`；没有当前 step 或没有内容时为 `false`。
     */
    const flushStepLlm = (): boolean => {
      if (!currentStep) return false;
      const hasContent = !!textContent || !!usageEvent || toolCallParts.length > 0 || !!runError;
      if (!hasContent) return false;

      const finishReasons = this.inferFinishReasons(currentStep.hasToolCalls, runError);
      const llmSpanId = generateSpanId();

      const inputTokens = numOr(usageEvent?.prompt_tokens) ?? 0;
      const outputTokens = numOr(usageEvent?.completion_tokens) ?? 0;
      const cachedTokens = numOr(usageEvent?.cached_tokens) ?? 0;
      const totalTokens = numOr(usageEvent?.total_tokens) ?? (inputTokens + outputTokens);

      const requestTimestamp = Math.max(currentStep.startTimestamp, runStartedTs ?? 0) || msg.createdAt;
      // 工具型 step 的 LLM 响应放在第一个工具前；纯文本 step 至少比请求晚 1ms，并采用 runFinishedTs。
      let responseTimestamp: number;
      if (currentStep.hasToolCalls && allToolStartTimes.length > 0) {
        const firstToolTs = minOf(allToolStartTimes);
        responseTimestamp = Math.max(requestTimestamp + 1, firstToolTs - 1);
      } else if (currentStep.hasToolCalls) {
        responseTimestamp = requestTimestamp + 1;
      } else {
        responseTimestamp = Math.max(requestTimestamp + 1, runFinishedTs ?? msg.createdAt);
      }

      // userContent 是 turn 级 prompt，只注入第一个 step，后续 step 使用上一轮工具结果增量。
      const includeUserContent = !!userContent && currentStep.stepIndex === 1;

      // 显式 STEP_FINISHED 路径同样输出成对 LLM 事件；request 先记录 step 层级和可选首轮 prompt。
      entries.push(buildAgentActivityEntry({
        timestamp: requestTimestamp,
        'event.id': hashId([sessionId, msg.id, 'request', String(currentStep.stepIndex)]),
        'event.name': 'llm.request',
        // common 提供 session/Agent/Provider，当前对象补 turn、step、model 和 trace 关联。
        ...common,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': currentStep.stepId,
        'gen_ai.request.model': model,
        'gen_ai.response.id': runId,
        'trace_id': traceId,
        // 首 step 使用 messages_delta 表示新输入；后续 step 的工具结果会在后处理阶段注入。
        ...(includeUserContent ? {
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: userContent }] },
          ],
        } : {}),
        attributes: {
          source: 'wukong',
          message_id: msg.id,
          conversation_id: msg.conversationId,
        },
      }));

      const outputParts: Array<Record<string, string>> = [];
      if (textContent) outputParts.push({ type: 'text', content: textContent });
      for (const tc of toolCallParts) {
        outputParts.push({ type: tc.type, id: tc.id, name: tc.name });
      }
      // 只有 RUN_ERROR、没有文本/工具时，也把错误写入 output.messages，满足 LLM 同时具有输入和输出的语义约束。
      if (outputParts.length === 0 && runError) {
        outputParts.push({ type: 'text', content: `[error] ${runError.code}: ${runError.message}` });
      }

      // response 与 request 共用业务身份，并创建挂在当前 step span 下的 LLM span。
      entries.push(buildAgentActivityEntry({
        timestamp: responseTimestamp,
        'event.id': hashId([sessionId, msg.id, 'response', String(currentStep.stepIndex)]),
        'event.name': 'llm.response',
        ...common,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': currentStep.stepId,
        'gen_ai.response.id': runId,
        'gen_ai.request.model': model,
        'gen_ai.response.model': model,
        'gen_ai.response.finish_reasons': finishReasons,
        'trace_id': traceId,
        'span_id': llmSpanId,
        'parent_span_id': currentStep.stepSpanId,
        // response 的 input.messages 只在首 step 写完整用户输入，避免每个 step 重复同一 prompt。
        ...(includeUserContent ? {
          'gen_ai.input.messages': [
            { role: 'user', parts: [{ type: 'text', content: userContent }] },
          ],
        } : {}),
        ...(outputParts.length > 0 ? {
          // 文本与 tool_call 声明可以共存于同一 assistant message，保持模型原始响应语义。
          'gen_ai.output.messages': [{ role: 'assistant', parts: outputParts }],
        } : {}),
        // usageEvent 已在闭包上方转换为安全数值；缺失时为 0，不把其他 step 的 token 借过来。
        'gen_ai.usage.input_tokens': inputTokens,
        'gen_ai.usage.output_tokens': outputTokens,
        'gen_ai.usage.cache_read.input_tokens': cachedTokens,
        'gen_ai.usage.total_tokens': totalTokens,
        // 只有当前 step 的 RUN_ERROR 才写标准错误字段，flush 后马上清空 runError。
        ...(runError ? { 'error.type': runError.code, 'error.message': runError.message } : {}),
        attributes: {
          source: 'wukong',
          message_id: msg.id,
          conversation_id: msg.conversationId,
          // 首 token 与完整 run 时间来自不同事件，仅在对应证据完整时输出。
          ...(firstTokenEvent ? {
            ttft_ms: firstTokenEvent.ttft_ms as number,
            e2e_ttft_ms: firstTokenEvent.e2e_ttft_ms as number,
          } : {}),
          ...(runStartedTs && runFinishedTs ? {
            run_duration_ms: runFinishedTs - runStartedTs,
          } : {}),
        },
      }));

      // 输出完成后清空当前 step 累加器，下一 step 从干净状态开始。
      flushedStepIds.add(currentStep.stepId);
      textContent = '';
      usageEvent = undefined;
      firstTokenEvent = undefined;
      toolCallParts.length = 0;
      // runError 也保持清空，因为它只属于刚结束的 step。
      runError = undefined;
      return true;
    };

    for (const rawEvt of events) {
      // AGUI 是外部输入，时间戳在参与排序和时长计算前必须先规范化。
      const sanitizedTs = numOr(rawEvt.timestamp) ?? msg.createdAt;
      const evt: AguiEvent = sanitizedTs === rawEvt.timestamp ? rawEvt : { ...rawEvt, timestamp: sanitizedTs };
      switch (evt.type) {
        case 'STEP_STARTED':
          startNewStep(evt);
          break;

        case 'STEP_FINISHED':
          // STEP_STARTED 重置累加器前先输出上一 step 的 LLM 对，确保每步保留自己的 token、文本和错误。
          flushStepLlm();
          break;

        case 'RUN_STARTED':
          runId = evt.runId as string | undefined;
          runStartedTs = evt.timestamp;
          break;

        case 'RUN_FINISHED':
          runFinishedTs = evt.timestamp;
          break;

        case 'RUN_ERROR':
          runError = {
            code: String(evt.code ?? 'UNKNOWN'),
            message: String(evt.message ?? ''),
          };
          break;

        case 'TEXT_MESSAGE_CONTENT':
          if (typeof evt.delta === 'string') textContent += evt.delta;
          break;

        case 'USAGE':
          usageEvent = evt;
          break;

        case 'FIRST_TOKEN':
          firstTokenEvent = evt;
          break;

        case 'TOOL_CALL_START': {
          if (currentStep) currentStep.hasToolCalls = true;
          const tcId = (evt.toolCallId as string | undefined) ?? `idx-${toolStartCount}`;
          toolStartTimestamps.set(tcId, evt.timestamp);
          allToolStartTimes.push(evt.timestamp);
          const toolName = (evt.toolName as string | undefined) ?? (evt.name as string | undefined) ?? '';
          toolNames.set(tcId, toolName);
          toolCallParts.push({ type: 'tool_call', id: tcId, name: toolName });
          toolStartCount++;
          break;
        }

        case 'TOOL_CALL_ARGS': {
          const tcId = (evt.toolCallId as string | undefined) ?? `idx-${toolStartCount - 1}`;
          const prev = toolArgsAccumulator.get(tcId) ?? '';
          toolArgsAccumulator.set(tcId, prev + (typeof evt.delta === 'string' ? evt.delta : ''));
          break;
        }

        case 'TOOL_CALL_END': {
          const tcId = (evt.toolCallId as string | undefined) ?? `idx-${toolStartCount - 1}`;
          const startTs = toolStartTimestamps.get(tcId);
          const startEvtTimestamp = startTs ?? evt.timestamp;
          // 工具结果至少比开始晚 1ms，避免生成零时长 Span。
          const adjustedEndTs = Math.max(evt.timestamp, startEvtTimestamp + 1);
          const duration = startTs ? adjustedEndTs - startTs : undefined;
          const toolName = toolNames.get(tcId) ?? (evt.toolName as string | undefined) ?? (evt.name as string | undefined) ?? '';
          const args = toolArgsAccumulator.get(tcId);

          // tool.call 延迟到此处生成，以收集 TOOL_CALL_START 后逐步到达的完整参数。
          const syntheticStartEvt = { ...evt, timestamp: startEvtTimestamp, toolCallId: evt.toolCallId, toolName };
          entries.push(this.buildToolCallEntry(
            task, msg, syntheticStartEvt, model, turnId, toolIdx, common,
            currentStep, traceId, agentSpanId, args,
          ));
          toolIdx++;

          // 使用修正后的结束时间生成 tool.result。
          const syntheticEndEvt = { ...evt, timestamp: adjustedEndTs };
          entries.push(this.buildToolResultEntry(
            task, msg, syntheticEndEvt, model, turnId, toolIdx, common, duration,
            currentStep, traceId, agentSpanId, toolName,
          ));
          toolIdx++;
          allToolEndTimes.push(adjustedEndTs);
          break;
        }

        case 'TOOL_CALL_RESULT': {
          // TOOL_CALL_RESULT 比 TOOL_CALL_END 内容更完整；按 toolCallId 回填对应结果，避免并发工具乱序时误写到最后一个工具。
          const tcId = evt.toolCallId as string | undefined;
          if (!tcId) break;
          const match = findEntryByToolCallId(entries, 'tool.result', tcId);
          if (match) {
            const content = evt.content;
            if (content !== undefined) {
              match['gen_ai.tool.call.result'] = toJsonValue(content);
            }
            if (evt.is_error === true) {
              // TOOL_CALL_END 已确定结果状态；这里根据更完整的 RESULT 事件补充标准错误类型。
              match['error.type'] = match['error.type'] ?? '_OTHER';
            }
          }
          break;
        }

        case 'ACTIVITY_SNAPSHOT': {
          const activityType = evt.activityType as string | undefined;
          if (activityType && activityType !== 'TASK_LINE_PLAN') {
            const actToolName = ACTIVITY_TYPE_TO_TOOL_NAME[activityType] ?? activityType.toLowerCase();
            const actToolCallId = `activity-${msg.id}-${toolIdx}`;
            toolCallParts.push({ type: 'tool_call', id: actToolCallId, name: actToolName });
            const content = evt.content as Record<string, unknown> | undefined;
            const actStartTs = numOr(content?.start_time) ?? evt.timestamp;
            const actEndTs = numOr(content?.finish_time) ?? evt.timestamp;
            allToolStartTimes.push(actStartTs);
            allToolEndTimes.push(actEndTs);
            const activityEntries = this.transformActivitySnapshot(
              task, msg, evt, model, turnId, toolIdx, common,
              currentStep, traceId, agentSpanId,
            );
            entries.push(...activityEntries);
            toolIdx += 2; // tool.call + tool.result
            if (currentStep) currentStep.hasToolCalls = true;
          }
          break;
        }
      }
    }

    // 合成 step 中同时有工具和最终文本时拆为两步：step 1 声明并执行工具，step 2 只输出最终答案，从而同时满足工具配对与末步无 tool_call 规则。
    if (!hasStepEvents && currentStep && currentStep.hasToolCalls && allToolStartTimes.length > 0) {
      // 第一段 LLM span 对应“模型决定调用工具”；单独生成 span ID，父级仍是当前 step span。
      const midLlmSpanId = generateSpanId();
      const midOutputParts: Array<Record<string, string>> = [];
      for (const tc of toolCallParts) {
        // 这里只需要把调用声明放进 assistant 输出，参数和结果已由独立 tool.* 事件承载。
        midOutputParts.push({ type: tc.type, id: tc.id, name: tc.name });
      }
      // request 从 run/step 起点开始；response 人为放在第一个工具开始前 1ms，维持父子时序。
      const midReqTs = runStartedTs ?? currentStep.startTimestamp;
      const firstToolTs = minOf(allToolStartTimes);
      const lastToolTs = maxOf(allToolStartTimes, allToolEndTimes);
      const midRespTs = Math.max(midReqTs + 1, firstToolTs - 1);

      // 生成 step 1 的工具调用型 llm.request/response。
      entries.push(buildAgentActivityEntry({
        // 请求事件没有自己的 span_id；与随后 response 通过稳定 event.id、turn 和 step 关联。
        timestamp: midReqTs,
        'event.id': hashId([sessionId, msg.id, 'request', String(currentStep.stepIndex)]),
        'event.name': 'llm.request',
        ...common,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': currentStep.stepId,
        'gen_ai.request.model': model,
        'gen_ai.response.id': runId,
        'trace_id': traceId,
        // 用户输入只随 turn 的第一步发送，后续步骤通过上下文延续，避免重复整段 prompt。
        ...(userContent && currentStep.stepIndex === 1 ? {
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: userContent }] },
          ],
        } : {}),
        attributes: { source: 'wukong', message_id: msg.id, conversation_id: msg.conversationId },
      }));
      entries.push(buildAgentActivityEntry({
        // response 使用独立 LLM span，并挂到 step span 下，形成 agent.step -> llm.response 层级。
        timestamp: midRespTs,
        'event.id': hashId([sessionId, msg.id, 'response', String(currentStep.stepIndex)]),
        'event.name': 'llm.response',
        ...common,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': currentStep.stepId,
        'gen_ai.response.id': runId,
        'gen_ai.request.model': model,
        'gen_ai.response.model': model,
        'gen_ai.response.finish_reasons': ['tool_calls'],
        'trace_id': traceId,
        'span_id': midLlmSpanId,
        'parent_span_id': currentStep.stepSpanId,
        ...(userContent && currentStep.stepIndex === 1 ? {
          'gen_ai.input.messages': [
            { role: 'user', parts: [{ type: 'text', content: userContent }] },
          ],
        } : {}),
        ...(midOutputParts.length > 0 ? {
          // tool_call parts 告诉下游本次 response 的结束原因是等待工具，而不是最终回答。
          'gen_ai.output.messages': [{ role: 'assistant', parts: midOutputParts }],
        } : {}),
        // Wukong API 未提供该中间 wave 的 token 明细；显式置 0 保持 Schema 数值字段完整。
        'gen_ai.usage.input_tokens': 0,
        'gen_ai.usage.output_tokens': 0,
        'gen_ai.usage.cache_read.input_tokens': 0,
        'gen_ai.usage.total_tokens': 0,
        attributes: { source: 'wukong', message_id: msg.id, conversation_id: msg.conversationId },
      }));

      // 所有工具完成后再开始 step 2，承载最终答案。
      stepIndex++;
      // 加 1ms 避免最终 step 与最后工具结果同一时刻，保证可视化时间轴严格有序。
      const finalStepStart = lastToolTs + 1;
      currentStep = {
        stepIndex,
        stepId: `${turnId}:s${stepIndex}`,
        stepMessageId: `synth-final-${stepIndex}`,
        hasToolCalls: false,
        startTimestamp: finalStepStart,
        stepSpanId: generateSpanId(),
      };
      // 新 step 不再携带上一 step 的工具声明；最终输出会作为纯文本 response。
      toolCallParts.length = 0;
      // 覆盖 runFinishedTs，使最终 step 的响应时间严格晚于工具。
      if (!runFinishedTs || runFinishedTs <= finalStepStart) {
        runFinishedTs = finalStepStart + 1;
      }
    }

    // 为当前（也可能是唯一）step 生成 LLM 对；已在 STEP_FINISHED flush 的 step 必须跳过。
    const alreadyFlushed = currentStep && flushedStepIds.has(currentStep.stepId);
    const shouldEmitFinalLlm = !alreadyFlushed && currentStep && (
      textContent || usageEvent || toolCallParts.length > 0
      || runError
      || (currentStep.stepIndex > 1 && !currentStep.hasToolCalls)
    );
    if (currentStep && shouldEmitFinalLlm) {
      const finishReasons = this.inferFinishReasons(currentStep.hasToolCalls, runError);
      const llmSpanId = generateSpanId();

      const inputTokens = numOr(usageEvent?.prompt_tokens) ?? 0;
      const outputTokens = numOr(usageEvent?.completion_tokens) ?? 0;
      const cachedTokens = numOr(usageEvent?.cached_tokens) ?? 0;
      const totalTokens = numOr(usageEvent?.total_tokens) ?? (inputTokens + outputTokens);

      // 时间策略：工具型 step 的响应位于首个工具前且时长非零；纯文本最终 step 使用 runFinishedTs；拆分出的 step 2 从最后工具之后开始。
      const requestTimestamp = Math.max(currentStep.startTimestamp, runStartedTs ?? 0) || msg.createdAt;
      let responseTimestamp: number;
      if (currentStep.hasToolCalls && allToolStartTimes.length > 0) {
        // 从 TOOL_CALL_START 与 ACTIVITY_SNAPSHOT 中取最早工具时间。
        const firstToolTs = minOf(allToolStartTimes);
        responseTimestamp = Math.max(requestTimestamp + 1, firstToolTs - 1);
      } else if (currentStep.hasToolCalls) {
        // 工具型 step 缺少工具时间时使用安全回退时间，仍保持非零时长。
        responseTimestamp = requestTimestamp + 1;
      } else {
        responseTimestamp = Math.max(requestTimestamp + 1, runFinishedTs ?? msg.createdAt);
      }
      // 每个 step 先生成 llm.request。event.id 使用 session/message/step 的稳定组合，重放时保持一致。
      entries.push(buildAgentActivityEntry({
        timestamp: requestTimestamp,
        'event.id': hashId([sessionId, msg.id, 'request', String(currentStep.stepIndex)]),
        'event.name': 'llm.request',
        // common 提供 session、Agent、Provider 等公共字段；下面补充本 turn/step 的层级身份。
        ...common,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': currentStep.stepId,
        'gen_ai.request.model': model,
        'gen_ai.response.id': runId,
        'trace_id': traceId,
        // 用户 prompt 只属于第一步；工具后的后续 step 依赖上下文，不重复上报同一段正文。
        ...(userContent && currentStep.stepIndex === 1 ? {
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: userContent }] },
          ],
        } : {}),
        attributes: {
          // Wukong 私有定位字段交给 entry-builder 展平为 agent.wukong.*。
          source: 'wukong',
          message_id: msg.id,
          conversation_id: msg.conversationId,
        },
      }));

      // output message parts 同时包含可选文本和工具调用声明。
      const outputParts: Array<Record<string, string>> = [];
      if (textContent) {
        outputParts.push({ type: 'text', content: textContent });
      }
      for (const tc of toolCallParts) {
        outputParts.push({ type: tc.type, id: tc.id, name: tc.name });
      }
      // 仅 RUN_ERROR 的 turn 也写 error output.messages，满足 validator 的输入/输出约束。
      if (outputParts.length === 0 && runError) {
        outputParts.push({ type: 'text', content: `[error] ${runError.code}: ${runError.message}` });
      }

      // response 与上面的 request 共用 turn/step/run ID，并创建真正参与 Trace 父子关系的 LLM span。
      const responseEntry = buildAgentActivityEntry({
        timestamp: responseTimestamp,
        'event.id': hashId([sessionId, msg.id, 'response', String(currentStep.stepIndex)]),
        'event.name': 'llm.response',
        ...common,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': currentStep.stepId,
        'gen_ai.response.id': runId,
        'gen_ai.request.model': model,
        'gen_ai.response.model': model,
        'gen_ai.response.finish_reasons': finishReasons,
        'trace_id': traceId,
        // LLM span 挂在 agent.step span 下；工具 span 也使用相同步骤父级，形成同一 wave。
        'span_id': llmSpanId,
        'parent_span_id': currentStep.stepSpanId,
        ...(userContent && currentStep.stepIndex === 1 ? {
          // response 携带完整 input.messages，request 则携带 messages_delta，满足两种消费模式。
          'gen_ai.input.messages': [
            { role: 'user', parts: [{ type: 'text', content: userContent }] },
          ],
        } : {}),
        ...(outputParts.length > 0 ? {
          // outputParts 可以同时包含文本和 tool_call 声明；空输出时整个字段省略而非写空数组。
          'gen_ai.output.messages': [
            { role: 'assistant', parts: outputParts },
          ],
        } : {}),
        // Wukong usage 是本次 run 的数值快照；缺失字段在上方已收敛为 0，总量缺失时用输入加输出。
        'gen_ai.usage.input_tokens': inputTokens,
        'gen_ai.usage.output_tokens': outputTokens,
        'gen_ai.usage.cache_read.input_tokens': cachedTokens,
        'gen_ai.usage.total_tokens': totalTokens,
        // 仅 RUN_ERROR 注入标准错误字段；普通非成功 finish reason 不自动视为异常。
        ...(runError ? { 'error.type': runError.code, 'error.message': runError.message } : {}),
        attributes: {
          source: 'wukong',
          message_id: msg.id,
          conversation_id: msg.conversationId,
          // FIRST_TOKEN 提供首 token 延迟；没有该事件时不伪造性能值。
          ...(firstTokenEvent ? {
            ttft_ms: firstTokenEvent.ttft_ms as number,
            e2e_ttft_ms: firstTokenEvent.e2e_ttft_ms as number,
          } : {}),
          // run_duration 只有起止事件都存在才计算，避免用消息时间混入不同口径。
          ...(runStartedTs && runFinishedTs ? {
            run_duration_ms: runFinishedTs - runStartedTs,
          } : {}),
        },
      });
      entries.push(responseEntry);
    }

    // 检测只有工具 entry、没有 LLM 对的 step，并合成声明这些工具的 request/response，满足每 step 一个 LLM 的结构规则。
    const stepsWithLlm = new Set<string>();
    const stepsWithTools = new Map<string, AgentActivityEntry[]>();
    for (const entry of entries) {
      const sid = entry['gen_ai.step.id'];
      if (typeof sid !== 'string' || !sid) continue;
      const ename = entry['event.name'];
      if (ename === 'llm.request' || ename === 'llm.response') {
        stepsWithLlm.add(sid);
      } else if (ename === 'tool.call' || ename === 'tool.result') {
        const arr = stepsWithTools.get(sid) ?? [];
        arr.push(entry);
        stepsWithTools.set(sid, arr);
      }
    }
    for (const [stepId, toolEntries] of stepsWithTools) {
      // 已有正常 LLM 对的 step 不需要合成；这里只修复 Wukong 源事件缺少模型 wave 的结构空洞。
      if (stepsWithLlm.has(stepId)) continue;
      // 当前 step 有工具但没有 LLM，补一个合成 LLM 对。
      const callEntries = toolEntries.filter(e => e['event.name'] === 'tool.call');
      const synthOutputParts: Array<Record<string, string>> = [];
      for (const ce of callEntries) {
        // 合成 response 只声明 call ID 和工具名；参数/结果仍留在真实 tool.* entry 中。
        synthOutputParts.push({
          type: 'tool_call',
          id: String(ce['gen_ai.tool.call.id'] ?? ''),
          name: String(ce['gen_ai.tool.name'] ?? ''),
        });
      }
      // 从工具 entry 推导合成 LLM 的请求/响应时间。
      const toolTimes = toolEntries.map(e => Number(e['time_unix_nano'] ?? 0) / 1e6);
      // 请求放在最早工具前 1ms、响应放在最晚工具后 1ms，使时间轴包含完整工具波次。
      const synthReqTs = minOf(toolTimes) - 1;
      const synthRespTs = maxOf(toolTimes) + 1;
      const synthLlmSpanId = generateSpanId();
      // 从任一工具 entry 取得共享的 step parent_span_id。
      const stepParentSpanId = (toolEntries[0]['parent_span_id'] as string | undefined) ?? agentSpanId;

      // 合成 request 使用确定性 event.id；没有原始 prompt 时写 continued 占位，满足 Schema 输入约束。
      entries.push(buildAgentActivityEntry({
        timestamp: synthReqTs,
        'event.id': hashId([sessionId, msg.id, 'synth-request', stepId]),
        'event.name': 'llm.request',
        ...common,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': stepId,
        'gen_ai.request.model': model,
        'gen_ai.response.id': runId,
        'trace_id': traceId,
        'gen_ai.input.messages_delta': [
          { role: 'user', parts: [{ type: 'text', content: userContent || '(continued)' }] },
        ],
        attributes: { source: 'wukong', message_id: msg.id, conversation_id: msg.conversationId },
      }));
      // 合成 response 创建 LLM span，finish reason 明确表示模型选择了工具而不是输出最终答案。
      entries.push(buildAgentActivityEntry({
        timestamp: synthRespTs,
        'event.id': hashId([sessionId, msg.id, 'synth-response', stepId]),
        'event.name': 'llm.response',
        ...common,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': stepId,
        'gen_ai.response.id': runId,
        'gen_ai.request.model': model,
        'gen_ai.response.model': model,
        'gen_ai.response.finish_reasons': ['tool_calls'],
        'trace_id': traceId,
        'span_id': synthLlmSpanId,
        // 父级沿用真实工具 entry 的 step span；缺失时退回 turn 级 agent span。
        'parent_span_id': stepParentSpanId,
        'gen_ai.input.messages': [
          { role: 'user', parts: [{ type: 'text', content: userContent || '(continued)' }] },
        ],
        ...(synthOutputParts.length > 0 ? {
          'gen_ai.output.messages': [{ role: 'assistant', parts: synthOutputParts }],
        } : {}),
        // 源事件没有这次隐含 LLM wave 的 usage，显式写 0 比借用整个 run 的 token 更不易误导。
        'gen_ai.usage.input_tokens': 0,
        'gen_ai.usage.output_tokens': 0,
        'gen_ai.usage.cache_read.input_tokens': 0,
        'gen_ai.usage.total_tokens': 0,
        attributes: { source: 'wukong', message_id: msg.id, conversation_id: msg.conversationId },
      }));
    }

    // 为缺少 trace_id 的 entry 回填当前 turn trace；缺少 step.id 的工具归入第一个 step，而不是可能已推进的 currentStep。
    let firstStepId: string | undefined;
    for (const entry of entries) {
      const sid = entry['gen_ai.step.id'];
      if (typeof sid === 'string' && sid) { firstStepId = sid; break; }
    }
    for (const entry of entries) {
      if (!entry['gen_ai.step.id'] && firstStepId) {
        entry['gen_ai.step.id'] = firstStepId;
      }
      if (!entry['trace_id']) {
        entry['trace_id'] = traceId;
      }
    }

    // 将上一 step 的 tool_call_response 注入下一 step 的 llm.request messages_delta：step 1 是用户输入，step 2+ 是前一步工具结果。
    const toolResultsByStep = new Map<string, Array<{ id: string; name: string; result: unknown }>>();
    for (const entry of entries) {
      if (entry['event.name'] !== 'tool.result') continue;
      const sid = entry['gen_ai.step.id'];
      if (typeof sid !== 'string' || !sid) continue;
      const arr = toolResultsByStep.get(sid) ?? [];
      arr.push({
        id: String(entry['gen_ai.tool.call.id'] ?? ''),
        name: String(entry['gen_ai.tool.name'] ?? ''),
        result: entry['gen_ai.tool.call.result'],
      });
      toolResultsByStep.set(sid, arr);
    }
    // 从 :sN 后缀解析 stepIndex，并按序取得 step.id。
    const stepIds = Array.from(new Set(entries
      .map(e => e['gen_ai.step.id'])
      .filter((s): s is string => typeof s === 'string' && !!s)
    )).sort((a, b) => {
      const na = parseInt(a.match(/:s(\d+)$/)?.[1] ?? '0', 10);
      const nb = parseInt(b.match(/:s(\d+)$/)?.[1] ?? '0', 10);
      return na - nb;
    });
    // 对每个 N>=2 的 step，把 N-1 的工具响应前置到其 llm.request messages_delta。
    for (let i = 1; i < stepIds.length; i++) {
      const prevStepId = stepIds[i - 1];
      const curStepId = stepIds[i];
      const priorTools = toolResultsByStep.get(prevStepId) ?? [];
      if (priorTools.length === 0) continue;
      const toolResponseMessages = priorTools.map(t => ({
        role: 'tool',
        parts: [{
          type: 'tool_call_response',
          id: t.id,
          response: typeof t.result === 'string' ? t.result : JSON.stringify(t.result ?? ''),
        }],
      }));
      // 查找当前 step 对应的 llm.request entry。
      for (const entry of entries) {
        if (entry['event.name'] !== 'llm.request') continue;
        if (entry['gen_ai.step.id'] !== curStepId) continue;
        const existing = entry['gen_ai.input.messages_delta'];
        const existingArr = Array.isArray(existing) ? existing : [];
        entry['gen_ai.input.messages_delta'] = toJsonValue([...toolResponseMessages, ...existingArr]);
        break;
      }
    }

    return entries;
  }

  /**
   * 按错误和工具状态推导标准 LLM 结束原因。
   * @returns 出错为 `stop`，有工具为 `tool_calls`，否则为 `end_turn`。
   */
  private inferFinishReasons(
    hasToolCalls: boolean,
    runError: { code: string; message: string } | undefined,
  ): string[] {
    if (runError) return ['stop'];
    if (hasToolCalls) return ['tool_calls'];
    return ['end_turn'];
  }

  /**
   * 把 `TOOL_CALL_START` 及后续累积参数构建为一条标准 `tool.call`。
   * 参数缺失时保持字段省略；本函数只创建对象，不执行工具或外部 I/O。
   * @returns 带 trace、step 和父 Span 关联的工具调用事件。
   */
  private buildToolCallEntry(
    task: ValidWukongTask,
    msg: WukongMessage,
    evt: AguiEvent,
    model: string,
    turnId: string,
    toolIdx: number,
    common: Record<string, unknown>,
    step: StepContext | null,
    traceId: string,
    agentSpanId: string,
    args: string | undefined,
  ): AgentActivityEntry {
    const toolCallId = (evt.toolCallId as string | undefined) ?? '';
    const toolName = (evt.toolName as string | undefined) ?? (evt.name as string | undefined) ?? '';
    const toolSpanId = generateSpanId();

    let parsedArgs: unknown | undefined;
    if (args) {
      try { parsedArgs = JSON.parse(args); } catch { parsedArgs = args; }
    }

    return buildAgentActivityEntry({
      timestamp: evt.timestamp || msg.createdAt,
      'event.id': hashId([task.session_id, msg.id, 'tool_call', toolCallId, String(toolIdx)]),
      'event.name': 'tool.call',
      ...common,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': step?.stepId,
      'gen_ai.request.model': model,
      'gen_ai.tool.name': toolName,
      'gen_ai.tool.call.id': toolCallId,
      ...(parsedArgs !== undefined ? { 'gen_ai.tool.call.arguments': toJsonValue(parsedArgs) } : {}),
      'trace_id': traceId,
      'span_id': toolSpanId,
      'parent_span_id': step?.stepSpanId ?? agentSpanId,
      attributes: {
        source: 'wukong',
        message_id: msg.id,
      },
    });
  }

  /**
   * 把 `TOOL_CALL_END` 构建为标准 `tool.result`，并结合开始时间计算持续时长和规范化状态。
   * @returns 工具结果事件；找不到开始事件时仍使用安全时间和已知名称生成可关联记录。
   */
  private buildToolResultEntry(
    task: ValidWukongTask,
    msg: WukongMessage,
    evt: AguiEvent,
    model: string,
    turnId: string,
    toolIdx: number,
    common: Record<string, unknown>,
    duration: number | undefined,
    step: StepContext | null,
    traceId: string,
    agentSpanId: string,
    toolName?: string,
  ): AgentActivityEntry {
    const toolCallId = (evt.toolCallId as string | undefined) ?? '';
    const resolvedToolName = toolName ?? (evt.toolName as string | undefined) ?? (evt.name as string | undefined) ?? '';
    const result = evt.result ?? evt.output;
    const hasError = Boolean(evt.error || evt.isError);
    const toolSpanId = generateSpanId();

    return buildAgentActivityEntry({
      timestamp: evt.timestamp || msg.createdAt,
      'event.id': hashId([task.session_id, msg.id, 'tool_result', toolCallId, String(toolIdx)]),
      'event.name': 'tool.result',
      ...common,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': step?.stepId,
      'gen_ai.request.model': model,
      'gen_ai.tool.name': resolvedToolName,
      'gen_ai.tool.call.id': toolCallId,
      ...(result !== undefined ? { 'gen_ai.tool.call.result': toJsonValue(result) } : {}),
      ...(duration !== undefined ? { 'gen_ai.tool.call.duration': duration } : {}),
      'tool.result.status': hasError ? 'failure' : 'success',
      ...(hasError && evt.error ? { 'error.type': String(evt.error) } : {}),
      'trace_id': traceId,
      'span_id': toolSpanId,
      'parent_span_id': step?.stepSpanId ?? agentSpanId,
      attributes: {
        source: 'wukong',
        message_id: msg.id,
      },
    });
  }

  /**
   * 将 Wukong 聚合型 `ACTIVITY_SNAPSHOT` 拆成成对的 `tool.call/tool.result`。
   * 不同 activity 类型在此提取各自参数、结果、错误和时间，未知类型使用通用 input/output 字段。
   * @returns 始终包含调用和结果两条标准事件的数组。
   */
  private transformActivitySnapshot(
    task: ValidWukongTask,
    msg: WukongMessage,
    evt: AguiEvent,
    model: string,
    turnId: string,
    toolIdx: number,
    common: Record<string, unknown>,
    step: StepContext | null,
    traceId: string,
    agentSpanId: string,
  ): AgentActivityEntry[] {
    const activityType = evt.activityType as string;
    const toolName = ACTIVITY_TYPE_TO_TOOL_NAME[activityType] ?? activityType.toLowerCase();
    const content = evt.content as Record<string, unknown> | undefined;

    const startTime = numOr(content?.start_time) ?? evt.timestamp;
    const rawFinishTime = numOr(content?.finish_time) ?? evt.timestamp;
    // 保证 activity 转换出的工具 Span 起止时间不同。
    const finishTime = rawFinishTime > startTime ? rawFinishTime : startTime + 1;
    const duration = finishTime > startTime ? finishTime - startTime : undefined;

    const toolCallId = `activity-${msg.id}-${toolIdx}`;

    // 按 activity 类型提取并规范化工具参数。
    let args: unknown | undefined;
    let result: unknown | undefined;

    if (content) {
      switch (activityType) {
        case 'TERMINAL':
          // 终端活动把命令作为参数，把 stdout/exit_code 作为结果，便于还原命令执行。
          args = content.command ? { command: content.command } : undefined;
          result = { output: content.output, exit_code: content.exit_code };
          break;
        case 'FILE_WRITE':
          // 写文件源事件通常只提供路径和最终状态，不在这里读取文件正文以避免额外 I/O。
          args = compactObject({ path: content.path ?? content.file_path });
          result = { status: content.status ?? 'done' };
          break;
        case 'FILE_READ':
          // 读取活动保留行号范围和返回片段；compactObject 会删除不同版本缺失的字段。
          args = compactObject({ path: content.path, start_line: content.start_line });
          result = compactObject({
            content: content.content,
            snippet: content.snippet,
            total_lines: content.total_lines,
            status: content.status,
            error_message: content.error_message,
          });
          break;
        case 'GREP_SEARCH':
          // grep 的 query 是输入，matches/output 是输出；两种结果字段兼容不同 CLI 版本。
          args = content.query ? { query: content.query } : undefined;
          result = content.matches ?? content.output;
          break;
        case 'SEARCH':
          // 通用搜索可一次提交多个 query，并在结果中保留来源状态。
          args = compactObject({ queries: content.queries, search_type: content.search_type });
          result = compactObject({ results: content.results, status: content.status });
          break;
        case 'DIRECTORY_LIST':
          // 目录列表优先使用直接 entries/output，旧版本则由 files/count/status 组合结果。
          args = content.path ? { path: content.path } : undefined;
          result = content.entries ?? content.output ?? compactObject({
            files: content.files,
            total_count: content.total_count,
            status: content.status,
          });
          break;
        case 'SKILL':
          // Skill 活动把名称、用途和元数据作为调用参数，把输出或错误作为结果。
          args = compactObject({ skill_name: content.skill_name, purpose: content.purpose, meta: content.meta });
          result = compactObject({
            output: content.output,
            status: content.status,
            error_message: content.error_message,
          });
          break;
        case 'ARTIFACT':
          // Artifact 没有独立调用参数，只记录生成产物元数据和生成时间。
          result = compactObject({ artifactsMetadata: content.artifactsMetadata, generatedAt: content.generatedAt });
          break;
        default:
          // 未知 activity 保留通用 input/output/result，确保新增类型不会被完全丢弃。
          args = content.input ?? undefined;
          result = content.output ?? content.result ?? undefined;
          break;
      }
    }

    // 每条 call/result 记录拥有独立事件 span ID，但共享 step 或 agent parent，供转换器建立层级。
    const callSpanId = generateSpanId();
    const resultSpanId = generateSpanId();
    const parentSpanId = step?.stepSpanId ?? agentSpanId;

    const toolCallEntry = buildAgentActivityEntry({
      timestamp: startTime,
      'event.id': hashId([task.session_id, msg.id, 'activity_call', toolCallId, String(toolIdx)]),
      'event.name': 'tool.call',
      ...common,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': step?.stepId,
      'gen_ai.request.model': model,
      'gen_ai.tool.name': toolName,
      'gen_ai.tool.call.id': toolCallId,
      ...(args !== undefined ? { 'gen_ai.tool.call.arguments': toJsonValue(args) } : {}),
      'trace_id': traceId,
      'span_id': callSpanId,
      'parent_span_id': parentSpanId,
      attributes: { source: 'wukong', message_id: msg.id },
    });

    // 状态与 error.message 分开保存：状态供聚合，原始错误文本供排障。
    const toolResultStatus = resolveActivityResultStatus(content);
    const errorMessage = typeof content?.error_message === 'string' && content.error_message.length > 0
      ? content.error_message
      : undefined;
    const toolResultEntry = buildAgentActivityEntry({
      timestamp: finishTime,
      'event.id': hashId([task.session_id, msg.id, 'activity_result', toolCallId, String(toolIdx + 1)]),
      'event.name': 'tool.result',
      ...common,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': step?.stepId,
      'gen_ai.request.model': model,
      'gen_ai.tool.name': toolName,
      'gen_ai.tool.call.id': toolCallId,
      ...(result !== undefined ? { 'gen_ai.tool.call.result': toJsonValue(result) } : {}),
      ...(duration !== undefined ? { 'gen_ai.tool.call.duration': duration } : {}),
      'tool.result.status': toolResultStatus,
      ...(errorMessage !== undefined ? { 'error.message': errorMessage } : {}),
      'trace_id': traceId,
      'span_id': resultSpanId,
      'parent_span_id': parentSpanId,
      attributes: { source: 'wukong', message_id: msg.id },
    });

    return [toolCallEntry, toolResultEntry];
  }

  /**
   * 通过多个短生命周期 `wukong-cli ... list_tasks` 子进程拉取全部任务页。
   * 每页最多 50 条，总量达到 500 时截断并告警；缺少 `session_id` 的任务会被过滤。
   * @returns 有效任务数组，按 CLI 分页顺序排列。
   * @throws 子进程失败、超时、取消、非 JSON 输出或响应结构不符合约定时抛错。
   */
  private async listAllTasks(): Promise<Array<WukongTask & { session_id: string }>> {
    const allTasks: Array<WukongTask & { session_id: string }> = [];
    let cursor: string | undefined;
    let hasMore = false;
    do {
      // cursor 只在服务端声明 hasMore 时携带；首页不传 cursor。
      const params: Record<string, unknown> = { limit: TASK_BATCH_LIMIT };
      if (cursor) params.cursor = cursor;
      // execFile 不经过 Shell，JSON 参数作为单独 argv 传入；timeout/maxBuffer 防止子进程失控。
      const { stdout, stderr } = await execFile(
        this.cliPath,
        ['agent', 'data', 'list_tasks', '--json', JSON.stringify(params)],
        { timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_BUFFER, signal: this._abortController.signal },
      );
      if (!stdout || !/\S/.test(stdout)) {
        this.logger.debug('wukong-cli list_tasks returned empty stdout', {
          stderr: (stderr ?? '').slice(0, 256),
        });
        break;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch (e) {
        throw new Error(`wukong-cli list_tasks returned non-JSON (stderr=${(stderr ?? '').slice(0, 256)}, head=${stdout.slice(0, 256)}): ${e}`);
      }
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { items?: unknown }).items)) {
        throw new Error('unexpected listTasks response structure');
      }
      const resp = parsed as ListTasksResponse;
      // 没有 session_id 的任务无法调用 getMessages，也无法生成稳定会话事件，因此过滤。
      for (const item of resp.items) {
        if (item.session_id != null) allTasks.push(item as WukongTask & { session_id: string });
      }
      // 服务端若错误地给出 hasMore 但没有 nextCursor，do/while 会自然停止，避免死循环。
      cursor = resp.hasMore ? resp.nextCursor : undefined;
      hasMore = !!resp.hasMore;
    } while (cursor && allTasks.length < MAX_TASKS);
    if (cursor && hasMore) {
      this.logger.warn('wukong task pagination truncated by MAX_TASKS', {
        limit: MAX_TASKS,
        fetched: allTasks.length,
      });
    }
    return allTasks;
  }

  /**
   * 调用 `get_spark_agui_messages` 读取一个会话的完整消息列表。
   * 空标准输出按“暂无消息”处理；标准错误只截取前 256 字符写日志，避免日志膨胀。
   * @param conversationId Wukong session/conversation 标识。
   * @returns CLI 响应 Promise。
   * @throws 子进程失败、超时、取消、JSON 无法解析或缺少 `messages` 数组时抛错。
   */
  private async getMessages(conversationId: string): Promise<GetMessagesResponse> {
    const { stdout, stderr } = await execFile(
      this.cliPath,
      ['agent', 'data', 'get_spark_agui_messages', '--json', JSON.stringify({ conversationId })],
      { timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_BUFFER, signal: this._abortController.signal },
    );
    if (!stdout || !/\S/.test(stdout)) {
      const stderrSnippet = (stderr ?? '').slice(0, 256);
      const logLevel = stderrSnippet ? 'warn' : 'debug';
      this.logger[logLevel]('wukong-cli get_spark_agui_messages returned empty stdout, treating as no messages', {
        conversationId,
        stderr: stderrSnippet,
      });
      return { messages: [] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      throw new Error(`wukong-cli get_spark_agui_messages returned non-JSON (stderr=${(stderr ?? '').slice(0, 256)}, head=${stdout.slice(0, 256)}): ${e}`);
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { messages?: unknown }).messages)) {
      throw new Error('unexpected getMessages response structure');
    }
    return parsed as GetMessagesResponse;
  }
}

/** 使用 NUL 分隔输入并计算 SHA-256，生成可重复的事件 ID，避免普通拼接产生边界歧义。 */
function hashId(parts: Array<string | number | undefined>): string {
  return crypto
    .createHash('sha256')
    .update(parts.map(p => p ?? '').join('\0'))
    .digest('hex');
}

/** 仅接受有限数值，过滤 `NaN`、无穷值和错误类型，供不可信 CLI 字段安全取值。 */
function numOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 删除 `null/undefined` 字段；全部为空时返回 `undefined`，从而让构建器省略该属性。 */
function compactObject(fields: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined && value !== null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** 综合 exit code、错误文本和状态字符串，归一化 activity 的三态结果。 */
function resolveActivityResultStatus(content: Record<string, unknown> | undefined): 'success' | 'failure' | 'cancelled' {
  if (!content) return 'success';
  if (content.exit_code !== undefined && content.exit_code !== 0) return 'failure';
  if (typeof content.error_message === 'string' && content.error_message.length > 0) return 'failure';
  if (typeof content.status !== 'string') return 'success';

  const status = content.status.toLowerCase();
  if (status === 'error' || status === 'failed' || status === 'failure') return 'failure';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  return 'success';
}

/** 优先使用非负 `turnIndex` 生成稳定 turn ID；旧消息没有索引时退回消息 ID。 */
function resolveTurnId(sessionId: string, msg: WukongMessage): string {
  if (msg.turnIndex >= 0) return `${sessionId}:t${msg.turnIndex}`;
  return `${sessionId}:${msg.id}`;
}

/** 生成 16 字节随机数对应的 32 位十六进制 trace ID。 */
function generateTraceId(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** 生成 8 字节随机数对应的 16 位十六进制 span ID。 */
function generateSpanId(): string {
  return crypto.randomBytes(8).toString('hex');
}

// 使用迭代 min/max，避免大数组展开为函数参数时超过调用栈/参数数量限制。
/** 迭代求最小时间；调用方应传入非空数组，空数组会得到正无穷。 */
function minOf(arr: ReadonlyArray<number>): number {
  let m = Number.POSITIVE_INFINITY;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v < m) m = v;
  }
  return m;
}

/** 在一个或多个数组中迭代求最大时间；全部为空时返回负无穷。 */
function maxOf(...arrs: ReadonlyArray<ReadonlyArray<number>>): number {
  let m = Number.NEGATIVE_INFINITY;
  for (const arr of arrs) {
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v > m) m = v;
    }
  }
  return m;
}

/** 判断消息能否推进持久化游标：assistant 必须没有事件，或已出现 `RUN_FINISHED/RUN_ERROR`。 */
function isMessageComplete(msg: WukongMessage): boolean {
  if (msg.role !== 'assistant') return true;
  if (!msg.events || msg.events.length === 0) return true;
  return msg.events.some(e => e.type === 'RUN_FINISHED' || e.type === 'RUN_ERROR');
}

/**
 * 查找从数组开头连续可提交的最后一个索引，并剔除没有 assistant 配对的尾部 user 消息。
 * @returns 可提交索引；`-1` 表示当前没有任何消息可以安全推进游标。
 */
function findLastCompleteIndex(messages: WukongMessage[]): number {
  // 先找到从 0 到 i 全部结束流式写入的最后位置。
  let lastComplete = messages.length - 1;
  for (let i = 0; i < messages.length; i++) {
    if (!isMessageComplete(messages[i])) {
      lastComplete = i - 1;
      break;
    }
  }
  // 再去掉没有配对 assistant 的尾部 user 消息，避免生成没有 LLM 子节点的孤立 ENTRY/AGENT。
  while (lastComplete >= 0 && messages[lastComplete].role === 'user') {
    lastComplete--;
  }
  return lastComplete;
}

/**
 * 从后向前查找同一工具调用最近生成的指定事件，供后到达的 RESULT 事件补写结果和错误信息。
 * @returns 匹配事件；尚未生成对应调用时返回 `undefined`。
 */
function findEntryByToolCallId(
  entries: AgentActivityEntry[],
  eventName: string,
  toolCallId: string,
): AgentActivityEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (
      entries[i]['event.name'] === eventName &&
      entries[i]['gen_ai.tool.call.id'] === toolCallId
    ) {
      return entries[i];
    }
  }
  return undefined;
}
