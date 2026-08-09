/**
 * 主事件流的阿里云 SLS 批量输出通道。
 *
 * 每条标准事件按 endpoint、project、logstore（以及需要时的 agentType）分桶；定时器或条数
 * 阈值触发 flush。每个 endpoint 可独立选择 AK SDK 或 WebTracking，失败经过指数重试后只把
 * 有界诊断元数据写入本地，不持久化原 payload/凭据，也不阻断其他 endpoint。
 */

import ALY from '@alicloud/log';
import * as os from 'node:os';
import { BaseFlusher } from './base-flusher.js';
import {
  serialiseLogEntry,
  redactCodeGenerationFields,
} from '../normalization/entry-builder.js';
import type { AgentActivityEntry, SlsFlusherConfig, SlsEndpoint } from '../types/index.js';
import type { AlarmManager } from '../metrics/alarm-manager.js';
import { createLogger } from '../utils/logger.js';
import { formatTime } from '../utils/time-utils.js';
import { normalizeAgentType } from '../utils/agent-type-normalize.js';
import { LOCAL_IP, buildUserAgent } from '../utils/network-utils.js';
import * as path from 'node:path';
import { SlsFailureLogWriter } from './sls-failure-log-writer.js';
import {
  HttpError,
  postWebtracking,
  isRetryable,
  RETRY_MAX_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  WEBTRACKING_TIMEOUT_MS,
  WEBTRACKING_MAX_BODY_BYTES,
  WEBTRACKING_MAX_LOGS,
  RETRYABLE_STATUS_CODES,
} from './sls-transport.js';

/** 进程启动时固定的主机名，作为 SLS tag。 */
const HOSTNAME = os.hostname();

const BATCH_MAX_SIZE = 20;
const FLUSH_INTERVAL_MS = 2000;

/** 队列中的单条日志同时保留目标、Agent 类型和估算字节数。 */
interface QueuedLog {
  /** 已过滤并字符串化的 SLS 宽表。 */
  content: Record<string, string>;
  /** 该副本的目标配置；send 会为每个 endpoint 各入队一次。 */
  endpoint: SlsEndpoint;
  /** 规范化 Agent 类型，用于可选 service name 分桶。 */
  agentType?: string;
  /** content JSON 的 UTF-8 估算字节数，供指标和失败摘要使用。 */
  byteSize: number;
}

const logger = createLogger('SlsFlusher');

/** MetricsWriter 读取的每 endpoint 累计统计。 */
export interface EndpointCounter {
  /** 进入该 endpoint 队列的累计条数/估算字节数。 */
  inEntries: number;
  inBytes: number;
  /** flush Promise 正常完成后累计的条数；当前不严格等同远端成功 ACK，见 flush 注释。 */
  outEntries: number;
  /** flush Promise reject 时累计条数。 */
  outFailed: number;
  totalDelayMs: number;
  lastFlushTime: string;
  startTime: string;
  mode: string;
  endpoint: string;
  project: string;
  logstore: string;
}

/**
 * 同时支持多个 SLS endpoint 和 AK/WebTracking 两种传输模式的 Flusher。
 *
 * send 只做同步序列化和内存入队；flush 把当前 Map 快照与新数据隔离，再按 bucket 并发。不同
 * endpoint 的失败互不阻断。最终失败不回队、不保存 payload，只写经清洗的有界元数据并触发
 * AlarmManager，因此输出语义是 best-effort 而非持久可靠队列。
 */
export class SlsFlusher extends BaseFlusher {
  readonly name = 'sls';
  private readonly config: SlsFlusherConfig;
  /** 分桶 key 到有序待发送日志；flush 时整体交换并清空。 */
  private readonly queue: Map<string, QueuedLog[]> = new Map();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly failedLogWriter: SlsFailureLogWriter;
  /** AK Client 按 endpoint 名惰性缓存，shutdown 时无需显式关闭。 */
  private readonly akClients: Map<string, any> = new Map();
  private readonly endpointCounters: Map<string, EndpointCounter> = new Map();
  private alarmManager: AlarmManager | null = null;

