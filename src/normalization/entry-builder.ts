/**
 * 原始/兼容事件到 `AgentActivityEntry` 的统一构建器。
 *
 * 各 Input 可以传 canonical dotted keys，也可传历史别名；本模块负责时间、事件 ID、Provider、
 * 消息结构、工具状态和 Agent 扩展字段的最终收敛。日志型 Flusher 还通过本文件将语义值序列化
 * 为字符串宽表。这里不执行内容策略或脱敏，它们由 InputManager 在构建完成后统一处理。
 */

// uuid v4 只用于未提供确定性 event.id 的通用记录；Codex 等 builder 可提前传入稳定 ID。
import { v4 as uuidv4 } from 'uuid';
import {
  type AgentActivityEntry,
  type AgentEventName,
  type CodeGenerationEvent,
  type JsonValue,
  type SerializedLogEntry,
  ClientType,
  ActionType,
} from '../types/index.js';
import {
  normalizeOutputMessages,
  normalizeInputMessages,
  normalizeInputMessagesDelta,
} from './normalize-messages.js';

/** 旧 IDE CodeGenerationEvent 构建路径接受的 camelCase 参数。 */
export interface LegacyAgentActivityOptions {
  sessionId: string;
  userId: string;
  agentType: ClientType;
  actionType: ActionType;
  filePath: string;
  content?: string;
  inlineDiffMessage?: string;
  extra?: Record<string, unknown>;
  timestamp?: number;
}

/**
 * 新标准参数与历史 dotted alias 的并集。
 * canonical 字段优先于对应 legacy alias，最终 alias 会从 entry 删除。
 */
export type StandardAgentActivityOptions = Partial<AgentActivityEntry> & {
  'event.name'?: AgentEventName;
  'session.id'?: string;
  'turn.id'?: string;
  'step.id'?: string;
  'response.id'?: string;
  'agent.type'?: string;
  'agent.id'?: string;
  'agent.name'?: string;
  'message.role'?: string;
  'provider.name'?: string;
  'request.id'?: string;
  'request.model'?: string;
  'response.model'?: string;
  'response.finish_reasons'?: string | string[];
  'usage.input_tokens'?: number;
  'usage.output_tokens'?: number;
  'usage.cache_read_tokens'?: number;
  'usage.cache_write_tokens'?: number;
  'usage.total_tokens'?: number;
  'cost.input'?: number;
  'cost.output'?: number;
  'cost.cache_read'?: number;
  'cost.cache_write'?: number;
  'cost.total'?: number;
  'input.messages_hash'?: string;
  'input.messages_delta'?: JsonValue;
  'input.messages'?: JsonValue;
  'output.messages'?: JsonValue;
  'tool.name'?: string;
  'tool.call.id'?: string;
  'tool.exec.id'?: string;
  'tool.arguments'?: JsonValue;
  'tool.result.payload'?: JsonValue;
  'tool.result.status'?: string;
  'tool.result.duration'?: number;
  'tool.result.duration_ms'?: number;
  'skill.name'?: string;
  attributes?: { [key: string]: JsonValue };
  'user.id'?: string;
  timestamp?: number;
};

/**
 * 构建一条满足输出 Schema 的标准 Agent 活动事件。
 *
 * @param opts 旧 IDE 参数或标准 dotted 字段；旧结构会先转成 Agent 扩展字段再递归构建。
 * @returns 新的 AgentActivityEntry，不保留 legacy alias。
 */
