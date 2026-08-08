// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Qwen Code CLI transcript JSONL 增量解析器。
 *
 * Qwen Code 将严格单行 JSON 写到 `~/.qwen/projects/<projectHash>/chats/<sessionId>.jsonl`，
 * 与多行 telemetry.outfile 不同。记录包括 user、assistant（text/thought/functionCall 与
 * usageMetadata）、tool_result（functionResponse/callId/status）和各种 system telemetry。
 *
 * `parseQwenTranscript(path, byteOffset, sessionId)` 只读 offset 之后内容，返回 `{turns,
 * nextOffset}`；nextOffset 是本次文件大小，由 processor 成功输出后持久化。每个 turn 包含
 * 一个 prompt 和后续 LLM/tool 链。v1 会过滤 `isSidechain` 或带 agentId 的子 Agent 记录，
 * 子 trace 展开尚未实现。模块同步只读文件、不写状态；损坏行跳过，超大积压最多读末尾 50MB。
 */

import fs from 'node:fs';

export const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024; // 50 MB 安全读取上限。

// 这些 type=user 子类型是 turn 内部产物，不开启新 turn；无 subtype 的普通 user 才是边界。
const INSIDE_TURN_USER_SUBTYPES = new Set([
  'mid_turn_user_message',
  'notification',
  'cron',
]);

/**
 * @param {string} transcriptPath
 * @param {number} byteOffset
 * @param {string|undefined} mainSessionId 用于过滤属于子 Agent prompt 的 api_response。
 * @returns {{ turns: Array, nextOffset: number }}
 */
export function parseQwenTranscript(transcriptPath, byteOffset = 0, mainSessionId = undefined) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { turns: [], nextOffset: byteOffset };
  }

  const { content, nextOffset } = readIncremental(transcriptPath, byteOffset);
  if (!content) {
    return { turns: [], nextOffset };
  }

  // 阶段 1：解析各行、丢弃 sidechain，并保留可分类的 API telemetry。
  const records = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let r;
    try { r = JSON.parse(trimmed); } catch { continue; }
    if (!r || typeof r !== 'object' || !r.type) continue;
    // v1 完全跳过子 Agent/sidechain 记录。
    if (r.isSidechain === true || r.agentId) continue;
    records.push(r);
  }
  if (records.length === 0) return { turns: [], nextOffset };

  // 阶段 2：以普通 type=user（非 turn 内 subtype）切 turn。
  const turns = splitIntoTurns(records);
  if (turns.length === 0) return { turns: [], nextOffset };

  // 阶段 3：逐 turn 推导 LLM 调用、工具配对和 api_response 元数据。
  const enriched = turns.map((turn) => enrichTurn(turn, mainSessionId));

  return { turns: enriched, nextOffset };
}

// ─── 增量文件读取（与 Claude parser 同策略） ───

function readIncremental(transcriptPath, byteOffset) {
  let stat;
  try { stat = fs.statSync(transcriptPath); } catch { return { content: '', nextOffset: byteOffset }; }
  const fileSize = stat.size;
  if (byteOffset >= fileSize) return { content: '', nextOffset: byteOffset };

  const readFrom = Math.max(byteOffset, 0);
  const readLen = fileSize - readFrom;

  // 严重积压的大文件只 tail 最后 50MB，舍弃最早内容，避免一次 Hook 耗尽内存。
  if (readLen > MAX_TRANSCRIPT_BYTES) {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const tailOffset = fileSize - MAX_TRANSCRIPT_BYTES;
      const actualOffset = Math.max(tailOffset, readFrom);
      const actualLen = fileSize - actualOffset;
      const buf = Buffer.alloc(actualLen);
      fs.readSync(fd, buf, 0, actualLen, actualOffset);
      let content = buf.toString('utf-8');
      if (actualOffset > readFrom) {
        // 从文件中段起读时丢弃第一条不完整行。
        const firstNewline = content.indexOf('\n');
        if (firstNewline >= 0) content = content.slice(firstNewline + 1);
      }
      return { content, nextOffset: fileSize };
    } finally {
      fs.closeSync(fd);
    }
  }

  if (readFrom > 0) {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, readFrom);
      return { content: buf.toString('utf-8'), nextOffset: fileSize };
    } finally {
      fs.closeSync(fd);
    }
  }

  return { content: fs.readFileSync(transcriptPath, 'utf-8'), nextOffset: fileSize };
}

// ─── turn 切分 ───

