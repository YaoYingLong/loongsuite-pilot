/**
 * 普通文件 Pipeline 专用的 SLS WebTracking 缓冲发送器。
 *
 * 日志按源 filePath 分 bucket，以便写 `__path__` tag；每轮最多并发 8 个 4000 条 batch。
 * 64k 硬上限拒绝 enqueue，32k 高水位通知读取端减速。最终失败只落有界元数据，不保留 payload。
 */

import type { PipelineSlsFlusherConfig } from '../../types.js';
import {
  postWebtracking,
  persistFailedLogs,
  type SlsTransportConfig,
} from '../../../flushers/sls-transport.js';
import { createLogger } from '../../../utils/logger.js';
import { LOCAL_IP, buildUserAgent } from '../../../utils/network-utils.js';
import { estimateStringRecordBytes } from '../../../flushers/sls-failure-log-writer.js';

const logger = createLogger('FileSlsSender');

/** 文件发送缓冲、并发和关闭等待的保护值。 */
const DEFAULT_FLUSH_INTERVAL_MS = 2000;
const DEFAULT_BATCH_SIZE = 4000;
const MAX_BUFFER_SIZE = 64_000;
const HIGH_WATERMARK = 32_000;
const FLUSH_CONCURRENCY = 8;
const SHUTDOWN_WAIT_TIMEOUT_MS = 30_000;

/**
 * 按源文件分桶并发送原始行。
 *
 * Map 的 key 是源路径，保证同一请求波次能写入正确的 `__path__` tag；每个 bucket 保留原始
 * 行顺序。Sender 不拥有 checkpoint，是否在拒收时继续推进由 FilePipeline 决定。
 */
export class FileSlsSender {
  private readonly transportConfig: SlsTransportConfig;
  private readonly failedLogDir: string;
  private readonly configName: string;
  private buckets: Map<string, Record<string, string>[]> = new Map();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private readonly flushIntervalMs: number;
  private readonly batchSize: number;
  private readonly userAgent: string;

  /**
   * 标准化 SLS 目标并保存运行参数；构造阶段不启动 timer 或网络请求。
   *
   * @param flusherConfig 目标 SLS 配置。
   * @param configName Pipeline 名，同时作为 topic/失败日志 endpoint 名。
   * @param failedLogDir 有界失败诊断目录。
   * @param dataDir 用于构造版本 User-Agent。
   */
  constructor(
    flusherConfig: PipelineSlsFlusherConfig,
    configName: string,
    failedLogDir: string,
    dataDir: string,
  ) {
    // 允许配置省略协议，缺省按 HTTPS 处理。
    const endpoint = /^https?:\/\//.test(flusherConfig.Endpoint)
      ? flusherConfig.Endpoint
      : `https://${flusherConfig.Endpoint}`;

    this.transportConfig = {
      endpoint,
      project: flusherConfig.Project,
      logstore: flusherConfig.Logstore,
    };
    this.configName = configName;
    this.failedLogDir = failedLogDir;
    this.flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS;
    this.batchSize = DEFAULT_BATCH_SIZE;
    this.userAgent = buildUserAgent(dataDir);
  }