export function buildAgentActivityEntry(
  opts: LegacyAgentActivityOptions | StandardAgentActivityOptions,
): AgentActivityEntry {
  // 旧入口先适配，不把两套字段解析逻辑散落在主构造对象中。
  if (isLegacyOptions(opts)) return buildFromLegacyOptions(opts);

  // source timestamp 缺失时使用观察时刻；observed time 始终单独记录当前时间。
  const now = opts.timestamp ?? Date.now();
  // 先展开 opts 以保留扩展字段，再用 canonical 计算值覆盖关键字段。
  const entry: AgentActivityEntry = {
    ...opts,
    time_unix_nano: opts.time_unix_nano ?? timestampToUnixNanos(now),
    observed_time_unix_nano: opts.observed_time_unix_nano ?? timestampToUnixNanos(Date.now()),
    'event.id': opts['event.id'] ?? uuidv4(),
    'event.name': normalizeEventName(opts['event.name']),
    'user.id': opts['user.id'] ?? '',
    'gen_ai.session.id': stringAlias(opts, 'gen_ai.session.id', 'session.id') ?? '',
    'gen_ai.turn.id': stringAlias(opts, 'gen_ai.turn.id', 'turn.id'),
    'gen_ai.step.id': stringAlias(opts, 'gen_ai.step.id', 'step.id'),
    'gen_ai.response.id': stringAlias(opts, 'gen_ai.response.id', 'response.id'),
    'gen_ai.agent.type': stringAlias(opts, 'gen_ai.agent.type', 'agent.type') ?? 'unknown',
    'gen_ai.agent.id': stringAlias(opts, 'gen_ai.agent.id', 'agent.id'),
    'gen_ai.agent.name': stringAlias(opts, 'gen_ai.agent.name', 'agent.name'),
    'gen_ai.provider.name': inferProviderName(opts),
    'gen_ai.request.id': stringAlias(opts, 'gen_ai.request.id', 'request.id'),
    'gen_ai.request.model': stringAlias(opts, 'gen_ai.request.model', 'request.model'),
    'gen_ai.response.model': stringAlias(opts, 'gen_ai.response.model', 'response.model'),
    'gen_ai.response.finish_reasons': normalizeFinishReasons(
      opts['gen_ai.response.finish_reasons'] ?? opts['response.finish_reasons'],
    ),
    'gen_ai.usage.input_tokens': numberAlias(opts, 'gen_ai.usage.input_tokens', 'usage.input_tokens'),
    'gen_ai.usage.output_tokens': numberAlias(opts, 'gen_ai.usage.output_tokens', 'usage.output_tokens'),
    'gen_ai.usage.cache_read.input_tokens': numberAlias(
      opts,
      'gen_ai.usage.cache_read.input_tokens',
      'usage.cache_read_tokens',
    ),
    'gen_ai.usage.cache_creation.input_tokens': numberAlias(
      opts,
      'gen_ai.usage.cache_creation.input_tokens',
      'usage.cache_write_tokens',
    ),
    'gen_ai.usage.total_tokens': numberAlias(opts, 'gen_ai.usage.total_tokens', 'usage.total_tokens'),
    'gen_ai.usage.input_cost': numberAlias(opts, 'gen_ai.usage.input_cost', 'cost.input'),
    'gen_ai.usage.output_cost': numberAlias(opts, 'gen_ai.usage.output_cost', 'cost.output'),
    'gen_ai.usage.cache_read.input_cost': numberAlias(
      opts,
      'gen_ai.usage.cache_read.input_cost',
      'cost.cache_read',
    ),
    'gen_ai.usage.cache_creation.input_cost': numberAlias(
      opts,
      'gen_ai.usage.cache_creation.input_cost',
      'cost.cache_write',
    ),
    'gen_ai.usage.total_cost': numberAlias(opts, 'gen_ai.usage.total_cost', 'cost.total'),
    'gen_ai.input.messages_hash': stringAlias(opts, 'gen_ai.input.messages_hash', 'input.messages_hash'),
    'gen_ai.input.messages_delta': jsonAlias(opts, 'gen_ai.input.messages_delta', 'input.messages_delta'),
    'gen_ai.input.messages': jsonAlias(opts, 'gen_ai.input.messages', 'input.messages'),
    'gen_ai.output.messages': jsonAlias(opts, 'gen_ai.output.messages', 'output.messages'),
    'gen_ai.tool.name': stringAlias(opts, 'gen_ai.tool.name', 'tool.name'),
    'gen_ai.tool.call.id': stringAlias(opts, 'gen_ai.tool.call.id', 'tool.call.id'),
    'gen_ai.tool.call.exec.id': stringAlias(opts, 'gen_ai.tool.call.exec.id', 'tool.exec.id'),
    'gen_ai.tool.call.arguments': jsonAlias(opts, 'gen_ai.tool.call.arguments', 'tool.arguments'),
    'gen_ai.tool.call.result': jsonAlias(opts, 'gen_ai.tool.call.result', 'tool.result.payload'),
    'gen_ai.tool.call.duration': resolveToolCallDuration(opts),
    'gen_ai.skill.name': stringAlias(opts, 'gen_ai.skill.name', 'skill.name'),
    'gen_ai.system_instructions': jsonAlias(
      opts,
      'gen_ai.system_instructions',
      'system_instructions',
    ),
    'gen_ai.tool.definitions': jsonAlias(
      opts,
      'gen_ai.tool.definitions',
      'tool.definitions',
    ),
  };
  // 以下后处理顺序很重要：先补工具失败语义和扩展字段，再规范消息，最后删除别名。
  applyLegacyToolStatus(entry, opts);
  flattenAttributes(entry, opts.attributes);
  entry['gen_ai.output.messages'] = normalizeOutputMessages(entry['gen_ai.output.messages']);
  entry['gen_ai.input.messages_delta'] = normalizeInputMessagesDelta(entry['gen_ai.input.messages_delta']);
  entry['gen_ai.input.messages'] = normalizeInputMessages(entry['gen_ai.input.messages']);
  removeLegacyAliases(entry);
  return entry;
}

