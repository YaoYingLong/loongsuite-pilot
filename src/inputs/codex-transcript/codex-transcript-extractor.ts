/**
 * Codex rollout JSONL 到 session/turn/step/tool 语义模型的解析器。
 *
 * 它识别 task_started/turn_context/terminal 边界，将 LLM 响应波次、token 样本与工具结果关联，
 * 并判断非 terminal 时哪些 leading steps 已闭合可增量提交。本文件不创建输出事件或写 checkpoint。
 */
import * as path from 'node:path';
import type { JsonValue } from '../../types/index.js';
import type {
  CodexPartialTurnExtraction,
  CodexExtractedTranscriptTurn,
  CodexTerminalStatus,
  CodexTranscriptMeta,
  CodexTranscriptSourceRecord,
  CodexTranscriptSourceRange,
  CodexTranscriptStep,
  CodexTranscriptTool,
  CodexTranscriptUsage,
} from './codex-transcript-types.js';
import { timestampMs } from './codex-transcript-utils.js';

/**
 * 从 `session_meta` 记录提取会话 ID、provider、基础指令和动态工具定义。
 * @returns 记录类型或 payload 不符合预期时返回 `null`，让扫描者继续寻找下一条元数据。
 */
export function extractCodexTranscriptMeta(record: Record<string, unknown>): CodexTranscriptMeta | null {
  if (record.type !== 'session_meta') return null;
  const payload = asRecord(record.payload);
  if (!payload) return null;

  const baseInstructions = readInstructionText(payload.base_instructions);
  const toolDefinitions = Array.isArray(payload.dynamic_tools)
    ? toJsonValue(payload.dynamic_tools)
    : undefined;
  return {
    sessionId: stringValue(payload.id) ?? '',
    provider: stringValue(payload.model_provider) ?? 'openai',
    ...(baseInstructions ? { baseInstructions } : {}),
    ...(toolDefinitions !== undefined ? { toolDefinitions } : {}),
  };
}

/**
 * 解析必须已经包含 `task_complete` 或 `turn_aborted` 的完整 turn。
 * @param expectedTurnId Input 从 task_started 确认的目标 turn，其他 turn 的记录会被忽略。
 * @returns terminal 缺失、ID 不匹配或有效数据不足时为 `null`。
 */
export function extractCodexTerminalTurn(
  records: Record<string, unknown>[],
  meta: CodexTranscriptMeta | null,
  fallbackSessionId: string,
  expectedTurnId: string,
): CodexExtractedTranscriptTurn | null {
  return extractCodexTurn(toSourceRecords(records), meta, fallbackSessionId, expectedTurnId, {
    requireTerminal: true,
  })?.turn ?? null;
}

/**
 * 解析尚未结束的 turn，供不需要真实字节边界的测试和兼容调用使用。
 * 数组序号会被临时当作偏移；生产增量提交应使用 `extractCodexPartialTurnWithBoundaries()`。
 */
export function extractCodexPartialTurn(
  records: Record<string, unknown>[],
  meta: CodexTranscriptMeta | null,
  fallbackSessionId: string,
  expectedTurnId: string,
  opts: {
    startedAtMs?: number;
    model?: string;
    cwd?: string;
    developerInstructions?: string;
  } = {},
): CodexExtractedTranscriptTurn | null {
  return extractCodexTurn(toSourceRecords(records), meta, fallbackSessionId, expectedTurnId, {
    requireTerminal: false,
    startedAtMs: opts.startedAtMs,
    model: opts.model,
    cwd: opts.cwd,
    developerInstructions: opts.developerInstructions,
  })?.turn ?? null;
}

/**
 * 解析活跃 turn，并同时计算哪些 leading steps 已闭合及其真实 JSONL 字节范围。
 *
 * Input 只会推进到 `consumedEndOffset`，后续仍在写入的 response/tool wave 留到下一周期处理，
 * 从而保证 checkpoint 与已经发出的事件一致。
 */
export function extractCodexPartialTurnWithBoundaries(
  records: CodexTranscriptSourceRecord[],
  meta: CodexTranscriptMeta | null,
  fallbackSessionId: string,
  expectedTurnId: string,
  opts: {
    startedAtMs?: number;
    model?: string;
    cwd?: string;
    developerInstructions?: string;
  } = {},
): CodexPartialTurnExtraction | null {
  return extractCodexTurn(records, meta, fallbackSessionId, expectedTurnId, {
    requireTerminal: false,
    startedAtMs: opts.startedAtMs,
    model: opts.model,
    cwd: opts.cwd,
    developerInstructions: opts.developerInstructions,
  });
}

