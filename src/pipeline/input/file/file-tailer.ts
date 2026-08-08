/**
 * 支持 rotation、断行缓存和 checkpoint 恢复的增量文件读取器。
 *
 * 每个逻辑路径维护 reader 队列：rename rotation 后旧 inode 继续读完，新 inode 从 0 开始；
 * copytruncate 则重置当前 reader。单次最多读 4 MiB，未换行尾部缓存到下一轮，checkpoint 同时
 * 保存 dev/inode 和文件头签名，防止 inode 复用导致错位续读。
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { FileCheckpoint, FileReaderState, DevInode } from '../../types.js';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('FileTailer');

/** 读取/发现/队列/超时和断行缓存的资源上限。 */
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_FILES_PER_CYCLE = 100;
const SIGNATURE_BYTES = 1024;
const MAX_READER_QUEUE_LENGTH = 20;
const READER_TIMEOUT_MS = 3_600_000;
const MAX_CACHE_BYTES = 1024 * 1024;

/** 单次读取结果；hasMore 也表示队列中还有旧 reader 待处理。 */
export interface ReadResult {
  /** 本轮读到且以换行符结束的完整非空文本行。 */
  lines: string[];
  /** 当前逻辑路径最新 reader 的可持久化位置，用于进程重启后恢复。 */
  checkpoint: FileCheckpoint;
  /** 当前物理文件仍有未读字节，或 rotation 队列中还有 reader 等待处理。 */
  hasMore: boolean;
}

/**
 * 按逻辑路径管理一个或多个物理 inode reader 的增量 tailer。
 *
 * `readerQueues` 的 key 是配置中发现的当前路径，value 按“旧文件到新文件”排序。例如应用把
 * `app.log` rename 为 `app.log.1` 并立即创建新 `app.log` 后，旧 inode reader 位于队首，
 * 新 inode reader 位于队尾。读取时必须先排空旧文件，否则 rotation 边界附近的数据会丢失。
 *
 * 本类没有后台 timer。FilePipeline 在正常轮询、背压暂停、系统唤醒和定期清理时分别调用其
 * 方法；所有文件句柄都在单次方法调用的 `finally` 中关闭。
 */
export class FileTailer {
  private readonly filePaths: string[];
  private readonly encoding: BufferEncoding;
  private readonly maxDirSearchDepth: number;
  private readerQueues: Map<string, FileReaderState[]> = new Map();

  /**
   * 保存 glob 路径和读取限制；构造时不扫描磁盘。
   *
   * @param opts `filePaths` 可包含 `*`；`encoding` 默认 UTF-8；`maxDirSearchDepth` 为递归层数。
   */
  constructor(opts: {
    filePaths: string[];
    encoding?: string;
    maxDirSearchDepth?: number;
  }) {
    this.filePaths = opts.filePaths;
    this.encoding = (opts.encoding as BufferEncoding) || 'utf8';
    this.maxDirSearchDepth = opts.maxDirSearchDepth ?? 0;
  }

  /**
   * 按所有 glob 同步发现普通文件，整个周期最多返回 100 个稳定排序结果。
   *
   * 这是同步文件系统操作，调用方应在低频轮询周期中使用。达到上限立即停止后续 pattern，
   * 防止一个过宽 glob 长时间占用 Node.js 主线程。
   *
   * @returns 按 pattern 顺序拼接、且各 pattern 内排序的路径；重叠 pattern 可能返回重复路径。
   */
  discoverFiles(): string[] {
    const result: string[] = [];
    for (const pattern of this.filePaths) {
      const matched = matchGlob(pattern, this.maxDirSearchDepth);
      result.push(...matched);
      if (result.length >= MAX_FILES_PER_CYCLE) break;
    }
    return result.slice(0, MAX_FILES_PER_CYCLE);
  }