/**
 * 将 IDE 层 CodeGenerationEvent 适配到兼容构建入口。
 *
 * @param event IDE 原始活动。
 * @param userId 安装配置或 InputManager 提供的用户标识。
 * @param sessionId 当前 IDE 会话标识。
 */
export function buildFromCodeGenerationEvent(
  event: CodeGenerationEvent,
  userId: string,
  sessionId: string,
): AgentActivityEntry {
  return buildAgentActivityEntry({
    sessionId,
    userId,
    agentType: event.agentType,
    actionType: event.actionType,
    filePath: event.filePath,
    content: event.content,
    inlineDiffMessage: event.diff,
    timestamp: event.sourceTimestamp,
    extra: event.rawData,
  });
}

/** redactCodeGenerationFields 必须删除的内容及旧身份字段。 */
const REDACTED_FIELDS = new Set([
  'gen_ai.input.messages_delta',
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'input.messages_delta',
  'input.messages',
  'output.messages',
  'tool.arguments',
  'tool.result.payload',
  'agent.content',
  'agent.inline_diff_message',
  'filePath', 'content', 'inlineDiffMessage',
  'recorduuid', 'distinctid',
]);

/** canonical entry 输出前需要移除的所有历史别名和构建辅助字段。 */
const LEGACY_ALIAS_FIELDS = new Set([
  'session.id',
  'turn.id',
  'step.id',
  'response.id',
  'agent.type',
  'agent.id',
  'agent.name',
  'gen_ai.message.role',
  'gen_ai.tool.call.duration_ms',
  'message.role',
  'client.channel',
  'provider.name',
  'request.id',
  'request.model',
  'response.model',
  'response.finish_reasons',
  'usage.input_tokens',
  'usage.output_tokens',
  'usage.cache_read_tokens',
  'usage.cache_write_tokens',
  'usage.total_tokens',
  'cost.input',
  'cost.output',
  'cost.cache_read',
  'cost.cache_write',
  'cost.total',
  'input.messages_hash',
  'input.messages_delta',
  'input.messages',
  'output.messages',
  'tool.name',
  'tool.exec.id',
  'tool.arguments',
  'tool.result.payload',
  'tool.result.duration',
  'tool.result.duration_ms',
  'skill.name',
  'is_error',
  'attributes',
  'sessionId',
  'timestamp',
  'uuid',
  'userId',
  'identity',
  'agentType',
  'actionType',
  'filePath',
  'content',
  'inlineDiffMessage',
  'extra',
]);

