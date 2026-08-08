/**
 * Collector 本地日志保留与磁盘容量保护服务。
 *
 * `Orchestrator.start()` 启动本类，延迟后按配置周期扫描各 Agent 的 history/errors/
 * debug、规范化 output 和 SLS 失败元数据。常规策略按文件名日期删除；output 另有
 * 大文件与 2 GiB 总量水位，且保护今天及容量清理时的昨天文件。删除失败逐文件隔离，
 * timer 使用 `unref()`，`stop()` 负责取消后续扫描。
 */


import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { LogRetentionConfig } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { SLS_FAILURE_LOG_MAX_TOTAL_BYTES } from '../flushers/sls-failure-log-writer.js';

const logger = createLogger('LogRetention');

const DATE_REGEX = /(\d{4}-\d{2}-\d{2})\.\w+$/;
const STARTUP_DELAY_MS = 30_000;
const MEBIBYTE = 1024 * 1024;

export const OUTPUT_RETENTION_MAX_TOTAL_BYTES = 2 * 1024 * MEBIBYTE;
export const OUTPUT_RETENTION_LARGE_FILE_THRESHOLD_BYTES = 512 * MEBIBYTE;
export const OUTPUT_RETENTION_LARGE_FILE_DAYS = 2;
export const OUTPUT_RETENTION_PRESSURE_MIN_KEEP_DAYS = 1;
export const SLS_FAILURE_RETENTION_MAX_TOTAL_BYTES = SLS_FAILURE_LOG_MAX_TOTAL_BYTES;

type Category = 'history' | 'errors' | 'debug' | 'output' | 'sls-failed-logs';

interface DatedLogFile {
  file: string;
  fullPath: string;
  dateStr: string;
  size: number;
}

const CATEGORY_DIR_MAP: Record<string, Category> = {
  history: 'history',
  errors: 'errors',
  debug: 'debug',
  output: 'output',
  'sls-failed-logs': 'sls-failed-logs',
};

/**
 * 多类别本地日志保留服务。
 *
 * 对普通分类按文件名日期清理，对 output/SLS failure 额外执行容量水位。所有目录读取、
 * stat 和 unlink 都逐项隔离，返回计数供日志观察，不会因单文件失败拒绝整轮 Promise。
 */
export class LogRetentionService {
  private readonly logsDir: string;
  private readonly config: LogRetentionConfig;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;

  /** @param dataDir 数据根目录；实际扫描固定在其 logs 子目录。 */
  constructor(dataDir: string, config: LogRetentionConfig) {
    this.logsDir = path.join(dataDir, 'logs');
    this.config = config;
  }

