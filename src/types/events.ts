/**
 * 采集事件的核心类型契约。
 *
 * 各 Input 先把 Agent 原生数据转换成 `AgentActivityEntry`，随后 InputManager 对它应用内容策略
 * 与脱敏，最后交给全部 Flusher。该文件只在 TypeScript 编译期提供约束，不产生运行时代码，
 * 但 dotted key 名必须与输出 Schema 和 Trace 转换器保持一致。
 */

import { ClientType } from './client-type.js';

/** IDE 代码活动在进入统一事件前使用的粗粒度动作分类。 */
export enum ActionType {
  Create = 'create',
  Edit = 'edit',
  Delete = 'delete',
  Read = 'read',
  Search = 'search',
  Execute = 'execute',
  Browse = 'browse',
  Other = 'other',
}

/** Pilot 对外稳定支持的标准事件名称。 */
export type AgentEventName =
  | 'llm.request'
  | 'llm.response'
  | 'tool.call'
  | 'tool.result'
  | 'skill.use'
  | 'tool.approve'
  | 'other';

/**
 * JSON 可无损序列化的递归值集合。
 * 明确排除 undefined、BigInt、函数和循环引用，保证事件可直接交给 JSONL/HTTP/SLS 输出层。
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * 所有 Input 共用的统一 AI Agent 活动事件。
 *
 * dotted key 有意与 SLS 宽表及 GenAI 语义字段保持一致，使日志序列化无需再做一层字段投影。
 * 字符串索引允许 Agent 扩展字段，但公共字段应优先使用这里的显式声明。
 */
export interface AgentActivityEntry {
  /** 允许 dotted 扩展字段；undefined 表示该源事件没有此信息。 */
  [key: string]: JsonValue | undefined;