export interface SerialiseLogEntryOptions {
  /** 是否丢弃 `agent.<namespace>.*` 私有扩展；SLS/JSONL 默认开启，HTTP 保留。 */
  dropAgentScopedFields?: boolean;
}

/** 精确识别带 Agent 命名空间的扩展字段，不匹配 `agent.channel` 等公共字段。 */
const AGENT_SCOPED_FIELD_RE = /^agent\.[^.]+\..+$/;

/**
 * 将标准事件序列化为日志后端可接受的字符串宽表。
 *
 * @param entry 已完成内容策略和脱敏的标准事件。
 * @param options 可选 Agent 私有字段过滤开关。
 * @returns 新建的 Record<string,string>；不会修改原 entry。
 * @throws 对象包含不符合 JsonValue 契约的循环引用时，JSON.stringify 异常向上抛出。
 */
export function serialiseLogEntry(
  entry: AgentActivityEntry,
  options: SerialiseLogEntryOptions = {},
): SerializedLogEntry {
  const out: SerializedLogEntry = {};
  // 只遍历 entry 自身可枚举字段。
  for (const [key, value] of Object.entries(entry)) {
    // 空值以“列缺失”表达，不写文本 `null`/`undefined`。
    if (value === undefined || value === null) continue;
    // 兼容输入字段不允许泄露到对外 Schema。
    if (LEGACY_ALIAS_FIELDS.has(key)) continue;
    // 部分日志后端默认丢弃 Agent 私有扩展，HTTP 则可选择保留。
    if (options.dropAgentScopedFields && AGENT_SCOPED_FIELD_RE.test(key)) continue;
    // 标量和 JSON 容器统一收敛为字符串列。
    out[key] = serializeValue(value);
  }

  return out;
}

/**
 * 对旧 CodeGeneration 日志执行额外内容裁剪。
 *
 * 该兼容 API 处理已经序列化的记录，因此 attributes 需要先 JSON.parse 后清字段；解析失败时
 * 删除整个 attributes，避免意外保留敏感原文。
 */
export function redactCodeGenerationFields(
  serialized: SerializedLogEntry,
): SerializedLogEntry {
  const copy = { ...serialized };
  // 在副本上删除，保留调用方仍可能使用的原字典。
  for (const key of REDACTED_FIELDS) {
    delete copy[key];
  }

  if (copy.attributes) {
    try {
      const attributes = JSON.parse(copy.attributes) as Record<string, unknown>;
      delete attributes.filePath;
      delete attributes.content;
      delete attributes.inlineDiffMessage;
      copy.attributes = JSON.stringify(attributes);
    } catch {
      // 无法验证的 attributes 宁可整体删除。
      delete copy.attributes;
    }
  }
  return copy;
}

/**
 * 把秒、毫秒、纳秒数字或可解析日期字符串统一为 Unix 纳秒字符串。
 * 无效/缺失输入回退当前时间，因此本函数不会抛错。
 */
export function timestampToUnixNanos(ts: number | string | undefined): string {
  if (typeof ts === 'string') {
    const trimmed = ts.trim();
    // 16 位以上视为调用方已提供微秒/纳秒量级稳定值，原样保留。
    if (/^\d{16,}$/.test(trimmed)) return trimmed;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return timestampToUnixNanos(numeric);
    const parsed = Date.parse(trimmed);
    return timestampToUnixNanos(Number.isNaN(parsed) ? Date.now() : parsed);
  }

  const value = Number.isFinite(ts) ? (ts as number) : Date.now();
  // >=1e16 按纳秒，>=1e12 按毫秒，否则按秒扩展到纳秒。
  if (value >= 1e16) return String(Math.trunc(value));
  if (value >= 1e12) return `${Math.trunc(value)}000000`;
  return `${Math.trunc(value * 1000)}000000`;
}

