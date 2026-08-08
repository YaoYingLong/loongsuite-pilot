/** Qoder SQLite 增量备用 Input：按 rowid 游标查询本地数据库并转为标准活动事件。 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sqlite3 from 'sqlite3';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { resolveHome } from '../../utils/fs-utils.js';
import {
  BaseSqliteInput,
  type SqliteInputOptions,
  type SqliteRow,
} from '../base/base-sqlite-input.js';

const DEFAULT_QODER_ROOT_MAC = '~/Library/Application Support/Qoder';
const DEFAULT_QODER_ROOT_LINUX = '~/.config/Qoder';
const QODER_DB_RELATIVE_PATH = path.join('SharedClientCache', 'cache', 'db', 'local.db');
const SOURCE = 'qoder-sqlite-chat-message';
const UNKNOWN_MODEL = 'unknown';

export interface QoderSqliteInputOptions extends Omit<SqliteInputOptions, 'dbPath'> {
  dbPath?: string;
  dataRoot?: string;
}

interface QoderTokenRow extends SqliteRow {
  id: string;
  sessionId: string | null;
  requestId: string | null;
  role: string | null;
  tokenInfo: string;
  gmtCreate: number;
}

interface QoderTokenInfo {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  max_input_tokens?: number;
}

/**
 * 从 Qoder `SharedClientCache/cache/db/local.db` 增量采集 token usage 的备用 Input。
 *
 * BaseSqliteInput 负责周期轮询、rowid 游标和逐行转换；本类只读打开数据库，查询 chat_message 的
 * token_info 并生成 llm.response。首次启动把游标 baseline 到当前最大 rowid，避免回放安装前历史。
 */
export class QoderSqliteInput extends BaseSqliteInput {
  readonly id = 'qoder-sqlite';
  readonly agentType = ClientType.Qoder;

  /** 解析跨平台数据库路径并把 StateStore、路径和轮询间隔交给 BaseSqliteInput。 */
  constructor(opts: QoderSqliteInputOptions) {
    const dataRoot = opts.dataRoot ?? resolveQoderRoot();
    super({
      stateStore: opts.stateStore,
      dbPath: opts.dbPath ?? resolveQoderDbPath(dataRoot),
      pollIntervalMs: opts.pollIntervalMs
        ?? (Number(process.env.QODER_ANALYTICS_POLL_INTERVAL) || 30_000),
    });
  }

  /** 返回数据库父目录，供发现服务在数据库出现时重新探测。 */
  static getWatchPaths(): string[] {
    return [path.dirname(resolveQoderDbPath(resolveQoderRoot()))];
  }

