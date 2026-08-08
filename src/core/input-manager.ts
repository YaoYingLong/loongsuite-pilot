/**
 * Input 生命周期与标准事件分发中心。
 *
 * 具体 Input 通过 EventEmitter 发出 `entries`；本类为每个 Input 维护独立 Promise
 * 队列，依次执行计数、user.id 注入、可选上游 Trace 关联、内容采集策略、脱敏，最后
 * 调用 Flusher。不同 Input 可并行，同一 Input 的批次保持顺序。`stopInput()`/`stopAll()`
 * 会先停止源再排空队列，避免退出时丢失已经发出的事件。它发出的 `flushed` 只表示
 * Flusher 调用完成；`MultiFlusher` 内部的单个远端失败可能已被隔离。
 */


import { EventEmitter } from 'node:events';
import type {
  AgentActivityEntry,
  AgentDetectionEntry,
  AgentsConfig,
  MaskConfig,
} from '../types/index.js';
import type { BaseInput } from '../inputs/base/base-input.js';
import type { BaseFlusher } from '../flushers/base-flusher.js';
import type { AlarmManager } from '../metrics/alarm-manager.js';
import { createLogger } from '../utils/logger.js';
import { formatTime } from '../utils/time-utils.js';
import { applyAgentContentPolicy } from '../normalization/agent-content-policy.js';
import { maskAgentActivityEntry } from '../mask/entry-masker.js';
import { loadEnabledRules } from '../mask/rule-loader.js';
import type { CompiledMaskRule } from '../mask/types.js';
import type { TraceLinker } from './upstream-link/trace-linker.js';

const logger = createLogger('InputManager');

export interface InputCounter {
  inEvents: number;
  inBytes: number;
  outEvents: number;
  outFailed: number;
  lastPollTime: string;
  startTime: string;
  type: string;
  lastActiveTime: number;
}

/**
 * 管理 Input 生命周期，并把 Input 产生的标准事件路由给输出器。
 *
 * 主要职责依次是：注册、启动和停止 Input；监听每个 Input 的 `entries` 事件；补充
 * `user.id` 等公共字段；执行关联、内容策略和脱敏；最终交给一个或多个 Flusher。
 */
export class InputManager extends EventEmitter {
  private readonly inputs: Map<string, BaseInput> = new Map();
  private readonly counters: Map<string, InputCounter> = new Map();
  private readonly entryQueues: Map<string, Promise<void>> = new Map();
  private flusher: BaseFlusher | null = null;
  private alarmManager: AlarmManager | null = null;
  private userId: string = '';
  private configuredUserId: string = '';
  private agentsConfig: AgentsConfig = {};
  private maskConfig: MaskConfig = { mode: 'none', types: [] };
  private maskRules: CompiledMaskRule[] = [];
  private traceLinker: TraceLinker | null = null;

  /** 注入唯一输出器；通常是具体 Flusher 或 MultiFlusher。 */
  setFlusher(flusher: BaseFlusher): void {
    this.flusher = flusher;
  }

  /** 注入无输出器时用于记录丢弃告警的 AlarmManager。 */
  setAlarmManager(alarmManager: AlarmManager): void {
    this.alarmManager = alarmManager;
  }

  /** 设置回退 userId，仅在事件未自带且未配置显式 userId 时使用。 */
  setUserId(userId: string): void {
    this.userId = userId;
  }

  /** 设置显式配置 userId；非空时覆盖所有源事件中的 user.id。 */
  setConfiguredUserId(userId: string): void {
    this.configuredUserId = userId;
  }

  /** 更新按 Agent 内容采集策略，后续批次立即使用。 */
  setAgentsConfig(config: AgentsConfig): void {
    this.agentsConfig = config;
  }

  /** 保存脱敏配置并预编译规则，避免每条事件重复加载规则。 */
  setMaskConfig(config: MaskConfig): void {
    this.maskConfig = config;
    this.maskRules = loadEnabledRules(config);
  }