/** 将纳秒/毫秒/秒量级值或日期字符串转换为 Unix 毫秒。 */
export function unixNanosToMillis(value: string | number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 1e16 ? Math.floor(value / 1_000_000) : normalizeTimestampToMillis(value);
  }
  if (typeof value !== 'string') return Date.now();
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }
  return numeric >= 1e16 ? Math.floor(numeric / 1_000_000) : normalizeTimestampToMillis(numeric);
}

/** 把旧 IDE 参数放入 agent.* 扩展字段，再交给统一构建路径。 */
function buildFromLegacyOptions(opts: LegacyAgentActivityOptions): AgentActivityEntry {
  const agentFields = toJsonObject({
    'agent.file_path': opts.filePath,
    'agent.action_type': opts.actionType,
    'agent.inline_diff_message': opts.inlineDiffMessage,
  });
  for (const [key, value] of Object.entries(toJsonObject(opts.extra ?? {}))) {
    // 调用方已经提供 agent. 前缀时不重复添加。
    const agentKey = key.startsWith('agent.') ? key : `agent.${key}`;
    if (agentFields[agentKey] === undefined) agentFields[agentKey] = value;
  }
  if (opts.content !== undefined) agentFields['agent.content'] = opts.content;

  return buildAgentActivityEntry({
    ...agentFields,
    timestamp: opts.timestamp,
    'session.id': opts.sessionId,
    'user.id': opts.userId,
    'agent.type': opts.agentType,
    'event.name': 'other',
  });
}

/** 通过旧结构特有的 camelCase key 做联合类型收窄。 */
function isLegacyOptions(
  opts: LegacyAgentActivityOptions | StandardAgentActivityOptions,
): opts is LegacyAgentActivityOptions {
  return 'sessionId' in opts || 'agentType' in opts || 'actionType' in opts;
}

/** 12 位以下按 Unix 秒处理，否则视为毫秒。 */
function normalizeTimestampToMillis(ts: number): number {
  if (ts < 1e12) return ts * 1000;
  return ts;
}

/** 日志后端字符串序列化：字符串直通，容器 JSON 化，其他标量 String 化。 */
function serializeValue(value: JsonValue): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 将各 Agent 的旧事件名映射到七种标准事件；未知值降级为 other。 */
export function normalizeEventName(value: unknown): AgentEventName {
  switch (value) {
    case 'llm.request':
    case 'llm_call_input':
      return 'llm.request';
    case 'llm.response':
    case 'llm_call_output':
    case 'llm_call_thinking':
      return 'llm.response';
    case 'tool.call':
    case 'tool_call_input':
      return 'tool.call';
    case 'tool.result':
    case 'tool_call_output':
      return 'tool.result';
    case 'skill.use':
    case 'skill_use':
      return 'skill.use';
    case 'tool.approve':
      return 'tool.approve';
    case 'event':
    case 'other':
    default:
      return 'other';
  }
}

/** 将单个 finish reason 或字符串数组统一为非空字符串数组。 */
export function normalizeFinishReasons(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const values = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
    return values.length > 0 ? values : undefined;
  }
  return typeof value === 'string' && value.length > 0 ? [value] : undefined;
}

/**
 * 按“显式 provider > model 特征 > agent type 特征 > unknown”推断 Provider。
 * 显式字段始终优先，避免代理/私有模型名称被启发式覆盖。
 */
export function inferProviderName(input: Record<string, unknown>): string {
  const explicit = stringAlias(input, 'gen_ai.provider.name', 'provider.name');
  if (explicit) return explicit;

  const model = (
    stringAlias(input, 'gen_ai.request.model', 'request.model') ??
    stringAlias(input, 'gen_ai.response.model', 'response.model') ??
    ''
  ).toLowerCase();
  if (/claude|anthropic/.test(model)) return 'anthropic';
  if (/gpt|openai|codex/.test(model)) return 'openai';
  if (/qwen|tongyi/.test(model)) return 'qwen';
  if (/deepseek/.test(model)) return 'deepseek';
  if (/gemini/.test(model)) return 'gcp.gemini';
  if (/grok|xai|x_ai/.test(model)) return 'x_ai';

  const agentType = (
    stringAlias(input, 'gen_ai.agent.type', 'agent.type') ??
    ''
  ).toLowerCase();
  if (agentType.includes('codex')) return 'openai';
  if (agentType.includes('claude')) return 'anthropic';
  if (agentType.includes('qoder') || agentType.includes('qwen')) return 'qwen';
  if (agentType.includes('gemini')) return 'gcp.gemini';
  return 'unknown';
}

