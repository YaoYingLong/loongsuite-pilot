// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Codex Hook 的轻量唤醒入口。
 *
 * `agents.d/codex.json` 当前只注册 Stop 事件；Shell/PowerShell wrapper 将 stdin JSON 和
 * `stop` 子命令传给本进程。Codex 的 `~/.codex/sessions/<日期目录>/rollout-*.jsonl` 才是唯一正式
 * 遥测事实源，本文件既不解析 transcript，也不累积 Hook 事件或写遥测 JSONL。它只把
 * session/turn/transcript 路径及资源属性原子写入
 * `<dataDir>/state/codex/transcript-wakeups/<session>.json`，让长驻 Collector 中的
 * `CodexTranscriptInput` 立即发起采集，而不必等待默认轮询周期。
 *
 * 输入是 stdin 的 Stop payload，stdout 始终返回 `{}` 满足 Hook 协议；错误写独立 error
 * JSONL 并 fail-open。同步文件 I/O 可确保短生命周期进程退出前 marker 已完成 rename。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { logHookError } from './shared/error-logger.mjs';
import { recordUpstreamContextOnce } from './shared/upstream-context.mjs';
import {
  collectResourceAttributesFromEnv,
} from './shared/resource-context.mjs';

const AGENT_ID = 'codex';
const RESOURCE_ATTRIBUTES = collectResourceAttributesFromEnv(process.env, { agentId: AGENT_ID });
const RESOURCE_ATTRIBUTE_FIELDS = Object.keys(RESOURCE_ATTRIBUTES).length > 0
  ? { resourceAttributes: RESOURCE_ATTRIBUTES }
  : {};

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

function tryReadStdin() {
  try {
    // 文件描述符 0 = stdin（标准输入） 等价读取终端 / 管道传入的数据；
    const input = fs.readFileSync(0, 'utf8').trim();
    if (!input) return {};
    const value = JSON.parse(input);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'stdin_parse',
      errorType: 'STDIN_PARSE_ERROR',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

function safePathPart(value) {
  // basename 去除父目录，再替换特殊字符，防止 sessionId 被当作路径使用。
  return path.basename(String(value)).replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
}

/**
 * 为有效 session 原子写入唤醒标记。
 * @param {Record<string, unknown>} input Codex Stop stdin payload。
 * @returns {void} 无返回值；失败只记日志。
 */
function writeWakeupMarker(input) {
  const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
  if (!sessionId) return;

  // 首个 turn 从环境变量读取 TRACEPARENT，按 session 只写一次上游关联记录。
  recordUpstreamContextOnce({ agentId: AGENT_ID, sessionId, dataDir: pilotDataDir() });

  // .loongsuite-pilot/state/codex/transcript-wakeups
  const directory = path.join(pilotDataDir(), 'state', 'codex', 'transcript-wakeups');
  const marker = path.join(directory, `${safePathPart(sessionId)}.json`);
  const temporary = path.join(directory, `.${safePathPart(sessionId)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const payload = {
    session_id: sessionId,
    ...(typeof input.turn_id === 'string' && input.turn_id ? { turn_id: input.turn_id } : {}),
    ...(typeof input.transcript_path === 'string' && input.transcript_path
      ? { transcript_path: input.transcript_path }
      : {}),
    ...RESOURCE_ATTRIBUTE_FIELDS,
    received_at: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(directory, { recursive: true });
    // 临时文件写完再 rename，watcher 不会读到不完整 JSON。
    fs.writeFileSync(temporary, JSON.stringify(payload), 'utf8');
    fs.renameSync(temporary, marker);
  } catch (error) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'wakeup_write',
      errorType: 'WAKEUP_WRITE_ERROR',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    try { fs.unlinkSync(temporary); } catch (cleanupError) {
      logHookError({
        agentId: AGENT_ID,
        stage: 'wakeup_cleanup',
        errorType: 'WAKEUP_CLEANUP_ERROR',
        errorMessage: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
  }
}

function main() {
  // `process.argv[0..1]` 分别是 Node 和脚本路径，真正子命令位于索引 2。
  const subcommand = (process.argv[2] || '').trim();
  try {
    if (subcommand === 'stop') writeWakeupMarker(tryReadStdin());
  } finally {
    // 无论是否识别命令或写入成功，都用合法空 JSON 响应宿主并正常结束。
    process.stdout.write('{}\n');
  }
}

main();
