/**
 * 将本地 Agent turn 挂接到外部 W3C Trace 上下文。
 *
 * `InputManager` 在内容策略和脱敏前调用 `stamp()`。每个 turn 的首条 `other` 事件
 * 提供用户文本，本类经 CorrelationStore 解析 traceparent，并覆盖采集侧 trace_id；
 * 只有根用户事件写 parent_span_id。结果按 session/turn 缓存供后续分批事件复用。
 * 关联文件可能比事件稍晚落盘，因此 turn 级匹配可短暂重试；任何失败都不阻断原始
 * 事件输出。
 */

import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { createLogger } from '../../utils/logger.js';
import type { CorrelationStore } from './correlation-store.js';

const logger = createLogger('trace-linker');

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

interface ResolveState {
  /** true 表示 traceparent 已通过格式校验；false 是本 turn 已尝试但未命中的负缓存。 */
  resolved: boolean;
  /** 从 traceparent 提取的 32 位十六进制 Trace ID。 */
  traceId?: string;
  /** 上游 Span ID，只写给本地 turn 的根用户事件。 */
  parentSpanId?: string;
}

interface TraceLinkerOptions {
  /** `other` 首次未命中时的重试次数；关联记录可能稍晚落盘。 */
  retries?: number;
  /** 两次磁盘查询间的非阻塞等待毫秒数。 */
  retryDelayMs?: number;
}

/** 解析并校验 W3C traceparent；拒绝格式错误和全零 ID。 */
function parseTraceparent(tp: string): { traceId: string; spanId: string } | null {
  // 当前只接受 W3C version 00 的标准四段格式；flags 可取任意两位十六进制值。
  const m = TRACEPARENT_RE.exec(tp.trim());
  if (!m) return null;
  const traceId = m[1].toLowerCase();
  const spanId = m[2].toLowerCase();
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return null;
  return { traceId, spanId };
}

/** 从 canonical messages_delta 的 text part 拼出用于关联的用户文本。 */
function extractUserText(entry: AgentActivityEntry): string {
  const delta = entry['gen_ai.input.messages_delta'] as JsonValue | undefined;
  if (!Array.isArray(delta)) return '';
  let text = '';
  for (const msg of delta) {
    // JsonValue 还可能是 null、标量或数组，只有普通消息对象才可能包含 parts。
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) continue;
    const parts = (msg as Record<string, JsonValue>).parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      // 关联写入端对完整 prompt 求 hash，因此按原顺序拼接全部 text part，不加分隔符。
      if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
      const p = part as Record<string, JsonValue>;
      if (p.type === 'text' && typeof p.content === 'string') text += p.content;
    }
  }
  return text;
}

/** 使用事件循环 timer 实现非阻塞重试等待；返回的 Promise 在延迟后兑现。 */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 从关联仓库解析上游 trace_id / parent_span_id，使 Trace converter 将 turn Span 树
 * 挂到外部父 Span 下。
 *
 * turn 事件可能分批到达，因此按 sessionId+turnId 缓存结果。首条 `other` 用户事件
 * 触发解析，后续事件复用缓存。
 *
 * 优先级：turn adapter 记录 > 首轮 session env 记录 > 采集侧原值。命中后覆盖本地
 * trace_id，但永不改变 gen_ai.turn.id；所有异常 fail-open。
 */
export class TraceLinker {
  /** 磁盘 JSONL 的索引与一次性消费实现。 */
  private readonly store: CorrelationStore;
  /** 首次查询之外允许的额外重试次数；总尝试次数为 retries + 1。 */
  private readonly retries: number;
  private readonly retryDelayMs: number;
  /** `${sessionId}|${turnId}` 到成功或失败解析结果，供同 turn 后续分批事件复用。 */
  private readonly cache = new Map<string, ResolveState>();
  /** 每个 session 首次见到的 turnId，用于限制 session 级 traceparent 只挂第一轮。 */
  private readonly firstTurnBySession = new Map<string, string>();
  /** session 最近处理时间，为 AcpCorrelateRetentionService 的内存淘汰提供依据。 */
  private readonly sessionLastAccess = new Map<string, number>();

  /** @param opts 重试参数主要供测试和特殊部署调整。 */
  constructor(store: CorrelationStore, opts: TraceLinkerOptions = {}) {
    this.store = store;
    this.retries = opts.retries ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 100;
  }

  /** 顺序处理批次事件；单条失败记录警告后继续，并原地修改命中的 entry。 */
  async stamp(entries: AgentActivityEntry[]): Promise<void> {
    // 顺序 await 很重要：同批的根 `other` 必须先填缓存，随后 request/response/tool 才能复用。
    for (const entry of entries) {
      try {
        await this.stampEntry(entry);
      } catch (err) {
        logger.warn('stamp entry failed (skipped)', { error: String(err) });
      }
    }
  }

