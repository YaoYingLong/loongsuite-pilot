// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * qwen-code transcript 消息到 ARMS event_t 消息的转换器。
 *
 * qwen-code 使用 `@google/genai` Content 结构保存历史：
 *   { role: 'user' | 'model' | 'tool', parts: [TextPart | FunctionCallPart | FunctionResponsePart] }
 * 其中每个 part 为：
 *   { text: string, thought?: true }                  // text / reasoning
 *   { functionCall: { name, args, id? } }              // tool call
 *   { functionResponse: { name, response } }           // tool result
 *
 * 目标 ARMS schema：
 *   { role, parts: [TextPart | ReasoningPart | ToolCallPart | ToolCallResponsePart] }
 * part 使用：
 *   { type: 'text', content }
 *   { type: 'reasoning', content }                     // ← qwen `thought: true` text
 *   { type: 'tool_call', id, name, arguments }
 *   { type: 'tool_call_response', id, response }
 *
 * 必须输出嵌套 parts，而不是 OpenAI 扁平 content；同一次响应的 reasoning、text、tool_call
 * 必须留在一个 assistant message 中，不能拆成多条。
 * 本模块只做纯数据转换，无文件或状态副作用；未知 part 返回 null 由调用方过滤。
 */

/**
 * 把一个 qwen-code message.parts[] 元素转为 ARMS part；无法识别时返回 null。
 *
 * @param {Object} qwenPart 例如 `{text:'hi'}` 或 `{functionCall:{...}}`。
 * @param {string|null} [toolCallIdForResponse] functionResponse 不带原 call id，调用方可从
 * tool_result.toolCallResult.callId 补入。
 */
export function convertQwenPart(qwenPart, toolCallIdForResponse = null) {
  if (!qwenPart || typeof qwenPart !== 'object') return null;

  // thought part 同时含 text 和 thought=true，必须先于普通 text 分支判断。
  if (qwenPart.thought === true && typeof qwenPart.text === 'string') {
    return { type: 'reasoning', content: qwenPart.text };
  }

  if (typeof qwenPart.text === 'string') {
    return { type: 'text', content: qwenPart.text };
  }

  if (qwenPart.functionCall && typeof qwenPart.functionCall === 'object') {
    const fc = qwenPart.functionCall;
    return {
      type: 'tool_call',
      id: fc.id || null,
      name: fc.name || '',
      arguments: fc.args ?? null,
    };
  }

  if (qwenPart.functionResponse && typeof qwenPart.functionResponse === 'object') {
    const fr = qwenPart.functionResponse;
    return {
      type: 'tool_call_response',
      id: toolCallIdForResponse || null,
      response: fr.response ?? null,
    };
  }

  // 未知结构直接丢弃，不生成会污染下游 schema 校验的 `{type:'unknown'}`。
  return null;
}

/**
 * 把 qwen message.parts[] 转为 ARMS parts[]，保持模型原始 reasoning/text/tool_call 顺序。
 */
export function convertQwenParts(qwenParts, toolCallIdForResponse = null) {
  if (!Array.isArray(qwenParts)) return [];
  const out = [];
  for (const p of qwenParts) {
    const converted = convertQwenPart(p, toolCallIdForResponse);
    if (converted) out.push(converted);
  }
  return out;
}

/**
 * 为单个 llm.response 构造 assistant 输出数组；全部 part 必须放在唯一一条 assistant message。
 *
 * @param {Object} assistantRecord type=assistant 的 qwen transcript 记录。
 * @returns {Array} `gen_ai.output.messages` 值。
 */
export function buildOutputMessages(assistantRecord) {
  const message = assistantRecord?.message || {};
  const parts = convertQwenParts(message.parts);
  const finishReason = inferAssistantFinishReason(assistantRecord);
  return [{
    role: 'assistant',
    parts,
    finish_reason: finishReason,
  }];
}

/**
 * 推断 assistant finish_reason。transcript 没有显式 stop_reason：含 functionCall 时为
 * `tool_call`，只有文本或为空时为 `stop`。
 */
export function inferAssistantFinishReason(assistantRecord) {
  const parts = assistantRecord?.message?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return 'stop';
  const hasFunctionCall = parts.some(
    (p) => p && typeof p === 'object' && p.functionCall && typeof p.functionCall === 'object',
  );
  return hasFunctionCall ? 'tool_call' : 'stop';
}

/**
 * 为单次 LLM 调用构造 `gen_ai.input.messages_delta`，只包含自上一调用/turn 开始新增的输入：
 *
 *   - turn 第一步的原始 user prompt
 *   - 上次 assistant 后产生的 tool_result
 *   - turn 中途 user 消息
 *
 * 输入是 qwen transcript 记录，提取 message.parts 并映射 role：
 *   - type=user → role: 'user'
 *   - type=tool_result → role: 'tool'（包含 tool_call_response part）
 *
 * @param {Array} sourceRecords user 或 tool_result transcript 记录。
 * @param {Map<string,string>} [toolCallIdByResponseUuid]
 * 可选映射：tool_result uuid -> 原工具 call id，用于补齐 functionResponse。
 */
export function buildInputMessagesDelta(sourceRecords, toolCallIdByResponseUuid = new Map()) {
  if (!Array.isArray(sourceRecords)) return [];
  const messages = [];
  for (const rec of sourceRecords) {
    if (!rec || typeof rec !== 'object') continue;
    const msg = rec.message || {};
    if (rec.type === 'tool_result') {
      const callId = toolCallIdByResponseUuid.get(rec.uuid) || rec?.toolCallResult?.callId || null;
      const parts = convertQwenParts(msg.parts, callId);
      if (parts.length > 0) {
        messages.push({ role: 'tool', parts });
      }
      continue;
    }
    // type=user，同时覆盖 mid_turn_user_message。
    const parts = convertQwenParts(msg.parts);
    if (parts.length > 0) {
      const role = msg.role === 'tool' ? 'tool' : 'user';
      messages.push({ role, parts });
    }
  }
  return messages;
}