  /**
   * 配置关闭时不创建资源；否则延迟首轮并建立周期 timer，二者均 unref。
   */
  start(): void {
    if (!this.config.enabled) {
      logger.info('log retention disabled');
      return;
    }
    logger.info('scheduling log retention', {
      intervalMs: this.config.intervalMs,
      hookHistoryDays: this.config.hookHistoryDays,
      hookErrorDays: this.config.hookErrorDays,
      hookDebugDays: this.config.hookDebugDays,
      outputDays: this.config.outputDays,
      slsFailedDays: this.config.slsFailedDays,
      outputMaxTotalBytes: OUTPUT_RETENTION_MAX_TOTAL_BYTES,
      outputLargeFileThresholdBytes: OUTPUT_RETENTION_LARGE_FILE_THRESHOLD_BYTES,
      outputLargeFileDays: OUTPUT_RETENTION_LARGE_FILE_DAYS,
      outputPressureMinKeepDays: OUTPUT_RETENTION_PRESSURE_MIN_KEEP_DAYS,
      slsFailedMaxTotalBytes: SLS_FAILURE_RETENTION_MAX_TOTAL_BYTES,
    });

    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.runCleanup();
      this.intervalTimer = setInterval(() => void this.runCleanup(), this.config.intervalMs);
    }, STARTUP_DELAY_MS);
  }

  /** 取消启动和周期 timer；已在进行的 runCleanup 自行完成。 */
  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  /**
   * 依次清理 history/errors/debug/output/sls-failed-logs。
   * @returns 本轮成功删除数和失败数。
   */
  async runCleanup(): Promise<{ deleted: number; errors: number }> {
    const today = localDateString(new Date());
    let deleted = 0;
    let errors = 0;

    try {
      const topEntries = await readdir(this.logsDir);

      for (const entry of topEntries) {
        const entryPath = path.join(this.logsDir, entry);
        const stat = await safeStat(entryPath);
        if (!stat?.isDirectory()) continue;

        const category = CATEGORY_DIR_MAP[entry];
        if (category) {
          const result = await this.cleanDirectory(entryPath, category, today);
          deleted += result.deleted;
          errors += result.errors;
        } else {
          const subResult = await this.cleanSubdirectories(entryPath, today);
          deleted += subResult.deleted;
          errors += subResult.errors;
        }
      }
    } catch (err) {
      logger.warn('log retention scan failed', { error: String(err) });
      errors++;
    }

    if (deleted > 0 || errors > 0) {
      logger.info('log retention complete', { deleted, errors });
    }

    return { deleted, errors };
  }

  /** 遍历每个 Agent 子目录，再把对应分类目录交给 cleanDirectory。 */
  private async cleanSubdirectories(
    parentDir: string,
    today: string,
  ): Promise<{ deleted: number; errors: number }> {
    let deleted = 0;
    let errors = 0;

    const subEntries = await readdir(parentDir);
    for (const sub of subEntries) {
      const category = CATEGORY_DIR_MAP[sub];
      if (!category) continue;

      const subPath = path.join(parentDir, sub);
      const stat = await safeStat(subPath);
      if (!stat?.isDirectory()) continue;

      const result = await this.cleanDirectory(subPath, category, today);
      deleted += result.deleted;
      errors += result.errors;
    }

    return { deleted, errors };
  }

  /** 按文件名日期删除早于 cutoff 的普通分类日志；当天文件受日期比较自然保护。 */
  private async cleanDirectory(
    dir: string,
    category: Category,
    today: string,
  ): Promise<{ deleted: number; errors: number }> {
    let deleted = 0;
    let errors = 0;

    const files = await readdir(dir);
    if (category === 'output') {
      return this.cleanOutputDirectory(dir, files, today);
    }
    if (category === 'sls-failed-logs') {
      return this.cleanSlsFailedDirectory(dir, files, today);
    }

    const retentionDays = this.getRetentionDays(category);
    const cutoff = dateCutoff(retentionDays);
    for (const file of files) {
      const dateStr = extractDate(file);
      if (!dateStr) continue;
      if (dateStr === today) continue;
      if (dateStr >= cutoff) continue;

      if (await this.deleteFile(path.join(dir, file))) {
        deleted++;
      } else {
        errors++;
      }
    }

    return { deleted, errors };
  }

  /**
   * 清 SLS 失败分段；除日期保留外还尊重 50 MiB 容量上限，并保护当前活跃 segment。
   */
  private async cleanSlsFailedDirectory(
    dir: string,
    files: string[],
    today: string,
  ): Promise<{ deleted: number; errors: number }> {
    let deleted = 0;
    let errors = 0;
    let remaining = await this.collectDatedOutputFiles(dir, files);

    const cutoff = dateCutoff(this.config.slsFailedDays);
    const expiredResult = await this.deleteDatedFiles(
      remaining,
      file => file.dateStr !== today && file.dateStr < cutoff,
    );
    deleted += expiredResult.deleted;
    errors += expiredResult.errors;

    remaining = await this.collectDatedOutputFiles(dir, await readdir(dir));
    let totalBytes = remaining.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes <= SLS_FAILURE_RETENTION_MAX_TOTAL_BYTES) {
      return { deleted, errors };
    }

    const activePaths = findActiveSlsFailureSegments(remaining, today);
    const candidates = remaining
      .filter(file => !activePaths.has(file.fullPath))
      .sort((a, b) => a.dateStr.localeCompare(b.dateStr)
        || a.file.localeCompare(b.file));

    for (const file of candidates) {
      if (totalBytes <= SLS_FAILURE_RETENTION_MAX_TOTAL_BYTES) break;
      if (await this.deleteFile(file.fullPath)) {
        deleted++;
        totalBytes -= file.size;
      } else {
        errors++;
      }
    }

    return { deleted, errors };
  }

  /**
   * 清规范化 JSONL：先执行常规天数/超大旧文件规则，再按总容量从最老文件删除。
   */
  private async cleanOutputDirectory(
    dir: string,
    files: string[],
    today: string,
  ): Promise<{ deleted: number; errors: number }> {
    let deleted = 0;
    let errors = 0;
    let remaining = await this.collectDatedOutputFiles(dir, files);

    const regularCutoff = dateCutoff(this.config.outputDays);
    const regularResult = await this.deleteDatedFiles(
      remaining,
      file => file.dateStr !== today && file.dateStr < regularCutoff,
    );
    deleted += regularResult.deleted;
    errors += regularResult.errors;
    remaining = remaining.filter(file => !regularResult.attemptedPaths.has(file.fullPath));

    const largeFileCutoff = dateCutoff(OUTPUT_RETENTION_LARGE_FILE_DAYS);
    const largeFileResult = await this.deleteDatedFiles(
      remaining,
      file => file.dateStr !== today
        && file.dateStr < largeFileCutoff
        && file.size > OUTPUT_RETENTION_LARGE_FILE_THRESHOLD_BYTES,
    );
    deleted += largeFileResult.deleted;
    errors += largeFileResult.errors;
    remaining = remaining.filter(file => !largeFileResult.attemptedPaths.has(file.fullPath));

    const pressureResult = await this.enforceOutputSizeLimit(remaining, today);
    deleted += pressureResult.deleted;
    errors += pressureResult.errors;

    return { deleted, errors };
  }

  /** 读取文件大小并提取日期，无法 stat/解析的文件不参加容量排序。 */
  private async collectDatedOutputFiles(dir: string, files: string[]): Promise<DatedLogFile[]> {
    const result: DatedLogFile[] = [];
    for (const file of files) {
      const dateStr = extractDate(file);
      if (!dateStr) continue;

      const fullPath = path.join(dir, file);
      const stat = await safeStat(fullPath);
      if (!stat?.isFile()) continue;

      result.push({
        file,
        fullPath,
        dateStr,
        size: stat.size,
      });
    }
    return result;
  }

  /** 按传入谓词批量删除 dated files，并累加共享结果对象。 */
  private async deleteDatedFiles(
    files: DatedLogFile[],
    shouldDelete: (file: DatedLogFile) => boolean,
  ): Promise<{ deleted: number; errors: number; attemptedPaths: Set<string> }> {
    let deleted = 0;
    let errors = 0;
    const attemptedPaths = new Set<string>();

    for (const file of files) {
      if (!shouldDelete(file)) continue;

      attemptedPaths.add(file.fullPath);
      if (await this.deleteFile(file.fullPath)) {
        deleted++;
      } else {
        errors++;
      }
    }

    return { deleted, errors, attemptedPaths };
  }

  /**
   * 总量超过水位时按日期、文件名升序删除，直到达标；protectedFiles 永不删除。
   */
  private async enforceOutputSizeLimit(
    files: DatedLogFile[],
    today: string,
  ): Promise<{ deleted: number; errors: number }> {
    let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes <= OUTPUT_RETENTION_MAX_TOTAL_BYTES) {
      return { deleted: 0, errors: 0 };
    }

    const minKeepCutoff = dateCutoff(OUTPUT_RETENTION_PRESSURE_MIN_KEEP_DAYS);
    const candidates = files
      .filter(file => file.dateStr !== today && file.dateStr < minKeepCutoff)
      .sort((a, b) => a.dateStr.localeCompare(b.dateStr)
        || b.size - a.size
        || a.file.localeCompare(b.file));

    let deleted = 0;
    let errors = 0;
    for (const file of candidates) {
      if (totalBytes <= OUTPUT_RETENTION_MAX_TOTAL_BYTES) break;

      if (await this.deleteFile(file.fullPath)) {
        deleted++;
        totalBytes -= file.size;
      } else {
        errors++;
      }
    }

    return { deleted, errors };
  }

  /** unlink 单文件；成功返回 true，失败记录警告并返回 false。 */
  private async deleteFile(file: string): Promise<boolean> {
    try {
      await fs.unlink(file);
      return true;
    } catch (err) {
      logger.warn('failed to delete log file', { file, error: String(err) });
      return false;
    }
  }

  /** 将分类映射到各自配置保留天数。 */
  private getRetentionDays(category: Category): number {
    switch (category) {
      case 'history': return this.config.hookHistoryDays;
      case 'errors': return this.config.hookErrorDays;
      case 'debug': return this.config.hookDebugDays;
      case 'output': return this.config.outputDays;
      case 'sls-failed-logs': return this.config.slsFailedDays;
    }
  }
}

