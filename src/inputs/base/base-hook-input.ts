/**
 * 按日轮转 Hook JSONL 的通用增量读取基类。
 *
 * Hook 脚本独立于 Collector 写文件；本类为最近三个日期文件维护 byte offset Map，以处理 Hook
 * 与 Collector 时区不同导致的跨日迟写。首轮通过旧 lastFile/lastOffset 迁移或 no-history
 * baseline 建立边界，逐行 JSON/转换错误被隔离，不阻断后续记录。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry, InputState } from '../../types/index.js';
import { BaseInput, type InputOptions } from './base-input.js';
import { getTodayDateString, ensureDir } from '../../utils/fs-utils.js';

/** offset Map 在 InputState.extra 中的稳定 key。 */
const OFFSET_MAP_EXTRA_KEY = 'hookLogOffsets';
/** 同时保持最近三份日文件活跃，覆盖常见时区跨日窗口。 */
const RECENT_LOG_FILE_LIMIT = 3;

type OffsetMap = Record<string, number>;

export interface HookInputOptions extends InputOptions {
  /** Hook JSONL 所在目录。 */
  logDir: string;
  /** 日文件前缀，例如 claude/cursor。 */
  logPrefix: string;
}

/**
 * Hook 日志增量读取的抽象 Input。
 *
 * Hook writer 可能继承与 Collector 不同的时区；本地日期切换附近，它仍可能写“前一天”文件。
 * 因此不能只读 `${prefix}-${today}.jsonl`，必须维护最近文件窗口和逐文件 offset。
 *
 * 子类只需实现 transformRecord。
 */
export abstract class BaseHookInput extends BaseInput {
  readonly collectionMethod = CollectionMethod.HookJsonl;

  protected readonly logDir: string;
  protected readonly logPrefix: string;

  /**
   * 可选冷启动重放保护。没有旧状态时只发送读到的最后一个 turn，其余视为旧 daemon 已发送历史。
 *
   * 仅适用于 JSONL 由 daemon 自己的子进程写入的数据源；独立 Hook（Cursor/Claude 等）可能在
   * Collector 停止期间产生从未发送的数据，绝不能开启此策略。
   */
  protected coldStartKeepLastTurnOnly = false;

  /** 保存日志目录和前缀；目录创建延迟到 onStart。 */
  constructor(opts: HookInputOptions) {
    super(opts);
    this.logDir = opts.logDir;
    this.logPrefix = opts.logPrefix;
  }

  /** 启动时尽力创建 Hook 日志目录。 */
  protected override async onStart(): Promise<void> {
    await ensureDir(this.logDir);
  }

  /**
   * 选择候选日文件、按各自 offset 增量转换、裁剪失效 offset 并更新状态。
   * coldStartKeepLastTurnOnly 开启时最后再执行批次级 turn 过滤。
   */
  protected async collect(): Promise<AgentActivityEntry[]> {
    const today = getTodayDateString();
    const entries: AgentActivityEntry[] = [];
    const state = this.getState();
    // state.lastFile 缺失是旧状态判断冷启动的兼容信号。
    const isColdStart = !state.lastFile;
    const fileNames = await this.listHookLogFiles();
    if (fileNames.length === 0) return entries;

    // 旧 offset Map 存在时复制后修改；否则根据文件和 legacy state 建立初值。
    const persistedOffsets = this.getPersistedOffsetMap(state);
    const shouldPersistOffsets = !persistedOffsets;
    const offsets: OffsetMap = persistedOffsets ? { ...persistedOffsets } : await this.seedOffsetMap(fileNames, state, today);
    const candidateFileNames = this.getCandidateFileNames(fileNames, state.lastFile, today);

    for (const logFileName of candidateFileNames) {
      const logFile = path.join(this.logDir, logFileName);
      const fileEntries = await this.collectFile(logFile, offsets[logFileName] ?? 0);
      offsets[logFileName] = fileEntries.offset;
      entries.push(...fileEntries.entries);
    }

    // 删除磁盘已不存在文件的 offset，避免日轮转让状态 Map 无界增长。
    const liveFileNames = new Set(fileNames);
    const prunedOffsets: OffsetMap = {};
    for (const [fileName, offset] of Object.entries(offsets)) {
      if (liveFileNames.has(fileName)) prunedOffsets[fileName] = offset;
    }

    const newestFileName = candidateFileNames[candidateFileNames.length - 1];
    if (newestFileName && (
      shouldPersistOffsets ||
      state.lastFile !== newestFileName ||
      state.lastOffset !== (prunedOffsets[newestFileName] ?? 0) ||
      this.isOffsetMapChanged(persistedOffsets, prunedOffsets)
    )) {
      this.setState({
        lastFile: newestFileName,
        lastOffset: prunedOffsets[newestFileName] ?? 0,
        extra: {
          ...(state.extra ?? {}),
          [OFFSET_MAP_EXTRA_KEY]: prunedOffsets,
        },
      });
    }

    // 可选冷启动保护在 offset 已推进到各文件尾后，仅返回最后 turn；后续从文件尾继续。
    if (this.coldStartKeepLastTurnOnly && isColdStart && entries.length > 0) {
      const turnIds = new Set(entries.map(e => (e['gen_ai.turn.id'] as string) || 'unknown'));
      if (turnIds.size > 1) {
        const lastTurnId = (entries[entries.length - 1]['gen_ai.turn.id'] as string) || 'unknown';
        this.logger.info('cold start detected, skipping historical turns', {
          skipped: turnIds.size - 1,
          totalTurns: turnIds.size,
          keepTurnId: lastTurnId,
        });
        return entries.filter(e => ((e['gen_ai.turn.id'] as string) || 'unknown') === lastTurnId);
      }
    }

    return entries;
  }