  /** 来源事件发生时间，Unix epoch 纳秒十进制字符串；用字符串避免超过 JS 安全整数。 */
  time_unix_nano: string;
  /** Pilot 观察/采集到事件的 Unix 纳秒时间；来源未提供时可缺省。 */
  observed_time_unix_nano?: string;
  /** 全局事件标识；EntryBuilder 会在来源缺失时生成。 */
  'event.id': string;
  /** 配置的用户标识；可能为空字符串但字段始终存在。 */
  'user.id': string;
  /** 归一化后的事件类别，决定 Trace 转换和指标计数方式。 */
  'event.name': AgentEventName;
  /** 可选 OpenTelemetry Trace ID，通常为 32 位十六进制文本。 */
  trace_id?: string;
  /** 当前事件对应的 Span ID。 */
  span_id?: string;
  /** 上游或当前会话中父 Span 的 ID。 */
  parent_span_id?: string;
  /** 来源主机名。 */
  'host.name'?: string;
  /** 来源主机 IP。 */
  'host.ip'?: string;
  /** 事件所属逻辑服务名。 */
  'service.name'?: string;
  /** Agent 会话 ID；缺失来源会使用空字符串或生成策略补齐。 */
  'gen_ai.session.id': string;
  /** 会话内一次用户回合的标识。 */
  'gen_ai.turn.id'?: string;
  /** 回合内模型/工具步骤标识。 */
  'gen_ai.step.id'?: string;
  /** Provider 返回的响应 ID。 */
  'gen_ai.response.id'?: string;
  /** 稳定 Agent 产品 ID，通常来自 ClientType 枚举值。 */
  'gen_ai.agent.type': string;
  /** Agent 实例 ID；同一产品可能有多个实例。 */
  'gen_ai.agent.id'?: string;
  /** 面向用户展示的 Agent 实例名。 */
  'gen_ai.agent.name'?: string;
  /** 模型 Provider 名；EntryBuilder 保证字段存在，无法识别时使用约定兜底。 */
  'gen_ai.provider.name': string;
  /** 来源侧请求 ID。 */
  'gen_ai.request.id'?: string;
  /** 请求时指定的模型名。 */
  'gen_ai.request.model'?: string;
  /** 响应实际使用的模型名，可能与请求模型不同。 */
  'gen_ai.response.model'?: string;
  /** Provider 报告的结束原因数组，例如 stop；不要与旧版单数字段混用。 */
  'gen_ai.response.finish_reasons'?: string[];
  /** 请求输入 token 数。 */
  'gen_ai.usage.input_tokens'?: number;
  /** 响应输出 token 数。 */
  'gen_ai.usage.output_tokens'?: number;
  /** 输入中命中缓存的 token 数。 */
  'gen_ai.usage.cache_read.input_tokens'?: number;
  /** 本次请求新写入缓存的 token 数。 */
  'gen_ai.usage.cache_creation.input_tokens'?: number;
  /** 来源报告或归一化层计算的总 token 数。 */
  'gen_ai.usage.total_tokens'?: number;
  /** 输入 token 成本；币种和单位由来源协议约定。 */
  'gen_ai.usage.input_cost'?: number;
  /** 输出 token 成本。 */
  'gen_ai.usage.output_cost'?: number;
  /** 缓存读取成本。 */
  'gen_ai.usage.cache_read.input_cost'?: number;
  /** 缓存创建成本。 */
  'gen_ai.usage.cache_creation.input_cost'?: number;
  /** 来源报告或归一化层计算的总成本。 */
  'gen_ai.usage.total_cost'?: number;
  /** 输入消息上下文的内容哈希，用于增量/去重而不暴露正文。 */
  'gen_ai.input.messages_hash'?: string;
  /** 相对上次上下文新增的 canonical Message 数组。 */
  'gen_ai.input.messages_delta'?: JsonValue;
  /** 完整输入消息；是否保留受 Agent 内容策略控制。 */
  'gen_ai.input.messages'?: JsonValue;
  /** 模型输出消息；是否保留受 Agent 内容策略控制。 */
  'gen_ai.output.messages'?: JsonValue;
  /** 被调用的工具名称。 */
  'gen_ai.tool.name'?: string;
  /** 将 tool.call 与 tool.result 配对的调用 ID。 */
  'gen_ai.tool.call.id'?: string;
  /** 一次调用的执行实例 ID；重试时可与 call.id 不同。 */
  'gen_ai.tool.call.exec.id'?: string;
  /** 结构化工具入参。 */
  'gen_ai.tool.call.arguments'?: JsonValue;
  /** 结构化或文本工具结果。 */
  'gen_ai.tool.call.result'?: JsonValue;
  /** 工具调用耗时；当前采集协议通常使用毫秒。 */
  'gen_ai.tool.call.duration'?: number;
  /** 工具结果状态，例如 success/failure。 */
  'tool.result.status'?: string;
  /** skill.use 事件使用的 Skill 名称。 */
  'gen_ai.skill.name'?: string;
  /**
   * 模型的 system instructions（MessagePart[] 数组形式），数据源为 codex transcript 的
   * `session_meta.payload.base_instructions.text` + `turn_context.payload.developer_instructions`。
   * 仅 Codex 端有值；Claude transcript 不含此数据。
   */
  'gen_ai.system_instructions'?: JsonValue;
  /**
   * 模型可用的工具定义集合（FunctionToolDefinition[] 数组形式），数据源为 codex transcript
   * 的 `session_meta.payload.dynamic_tools[]`。仅 Codex 端有值；codex 的核心工具（shell/apply_patch
   * 等）是嵌入 system prompt 的伪工具，不在此字段中，但在 `gen_ai.system_instructions` 中可见。
   */
  'gen_ai.tool.definitions'?: JsonValue;
  /** 规范化仓库标识，例如 `sls/loongsuite-pilot`。 */
  'git.repo'?: string;
  /** 采集时观察到的当前分支。 */
  'git.branch'?: string;
  /** 用于推断 Git 元数据的仓库文件系统根目录；兼容旧字段。 */
  'git.repo_root'?: string;
  /** Git 托管域名，例如 github.com。 */
  'git.domain'?: string;
  /** 从候选 workspace roots 中选出的当前根目录。 */
  'workspace.current_root'?: string;
  /** Agent 实际运行的绝对 cwd，与目录是否属于 Git 仓库无关。 */
  'workspace.path'?: string;
  /** 来源错误类型或错误码。 */
  'error.type'?: string;
  /** 来源错误文本；可能经过内容策略和脱敏。 */
  'error.message'?: string;
  /** Hook processor 发出的动态 OTLP Resource 属性候选值。 */
  resourceAttributes?: { [key: string]: JsonValue };
}

