/**
 * 多个 Hook JSONL Input 共用的 canonical 字段转换。
 *
 * Claude、OpenCode、Pi、Qwen 等源记录字段接近统一 Schema；本函数处理新旧别名、JSON 内容、
 * token/tool/error 字段，再调用 Git enrich。返回值已是 AgentActivityEntry，但 user/content/mask
 * 仍由 InputManager 在更上层统一处理。
 */

import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry, AgentEventName } from '../../types/index.js';
import { buildAgentActivityEntry, normalizeEventName, toJsonValue } from '../../normalization/entry-builder.js';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';

/** 从 record 读取非空字符串。 */
function getStringValue(data: Record<string, unknown>, key: string): string | undefined {
  const val = data[key];
  return typeof val === 'string' && val.length > 0 ? val : undefined;
}

/** 从 record 读取有限数字，过滤 NaN/Infinity。 */
function getNumberValue(data: Record<string, unknown>, key: string): number | undefined {
  const val = data[key];
  return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
}

/**
 * 转换 Hook 记录并按指定 Agent namespace 补齐 Git/workspace。
 *
 * @param record 已解析的一行 Hook JSON。
 * @param agentType 调用方固定 ClientType，覆盖源端可能过时的类型。
 * @param gitNamespace 查找 `agent.<namespace>.cwd/workspace_roots` 的命名空间。
 * @returns 标准事件；没有 event.name 时返回 null。
 */
export async function transformHookRecord(
  record: Record<string, unknown>,
  agentType: ClientType,
  gitNamespace: string,
): Promise<AgentActivityEntry | null> {
  const rawEventName = getStringValue(record, 'event.name');
  // event.name 是统一事件的最低要求，缺失记录无法安全分类。
  if (!rawEventName) return null;
  const eventName = normalizeEventName(rawEventName);

  const entry = buildAgentActivityEntry({
    // 先展开原记录保留 Agent 扩展，后续显式字段按 canonical/legacy 优先级覆盖。
    ...record,
    time_unix_nano: getStringValue(record, 'time_unix_nano'),
    observed_time_unix_nano: getStringValue(record, 'observed_time_unix_nano'),
    'event.id': getStringValue(record, 'event.id'),
    'event.name': eventName as AgentEventName,
    'user.id': getStringValue(record, 'user.id') ?? '',
    'gen_ai.session.id': getStringValue(record, 'gen_ai.session.id') ?? getStringValue(record, 'session.id') ?? '',
    'gen_ai.turn.id': getStringValue(record, 'gen_ai.turn.id') ?? getStringValue(record, 'turn.id'),
    'gen_ai.step.id': getStringValue(record, 'gen_ai.step.id') ?? getStringValue(record, 'step.id'),
    'gen_ai.agent.type': agentType,
    'gen_ai.provider.name': getStringValue(record, 'gen_ai.provider.name') ?? getStringValue(record, 'provider.name'),
    'gen_ai.request.model': getStringValue(record, 'gen_ai.request.model') ?? getStringValue(record, 'request.model'),
    'gen_ai.response.model': getStringValue(record, 'gen_ai.response.model') ?? getStringValue(record, 'response.model'),
    'response.finish_reasons': getStringValue(record, 'response.finish_reasons'),
    'gen_ai.usage.input_tokens': getNumberValue(record, 'gen_ai.usage.input_tokens') ?? getNumberValue(record, 'usage.input_tokens'),
    'gen_ai.usage.output_tokens': getNumberValue(record, 'gen_ai.usage.output_tokens') ?? getNumberValue(record, 'usage.output_tokens'),
    'gen_ai.usage.cache_read.input_tokens': getNumberValue(record, 'gen_ai.usage.cache_read.input_tokens') ?? getNumberValue(record, 'usage.cache_read_tokens'),
    'gen_ai.usage.total_tokens': getNumberValue(record, 'gen_ai.usage.total_tokens') ?? getNumberValue(record, 'usage.total_tokens'),
    'gen_ai.input.messages_hash': getStringValue(record, 'gen_ai.input.messages_hash') ?? getStringValue(record, 'input.messages_hash'),
    'gen_ai.input.messages_delta': toJsonValue(record['gen_ai.input.messages_delta'] ?? record['input.messages_delta']),
    'gen_ai.input.messages': toJsonValue(record['gen_ai.input.messages'] ?? record['input.messages']),
    'gen_ai.output.messages': toJsonValue(record['gen_ai.output.messages'] ?? record['output.messages']),
    'gen_ai.tool.name': getStringValue(record, 'gen_ai.tool.name') ?? getStringValue(record, 'tool.name'),
    'gen_ai.tool.call.id': getStringValue(record, 'gen_ai.tool.call.id') ?? getStringValue(record, 'tool.call.id'),
    'gen_ai.tool.call.arguments': toJsonValue(record['gen_ai.tool.call.arguments'] ?? record['tool.arguments']),
    'gen_ai.tool.call.result': toJsonValue(record['gen_ai.tool.call.result'] ?? record['tool.result']),
    'tool.result.status': getStringValue(record, 'tool.result.status'),
    'gen_ai.tool.call.duration': getNumberValue(record, 'gen_ai.tool.call.duration')
      ?? getNumberValue(record, 'gen_ai.tool.call.duration_ms')
      ?? getNumberValue(record, 'tool.result.duration')
      ?? getNumberValue(record, 'tool.result.duration_ms'),
    'gen_ai.system_instructions': toJsonValue(record['gen_ai.system_instructions']),
    'gen_ai.tool.definitions': toJsonValue(record['gen_ai.tool.definitions']),
    'error.type': getStringValue(record, 'error.type'),
    'error.message': getStringValue(record, 'error.message'),
  });
  if (entry) {
    // enrich 是异步 Git 子进程调用，但失败在工具层 fail-open。
    await enrichCanonicalEntryWithGit(entry as Record<string, unknown>, record, gitNamespace);
  }
  return entry;
}