  private readonly serviceName: string;
  private readonly userAgent: string;

  /**
   * 保存配置、创建失败诊断 writer，并为每个 endpoint 初始化累计计数器。
   * 构造阶段不创建 SDK Client、目录、timer 或网络连接；AK Client 在第一次发送时惰性创建。
   *
   * @param config ConfigLoader 合并后的全部 SLS endpoints 和批量参数。
   * @param dataDir 失败诊断目录及安装版本 User-Agent 的数据根。
   */
  constructor(config: SlsFlusherConfig, dataDir: string) {
    super();
    this.config = config;
    this.failedLogWriter = new SlsFailureLogWriter(
      path.join(dataDir, 'logs', 'sls-failed-logs'),
    );
    this.serviceName = config.serviceNamePrefix || '';
    this.userAgent = buildUserAgent(dataDir);
    // 为每个 endpoint 预建稳定计数器，便于无流量时也能展示状态。
    for (const ep of config.endpoints) {
      this.endpointCounters.set(ep.name, {
        inEntries: 0, inBytes: 0, outEntries: 0, outFailed: 0,
        totalDelayMs: 0, lastFlushTime: '', startTime: '',
        mode: ep.mode, endpoint: ep.endpoint, project: ep.project, logstore: ep.logstore,
      });
    }
  }

  /** 暴露计数器 Map 给 MetricsCollector；调用方只读但返回的是实时对象。 */
  getEndpointCounters(): Map<string, EndpointCounter> {
    return this.endpointCounters;
  }

  /** Orchestrator 后置注入告警管理器，避免输出层构造循环依赖。 */
  setAlarmManager(alarmManager: AlarmManager): void {
    this.alarmManager = alarmManager;
  }

  /**
   * 按 endpoint 名惰性创建并复用 SLS AK SDK Client。
   * accessKey 只传给 SDK，不进入本类日志；若两个配置误用同名 endpoint，后创建配置会复用第一
   * 个 Client，因此 endpoint name 在配置中必须唯一。
   */
  private getAkClient(endpoint: SlsEndpoint): any {
    let client = this.akClients.get(endpoint.name);
    if (!client) {
      client = new ALY({
        accessKeyId: endpoint.accessKeyId ?? '',
        accessKeySecret: endpoint.accessKeySecret ?? '',
        endpoint: endpoint.endpoint,
        userAgent: this.userAgent,
      } as any);
      this.akClients.set(endpoint.name, client);
    }
    return client;
  }

  /**
   * 尽力初始化失败日志目录并启动周期 flush timer。
   * 当前方法没有重复 start 防护，生命周期层必须只调用一次；timer 未 unref，shutdown 必须清理。
   */
  async start(): Promise<void> {
    await this.failedLogWriter.start();
    this.flushTimer = setInterval(
      () => void this.flush(),
      this.config.flushIntervalMs || FLUSH_INTERVAL_MS,
    );
  }

  /**
   * 序列化单条事件，并为每个配置 endpoint 各入队一份。
   *
   * Agent 私有命名空间在宽表序列化时统一丢弃。未启用 legacy redact 的 endpoint 共享同一个
   * serialized 对象引用，但后续发送路径只读取它；启用 redact 时获得独立裁剪副本。
   */
  async send(entry: AgentActivityEntry): Promise<void> {
    const serialized = serialiseLogEntry(entry, { dropAgentScopedFields: true });
    const agentType = normalizeAgentType(String(entry['gen_ai.agent.type'] ?? 'unknown'));

    for (const endpoint of this.config.endpoints) {
      // endpoint.redact 是旧 CodeGeneration 兼容裁剪，不替代全局 mask。
      const content = endpoint.redact
        ? redactCodeGenerationFields(serialized)
        : serialized;
      this.enqueue(endpoint, content, agentType);
    }
  }