  /**
   * 校验 checkpoint 的文件存在、dev/inode 和可选头签名后恢复 reader。
   *
   * `dev + inode` 是 Unix 文件身份；文件路径相同不代表仍是同一物理文件。操作系统也可能在
   * 删除后复用 inode，所以保存的前 1 KiB MD5 签名提供第二重校验。任何校验失败都选择从
   * 当前文件重新建 reader，而不是冒险从旧 offset 跳过新内容。
   *
   * @param filePath checkpoint 所属的逻辑文件路径。
   * @param checkpoint StateStore 恢复出的字节位置、文件身份和半行缓存。
   * @returns 校验成功为 true；无效 checkpoint 不修改队列并返回 false。
   */
  async initReaderFromCheckpoint(filePath: string, checkpoint: FileCheckpoint): Promise<boolean> {
    let stat: fsSync.Stats;
    try {
      stat = await fs.stat(filePath);
    } catch {
      logger.info('checkpoint file no longer exists, skipping', { file: filePath });
      return false;
    }

    if (stat.dev !== checkpoint.dev || stat.ino !== checkpoint.inode) {
      logger.info('checkpoint dev/inode mismatch, skipping', {
        file: filePath,
        checkpointDev: checkpoint.dev,
        checkpointInode: checkpoint.inode,
        actualDev: stat.dev,
        actualInode: stat.ino,
      });
      return false;
    }

    // dev/inode 匹配仍可能是 inode 复用，头部签名提供第二层验证。
    if (checkpoint.signatureHash) {
      const currentSig = await computeFileSignature(filePath);
      if (currentSig && currentSig !== checkpoint.signatureHash) {
        logger.info('inode reused (signature mismatch), discarding checkpoint', {
          file: filePath,
          inode: checkpoint.inode,
          savedSig: checkpoint.signatureHash,
          currentSig,
        });
        return false;
      }
    }

    const reader: FileReaderState = {
      filePath,
      devInode: { dev: checkpoint.dev, ino: checkpoint.inode },
      offset: checkpoint.offset,
      signatureHash: checkpoint.signatureHash,
      lastUpdateTime: checkpoint.lastUpdateTime || Date.now(),
      cache: checkpoint.cache || '',
      deleted: false,
      deletedTime: 0,
    };

    const existing = this.readerQueues.get(filePath);
    if (existing) {
      existing.push(reader);
    } else {
      this.readerQueues.set(filePath, [reader]);
    }
    return true;
  }

  /** 返回所有当前有 reader 队列的逻辑路径。 */
  getActiveFiles(): string[] {
    return [...this.readerQueues.keys()];
  }

  /**
   * 只返回每个逻辑路径最新 reader 的 checkpoint。
   *
   * 旧接口无法表达 rotation 后并存的多个 inode，因而仅为兼容调用保留；需要完整恢复能力的
   * 调用方应使用 `getAllReaderCheckpoints()`。
   */
  getCheckpoints(): Map<string, FileCheckpoint> {
    const result = new Map<string, FileCheckpoint>();
    for (const [filePath, queue] of this.readerQueues) {
      const latestReader = queue[queue.length - 1];
      if (latestReader) {
        result.set(filePath, this.readerToCheckpoint(latestReader));
      }
    }
    return result;
  }

  /**
   * 返回所有旧/新 reader checkpoint，key 追加 dev/inode 以区分 rotation 队列。
   *
   * 返回的是新 Map 和新 checkpoint 对象，调用方持久化或修改结果不会直接改变 reader 状态。
   */
  getAllReaderCheckpoints(): Map<string, FileCheckpoint> {
    const result = new Map<string, FileCheckpoint>();
    for (const [filePath, queue] of this.readerQueues) {
      for (const reader of queue) {
        const key = `${filePath}*${reader.devInode.dev}*${reader.devInode.ino}`;
        result.set(key, this.readerToCheckpoint(reader));
      }
    }
    return result;
  }

