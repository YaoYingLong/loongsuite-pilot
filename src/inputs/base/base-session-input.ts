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
  /** 文件名 pattern，例如 `rollout-*.jsonl`；匹配规则由具体子类实现。 */
  filePattern: string;
}

/**
 * 单行独立 session 文件的增量轮询抽象类。
 */
export abstract class BaseSessionInput extends BaseInput {
  readonly collectionMethod = CollectionMethod.SessionFilePolling;

  protected readonly sessionDir: string;
  protected readonly filePattern: string;

  /**
   * 保存扫描根与 pattern；不在构造阶段访问文件系统。
   * @param opts BaseInput 依赖、session 根目录和文件名 pattern。
   */
  constructor(opts: SessionInputOptions) {
    super(opts);
    this.sessionDir = opts.sessionDir;
    this.filePattern = opts.filePattern;
  }

  /**
   * 先发现文件，再逐文件串行处理并拼接结果。
   *
   * 串行 `await` 避免多个大 session 同时分配整段 Buffer，也保持 `discoverSessionFiles()` 的顺序。
   * 文件级 stat/open 异常的处理方式由 `processFile()` 决定。
   */
  protected async collect(): Promise<AgentActivityEntry[]> {
    const files = await this.discoverSessionFiles();
    const allEntries: AgentActivityEntry[] = [];

    for (const filePath of files) {
      const entries = await this.processFile(filePath);
      allEntries.push(...entries);
    }
    return allEntries;
  }

  /**
   * 按 `<inputId>:<filePath>` 状态 key 增量读取一个文件，并处理 inode/截断变化。
   *
   * `stat.size` 固定本轮边界，并发追加留到下轮；文件句柄在 finally 中关闭。offset 在逐行解析
   * 前推进到该边界，所以坏 JSON、转换异常以及末尾尚未写完的半行都不会重试。这种基类只适合
   * writer 每次原子追加完整 JSONL 行的简单 session；需要断行缓存的来源应使用专用 Input。
   */
  private async processFile(filePath: string): Promise<AgentActivityEntry[]> {
    const stateKey = `${this.id}:${filePath}`;
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return [];
    }

    // 当前读取值未参与后续计算；真正使用的 offset 会在 inode 检查后重新读取，此变量用途待确认。
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
    // 等于表示没有新增；小于已在上面按 copytruncate 重置，不会落入这里。
    if (stat.size <= offset) return [];

    const handle = await fs.open(filePath, 'r');
    try {
      // Buffer 长度使用字节差，不能用字符串字符数代替，中文在 UTF-8 下通常占多个字节。
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

  /**
   * 发现本轮需要处理的 session 文件。
   * @returns Promise 兑现为文件路径列表；建议返回稳定顺序，基类不会额外排序。
   */
  protected abstract discoverSessionFiles(): Promise<string[]>;

  /**
   * 转换单条已解析 JSON。
   * @param record JSON.parse 得到的对象。
   * @param filePath 记录来源文件，供提取 session ID 或补充 source 属性。
   * @returns 标准事件；null 表示有意跳过。
   * @throws 异常被当前行的 catch 隔离，该行 offset 已经推进。
   */
  protected abstract processSessionLine(
    record: Record<string, unknown>,
    filePath: string,
  ): Promise<AgentActivityEntry | null>;
}
