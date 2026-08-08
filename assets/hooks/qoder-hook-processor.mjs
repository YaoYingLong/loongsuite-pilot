#!/usr/bin/env node
/**
 * Qoder / Qoder CLI / Qoder CN 的 Hook transcript 处理器。
 *
 * wrapper 通过 `--agent-id` 指定变体，并把 Stop payload 从 stdin 传入。处理器读取本次新增的
 * transcript 行（Qoder CN 会按设计重读完整文件），利用 progress Hook 时间划分 LLM 调用，
 * 将 thinking/text/tool_use 合成多 part response，再把标准事件追加到
 * `logs/<agentId>/history/*.jsonl`，由对应 Input 继续采集。
 *
 * 非交互/打印模式中 Stop 可能早于 transcript 刷盘，因此会启动延迟重试子进程。Qoder CN
 * 又可能每 turn 多次触发 Stop，故以 transcript 路径哈希锁串行化重试。history 成功写入后才
 * 推进持久化行游标；失败保留游标供下次恢复。stdout 协议和大部分 I/O 均 fail-open。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  parseArgs,
  parseStdinPayload,
  logDebug,
  getLineRangeInfo,
  getTranscriptLineCount,
  readTranscriptLines,
  appendRowsToHistory,
  updateLineRecord,
  loadHookRuntimeConfig,
  getErrorLogFile,
  HOOKS_DIR,
  LOONGSUITE_PILOT_LOGS_BASE_DIR,
} from './shared/hook-processor-base.mjs';
import {
  buildQoderHookRecord,
  inferProviderName,
} from './agent-event-normalizer.mjs';
import {
  agentBaseFieldPatch,
  collectResourceAttributesFromEnv,
  parseSpanAttributesFromEnv,
} from './shared/resource-context.mjs';
import { recordUpstreamContextOnce } from './shared/upstream-context.mjs';

const RESOURCE_ATTRIBUTES = collectResourceAttributesFromEnv(process.env, { agentId: 'qoder' });
const RESOURCE_BASE_FIELD_PATCH = agentBaseFieldPatch(RESOURCE_ATTRIBUTES);
const RESOURCE_ATTRIBUTE_FIELDS = Object.keys(RESOURCE_ATTRIBUTES).length > 0
  ? { resourceAttributes: RESOURCE_ATTRIBUTES }
  : {};
// 调用方 span 属性（如 multica.*）铺到事件顶层，供 trace flusher 透传。
const SPAN_ATTRIBUTES = parseSpanAttributesFromEnv(process.env, { agentId: 'qoder' });

// --- 重试锁（仅 Qoder CN） -------------------------------------------------
// Qoder CN 每 turn 会多次触发 Stop，未完整 transcript 又会启动后台重试；若不协调会堆叠并
// 生成重复记录。父进程在已有活锁时不 spawn，重试子进程也在同伴持锁时拒绝处理。
// 锁位于 <HOOKS_DIR>/.retry-locks/<sha1>.lock，内容为 `{pid, sessionId, startedAt}`。

export const RETRY_LOCK_DIR = path.join(HOOKS_DIR, '.retry-locks');
export const RETRY_LOCK_MAX_AGE_MS = 60_000;

export function retryLockPath(transcriptPath, dir = RETRY_LOCK_DIR) {
  const hash = crypto.createHash('sha1').update(transcriptPath).digest('hex');
  return path.join(dir, `${hash}.lock`);
}

export function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

export function readRetryLock(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* 文件不存在或损坏时按无有效锁继续。 */ }
  return null;
}

export function isRetryLockStale(lock) {
  if (!lock) return true;
  const age = Date.now() - (Number(lock.startedAt) || 0);
  if (age > RETRY_LOCK_MAX_AGE_MS) return true;
  return !pidAlive(lock.pid);
}

export function tryAcquireRetryLock(transcriptPath, sessionId, dir = RETRY_LOCK_DIR) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const lockPath = retryLockPath(transcriptPath, dir);
    const payload = JSON.stringify({ pid: process.pid, sessionId, startedAt: Date.now() });
    try {
      const handle = fs.openSync(lockPath, 'wx');
      fs.writeSync(handle, payload);
      fs.closeSync(handle);
      return true;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        const existing = readRetryLock(lockPath);
        if (isRetryLockStale(existing)) {
          try { fs.unlinkSync(lockPath); } catch { /* 不能清理陈旧锁时本轮获取会自然失败。 */ }
          try {
            const handle = fs.openSync(lockPath, 'wx');
            fs.writeSync(handle, payload);
            fs.closeSync(handle);
            return true;
          } catch { return false; }
        }
        return false;
      }
      return false;
    }
  } catch {
    return false;
  }
}

