/**
 * 自定义 HTTP JSON 批量输出通道。
 *
 * send/sendBatch 只把字符串化事件加入内存 buffer；条数阈值或周期定时器触发 POST。请求失败
 * 时整批放回队首等待下次重试。该缓冲不落盘，进程被强杀仍可能丢失未发送事件。
 */

// axios 提供 Promise 化 POST、请求头和超时控制。
import axios from 'axios';
import { BaseFlusher } from './base-flusher.js';
import { serialiseLogEntry } from '../normalization/entry-builder.js';
import type { AgentActivityEntry, HttpFlusherConfig } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('HttpFlusher');

/**
 * 带周期 flush 和失败回队的 HTTP Flusher。
 *
 * buffer 只存在内存。每次 flush 用 `splice(0)` 把当时批次与新到数据隔离，网络失败再 unshift
 * 回队首。类中没有 `flushing` 互斥标志，timer 与阈值触发可能并发发送不同快照；多个失败批次
 * 回队时的全局顺序取决于请求完成顺序。
 */
export class HttpFlusher extends BaseFlusher {
  readonly name = 'http';
  private readonly config: HttpFlusherConfig;
  /** 尚未发送的字符串宽表事件，按抵达顺序排列。 */
  private buffer: Record<string, string>[] = [];
  /** start 创建、shutdown 清理的事件循环定时器句柄。 */
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param config URL、headers、批量阈值、周期和请求超时；构造阶段不启动 timer 或发请求。
   */
  constructor(config: HttpFlusherConfig) {
    super();
    this.config = config;
  }

  /**
   * 启动周期 flush；回调使用 `void` 丢弃 Promise。
   * 当前方法没有幂等检查，生命周期管理方必须只调用一次 start，否则旧 timer 句柄会丢失且无法
   * 全部清理。timer 未 unref，是需要 shutdown 释放的保活资源。
   */
  async start(): Promise<void> {
    // 开启一个周期性定时器：每隔 ms 毫秒，持续执行回调函数。
    this.flushTimer = setInterval(
      () => void this.flush(),
      this.config.flushIntervalMs,
    );
  }

  /**
   * 把标准事件序列化为字符串宽表并入队；达到阈值时 await 本次 flush。
   * await 只等待该 flush 的 HTTP 请求结束；请求失败在 flush 内被捕获并回队，因此 send 仍正常
   * 兑现，不表示远端写入成功。
   */
  async send(entry: AgentActivityEntry): Promise<void> {
    // 序列化：过滤部分字段，如果是字符串直接返回，如果是对象，直接转换成json字符串
    const serialized = serialiseLogEntry(entry);
    // 将数据添加到缓存数组中
    this.buffer.push(serialized);

    if (this.buffer.length >= this.config.batchMaxSize) {
      // 如果缓存长度大于batchMaxSize直接执行导出
      await this.flush();
    }
  }

  /** 保持输入顺序批量入队，达到阈值时触发一次请求。 */
  async sendBatch(entries: AgentActivityEntry[]): Promise<void> {
    for (const entry of entries) {
      this.buffer.push(serialiseLogEntry(entry));
    }
    if (this.buffer.length >= this.config.batchMaxSize) {
      await this.flush();
    }
  }

  /**
   * 取走当前 buffer 并 POST `{entries: batch}`。
   * 新事件可在 await 网络期间继续进入新 buffer；失败批次用 unshift 回到它们之前。
   *
   * axios 的 timeout、网络和非 2xx 默认都会 reject。catch 不再抛出，使 timer 不产生未处理
   * rejection，也让 InputManager 继续处理后续事件。没有最大重试次数或内存上限；远端长期故障
   * 时 buffer 会持续增长。
   */
  async flush(): Promise<void> {
    // 如果没有数据直接结束
    if (this.buffer.length === 0) return;

    // splice(0)表示从下标 0 开始，删除数组所有元素 返回值：被删除的元素组成的新数组
    const batch = this.buffer.splice(0);
    try {
      // 使用 axios 发起一次 POST HTTP 请求，把批量数据 batch 推送到远端接口地址 this.config.url
      await axios.post(this.config.url, { entries: batch }, {
        headers: {
          'Content-Type': 'application/json',
          ...this.config.headers,
        },
        timeout: this.config.requestTimeoutMs,
      });
      logger.debug('batch sent', { count: batch.length });
    } catch (err) {
      logger.error('batch send failed, re-queuing', {
        count: batch.length,
        error: String(err),
      });
      this.buffer.unshift(...batch);
    }
  }

  /**
   * 停止周期任务并最后尝试提交一次剩余事件。
   * flush 失败会把批次留在内存但不 reject，所以 shutdown 仍返回；对象随后被释放时这些记录丢失。
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  /**
   * 立即 POST 非标准 topic payload；失败只告警，不加入标准事件重试 buffer。
   * payload 展开在 topic 之后，因此 payload 中同名 `topic` 字段会覆盖方法参数，当前行为待确认。
   */
  override async sendRaw(topic: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await axios.post(this.config.url, { topic, ...payload }, {
        headers: {
          'Content-Type': 'application/json',
          ...this.config.headers,
        },
        timeout: this.config.requestTimeoutMs,
      });
    } catch (err) {
      logger.warn('sendRaw failed', { topic, error: String(err) });
    }
  }
}
