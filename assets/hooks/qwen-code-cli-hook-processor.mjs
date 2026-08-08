#!/usr/bin/env node
// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Qwen Code CLI Hook 子命令分派器与 transcript 导出器。
 *
 * `qwen-code-cli-loongsuite-pilot-hook.sh` 为每个注册事件执行
 * `node qwen-code-cli-hook-processor.mjs <subcommand>`。v1 的 stop 增量解析 transcript 并
 * 写 event_t JSONL；subagent-start/stop 只累积 state.events，尚不展开为子 trace。
 *
 * 架构与 Claude Code v2 相似，以 transcript 的 record.timestamp 为事实时间，而不是 Hook
 * 触发时间。输入是 stdin payload 和 `~/.qwen/projects/<projectHash>/chats/<session>.jsonl`；输出是
 * `logs/qwen-code-cli/*.jsonl` 及 session offset/state。成功写出后才推进 offset，stdout
 * 最终返回 `{}`，异常写独立 error JSONL 并 fail-open。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { readStdinJson } from './shared/stdin-reader.mjs';
import {
  INITIAL_HASH,
  computeHash,
  generateTraceId,
  generateSpanId,
  writeJsonlRecords,
} from './shared/event-emitter.mjs';
import { logHookError } from './shared/error-logger.mjs';
import { recordUpstreamContextOnce } from './shared/upstream-context.mjs';
import {
  sanitizeObject,
  loadHookRuntimeConfig,
  resolveUserId,
  applyHookContentPolicy,
} from './agent-event-normalizer.mjs';

import {
  loadState,
  saveState,
  readAndDeleteChildState,
} from './qwen-code-cli/state.mjs';
import { parseQwenTranscript } from './qwen-code-cli/transcript-parser.mjs';
import {
  buildOutputMessages,
  buildInputMessagesDelta,
  inferAssistantFinishReason,
} from './qwen-code-cli/message-converter.mjs';
import { inferProvider } from './qwen-code-cli/provider-inferrer.mjs';

const AGENT_ID = 'qwen-code-cli';

// ─── 通用工具 ───

function nowSec() { return Date.now() / 1000; }

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

function defaultLogDir() {
  return path.join(pilotDataDir(), 'logs', AGENT_ID);
}

function tryReadStdin() {
  try { return readStdinJson(); }
  catch (err) {
    logHookError({
      agentId: AGENT_ID, stage: 'stdin_parse',
      errorType: 'parse_failed',
      errorMessage: err?.message || String(err),
    });
    return {};
  }
}

function requireSessionId(event, stage = 'cmd') {
  const sid = event && event.session_id;
  if (typeof sid === 'string' && sid.length > 0) return sid;
  logHookError({
    agentId: AGENT_ID, stage,
    errorType: 'missing_session_id',
    errorMessage: 'hook stdin lacks session_id; skipping',
  });
  return null;
}

/**
 * 把 ISO 8601 转为 time_unix_nano 字符串。[C10]
 *
 * 时间缺失时返回 `'0'`，避免下游 BigInt 抛错；trace converter 会将 0 视为无时间并告警，
 * 这比静默丢弃事件更可诊断。
 */
function isoToUnixNanos(isoStr) {
  if (!isoStr) return '0';
  const ms = new Date(isoStr).getTime();
  if (isNaN(ms)) return '0';
  return String(ms) + '000000';
}

// ─── 子命令处理器 ───

// v1：subagent_start / subagent_stop 有意不生成输出。
//
// 当前只把事件存入 state.events 为 v2 预留，不发 event_t；parser 也显式过滤 sidechain，
// 因此 v1 端到端不会输出子 Agent 活动。
//
// 规划中的 v2 才会读取子 session JSONL，构造嵌套 AGENT -> STEP -> LLM/TOOL，并通过
// `gen_ai.subagent.parent_tool_call.id` 挂到父 TOOL span。
//
// 在此之前处理器只做最小状态累积，不应误加记录输出。
function cmdSubagentStart() {
  const event = tryReadStdin();
  const sessionId = requireSessionId(event, 'subagent_start');
  if (!sessionId) return;
  const state = loadState(sessionId);
  state.events = state.events || [];
  state.events.push({
    type: 'subagent_start',
    timestamp: nowSec(),
    subagent_session_id: event.subagent_session_id || '',
    agent_id: event.agent_id || '',
    agent_type: event.agent_type || '',
  });
  saveState(sessionId, state);
}