  /**
   * 确保 reader 存在、检测 rotation，再从队首 reader 读取完整行。
   * 可选 checkpoint 只在该路径尚无队列时尝试恢复。
   *
   * 调用顺序很重要：先恢复/新建 reader，再检测路径当前 inode，最后消费队列。若在恢复前
   * 检测 rotation，就无法把 checkpoint 指向的旧 inode 与刚创建的新文件正确排进同一队列。
   *
   * @param filePath watcher/discovery 发现的当前逻辑路径。
   * @param checkpoint 可选的磁盘恢复状态；已有内存队列时忽略它，避免重复 reader。
   * @returns 一批完整行、最新 checkpoint 和是否应立即继续读取的标志。
   */
  async readNewLines(filePath: string, checkpoint?: FileCheckpoint | null): Promise<ReadResult> {
    if (checkpoint && !this.readerQueues.has(filePath)) {
      await this.initReaderFromCheckpoint(filePath, checkpoint);
    }

    let queue = this.readerQueues.get(filePath);

    if (!queue || queue.length === 0) {
      let stat: fsSync.Stats;
      try {
        stat = await fs.stat(filePath);
      } catch {
        return this.emptyResult();
      }
      const sig = await computeFileSignature(filePath);
      // 首次发现新文件从 offset 0 开始，并记录文件头签名。
      const reader: FileReaderState = {
        filePath,
        devInode: { dev: stat.dev, ino: stat.ino },
        offset: 0,
        signatureHash: sig,
        lastUpdateTime: Date.now(),
        cache: '',
        deleted: false,
        deletedTime: 0,
      };
      queue = [reader];
      this.readerQueues.set(filePath, queue);
    }

    await this.detectRotation(filePath, queue);

    return this.processQueue(filePath, queue);
  }

  /**
   * 背压暂停读取期间仍检测 rotation，避免错过旧 inode。
   *
   * Sender 队列满时 FilePipeline 不应继续产生行，但日志文件仍可能 rotate。此方法只更新
   * reader 队列，不读正文，因此既保住旧 inode，又不会绕过背压产生更多待发送数据。
   */
  async checkRotation(filePath: string): Promise<void> {
    const queue = this.readerQueues.get(filePath);
    if (!queue || queue.length === 0) return;
    await this.detectRotation(filePath, queue);
  }

  /** 系统唤醒后刷新所有 reader 时间，避免把睡眠时长误判为一小时无活动。 */
  refreshReaderTimestamps(): void {
    const now = Date.now();
    for (const [, queue] of this.readerQueues) {
      for (const reader of queue) {
        reader.lastUpdateTime = now;
        if (reader.deleted) {
          reader.deletedTime = now;
        }
      }
    }
  }

  /**
   * 删除超过一小时未活动的 reader，限制长时间运行进程的内存占用。
   *
   * 已标记删除的 reader 同时检查 `deletedTime` 和 `lastUpdateTime`，给 rename 后暂时找不到的
   * 文件留出恢复窗口；清空的队列连同 Map key 一起移除。
   */
  cleanupStaleReaders(): void {
    const now = Date.now();
    for (const [filePath, queue] of this.readerQueues) {
      const filtered = queue.filter((reader) => {
        if (reader.deleted && now - reader.deletedTime > READER_TIMEOUT_MS && now - reader.lastUpdateTime > READER_TIMEOUT_MS) {
          return false;
        }
        if (!reader.deleted && now - reader.lastUpdateTime > READER_TIMEOUT_MS) {
          return false;
        }
        return true;
      });
      if (filtered.length === 0) {
        this.readerQueues.delete(filePath);
      } else {
        this.readerQueues.set(filePath, filtered);
      }
    }
  }

  /**
   * 识别路径消失、dev/inode 变化和 size 回退三类 rotation。
   *
   * 路径消失可能只是 rename 与新建之间的短窗口，所以只标记旧 reader；inode 改变时把旧
   * reader 标记 deleted 并把新 reader 入队；inode 不变但 size 回退是 copytruncate，只能
   * 清空半行缓存并把当前 reader offset 归零。
   */
  private async detectRotation(filePath: string, queue: FileReaderState[]): Promise<void> {
    let stat: fsSync.Stats;
    try {
      stat = await fs.stat(filePath);
    } catch {
      // 路径暂时消失时保留 reader，后续按 inode 在父目录寻找 rename 后文件。
      const latest = queue[queue.length - 1];
      if (latest && !latest.deleted) {
        latest.deleted = true;
        latest.deletedTime = Date.now();
      }
      return;
    }

    const latestReader = queue[queue.length - 1];

    if (latestReader.devInode.ino !== stat.ino || latestReader.devInode.dev !== stat.dev) {
      logger.info('inode changed (rename rotation detected)', {
        file: filePath,
        oldInode: latestReader.devInode.ino,
        newInode: stat.ino,
      });
      latestReader.deleted = true;
      latestReader.deletedTime = Date.now();

      const sig = await computeFileSignature(filePath);
      const newReader: FileReaderState = {
        filePath,
        devInode: { dev: stat.dev, ino: stat.ino },
        offset: 0,
        signatureHash: sig,
        lastUpdateTime: Date.now(),
        cache: '',
        deleted: false,
        deletedTime: 0,
      };
      // 新 inode reader 加到队尾，processQueue 会先读完旧 reader。
      queue.push(newReader);

      while (queue.length > MAX_READER_QUEUE_LENGTH) {
        // 极端高频 rotation 时限制为 20 个 reader；淘汰会记录可能的数据缺口。
        const evicted = queue.shift()!;
        logger.warn('reader queue overflow, evicting oldest reader', {
          file: filePath,
          evictedInode: evicted.devInode.ino,
          evictedOffset: evicted.offset,
          queueLength: queue.length,
        });
      }
    } else if (stat.size < latestReader.offset) {
      // copytruncate 保持 inode 但文件缩短，只能从新文件头重新读取。
      logger.info('file truncated (copytruncate rotation)', {
        file: filePath,
        recorded: latestReader.offset,
        actual: stat.size,
      });
      const sig = await computeFileSignature(filePath);
      latestReader.offset = 0;
      latestReader.signatureHash = sig;
      latestReader.cache = '';
      latestReader.lastUpdateTime = Date.now();
    }
  }

