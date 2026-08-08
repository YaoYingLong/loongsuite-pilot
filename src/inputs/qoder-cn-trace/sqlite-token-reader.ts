/** Qoder CN 数据库结构专用 token 样本读取器。 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import sqlite3 from 'sqlite3';
import { resolveHome } from '../../utils/fs-utils.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('QoderCnSqliteTokenReader');

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

/**
 * 从当前平台的 Qoder CN 数据库查询指定 session 的 assistant token 记录。
 * 数据库不存在或查询失败时返回空数组，调用方可继续用其他 token 来源。
 */
export async function readSqliteTokensForSession(sessionId: string): Promise<SqliteTokenData[]> {
  // CN 版每个平台只有一个已知数据库位置；找不到文件时直接让上层保留无 token 的 Hook 事件。
  const dbPath = resolveQoderCnDbPath();
  if (!dbPath) return [];

  // 只查询 assistant 行，因为一条 assistant chat_message 对应一次 LLM response 的 usage。
  const sql = `
    SELECT
      cm.id            AS message_id,
      cm.session_id    AS session_id,
      cm.request_id    AS request_id,
      cm.gmt_create    AS gmt_create,
      cm.token_info    AS token_info,
      cm.model_info    AS model_info,
      cr.extra         AS record_extra
    FROM chat_message cm
    LEFT JOIN chat_record cr ON cr.request_id = cm.request_id
    WHERE cm.session_id = ?
      AND cm.role = 'assistant'
      AND cm.token_info IS NOT NULL
      AND cm.token_info != ''
      AND json_valid(cm.token_info)
    ORDER BY cm.gmt_create ASC
  `;

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
    logger.debug('sqlite query failed', { sessionId, error: String(err) });
    return [];
  }

  // ORDER BY 已保证时间顺序，结果数组保持该顺序交给共享 enrichIdeTurn 做跨 turn 对齐。
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
      // 新旧 CN 版本保存模型的位置不同，优先 message.model_info，再回退关联 record.extra。
      model: parseModelKey(row.model_info) ?? parseRecordModelKey(row.record_extra),
    });
  }
  return results;
}

/** 按平台计算 CN 数据库候选路径，并返回第一个可访问文件。 */
function resolveQoderCnDbPath(): string | null {
  const appdata = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const candidates = process.platform === 'darwin'
    ? [resolveHome('~/Library/Application Support/QoderCN/SharedClientCache/cache/db/local.db')]
    : process.platform === 'win32'
      ? [path.join(appdata, 'QoderCN', 'SharedClientCache', 'cache', 'db', 'local.db')]
      : [resolveHome('~/.config/QoderCN/SharedClientCache/cache/db/local.db')];

  for (const candidate of candidates) {
    try {
      // 候选数很小，使用同步 access 让函数直接返回确定路径或 null。
      fs.accessSync(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/** 解析 token_info；输入和输出均为 0 时不把它当作有效样本。 */
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

/** 从 message.model_info JSON 读取 model_key。 */
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

/** model_info 缺失时从关联 record.extra.modelConfig.key 回退读取。 */
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

/** 把 sqlite3 只读查询包装为 Promise；查询错误拒绝，关闭错误只写 debug 日志。 */
function queryReadonly<T>(dbPath: string, sql: string, params: unknown[]): Promise<T[]> {
  return new Promise((resolve, reject) => {
    // 只读模式确保采集不会对 Qoder CN 自有数据库产生写锁或数据修改。
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (openErr) => {
      if (openErr) { reject(openErr); return; }
      // sqlite3 是回调 API；包装成 Promise 后，上层可用 await 保持“查询完成再 enrich”的顺序。
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
