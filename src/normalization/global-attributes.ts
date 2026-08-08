/**
 * Trace 专用全局属性的解析、清洗与动态文件缓存。
 *
 * ConfigLoader 合并 config 与 `OTEL_SPAN_ATTRIBUTES` 形成启动基线；OtlpTraceFlusher 每批调用
 * Provider 读取可变 `span-attributes.json`。这些属性只进入 Span 副本，不污染日志型输出。
 */

import * as fs from 'node:fs';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('GlobalAttributes');

/**
 * enrich-git-context.ts 生成的 Git/工作区字段。
 * 这些是 Collector 自己维护的标准语义，会固定透传到 Trace Span，不受用户自定义属性影响。
 */
export const DEFAULT_GIT_PASSTHROUGH_KEYS = [
  'git.repo',
  'git.branch',
  'git.domain',
  'workspace.current_root',
  'workspace.path',
] as const;

/**
 * 转换器和采集管道保留的字段前缀。
 * 用户自定义属性若命中这些前缀会被丢弃，避免覆盖 trace_id、user.id、gen_ai.* 等平台
 * 生成字段，造成 Trace 语义错误或不同输出之间含义不一致。
 */
const RESERVED_PREFIXES = [
  'gen_ai.',
  'git.',
  'workspace.',
  'event.',
  'trace_',
  'user.',
  'cost_',
  'agent.',
  'time_unix_nano',
  'observed_time_unix_nano',
];

/** 判断属性名是否属于 Collector 保留命名空间。 */
export function isReservedKey(key: string): boolean {
  return RESERVED_PREFIXES.some((p) => key === p || key.startsWith(p));
}

/**
 * 解析 OTel 常用的 `key1=value1,key2=value2` 文本格式。
 * 每项只按第一个等号切分，因此 value 中可以继续包含等号；空 key/value 和畸形项直接跳过。
 */
export function parseKeyValueAttributes(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key.length === 0 || value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/** 把 string/number/boolean 转成 Span 属性字符串；对象、数组等复杂值返回 undefined。 */
function coerceString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/**
 * 清洗候选属性：删除保留前缀，并丢弃不能安全转换成字符串的复杂值。
 */
export function sanitizeAttributes(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(input)) {
    if (isReservedKey(key)) continue;
    const value = coerceString(rawValue);
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 全局 Span 自定义属性提供器。
 *
 * 启动时的 config + env 形成静态基线；运行中的 `<dataDir>/span-attributes.json` 可动态
 * 覆盖基线。文件按 mtime 缓存，只有发生变化才重新读取，因此每批 Trace 查询成本很低。
 * 这些属性只注入 Trace Span，不写入 JSONL/SLS/HTTP 事件日志。
 */
export class GlobalAttributesProvider {
  private readonly baseline: Record<string, string>;
  private readonly filePath: string;
  private cachedMtimeMs = -1;
  private cachedFileAttrs: Record<string, string> = {};
  private cachedMerged: Record<string, string>;

  constructor(baseline: Record<string, string>, filePath: string) {
    this.baseline = sanitizeAttributes(baseline);
    // 通常是 `<dataDir>/span-attributes.json`，由 CLI 原子更新。
    this.filePath = filePath;
    this.cachedMerged = { ...this.baseline };
  }

  /** 返回“启动基线 < 动态文件”的合并结果；mtime 未变化时直接复用缓存。 */
  resolve(): Record<string, string> {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(this.filePath).mtimeMs;
    } catch {
      // 文件被删除或 stat 失败时回退到启动基线；只在状态变化时重建一次缓存。
      if (this.cachedMtimeMs !== -1) {
        this.cachedMtimeMs = -1;
        this.cachedFileAttrs = {};
        this.cachedMerged = { ...this.baseline };
      }
      return this.cachedMerged;
    }

    if (mtimeMs === this.cachedMtimeMs) return this.cachedMerged;

    const result = this.readFileAttrs();
    if (!result.ok) {
      // 并发非原子写入可能暂时留下半截 JSON。此时继续使用最近一次成功值，并且不提交
      // 新 mtime，这样下次 resolve() 仍会重试，而不是一直卡在旧缓存。
      return this.cachedMerged;
    }

    this.cachedMtimeMs = mtimeMs;
    this.cachedFileAttrs = result.attrs;
    this.cachedMerged = { ...this.baseline, ...result.attrs };
    return this.cachedMerged;
  }

  /** 返回当前合并结果的属性名列表。 */
  keys(): string[] {
    return Object.keys(this.resolve());
  }

  private readFileAttrs(): { ok: boolean; attrs: Record<string, string> } {
    // 同步读取使一次 resolve() 得到单一快照，文件很小且只在 mtime 改变后执行。
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      logger.warn('failed to read span-attributes file; will retry', {
        filePath: this.filePath,
        error: String(err),
      });
      return { ok: false, attrs: {} };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // JSON 可能只是在写入中暂时不完整，保留最近成功值并等待下次重试。
      logger.warn('span-attributes file has invalid JSON; will retry', {
        filePath: this.filePath,
        error: String(err),
      });
      return { ok: false, attrs: {} };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // JSON 可解析但不是对象，说明文件结构明确不合法；把动态属性视为空，而非持续重试。
      logger.warn('span-attributes file is not a JSON object; ignoring', { filePath: this.filePath });
      return { ok: true, attrs: {} };
    }
    return { ok: true, attrs: sanitizeAttributes(parsed as Record<string, unknown>) };
  }
}
