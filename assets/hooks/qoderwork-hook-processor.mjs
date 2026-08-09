#!/usr/bin/env node
/**
 * Qoder Work / Qoder Work CN 的 Hook transcript 处理器。
 *
 * wrapper 传入 agentId 和 stdin Stop payload；本文件通过共享游标仅读新增 transcript 行，
 * 按真实 user prompt 切 turn，再以 tool_result 作为 LLM 响应边界，把 thinking/text/tool_use
 * 合为多 part response，并分配标准 turn.id/step.id。成功追加到
 * `logs/<agentId>/history/*.jsonl` 后才推进游标。
 *
 * 它与 qoder-hook-processor 共享持久化/归一化基础层，但 Qoder Work transcript 没有 progress，
 * 且一个 LLM response 偶尔跨多个 parentUuid，因此不能简单按 parentUuid 切 step。项目真实
 * cwd 还需从 Qoder Work SQLite 恢复；查询失败时保留 Hook sandbox cwd。所有异常由入口
 * fail-open，不应阻塞宿主。
 */

import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  parseArgs,
  parseStdinPayload,
  logDebug,
  getLineRangeInfo,
  readTranscriptLines,
  appendRowsToHistory,
  updateLineRecord,
  loadHookRuntimeConfig,
  HOOKS_DIR,
} from './shared/hook-processor-base.mjs';
import {
  inferProviderName,
  resolveUserId,
  timestampToUnixNanos,
  applyHookContentPolicy,
  sanitizeObject,
  getStringValue,
} from './agent-event-normalizer.mjs';

/**
 * 单次 Stop Hook 入口：读取 stdin、确定 transcript 新增行、组装记录并在成功后提交行号 checkpoint。
 * Qoder Work/CN 共用本处理器，wrapper 通过 agentId 选择变体；解析失败时不推进状态。
 */
async function main() {
  const { agentId, logPrefix } = parseArgs();
  const payload = await parseStdinPayload(agentId);
  if (!payload) return;

  const { transcriptPath, sessionId, cwd: rawCwd } = payload;
  const cwd = resolveQoderWorkProjectDir(rawCwd, agentId);
  const runtimeConfig = loadHookRuntimeConfig(path.join(HOOKS_DIR, '..'));

  const range = getLineRangeInfo(agentId, transcriptPath, sessionId);
  if (!range) return;

  const { startLine, endLine, reason: rangeReason } = range;
  const lines = readTranscriptLines(transcriptPath, startLine, endLine);
  logDebug(agentId, `Read ${lines.length} lines from ${transcriptPath} (range: ${startLine}-${endLine})`);
  if (!lines.length) {
    updateLineRecord(agentId, transcriptPath, sessionId, endLine);
    return;
  }

  const parsed = [];
  for (const line of lines) {
    try { parsed.push(JSON.parse(line)); } catch { /* 跳过损坏行，继续处理本批其他记录。 */ }
  }
  if (!parsed.length) {
    updateLineRecord(agentId, transcriptPath, sessionId, endLine);
    return;
  }

  const records = processTranscript(parsed, sessionId, agentId, runtimeConfig, cwd, {
    rangeReason,
  });
  logDebug(agentId, `Produced ${records.length} events`);

  const rowsToAppend = records.filter(Boolean).map(r => JSON.stringify(r));
  const success = appendRowsToHistory(agentId, logPrefix, rowsToAppend);
  if (success) {
    logDebug(agentId, `Successfully appended ${rowsToAppend.length} rows`);
    updateLineRecord(agentId, transcriptPath, sessionId, endLine);
  }
}

/**
 * 将已解析 JSONL 行切成 turn，再为每个 turn 构造标准事件。
 * 这是内存转换阶段，不读写 checkpoint；返回数组由 main 一次性追加 history，避免部分写成功后误提交。
 */