export function releaseRetryLock(transcriptPath, dir = RETRY_LOCK_DIR) {
  try {
    const lockPath = retryLockPath(transcriptPath, dir);
    const existing = readRetryLock(lockPath);
    // 仅删除自己 PID 持有的锁，避免崩溃恢复时误删同伴新锁。
    if (existing && existing.pid === process.pid) {
      fs.unlinkSync(lockPath);
    }
  } catch { /* 尽力清理；失败不影响后续流程。 */ }
}

// --- 时间戳辅助函数 --------------------------------------------------------

function isoToUnixNanos(isoString) {
  if (!isoString) return '';
  const ms = Date.parse(isoString);
  if (Number.isNaN(ms)) return '';
  return String(BigInt(ms) * 1_000_000n);
}

function timestampToUnixNanos(value) {
  if (!value) return String(BigInt(Date.now()) * 1_000_000n);
  if (typeof value === 'number') return String(BigInt(Math.round(value)) * 1_000_000n);
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return String(BigInt(ms) * 1_000_000n);
    if (/^\d+$/.test(value)) return value;
  }
  return String(BigInt(Date.now()) * 1_000_000n);
}

function computeDurationMs(startNanos, endNanos) {
  if (!startNanos || !endNanos || startNanos === endNanos) return 0;
  try {
    const diffNs = BigInt(endNanos) - BigInt(startNanos);
    if (diffNs <= 0n) return 0;
    return Number(diffNs / 1_000_000n);
  } catch {
    return 0;
  }
}

// --- 主流程 ----------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const isRetry = args.includes('--retry');

  // 重试模式由延迟后台子进程调用，不再读取 stdin，直接从 argv 取得 transcript/session。
  if (isRetry) {
    const transcriptIdx = args.indexOf('--transcript');
    const sessionIdx = args.indexOf('--session');
    const cwdIdx = args.indexOf('--cwd');
    const transcriptPath = transcriptIdx >= 0 ? args[transcriptIdx + 1] : '';
    const sessionId = sessionIdx >= 0 ? args[sessionIdx + 1] : '';
    const cwd = cwdIdx >= 0 ? args[cwdIdx + 1] : undefined;
    const { agentId, logPrefix } = parseArgs();
    if (!transcriptPath || !sessionId) return;
    logDebug(agentId, `Retry: processing ${transcriptPath} for session ${sessionId}`);
    const runtimeConfig = loadHookRuntimeConfig(path.join(HOOKS_DIR, '..'));

    // Qoder CN：先等待 HOOK_RETRY_DELAY，让排队 Stop 有机会推进 offset，再争抢同一 transcript
    // 锁；未抢到或稍后发现 currentCount==lastCount 的进程直接退出。
    const retryDelay = parseInt(process.env.HOOK_RETRY_DELAY || '0', 10);
    if (retryDelay > 0) {
      await new Promise(r => setTimeout(r, retryDelay));
    }

    if (agentId === 'qoder-cn') {
      if (!tryAcquireRetryLock(transcriptPath, sessionId)) {
        logDebug(agentId, `Retry skipped: lock held by peer for ${transcriptPath}`);
        return;
      }
    }
    try {
      const range = getLineRangeInfo(agentId, transcriptPath, sessionId);
      if (!range) return;
      await processTranscript(
        agentId, logPrefix, transcriptPath, sessionId,
        range.startLine, range.endLine, runtimeConfig, cwd,
        { delayApplied: true, rangeReason: range.reason },
      );
    } finally {
      if (agentId === 'qoder-cn') releaseRetryLock(transcriptPath);
    }
    return;
  }

  // 正常模式由 Stop Hook 调用，从 stdin 校验 transcriptPath/sessionId/cwd。
  const { agentId, logPrefix } = parseArgs();
  const payload = await parseStdinPayload(agentId);
  if (!payload) return;

  const { transcriptPath, sessionId, cwd } = payload;

  // 方案1(env):首个 turn 读 TRACEPARENT 写 session 级关联记录(fail-open, 每 session 一次)
  if (sessionId) {
    recordUpstreamContextOnce({ agentId, sessionId, dataDir: path.dirname(LOONGSUITE_PILOT_LOGS_BASE_DIR) });
  }

  const runtimeConfig = loadHookRuntimeConfig(path.join(HOOKS_DIR, '..'));

  const range = getLineRangeInfo(agentId, transcriptPath, sessionId);
  if (!range) return;

  const startLine = range.startLine;
  const endLine = range.endLine;
  const lines = readTranscriptLines(transcriptPath, startLine, endLine);
  logDebug(agentId, `Read ${lines.length} lines (range: ${startLine}-${endLine})`);
  if (!lines.length) {
    updateLineRecord(agentId, transcriptPath, sessionId, endLine);
    return;
  }

  // print/非交互模式中 Stop 早于 transcript 完整刷盘，剩余写入又发生在 Hook 返回后；
  // 发现不完整时启动后台子进程，延迟后重读。
  let parsed = [];
  for (const line of lines) {
    try { parsed.push(JSON.parse(line)); } catch { /* 跳过无法解析的行。 */ }
  }

  // `last-prompt` 是 qodercli 退出时写入的权威结束标记；缺失说明文件仍在刷盘。
  const hasLastPrompt = parsed.some(p => p.type === 'last-prompt');
  if (parsed.length > 0 && !hasLastPrompt) {
    logDebug(agentId, `Transcript incomplete (${parsed.length} lines, no last-prompt marker). Spawning background retry in 5s.`);
    if (agentId === 'qoder-cn') {
      // 子进程锁会保证正确性；父进程先跳过明显重复 spawn，可减少 Qoder CN 进程抖动。
      const lockPath = retryLockPath(transcriptPath);
      const existing = readRetryLock(lockPath);
      if (existing && !isRetryLockStale(existing)) {
        logDebug(agentId, `Skip spawn: live retry lock held by pid ${existing.pid}`);
      } else {
        if (existing) { try { fs.unlinkSync(lockPath); } catch { /* 忽略旧锁清理失败。 */ } }
        spawnDelayedRetry(agentId, transcriptPath, sessionId, logPrefix, cwd);
      }
    } else {
      spawnDelayedRetry(agentId, transcriptPath, sessionId, logPrefix, cwd);
    }
    return;
  }

  if (agentId === 'qoder-cn') {
    if (!tryAcquireRetryLock(transcriptPath, sessionId)) {
      logDebug(agentId, `Stop skipped: peer retry/handler holds lock for ${transcriptPath}`);
      return;
    }
    try {
      await processTranscript(
        agentId, logPrefix, transcriptPath, sessionId, startLine, endLine,
        runtimeConfig, cwd, { rangeReason: range.reason },
      );
    } finally {
      releaseRetryLock(transcriptPath);
    }
    return;
  }

  await processTranscript(
    agentId, logPrefix, transcriptPath, sessionId, startLine, endLine,
    runtimeConfig, cwd, { rangeReason: range.reason },
  );
}