  /** 检查默认数据库文件是否可访问，普通文件系统错误转换为 false。 */
  static async checkAvailability(): Promise<boolean> {
    try {
      await fs.access(resolveQoderDbPath(resolveQoderRoot()));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 仅在尚无 lastRowId 时读取当前最大可用 rowid 作为起点；查询失败只告警，后续轮询仍可重试。
   */
  protected override async onStart(): Promise<void> {
    if (this.stateStore.get(this.id).lastRowId !== undefined) return;

    try {
      const maxRowId = await readMaxEligibleRowId(this.dbPath);
      this.stateStore.setRowId(this.id, maxRowId);
    } catch (err) {
      this.logger.warn('failed to baseline Qoder SQLite cursor', { error: String(err) });
    }
  }

  /** 查询游标之后 token_info 为合法非空 JSON 的消息，并按 rowid 升序返回。 */
  protected async readNewRows(lastRowId: number): Promise<SqliteRow[]> {
    const sql = `
      SELECT
        rowid,
        id,
        session_id AS sessionId,
        request_id AS requestId,
        role,
        token_info AS tokenInfo,
        gmt_create AS gmtCreate
      FROM chat_message
      WHERE rowid > ?
        AND token_info IS NOT NULL
        AND token_info != ''
        AND json_valid(token_info)
      ORDER BY rowid ASC
    `;

    return queryReadonly<QoderTokenRow>(this.dbPath, sql, [lastRowId]);
  }

  /**
   * 解析 token_info 并构建标准 llm.response；JSON 无效或缺少对象结构时返回 null 跳过该行。
   */
  protected async transformRow(row: SqliteRow): Promise<AgentActivityEntry | null> {
    const qoderRow = row as QoderTokenRow;
    const tokenInfo = parseTokenInfo(qoderRow.tokenInfo);
    if (!tokenInfo) return null;

    const inputTokens = finiteNumber(tokenInfo.prompt_tokens);
    const outputTokens = finiteNumber(tokenInfo.completion_tokens);
    const cacheReadTokens = finiteNumber(tokenInfo.cached_tokens);
    const maxInputTokens = finiteNumber(tokenInfo.max_input_tokens);

    const attributes: Record<string, JsonValue> = {
      source: SOURCE,
      rowid: qoderRow.rowid,
      message_id: qoderRow.id,
    };
    if (qoderRow.requestId) attributes.request_id = qoderRow.requestId;
    if (maxInputTokens !== undefined) attributes.max_input_tokens = maxInputTokens;

    return buildAgentActivityEntry({
      timestamp: qoderRow.gmtCreate,
      'event.id': qoderRow.id || undefined,
      'event.name': 'llm.response',
      'gen_ai.session.id': qoderRow.sessionId ?? '',
      'gen_ai.agent.type': ClientType.Qoder,
      'gen_ai.request.model': UNKNOWN_MODEL,
      'gen_ai.response.model': UNKNOWN_MODEL,
      'gen_ai.usage.input_tokens': inputTokens,
      'gen_ai.usage.output_tokens': outputTokens,
      'gen_ai.usage.cache_read.input_tokens': cacheReadTokens,
      'gen_ai.usage.total_tokens': sumIfPresent(inputTokens, outputTokens),
      attributes,
    });
  }
}

/** 按当前平台和 XDG/APPDATA 约定计算 Qoder 数据根目录。 */
function resolveQoderRoot(): string {
  if (process.platform === 'darwin') {
    return resolveHome(DEFAULT_QODER_ROOT_MAC);
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Qoder');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'Qoder');
  return resolveHome(DEFAULT_QODER_ROOT_LINUX);
}

/** 把数据根目录与固定数据库相对路径组合为绝对路径。 */
function resolveQoderDbPath(dataRoot: string): string {
  return path.join(dataRoot, QODER_DB_RELATIVE_PATH);
}

/** 读取当前已含合法 token_info 的最大 rowid，空表返回 0。 */
function readMaxEligibleRowId(dbPath: string): Promise<number> {
  const sql = `
    SELECT COALESCE(MAX(rowid), 0) AS maxRowId
    FROM chat_message
    WHERE token_info IS NOT NULL
      AND token_info != ''
      AND json_valid(token_info)
  `;
  return queryReadonly<{ maxRowId: number }>(dbPath, sql, [])
    .then(rows => rows[0]?.maxRowId ?? 0);
}

/**
 * 用 sqlite3 回调 API 以只读模式执行查询，并包装为 Promise。
 * 数据库会在查询回调中关闭；打开、查询或关闭任一步失败都会拒绝 Promise，由上层决定告警或重试。
 */
function queryReadonly<T>(
  dbPath: string,
  sql: string,
  params: unknown[],
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    let db: sqlite3.Database;
    db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (openErr) => {
      if (openErr) {
        reject(openErr);
        return;
      }

      db.all(sql, params, (queryErr: Error | null, rows: T[]) => {
        db.close((closeErr) => {
          if (queryErr) {
            reject(queryErr);
            return;
          }
          if (closeErr) {
            reject(closeErr);
            return;
          }
          resolve(rows);
        });
      });
    });
  });
}

/** 安全解析 token_info JSON，只接受非数组对象。 */
function parseTokenInfo(raw: string): QoderTokenInfo | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as QoderTokenInfo;
  } catch {
    return null;
  }
}

/** 只接受有限数值，防止 NaN/Infinity 污染输出。 */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 两个 token 分项都存在时才计算总数，缺项时不编造 total。 */
function sumIfPresent(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined || right === undefined) return undefined;
  return left + right;
}
