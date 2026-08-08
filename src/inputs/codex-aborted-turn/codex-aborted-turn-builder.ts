/**
 * 旧 Codex 中断恢复语义到 cancelled `AgentActivityEntry` 的构建器，非当前生产主链。
 *
 * extractor 把 rollout 聚合成 `CodexExtractedAbortedTurn` 后调用导出函数；本文件按时间和 sequence
 * 排序 timeline，将“并行调用、出现任一结果后再发起下一批”划分为 tool wave，并为每一 wave
 * 生成一个 step 的 LLM 请求/响应和成对工具事件，最后补一个 `cancelled` LLM 响应。
 *
 * 所有函数均为同步纯构建，不读取文件、网络或环境变量。ID 使用确定性 SHA-256，因此同一中断
 * turn 重试会生成相同 ID，配合 checkpoint 去重；最终字段统一交给 entry builder 规范化时间格式。
 */
import * as crypto from 'node:crypto';
import { buildAgentActivityEntry, timestampToUnixNanos } from '../../normalization/entry-builder.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import type {
  CodexExtractedAbortedTurn,
  CodexTimelineAssistantMessage,
  CodexTimelineEvent,
  CodexTimelineToolCall,
  CodexTimelineToolResult,
  CodexTokenUsage,
  CodexTokenUsageSample,
} from './codex-aborted-turn-types.js';

/** 一批可并行执行的工具调用及其已知结果；看到该批首个结果后，后续调用归入下一 wave。 */
interface ToolWave {
  calls: CodexTimelineToolCall[];
  results: Map<string, CodexTimelineToolResult>;
  hasResult: boolean;
}

/**
 * 把一个已提取的中断 turn 构建为完整、可关联的标准事件序列。
 * @param turn extractor 产出的稳定语义对象。
 * @returns 按逻辑流程排列的 user 输入、LLM 请求/响应、工具调用/结果；末项一定是 cancelled 响应。
 */
export function buildCodexAbortedTurnEntries(turn: CodexExtractedAbortedTurn): AgentActivityEntry[] {
  const traceId = hashId([turn.sessionId, turn.transcriptTurnId, 'trace'], 32);
  const agentSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'agent'], 16);
  const turnId = `${turn.sessionId}:aborted:${turn.transcriptTurnId}`;
  const model = turn.model || 'unknown';
  const base: Record<string, JsonValue> = {
    trace_id: traceId,
    'gen_ai.session.id': turn.sessionId,
    'gen_ai.turn.id': turnId,
    'gen_ai.agent.type': 'codex',
    'gen_ai.agent.id': turn.sessionId,
    'gen_ai.provider.name': turn.provider,
    'agent.codex.transcript_turn_id': turn.transcriptTurnId,
    'agent.codex.turn_status': 'interrupted',
    ...(turn.cwd ? { 'agent.codex.cwd': turn.cwd } : {}),
  };
  const records: AgentActivityEntry[] = [];
  const timeline = [...turn.timeline].sort(compareTimelineEvents);
  const waves = buildToolWaves(timeline);
  const messagesByStep = groupMessagesByStep(timeline, waves);
  const usageByStep = groupUsageByStep(turn.usageSamples, timeline, waves, messagesByStep);

  if (turn.prompt) {
    records.push(buildEntry({
      ...base,
      timestamp: turn.startedAtMs,
      'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'other'], 32),
      'event.name': 'other',
      span_id: agentSpanId,
      // 合成根父 ID 与 OTLP converter 的 createTraceParentContext 哨兵保持一致。
      // 它名义上指向的 ENTRY Span 只会在 OTLP 路径由 converter 合成，JSONL 不会输出对应记录；
      // 消费方把它视为外部根节点，不应尝试在事件列表中查找。


      parent_span_id: '0000000000000001',
      'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: turn.prompt }] }],
    }));
  }

  records.push(buildLlmRequest(turn, base, model, 1, turn.startedAtMs, turn.prompt
    ? [{ role: 'user', parts: [{ type: 'text', content: turn.prompt }] }]
    : undefined));

  for (let index = 0; index < waves.length; index++) {
    const wave = waves[index]!;
    const step = index + 1;
    if (step > 1) {
      const previousWave = waves[index - 1]!;
      records.push(buildLlmRequest(
        turn,
        base,
        model,
        step,
        requestTimestamp(previousWave),
        toolResultInput(previousWave),
      ));
    }

    records.push(buildToolCallResponse(
      turn,
      base,
      model,
      step,
      wave,
      messagesByStep.get(step) ?? [],
      usageByStep.get(step),
    ));
    for (const tool of wave.calls) {
      records.push(...buildToolEntries(turn, tool, wave.results.get(tool.callId), base, step));
    }
  }

  const finalStep = waves.length + 1;
  if (waves.length > 0) {
    const previousWave = waves[waves.length - 1]!;
    records.push(buildLlmRequest(
      turn,
      base,
      model,
      finalStep,
      requestTimestamp(previousWave),
      toolResultInput(previousWave),
    ));
  }
  records.push(buildCancelledResponse(
    turn,
    base,
    model,
    finalStep,
    messagesByStep.get(finalStep) ?? [],
    usageByStep.get(finalStep),
  ));

  return records;
}

