// Dashboard 进程指标读取库。`serve-loongsuite-pilot-monitor.mjs` 调用这里的导出函数，
// 从 monitor Shell 脚本按小时生成的 CSV 中选择时间窗口、解析行并汇总状态。
// 本模块使用 ESM `export` 暴露 API；所有磁盘操作基于 Promise，调用方必须 `await`。
// 文件在轮转中消失或暂时不可读时辅助函数返回空结果，避免监控故障影响 Collector。

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

// CSV 表头也是 Shell 写入端和浏览器读取端之间的字段顺序契约。
export const METRICS_HEADER = 'timestamp,pid,ppid,command,cpu_percent,mem_percent,rss_kb,vsz_kb,elapsed,threads,open_files,inet_connections,tcp_established,tcp_listen,udp_connections';

const DEFAULT_WINDOW_MINUTES = 60;
const MAX_WINDOW_MINUTES = 24 * 60;

/**
 * 将本地时间转换为与 Shell 采样文件名一致的小时键。
 * @param {Date} date 要格式化的时间，默认当前时间。
 * @returns {string} `YYYY-MM-DD-HH`，用于定位小时 CSV。
 */
export function localHourString(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    String(date.getHours()).padStart(2, '0'),
  ].join('-');
}

/**
 * 校验 Dashboard 查询窗口并向上取整，最大限制为 24 小时，避免一次请求扫描无限历史文件。
 * @param {unknown} rawValue URL/环境变量中的原始分钟值。
 * @param {number} fallback 非法输入的回退值。
 * @returns {number} 1 到 1440 之间的整数分钟数。
 */
export function parseWindowMinutes(rawValue, fallback = DEFAULT_WINDOW_MINUTES) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.ceil(parsed), MAX_WINDOW_MINUTES);
}

/**
 * 解析一行 RFC 4180 风格 CSV，正确处理引号字段、转义双引号和引号内逗号。
 * @param {string} line 不含换行符的一行。
 * @returns {string[]} 按原顺序拆分的字段；本函数不做数字类型转换。
 */
export function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

/**
 * 为 `/api/metrics` 生成带表头的 CSV 响应。
 * @param {object} options 透传给 `collectMetricsWindow` 的目录、分钟数和当前时间。
 * @returns {Promise<string>} 按时间排序且以换行结尾的 CSV。
 */
export async function getMetricsCsv(options) {
  const summary = await collectMetricsWindow(options);
  return [
    METRICS_HEADER,
    ...summary.rows.map((row) => row.line),
  ].join('\n') + '\n';
}

/**
 * 为 `/api/status` 返回当前窗口使用的文件和更新时间元数据，不返回每一行指标内容。
 * @param {object} options 采样目录与窗口选项。
 * @returns {Promise<object>} 可直接 JSON 序列化的状态对象。
 */
export async function getMetricsStatus(options) {
  const summary = await collectMetricsWindow(options);
  return {
    paths: summary.files.map((file) => file.path),
    files: summary.files,
    windowMinutes: summary.windowMinutes,
    rows: summary.rows.length,
    from: summary.from.toISOString(),
    to: summary.to.toISOString(),
    updatedAt: summary.files
      .map((file) => file.updatedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || null,
  };
}

/**
 * 收集时间窗口内的全部 CSV 行。函数异步枚举候选文件，忽略无效/过期行并按时间升序排序。
 * @param {object} options
 * @param {string} options.monitorDir Shell 采样器写入目录。
 * @param {number} [options.minutes=60] 查询窗口分钟数。
 * @param {Date} [options.now] 可注入当前时间，便于测试稳定边界。
 * @returns {Promise<{files: object[], rows: object[], from: Date, to: Date, windowMinutes: number}>}
 */
export async function collectMetricsWindow({
  monitorDir,
  minutes = DEFAULT_WINDOW_MINUTES,
  now = new Date(),
} = {}) {
  const windowMinutes = parseWindowMinutes(minutes);
  const to = now;
  const from = new Date(to.getTime() - windowMinutes * 60_000);
  const files = await listCandidateFiles(monitorDir, from, to);
  const rows = [];

  for (const file of files) {
    const text = await safeReadFile(file.path);
    if (!text) continue;
    const lines = text.split(/\r?\n/).filter(Boolean);
    const body = lines[0] === METRICS_HEADER ? lines.slice(1) : lines.filter((line) => !line.startsWith('timestamp,'));
    for (const line of body) {
      const values = parseCsvLine(line);
      const timestamp = parseMetricTimestamp(values[0]);
      if (!timestamp) continue;
      if (timestamp >= from && timestamp <= to) {
        rows.push({ timestamp, line });
      }
    }
  }

  rows.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return { files, rows, from, to, windowMinutes };
}

/**
 * 枚举可能与窗口相交的小时/旧版每日 CSV，并附加 stat 元数据。
 * 文件轮转造成的瞬时消失由 safe 辅助函数吞掉，不会拒绝整个 Dashboard 请求。
 * @returns {Promise<object[]>} 按文件名排序的候选文件。
 */
async function listCandidateFiles(monitorDir, from, to) {
  const entries = await safeReaddir(monitorDir);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const hourly = entry.name.match(/^loongsuite-pilot-process-(\d{4})-(\d{2})-(\d{2})-(\d{2})\.csv$/);
    const daily = entry.name.match(/^loongsuite-pilot-process-(\d{4})-(\d{2})-(\d{2})\.csv$/);
    if (!hourly && !daily) continue;

    const filePath = path.join(monitorDir, entry.name);
    const fileStat = await safeStat(filePath);
    if (!fileStat) continue;

    if (hourly) {
      const start = new Date(Number(hourly[1]), Number(hourly[2]) - 1, Number(hourly[3]), Number(hourly[4]));
      const end = new Date(start.getTime() + 60 * 60_000);
      if (end < from || start > to) continue;
    } else if (fileStat.mtime < from) {
      continue;
    }

    candidates.push({
      path: filePath,
      name: entry.name,
      sizeBytes: fileStat.size,
      updatedAt: fileStat.mtime.toISOString(),
    });
  }
  candidates.sort((a, b) => a.name.localeCompare(b.name));
  return candidates;
}

/** 将 CSV 时间字段解析为 Date；格式无效返回 `null`，供调用循环跳过该行。 */
function parseMetricTimestamp(value) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value.replace(' ', 'T'));
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

/** fail-open 读取 UTF-8 文件；不存在或权限错误时返回空字符串。 */
async function safeReadFile(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

/** fail-open 枚举目录；不存在或权限错误时返回空数组。 */
async function safeReaddir(dirPath) {
  try {
    return await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** fail-open 获取文件状态；文件轮转消失或权限错误时返回 `null`。 */
async function safeStat(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}
