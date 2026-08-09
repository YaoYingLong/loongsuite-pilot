// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Claude Code 工具响应的兼容归一化辅助模块。
 *
 * 这两个函数移植自旧 `claude-code-plugin` 的 hooks 实现，用于把不同工具可能返回的字符串、对象、
 * content block 数组整理成统一结果，并在错误时生成标准错误对象。它们只处理已经在内存中的值：
 * 不读 transcript、不写 JSONL、不修改 session state，也不会直接触发 Collector 的 `entries`。
 *
 * 需要特别注意当前调用关系：截至当前代码，`claude-code-hook-processor.mjs` 和
 * `claude-code/transcript-parser.mjs` 都没有导入本模块。现行主流程由 transcript parser 直接提取
 * `tool_result` 的 `content/output/result` 与 `is_error`，processor 再直接构造 `tool.result` 事件。
 * 因此本文件现在属于迁移后保留的兼容/备用 API，而不是 Claude `entries` 链路的必经步骤；未来是否
 * 删除或重新接入待确认。保留注释中的行为说明，便于后续调用方不会误解优先级和返回类型。
 */

/**
 * 从兼容形态的 Claude Code tool response 中提取可上报结果值。
 *
 * 处理顺序决定最终结果：
 * 1. `null`/`undefined` 统一返回 null，字符串和非对象标量原样返回；
 * 2. 普通对象只要 `error` 或 `isError` 为真，就优先返回 `Error: ...` 字符串；
 * 3. 否则按 `result -> content -> message -> output -> stdout` 查找第一个“存在的键”；
 * 4. 该值若是 content-block 数组，只拼接其中 `{ type: 'text', text: <非空值> }` 的 text；
 * 5. 没有可拼接文本时返回该数组原值，完全没有候选键时返回整个对象。
 *
 * “第一个存在的键”使用 `key in object` 判断，即使值为 undefined 也会立即返回，不会继续尝试后续
 * 键；文本数组使用空分隔符拼接。这些都是现有兼容语义，调用方不应假定函数总返回字符串。
 *
 * @param {unknown} toolResponse 工具执行器返回的原始值。
 * @returns {unknown} 提取后的字符串/数组/对象/标量，或空输入对应的 null。
 */
export function extractToolResult(toolResponse) {
  // `== null` 有意同时匹配 null 和 undefined，并把二者归一为 null。
  if (toolResponse == null) return null;
  // 已经是最终文本时无需复制或序列化。
  if (typeof toolResponse === 'string') return toolResponse;
  // 数组和数字、布尔值等不是下面要按键搜索的普通对象，保持原值。
  if (typeof toolResponse !== 'object' || Array.isArray(toolResponse)) return toolResponse;

  // 错误优先于 result/content 等成功字段；error 缺失但 isError=true 时使用固定兜底文本。
  if (toolResponse.error || toolResponse.isError) {
    return `Error: ${toolResponse.error || 'Unknown error'}`;
  }

  // 固定优先级兼容多个工具/旧版本使用的不同结果字段名。
  for (const key of ['result', 'content', 'message', 'output', 'stdout']) {
    // 使用 `in` 而不是 truthy 检查，保留 0、false、空字符串等合法结果。
    if (!(key in toolResponse)) continue;
    const raw = toolResponse[key];
    if (Array.isArray(raw)) {
      // Anthropic content 数组可能混合 image/tool 等 block；这里只提取明确的非空文本 block。
      const texts = raw
        .filter((item) => item && typeof item === 'object' && item.type === 'text' && item.text)
        .map((item) => item.text);
      // 不插入额外换行或空格，避免改变多个 block 原本连续的内容。
      if (texts.length > 0) return texts.join('');
    }
    // 非数组或没有可提取文本的数组，都按原始值返回并停止搜索后续候选键。
    return raw;
  }

  // 未识别包装形状时保留完整对象，交由上层序列化/内容策略决定如何处理。
  return toolResponse;
}

/**
 * 检测兼容形态的 tool response 是否明确表示失败。
 *
 * 只接受非数组对象，且 `error` 或 `isError` 至少一个为真。返回对象使用固定 `ToolError` 类型；
 * `message` 优先取 response.error 并转成字符串，仅有 isError 标记时回退为 `Unknown error`。
 * 本函数不会读取 `extractToolResult()` 的输出，两者是否同时调用由未来调用方决定。
 *
 * @param {unknown} toolResponse 工具执行器返回的原始值。
 * @returns {{message: string, type: string}|null} 标准错误对象；未识别为错误时返回 null。
 */
export function extractToolError(toolResponse) {
  // 字符串即使以 Error 开头也不在这里推断为错误，避免凭内容误判状态。
  if (!toolResponse || typeof toolResponse !== 'object' || Array.isArray(toolResponse)) return null;
  // 两个标志都为假时视为正常结果。
  if (!toolResponse.error && !toolResponse.isError) return null;
  return {
    // String() 保证下游 error.message 字段不会意外保留数字/对象等非字符串类型。
    message: String(toolResponse.error || 'Unknown error'),
    type: 'ToolError',
  };
}
