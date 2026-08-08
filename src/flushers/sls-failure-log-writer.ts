/**
 * SLS 最终失败的有界诊断元数据写入器。
 *
 * 该文件刻意不记录失败 payload、请求 headers 或凭据，只保存 endpoint、错误摘要和批次大小。
 * 每个 endpoint 按本地日期/10 MiB 分段，目录总量限制 50 MiB；写操作用 Promise 链串行化，
 * 避免并发 append、轮转和容量清理互相竞争。
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createLogger } from '../utils/logger.js';
import { ensureDir } from '../utils/fs-utils.js';

const logger = createLogger('SlsFailureLogWriter');

/** 二进制 MiB，避免与十进制 MB 混淆。 */
const MEBIBYTE = 1024 * 1024;

export const SLS_FAILURE_LOG_SCHEMA_VERSION = 2;
export const SLS_FAILURE_LOG_MAX_FILE_BYTES = 10 * MEBIBYTE;
export const SLS_FAILURE_LOG_MAX_TOTAL_BYTES = 50 * MEBIBYTE;
export const SLS_FAILURE_ERROR_SUMMARY_MAX_BYTES = 2 * 1024;

/** 调用方提供的失败上下文；error 会在本模块内清洗和截断。 */
export interface SlsFailureLogInput {
  endpoint: string;
  mode: string;
  project: string;
  logstore: string;
  kind: string;
  batchCount: number;
  batchBytes: number;
  error: unknown;
}

/** 实际写入 JSONL 的固定 schema 2 记录。 */
export interface SlsFailureLogRecord {
  schema_version: 2;
  ts: number;
  endpoint: string;
  mode: string;
  project: string;
  logstore: string;
  kind: string;
  error_type: string;
  error_code: string;
  http_status: number;
  error_summary: string;
  batch_count: number;
  batch_bytes: number;
}

/** 测试或特殊部署可覆盖的容量和时钟。 */
export interface SlsFailureLogWriterOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  now?: () => Date;
}

/** 单个 endpoint+date 当前活跃分段的内存状态。 */
interface FileState {
  date: string;
  segment: number;
  filePath: string;
}

/** 容量回收所需的磁盘文件元数据。 */
interface LogFileInfo {
  file: string;
  fullPath: string;
  size: number;
  mtimeMs: number;
  group: string | null;
  segment: number | null;
  date: string | null;
}

/** 解析 `<prefix>-<segment>-YYYY-MM-DD.jsonl` 的文件名。 */
const ROTATED_FILE_REGEX = /^(.*)-(\d+)-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** 串行写入、轮转和回收失败诊断文件。 */
export class SlsFailureLogWriter {
  private readonly directory: string;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => Date;
  private readonly states = new Map<string, FileState>();
  /** 前一次写操作的尾 Promise；reject 会被转换后继续供下一次排队。 */
  private writeChain: Promise<void> = Promise.resolve();

  /**
   * @param directory 失败日志专用目录，构造时转为绝对路径。
   * @param options 容量上限和可注入时钟。
   */
  constructor(directory: string, options: SlsFailureLogWriterOptions = {}) {
    this.directory = path.resolve(directory);
    this.maxFileBytes = options.maxFileBytes ?? SLS_FAILURE_LOG_MAX_FILE_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? SLS_FAILURE_LOG_MAX_TOTAL_BYTES;
    this.now = options.now ?? (() => new Date());
  }

  /** 确保目标目录存在；Orchestrator 启动 SLS Flusher 时调用。 */
  async start(): Promise<void> {
    await ensureDir(this.directory);
  }

  /**
   * 将一次失败追加到串行写链。
   *
   * @returns 成功落盘为 true；容量不足、路径保护或 I/O 异常为 false，均不向主输出链抛错。
   */
  async write(input: SlsFailureLogInput): Promise<boolean> {
    let written = false;
    const operation = this.writeChain.then(async () => {
      written = await this.writeOnce(input);
    });
    // 无论 operation 成败都把 writeChain 转为 fulfilled，保证后续失败仍能继续写。
    this.writeChain = operation.catch(() => {});
    try {
      await operation;
      return written;
    } catch (err) {
      logger.warn('failed to persist SLS failure metadata', {
        endpoint: input.endpoint,
        error: String(err),
      });
      return false;
    }
  }