/**
 * 根据调用和结果的交错关系划分 ReAct 工具波次。
 * 同一结果出现前连续声明的工具视为并行；结果出现后再声明的工具开启下一 step。
 */
function buildToolWaves(timeline: CodexTimelineEvent[]): ToolWave[] {
  const waves: ToolWave[] = [];
  const callWaves = new Map<string, ToolWave>();
  let currentWave: ToolWave | undefined;

  for (const event of timeline) {
    if (event.kind === 'tool_call') {
      if (!currentWave || currentWave.hasResult) {
        currentWave = { calls: [], results: new Map(), hasResult: false };
        waves.push(currentWave);
      }
      currentWave.calls.push(event);
      callWaves.set(event.callId, currentWave);
      continue;
    }
    if (event.kind !== 'tool_result') continue;
    const wave = callWaves.get(event.callId);
    if (!wave) continue;
    wave.results.set(event.callId, event);
    wave.hasResult = true;
  }

  return waves;
}

/** 把 assistant 文本归到最近已完成工具 wave 之后的 step，保留同一 step 内原顺序。 */
function groupMessagesByStep(
  timeline: CodexTimelineEvent[],
  waves: ToolWave[],
): Map<number, CodexTimelineAssistantMessage[]> {
  const lastResultSequence = waves.flatMap(wave => {
    const sequences = [...wave.results.values()].map(result => result.sequence);
    return sequences.length > 0 ? [Math.max(...sequences)] : [];
  });
  const messagesByStep = new Map<number, CodexTimelineAssistantMessage[]>();
  for (const event of timeline) {
    if (event.kind !== 'assistant_message') continue;
    const step = 1 + lastResultSequence.filter(sequence => sequence < event.sequence).length;
    const messages = messagesByStep.get(step) ?? [];
    messages.push(event);
    messagesByStep.set(step, messages);
  }
  return messagesByStep;
}

/**
 * 将累计 token 快照分配给时间/sequence 上最近的消息或工具调用边界。
 * 同一步出现多个样本时保留最后一个，代表该 step 可获得的最新累计值。
 */
function groupUsageByStep(
  samples: CodexTokenUsageSample[],
  timeline: CodexTimelineEvent[],
  waves: ToolWave[],
  messagesByStep: Map<number, CodexTimelineAssistantMessage[]>,
): Map<number, CodexTokenUsage> {
  const toolSteps = new Map<string, number>();
  waves.forEach((wave, index) => {
    for (const call of wave.calls) toolSteps.set(call.callId, index + 1);
  });
  const messageSteps = new Map<CodexTimelineAssistantMessage, number>();
  for (const [step, messages] of messagesByStep) {
    for (const message of messages) messageSteps.set(message, step);
  }
  const boundaries: Array<{ timestampMs: number; sequence: number; step: number }> = [];
  for (const event of timeline) {
    if (event.kind === 'tool_call') {
      boundaries.push({
        timestampMs: event.timestampMs,
        sequence: event.sequence,
        step: toolSteps.get(event.callId) ?? 1,
      });
    } else if (event.kind === 'assistant_message') {
      const step = messageSteps.get(event);
      if (step !== undefined) boundaries.push({ timestampMs: event.timestampMs, sequence: event.sequence, step });
    }
  }
  boundaries.sort((left, right) => left.timestampMs - right.timestampMs || left.sequence - right.sequence);

  const usageByStep = new Map<number, CodexTokenUsage>();
  for (const sample of samples) {
    let latest: { timestampMs: number; sequence: number; step: number } | undefined;
    for (const boundary of boundaries) {
      const isBefore = boundary.timestampMs < sample.timestampMs
        || boundary.timestampMs === sample.timestampMs && boundary.sequence < sample.sequence;
      if (isBefore) latest = boundary;
      else break;
    }
    if (latest) usageByStep.set(latest.step, sample.usage);
  }
  return usageByStep;
}

/** 将内部 token 结构映射为标准 `gen_ai.usage.*` 字段；没有样本时返回空对象便于展开。 */
function usageFields(usage: CodexTokenUsage | undefined): Record<string, JsonValue> {
  if (!usage) return {};
  return {
    'gen_ai.usage.input_tokens': usage.inputTokens,
    'gen_ai.usage.output_tokens': usage.outputTokens,
    'gen_ai.usage.cache_read.input_tokens': usage.cachedInputTokens,
    'gen_ai.usage.cache_creation.input_tokens': usage.cacheCreationTokens,
    'gen_ai.usage.total_tokens': usage.totalTokens,
    ...(usage.reasoningOutputTokens !== undefined
      ? { 'gen_ai.usage.reasoning_output_tokens': usage.reasoningOutputTokens }
      : {}),
  };
}

