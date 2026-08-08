/**
 * acp-correlate JSONL 的按 session 查询与一次性消费仓库。
 *
 * Hook/adapter 把 turn 级 prompt 指纹或 session 级 traceparent 写入磁盘；TraceLinker
 * 调用本类按“精确 hash、内容前缀、首轮 session”顺序解析。文件 mtime 未变化时复用
 * 内存索引，变化后重读，并保留已经消费的下标，避免同一上游上下文被多个 turn
 * 重复使用。同步 fs API 使单次解析保持原子视图；所有格式错误均被跳过以保证采集
 * fail-open。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { contentHash } from '../../utils/content-hash.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('correlation-store');

interface TurnRecord {
  type: 'turn';
  /** 写入端对完整 prompt 计算的稳定摘要，首选匹配方式。 */
  contentHash?: string;
  /** Agent 可能改写 prompt 时使用的兼容前缀；仅在 hash 未命中后检查。 */
  contentPrefix?: string;
  /** 原始 W3C traceparent，格式校验由 TraceLinker 统一执行。 */
  traceparent: string;
}

interface SessionRecord {
  type: 'session';
  /** 由环境变量 Hook 写入、只允许 session 第一轮消费的上游上下文。 */
  traceparent: string;
}

interface SessionState {
  /** 最近加载时磁盘文件的修改时间，用于判断追加写后是否需要重读。 */
  mtimeMs: number;
  /** 保持 JSONL 文件顺序的 turn 记录。 */
  turns: TurnRecord[];
  /** 保持 JSONL 文件顺序的 session 记录；当前消费逻辑只取第一条。 */
  sessions: SessionRecord[];
  /** 已一次性消费的下标；文件重读后仍保留。 */
  consumedTurns: Set<number>;
  sessionConsumed: boolean;
  /** contentHash -> 升序 turn 下标，用于摊销 O(1) 的精确匹配。 */
  hashIndex: Map<string, number[]>;
  /** contentHash -> 下一个待检查的桶位置，用来跳过已消费前缀。 */
  hashCursor: Map<string, number>;
  /** 最后访问的墙上时钟时间，用于淘汰空闲 session。 */
  lastAccessMs: number;
}