/**
 * 把记录切成 turn；边界是无 subtype 或 subtype 不属于内部集合的 type=user。
 *
 * 每项包含 userRecord 与直到下个边界前的 assistant/tool_result/system records。
 */
export function splitIntoTurns(records) {
  const turns = [];
  let current = null;
  for (const r of records) {
    const isTurnBoundary = r.type === 'user' && !INSIDE_TURN_USER_SUBTYPES.has(r.subtype || '');
    if (isTurnBoundary) {
      if (current) turns.push(current);
      current = { userRecord: r, records: [] };
    } else if (current) {
      current.records.push(r);
    }
    // 首个 user 前的孤立记录通常来自损坏 transcript，直接丢弃。
  }
  if (current) turns.push(current);
  return turns;
}

// ─── 丰富每 turn 的 LLM 调用与工具配对 ───

function enrichTurn(turn, mainSessionId) {
  const userRec = turn.userRecord;
  const promptText = extractUserPromptText(userRec);
  const turnRecords = turn.records;

  // 为主 session 的 api_response 建索引，排除子 Agent prompt。
  const mainApiPromptPrefix = mainSessionId ? `${mainSessionId}########` : null;
  const mainApiResponses = turnRecords.filter((r) => {
    if (r.type !== 'system' || r.subtype !== 'ui_telemetry') return false;
    const ev = r?.systemPayload?.uiEvent;
    if (!ev) return false;
    if (ev['event.name'] !== 'qwen-code.api_response' && ev['event.name'] !== 'qwen-code.api_error') {
      return false;
    }
    if (mainApiPromptPrefix && typeof ev.prompt_id === 'string') {
      return ev.prompt_id.startsWith(mainApiPromptPrefix);
    }
    return mainApiPromptPrefix === null; // 未提供 session ID 时接受全部候选。
  });

  // 按源顺序构造：每条 assistant 对应一次 LLM 调用和一个 step。
  const llmCalls = [];
  let prevStepEndTimestamp = userRec.timestamp; // 第一个 step 的 request 从用户 prompt 时间开始。
  let inputDeltaBuffer = [userRec];              // 为下一 step 的 input.messages_delta 累积记录。
  let apiResponseCursor = 0;                     // 按顺序遍历 mainApiResponses。

  for (let i = 0; i < turnRecords.length; i++) {
    const r = turnRecords[i];

    if (r.type === 'tool_result') {
      // 工具结果进入下一 step 输入增量；此处不独立构造，由后文按 callId 配对。
      inputDeltaBuffer.push(r);
      // 工具结果完成时间是下一 step request_start，因为模型只能在取得结果后再次调用。
      if (r.timestamp) prevStepEndTimestamp = r.timestamp;
      continue;
    }

    if (r.type === 'assistant') {
      // 匹配源顺序中位于 assistant 之前的最近 api_response；Qwen 通常紧邻写入。
      let matchedApiResp = null;
      while (apiResponseCursor < mainApiResponses.length) {
        const cand = mainApiResponses[apiResponseCursor];
        const candIdx = turnRecords.indexOf(cand);
        if (candIdx <= i) {
          matchedApiResp = cand;
          apiResponseCursor++;
        } else {
          break;
        }
      }

      // 从 functionCall part 提取本 LLM 声明的工具。
      const parts = r.message?.parts || [];
      const functionCallParts = parts.filter(
        (p) => p && typeof p === 'object' && p.functionCall && typeof p.functionCall === 'object',
      );
      const declaredTools = functionCallParts.map((p, idx) => ({
        callId: p.functionCall.id || null,
        name: p.functionCall.name || '',
        args: p.functionCall.args ?? null,
        partIndex: idx,
        result: null,                 // 在下方完成工具结果配对后填入。
      }));

      // requestStartTime 取 assistant 前最近记录（prompt 或 tool_result），缺失时回退 assistant。
      const requestStartTime = prevStepEndTimestamp || r.timestamp;

      const llmCall = {
        assistantUuid: r.uuid,
        timestamp: r.timestamp,
        requestStartTime,
        model: r.model || 'unknown',
        usageMetadata: r.usageMetadata || null,
        messageParts: parts,
        assistantRecord: r,
        apiResponse: extractApiResponseEvent(matchedApiResp),
        declaredTools,
        inputMessagesDeltaRecords: inputDeltaBuffer,
      };
      llmCalls.push(llmCall);

      // 清空 delta 缓冲，下一 step 从此继续累积。
      inputDeltaBuffer = [];
      prevStepEndTimestamp = r.timestamp;
    }
    // v1 跳过 slash_command、notification 等其他 system subtype。
  }

  // 将声明工具与本 turn tool_result 配对，优先 callId，必要时位置回退。
  const pairStats = pairToolCallsWithResults(llmCalls, turnRecords);

  return {
    sessionId: userRec.sessionId,
    cwd: userRec.cwd || null,
    gitBranch: userRec.gitBranch || null,
    prompt: promptText,
    promptTimestamp: userRec.timestamp,
    promptUuid: userRec.uuid,
    llmCalls,
    positionalFallbacksUsed: pairStats.positionalFallbacksUsed,
  };
}

