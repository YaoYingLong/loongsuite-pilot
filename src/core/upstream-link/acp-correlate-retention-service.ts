/**
 * 上游 Trace 关联记录的磁盘与内存保留服务。
 *
 * `Orchestrator` 仅在 upstreamLink 开启时创建本类。它延迟 30 秒首次扫描，之后每
 * 6 小时删除 `<dataDir>/acp-correlate` 中 mtime 超过 TTL 的文件，并让 TraceLinker
 * 同步淘汰空闲 session 缓存。timer 调用 `unref()`，因此不会单独阻止 Node 进程退出；
 * 单文件清理失败只计数和记录，整轮保持 fail-open。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { UpstreamLinkConfig } from '../../types/index.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('AcpCorrelateRetention');

const STARTUP_DELAY_MS = 30_000;
const INTERVAL_MS = 21_600_000; // 每 6 小时扫描一次。

/** 可按与磁盘文件相同 TTL 淘汰内存状态的最小接口，由 TraceLinker 实现。 */
export interface IdlePrunable {
  /** 删除最近访问时间早于绝对 Unix 毫秒 cutoff 的内存条目。 */
  pruneIdle(cutoffMs: number): void;
}

/**
 * 清理 `${dataDir}/acp-correlate/` 下过期关联文件/锁，并按同一 TTL 淘汰可选
 * TraceLinker 的 session 内存状态。周期 timer 已 unref，不会单独维持进程。
 */
export class AcpCorrelateRetentionService {
  /** `<dataDir>/acp-correlate`，由 Orchestrator 在构造本服务前确保存在。 */
  private readonly dir: string;
  /** 磁盘 mtime 与内存 lastAccess 共用的过期时长。 */
  private readonly ttlMs: number;
  /** 通常是 TraceLinker；保持最小接口以便独立测试保留逻辑。 */
  private readonly prunable?: IdlePrunable;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;

  /** @param prunable 可选内存缓存；省略时只清磁盘。 */
  constructor(dataDir: string, config: UpstreamLinkConfig, prunable?: IdlePrunable) {
    this.dir = path.join(dataDir, 'acp-correlate');
    this.ttlMs = config.ttlMs;
    this.prunable = prunable;
  }

  /** 安排延迟首次清理和后续 6 小时间隔；不立即扫描以降低启动 I/O 峰值。 */
  start(): void {
    logger.info('scheduling acp-correlate retention', { ttlMs: this.ttlMs });
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      // 回调不能 await；runCleanup 将逐文件错误转换为计数。极端慢 I/O 下周期可能重叠，
      // 当前没有 in-flight 锁，但默认 6 小时间隔使这种情况通常不会发生。
      void this.runCleanup();
      this.intervalTimer = setInterval(() => void this.runCleanup(), INTERVAL_MS);
      this.intervalTimer.unref();
    }, STARTUP_DELAY_MS);
    this.startupTimer.unref();
  }

  /** 取消尚未触发的启动 timer 与周期 timer；已经开始的 runCleanup 不会被中止。 */
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
   * 清理 mtime 早于截止点的普通文件，并同步淘汰内存缓存。
   * @returns 删除数和逐文件错误数；目录不存在时均为 0。
   */
  async runCleanup(): Promise<{ deleted: number; errors: number }> {
    // cutoff 是绝对 Unix 毫秒，TraceLinker.lastAccessMs 与 fs.stat.mtimeMs 可直接比较。
    const cutoff = Date.now() - this.ttlMs;
    let deleted = 0;
    let errors = 0;

    // 内存状态使用相同 TTL 独立淘汰，不依赖对应磁盘文件是否仍然存在。
    try {
      this.prunable?.pruneIdle(cutoff);
    } catch (err) {
      logger.warn('failed to prune idle upstream-link state', { error: String(err) });
    }

    let files: string[];
    try {
      files = await fs.readdir(this.dir);
    } catch {
      return { deleted, errors }; // 目录不存在，直接按“无内容可清理”返回。
    }

    for (const file of files) {
      // path.join 仅拼接 readdir 返回的目录项；不会递归进入子目录。
      const full = path.join(this.dir, file);
      try {
        const stat = await fs.stat(full);
        // 非普通文件（目录、设备等）以及 TTL 内文件全部保留；锁文件只要是普通文件也按 mtime 清。
        if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
        await fs.unlink(full);
        deleted++;
      } catch (err) {
        logger.warn('failed to clean correlation file', { file: full, error: String(err) });
        errors++;
      }
    }

    if (deleted > 0 || errors > 0) {
      logger.info('acp-correlate retention complete', { deleted, errors });
    }
    return { deleted, errors };
  }
}
