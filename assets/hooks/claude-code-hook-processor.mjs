#!/usr/bin/env node
// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Claude Code Hook 的短生命周期处理进程，也是 Claude 数据链路的“写入侧”。
 *
 * `agents.d/claude-code.json` 声明了 `Stop`、`SubagentStart`、`SubagentStop` 三类 Hook。
 * `HookStrategy` 把相应命令安装到 `~/.claude/settings.json` 后，Claude Code 每次触发 Hook 都会
 * 新建一个 wrapper/Node.js 进程，并通过 stdin 传入本次 Hook JSON。Unix wrapper 的调用形式为：
 *
 *   $ node claude-code-hook-processor.mjs <stop|subagent-start|subagent-stop>
 *
 * 本文件不是常驻服务，也不是 `BaseInput`：它不创建 Node.js `EventEmitter`，不会触发
 * `entries`，更不会直接调用 Flusher。完整的跨进程链路是：
 *
 *   Claude Code 触发 Stop
 *     -> wrapper 原样转交 stdin 和子命令
 *     -> `cmdStop()` 增量解析 Claude transcript
 *     -> 同步追加 `logs/claude-code/claude-code-YYYY-MM-DD.jsonl`
 *     -> 常驻 Collector 的 `ClaudeCodeLogInput` 在下一次轮询中读取新增 JSONL
 *     -> `BaseInput.runCycleOnce()` 对非空结果触发 `entries`
 *     -> `InputManager` 处理并调用 Flusher
 *
 * `Stop` 的主要写入步骤是：等待 transcript 文件稳定、从 `transcript_offset` 增量解析、
 * 首次接入时只导出最后一个 turn、构造并按时间排序标准事件、应用内容策略、同步追加 JSONL，
 * 最后才提交新的 offset。这样写文件失败时 checkpoint 不会提前前进，下次 Stop 仍可重试。
 *
 * `SubagentStart`/`SubagentStop` 当前只把元数据写进 session state 的 `events` 数组；
 * `exportSession()` 尚未读取该数组，`cmdStop()` 成功后还会将它清空。因此这些子 Agent 状态
 * 目前不会生成 JSONL 事件，这是预留设计而不是已经完成的父子 trace 合并能力。
 *
 * v2 以 transcript 为消息、时间戳和工具归属的事实来源：工具通过 `tool_use_id` 归到声明它的
 * LLM step，不再通过 Hook 事件时间线做对齐。输出字段遵循 `ai_event_schema.md` 的 `gen_ai.*`
 * 命名，`finish_reasons` 按规范输出为字符串数组。异常只写诊断并返回 `{}`，避免采集失败阻塞
 * Claude Code 自身的 Stop 流程。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { readStdinJson, isCursorCaller } from './shared/stdin-reader.mjs';
import {
  INITIAL_HASH,
  computeHash,
  shouldLogFullMessages,
  generateTraceId,
  generateSpanId,
  writeJsonlRecords,
} from './shared/event-emitter.mjs';
import { logHookError } from './shared/error-logger.mjs';
import { recordUpstreamContextOnce } from './shared/upstream-context.mjs';
import {
  sanitizeObject,
  toJsonValue,
  loadHookRuntimeConfig,
  resolveUserId,
  applyHookContentPolicy,
} from './agent-event-normalizer.mjs';

import {
  loadState,
  saveState,
  readAndDeleteChildState,
} from './claude-code/state.mjs';
import {
  parseClaudeTranscript,
} from './claude-code/transcript-parser.mjs';
import {
  convertInputMessages,
  convertOutputMessages,
  mapStopReason,
} from './claude-code/message-converter.mjs';
import {
  agentBaseFieldPatch,
  collectResourceAttributesFromEnv,
  parseSpanAttributesFromEnv,
} from './shared/resource-context.mjs';

const AGENT_ID = 'claude-code';
const RESOURCE_ATTRIBUTES = collectResourceAttributesFromEnv(process.env, { agentId: AGENT_ID });
const RESOURCE_BASE_FIELD_PATCH = agentBaseFieldPatch(RESOURCE_ATTRIBUTES);
const RESOURCE_ATTRIBUTE_FIELDS = Object.keys(RESOURCE_ATTRIBUTES).length > 0
  ? { resourceAttributes: RESOURCE_ATTRIBUTES }
  : {};
// 调用方提供的 span 属性（如 multica.*）铺到记录顶层，供 trace flusher 透传。
const SPAN_ATTRIBUTES = parseSpanAttributesFromEnv(process.env, { agentId: AGENT_ID });

