/**
 * 内部状态/统计上报共用的轻量 WebTracking POST。
 *
 * 该模块与用户配置的 SLS Flusher 相互独立，只供 `src/internal` 使用。请求最多重试三次，
 * 最终失败只写日志、不抛给 MetricsWriter，避免内部遥测影响 Collector 主业务。
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('WebTrackingPost');

const TIMEOUT_MS = 10_000;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

/** 按 SLS WebTracking 规则把 project 插入 endpoint host。 */
export function buildWebTrackingUrl(endpoint: string, project: string, logstore: string): string {
  const base = endpoint.replace(/^(https?:\/\/)/, `$1${project}.`);
  return `${base}/logstores/${logstore}/track`;
}

/** 仅网络暂态和指定 HTTP 状态可重试。 */
function isRetryable(err: unknown): boolean {
  if (err && typeof err === 'object' && 'status' in err) {
    return RETRYABLE_STATUS_CODES.has((err as { status: number }).status);
  }
  const msg = String(err);
  return msg.includes('ECONNRESET') ||
         msg.includes('ETIMEDOUT') ||
         msg.includes('ECONNREFUSED') ||
         msg.includes('TimeoutError');
}

/** Promise 化指数退避等待。 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 发送一个内部 WebTracking body；最终失败仅记录 error，不 reject。
 */
export async function postWebTracking(
  url: string,
  body: Record<string, unknown>,
  label?: string,
): Promise<void> {
  const raw = JSON.stringify(body);
  const tag = label || 'webtracking';
  let lastErr: unknown;

  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'x-log-apiversion': '0.6.0',
          'x-log-bodyrawsize': String(Buffer.byteLength(raw)),
          'Content-Type': 'application/json',
        },
        body: raw,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (resp.ok) {
        logger.debug(`${tag} sent`, { url });
        return;
      }

      const text = await resp.text();
      // 动态附加 status，使 isRetryable 能统一处理 fetch HTTP 错误。
      lastErr = Object.assign(new Error(`${resp.status} ${text}`), { status: resp.status });
      if (!RETRYABLE_STATUS_CODES.has(resp.status)) break;
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) break;
    }

    if (attempt < RETRY_MAX_ATTEMPTS - 1) {
      // 等待 1s、2s；第三次失败后直接结束。
      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
      logger.warn(`${tag} retrying`, { attempt: attempt + 1, delayMs: delay, error: String(lastErr) });
      await sleep(delay);
    }
  }

  logger.error(`${tag} failed after retries`, { url, error: String(lastErr) });
}