/** canonical/legacy 二选一的非空字符串读取器。 */
function stringAlias(input: Record<string, unknown>, canonical: string, legacy: string): string | undefined {
  const value = input[canonical] ?? input[legacy];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** canonical/legacy 二选一的有限数字读取器。 */
function numberAlias(input: Record<string, unknown>, canonical: string, legacy: string): number | undefined {
  const value = input[canonical] ?? input[legacy];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 按 canonical、新旧毫秒别名的优先级取得工具耗时。 */
function resolveToolCallDuration(input: Record<string, unknown>): number | undefined {
  const value = input['gen_ai.tool.call.duration']
    ?? input['gen_ai.tool.call.duration_ms']
    ?? input['tool.result.duration']
    ?? input['tool.result.duration_ms'];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 读取 canonical/legacy 值并递归收敛为 JsonValue。 */
function jsonAlias(input: Record<string, unknown>, canonical: string, legacy: string): JsonValue | undefined {
  return toJsonValue(input[canonical] ?? input[legacy]);
}

/** 从已构建 entry 删除兼容输入字段，只保留对外 Schema。 */
function removeLegacyAliases(entry: AgentActivityEntry): void {
  for (const key of LEGACY_ALIAS_FIELDS) {
    delete entry[key];
  }
}

/** 规范旧 tool.result.status；失败结果至少补一个低基数 error.type。 */
function applyLegacyToolStatus(
  entry: AgentActivityEntry,
  opts: StandardAgentActivityOptions,
): void {
  const status = typeof opts['tool.result.status'] === 'string'
    ? opts['tool.result.status'].toLowerCase()
    : undefined;
  if (!status) return;

  const normalizedStatus = normalizeToolResultStatus(status);
  entry['tool.result.status'] = normalizedStatus;
  if (normalizedStatus === 'failure') {
    entry['error.type'] = entry['error.type'] ?? '_OTHER';
  }
}

/** 将 completed/failed/canceled 等源端拼写收敛为稳定状态。 */
function normalizeToolResultStatus(status: string): 'success' | 'failure' | 'cancelled' | 'unknown' {
  if (status === 'success' || status === 'completed') return 'success';
  if (status === 'failure' || status === 'failed' || status === 'error') return 'failure';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  return 'unknown';
}

/** 将 attributes 展平到 agent.*，且不覆盖已经存在的显式字段。 */
function flattenAttributes(
  entry: AgentActivityEntry,
  attributes: { [key: string]: JsonValue } | undefined,
): void {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return;
  for (const [key, value] of Object.entries(attributes)) {
    const targetKey = key.startsWith('agent.') ? key : `agent.${key}`;
    if (entry[targetKey] === undefined) entry[targetKey] = value;
  }
}

/** 递归过滤 undefined，把普通 unknown 对象转换为 JSON 安全对象。 */
function toJsonObject(value: Record<string, unknown>): { [key: string]: JsonValue } {
  const out: { [key: string]: JsonValue } = {};
  for (const [key, raw] of Object.entries(value)) {
    const json = toJsonValue(raw);
    if (json !== undefined) out[key] = json;
  }
  return out;
}

/**
 * 将任意运行时值递归转换为 JsonValue。
 * undefined 被丢弃，函数/Symbol/BigInt 等非 JSON 值最终转成字符串。
 */
export function toJsonValue(value: unknown): JsonValue | undefined {
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