// ─── 通用工具 ───

function nowSec() {
  return Date.now() / 1000;
}

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

function defaultLogDir() {
  return path.join(pilotDataDir(), 'logs', AGENT_ID);
}

// ─── 合并 BUN_OPTIONS preload 截获数据 ───

const INTERCEPT_STALE_MS = 60 * 60 * 1000; // 截获文件超过 1 小时即视为过期。

function interceptSessionDir(sessionId) {
  return path.join(pilotDataDir(), 'intercept', AGENT_ID, sessionId);
}

/**
 * 读取 fetch preload 为每次 LLM 调用落下的截获记录。
 * @param {string} sessionId 当前 Claude 会话 ID。
 * @returns {Map<string, object>} 以 response_id 为键；额外保存 `_file` 供成功合并后删除。
 */
function loadInterceptForSession(sessionId) {
  const out = new Map();
  const dir = interceptSessionDir(sessionId);
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(dir, name);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (_) {
      // preload 中途退出留下损坏文件时暂不删除，由陈旧文件清理器处理，也不阻塞其他记录合并。
      continue;
    }
    if (raw && typeof raw.response_id === 'string' && raw.response_id.length > 0) {
      out.set(raw.response_id, { ...raw, _file: filePath });
    }
  }
  return out;
}

/**
 * 删除已经成功并入输出事件的 response_id 文件。
 * 未出现在本轮 transcript 中的文件可能属于未来 turn，先保留，最终由陈旧文件清理器回收。
 */
function reapInterceptFiles(intercept, mergedResponseIds) {
  for (const rid of mergedResponseIds) {
    const data = intercept.get(rid);
    if (!data?._file) continue;
    try { fs.unlinkSync(data._file); } catch (_) {}
  }
}

/**
 * 在 `exportSession()` 结束时顺带删除修改时间超过一小时的孤立截获文件。
 * 这些文件的 response_id 始终未进入 transcript；清空后还会尝试删除空会话目录。
 */
function reapStaleIntercept(sessionId) {
  const dir = interceptSessionDir(sessionId);
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }
  const now = Date.now();
  for (const name of entries) {
    const f = path.join(dir, name);
    try {
      const st = fs.statSync(f);
      if (now - st.mtimeMs > INTERCEPT_STALE_MS) fs.unlinkSync(f);
    } catch (_) {}
  }
  try { fs.rmdirSync(dir); } catch (_) {}
}

/** 同步消费 Hook stdin；JSON 无效时记录错误并返回空对象，不把异常传播给 Claude Code。 */
function tryReadStdin() {
  try {
    return readStdinJson();
  } catch (err) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'stdin_parse',
      errorType: 'parse_failed',
      errorMessage: err?.message || String(err),
    });
    return {};
  }
}

/** session_id 是 state/transcript/intercept 的隔离键；缺失时记录后跳过，避免污染共享 unknown 会话。 */
function requireSessionId(event, stage = 'cmd') {
  const sid = event && event.session_id;
  if (typeof sid === 'string' && sid.length > 0) return sid;
  logHookError({
    agentId: AGENT_ID,
    stage,
    errorType: 'missing_session_id',
    errorMessage: 'hook stdin lacks session_id; skipping',
  });
  return null;
}

/**
 * ISO8601 字符串转为 time_unix_nano 字符串。
 */
function isoToUnixNanos(isoStr) {
  if (!isoStr) return '0';
  const ms = new Date(isoStr).getTime();
  if (isNaN(ms)) return '0';
  return String(ms) + '000000';
}

// ─── 子命令处理器 ───

/**
 * 处理 Claude Code 的 `SubagentStart` Hook。
 *
 * 调用位置：模块末尾的 `DISPATCH['subagent-start']`。输入不是函数参数，而是 Claude Code 写入
 * stdin 的 Hook JSON。函数会记录父 session 的 transcript/cwd（仅在 state 尚无值时补齐），
 * 再把子 Agent 标识与本地接收时间追加到 `state.events` 并同步保存。
 *
 * 注意：这里不解析 transcript、不写采集 JSONL，也不触发 Collector 的 `entries`。
 * TODO：`exportSession()` 当前没有消费 `state.events`；这些数据仅为未来父子 trace 合并预留，
 * 而且主 session 的 `cmdStop()` 成功后会清空它们。
 */
