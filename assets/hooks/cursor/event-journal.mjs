/**
 * Cursor 只追加事件 journal 及并发压缩工具。
 *
 * 父会话、子会话和 subagent 元事件都会由不同 Hook 子进程追加到同一 JSONL。父 stop 时
 * processor 读取快照、组装完成 turn，然后仅保留未完成事件重写 journal。追加与重写共用
 * `event-journal.lock` 独占锁，防止 stop 压缩覆盖并发新事件；重写还会把快照之后追加的记录
 * 合并回来。锁等待最多 3 秒，2 秒以上锁视为可能由崩溃进程遗留并尝试回收。
 *
 * 本模块使用同步 I/O，因为每个 Hook 都是短生命周期独立进程，必须在返回宿主前完成状态提交。
 * 写入异常向 processor 抛出，由其记录错误并 fail-open；损坏的旧 JSONL 行会被跳过。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

const JOURNAL_DIR = path.join(pilotDataDir(), 'state', 'cursor');
const JOURNAL_FILE = path.join(JOURNAL_DIR, 'event-journal.jsonl');
const JOURNAL_LOCK_FILE = path.join(JOURNAL_DIR, 'event-journal.lock');
const JOURNAL_LOCK_TIMEOUT_MS = 3000;
const JOURNAL_LOCK_STALE_MS = 2000;
const JOURNAL_LOCK_RETRY_MS = 10;

function ensureJournalDir() {
  fs.mkdirSync(JOURNAL_DIR, { recursive: true });
}

export function appendEvent(event) {
  ensureJournalDir();
  withJournalLock(() => {
    fs.appendFileSync(JOURNAL_FILE, JSON.stringify(event) + '\n', 'utf-8');
  });
}

export function readAllEvents() {
  ensureJournalDir();
  return withJournalLock(() => {
    if (!fs.existsSync(JOURNAL_FILE)) return [];
    const content = fs.readFileSync(JOURNAL_FILE, 'utf-8');
    return parseJournalContent(content);
  });
}

export function rewriteJournal(remainingEvents, snapshotEvents = null) {
  ensureJournalDir();
  withJournalLock(() => {
    const finalEvents = Array.isArray(snapshotEvents)
      ? mergeConcurrentAppends(remainingEvents || [], snapshotEvents)
      : (remainingEvents || []);

    if (finalEvents.length === 0) {
      try { fs.unlinkSync(JOURNAL_FILE); } catch {}
      return;
    }

    // 同目录临时文件 + rename，确保其他进程只看到旧版或完整新版 journal。
    const tmp = JOURNAL_FILE + `.${process.pid}.tmp`;
    try {
      const content = finalEvents.map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.writeFileSync(tmp, content, 'utf-8');
      fs.renameSync(tmp, JOURNAL_FILE);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch {}
      throw err;
    }
  });
}

function mergeConcurrentAppends(remainingEvents, snapshotEvents) {
  if (!fs.existsSync(JOURNAL_FILE)) return remainingEvents;
  const currentEvents = parseJournalContent(fs.readFileSync(JOURNAL_FILE, 'utf-8'));
  const snapshotCounts = new Map();
  for (const event of snapshotEvents) {
    const key = stableEventKey(event);
    snapshotCounts.set(key, (snapshotCounts.get(key) || 0) + 1);
  }

  const appendedEvents = [];
  for (const event of currentEvents) {
    const key = stableEventKey(event);
    const count = snapshotCounts.get(key) || 0;
    if (count > 0) {
      snapshotCounts.set(key, count - 1);
    } else {
      appendedEvents.push(event);
    }
  }

  return [...remainingEvents, ...appendedEvents];
}

/**
 * 为 journal 事件生成稳定去重键。
 * 使用语义字段而非 JSON.stringify，避免 V8 版本间属性顺序差异，也避免复制大型 tool_output。
 */
function stableEventKey(event) {
  return [
    event._journal_ts || '',
    event.hook_event || '',
    event.conversation_id || '',
    event.generation_id || '',
    event.tool_use_id || '',
  ].join('\0');
}

function parseJournalContent(content) {
  const events = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // 跳过损坏行；保留其余可恢复事件。
    }
  }
  return events;
}

function withJournalLock(fn) {
  const lockFd = acquireJournalLock();
  try {
    return fn();
  } finally {
    try { fs.closeSync(lockFd); } catch {}
    try { fs.unlinkSync(JOURNAL_LOCK_FILE); } catch {}
  }
}

function acquireJournalLock() {
  const startedAt = Date.now();
  while (true) {
    try {
      return fs.openSync(JOURNAL_LOCK_FILE, 'wx');
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      removeStaleJournalLock();
      if (Date.now() - startedAt >= JOURNAL_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for Cursor event journal lock: ${JOURNAL_LOCK_FILE}`);
      }
      sleepSync(JOURNAL_LOCK_RETRY_MS);
    }
  }
}

function removeStaleJournalLock() {
  try {
    const stat = fs.statSync(JOURNAL_LOCK_FILE);
    if (Date.now() - stat.mtimeMs >= JOURNAL_LOCK_STALE_MS) {
      fs.unlinkSync(JOURNAL_LOCK_FILE);
    }
  } catch {}
}

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

export const CURSOR_JOURNAL_DIR = JOURNAL_DIR;
export const CURSOR_JOURNAL_FILE = JOURNAL_FILE;
export const CURSOR_JOURNAL_LOCK_TIMEOUT_MS = JOURNAL_LOCK_TIMEOUT_MS;
export const CURSOR_JOURNAL_LOCK_STALE_MS = JOURNAL_LOCK_STALE_MS;