/** 解析期间为 step 附加源字节边界和“是否可以增量提交”的内部状态。 */
interface StepEnvelope {
  step: CodexTranscriptStep;
  sourceRange: CodexTranscriptSourceRange;
  llmClosed: boolean;
  followedByAnotherWave: boolean;
}

/**
 * 完整与增量入口共享的状态机。
 *
 * 函数按 JSONL 原顺序消费 record，根据 `turn_context`/`task_started` 锚定 turn，把多种 Codex
 * response_item 和 event_msg 形状合并为 step/tool，并在 terminal 处停止。它只转换内存数据，
 * 不写 checkpoint；无法构成目标 turn 时返回 `null`。
 */
function extractCodexTurn(
  records: CodexTranscriptSourceRecord[],
  meta: CodexTranscriptMeta | null,
  fallbackSessionId: string,
  expectedTurnId: string,
  opts: {
    requireTerminal: boolean;
    startedAtMs?: number;
    model?: string;
    cwd?: string;
    developerInstructions?: string;
  },
): CodexPartialTurnExtraction | null {
  let currentTurnId = opts.requireTerminal ? '' : expectedTurnId;
  let startedAtMs = opts.startedAtMs ?? 0;
  let terminalAtMs = 0;
  let status: CodexTerminalStatus | null = null;
  let sawTerminal = false;
  let finalText: string | undefined;
  let model = opts.model ?? 'unknown';
  let cwd = opts.cwd;
  let developerInstructions = opts.developerInstructions;
  let prompt: string | undefined;
  const promptParts: string[] = [];
  const inputMessages: JsonValue[] = [];
  const stepEnvelopes: StepEnvelope[] = [];
  const unmatchedTokenUsages: CodexTranscriptUsage[] = [];
  const toolSteps = new Map<string, StepEnvelope>();
  const webSearchStarts = new Map<string, number>();
  const webSearchEnds = new Map<string, number>();
  let currentStep: StepEnvelope | null = null;
  let lastUsage: CodexTranscriptUsage | undefined;
  let lastActivityAtMs = 0;

  /** 取得当前 response wave；若尚未创建，则以当前源记录边界初始化一个 step。 */
  const beginStep = (timestamp: number, source: CodexTranscriptSourceRecord): StepEnvelope => {
    if (!currentStep) {
      const previous = stepEnvelopes.at(-1);
      if (previous?.llmClosed) previous.followedByAnotherWave = true;
      currentStep = {
        step: {
          startedAtMs: timestamp,
          responseAtMs: timestamp,
          hasResponseEvidence: false,
          completedAtMs: timestamp,
          reasoning: [],
          tools: [],
        },
        sourceRange: {
          startOffset: source.startOffset,
          endOffset: source.endOffset,
        },
        llmClosed: false,
        followedByAnotherWave: false,
      };
    }
    return currentStep;
  };

  /** 把新关联的源记录纳入 step 范围，最终 checkpoint 才能推进到完全闭合的边界。 */
  const touchStep = (envelope: StepEnvelope, source: CodexTranscriptSourceRecord): void => {
    envelope.sourceRange.startOffset = Math.min(envelope.sourceRange.startOffset, source.startOffset);
    envelope.sourceRange.endOffset = Math.max(envelope.sourceRange.endOffset, source.endOffset);
  };

  /** 只有“存在工具且每个工具都有完成时间”才表示工具阶段整体闭合。 */
  const stepToolsComplete = (step: CodexTranscriptStep): boolean => (
    step.tools.length > 0 && step.tools.every(tool => tool.completedAtMs !== undefined)
  );

  /** 将有实际内容的当前 step 放入结果，并清空当前指针；terminal 可用 force 保留空闭合 step。 */
  const flushCurrentStep = (force = false): void => {
    if (!currentStep) return;
    const step = currentStep.step;
    if (force || step.reasoning.length > 0 || step.tools.length > 0 || step.finalText) {
      stepEnvelopes.push(currentStep);
    }
    currentStep = null;
  };
  // TypeScript 无法推断 beginStep/flushCurrentStep 通过闭包对 currentStep 的修改，因此使用
  // 明确返回类型的 getter 读取可变状态，避免控制流分析把它错误缩窄为 null。
  const activeStep = (): StepEnvelope | null => currentStep;
  /** 去重后拼接多段用户 prompt；rollout 可能用不同记录重复表达同一文本。 */
  const appendPrompt = (value: string | undefined): void => {
    if (!value || promptParts.includes(value)) return;
    promptParts.push(value);
    prompt = promptParts.join('\n');
  };
  /** 记录最近有效活动时间，用于缺少显式开始/结束时间的防御性回退。 */
  const markActivity = (timestamp: number): void => {
    if (timestamp > 0) lastActivityAtMs = timestamp;
  };

  // JSONL 记录顺序本身定义了 turn 的事件顺序，不能并行或排序处理。
  for (const source of records) {
    const record = source.record;
    const payload = asRecord(record.payload);
    if (!payload) continue;
    const timestamp = timestampMs(record, Date.now());

    // turn_context 携带模型、cwd 和 developer instructions；只接受目标 turn 的上下文。
    if (record.type === 'turn_context') {
      const turnId = stringValue(payload.turn_id);
      if (turnId !== expectedTurnId) continue;
      currentTurnId = turnId;
      startedAtMs ||= timestamp;
      markActivity(timestamp);
      model = stringValue(payload.model) ?? model;
      cwd = stringValue(payload.cwd) ?? cwd;
      developerInstructions = stringValue(payload.developer_instructions) ?? developerInstructions;
      continue;
    }

    if (record.type === 'event_msg' && payload.type === 'task_started') {
      const turnId = stringValue(payload.turn_id);
      if (turnId === expectedTurnId) {
        currentTurnId = turnId;
        startedAtMs ||= timestamp;
        markActivity(timestamp);
      }
      continue;
    }

    // 在 task_started/turn_context 锚定目标 turn 之前，不把其他会话活动误归入当前 turn。
    if (currentTurnId !== expectedTurnId) continue;

    if (record.type === 'event_msg') {
      if (payload.type === 'user_message') {
        // event_msg.user_message 是一种 prompt 形态；appendPrompt 会过滤空值和中断控制注入。
        appendPrompt(stringValue(payload.message));
        markActivity(timestamp);
        continue;
      }
      if (payload.type === 'agent_message') {
        // agent_message 表示这一轮 LLM 已产生响应证据；若前一工具 wave 已闭合，先结算旧 step。
        const active = activeStep();
        if (active && stepToolsComplete(active.step)) flushCurrentStep();
        const message = stringValue(payload.message);
        if (message) {
          // 响应文本可能在没有显式 request 记录时出现，因此按上次活动时间惰性创建 step。
          const next = beginStep(lastActivityAtMs || timestamp, source);
          touchStep(next, source);
          const nextStep = next.step;
          nextStep.responseAtMs = timestamp;
          nextStep.hasResponseEvidence = true;
          // 某些 Codex 版本会在不同记录形态重复同一句 agent_message，只去掉相邻重复项。
          if (nextStep.reasoning[nextStep.reasoning.length - 1] !== message) {
            nextStep.reasoning.push(message);
          }
        }
        markActivity(timestamp);
        continue;
      }
      if (payload.type === 'web_search_start') {
        // start/end 事件为 web_search_call 补充比 response_item 时间更精确的执行边界。
        const callId = stringValue(payload.call_id);
        if (callId) webSearchStarts.set(callId, timestamp);
        const active = activeStep();
        if (active && stepToolsComplete(active.step)) flushCurrentStep();
        const next = beginStep(lastActivityAtMs || timestamp, source);
        touchStep(next, source);
        const nextStep = next.step;
        nextStep.responseAtMs = timestamp;
        // 搜索开始本身证明模型已返回工具选择，即使没有 assistant 文本也应形成 llm.response。
        nextStep.hasResponseEvidence = true;
        markActivity(timestamp);
        continue;
      }
      if (payload.type === 'web_search_end') {
        const callId = stringValue(payload.call_id);
        if (callId) {
          // 先缓存结束时间；若对应 tool 已经创建，则立即补齐工具和 step 的完成时间。
          webSearchEnds.set(callId, timestamp);
          const envelope = toolSteps.get(callId);
          const step = envelope?.step;
          const tool = step?.tools.find(candidate => candidate.callId === callId);
          if (tool) {
            tool.completedAtMs = timestamp;
            // 非空断言成立是因为 tool 只能从上面可选链得到的 step 中找到。
            step!.completedAtMs = Math.max(step!.completedAtMs, timestamp);
            touchStep(envelope!, source);
          }
        }
        continue;
      }
      if (payload.type === 'token_count') {
        // token_count 属于累计/最近一次采样；只有当前 wave 已出现 response 证据时才能可靠归属。
        const usage = extractLastTokenUsage(payload.info);
        if (!usage) continue;
        const envelope = activeStep();
        if (envelope?.step.hasResponseEvidence) {
          // 累计快照归属于当前 response wave，并把 LLM 标记为闭合；随后 flush 允许下个 wave 新建 step。
          envelope.step.tokenUsage = usage;
          envelope.step.completedAtMs = Math.max(envelope.step.completedAtMs, timestamp);
          envelope.llmClosed = true;
          touchStep(envelope, source);
          lastUsage = usage;
          markActivity(timestamp);
          flushCurrentStep();
        } else if (!sameUsage(lastUsage, usage)) {
          // 未锚定样本不能顺延给下一个 response wave，否则会把前一请求的 usage 记到后一请求。
          unmatchedTokenUsages.push(usage);
          // 仍更新 lastUsage，避免连续相同的未锚定样本重复进入诊断数组。
          lastUsage = usage;
        }
        continue;
      }
      if (payload.type === 'task_complete' && stringValue(payload.turn_id) === expectedTurnId) {
        // task_complete 提供正常终态和可选最终文本；终态之后的记录属于后续 turn，无需继续扫描。
        status = 'completed';
        sawTerminal = true;
        terminalAtMs = timestamp;
        // 最终文本不一定另有 agent_message，暂存后由终态收尾逻辑补入最后一个 step。
        finalText = stringValue(payload.last_agent_message);
        break;
      }
      if (payload.type === 'turn_aborted' && stringValue(payload.turn_id) === expectedTurnId) {
        // turn_aborted 没有正常最终文本，Builder 会把最后 response/tool result 标记为 cancelled。
        status = 'interrupted';
        sawTerminal = true;
        terminalAtMs = timestamp;
        break;
      }
      continue;
    }

    if (record.type !== 'response_item') continue;
    const itemType = stringValue(payload.type);
    if (itemType === 'message') {
      const role = stringValue(payload.role);
      if (role === 'assistant') {
        // assistant message 属于当前 LLM 输出 wave；若上一工具阶段已闭合，先开始一个新 step。
        const active = activeStep();
        if (active && stepToolsComplete(active.step)) flushCurrentStep();
        const envelope = beginStep(lastActivityAtMs || timestamp, source);
        touchStep(envelope, source);
        const step = envelope.step;
        step.responseId ??= stringValue(payload.id);
        step.responseAtMs = timestamp;
        step.hasResponseEvidence = true;
        const message = extractMessageText(payload.content);
        if (message && step.reasoning[step.reasoning.length - 1] !== message) {
          step.reasoning.push(message);
        }
      } else if (role) {
        // user/system 等非 assistant 消息属于请求上下文，而不是模型输出。
        const message = transcriptInputMessage(role, payload.content);
        if (message) {
          inputMessages.push(message);
          if (role === 'user') appendPrompt(message.parts[0]?.content);
        }
        markActivity(timestamp);
      }
      continue;
    }

    if (itemType === 'reasoning') {
      // reasoning item 本身可能不带可展示文本，但它仍是 response 已开始的证据和 step 边界锚点。
      const active = activeStep();
      if (active && stepToolsComplete(active.step)) flushCurrentStep();
      const envelope = beginStep(lastActivityAtMs || timestamp, source);
      touchStep(envelope, source);
      const step = envelope.step;
      step.responseId ??= stringValue(payload.id);
      step.responseAtMs = timestamp;
      step.hasResponseEvidence = true;
      markActivity(timestamp);
      continue;
    }

    // function/custom/tool_search/web_search 的调用形状不同，先统一为 CodexTranscriptTool。
    const call = transcriptToolCall(itemType, payload, timestamp);
    if (call) {
      const active = activeStep();
      if (active && stepToolsComplete(active.step)) flushCurrentStep();
      if (call.name === 'web_search') {
        // web_search 的 event_msg start/end 比 response_item 时间更准确，优先用已缓存边界覆盖。
        call.startedAtMs = webSearchStarts.get(call.callId) ?? (lastActivityAtMs || timestamp);
        call.completedAtMs = webSearchEnds.get(call.callId) ?? timestamp;
      }
      const envelope = beginStep(lastActivityAtMs || call.startedAtMs, source);
      touchStep(envelope, source);
      const step = envelope.step;
      step.responseId ??= stringValue(payload.id);
      if (call.name !== 'web_search') {
        // 普通工具调用紧随 LLM response；第一个工具决定 response 时间，后续工具取更早边界。
        step.responseAtMs = step.tools.length === 0
          ? call.startedAtMs
          : Math.min(step.responseAtMs, call.startedAtMs);
        step.hasResponseEvidence = true;
      } else if (!step.hasResponseEvidence) {
        // 只有 web_search 且尚无其他 response 证据时，搜索完成时间可作为该 wave 的响应锚点。
        step.responseAtMs = call.name === 'web_search'
          ? call.completedAtMs ?? call.startedAtMs
          : call.startedAtMs;
        step.hasResponseEvidence = true;
      }
      step.tools.push(call);
      toolSteps.set(call.callId, envelope);
      markActivity(call.completedAtMs ?? timestamp);
      continue;
    }

    // 输出通过 callId 回填到创建调用时记录的 step；找不到调用时宁可跳过，也不猜测归属。
    const toolOutput = transcriptToolOutput(itemType, payload);
    if (!toolOutput) continue;
    const envelope = toolSteps.get(toolOutput.callId);
    if (!envelope) continue;
    const step = envelope.step;
    const tool = step.tools.find(candidate => candidate.callId === toolOutput.callId);
    if (!tool) continue;
    // callId 精确匹配成功后，输出时间闭合工具 span，并把该源记录范围并入所属 step。
    tool.completedAtMs = timestamp;
    tool.output = toolOutput.output;
    step.completedAtMs = Math.max(step.completedAtMs, timestamp);
    touchStep(envelope, source);
    markActivity(timestamp);
  }

  // 完整解析必须有 terminal；返回 null 会让 Input 保存 pendingTerminal 并在后续周期重试。
  if (opts.requireTerminal && (!status || !terminalAtMs)) return null;

  const finalActiveStep = activeStep();
  if (finalActiveStep && stepToolsComplete(finalActiveStep.step)) flushCurrentStep();
  if (!status && !opts.requireTerminal) {
    if (stepEnvelopes.length === 0 && !prompt) return null;
    terminalAtMs = lastActivityAtMs || startedAtMs || Date.now();
    status = 'completed';
  } else if (status === 'completed') {
    let terminalEnvelope = activeStep() ?? stepEnvelopes.at(-1) ?? null;
    if (!terminalEnvelope) {
      const terminalSource = records.at(-1) ?? {
        startOffset: 0,
        endOffset: 0,
        record: {},
      };
      terminalEnvelope = beginStep(lastActivityAtMs || startedAtMs || terminalAtMs, terminalSource);
      terminalEnvelope.step.responseAtMs = terminalAtMs;
    }
    if (terminalEnvelope) {
      const step = terminalEnvelope.step;
      if (finalText) {
        if (step.reasoning[step.reasoning.length - 1] === finalText) step.reasoning.pop();
        step.finalText = finalText;
      }
      step.completedAtMs = terminalAtMs;
      if (terminalEnvelope === activeStep()) flushCurrentStep(true);
    }
  } else if (activeStep()) {
    activeStep()!.step.completedAtMs = terminalAtMs;
    flushCurrentStep();
  }

  const resolvedStatus = status ?? 'completed';
  const steps = stepEnvelopes.map(envelope => envelope.step);
  const turn: CodexExtractedTranscriptTurn = {
    sessionId: meta?.sessionId || fallbackSessionId,
    transcriptTurnId: expectedTurnId,
    provider: meta?.provider ?? 'openai',
    model,
    status: resolvedStatus,
    startedAtMs: startedAtMs || terminalAtMs,
    terminalAtMs,
    ...(prompt ? { prompt } : {}),
    inputMessages,
    ...(cwd ? { cwd } : {}),
    ...(developerInstructions ? { developerInstructions } : {}),
    ...(meta?.baseInstructions ? { baseInstructions: meta.baseInstructions } : {}),
    ...(meta?.toolDefinitions !== undefined ? { toolDefinitions: meta.toolDefinitions } : {}),
    steps,
    unmatchedTokenUsages,
  };
  // terminal 已落盘时可提交全部 step；活跃 turn 只能提交从头连续且明确闭合的 step。
  const committedEnvelopes = sawTerminal
    ? stepEnvelopes
    : leadingIncrementallyCommittableSteps(stepEnvelopes);
  return {
    turn,
    committedStepCount: committedEnvelopes.length,
    committedStepRanges: committedEnvelopes.map(envelope => ({ ...envelope.sourceRange })),
    consumedEndOffset: committedEnvelopes.at(-1)?.sourceRange.endOffset ?? records[0]?.startOffset ?? 0,
  };
}