  /** 执行单次记录构建、路径校验、容量回收和 append。 */
  private async writeOnce(input: SlsFailureLogInput): Promise<boolean> {
    await ensureDir(this.directory);

    const now = this.now();
    const record = buildSlsFailureLogRecord(input, now);
    const line = `${JSON.stringify(record)}\n`;
    const lineBytes = Buffer.byteLength(line);
    const safeEndpoint = safeEndpointFilePrefix(input.endpoint);
    const state = await this.resolveFileState(safeEndpoint, localDateString(now), lineBytes);

    // 即便 prefix 已清洗，仍在写入前做最终目录逃逸检查。
    if (!isPathInside(this.directory, state.filePath)) {
      logger.warn('refusing SLS failure log path outside target directory', {
        endpoint: input.endpoint,
      });
      return false;
    }

    const hasCapacity = await this.ensureCapacity(lineBytes, state.filePath);
    if (!hasCapacity) {
      logger.warn('SLS failure metadata dropped because directory limit is exhausted', {
        endpoint: input.endpoint,
        maxTotalBytes: this.maxTotalBytes,
      });
      return false;
    }

    await fs.appendFile(state.filePath, line, 'utf8');
    return true;
  }

  /** 复用当天分段；当前文件加新行超限时切到下一个 segment。 */
  private async resolveFileState(
    safeEndpoint: string,
    date: string,
    lineBytes: number,
  ): Promise<FileState> {
    const key = `${safeEndpoint}|${date}`;
    let state = this.states.get(key);
    if (!state) {
      const segment = await this.findLatestSegment(safeEndpoint, date);
      state = {
        date,
        segment,
        filePath: this.buildFilePath(safeEndpoint, segment, date),
      };
    }

    const stat = await safeLstat(state.filePath);
    if (stat?.isFile() && stat.size > 0 && stat.size + lineBytes > this.maxFileBytes) {
      state = {
        date,
        segment: state.segment + 1,
        filePath: this.buildFilePath(safeEndpoint, state.segment + 1, date),
      };
    }

    this.states.set(key, state);
    return state;
  }

  /** 扫描已有同 endpoint/date 文件，恢复进程重启前的最大 segment。 */
  private async findLatestSegment(safeEndpoint: string, date: string): Promise<number> {
    let latest = 0;
    const prefix = `${safeEndpoint}-`;
    const suffix = `-${date}.jsonl`;
    const entries = await safeReaddir(this.directory);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(suffix)) continue;
      const segmentText = entry.name.slice(prefix.length, -suffix.length);
      if (!/^\d+$/.test(segmentText)) continue;
      latest = Math.max(latest, Number(segmentText));
    }
    return latest;
  }

  /** 构造四位补零 segment 文件名。 */
  private buildFilePath(safeEndpoint: string, segment: number, date: string): string {
    return path.join(
      this.directory,
      `${safeEndpoint}-${String(segment).padStart(4, '0')}-${date}.jsonl`,
    );
  }

  /**
   * 确保加入 incomingBytes 后不超过目录总量。
   * 保留今天每组最新活跃分段和当前目标，从最旧的密封分段开始删除。
   */
  private async ensureCapacity(incomingBytes: number, targetPath: string): Promise<boolean> {
    const files = await this.collectLogFiles();
    let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes + incomingBytes <= this.maxTotalBytes) return true;

    const activePaths = findActivePaths(files, targetPath, localDateString(this.now()));
    const candidates = files
      .filter(file => !activePaths.has(file.fullPath))
      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '')
        || a.mtimeMs - b.mtimeMs
        || a.file.localeCompare(b.file));

    for (const file of candidates) {
      if (totalBytes + incomingBytes <= this.maxTotalBytes) break;
      // 某个旧文件删不掉时继续尝试其他候选，最终按实际总量决定能否写入。
      try {
        await fs.unlink(file.fullPath);
        totalBytes -= file.size;
      } catch (err) {
        logger.warn('failed to remove sealed SLS failure log segment', {
          file: file.file,
          error: String(err),
        });
      }
    }

    return totalBytes + incomingBytes <= this.maxTotalBytes;
  }

  /** 收集目录内普通 `.jsonl` 文件；符号链接和非文件条目不会计入。 */
  private async collectLogFiles(): Promise<LogFileInfo[]> {
    const result: LogFileInfo[] = [];
    const entries = await safeReaddir(this.directory);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const fullPath = path.join(this.directory, entry.name);
      const stat = await safeLstat(fullPath);
      if (!stat?.isFile()) continue;
      const parsed = parseRotatedFile(entry.name);
      result.push({
        file: entry.name,
        fullPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        group: parsed?.group ?? null,
        segment: parsed?.segment ?? null,
        date: parsed?.date ?? null,
      });
    }
    return result;
  }
}

/**
 * 将任意 error 转成固定、截断、已去凭据的 schema 2 记录。
 */
