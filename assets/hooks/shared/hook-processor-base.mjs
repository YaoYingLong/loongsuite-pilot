/**
 * Hook transcript processor 的共享基础设施。
 *
 * 本文件属于“Agent Hook -> 本地 JSONL”采集链的底层工具层，主要由
 * `qoder-hook-processor.mjs` 和 `qoderwork-hook-processor.mjs` 导入。它负责解析
 * processor 的命令行参数、读取 Hook stdin、按会话持久化 transcript 行游标、兼容旧版
 * 聚合游标文件、读取新增 transcript 行，以及把归一化记录追加到 history JSONL。
 *
 * 输入来自宿主 Agent 写入 stdin 的 Hook JSON 和 Agent 自己维护的 transcript 文件；输出是
 * `<dataDir>/logs/<agentId>/history/*.jsonl` 以及 `<dataDir>/state/hooks/` 下的游标状态。
 * 这些函数运行在短生命周期 Node.js 子进程中，因此有意使用同步文件 API，保证进程退出前写入
 * 已落盘。除缺少必填 CLI 参数会退出 1 外，采集和日志操作均采用“尽力而为（best-effort）/
 * 失败开放（fail-open）”策略：
 * 遥测故障不应阻塞宿主 Agent。
 *
 * 本文件是 ES Module：`import` 引入 Node.js 内置模块，带 `export` 的函数供 processor 复用。
 */

// `node:fs` 提供同步文件读写；Hook 子进程必须在退出前完成持久化。
import fs from 'node:fs';
// `node:path` 负责跨平台拼接目录，避免手写 `/` 或 `\\`。
import path from 'node:path';
// `node:os` 用于取得用户主目录，构造默认数据目录。
import os from 'node:os';
// `node:crypto` 用 SHA-256 将任意 sessionId 转成安全、固定长度的文件名。
import crypto from 'node:crypto';
// ESM 没有 CommonJS 的 `__dirname`，需把 `import.meta.url` 转成本地路径。
import { fileURLToPath } from 'node:url';
import {
  buildQoderHookRecord,
  loadHookRuntimeConfig,
} from '../agent-event-normalizer.mjs';

// 调试日志总开关；写日志失败会被吞掉，不能反向影响 Agent。
const ENABLE_LOGGING = true;
// 当前源文件位于 `hooks/shared/`，连续两次 dirname 得到部署后的 `hooks/` 根目录。
export const HOOKS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// 安装器通常注入数据目录；未注入时回退到用户主目录下的标准位置。
export const LOONGSUITE_PILOT_DATA_DIR = process.env.LOONGSUITE_PILOT_DATA_DIR
  || path.join(os.homedir(), '.loongsuite-pilot');
// 所有 Agent 的 debug、error 和 history 日志都以此目录为共同根路径。
export const LOONGSUITE_PILOT_LOGS_BASE_DIR = (() => {
  return path.join(LOONGSUITE_PILOT_DATA_DIR, 'logs');
})();

// --- CLI 参数解析 -----------------------------------------------------------

/**
 * 解析 processor 的 `--agent-id` 与 `--log-prefix` 参数。
 *
 * 调用者是 Qoder/Qoder Work processor 的 `main()`。`process.argv.slice(2)` 会跳过
 * Node 可执行文件和脚本路径；`++i` 在读取选项值后同时跳过该值。缺少 `--agent-id` 表示
 * 部署命令不完整，此时写 stderr 并以退出码 1 终止；其余运行期错误仍由上层 fail-open。
 *
 * @returns {{agentId: string, logPrefix: string}} Agent 标识和 history 文件名前缀。
 */
export function parseArgs() {
  const args = process.argv.slice(2);
  let agentId = '';
  let logPrefix = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent-id' && i + 1 < args.length) { agentId = args[++i]; }
    else if (args[i] === '--log-prefix' && i + 1 < args.length) { logPrefix = args[++i]; }
  }
  if (!agentId) {
    process.stderr.write('hook-processor: --agent-id is required\n');
    process.exit(1);
  }
  return { agentId, logPrefix: logPrefix || agentId };
}

