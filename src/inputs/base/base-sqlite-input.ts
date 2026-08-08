/**
 * SQLite 增量轮询 Input 基类。
 *
 * 子类只实现 `rowid > cursor` 查询和单行转换；本类逐行隔离转换错误，并把本批见到的最大
 * rowid 写入 StateStore。数据库读取失败返回空批，BaseInput 周期仍可继续。
 */

import { CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseInput, type InputOptions } from './base-input.js';

export interface SqliteInputOptions extends InputOptions {
  /** SQLite 数据库路径。 */
  dbPath: string;
}

/**
 * readNewRows 的最小行结构；子类可扩展任意列。
 * rowid 用作游标，gmtCreate 提供源时间。
 */
export interface SqliteRow {
  rowid: number;
  gmtCreate: number;
  [key: string]: unknown;
}

/**
 * 使用 StateStore rowid 游标的 SQLite Input 抽象类。
 */
export abstract class BaseSqliteInput extends BaseInput {
  readonly collectionMethod = CollectionMethod.SqlitePolling;

  protected readonly dbPath: string;

  /** @param opts 基础轮询依赖和数据库路径。 */
  constructor(opts: SqliteInputOptions) {
    super(opts);
    this.dbPath = opts.dbPath;
  }

  /** 查询增量行、逐行转换，并在最后推进到最大 rowid。 */
  protected async collect(): Promise<AgentActivityEntry[]> {
    const lastRowId = this.stateStore.getRowId(this.id);
    let rows: SqliteRow[];

    try {
      rows = await this.readNewRows(lastRowId);
    } catch (err) {
      this.logger.error('failed to read SQLite rows', { error: String(err) });
      return [];
    }

    if (rows.length === 0) return [];

    const entries: AgentActivityEntry[] = [];
    let maxRowId = lastRowId;

    // transform 失败仍推进该 rowid，避免永久毒行阻塞后续数据。
    for (const row of rows) {
      try {
        const entry = await this.transformRow(row);
        if (entry) entries.push(entry);
        if (row.rowid > maxRowId) maxRowId = row.rowid;
      } catch (err) {
        this.logger.warn('row transform failed', { rowid: row.rowid, error: String(err) });
      }
    }

    this.stateStore.setRowId(this.id, maxRowId);
    return entries;
  }

  /**
   * 查询 `rowid > lastRowId` 的源表行。
   * @throws 数据库打开/SQL 错误可抛出，本类会记录并让本轮返回空数组。
   */
  protected abstract readNewRows(lastRowId: number): Promise<SqliteRow[]>;

  /**
   * 把一行转换为标准事件；返回 null 表示有意跳过。
   */
  protected abstract transformRow(row: SqliteRow): Promise<AgentActivityEntry | null>;
}