function processTranscript(parsed, sessionId, agentId, runtimeConfig, cwd, opts = {}) {
  const observedTs = timestampToUnixNanos(Date.now());
  const records = [];

  // Qoder Work 会为自动 review 复制 transcript；原 session 已覆盖用户对话，必须跳过副本防重。
  const isReviewCopy = parsed.some(row =>
    row.type === 'user' &&
    typeof row.message?.content?.[0]?.text === 'string' &&
    row.message.content[0].text.startsWith('[SYSTEM: This is an automated background review task')
  );
  if (isReviewCopy) {
    logDebug(agentId, `Skipping review-copy session ${sessionId}`);
    return records;
  }

  // 过滤元数据、progress、sidechain 和 meta，只保留真实 user/assistant 内容。
  const contentRows = parsed.filter(row => {
    const type = row.type;
    if (!type || type === 'ai-title' || type === 'last-prompt' || type === 'session_meta' || type === 'progress') return false;
    if (row.isSidechain === true || row.isSidechain === 'true') return false;
    if (row.isMeta === true || row.isMeta === 'true') return false;
    return type === 'user' || type === 'assistant';
  });

  if (!contentRows.length) return records;

  // 每条非 tool_result user 消息开启新 turn。
  const allTurns = splitIntoTurns(contentRows);
  const rangeReason = opts.rangeReason || 'incremental';
  const isBootstrap = rangeReason !== 'incremental';
  const turns = isBootstrap ? allTurns.slice(-1) : allTurns;
  if (isBootstrap && allTurns.length > turns.length) {
    logDebug(agentId, `Cursor recovery (${rangeReason}): skipped ${allTurns.length - turns.length} historical turn(s), kept latest turn`);
  }

  // 冷启动恢复可能丢弃前序 turn，元数据必须从最终选中 turn 获取，而非文件开头。
  const firstRow = turns[0]?.[0] || contentRows[0];
  const userId = resolveUserId(firstRow, runtimeConfig);
  const providerName = inferProviderName({ 'gen_ai.agent.type': agentId });
  const version = getStringValue(firstRow, 'version') || '';

  for (const turn of turns) {
    const turnId = getTurnIdForRows(turn);
    const turnRecords = buildTurnEvents(turn, turnId, sessionId, userId, providerName, version, observedTs, runtimeConfig, cwd, agentId);
    records.push(...turnRecords);
  }

  const cursorMode = isBootstrap ? 'bootstrap' : 'incremental';
  const cursorBatchId = crypto.randomUUID();
  for (const record of records) {
    if (!record) continue;
    record['agent.transcript.cursor_mode'] = cursorMode;
    record['agent.transcript.cursor_reason'] = rangeReason;
    record['agent.transcript.cursor_batch_id'] = cursorBatchId;
  }

  return records;
}

/**
 * 以真实用户 prompt 为边界切分 transcript；边界之前的孤立系统行不会单独形成 turn。
 * 最后一个尚未遇到下一 prompt 的分组也会在循环结束后提交。
 */
function splitIntoTurns(contentRows) {
  const turns = [];
  let currentTurn = [];

  for (const row of contentRows) {
    if (isPromptRow(row)) {
      if (currentTurn.length > 0) {
        turns.push(currentTurn);
      }
      currentTurn = [row];
    } else {
      currentTurn.push(row);
    }
  }
  if (currentTurn.length > 0) turns.push(currentTurn);
  return turns;
}

function isPromptRow(row) {
  return row.type === 'user' && !isToolResult(row) && !isSystemInjection(row);
}

function getTurnIdForRows(turnRows) {
  const promptRow = turnRows.find(isPromptRow);
  return promptRow?.promptId || promptRow?.uuid || crypto.randomUUID();
}

function isSystemInjection(row) {
  const text = extractText(row).trimStart();
  if (text.startsWith('<command-message>') ||
    text.startsWith('<command-name>') ||
    text.startsWith('[Request interrupted') ||
    text.startsWith('[SYSTEM: This is an automated background review task')) {
    return true;
  }
  return isPureSystemReminder(text);
}

function isPureSystemReminder(text) {
  return text.startsWith('<system-reminder>')
    && text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim().length === 0;
}

/**
 * 展开一个 Qoder Work turn：先输出用户入口，再按 assistant/tool_result 分组生成多步 LLM/TOOL 链。
 * turnId/sessionId 在所有记录间共享，stepId 由分组顺序产生；内容策略在最终 record 构造时应用。
 */
