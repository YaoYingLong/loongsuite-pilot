/**
 * Codex transcript 语义段到 AgentActivityEntry[] 的构建器。
 *
 * 为 turn/step/LLM/tool/event 生成确定性 SHA-256 截断 ID，维护 input messages full/delta/hash
 * 链，并把 completed/interrupted 分别映射为 stop/cancelled。结果交回 Input 后再经通用策略/脱敏。
 */
import * as crypto from 'node:crypto';
import { buildAgentActivityEntry, timestampToUnixNanos } from '../../normalization/entry-builder.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import type {
  CodexExtractedTranscriptTurn,
  CodexTranscriptInputContext,
  CodexTranscriptStep,
  CodexTranscriptTool,
  CodexTranscriptUsage,
} from './codex-transcript-types.js';

// checkpoint 最多内嵌 1 MiB 完整消息；超过后只保留链式哈希和可重建的增量，控制状态文件体积。
const MAX_INPUT_MESSAGES_BYTES = 1024 * 1024;
// 空上下文的固定起始哈希，后续每条消息都在前一个哈希基础上继续计算。
const INITIAL_INPUT_HASH = crypto.createHash('sha256').update('').digest('hex').slice(0, 32);

/** 控制本次只构建 turn 的哪个增量片段，以及上下文从哪里继续。 */
export interface CodexTranscriptBuildOptions {
  /** 是否输出 turn 开始时的用户 prompt 事件；恢复中途 step 时设为 false，避免重复。 */
  includePrompt?: boolean;
  /** 当前片段第一条 step 的全局序号，默认从 1 开始。 */
  startStepNumber?: number;
  /** 上一批已提交 step 留下的输入上下文。 */
  inputContext?: CodexTranscriptInputContext;
  /** 返回上下文只提交前多少个 step；可用于解析了更多数据但只确认部分边界的场景。 */
  contextStepCount?: number;
}

export interface CodexTranscriptBuildResult {
  entries: AgentActivityEntry[];
  nextInputContext: CodexTranscriptInputContext;
}

/**
 * 把一个完整或增量 Codex turn 转成标准事件数组。
 *
 * 这是只需要事件、不需要下一段上下文时的便捷入口；生产 Input 通常调用
 * `buildCodexTranscriptSegment()`，以便把 `nextInputContext` 写入 checkpoint。
 *
 * @param turn Extractor 生成的语义 turn。
 * @param opts prompt、step 起始编号和上下文恢复选项。
 * @returns 按 prompt、LLM request/response、tool call/result 顺序排列的标准事件。
 */
export function buildCodexTranscriptEntries(
  turn: CodexExtractedTranscriptTurn,
  opts: CodexTranscriptBuildOptions = {},
): AgentActivityEntry[] {
  return buildCodexTranscriptSegment(turn, opts).entries;
}

/**
 * 构建一个 turn 片段，并返回本片段提交后的请求上下文。
 *
 * 本函数是纯数据转换：不读写文件、不发送网络请求。相同 session/turn/step 输入会生成相同 ID，
 * 因而重试不会创造另一组随机标识。结构错误通常会作为普通 JavaScript 异常向 Input 传播。
 */
