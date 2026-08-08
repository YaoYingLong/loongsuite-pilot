// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Cursor Windows 的 transcript 驱动输出组装器。
 *
 * `cursor-hook-processor.mjs` 在 stop 时仅于 Windows 优先调用本模块。Cursor 的
 * agent-transcript JSONL 是可靠 UTF-8，本模块解析当前 turn，再与 event journal 对齐，既保留
 * transcript 中未损坏的文本，又补上 journal 提供的工具 ID、token、时间戳和模型。
 *
 * 设计约束：只处理最近一个 turn（最后两个 `turn_ended` 边界之间）；transcript 没有工具 ID，
 * 因而工具只能按位置匹配；journal 时序竞争导致工具事件缺失时会合成稳定 ID。已知限制是这里
 * 不组装子 Agent/子会话；含 Subagent/Task 的 turn 应由回退 `assembleTurn()` 通过扫描
 * `subagents/` 处理。并行或中断工具数量不一致时位置匹配也可能错位，此限制尚未解决。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  resolveUserId,
  timestampToUnixNanos,
  applyHookContentPolicy,
  sanitizeObject,
  toJsonValue,
  parseMaybeJson,
  inferProviderName,
} from '../agent-event-normalizer.mjs';

// ─── 对外 API ───

/**
 * 结合 transcript 与 journal 构造标准输出记录。
 * @param {string} transcriptPath Cursor agent-transcript JSONL 路径。
 * @param {object[]} journalEvents 本次 journal 快照的全部事件。
 * @param {{runtimeConfig?: object, stopConversationId?: string}} options 内容策略和 stop 会话 ID。
 * @returns {object[] | null} 标准记录；无法可靠解析时返回 null，通知调用方走回退 assembler。
 */