  /** 从一个日文件的 startOffset 读到本轮 stat.size，并逐行转换。 */
  private async collectFile(
    logFile: string,
    startOffset: number,
  ): Promise<{ entries: AgentActivityEntry[]; offset: number }> {
    const entries: AgentActivityEntry[] = [];
    let stat;
    try {
      stat = await fs.stat(logFile);
    } catch {
      return { entries, offset: startOffset };
    }

    let offset = startOffset;
    // 文件小于已记 offset 表示 truncate/替换，从 0 读取新内容。
    if (offset > 0 && stat.size < offset) {
      this.logger.info('file truncated, resetting offset', {
        file: logFile,
        recorded: offset,
        actual: stat.size,
      });
      offset = 0;
    }
    if (stat.size <= offset) return { entries, offset: stat.size };

    const handle = await fs.open(logFile, 'r');
    try {
      // 以本轮 stat.size 为读取边界；并发追加留到下一轮，避免 offset 越过未读数据。
      const buf = Buffer.alloc(stat.size - offset);
      await handle.read(buf, 0, buf.length, offset);
      const text = buf.toString('utf-8');

      const lines = text.split('\n').filter(l => l.trim().length > 0);

      for (const line of lines) {
        // 单行 JSON 或 transform 异常只告警并跳过，其他行继续。
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          const entry = await this.transformRecord(record);
          if (entry) entries.push(entry);
        } catch (err) {
          this.logger.warn('invalid JSONL line', { error: String(err), line: line.slice(0, 200) });
        }
      }
    } finally {
      await handle.close();
    }

    return { entries, offset: stat.size };
  }

  /** 列出符合 `<prefix>-YYYY-MM-DD.jsonl` 的文件并按名称（日期）排序。 */
  private async listHookLogFiles(): Promise<string[]> {
    let fileNames: string[];
    try {
      fileNames = await fs.readdir(this.logDir);
    } catch {
      return [];
    }

    return fileNames
      .filter(fileName => this.isHookLogFile(fileName))
      .sort();
  }

  /** 精确验证 Hook 日文件名，排除 error/debug 等同前缀文件。 */
  private isHookLogFile(fileName: string): boolean {
    const prefix = `${this.logPrefix}-`;
    if (!fileName.startsWith(prefix)) return false;
    const suffix = fileName.slice(prefix.length);
    return /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(suffix);
  }

  /** 合并最近三文件、legacy lastFile 和今天文件，去重后排序。 */
  private getCandidateFileNames(
    fileNames: string[],
    lastFile: string | undefined,
    today: string,
  ): string[] {
    const todayFileName = `${this.logPrefix}-${today}.jsonl`;
    const candidates = new Set<string>();
    // 时区可能不同，因此保留滚动窗口而不是只信任 Collector 的今天。
    for (const fileName of fileNames.slice(-RECENT_LOG_FILE_LIMIT)) {
      candidates.add(fileName);
    }
    if (lastFile && fileNames.includes(lastFile)) {
      candidates.add(lastFile);
    }
    if (fileNames.includes(todayFileName)) {
      candidates.add(todayFileName);
    }
    return Array.from(candidates).sort();
  }

  /** 从 state.extra 解析非负有限数 offset Map；无有效项返回 null。 */
  private getPersistedOffsetMap(state: InputState): OffsetMap | null {
    const raw = state.extra?.[OFFSET_MAP_EXTRA_KEY];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const offsets: OffsetMap = {};
    for (const [fileName, offset] of Object.entries(raw)) {
      if (typeof offset === 'number' && Number.isFinite(offset) && offset >= 0) {
        offsets[fileName] = offset;
      }
    }
    return Object.keys(offsets).length > 0 ? offsets : null;
  }

  /** 比较 Map key 数量和每个值，决定是否需要更新 StateStore。 */
  private isOffsetMapChanged(previous: OffsetMap | null, next: OffsetMap): boolean {
    if (!previous) return true;
    const previousKeys = Object.keys(previous);
    const nextKeys = Object.keys(next);
    if (previousKeys.length !== nextKeys.length) return true;
    return nextKeys.some(fileName => previous[fileName] !== next[fileName]);
  }

  /**
   * 从旧 lastFile/lastOffset 或真实冷启动建立逐文件 offset。
   * 默认先把全部现有文件 baseline 到末尾，再只开放明确需要消费的文件。
   */
  private async seedOffsetMap(
    fileNames: string[],
    state: InputState,
    today: string,
  ): Promise<OffsetMap> {
    const offsets: OffsetMap = {};
    // 先把每个现有文件标为已消费，防止首次运行/状态丢失回灌全部历史。
    for (const fileName of fileNames) {
      const logFile = path.join(this.logDir, fileName);
      try {
        offsets[fileName] = (await fs.stat(logFile)).size;
      } catch {
        offsets[fileName] = 0;
      }
    }

    const todayFileName = `${this.logPrefix}-${today}.jsonl`;
    if (state.lastFile && fileNames.includes(state.lastFile)) {
      // legacy 迁移：旧文件从保存 offset 续读；若今天是更新文件，则从头读取今天。
      offsets[state.lastFile] = state.lastOffset ?? 0;
      if (state.lastFile !== todayFileName && fileNames.includes(todayFileName)) {
        offsets[todayFileName] = 0;
      }
    } else if (fileNames.includes(todayFileName)) {
      // 真冷启动只从今天文件头开始；非今天文件绝不置 0，否则可能回灌旧 daemon 已发送的一天历史。
      offsets[todayFileName] = 0;
    }

    return offsets;
  }

  /**
   * 将一行已解析 JSON 转为标准事件；返回 null 跳过无关事件。
   */
  protected abstract transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null>;
}