// --- 本地时区日期工具 -------------------------------------------------------

/**
 * 把 Date 格式化为 `YYYY-MM-DD`，用于按本地自然日滚动日志文件。
 * @param {Date} date 待格式化时间；默认当前时间。
 * @returns {string} 固定十位日期字符串。
 */
export function getLocalDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// --- 调试日志 ---------------------------------------------------------------

export function getDebugLogFile(agentId) {
  const day = getLocalDateString();
  return path.join(LOONGSUITE_PILOT_LOGS_BASE_DIR, agentId, 'debug', `${agentId}-debug-${day}.log`);
}

export function getErrorLogFile(agentId) {
  const day = getLocalDateString();
  return path.join(LOONGSUITE_PILOT_LOGS_BASE_DIR, agentId, 'errors', `${agentId}-error-${day}.log`);
}

export function logDebug(agentId, message) {
  if (!ENABLE_LOGGING) return;
  try {
    const file = getDebugLogFile(agentId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    fs.appendFileSync(file, `[${ts}] ${message}\n`, 'utf-8');
  } catch { /* 尽力而为：磁盘或权限错误不能阻塞宿主 Agent。 */ }
}

// --- 行游标持久化（按 Agent 和会话隔离） -----------------------------------

function aggregateLineRecordFile(agentId) {
  return path.join(LOONGSUITE_PILOT_DATA_DIR, 'state', 'hooks', `${agentId}-line-records.json`);
}

function deployedLegacyLineRecordFile(agentId) {
  return path.join(HOOKS_DIR, `.line_records.${agentId}.json`);
}

function sessionLineRecordDir(agentId) {
  return path.join(LOONGSUITE_PILOT_DATA_DIR, 'state', 'hooks', `${agentId}-line-records`);
}

function sessionLineRecordFile(agentId, sessionId) {
  // sessionId 可能包含路径分隔符或其他特殊字符；哈希后可安全地作为文件名。
  const sessionHash = crypto.createHash('sha256').update(sessionId).digest('hex');
  return path.join(sessionLineRecordDir(agentId), `${sessionHash}.json`);
}

/** 读取状态 JSON；不存在、损坏或顶层不是普通对象时返回 null，调用方据此走初始化/迁移路径。 */
function readJsonObject(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 通过“同目录临时文件 + rename”原子替换状态，避免进程崩溃时留下半截 JSON。
 * 返回布尔值而非抛错；失败时尽力删除本进程的临时文件。
 */
function saveJsonObject(file, value) {
  let tmp = '';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    // 先写同目录临时文件，再 rename，避免并发读取者看到半截 JSON。
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    if (tmp) {
      try { fs.unlinkSync(tmp); } catch { /* 临时文件清理失败不再向外抛错。 */ }
    }
    return false;
  }
}

function saveSessionLineRecord(agentId, sessionId, record) {
  return saveJsonObject(sessionLineRecordFile(agentId, sessionId), record);
}

/**
 * 把旧版按 Agent 聚合的游标按需迁移为按 session 单文件状态。
 * 只迁移当前请求的 session，且通过 isLineRecordNewer 保证不会用旧游标覆盖新版进度。
 */
function reconcileAggregateLineRecord(agentId, requestedSessionId) {
  // 新版按 session 拆文件；这两个来源是旧版按 Agent 聚合的状态文件。
  const sources = [
    aggregateLineRecordFile(agentId),
    deployedLegacyLineRecordFile(agentId),
  ];

  for (const source of sources) {
    const records = readJsonObject(source);
    if (!records) continue;

    for (const [transcriptPath, value] of Object.entries(records)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const sessionId = typeof value.session_id === 'string' ? value.session_id : '';
      if (!sessionId || sessionId !== requestedSessionId) continue;

      const target = sessionLineRecordFile(agentId, sessionId);
      const existing = readJsonObject(target);
      const candidate = {
        ...value,
        session_id: sessionId,
        transcript_path: transcriptPath,
      };
      if (!existing || isLineRecordNewer(candidate, existing)) {
        saveSessionLineRecord(agentId, sessionId, candidate);
      }
    }
  }
}

function isLineRecordNewer(candidate, existing) {
  if (candidate.transcript_path === existing.transcript_path) {
    // 同一 transcript 的已读行数只能单调递增。旧版本并发“读-改-写”可能留下时间较新、
    // 行数却较旧的记录，因此此处以行数而不是 updated_at 判断，防止新版主游标倒退并重复采集。
    return Number(candidate.last_line_count) > Number(existing.last_line_count);
  }

  const candidateUpdated = typeof candidate.updated_at === 'string' ? candidate.updated_at : '';
  const existingUpdated = typeof existing.updated_at === 'string' ? existing.updated_at : '';
  return Boolean(candidateUpdated)
    && (!existingUpdated || candidateUpdated > existingUpdated);
}

// `Atomics.wait` 需要共享数组作为等待地址；这里只借它同步休眠 10ms，不存放业务数据。
const LOCK_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

/**
 * 更新供旧版本读取的聚合影子文件。
 * `wx` 锁把多个短命 Hook 的读改写串行化；等待最多 1 秒，30 秒以上锁视为崩溃残留。
 */
function updateAggregateShadow(file, transcriptPath, record) {
  // 多个 Hook 子进程可能同时更新兼容影子文件，使用 `wx` 独占创建锁文件串行化写入。
  const lockFile = `${file}.lock`;
  const deadline = Date.now() + 1_000;
  let acquired = false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    while (!acquired) {
      try {
        const fd = fs.openSync(lockFile, 'wx');
        fs.closeSync(fd);
        acquired = true;
      } catch (err) {
        if (err?.code !== 'EEXIST') return false;
        try {
          const stat = fs.statSync(lockFile);
          if (Date.now() - stat.mtimeMs > 30_000) {
            fs.unlinkSync(lockFile);
            continue;
          }
        } catch { /* 锁可能刚被另一进程释放，进入下一轮重试。 */ }
        if (Date.now() >= deadline) return false;
        Atomics.wait(LOCK_WAIT_ARRAY, 0, 0, 10);
      }
    }

    const records = readJsonObject(file) || {};
    const existing = records[transcriptPath];
    if (existing?.session_id === record.session_id
      && Number(existing.last_line_count) > Number(record.last_line_count)) {
      return true;
    }
    records[transcriptPath] = {
      session_id: record.session_id,
      last_line_count: record.last_line_count,
      updated_at: record.updated_at,
    };
    return saveJsonObject(file, records);
  } finally {
    if (acquired) {
      try { fs.unlinkSync(lockFile); } catch { /* 清理失败由 30 秒陈旧锁恢复逻辑兜底。 */ }
    }
  }
}