export function buildCursorRecordsFromTranscript(transcriptPath, journalEvents, options = {}) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  const turn = parseCursorTranscript(transcriptPath);
  if (!turn) return null;

  const runtimeConfig = options.runtimeConfig || {};
  const stopConversationId = options.stopConversationId;

  const promptEvent = stopConversationId
    ? journalEvents.find(e => e.hook_event === 'beforeSubmitPrompt' && e.conversation_id === stopConversationId)
    : journalEvents.find(e => e.hook_event === 'beforeSubmitPrompt');
  if (!promptEvent) return null;

  const parentConvId = promptEvent.conversation_id;
  const turnId = promptEvent.generation_id || parentConvId;
  const traceId = deriveTraceId(turnId);
  const userId = resolveUserId({}, runtimeConfig);

  const parentEvents = journalEvents
    .filter(e => e.conversation_id === parentConvId)
    .filter(e => e.hook_event !== 'sessionStart')
    .sort((a, b) => tsMs(a) - tsMs(b));

  // 从 journal 推断模型，afterAgentThought/Response 通常携带真实值。
  const model = parentEvents.find(e =>
    e.model && e.model !== 'unknown' && e.model !== ''
  )?.model || promptEvent?.model || 'unknown';

  // 所有记录共享会话、turn、trace、Agent 和用户字段。
  const baseFields = {
    trace_id: traceId,
    'gen_ai.session.id': parentConvId,
    'gen_ai.turn.id': turnId,
    'gen_ai.agent.type': 'cursor',
    'gen_ai.agent.id': parentConvId,
    'user.id': userId,
  };

  const records = [];
  const userText = turn.userText || promptEvent.prompt;

  // 用户 prompt 是 turn 入口 `other` 事件，不属于任一 ReAct step，因此没有 step_id。
  if (userText) {
    records.push(applyPolicy({
      time_unix_nano: eventTs(promptEvent),
      observed_time_unix_nano: eventTs(promptEvent),
      'event.id': crypto.randomUUID(),
      'event.name': 'other',
      ...baseFields,
      'gen_ai.provider.name': inferProvider(model),
      'gen_ai.input.messages_delta': [
        { role: 'user', parts: [{ type: 'text', content: userText }] },
      ],
      'agent.cursor.hook_event_name': 'beforeSubmitPrompt',
      'agent.cursor.composer_mode': promptEvent.composer_mode,
    }, runtimeConfig));
  }

  // 每个对齐后的 step 依次构造 request、tool 对和 response。
  const steps = alignSteps(turn.assistantEntries, parentEvents, turnId);
  const stopEvent = parentEvents.find(e => e.hook_event === 'stop');
  let prevToolResults = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepId = `${turnId}:s${i + 1}`;
    const isLast = i === steps.length - 1;

    // 同一步 request/response 共用 responseId，便于下游配对。
    const responseId = crypto.randomUUID();

    // 精确请求时间：s1 优先用 thought.duration 反推真实开始，失败时用 prompt；
    // s2+ 使用上一步最后一个工具结果的结束时间。
    let reqTs;
    if (i === 0) {
      // thought 有时长时反推 LLM 开始；它通常晚于 turn 入口的 `other` 事件。
      reqTs = step.thoughtEvent?.duration_ms != null
        ? timestampToUnixNanos(durationStartMs(step.thoughtEvent))
        : eventTs(promptEvent);
    } else {
      const prevStepLastResult = steps[i - 1].toolResults[steps[i - 1].toolResults.length - 1];
      reqTs = prevStepLastResult
        ? eventTs(prevStepLastResult)
        : (step.thoughtEvent?.duration_ms != null
          ? timestampToUnixNanos(durationStartMs(step.thoughtEvent))
          : eventTs(step.thoughtEvent || promptEvent));
    }

    // step 事件中的模型比 turn 级回退值更精确。
    const stepModel = step.thoughtEvent?.model || step.responseEvent?.model || model;

    const inputMessages = [];
    if (i === 0 && userText) {
      inputMessages.push({ role: 'user', parts: [{ type: 'text', content: userText }] });
    } else if (prevToolResults.length > 0) {
      // journal postToolUse 的 tool_output 可能已被 GB18030 损坏；省略内容但保留结构。
      inputMessages.push({
        role: 'tool',
        parts: prevToolResults.map(tr => ({
          type: 'tool_call_response',
          id: tr.tool_use_id || null,
          response: '',
        })),
      });
    }

    // ── 构造 llm.request ──
    const reqSource = step.thoughtEvent || step.responseEvent || promptEvent;
    records.push(applyPolicy({
      time_unix_nano: reqTs,
      observed_time_unix_nano: reqTs,
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.request',
      ...baseFields,
      'gen_ai.step.id': stepId,
      'gen_ai.response.id': responseId,
      'gen_ai.provider.name': inferProvider(stepModel),
      'gen_ai.request.model': stepModel,
      'gen_ai.input.messages': inputMessages.length > 0 ? inputMessages : undefined,
      'agent.cursor.hook_event_name': reqSource.hook_event,
      'agent.cursor.llm_request_time_source': i === 0
        ? 'prompt_submit'
        : (steps[i - 1].toolResults.length > 0 ? 'previous_step_end' : undefined),
    }, runtimeConfig));

    // ── 构造 tool.call 记录 ──
    for (const tc of step.toolCalls) {
      // 合成工具没有真实时间戳，使用 step request 时间。
      const tcTs = tc._synthetic ? reqTs : eventTs(tc);
      records.push(applyPolicy({
        time_unix_nano: tcTs,
        observed_time_unix_nano: tcTs,
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.call',
        ...baseFields,
        'gen_ai.step.id': stepId,
        'gen_ai.tool.name': tc.tool_name,
        'gen_ai.tool.call.id': tc.tool_use_id,
        'gen_ai.tool.call.arguments': toJsonValue(parseMaybeJson(tc.tool_input)),
        'agent.cursor.hook_event_name': tc.hook_event,
      }, runtimeConfig));
    }

    // ── tool.result（仅 journal 提供，transcript 没有工具结果） ──
    for (const tr of step.toolResults) {
      const isFailure = tr.hook_event === 'postToolUseFailure';
      records.push(applyPolicy({
        time_unix_nano: eventTs(tr),
        observed_time_unix_nano: eventTs(tr),
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.result',
        ...baseFields,
        'gen_ai.step.id': stepId,
        'gen_ai.tool.name': tr.tool_name,
        'gen_ai.tool.call.id': tr.tool_use_id,
        'gen_ai.tool.call.result': isFailure ? undefined : toJsonValue(parseMaybeJson(tr.tool_output)),
        'gen_ai.tool.call.duration': tr.duration_ms,
        'tool.result.status': isFailure ? 'failure' : undefined,
        'error.type': isFailure ? (tr.failure_type || 'tool_use_failure') : undefined,
        'error.message': isFailure ? tr.error_message : undefined,
        'agent.cursor.hook_event_name': tr.hook_event,
      }, runtimeConfig));
    }

    // ── 构造 llm.response ──
    // step 声明工具调用时 finish_reason 为 `tool_calls`，否则由最终状态决定。
    const finishReason = step.toolCalls.length > 0 ? 'tool_calls' : 'stop';

    // response 时间优先取 thoughtEvent，最终 step 则可取 responseEvent。
    const respSource = isLast
      ? (step.responseEvent || stopEvent)
      : (step.thoughtEvent || null);
    const respTs = respSource ? eventTs(respSource) : reqTs;

    // output.messages 包含文本及每个工具的 tool_call；非最终 step 文本标为 reasoning，
    // 与 react-assembler 对 afterAgentThought 的处理保持一致。
    const textPartType = isLast ? 'text' : 'reasoning';
    const outputParts = [];
    if (step.text) outputParts.push({ type: textPartType, content: step.text });
    for (const tc of step.toolCalls) {
      outputParts.push({
        type: 'tool_call',
        id: tc.tool_use_id || null,
        name: tc.tool_name,
        arguments: parseMaybeJson(tc.tool_input),
      });
    }

    const respRecord = applyPolicy({
      time_unix_nano: respTs,
      observed_time_unix_nano: respTs,
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.response',
      ...baseFields,
      'gen_ai.step.id': stepId,
      'gen_ai.response.id': responseId,
      'gen_ai.provider.name': inferProvider(respSource?.model || stepModel),
      'gen_ai.request.model': respSource?.model || stepModel,
      'gen_ai.response.model': respSource?.model || stepModel,
      'gen_ai.output.messages': [{
        role: 'assistant',
        parts: outputParts,
        finish_reason: finishReason,
      }],
      'gen_ai.response.finish_reasons': [finishReason],
      'agent.cursor.hook_event_name': respSource?.hook_event
        || (isLast ? 'afterAgentResponse' : 'afterAgentThought'),
      'agent.cursor.llm_response_time_source': respSource?.hook_event === 'afterAgentThought'
        ? 'after_agent_thought'
        : respSource?.hook_event === 'afterAgentResponse'
        ? 'after_agent_response'
        : undefined,
    }, runtimeConfig);

    // 只有最后一步携带真实 token，中间步置 0，防止 AGENT span 重复汇总。
    if (isLast) {
      mergeTokens(respRecord, step.responseEvent || stopEvent);
    } else {
      respRecord['gen_ai.usage.input_tokens'] = 0;
      respRecord['gen_ai.usage.output_tokens'] = 0;
      respRecord['gen_ai.usage.cache_read.input_tokens'] = 0;
      respRecord['gen_ai.usage.cache_creation.input_tokens'] = 0;
      respRecord['gen_ai.usage.total_tokens'] = 0;
    }

    records.push(respRecord);
    prevToolResults = step.toolResults;
  }

  return records.length > 0 ? records : null;
}

