// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Claude Code transcript 消息到统一 GenAI Message Schema 的转换模块。
 *
 * 主调用链是：`transcript-parser.mjs` 把 Claude 原生 JSONL 合并为 turn/LLM call
 * -> `claude-code-hook-processor.mjs#buildTurnRecords()` 调用本文件
 * -> `convertInputMessages()` 生成 `gen_ai.input.messages(_delta)`
 * -> `convertOutputMessages()` 生成 `gen_ai.output.messages`
 * -> processor 将包含这些字段的标准事件写入 Claude Hook JSONL。
 *
 * 当前 Claude transcript parser 会把 LLM call 标记为 `protocol: 'anthropic'`，所以生产主路径使用
 * Anthropic 分支；`openai-chat` 和 `openai-responses` 分支是从旧插件保留的协议兼容能力。本文件不负责
 * system prompt：请求侧 system instructions 由 `claude-code-fetch-intercept.mjs` 截获，并在 processor
 * 中按 response ID 合并。
 *
 * 统一后的大致结构为：
 * `InputMessage  = { role, parts: [TextPart | ToolCallPart | ToolCallResponsePart | BlobPart |
 *                                  UriPart | ReasoningPart] }`
 * `OutputMessage = { role: 'assistant', parts: [...], finish_reason }`。
 *
 * 所有导出函数都是同步纯转换：不修改输入消息、不读写文件、不访问网络、不保存 state，也不直接触发
 * Collector 的 `entries`。它们返回的数据只有在 processor 成功追加 JSONL、随后
 * `ClaudeCodeLogInput` 轮询到新增行后，才进入 `entries` 链路。未知输入块的处理因协议而异：Anthropic
 * 输入尽量保留 type，输出只保留可识别内容；OpenAI 兼容分支也会把未知 part 降级为 type-only 对象。
 */

// 把不同供应商/兼容协议中的结束原因收敛到平台约定值，供 llm.response 的 finish_reason 使用。
const STOP_REASON_MAP = {
  end_turn: 'stop',
  stop: 'stop',
  completed: 'stop',
  tool_use: 'tool_call',
  tool_calls: 'tool_call',
  max_tokens: 'length',
  length: 'length',
  content_filter: 'content_filter',
  error: 'error',
};

/**
 * 将供应商 stop reason 映射为平台 finish_reason。
 *
 * 空值按正常停止处理；映射表之外的新值原样返回，这样升级后的 Claude 字段不会被错误抹掉。
 *
 * @param {unknown} raw transcript 中的原始 stop reason。
 * @returns {unknown} 已知值对应的平台字符串、默认 `stop`，或未识别的原值。
 */
export function mapStopReason(raw) {
  if (!raw) return 'stop';
  // 对普通对象使用方括号索引；不存在的 key 得到 undefined，再由 `||` 回退到 raw。
  return STOP_REASON_MAP[raw] || raw;
}

// ─── Anthropic content block 与 MessagePart 互转 ───

/**
 * 把一个 Anthropic content block 转成统一 MessagePart。
 *
 * 对应关系：`text -> text`、`tool_use -> tool_call`、`tool_result -> tool_call_response`、
 * `image -> blob`、`thinking -> reasoning`。图片 base64 只移动到 `content` 字段，不进行解码；
 * tool 参数和结果保留原始 JavaScript 值，后续由 processor 的事件清理/序列化阶段处理。
 *
 * @param {unknown} block Anthropic message.content 中的单个 block。
 * @returns {object|null} 新建的统一 part；非对象输入返回 null。
 */
export function convertAnthropicContentBlock(block) {
  // transcript 可能包含 null 或损坏块；跳过该块比让整个 turn 转换失败更稳妥。
  if (!block || typeof block !== 'object') return null;
  switch (block.type) {
    case 'text':
      // 缺失文本降级为空串，保持 part 的结构稳定。
      return { type: 'text', content: block.text || '' };
    case 'tool_use':
      return {
        type: 'tool_call',
        // `id` 供 tool_result 关联调用；缺失时明确保留 null，而不是伪造 ID。
        id: block.id || null,
        name: block.name || '',
        // `??` 只把 null/undefined 当缺失，允许 false、0、空字符串等合法参数原样通过。
        arguments: block.input ?? null,
      };
    case 'tool_result':
      return {
        type: 'tool_call_response',
        // Anthropic 用 tool_use_id 指回先前的 tool_use block。
        id: block.tool_use_id || null,
        response: block.content ?? null,
      };
    case 'image': {
      // Anthropic 图片通常位于 source={type, media_type, data}；这里只使用媒体类型和 base64 数据。
      const src = block.source || {};
      const mimeType = src.media_type || 'image/unknown';
      const data = src.data || '';
      return { type: 'blob', mime_type: mimeType, modality: 'image', content: data };
    }
    case 'thinking':
      // thinking block 作为 reasoning 保存，避免与最终给用户的 text 混为一段。
      return { type: 'reasoning', content: block.thinking || '' };
    default:
      // 新 block 若仍带 text，至少保留文本；否则保留类型占位，避免整条消息静默消失。
      if (block.text != null) return { type: 'text', content: block.text };
      return { type: block.type || 'unknown' };
  }
}