function extractUserPromptText(userRec) {
  const parts = userRec?.message?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : '')).join('');
}

function extractApiResponseEvent(rec) {
  if (!rec) return null;
  const ev = rec?.systemPayload?.uiEvent;
  if (!ev) return null;
  return {
    eventName: ev['event.name'],
    eventTimestamp: ev['event.timestamp'],
    responseId: ev.response_id || null,
    model: ev.model || null,
    statusCode: typeof ev.status_code === 'number' ? ev.status_code : null,
    durationMs: typeof ev.duration_ms === 'number' ? ev.duration_ms : null,
    inputTokenCount: typeof ev.input_token_count === 'number' ? ev.input_token_count : null,
    outputTokenCount: typeof ev.output_token_count === 'number' ? ev.output_token_count : null,
    cachedContentTokenCount: typeof ev.cached_content_token_count === 'number' ? ev.cached_content_token_count : null,
    thoughtsTokenCount: typeof ev.thoughts_token_count === 'number' ? ev.thoughts_token_count : null,
    totalTokenCount: typeof ev.total_token_count === 'number' ? ev.total_token_count : null,
    promptId: ev.prompt_id || null,
    authType: ev.auth_type || null,
    errorMessage: ev.error_message || null,
    errorType: ev.error_type || null,
  };
}

/**
 * 为每个声明工具查找其后 tool_result。优先匹配 callId；缺 ID 时按尚未领取结果的位置回退。
 *
 * 原地写入 declaredTools[i].result，并返回位置回退次数供调用方告警。
 */
export function pairToolCallsWithResults(llmCalls, turnRecords) {
  const toolResults = turnRecords.filter((r) => r.type === 'tool_result');
  const claimedToolResults = new Set();

  // 第一轮按 callId 匹配，可靠性最高。
  for (const llmCall of llmCalls) {
    for (const tool of llmCall.declaredTools) {
      if (!tool.callId) continue;
      const match = toolResults.find(
        (tr) => !claimedToolResults.has(tr.uuid) && tr?.toolCallResult?.callId === tool.callId,
      );
      if (match) {
        claimedToolResults.add(match.uuid);
        tool.result = extractToolResult(match);
      }
    }
  }

  // 第二轮对缺失/未匹配 callId 的工具按位置回退。多个无 ID 结果交错时无法消歧；
  // SDK 通常提供 ID，该路径频繁触发可能表示上游行为改变。
  let positionalFallbacksUsed = 0;
  const unclaimedToolResults = toolResults.filter((tr) => !claimedToolResults.has(tr.uuid));
  let cursor = 0;
  for (const llmCall of llmCalls) {
    for (const tool of llmCall.declaredTools) {
      if (tool.result !== null) continue;
      if (cursor < unclaimedToolResults.length) {
        const tr = unclaimedToolResults[cursor++];
        positionalFallbacksUsed++;
        // 用 result.toolCallResult 回填工具缺失的 callId。
        if (!tool.callId && tr?.toolCallResult?.callId) {
          tool.callId = tr.toolCallResult.callId;
        }
        tool.result = extractToolResult(tr);
      }
    }
  }
  return { positionalFallbacksUsed };
}

function extractToolResult(toolResultRec) {
  const tcr = toolResultRec.toolCallResult || {};
  // 优先从 message 的 functionResponse part 提取结果。
  const parts = toolResultRec.message?.parts || [];
  const fr = parts.find((p) => p && p.functionResponse)?.functionResponse;
  const response = fr ? fr.response : (tcr.resultDisplay ?? null);
  const status = tcr.status || 'success';
  // status='error' 或 toolCallResult.error 存在都表示工具失败。
  const errorContent = status === 'error' ? (tcr.error || tcr.resultDisplay || '') : null;
  return {
    uuid: toolResultRec.uuid,
    timestamp: toolResultRec.timestamp,
    response,
    status,
    error: errorContent,
  };
}
