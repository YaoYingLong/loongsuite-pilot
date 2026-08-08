/**
 * 普通文件增量采集 Pipeline 的生命周期编排器。
 *
 * 它组合 FileWatcher（变化提示）、FileTailer（rotation/checkpoint/按行读取）、FileSlsSender
 * （缓冲与 WebTracking）和独立 StateStore。该链路不生成 AgentActivityEntry，也不经过
 * InputManager；每行原文作为 `{content}` 直接上报配置的 SLS。
 */

import * as path from 'node:path';
import type { PipelineConfig, FileCheckpoint, FilePipelineOptions, Pipeline, WakeEvent } from '../../types.js';
import { FileTailer, globToRegex } from './file-tailer.js';
import { FileSlsSender } from '../../flusher/file/file-sls-sender.js';
import { FileWatcher, extractParentDirs } from './file-watcher.js';
import { StateStore } from '../../../checkpoints/state-store.js';
import { createLogger } from '../../../utils/logger.js';
import { ensureDir } from '../../../utils/fs-utils.js';

/**
 * 从 FileTailer 的 reader checkpoint key 还原原始路径。
 * reader 队列 key 可能追加两个 `*` 分隔字段；格式不完整时返回 null。
 */
export function parseCheckpointKey(key: string): string | null {
  const lastStar = key.lastIndexOf('*');
  if (lastStar === -1) return key;
  const secondLastStar = key.lastIndexOf('*', lastStar - 1);
  if (secondLastStar === -1) return null;
  return key.substring(0, secondLastStar);
}

/** poll、完整 rescan、单文件时间片和签名大小的固定保护值。 */
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const RESCAN_INTERVAL_MS = 30_000;
const READ_TIME_SLICE_MS = 50;
const SIGNATURE_BYTES = 1024;

/** 管理单份 input_file 配置从发现、增量读取到 SLS 发送的完整生命周期。 */
export class FilePipeline implements Pipeline {
  private readonly config: PipelineConfig;
  private readonly tailer: FileTailer;
  private readonly sender: FileSlsSender;
  private readonly fileWatcher: FileWatcher;
  private readonly stateStore: StateStore;
  private readonly stateFilePath: string;
  private readonly logger;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private polling = false;
  /** sender 拒收后暂存在内存的行；checkpoint 已前移，因此必须优先重试。 */
  private readonly pendingLines: Map<string, string[]> = new Map();
  private lastRescanTime = 0;
  private readonly patternMatchers: { dir: string; regex: RegExp }[];

  /**
   * 校验第一 input 类型，创建 tailer/sender/watcher/state，并预编译 glob basename 正则。
   * @throws 配置不是 input_file 时抛出，由 PipelineManager 记录并跳过该 Pipeline。
   */
  constructor(opts: FilePipelineOptions) {
    this.config = opts.config;
    this.logger = createLogger(`FilePipeline:${opts.config.configName}`);

    const input = opts.config.inputs[0];
    if (input.Type !== 'input_file') {
      throw new Error(`FilePipeline expects input_file, got ${input.Type}`);
    }

    this.tailer = new FileTailer({
      filePaths: input.FilePaths,
      encoding: input.FileEncoding,
      maxDirSearchDepth: input.MaxDirSearchDepth,
    });

    // 每个 pattern 只匹配同一父目录下的 basename，不递归借助 watcher 猜测。
    this.patternMatchers = input.FilePaths.map((p) => ({
      dir: path.dirname(p),
      regex: globToRegex(path.basename(p)),
    }));

    const flusher = opts.config.flushers[0];
    this.sender = new FileSlsSender(
      flusher,
      opts.config.configName,
      opts.failedLogDir,
      opts.dataDir,
    );

    this.fileWatcher = new FileWatcher();

    this.stateFilePath = path.join(opts.stateDir, `${opts.config.configName}.json`);
    this.stateStore = new StateStore(this.stateFilePath);
  }

  /** 恢复 checkpoint、建立 watcher、启动 sender，首轮同步 poll 后创建周期任务。 */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await ensureDir(path.dirname(this.stateFilePath));
    await this.stateStore.load();
    await this.loadCheckpoints();

    const input = this.config.inputs[0];
    if (input.Type !== 'input_file') {
      throw new Error(`FilePipeline expects input_file, got ${input.Type}`);
    }
    const parentDirs = extractParentDirs(input.FilePaths);
    this.fileWatcher.watch(parentDirs);

    this.sender.start();
    await this.pollCycle();
    this.pollTimer = setInterval(
      () => void this.pollCycle(),
      DEFAULT_POLL_INTERVAL_MS,
    );