  /** 逐条调用 send，保持每个 endpoint bucket 内的输入顺序。 */
  async sendBatch(entries: AgentActivityEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.send(entry);
    }
  }

  /**
   * 原子取走当前所有 bucket，并行发送各 bucket。
   * 发送期间新事件进入新的 queue；单 bucket 失败被 catch 并计数，不 reject 整体 flush。
   *
   * 这里的“原子”指同一 JavaScript 事件循环 turn 内先复制 Map entries 再 clear，中间没有 await；
   * 新 send 随后会进入空 Map。类没有全局 `flushing` 门，多个 flush 可以并发，但各自持有互不
   * 重叠的快照。
   *
   * 注意 `flushViaAk/postWebtracking` 在最终发送失败后会自行记录告警/失败摘要并正常返回，所以
   * 外层 then 当前仍增加 `outEntries`；`outFailed` 只统计真正 reject 的意外异常，并不严格代表
   * SLS 远端失败数。该指标口径是否符合监控预期待确认。
   */
  async flush(): Promise<void> {
    const batches = Array.from(this.queue.entries());
    this.queue.clear();

    if (batches.length > 0) {
      logger.debug('flush dispatching', {
        buckets: batches.length,
        totalLogs: batches.reduce((sum, [, logs]) => sum + logs.length, 0),
      });
    }

    const tasks = batches
      .filter(([, logs]) => logs.length > 0)
      .map(([, logs]) => {
        const endpoint = logs[0].endpoint;
        const counter = this.endpointCounters.get(endpoint.name);
        const startMs = Date.now();
        const send = endpoint.mode === 'ak'
          ? this.flushViaAk(endpoint, logs)
          : this.flushViaWebtracking(endpoint, logs);
        return send.then(() => {
          if (counter) {
            counter.outEntries += logs.length;
            counter.totalDelayMs += Date.now() - startMs;
            counter.lastFlushTime = formatTime(new Date());
          }
        }).catch(err => {
          if (counter) {
            counter.outFailed += logs.length;
            counter.totalDelayMs += Date.now() - startMs;
          }
          logger.error('SLS endpoint flush failed', {
            endpoint: endpoint.name,
            error: String(err),
          });
        });
      });
    await Promise.all(tasks);
  }

  /** 托管 endpoint 可覆盖用户共享 serviceName 前缀。 */
  private effectiveServiceName(endpoint?: SlsEndpoint): string {
    return endpoint?.serviceName || this.serviceName;
  }

  /** 组合最终 `<prefix>-<agentType>`，前缀为空时不写 service tag。 */
  private resolveServiceName(endpoint?: SlsEndpoint, agentType?: string): string {
    const base = this.effectiveServiceName(endpoint);
    if (!base) return '';
    return agentType ? `${base}-${agentType}` : base;
  }

  /** AK SDK 要求 tags 为单键对象数组。 */
  private buildAkTags(endpoint: SlsEndpoint, agentType?: string): Record<string, string>[] {
    const tags: Record<string, string>[] = [{ __hostname__: HOSTNAME }];
    const sn = this.resolveServiceName(endpoint, agentType);
    if (sn) tags.push({ __service_name__: sn });
    return tags;
  }

  /** WebTracking body 使用普通键值对象承载 tags。 */
  private buildWebtrackingTags(endpoint: SlsEndpoint, agentType?: string): Record<string, string> {
    const tags: Record<string, string> = { __hostname__: HOSTNAME };
    const sn = this.resolveServiceName(endpoint, agentType);
    if (sn) tags['__service_name__'] = sn;
    return tags;
  }

  /** service name 含 Agent 时检查 bucket 是否意外混入多个类型。 */
  private warnIfMixedAgentTypes(logs: QueuedLog[]): void {
    if (this.effectiveServiceName(logs[0]?.endpoint)) {
      const types = new Set(logs.map(l => l.agentType));
      if (types.size > 1) logger.warn('mixed agentTypes in batch', { types: [...types] });
    }
  }

  /**
   * 通过官方 AK SDK 发送一个 bucket，执行有限指数退避和告警。
   *
   * 同一 bucket 共用调用时刻的秒级 timestamp。SDK reject 后按错误分类重试；最终失败会记录
   * Alarm 和有界元数据，但不重新 throw，因此该方法的 Promise 随后正常兑现。
   */
  private async flushViaAk(endpoint: SlsEndpoint, logs: QueuedLog[]): Promise<void> {
    this.warnIfMixedAgentTypes(logs);
    const now = Math.floor(Date.now() / 1000);
    const agentType = logs[0]?.agentType;
    const logGroup = {
      logs: logs.map(l => ({
        timestamp: now,
        content: l.content,
      })),
      source: LOCAL_IP,
      topic: endpoint.kind,
      tags: this.buildAkTags(endpoint, agentType),
    };

    const client = this.getAkClient(endpoint);
    let lastErr: unknown;
    for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        await client.postLogStoreLogs(
          endpoint.project,
          endpoint.logstore,
          logGroup,
        );
        logger.debug('batch sent via ak', {
          endpoint: endpoint.name,
          project: endpoint.project,
          logstore: endpoint.logstore,
          count: logs.length,
        });
        return;
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === RETRY_MAX_ATTEMPTS - 1) break;
        // 退避序列为 base、2*base、4*base，不阻塞事件循环。
        const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
        logger.warn('SLS ak send retrying', {
          endpoint: endpoint.name,
          attempt: attempt + 1,
          delayMs: delay,
          error: String(err),
        });
        await this.sleep(delay);
      }
    }

    logger.error('SLS send failed after retries', {
      endpoint: endpoint.name,
      error: String(lastErr),
    });
    this.alarmManager?.record(
      'FLUSH_SEND_ALARM', '2',
      `SLS ak send failed: ${String(lastErr)}`,
      { endpoint_name: endpoint.name },
    );
    if (lastErr instanceof HttpError && lastErr.status === 429) {
      this.alarmManager?.record(
        'FLUSH_QUOTA_ALARM', '2',
        `SLS endpoint throttled (429)`,
        { endpoint_name: endpoint.name },
      );
    }
    // 最终失败只落有界元数据，原始 batch 不写磁盘。
    await this.persistFailedLogs(
      endpoint,
      logs.length,
      logs.reduce((sum, log) => sum + log.byteSize, 0),
      lastErr,
    );
  }

  /**
   * 先按 WebTracking 服务限制拆 chunk，再按原顺序逐个发送。
   * `postWebtracking()` 最终失败会完成本地诊断后正常返回，所以后续 chunk 仍会继续尝试。
   */
  private async flushViaWebtracking(endpoint: SlsEndpoint, logs: QueuedLog[]): Promise<void> {
    const chunks = this.splitForWebtracking(logs);
    for (const chunk of chunks) {
      await this.postWebtracking(endpoint, chunk);
    }
  }

  /** 保持顺序按最大日志数和估算请求体字节数拆分。 */
  private splitForWebtracking(logs: QueuedLog[]): QueuedLog[][] {
    const chunks: QueuedLog[][] = [];
    let current: QueuedLog[] = [];
    let currentSize = 0;

    for (const log of logs) {
      const logSize = Buffer.byteLength(JSON.stringify(log.content));

      if (current.length > 0 &&
          (current.length >= WEBTRACKING_MAX_LOGS ||
           currentSize + logSize > WEBTRACKING_MAX_BODY_BYTES)) {
        chunks.push(current);
        current = [];
        currentSize = 0;
      }

      current.push(log);
      currentSize += logSize;
    }

    if (current.length > 0) {
      chunks.push(current);
    }
    return chunks;
  }

  /**
   * 构造 WebTracking body，通过 fetch 发送并执行有限重试。
   *
   * body 在循环前序列化一次；每次 attempt 创建新的 AbortSignal。不可重试 4xx 立即退出，
   * 408/429/5xx 和网络异常执行指数退避。最终失败触发告警并写失败摘要，但不向 flush 重新抛出。
   */
  private async postWebtracking(endpoint: SlsEndpoint, logs: QueuedLog[]): Promise<void> {
    this.warnIfMixedAgentTypes(logs);
    const agentType = logs[0]?.agentType;
    const body = {
      __topic__: endpoint.kind ?? '',
      __source__: LOCAL_IP,
      __logs__: logs.map(l => l.content),
      __tags__: this.buildWebtrackingTags(endpoint, agentType),
    };

    const raw = JSON.stringify(body);
    // 有 project 时将它插入 endpoint host，符合 SLS WebTracking URL 规则。
    const base = endpoint.project
      ? endpoint.endpoint.replace(/^(https?:\/\/)/, `$1${endpoint.project}.`)
      : endpoint.endpoint;
    const url = `${base}/logstores/${endpoint.logstore}/track`;

    let lastErr: unknown;
    for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'x-log-apiversion': '0.6.0',
            'x-log-bodyrawsize': String(Buffer.byteLength(raw)),
            'Content-Type': 'application/json',
            'user-agent': this.userAgent,
          },
          body: raw,
          signal: AbortSignal.timeout(WEBTRACKING_TIMEOUT_MS),
        });

        if (!resp.ok) {
          const text = await resp.text();
          const err = new HttpError(resp.status, text);
          if (!RETRYABLE_STATUS_CODES.has(resp.status) || attempt === RETRY_MAX_ATTEMPTS - 1) {
            throw err;
          }
          lastErr = err;
        } else {
          logger.debug('batch sent via webtracking', {
            project: endpoint.project,
            logstore: endpoint.logstore,
            count: logs.length,
          });
          return;
        }
      } catch (err) {
        lastErr = err;
        if (err instanceof HttpError && !RETRYABLE_STATUS_CODES.has(err.status)) break;
        if (attempt === RETRY_MAX_ATTEMPTS - 1) break;
      }

      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
      logger.warn('SLS webtracking retrying', {
        endpoint: endpoint.name,
        attempt: attempt + 1,
        delayMs: delay,
        error: String(lastErr),
      });
      await this.sleep(delay);
    }

    logger.error('SLS webtracking send failed after retries', {
      endpoint: endpoint.name,
      error: String(lastErr),
    });
    this.alarmManager?.record(
      'FLUSH_SEND_ALARM', '2',
      `SLS webtracking send failed: ${String(lastErr)}`,
      { endpoint_name: endpoint.name },
    );
    if (lastErr instanceof HttpError && lastErr.status === 429) {
      this.alarmManager?.record(
        'FLUSH_QUOTA_ALARM', '2',
        `SLS endpoint throttled (429)`,
        { endpoint_name: endpoint.name },
      );
    }
    await this.persistFailedLogs(endpoint, logs.length, Buffer.byteLength(raw), lastErr);
  }

  /** 委托 SlsFailureLogWriter 保存不含 payload 的失败摘要。 */
  private async persistFailedLogs(
    endpoint: SlsEndpoint,
    batchCount: number,
    batchBytes: number,
    err: unknown,
  ): Promise<void> {
    await this.failedLogWriter.write({
      endpoint: endpoint.name,
      mode: endpoint.mode,
      project: endpoint.project,
      logstore: endpoint.logstore,
      kind: endpoint.kind,
      batchCount,
      batchBytes,
      error: err,
    });
  }

  /**
   * 清理 timer，并提交调用时仍在 queue 中的记录。
   *
   * 当前没有保存此前已启动 flush 的 Promise；若 shutdown 与一个旧的阈值/timer flush 重叠，
   * 本方法只等待自己取得的快照，旧 flush 仍独立在途。SDK Client 无显式 close API。
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  /**
   * 把非标准 payload 作为单条日志直接发送到 kind 为 mcp/trace 的 endpoint。
   *
   * 对象值 JSON.stringify 后写入；undefined 等不可序列化值的具体结果由 JSON.stringify 决定。
   * endpoint 串行发送，单个失败被 catch 且不保存失败摘要，也不阻断后续 endpoint。
   */
  override async sendRaw(topic: string, payload: Record<string, unknown>): Promise<void> {
    // SLS content 只接受字符串值；字符串原样保留，结构化值统一 JSON 序列化。
    const content: Record<string, string> = { topic };
    for (const [k, v] of Object.entries(payload)) {
      content[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }

    // 同一 raw payload 会扇出到所有 mcp/trace endpoint；普通 agent endpoint 由 send() 路径处理。
    for (const endpoint of this.config.endpoints) {
      if (endpoint.kind !== 'mcp' && endpoint.kind !== 'trace') continue;
      try {
        if (endpoint.mode === 'ak') {
          // AK 模式复用缓存 SDK Client，并携带 endpoint 配置生成的 tags。
          const client = this.getAkClient(endpoint);
          await client.postLogStoreLogs(endpoint.project, endpoint.logstore, {
            logs: [{ timestamp: Math.floor(Date.now() / 1000), content }],
            source: LOCAL_IP,
            topic,
            tags: this.buildAkTags(endpoint),
          });
        } else {
          // WebTracking 不需要 AK，直接向公开采集端点 POST；userAgent 用于服务端识别 Pilot 版本。
          await postWebtracking(
            {
              endpoint: endpoint.endpoint,
              project: endpoint.project,
              logstore: endpoint.logstore,
            },
            [content],
            {
              topic,
              source: LOCAL_IP,
              tags: { __hostname__: HOSTNAME },
              userAgent: this.userAgent,
            },
          );
        }
      } catch {
        // raw 通道目前只有 warning，没有失败文件持久化；一个 endpoint 失败后继续尝试其余目的地。
        logger.warn('sendRaw failed', { topic, endpoint: endpoint.name });
      }
    }
  }

  /**
   * 根据 endpoint 和可选 agentType 选择 bucket，更新入口指标，并在条数阈值时异步触发 flush。
   *
   * service name 启用时 agentType 加入 key，保证每批 tag 单一；未启用时不同 Agent 可共享 bucket。
   * `void flush()` 保持 send 低延迟，flush 内部负责吞掉 endpoint 级失败。
   */
  private enqueue(endpoint: SlsEndpoint, content: Record<string, string>, agentType?: string): void {
    // endpoint 三元组隔离不同目的地；启用 serviceName 时再按 Agent 拆桶，确保批次 tag 一致。
    const base = `${endpoint.name}/${endpoint.project}/${endpoint.logstore}`;
    const key = (this.effectiveServiceName(endpoint) && agentType)
      ? `${base}/${agentType}`
      : base;
    let bucket = this.queue.get(key);
    if (!bucket) {
      // Map 中只在首条记录到来时建桶，flush 清空后会删除空桶。
      bucket = [];
      this.queue.set(key, bucket);
    }
    // byteSize 在入队时计算并随项保存，flush 分批和指标无需反复序列化估算。
    const byteSize = Buffer.byteLength(JSON.stringify(content));
    bucket.push({ content, endpoint, agentType, byteSize });

    const counter = this.endpointCounters.get(endpoint.name);
    if (counter) {
      // in* 表示已接收入内存队列，并不代表远端写入成功；out*/failed* 在 flush 后更新。
      counter.inEntries++;
      counter.inBytes += byteSize;
      if (!counter.startTime) counter.startTime = formatTime(new Date());
    }

    const maxSize = this.config.batchMaxSize || BATCH_MAX_SIZE;
    if (bucket.length >= maxSize) {
      // 不 await 以保持 send 低延迟；flush 内部自行隔离 endpoint 错误。
      void this.flush();
    }
  }

  /** Promise 化退避等待。 */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