// 非交互 `--print` 每 session 只触发一次 Stop，正常 Hook 与重试通常不竞争；即使意外并发，
// getLineRangeInfo 的 offset 检查也会阻止重复处理。
function spawnDelayedRetry(agentId, transcriptPath, sessionId, logPrefix, cwd) {
  const nodebin = process.argv[0];
  const script = fileURLToPath(import.meta.url);
  const spawnArgs = [
    script,
    '--agent-id', agentId,
    '--log-prefix', logPrefix,
    '--retry',
    '--transcript', transcriptPath,
    '--session', sessionId,
    ...(cwd ? ['--cwd', cwd] : []),
  ];
  const child = spawn(nodebin, spawnArgs, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, HOOK_RETRY_DELAY: '5000' },
  });
  child.unref();
  logDebug(agentId, `Spawned retry subprocess (PID ${child.pid})`);
}

async function processTranscript(agentId, logPrefix, transcriptPath, sessionId, startLine, initialEndLine, runtimeConfig, cwd, opts) {
  // 重试子进程先按参数等待，让宿主有时间继续完成 transcript 写入。
  const delayApplied = !!(opts && opts.delayApplied);
  if (!delayApplied) {
    const retryDelay = parseInt(process.env.HOOK_RETRY_DELAY || '0', 10);
    if (retryDelay > 0) {
      await new Promise(r => setTimeout(r, retryDelay));
    }
  }

  // 延迟后重新统计并读取 transcript，它可能已经增长。
  let endLine = initialEndLine;
  const currentCount = getTranscriptLineCount(transcriptPath);
  if (currentCount > endLine) {
    endLine = currentCount;
  }

  let lines = readTranscriptLines(transcriptPath, startLine, endLine);
  logDebug(agentId, `Processing ${lines.length} lines (range: ${startLine}-${endLine})`);
  if (!lines.length) {
    updateLineRecord(agentId, transcriptPath, sessionId, endLine);
    return;
  }

  // --- 阶段 1：解析全部目标 transcript 行 ---
  let parsed = [];
  for (const line of lines) {
    try { parsed.push(JSON.parse(line)); } catch { /* 跳过无法解析的行。 */ }
  }

  // --- 阶段 2：提取 progress 时序与内容事件 ---
  const progressEvents = [];
  const contentEvents = [];

  let lastProgressHookEvent = '';
  for (const row of parsed) {
    const rowType = row.type;
    if (rowType === 'progress') {
      const data = row.data || {};
      const hookEvent = data.hookEvent || '';
      // 同一 hookEvent 会为每个已注册命令写 progress，只保留连续同名组的第一条。
      if (hookEvent && hookEvent !== lastProgressHookEvent) {
        progressEvents.push({ hookEvent, ts: row.timestamp, hookName: data.hookName || '' });
      }
      if (hookEvent) lastProgressHookEvent = hookEvent;
    } else if (rowType === 'user' || rowType === 'assistant') {
      contentEvents.push(row);
    }
    // session_meta 及其他非内容类型不参与事件构造。
  }

  // --- 阶段 2.5（仅 Qoder CN）：transcript 尚未出现 Stop 时不处理 ---
  // PostToolUse 重试发生在 Stop 写入前，只能看到不完整 ReAct 链；等待 Stop 后才能生成完整
  // request 及 step 2 的 tool_result 输入增量。
  if (agentId === 'qoder-cn') {
    const hasStop = progressEvents.some(pe => pe.hookEvent === 'Stop');
    if (!hasStop) {
      logDebug(agentId, `Transcript not yet complete (no Stop event in progress). Skipping processing.`);
      return;
    }
    // 检测到 Stop 后从头重读，使 turn 切分看到完整 user -> assistant/tool -> result -> assistant 链。
    startLine = 0;
    lines = readTranscriptLines(transcriptPath, startLine, endLine);
    logDebug(agentId, `Reprocessing full transcript from 0-${endLine} (${lines.length} lines)`);
    // startLine 已重置，必须重新解析目标行。
    parsed = [];
    for (const line of lines) {
      try { parsed.push(JSON.parse(line)); } catch { /* 跳过无法解析的行。 */ }
    }
    // 从完整 transcript 重新提取 progress 和内容事件。
    progressEvents.length = 0;
    contentEvents.length = 0;
    lastProgressHookEvent = '';
    for (const row of parsed) {
      const rowType = row.type;
      if (rowType === 'progress') {
        const data = row.data || {};
        const hookEvent = data.hookEvent || '';
        if (hookEvent && hookEvent !== lastProgressHookEvent) {
          progressEvents.push({ hookEvent, ts: row.timestamp, hookName: data.hookName || '' });
        }
        if (hookEvent) lastProgressHookEvent = hookEvent;
      } else if (rowType === 'user' || rowType === 'assistant') {
        contentEvents.push(row);
      }
    }
  }

  // --- 阶段 3：按真实 user prompt 切分 turn ---
  // 每个真实 prompt 开新 turn，tool result 留在前一 turn，避免所有 turn 继承首个 prompt。
  const allTurnSegments = splitContentEventsIntoTurns(contentEvents);
  const rangeReason = opts?.rangeReason || 'incremental';
  // 游标恢复和 Qoder CN 完整链重建都会从行 0 读取，但只有最后一个逻辑 turn 是新数据，
  // 因此即使 offset 有效也只能输出最后 turn。
  const turnSegments = selectTurnSegmentsForCollection(allTurnSegments, rangeReason, agentId);
  const keepLatestTurnOnly = turnSegments.length < allTurnSegments.length;
  if (keepLatestTurnOnly && allTurnSegments.length > turnSegments.length) {
    const recoverySource = agentId === 'qoder-cn' && rangeReason === 'incremental'
      ? 'QoderCN full reparse'
      : `cursor recovery (${rangeReason})`;
    logDebug(agentId, `${recoverySource}: skipped ${allTurnSegments.length - turnSegments.length} historical turn(s), kept latest turn`);
  }
  logDebug(agentId, `Split transcript segment into ${turnSegments.length} turn(s)`);

  // --- 阶段 4：逐 turn 构造标准事件 ---
  const records = [];
  for (let turnIdx = 0; turnIdx < turnSegments.length; turnIdx++) {
    const turnContentEvents = turnSegments[turnIdx];
    const turnId = crypto.randomUUID();

    // 使用本 turn 的 progress/content 计算 LLM 调用边界。
    const llmBoundaries = buildLlmBoundaries(progressEvents, turnContentEvents);
    logDebug(agentId, `Turn ${turnIdx + 1}: detected ${llmBoundaries.length} LLM call(s)`);

    const turnRecords = buildEventsFromBoundaries(
      llmBoundaries, turnContentEvents, parsed, turnId, sessionId, agentId, runtimeConfig, cwd,
    );
    records.push(...turnRecords);

    logDebug(agentId, `Turn ${turnIdx + 1}: produced ${turnRecords.length} events, turn_id=${turnId}`);
  }

  const cursorMode = rangeReason === 'incremental' ? 'incremental' : 'bootstrap';
  const cursorBatchId = crypto.randomUUID();
  for (const record of records) {
    record['agent.transcript.cursor_mode'] = cursorMode;
    record['agent.transcript.cursor_reason'] = rangeReason;
    record['agent.transcript.cursor_batch_id'] = cursorBatchId;
  }

  // --- 阶段 5：追加 history，成功后推进 offset ---
  const rowsToAppend = records.map(r => JSON.stringify(r));
  const success = appendRowsToHistory(agentId, logPrefix, rowsToAppend);
  if (success) {
    logDebug(agentId, `Appended ${rowsToAppend.length} rows`);
    updateLineRecord(agentId, transcriptPath, sessionId, endLine);
  }
}

