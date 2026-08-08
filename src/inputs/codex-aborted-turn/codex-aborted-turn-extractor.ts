/**
 * 旧 `CodexAbortedTurnInput` 的 rollout 语义提取器，非当前生产采集主链。
 *
 * 调用位置：input 从 checkpoint 指定的字节范围读取并解析 JSONL 后，先调用
 * `extractCodexTranscriptMeta()` 读取会话元数据，再调用 `extractAbortedTurn()` 把松散的 Codex
 * 记录聚合为强类型 timeline，随后交给 builder。所有函数均为同步纯转换，不读写文件或网络；
 * 不可信字段通过 utils 做类型检查，无法确认的记录会跳过，只有真正看到目标 `turn_aborted`
 * 且时间戳有效时才返回可恢复对象。
 */
import * as path from 'node:path';
import type { JsonValue } from '../../types/index.js';
import type {
  CodexExtractedAbortedTurn,
  CodexTokenUsage,
  CodexTokenUsageSample,
  CodexTranscriptMeta,
  CodexTimelineAssistantMessage,
  CodexTimelineEvent,
  CodexTimelineToolCall,
  CodexTimelineToolResult,
} from './codex-aborted-turn-types.js';
import { asRecord, stringValue, timestampMs } from './codex-aborted-turn-utils.js';

/** append 回调接收的临时事件类型；`sequence` 由提取器统一生成，调用者无需提供。 */
type CodexTimelineEventInput =
  | Omit<CodexTimelineAssistantMessage, 'sequence'>
  | Omit<CodexTimelineToolCall, 'sequence'>
  | Omit<CodexTimelineToolResult, 'sequence'>;

/**
 * 从一条 `session_meta` 记录提取恢复所需的最小会话上下文。
 * @param record 已完成 JSON 解析的一行 rollout 记录。
 * @returns 类型或 payload 不匹配时返回 `null`；否则返回带默认 Provider 的元数据。
 */
export function extractCodexTranscriptMeta(record: Record<string, unknown>): CodexTranscriptMeta | null {
  if (record.type !== 'session_meta') return null;
  const payload = asRecord(record.payload);
  if (!payload) return null;

  const baseInstructions = readInstructionText(payload.base_instructions);
  const definitions = Array.isArray(payload.dynamic_tools)
    ? toJsonValue(payload.dynamic_tools)
    : undefined;

  return {
    sessionId: stringValue(payload.id) ?? '',
    provider: stringValue(payload.model_provider) ?? 'openai',
    ...(baseInstructions ? { baseInstructions } : {}),
    ...(definitions !== undefined ? { toolDefinitions: definitions } : {}),
  };
}

/**
 * 扫描目标 turn 的记录范围，提取 prompt、模型、assistant 文本、工具调用/结果和 token 快照。
 * 只有 `task_started/turn_context` 匹配 `expectedTurnId` 后的记录才进入 timeline；工具结果还必须
 * 能匹配此前见过的 call ID。相同 token 累计值会去重，Codex 注入的 `<turn_aborted>` 用户消息
 * 不会误当成真实 prompt。
 * @param records 从 turn 起点到 abort 行末尾的已解析记录。
 * @param meta 最近一条 session meta；缺失时使用回退值。
 * @param fallbackSessionId 无 meta 时从文件名推导的 session ID。
 * @param expectedTurnId checkpoint 正在跟踪的 turn ID。
 * @returns 完整中断 turn；未找到有效 `turn_aborted` 时间时返回 `null`，让上层写恢复失败诊断。
 */
