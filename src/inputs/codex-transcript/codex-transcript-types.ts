/**
 * Codex rollout 解析模型、增量构建上下文与持久化 checkpoint 类型。
 *
 * 这些结构连接 Input、Extractor 和 Builder；字段变更必须同时检查 checkpoint 兼容与 Codex 测试。
 */
import type { JsonValue } from '../../types/index.js';

export const MAX_EMITTED_TERMINAL_TURNS = 100;
export const MAX_GLOBAL_EMITTED_TERMINAL_TURNS = 10_000;

export type CodexTerminalStatus = 'completed' | 'interrupted';

/** Builder 在相邻 LLM step 之间传递的请求上下文快照。 */
export interface CodexTranscriptInputContext {
  /** 当前状态所代表的完整请求上下文链式哈希，用于关联而不必总是保存全文。 */
  hash: string;
  /** 下一次 LLM 请求需要在前一上下文后追加的消息。 */
  delta?: JsonValue[];
  /** 仅当序列化体积未超过上限时保留完整上下文，防止 checkpoint 无限膨胀。 */
  fullMessages?: JsonValue[];
  /** 超大 delta 在 transcript 中的字节范围，恢复时据此重建，避免塞进 `input-state.json`。 */
  deltaRange?: {
    /** 该上下文片段第一条源记录的起始字节偏移。 */
    startOffset: number;
    /** 该上下文片段最后一条源记录结束后的字节偏移。 */
    endOffset: number;
  };
}

/** 一个尚未遇到 terminal 记录、可跨轮询周期继续恢复的活跃 Codex turn。 */
export interface CodexActiveTranscriptTurn {
  /** 由 task_started 记录派生的稳定 turn 标识。 */
  turnId: string;
  /** turn 在 JSONL 文件中的起始字节位置。 */
  startOffset: number;
  /** turn 开始的 Unix 毫秒时间戳。 */
  startedAtMs: number;
  /** 增量恢复越过 `turn_context` 后仍需保留的 turn 级模型和工作目录等上下文。 */
  model?: string;
  /** Codex 执行该 turn 时的工作目录，用于 Git/source enrich 和诊断。 */
  cwd?: string;
  /** turn_context 中的 developer instructions；后续构建每次 LLM request 时复用。 */
  developerInstructions?: string;
  /** 用户 prompt 边界事件是否已经发出，防止增量恢复重复发送。 */
  emittedPrompt?: boolean;
  /** 已提交 step 数；下一批 Builder 的 step 序号从该值加一开始。 */
  emittedStepCount?: number;
  /** 已发出的 llm.request step ID，有界保存用于重建片段去重。 */
  emittedStepRequestIds?: string[];
  /** 已发出的 llm.response step ID。 */
  emittedStepResponseIds?: string[];
  /** 已发出的 tool.call ID。 */
  emittedToolCallIds?: string[];
  /** 已发出的 tool.result ID。 */
  emittedToolResultIds?: string[];
  /** 已提交 step 之后、供下一次 LLM request 继续使用的消息上下文。 */
  inputContext?: CodexTranscriptInputContext;
}

/** 已完整落盘但暂时无法转换的 terminal 记录。 */
export interface CodexPendingTerminalTurn {
  /** 与 activeTurn 对应的稳定 turn 标识。 */
  turnId: string;
  /** terminal 记录结束后的字节偏移；下周期可精确重读，而不依赖扫描游标回退。 */
  terminalEndOffset: number;
  /** 已尝试恢复的次数，仅用于诊断和告警。 */
  retryCount?: number;
  /** 首次进入 pending 状态的 Unix 毫秒时间，用于判断持续时长。 */
  firstPendingAtMs?: number;
  /** 最近一次重试时间。 */
  lastAttemptAtMs?: number;
  /** 上次读取到的源记录数，帮助区分空范围与解析器不兼容。 */
  sourceRecordCount?: number;
}

export interface CodexTranscriptCheckpoint {
  /** 文件 inode；变化通常表示日志轮转或文件被替换。 */
  inode: number;
  /** 下一次从哪个字节继续扫描。 */
  scanOffset: number;
  /** 跨轮询周期保存的未结束 turn；当前没有活跃 turn 时为 `null`。 */
  activeTurn: CodexActiveTranscriptTurn | null;
  /** terminal 转换失败时的重试位置；存在时会先恢复它，再处理后续 turn。 */
  pendingTerminal: CodexPendingTerminalTurn | null;
  /** 最近一次 session_meta 记录的偏移，用于补取会话级元数据。 */
  latestSessionMetaOffset: number | null;
  /** 当前 transcript 已处理的 terminal turn，包括没有业务事件的控制 turn。 */
  emittedTerminalTurnIds: string[];
}

export interface CodexTranscriptGlobalState {
  /** 有容量上限的跨 transcript 去重表；持久化字段名为兼容旧状态而保留。 */
  emittedTerminalTurnIds: string[];
}

/** 从最近一条 session_meta 提取、供整个 transcript 共用的会话元数据。 */
export interface CodexTranscriptMeta {
  /** Codex session UUID；缺失时 Input 会从文件名回退推导。 */
  sessionId: string;
  /** 模型服务提供方，例如 openai。 */
  provider: string;
  /** session 级基础系统指令。 */
  baseInstructions?: string;
  /** Codex 在 session_meta 中声明的动态工具定义。 */
  toolDefinitions?: JsonValue;
}