function cmdSubagentStart() {
  // wrapper 不解析 stdin；真正的 JSON 解码在这里同步完成，失败时降级为空对象。
  const event = tryReadStdin();
  // Claude 与 Cursor 的 Hook 形态可能交叉；检测到 Cursor payload 时避免重复采集。
  if (isCursorCaller(event)) return;
  // session_id 是状态文件隔离键；缺失时不能安全归档到任意公共 state。
  const sessionId = requireSessionId(event, 'cmd');
  if (!sessionId) return;

  // loadState 在没有旧文件时返回带默认字段的新 state。
  const state = loadState(sessionId);
  // transcript_path/cwd 只做缺省补齐，避免子 Agent Hook 覆盖主会话已经确认的上下文。
  if (!state.transcript_path && event.transcript_path) {
    state.transcript_path = event.transcript_path;
  }
  if (!state.cwd && event.cwd && typeof event.cwd === 'string') {
    state.cwd = event.cwd;
  }
  // 兼容没有 events 字段的旧 state，再追加一条尚未参与导出的预留事件。
  state.events = state.events || [];
  state.events.push({
    type: 'subagent_start',
    timestamp: nowSec(),
    subagent_session_id: event.subagent_session_id || '',
    agent_id: event.agent_id || '',
    agent_type: event.agent_type || '',
  });
  // state 写盘供同一 session 的后续 Hook 进程读取；本进程随后即可退出。
  saveState(sessionId, state);
}

/**
 * 处理 Claude Code 的 `SubagentStop` Hook。
 *
 * 除了保存停止原因和 token 统计，还会尝试读取并删除子 session 自己的 state，把其中的 events
 * 快照挂到父 session 的 `_child_state`。读取删除只在子 ID 有效且不同于父 ID 时执行，避免误删
 * 当前父状态。与 `cmdSubagentStart()` 一样，这些数据目前仅落 state，不会被 `exportSession()`
 * 转成 JSONL，也不会触发 `entries`。
 */
function cmdSubagentStop() {
  // 每个 Hook 进程只消费一次 stdin；JSON 错误按 fail-open 处理。
  const event = tryReadStdin();
  if (isCursorCaller(event)) return;
  const sessionId = requireSessionId(event, 'cmd');
  if (!sessionId) return;

  const state = loadState(sessionId);
  if (!state.transcript_path && event.transcript_path) {
    state.transcript_path = event.transcript_path;
  }
  if (!state.cwd && event.cwd && typeof event.cwd === 'string') {
    state.cwd = event.cwd;
  }

  // 缺失 child session ID 时使用 unknown，但不会拿 unknown 去删除任何 state 文件。
  const childSid = event.subagent_session_id || 'unknown';
  let childStateSnapshot = null;
  if (childSid && childSid !== 'unknown' && childSid !== sessionId) {
    // 读取成功后删除子 state，避免同一快照被未来的 SubagentStop 重复合并。
    childStateSnapshot = readAndDeleteChildState(childSid);
  }

  state.events = state.events || [];
  const evData = {
    type: 'subagent_stop',
    timestamp: nowSec(),
    subagent_session_id: childSid,
    stop_reason: event.stop_reason || 'end_turn',
    input_tokens: event.usage?.input_tokens || event.input_tokens || 0,
    output_tokens: event.usage?.output_tokens || event.output_tokens || 0,
    cache_read_input_tokens: event.usage?.cache_read_input_tokens || event.cache_read_input_tokens || 0,
    cache_creation_input_tokens: event.usage?.cache_creation_input_tokens || event.cache_creation_input_tokens || 0,
  };
  if (childStateSnapshot && Array.isArray(childStateSnapshot.events) && childStateSnapshot.events.length > 0) {
    // 当前只保存嵌套快照；尚没有代码把它展开为父 trace 下的标准事件。
    evData._child_state = childStateSnapshot;
  }
  state.events.push(evData);
  saveState(sessionId, state);
}

/**
 * 处理 Claude Code 的 `Stop` Hook，是 Claude 写入侧真正产生采集记录的入口。
 *
 * 调用链：`DISPATCH['stop']` -> `cmdStop()` -> `exportSession()` ->
 * `parseClaudeTranscript()`/`buildTurnRecords()` -> `writeJsonlRecords()`。
 *
 * Hook payload 提供 session_id、transcript_path、cwd、stop_reason 等控制信息；消息正文、LLM 调用、
 * tool_use/tool_result 与它们的时间戳仍从 transcript 读取。函数先保存基本状态和 stop_time，确保
 * 后续 Hook 进程可以恢复；然后等待异步导出完成。
 *
 * `exportSession()` 只把解析器给出的新位置放进内存字段 `_next_transcript_offset`。只有导出流程
 * 没有抛异常（包括 JSONL 已成功 append）时，本函数才把它提交为持久化 `transcript_offset`，
 * 并清空 stop_time/events。若解析、内容处理或文件写入抛错，catch 只记录诊断，旧 offset 保持
 * 不变，下次 Stop 可以从同一位置重试。
 *
 * @returns {Promise<void>} 等待本次增量导出或错误记录结束；不会返回采集 entries。
 */
