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
  cwd?: string;
  developerInstructions?: string;
  emittedPrompt?: boolean;
  emittedStepCount?: number;
  emittedStepRequestIds?: string[];
  emittedStepResponseIds?: string[];
  emittedToolCallIds?: string[];
  emittedToolResultIds?: string[];
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
  firstPendingAtMs?: number;
  lastAttemptAtMs?: number;
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

export interface CodexTranscriptMeta {
  sessionId: string;
  provider: string;
  baseInstructions?: string;
  toolDefinitions?: JsonValue;
}

export interface CodexTranscriptUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  reasoningOutputTokens?: number;
  totalTokens: number;
}

export interface CodexTranscriptTool {
  callId: string;
  name: string;
  input?: JsonValue;
  startedAtMs: number;
  output?: JsonValue;
  completedAtMs?: number;
}

export interface CodexTranscriptStep {
  startedAtMs: number;
  responseAtMs: number;
  hasResponseEvidence: boolean;
  completedAtMs: number;
  responseId?: string;
  inputMessages?: JsonValue[];
  reasoning: string[];
  tools: CodexTranscriptTool[];
  tokenUsage?: CodexTranscriptUsage;
  finalText?: string;
}

export interface CodexTranscriptSourceRecord {
  startOffset: number;
  endOffset: number;
  record: Record<string, unknown>;
}

export interface CodexTranscriptSourceRange {
  startOffset: number;
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

export interface CodexExtractedTranscriptTurn {
  sessionId: string;
  transcriptTurnId: string;
  provider: string;
  model: string;
  status: CodexTerminalStatus;
  startedAtMs: number;
  terminalAtMs: number;
  prompt?: string;
  inputMessages: JsonValue[];
  cwd?: string;
  developerInstructions?: string;
  baseInstructions?: string;
  toolDefinitions?: JsonValue;
  steps: CodexTranscriptStep[];
  /** 无法可靠关联到某个已完成 response wave 的 token 样本；保留供诊断但不强行归属。 */
  unmatchedTokenUsages: CodexTranscriptUsage[];
}
