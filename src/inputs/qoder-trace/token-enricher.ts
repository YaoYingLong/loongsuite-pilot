/**
 * Qoder trace 记录的多来源 token 用量补齐器。
 *
 * 按拦截文件、segment 统计和 SQLite 样本等来源匹配 turn/request，去重并只填充缺失 usage；
 * 匹配不确定时保留原事件，不编造 token。
 */
import * as crypto from 'node:crypto';
import type { AgentActivityEntry } from '../../types/index.js';
import type { SegmentTokenData } from './segment-token-reader.js';
import type { SqliteTokenData } from './sqlite-token-reader.js';

// 阶段 B 最近时间匹配的最大允许差值；实际仍选择最近候选。JSONL response 的 Hook progress 时钟
// 与 SQLite gmt_create 可漂移约 1.4 秒，所以从 1000ms 放宽；有 match_ts 时通常只差几毫秒。
const TIMESTAMP_THRESHOLD_MS = 5000;

// 顺序匹配的时间合理性保护：中间缺 SQLite 行会使后续位置整体错一位，若 response 与 row 时间差
// 明显过大就拒绝该配对。存在准确 match_ts 时用严格阈值，仅有漂移时钟时用宽松阈值。
const ORDER_MATCH_STRICT_MS = 1000;
const ORDER_MATCH_LOOSE_MS = 3000;

/**
 * 用 CLI segment 数据原地补充一个 turn 的 token、模型、finish reason 与 step/tool 时间。
 * 同一 responseId 重复出现时只把 token 写到第一条，其余写 0，避免聚合重复计数。
 */
export function enrichCliTurn(
  entries: AgentActivityEntry[],
  segments: SegmentTokenData[],
  systemPrompt?: string,
): void {
  if (systemPrompt) {
    const firstReq = entries.find(e =>
      e['event.name'] === 'llm.request' && !!e['gen_ai.step.id'],
    );
    if (firstReq) {
      (firstReq as Record<string, unknown>)['gen_ai.system_instructions'] = [
        { type: 'text', content: systemPrompt },
      ];
    }
  }

  if (segments.length === 0) return;

  for (const seg of segments) {
    const matches = entries.filter(e =>
      e['gen_ai.response.id'] === seg.requestId && e['event.name'] === 'llm.response',
    );

    if (matches.length === 0) continue;

    matches[0]['gen_ai.usage.input_tokens'] = seg.inputTokens;
    matches[0]['gen_ai.usage.output_tokens'] = seg.outputTokens;
    matches[0]['gen_ai.usage.total_tokens'] = seg.inputTokens + seg.outputTokens;
    matches[0]['gen_ai.usage.cache_read.input_tokens'] = seg.cacheReadTokens;
    matches[0]['gen_ai.usage.cache_creation.input_tokens'] = seg.cacheCreationTokens;

    if (seg.stopReason && !matches[0]['gen_ai.response.finish_reasons']) {
      matches[0]['gen_ai.response.finish_reasons'] = [seg.stopReason];
    }

    for (let i = 1; i < matches.length; i++) {
      matches[i]['gen_ai.usage.input_tokens'] = 0;
      matches[i]['gen_ai.usage.output_tokens'] = 0;
      matches[i]['gen_ai.usage.total_tokens'] = 0;
      matches[i]['gen_ai.usage.cache_read.input_tokens'] = 0;
      matches[i]['gen_ai.usage.cache_creation.input_tokens'] = 0;
    }

    // 整个 step 都使用 segment 时间和模型，避免同一 span 混用 Hook 时钟与 session 时钟。
    const stepId = matches[0]['gen_ai.step.id'];

    // segment 中的真实模型覆盖 Hook processor 无法确认时写入的 auto。
    if (seg.model && seg.model !== 'unknown') {
      matches[0]['gen_ai.request.model'] = seg.model;
      matches[0]['gen_ai.response.model'] = seg.model;
      const req = entries.find(e =>
        e['event.name'] === 'llm.request' && e['gen_ai.step.id'] === stepId,
      );
      if (req) req['gen_ai.request.model'] = seg.model;
    }

    // llm.request 使用 segment 的请求开始时间。
    if (seg.requestStartTs > 0) {
      const req = entries.find(e =>
        e['event.name'] === 'llm.request' && e['gen_ai.step.id'] === stepId,
      );
      if (req) {
        req.time_unix_nano = String(BigInt(seg.requestStartTs) * 1_000_000n);
      }
    }

    // llm.response 使用 segment 的响应完成时间。
    if (seg.responseEndTs > 0) {
      matches[0].time_unix_nano = String(BigInt(seg.responseEndTs) * 1_000_000n);
    }

    // 工具在 LLM 响应结束后开始，tool.call 用 responseEndTs；tool.result 用真实 toolFinishedTs。
    if (stepId && seg.toolFinishedTs > 0) {
      const toolCalls = entries.filter(e =>
        e['event.name'] === 'tool.call' && e['gen_ai.step.id'] === stepId,
      );
      const toolResults = entries.filter(e =>
        e['event.name'] === 'tool.result' && e['gen_ai.step.id'] === stepId,
      );
      const toolCallTs = String(BigInt(seg.responseEndTs) * 1_000_000n);
      const toolResultTs = String(BigInt(seg.toolFinishedTs) * 1_000_000n);
      const toolDurationMs = seg.responseEndTs > 0
        ? seg.toolFinishedTs - seg.responseEndTs
        : 0;
      for (const tc of toolCalls) tc.time_unix_nano = toolCallTs;
      for (const tr of toolResults) {
        tr.time_unix_nano = toolResultTs;
        if (toolDurationMs > 0) {
          (tr as Record<string, unknown>)['gen_ai.tool.call.duration'] = toolDurationMs;
        }
      }
    }
  }
}

