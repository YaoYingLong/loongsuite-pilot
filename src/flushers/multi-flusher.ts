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
 *
 * 本类不复制 entry，所有下游收到同一只读对象引用；因此 Flusher 实现不得原地修改事件。
 * send/sendBatch/flush/shutdown 都使用 allSettled，把某个后端失败限制在该后端。代价是调用方无法
 * 通过 Promise rejection 得知部分输出丢失，只能依赖这里的日志和各 Flusher 指标。
 */
export class MultiFlusher extends BaseFlusher {
  readonly name = 'multi';
  private readonly flushers: BaseFlusher[];

  /**
   * @param flushers 已各自完成构造和 start 的下游通道；本类不代替它们执行 start。
   */
  constructor(flushers: BaseFlusher[]) {
    super();
    this.flushers = flushers;
  }

  /**
   * 返回内部通道数组，供指标/诊断层定位具体实现。
   * 当前返回真实数组而非副本，调用方应只读；push/splice 会直接改变后续扇出目标。
   */
  getFlushers(): BaseFlusher[] {
    return this.flushers;
  }

  /**
   * 并行发送单条事件，等待所有通道 settle，再逐个记录 reject。
   * `Promise.allSettled` 结果与输入 Promise 保持索引对应，便于准确输出失败 Flusher 名称；即使全部
   * 通道失败，本方法也正常兑现。
   */
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

  /**
   * 并行尽力 flush 全部通道；单个 reject 不阻断其余调用，也不会在本层记录具体原因。
   * 失败诊断依赖各子 Flusher 自身实现。
   */
  async flush(): Promise<void> {
    await Promise.allSettled(this.flushers.map(r => r.flush()));
  }

  /**
   * 并行关闭全部下游；所有 Promise settled 后返回。
   * 关闭 rejection 被吞掉，因此 Orchestrator 能继续退出，但不能把正常返回理解为所有缓冲均送达。
   */
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