function rollbackShadowFiles(agentId) {
  const files = [aggregateLineRecordFile(agentId)];
  const deployedHooksDir = path.join(LOONGSUITE_PILOT_DATA_DIR, 'hooks');
  if (path.resolve(HOOKS_DIR) === path.resolve(deployedHooksDir)) {
    files.push(deployedLegacyLineRecordFile(agentId));
  }
  return files;
}

export function loadLineRecord(agentId, sessionId) {
  if (!sessionId) return {};
  const file = sessionLineRecordFile(agentId, sessionId);

  // 旧版本把一个 Agent 的所有 transcript 游标放在单个 JSON 对象中，位置可能是持久化状态目录，
  // 也可能是已部署 hooks 旁。这里只按请求的 session 惰性迁移，避免每次 Hook 全量扫描和重写。
  // 聚合文件仍作为带锁的“回滚影子”继续更新，因此用户回滚旧版又升级回来时不会丢失游标进度。
  reconcileAggregateLineRecord(agentId, sessionId);
  return readJsonObject(file) || {};
}

export function updateLineRecord(agentId, transcriptPath, sessionId, endLine) {
  const record = {
    session_id: sessionId,
    transcript_path: transcriptPath,
    last_line_count: endLine,
    updated_at: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
  };
  const ok = saveSessionLineRecord(agentId, sessionId, record);
  if (ok) {
    logDebug(agentId, `Updated record: ${transcriptPath} -> ${endLine} lines`);
    for (const shadow of rollbackShadowFiles(agentId)) {
      if (!updateAggregateShadow(shadow, transcriptPath, record)) {
        logDebug(agentId, `Warning: Failed to update rollback cursor shadow ${shadow}`);
      }
    }
  } else {
    logDebug(agentId, 'Warning: Failed to save line records');
  }
  return ok;
}