function buildTurnEvents(turnRows, turnId, sessionId, userId, providerName, version, observedTs, runtimeConfig, cwd, agentId) {
  const records = [];

  // 找到本 turn 的真实用户 prompt。
  const userRow = turnRows.find(isPromptRow);
  const promptId = userRow?.promptId || turnId;
  const turnMetadata = promptId ? { 'agent.qoderwork.promptId': promptId } : {};

  // user-hook 是 ENTRY 输入，按规范不带 step.id 和 model。
  if (userRow) {
    const userText = extractText(userRow);
    if (userText) {
      records.push(buildRecord({
        ...turnMetadata,
        'event.name': 'other',
        'gen_ai.turn.id': turnId,
        'gen_ai.session.id': sessionId,
        'gen_ai.agent.type': agentId,
        'gen_ai.provider.name': providerName,
        'user.id': userId,
        'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: userText }] }],
        time_unix_nano: timestampToUnixNanos(userRow.timestamp),
        observed_time_unix_nano: observedTs,
        version,
      }, turnRows[0], runtimeConfig, cwd));
    }
  }

  // 以 tool_result 为边界分 assistant 组，每组是一轮 LLM。Qoder Work 可能把同一响应的 thinking
  // 与 tool_use 写成不同 parentUuid；按 parentUuid 会误拆 step，并把工具执行时间算进下一 LLM。
  const assistantRows = turnRows.filter(r => r.type === 'assistant');
  const toolResultRows = turnRows.filter(r => r.type === 'user' && isToolResult(r));
  const toolResultsByUseId = new Map();
  for (const row of toolResultRows) {
    const content = Array.isArray(row.message?.content) ? row.message.content : [];
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id && !toolResultsByUseId.has(block.tool_use_id)) {
        toolResultsByUseId.set(block.tool_use_id, { row, block });
      }
    }
  }

  const llmGroups = groupAssistantRowsByToolResults(turnRows);

  const userText = userRow ? extractText(userRow) : '';
  const userTs = userRow ? timestampToUnixNanos(userRow.timestamp) : undefined;
  let prevToolCalls = []; // 上一 step 的 tool_call ID，用于构造 tool_result 增量。
  let prevStepLastToolResultTs = undefined; // 上一个 step 最后一个 tool_result 的 nano ts，用于本 step llm.request 时间

  let stepCounter = 0;
  for (const group of llmGroups) {
    stepCounter++;
    const stepId = `${turnId}:s${stepCounter}`;

    // llm.request 增量：Step 1 是 user prompt；Step N>1 是前一步工具结果。
    let inputDelta;
    if (stepCounter === 1 && userText) {
      inputDelta = [{ role: 'user', parts: [{ type: 'text', content: userText }] }];
    } else if (prevToolCalls.length > 0) {
      const toolParts = [];
      for (const tc of prevToolCalls) {
        const matchingResult = toolResultsByUseId.get(tc.id);
        if (matchingResult) {
          const resultBlock = matchingResult.block;
          const resultText = typeof resultBlock?.content === 'string' ? resultBlock.content : JSON.stringify(resultBlock?.content);
          toolParts.push({ type: 'tool_call_response', id: tc.id, response: resultText });
        }
      }
      if (toolParts.length > 0) {
        inputDelta = [{ role: 'tool', parts: toolParts }];
      }
    }

    // llm.request 时间：step 1 用 user 消息到达时间近似 LLM 开始；
    //   step N>1 = 上一个 step 最后一个 tool_result ts (工具返回后模型立刻开始处理)
    // 否则用 assistant 行写盘时间会导致 LLM span 退化为 0ms（thinking/tool_use 同毫秒批量 flush）
    const llmRequestTs = stepCounter === 1 ? userTs : prevStepLastToolResultTs;

    const stepRecords = buildStepEvents(group, toolResultsByUseId, stepId, turnId, sessionId, userId, providerName, version, observedTs, runtimeConfig, agentId, stepCounter === llmGroups.length, inputDelta, cwd, llmRequestTs, turnMetadata);
    records.push(...stepRecords);

    // 收集本 step 工具调用，其结果将成为下一 step 输入增量。
    prevToolCalls = [];
    let lastToolResultTsInStep = undefined;
    for (const row of group) {
      const msg = row.message || {};
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const b of content) {
        if (b.type === 'tool_use') {
          prevToolCalls.push({ id: b.id, name: b.name });
          // 找到本 step 该 tool_use 对应的 tool_result 行，记录 ts；多 tool 场景保留最后一个
          const matchingResult = toolResultsByUseId.get(b.id);
          if (matchingResult?.row.timestamp) {
            const nano = timestampToUnixNanos(matchingResult.row.timestamp);
            if (nano) lastToolResultTsInStep = nano;
          }
        }
      }
    }
    if (lastToolResultTsInStep) {
      prevStepLastToolResultTs = lastToolResultTsInStep;
    }
  }

  return records;
}

