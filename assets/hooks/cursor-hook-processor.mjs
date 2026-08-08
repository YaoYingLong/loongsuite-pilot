#!/usr/bin/env node
/**
 * LoongSuite Pilot 的 Cursor Hook 有状态处理器。
 *
 * Shell/PowerShell wrapper 每收到一个 Cursor Hook 事件就启动一次本 Node 子进程。普通事件先
 * 转成内部结构并追加到共享 event journal；父会话 `stop` 到来时读取 journal，把同一 turn
 * 组装成带 step、子 Agent 嵌套和 trace ID 的标准记录，再写 history JSONL。Windows 优先
 * 用原生 UTF-8 transcript 提供文本以绕过 GB18030 损坏，其他平台或解析失败时走 Hook 事件
 * assembler。Cursor CLI 的 stop 可能早于 afterAgentResponse，因此支持延迟补偿组装。
 *
 * `logs/cursor/history/*.jsonl` 是 `CursorHookInput` 唯一正式数据源；原始 payload 仅在
 * `LOONGSUITE_CURSOR_RAW_TRACE=1` 时写入诊断目录。stdout 始终输出 `{}`，所有采集错误
 * fail-open。主入口最后的 `import.meta.url` 判断使测试可以导入导出函数而不自动消费 stdin。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  applyHookContentPolicy,
  hashJson,
  loadHookRuntimeConfig,
  sanitizeObject,
} from './agent-event-normalizer.mjs';
import { toInternalEvent } from './cursor/source-event.mjs';
import { appendEvent, readAllEvents, rewriteJournal } from './cursor/event-journal.mjs';
import { assembleTurn } from './cursor/react-assembler.mjs';
import { buildCursorRecordsFromTranscript } from './cursor/transcript-assembler.mjs';

function resolveDataDir() {
  const configured = process.env.LOONGSUITE_PILOT_DATA_DIR;
  if (configured) return configured;
  return path.join(os.homedir(), '.loongsuite-pilot');
}

function localDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function appendErrorJsonl(dataDir, now, fields) {
  const day = localDateString(now);
  const record = sanitizeObject({
    time: now.toISOString(),
    clientType: 'CursorHook',
    ...fields,
  }) || { time: now.toISOString(), clientType: 'CursorHook', stage: 'unknown' };
  const candidates = [
    path.join(dataDir, 'logs', 'cursor', 'errors', `cursor-error-${day}.jsonl`),
    path.join(os.tmpdir(), 'loongsuite-pilot', 'cursor', 'errors', `cursor-error-${day}.jsonl`),
  ];
  for (const filePath of candidates) {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
      return;
    } catch {
      // 首选目录和临时目录都不可写时放弃；错误日志本身不能阻塞宿主。
    }
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  let str = Buffer.concat(chunks).toString('utf-8');
  if (str.charCodeAt(0) === 0xFEFF) str = str.slice(1);
  return str;
}

async function appendJsonl(filePath, record) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
}

async function appendBatchJsonl(filePath, records) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  await fs.appendFile(filePath, content, 'utf-8');
}

function writeEmptyResponse() {
  process.stdout.write('{}\n');
}

const CLI_VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}/;

function inferVariant(events) {
  for (const ev of events) {
    if (ev.cursor_version && CLI_VERSION_PATTERN.test(ev.cursor_version)) return 'cursor-cli';
  }
  return 'cursor';
}

function compactJournal(allEvents, consumedConversationIds) {
  const pendingTurnConvIds = new Set();
  const remaining = [];
  for (const ev of allEvents) {
    if (consumedConversationIds.has(ev.conversation_id)) continue;
    if (ev.hook_event === 'beforeSubmitPrompt') pendingTurnConvIds.add(ev.conversation_id);
  }
  for (const ev of allEvents) {
    if (consumedConversationIds.has(ev.conversation_id)) continue;
    if (pendingTurnConvIds.has(ev.conversation_id)) remaining.push(ev);
  }
  rewriteJournal(remaining, allEvents);
}

function applyPolicy(record, runtimeConfig) {
  return sanitizeObject(applyHookContentPolicy(record, runtimeConfig)) || {};
}

function injectSkillRecords(records, skills, runtimeConfig = {}) {
  // Skill 与 step 的对齐只能尽力而为：把检测到的 Read 附到第一条 LLM response。
  // assembler 即使面对纯 thought/隐式工具 step 也会合成 response，因此不要附到 request。
  const targetLlmIdx = records.findIndex(r => r['event.name'] === 'llm.response');
  if (targetLlmIdx < 0) return;

  // 每个 Read 只生成一次 call ID，使 LLM output、tool.call、tool.result 指向同一合成调用。
  const skillEntries = skills.map(skill => ({
    skill,
    toolCallId: crypto.randomUUID(),
  }));

  // 先在第一条 LLM response 的 assistant parts 中声明标准 Read tool_call。
  const llmRecord = records[targetLlmIdx];
  const outputMsgs = Array.isArray(llmRecord['gen_ai.output.messages'])
    ? llmRecord['gen_ai.output.messages']
    : [];

  let assistantMsg = outputMsgs.find(m => m.role === 'assistant');
  if (!assistantMsg) {
    assistantMsg = { role: 'assistant', parts: [] };
    outputMsgs.push(assistantMsg);
  }
  if (!Array.isArray(assistantMsg.parts)) assistantMsg.parts = [];

  for (const { skill, toolCallId } of skillEntries) {
    assistantMsg.parts.push({
      type: 'tool_call',
      id: toolCallId,
      name: 'Read',
      arguments: { path: skill.skillPath },
    });
  }
  llmRecord['gen_ai.output.messages'] = outputMsgs;
  records[targetLlmIdx] = applyPolicy(llmRecord, runtimeConfig);

  // 再为每次 skill 读取创建配对的 tool.call 与 tool.result 独立记录。
  const insertRecords = [];
  const baseTime = BigInt(llmRecord.time_unix_nano);
  const baseObservedTime = BigInt(
    llmRecord.observed_time_unix_nano ?? llmRecord.time_unix_nano
  );
  for (let index = 0; index < skillEntries.length; index++) {
    const { skill, toolCallId } = skillEntries[index];
    const callOffset = BigInt(index * 2 + 1);
    const resultOffset = callOffset + 1n;
    const baseFields = {
      trace_id: llmRecord.trace_id,
      'gen_ai.session.id': llmRecord['gen_ai.session.id'],
      'gen_ai.turn.id': llmRecord['gen_ai.turn.id'],
      'gen_ai.step.id': llmRecord['gen_ai.step.id'] || 'step_1',
      'gen_ai.agent.type': llmRecord['gen_ai.agent.type'],
      'user.id': llmRecord['user.id'],
    };

    // 合成 Skill Read 的 tool.call。
    insertRecords.push(applyPolicy({
      ...baseFields,
      time_unix_nano: String(baseTime + callOffset),
      observed_time_unix_nano: String(baseObservedTime + callOffset),
      'event.id': crypto.randomUUID(),
      'event.name': 'tool.call',
      'gen_ai.tool.name': 'Read',
      'gen_ai.tool.call.id': toolCallId,
      'gen_ai.tool.call.arguments': { path: skill.skillPath },
      'gen_ai.skill.name': skill.skillName,
      'agent.cursor.skill_detection_source': 'transcript_post_assembly',
    }, runtimeConfig));

    // 合成同一 call ID 的 tool.result。
    insertRecords.push(applyPolicy({
      ...baseFields,
      time_unix_nano: String(baseTime + resultOffset),
      observed_time_unix_nano: String(baseObservedTime + resultOffset),
      'event.id': crypto.randomUUID(),
      'event.name': 'tool.result',
      'gen_ai.tool.name': 'Read',
      'gen_ai.tool.call.id': toolCallId,
      'gen_ai.skill.name': skill.skillName,
      'agent.cursor.skill_detection_source': 'transcript_post_assembly',
    }, runtimeConfig));
  }

  // 紧跟在声明这些调用的第一条 LLM response 后插入，保持下游消费顺序。
  records.splice(targetLlmIdx + 1, 0, ...insertRecords);
}

async function main() {
  const dataDir = resolveDataDir();
  const raw = await readStdin();
  if (!raw || raw.trim().length === 0) {
    writeEmptyResponse();
    return;
  }

  const now = new Date();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (firstErr) {
    // Windows Cursor 可能在含中文事件的 JSON 引号后插入多余 0x3F（?），原因是 GB18030
    // 代码页把部分字符映射为问号。问号出现在闭合引号与结构字符（, } ]）之间：
    //   "value"?,  → "value",
    //   "value"?}  → "value"}
    if (process.platform === 'win32') {
      const repaired = raw
        .replace(/"?\?,/g, '",')   // 删除逗号前的 `"?` 或 `?`。
        .replace(/"?\?}/g, '"}')   // 删除右花括号前的 `"?` 或 `?`。
        .replace(/"?\?]/g, '"]');  // 删除右方括号前的 `"?` 或 `?`。
      if (repaired !== raw) {
        try {
          payload = JSON.parse(repaired);
        } catch {
          // 修复后仍无法解析，下面记录诊断并返回空响应。
        }
      }
    }
    if (!payload) {
      await appendErrorJsonl(dataDir, now, {
        stage: 'parse',
        'error.type': 'invalid_json',
        'error.message': firstErr instanceof Error ? firstErr.message : String(firstErr),
        input_bytes: Buffer.byteLength(raw),
        input_sha256: hashJson(raw),
      });
      writeEmptyResponse();
      return;
    }
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    await appendErrorJsonl(dataDir, now, {
      stage: 'validate',
      'error.type': 'invalid_payload_root',
      'error.message': 'Expected JSON object root payload',
      input_bytes: Buffer.byteLength(raw),
      input_sha256: hashJson(raw),
    });
    writeEmptyResponse();
    return;
  }

  // 先转为稳定内部事件，再在文件锁保护下追加 journal。
  const internalEvent = toInternalEvent(payload);
  try {
    appendEvent(internalEvent);
  } catch (err) {
    await appendErrorJsonl(dataDir, now, {
      stage: 'journal_append',
      'error.type': 'journal_failed',
      'error.message': err instanceof Error ? err.message : String(err),
      hookEvent: internalEvent.hook_event,
    });
    writeEmptyResponse();
    return;
  }

  if (process.env.LOONGSUITE_CURSOR_RAW_TRACE === '1') {
    try {
      const rawFile = path.join(dataDir, 'logs', 'cursor', 'raw', 'cursor-raw-trace.jsonl');
      await appendJsonl(rawFile, { _captured_at: now.toISOString(), ...payload });
    } catch {
      // 原始追踪仅用于诊断，写失败不影响正式 history 流程。
    }
  }

  // 父会话 stop 到达时组装完整 turn 并写正式 history。
  if (internalEvent.hook_event === 'stop') {
    try {
      const allEvents = readAllEvents();

      // 已知限制：Cursor 会并行启动 Hook，preToolUse 可能晚于 stop；此时本轮输出会缺少相应
      // tool.call/result。当前代码没有等待窗口，不能把此情况误解为已解决。

      // 重复 stop 防护：journal 中若已没有本会话 beforeSubmitPrompt，说明 turn 已被压缩处理。
      const hasPendingTurn = allEvents.some(e =>
        e.hook_event === 'beforeSubmitPrompt' &&
        e.conversation_id === internalEvent.conversation_id
      );
      if (!hasPendingTurn) {
        await appendErrorJsonl(dataDir, now, {
          stage: 'stop_guard',
          'error.type': 'info',
          'error.message': `skipped duplicate stop for conv=${internalEvent.conversation_id?.slice(0, 8)} (no pending beforeSubmitPrompt)`,
        });
        writeEmptyResponse();
        return;
      }

      // ─── Cursor CLI 延迟 stop ───
      // Cursor CLI 会先发 stop、后发 afterAgentResponse；有 prompt 但尚无 response 时延迟组装。
      // IDE 会立即组装，因为中止/错误场景不能等待一个可能永远不来的 response。
      const convId = internalEvent.conversation_id;
      const variant = inferVariant(allEvents);
      const hasResponse = allEvents.some(e =>
        e.hook_event === 'afterAgentResponse' && e.conversation_id === convId
      );
      if (variant === 'cursor-cli' && !hasResponse) {
        // 仅保留 journal；后到的 afterAgentResponse 分支会重新触发组装。
        writeEmptyResponse();
        return;
      }

      const runtimeConfig = loadHookRuntimeConfig(dataDir);
      let records;
      let consumedConversationIds;
      let assembledFromTranscript = false;

      // Windows 以 transcript 作为文本事实源，绕过 Hook payload 的 GB18030 代码页损坏。
      if (process.platform === 'win32' && internalEvent.transcript_path) {
        const transcriptRecords = buildCursorRecordsFromTranscript(
          internalEvent.transcript_path,
          allEvents,
          { runtimeConfig, stopConversationId: convId }
        );
        if (transcriptRecords && transcriptRecords.length > 0) {
          records = transcriptRecords;
          consumedConversationIds = new Set([convId]);
          assembledFromTranscript = true;
        }
      }

      // macOS/Linux 或 transcript 不可用时，回退到 Hook 事件驱动的 assembleTurn。
      if (!records) {
        const result = assembleTurn(allEvents, {
          runtimeConfig,
          variant,
          stopConversationId: convId,
          transcriptPath: internalEvent.transcript_path,
        });
        records = result.records;
        consumedConversationIds = result.consumedConversationIds;
      }

      // ─── 组装后从 transcript 检测 Skill 使用 ───
      try {
        const transcriptPathForSkill = internalEvent.transcript_path;
        const promptForSkill = allEvents.find(e =>
          e.hook_event === 'beforeSubmitPrompt' && e.conversation_id === convId
        );
        if (transcriptPathForSkill && promptForSkill?.prompt && records.length > 0) {
          const { detectSkillFromTranscript } = await import('./cursor/skill-detector.mjs');
          const detectedSkills = detectSkillFromTranscript(transcriptPathForSkill, promptForSkill.prompt);
          // Windows transcript assembler 已实体化 tool_use；只为 Hook 事件组装路径补偿 Skill 记录。
          if (detectedSkills && detectedSkills.length > 0 && !assembledFromTranscript) {
            injectSkillRecords(records, detectedSkills, runtimeConfig);
          }
        }
      } catch { /* Skill 检测尽力而为，绝不阻塞正式输出。 */ }

      if (records.length > 0) {
        const day = localDateString(now);
        const historyFile = path.join(dataDir, 'logs', 'cursor', 'history', `cursor-${day}.jsonl`);
        await appendBatchJsonl(historyFile, records);
      }

      compactJournal(allEvents, consumedConversationIds);
    } catch (err) {
      await appendErrorJsonl(dataDir, now, {
        stage: 'assemble',
        'error.type': 'assemble_failed',
        'error.message': err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── 延迟 stop 补偿：response 晚到后再组装 ───
  if (internalEvent.hook_event === 'afterAgentResponse') {
    try {
      const allEvents = readAllEvents();
      const convId = internalEvent.conversation_id;
      const hasStop = allEvents.some(e =>
        e.hook_event === 'stop' && e.conversation_id === convId
      );
      if (hasStop) {
        const runtimeConfig = loadHookRuntimeConfig(dataDir);
        const variant = inferVariant(allEvents);
        // 这里有意不传 transcriptPath：assembleTurn 应从 journal 中的 stopEvent 读取；
        // afterAgentResponse 自身携带的路径不保证正确。
        const result = assembleTurn(allEvents, {
          runtimeConfig,
          variant,
          stopConversationId: convId,
        });

        if (result.records.length > 0) {
          const day = localDateString(now);
          const historyFile = path.join(dataDir, 'logs', 'cursor', 'history', `cursor-${day}.jsonl`);
          await appendBatchJsonl(historyFile, result.records);
        }

        compactJournal(allEvents, result.consumedConversationIds);
      }
    } catch (err) {
      await appendErrorJsonl(dataDir, now, {
        stage: 'deferred_assemble',
        'error.type': 'deferred_assemble_failed',
        'error.message': err instanceof Error ? err.message : String(err),
      });
    }
  }

  writeEmptyResponse();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch(async err => {
    await appendErrorJsonl(resolveDataDir(), new Date(), {
      stage: 'runtime',
      'error.type': 'unhandled_exception',
      'error.message': err instanceof Error ? err.message : String(err),
    });
    writeEmptyResponse();
  });
}

export { injectSkillRecords };