/** 为指定 step 创建确定性 ID 的 `llm.request`，并可注入用户输入或上一 wave 工具结果。 */
function buildLlmRequest(
  turn: CodexExtractedAbortedTurn,
  base: Record<string, JsonValue>,
  model: string,
  step: number,
  timestamp: number,
  inputMessages?: JsonValue,
): AgentActivityEntry {
  const stepId = `${base['gen_ai.turn.id']}:s${step}`;
  const stepSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'step', String(step)], 16);
  const llmSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'llm', String(step)], 16);
  return buildEntry({
    ...base,
    timestamp,
    'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'request', String(step)], 32),
    'event.name': 'llm.request',
    span_id: llmSpanId,
    parent_span_id: stepSpanId,
    'gen_ai.step.id': stepId,
    'gen_ai.request.model': model,
    ...(inputMessages !== undefined ? { 'gen_ai.input.messages_delta': inputMessages } : {}),
    ...sharedLlmFields(turn),
  });
}

/** 构建以 `tool_call` 结束的 LLM 响应，输出 reasoning 文本和本 wave 的全部工具声明。 */
function buildToolCallResponse(
  turn: CodexExtractedAbortedTurn,
  base: Record<string, JsonValue>,
  model: string,
  step: number,
  wave: ToolWave,
  messages: CodexTimelineAssistantMessage[],
  usage: CodexTokenUsage | undefined,
): AgentActivityEntry {
  const stepId = `${base['gen_ai.turn.id']}:s${step}`;
  const stepSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'step', String(step)], 16);
  const llmSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'llm', String(step)], 16);
  return buildEntry({
    ...base,
    timestamp: wave.calls[0]!.timestampMs,
    'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'response', String(step)], 32),
    'event.name': 'llm.response',
    span_id: llmSpanId,
    parent_span_id: stepSpanId,
    'gen_ai.step.id': stepId,
    'gen_ai.request.model': model,
    'gen_ai.response.model': model,
    'gen_ai.response.finish_reasons': ['tool_call'],
    'gen_ai.output.messages': toolResponseMessages(messages, wave.calls),
    ...usageFields(usage),
    ...sharedLlmFields(turn),
  });
}

/** 为最终 step 构建中断时间上的 `cancelled` LLM 响应，并附带尚未完成前的 assistant 文本/token。 */
function buildCancelledResponse(
  turn: CodexExtractedAbortedTurn,
  base: Record<string, JsonValue>,
  model: string,
  step: number,
  messages: CodexTimelineAssistantMessage[],
  usage: CodexTokenUsage | undefined,
): AgentActivityEntry {
  const stepId = `${base['gen_ai.turn.id']}:s${step}`;
  const stepSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'step', String(step)], 16);
  const llmSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'llm', String(step)], 16);
  return buildEntry({
    ...base,
    timestamp: turn.abortedAtMs,
    'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'response', String(step)], 32),
    'event.name': 'llm.response',
    span_id: llmSpanId,
    parent_span_id: stepSpanId,
    'gen_ai.step.id': stepId,
    'gen_ai.request.model': model,
    'gen_ai.response.model': model,
    'gen_ai.response.finish_reasons': ['cancelled'],
    ...(messages.length > 0 ? { 'gen_ai.output.messages': agentResponseMessages(messages) } : {}),
    ...usageFields(usage),
    ...sharedLlmFields(turn),
  });
}

/**
 * 为一次工具调用生成成对 `tool.call/tool.result`。
 * 缺少结果表示工具在中断时仍未完成：结果时间使用 abort 时间且状态为 cancelled；已有结果则
 * 标为 success，并在非负时写入持续时长。
 */