function groupByParentUuid(assistantRows) {
  const groups = [];
  const grouped = new Map();
  const order = [];

  for (const row of assistantRows) {
    // 缺 parentUuid/uuid 的行用随机 UUID 单独分组；实际通常都有 parentUuid，这只是防御回退。
    const parentUuid = row.parentUuid || row.uuid || crypto.randomUUID();
    if (!grouped.has(parentUuid)) {
      grouped.set(parentUuid, []);
      order.push(parentUuid);
    }
    grouped.get(parentUuid).push(row);
  }

  for (const key of order) {
    groups.push(grouped.get(key));
  }
  return groups;
}

/**
 * 按 tool_result 边界合并连续 assistant 行。
 *
 * 每组代表一次 LLM response；tool_result 把工具输出交还模型，之后的 assistant 才是新响应。
 *
 * 不按 parentUuid 的原因：一个响应可能以不同 parentUuid 写 thinking 和 tool_use；误拆后，
 * “前一 tool_result 作为 request 开始”会错误地把工具执行时间归入后半段 LLM。
 */
/**
 * 每遇到 tool_result 即闭合前一批 assistant 输出，使下一批 assistant 成为新的模型 step。
 * 返回分组保留原始顺序，后续可把工具结果作为下一次 request 的 input delta。
 */