export function extractAbortedTurn(
  records: Record<string, unknown>[],
  meta: CodexTranscriptMeta | null,
  fallbackSessionId: string,
  expectedTurnId: string,
): CodexExtractedAbortedTurn | null {
  // currentTurnId 是状态机闸门：在看到目标 turn 的起点前，后续消息一律不进入聚合结果。
  let currentTurnId = '';
  // startedAtMs 可由 task_started 或 turn_context 首次赋值；abort 时间必须来自真实中断记录。
  let startedAtMs: number | undefined;
  let abortedAtMs: number | undefined;
  // rollout 未提供 reason/model 时保留可诊断的默认值，而不是让下游处理 undefined。
  let abortReason = 'interrupted';
  let model = 'unknown';
  let cwd: string | undefined;
  let developerInstructions: string | undefined;
  const promptParts: string[] = [];
  // timeline 同时保存文本、工具调用和工具结果；builder 会按 timestamp + sequence 划分步骤。
  const timeline: CodexTimelineEvent[] = [];
  // 只有见过调用的 callId 才接纳对应结果，防止范围边界附近的孤立结果串入当前 turn。
  const toolCallIds = new Set<string>();
  // token_count 是累计快照而非单次增量，保留变化点供 builder 计算各步骤差值。
  const usageSamples: CodexTokenUsageSample[] = [];
  let lastUsage: CodexTokenUsage | undefined;
  let sequence = 0;

  /** 为 timeline 事件分配单调 sequence，确保相同毫秒内仍能按原始记录顺序稳定排序。 */
  const appendTimeline = (event: CodexTimelineEventInput): void => {
    // 后置递增让第一条事件从 0 开始；token 样本也共享该序列空间。
    const nextSequence = sequence++;
    if (event.kind === 'assistant_message') {
      // 显式重建对象既补入 sequence，也避免把联合类型中不属于该分支的字段带入结果。
      timeline.push({
        kind: 'assistant_message',
        timestampMs: event.timestampMs,
        sequence: nextSequence,
        content: event.content,
      });
    } else if (event.kind === 'tool_call') {
      timeline.push({
        kind: 'tool_call',
        timestampMs: event.timestampMs,
        sequence: nextSequence,
        callId: event.callId,
        name: event.name,
        input: event.input,
      });
    } else {
      timeline.push({
        kind: 'tool_result',
        timestampMs: event.timestampMs,
        sequence: nextSequence,
        callId: event.callId,
        ...(event.output !== undefined ? { output: event.output } : {}),
      });
    }
  };

  for (const record of records) {
    // rollout 内容来自外部进程，任何非对象 payload 都直接跳过，避免属性访问抛错。
    const payload = asRecord(record.payload);
    if (!payload) continue;
    const parsedTimestamp = timestampMs(record);
    // 普通 timeline 项允许退回 turn 起始时间；唯独 abort 必须保留“时间无效”这一失败信号。
    const timestamp = parsedTimestamp ?? startedAtMs ?? Date.now();

    if (record.type === 'event_msg' && payload.type === 'task_started') {
      const turnId = stringValue(payload.turn_id);
      if (turnId === expectedTurnId) {
        // 只打开调用者指定的 turn，范围内其他 turn 的起点不会改变当前目标。
        currentTurnId = turnId;
        // `??=` 保留更早获得的合法起点，不被重复起始记录覆盖。
        startedAtMs ??= timestamp;
      }
      continue;
    }

    if (record.type === 'turn_context') {
      const turnId = stringValue(payload.turn_id);
      if (turnId !== expectedTurnId) continue;
      // turn_context 兼作缺失 task_started 时的起点，并携带模型、cwd 和开发者指令。
      currentTurnId = turnId;
      startedAtMs ??= timestamp;
      model = stringValue(payload.model) ?? model;
      cwd = stringValue(payload.cwd) ?? cwd;
      developerInstructions = stringValue(payload.developer_instructions) ?? developerInstructions;
      continue;
    }

    // 到这里仍未进入目标 turn 的记录属于范围前缀，只能忽略。
    if (currentTurnId !== expectedTurnId) continue;

    if (record.type === 'event_msg') {
      if (payload.type === 'agent_message') {
        // agent_message 是可展示的 assistant 文本，按原始时间插入 timeline。
        const message = stringValue(payload.message);
        if (message) appendTimeline({ kind: 'assistant_message', timestampMs: timestamp, content: message });
      } else if (payload.type === 'token_count') {
        // 只保存可解析且与上一累计值不同的样本，避免重复快照制造零增量步骤。
        const usage = extractLastTokenUsage(payload.info);
        if (usage && !sameUsage(lastUsage, usage)) {
          lastUsage = usage;
          usageSamples.push({ timestampMs: timestamp, sequence: sequence++, usage });
        }
      } else if (payload.type === 'turn_aborted' && stringValue(payload.turn_id) === expectedTurnId) {
        // 使用 parsedTimestamp 而不是回退 timestamp；缺少真实中断时间时整次提取应失败并写诊断。
        abortedAtMs = parsedTimestamp;
        abortReason = stringValue(payload.reason) ?? abortReason;
      }
      continue;
    }

    // 其余协议记录不参与中断恢复；response_item 才承载 prompt 和工具交互。
    if (record.type !== 'response_item') continue;
    const itemType = stringValue(payload.type);
    if (itemType === 'message') {
      if (stringValue(payload.role) === 'user') {
        const text = extractMessageText(payload.content);
        // Codex 自己插入的 <turn_aborted> 控制消息不是用户意图，必须从 prompt 中排除。
        if (text && !isTurnAbortedInjection(text)) promptParts.push(text);
      }
      continue;
    }

    if (itemType === 'function_call' || itemType === 'custom_tool_call' || itemType === 'tool_search_call') {
      // 不同工具协议把标识写在 call_id 或 id，按优先级兼容两种形状。
      const callId = stringValue(payload.call_id) ?? stringValue(payload.id);
      if (!callId) continue;
      // custom_tool_call 使用 input，普通函数和工具搜索使用 arguments。
      const inputField = itemType === 'custom_tool_call' ? payload.input : payload.arguments;
      appendTimeline({
        kind: 'tool_call',
        timestampMs: timestamp,
        callId,
        name: stringValue(payload.name) ?? (itemType === 'tool_search_call' ? 'tool_search' : 'unknown'),
        input: toJsonValue(parseMaybeJson(inputField)),
      });
      // 先登记调用，后面的 output 才能通过归属校验。
      toolCallIds.add(callId);
      continue;
    }

    if (itemType === 'web_search_call') {
      // 旧 Web Search 记录可能没有 ID；时间戳派生值让调用和下方合成结果仍能稳定配对。
      const callId = stringValue(payload.call_id) ?? stringValue(payload.id) ?? `web_search:${timestamp}`;
      appendTimeline({
        kind: 'tool_call',
        timestampMs: timestamp,
        callId,
        name: 'web_search',
        input: toJsonValue(parseMaybeJson(payload.action)),
      });
      toolCallIds.add(callId);
      // web_search_call 本身同时携带状态，没有独立 output 记录，因此当场合成一个 tool_result。
      appendTimeline({
        kind: 'tool_result',
        timestampMs: timestamp,
        callId,
        output: toJsonValue({
          ...(payload.status !== undefined ? { status: payload.status } : {}),
          ...(payload.action !== undefined ? { action: parseMaybeJson(payload.action) } : {}),
        }),
      });
      continue;
    }

    const outputType = itemType === 'function_call_output'
      || itemType === 'custom_tool_call_output'
      || itemType === 'tool_search_output';
    if (!outputType) continue;

    const callId = stringValue(payload.call_id) ?? stringValue(payload.id);
    if (!callId) continue;
    // 范围中可能出现上一个 turn 发起、当前 turn 才返回的结果；没有本 turn 调用证据就丢弃。
    if (!toolCallIds.has(callId)) continue;
    appendTimeline({
      kind: 'tool_result',
      timestampMs: timestamp,
      callId,
      output: itemType === 'tool_search_output'
        // tool_search_output 是结构化复合对象，普通工具结果则直接解析 output 字段。
        ? toJsonValue({
        ...(payload.status !== undefined ? { status: payload.status } : {}),
        ...(payload.execution !== undefined ? { execution: payload.execution } : {}),
        ...(payload.tools !== undefined ? { tools: parseMaybeJson(payload.tools) } : {}),
      })
        : toJsonValue(parseMaybeJson(payload.output)),
    });
  }

  // 中断时间是“确实发生目标终态”的硬证据；缺失时不生成可能误报的 cancelled 事件。
  if (abortedAtMs === undefined) return null;
  return {
    // meta 优先于文件名推导值；空 sessionId 也会回退，避免生成无会话归属的事件。
    sessionId: meta?.sessionId || fallbackSessionId,
    transcriptTurnId: expectedTurnId,
    provider: meta?.provider ?? 'openai',
    model,
    ...(cwd ? { cwd } : {}),
    ...(promptParts.length > 0 ? { prompt: promptParts.join('\n\n') } : {}),
    ...(developerInstructions ? { developerInstructions } : {}),
    ...(meta?.baseInstructions ? { baseInstructions: meta.baseInstructions } : {}),
    ...(meta?.toolDefinitions !== undefined ? { toolDefinitions: meta.toolDefinitions } : {}),
    // 极端情况下缺少起点，使用 abort 时刻可保证持续时间非负且事件仍可诊断。
    startedAtMs: startedAtMs ?? abortedAtMs,
    abortedAtMs,
    reason: abortReason,
    timeline,
    usageSamples,
  };
}

