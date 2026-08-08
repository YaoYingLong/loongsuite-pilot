/**
 * 允许进入敏感字符串扫描器的字段白名单。
 *
 * 脱敏不会遍历所有事件字段，避免误改 model、Git、token 数等稳定元数据。新增可能包含用户
 * 文本、工具参数或错误详情的公共字段时，应在这里显式评估并登记。
 */

/** canonical 字段、兼容别名及已知 Agent 内容字段的精确集合。 */
export const FIELDS_TO_MASK = new Set<string>([
  'gen_ai.input.messages',
  'gen_ai.input.messages_delta',
  'gen_ai.output.messages',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'gen_ai.system_instructions',
  'gen_ai.tool.definitions',
  'error.message',

  'content',
  'inlineDiffMessage',
  'agent.content',
  'agent.inline_diff_message',

  'input.messages',
  'input.messages_delta',
  'output.messages',
  'tool.arguments',
  'tool.result',
  'tool.result.payload',
  'system_instructions',
  'tool.definitions',

  'agent._cinput',
  'agent._ctext',
  'agent._ccontent',
  'agent._cthinking',

  'error',
  'error_message',
]);

/**
 * @param field AgentActivityEntry 的顶层字段名。
 * @returns 仅当字段在审核过的白名单中时为 true。
 */
export function shouldMaskField(field: string): boolean {
  return FIELDS_TO_MASK.has(field);
}
