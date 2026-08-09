/**
 * 多个 Hook JSONL Input 共用的 canonical 字段转换。
 *
 * Claude、OpenCode、Pi、Qwen 等源记录字段接近统一 Schema；本函数处理新旧别名、JSON 内容、
 * token/tool/error 字段，再调用 Git enrich。返回值已是 AgentActivityEntry，但 user/content/mask
 * 仍由 InputManager 在更上层统一处理。
 */

// ClientType 是运行时枚举，需要普通 import；下行两个接口只参与编译，因此使用 type import。
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry, AgentEventName } from '../../types/index.js';
// EntryBuilder 集中补齐时间、ID 和默认字段，避免每个 Hook Input 各自实现一套 Schema。
import { buildAgentActivityEntry, normalizeEventName, toJsonValue } from '../../normalization/entry-builder.js';
// Git enrich 可能创建短生命周期 git 子进程；它内部 fail-open，因此不影响主转换结果。
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';

/** 从 record 读取非空字符串。 */
function getStringValue(data: Record<string, unknown>, key: string): string | undefined {
  // 不做 String(val) 强制转换，防止对象被静默变成 `[object Object]` 污染标准字段。
  const val = data[key];
  return typeof val === 'string' && val.length > 0 ? val : undefined;
}

/** 从 record 读取有限数字，过滤 NaN/Infinity。 */
function getNumberValue(data: Record<string, unknown>, key: string): number | undefined {
  // JSON 中的数字字符串不会在这里隐式转数值；来源必须给出真正 number 才能进入 token 字段。
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
 * @throws 正常坏记录不会抛出；只有 EntryBuilder 或 Git enrich 未按约定处理的意外异常才会
 * 随 Promise reject 传播给 BaseHookInput，由 Input 轮询边界记录该行处理失败。
 *
 * 副作用：转换本身不改写 record；Git enrich 可能执行只读 `git -C` 子进程并更新短时缓存。
 */
export async function transformHookRecord(
  record: Record<string, unknown>,
  agentType: ClientType,
  gitNamespace: string,
): Promise<AgentActivityEntry | null> {
  const rawEventName = getStringValue(record, 'event.name');
  // event.name 是统一事件的最低要求，缺失记录无法安全分类。
  if (!rawEventName) return null;
  // 旧 Hook 的事件别名在进入 EntryBuilder 前统一映射到 AgentEventName 集合。
  const eventName = normalizeEventName(rawEventName);

  const entry = buildAgentActivityEntry({
    // 先展开原记录保留 Agent 扩展，后续显式字段按 canonical/legacy 优先级覆盖。
    ...record,
    // 时间、事件与身份字段直接使用 canonical 名；EntryBuilder 负责缺省时间/ID。
    time_unix_nano: getStringValue(record, 'time_unix_nano'),
    observed_time_unix_nano: getStringValue(record, 'observed_time_unix_nano'),
    'event.id': getStringValue(record, 'event.id'),
    'event.name': eventName as AgentEventName,
    'user.id': getStringValue(record, 'user.id') ?? '',
    // 对新旧字段使用 `??`：canonical 值只要存在就优先，legacy 仅用于兼容历史 Hook。
    'gen_ai.session.id': getStringValue(record, 'gen_ai.session.id') ?? getStringValue(record, 'session.id') ?? '',
    'gen_ai.turn.id': getStringValue(record, 'gen_ai.turn.id') ?? getStringValue(record, 'turn.id'),
    'gen_ai.step.id': getStringValue(record, 'gen_ai.step.id') ?? getStringValue(record, 'step.id'),
    // Agent 类型由具体 Input 固定注入，不能信任日志内可能过时或伪造的 agent.type。
    'gen_ai.agent.type': agentType,
    'gen_ai.provider.name': getStringValue(record, 'gen_ai.provider.name') ?? getStringValue(record, 'provider.name'),
    'gen_ai.request.model': getStringValue(record, 'gen_ai.request.model') ?? getStringValue(record, 'request.model'),
    'gen_ai.response.model': getStringValue(record, 'gen_ai.response.model') ?? getStringValue(record, 'response.model'),
    'response.finish_reasons': getStringValue(record, 'response.finish_reasons'),
    // token 字段接受 canonical 和早期 usage.* 别名；每项独立缺省，不推算不存在的总量。
    'gen_ai.usage.input_tokens': getNumberValue(record, 'gen_ai.usage.input_tokens') ?? getNumberValue(record, 'usage.input_tokens'),
    'gen_ai.usage.output_tokens': getNumberValue(record, 'gen_ai.usage.output_tokens') ?? getNumberValue(record, 'usage.output_tokens'),
    'gen_ai.usage.cache_read.input_tokens': getNumberValue(record, 'gen_ai.usage.cache_read.input_tokens') ?? getNumberValue(record, 'usage.cache_read_tokens'),
    'gen_ai.usage.total_tokens': getNumberValue(record, 'gen_ai.usage.total_tokens') ?? getNumberValue(record, 'usage.total_tokens'),
    // 消息、工具参数和结果可能是对象/数组，toJsonValue 会限制为可序列化 JsonValue。
    'gen_ai.input.messages_hash': getStringValue(record, 'gen_ai.input.messages_hash') ?? getStringValue(record, 'input.messages_hash'),
    'gen_ai.input.messages_delta': toJsonValue(record['gen_ai.input.messages_delta'] ?? record['input.messages_delta']),
    'gen_ai.input.messages': toJsonValue(record['gen_ai.input.messages'] ?? record['input.messages']),
    'gen_ai.output.messages': toJsonValue(record['gen_ai.output.messages'] ?? record['output.messages']),
    'gen_ai.tool.name': getStringValue(record, 'gen_ai.tool.name') ?? getStringValue(record, 'tool.name'),
    'gen_ai.tool.call.id': getStringValue(record, 'gen_ai.tool.call.id') ?? getStringValue(record, 'tool.call.id'),
    'gen_ai.tool.call.arguments': toJsonValue(record['gen_ai.tool.call.arguments'] ?? record['tool.arguments']),
    'gen_ai.tool.call.result': toJsonValue(record['gen_ai.tool.call.result'] ?? record['tool.result']),
    'tool.result.status': getStringValue(record, 'tool.result.status'),
    // duration 兼容四个历史名称，但不在此处统一单位；当前 Hook 协议约定传入毫秒值。
    'gen_ai.tool.call.duration': getNumberValue(record, 'gen_ai.tool.call.duration')
      ?? getNumberValue(record, 'gen_ai.tool.call.duration_ms')
      ?? getNumberValue(record, 'tool.result.duration')
      ?? getNumberValue(record, 'tool.result.duration_ms'),
    'gen_ai.system_instructions': toJsonValue(record['gen_ai.system_instructions']),
    'gen_ai.tool.definitions': toJsonValue(record['gen_ai.tool.definitions']),
    // 错误字段保持来源语义；本转换器不会根据 tool.result.status 人工制造 Error。
    'error.type': getStringValue(record, 'error.type'),
    'error.message': getStringValue(record, 'error.message'),
  });
  if (entry) {
    // enrich 是异步 Git 子进程调用，但失败在工具层 fail-open。
    await enrichCanonicalEntryWithGit(entry as Record<string, unknown>, record, gitNamespace);
  }
  return entry;
}