function groupAssistantRowsByToolResults(turnRows) {
  const groups = [];
  let current = [];

  for (const row of turnRows) {
    if (row.type === 'assistant') {
      current.push(row);
    } else if (row.type === 'user' && isToolResult(row)) {
      if (current.length > 0) {
        groups.push(current);
        current = [];
      }
    }
    // prompt 等非 tool_result user 行不结束 LLM response 组，在此忽略。
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** 构造一个 step 的 request、response 及配对工具事件；返回顺序就是下游消费的因果顺序。 */
function buildStepEvents(group, toolResultsByUseId, stepId, turnId, sessionId, userId, providerName, version, observedTs, runtimeConfig, agentId, isLastStep, inputDelta, cwd, llmRequestTs, turnMetadata = {}) {
  const records = [];
  const firstRow = group[0];
  const lastRow = group[group.length - 1];

  // thinking 行的 ts 用作 llm.response 时间（模型完成输出的真实时刻）；
  // 没有 thinking 时回退到 lastRow.timestamp（与现有行为一致）
  const thinkingRow = group.find(r => {
    const content = Array.isArray(r.message?.content) ? r.message.content : [];
    const firstType = content[0]?.type;
    return firstType === 'thinking' || r.content_type === 'thinking';
  });
  const llmResponseTs = timestampToUnixNanos(thinkingRow ? thinkingRow.timestamp : lastRow.timestamp);

  // 优先用可直接匹配 intercept token 的 message.id，旧版缺失时回退 parentUuid。
  const responseId = firstRow.message?.id || firstRow.parentUuid || firstRow.uuid;

  // 合并本次响应的全部 output part。
  const outputParts = [];
  const toolCalls = [];

  for (const row of group) {
    const msg = row.message || {};
    const content = Array.isArray(msg.content) ? msg.content : [];
    // 原 transcript 没有 content_type，从 message.content[0].type 推导。
    const contentType = row.content_type || (content[0]?.type) || '';

    if (contentType === 'thinking') {
      const thinking = content.find(b => b.type === 'thinking')?.thinking
        || content.find(b => b.type === 'text')?.text
        || (typeof msg.content === 'string' ? msg.content : '');
      if (thinking) outputParts.push({ type: 'reasoning', content: thinking });
    } else if (contentType === 'text') {
      const text = content.find(b => b.type === 'text')?.text
        || (typeof msg.content === 'string' ? msg.content : '');
      if (text) outputParts.push({ type: 'text', content: text });
    } else if (contentType === 'tool_use') {
      const toolBlock = content.find(b => b.type === 'tool_use') || {};
      outputParts.push({ type: 'tool_call', id: toolBlock.id, name: toolBlock.name, arguments: toolBlock.input });
      toolCalls.push({ id: toolBlock.id, name: toolBlock.name, input: toolBlock.input });
    }
  }

  const finishReason = toolCalls.length > 0 ? 'tool_calls' : (isLastStep ? 'end_turn' : 'stop');

  // llm.request 使用增量 `gen_ai.input.messages_delta`：Step 1 只有 prompt，后续只有前一步
  // tool_results；converter 会跨 step 累积，重建各 LLM span 的完整上下文。
  const llmRequestFields = {
    ...turnMetadata,
    'event.name': 'llm.request',
    'gen_ai.step.id': stepId,
    'gen_ai.turn.id': turnId,
    'gen_ai.session.id': sessionId,
    'gen_ai.agent.type': agentId,
    'gen_ai.provider.name': providerName,
    'gen_ai.request.model': 'auto',
    'user.id': userId,
    time_unix_nano: llmRequestTs || timestampToUnixNanos(firstRow.timestamp),
    observed_time_unix_nano: observedTs,
    version,
  };
  if (inputDelta) {
    llmRequestFields['gen_ai.input.messages_delta'] = inputDelta;
  }
  records.push(buildRecord(llmRequestFields, firstRow, runtimeConfig, cwd));

  // 构造合并多 part 的 llm.response。
  if (outputParts.length > 0) {
    records.push(buildRecord({
      ...turnMetadata,
      'event.name': 'llm.response',
      'gen_ai.step.id': stepId,
      'gen_ai.turn.id': turnId,
      'gen_ai.session.id': sessionId,
      'gen_ai.agent.type': agentId,
      'gen_ai.provider.name': providerName,
      'gen_ai.request.model': 'auto',
      'gen_ai.response.model': 'auto',
      'gen_ai.response.id': responseId,
      'gen_ai.response.finish_reasons': [finishReason],
      'user.id': userId,
      'gen_ai.output.messages': [{ role: 'assistant', parts: outputParts, finish_reason: finishReason }],
      time_unix_nano: llmResponseTs,
      observed_time_unix_nano: observedTs,
      version,
    }, firstRow, runtimeConfig, cwd));
  }

  // 构造 tool.call 与 tool.result 事件。
  for (const tc of toolCalls) {
    records.push(buildRecord({
      ...turnMetadata,
      'event.name': 'tool.call',
      'gen_ai.step.id': stepId,
      'gen_ai.turn.id': turnId,
      'gen_ai.session.id': sessionId,
      'gen_ai.agent.type': agentId,
      'gen_ai.tool.name': tc.name,
      'gen_ai.tool.call.id': tc.id,
      'gen_ai.tool.call.exec.id': tc.id,
      'gen_ai.tool.call.arguments': typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
      'user.id': userId,
      time_unix_nano: timestampToUnixNanos(lastRow.timestamp),
      observed_time_unix_nano: observedTs,
      version,
    }, firstRow, runtimeConfig, cwd));

    // 按 tool_use_id 查找对应 tool_result。
    const matchingResult = toolResultsByUseId.get(tc.id);
    if (matchingResult) {
      const { row: resultRow, block: resultBlock } = matchingResult;
      const resultText = typeof resultBlock?.content === 'string' ? resultBlock.content : JSON.stringify(resultBlock?.content);
      records.push(buildRecord({
        ...turnMetadata,
        'event.name': 'tool.result',
        'gen_ai.step.id': stepId,
        'gen_ai.turn.id': turnId,
        'gen_ai.session.id': sessionId,
        'gen_ai.agent.type': agentId,
        'gen_ai.tool.name': tc.name,
        'gen_ai.tool.call.id': tc.id,
        'gen_ai.tool.call.exec.id': tc.id,
        'gen_ai.tool.call.result': resultText,
        'tool.result.status': resultBlock?.is_error ? 'failure' : 'success',
        'user.id': userId,
        time_unix_nano: timestampToUnixNanos(resultRow.timestamp),
        observed_time_unix_nano: observedTs,
        version,
      }, resultRow, runtimeConfig, cwd));
    }
  }

  return records;
}

function buildRecord(fields, sourceRow, runtimeConfig, cwd) {
  const record = {
    'event.id': crypto.randomUUID(),
    'agent.source': 'qoder-transcript-hook',
    'agent.qoderwork.variant': fields['gen_ai.agent.type'] || 'qoder-work',
    ...fields,
  };
  if (cwd) record['agent.qoderwork.cwd'] = cwd;
  if (sourceRow) {
    if (sourceRow.isSidechain !== undefined) record['agent.qoderwork.isSidechain'] = String(sourceRow.isSidechain);
    if (sourceRow.userType) record['agent.qoderwork.userType'] = sourceRow.userType;
    if (sourceRow.version) record['agent.qoderwork.version'] = sourceRow.version;
    if (sourceRow.agentId) record['agent.qoderwork.agentId'] = sourceRow.agentId;
  }
  return sanitizeObject(applyHookContentPolicy(record, runtimeConfig)) || null;
}

function isToolResult(row) {
  const content = row.message?.content;
  return Array.isArray(content) && content.length > 0 && content[0]?.type === 'tool_result';
}

function extractText(row) {
  const msg = row.message || {};
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block.type === 'text' && block.text) parts.push(block.text);
      else if (typeof block === 'string') parts.push(block);
    }
    return parts.join('\n');
  }
  return '';
}