/**
 * 用 SQLite 样本原地 enrich 同 session 的 IDE 事件。
 *
 * 阶段 A 优先按 turn/request 顺序匹配，阶段 B 再用最近时间处理剩余项；方法同步 request/model/token
 * 和时间，最后把未获得 token 的 response 明确写为 0，便于下游 AGENT 聚合。
 */
export function enrichIdeTurn(
  entries: AgentActivityEntry[],
  sqliteRows: SqliteTokenData[],
): void {
  if (sqliteRows.length === 0) return;

  // 只对 llm.response 匹配 token，并按时间排序供阶段 B 最近距离搜索。
  const responseEntries = entries
    .filter(e => e['event.name'] === 'llm.response')
    .sort((a, b) => extractMs(a) - extractMs(b));

  const used = new Set<AgentActivityEntry>();
  const tokenWritten = new Set<string>();
  const sortedGroups = groupSqliteRowsByRequest(sqliteRows);

  matchIdeTurnsBySqliteOrder(entries, sortedGroups, used, tokenWritten);

  // SQLite 元数据不完整或结构匹配失败时，用保守的近时间匹配保持兼容行为。
  for (const [requestId, group] of sortedGroups) {
    for (const row of group) {
      // 跳过阶段 A 已消费的 row；否则同一 row 可能再次给剩余 response 写入错误 ID/模型。
      if (tokenWritten.has(sqliteDedupeKey(row))) continue;

      let bestEntry: AgentActivityEntry | null = null;
      let bestDiff = Infinity;

      for (const entry of responseEntries) {
        if (used.has(entry)) continue;
        const diff = Math.abs(matchMs(entry) - row.gmtCreate);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestEntry = entry;
        }
      }

      if (bestEntry && bestDiff <= TIMESTAMP_THRESHOLD_MS) {
        used.add(bestEntry);
        (bestEntry as Record<string, unknown>).__matched_gmt_create = row.gmtCreate;

        if (!bestEntry['gen_ai.response.id']) {
          bestEntry['gen_ai.response.id'] = row.messageId || requestId;
        }
        bestEntry['gen_ai.request.id'] = requestId;
        (bestEntry as Record<string, unknown>)['agent.request_id'] = requestId;

        if (row.model && row.model !== 'unknown') {
          bestEntry['gen_ai.request.model'] = row.model;
          bestEntry['gen_ai.response.model'] = row.model;
          const stepId = bestEntry['gen_ai.step.id'];
          const req = entries.find(e =>
            e['event.name'] === 'llm.request' && e['gen_ai.step.id'] === stepId,
          );
          if (req) {
            req['gen_ai.request.id'] = requestId;
            (req as Record<string, unknown>)['agent.request_id'] = requestId;
            req['gen_ai.request.model'] = row.model;
          }
        }

        // 一条 SQLite row 代表一次 LLM 调用，token 只能写一次。优先 messageId，否则组合
        // requestId:gmtCreate，避免同一毫秒出现多个调用时发生简单时间键冲突。
        const dedupeKey = sqliteDedupeKey(row);
        if (!tokenWritten.has(dedupeKey)) {
          bestEntry['gen_ai.usage.input_tokens'] = row.inputTokens;
          bestEntry['gen_ai.usage.output_tokens'] = row.outputTokens;
          bestEntry['gen_ai.usage.total_tokens'] = row.inputTokens + row.outputTokens;
          bestEntry['gen_ai.usage.cache_read.input_tokens'] = row.cacheReadTokens;
          tokenWritten.add(dedupeKey);
        }
      }
    }
  }

  // 类似 CLI 使用 segment 时钟，IDE 使用 SQLite gmt_create 作为真实响应时间，并按时间排序配对。
  const matchedPairs: { entry: AgentActivityEntry; gmtCreate: number }[] = [];
  for (const entry of responseEntries) {
    if (!used.has(entry)) continue;
    const gmtCreate = (entry as Record<string, unknown>).__matched_gmt_create as number | undefined;
    if (gmtCreate) matchedPairs.push({ entry, gmtCreate });
  }
  matchedPairs.sort((a, b) => a.gmtCreate - b.gmtCreate);

  // 查找 step 1 的用户边界。normalizer 通常把用户 prompt 输出为 other，也兼容旧 llm.request 形状。
  const userBoundary = entries.find(e =>
    !e['gen_ai.step.id'] &&
    (e['event.name'] === 'llm.request' || (e['event.name'] === 'other' && e['gen_ai.input.messages_delta'])),
  );

  for (let i = 0; i < matchedPairs.length; i++) {
    const { entry: respEntry, gmtCreate } = matchedPairs[i];

    // llm.response 采用 SQLite gmt_create 作为真实完成时间。
    respEntry.time_unix_nano = String(BigInt(gmtCreate) * 1_000_000n);

    // 优先找同 step.id 的 llm.request，避免同 session 多 turn 合并后误改上一 turn 的请求时间。
    const respStepId = respEntry['gen_ai.step.id'];
    let req: AgentActivityEntry | undefined;
    if (respStepId) {
      req = entries.find(e => e['event.name'] === 'llm.request' && e['gen_ai.step.id'] === respStepId);
    }
    if (!req) {
      // step.id 缺失时才向前回扫，但仍限制在相同 turn 内。
      const respTurnId = respEntry['gen_ai.turn.id'];
      const respIdx = entries.indexOf(respEntry);
      for (let j = respIdx - 1; j >= 0; j--) {
        if (entries[j]['event.name'] === 'llm.request' && entries[j]['gen_ai.step.id'] &&
            entries[j]['gen_ai.turn.id'] === respTurnId) {
          req = entries[j];
          break;
        }
      }
    }

    if (req) {
      if (i > 0) {
        // 后续 step 从上一响应后 1ms 开始，为上一 step 的 tool.result 留出时间位置。
        req.time_unix_nano = String(BigInt(matchedPairs[i - 1].gmtCreate + 1) * 1_000_000n);
      } else if (userBoundary) {
        // 首个请求放在用户边界后 1ms。二者同刻时转换器会在 step s1 生成一个 0ms、无 LLM 子节点
        // 的重复空 STEP。
        const ubNs = BigInt(String(userBoundary.time_unix_nano));
        req.time_unix_nano = String(ubNs + 1_000_000n); // +1ms
      }
    }

    // IDE 没有工具完成时间，只能把 tool.call 放在 response 时刻、result 放到 1ms 后；下一 step
    // request 也从该位置继续，保持各 STEP 不重叠。
    const toolCallTs = String(BigInt(gmtCreate) * 1_000_000n);
    const toolResultTs = String(BigInt(gmtCreate + 1) * 1_000_000n);
    const respIdx = entries.indexOf(respEntry);
    const rightBound = i < matchedPairs.length - 1
      ? entries.indexOf(matchedPairs[i + 1].entry)
      : entries.length;
    for (let j = respIdx + 1; j < rightBound; j++) {
      if (entries[j]['event.name'] === 'tool.call') entries[j].time_unix_nano = toolCallTs;
      if (entries[j]['event.name'] === 'tool.result') entries[j].time_unix_nano = toolResultTs;
    }
  }

  // 临时匹配时间只用于本函数内部，输出前删除，避免污染事件 schema。
  for (const entry of responseEntries) {
    delete (entry as Record<string, unknown>).__matched_gmt_create;
  }

  // 未匹配 response 明确写 0，使 AGENT 聚合把它计为 0；undefined 会被聚合逻辑完全跳过。
  for (const entry of responseEntries) {
    if (entry['gen_ai.usage.input_tokens'] !== undefined) continue;
    entry['gen_ai.usage.input_tokens'] = 0;
    entry['gen_ai.usage.output_tokens'] = 0;
    entry['gen_ai.usage.total_tokens'] = 0;
    entry['gen_ai.usage.cache_read.input_tokens'] = 0;
  }

}