/** 从 `<name>-YYYY-MM-DD.<ext>` 中提取日期；格式不符返回 null。 */
export function extractDate(filename: string): string | null {
  const match = DATE_REGEX.exec(filename);
  if (!match) return null;
  const d = match[1];
  const parts = d.split('-').map(Number);
  if (parts.length !== 3) return null;
  const [y, m, day] = parts;
  if (y < 2020 || y > 2099 || m < 1 || m > 12 || day < 1 || day > 31) return null;
  return d;
}

/** 按本地日期计算 retentionDays 天前的字符串截止点。 */
function dateCutoff(retentionDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() - retentionDays);
  return localDateString(d);
}

/** 生成可按字典序比较的本地 YYYY-MM-DD。 */
function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 容错读取目录；不存在或无权限时返回空数组。 */
async function readdir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

/** 容错 stat；失败返回 null，由调用者跳过该文件。 */
async function safeStat(p: string) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

/**
 * 找出今天每个 SLS 失败日志基础名的最新分段，容量清理时保护正在追加的文件。
 */
function findActiveSlsFailureSegments(files: DatedLogFile[], today: string): Set<string> {
  const latestByEndpoint = new Map<string, { segment: number; path: string }>();
  for (const file of files) {
    if (file.dateStr !== today) continue;
    const match = /^(.*)-(\d+)-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file.file);
    if (!match || match[3] !== today) continue;
    const segment = Number(match[2]);
    const current = latestByEndpoint.get(match[1]);
    if (!current || segment > current.segment) {
      latestByEndpoint.set(match[1], { segment, path: file.fullPath });
    }
  }
  return new Set([...latestByEndpoint.values()].map(value => value.path));
}
