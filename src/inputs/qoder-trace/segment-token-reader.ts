/** 从 Qoder trace segment 文件提取 token 样本，并维护文件级增量状态。 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';
import { resolveHome } from '../../utils/fs-utils.js';
import { createLogger } from '../../utils/logger.js';
import { readInterceptData } from './intercept-token-reader.js';

const logger = createLogger('SegmentTokenReader');

/** 返回 Qoder CLI 原生 session segment 根目录。 */
function getSessionsDir(): string {
  return resolveHome('~/.qoder/logs/sessions');
}

// 模块级 Map 在同一进程内被所有 QoderTraceInput 实例共享，减少同一 session 的重复全目录扫描。
const sessionCache = new Map<string, { data: SegmentTokenData[]; ts: number }>();
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_SIZE = 50;

export interface SegmentTokenData {
  requestId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requestStartTs: number;
  responseEndTs: number;
  toolFinishedTs: number;
  stopReason: string;
  model: string;
}

/**
 * 读取一个 session 的全部 segment JSONL，并关联 request/response/tool 完成时间和 token 用量。
 *
 * 结果缓存 60 秒；源 segment 的 token 为 0 时，按 requestId 尝试用 intercept 数据补齐。目录、
 * 文件或坏行错误均 fail-open，调用方可继续使用 canonical trace 的原始事件。
 */
export async function readSegmentTokensForSession(sessionId: string): Promise<SegmentTokenData[]> {
  const cached = sessionCache.get(sessionId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  const files = await findSegmentFilesForSession(sessionId);
  if (files.length === 0) return [];

  const requestStarts = new Map<string, number>();
  const results: SegmentTokenData[] = [];

  // 先收集全部相关事件，后面才能根据时间顺序把 tool.execution.finished 归属到正确 LLM step。
  const allEvents: Array<{ type: string; ts: number; requestId?: string; data?: Record<string, unknown> }> = [];

  for (const filePath of files) {
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      const type = record.type as string | undefined;
      if (!type) continue;

      const ts = parseTs(record.ts);
      if (type === 'model.request.started' || type === 'model.response.completed' || type === 'tool.execution.finished') {
        const requestId = record.request_id as string | undefined;
        const data = (record.data && typeof record.data === 'object' && !Array.isArray(record.data))
          ? record.data as Record<string, unknown>
          : undefined;
        allEvents.push({ type, ts, requestId: requestId || undefined, data });
      }
    }
  }

  // 第一遍用 request_id 配对 model.request.started 与 model.response.completed，构造每次 LLM 样本。
  for (const evt of allEvents) {
    if (evt.type === 'model.request.started' && evt.requestId && evt.ts > 0) {
      requestStarts.set(evt.requestId, evt.ts);
    }

    if (evt.type === 'model.response.completed' && evt.requestId) {
      const data = evt.data || {};
      const startTs = requestStarts.get(evt.requestId) ?? evt.ts;

      results.push({
        requestId: evt.requestId,
        inputTokens: finiteNum(data.input_tokens) ?? 0,
        outputTokens: finiteNum(data.output_tokens) ?? 0,
        cacheReadTokens: finiteNum(data.cache_read_input_tokens) ?? 0,
        cacheCreationTokens: finiteNum(data.cache_creation_input_tokens) ?? 0,
        requestStartTs: startTs,
        responseEndTs: evt.ts,
        toolFinishedTs: 0,
        stopReason: (data.stop_reason as string) ?? '',
        model: (data.model as string) ?? '',
      });
    }
  }

  // 第二遍把 response 之后、下一次 model.request.started 之前的最后一个 tool finished 归给当前 step。
  for (let i = 0; i < results.length; i++) {
    const currentEnd = results[i].responseEndTs;
    const nextStart = i + 1 < results.length ? results[i + 1].requestStartTs : Infinity;

    let lastToolFinish = 0;
    for (const evt of allEvents) {
      if (evt.type === 'tool.execution.finished' && evt.ts > currentEnd && evt.ts <= nextStart) {
        lastToolFinish = Math.max(lastToolFinish, evt.ts);
      }
    }
    results[i].toolFinishedTs = lastToolFinish;
  }

  // Qoder CLI 1.0.21+ 某些 segment 会写 0 token；仅对这些样本按 requestId 使用 intercept 数据补齐。
  const zeroSegments = results.filter(r => r.inputTokens === 0 && r.outputTokens === 0);
  if (zeroSegments.length > 0) {
    try {
      const earliest = results.reduce((min, r) => {
        const v = r.requestStartTs || r.responseEndTs;
        return v > 0 && v < min ? v : min;
      }, Infinity);
      const { tokens } = await readInterceptData(earliest < Infinity ? earliest - 5000 : undefined);
      for (const seg of zeroSegments) {
        const match = tokens.find(t => t.id === seg.requestId);
        if (match) {
          seg.inputTokens = match.promptTokens;
          seg.outputTokens = match.completionTokens;
          seg.cacheReadTokens = match.cachedTokens;
          // intercept 格式没有 cache_creation 字段，这是已知数据源限制，只能保留为 0。
          seg.cacheCreationTokens = 0;
        }
      }
    } catch (err) {
      logger.debug('intercept fallback failed', { error: String(err) });
    }
  }

  // 写入新缓存前清理过期项，并在达到容量上限时移除最早项，避免模块级 Map 无限增长。
  const now = Date.now();
  for (const [key, entry] of sessionCache) {
    if (now - entry.ts > CACHE_TTL_MS) sessionCache.delete(key);
  }
  if (sessionCache.size >= CACHE_MAX_SIZE) {
    const oldest = [...sessionCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) sessionCache.delete(oldest[0]);
  }

  sessionCache.set(sessionId, { data: results, ts: now });
  return results;
}

/** 跨所有 cwd key 查找指定 sessionId 的 segments JSONL，并排序返回。 */
async function findSegmentFilesForSession(sessionId: string): Promise<string[]> {
  const files: string[] = [];
  let cwdDirs: Dirent[];
  try {
    cwdDirs = await fs.readdir(getSessionsDir(), { withFileTypes: true });
  } catch {
    return [];
  }

  for (const cwdDir of cwdDirs) {
    if (!cwdDir.isDirectory()) continue;
    const segDir = path.join(getSessionsDir(), cwdDir.name, sessionId, 'segments');
    let entries: Dirent[];
    try {
      entries = await fs.readdir(segDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(path.join(segDir, entry.name));
      }
    }
  }

  return files.sort();
}

/** 兼容有限 number、日期字符串和数字字符串；无法解析时返回 0。 */
function parseTs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const d = Date.parse(value);
    if (!Number.isNaN(d)) return d;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/** 仅接受有限 number，避免异常数值进入 token 计算。 */
function finiteNum(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}