  /** 注入可选上游关联器；未设置时保持采集侧生成的 Trace 上下文。 */
  setTraceLinker(linker: TraceLinker): void {
    this.traceLinker = linker;
  }

  /**
   * 注册 Input 并订阅 entries。重复 ID 被忽略；回调把批次接到前一个 Promise 后面，
   * 前批失败先吞掉再继续，防止队列永久中断。
   */
  registerInput(input: BaseInput): void {
    if (this.inputs.has(input.id)) {
      logger.warn('input already registered', { id: input.id });
      return;
    }
    this.inputs.set(input.id, input);
    this.counters.set(input.id, {
      inEvents: 0,
      inBytes: 0,
      outEvents: 0,
      outFailed: 0,
      lastPollTime: '',
      startTime: '',
      type: input.collectionMethod,
      lastActiveTime: 0,
    });
    input.on('entries', (entries: AgentActivityEntry[]) => {
      const previous = this.entryQueues.get(input.id) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(() => this.handleEntries(input.id, entries))
        .catch(err => {
          logger.error('entry handling failed', { inputId: input.id, error: String(err) });
        });
      this.entryQueues.set(input.id, next);
      void next.finally(() => {
        if (this.entryQueues.get(input.id) === next) this.entryQueues.delete(input.id);
      });
    });
    logger.info('input registered', { id: input.id });
  }

  /** 启动已注册 Input；未知 ID 只记录警告。 */
  async startInput(id: string): Promise<void> {
    const input = this.inputs.get(id);
    if (!input) {
      logger.warn('cannot start unknown input', { id });
      return;
    }
    await input.start();
    logger.info('input started', { id });
  }

  /**
   * 停止源 Input 后等待该 Input 已发出的全部 entries 批次分发完毕。
   */
  async stopInput(id: string): Promise<void> {
    const input = this.inputs.get(id);
    if (!input) return;
    await input.stop();
    await this.drainInputQueue(id);
    logger.info('input stopped', { id });
  }

  /** 顺序停止所有 running Input，再排空全部分发队列。 */
  async stopAll(): Promise<void> {
    for (const [id, input] of this.inputs) {
      if (input.running) {
        await input.stop();
      }
    }
    await this.drainAllEntryQueues();
  }

  /** 等待指定队列稳定为空；等待期间可能接上新 Promise，因此循环复核引用。 */
  private async drainInputQueue(id: string): Promise<void> {
    while (true) {
      const queue = this.entryQueues.get(id);
      if (!queue) return;
      await queue;
      if (this.entryQueues.get(id) === queue) {
        this.entryQueues.delete(id);
        return;
      }
    }
  }

  /** 并行排空当前全部 Input 队列，并复查期间是否出现新队列。 */
  private async drainAllEntryQueues(): Promise<void> {
    while (this.entryQueues.size > 0) {
      await Promise.all([...this.entryQueues.keys()].map(id => this.drainInputQueue(id)));
    }
  }

  /** 按 ID 返回注册实例，主要供 Orchestrator 和诊断使用。 */
  getInput(id: string): BaseInput | undefined {
    return this.inputs.get(id);
  }

  /** 返回实时计数 Map；调用方只应读取。 */
  getInputCounters(): Map<string, InputCounter> {
    return this.counters;
  }

  /** 根据 BaseInput.running 生成当前活跃 ID 列表。 */
  getActiveInputIds(): string[] {
    return Array.from(this.inputs.entries())
      .filter(([, input]) => input.running)
      .map(([id]) => id);
  }

  /** 返回距最后活跃的整分钟数；无记录或从未活跃返回 -1。 */
  getInputIdleMinutes(id: string): number {
    const counter = this.counters.get(id);
    if (!counter || counter.lastActiveTime === 0) return -1;
    return Math.floor((Date.now() - counter.lastActiveTime) / 60_000);
  }

