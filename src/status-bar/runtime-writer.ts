/**
 * Collector 运行心跳文件写入器。
 *
 * 启用状态栏时，Orchestrator 启动本类立即写一次 `logs/runtime.json`，随后周期更新
 * status、版本、PID 和时间；macOS App 与服务诊断据此判断 Collector 是否存活。
 * timer 不阻止进程退出，`stop()` 清 timer 并同步删除心跳，避免退出后显示假在线。
 */


import * as fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import * as path from 'node:path';
import type { StatusBarConfig } from '../types/index.js';
import { writeJsonFile, ensureDir } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('RuntimeWriter');

export interface RuntimeRecord {
  status: string;
  packageVersion: string;
  pid: number;
  updatedAt: string;
}

/**
 * 用周期文件心跳向状态栏和诊断工具公布 Collector 存活状态。
 *
 * Orchestrator 在启动末段创建并调用 `start()`，退出时调用 `stop()`。本类拥有一个
 * interval timer 和 runtime.json 路径；timer 回调异步原子写盘且自行记录异常，
 * `stop()` 清除 timer 并删除文件，不保留其他外部资源。
 */
export class RuntimeWriter {
  private readonly filePath: string;
  private readonly config: StatusBarConfig;
  private readonly packageVersion: string;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;

  /** 保存心跳路径、刷新配置和版本；构造阶段不创建文件。 */
  constructor(dataDir: string, config: StatusBarConfig, packageVersion: string) {
    this.filePath = path.join(dataDir, 'logs', 'runtime.json');
    this.config = config;
    this.packageVersion = packageVersion;
  }

  /** 启用时立即异步写一次，再建立 unref interval；write 自行捕获文件异常。 */
  start(): void {
    if (!this.config.enabled) {
      logger.info('runtime writer disabled');
      return;
    }

    void this.write();

    this.intervalTimer = setInterval(
      () => void this.write(),
      this.config.runtimeRefreshIntervalMs,
    );

    logger.info('runtime writer started', {
      path: this.filePath,
      intervalMs: this.config.runtimeRefreshIntervalMs,
    });
  }

  /** 清 timer 并同步删除 runtime.json，确保退出后状态栏不误判在线。 */
  stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }

    try {
      rmSync(this.filePath, { force: true });
    } catch {
      // 文件可能尚未生成或已被其他清理流程删除。
    }
    logger.info('runtime writer stopped');
  }

  /** 确保父目录并原子写 running/PID/version/updatedAt；失败只记录警告。 */
  private async write(): Promise<void> {
    try {
      const record: RuntimeRecord = {
        status: 'active',
        packageVersion: this.packageVersion,
        pid: process.pid,
        updatedAt: new Date().toISOString(),
      };
      await ensureDir(path.dirname(this.filePath));
      await writeJsonFile(this.filePath, record);
    } catch (err) {
      logger.warn('failed to write runtime.json', { error: String(err) });
    }
  }
}