async function cmdStop() {
  // wrapper 把 Claude Code 的 stdin 直接转给 processor；这里同步读取并解析一次。
  const event = tryReadStdin();
  // 若 payload 实际来自 Cursor，则交给 Cursor 自己的链路处理，避免写入 Claude 日志。
  if (isCursorCaller(event)) return;
  const sessionId = requireSessionId(event, 'cmd');
  if (!sessionId) return;

  // 首个 turn 尝试从 Claude 进程继承的 TRACEPARENT 建立 session 级上游关联；函数内部 fail-open。
  recordUpstreamContextOnce({ agentId: AGENT_ID, sessionId, dataDir: pilotDataDir() });

  // state 跨 Hook 进程保存 transcript_offset；各次 Stop 依靠它实现增量而不是重读整个文件。
  const state = loadState(sessionId);
  // transcript_path 一旦建立就沿用；cwd 则接受最新 Hook 值，反映当前 turn 的工作目录。
  if (!state.transcript_path && event.transcript_path) {
    state.transcript_path = event.transcript_path;
  }
  if (event.cwd && typeof event.cwd === 'string') {
    state.cwd = event.cwd;
  }
  // 先保存“正在处理 Stop”的恢复标记；export 成功后再清掉。
  state.stop_time = nowSec();
  saveState(sessionId, state);

  try {
    // await 保证 JSONL 写入和清理完成前不会提交 offset，也不会让短生命周期进程提前退出。
    await exportSession(state, event.stop_reason || 'end_turn');
    if (typeof state._next_transcript_offset === 'number') {
      // 两阶段 checkpoint：只有 exportSession 正常返回，临时游标才转成下轮读取起点。
      state.transcript_offset = state._next_transcript_offset;
      delete state._next_transcript_offset;
    }
    // 当前 exportSession 不使用子 Agent events；成功 Stop 会丢弃这些预留状态。
    state.events = [];
    state.stop_time = null;
    saveState(sessionId, state);
  } catch (err) {
    // 不重新抛出，保证采集故障不会改变 Claude Code 的 Stop 结果；旧 offset 仍可供下次重试。
    logHookError({
      agentId: AGENT_ID,
      stage: 'cmd_stop',
      errorType: 'export_failed',
      errorMessage: err?.message || String(err),
    });
  }
}

// ─── transcript 稳定性等待 ───

/**
 * 等待 Claude transcript 的异步 flush 暂时稳定。
 *
 * Claude Code 可能先触发 Stop Hook，随后才把最后几行写入 transcript。函数最多检查 10 次，
 * 每次间隔 150ms；文件大小必须先大于旧 `transcript_offset`，并连续两次与上次相同才提前返回。
 * 文件暂时不存在时立即结束，由后续解析/下一次 Stop 负责恢复；达到上限也直接返回，避免 Hook
 * 长时间阻塞 Claude Code。这里判断的是“大小短暂稳定”，不提供写入锁或永久完成保证。
 *
 * @param {string} transcriptPath Claude Code 在 Hook payload 中给出的 transcript 文件路径。
 * @param {number} minSize 已提交的 byte offset；文件尚未增长到该位置之后时继续等待。
 * @returns {Promise<void>} 等待结束后无数据返回。
 */
