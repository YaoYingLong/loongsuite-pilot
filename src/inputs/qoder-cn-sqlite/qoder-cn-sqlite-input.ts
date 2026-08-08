/** Qoder CN SQLite 增量备用 Input；仅在更优先的 trace 数据源未启用时由 Orchestrator 选择。 */
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

const DEFAULT_QODER_CN_ROOT_MAC = '~/Library/Application Support/QoderCN';
const DEFAULT_QODER_CN_ROOT_LINUX = '~/.config/QoderCN';
const QODER_CN_DB_RELATIVE_PATH = path.join('SharedClientCache', 'cache', 'db', 'local.db');
const SOURCE = 'qoder-cn-sqlite-chat-message';
const UNKNOWN_MODEL = 'unknown';

export interface QoderCnSqliteInputOptions extends Omit<SqliteInputOptions, 'dbPath'> {
  dbPath?: string;
  dataRoot?: string;
}

interface QoderCnTokenRow extends SqliteRow {
  id: string;
  sessionId: string | null;
  requestId: string | null;
  role: string | null;
  tokenInfo: string;
  gmtCreate: number;
}

interface QoderCnTokenInfo {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  max_input_tokens?: number;
}

/**
 * 从 Qoder CN `SharedClientCache/cache/db/local.db` 增量采集 token usage 的备用 Input。
 *
 * BaseSqliteInput 管理周期与 rowid；本类只读查询 chat_message 并生成 llm.response。首次启动
 * baseline 当前最大 rowid，避免安装后回放全部历史，状态 key 和 ClientType 与国际版隔离。
 */
export class QoderCnSqliteInput extends BaseSqliteInput {
  readonly id = 'qoder-cn-sqlite';
  readonly agentType = ClientType.QoderCn;

  /** 解析 CN 数据库路径，并将通用状态与轮询配置交给 BaseSqliteInput。 */
  constructor(opts: QoderCnSqliteInputOptions) {
    const dataRoot = opts.dataRoot ?? resolveQoderCnRoot();
    super({
      stateStore: opts.stateStore,
      dbPath: opts.dbPath ?? resolveQoderCnDbPath(dataRoot),
      pollIntervalMs: opts.pollIntervalMs
        ?? (Number(process.env.QODER_CN_ANALYTICS_POLL_INTERVAL) || 30_000),
    });
  }

  /** 返回 CN 数据库父目录，供 Agent 发现服务监听。 */
  static getWatchPaths(): string[] {
    return [path.dirname(resolveQoderCnDbPath(resolveQoderCnRoot()))];
  }

  /** 检查默认 CN 数据库是否可访问，不存在或无权限时返回 false。 */
  static async checkAvailability(): Promise<boolean> {
    try {
      await fs.access(resolveQoderCnDbPath(resolveQoderCnRoot()));
      return true;
    } catch {
      return false;
    }
  }

  /** 无历史游标时把当前最大可用 rowid 保存为 baseline；失败只告警，不阻止后续轮询。 */
  protected override async onStart(): Promise<void> {
    // 已持久化 lastRowId 时必须继续消费，不能重新 baseline 覆盖停机期间的增量。
    if (this.stateStore.get(this.id).lastRowId !== undefined) return;

    try {
      // 首次运行跳过数据库中已有历史，只从当前最大 eligible rowid 之后开始。
      const maxRowId = await readMaxEligibleRowId(this.dbPath);
      this.stateStore.setRowId(this.id, maxRowId);
    } catch (err) {
      this.logger.warn('failed to baseline QoderCN SQLite cursor', { error: String(err) });
    }
  }

  /** 只读查询 lastRowId 之后含合法 token_info 的行，并保持 rowid 顺序。 */
  protected async readNewRows(lastRowId: number): Promise<SqliteRow[]> {
    // 在 SQLite 侧过滤空 token_info 和非法 JSON，Node.js 只接收可转换候选行。
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

    // 使用占位参数传递游标，避免拼接 SQL。
    return queryReadonly<QoderCnTokenRow>(this.dbPath, sql, [lastRowId]);
  }

