/**
 * 所有 Agent Input 的统一事件、轮询和停止生命周期。
 *
 * AgentDiscoveryService 调用 start/stop；子类 collect 返回标准事件后，本类同步 emit `entries`，
 * InputManager 为每个 Input 建立异步处理队列。`cyclePromise` 保证 timer、watcher 即时请求和首轮
 * 不会重入；stop 会先清 timer，再等待当前 collect/state save 完成。
 */

import { EventEmitter } from 'node:events';
import type { AgentActivityEntry, InputState } from '../../types/index.js';
import { ClientType, CollectionMethod } from '../../types/index.js';
import { type BoundLogger, createLogger } from '../../utils/logger.js';
import type { StateStore } from '../../checkpoints/state-store.js';

/** Input 共用依赖：全局 StateStore 和可覆盖轮询周期。 */
export interface InputOptions {
  stateStore: StateStore;
  pollIntervalMs?: number;
}

/**
 * 所有 Input 的抽象基类。
 * 除完全自定义数据源外，应优先继承 IDE/SQLite/Hook/Session 等专用基类。
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

  /** 保存依赖、默认 30 秒轮询，并以运行时子类名创建 logger。 */
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

  /** 幂等启动：onStart -> 立即首轮 -> interval。启动异常由发现/Orchestrator 上层处理。 */
  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    this.logger.info('starting');

    await this.onStart();
    await this.runCycle();

    this.timer = setInterval(() => void this.runCycle(), this.pollIntervalMs);
  }

  /** 幂等停止：禁止新周期、等待在途周期，再执行子类资源清理。 */
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

  /** 子类实现单轮采集，Promise 兑现为已经归一化的事件数组。 */
  protected abstract collect(): Promise<AgentActivityEntry[]>;

  /** 可选版本探测，由具体 Input 实现。 */
  getAgentVersion?(): string;

  /** 一次性启动 Hook，例如建目录、打开 watcher/数据库。 */
  protected async onStart(): Promise<void> {}
  /** 一次性停止 Hook，例如关闭 watcher/数据库。 */
  protected async onStop(): Promise<void> {}

  /** Input 自有 watcher 请求立即采集；仍复用串行 cyclePromise。 */
  protected requestCollection(): void {
    if (this._running) void this.runCycle();
  }

  /** 返回现有周期或创建新周期，并在 settle 后释放门闩。 */
  private runCycle(): Promise<void> {
    if (this.cyclePromise) return this.cyclePromise;
    this.cyclePromise = this.runCycleOnce().finally(() => {
      this.cyclePromise = null;
    });
    return this.cyclePromise;
  }

  /** 执行 collect、发布 entries、保存全局 state；异常转成 collect-error 事件。 */
  private async runCycleOnce(): Promise<void> {
    try {
      const entries = await this.collect();
      // emit 本身同步调用监听器；InputManager 监听器会把异步工作接入自己的 Promise 队列。
      if (entries.length > 0) {
        this.emit('entries', entries);
        this.logger.debug('cycle produced entries', { count: entries.length });
      }
      // 即使本轮没有 entries，也保存 offset/checkpoint 的变化。
      await this.stateStore.save();
    } catch (err) {
      this.logger.error('collection cycle failed', { error: String(err) });
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