function cmdSubagentStop() {
  const event = tryReadStdin();
  const sessionId = requireSessionId(event, 'subagent_stop');
  if (!sessionId) return;
  const state = loadState(sessionId);
  const childSid = event.subagent_session_id || 'unknown';
  let childStateSnapshot = null;
  if (childSid && childSid !== 'unknown' && childSid !== sessionId) {
    childStateSnapshot = readAndDeleteChildState(childSid);
  }
  state.events = state.events || [];
  const ev = {
    type: 'subagent_stop',
    timestamp: nowSec(),
    subagent_session_id: childSid,
    stop_reason: event.stop_reason || 'end_turn',
  };
  if (childStateSnapshot) ev._child_state = childStateSnapshot;
  state.events.push(ev);
  saveState(sessionId, state);
}

async function cmdStop() {
  const event = tryReadStdin();
  const sessionId = requireSessionId(event, 'stop');
  if (!sessionId) return;

  // 方案1(env):首个 turn 读 TRACEPARENT 写 session 级关联记录(fail-open, 每 session 一次)
  recordUpstreamContextOnce({ agentId: AGENT_ID, sessionId, dataDir: pilotDataDir() });

  const state = loadState(sessionId);
  if (!state.transcript_path && event.transcript_path) {
    state.transcript_path = event.transcript_path;
  }
  if (event.cwd && typeof event.cwd === 'string') {
    state.cwd = event.cwd;
  }
  state.stop_time = nowSec();
  saveState(sessionId, state);

  try {
    await exportSession(state, event.stop_reason || 'end_turn');
    if (typeof state._next_transcript_offset === 'number') {
      state.transcript_offset = state._next_transcript_offset;
      delete state._next_transcript_offset;
    }
    state.events = [];
    state.stop_time = null;
    saveState(sessionId, state);
  } catch (err) {
    logHookError({
      agentId: AGENT_ID, stage: 'cmd_stop',
      errorType: 'export_failed',
      errorMessage: err?.message || String(err),
    });
  }
}

// ─── 等待 transcript 稳定 ───