  /**
   * 幂等启动两秒周期 flush。
   *
   * timer 未调用 `unref()`，所以它是服务保活资源；FilePipeline.stop() 必须调用 shutdown 清理。
   * 回调不 await Promise，重叠触发由 `flushing` 标志直接拒绝。
   */
  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(
      () => void this.flush(),
      this.flushIntervalMs,
    );
  }

  /**
   * 将文本行包装为 `{content}` 后加入对应 filePath bucket。
   *
   * 当前硬上限判断发生在加入本批之前；如果 buffer 尚未到 64k，一次很大的 `lines` 仍可能让
   * 它短暂超过阈值。方法保存的是新 `{content}` 对象，不直接持有调用方字符串数组。
   *
   * @returns 入队前已达到 64k 时为 false；调用方必须缓存本批并停止继续读该文件。
   */
  enqueue(lines: string[], filePath: string): boolean {
    if (this.bufferSize() >= MAX_BUFFER_SIZE) {
      logger.warn('buffer full, rejecting enqueue', {
        configName: this.configName,
        bufferSize: this.bufferSize(),
      });
      return false;
    }

    let bucket = this.buckets.get(filePath);
    if (!bucket) {
      bucket = [];
      this.buckets.set(filePath, bucket);
    }
    for (const line of lines) {
      bucket.push({ content: line });
    }
    return true;
  }

  /** 达到高水位时提示 FilePipeline 暂停继续读取。 */
  isBackpressured(): boolean {
    return this.bufferSize() >= HIGH_WATERMARK;
  }

  /**
   * 按 bucket 顺序处理，每波并行最多八个 batch；重入调用直接返回。
   *
   * 不同 filePath bucket 串行，单 bucket 内用 `Promise.allSettled` 并发。这样 `__path__` 不会
   * 混批，同时某个请求 reject 不会掩盖同波其他请求的结果。不论成功失败，本波记录都会从
   * 内存删除；失败仅持久化有界诊断元数据，不提供 payload 重放。finally 保证解除 flush 门。
   */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const [filePath, bucket] of this.buckets) {
        let failed = false;
        while (bucket.length > 0 && !failed) {
          const sliceEnd = Math.min(bucket.length, this.batchSize * FLUSH_CONCURRENCY);
          const tasks: { batch: Record<string, string>[]; startIdx: number }[] = [];
          for (let offset = 0; offset < sliceEnd; offset += this.batchSize) {
            const end = Math.min(offset + this.batchSize, sliceEnd);
            tasks.push({ batch: bucket.slice(offset, end), startIdx: offset });
          }

          const results = await Promise.allSettled(
            tasks.map((t) =>
              postWebtracking(this.transportConfig, t.batch, {
                topic: this.configName,
                source: LOCAL_IP,
                tags: { __path__: filePath },
                userAgent: this.userAgent,
              }).then(() => ({ ok: true as const })),
            ),
          );

          let sentCount = 0;
          let hasFailure = false;
          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.status === 'fulfilled' && r.value.ok) {
              sentCount += tasks[i].batch.length;
            } else {
              hasFailure = true;
              const err = r.status === 'rejected' ? r.reason : 'unknown';
              logger.error('flush failed, persisting to failed log', {
                configName: this.configName,
                filePath,
                count: tasks[i].batch.length,
                error: String(err),
              });
              await persistFailedLogs(
                this.failedLogDir,
                this.configName,
                {
                  mode: 'webtracking',
                  project: this.transportConfig.project,
                  logstore: this.transportConfig.logstore,
                  kind: this.configName,
                  batchCount: tasks[i].batch.length,
                  batchBytes: estimateStringRecordBytes(tasks[i].batch),
                },
                err,
              );
            }
          }

          // 不论成功失败都从内存删除本波；失败 payload 不做本地重放。
          bucket.splice(0, sliceEnd);
          if (hasFailure) failed = true;

          if (sentCount > 0) {
            logger.debug('flush batch sent', {
              configName: this.configName,
              filePath,
              count: sentCount,
              remaining: this.bufferSize(),
            });
          }
        }
        if (bucket.length === 0) this.buckets.delete(filePath);
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * 清 timer、限时等待正在发送的波次、重试排空，最终余量只写失败元数据。
   *
   * 100ms 等待是异步定时 Promise，不阻塞事件循环；30 秒后即使在途请求仍未返回也继续关闭，
   * 这是“进程可停止”优先于无限等待。最多三轮 drain 后，残余 payload 从内存清除。
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // 最多等待 30 秒，不让进程关闭永久卡在网络调用。
    const waitStart = Date.now();
    while (this.flushing && Date.now() - waitStart < SHUTDOWN_WAIT_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.flushing) {
      logger.warn('shutdown: flush still in progress after timeout, proceeding', {
        configName: this.configName,
        timeoutMs: SHUTDOWN_WAIT_TIMEOUT_MS,
      });
    }
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts && this.bufferSize() > 0; attempt++) {
      await this.flush();
    }
    if (this.bufferSize() > 0) {
      const remaining: Record<string, string>[] = [];
      for (const [, bucket] of this.buckets) {
        remaining.push(...bucket);
      }
      this.buckets.clear();
      logger.warn('shutdown: buffer not fully drained, persisting remaining', {
        configName: this.configName,
        remaining: remaining.length,
      });
      await persistFailedLogs(
        this.failedLogDir,
        this.configName,
        {
          mode: 'webtracking',
          project: this.transportConfig.project,
          logstore: this.transportConfig.logstore,
          kind: this.configName,
          batchCount: remaining.length,
          batchBytes: estimateStringRecordBytes(remaining),
        },
        new Error('shutdown drain incomplete'),
      );
    }
  }

  /** O(bucket 数) 统计当前内存行数，供 backpressure 和诊断使用。 */
  bufferSize(): number {
    let size = 0;
    for (const [, bucket] of this.buckets) {
      size += bucket.length;
    }
    return size;
  }
}