/**
 * 从头选取可安全增量提交的连续 step。
 * 遇到第一个未闭合 LLM wave 或工具尚未完成且后面没有新 wave 的 step 就停止，不能跳跃提交。
 */
function leadingIncrementallyCommittableSteps(envelopes: StepEnvelope[]): StepEnvelope[] {
  const committed: StepEnvelope[] = [];
  for (const envelope of envelopes) {
    if (!envelope.llmClosed) break;
    const toolsComplete = envelope.step.tools.length > 0
      && envelope.step.tools.every(tool => tool.completedAtMs !== undefined);
    if (!toolsComplete && !envelope.followedByAnotherWave) break;
    committed.push(envelope);
  }
  return committed;
}

/** 为无真实文件偏移的兼容入口生成单调伪边界；生产 Input 不使用这些伪偏移写 checkpoint。 */
function toSourceRecords(records: Record<string, unknown>[]): CodexTranscriptSourceRecord[] {
  return records.map((record, index) => ({
    startOffset: index,
    endOffset: index + 1,
    record,
  }));
}

/**
 * 从 `rollout-...-<uuid>.jsonl` 文件名末尾提取 session UUID；不匹配时退回不带扩展名的文件名。
 */
export function sessionIdFromTranscriptPath(filePath: string): string {
  const base = path.basename(filePath, '.jsonl');
  const match = base.match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i);
  return match?.[1] ?? base;
}

