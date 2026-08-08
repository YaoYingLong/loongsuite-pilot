/**
 * 旧 Codex 中断 turn 恢复链的内部数据契约，保留用于兼容、迁移参考和现有测试。
 *
 * 类型把流程分成三层：`CodexAbortedCheckpoint` 保存文件扫描位置；timeline 类型表示从 rollout
 * 提取的有序语义事件；`CodexExtractedAbortedTurn` 是 builder 的完整输入。它们只是 TypeScript
 * 类型，编译后不会产生运行时代码；两个上限常量则用于约束持久化数组，避免状态文件无限增长。
 */
import type { JsonValue } from '../../types/index.js';

/** 每个 transcript 最多保留 100 个已恢复的中断 turn ID，用于跨轮询去重。 */
export const MAX_EMITTED_ABORTED_TURNS = 100;
/** 最多跟踪 100 个等待 Hook 状态出现的正常完成 turn，限制诊断状态大小。 */
export const MAX_PENDING_COMPLETED_TURNS = 100;

/** 当前尚未结束的 turn：ID 用于匹配终止事件，offset/time 决定恢复读取范围与起始时间。 */
export interface CodexActiveTurn {
  turnId: string;
  startOffset: number;
  startedAtMs: number;
}

/**
 * 单个 rollout 文件的持久化 checkpoint。
 * `inode` 检测文件替换，`scanOffset` 是下次增量读取起点；session meta offset 允许按需回读；
 * 三个数组分别负责中断去重、Hook 缺失宽限队列和诊断去重。
 */
export interface CodexAbortedCheckpoint {
  inode: number;
  scanOffset: number;
  activeTurn: CodexActiveTurn | null;
  latestSessionMetaOffset: number | null;
  latestSessionId: string | null;
  emittedAbortedTurnIds: string[];
  pendingCompletedTurns: CodexCompletedTurn[];
  emittedHookGapTurnIds: string[];
}

/** 已正常完成、等待确认对应 Hook 状态的 turn；超过宽限期仍缺失时写诊断。 */
export interface CodexCompletedTurn {
  turnId: string;
  sessionId: string;
  completedAtMs: number;
}

/** 从最近一条 `session_meta` 提取的 session、Provider、系统指令和动态工具定义。 */
export interface CodexTranscriptMeta {
  sessionId: string;
  provider: string;
  baseInstructions?: string;
  toolDefinitions?: JsonValue;
}

/** timeline 中一段 assistant 文本；`sequence` 用于相同时间戳下保持原文件顺序。 */
export interface CodexTimelineAssistantMessage {
  kind: 'assistant_message';
  timestampMs: number;
  sequence: number;
  content: string;
}

/** timeline 中一次工具调用声明；`input` 已被递归过滤为合法 `JsonValue`。 */
export interface CodexTimelineToolCall {
  kind: 'tool_call';
  timestampMs: number;
  sequence: number;
  callId: string;
  name: string;
  input: JsonValue | undefined;
}

/** timeline 中与 `callId` 配对的工具结果；中断前可能不存在。 */
export interface CodexTimelineToolResult {
  kind: 'tool_result';
  timestampMs: number;
  sequence: number;
  callId: string;
  output?: JsonValue;
}

/** 提取器和 builder 之间的判别联合；通过 `kind` 可安全缩窄为消息、调用或结果。 */
export type CodexTimelineEvent =
  | CodexTimelineAssistantMessage
  | CodexTimelineToolCall
  | CodexTimelineToolResult;

/** 单次累计 token 快照；缓存和 reasoning 字段会映射到标准 `gen_ai.usage.*`。 */
export interface CodexTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  reasoningOutputTokens?: number;
  totalTokens: number;
}

/** 带时间及原始顺序的 token 快照，builder 据此归属到最近的 step。 */
export interface CodexTokenUsageSample {
  timestampMs: number;
  sequence: number;
  usage: CodexTokenUsage;
}

/**
 * 一个可构建的中断 turn 聚合对象。
 * 包含 session/模型上下文、用户 prompt、起止时间、按顺序的消息与工具 timeline 以及 token 快照；
 * builder 不再访问原文件，只依赖本对象生成 cancelled `AgentActivityEntry`。
 */
export interface CodexExtractedAbortedTurn {
  sessionId: string;
  transcriptTurnId: string;
  provider: string;
  model: string;
  cwd?: string;
  prompt?: string;
  developerInstructions?: string;
  baseInstructions?: string;
  toolDefinitions?: JsonValue;
  startedAtMs: number;
  abortedAtMs: number;
  reason: string;
  timeline: CodexTimelineEvent[];
  usageSamples: CodexTokenUsageSample[];
}
