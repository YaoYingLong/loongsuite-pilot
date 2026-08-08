/**
 * 旧版 SLS 失败 payload 日志的一次性隐私清理服务。
 *
 * 新实现只保留有容量上限的错误元数据；本服务在 Collector 启动后延迟运行，把历史
 * JSONL 先原子移动到 pending 目录，再逐个删除，避免继续留存消息正文。瞬时文件系统
 * 错误按固定退避重试，符号链接和非普通文件按保守规则处理。整个迁移 fail-open，
 * 结果只用于日志和指标，不参与当前 SLS 发送链。
 */


import type { Dirent, Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('LegacySlsFailureCleanup');

export const LEGACY_SLS_CLEANUP_STARTUP_DELAY_MS = 30_000;
export const LEGACY_SLS_CLEANUP_FILE_DELAY_MS = 100;
export const LEGACY_SLS_CLEANUP_RETRY_DELAYS_MS = [250, 1_000, 4_000] as const;

/** 可替换的文件系统接口，便于在单元测试中模拟权限、竞争和瞬时错误。 */
export interface CleanupFileSystem {
  lstat(filePath: string): Promise<Stats>;
  rename(oldPath: string, newPath: string): Promise<void>;
  readdir(directory: string): Promise<Dirent[]>;
  unlink(filePath: string): Promise<void>;
  rmdir(directory: string): Promise<void>;
}

const defaultFileSystem: CleanupFileSystem = {
  lstat: filePath => fs.lstat(filePath),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  readdir: directory => fs.readdir(directory, { withFileTypes: true }),
  unlink: filePath => fs.unlink(filePath),
  rmdir: directory => fs.rmdir(directory),
};

export interface LegacySlsFailedLogCleanupOptions {
  startupDelayMs?: number;
  fileDelayMs?: number;
  retryDelaysMs?: readonly number[];
  fileSystem?: CleanupFileSystem;
  delay?: (milliseconds: number) => Promise<void>;
}

/** 清理阶段计数；errors 不会使启动失败，只用于日志和指标。 */
export interface LegacySlsFailedLogCleanupResult {
  renamed: boolean;
  deleted: number;
  skipped: number;
  errors: number;
  logicalBytes: number;
}

/**
 * 迁移旧 `logs/sls-failed-logs` 中可能包含 payload 的 JSONL。
 *
 * 生命周期：构造 -> start 延迟一次运行 -> runCleanup 合并并发调用 -> stop 取消未触发
 * timer。正在执行的清理不会被 stop 强行中断，以免留下一半重命名状态。
 */
export class LegacySlsFailedLogCleanupService {
  private readonly legacyDir: string;
  private readonly pendingDir: string;
  private readonly startupDelayMs: number;
  private readonly fileDelayMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly fileSystem: CleanupFileSystem;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<LegacySlsFailedLogCleanupResult> | null = null;

  /**
   * @param dataDir Collector 数据根目录。
   * @param options 延迟、重试和文件系统依赖覆盖，生产通常使用默认值。
   */
  constructor(dataDir: string, options: LegacySlsFailedLogCleanupOptions = {}) {
    this.legacyDir = path.join(dataDir, 'sls-failed-logs');
    this.pendingDir = path.join(dataDir, 'sls-failed-logs.delete-pending');
    this.startupDelayMs = options.startupDelayMs ?? LEGACY_SLS_CLEANUP_STARTUP_DELAY_MS;
    this.fileDelayMs = options.fileDelayMs ?? LEGACY_SLS_CLEANUP_FILE_DELAY_MS;
    this.retryDelaysMs = options.retryDelaysMs ?? LEGACY_SLS_CLEANUP_RETRY_DELAYS_MS;
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
    this.delay = options.delay ?? unrefDelay;
  }

  /** 安排一次延迟清理；重复 start 会先取消旧 timer。timer 已 unref。 */
  start(): void {
    if (this.startupTimer || this.running) return;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.runCleanup();
    }, this.startupDelayMs);
    this.startupTimer.unref();
  }

  /** 仅取消尚未触发的启动 timer，不删除文件。 */
  stop(): void {
    if (!this.startupTimer) return;
    clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  /**
   * 执行或复用正在运行的同一清理 Promise，避免两轮同时 rename/unlink。
 * @returns 完成、跳过及错误计数。
   */
  async runCleanup(): Promise<LegacySlsFailedLogCleanupResult> {
    if (this.running) return this.running;
    this.running = this.runOnce()
      .catch(err => {
        logger.warn('legacy SLS failure cleanup failed', { error: String(err) });
        return emptyResult(1);
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /**
   * 把 legacy 目录原子改名为 pending，再清 pending。rename 先切断新旧路径，可避免
   * 清理过程中继续向旧目录追加；目录不存在按无需处理。
   */
  private async runOnce(): Promise<LegacySlsFailedLogCleanupResult> {
    const result = emptyResult();
    const pendingErrors = result.errors;
    const pendingStat = await this.safeLstat(this.pendingDir, result);

    if (pendingStat) {
      if (pendingStat.isSymbolicLink() || !pendingStat.isDirectory()) {
        logger.warn('legacy pending path is not a regular directory; skipping', {
          path: path.basename(this.pendingDir),
        });
        result.skipped++;
        return result;
      }
      await this.cleanPendingDirectory(result);
      this.logResult(result);
      return result;
    }
    if (result.errors > pendingErrors) return result;

    const legacyErrors = result.errors;
    const legacyStat = await this.safeLstat(this.legacyDir, result);
    if (result.errors > legacyErrors) return result;
    if (!legacyStat) return result;
    if (legacyStat.isSymbolicLink() || !legacyStat.isDirectory()) {
      logger.warn('legacy SLS failure path is not a regular directory; skipping', {
        path: path.basename(this.legacyDir),
      });
      result.skipped++;
      return result;
    }

    const renamed = await this.retryTransient(
      () => this.fileSystem.rename(this.legacyDir, this.pendingDir),
      path.basename(this.legacyDir),
      'rename',
    );
    if (!renamed) {
      result.errors++;
      return result;
    }
    result.renamed = true;

    await this.cleanPendingDirectory(result);
    this.logResult(result);
    return result;
  }

  /** 逐个处理 pending 条目；仅删除符合旧 JSONL 命名的普通文件，目录最后尝试 rmdir。 */
  private async cleanPendingDirectory(result: LegacySlsFailedLogCleanupResult): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await this.fileSystem.readdir(this.pendingDir);
    } catch (err) {
      result.errors++;
      logger.warn('failed to enumerate legacy SLS failure directory', {
        error: errorCode(err),
      });
      return;
    }

    const candidates = entries.filter(entry => isLegacyJsonlName(entry.name));
    for (const entry of entries) {
      if (isLegacyJsonlName(entry.name)) continue;
      result.skipped++;
      logger.warn('skipping unknown legacy SLS failure entry', {
        file: entry.name,
        reason: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'name',
      });
    }

    for (let index = 0; index < candidates.length; index++) {
      const entry = candidates[index];
      const fullPath = path.join(this.pendingDir, entry.name);
      let stat: Stats;
      try {
        stat = await this.fileSystem.lstat(fullPath);
      } catch (err) {
        result.errors++;
        logger.warn('failed to inspect legacy SLS failure file', {
          file: entry.name,
          error: errorCode(err),
        });
        continue;
      }

      if (stat.isSymbolicLink() || !stat.isFile()) {
        result.skipped++;
        logger.warn('skipping non-regular legacy SLS failure entry', { file: entry.name });
        continue;
      }

      const deleted = await this.retryTransient(
        () => this.fileSystem.unlink(fullPath),
        entry.name,
        'unlink',
        stat.size,
      );
      if (deleted) {
        result.deleted++;
        result.logicalBytes += stat.size;
      } else {
        result.errors++;
      }

      if (index < candidates.length - 1 && this.fileDelayMs > 0) {
        await this.delay(this.fileDelayMs);
      }
    }

    try {
      const remaining = await this.fileSystem.readdir(this.pendingDir);
      if (remaining.length === 0) await this.fileSystem.rmdir(this.pendingDir);
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') {
        result.errors++;
        logger.warn('failed to remove empty legacy pending directory', {
          error: errorCode(err),
        });
      }
    }
  }

  /**
   * 只对预期的瞬时文件错误按配置延迟重试；其他错误立即返回给调用分支计数。
   */
  private async retryTransient(
    operation: () => Promise<void>,
    basename: string,
    operationName: 'rename' | 'unlink',
    logicalBytes?: number,
  ): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        await operation();
        return true;
      } catch (err) {
        const code = errorCode(err);
        const retryDelay = this.retryDelaysMs[attempt];
        if (!isTransientFileError(code) || retryDelay === undefined) {
          logger.warn('legacy SLS failure cleanup operation failed', {
            operation: operationName,
            file: basename,
            logicalBytes,
            error: code,
            attempts: attempt + 1,
          });
          return false;
        }
        await this.delay(retryDelay);
      }
    }
  }

  /** lstat 的 ENOENT 视为对象已消失，其他错误保留给上层统计。 */
  private async safeLstat(
    filePath: string,
    result: LegacySlsFailedLogCleanupResult,
  ): Promise<Stats | null> {
    try {
      return await this.fileSystem.lstat(filePath);
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') {
        result.errors++;
        logger.warn('failed to inspect legacy SLS failure path', {
          path: path.basename(filePath),
          error: errorCode(err),
        });
      }
      return null;
    }
  }

  /** 仅在有实际工作或错误时记录汇总，避免每次启动产生空噪声。 */
  private logResult(result: LegacySlsFailedLogCleanupResult): void {
    if (!result.renamed && result.deleted === 0 && result.skipped === 0 && result.errors === 0) return;
    logger.info('legacy SLS failure cleanup complete', { ...result });
  }
}

/** 只识别旧格式 `.jsonl` 文件，目录和新元数据格式不会被误删。 */
export function isLegacyJsonlName(name: string): boolean {
  return !name.startsWith('.') && name.length > '.jsonl'.length && name.endsWith('.jsonl');
}

/** 创建各计数为 0 的新结果对象。 */
function emptyResult(errors = 0): LegacySlsFailedLogCleanupResult {
  return { renamed: false, deleted: 0, skipped: 0, errors, logicalBytes: 0 };
}

/** 从未知异常提取 Node.js errno code。 */
function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code) return code;
  }
  return String(error);
}

/** 判断 rename/unlink 是否值得退避重试。 */
function isTransientFileError(code: string): boolean {
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

/** 创建不会单独维持进程的延迟 Promise。 */
function unrefDelay(milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}