// ─── Transcript 解析 ───

/**
 * 解析 Cursor transcript，且只返回当前 turn。
 * Cursor 把多个 turn 追加到同一文件，以 `turn_ended` 分隔；必须裁剪到最后两个边界之间。
 */
function parseCursorTranscript(transcriptPath) {
  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    // 先收集所有 turn_ended 位置，用于确定当前 turn 边界。
    const turnEndedPositions = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'turn_ended') turnEndedPositions.push(i);
      } catch {}
    }

    // 最后一行是否为 turn_ended 决定当前 turn 已结束还是仍写入中。
    let lastEntry = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try { lastEntry = JSON.parse(lines[i]); break; } catch {}
    }
    const endsWithTurnEnded = lastEntry?.type === 'turn_ended';

    let currentTurnStart, currentTurnEnd;

    if (endsWithTurnEnded && turnEndedPositions.length >= 1) {
      // 已结束：取倒数第二个边界之后到最后边界之前。
      const lastPos = turnEndedPositions[turnEndedPositions.length - 1];
      const prevPos = turnEndedPositions.length >= 2
        ? turnEndedPositions[turnEndedPositions.length - 2]
        : -1;
      currentTurnStart = prevPos + 1;
      currentTurnEnd = lastPos; // 结束位置不包含在当前区间内。
    } else {
      // 仍进行中：取最后边界之后到 EOF。
      const lastPos = turnEndedPositions.length > 0
        ? turnEndedPositions[turnEndedPositions.length - 1]
        : -1;
      currentTurnStart = lastPos + 1;
      currentTurnEnd = lines.length;
    }

    let userText = null;
    const assistantEntries = [];

    for (let i = currentTurnStart; i < currentTurnEnd; i++) {
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }

      if (entry.role === 'user' && entry.message?.content) {
        const parts = entry.message.content.filter(p => p.type === 'text' && p.text);
        const text = parts
          .map(p => p.text.replace(/<\/?user_query>\n?/g, '').trim())
          .filter(Boolean)
          .join('');
        if (text) userText = text;
      }

      if (entry.role === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content.filter(p => p.type === 'text' && p.text);
        const toolUseParts = entry.message.content.filter(p => p.type === 'tool_use');
        const rawText = textParts.map(p => p.text).join('');
        const text = isUsableText(rawText) ? rawText : null;
        // 提取工具名和参数；transcript 本身不提供 tool ID。
        const toolUses = toolUseParts.map(p => ({
          name: p.name || '',
          input: p.input || {},
        }));
        assistantEntries.push({ text, toolUseCount: toolUseParts.length, toolUses });
      }
    }

    if (!userText && assistantEntries.length === 0) return null;
    return { userText, assistantEntries };
  } catch {
    return null;
  }
}