// ─── input messages 归一化 ───

/**
 * 把一次 LLM 请求的输入消息数组分派给对应协议转换器。
 *
 * `buildTurnRecords()` 每处理一个 transcript LLM call 调用一次。字符串输入被当作单条 user 文本；
 * 数组逐项转换；其他类型返回空数组。未明确写成 `openai-chat` 或 `openai-responses` 的 protocol
 * 都走 Anthropic 默认分支，符合当前 Claude parser 的输出。
 *
 * @param {unknown} messages transcript parser 汇总出的请求消息。
 * @param {string|undefined} protocol `anthropic`、`openai-chat` 或 `openai-responses`。
 * @returns {object[]} 新建的统一 InputMessage 数组；不会修改原 messages。
 */
export function convertInputMessages(messages, protocol) {
  // null、undefined、空字符串都表示没有可转换的输入。
  if (!messages) return [];
  if (typeof messages === 'string') {
    // 保留这一兼容入口；正常 Claude transcript 主路径传入数组。
    return messages ? [{ role: 'user', parts: [{ type: 'text', content: messages }] }] : [];
  }
  if (!Array.isArray(messages)) return [];

  const result = [];
  for (const msg of messages) {
    // 单条坏记录只影响自身，不让同一 LLM 请求中的其他消息丢失。
    if (!msg || typeof msg !== 'object') continue;

    if (protocol === 'openai-chat') {
      // chat message 总能降级成带 role 的对象，因此直接加入。
      result.push(convertOpenAIChatMessage(msg));
    } else if (protocol === 'openai-responses') {
      // Responses item 可能是无关控制项，转换器以 null 表示应跳过。
      const converted = convertOpenAIResponsesItem(msg);
      if (converted) result.push(converted);
    } else {
      // 当前 Claude 主路径在这里处理 Anthropic 原生 role/content 对象。
      result.push(convertAnthropicMessage(msg));
    }
  }
  return result;
}

/**
 * 转换一条 Anthropic 原生消息。
 *
 * Anthropic 通常把 `tool_result` 放在 role=user 的 content 数组中；统一 Schema 则用 role=tool 表示
 * 工具响应。因此只要转换后的任一 part 是 `tool_call_response`，整条消息角色就提升为 `tool`。
 *
 * @param {object} msg Anthropic `{ role, content }` 消息。
 * @returns {object} 新建的统一 InputMessage。
 */
function convertAnthropicMessage(msg) {
  // 缺失 role 时按外部输入 user 处理，是协议兼容的保守默认值。
  const role = msg.role || 'user';
  const content = msg.content;

  if (typeof content === 'string') {
    // Anthropic 允许简写字符串 content，统一包装为一个 TextPart。
    return { role, parts: [{ type: 'text', content }] };
  }

  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      const part = convertAnthropicContentBlock(block);
      if (part) parts.push(part);
    }
    // 一个 Anthropic user 消息可能只用于返回工具结果；这里转换成下游理解的 tool 角色。
    const effectiveRole = parts.some((p) => p.type === 'tool_call_response') ? 'tool' : role;
    return { role: effectiveRole, parts };
  }

  // 非标准标量用 String() 留下可诊断文本；null/undefined 则形成空 parts。
  return { role, parts: content != null ? [{ type: 'text', content: String(content) }] : [] };
}

/**
 * 转换 OpenAI Chat Completions 风格消息；这是兼容分支，当前 Claude 主 transcript 不会走这里。
 * @param {object} msg Chat Completions message。
 * @returns {object} 统一 InputMessage。
 */
function convertOpenAIChatMessage(msg) {
  const role = msg.role || 'user';
  const parts = [];

  // role=tool 的消息本身就是某次 tool call 的响应，无需再继续解析普通 content/tool_calls。
  if (role === 'tool' && msg.tool_call_id) {
    parts.push({
      type: 'tool_call_response',
      id: msg.tool_call_id,
      response: msg.content ?? null,
    });
    return { role: 'tool', parts };
  }

  if (msg.content != null) {
    if (typeof msg.content === 'string') {
      // 空字符串不生成无意义 TextPart，但消息对象仍会在函数末尾返回。
      if (msg.content) parts.push({ type: 'text', content: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        // 兼容某些客户端直接在 content 数组中放裸字符串。
        if (typeof block === 'string') {
          parts.push({ type: 'text', content: block });
        } else if (block && block.type === 'text') {
          parts.push({ type: 'text', content: block.text || '' });
        } else if (block && block.type === 'image_url' && block.image_url) {
          // image_url 既可能是字符串，也可能是 `{ url }` 对象。
          const url = typeof block.image_url === 'string' ? block.image_url : block.image_url.url || '';
          // data URI 拆成 blob；普通远程地址保留为 uri，转换器不会主动下载图片。
          const dataMatch = url.match(/^data:([^;]+);base64,(.+)$/);
          if (dataMatch) {
            parts.push({ type: 'blob', mime_type: dataMatch[1], modality: 'image', content: dataMatch[2] });
          } else {
            parts.push({ type: 'uri', mime_type: 'image/unknown', modality: 'image', uri: url });
          }
        }
      }
    }
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      // OpenAI 的函数名和参数位于 tool_call.function 下；arguments 常见为 JSON 字符串，原样保留。
      parts.push({
        type: 'tool_call',
        id: tc.id || null,
        name: tc.function?.name || '',
        arguments: tc.function?.arguments ?? null,
      });
    }
  }

  return { role, parts };
}