function buildToolEntries(
  turn: CodexExtractedAbortedTurn,
  tool: CodexTimelineToolCall,
  result: CodexTimelineToolResult | undefined,
  base: Record<string, JsonValue>,
  step: number,
): AgentActivityEntry[] {
  const stepId = `${base['gen_ai.turn.id']}:s${step}`;
  const stepSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'step', String(step)], 16);
  const spanId = hashId([turn.sessionId, turn.transcriptTurnId, 'tool', tool.callId], 16);
  const records = [buildEntry({
    ...base,
    timestamp: tool.timestampMs,
    'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'tool-call', tool.callId], 32),
    'event.name': 'tool.call',
    span_id: spanId,
    parent_span_id: stepSpanId,
    'gen_ai.step.id': stepId,
    'gen_ai.tool.name': tool.name,
    'gen_ai.tool.call.id': tool.callId,
    ...(tool.input !== undefined ? { 'gen_ai.tool.call.arguments': tool.input } : {}),
  })];
  const completed = result !== undefined;
  const resultEntry: Record<string, JsonValue> = {
    ...base,
    timestamp: result?.timestampMs ?? turn.abortedAtMs,
    'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'tool-result', tool.callId], 32),
    'event.name': 'tool.result',
    span_id: spanId,
    parent_span_id: stepSpanId,
    'gen_ai.step.id': stepId,
    'gen_ai.tool.name': tool.name,
    'gen_ai.tool.call.id': tool.callId,
    'tool.result.status': completed ? 'success' : 'cancelled',
  };
  if (completed && result.output !== undefined) resultEntry['gen_ai.tool.call.result'] = result.output;
  const duration = completed ? result.timestampMs - tool.timestampMs : undefined;
  if (duration !== undefined && duration >= 0) resultEntry['gen_ai.tool.call.duration'] = duration;
  records.push(buildEntry(resultEntry));
  return records;
}

/** 取上一 wave 最晚结果时间作为下一请求起点；没有结果时退回最晚调用时间。 */
function requestTimestamp(wave: ToolWave): number {
  const resultTimes = [...wave.results.values()].map(result => result.timestampMs);
  return resultTimes.length > 0
    ? Math.max(...resultTimes)
    : Math.max(...wave.calls.map(tool => tool.timestampMs));
}

/** 把已完成工具结果包装成下一 LLM 请求的 `tool_call_response` 消息；无结果时省略。 */
function toolResultInput(wave: ToolWave): JsonValue | undefined {
  const completed = wave.calls.flatMap(tool => {
    const result = wave.results.get(tool.callId);
    return result ? [{
      type: 'tool_call_response',
      id: tool.callId,
      response: result.output ?? null,
    }] : [];
  });
  return completed.length > 0 ? [{ role: 'tool', parts: completed }] : undefined;
}

/** 将 reasoning 文本和工具声明组合为标准 assistant `tool_call` 输出消息。 */
function toolResponseMessages(
  messages: CodexTimelineAssistantMessage[],
  tools: CodexTimelineToolCall[],
): JsonValue {
  const parts: JsonValue[] = [
    ...messages.map(message => ({ type: 'reasoning', content: message.content })),
    ...tools.map(tool => ({
      type: 'tool_call',
      id: tool.callId,
      name: tool.name,
      arguments: tool.input ?? null,
    })),
  ];
  return [{ role: 'assistant', parts, finish_reason: 'tool_call' }];
}

/** 将中断前 assistant 文本包装成 finish_reason 为 cancelled 的标准输出消息。 */
function agentResponseMessages(messages: CodexTimelineAssistantMessage[]): JsonValue {
  return [{
    role: 'assistant',
    parts: messages.map(message => ({ type: 'reasoning', content: message.content })),
    finish_reason: 'cancelled',
  }];
}

/** 汇总基础/开发者指令和动态工具定义，供同一 turn 的所有 LLM 事件复用。 */
function sharedLlmFields(turn: CodexExtractedAbortedTurn): Record<string, JsonValue> {
  const instructions: JsonValue[] = [];
  if (turn.baseInstructions) instructions.push({ type: 'text', content: turn.baseInstructions });
  if (turn.developerInstructions) instructions.push({ type: 'text', content: turn.developerInstructions });
  return {
    ...(instructions.length > 0 ? { 'gen_ai.system_instructions': instructions } : {}),
    ...(turn.toolDefinitions !== undefined ? { 'gen_ai.tool.definitions': turn.toolDefinitions } : {}),
  };
}

/** 先按毫秒、再按 extractor 分配的 sequence 排序，解决相同时间戳的稳定顺序问题。 */
function compareTimelineEvents(left: CodexTimelineEvent, right: CodexTimelineEvent): number {
  return left.timestampMs - right.timestampMs || left.sequence - right.sequence;
}

/**
 * 去掉仅供本构建器使用的临时 `timestamp`，补充纳秒时间并调用统一 entry builder 规范字段。
 * 缺失时间时以当前时间兜底；正常调用路径都会显式传入 transcript 时间。
 */
function buildEntry(fields: Record<string, JsonValue>): AgentActivityEntry {
  const timestamp = typeof fields.timestamp === 'number' ? fields.timestamp : Date.now();
  const { timestamp: _timestamp, ...rest } = fields;
  return buildAgentActivityEntry({
    ...rest,
    timestamp,
    time_unix_nano: timestampToUnixNanos(timestamp),
  }) as AgentActivityEntry;
}

/** 使用 NUL 分隔后计算 SHA-256 并按目标长度截断，生成可重复的 trace/span/event ID。 */
function hashId(parts: string[], length: number): string {
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, length);
}