/** 按 requestId 分组并分别按 gmtCreate 排序，再按每组首行时间排列各 request 组。 */
function groupSqliteRowsByRequest(sqliteRows: SqliteTokenData[]): Array<[string, SqliteTokenData[]]> {
  const requestGroups = new Map<string, SqliteTokenData[]>();
  for (const row of sqliteRows) {
    if (!row.requestId) continue;
    const group = requestGroups.get(row.requestId) ?? [];
    group.push(row);
    requestGroups.set(row.requestId, group);
  }

  return [...requestGroups.entries()]
    .map(([requestId, rows]) => [
      requestId,
      [...rows].sort((a, b) => a.gmtCreate - b.gmtCreate),
    ] as [string, SqliteTokenData[]])
    .sort((a, b) => a[1][0].gmtCreate - b[1][0].gmtCreate);
}

/**
 * 阶段 A：在 session 元数据完整时，按 Hook turn 顺序与 SQLite request 组顺序做结构匹配。
 * 结果通过 used/tokenWritten 集合传给阶段 B，函数原地更新匹配到的事件。
 */
function matchIdeTurnsBySqliteOrder(
  entries: AgentActivityEntry[],
  requestGroups: Array<[string, SqliteTokenData[]]>,
  used: Set<AgentActivityEntry>,
  tokenWritten: Set<string>,
): void {
  if (requestGroups.length === 0) return;
  if (!requestGroups.every(([, rows]) => rows.every(row => row.messageId && row.sessionId))) return;

  const sessionId = entries.find(e => typeof e['gen_ai.session.id'] === 'string')?.['gen_ai.session.id'] as string | undefined;
  const sessionGroups = sessionId
    ? requestGroups.filter(([, rows]) => rows[0]?.sessionId === sessionId)
    : requestGroups;
  if (sessionGroups.length === 0) return;

  const turnGroups = groupEntriesByTurn(entries);
  if (turnGroups.length === 0) return;

  if (sessionGroups.length < turnGroups.length) {
    for (const [, turnEntries] of turnGroups) {
      markLowConfidence(turnEntries, 'request_count_mismatch');
    }
    return;
  }

  const candidateGroups = sessionGroups.slice(sessionGroups.length - turnGroups.length);
  for (let i = 0; i < turnGroups.length; i++) {
    const [, turnEntries] = turnGroups[i];
    const [requestId, sqliteRows] = candidateGroups[i];
    const responses = turnEntries.filter(e => e['event.name'] === 'llm.response');

    // 数量常因 sub-agent transcript 缺最终答案或最新 SQLite row 未落盘而不同；仍按顺序匹配可对齐
    // 的前缀。若中间缺行导致位置整体偏移，时间保护会拒绝明显过远的配对并交给阶段 B。
    const n = Math.min(responses.length, sqliteRows.length);
    // 数量完全一致时信任结构顺序，不依赖两个时钟；只有数量不等的 best-effort 分支才检查时间差。
    const countsMatch = responses.length === sqliteRows.length;
    for (let j = 0; j < n; j++) {
      const response = responses[j];
      const row = sqliteRows[j];
      if (!countsMatch) {
        const threshold = accurateMatchMs(response) !== undefined
          ? ORDER_MATCH_STRICT_MS
          : ORDER_MATCH_LOOSE_MS;
        if (Math.abs(matchMs(response) - row.gmtCreate) > threshold) {
          markLowConfidence([response], 'order_time_gap');
          continue;
        }
      }
      applySqliteRowToIdeResponse(entries, turnEntries, response, row, requestId, used, tokenWritten);
    }
  }
}