/** 将多种 response_item 工具调用载荷统一为内部工具结构；非调用记录返回 `null`。 */
function transcriptToolCall(
  itemType: string | undefined,
  payload: Record<string, unknown>,
  timestamp: number,
): CodexTranscriptTool | null {
  if (itemType === 'web_search_call') {
    const callId = stringValue(payload.call_id) ?? stringValue(payload.id) ?? `web_search:${timestamp}`;
    return {
      callId,
      name: 'web_search',
      input: toJsonValue(parseMaybeJson(payload.action)),
      startedAtMs: timestamp,
      output: toJsonValue({
        ...(payload.status !== undefined ? { status: payload.status } : {}),
        ...(payload.action !== undefined ? { action: parseMaybeJson(payload.action) } : {}),
      }),
      completedAtMs: timestamp,
    };
  }
  if (itemType !== 'function_call' && itemType !== 'custom_tool_call' && itemType !== 'tool_search_call') return null;
  const callId = stringValue(payload.call_id) ?? stringValue(payload.id);
  if (!callId) return null;
  const name = stringValue(payload.name) ?? (itemType === 'tool_search_call' ? 'tool_search' : 'unknown');
  const rawInput = itemType === 'custom_tool_call' ? payload.input : payload.arguments;
  return {
    callId,
    name,
    input: normalizeToolInput(name, parseMaybeJson(rawInput)),
    startedAtMs: timestamp,
  };
}

