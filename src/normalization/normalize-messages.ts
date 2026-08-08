/**
 * GenAI 输入/输出消息结构兼容转换。
 *
 * 不同 Agent/旧版本可能提供裸 parts、`content` 或 camelCase 字段；EntryBuilder 在统一事件
 * 建成后调用这里收敛到测试 Schema。所有转换保持幂等，已经 canonical 的值原样通过。
 */

import type { JsonValue } from '../types/index.js';

/**
 * 将 `gen_ai.output.messages` 规范为测试 Schema 定义的结构：
 *   [{role: "assistant", parts: [...], finish_reason?: string}]
 *
 * 兼容裸 parts、camelCase `finishReason`，以及已经规范的消息。
 *
 * @param raw 未知来源但已收敛为 JsonValue 的消息值。
 * @returns 规范化值；null/undefined 转为 undefined，无法识别的结构原样返回。
 */
export function normalizeOutputMessages(raw: JsonValue | undefined): JsonValue | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) return raw;

  // 用首项判断数组整体形状；混合或未知结构保守保留原数据。
  const first = raw[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return raw;
  const firstObj = first as Record<string, JsonValue>;

  if (Array.isArray(firstObj.parts)) {
    // 已有消息容器，仅统一 finish reason 的 key 命名。
    return raw.map(msg => normalizeOutputMessageKeys(msg));
  }

  if (typeof firstObj.type === 'string') {
    // 裸 part 数组包装成单条 assistant message，非对象项在此丢弃。
    const parts = raw.filter(
      (p): p is Record<string, JsonValue> => p !== null && typeof p === 'object' && !Array.isArray(p),
    );
    return [{ role: 'assistant', parts }];
  }

  return raw;
}

/** 将单条 output message 的 finishReason 改成 canonical snake_case。 */
function normalizeOutputMessageKeys(msg: JsonValue): JsonValue {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return msg;
  const obj = msg as Record<string, JsonValue>;

  if ('finishReason' in obj && !('finish_reason' in obj)) {
    const { finishReason, ...rest } = obj;
    return { ...rest, finish_reason: finishReason };
  }
  return obj;
}

/**
 * 将 `gen_ai.input.messages_delta` 规范为：
 *   [{role, parts: [{type: "text", content}]}]
 *
 * 扁平 `{role,content}` 会变成 text part，已经 canonical 的值保持不变。
 */
export function normalizeInputMessagesDelta(raw: JsonValue | undefined): JsonValue | undefined {
  return normalizeInputMessagesArray(raw);
}

/**
 * 使用与 messages_delta 相同的规则规范完整输入消息。
 */
export function normalizeInputMessages(raw: JsonValue | undefined): JsonValue | undefined {
  return normalizeInputMessagesArray(raw);
}

/** 输入消息数组的共享实现；未知项逐项保留，避免静默丢源数据。 */
function normalizeInputMessagesArray(raw: JsonValue | undefined): JsonValue | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) return raw;

  return raw.map(msg => {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return msg;
    const obj = msg as Record<string, JsonValue>;

    if (Array.isArray(obj.parts)) return msg;

    if (typeof obj.content === 'string' && typeof obj.role === 'string') {
      // 保留 role 以外的扩展字段，只把 content 移入 canonical text part。
      const { content, ...rest } = obj;
      return { ...rest, parts: [{ type: 'text', content }] };
    }

    return msg;
  });
}