export function buildCodexTranscriptSegment(
  turn: CodexExtractedTranscriptTurn,
  opts: CodexTranscriptBuildOptions = {},
): CodexTranscriptBuildResult {
  const includePrompt = opts.includePrompt ?? true;
  const startStepNumber = opts.startStepNumber ?? 1;
  // trace/span/event ID 均由稳定业务键计算，使同一源记录在恢复重放后仍可被下游去重。
  const traceId = hashId([turn.sessionId, turn.transcriptTurnId, 'trace'], 32);
  const agentSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'agent'], 16);
  const turnId = `${turn.sessionId}:${turn.transcriptTurnId}`;
  // 源记录偶尔不带模型；统一使用 unknown 可保持 schema 稳定，同时明确表示“未知”而非空字符串。
  const model = turn.model || 'unknown';
  // base 中只放 turn 内所有事件都相同的字段，后续 request/response/tool 构建时再补事件专有字段。
  const base: Record<string, JsonValue> = {
    trace_id: traceId,
    'gen_ai.session.id': turn.sessionId,
    'gen_ai.turn.id': turnId,
    'gen_ai.agent.type': 'codex',
    'gen_ai.agent.id': turn.sessionId,
    'gen_ai.provider.name': turn.provider,
    'agent.codex.transcript_turn_id': turn.transcriptTurnId,
    ...(turn.status === 'interrupted' ? { 'agent.codex.turn_status': 'interrupted' } : {}),
    ...(turn.cwd ? { 'agent.codex.cwd': turn.cwd } : {}),
  };
  const records: AgentActivityEntry[] = [];
  // 恢复采集时沿用 checkpoint 中的上下文；首次构建则从 prompt/首个 step 初始化。
  let inputContext = opts.inputContext ?? initialInputContext(turn);
  const contextStepCount = opts.contextStepCount ?? turn.steps.length;
  let nextInputContext = inputContext;

  // 用户输入作为 other 边界事件单独输出。增量恢复时 includePrompt=false，避免重复发送同一 prompt。
  if (includePrompt && turn.prompt) {
    // request 和 response 共用同一个 llmSpanId，转换为 OTLP 后形成同一 LLM span 的起止证据。
    records.push(buildEntry({
      ...base,
      timestamp: turn.startedAtMs,
      'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'other'], 32),
      'event.name': 'other',
      span_id: agentSpanId,
      // 合成根 parent ID 与 OTLP 转换器 `createTraceParentContext` 的哨兵值保持一致。OTLP 路径会
      // 合成它所代表的 ENTRY span，JSONL 路径则不输出该记录；消费者把它视为外部根节点，无需查找。
      parent_span_id: '0000000000000001',
      'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: turn.prompt }] }],
    }));
  }

  // 每个语义 step 固定输出一个 LLM request、一个 LLM response，再输出其中的工具调用对。
  for (const [index, step] of turn.steps.entries()) {
    const stepNumber = startStepNumber + index;
    const stepId = `${turnId}:s${stepNumber}`;
    const stepSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'step', String(stepNumber)], 16);
    const llmSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'llm', String(stepNumber)], 16);
    const responseId = step.responseId ?? `${turnId}:r${stepNumber}`;
    // delta 让下游看到相对上一请求新增了什么；体积允许时同时携带完整上下文，便于直接分析。
    const inputMessages = inputContext.delta ?? [];
    const outputInputMessages = inputContext.fullMessages ?? inputMessages;

    records.push(buildEntry({
      ...base,
      timestamp: step.startedAtMs,
      'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'request', String(stepNumber)], 32),
      'event.name': 'llm.request',
      span_id: llmSpanId,
      parent_span_id: stepSpanId,
      'gen_ai.step.id': stepId,
      'gen_ai.request.model': model,
      'gen_ai.response.id': responseId,
      'gen_ai.input.messages_hash': inputContext.hash,
      ...(inputMessages.length > 0 ? { 'gen_ai.input.messages_delta': inputMessages } : {}),
      ...(outputInputMessages.length > 0 ? { 'gen_ai.input.messages': outputInputMessages } : {}),
      ...sharedLlmFields(turn),
    }));

    // 只有最后一个 step 会继承 turn 的 interrupted/completed 终态；中间 step 按工具或 stop 判断。
    const terminalStep = index === turn.steps.length - 1;
    records.push(buildEntry({
      ...base,
      timestamp: responseTimestamp(step),
      'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'response', String(stepNumber)], 32),
      'event.name': 'llm.response',
      span_id: llmSpanId,
      parent_span_id: stepSpanId,
      'gen_ai.step.id': stepId,
      'gen_ai.request.model': model,
      'gen_ai.response.model': model,
      'gen_ai.response.id': responseId,
      'gen_ai.response.finish_reasons': finishReasons(turn, step, terminalStep),
      ...(responseMessages(turn, step, terminalStep).length > 0
        ? { 'gen_ai.output.messages': responseMessages(turn, step, terminalStep) }
        : {}),
      ...usageFields(step.tokenUsage),
    }));

    // 一个 step 可包含多个工具；flatMap 式展开后仍保持源记录中的工具顺序。
    for (const [toolIndex, tool] of step.tools.entries()) {
      records.push(...buildToolEntries(turn, tool, toolIndex, base, stepId, stepSpanId));
    }

    // 当前 step 的工具请求和结果会成为下一次 LLM request 的增量上下文。
    inputContext = advanceInputContext(inputContext, step);
    // 解析器可能只确认前若干 step 可提交，此时返回的 checkpoint 上下文也必须停在相同边界。
    if (index + 1 === contextStepCount) nextInputContext = inputContext;
  }

  return { entries: records, nextInputContext };
}