/** 解析工具输出，并保留可选 status/execution/tools 元数据；缺少 callId 时返回 `null`。 */
function transcriptToolOutput(
  itemType: string | undefined,
  payload: Record<string, unknown>,
): { callId: string; output?: JsonValue } | null {
  if (itemType !== 'function_call_output' && itemType !== 'custom_tool_call_output' && itemType !== 'tool_search_output') return null;
  const callId = stringValue(payload.call_id) ?? stringValue(payload.id);
  if (!callId) return null;
  if (itemType === 'tool_search_output') {
    return {
      callId,
      output: toJsonValue({
        ...(payload.status !== undefined ? { status: payload.status } : {}),
        ...(payload.execution !== undefined ? { execution: payload.execution } : {}),
        ...(payload.tools !== undefined ? { tools: parseMaybeJson(payload.tools) } : {}),
      }),
    };
  }
  return { callId, output: toJsonValue(parseMaybeJson(payload.output)) };
}

/**
 * 对常见命令工具只保留稳定且有分析价值的 command/workdir；其他工具保持 JSON 兼容结构。
 */
function normalizeToolInput(name: string, value: unknown): JsonValue | undefined {
  const input = toJsonValue(value);
  const record = asRecord(value);
  if (name === 'Bash' || name === 'exec_command') {
    const command = stringValue(record?.command) ?? stringValue(record?.cmd);
    if (!command) return input;
    return {
      command,
      ...(stringValue(record?.workdir) ? { workdir: stringValue(record?.workdir)! } : {}),
    };
  }
  if (name === 'apply_patch' && typeof value === 'string') return { command: value };
  return input;
}