/** 去除 `[REDACTED]` 标记后仍有非空内容，才视为可用文本。 */
function isUsableText(text) {
  if (!text || !text.trim()) return false;
  return text.replace(/\[REDACTED\]/g, '').trim().length > 0;
}

// ─── Step 对齐 ───

/**
 * 对齐 transcript assistant 与 journal Hook 事件以构造 step。
 *
 * transcript 决定工具身份、参数和数量；journal 的 preToolUse 在可用时提供真实 ID 与时序。
 * journal 因并发竞争缺失工具时从 transcript 合成条目，保证至少存在 tool.call。
 * 已知限制：位置匹配假设两路工具数量一致；中断工具或 Cursor 内部重试会使后续分配错位，
 * transcript 缺少工具 ID，当前无法可靠消除此问题。
 */
function alignSteps(assistantEntries, parentEvents, turnId) {
  const sortedJournalCalls = parentEvents
    .filter(e => e.hook_event === 'preToolUse')
    .sort((a, b) => tsMs(a) - tsMs(b));
  const sortedToolResults = parentEvents
    .filter(e => e.hook_event === 'postToolUse' || e.hook_event === 'postToolUseFailure')
    .sort((a, b) => tsMs(a) - tsMs(b));
  const thoughtEvents = parentEvents
    .filter(e => e.hook_event === 'afterAgentThought')
    .sort((a, b) => tsMs(a) - tsMs(b));
  const responseEvents = parentEvents
    .filter(e => e.hook_event === 'afterAgentResponse')
    .sort((a, b) => tsMs(a) - tsMs(b));

  if (!assistantEntries || assistantEntries.length === 0) {
    return [{
      text: null,
      toolCalls: sortedJournalCalls,
      toolResults: sortedToolResults,
      thoughtEvent: thoughtEvents[0] || null,
      responseEvent: responseEvents[0] || null,
    }];
  }

  let journalCallIdx = 0;
  let toolResultIdx = 0;
  const steps = [];

  for (let i = 0; i < assistantEntries.length; i++) {
    const entry = assistantEntries[i];
    const count = entry.toolUseCount || 0;
    const isFinal = i === assistantEntries.length - 1;

    // 优先采用 journal 的真实 ID/时间，缺失时从 transcript 合成工具调用。
    const stepToolCalls = [];
    for (let j = 0; j < count; j++) {
      const journalEvent = sortedJournalCalls[journalCallIdx + j];
      const transcriptTool = entry.toolUses?.[j];
      if (journalEvent) {
        // journal 提供真实时序和 ID，参数仍用 transcript 的正确 UTF-8，避免中文乱码。
        stepToolCalls.push({
          ...journalEvent,
          tool_input: transcriptTool ? JSON.stringify(transcriptTool.input) : journalEvent.tool_input,
        });
      } else if (transcriptTool) {
        // 没有 journal 事件时用 transcript 合成，稳定 ID 格式为 <turnId>:s<step>:t<toolIndex>。
        const syntheticId = `${turnId}:s${i + 1}:t${j + 1}`;
        stepToolCalls.push({
          _journal_ts: null, // 没有可用的真实时间戳。
          hook_event: 'preToolUse',
          tool_name: transcriptTool.name,
          tool_use_id: syntheticId,
          tool_input: JSON.stringify(transcriptTool.input),
          _synthetic: true,
        });
      }
    }
    journalCallIdx += count;

    const stepToolResults = sortedToolResults.slice(toolResultIdx, toolResultIdx + count);
    toolResultIdx += count;

    steps.push({
      text: entry.text,
      toolCalls: stepToolCalls,
      toolResults: stepToolResults,
      thoughtEvent: !isFinal ? (thoughtEvents[i] || null) : null,
      responseEvent: isFinal ? (responseEvents[0] || null) : null,
    });
  }

  return steps;
}