export function selectTurnSegmentsForCollection(turnSegments, rangeReason, agentId) {
  // Qoder CN 每次 Stop 都有意重读完整文件，其他变体仅游标恢复时如此；两者都只输出最新 turn。
  if (rangeReason !== 'incremental' || agentId === 'qoder-cn') {
    return turnSegments.slice(-1);
  }
  return turnSegments;
}

// --- LLM 边界检测 ---------------------------------------------------------

function buildLlmBoundaries(progressEvents, contentEvents) {
  // 第一步：把 assistant block 分组为 LLM 调用。优先级为 message.id（CLI）> progress 窗口
  //（IDE）> 无 progress 时按时间接近度回退。
  const assistantGroups = [];
  let currentGroup = [];
  let lastTs = null;
  let currentKey = null;
  const hasProgressWindows = progressEvents.some(pe =>
    pe.hookEvent === 'UserPromptSubmit' || pe.hookEvent === 'PostToolUse' ||
    pe.hookEvent === 'PreToolUse' || pe.hookEvent === 'Stop'
  );

  function flushGroup() {
    if (currentGroup.length > 0) assistantGroups.push(currentGroup);
    currentGroup = [];
    lastTs = null;
    currentKey = null;
  }

  for (const row of contentEvents) {
    if (row.type !== 'assistant') {
      flushGroup();
      continue;
    }
    const ts = row.timestamp ? Date.parse(row.timestamp) : 0;
    if (!ts) continue;

    const messageId = row.message?.id || null;
    const key = messageId
      ? `message:${messageId}`
      : hasProgressWindows
        ? progressWindowKey(progressEvents, ts)
        : null;

    // 判断当前 assistant 行是否开启新的 LLM 调用。
    let isNewCall = false;
    if (currentGroup.length > 0 && key && currentKey) {
      isNewCall = key !== currentKey;
    } else if (currentGroup.length > 0 && !key && !currentKey) {
      isNewCall = lastTs !== null && (ts - lastTs) > 200;
    } else if (currentGroup.length > 0 && key !== currentKey) {
      // 同时出现有/无 key 的行很少见，保留旧时间间隔回退。
      isNewCall = lastTs !== null && (ts - lastTs) > 200;
    }

    if (isNewCall) flushGroup();

    currentGroup.push(row);
    currentKey = key;
    lastTs = ts;
  }
  flushGroup();

  // 第二步：为每个 assistant 组从 progress 中寻找开始/结束时间。
  const boundaries = [];
  for (let i = 0; i < assistantGroups.length; i++) {
    const group = assistantGroups[i];
    const groupStartMs = Date.parse(group[0].timestamp) || 0;
    const groupEndMs = Date.parse(group[group.length - 1].timestamp) || groupStartMs;

    // 开始时间取该组之前最近的 PostToolUse 或 UserPromptSubmit。
    let startTs = null;
    for (const pe of progressEvents) {
      const peMs = Date.parse(pe.ts) || 0;
      if (peMs >= groupStartMs) break;
      if (pe.hookEvent === 'PostToolUse' || pe.hookEvent === 'UserPromptSubmit') {
        startTs = pe.ts;
      }
    }

    // 结束时间取该组之后第一个 PreToolUse 或 Stop。
    let endTs = null;
    for (const pe of progressEvents) {
      const peMs = Date.parse(pe.ts) || 0;
      if (peMs <= groupEndMs) continue;
      if (pe.hookEvent === 'PreToolUse' || pe.hookEvent === 'Stop') {
        endTs = pe.ts;
        break;
      }
    }

    boundaries.push({
      startTs: startTs || group[0].timestamp,
      endTs: endTs || group[group.length - 1].timestamp,
    });
  }

  return boundaries;
}