/**
 * 从 `rollout-...-UUID.jsonl` 文件名提取 session ID。
 * @returns 匹配 UUID 时返回 UUID，否则退回不带扩展名的完整文件名，保证始终有标识。
 */
export function sessionIdFromTranscriptPath(filePath: string): string {
  const base = path.basename(filePath, '.jsonl');
  const match = base.match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i);
  return match?.[1] ?? base;
}

/** 兼容指令既可能直接是字符串，也可能包装在 `{ text }` 对象中的两种 rollout 形状。 */
function readInstructionText(value: unknown): string | undefined {
  const record = asRecord(value);
  if (record && typeof record.text === 'string' && record.text) return record.text;
  return stringValue(value);
}

/** 提取字符串或内容分片数组中的文本，并用换行连接；无法识别的分片会被忽略。 */
function extractMessageText(content: unknown): string | undefined {
  if (typeof content === 'string' && content) return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap(item => {
    if (typeof item === 'string') return [item];
    const record = asRecord(item);
    const text = record && stringValue(record.text);
    return text ? [text] : [];
  });
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/** 识别 Codex 为中断恢复自动注入的标记，防止把控制消息计入用户 prompt。 */
function isTurnAbortedInjection(text: string): boolean {
  return text.trimStart().startsWith('<turn_aborted>');
}

/** 尝试解析字符串形式的工具参数/结果；解析失败时保留原字符串而不是丢失数据。 */
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * 递归把未知值过滤为可 JSON 序列化的值。
 * 非有限数值、函数等非法值被省略；数组中非法元素会删除，对象中非法字段会跳过。
 */
function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    return value.flatMap(item => {
      const json = toJsonValue(item);
      return json === undefined ? [] : [json];
    });
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(record)) {
    const json = toJsonValue(item);
    if (json !== undefined) out[key] = json;
  }
  return out;
}