  /** 只有包含 session/turn 且为首条 `other` 的记录会访问仓库。 */
  private async stampEntry(entry: AgentActivityEntry): Promise<void> {
    const sessionId = entry['gen_ai.session.id'] as string | undefined;
    const turnId = entry['gen_ai.turn.id'] as string | undefined;
    // 上游关联以 session + turn 为查找键；任一身份缺失时无法安全猜测父 Span。
    if (!sessionId || !turnId) return;

    // 刷新 session 活跃时间，供 retention 删除长期未访问的 firstTurnBySession 状态。
    this.sessionLastAccess.set(sessionId, Date.now());
    if (!this.firstTurnBySession.has(sessionId)) {
      // 第一次看到的 turn 作为 session 首 turn；后续回退查找只允许首 turn 使用 session 级关联。
      this.firstTurnBySession.set(sessionId, turnId);
    }

    const key = `${sessionId}|${turnId}`;
    const cached = this.cache.get(key);
    if (cached) {
      // cache 同时保存成功命中和“已经查过但未命中”。只有 resolved 项才写 trace/parent；
      // 未命中项直接返回，可避免同一 turn 的每条 entry 都重复读取关联仓库。
      if (cached.resolved) this.apply(entry, cached);
      return; // 已解析，或已经尝试过但未命中；两种情况都不再重复访问仓库。
    }

    // 只有 `other`（用户输入）事件携带关联所需的文本；其他事件等待缓存结果。
    if (entry['event.name'] !== 'other') return;

    const text = extractUserText(entry);
    const isFirstTurn = this.firstTurnBySession.get(sessionId) === turnId;
    const tp = await this.resolveWithRetry(sessionId, text, isFirstTurn);

    if (!tp) {
      // 记录负缓存，避免同 turn 后续工具事件再次触发磁盘读取和延迟重试。
      this.cache.set(key, { resolved: false });
      return;
    }
    const parsed = parseTraceparent(tp);
    if (!parsed) {
      // 文件存在但 traceparent 非法时同样 fail-open；原采集 trace_id 保持不变。
      this.cache.set(key, { resolved: false });
      return;
    }
    const state: ResolveState = { resolved: true, traceId: parsed.traceId, parentSpanId: parsed.spanId };
    this.cache.set(key, state);
    this.apply(entry, state);
  }

  /** turn 级文本匹配优先重试，最后仅对 session 首轮消费 session 级上下文。 */
  private async resolveWithRetry(sessionId: string, text: string, isFirstTurn: boolean): Promise<string | null> {
    // session 没有关联文件，说明 adapter/env 未写入记录；立即返回，避免在常见路径上
    // 无意义消耗 `retries * retryDelayMs` 的重试时间。
    if (!this.store.hasSession(sessionId)) return null;

    // 空 `other` 没有可匹配文本，不重试 turn 记录，直接进入 session 级回退。
    if (text) {
      // 关联文件可能稍晚写入，因此全部重试期间都保持 turn 级记录优先。
      for (let attempt = 0; attempt <= this.retries; attempt += 1) {
        const turnTp = this.store.resolveTurn(sessionId, text);
        if (turnTp) return turnTp;
        // 最后一次失败后不再 sleep，避免已经确定回退时额外增加一个延迟周期。
        if (attempt < this.retries) await sleep(this.retryDelayMs);
      }
    }
    // session 级环境上下文是最终回退，而且只允许用于第一轮 turn。
    if (isFirstTurn) return this.store.resolveSessionFirst(sessionId);
    return null;
  }

  /**
   * 丢弃截止时间前未访问的 session/turn 缓存，并同步清 Store，避免常驻 Map 无界增长。
   */
  pruneIdle(cutoffMs: number): void {
    for (const [sessionId, last] of this.sessionLastAccess) {
      if (last >= cutoffMs) continue;
      this.sessionLastAccess.delete(sessionId);
      this.firstTurnBySession.delete(sessionId);
      const prefix = `${sessionId}|`;
      for (const key of this.cache.keys()) {
        if (key.startsWith(prefix)) this.cache.delete(key);
      }
    }
    this.store.pruneIdle(cutoffMs);
  }

  /** 将上下文写回事件；parent_span_id 只属于 turn 根 `other`。 */
  private apply(entry: AgentActivityEntry, state: ResolveState): void {
    // trace_id 覆盖采集器本地生成值，使一个 turn 内所有事件落到同一条上游 Trace。
    if (state.traceId) entry.trace_id = state.traceId;
    if (entry['event.name'] === 'other' && state.parentSpanId) {
      entry.parent_span_id = state.parentSpanId;
    }
  }
}