  /** 把 CN token 行映射为标准 llm.response；无效 token JSON 返回 null，由基类跳过。 */
  protected async transformRow(row: SqliteRow): Promise<AgentActivityEntry | null> {
    const qoderCnRow = row as QoderCnTokenRow;
    const tokenInfo = parseTokenInfo(qoderCnRow.tokenInfo);
    if (!tokenInfo) return null;

    // token 分项分别校验，允许源版本只提供其中一部分。
    const inputTokens = finiteNumber(tokenInfo.prompt_tokens);
    const outputTokens = finiteNumber(tokenInfo.completion_tokens);
    const cacheReadTokens = finiteNumber(tokenInfo.cached_tokens);
    const maxInputTokens = finiteNumber(tokenInfo.max_input_tokens);

    // 保留数据库定位字段，出现 usage 差异时可以回查原始 chat_message 行。
    const attributes: Record<string, JsonValue> = {
      source: SOURCE,
      rowid: qoderCnRow.rowid,
      message_id: qoderCnRow.id,
    };
    if (qoderCnRow.requestId) attributes.request_id = qoderCnRow.requestId;
    if (maxInputTokens !== undefined) attributes.max_input_tokens = maxInputTokens;

    return buildAgentActivityEntry({
      timestamp: qoderCnRow.gmtCreate,
      'event.id': qoderCnRow.id || undefined,
      'event.name': 'llm.response',
      'gen_ai.session.id': qoderCnRow.sessionId ?? '',
      'gen_ai.agent.type': ClientType.QoderCn,
      'gen_ai.request.model': UNKNOWN_MODEL,
      'gen_ai.response.model': UNKNOWN_MODEL,
      'gen_ai.usage.input_tokens': inputTokens,
      'gen_ai.usage.output_tokens': outputTokens,
      'gen_ai.usage.cache_read.input_tokens': cacheReadTokens,
      // 任一分项缺失时不输出 total，避免把未知量错误当作 0。
      'gen_ai.usage.total_tokens': sumIfPresent(inputTokens, outputTokens),
      attributes,
    });
  }
}

/** 按当前平台和 XDG/APPDATA 约定解析 Qoder CN 数据根目录。 */
function resolveQoderCnRoot(): string {
  if (process.platform === 'darwin') {
    return resolveHome(DEFAULT_QODER_CN_ROOT_MAC);
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'QoderCN');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'QoderCN');
  return resolveHome(DEFAULT_QODER_CN_ROOT_LINUX);
}

/** 将 CN 数据根目录和固定相对路径组合成数据库路径。 */
function resolveQoderCnDbPath(dataRoot: string): string {
  return path.join(dataRoot, QODER_CN_DB_RELATIVE_PATH);
}

/** 查询含合法 token_info 的最大 rowid，空表用 0 表示。 */
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
 * 将 sqlite3 的只读打开、查询、关闭回调包装为 Promise；任一步错误都会拒绝 Promise。
 */
function queryReadonly<T>(
  dbPath: string,
  sql: string,
  params: unknown[],
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    let db: sqlite3.Database;
    // 只读打开 Agent 数据库，本采集器不会执行建表、更新或事务操作。
    db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (openErr) => {
      if (openErr) {
        reject(openErr);
        return;
      }

      // 查询回调中始终关闭连接，关闭完成后再向 async 调用方返回结果或错误。
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

/** 安全解析 CN token_info，只接受普通 JSON 对象。 */
function parseTokenInfo(raw: string): QoderCnTokenInfo | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as QoderCnTokenInfo;
  } catch {
    return null;
  }
}

/** 仅保留有限 number，过滤非数字和非有限值。 */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 输入与输出 token 均存在时相加，否则保持 undefined。 */
function sumIfPresent(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined || right === undefined) return undefined;
  return left + right;
}
