/**
 * 可复用的 SLS WebTracking 传输函数。
 *
 * 文件/Qoder API 独立管道与其他调用方可直接使用这里，而不依赖主 SlsFlusher 的队列。模块
 * 负责按条数/估算字节拆批、HTTP 超时、指数退避和失败元数据持久化，不负责事件归一化。
 */

import { createLogger } from '../utils/logger.js';
import {
  SlsFailureLogWriter,
  type SlsFailureLogInput,
} from './sls-failure-log-writer.js';

const logger = createLogger('SlsTransport');

/** WebTracking 单请求的默认超时和服务端限制保护值。 */
export const WEBTRACKING_TIMEOUT_MS = 10_000;
export const WEBTRACKING_MAX_BODY_BYTES = 2_800_000;
export const WEBTRACKING_MAX_LOGS = 4096;
export const RETRY_MAX_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 1000;

/** 明确允许重试的 HTTP 状态；4xx 参数/鉴权错误通常立即失败。 */
export const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

/** 保留 HTTP status 的错误类型，供重试分类和告警判断。 */
export class HttpError extends Error {
  /** @param status HTTP 状态码；@param body SLS 响应正文，当前错误类不主动截断。 */
  constructor(readonly status: number, body: string) {
    super(`${status} ${body}`);
  }
}

/** 单个 WebTracking 目标和重试参数。 */
export interface SlsTransportConfig {
  /** 不带 project 子域前缀的基础 endpoint。 */
  endpoint: string;
  /** SLS project；发送时插入 endpoint host 前。 */
  project: string;
  /** 目标 logstore 名称。 */
  logstore: string;
  /** 单次 fetch 超时毫秒数。 */
  timeoutMs?: number;
  /** 总 attempt 数，默认 3；名称沿用历史配置。 */
  maxRetries?: number;
  /** 指数退避基数，默认 1000ms。 */
  retryBaseDelayMs?: number;
}

/** 构造 WebTracking body/header 的可选元数据。 */
export interface PostWebtrackingOptions {
  topic?: string;
  source?: string;
  tags?: Record<string, string>;
  userAgent?: string;
}

/** 调用方填写的失败批次元数据；endpoint 名和 error 由 persistFailedLogs 单独注入。 */
export type PersistFailedLogContext = Omit<SlsFailureLogInput, 'endpoint' | 'error'>;

/** 失败目录到 writer 的进程级缓存，避免每次失败重建串行写链。 */
const failedLogWriters = new Map<string, SlsFailureLogWriter>();

  /**
   * 按最大条数和估算 JSON 字节数顺序切分日志。
   * 单条超大日志不会在字段内部拆开，而是形成独立 chunk 交由服务端决定。
   *
   * 字节估算只计算各 log 的 JSON，不包含最终 body 中 topic/source/tags 和分隔符，因此保留的
   * 2.8MB 限值本身承担协议开销余量。函数保持输入顺序，返回的新数组仍引用原 log 对象。
   */