/**
 * 把 Qoder Work sandbox cwd 解析为用户真实项目目录。
 *
 * Hook 只有 `~/.qoderwork/workspace/<chatId>`，真实路径位于 SQLite
 * `chats.additional_directories`；本函数只读查询恢复它，失败时返回原 cwd。
 */
function resolveQoderWorkProjectDir(sandboxCwd, agentId) {
  if (!sandboxCwd) return undefined;
  const isCn = agentId === 'qoder-work-cn';
  const homeDirName = isCn ? '.qoderworkcn' : '.qoderwork';
  const appDirName = isCn ? 'QoderWork CN' : 'QoderWork';
  const qwWorkspacePrefix = path.join(os.homedir(), homeDirName, 'workspace') + path.sep;
  if (!sandboxCwd.startsWith(qwWorkspacePrefix)) return sandboxCwd;

  const relative = sandboxCwd.slice(qwWorkspacePrefix.length);
  const chatId = relative.split(path.sep)[0];
  if (!chatId || !/^[a-z0-9-]{1,64}$/i.test(chatId)) return sandboxCwd;

  const dbPath = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', appDirName, 'data', 'agents.db')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), appDirName, 'data', 'agents.db');

  try {
    const sql = `SELECT additional_directories FROM chats WHERE id = '${chatId.replace(/'/g, "''")}'`;
    const result = execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf-8', timeout: 5000 }).trim();
    if (result) {
      const dirs = JSON.parse(result);
      if (Array.isArray(dirs) && dirs.length > 0 && typeof dirs[0] === 'string') {
        logDebug(agentId, `Resolved project dir: ${sandboxCwd} -> ${dirs[0]}`);
        return dirs[0];
      }
    }
  } catch (err) {
    logDebug(agentId, `Failed to resolve project dir from sqlite: ${err.message || err}`);
  }
  return sandboxCwd;
}

export { extractText, getTurnIdForRows, isSystemInjection, isToolResult, splitIntoTurns };

main().catch(() => { /* 遵循 fail-open，吞掉采集异常。 */ });
