/**
 * 通用 session JSONL 文件轮询基类。
 *
 * 子类负责发现文件和单行转换；本类为每个绝对路径维护 byte offset/inode，处理 truncate/rotation
 * 并逐行隔离 JSON 错误。复杂的跨行 turn/step 语义（如当前 Codex）会直接继承 BaseInput，
 * 不使用这个“单行即一事件”的简单基类。
 */

import * as fs from 'node:fs/promises';
import { CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseInput, type InputOptions } from './base-input.js';

export interface SessionInputOptions extends InputOptions {
  /** session 文件扫描根目录。 */
  sessionDir: string;
  /** 文件名 pattern，例如 `rollout-*.jsonl`。 */
  filePattern: string;
}

/**
 * 单行独立 session 文件的增量轮询抽象类。
 */
export abstract class BaseSessionInput extends BaseInput {
  readonly collectionMethod = CollectionMethod.SessionFilePolling;

  protected readonly sessionDir: string;
  protected readonly filePattern: string;

  /** 保存扫描根与 pattern；不在构造阶段访问文件系统。 */
  constructor(opts: SessionInputOptions) {
    super(opts);
    this.sessionDir = opts.sessionDir;
    this.filePattern = opts.filePattern;
  }

  /** 顺序处理发现到的文件，保持子类返回顺序。 */
  protected async collect(): Promise<AgentActivityEntry[]> {
    const files = await this.discoverSessionFiles();
    const allEntries: AgentActivityEntry[] = [];

    for (const filePath of files) {
      const entries = await this.processFile(filePath);
      allEntries.push(...entries);
    }
    return allEntries;
  }

  /** 按路径状态 key 增量读取文件，并为 inode/截断变化重置 offset。 */
  private async processFile(filePath: string): Promise<AgentActivityEntry[]> {
    const stateKey = `${this.id}:${filePath}`;
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return [];
    }

    const prevOffset = this.stateStore.getOffset(stateKey);
    const prevState = this.stateStore.get(stateKey);
    const prevInode = prevState.extra?.inode as number | undefined;

    // inode 变化表示路径已指向新文件，从 0 开始消费。
    if (prevInode !== undefined && prevInode !== (stat as any).ino) {
      this.stateStore.setOffset(stateKey, 0);
      this.stateStore.update(stateKey, { extra: { inode: (stat as any).ino } });
    }

    // 同 inode 但 size 变小属于 copytruncate，也需要重置。
    let offset = this.stateStore.getOffset(stateKey);
    if (offset > 0 && stat.size < offset) {
      this.logger.info('file truncated or rotated, resetting offset', {
        file: filePath,
        recorded: offset,
        actual: stat.size,
      });
      offset = 0;
      this.stateStore.setOffset(stateKey, 0);
      this.stateStore.update(stateKey, { extra: { inode: Number((stat as any).ino) } });
    }
    if (stat.size <= offset) return [];

    const handle = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - offset);
      await handle.read(buf, 0, buf.length, offset);
      const text = buf.toString('utf-8');
      // 先推进到本次 stat.size；畸形行不会永久阻塞后续内容。
      this.stateStore.setOffset(stateKey, stat.size);
      this.stateStore.update(stateKey, { extra: { inode: (stat as any).ino } });

      const entries: AgentActivityEntry[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const entry = await this.processSessionLine(parsed, filePath);
          if (entry) entries.push(entry);
        } catch (err) {
          this.logger.warn('invalid session line', { file: filePath, error: String(err) });
        }
      }
      return entries;
    } finally {
      await handle.close();
    }
  }

  /** 发现本轮需要处理的 session 文件。 */
  protected abstract discoverSessionFiles(): Promise<string[]>;

  /** 转换单条已解析 JSON；返回 null 跳过。 */
  protected abstract processSessionLine(
    record: Record<string, unknown>,
    filePath: string,
  ): Promise<AgentActivityEntry | null>;
}