/** 按非空 turn.id 分组，并移除不含 llm.response 的组。 */
function groupEntriesByTurn(entries: AgentActivityEntry[]): Array<[string, AgentActivityEntry[]]> {
  const groups = new Map<string, AgentActivityEntry[]>();
  for (const entry of entries) {
    const turnId = entry['gen_ai.turn.id'];
    if (typeof turnId !== 'string' || turnId.length === 0) continue;
    const group = groups.get(turnId) ?? [];
    group.push(entry);
    groups.set(turnId, group);
  }
  return [...groups.entries()].filter(([, group]) => group.some(e => e['event.name'] === 'llm.response'));
}

/** 把一条确认匹配的 SQLite row 的 ID、模型和 token 写入 response 及同 step request。 */
function applySqliteRowToIdeResponse(
  allEntries: AgentActivityEntry[],
  turnEntries: AgentActivityEntry[],
  response: AgentActivityEntry,
  row: SqliteTokenData,
  requestId: string,
  used: Set<AgentActivityEntry>,
  tokenWritten: Set<string>,
): void {
  used.add(response);
  (response as Record<string, unknown>).__matched_gmt_create = row.gmtCreate;
  response['gen_ai.request.id'] = requestId;
  (response as Record<string, unknown>)['agent.request_id'] = requestId;
  response['gen_ai.response.id'] = row.messageId || requestId;

  if (row.model && row.model !== 'unknown') {
    response['gen_ai.request.model'] = row.model;
    response['gen_ai.response.model'] = row.model;
  }

  const request = findStepRequest(allEntries, response) ?? turnEntries.find(e => e['event.name'] === 'llm.request');
  if (request) {
    request['gen_ai.request.id'] = requestId;
    (request as Record<string, unknown>)['agent.request_id'] = requestId;
    if (row.model && row.model !== 'unknown') request['gen_ai.request.model'] = row.model;
  }

  const dedupeKey = sqliteDedupeKey(row);
  if (tokenWritten.has(dedupeKey)) return;
  response['gen_ai.usage.input_tokens'] = row.inputTokens;
  response['gen_ai.usage.output_tokens'] = row.outputTokens;
  response['gen_ai.usage.total_tokens'] = row.inputTokens + row.outputTokens;
  response['gen_ai.usage.cache_read.input_tokens'] = row.cacheReadTokens;
  tokenWritten.add(dedupeKey);
}