function progressWindowKey(progressEvents, rowMs) {
  let startTs = null;
  for (const pe of progressEvents) {
    const peMs = Date.parse(pe.ts) || 0;
    if (peMs >= rowMs) break;
    if (pe.hookEvent === 'PostToolUse' || pe.hookEvent === 'UserPromptSubmit') {
      startTs = pe.ts;
    }
  }

  // 找不到开始边界说明该行早于全部 progress；返回 null 改用时间间隔，避免错误合并多个调用。
  if (!startTs) return null;

  let endTs = null;
  for (const pe of progressEvents) {
    const peMs = Date.parse(pe.ts) || 0;
    if (peMs <= rowMs) continue;
    if (pe.hookEvent === 'PreToolUse' || pe.hookEvent === 'Stop') {
      endTs = pe.ts;
      break;
    }
  }

  return `progress:${startTs}->${endTs || ''}`;
}

// --- 标准事件构造 ---------------------------------------------------------

function buildEventsFromBoundaries(boundaries, contentEvents, allParsed, turnId, sessionId, agentId, runtimeConfig, cwd) {
  const records = [];
  const observedTs = timestampToUnixNanos(Date.now());

  // 找到本 turn 的真实用户 prompt。
  const userRow = contentEvents.find(r => r.type === 'user' && !isToolResult(r));
  const userId = resolveUserId(userRow || contentEvents[0], runtimeConfig);
  const agentType = inferVariant(userRow || contentEvents[0], agentId);
  const providerName = inferProviderName({ 'gen_ai.agent.type': agentType });

  // 用户 Hook 记录作为 ENTRY 输入，不属于具体 step。
  if (userRow) {
    const userText = extractUserText(userRow);
    if (userText) {
      const userHookModel = contentEvents.find(r => r.type === 'assistant' && r.message?.model)?.message?.model || 'unknown';
      records.push({
        'event.id': crypto.randomUUID(),
        'event.name': 'other',
        'gen_ai.turn.id': turnId,
        'gen_ai.session.id': sessionId,
        'gen_ai.agent.type': agentType,
        'gen_ai.provider.name': providerName,
        'gen_ai.request.model': userHookModel,
        'user.id': userId,
        'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: userText }] }],
        'agent.source': 'qoder-transcript-hook',
        'agent.qoder.raw_type': 'user',
        'agent.qoder.content_type': 'text',
        time_unix_nano: timestampToUnixNanos(userRow.timestamp),
        observed_time_unix_nano: observedTs,
      });
    }
  }

  // 没有任何 progress 边界时回退旧的逐行归一化。
  if (boundaries.length === 0) {
    const legacyRecords = buildLegacyEvents(contentEvents, turnId, sessionId, agentId, runtimeConfig, records, observedTs);
    return finalizeRecords(legacyRecords, cwd);
  }

  // 每个边界拥有从自身 startTs 到下个边界 startTs 的内容，使夹在边界间的 tool_result
  // 归属前一步而不会落入空隙。
  const assignedContent = assignContentToBoundaries(boundaries, contentEvents);

  // 为每个 LLM 调用边界输出 request/response/tool 记录。
  let toolResultsForNextStep = [];
  for (let i = 0; i < boundaries.length; i++) {
    const boundary = boundaries[i];
    const stepId = `${turnId}:s${i + 1}`;
    const content = assignedContent[i] || [];
    const startNanos = isoToUnixNanos(boundary.startTs);
    const endNanos = boundary.endTs ? isoToUnixNanos(boundary.endTs) : startNanos;

    // 预扫描本 step assistant 行中的模型名；CLI 通常在 message.model 提供。
    const stepModel = content.find(r => r.type === 'assistant' && r.message?.model)?.message?.model || 'auto';

    // 构造本 step 的 llm.request。
    let inputDelta;
    if (i === 0 && userRow) {
      inputDelta = [{ role: 'user', parts: [{ type: 'text', content: extractUserText(userRow) }] }];
    } else if (toolResultsForNextStep.length > 0) {
      inputDelta = toolResultsForNextStep.map(tr => ({
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: tr.toolId, response: tr.result }],
      }));
    }

    if (inputDelta) {
      records.push({
        'event.id': crypto.randomUUID(),
        'event.name': 'llm.request',
        'gen_ai.step.id': stepId,
        'gen_ai.turn.id': turnId,
        'gen_ai.session.id': sessionId,
        'gen_ai.agent.type': agentType,
        'gen_ai.provider.name': providerName,
        'gen_ai.request.model': stepModel,
        'user.id': userId,
        'gen_ai.input.messages_delta': inputDelta,
        'agent.source': 'qoder-transcript-hook',
        time_unix_nano: startNanos,
        observed_time_unix_nano: observedTs,
      });
    }

    // 构造合并多 part 的 llm.response。
    const outputParts = [];
    const toolCalls = [];
    toolResultsForNextStep = [];
    let responseId = undefined;
    let lastAssistantTs = null;
    let firstAssistantTs = null;

    for (const row of content) {
      if (row.type === 'assistant') {
        const msg = row.message || {};
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        if (msg.id && !responseId) responseId = msg.id;
        if (row.timestamp) lastAssistantTs = row.timestamp;
        if (row.timestamp && !firstAssistantTs) firstAssistantTs = row.timestamp;
        for (const block of blocks) {
          if (block.type === 'thinking') {
            outputParts.push({ type: 'reasoning', content: block.thinking || '' });
          } else if (block.type === 'redacted_thinking') {
            // thinking 已被脱敏且没有内容时跳过。
          } else if (block.type === 'text') {
            outputParts.push({ type: 'text', content: block.text || '' });
          } else if (block.type === 'tool_use') {
            outputParts.push({ type: 'tool_call', id: block.id, name: block.name, arguments: block.input });
            toolCalls.push({ id: block.id, name: block.name, input: block.input, preToolTs: endNanos });
          }
        }
      } else if (row.type === 'user' && isToolResult(row)) {
        const blocks = Array.isArray(row.message?.content) ? row.message.content : [];
        for (const block of blocks) {
          if (block.type === 'tool_result') {
            const resultText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            toolResultsForNextStep.push({ toolId: block.tool_use_id, result: resultText });
          }
        }
      }
    }

    // 无可区分 progress 导致起止相等时，用 assistant 时间作为结束。
    let responseEndNanos = endNanos;
    if (startNanos === endNanos && lastAssistantTs) {
      responseEndNanos = isoToUnixNanos(lastAssistantTs) || endNanos;
    }

    // finish reason 优先取末条 assistant 的权威 stop_reason，缺失时再推断。
    const lastStopReason = [...content].reverse()
      .find(r => r.type === 'assistant' && r.message?.stop_reason)?.message?.stop_reason;
    let finishReason;
    if (toolCalls.length > 0) {
      finishReason = 'tool_call';
    } else if (lastStopReason === 'max_tokens') {
      finishReason = 'max_tokens';
    } else if (lastStopReason === 'end_turn' || (i === boundaries.length - 1)) {
      finishReason = 'end_turn';
    } else if (lastStopReason) {
      finishReason = lastStopReason;
    } else {
      finishReason = 'stop';
    }

    if (outputParts.length > 0) {
      records.push({
        'event.id': crypto.randomUUID(),
        'event.name': 'llm.response',
        'gen_ai.step.id': stepId,
        'gen_ai.turn.id': turnId,
        'gen_ai.session.id': sessionId,
        'gen_ai.agent.type': agentType,
        'gen_ai.provider.name': providerName,
        'gen_ai.request.model': stepModel,
        'gen_ai.response.model': stepModel,
        'gen_ai.response.id': responseId,
        'gen_ai.response.finish_reasons': [finishReason],
        'user.id': userId,
        'gen_ai.output.messages': [{ role: 'assistant', parts: outputParts, finish_reason: finishReason }],
        'agent.source': 'qoder-transcript-hook',
        // 首条 assistant 的精确响应时间仅供 token-enricher 匹配；作为 Agent 私有字段不会进入
        // 最终 SLS/JSONL。CLI 没有 firstAssistantTs 时省略。
        'agent.qoder.match_ts': firstAssistantTs ? Date.parse(firstAssistantTs) : undefined,
        time_unix_nano: responseEndNanos,
        observed_time_unix_nano: observedTs,
      });
    }

    // 构造配对的 tool.call 和 tool.result。
    for (let ti = 0; ti < toolCalls.length; ti++) {
      const tc = toolCalls[ti];
      const tr = toolResultsForNextStep[ti];
      const toolCallTs = endNanos;

      records.push({
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.call',
        'gen_ai.step.id': stepId,
        'gen_ai.turn.id': turnId,
        'gen_ai.session.id': sessionId,
        'gen_ai.agent.type': agentType,
        'gen_ai.tool.name': tc.name,
        'gen_ai.tool.call.id': tc.id,
        'gen_ai.tool.call.exec.id': tc.id,
        'gen_ai.tool.call.arguments': typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
        'user.id': userId,
        'agent.source': 'qoder-transcript-hook',
        time_unix_nano: toolCallTs,
        observed_time_unix_nano: observedTs,
      });

      if (tr) {
        // 为该工具查找匹配的 PostToolUse 时间。
        const postToolTs = findPostToolUseTs(boundaries, i)
          || (BigInt(toolCallTs) + 1_000_000n).toString(); // 回退为 +1ms，确保工具 span 时长至少 1ms。
        const toolDurationMs = computeDurationMs(toolCallTs, postToolTs);
        records.push({
          'event.id': crypto.randomUUID(),
          'event.name': 'tool.result',
          'gen_ai.step.id': stepId,
          'gen_ai.turn.id': turnId,
          'gen_ai.session.id': sessionId,
          'gen_ai.agent.type': agentType,
          'gen_ai.tool.name': tc.name,
          'gen_ai.tool.call.id': tc.id,
          'gen_ai.tool.call.exec.id': tc.id,
          'gen_ai.tool.call.result': tr.result,
          'tool.result.status': 'success',
          ...(toolDurationMs > 0 ? { 'gen_ai.tool.call.duration': toolDurationMs } : {}),
          'user.id': userId,
          'agent.source': 'qoder-transcript-hook',
          time_unix_nano: postToolTs,
          observed_time_unix_nano: observedTs,
        });
      }
    }
  }

  return finalizeRecords(records, cwd);
}

