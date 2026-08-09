/**
 * 所有 Agent Input 的统一事件、轮询和停止生命周期。
 *
 * AgentDiscoveryService 调用 start/stop；子类 collect 返回标准事件后，本类同步 emit `entries`，
 * InputManager 为每个 Input 建立异步处理队列。`cyclePromise` 保证 timer、watcher 即时请求和首轮
 * 不会重入；stop 会先清 timer，再等待当前 collect/state save 完成。
 *
 * 一轮采集的实际时序是 `collect -> emit(entries) -> StateStore.save`。其中 `emit` 只同步执行
 * InputManager 的“入队”代码，不等待输出完成，所以状态落盘与远端发送并非事务：若发送成功前
 * 进程崩溃，重启可能从已推进的 checkpoint 继续而漏发；反过来若发送成功后、状态落盘前崩溃，
 * 重启可能重复采集。优雅停止时 InputManager 会在本类 stop 完成后继续排空输出队列。
 */

import { EventEmitter } from 'node:events';
import type { AgentActivityEntry, InputState } from '../../types/index.js';
import { ClientType, CollectionMethod } from '../../types/index.js';
import { type BoundLogger, createLogger } from '../../utils/logger.js';
import type { StateStore } from '../../checkpoints/state-store.js';

/** Input 共用依赖：全局 StateStore 和可覆盖轮询周期。 */
export interface InputOptions {
  /** Orchestrator 创建并在多个 Input 间共享的 checkpoint 仓库。 */
  stateStore: StateStore;
  /** 周期毫秒数；缺省 30 秒。0 等特殊值会原样传给 setInterval，调用方应先校验。 */
  pollIntervalMs?: number;
}

/**
 * 所有 Input 的抽象基类。
 *
 * 它把不同来源统一成 EventEmitter 协议：子类在 `collect()` 中返回标准事件，本类发布
 * `entries`；采集/状态保存异常转为 `collect-error`。除完全自定义数据源外，应优先继承
 * IDE/SQLite/Hook/Session 等专用基类，以复用其游标和资源生命周期。
 *
 * `collect-error` 不是 Node.js EventEmitter 的特殊 `error` 事件：即使没有监听器也不会再次
 * 抛错，错误仍会由本类 logger 记录。实例在 stop 后可再次 start，但子类 onStop/onStart 必须
 * 自行保证资源可重建。
 */
export abstract class BaseInput extends EventEmitter {
  /** InputManager、StateStore 与 listener config 使用的唯一 ID。 */
  abstract readonly id: string;
  /** 输出事件中的产品/采集入口类型。 */
  abstract readonly agentType: ClientType;
  /** 发现/指标层展示的采集方式。 */
  abstract readonly collectionMethod: CollectionMethod;

  protected readonly logger: BoundLogger;
  protected readonly stateStore: StateStore;
  protected pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 当前 timer 或 watcher 触发的唯一在途周期。 */
  private cyclePromise: Promise<void> | null = null;
  private _running = false;

  /**
   * 保存共享 StateStore、解析默认周期，并以运行时子类名创建 logger。
   *
   * JavaScript 在 `super()` 执行期间已经能通过 `this.constructor.name` 看到具体子类名，因此日志
   * tag 会是 `Codex...Input` 等真实类型。构造阶段不创建 timer，也不调用可覆写 Hook。
   *
   * @param opts checkpoint 仓库和可选轮询周期。
   */
  constructor(opts: InputOptions) {
    super();
    this.stateStore = opts.stateStore;
    this.pollIntervalMs = opts.pollIntervalMs ?? 30_000;
    this.logger = createLogger(this.constructor.name);
  }

  /** 只读运行状态，由发现服务状态机查询。 */
  get running(): boolean {
    return this._running;
  }

  /**
   * 幂等启动，严格按 `onStart -> 立即首轮 -> setInterval` 顺序执行。
   *
   * `await onStart()` 让子类先恢复状态、建目录或打开资源；首轮完成后才创建 timer，避免启动与
   * 定时触发重叠。timer 回调使用 `void`，因为周期错误会在 `runCycleOnce()` 内转为事件。
   *
   * 注意 `_running` 在 `onStart()` 前设为 true；若 onStart 抛错，当前实现不会自动回滚该标志。
   * AgentDiscoveryService 虽会把自己的条目状态退回 idle，但仍复用同一个 Input 实例，所以下一轮
   * `start()` 会因 `_running=true` 直接返回，无法真正重试初始化；是否应在异常路径复位，当前待确认。
   *
   * @throws `onStart()` 异常会向发现服务传播；普通 collect 异常不会从本方法抛出。
   */
  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    this.logger.info('starting');

    await this.onStart();
    await this.runCycle();

