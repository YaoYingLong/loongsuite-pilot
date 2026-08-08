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
  contentHash?: string;
  contentPrefix?: string;
  traceparent: string;
}

interface SessionRecord {
  type: 'session';
  traceparent: string;
}

interface SessionState {
  mtimeMs: number;
  turns: TurnRecord[];
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
  private readonly dir: string;
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
    // 获取对应sessionId对应的文件路径
    const file = path.join(this.dir, `${safeName(sessionId)}.jsonl`);
    let stat: fs.Stats;
    try {
      // 同步方法，获取 file 路径对应的文件元信息（大小、修改时间、是否存在等）
      stat = fs.statSync(file);
    } catch {
      return null; // 文件不存在或不可访问，表示该 session 暂无可用记录。
    }

    const existing = this.states.get(sessionId);
    // 如果缓存中存在对应sessionId的数据，内存里有缓存 并且 缓存记录保存的文件修改时间 mtimeMs 等于磁盘当前文件的 mtimeMs
    if (existing && existing.mtimeMs === stat.mtimeMs) {
      // 磁盘文件自从上次加载后没有被修改过，内存缓存依然有效
      existing.lastAccessMs = Date.now();
      return existing;
    }

    // 如果磁盘文件自从上次加载后有被修改过，需要重新读取
    const turns: TurnRecord[] = [];
    const sessions: SessionRecord[] = [];
    try {
      // 读取文件内容
      const raw = fs.readFileSync(file, 'utf8');
      // 按行读取
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let rec: unknown;
        try {
          // 将每行的数据转换成json数据
          rec = JSON.parse(line);
        } catch {
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