/** 按“首 step 明确输入 -> turn 输入 -> prompt”的优先级创建初始 LLM 请求上下文。 */
function initialInputContext(turn: CodexExtractedTranscriptTurn): CodexTranscriptInputContext {
  const delta = turn.steps[0]?.inputMessages?.length
    ? turn.steps[0].inputMessages
    : turn.inputMessages.length > 0
      ? turn.inputMessages
      : turn.prompt
        ? [{ role: 'user', parts: [{ type: 'text', content: turn.prompt }] }]
        : [];
  return contextFromMessages(INITIAL_INPUT_HASH, [], delta);
}

/** 把当前 step 已完成的工具调用及结果追加到上下文，为下一次 LLM 请求做准备。 */
function advanceInputContext(
  context: CodexTranscriptInputContext,
  step: CodexTranscriptStep,
): CodexTranscriptInputContext {
  const delta = nextInputMessagesForStep(step);
  return contextFromMessages(context.hash, context.fullMessages, delta);
}

/**
 * 计算追加消息后的链式哈希，并在序列化体积不超过 1 MiB 时保留完整消息列表。
 * @returns 可安全写入 checkpoint 的新对象，不会修改传入数组。
 */
function contextFromMessages(
  previousHash: string,
  previousFullMessages: JsonValue[] | undefined,
  delta: JsonValue[],
): CodexTranscriptInputContext {
  // 一旦完整上下文因超限被丢弃，后续保持 undefined；不能用不完整片段冒充完整会话历史。
  const fullMessages = previousFullMessages === undefined
    ? undefined
    : [...previousFullMessages, ...delta];
  // Buffer.byteLength 按真实 UTF-8 字节计算，中文等多字节字符不会被低估。
  const retainFullMessages = fullMessages !== undefined
    && Buffer.byteLength(JSON.stringify(fullMessages), 'utf8') <= MAX_INPUT_MESSAGES_BYTES;
  return {
    hash: hashInputMessages(previousHash, delta),
    delta,
    ...(retainFullMessages ? { fullMessages } : {}),
  };
}

/**
 * 将已完成工具转换为下一轮请求要补入的 assistant tool_call 与 tool response 两条消息。
 * 未完成工具不能作为有效上下文，因此会被过滤掉。
 */
export function nextInputMessagesForStep(step: CodexTranscriptStep): JsonValue[] {
  const completedTools = step.tools.filter(tool => tool.completedAtMs !== undefined);
  const messages: JsonValue[] = [];
  const toolCallMessage = assistantToolCallMessage(completedTools);
  if (toolCallMessage) messages.push(toolCallMessage);
  const toolMessage = toolResponseMessage(completedTools);
  if (toolMessage) messages.push(toolMessage);
  return messages;
}