/**
 * IDE 级 Input 在归一化前发出的原始代码活动。
 */
export interface CodeGenerationEvent {
  /** 产生原始活动的 Agent 产品类型。 */
  agentType: ClientType;
  /** 被读取、生成或修改的文件路径。 */
  filePath: string;
  /** 来源动作归一化后的粗粒度类别。 */
  actionType: ActionType;
  /** 可选完整内容，是否保留由 Input 和内容策略决定。 */
  content?: string;
  /** 可选代码差异文本。 */
  diff?: string;
  /** 来源事件时间，Unix 毫秒。 */
  sourceTimestamp: number;
  /** 未投影的来源字段，供诊断和专用转换使用。 */
  rawData: Record<string, unknown>;
}

/**
 * Session 型 Input 在归一化前使用的模型调用、工具调用和消息聚合记录。
 */
export interface SessionRecord {
  /** 来源侧会话 ID。 */
  sessionId: string;
  /** 产生会话的 Agent 类型。 */
  agentType: ClientType;
  /** 来源请求 ID。 */
  requestId?: string;
  /** 请求或响应模型名。 */
  model?: string;
  /** 模型服务商。 */
  provider?: string;
  /** 聚合记录的主消息角色。 */
  role?: string;
  /** 会话内尚待展开的工具调用集合。 */
  toolCalls?: ToolCallRecord[];
  /** 会话内尚待转换的消息集合。 */
  messages?: MessageRecord[];
  /** 来源报告的 token 用量。 */
  usage?: TokenUsage;
  /** 会话开始时间，Unix 毫秒。 */
  startedAt: number;
  /** 会话结束时间，Unix 毫秒；进行中时缺失。 */
  endedAt?: number;
}

/** 单次工具调用的中间记录，Input 会将它展开成 tool.call/tool.result。 */
export interface ToolCallRecord {
  /** 来源侧工具名。 */
  toolName: string;
  /** 已解析的工具参数对象。 */
  parameters?: Record<string, unknown>;
  /** 工具返回的文本结果。 */
  result?: string;
  /** 当前执行状态；pending 表示尚未观察到结果。 */
  status: 'success' | 'failure' | 'pending';
  /** 工具执行耗时，单位毫秒。 */
  durationMs?: number;
}

/** 尚未转成 canonical parts 的通用消息记录。 */
export interface MessageRecord {
  /** canonical 消息角色。 */
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** 消息的主文本内容。 */
  content: string;
  /** 需要保留结构时使用的细粒度内容片段。 */
  items?: MessageItem[];
}

/** 消息中的文本、推理或工具片段。 */
export interface MessageItem {
  /** 片段类别，决定后续 canonical part 的解释方式。 */
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  /** 当前片段的文本内容。 */
  content: string;
}

/** 上游 Agent 提供的 token 用量；缓存字段可能缺失。 */
export interface TokenUsage {
  /** 请求输入 token。 */
  inputTokens: number;
  /** 响应输出 token。 */
  outputTokens: number;
  /** 命中缓存的输入 token。 */
  cacheReadTokens?: number;
  /** 新写入缓存的输入 token。 */
  cacheWriteTokens?: number;
}

/**
 * 适配 SLS/JSONL 等日志后端的纯字符串宽表。
 */
export type SerializedLogEntry = Record<string, string>;

/**
 * post-commit / pre-push 等 Git Hook 产生的仓库活动记录。
 */
export interface GitHookEvent {
  /** 触发 Pilot Git Hook 的阶段。 */
  eventType: 'post-commit' | 'pre-push';
  /** 仓库绝对根目录。 */
  repoRoot: string;
  /** 当前提交哈希。 */
  commitHash: string;
  /** 当前分支名。 */
  branchName: string;
  /** 本次 Hook 关联的变更文件路径。 */
  changedFiles: string[];
  /** Hook 触发时间，Unix 毫秒。 */
  timestamp: number;
}