  /**
   * 把已注册 Input 包装成 AgentDiscoveryService 使用的声明式发现条目；start/stop 回调
   * 会回到本类，以便生命周期和待发送队列仍由 InputManager 统一管理。
   */
  buildDetectionEntry(
    input: BaseInput,
    opts: {
      watchPaths: string[];
      isAvailable: () => Promise<boolean>;
      enabled: () => boolean;
      pollIntervalMs?: number;
    },
  ): AgentDetectionEntry {
    return {
      id: input.id,
      type: input.collectionMethod,
      watchPaths: opts.watchPaths,
      isAvailable: opts.isAvailable,
      enabled: opts.enabled,
      start: () => this.startInput(input.id),
      stop: () => this.stopInput(input.id),
      pollIntervalMs: opts.pollIntervalMs ?? 300_000,
    };
  }

  /**
   * 单批标准处理主链：计数 -> userId -> upstream link -> 内容策略 -> 脱敏 -> 输出。
   * 本方法会原地补 user.id/Trace 字段；内容策略和 mask 返回供输出的新条目数组。
   */
  private async handleEntries(
    inputId: string,
    entries: AgentActivityEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;

    const counter = this.counters.get(inputId);
    let batchBytes = 0;
    if (counter) {
      counter.inEvents += entries.length;
      for (const entry of entries) {
        const b = Buffer.byteLength(JSON.stringify(entry));
        counter.inBytes += b;
        batchBytes += b;
      }
      counter.lastPollTime = formatTime(new Date());
      counter.lastActiveTime = Date.now();
      if (!counter.startTime) counter.startTime = formatTime(new Date());
    }

    for (const entry of entries) {
      if (this.configuredUserId) {
        entry['user.id'] = this.configuredUserId;
      } else if (!entry['user.id'] && this.userId) {
        entry['user.id'] = this.userId;
      }
    }

    // 从关联仓库补写 trace_id/parent_span_id，使 Agent Span 挂到上游 Span；失败时保持原事件继续输出。
    if (this.traceLinker) {
      try {
        await this.traceLinker.stamp(entries);
      } catch (err) {
        logger.warn('trace linker stamp failed (skipped)', { inputId, error: String(err) });
      }
    }

    const policyAppliedEntries = entries.map(entry =>
      applyAgentContentPolicy(entry, this.agentsConfig),
    );

    const maskedEntries = this.maskRules.length === 0
      ? policyAppliedEntries
      : policyAppliedEntries.map(entry =>
          maskAgentActivityEntry(entry, this.maskConfig, this.maskRules),
        );

    logger.info('dispatching entries', { inputId, count: maskedEntries.length });
    await this.dispatchEntries(inputId, maskedEntries, batchBytes);
  }

  /** 记录 Input 已启动时间；已有时间时不覆盖。 */
  markInputStarted(id: string): void {
    const counter = this.counters.get(id);
    if (counter && !counter.startTime) {
      counter.startTime = formatTime(new Date());
    }
  }

  /**
   * 把批次交给 Flusher。未配置输出器时记录丢弃告警；发送异常只更新失败计数和日志，
   * 不重新抛出，从而不打断后续批次。
   */
  private async dispatchEntries(inputId: string, entries: AgentActivityEntry[], batchBytes: number): Promise<void> {
    if (!this.flusher) {
      logger.warn('no flusher set, dropping entries', { count: entries.length });
      this.alarmManager?.record(
        'DISPATCH_DROP_ALARM', '3',
        `dropped ${entries.length} entries from ${inputId}: no flusher`,
        { input_name: inputId },
      );
      return;
    }

    const counter = this.counters.get(inputId);
    try {
      await this.flusher.sendBatch(entries);
      if (counter) counter.outEvents += entries.length;
      this.emit('flushed', { count: entries.length, bytes: batchBytes });
    } catch (err) {
      if (counter) counter.outFailed += entries.length;
      logger.error('dispatch failed', { count: entries.length, error: String(err) });
    }
  }
}