/** 把同一 step 的工具请求聚合成一条 assistant 消息；空数组返回 undefined。 */
function assistantToolCallMessage(tools: CodexTranscriptTool[]): JsonValue | undefined {
  if (tools.length === 0) return undefined;
  return {
    role: 'assistant',
    parts: tools.map(tool => ({
      type: 'tool_call',
      id: tool.callId,
      name: tool.name,
      arguments: tool.input ?? null,
    })),
  };
}

/** 把工具结果聚合成一条 tool 消息，与前一条 assistant tool_call 按 callId 对应。 */
function toolResponseMessage(tools: CodexTranscriptTool[]): JsonValue | undefined {
  if (tools.length === 0) return undefined;
  return {
    role: 'tool',
    parts: tools.map(tool => ({
      type: 'tool_call_response',
      id: tool.callId,
      response: tool.output ?? null,
    })),
  };
}

/** 统一取得 response 事件时间；独立函数便于保持构建规则集中并供测试覆盖。 */
function responseTimestamp(step: CodexTranscriptStep): number {
  return step.responseAtMs;
}

/** 根据中断、工具调用和正常结束状态生成 OpenTelemetry GenAI finish reason。 */
function finishReasons(
  turn: CodexExtractedTranscriptTurn,
  step: CodexTranscriptStep,
  terminalStep: boolean,
): JsonValue {
  if (terminalStep && turn.status === 'interrupted') return ['cancelled'];
  if (step.tools.length > 0) return ['tool_call'];
  if (step.tokenUsage || (terminalStep && turn.status === 'completed')) return ['stop'];
  return [];
}

/** 组合 reasoning、工具调用和最终文本，形成 assistant 输出消息。 */
function responseMessages(
  turn: CodexExtractedTranscriptTurn,
  step: CodexTranscriptStep,
  terminalStep: boolean,
): JsonValue[] {
  const parts: JsonValue[] = [
    ...step.reasoning.map(content => ({ type: 'reasoning', content })),
    ...step.tools.map(tool => ({
      type: 'tool_call',
      id: tool.callId,
      name: tool.name,
      arguments: tool.input ?? null,
    })),
    ...(step.finalText ? [{ type: 'text', content: step.finalText }] : []),
  ];
  if (parts.length === 0) return [];
  const finishReason = terminalStep && turn.status === 'interrupted'
    ? 'cancelled'
    : step.tools.length > 0
    ? 'tool_call'
    : 'stop';
  return [{ role: 'assistant', parts, finish_reason: finishReason }];
}

/**
 * 为一个工具生成配对的 `tool.call` 与 `tool.result` 事件。
 *
 * terminal 到来时仍未完成的工具也会生成 cancelled result，以闭合 span；此时不伪造 result 内容
 * 或 duration。已完成工具才会写真实返回值和非负耗时。
 */
function buildToolEntries(
  turn: CodexExtractedTranscriptTurn,
  tool: CodexTranscriptTool,
  index: number,
  base: Record<string, JsonValue>,
  stepId: string,
  stepSpanId: string,
): AgentActivityEntry[] {
  const spanId = hashId([turn.sessionId, turn.transcriptTurnId, 'tool', tool.callId], 16);
  const records = [buildEntry({
    ...base,
    timestamp: tool.startedAtMs,
    'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'tool-call', tool.callId, String(index)], 32),
    'event.name': 'tool.call',
    span_id: spanId,
    parent_span_id: stepSpanId,
    'gen_ai.step.id': stepId,
    'gen_ai.tool.name': tool.name,
    'gen_ai.tool.call.id': tool.callId,
    ...(tool.input !== undefined ? { 'gen_ai.tool.call.arguments': tool.input } : {}),
  })];

  // 是否有完成时间是当前解析模型判断“工具已经返回”的唯一可靠依据。
  const completed = tool.completedAtMs !== undefined;
  const result: Record<string, JsonValue> = {
    ...base,
    timestamp: completed ? tool.completedAtMs! : turn.terminalAtMs,
    'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'tool-result', tool.callId, String(index)], 32),
    'event.name': 'tool.result',
    span_id: spanId,
    parent_span_id: stepSpanId,
    'gen_ai.step.id': stepId,
    'gen_ai.tool.name': tool.name,
    'gen_ai.tool.call.id': tool.callId,
    'tool.result.status': completed ? 'success' : 'cancelled',
  };
  if (completed && tool.output !== undefined) result['gen_ai.tool.call.result'] = tool.output;
  const duration = completed ? tool.completedAtMs! - tool.startedAtMs : undefined;
  if (duration !== undefined && duration >= 0) result['gen_ai.tool.call.duration'] = duration;
  records.push(buildEntry(result));
  return records;
}

