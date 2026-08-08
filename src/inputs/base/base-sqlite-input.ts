/**
 * SQLite 增量轮询 Input 基类。
 *
 * 子类只实现 `rowid > cursor` 查询和单行转换；本类逐行隔离转换错误，并把成功执行转换的
 * 最大 rowid 写入 StateStore。数据库读取失败返回空批，BaseInput 周期仍可继续。
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
  /** SQLite 隐式行号，必须随查询结果返回并按增量顺序使用。 */
  rowid: number;
  /** 源记录创建时间；具体单位由子类对应数据库 schema 解释。 */
  gmtCreate: number;
  [key: string]: unknown;
}

/**
 * 使用 StateStore rowid 游标的 SQLite Input 抽象类。
 */
export abstract class BaseSqliteInput extends BaseInput {
  readonly collectionMethod = CollectionMethod.SqlitePolling;

  protected readonly dbPath: string;

  /**
   * @param opts 基础轮询依赖和数据库路径；构造时不打开数据库连接。
   */
  constructor(opts: SqliteInputOptions) {
    super(opts);
    this.dbPath = opts.dbPath;
  }

  /**
   * 查询 `rowid` 游标之后的增量行，顺序转换并更新内存 checkpoint。
   *
   * 数据库查询整体失败被降级为空批，不修改 rowid；单行转换失败只告警，循环继续。maxRowId
   * 只在该行 transform 正常返回后更新，但后续更大 rowid 成功时仍会跨过之前失败行。因此失败
   * 行是否重试取决于它后面是否还有成功行，当前并非严格的逐行确认队列。
   *
   * @returns 本轮成功转换且非 null 的标准事件；真正落盘由 BaseInput 周期末 save 完成。
   */
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

    // maxRowId 更新位于 try 内；失败行本身不推进，但后续成功行可把游标推进到它之后。
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
   * @param lastRowId StateStore 中已保存边界，首次运行通常为 0。
   * @returns 建议按 rowid 升序排列的行；若无排序，游标与输出顺序由子类自行保证。
   * @throws 数据库打开/SQL 错误可抛出，本类会记录并让本轮返回空数组。
   */
  protected abstract readNewRows(lastRowId: number): Promise<SqliteRow[]>;

  /**
   * 把一行转换为标准事件；返回 null 表示有意跳过。
   * @throws 单行异常由 collect 捕获，不会中断本批其他行。
   */
  protected abstract transformRow(row: SqliteRow): Promise<AgentActivityEntry | null>;
}
