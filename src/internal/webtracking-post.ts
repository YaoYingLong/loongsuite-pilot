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

/**
 * 按 SLS WebTracking 规则把 project 插入 endpoint host，并追加 logstore track 路径。
 * 本函数不发网络请求，也不校验 URL；调用方必须传入带 http/https scheme 的基础 endpoint。
 */
export function buildWebTrackingUrl(endpoint: string, project: string, logstore: string): string {
  // replace 只匹配字符串开头的 scheme，因此原 endpoint 的其余 path/host 会原样保留。
  const base = endpoint.replace(/^(https?:\/\/)/, `$1${project}.`);
  return `${base}/logstores/${logstore}/track`;
}

/** 仅网络暂态和指定 HTTP 状态可重试。 */
function isRetryable(err: unknown): boolean {
  if (err && typeof err === 'object' && 'status' in err) {
    return RETRYABLE_STATUS_CODES.has((err as { status: number }).status);
  }
  // fetch 的网络异常在不同 Node/平台可能没有稳定 code，此处按错误文本兼容常见暂态错误。
  const msg = String(err);
  return msg.includes('ECONNRESET') ||
         msg.includes('ETIMEDOUT') ||
         msg.includes('ECONNREFUSED') ||
         msg.includes('TimeoutError');
}

/** Promise 化指数退避等待。 */
function sleep(ms: number): Promise<void> {
  // timer 没有 unref；重试等待期间它会让当前短生命周期命令保持运行直至 Promise 兑现。
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 发送一个内部 WebTracking body；最终失败仅记录 error，不 reject。
 *
 * @param url 已包含 project/logstore 的 WebTracking track URL。
 * @param body 会被一次性 JSON.stringify；循环重试复用同一份 UTF-8 文本。
 * @param label 仅用于结构化日志标签，不发送给服务端。
 * @returns 成功或最终放弃后均正常兑现；JSON.stringify 本身若遇循环引用会在进入重试前抛出。
 */
export async function postWebTracking(
  url: string,
  body: Record<string, unknown>,
  label?: string,
): Promise<void> {
  // 循环外序列化保证每次重试 body 和 Content-Length 完全一致。
  const raw = JSON.stringify(body);
  const tag = label || 'webtracking';
  let lastErr: unknown;

  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      // AbortSignal.timeout 到期会中止 fetch；POST body 已在内存中，不涉及文件流清理。
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'x-log-apiversion': '0.6.0',
          // byteLength 按 UTF-8 字节计算，不能使用 JS 字符串 length 代替。
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

      // 读取错误响应正文只用于日志；过大的服务端响应会完整进入内存。
      const text = await resp.text();
      // 动态附加 status，使 isRetryable 能统一处理 fetch HTTP 错误。
      lastErr = Object.assign(new Error(`${resp.status} ${text}`), { status: resp.status });
      // 4xx 等确定性错误立即停止，避免重复发送相同无效请求。
      if (!RETRYABLE_STATUS_CODES.has(resp.status)) break;
    } catch (err) {
      lastErr = err;
      // DNS/证书/参数等非暂态异常同样立即结束。
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