function finalizeRecords(records, cwd) {
  for (const record of records) {
    if (cwd) record['agent.qoder.cwd'] = cwd;
    Object.assign(record, SPAN_ATTRIBUTES, RESOURCE_BASE_FIELD_PATCH, RESOURCE_ATTRIBUTE_FIELDS);
  }
  return records;
}

// --- 内容分配到边界 -------------------------------------------------------

function assignContentToBoundaries(boundaries, contentEvents) {
  const assigned = boundaries.map(() => []);

  for (const row of contentEvents) {
    // 用户 prompt 已在边界外作为 user-hook 处理，此处跳过。
    if (row.type === 'user' && !isToolResult(row)) continue;

    const rowTs = row.timestamp ? Date.parse(row.timestamp) : 0;
    if (!rowTs) continue;

    // 区间右端不含下个 startTs，边界间的 tool_result 因而归当前 step，不会丢失。
    let bestIdx = -1;
    for (let i = 0; i < boundaries.length; i++) {
      const startMs = Date.parse(boundaries[i].startTs) || 0;
      const nextStartMs = (i + 1 < boundaries.length)
        ? Date.parse(boundaries[i + 1].startTs) || Infinity
        : Infinity;
      if (rowTs >= startMs && rowTs < nextStartMs) {
        bestIdx = i;
        break;
      }
    }
    if (bestIdx >= 0) assigned[bestIdx].push(row);
  }

  return assigned;
}