    this.logger.info('started', { configName: this.config.configName });
  }

  /**
   * 系统唤醒后刷新 reader 活跃时间、重建 watcher、强制下轮 rescan 并保存状态。
   * 错误被记录但不会停止 Pipeline，最后异步触发一次 poll。
   */
  async handleWake(event?: WakeEvent): Promise<void> {
    if (!this.running) return;

    try {
      this.tailer.refreshReaderTimestamps();

      this.fileWatcher.rewatch();

      this.lastRescanTime = 0;

      this.saveCheckpoints();
      await this.stateStore.save();
    } catch (err) {
      this.logger.error('wake recovery failed', {
        configName: this.config.configName,
        error: String(err),
      });
    }

    this.logger.info('wake recovery complete', { configName: this.config.configName });

    void this.pollCycle();
  }

  /** 停止新 poll，关闭 watcher，把 pending 尽量入队，排空 sender 并持久化 checkpoint。 */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.fileWatcher.close();

    for (const [filePath, lines] of this.pendingLines) {
      this.sender.enqueue(lines, filePath);
    }
    this.pendingLines.clear();

    await this.sender.shutdown();
    this.saveCheckpoints();
    await this.stateStore.save();

    this.logger.info('stopped', { configName: this.config.configName });
  }

  /**
   * 单轮串行轮询。dirty、活跃 reader 和 30 秒 rescan 三个来源合并去重；每文件最多读取
   * 50ms，sender 高水位时只检查 rotation 并延后，防止单个热文件饿死其他文件。
   */
  private async pollCycle(): Promise<void> {
    // running/polling 双门控保证 setInterval 与 wake 不会让状态并发修改。
    if (!this.running || this.polling) return;
    this.polling = true;

    try {
      const filesToProcess = new Set<string>();

      const dirtyFiles = this.fileWatcher.getDirtyFiles();
      for (const f of dirtyFiles) {
        if (this.matchesPattern(f)) {
          filesToProcess.add(f);
        }
      }

      // 活跃 reader 即使没有 fs.watch 事件也参与轮询，兼容事件合并/丢失的平台。
      for (const f of this.tailer.getActiveFiles()) {
        if (this.matchesPattern(f)) {
          filesToProcess.add(f);
        }
      }

      // 周期全量发现是 watcher 失败和新 glob 文件出现的最终兜底。
      const now = Date.now();
      if (now - this.lastRescanTime >= RESCAN_INTERVAL_MS) {
        this.lastRescanTime = now;
        const discovered = this.tailer.discoverFiles();
        for (const f of discovered) {
          filesToProcess.add(f);
        }
      }

      for (const filePath of filesToProcess) {
        if (!this.running) return;

        try {
          const pending = this.pendingLines.get(filePath);
          if (pending) {
            // pending 对应已经从 tailer 读出的行，必须先入 sender 才能继续推进此文件。
            const accepted = this.sender.enqueue(pending, filePath);
            if (!accepted) {
              this.fileWatcher.addDirty(filePath);
              await this.tailer.checkRotation(filePath);
              continue;
            }
            this.pendingLines.delete(filePath);
          }

          if (this.sender.isBackpressured()) {
            await this.tailer.checkRotation(filePath);
            this.fileWatcher.addDirty(filePath);
            this.logger.debug('backpressure active, deferring file', {
              file: filePath,
              bufferSize: this.sender.bufferSize(),
            });
            continue;
          }

          const sliceStart = Date.now();
          let hasMore = true;

          while (hasMore && Date.now() - sliceStart < READ_TIME_SLICE_MS) {
            const result = await this.tailer.readNewLines(filePath);

            hasMore = result.hasMore;

            if (result.lines.length > 0) {
              const accepted = this.sender.enqueue(result.lines, filePath);
              if (!accepted) {
                // sender 达硬上限时保存本批，并把文件重新标脏供下轮首先重试。
                this.pendingLines.set(filePath, result.lines);
                this.fileWatcher.addDirty(filePath);
                break;
              }
            }
          }

          if (hasMore) {
            this.fileWatcher.addDirty(filePath);
          }
        } catch (err) {
          this.logger.warn('error reading file', {
            file: filePath,
            error: String(err),
          });
        }
      }

      this.tailer.cleanupStaleReaders();
      // 每轮结束把所有 reader 队列状态同步到 StateStore 并原子保存。
      this.saveCheckpoints();
      await this.stateStore.save();
    } catch (err) {
      this.logger.error('poll cycle failed', { error: String(err) });
    } finally {
      this.polling = false;
    }
  }

  /** 判断路径父目录和 basename 是否命中任一预编译配置 pattern。 */
  private matchesPattern(filePath: string): boolean {
    const dir = path.dirname(filePath);
    const name = path.basename(filePath);
    return this.patternMatchers.some((m) => dir === m.dir && m.regex.test(name));
  }

  /** 从 StateStore 恢复 checkpoint，并让 FileTailer 校验 inode/dev/签名。 */
  private async loadCheckpoints(): Promise<void> {
    const allKeys = this.stateStore.keys();
    for (const key of allKeys) {
      const filePath = parseCheckpointKey(key);
      if (!filePath || !this.matchesPattern(filePath)) continue;

      const state = this.stateStore.get(key);
      if (state.lastOffset !== undefined && state.extra?.inode !== undefined) {
        const cp: FileCheckpoint = {
          offset: state.lastOffset,
          inode: state.extra.inode as number,
          dev: (state.extra.dev as number) || 0,
          // 兼容旧 checkpoint 的 signature 字段名。
          signatureHash: (state.extra.signatureHash as string) || (state.extra.signature as string) || '',
          signatureSize: (state.extra.signatureSize as number) || SIGNATURE_BYTES,
          lastUpdateTime: (state.extra.lastUpdateTime as number) || Date.now(),
          cache: (state.extra.cache as string) || '',
        };
        const restored = await this.tailer.initReaderFromCheckpoint(filePath, cp);
        if (!restored) {
          this.logger.info('checkpoint discarded', { key, reason: 'validation failed' });
        }
      }
    }
  }

  /** 用 tailer 当前全部 reader 状态覆盖 StateStore，并删除已不存在的旧 key。 */
  private saveCheckpoints(): void {
    const allCheckpoints = this.tailer.getAllReaderCheckpoints();
    const currentKeys = new Set<string>();

    for (const [key, cp] of allCheckpoints) {
      currentKeys.add(key);
      this.stateStore.update(key, {
        lastOffset: cp.offset,
        extra: {
          inode: cp.inode,
          dev: cp.dev,
          signatureHash: cp.signatureHash,
          signatureSize: cp.signatureSize,
          lastUpdateTime: cp.lastUpdateTime,
          cache: cp.cache,
        },
      });
    }

    for (const existingKey of this.stateStore.keys()) {
      if (!currentKeys.has(existingKey)) {
        this.stateStore.delete(existingKey);
      }
    }
  }
}
