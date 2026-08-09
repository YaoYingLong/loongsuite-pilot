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
  /** IDE 会话标识，适配后写入 `gen_ai.session.id`。 */
  sessionId: string;
  /** 安装/登录用户标识，适配后写入 `user.id`。 */
  userId: string;
  /** 旧版 ClientType 枚举值。 */
  agentType: ClientType;
  /** IDE 行为枚举，保留在 `agent.action_type` 扩展字段。 */
  actionType: ActionType;
  /** 发生代码活动的文件路径。 */
  filePath: string;
  /** 可选代码/消息正文；后续仍受内容策略和脱敏控制。 */
  content?: string;
  /** 可选 inline diff 原文。 */
  inlineDiffMessage?: string;
  /** IDE 私有补充字段，会转成 `agent.*` 扩展。 */
  extra?: Record<string, unknown>;
  /** 源事件毫秒时间戳；缺失时使用构建时刻。 */
  timestamp?: number;
}

/**
 * 新标准参数与历史 dotted alias 的并集。
 * canonical 字段优先于对应 legacy alias，最终 alias 会从 entry 删除。
 */
export type StandardAgentActivityOptions = Partial<AgentActivityEntry> & {
  /** 旧事件名和 session/turn/step/response 层级别名。 */
  'event.name'?: AgentEventName;
  'session.id'?: string;
  'turn.id'?: string;
  'step.id'?: string;
  'response.id'?: string;
  /** 旧 Agent 身份、消息角色和 Provider/模型别名。 */
  'agent.type'?: string;
  'agent.id'?: string;
  'agent.name'?: string;
  'message.role'?: string;
  'provider.name'?: string;
  'request.id'?: string;
  'request.model'?: string;
  'response.model'?: string;
  'response.finish_reasons'?: string | string[];
  /** 旧 token 统计字段；数值口径由源端决定，builder 只迁移名称。 */
  'usage.input_tokens'?: number;
  'usage.output_tokens'?: number;
  'usage.cache_read_tokens'?: number;
  'usage.cache_write_tokens'?: number;
  'usage.total_tokens'?: number;
  /** 旧成本字段；builder 不根据 token 重新计价。 */
  'cost.input'?: number;
  'cost.output'?: number;
  'cost.cache_read'?: number;
  'cost.cache_write'?: number;
  'cost.total'?: number;
  /** 旧输入/输出消息字段；接受 JsonValue 是为了兼容不同 Agent 的消息数组形状。 */
  'input.messages_hash'?: string;
  'input.messages_delta'?: JsonValue;
  'input.messages'?: JsonValue;
  'output.messages'?: JsonValue;
  /** 旧工具调用/结果字段；call.id 用于配对，exec.id 标识具体执行。 */
  'tool.name'?: string;
  'tool.call.id'?: string;
  'tool.exec.id'?: string;
  'tool.arguments'?: JsonValue;
  'tool.result.payload'?: JsonValue;
  'tool.result.status'?: string;
  'tool.result.duration'?: number;
  'tool.result.duration_ms'?: number;
  /** 旧技能名、Agent 私有属性、用户身份和毫秒时间。 */
  'skill.name'?: string;
  attributes?: { [key: string]: JsonValue };
  'user.id'?: string;
  timestamp?: number;
};

