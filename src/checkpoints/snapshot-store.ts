/**
 * 面向快照式数据源的去重状态仓库。
 *
 * 本模块按业务 key 记录对象是否已处理，并维护已成功处理数据的时间高水位。
 * IDE 历史快照等 Input 在发现数据时先标记 pending，成功后标记 processed，
 * 再由 `flush()` 将内存 Map 原子写入 JSON。保留期外的去重记录会被清理。
 * 它与保存线性字节偏移或 row id 的 `StateStore` 分工互补。
 */

import { createLogger, type BoundLogger } from '../utils/logger.js';
import { readJsonFile, writeJsonFile } from '../utils/fs-utils.js';

export interface SnapshotEntry {
  key: string;
  timestamp: number;
  seenAt: number;
  status: 'pending' | 'processed';
  reason?: string;
}

/** 磁盘结构：内存 Map 会被序列化为 entries 数组。 */
interface SnapshotStoreData {
  highWatermark: number;
  entries: SnapshotEntry[];
}

/** 只用 processed 条目重算高水位，pending 数据不能让后续查询跳过未完成对象。 */
function rebuildHighWatermark(entries: Map<string, SnapshotEntry>): number {
  let max = 0;
  for (const e of entries.values()) {
    if (e.status === 'processed' && e.timestamp > max) {
      max = e.timestamp;
    }
  }
  return max;
}

/**
 * 面向“对象快照”而非线性偏移的持久化去重仓库。
 *
 * Orchestrator 创建后把它交给快照式 Input；Input 先 `markPending()` 防止并发重复，
 * 成功处理后 `markProcessed()`，并在采集轮次或退出时 `flush()`。成员 Map 和高水位
 * 只在当前 Node.js 进程内共享，磁盘文件负责跨重启恢复；本类不创建 timer 或子进程。
 * 文件读写异常由 Promise 向调用方传播，以便采集循环决定记录或重试。
 */
export class SnapshotStore {
  private readonly entries: Map<string, SnapshotEntry> = new Map();
  private highWatermark = 0;
  private readonly retentionMs: number;
  private readonly filePath: string;
  private readonly logger: BoundLogger;
  private dirty = false;

/**
 * @param filePath 快照状态 JSON 的绝对路径。
 * @param retentionMs 去重条目保留毫秒数，默认 7 天；也决定建议查询窗口下限。
 */
  constructor(
    filePath: string,
    retentionMs: number = 7 * 24 * 60 * 60 * 1000
  ) {
    this.filePath = filePath;
    this.retentionMs = retentionMs;
    this.logger = createLogger('SnapshotStore');
  }

/**
 * 从磁盘恢复条目并重新计算高水位。非法 status 按 pending 处理，避免误判为已消费。
 * @returns 恢复完成后兑现的 Promise；首次运行缺少文件时得到空仓库。
 */
  async load(): Promise<void> {
    const data = await readJsonFile<SnapshotStoreData | null>(this.filePath);
    this.entries.clear();
    if (!data || !Array.isArray(data.entries)) {
      this.highWatermark = 0;
      this.dirty = false;
      return;
    }
    for (const raw of data.entries) {
      if (!raw || typeof raw.key !== 'string') {
        continue;
      }
      const status =
        raw.status === 'pending' || raw.status === 'processed'
          ? raw.status
          : 'pending';
      this.entries.set(raw.key, {
        key: raw.key,
        timestamp: Number(raw.timestamp) || 0,
        seenAt: Number(raw.seenAt) || 0,
        status,
        reason: typeof raw.reason === 'string' ? raw.reason : undefined,
      });
    }
    this.highWatermark = rebuildHighWatermark(this.entries);
    this.dirty = false;
  }

/**
 * 先清理过期条目、重算高水位，再在 dirty 时原子写盘。
 * @throws 写入失败时透传文件系统异常，dirty 保持为 true 供下次重试。
 */
  async flush(): Promise<void> {
    this.prune();
    this.highWatermark = rebuildHighWatermark(this.entries);
    if (!this.dirty) {
      return;
    }
    const payload: SnapshotStoreData = {
      highWatermark: this.highWatermark,
      entries: Array.from(this.entries.values()),
    };
    await writeJsonFile(this.filePath, payload);
    this.dirty = false;
  }

/** key 从未出现过时才返回 true；pending 也可阻止进程内重复并发处理。 */
  shouldProcess(key: string): boolean {
    return !this.entries.has(key);
  }

/** 登记待处理对象并记录本地 seenAt；只改内存。 */
  markPending(key: string, timestamp: number): void {
    const now = Date.now();
    this.entries.set(key, {
      key,
      timestamp,
      seenAt: now,
      status: 'pending',
    });
    this.dirty = true;
  }

/**
 * 把已登记对象标为 processed 并推进高水位；未知 key 只记录警告，不自动创建。
 * @param reason 可选诊断原因；未传时保留旧值。
 */
  markProcessed(key: string, reason?: string): void {
    const entry = this.entries.get(key);
    if (!entry) {
      this.logger.warn('markProcessed: unknown key', { key });
      return;
    }
    const next: SnapshotEntry = {
      ...entry,
      status: 'processed',
      reason: reason !== undefined ? reason : entry.reason,
    };
    this.entries.set(key, next);
    this.highWatermark = Math.max(this.highWatermark, next.timestamp);
    this.dirty = true;
  }

/**
 * 返回查询 since：取“成功高水位”和“当前时间减保留期”中较新者。
 */
  getSuggestedSinceTimestamp(): number {
    const floor = Date.now() - this.retentionMs;
    return Math.max(this.highWatermark, floor);
  }

/** 当前内存中 pending 与 processed 条目总数。 */
  get size(): number {
    return this.entries.size;
  }

/** 按 seenAt 删除保留期外条目；实际删除才设置 dirty。 */
  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.seenAt > this.retentionMs) {
        this.entries.delete(key);
        this.dirty = true;
      }
    }
  }
}