/** 从 `token_count.info.last_token_usage` 读取累计 token；缺少必需输入/输出字段时返回空。 */
function extractLastTokenUsage(value: unknown): CodexTokenUsage | undefined {
  const info = asRecord(value);
  const raw = info && asRecord(info.last_token_usage);
  if (!raw) return undefined;
  const inputTokens = numberValue(raw.input_tokens);
  const outputTokens = numberValue(raw.output_tokens);
  const cachedInputTokens = numberValue(raw.cached_input_tokens);
  const cacheCreationTokens = numberValue(raw.cache_creation_input_tokens) ?? 0;
  const totalTokens = numberValue(raw.total_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const reasoningOutputTokens = numberValue(raw.reasoning_output_tokens);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: cachedInputTokens ?? 0,
    cacheCreationTokens,
    totalTokens: totalTokens && totalTokens > 0 ? totalTokens : inputTokens + outputTokens,
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
  };
}

/** 仅接受有限 number，避免 `NaN/Infinity` 污染标准事件。 */
function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 比较两个累计 token 快照的所有字段，用于删除连续重复样本。 */
function sameUsage(left: CodexTokenUsage | undefined, right: CodexTokenUsage): boolean {
  return left !== undefined
    && left.inputTokens === right.inputTokens
    && left.outputTokens === right.outputTokens
    && left.cachedInputTokens === right.cachedInputTokens
    && left.cacheCreationTokens === right.cacheCreationTokens
    && left.reasoningOutputTokens === right.reasoningOutputTokens
    && left.totalTokens === right.totalTokens;
}