/**
 * 构建一条满足输出 Schema 的标准 Agent 活动事件。
 *
 * 构建顺序是：识别 legacy 结构 -> 复制扩展字段 -> 用 canonical/alias 优先级覆盖标准字段 ->
 * 规范工具状态和消息结构 -> 删除所有兼容别名。函数只做同步内存转换，不读写文件、不调用
 * 网络，也不执行内容开关或敏感信息脱敏。
 *
 * 未提供 `event.id` 时生成 UUID v4，因此通用调用默认不具备重放去重能力；需要确定性 ID 的
 * Input 应在 opts 中提前提供。源时间与观察时间分开计算，便于衡量采集延迟。
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
    // 时间和事件身份字段是所有事件的公共外壳。源端未提供稳定 event.id 时只能生成随机 UUID。
    time_unix_nano: opts.time_unix_nano ?? timestampToUnixNanos(now),
    observed_time_unix_nano: opts.observed_time_unix_nano ?? timestampToUnixNanos(Date.now()),
    'event.id': opts['event.id'] ?? uuidv4(),
    'event.name': normalizeEventName(opts['event.name']),
    'user.id': opts['user.id'] ?? '',
    // session -> turn -> step -> response 构成业务层级；每一级都优先读取新 gen_ai.* 名称，
    // 再兼容旧短名称。只有 session 是 Schema 必填项，所以其缺失值收敛为空字符串。
    'gen_ai.session.id': stringAlias(opts, 'gen_ai.session.id', 'session.id') ?? '',
    'gen_ai.turn.id': stringAlias(opts, 'gen_ai.turn.id', 'turn.id'),
    'gen_ai.step.id': stringAlias(opts, 'gen_ai.step.id', 'step.id'),
    'gen_ai.response.id': stringAlias(opts, 'gen_ai.response.id', 'response.id'),
    'gen_ai.agent.type': stringAlias(opts, 'gen_ai.agent.type', 'agent.type') ?? 'unknown',
    'gen_ai.agent.id': stringAlias(opts, 'gen_ai.agent.id', 'agent.id'),
    'gen_ai.agent.name': stringAlias(opts, 'gen_ai.agent.name', 'agent.name'),
    // provider 允许从显式字段或模型名称推断；request/response 模型分开保留，可观察路由切换。
    'gen_ai.provider.name': inferProviderName(opts),
    'gen_ai.request.id': stringAlias(opts, 'gen_ai.request.id', 'request.id'),
    'gen_ai.request.model': stringAlias(opts, 'gen_ai.request.model', 'request.model'),
    'gen_ai.response.model': stringAlias(opts, 'gen_ai.response.model', 'response.model'),
    'gen_ai.response.finish_reasons': normalizeFinishReasons(
      opts['gen_ai.response.finish_reasons'] ?? opts['response.finish_reasons'],
    ),
    // token 数量按输入、输出、缓存读取、缓存创建和总量分别映射；builder 不自行重算总量，
    // 因为不同 Provider 对 reasoning/cache token 的计费口径并不一致。
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
    // 成本字段与 token 字段一一对应，但仅做类型收窄和别名迁移，不在这里套用价格表。
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
    // hash 用于不采集正文时关联上下文；delta 表示本 step 新增内容，messages 表示完整上下文。
    'gen_ai.input.messages_hash': stringAlias(opts, 'gen_ai.input.messages_hash', 'input.messages_hash'),
    'gen_ai.input.messages_delta': jsonAlias(opts, 'gen_ai.input.messages_delta', 'input.messages_delta'),
    'gen_ai.input.messages': jsonAlias(opts, 'gen_ai.input.messages', 'input.messages'),
    'gen_ai.output.messages': jsonAlias(opts, 'gen_ai.output.messages', 'output.messages'),
    // tool.call 与 tool.result 通过 call.id 配对，exec.id 用于区分同一调用的具体执行实例。
    'gen_ai.tool.name': stringAlias(opts, 'gen_ai.tool.name', 'tool.name'),
    'gen_ai.tool.call.id': stringAlias(opts, 'gen_ai.tool.call.id', 'tool.call.id'),
    'gen_ai.tool.call.exec.id': stringAlias(opts, 'gen_ai.tool.call.exec.id', 'tool.exec.id'),
    'gen_ai.tool.call.arguments': jsonAlias(opts, 'gen_ai.tool.call.arguments', 'tool.arguments'),
    'gen_ai.tool.call.result': jsonAlias(opts, 'gen_ai.tool.call.result', 'tool.result.payload'),
    // 时长可能来自多个历史字段，统一解析逻辑集中在 resolveToolCallDuration()。
    'gen_ai.tool.call.duration': resolveToolCallDuration(opts),
    'gen_ai.skill.name': stringAlias(opts, 'gen_ai.skill.name', 'skill.name'),
    // system instructions 与工具定义属于请求上下文，只接受可 JSON 序列化结构。
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
 * @returns 由统一 builder 生成的新事件；`rawData` 会被收敛到 `agent.*` 扩展字段。
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
  // 旧版会话层级和 Agent 身份字段；对应值已迁入 gen_ai.*。
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
  // Provider、请求、响应和 finish reason 的旧短名称。
  'provider.name',
  'request.id',
  'request.model',
  'response.model',
  'response.finish_reasons',
  // token 与成本旧字段；保留它们会导致同一指标出现两套列名。
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
  // 输入、输出及工具交互旧字段；内容已经规范化到 gen_ai 消息/工具结构。
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
  // 构建过程使用的错误标志、attributes 包装和旧 IDE 平铺字段，不属于最终 Schema。
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

/** 日志宽表序列化的可选字段过滤策略。 */
export interface SerialiseLogEntryOptions {
  /** 是否丢弃 `agent.<namespace>.*` 私有扩展；SLS/JSONL 默认开启，HTTP 保留。 */
  dropAgentScopedFields?: boolean;
}

/** 精确识别带 Agent 命名空间的扩展字段，不匹配 `agent.channel` 等公共字段。 */
const AGENT_SCOPED_FIELD_RE = /^agent\.[^.]+\..+$/;

/**
 * 将标准事件序列化为日志后端可接受的字符串宽表。
 *
 * JavaScript 对象/数组通过 JSON.stringify 保持结构，字符串不重复加引号，数字和布尔值通过
 * String 转换。undefined/null 代表列缺失。函数创建新对象，适合同一 entry 被多个 Flusher
 * 分别序列化；它本身不做脱敏，调用前必须经过 InputManager 的内容策略和 masker。
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
 *
 * @param serialized 字符串宽表；函数不会修改传入对象。
 * @returns 删除正文、文件路径和旧身份字段后的浅拷贝。
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
 *
 * 阈值是兼容性启发式而非精确单位标记：16 位以上数字字符串原样保留，数字值则按数量级
 * 判断。调用方若掌握明确单位，应优先传标准 `time_unix_nano`，避免边界年份被误分类。
 *
 * @returns 十进制整数字符串，便于避免 JavaScript number 表示纳秒时的精度损失。
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

/**
 * 将纳秒/毫秒/秒量级值或日期字符串转换为 Unix 毫秒。
 * 无效值与缺失值回退当前时间；纳秒除以 1,000,000 并向下取整。
 */
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

/**
 * 将各 Agent 的旧事件名映射到七种标准事件；未知值降级为 `other`。
 * 该降级保证事件仍可输出，但调用方若需要保留源类型应另写 Agent 扩展字段。
 */
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
 *
 * 判断只做字符串小写和正则匹配，不访问模型注册表；新模型未命中时稳定返回 unknown。
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
 *
 * 普通对象递归复制、数组逐项转换并过滤 undefined，因此返回值不与输入共享对象容器。
 * 本函数不检测循环引用；循环对象会递归溢出，调用方应只传 JSON 类数据。
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