async function waitForTranscriptStable(transcriptPath, minSize = 0) {
  let prevSize = -1;
  let stableCount = 0;
  for (let i = 0; i < 10; i++) {
    let size = 0;
    try { size = fs.statSync(transcriptPath).size; } catch { break; }
    if (size <= minSize) {
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }
    if (size === prevSize) {
      stableCount++;
      if (stableCount >= 2) return;
    } else {
      stableCount = 0;
    }
    prevSize = size;
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ─── Stop 主导出流程 ───

async function exportSession(state, stopReason) {
  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  const sessionId = state.session_id || 'unknown';

  if (!state.transcript_path) {
    logHookError({
      agentId: AGENT_ID, stage: 'export',
      errorType: 'missing_transcript_path',
      errorMessage: 'no transcript_path in state; cannot export',
    });
    return;
  }

  const transcriptPath = state.transcript_path;
  const baseOffset = state.transcript_offset || 0;

  // 文件未超过上次 offset 就没有新数据；重复 Stop、新 turn 尚未写入或用户未产生输出时快速返回。
  let currentSize = 0;
  try { currentSize = fs.statSync(transcriptPath).size; } catch {}
  if (currentSize <= baseOffset) return;

  await waitForTranscriptStable(transcriptPath, baseOffset);

  let parseResult;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      parseResult = parseQwenTranscript(transcriptPath, baseOffset, sessionId);
      if (parseResult.turns.length > 0) break;
    } catch (err) {
      logHookError({
        agentId: AGENT_ID, stage: 'transcript_parse',
        errorType: 'parse_failed',
        errorMessage: err?.message || String(err),
      });
      break;
    }
    // 没解析出 turn 时仅在文件仍增长期间重试；大小稳定但新增字节未形成完整 turn 时快速再试一次。
    await new Promise((r) => setTimeout(r, 200));
    let newSize = 0;
    try { newSize = fs.statSync(transcriptPath).size; } catch {}
    if (newSize === currentSize && attempt > 0) break;
    currentSize = newSize;
    await waitForTranscriptStable(transcriptPath, baseOffset);
  }

  if (!parseResult || parseResult.turns.length === 0) return;

  state._next_transcript_offset = parseResult.nextOffset;

  const userId = resolveUserId({}, runtimeConfig);
  const allRecords = [];
  let logHash = INITIAL_HASH;

  const baseTurnCount = state.turn_count || 0;

  // 首次安装/重装无 turn_count 且 offset=0 时，只导出最后一个刚完成 turn，避免回放数月历史。
  const isFirstRun = !state.turn_count && baseOffset === 0;
  let turnsToExport = parseResult.turns;
  if (isFirstRun && parseResult.turns.length > 1) {
    turnsToExport = parseResult.turns.slice(-1);
  }

  const cwd = state.cwd || undefined;

  for (let i = 0; i < turnsToExport.length; i++) {
    const turn = turnsToExport[i];
    const isLast = i === turnsToExport.length - 1;
    const turnStopReason = isLast ? stopReason : 'end_turn';
    const { records, hash } = buildTurnRecords(
      turn, baseTurnCount + i, sessionId, logHash, userId, turnStopReason, cwd,
    );
    allRecords.push(...records);
    logHash = hash;

    // 位置回退可能把多个无 ID、交错结果的工具配错，因此把使用次数暴露到运维字段而非静默处理。
    // @google/genai 通常提供 functionCall.id；频繁触发说明上游行为可能改变。
    if (turn.positionalFallbacksUsed > 0) {
      logHookError({
        agentId: AGENT_ID,
        stage: 'pair_tool_results',
        errorType: 'tool_pair_ambiguous',
        errorMessage:
          `positional fallback used for ${turn.positionalFallbacksUsed} tool ` +
          `call(s) in turn ${baseTurnCount + i + 1} (session=${sessionId}); ` +
          `functionCall.id missing — pairings may be incorrect if multiple ID-less calls coexist`,
      });
    }
  }

  // turn_count 包含首次防护跳过的历史 turn，使 offset 越过它们并避免下次重复解析。
  state.turn_count = baseTurnCount + parseResult.turns.length;

  const cleaned = allRecords.map((r) => applyHookContentPolicy(sanitizeObject(r) || r, runtimeConfig));
  writeJsonlRecords(defaultLogDir(), AGENT_ID, cleaned);
}

// ─── buildTurnRecords：把一个已解析 turn 转成 event_t ───

/**
 * 把 parser 产出的一个 turn 展开为按时间排序的 event_t 记录，并继续输入消息哈希链。
 * 本函数是纯内存转换：不读写文件、不启动异步任务；调用方 `exportSession` 汇总各 turn 后统一落盘。
 *
 * @param {object} turn `parseQwenTranscript().turns[i]` 返回的一轮对话。
 * @param {number} turnIndex 从 0 开始的 turn 序号，用于生成 turn.id 后缀。
 * @param {string} sessionId Qwen session ID，同时作为 gen_ai.session.id 和 turn.id 前缀。
 * @param {string} prevHash 上一轮留下的 input.messages_hash 链头。
 * @param {string} userId 配置解析后得到的 user.id。
 * @param {string} turnStopReason 本 turn 最后一次 LLM 调用的停止原因。
 * @param {string|undefined} cwd 可选工作目录，写入 agent.qwen-code-cli.cwd。
 * @returns {{records: object[], hash: string}} records 是待写 JSONL 的事件数组，hash 是更新后的链头。
 */