/** 为 turn 记录按 contentHash 建立升序下标桶，减少精确匹配扫描。 */
function buildHashIndex(turns: TurnRecord[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (let i = 0; i < turns.length; i += 1) {
    const h = turns[i].contentHash;
    if (h === undefined) continue;
    const bucket = index.get(h);
    if (bucket) bucket.push(i);
    else index.set(h, [i]);
  }
  return index;
}

/** 把 sessionId 收敛为可用作单个文件名的安全字符串。 */
function safeName(value: string): string {
  return path.basename(String(value)).replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
}

/**
 * 读取 `${dataDir}/acp-correlate/<sessionId>.jsonl` 中的上游上下文关联记录。
 *
 * `turn` 记录由 adapter 按 prompt 写入，通过内容匹配并且只能消费一次；`session`
 * 记录由环境 Hook 写入，只应用于 session 的第一轮。
 *
 * 状态按 session 隔离，并根据 mtime 惰性加载或重载。消费游标只保存在内存中；由于
 * 文件采用追加写、下标稳定，文件重读后仍能继续沿用已消费集合。
 */
export class CorrelationStore {
  /** acp-correlate 根目录；每个 session 对应一个安全化文件名。 */
  private readonly dir: string;
  /** 进程内惰性缓存；不会持久化消费状态，Collector 重启后重新开始。 */
  private readonly states = new Map<string, SessionState>();

  /** @param correlateDir `<dataDir>/acp-correlate` 的绝对路径。 */
  constructor(correlateDir: string) {
    // ~/.loongsuite-pilot/acp-correlate
    this.dir = correlateDir;
  }

  /**
   * 按 session 读取 JSONL；mtime 未变化时复用缓存，变化时重建索引并保留已消费集合。
   * 文件缺失返回 null，坏行逐行跳过；同步读取保证一次解析看到同一文件快照。
   */
  private load(sessionId: string): SessionState | null {
    // safeName 同时阻止 `../` 路径穿越，并让异常字符不会创建子目录。
    const file = path.join(this.dir, `${safeName(sessionId)}.jsonl`);
    let stat: fs.Stats;
    try {
      // 同步 stat/read 位于单条事件关联的短路径中：它让 mtime 判断与随后读取保持简单、
      // 顺序一致；文件很大时对事件循环的影响由保留服务限制目录增长来缓解。
      stat = fs.statSync(file);
    } catch {
      return null; // 文件不存在或不可访问，表示该 session 暂无可用记录。
    }

    const existing = this.states.get(sessionId);
    // mtime 相同表示写入端没有追加记录，直接复用解析结果和一次性消费游标。
    if (existing && existing.mtimeMs === stat.mtimeMs) {
      existing.lastAccessMs = Date.now();
      return existing;
    }

    // 文件发生变化时从头解析，因为 JSONL 是追加格式且体量受保留策略限制；这样无需维护
    // 半行缓冲和字节 offset，也能容忍写入端重建文件。
    const turns: TurnRecord[] = [];
    const sessions: SessionRecord[] = [];
    try {
      const raw = fs.readFileSync(file, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let rec: unknown;
        try {
          rec = JSON.parse(line);
        } catch {
          // 正在追加的最后一行或历史坏记录不会让整个 session 的有效记录失效。
          continue;
        }
        const r = rec as Record<string, unknown>;
        if (r.type === 'turn' && typeof r.traceparent === 'string') {
          turns.push({
            type: 'turn',
            contentHash: typeof r.contentHash === 'string' ? r.contentHash : undefined,
            contentPrefix: typeof r.contentPrefix === 'string' ? r.contentPrefix : undefined,
            traceparent: r.traceparent,
          });
        } else if (r.type === 'session' && typeof r.traceparent === 'string') {
          sessions.push({ type: 'session', traceparent: r.traceparent });
        }
      }
    } catch (err) {
      logger.warn('failed to read correlation file', { sessionId, error: String(err) });
      // 重读失败时继续使用旧快照，比完全丢失已解析关联更稳妥；首次加载则返回 null。
      return existing ?? null;
    }

    const state: SessionState = {
      mtimeMs: stat.mtimeMs,
      turns,
      sessions,
      consumedTurns: existing?.consumedTurns ?? new Set<number>(),
      sessionConsumed: existing?.sessionConsumed ?? false,
      // 每次重读都重建索引；追加写保证下标稳定，游标首次使用时会根据 consumedTurns 重新定位。
      hashIndex: buildHashIndex(turns),
      hashCursor: new Map<string, number>(),
      lastAccessMs: Date.now(),
    };
    this.states.set(sessionId, state);
    return state;
  }

  /**
   * 一次性消费与用户文本匹配的 turn traceparent：先精确 hash，再尝试内容前缀。
   * @returns 命中的 traceparent；无文件或无未消费匹配时返回 null。
   */
  resolveTurn(sessionId: string, collectedText: string): string | null {
    const state = this.load(sessionId);
    if (!state || state.turns.length === 0) return null;

    // 精确路径先跨过已消费下标（某个桶成员也可能已被前缀回退消费），再取最早未消费项。
    const hash = contentHash(collectedText);
    const bucket = state.hashIndex.get(hash);
    if (bucket) {
      let c = state.hashCursor.get(hash) ?? 0;
      // 前缀回退可能提前消费了同一桶中的成员，因此 cursor 前进时还要检查 consumedTurns。
      while (c < bucket.length && state.consumedTurns.has(bucket[c])) c += 1;
      if (c < bucket.length) {
        const idx = bucket[c];
        state.consumedTurns.add(idx);
        state.hashCursor.set(hash, c + 1);
        return state.turns[idx].traceparent;
      }
      state.hashCursor.set(hash, c);
    }

    // 精确 hash 未命中时才线性扫描前缀，取文件顺序中最早且未消费的匹配项；该分支主要
    // 兼容 Agent 在 prompt 后追加 `@file` 等内容的情况。
    for (let i = 0; i < state.turns.length; i += 1) {
      if (state.consumedTurns.has(i)) continue;
      const t = state.turns[i];
      if (t.contentPrefix !== undefined && t.contentPrefix.length > 0 && collectedText.startsWith(t.contentPrefix)) {
        state.consumedTurns.add(i);
        return t.traceparent;
      }
    }
    return null;
  }

  /** 仅一次消费 session 级 traceparent，供该 session 第一 turn 回退使用。 */
  resolveSessionFirst(sessionId: string): string | null {
    const state = this.load(sessionId);
    if (!state || state.sessions.length === 0 || state.sessionConsumed) return null;
    state.sessionConsumed = true;
    // 只采用文件中的第一条 session 记录，以保持“进程启动时继承的上游上下文”语义。
    return state.sessions[0].traceparent;
  }

  /** 只检查关联文件是否存在，用于 TraceLinker 避免无意义重试。 */
  hasSession(sessionId: string): boolean {
    try {
      return fs.statSync(path.join(this.dir, `${safeName(sessionId)}.jsonl`)).isFile();
    } catch {
      return false;
    }
  }

  /**
   * 淘汰截止时间前未访问的 session 缓存。
   * @returns 删除的 session 数量。
   */
  pruneIdle(cutoffMs: number): number {
    let evicted = 0;
    for (const [sessionId, state] of this.states) {
      if (state.lastAccessMs < cutoffMs) {
        this.states.delete(sessionId);
        evicted += 1;
      }
    }
    return evicted;
  }
}