// --- Transcript 增量读取 ---------------------------------------------------

/**
 * 统计 transcript 的逻辑行数；末尾没有换行符的最后一行也计入。
 * @param {string} transcriptPath transcript 绝对路径。
 * @returns {number} 行数；文件不存在或读取失败时返回 0。
 */
export function getTranscriptLineCount(transcriptPath) {
  try {
    if (!fs.existsSync(transcriptPath)) return 0;
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    let count = 0;
    for (let i = 0; i < content.length; i++) {
      if (content[i] === '\n') count++;
    }
    if (content.length > 0 && content[content.length - 1] !== '\n') count++;
    return count;
  } catch {
    return 0;
  }
}

export function getLineRangeInfo(agentId, transcriptPath, sessionId) {
  const record = loadLineRecord(agentId, sessionId);
  const hasRecordedOffset = Number.isFinite(record.last_line_count)
    && record.last_line_count >= 0;
  let lastCount = hasRecordedOffset ? record.last_line_count : 0;
  const recordedSession = record.session_id || '';
  const recordedTranscript = record.transcript_path || '';
  let reason = hasRecordedOffset ? 'incremental' : 'missing-cursor';

  const currentCount = getTranscriptLineCount(transcriptPath);

  // 会话或文件身份变化时不能沿用旧 offset，否则会跳过新文件开头。
  if (recordedSession && recordedSession !== sessionId) {
    logDebug(agentId, `Session changed: ${recordedSession} -> ${sessionId}, reset to 0`);
    lastCount = 0;
    reason = 'session-changed';
  }
  if (recordedTranscript && recordedTranscript !== transcriptPath) {
    logDebug(agentId, `Transcript changed for session ${sessionId}, reset to 0`);
    lastCount = 0;
    reason = 'transcript-changed';
  }
  if (currentCount === 0) {
    logDebug(agentId, 'Transcript is empty');
    return null;
  }
  if (currentCount === lastCount) {
    logDebug(agentId, `No new lines (count: ${currentCount})`);
    return null;
  }
  // 文件被截断/轮转后从第 0 行重读，保证不会永久漏掉新内容。
  if (currentCount < lastCount) {
    logDebug(agentId, `File truncated (${lastCount} -> ${currentCount}), sending all`);
    lastCount = 0;
    reason = 'truncated';
  }

  logDebug(agentId, `Range: ${lastCount} -> ${currentCount} (${reason})`);
  return { startLine: lastCount, endLine: currentCount, reason };
}

/**
 * 混合版本部署期的兼容 API。
 *
 * 升级时共享模块可能先于旧 processor 被替换，而旧 processor 仍要求数组返回值；因此保留
 * `[startLine, endLine]` 形式。仓库内当前 processor 使用信息更完整的 `getLineRangeInfo()`。
 * @returns {[number, number] | null} 有新增内容时返回起止行，否则返回 null。
 */
export function getLineRange(agentId, transcriptPath, sessionId) {
  const info = getLineRangeInfo(agentId, transcriptPath, sessionId);
  return info ? [info.startLine, info.endLine] : null;
}