/** 查找与 response 具有相同 step.id 的 llm.request。 */
function findStepRequest(entries: AgentActivityEntry[], response: AgentActivityEntry): AgentActivityEntry | undefined {
  const stepId = response['gen_ai.step.id'];
  return entries.find(e => e['event.name'] === 'llm.request' && e['gen_ai.step.id'] === stepId);
}

/** 低置信匹配目前只作为显式占位，不向事件写额外字段，避免污染输出 schema。 */
function markLowConfidence(entries: AgentActivityEntry[], _warning: string): void {
  void entries;
}

/** 优先使用 messageId，否则组合 requestId 与时间生成 SQLite 行去重键。 */
function sqliteDedupeKey(row: SqliteTokenData): string {
  return row.messageId || `${row.requestId}:${row.gmtCreate}`;
}


/** 为同一 turn 的全部事件原地写入同一个随机 16 字节 trace_id；空数组不生成随机值。 */
export function injectTraceId(entries: AgentActivityEntry[]): void {
  if (entries.length === 0) return;
  const traceId = crypto.randomBytes(16).toString('hex');
  for (const entry of entries) {
    (entry as Record<string, unknown>).trace_id = traceId;
  }
}

/** 从纳秒字符串/数字或兼容 timestamp 字段取得毫秒时间，缺失时返回 0。 */
function extractMs(entry: AgentActivityEntry): number {
  const raw = entry.time_unix_nano;
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n > 1e15 ? n / 1e6 : n;
  }
  if (typeof raw === 'number') return raw > 1e15 ? raw / 1e6 : raw;
  const ts = (entry as Record<string, unknown>).timestamp;
  if (typeof ts === 'number') return ts;
  return 0;
}

/**
 * 读取 Hook 从 transcript assistant record 注入的精确匹配时间，通常与 SQLite gmt_create 只差数毫秒。
 * 旧 JSONL 或旧 Hook 不含此字段时返回 undefined。
 */
function accurateMatchMs(entry: AgentActivityEntry): number | undefined {
  const raw = (entry as Record<string, unknown>)['agent.qoder.match_ts'];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** SQLite 匹配优先用精确 match_ts，缺失时回退到可能有漂移的事件时间。 */
function matchMs(entry: AgentActivityEntry): number {
  return accurateMatchMs(entry) ?? extractMs(entry);
}