/**
 * 转换 OpenAI Responses API 风格 item；这是兼容分支，当前 Claude 主 transcript 不会走这里。
 * @param {unknown} item Responses API 输入数组中的一个 item。
 * @returns {object|null} 统一 InputMessage；非对象控制项返回 null。
 */
function convertOpenAIResponsesItem(item) {
  // convertInputMessages 外层已过滤非对象；此处重复校验使函数未来被单独调用时也能防御坏输入。
  if (!item || typeof item !== 'object') return null;

  // 待确认：该遗留字符串分支位于上方对象类型守卫之后，按当前执行顺序不可到达。
  if (typeof item === 'string') {
    return { role: 'user', parts: [{ type: 'text', content: item }] };
  }

  // Responses API 用独立 function_call_output item 表示工具返回值。
  if (item.type === 'function_call_output') {
    return {
      role: 'tool',
      parts: [{
        type: 'tool_call_response',
        id: item.call_id || null,
        response: item.output ?? null,
      }],
    };
  }

  const role = item.role || 'user';
  const content = item.content;
  // 允许 message item 使用字符串 content 的简写形式。
  if (typeof content === 'string') {
    return { role, parts: [{ type: 'text', content }] };
  }
  if (Array.isArray(content)) {
    const parts = content.map((c) => {
      if (typeof c === 'string') return { type: 'text', content: c };
      // input_text 与 text 在统一 Schema 中都归为普通文本。
      if (c && c.type === 'input_text') return { type: 'text', content: c.text || '' };
      if (c && c.type === 'text') return { type: 'text', content: c.text || '' };
      if (c && c.type === 'input_image') {
        const url = c.image_url || c.url || '';
        // 与 Chat 分支相同：内嵌 base64 转 blob，外部地址转 uri，不执行网络 I/O。
        const dataMatch = url.match(/^data:([^;]+);base64,(.+)$/);
        if (dataMatch) {
          return { type: 'blob', mime_type: dataMatch[1], modality: 'image', content: dataMatch[2] };
        }
        return { type: 'uri', mime_type: 'image/unknown', modality: 'image', uri: url };
      }
      // 未识别 item 只保留 type 占位；其其他字段当前不会进入标准事件，属于兼容降级。
      return { type: c?.type || 'unknown' };
    });
    return { role, parts };
  }

  // 没有可识别 content 仍返回角色和空 parts，保持消息边界。
  return { role, parts: [] };
}

// ─── output messages 归一化 ───

/**
 * 把 Anthropic assistant 输出 blocks 转为统一 OutputMessage 数组。
 *
 * `buildTurnRecords()` 在构造每条 `llm.response` 时调用。即使没有输出内容也固定返回一条
 * role=assistant 的空消息，使 finish_reason 仍能上报。输出只接受数组；text、tool_use、thinking
 * 分别转为 text、tool_call、reasoning，未知但带 text 的 block 降级成 TextPart，其余未知块跳过。
 *
 * @param {unknown} outputContent transcript parser 汇总出的 assistant content blocks。
 * @param {unknown} stopReason 本次 LLM 调用的原始结束原因。
 * @returns {object[]} 始终只含一个 assistant OutputMessage 的新数组。
 */
export function convertOutputMessages(outputContent, stopReason) {
  // 空值、非数组和空数组统一形成“有结束原因但无正文”的 assistant 消息。
  if (!outputContent || !Array.isArray(outputContent) || outputContent.length === 0) {
    return [{
      role: 'assistant',
      parts: [],
      finish_reason: mapStopReason(stopReason),
    }];
  }

  const parts = [];
  for (const block of outputContent) {
    // 忽略单个损坏块，继续转换同一响应中的其他有效内容。
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'text':
        parts.push({ type: 'text', content: block.text || '' });
        break;
      case 'tool_use':
        parts.push({
          type: 'tool_call',
          // id/name 缺失时保留稳定的 null/空串，参数仅对 null/undefined 回退。
          id: block.id || null,
          name: block.name || '',
          arguments: block.input ?? null,
        });
        break;
      case 'thinking':
        parts.push({ type: 'reasoning', content: block.thinking || '' });
        break;
      default:
        // 对未来新增但仍携带 text 的 block 保留可读正文；完全未知结构则不生成 part。
        if (block.text != null) {
          parts.push({ type: 'text', content: block.text });
        }
        break;
    }
  }

  // 下游字段定义为消息数组，因此即使 Anthropic 一次只产生一个 assistant message 也保持数组形状。
  return [{
    role: 'assistant',
    parts,
    finish_reason: mapStopReason(stopReason),
  }];
}