/**
 * 将 Codex token 统计映射到统一字段；源数据没有样本时按既有 schema 写 0，而非省略整组字段。
 */
function usageFields(usage: CodexTranscriptUsage | undefined): Record<string, JsonValue> {
  const resolved = usage ?? {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
  };
  return {
    'gen_ai.usage.input_tokens': resolved.inputTokens,
    'gen_ai.usage.output_tokens': resolved.outputTokens,
    'gen_ai.usage.cache_read.input_tokens': resolved.cachedInputTokens,
    'gen_ai.usage.cache_creation.input_tokens': resolved.cacheCreationTokens,
    'gen_ai.usage.total_tokens': resolved.totalTokens,
    ...(resolved.reasoningOutputTokens !== undefined
      ? { 'gen_ai.usage.reasoning_output_tokens': resolved.reasoningOutputTokens }
      : {}),
  };
}

/** 收集 turn 中每次 LLM 请求共用的 system instructions 与工具定义。 */
function sharedLlmFields(turn: CodexExtractedTranscriptTurn): Record<string, JsonValue> {
  const instructions: JsonValue[] = [];
  if (turn.baseInstructions) instructions.push({ type: 'text', content: turn.baseInstructions });
  if (turn.developerInstructions) instructions.push({ type: 'text', content: turn.developerInstructions });
  return {
    ...(instructions.length > 0 ? { 'gen_ai.system_instructions': instructions } : {}),
    ...(turn.toolDefinitions !== undefined ? { 'gen_ai.tool.definitions': turn.toolDefinitions } : {}),
  };
}

/**
 * 调用全局 EntryBuilder 补齐标准字段和纳秒时间戳，并保留 tool result 的扩展状态字段。
 * 输入对象不会被修改；timestamp 缺失时才使用当前时间作为防御性兜底。
 */
function buildEntry(fields: Record<string, JsonValue>): AgentActivityEntry {
  const timestamp = typeof fields.timestamp === 'number' ? fields.timestamp : Date.now();
  const { timestamp: _timestamp, ...rest } = fields;
  const entry = buildAgentActivityEntry({
    ...rest,
    timestamp,
    time_unix_nano: timestampToUnixNanos(timestamp),
  }) as AgentActivityEntry;
  if (typeof fields['tool.result.status'] === 'string') {
    entry['tool.result.status'] = fields['tool.result.status'];
  }
  return entry;
}

/** 用 NUL 分隔业务键后计算 SHA-256，并截取 schema 所需长度的十六进制 ID。 */
function hashId(parts: string[], length: number): string {
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, length);
}

/**
 * 按消息顺序推进链式哈希；每一步都包含前一哈希，因此调换、增加或删除消息都会改变结果。
 */
function hashInputMessages(previousHash: string, messages: JsonValue[]): string {
  let hash = previousHash;
  for (const message of messages) {
    hash = crypto.createHash('sha256')
      .update(hash)
      .update(stableSerialize(message))
      .digest('hex')
      .slice(0, 32);
  }
  return hash;
}

/**
 * 递归按字典序排列对象键，得到与对象属性插入顺序无关的稳定 JSON 字符串。
 * 数组顺序具有语义，因此保持不变；此函数只处理 `JsonValue`，不存在循环引用。
 */
function stableSerialize(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${stableSerialize(value[key]!)}`)
    .join(',')}}`;
}