  /**
   * 从队首 reader 开始，必要时按 inode 定位 rename 后的物理文件。
   *
   * 一次调用最多从一个 reader 返回一批行，让 FilePipeline 有机会在批次之间检查 Sender
   * 背压。只有旧 reader 已到 EOF 且标记 deleted 才出队；暂时找不到 rename 文件时保留队列，
   * 等后续周期重试。
   */
  private async processQueue(filePath: string, queue: FileReaderState[]): Promise<ReadResult> {
    while (queue.length > 0) {
      const reader = queue[0];

      const readPath = reader.deleted
        // rename 后逻辑路径已指向新文件，需要按 dev/inode 在同目录找到旧文件名。
        ? await this.findFileByDevInode(path.dirname(filePath), reader.devInode)
        : reader.filePath;

      if (!readPath) {
        if (reader.deleted && Date.now() - reader.deletedTime > READER_TIMEOUT_MS) {
          logger.warn('deleted reader file not found after timeout, discarding', {
            file: filePath,
            inode: reader.devInode.ino,
            offset: reader.offset,
          });
          queue.shift();
          continue;
        }
        logger.debug('deleted reader file temporarily not found, skipping to next reader', {
          file: filePath,
          inode: reader.devInode.ino,
        });
        break;
      }

      const result = await this.readFromReader(readPath, reader);

      if (result.lines.length === 0 && !result.hasMore && reader.deleted) {
        queue.shift();
        continue;
      }

      const removedFront = !result.hasMore && reader.deleted;
      if (removedFront) {
        queue.shift();
      }

      const latestReader = queue[queue.length - 1] || reader;
      const hasUnprocessedReaders = removedFront ? queue.length > 0 : queue.length > 1;
      return {
        lines: result.lines,
        checkpoint: this.readerToCheckpoint(latestReader),
        hasMore: result.hasMore || hasUnprocessedReaders,
      };
    }

    this.readerQueues.delete(filePath);
    return this.emptyResult();
  }

  /**
   * 从单个物理文件按 byte offset 最多读取 4 MiB，仅返回换行结束的完整非空行。
   *
   * `offset` 按读取字节数推进，而不是按解码后字符串长度推进；最后一个换行后的文本保存在
   * `reader.cache`，下轮与新字节前缀拼接。文件句柄由 `finally` 关闭，读取或解码异常会原样
   * reject 给 FilePipeline，避免调用方误把失败当作已消费。
   *
   * @returns 当前 reader 的完整行，以及本物理文件在本轮 stat 边界后是否仍有字节。
   */
  private async readFromReader(
    filePath: string,
    reader: FileReaderState,
  ): Promise<{ lines: string[]; hasMore: boolean }> {
    let stat: fsSync.Stats;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return { lines: [], hasMore: false };
    }

    if (stat.size <= reader.offset) {
      return { lines: [], hasMore: false };
    }