export function splitForWebtracking(
  logs: Record<string, string>[],
  maxLogs = WEBTRACKING_MAX_LOGS,
  maxBytes = WEBTRACKING_MAX_BODY_BYTES,
): Record<string, string>[][] {
  const chunks: Record<string, string>[][] = [];
  let current: Record<string, string>[] = [];
  let currentSize = 0;

  for (const log of logs) {
    // Buffer.byteLength 默认 UTF-8，能正确计算中文等多字节内容。
    const logSize = Buffer.byteLength(JSON.stringify(log));

    if (
      current.length > 0 &&
      (current.length >= maxLogs || currentSize + logSize > maxBytes)
    ) {
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
 * 判断 HTTP status 或常见错误文本是否值得重试。
 * 非 HttpError 采用字符串关键词启发式，可能受运行时/SDK 错误文案影响；未知错误默认不重试。
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return RETRYABLE_STATUS_CODES.has(err.status);
  const msg = String(err);
  return (
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('socket hang up') ||
    msg.includes('network') ||
    msg.includes('TimeoutError') ||
    msg.includes('InternalServerError') ||
    msg.includes('ServerBusy')
  );
}

/**
 * 拆分后按顺序逐 chunk 发送；任一 chunk 最终失败会 reject 并停止后续 chunk。
 * 串行顺序限制瞬时请求量，也使调用方能把失败理解为“该 chunk 及其后内容未由本次调用确认”。
 */
export async function postWebtracking(
  config: SlsTransportConfig,
  logs: Record<string, string>[],
  opts?: PostWebtrackingOptions,
): Promise<void> {
  const chunks = splitForWebtracking(logs);
  for (const chunk of chunks) {
    await postWebtrackingChunk(config, chunk, opts);
  }
}

/**
 * 构造并发送一个 WebTracking 请求，按指数退避执行有限 attempt。
 *
 * body 在重试循环外只序列化一次，各 attempt 使用相同字节。每次 fetch 创建独立超时 signal；
 * 408/429/5xx 及部分网络错误会等待 `base * 2^attempt` 后重试，不可重试 4xx 立即结束。
 * `maxRetries <= 0` 时最终会抛出 undefined，配置有效性依赖上游保证。
 */
async function postWebtrackingChunk(
  config: SlsTransportConfig,
  logs: Record<string, string>[],
  opts?: PostWebtrackingOptions,
): Promise<void> {
  const body = {
    __topic__: opts?.topic ?? '',
    __source__: opts?.source ?? '',
    __logs__: logs,
    __tags__: opts?.tags ?? ({} as Record<string, string>),
  };

  const raw = JSON.stringify(body);
  // SLS WebTracking 域名要求 project 作为 endpoint 的子域前缀。
  const base = config.endpoint.replace(
    /^(https?:\/\/)/,
    `$1${config.project}.`,
  );
  const url = `${base}/logstores/${config.logstore}/track`;

  const maxRetries = config.maxRetries ?? RETRY_MAX_ATTEMPTS;
  const retryBaseDelay = config.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
  const timeoutMs = config.timeoutMs ?? WEBTRACKING_TIMEOUT_MS;

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'x-log-apiversion': '0.6.0',
          'x-log-bodyrawsize': String(Buffer.byteLength(raw)),
          'Content-Type': 'application/json',
          ...(opts?.userAgent ? { 'user-agent': opts.userAgent } : {}),
        },
        body: raw,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!resp.ok) {
        // 读取响应正文帮助诊断，但失败日志后续会做截断与凭据清理。
        const text = await resp.text();
        const err = new HttpError(resp.status, text);
        if (
          !RETRYABLE_STATUS_CODES.has(resp.status) ||
          attempt === maxRetries - 1
        ) {
          throw err;
        }
        lastErr = err;
      } else {
        logger.debug('batch sent via webtracking', {
          project: config.project,
          logstore: config.logstore,
          count: logs.length,
        });
        return;
      }
    } catch (err) {
      lastErr = err;
      if (err instanceof HttpError && !RETRYABLE_STATUS_CODES.has(err.status))
        break;
      if (attempt === maxRetries - 1) break;
    }

    const delay = retryBaseDelay * 2 ** attempt;
    logger.warn('SLS webtracking retrying', {
      attempt: attempt + 1,
      delayMs: delay,
      error: String(lastErr),
    });
    await sleep(delay);
  }

  throw lastErr;
}

  /**
   * 将不可恢复失败写成不含 payload/headers 的有界诊断元数据。
   *
   * 每个失败目录复用一个 SlsFailureLogWriter，以其 Promise 链串行化并发 append/rotation。
   * writer.write 返回 false 时本函数不会抛出或返回状态，调用方只能依赖 writer 自身日志判断。
   */
export async function persistFailedLogs(
  failedLogDir: string,
  name: string,
  context: PersistFailedLogContext,
  err: unknown,
): Promise<void> {
  let writer = failedLogWriters.get(failedLogDir);
  if (!writer) {
    // 同一目录复用 writer 的 Promise 链，保证并发失败顺序写入。
    writer = new SlsFailureLogWriter(failedLogDir);
    failedLogWriters.set(failedLogDir, writer);
  }
  await writer.write({
    ...context,
    endpoint: name,
    error: err,
  });
}

/** Promise 化定时等待，不阻塞 Node.js 事件循环。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
