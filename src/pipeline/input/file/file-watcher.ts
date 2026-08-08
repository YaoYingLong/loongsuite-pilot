/**
 * 文件 Pipeline 的低延迟变更提示器。
 *
 * `fs.watch` 只负责把可能变化的路径放入 dirty Set，FileTailer 仍通过 stat/offset 验证真实内容；
 * watcher 创建或运行失败时删除句柄并退化到 FilePipeline 的周期全量扫描。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('FileWatcher');

/** 管理多个父目录 watcher 和一次性 dirty 文件集合。 */
export class FileWatcher {
  private watchers: Map<string, fs.FSWatcher> = new Map();
  private dirtyFiles: Set<string> = new Set();

  /** 为尚未监听的唯一目录创建 watcher；单目录失败不影响其他目录。 */
  watch(dirs: string[]): void {
    const uniqueDirs = [...new Set(dirs)];
    for (const dir of uniqueDirs) {
      if (this.watchers.has(dir)) continue;
      try {
        const watcher = fs.watch(dir, (_event, filename) => {
          // 部分平台只报告目录变化而不给 filename，此时依赖周期 rescan。
          if (filename) {
            this.dirtyFiles.add(path.join(dir, filename));
          }
        });
        watcher.on('error', (err) => {
          logger.warn('fs.watch error, degrading to polling', { dir, error: String(err) });
          watcher.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, watcher);
      } catch (err) {
        logger.warn('failed to create fs.watch, degrading to polling', { dir, error: String(err) });
      }
    }
  }

  /** 取出并清空本轮 dirty 文件，避免同一提示无限重复。 */
  getDirtyFiles(): string[] {
    const files = [...this.dirtyFiles];
    this.dirtyFiles.clear();
    return files;
  }

  /** 由 backpressure/时间片逻辑手动把文件放回下一轮。 */
  addDirty(filePath: string): void {
    this.dirtyFiles.add(filePath);
  }

  /** 唤醒后关闭并重建现有目录 watcher，恢复失效的系统句柄。 */
  rewatch(): void {
    const dirs = [...this.watchers.keys()];
    for (const [, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();
    this.watch(dirs);
  }

  /** 关闭所有 watcher 并丢弃 dirty 状态。 */
  close(): void {
    for (const [, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();
    this.dirtyFiles.clear();
  }
}

/** 从 glob 路径提取父目录并去重，供 watch 建立目录级监听。 */
export function extractParentDirs(patterns: string[]): string[] {
  const dirs = new Set<string>();
  for (const pattern of patterns) {
    dirs.add(path.dirname(pattern));
  }
  return [...dirs];
}