// ─── 辅助函数 ───

function mergeTokens(rec, ev) {
  if (!ev) return;
  if (ev.input_tokens != null) rec['gen_ai.usage.input_tokens'] = ev.input_tokens;
  if (ev.output_tokens != null) rec['gen_ai.usage.output_tokens'] = ev.output_tokens;
  if (ev.cache_read_tokens != null) rec['gen_ai.usage.cache_read.input_tokens'] = ev.cache_read_tokens;
  if (ev.cache_write_tokens != null) rec['gen_ai.usage.cache_creation.input_tokens'] = ev.cache_write_tokens;
  if (ev.input_tokens != null && ev.output_tokens != null) {
    rec['gen_ai.usage.total_tokens'] = ev.input_tokens + ev.output_tokens;
  }
}

function deriveTraceId(turnId) {
  if (!turnId) return crypto.randomUUID().replace(/-/g, '');
  return crypto.createHash('sha256').update(`cursor:${turnId}`).digest('hex').slice(0, 32);
}

function eventTs(ev) {
  if (ev?._journal_ts) return timestampToUnixNanos(ev._journal_ts);
  return timestampToUnixNanos(new Date());
}

function tsMs(ev) {
  if (ev?._journal_ts) return new Date(ev._journal_ts).getTime();
  return Date.now();
}

function durationStartMs(ev) {
  const endMs = tsMs(ev);
  const durationMs = Number(ev?.duration_ms);
  if (!Number.isFinite(durationMs) || durationMs < 0) return endMs;
  return endMs - durationMs;
}

function inferProvider(model) {
  const provider = inferProviderName({ 'gen_ai.request.model': model, 'gen_ai.agent.type': 'cursor' });
  if (provider === 'unknown' && /composer/i.test(model)) return 'openai';
  return provider;
}

function applyPolicy(record, runtimeConfig) {
  return sanitizeObject(applyHookContentPolicy(record, runtimeConfig)) || {};
}