/** 将 Codex message content 的多种形状压平为统一 text part；无文本时返回 `null`。 */
function transcriptInputMessage(role: string, content: unknown): { role: string; parts: Array<{ type: 'text'; content: string }> } | null {
  const text = extractMessageText(content);
  return text ? { role, parts: [{ type: 'text', content: text }] } : null;
}

/** 把未知 JSON 值安全缩窄为普通对象；数组和 null 不属于 record。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** 只返回非空字符串，避免把空值当作有效 ID、角色或文本。 */
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 兼容 instruction 直接为字符串或 `{ text }` 对象的两种 rollout 格式。 */
function readInstructionText(value: unknown): string | undefined {
  const record = asRecord(value);
  return stringValue(record?.text) ?? stringValue(value);
}

/** 从字符串或 content-part 数组提取文本，多段之间使用换行保持原先边界。 */
function extractMessageText(content: unknown): string | undefined {
  if (typeof content === 'string' && content) return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap(item => {
    if (typeof item === 'string') return [item];
    const record = asRecord(item);
    return stringValue(record?.text) ? [stringValue(record?.text)!] : [];
  });
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/** 字符串若是合法 JSON 就解析，否则原样返回；非字符串无需转换。 */
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * 递归过滤 `undefined`、非有限数字等 JSON 不可表示值，得到可安全序列化的 `JsonValue`。
 */
function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) return value.flatMap(item => {
    const json = toJsonValue(item);
    return json === undefined ? [] : [json];
  });
  const record = asRecord(value);
  if (!record) return undefined;
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(record)) {
    const json = toJsonValue(item);
    if (json !== undefined) output[key] = json;
  }
  return output;
}