export function buildSlsFailureLogRecord(
  input: SlsFailureLogInput,
  now = new Date(),
): SlsFailureLogRecord {
  const errorObject = asErrorObject(input.error);
  return {
    schema_version: SLS_FAILURE_LOG_SCHEMA_VERSION,
    ts: now.getTime(),
    endpoint: boundedString(input.endpoint, 256),
    mode: boundedString(input.mode, 64),
    project: boundedString(input.project, 256),
    logstore: boundedString(input.logstore, 256),
    kind: boundedString(input.kind, 128),
    error_type: boundedString(errorObject.type, 128),
    error_code: boundedString(errorObject.code, 128),
    http_status: errorObject.httpStatus,
    error_summary: truncateUtf8(redactErrorSummary(errorObject.summary), SLS_FAILURE_ERROR_SUMMARY_MAX_BYTES),
    batch_count: boundedNonNegativeInteger(input.batchCount),
    batch_bytes: boundedNonNegativeInteger(input.batchBytes),
  };
}

/**
 * 把 endpoint 规范化成安全短前缀并附加原值 SHA-256 短 hash，兼顾安全与区分度。
 */
export function safeEndpointFilePrefix(endpoint: string): string {
  const normalized = endpoint.normalize('NFKC');
  const base = normalized
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 48) || 'endpoint';
  const hash = createHash('sha256').update(endpoint).digest('hex').slice(0, 10);
  return `${base}-${hash}`;
}

/** 估算字符串宽表批次字节数，供失败元数据记录而非网络硬限制。 */
export function estimateStringRecordBytes(records: Record<string, string>[]): number {
  let total = 0;
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      total += Buffer.byteLength(key) + Buffer.byteLength(value) + 6;
    }
    total += 2;
  }
  return total;
}

/** 从 Error 或普通对象中提取低基数类型、code、HTTP status 和摘要。 */
function asErrorObject(error: unknown): {
  type: string;
  code: string;
  httpStatus: number;
  summary: string;
} {
  const value = typeof error === 'object' && error !== null
    ? error as Record<string, unknown>
    : null;
  const status = Number(value?.status ?? value?.statusCode ?? 0);
  const type = error instanceof Error
    ? error.name || error.constructor.name
    : typeof error;
  const summary = error instanceof Error ? error.message : String(error ?? 'unknown error');
  return {
    type: type || 'Error',
    code: typeof value?.code === 'string' ? value.code : '',
    httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0,
    summary,
  };
}

/** 删除 Bearer、AccessKey、API key 和 URL 用户密码等常见凭据。 */
function redactErrorSummary(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bLTAI[A-Za-z0-9]{12,}\b/g, '[REDACTED_ACCESS_KEY]')
    .replace(
      /((?:access[_-]?key(?:[_-]?(?:id|secret))?|api[_-]?key|authorization)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      '$1[REDACTED]',
    )
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

/** 按 UTF-8 字节安全截断，并去掉截断多字节字符产生的尾部替换符。 */
function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/u, '');
}

/** 将任意字符串值限制到最大 UTF-8 字节数。 */
function boundedString(value: string, maxBytes: number): string {
  return truncateUtf8(String(value ?? ''), maxBytes);
}

/** 将批次计数限制为 0..Number.MAX_SAFE_INTEGER 的整数。 */
function boundedNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

/** 返回本地日期，文件轮转与本机 retention 语义一致。 */
function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 判断 child 解析后的相对路径严格位于 parent 内部，不允许等于目录本身。 */
function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** 解析受管理轮转文件名；不匹配的旧/外部 JSONL 返回 null。 */
function parseRotatedFile(file: string): { group: string; segment: number; date: string } | null {
  const match = ROTATED_FILE_REGEX.exec(file);
  if (!match) return null;
  return { group: `${match[1]}|${match[3]}`, segment: Number(match[2]), date: match[3] };
}

/** 找出今天每组最新 segment 和当前目标，容量清理不得删除这些活跃路径。 */
function findActivePaths(files: LogFileInfo[], targetPath: string, today: string): Set<string> {
  const latestByGroup = new Map<string, LogFileInfo>();
  for (const file of files) {
    if (!file.group || file.date !== today || file.segment === null) continue;
    const current = latestByGroup.get(file.group);
    if (!current || (current.segment ?? -1) < file.segment) latestByGroup.set(file.group, file);
  }

  const target = parseRotatedFile(path.basename(targetPath));
  if (target?.date === today) latestByGroup.delete(target.group);
  return new Set([...latestByGroup.values()].map(file => file.fullPath).concat(targetPath));
}

/** readdir 失败时返回空列表，容量检查会保守基于可见文件继续。 */
async function safeReaddir(directory: string) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** lstat 失败时返回 null；使用 lstat 可避免跟随符号链接。 */
async function safeLstat(filePath: string) {
  try {
    return await fs.lstat(filePath);
  } catch {
    return null;
  }
}
