/**
 * IDE history/DiskKV 快照轮询基类。
 *
 * SnapshotStore 以“文件+源时间+Agent”去重并保留 pending/processed 状态。子类扫描原始
 * CodeGenerationEvent 并转换；只有成功构建的事件才标记 processed，停止时强制 flush 快照。
 */

import { CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry, CodeGenerationEvent } from '../../types/index.js';
import { SnapshotStore } from '../../checkpoints/snapshot-store.js';
import { BaseInput, type InputOptions } from './base-input.js';

export interface IdeInputOptions extends InputOptions {
  /** IDE 数据根，例如 Qoder Application Support。 */
  dataRoot: string;
  /** 独立 SnapshotStore JSON 路径。 */
  snapshotStorePath: string;
  snapshotRetentionMs?: number;
}

/**
 * IDE 快照轮询的抽象生命周期。
 */
export abstract class BaseIdeInput extends BaseInput {
  readonly collectionMethod = CollectionMethod.IdeSnapshotPolling;

  protected readonly dataRoot: string;
  protected readonly snapshotStore: SnapshotStore;

  /** 构造独立 SnapshotStore；实际文件读取延迟到 onStart。 */
  constructor(opts: IdeInputOptions) {
    super(opts);
    this.dataRoot = opts.dataRoot;
    this.snapshotStore = new SnapshotStore(
      opts.snapshotStorePath,
      opts.snapshotRetentionMs,
    );
  }

  /** 启动前恢复去重快照。 */
  protected override async onStart(): Promise<void> {
    await this.snapshotStore.load();
  }

  /** 停止时等待快照原子落盘。 */
  protected override async onStop(): Promise<void> {
    await this.snapshotStore.flush();
  }

  /** 按建议起点扫描、去重、转换并持久化快照。 */
  protected async collect(): Promise<AgentActivityEntry[]> {
    const sinceTs = this.snapshotStore.getSuggestedSinceTimestamp();
    const rawEvents = await this.scanHistoryEntries(sinceTs);
    const entries: AgentActivityEntry[] = [];

    for (const event of rawEvents) {
      const key = this.buildSnapshotKey(event);
      if (!this.snapshotStore.shouldProcess(key)) continue;

      // 先标 pending；构建抛错时不标 processed，保留后续恢复可能。
      this.snapshotStore.markPending(key, event.sourceTimestamp);
      try {
        const entry = await this.buildEntry(event);
        if (entry) {
          entries.push(entry);
          this.snapshotStore.markProcessed(key);
        }
      } catch (err) {
        this.logger.warn('failed to build entry', { key, error: String(err) });
      }
    }

    await this.snapshotStore.flush();
    return entries;
  }

  /**
   * 扫描 `sinceTs` 之后的 IDE 原始活动。
   */
  protected abstract scanHistoryEntries(sinceTs: number): Promise<CodeGenerationEvent[]>;

  /**
   * 把原始活动转为标准事件；返回 null 表示跳过且不会标 processed。
   */
  protected abstract buildEntry(event: CodeGenerationEvent): Promise<AgentActivityEntry | null>;

  /** 构造同一 Agent/文件/源时间的稳定去重 key。 */
  protected buildSnapshotKey(event: CodeGenerationEvent): string {
    return `${event.filePath}@@${event.sourceTimestamp}@@${event.agentType}`;
  }
}