export function buildTurnRecords(turn, turnIndex, sessionId, prevHash, userId, turnStopReason, cwd) {
  const records = [];
  // [C2] turn.id 使用 `<sessionId>:t<N>`。
  const turnId = `${sessionId}:t${turnIndex + 1}`;
  let runningHash = prevHash;
  // [C1] 每 turn 只生成一个 trace_id，本 turn 全部事件复用。
  const traceId = generateTraceId();

  const baseFields = {
    trace_id: traceId,
    'gen_ai.session.id': sessionId,
    'gen_ai.turn.id': turnId,
    'gen_ai.agent.type': AGENT_ID,
    'gen_ai.agent.id': sessionId,
    'user.id': userId,
    ...(cwd ? { 'agent.qwen-code-cli.cwd': cwd } : {}),
    ...(turn.gitBranch ? { 'git.branch': turn.gitBranch } : {}),
  };

  // [C7] 用户输入 -> event.name=other + messages_delta（做法 A）。
  // user prompt 不单独作为 llm.request；converter 会把 delta 合入 ENTRY/AGENT input.messages。
  if (turn.prompt) {
    records.push({
      time_unix_nano: isoToUnixNanos(turn.promptTimestamp),
      'event.id': crypto.randomUUID(),
      'event.name': 'other',
      ...baseFields,
      'gen_ai.input.messages_delta': [
        { role: 'user', parts: [{ type: 'text', content: turn.prompt }] },
      ],
    });
  }

  // 每条 assistant（一次 LLM）输出 request、response，以及每个 functionCall 的工具对。
  // [C3] 每个 LLM 边界创建一个 STEP，所以 STEP 数等于 LLM 数。
  const llmCalls = turn.llmCalls || [];
  let stepRound = 0;

  for (const llm of llmCalls) {
    stepRound++;
    // [C2] step.id 使用 `<turnId>:s<M>`。
    const stepId = `${turnId}:s${stepRound}`;
    const stepSpanId = generateSpanId();
    const llmSpanId = generateSpanId();
    // [C4] request 与 response 共用 gen_ai.response.id 作为配对键。
    const responseId =
      llm.apiResponse?.responseId || llm.assistantUuid || `${stepId}:r`;

    // [C8] provider 由模型名推断，auth_type 兜底，不硬编码。
    const provider = inferProvider(llm.model, llm.apiResponse?.authType);

    // deltaRecords 保存上一步至本步之间新增的 user/tool_result；所需 call.id 就在各记录自己的
    // toolCallResult.callId，converter 可直接读取，无需额外 override Map。
    const inputMsgsDelta = buildInputMessagesDelta(
      llm.inputMessagesDeltaRecords || [],
    );
    const inputMsgsHash = computeHash(runningHash, inputMsgsDelta);

    // ─── llm.request ───
    records.push({
      // [C11] request 时间必须不同于 response，使用 assistant 前最后一条 user/tool_result 时间。
      time_unix_nano: isoToUnixNanos(llm.requestStartTime || llm.timestamp),
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.request',
      ...baseFields,
      span_id: llmSpanId,
      parent_span_id: stepSpanId,
      'gen_ai.step.id': stepId,
      'gen_ai.response.id': responseId,
      'gen_ai.provider.name': provider,
      'gen_ai.request.model': llm.model || 'unknown',
      'gen_ai.input.messages_hash': inputMsgsHash,
      ...(inputMsgsDelta.length > 0 ? { 'gen_ai.input.messages_delta': inputMsgsDelta } : {}),
    });
    runningHash = inputMsgsHash;

    // ─── llm.response ───
    // token 优先 assistant.usageMetadata；缺失再用可能被用户关闭的 api_response telemetry。
    const usage = llm.usageMetadata || {};
    const inputTokens = usage.promptTokenCount ?? llm.apiResponse?.inputTokenCount ?? 0;
    const outputTokens = usage.candidatesTokenCount ?? llm.apiResponse?.outputTokenCount ?? 0;
    const cacheRead = usage.cachedContentTokenCount ?? llm.apiResponse?.cachedContentTokenCount ?? 0;
    const totalTokens = usage.totalTokenCount ?? (inputTokens + outputTokens);

    // [C5] reasoning/text/tool_call 必须位于同一 response，不能拆多条记录。
    const outputMessages = buildOutputMessages(llm.assistantRecord);
    const finishReason = inferAssistantFinishReason(llm.assistantRecord);

    const respRecord = {
      time_unix_nano: isoToUnixNanos(llm.timestamp),
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.response',
      ...baseFields,
      span_id: llmSpanId,
      parent_span_id: stepSpanId,
      'gen_ai.step.id': stepId,
      'gen_ai.response.id': responseId,
      'gen_ai.provider.name': provider,
      'gen_ai.request.model': llm.model || 'unknown',
      'gen_ai.response.model': llm.model || 'unknown',
      'gen_ai.response.finish_reasons': [finishReason],
      'gen_ai.usage.input_tokens': inputTokens,
      'gen_ai.usage.output_tokens': outputTokens,
      'gen_ai.usage.cache_read.input_tokens': cacheRead,
      'gen_ai.usage.total_tokens': totalTokens,
      'gen_ai.output.messages': outputMessages,
    };
    // telemetry 标记调用失败时附加 api_error 信息。
    if (llm.apiResponse?.eventName === 'qwen-code.api_error') {
      respRecord['error.type'] = llm.apiResponse.errorType || 'ApiError';
      respRecord['error.message'] = String(llm.apiResponse.errorMessage || '').slice(0, 500);
      if (typeof llm.apiResponse.statusCode === 'number') {
        respRecord['http.status_code'] = llm.apiResponse.statusCode;
      }
      respRecord['gen_ai.response.finish_reasons'] = ['error'];
    }
    records.push(respRecord);

    // ─── 为每个已声明工具生成 tool.call + tool.result ───
    for (const tool of llm.declaredTools) {
      const toolSpanId = generateSpanId();
      // [C6] tool.call 与 tool.result 共用 gen_ai.tool.call.id。
      const callIdForEvent = tool.callId || `${stepId}:t${tool.partIndex}`;

      // tool.call 使用 assistant 发出时间；并行工具共享该时间，因为 transcript 无法观察真实执行起点。
      records.push({
        time_unix_nano: isoToUnixNanos(llm.timestamp),
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.call',
        ...baseFields,
        span_id: toolSpanId,
        parent_span_id: stepSpanId,
        'gen_ai.step.id': stepId,
        'gen_ai.tool.name': tool.name,
        'gen_ai.tool.call.id': callIdForEvent,
        ...(tool.args != null ? { 'gen_ai.tool.call.arguments': tool.args } : {}),
      });

      if (tool.result) {
        const resultRec = {
          time_unix_nano: isoToUnixNanos(tool.result.timestamp),
          'event.id': crypto.randomUUID(),
          'event.name': 'tool.result',
          ...baseFields,
          span_id: toolSpanId,
          parent_span_id: stepSpanId,
          'gen_ai.step.id': stepId,
          'gen_ai.tool.name': tool.name,
          'gen_ai.tool.call.id': callIdForEvent,
          ...(tool.result.response != null ? { 'gen_ai.tool.call.result': tool.result.response } : {}),
          'tool.result.status': tool.result.status,
        };
        if (tool.result.status === 'error') {
          resultRec['error.type'] = 'ToolError';
          resultRec['error.message'] =
            typeof tool.result.error === 'string'
              ? tool.result.error.slice(0, 500)
              : String(tool.result.error || 'tool execution failed').slice(0, 500);
        }
        records.push(resultRec);
      }
      // 无结果的孤立 tool.call 仍保留模型意图；converter 会告警但不会崩溃。
    }
  }

  // 按 time_unix_nano 排序；虽配对不强制顺序，但 flusher 串行消费，乱序会干扰下游。
  records.sort((a, b) => {
    const ta = BigInt(a.time_unix_nano || '0');
    const tb = BigInt(b.time_unix_nano || '0');
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });

  // 用 Hook 的最终 stop_reason 覆盖末条 response 的内容推断值，例如 content filter。
  if (turnStopReason && turnStopReason !== 'end_turn') {
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i]['event.name'] === 'llm.response') {
        records[i]['gen_ai.response.finish_reasons'] = [turnStopReason];
        break;
      }
    }
  }

  return { records, hash: runningHash };
}

// ─── CLI 子命令分派 ───

const SUBCOMMAND = process.argv[2];

async function main() {
  switch (SUBCOMMAND) {
    case 'stop':
      await cmdStop();
      break;
    case 'subagent-start':
      cmdSubagentStart();
      break;
    case 'subagent-stop':
      cmdSubagentStop();
      break;
    default:
      // 未注册子命令按 fail-open 契约直接返回。
      break;
  }
  // 成功时 Hook stdout 必须是 `{}`；非 JSON 会被 Qwen Code TRUSTED_HOOKS 记为失败。
  process.stdout.write('{}\n');
}

// 仅直接作为主脚本执行；单元测试 import 时不自动读取 stdin。
if (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1]?.endsWith('qwen-code-cli-hook-processor.mjs')) {
  main().catch((err) => {
    // 最后一层兜底：记录异常并以 0 退出，避免阻塞 Qwen Code。
    try {
      logHookError({
        agentId: AGENT_ID, stage: 'main',
        errorType: 'unhandled',
        errorMessage: err?.message || String(err),
      });
    } catch {}
    process.stdout.write('{}\n');
    process.exit(0);
  });
}