/**
 * 从 token_count 的 `last_token_usage` 读取本次 wave 用量；必需字段缺失时不编造样本。
 */
function extractLastTokenUsage(value: unknown): CodexTranscriptUsage | undefined {
  const info = asRecord(value);
  const raw = asRecord(info?.last_token_usage);
  if (!raw) return undefined;
  const inputTokens = numberValue(raw.input_tokens);
  const outputTokens = numberValue(raw.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cachedInputTokens = numberValue(raw.cached_input_tokens) ?? 0;
  const cacheCreationTokens = numberValue(raw.cache_creation_input_tokens) ?? 0;
  const totalTokens = numberValue(raw.total_tokens);
  const reasoningOutputTokens = numberValue(raw.reasoning_output_tokens);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    totalTokens: totalTokens && totalTokens > 0 ? totalTokens : inputTokens + outputTokens,
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
  };
}

/** 仅接受有限 number，拒绝字符串数字、NaN 和 Infinity。 */
function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 比较全部 usage 字段，用于去掉相邻重复的累计样本。 */
function sameUsage(left: CodexTranscriptUsage | undefined, right: CodexTranscriptUsage): boolean {
  return left !== undefined
    && left.inputTokens === right.inputTokens
    && left.outputTokens === right.outputTokens
    && left.cachedInputTokens === right.cachedInputTokens
    && left.cacheCreationTokens === right.cacheCreationTokens
    && left.reasoningOutputTokens === right.reasoningOutputTokens
    && left.totalTokens === right.totalTokens;
}
