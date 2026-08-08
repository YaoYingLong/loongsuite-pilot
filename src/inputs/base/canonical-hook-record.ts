/**
 * 已接近 canonical 的 Hook JSON 记录快速构建器。
 *
 * 只有带 `event.name` 和 `gen_ai.agent.type` 的记录才进入；字段严格按 canonical key/prefix
 * 白名单复制，再交给 EntryBuilder 做最终消息/别名规范，防止任意 Hook 顶层字段污染输出。
 */

import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';

/** 允许透传的稳定 dotted namespace。 */
const CANONICAL_PREFIXES = [
  'agent.',
  'error.',
  'gen_ai.',
  'git.',
  'host.',
  'service.',
  'workspace.',
];

/** 不属于上述 namespace 但属于公共 Schema 的精确 key。 */
const CANONICAL_KEYS = new Set([
  'event.id',
  'event.name',
  'observed_time_unix_nano',
  'parent_span_id',
  'span_id',
  'time_unix_nano',
  'resourceAttributes',
  'tool.result.status',
  'trace_id',
  'user.id',
]);

/**
 * @param record Hook 原始对象。
 * @param fallbackAgentType 源端 agent type 缺失时的调用方类型（当前预检仍要求源字段存在）。
 * @param attributes 可选 Agent 扩展属性。
 * @returns 标准事件；不是 canonical Hook 记录时返回 null。
 */
export function buildCanonicalHookEntry(
  record: Record<string, unknown>,
  fallbackAgentType: string,
  attributes?: Record<string, unknown>,
): AgentActivityEntry | null {
  if (!isCanonicalHookRecord(record)) return null;

  const opts: Record<string, JsonValue | undefined> = {};
  // 只复制审核过的公共 key，并递归丢弃 undefined。
  for (const [key, raw] of Object.entries(record)) {
    if (!isCanonicalKey(key)) continue;
    const value = toJsonValue(raw);
    if (value !== undefined) opts[key] = value;
  }

  opts['gen_ai.agent.type'] = stringValue(record, 'gen_ai.agent.type') ?? fallbackAgentType;

  // Hook 无 model 时设 unknown；保留 `auto`，后续 token enricher 可能替换为真实模型。
  if (!opts['gen_ai.request.model']) opts['gen_ai.request.model'] = 'unknown';
  if (!opts['gen_ai.response.model']) opts['gen_ai.response.model'] = opts['gen_ai.request.model'];

  const entry = buildAgentActivityEntry({
    ...opts,
    attributes: toJsonObject(attributes ?? {}),
  });

  return entry;
}

/** canonical Hook 的最低识别条件。 */
function isCanonicalHookRecord(record: Record<string, unknown>): boolean {
  return typeof record['event.name'] === 'string'
    && typeof record['gen_ai.agent.type'] === 'string';
}

/** 精确 key 或稳定 namespace 才允许透传。 */
function isCanonicalKey(key: string): boolean {
  return CANONICAL_KEYS.has(key) || CANONICAL_PREFIXES.some(prefix => key.startsWith(prefix));
}

/** 读取非空字符串字段。 */
function stringValue(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 把 unknown 对象递归转成 JSON 安全对象。 */
function toJsonObject(value: Record<string, unknown>): { [key: string]: JsonValue } {
  const out: { [key: string]: JsonValue } = {};
  for (const [key, raw] of Object.entries(value)) {
    const json = toJsonValue(raw);
    if (json !== undefined) out[key] = json;
  }
  return out;
}

/** 递归转换 JSON 值；undefined 删除，其他非 JSON 类型最后 String 化。 */
function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map(item => toJsonValue(item))
      .filter((item): item is JsonValue => item !== undefined);
  }
  if (typeof value === 'object') return toJsonObject(value as Record<string, unknown>);
  return String(value);
}