// --- 辅助函数 -------------------------------------------------------------

/**
 * 把内容事件按真实 user prompt 切成 turn；tool result 不开启新 turn，后续工具结果和
 * assistant 内容一直归属当前 turn，直到下一个真实 prompt。
 */
function splitContentEventsIntoTurns(contentEvents) {
  const turns = [];
  let currentTurn = [];

  for (const row of contentEvents) {
    if (row.type === 'user' && !isToolResult(row)) {
      if (currentTurn.length > 0) {
        turns.push(currentTurn);
      }
      currentTurn = [row];
    } else {
      currentTurn.push(row);
    }
  }

  if (currentTurn.length > 0) {
    turns.push(currentTurn);
  }

  return turns;
}

function findPostToolUseTs(boundaries, currentIdx) {
  if (currentIdx + 1 < boundaries.length) {
    return isoToUnixNanos(boundaries[currentIdx + 1].startTs);
  }
  return null;
}

function isToolResult(row) {
  const content = row.message?.content;
  return Array.isArray(content) && content.length > 0 && content[0].type === 'tool_result';
}

function extractUserText(row) {
  const content = row.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text') return block.text || '';
      if (typeof block === 'string') return block;
    }
  }
  return '';
}

function inferVariant(row, sourceAgentId) {
  if (sourceAgentId === 'qoder-cn') return 'qoder-cn';
  if (!row) return sourceAgentId === 'qoder' ? 'qoder' : 'qoder-cli';
  if (row.entrypoint === 'cli' || row.promptId || row.permissionMode || row.userType) {
    return 'qoder-cli';
  }
  return 'qoder';
}