async function waitForTranscriptStable(transcriptPath, minSize = 0) {
  // prevSize=-1 确保第一次成功 stat 只建立比较基线，不会立刻算作稳定。
  let prevSize = -1;
  let stableCount = 0;
  // 总等待量受循环次数限制；setTimeout 让出事件循环，不做 CPU 忙等。
  for (let i = 0; i < 10; i++) {
    let size = 0;
    try {
      size = fs.statSync(transcriptPath).size;
    } catch {
      // 文件缺失或无权限时不在 Hook 中抛错；exportSession 后续按实际解析结果处理。
      break;
    }
    if (size <= minSize) {
      // transcript 尚无新字节，给 Claude Code 的落盘动作一个短暂窗口。
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }
    if (size === prevSize) {
      // 两次连续“与上一轮相同”意味着总共观察到了三次相同大小。
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

/**
 * 把主 transcript 自上次 offset 以来的新增内容导出为标准 Hook JSONL。
 *
 * 执行顺序：
 * 1. 加载 Hook 运行时配置并检查 transcript_path；
 * 2. 等待文件稳定，从已提交 `transcript_offset` 开始增量解析，空结果最多重试 5 次；
 * 3. 暂存解析器返回的 nextOffset，首次接入旧会话时只选择最后一个 turn 输出；
 * 4. 按 turn 调用 `buildTurnRecords()`，同时按 response_id 合并 fetch preload 数据；
 * 5. 对全部记录执行对象清理和内容策略，再同步追加到按日 JSONL；
 * 6. 写入成功后才删除已消费 intercept 文件并清理过期孤儿。
 *
 * 本函数修改传入 state 的 `_next_transcript_offset` 和 `turn_count`，但不调用 `saveState()`；
 * 外层 `cmdStop()` 是 checkpoint 的唯一提交者。这里写出的只是 Collector 的输入文件，真正的
 * `entries` 由另一个常驻进程中的 `ClaudeCodeLogInput` 后续轮询产生。
 *
 * @param {object} state 当前 session 的可变状态对象，包含 transcript_path/transcript_offset 等。
 * @param {string} stopReason 当前 Hook 给出的停止原因，只应用于本次最后一个 turn。
 * @returns {Promise<void>} JSONL 写入与清理完成后返回。
 * @throws 记录构造、内容处理或 JSONL 写入异常会向 `cmdStop()` 传播，使 offset 不被提交；
 *   transcript parser 自身的异常在本函数内记录并提前返回，同样不会推进 offset。
 */
async function exportSession(state, stopReason) {
  // 内容保留策略、用户标识等配置在每个短生命周期 Hook 进程中重新读取。
  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  const sessionId = state.session_id || 'unknown';

  if (!state.transcript_path) {
    // 没有路径时无法采集；记录诊断后正常返回，因此本轮不会产生 JSONL。
    logHookError({
      agentId: AGENT_ID,
      stage: 'export',
      errorType: 'missing_transcript_path',
      errorMessage: 'no transcript_path in state; cannot export',
    });
    return;
  }

  const transcriptPath = state.transcript_path;
  const baseOffset = state.transcript_offset || 0;

  // 旧 offset 同时是增量解析起点和“文件是否已经出现新内容”的最小尺寸。
  await waitForTranscriptStable(transcriptPath, baseOffset);

  // transcript 是唯一事件事实来源；state.events 中的 SubagentStart/Stop 当前不参与解析。
  let parseResult;
  // Stop 与 transcript flush 仍可能存在竞态；没有完整 turn 时短暂重试，而不是立即提交空结果。
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      parseResult = parseClaudeTranscript(transcriptPath, baseOffset);
      if (parseResult.turns.length > 0) break;
    } catch (err) {
      // 解析器明确抛错时停止重试并保留旧 checkpoint；错误由诊断日志记录。
      logHookError({
        agentId: AGENT_ID,
        stage: 'transcript_parse',
        errorType: 'parse_failed',
        errorMessage: err?.message || String(err),
      });
      break;
    }
    // Promise 定时器让 Node.js 事件循环等待，不阻塞 CPU；之后再次确认文件稳定。
    await new Promise((r) => setTimeout(r, 200));
    await waitForTranscriptStable(transcriptPath, baseOffset);
  }

  // 解析始终失败时没有可提交位置；直接回到 cmdStop 的 fail-open 路径。
  if (!parseResult) return;
  // 这里只暂存 nextOffset。即使 turns 为空也要推进，以跳过已确认但不构成事件的 transcript 行。
  state._next_transcript_offset = parseResult.nextOffset;
  if (parseResult.turns.length === 0) return;

  // allRecords 先在内存汇总，确保内容策略应用完后再做一次文件 append。
  const userId = resolveUserId({}, runtimeConfig);
  const allRecords = [];
  // hash 链跨同一批次中的 turn/LLM 调用延续，用于 messages_delta 的完整性判断。
  let logHash = INITIAL_HASH;

  const baseTurnCount = state.turn_count || 0;

  // 首次运行防护：新安装/重装后 state 被清空(offset=0, 无 turn_count)时，transcript 可能已有历史。
  // 只上报最后一个（当前）turn，但仍在下方把 offset/turn_count 推进过全部历史，避免下次重放。
  const isFirstRun = !state.turn_count && baseOffset === 0;
  let turnsToExport = parseResult.turns;
  if (isFirstRun && parseResult.turns.length > 1) {
    turnsToExport = parseResult.turns.slice(-1);
  }

  const cwd = state.cwd || undefined;

  // 每个 session 只读取一次截获目录；以 response_id（即 Anthropic message_id）查找。
  // preload 未产出文件时得到空 Map，后续合并自然无操作。
  const intercept = loadInterceptForSession(sessionId);
  const mergedResponseIds = new Set();

  // 每个 turn 单独生成 trace；循环保持 transcript 顺序，并把上一 turn 的消息 hash 传给下一轮。
  for (let i = 0; i < turnsToExport.length; i++) {
    const turn = turnsToExport[i];
    const isLast = i === turnsToExport.length - 1;
    // 一次 Stop 若补读多个 turn，只有最后一个使用真实 stopReason，前面的按正常 end_turn 收束。
    const turnStopReason = isLast ? stopReason : 'end_turn';
    const { records, hash, mergedResponseIds: turnMerged } = buildTurnRecords(
      turn,
      baseTurnCount + i,
      sessionId,
      logHash,
      userId,
      turnStopReason,
      cwd,
      intercept,
    );
    // buildTurnRecords 只做内存构造；此处尚未写文件，也尚未触发 Collector。
    allRecords.push(...records);
    logHash = hash;
    if (turnMerged) {
      for (const rid of turnMerged) mergedResponseIds.add(rid);
    }
  }

  // turn_count 计入全部 turns（含首次跳过的历史），确保未来 turn ID 连续且不重复上报。
  state.turn_count = baseTurnCount + parseResult.turns.length;

  // sanitizeObject 删除无效值，内容策略再按配置保留/遮蔽正文；顺序不可颠倒。
  const cleaned = allRecords.map((r) => applyHookContentPolicy(sanitizeObject(r) || r, runtimeConfig));
  // 空数组会被 writer 忽略；非空数组同步追加完整 JSONL 行。这里仍不会触发 `entries` 事件。
  writeJsonlRecords(defaultLogDir(), AGENT_ID, cleaned);

  // JSONL 落盘后删除已合并文件并清理旧孤儿；清理失败不影响宿主。
  reapInterceptFiles(intercept, mergedResponseIds);
  reapStaleIntercept(sessionId);
}

// ─── buildTurnRecords — 单 turn 的 JSONL 记录构造 (v2: tool_use_id 归属) ───

/**
 * 把一个 Claude turn 展开成有序的 user、LLM 和 TOOL 标准记录。
 *
 * 第一阶段为每个 LLM 调用建立独立 step，同时记录其声明的 `tool_use_id -> step` 映射；第二阶段
 * 再生成 tool.call/tool.result，并利用该映射归回声明工具的 LLM step。这样即使多个工具并行、
 * result 出现在后续消息中，也不会错误归到“最近一个” LLM。最后统一按 transcript 时间戳排序，
 * 保证下游在看到 turn 结束的 llm.response 前先看到时间上更早的工具事件。
 *
 * `intercept` 是 fetch preload 以 Anthropic message_id/response_id 为键记录的补充数据，只提供
 * system instructions 和 TTFT 等 transcript 不完整的字段；transcript 仍决定消息、时间和归属。
 * 本函数是纯内存转换，不读写文件、不修改 state，也不触发 `entries`。
 *
 * @param {object} turn `parseClaudeTranscript()` 生成的单个 turn。
 * @param {number} turnIndex session 内从零开始的稳定 turn 序号。
 * @param {string} sessionId Claude session ID。
 * @param {string} prevHash 上一批消息的链式 hash 起点。
 * @param {string} userId 运行时配置解析出的用户标识。
 * @param {string} turnStopReason 当前 turn 的结束原因。
 * @param {string|undefined} cwd Hook 记录的工作目录。
 * @param {Map<string, object>} intercept 本 session 的 preload 截获数据。
 * @returns {{records: object[], hash: string, mergedResponseIds: Set<string>}} 有序记录、最新 hash
 *   以及确认并入记录的 response ID；后者供写盘成功后清理截获文件。
 */
function buildTurnRecords(turn, turnIndex, sessionId, prevHash, userId, turnStopReason, cwd, intercept) {
  const records = [];
  const turnId = `${sessionId}:t${turnIndex + 1}`;
  let stepRound = 0;
  let runningHash = prevHash;
  let prevInputMsgs = [];
  // 记录实际合并成功的 response_id；只有 JSONL 写完后 exportSession 才删除对应文件。
  const mergedResponseIds = new Set();

  const traceId = generateTraceId();
  const entrySpanId = generateSpanId();
  const agentSpanId = generateSpanId();

  const baseFields = {
    trace_id: traceId,
    'gen_ai.session.id': sessionId,
    'gen_ai.turn.id': turnId,
    'gen_ai.agent.type': AGENT_ID,
    'gen_ai.agent.id': sessionId,
    ...RESOURCE_BASE_FIELD_PATCH,
    'user.id': userId,
    ...(cwd ? { 'agent.claude-code.cwd': cwd } : {}),
    // 先展开调用方属性，使后面的结构/管道字段（如 resourceAttributes）拥有更高覆盖优先级。
    ...SPAN_ATTRIBUTES,
    ...RESOURCE_ATTRIBUTE_FIELDS,
  };

  // 用户输入: 做法 A (EVENT_LOG_TO_TRACE_SPEC §5.1, 0.1.0-beta.3+)
  // event.name="other" + messages_delta → 转换器归并到 ENTRY/AGENT 的 input.messages
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

  // 阶段 1：为每个 llm_call 创建 step 并生成 LLM 事件。
  const toolIdToStep = new Map(); // tool_use_id → { stepId, stepSpanId }
  const llmCalls = turn.llmCalls || [];

  for (const ev of llmCalls) {
    stepRound++;
    const currentStepId = `${turnId}:s${stepRound}`;
    const currentStepSpanId = generateSpanId();
    const llmSpanId = generateSpanId();
    const responseId = ev.message_id || `${currentStepId}:r`;

    // 注册该 LLM 声明的所有 tool_use_id → 当前 step
    for (const toolId of (ev.declaredToolIds || [])) {
      toolIdToStep.set(toolId, { stepId: currentStepId, stepSpanId: currentStepSpanId });
    }

    // 计算输入消息增量与全量 hash。
    const inputMsgs = convertInputMessages(ev.input_messages, ev.protocol || 'anthropic');
    let currentFullHash;
    let delta;
    let logFull;
    if (ev._input_is_delta) {
      delta = inputMsgs;
      currentFullHash = computeHash(runningHash, delta);
      logFull = false;
    } else {
      currentFullHash = computeHash(INITIAL_HASH, inputMsgs);
      delta = inputMsgs.slice(prevInputMsgs.length);
      logFull = shouldLogFullMessages(runningHash, delta, currentFullHash);
    }

    // 每个 LLM 调用查一次 preload 数据；ev.message_id 对应 SSE message_start.message.id。
    const interceptData = intercept && ev.message_id
      ? intercept.get(ev.message_id)
      : undefined;
    if (interceptData) mergedResponseIds.add(ev.message_id);

    // 构造 llm.request。
    const reqRecord = {
      time_unix_nano: isoToUnixNanos(ev.request_start_time),
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.request',
      ...baseFields,
      span_id: llmSpanId,
      parent_span_id: currentStepSpanId,
      'gen_ai.step.id': currentStepId,
      'gen_ai.response.id': responseId,
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': ev.model || 'unknown',
      'gen_ai.input.messages_hash': currentFullHash,
      'gen_ai.input.messages_delta': delta,
    };
    if (logFull) {
      reqRecord['gen_ai.input.messages'] = inputMsgs;
    }
    if (interceptData && Array.isArray(interceptData.system_instructions)
        && interceptData.system_instructions.length > 0) {
      reqRecord['gen_ai.system_instructions'] = interceptData.system_instructions;
    }
    records.push(reqRecord);

    // token 全量公式: input = api + cacheRead + cacheCreation
    const apiInputTokens = ev.input_tokens || 0;
    const cacheRead = ev.cache_read_input_tokens || 0;
    const cacheCreation = ev.cache_creation_input_tokens || 0;
    const inputTokens = apiInputTokens + cacheRead + cacheCreation;
    const outputTokens = ev.output_tokens || 0;
    const totalTokens = inputTokens + outputTokens;

    // 构造 llm.response。
    const respRecord = {
      time_unix_nano: isoToUnixNanos(ev.timestamp),
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.response',
      ...baseFields,
      span_id: llmSpanId,
      parent_span_id: currentStepSpanId,
      'gen_ai.step.id': currentStepId,
      'gen_ai.response.id': responseId,
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': ev.model || 'unknown',
      'gen_ai.response.model': ev.model || 'unknown',
      'gen_ai.response.finish_reasons': [mapStopReason(ev.stop_reason || 'stop')],
      'gen_ai.usage.input_tokens': inputTokens,
      'gen_ai.usage.output_tokens': outputTokens,
      'gen_ai.usage.cache_read.input_tokens': cacheRead,
      'gen_ai.usage.cache_creation.input_tokens': cacheCreation,
      'gen_ai.usage.total_tokens': totalTokens,
      'gen_ai.output.messages': convertOutputMessages(ev.output_content, ev.stop_reason),
    };
    if (interceptData && typeof interceptData.ttft_ns === 'number'
        && Number.isFinite(interceptData.ttft_ns) && interceptData.ttft_ns >= 0) {
      respRecord['gen_ai.response.time_to_first_token'] = interceptData.ttft_ns;
    }
    records.push(respRecord);

    runningHash = currentFullHash;
    prevInputMsgs = ev._input_is_delta ? [] : inputMsgs;
  }

  // 阶段 2：为每个 tool 生成 tool.call 和 tool.result，并归入声明该工具的 LLM step。
  for (const ev of llmCalls) {
    for (const toolId of (ev.declaredToolIds || [])) {
      const owner = toolIdToStep.get(toolId);
      if (!owner) continue;

      const timestamps = ev.toolDetails?.get(toolId);
      if (!timestamps) continue;

      // 从 output_content 找到该 tool_use block 的 name + input
      const toolBlock = ev.output_content.find(
        (b) => b.type === 'tool_use' && b.id === toolId,
      );
      if (!toolBlock) continue;

      const toolName = toolBlock.name || 'unknown';
      if (toolName === 'Agent' || toolName === 'agent') continue;

      const toolSpanId = generateSpanId();

      // 构造 tool.call。
      records.push({
        time_unix_nano: isoToUnixNanos(timestamps.call),
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.call',
        ...baseFields,
        span_id: toolSpanId,
        parent_span_id: owner.stepSpanId,
        'gen_ai.step.id': owner.stepId,
        'gen_ai.tool.name': toolName,
        'gen_ai.tool.call.id': toolId,
        'gen_ai.tool.call.arguments': toJsonValue(toolBlock.input || {}),
      });

      // 仅在拥有结果时间戳时构造 tool.result。
      if (timestamps.result) {
        const resultRecord = {
          time_unix_nano: isoToUnixNanos(timestamps.result),
          'event.id': crypto.randomUUID(),
          'event.name': 'tool.result',
          ...baseFields,
          span_id: toolSpanId,
          parent_span_id: owner.stepSpanId,
          'gen_ai.step.id': owner.stepId,
          'gen_ai.tool.name': toolName,
          'gen_ai.tool.call.id': toolId,
          'gen_ai.tool.call.result': toJsonValue(timestamps.resultContent || ''),
          'tool.result.status': timestamps.isError ? 'error' : 'success',
        };
        if (timestamps.isError) {
          resultRecord['error.type'] = 'ToolError';
          resultRecord['error.message'] = typeof timestamps.resultContent === 'string'
            ? timestamps.resultContent.slice(0, 500)
            : 'tool execution failed';
        }
        records.push(resultRecord);
      }
    }
  }

  // 构造阶段按“全部 LLM、再全部 tool”组织代码，不等于输出顺序；这里恢复真实时间顺序。
  // OTLP flusher 在收到结束原因时会完成 turn buffer；若更早发生的 tool 被排在结束记录之后，
  // 它们可能落到已经关闭的 turn 外，因此排序是下游正确重建 trace 的必要条件。
  records.sort((a, b) => {
    const ta = BigInt(a.time_unix_nano || '0');
    const tb = BigInt(b.time_unix_nano || '0');
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });

  return { records, hash: runningHash, mergedResponseIds };
}

// ─── 子命令分派：wrapper 只传字符串，业务入口由这张只读映射选择 ───

const DISPATCH = {
  'stop': cmdStop,
  'subagent-start': cmdSubagentStart,
  'subagent-stop': cmdSubagentStop,
};

const sub = process.argv[2] || 'unknown';
const fn = DISPATCH[sub];
if (fn) {
  // 同步 handler 也包装成 Promise；这样 Stop 的异步等待和 Subagent 的同步保存共用一套收尾逻辑。
  Promise.resolve(fn()).catch((err) => {
    // 捕获 cmdStop 自身 catch 之外的遗漏异常，仍不把错误传播给 Claude Code。
    logHookError({
      agentId: AGENT_ID,
      stage: `dispatch_${sub}`,
      errorType: 'unhandled',
      errorMessage: err?.message || String(err),
    });
  }).finally(() => {
    // stdout 是 Hook 协议响应通道；固定空对象表示“不修改/阻止 Claude Code 的行为”。
    process.stdout.write('{}\n');
  });
} else {
  // 未注册或缺失子命令保持兼容性：不读取/处理 payload，直接成功返回空响应。
  process.stdout.write('{}\n');
}
