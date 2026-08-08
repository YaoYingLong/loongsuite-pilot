/**
 * Updater 与 Collector Watchdog 共享的运行状态文件契约。
 *
 * 独立 Updater 周期写入 PID、当前版本、失败次数和下次检查时间；UpdaterWatchdog
 * 从同一路径读取并结合进程探测判断健康。这里只定义类型和路径，无文件 I/O 副作用。
 */


import * as path from 'node:path';

export type UpdaterRuntimeStatus = 'running' | 'degraded';

export interface UpdaterRuntimeState {
  status: UpdaterRuntimeStatus;
  pid: number;
  version: string;
  versionDir: string | null;
  gitCommit?: string;
  updatedAt: string;
  consecutiveFailures: number;
  nextCheckAt?: string;
}

/** 返回 `<dataDir>/logs/updater-runtime.json`。 */
export function updaterRuntimePath(dataDir: string): string {
  return path.join(dataDir, 'logs', 'updater-runtime.json');
}