function resolveUserId(row, runtimeConfig) {
  if (runtimeConfig?.userId) return runtimeConfig.userId;
  if (row?.userId) return String(row.userId);
  return '';
}

// --- 旧版回退（没有 progress） -------------------------------------------
// transcript 同时没有 progress 和可分组 assistant 时使用。它不合成 llm.request、也不合并
// 多 part，因此 LLM 可能成为 0ms 孤立 response；token 可由 enricher 补充，时间仍近似。

function buildLegacyEvents(contentEvents, turnId, sessionId, agentId, runtimeConfig, existingRecords, observedTs) {
  // 无 progress 时使用旧的逐行归一化。
  for (const row of contentEvents) {
    const record = buildQoderHookRecord(row, { agentId, runtimeConfig, turnId });
    if (record) existingRecords.push(record);
  }

  // 旧逻辑按时间接近度分配 step.id。
  let stepCounter = 0;
  let lastResponseTs = null;
  for (const record of existingRecords) {
    const eventName = record['event.name'];
    const rawType = record['agent.qoder.raw_type'];
    if (rawType === 'user') continue;
    if (eventName === 'llm.response') {
      const responseTs = record['time_unix_nano'] || '';
      const tsDiff = lastResponseTs === null ? Infinity : Math.abs(Number(responseTs) - Number(lastResponseTs));
      if (tsDiff > 100_000_000) stepCounter++;
      lastResponseTs = responseTs;
    }
    if (stepCounter === 0) stepCounter = 1;
    record['gen_ai.step.id'] = `${turnId}:s${stepCounter}`;
  }

  return existingRecords;
}

// --- 脚本入口 -------------------------------------------------------------

function isDirectExec() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const here = fileURLToPath(import.meta.url);
  if (path.resolve(argv1) === here) return true;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(here);
  } catch {
    return false;
  }
}

if (isDirectExec()) {
  main().catch((e) => {
    try {
      const agentId = process.argv.find((_, i) => process.argv[i - 1] === '--agent-id') || 'unknown';
      const file = getErrorLogFile(agentId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
      fs.appendFileSync(file, `[${ts}] ${e.message}\n`, 'utf-8');
    } catch { /* 忽略兜底日志写入失败。 */ }
  });
}
