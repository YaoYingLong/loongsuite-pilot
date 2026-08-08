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

/**
 * 管理多个父目录 watcher 和一次性 dirty 文件集合。
 *
 * `fs.watch` 事件只是一种低延迟提示：不同平台可能合并、重复甚至漏掉事件，filename 也可能
 * 为空。因此本类不读取文件、不判断 offset；FilePipeline 会把 dirty 集合与活跃 reader、周期
 * 全量扫描合并。`Set` 自动折叠同一路径的重复提示。
 */
export class FileWatcher {
  private watchers: Map<string, fs.FSWatcher> = new Map();
  private dirtyFiles: Set<string> = new Set();

  /**
   * 为尚未监听的唯一目录创建 watcher；单目录失败不影响其他目录。
   *
   * watcher 回调由 Node.js 事件循环异步触发，只把路径加入 Set，不在回调中执行文件 I/O。
   * 运行期 `error` 会关闭并移除对应句柄，使后续数据发现退化到 Pipeline 的 rescan。
   */
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

  /**
   * 以“快照后清空”的方式取出本轮 dirty 文件。
   *
   * 返回新数组，调用方处理期间新到达的 watch 事件会进入已清空的 Set，留给下一轮，不会混入
   * 当前遍历；如果处理被背压推迟，FilePipeline 会通过 `addDirty()` 主动放回。
   */
  getDirtyFiles(): string[] {
    const files = [...this.dirtyFiles];
    this.dirtyFiles.clear();
    return files;
  }

  /** 由 backpressure/时间片逻辑手动把文件放回下一轮。 */
  addDirty(filePath: string): void {
    this.dirtyFiles.add(filePath);
  }

  /**
   * 系统唤醒后关闭并重建现有目录 watcher，恢复可能失效的 OS 句柄。
   *
   * 只重建当前成功登记的目录；之前创建失败的目录仍依靠全量扫描，除非外层重新调用 watch。
   */
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

/**
 * 从 glob 路径提取父目录并去重，供 `fs.watch` 建立目录级监听。
 *
 * glob 只作用于 basename，watcher 本身监听父目录；真正是否匹配仍由 FilePipeline 的正则判断。
 */
export function extractParentDirs(patterns: string[]): string[] {
  const dirs = new Set<string>();
  for (const pattern of patterns) {
    dirs.add(path.dirname(pattern));
  }
  return [...dirs];
}