    // setInterval 默认是“有引用”的句柄，会让 Node.js 事件循环保持存活；stop 必须 clearInterval。
    this.timer = setInterval(() => void this.runCycle(), this.pollIntervalMs);
  }

  /**
   * 幂等停止：先禁止新周期并清 timer，再等待在途周期，最后执行子类资源清理。
   *
   * `await null` 会立即完成，所以没有在途 collect 时同样安全。等待 `cyclePromise` 可确保文件
   * offset/rowid 保存完成后才关闭数据库或 watcher；`onStop()` 异常原样传播给上层关闭流程。
   */
  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.cyclePromise;
    await this.onStop();
    this.logger.info('stopped');
  }

  /**
   * 子类实现单轮采集。
   * @returns Promise 兑现为已经归一化的事件数组；空数组表示本轮没有新数据。
   * @throws 可抛 I/O/解析异常，`runCycleOnce()` 会记录并发布 `collect-error`。
   */
  protected abstract collect(): Promise<AgentActivityEntry[]>;

  /** 可选版本探测，由具体 Input 实现。 */
  getAgentVersion?(): string;

  /** 一次性启动 Hook，例如建目录、打开 watcher/数据库。 */
  protected async onStart(): Promise<void> {}
  /** 一次性停止 Hook，例如关闭 watcher/数据库。 */
  protected async onStop(): Promise<void> {}

  /**
   * 供子类 watcher 请求立即采集。
   *
   * 方法不返回 Promise，也不等待完成；停止状态直接忽略，运行状态则复用 `runCycle()` 的在途
   * Promise。连续多个 watch 事件会合并到当前周期，而不是排队执行同样次数；当前周期结束后
   * 不会因为合并期间又收到通知而自动补跑一轮，后续变化依赖下一次 timer 或新 watcher 通知发现。
   */
  protected requestCollection(): void {
    if (this._running) void this.runCycle();
  }

  /**
   * 返回现有周期或创建唯一新周期，实现 timer/watcher/首轮之间的防重入。
   *
   * `.finally()` 在 fulfilled/rejected 两种结果上都清空成员；返回的新 Promise 保持原结果，
   * 因而若 `runCycleOnce()` 自身意外 reject，等待它的 start/stop 仍能观察到异常。
   */
  private runCycle(): Promise<void> {
    if (this.cyclePromise) return this.cyclePromise;
    this.cyclePromise = this.runCycleOnce().finally(() => {
      this.cyclePromise = null;
    });
    return this.cyclePromise;
  }

  /**
   * 执行 collect、同步发布 entries，再保存共享 StateStore。
   *
   * `EventEmitter.emit()` 会在当前调用栈同步执行 listener，但 InputManager 的 listener 只把后续
   * 异步处理链接到自己的 Promise 队列，因此这里不会等待脱敏和 Flusher 网络发送。checkpoint
   * 保存发生在 emit 之后，表示“已采集并交给上层队列”，不是“所有远端输出已成功”。
   *
   * try/catch 同时覆盖 collect、listener 同步异常和 StateStore.save；捕获后记录并发布
   * `collect-error`，使 timer 后续周期继续运行。
   *
   * Claude 路径示例：`ClaudeCodeLogInput -> BaseHookInput.collect()` 返回从日 JSONL 新读到的数组；
   * 只有数组非空时，本方法下方的 `emit('entries')` 才是 Collector 内真正的 entries 触发点。
   */
  private async runCycleOnce(): Promise<void> {
    try {
      // 动态分派到具体子类 collect。Claude 使用 BaseHookInput 的“返回数组”模式；CodexTranscriptInput
      // 则在内部为控制批大小直接 emit 并返回 []，两种模式不能混为一谈。
      const entries = await this.collect();
      // emit 本身同步调用监听器；InputManager 监听器会把异步工作接入自己的 Promise 队列。
      if (entries.length > 0) {
        // Claude 的 entries 在这里触发。InputManager.registerInput() 已注册监听器，监听器把
        // handleEntries -> dispatchEntries -> flusher.sendBatch 接到该 Input 的 Promise 队列。
        this.emit('entries', entries);
        this.logger.debug('cycle produced entries', { count: entries.length });
      }
      // 即使本轮没有 entries，也保存 offset/checkpoint 的变化；save 兑现不代表 Flusher 已经发送成功。
      await this.stateStore.save();
    } catch (err) {
      this.logger.error('collection cycle failed', { error: String(err) });
      // 使用自定义事件名而不是 EventEmitter 的 `error`，避免没有监听器时 Node.js 主动抛异常。
      this.emit('collect-error', err);
    }
  }

  /** 读取以当前 Input ID 为 key 的状态；缺失时 StateStore 返回默认结构。 */
  protected getState(): InputState {
    return this.stateStore.get(this.id);
  }

  /** 合并更新当前 Input 状态，真正落盘在周期末统一 save。 */
  protected setState(state: Partial<InputState>): void {
    this.stateStore.update(this.id, state);
  }
}
