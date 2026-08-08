/**
 * Qoder API Pipeline 专用 SLS WebTracking 缓冲发送器。
 *
 * 所有管理 API 宽表行共享一个有序 buffer，不按文件分桶；两秒 flush，每波并发最多 8 个
 * 4000 条 batch。发送失败后删除 payload 并保存有界诊断元数据，确定性 event_id 保护重采去重。
 */

import * as os from 'node:os';
import type { PipelineSlsFlusherConfig } from '../../types.js';
import {
  postWebtracking,
  persistFailedLogs,
  type SlsTransportConfig,
} from '../../../flushers/sls-transport.js';
import { LOCAL_IP, buildUserAgent } from '../../../utils/network-utils.js';
import { createLogger } from '../../../utils/logger.js';
import { estimateStringRecordBytes } from '../../../flushers/sls-failure-log-writer.js';

const logger = createLogger('QoderApiSlsSender');

const DEFAULT_FLUSH_INTERVAL_MS = 2000;
const DEFAULT_BATCH_SIZE = 4000;
const MAX_BUFFER_SIZE = 64_000;
const HIGH_WATERMARK = 32_000;
const FLUSH_CONCURRENCY = 8;
const SHUTDOWN_WAIT_TIMEOUT_MS = 30_000;

/** 构造 sender 所需的目标、命名和运行目录。 */
export interface QoderApiSlsSenderOptions {
  /** 目标 SLS endpoint/project/logstore；该 Sender 固定使用 WebTracking。 */
  flusherConfig: PipelineSlsFlusherConfig;
  /** 作为 topic 和日志标签的 pipeline 配置名。 */
  configName: string;
  /** 失败摘要目录；出于数据安全不会在这里保存原始 payload。 */
  failedLogDir: string;
  /** 用于生成带安装版本的 User-Agent。 */
  dataDir: string;
}

/**
 * 持有有界单数组 buffer，并通过公共 SLS transport 发送。
 */
export class QoderApiSlsSender {
  private readonly transportConfig: SlsTransportConfig;
  private readonly configName: string;
  private readonly failedLogDir: string;
  private readonly userAgent: string;
  private readonly hostname: string;
  private buffer: Record<string, string>[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  /**
   * 标准化 endpoint，并缓存请求所需的 User-Agent 与 hostname。
   *
   * @param opts SLS 目标、pipeline 名称和运行目录。
   * 构造阶段不创建 socket，也不启动 timer；`start()` 才接管周期 flush 生命周期。
   */
  constructor(opts: QoderApiSlsSenderOptions) {
    const endpoint = /^https?:\/\//.test(opts.flusherConfig.Endpoint)
      ? opts.flusherConfig.Endpoint
      : `https://${opts.flusherConfig.Endpoint}`;

    this.transportConfig = {
      endpoint,
      project: opts.flusherConfig.Project,
      logstore: opts.flusherConfig.Logstore,
    };
    this.configName = opts.configName;
    this.failedLogDir = opts.failedLogDir;
    this.userAgent = buildUserAgent(opts.dataDir);
    this.hostname = os.hostname();
  }

  /**
   * 幂等启动两秒一次的非保活 flush 定时器。
   *
   * 回调中的 `void` 明确丢弃 Promise；`flush()` 自己用 `flushing` 防重入，但网络失败仍会在其
   * 内部处理。`unref()` 使该定时器不会成为进程无法退出的唯一原因。
   */
  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(
      () => void this.flush(),
      DEFAULT_FLUSH_INTERVAL_MS,
    );
    this.flushTimer.unref();
  }

  /**
   * 把整批宽表记录追加到有序内存 buffer。
   *
   * 当前实现只在“入队前已有数量达到 64k”时拒绝，未预先计算本批加入后的大小，因此一次大批
   * 可能暂时超过该阈值。返回 true 只表示 Sender 接管了对象引用，不代表远端已经成功写入。
   *
   * @returns true 表示已接管，false 表示调用方必须保留窗口并在下轮重采。
   */
  enqueue(rows: Record<string, string>[]): boolean {
    if (this.bufferSize() >= MAX_BUFFER_SIZE) {
      logger.warn('buffer full, rejecting enqueue', {
        configName: this.configName,
        bufferSize: this.bufferSize(),
      });
      return false;
    }
    for (const row of rows) {
      this.buffer.push(row);
    }
    return true;
  }

  /** 32k 高水位提示，当前 Pipeline 主要使用硬上限返回值。 */
  isBackpressured(): boolean {
    return this.bufferSize() >= HIGH_WATERMARK;
  }

  /**
   * 防重入地排空 buffer，每波最多并发发送八个 4000 行 batch。
   *
   * `Promise.allSettled` 等待同一波所有请求结束，使一个 reject 不会让其他请求结果丢失。无论
   * 成功或失败，本波对应的 buffer 前缀随后都会删除；失败只保存有界元数据，不在磁盘保留
   * 可能包含源码/提示词的原始行。任一 batch 失败后停止继续排空，给下一周期留下恢复机会。
   * `finally` 在任何异常路径都清除 `flushing`，避免 Sender 永久锁死。
   */
  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    try {
      while (this.buffer.length > 0) {
        const sliceEnd = Math.min(this.buffer.length, DEFAULT_BATCH_SIZE * FLUSH_CONCURRENCY);
        const tasks: { batch: Record<string, string>[]; startIdx: number }[] = [];
        for (let offset = 0; offset < sliceEnd; offset += DEFAULT_BATCH_SIZE) {
          const end = Math.min(offset + DEFAULT_BATCH_SIZE, sliceEnd);
          tasks.push({ batch: this.buffer.slice(offset, end), startIdx: offset });
        }

        const results = await Promise.allSettled(
          tasks.map((t) =>
            postWebtracking(this.transportConfig, t.batch, {
              topic: this.configName,
              source: this.hostname,
              tags: {
                __hostname__: this.hostname,
                pipeline_type: 'qoder-api',
              },
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

        // 失败 payload 不在本地保留；失败日志仅含有界元数据，event_id 保护可能的重采去重。
        this.buffer.splice(0, sliceEnd);
        if (hasFailure) break;

        if (sentCount > 0) {
          logger.debug('flush batch sent', {
            configName: this.configName,
            count: sentCount,
            remaining: this.bufferSize(),
          });
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * 清理 timer、限时等待在途 flush，并尝试排空剩余记录。
   *
   * 等待采用 100ms 异步轮询，不阻塞事件循环；30 秒上限防止服务停止永久挂住。之后最多调用
   * `flush()` 三轮。仍未发送的数据从内存删除，只落数量、字节数和错误原因，随后 Promise 才
   * 完成，因此 Pipeline 可以把它作为资源关闭屏障。
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // 最多等待 30 秒在途 flush，避免停止过程永久卡住。
    const waitStart = Date.now();
    while (this.flushing && Date.now() - waitStart < SHUTDOWN_WAIT_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.flushing) {
      logger.warn('shutdown: flush still in progress after timeout, skipping drain retries', {
        configName: this.configName,
        timeoutMs: SHUTDOWN_WAIT_TIMEOUT_MS,
      });
    }

    // 在途任务已完成时最多重试三轮排空。
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts && this.bufferSize() > 0; attempt++) {
      await this.flush();
    }

    // 最终余量从内存删除，只持久化数量/字节/错误摘要。
    if (this.bufferSize() > 0) {
      const remaining = this.buffer.splice(0);
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

  /** 返回 O(1) 当前缓冲行数。 */
  bufferSize(): number {
    return this.buffer.length;
  }
}
