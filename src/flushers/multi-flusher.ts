/**
 * 多输出并行扇出器。
 *
 * Orchestrator 配置出两个以上后端时使用本类。每个下游 Promise 通过 allSettled 隔离：一个
 * 后端失败会记录日志，但不会阻止其他后端，也通常不会向 InputManager 重新抛出该失败。
 */

import { BaseFlusher } from './base-flusher.js';
import type { AgentActivityEntry } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('MultiFlusher');

/**
 * 将同一事件/批次并行分发给多个 BaseFlusher。
 * 生命周期方法同样扇出，因此每个子通道负责自己的幂等关闭。
 */
export class MultiFlusher extends BaseFlusher {
  readonly name = 'multi';
  private readonly flushers: BaseFlusher[];

  /** @param flushers 已各自完成构造和 start 的下游通道。 */
  constructor(flushers: BaseFlusher[]) {
    super();
    this.flushers = flushers;
  }

  /** 返回内部通道列表，供指标/诊断层定位具体 SLS 等实现。 */
  getFlushers(): BaseFlusher[] {
    return this.flushers;
  }

  /** 并行发送单条事件，并逐个记录 reject；方法自身正常兑现。 */
  async send(entry: AgentActivityEntry): Promise<void> {
    // allSettled 保留与 flushers 相同的索引顺序，便于标出失败通道名。
    const results = await Promise.allSettled(
      this.flushers.map(r => r.send(entry)),
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        const err = (results[i] as PromiseRejectedResult).reason;
        logger.error('flusher send failed', {
          flusher: this.flushers[i].name,
          error: String(err),
        });
      }
    }
  }

  /** 并行发送整个批次，失败隔离语义与 send 相同。 */
  async sendBatch(entries: AgentActivityEntry[]): Promise<void> {
    const results = await Promise.allSettled(
      this.flushers.map(r => r.sendBatch(entries)),
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        const err = (results[i] as PromiseRejectedResult).reason;
        logger.error('flusher sendBatch failed', {
          flusher: this.flushers[i].name,
          error: String(err),
        });
      }
    }
  }

  /** 尽力 flush 全部通道；单个 reject 不阻断其余调用。 */
  async flush(): Promise<void> {
    await Promise.allSettled(this.flushers.map(r => r.flush()));
  }

  /** 并行关闭全部下游；所有 Promise settled 后返回。 */
  async shutdown(): Promise<void> {
    await Promise.allSettled(this.flushers.map(r => r.shutdown()));
  }

  /** 把非标准 payload 原样扇出，默认忽略每个下游失败。 */
  override async sendRaw(topic: string, payload: Record<string, unknown>): Promise<void> {
    await Promise.allSettled(
      this.flushers.map(r => r.sendRaw(topic, payload)),
    );
  }
}