export function readTranscriptLines(transcriptPath, startLine, endLine) {
  const lines = [];
  try {
    if (!fs.existsSync(transcriptPath)) return lines;
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const allLines = content.split('\n');
    for (let i = startLine; i < endLine && i < allLines.length; i++) {
      const trimmed = allLines[i].trim();
      if (trimmed) lines.push(trimmed);
    }
  } catch {
    // 尽力读取：调用者会把空数组视为本轮无可处理记录。
  }
  return lines;
}

export function parseTranscriptLine(line, agentId, runtimeConfig, turnId) {
  try {
    const parsed = JSON.parse(line);
    return normalizeTranscriptRecord(parsed, agentId, runtimeConfig, turnId);
  } catch {
    return null;
  }
}

export function normalizeTranscriptRecord(record, agentId, runtimeConfig, turnId) {
  if (agentId === 'qoder-cli' || agentId === 'qoder-work' || agentId === 'qoder' || agentId === 'qoder-cn') {
    return buildQoderHookRecord(record, { agentId, runtimeConfig, turnId });
  }
  return record;
}

// --- 标准 history 文件 -----------------------------------------------------

export function getHistoryLogFile(agentId, logPrefix) {
  const day = getLocalDateString();
  const historyDir = path.join(LOONGSUITE_PILOT_LOGS_BASE_DIR, agentId, 'history');
  return path.join(historyDir, `${logPrefix}-${day}.jsonl`);
}

export function appendRowsToHistory(agentId, logPrefix, rows) {
  if (!rows.length) return true;
  const logFile = getHistoryLogFile(agentId, logPrefix);
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, rows.join('\n') + '\n', 'utf-8');
    logDebug(agentId, `Appended ${rows.length} rows to ${logFile}`);
    return true;
  } catch (e) {
    logDebug(agentId, `ERROR appending rows to history: ${e.message}`);
    return false;
  }
}

// --- stdin 辅助函数 --------------------------------------------------------

/**
 * 异步消费标准输入流直到 EOF，并合并为 UTF-8 字符串。
 *
 * `for await` 会随 Node.js 事件循环等待每个数据块，Promise 在 stdin 关闭后完成。这里剥离
 * PowerShell 5.x 管道可能添加的 UTF-8 BOM，否则紧随其后的 JSON.parse 会失败。
 * @returns {Promise<string>} 完整 stdin 文本。
 */
export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  let str = Buffer.concat(chunks).toString('utf-8');
  // PowerShell 5.x 向原生命令传递字符串时可能添加 UTF-8 BOM，解析 JSON 前必须去掉。
  if (str.charCodeAt(0) === 0xFEFF) str = str.slice(1);
  return str;
}

export async function parseStdinPayload(agentId) {
  const raw = await readStdin();
  // Hook 协议需要立即得到合法 JSON；先输出空对象，即使后续采集失败也不会阻塞宿主。
  process.stdout.write('{}\n');

  if (!raw || !raw.trim()) return null;

  logDebug(agentId, `stdin payload: ${raw.length} bytes`);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    logDebug(agentId, `Failed to parse stdin JSON: ${e.message}`);
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  logDebug(agentId, `event: ${payload.hook_event_name || 'unknown'}, session: ${payload.session_id || ''}`);
  logDebug(agentId, `payload keys: ${Object.keys(payload).join(', ')}`);

  if (payload.stop_hooks_active) {
    logDebug(agentId, 'stop_hooks_active=true, exiting to avoid recursion');
    return null;
  }

  const transcriptPath = payload.transcript_path || '';
  const sessionId = payload.session_id || payload.conversation_id || '';

  if (!transcriptPath || !sessionId) {
    logDebug(agentId, 'No transcript_path or session_id in payload');
    return null;
  }

  if (!fs.existsSync(transcriptPath)) {
    logDebug(agentId, `Transcript file not found: ${transcriptPath}`);
    return null;
  }

  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : undefined;
  return { transcriptPath, sessionId, cwd };
}

// --- 重新导出归一化工具 ----------------------------------------------------

// 调用者只依赖本共享模块即可取得运行时配置加载器，无需了解其实际定义文件。
export { loadHookRuntimeConfig };
