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

  time_unix_nano: string;
  observed_time_unix_nano?: string;
  'event.id': string;
  'user.id': string;
  'event.name': AgentEventName;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  'host.name'?: string;
  'host.ip'?: string;
  'service.name'?: string;
  'gen_ai.session.id': string;
  'gen_ai.turn.id'?: string;
  'gen_ai.step.id'?: string;
  'gen_ai.response.id'?: string;
  'gen_ai.agent.type': string;
  'gen_ai.agent.id'?: string;
  'gen_ai.agent.name'?: string;
  'gen_ai.provider.name': string;
  'gen_ai.request.id'?: string;
  'gen_ai.request.model'?: string;
  'gen_ai.response.model'?: string;
  'gen_ai.response.finish_reasons'?: string[];
  'gen_ai.usage.input_tokens'?: number;
  'gen_ai.usage.output_tokens'?: number;
  'gen_ai.usage.cache_read.input_tokens'?: number;
  'gen_ai.usage.cache_creation.input_tokens'?: number;
  'gen_ai.usage.total_tokens'?: number;
  'gen_ai.usage.input_cost'?: number;
  'gen_ai.usage.output_cost'?: number;
  'gen_ai.usage.cache_read.input_cost'?: number;
  'gen_ai.usage.cache_creation.input_cost'?: number;
  'gen_ai.usage.total_cost'?: number;
  'gen_ai.input.messages_hash'?: string;
  'gen_ai.input.messages_delta'?: JsonValue;
  'gen_ai.input.messages'?: JsonValue;
  'gen_ai.output.messages'?: JsonValue;
  'gen_ai.tool.name'?: string;
  'gen_ai.tool.call.id'?: string;
  'gen_ai.tool.call.exec.id'?: string;
  'gen_ai.tool.call.arguments'?: JsonValue;
  'gen_ai.tool.call.result'?: JsonValue;
  'gen_ai.tool.call.duration'?: number;
  'tool.result.status'?: string;
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
  'error.type'?: string;
  'error.message'?: string;
  /** Hook processor 发出的动态 OTLP Resource 属性候选值。 */
  resourceAttributes?: { [key: string]: JsonValue };
}

/**
 * IDE 级 Input 在归一化前发出的原始代码活动。
 */
export interface CodeGenerationEvent {
  agentType: ClientType;
  filePath: string;
  actionType: ActionType;
  content?: string;
  diff?: string;
  sourceTimestamp: number;
  rawData: Record<string, unknown>;
}

/**
 * Session 型 Input 在归一化前使用的模型调用、工具调用和消息聚合记录。
 */
export interface SessionRecord {
  sessionId: string;
  agentType: ClientType;
  requestId?: string;
  model?: string;
  provider?: string;
  role?: string;
  toolCalls?: ToolCallRecord[];
  messages?: MessageRecord[];
  usage?: TokenUsage;
  startedAt: number;
  endedAt?: number;
}

/** 单次工具调用的中间记录，Input 会将它展开成 tool.call/tool.result。 */
export interface ToolCallRecord {
  toolName: string;
  parameters?: Record<string, unknown>;
  result?: string;
  status: 'success' | 'failure' | 'pending';
  durationMs?: number;
}

/** 尚未转成 canonical parts 的通用消息记录。 */
export interface MessageRecord {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  items?: MessageItem[];
}

/** 消息中的文本、推理或工具片段。 */
export interface MessageItem {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  content: string;
}

/** 上游 Agent 提供的 token 用量；缓存字段可能缺失。 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
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
  eventType: 'post-commit' | 'pre-push';
  repoRoot: string;
  commitHash: string;
  branchName: string;
  changedFiles: string[];
  timestamp: number;
}
