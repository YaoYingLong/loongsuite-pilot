/** 从 Qoder 本地 SQLite 读取可关联的 token 用量样本，查询失败时 fail-open。 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import sqlite3 from 'sqlite3';
import { resolveHome } from '../../utils/fs-utils.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('SqliteTokenReader');

export interface SqliteTokenData {
  sessionId?: string;
  requestId: string;
  messageId?: string;
  gmtCreate: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  model?: string;
}

export interface SqliteTokenResult {
  rows: SqliteTokenData[];
  /** 实际命中该 session 的数据库路径，调用方据此区分 Desktop 与 IntelliJ 变体。 */
  matchedDbPath: string | null;
}

/**
 * 依次查询本机所有可访问的 Qoder Desktop/JetBrains 数据库，返回首个包含目标 session 的结果。
 * 单库查询失败只记录 debug 并继续下一个；均无数据时返回空数组和 null 路径。
 */
export async function readSqliteTokensForSession(sessionId: string): Promise<SqliteTokenResult> {
  // 同机可能同时安装 Desktop 与 JetBrains，必须逐库查 session，不能仅按平台选择单一路径。
  const dbPaths = resolveAllQoderDbPaths();
  if (dbPaths.length === 0) return { rows: [], matchedDbPath: null };

  // LEFT JOIN chat_record 只为在 message.model_info 缺失时补模型；token 主数据仍来自 chat_message。
  const sql = `
    SELECT
      cm.id AS message_id,
      cm.session_id AS session_id,
      cm.request_id AS request_id,
      cm.gmt_create AS gmt_create,
      cm.token_info AS token_info,
      cm.model_info AS model_info,
      cr.extra AS record_extra
    FROM chat_message cm
    LEFT JOIN chat_record cr ON cr.request_id = cm.request_id
    WHERE cm.session_id = ?
      AND cm.role = 'assistant'
      AND cm.token_info IS NOT NULL
      AND cm.token_info != ''
      AND json_valid(cm.token_info)
    ORDER BY cm.gmt_create ASC
  `;

  // 数据库相互独立：一个库失败或没有该 session 时继续尝试下一个。
  for (const dbPath of dbPaths) {
    let rows: Array<{
      message_id?: string;
      session_id?: string;
      request_id: string;
      gmt_create: number;
      token_info: string;
      model_info?: string | null;
      record_extra?: string | null;
    }>;
    try {
      rows = await queryReadonly(dbPath, sql, [sessionId]);
    } catch (err) {
      logger.debug('sqlite query failed', { sessionId, dbPath, error: String(err) });
      continue;
    }

    if (rows.length === 0) continue;

    // 数据库保证按 gmt_create 排序，保持该顺序供 token-enricher 做结构匹配。
    const results: SqliteTokenData[] = [];
    for (const row of rows) {
      const info = parseTokenInfo(row.token_info);
      if (!info) continue;
      results.push({
        sessionId: row.session_id ?? '',
        requestId: row.request_id ?? '',
        messageId: row.message_id ?? '',
        gmtCreate: row.gmt_create,
        inputTokens: info.promptTokens,
        outputTokens: info.completionTokens,
        cacheReadTokens: info.cachedTokens,
        // 新版本模型在 model_info，旧版本可能只在 chat_record.extra 中保存。
        model: parseModelKey(row.model_info) ?? parseRecordModelKey(row.record_extra),
      });
    }
    // 首个产生有效 token 的数据库就是 session 所属变体；路径交给上层修正 QoderIdea 类型。
    if (results.length > 0) return { rows: results, matchedDbPath: dbPath };
  }
  return { rows: [], matchedDbPath: null };
}

/** 判断命中的数据库是否属于 IntelliJ 专用目录；先统一路径分隔符以兼容 Windows。 */
export function isIdeaDbPath(dbPath: string | null): boolean {
  if (!dbPath) return false;
  const normalized = dbPath.replace(/\\/g, '/');
  return normalized.includes('.qoder/shared_client');
}

/** 返回当前平台上所有实际可访问的 Qoder Desktop 与 JetBrains 数据库路径。 */
function resolveAllQoderDbPaths(): string[] {
  // Desktop Electron 版把 SQLite 放在平台应用数据目录；JetBrains 版使用 ~/.qoder/shared_client。
  // 两者可能同时安装且 session 分属不同数据库，因此不能找到第一个文件后就停止。
  const appdata = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const candidates = process.platform === 'darwin'
    ? [
        resolveHome('~/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db'),
        resolveHome('~/.qoder/shared_client/cache/db/local.db'),
      ]
    : process.platform === 'win32'
      ? [
          path.join(appdata, 'Qoder', 'SharedClientCache', 'cache', 'db', 'local.db'),
          path.join(os.homedir(), '.qoder', 'shared_client', 'cache', 'db', 'local.db'),
        ]
      : [
          resolveHome('~/.config/Qoder/SharedClientCache/cache/db/local.db'),
          resolveHome('~/.qoder/shared_client/cache/db/local.db'),
        ];

  const available: string[] = [];
  for (const candidate of candidates) {
    try {
      // 同步 access 仅检查极少量固定路径，避免把异步目录探测扩散到纯路径辅助函数调用方。
      fs.accessSync(candidate);
      available.push(candidate);
    } catch {
      continue;
    }
  }
  return available;
}

/** 解析 token_info；输入和输出均为 0 时视为无有效 usage，返回 null。 */
function parseTokenInfo(raw: string): { promptTokens: number; completionTokens: number; cachedTokens: number } | null {
  try {
    const obj = JSON.parse(raw);
    const pt = typeof obj.prompt_tokens === 'number' ? obj.prompt_tokens : 0;
    const ct = typeof obj.completion_tokens === 'number' ? obj.completion_tokens : 0;
    const cached = typeof obj.cached_tokens === 'number' ? obj.cached_tokens : 0;
    if (pt === 0 && ct === 0) return null;
    return { promptTokens: pt, completionTokens: ct, cachedTokens: cached };
  } catch {
    return null;
  }
}

/** 从 chat_message.model_info JSON 中读取 model_key。 */
function parseModelKey(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw);
    return typeof obj.model_key === 'string' && obj.model_key.length > 0
      ? obj.model_key
      : undefined;
  } catch {
    return undefined;
  }
}

/** model_info 缺失时，从关联 chat_record.extra.modelConfig.key 兼容读取模型。 */
function parseRecordModelKey(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw);
    const key = obj?.modelConfig?.key;
    return typeof key === 'string' && key.length > 0 ? key : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 将 sqlite3 只读查询回调包装为 Promise。关闭失败仅记录 debug；查询失败会拒绝 Promise。
 */
function queryReadonly<T>(dbPath: string, sql: string, params: unknown[]): Promise<T[]> {
  return new Promise((resolve, reject) => {
    // OPEN_READONLY 明确禁止采集器修改或创建 Agent 数据库。
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (openErr) => {
      if (openErr) { reject(openErr); return; }
      // 查询完成后先关闭连接，再向 Promise 调用方返回；关闭告警不掩盖已取得的查询结果。
      db.all(sql, params, (queryErr: Error | null, rows: T[]) => {
        db.close((closeErr) => {
          if (closeErr) logger.debug('sqlite close warning', { error: String(closeErr) });
          if (queryErr) { reject(queryErr); return; }
          resolve(rows);
        });
      });
    });
  });
}