    const readSize = Math.min(stat.size - reader.offset, MAX_READ_BYTES);
    let handle;
    try {
      handle = await fs.open(filePath, 'r');
      const buf = Buffer.alloc(readSize);
      await handle.read(buf, 0, readSize, reader.offset);
      const text = buf.toString(this.encoding);

      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline === -1) {
        // 没有完整行时把文本拼入 cache；超过 1 MiB 丢弃以防无换行巨型文件占满内存。
        const newCache = reader.cache + text;
        if (Buffer.byteLength(newCache, this.encoding) > MAX_CACHE_BYTES) {
          logger.warn('cache overflow, discarding', {
            file: filePath,
            cacheSize: Buffer.byteLength(newCache, this.encoding),
          });
          reader.cache = '';
        } else {
          reader.cache = newCache;
        }
        reader.offset += readSize;
        reader.lastUpdateTime = Date.now();
        return { lines: [], hasMore: stat.size > reader.offset };
      }

      const completePart = reader.cache + text.substring(0, lastNewline);
      // 最后一个换行后的残片留到下轮，与下一段前缀拼接。
      reader.cache = text.substring(lastNewline + 1);
      const lines = completePart.split('\n').filter((l) => l.length > 0);

      reader.offset += readSize;
      reader.lastUpdateTime = Date.now();

      return { lines, hasMore: stat.size > reader.offset };
    } finally {
      await handle?.close();
    }
  }

  /** 在同一目录普通文件中寻找指定 dev/inode，供 rename rotation 续读。 */
  private async findFileByDevInode(dir: string, devInode: DevInode): Promise<string | null> {
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const s = await fs.stat(fullPath);
        if (s.dev === devInode.dev && s.ino === devInode.ino) {
          return fullPath;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  /** 将可变 reader 状态复制成可序列化 checkpoint。 */
  private readerToCheckpoint(reader: FileReaderState): FileCheckpoint {
    return {
      offset: reader.offset,
      inode: reader.devInode.ino,
      dev: reader.devInode.dev,
      signatureHash: reader.signatureHash,
      signatureSize: SIGNATURE_BYTES,
      lastUpdateTime: reader.lastUpdateTime,
      cache: reader.cache,
    };
  }

  /** 文件不可用时返回稳定空结果。 */
  private emptyResult(): ReadResult {
    return {
      lines: [],
      checkpoint: {
        offset: 0,
        inode: 0,
        dev: 0,
        signatureHash: '',
        signatureSize: SIGNATURE_BYTES,
        lastUpdateTime: Date.now(),
        cache: '',
      },
      hasMore: false,
    };
  }
}

/** 读取文件头 1 KiB 计算 MD5 身份签名；仅用于变化检测，不用于安全认证。 */
async function computeFileSignature(filePath: string): Promise<string> {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(SIGNATURE_BYTES);
    const { bytesRead } = await handle.read(buf, 0, SIGNATURE_BYTES, 0);
    if (bytesRead === 0) return '';
    return crypto.createHash('md5').update(buf.subarray(0, bytesRead)).digest('hex');
  } catch {
    return '';
  } finally {
    await handle?.close();
  }
}

/** 在 pattern 父目录按 basename glob 同步收集文件，并限制递归深度。 */
function matchGlob(pattern: string, maxDepth: number): string[] {
  const dir = path.dirname(pattern);
  const filePattern = path.basename(pattern);

  if (!fsSync.existsSync(dir)) return [];

  const regex = globToRegex(filePattern);
  const results: string[] = [];
  collectFiles(dir, regex, 0, maxDepth, results);
  return results.sort();
}

/** 深度优先递归目录；达到每周期 100 文件后立即停止。 */
function collectFiles(
  dir: string,
  regex: RegExp,
  currentDepth: number,
  maxDepth: number,
  results: string[],
): void {
  let entries: fsSync.Dirent[];
  try {
    entries = fsSync.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= MAX_FILES_PER_CYCLE) return;

    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && regex.test(entry.name)) {
      results.push(fullPath);
    } else if (entry.isDirectory() && currentDepth < maxDepth) {
      collectFiles(fullPath, regex, currentDepth + 1, maxDepth, results);
    }
  }
}

/** 将 basename 中 `*` 转成“不跨路径分隔符”的正则，其余正则字符全部转义。 */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*/g, '[^/]*');
  return new RegExp(`^${regexStr}$`);
}