/** 单个 LLM response wave 的 token 用量，字段已从 Codex 原始命名归一化。 */
export interface CodexTranscriptUsage {
  /** 发送给模型的输入 token。 */
  inputTokens: number;
  /** 模型生成的输出 token。 */
  outputTokens: number;
  /** 从 prompt cache 读取的输入 token。 */
  cachedInputTokens: number;
  /** 新写入 prompt cache 的输入 token。 */
  cacheCreationTokens: number;
  /** 源版本提供时记录 reasoning 输出 token。 */
  reasoningOutputTokens?: number;
  /** 源 total 有效时采用源值，否则由输入与输出相加得到。 */
  totalTokens: number;
}

/** Extractor 在一个 step 内关联好的工具调用及可选结果。 */
export interface CodexTranscriptTool {
  /** 调用与结果之间的关联 ID。 */
  callId: string;
  /** 工具名，例如 exec_command、apply_patch。 */
  name: string;
  /** JSON 兼容的工具参数；源数据缺失时省略。 */
  input?: JsonValue;
  /** 工具调用开始的 Unix 毫秒时间。 */
  startedAtMs: number;
  /** JSON 兼容的工具输出。 */
  output?: JsonValue;
  /** 出现对应输出时的完成时间；缺失表示 terminal 到来时仍未闭合。 */
  completedAtMs?: number;
}

/** 一次 LLM response wave 及紧随其后的工具调用集合，对应标准事件中的一个 step。 */
export interface CodexTranscriptStep {
  /** 本 step 的请求开始时间。 */
  startedAtMs: number;
  /** 模型响应发生时间，也是没有工具时的主要完成边界。 */
  responseAtMs: number;
  /** 是否观察到 assistant/reasoning/tool call 等真实响应证据。 */
  hasResponseEvidence: boolean;
  /** step 内最后一项活动的时间；工具结果可能晚于 responseAtMs。 */
  completedAtMs: number;
  /** Codex 原始 response ID；缺失时 Builder 生成确定性回退 ID。 */
  responseId?: string;
  /** 首个 step 从 transcript 中解析到的请求消息。 */
  inputMessages?: JsonValue[];
  /** assistant/reasoning 文本片段，按源顺序保存。 */
  reasoning: string[];
  /** 当前 wave 发起的工具调用。 */
  tools: CodexTranscriptTool[];
  /** 已可靠锚定到当前 response 的 token 样本。 */
  tokenUsage?: CodexTranscriptUsage;
  /** task_complete 提供的最终回答文本，只归属于 terminal step。 */
  finalText?: string;
}

/** 一条已解析 JSONL 对象及其在 UTF-8 文件中的半开字节区间。 */
export interface CodexTranscriptSourceRecord {
  /** 当前行第一个字节的位置。 */
  startOffset: number;
  /** 换行符之后的第一个字节位置。 */
  endOffset: number;
  /** JSON.parse 得到的普通对象。 */
  record: Record<string, unknown>;
}

/** 不携带内容的源字节范围，用于把超大上下文按需从 transcript 重建。 */
export interface CodexTranscriptSourceRange {
  /** 半开区间起点。 */
  startOffset: number;
  /** 半开区间终点。 */
  endOffset: number;
}

/**
 * 非 terminal turn 的增量解析结果。
 *
 * 这里把 LLM response wave 的语义边界和源文件字节消费边界放在同一结构中，确保 Input 推进
 * checkpoint 的单位与实际发出的 step 完全一致，不会因先移动 offset 而漏掉未闭合事件。
 */
export interface CodexPartialTurnExtraction {
  /** 已解析出的 turn 语义模型。 */
  turn: CodexExtractedTranscriptTurn;
  /** 从 turn 开头起已经确认闭合、可以提交的 step 数量。 */
  committedStepCount: number;
  /** 每个已提交 step 对应的源记录范围。 */
  committedStepRanges: CodexTranscriptSourceRange[];
  /** 与已提交内容严格对应的下一个扫描字节位置。 */
  consumedEndOffset: number;
}

/** Extractor 输出、Builder 输入的完整内存 turn 模型。 */
export interface CodexExtractedTranscriptTurn {
  /** 会话标识，优先来自 session_meta。 */
  sessionId: string;
  /** Codex rollout 原始 turn_id。 */
  transcriptTurnId: string;
  /** 模型服务提供方。 */
  provider: string;
  /** turn_context 中的实际模型，未知时为 `unknown`。 */
  model: string;
  /** 正常完成或被中断。活跃 turn 的增量模型暂以 completed 构建已闭合前缀。 */
  status: CodexTerminalStatus;
  /** turn 开始时间。 */
  startedAtMs: number;
  /** terminal 时间；增量解析时为当前已提交活动的末尾时间。 */
  terminalAtMs: number;
  /** 去重拼接后的用户 prompt。 */
  prompt?: string;
  /** transcript 中显式出现的非 assistant 请求消息。 */
  inputMessages: JsonValue[];
  /** 工作目录。 */
  cwd?: string;
  /** turn 级 developer instructions。 */
  developerInstructions?: string;
  /** session 级基础指令。 */
  baseInstructions?: string;
  /** session 级工具定义。 */
  toolDefinitions?: JsonValue;
  /** 按 response wave 顺序排列的 step。 */
  steps: CodexTranscriptStep[];
  /** 无法可靠关联到某个已完成 response wave 的 token 样本；保留供诊断但不强行归属。 */
  unmatchedTokenUsages: CodexTranscriptUsage[];
}
