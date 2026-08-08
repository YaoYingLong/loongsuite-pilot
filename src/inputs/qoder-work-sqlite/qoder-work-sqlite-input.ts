/**
 * Qoder Work / Qoder Work CN 本地 `agents.db` 增量输入。
 *
 * 本类是 Trace 关闭时的回退数据源之一：Orchestrator 为两个产品变体分别实例化它，
 * AgentDiscoveryService 启动后由 `BaseInput` 周期调用 `collect()`。每轮以 `messages.updated_at`
 * 秒级游标只读查询 SQLite，并通过 `sub_chats` 恢复 session 和模型；用户行生成 llm.request，
 * assistant 中的工具 part 生成 tool.result。标准事件随后由 InputManager 统一做策略、脱敏和输出。
 *
 * 首次启动把游标基线设到数据库当前最大时间，防止安装 Collector 后回放全部旧会话。数据库连接
 * 每次查询创建并在回调完成后关闭，没有跨周期句柄；查询/单行转换异常只记录日志，本轮仍保持
 * Collector 运行。StateStore 保存游标和有限长度的 tool.result event.id 去重集合。
 */
// Node 内置模块分别用于稳定哈希、异步文件可用性检查和跨平台路径拼接。
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
// sqlite3 提供回调式只读连接；下面 queryReadonly 将它包装成 Promise 供 async/await 使用。
import sqlite3 from 'sqlite3';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
// 所有数据库行最终都通过统一 builder 生成合法 AgentActivityEntry。
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
// BaseInput 管理启动首轮、定时器、串行周期、停止等待和 StateStore 落盘。
import { BaseInput, type InputOptions } from '../base/base-input.js';
// 与 SDK Log/Trace 输入复用同一套国际版/CN 平台数据根目录规则。
import { resolveQoderWorkRoot } from '../qoder-work-log/qoder-work-log-input.js';

/** Qoder Work 数据根目录内 SQLite 数据库的固定相对路径。 */
const DB_REL_PATH = path.join('data', 'agents.db');
/** 标记事件来源，最终作为 Agent 私有 attribute 输出。 */
const SOURCE = 'qoder-work-sqlite';
/** 老记录没有 model_level 时使用显式未知值，而不是猜测模型。 */
const UNKNOWN_MODEL = 'unknown';
/** 单轮最多查询的 messages 行数，限制一次轮询的内存和转换耗时。 */
const SQL_BATCH_LIMIT = 1000;
/** StateStore 中最多保留的工具结果 event.id，避免长期运行状态无限增长。 */
const TOOL_RESULT_DEDUPE_LIMIT = 50_000;

/** SQLite Input 的构造参数；可用显式路径覆盖平台默认位置，方便测试和特殊部署。 */
export interface QoderWorkSqliteInputOptions extends InputOptions {
  /** 完整 agents.db 路径；优先级高于 dataRoot。 */
  dbPath?: string;
  /** Qoder Work 数据根目录；未给 dbPath 时与 DB_REL_PATH 拼接。 */
  dataRoot?: string;
  /** 国际版或 CN Agent 类型；默认国际版。 */
  agentType?: ClientType;
}

/**
 * `messages` 与 `sub_chats.session_id/model_level` 联表后的内部行结构。
 * 注意：Qoder Work 的 `updated_at` 是 Unix 秒，不是 JavaScript 常用的毫秒。
 */
interface MessageRow {
  /** messages 主键，用于生成稳定 event.id。 */
  id: string;
  /** LEFT JOIN 恢复出的 Agent session；父记录缺失时为 null。 */
  sessionId: string | null;
  subChatId: string;
  /** 同一 sub_chat 内消息顺序。 */
  sequence: number;
  role: string;
  /** JSON 字符串，解析后应为消息 part 数组。 */
  parts: string;
  updatedAt: number;
  /**
   * `sub_chats.model_level` 保存实际 LLM 模型名，例如 `qwork-ultimate` / `qwork-auto`。
   * 父 sub_chat 缺失或旧记录未填充该列时可能为 null。
   */
  modelLevel: string | null;
}

/**
 * Qoder Work `agents.db` 轮询 Input。
 *
 * 新版本 Qoder Work 的 `sub_chats.messages` 通常保持 `'[]'`，真实聊天内容写在独立
 * `messages` 表，因此这里直接轮询 messages，并联表恢复 session/model。该类只补充用户 prompt
 * 与工具结果；完整 llm.response、精确时序和 token 由 SDK Log 或 Trace 路径负责。
 *
 * 输出规则：
 *   - 每条 role=user 且含文本的行输出一个 `llm.request`；
 *   - assistant 行中每个 `tool-*` part 输出一个 `tool.result`，但跳过 `tool-Thinking`。
 *
 * event.id 由关键字段做 SHA-256，重复读取同一行得到相同 ID；tool.result 另以 StateStore 集合
 * 去重。实例生命周期由 BaseInput 管理，类本身不保留数据库连接。
 */
export class QoderWorkSqliteInput extends BaseInput {
  /** `qoder-work-sqlite` 或 `qoder-work-cn-sqlite`。 */
  readonly id: string;
  readonly agentType: ClientType;
  /** 供发现和监控展示的数据采集方式。 */
  readonly collectionMethod = CollectionMethod.SqlitePolling;

  /** 当前实例实际查询的绝对数据库路径。 */
  protected readonly dbPath: string;

  /**
   * 保存依赖并根据产品变体解析默认 data root / DB 路径。
   * @param opts StateStore、轮询周期及可选路径/Agent 变体。
   */
  constructor(opts: QoderWorkSqliteInputOptions) {
    super(opts);
    const agentType = opts.agentType ?? ClientType.QoderWork;
    const dataRoot = opts.dataRoot ?? resolveQoderWorkRoot(agentType === ClientType.QoderWorkCN ? 'cn' : 'standard');
    this.agentType = agentType;
    this.id = `${agentType}-sqlite`;
    this.dbPath = opts.dbPath ?? path.join(dataRoot, DB_REL_PATH);
    this.pollIntervalMs = opts.pollIntervalMs ?? 30_000;
  }

  /**
   * 返回国际版数据库父目录，供默认 discovery watcher 使用。
   * @returns 单元素目录数组；CN 注册处由 Orchestrator 显式传入 CN watch path。
   */
  static getWatchPaths(): string[] {
    return [path.dirname(path.join(resolveQoderWorkRoot(), DB_REL_PATH))];
  }

  /**
   * 通过 fs.access 检查国际版 agents.db 是否可读。
   * @returns 文件可访问时为 true；任何权限/不存在异常都折叠为 false。
   */
  static async checkAvailability(): Promise<boolean> {
    try {
      await fs.access(path.join(resolveQoderWorkRoot(), DB_REL_PATH));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 首次启动建立 `lastUpdatedAt` 基线，避免回放 Collector 安装前的全部数据库历史。
   * 已存在数字游标时立即返回；基线查询失败只告警，后续 collect 会从默认 0 尝试。
   */
  protected override async onStart(): Promise<void> {
    const state = this.stateStore.get(this.id);
    // 数字 0 也是调用方显式设置的合法测试/重放游标，不能按 falsy 误判为缺失。
    if (state.extra && typeof state.extra.lastUpdatedAt === 'number') return;

    try {
      const baseline = await readMaxUpdatedAt(this.dbPath);
      const extra = toPlainObject(state.extra);
      this.stateStore.update(this.id, {
        extra: { ...extra, lastUpdatedAt: baseline },
      });
    } catch (err) {
      this.logger.warn('failed to baseline qoder-work sqlite cursor', { error: String(err) });
    }
  }

  /**
   * 执行一轮 SQLite 增量查询和行转换。
   *
   * 查询异常返回空数组；单行异常被隔离并继续后续行。即使某行无法转换，游标仍推进到本批最大
   * updated_at，避免永久卡在坏数据。StateStore 在 BaseInput 周期末统一保存。
   *
   * @returns 本批用户请求与工具结果事件，按 SQL 的时间/sequence 顺序排列。
   */
  protected async collect(): Promise<AgentActivityEntry[]> {
    const state = this.stateStore.get(this.id);
    // 状态缺失时从 0 开始；正常生产首次 onStart 已先写入数据库最大值。
    const cursor = (state.extra && typeof state.extra.lastUpdatedAt === 'number')
      ? state.extra.lastUpdatedAt as number
      : 0;

    let rows: MessageRow[];
    try {
      rows = await readNewMessageRows(this.dbPath, cursor);
    } catch (err) {
      this.logger.error('failed to read qoder-work sqlite rows', { error: String(err) });
      return [];
    }
    if (rows.length === 0) return [];

    const entries: AgentActivityEntry[] = [];
    // Set 同时提供 O(1) 查询和本轮新增 ID 累积，结束后再裁剪并写回。
    const emittedToolResultIds = new Set(getStringArray(state.extra, 'emittedToolResultIds'));
    let maxUpdate = cursor;

    // 行按 updated_at、sequence 排序；单行失败不影响本批其余数据。
    for (const row of rows) {
      if (row.updatedAt > maxUpdate) maxUpdate = row.updatedAt;
      try {
        const rowEntries = transformRow(row, this.agentType, emittedToolResultIds);
        entries.push(...rowEntries);
      } catch (err) {
        this.logger.warn('row transform failed', {
          messageId: row.id,
          error: String(err),
        });
      }
    }

    // 保留其他模块写入的 extra 字段，只覆盖本 Input 拥有的游标和去重窗口。
    const extra = toPlainObject(state.extra);
    this.stateStore.update(this.id, {
      extra: {
        ...extra,
        lastUpdatedAt: maxUpdate,
        emittedToolResultIds: capArray([...emittedToolResultIds], TOOL_RESULT_DEDUPE_LIMIT),
      },
    });
    return entries;
  }
}

/**
 * 把一条联表行转换为零到多个标准事件。
 * @param row SQLite 联表结果。
 * @param agentType 国际版或 CN 产品类型。
 * @param emittedToolResultIds 跨轮询工具结果去重集合；函数会原地加入新 event.id。
 * @returns 用户行最多一个 request；assistant 行可返回多个 tool.result；坏 JSON/无关行返回空数组。
 */
function transformRow(
  row: MessageRow,
  agentType: ClientType,
  emittedToolResultIds: Set<string> = new Set(),
): AgentActivityEntry[] {
  const sessionId = row.sessionId ?? '';
  // Qoder Work 保存 Unix 秒；乘 1000 转为毫秒，才能与其余 Input 的时间单位一致。
  const tsMs = row.updatedAt > 0 ? row.updatedAt * 1000 : Date.now();
  const model = row.modelLevel && row.modelLevel.length > 0
    ? row.modelLevel
    : UNKNOWN_MODEL;

  // SQLite 列是 JSON 文本；解析失败说明该行不可消费，但不能让整个周期失败。
  let parts: unknown;
  try {
    parts = JSON.parse(row.parts);
  } catch {
    return [];
  }
  if (!Array.isArray(parts)) return [];

  const out: AgentActivityEntry[] = [];

  if (row.role === 'user') {
    // 只拼接 text part；空 prompt 不输出伪 llm.request。
    const content = extractUserText(parts as unknown[]);
    if (!content) return out;
    out.push(
      buildAgentActivityEntry({
        timestamp: tsMs,
        'event.id': hashId([sessionId, row.id, 'user']),
        'event.name': 'llm.request',
        'gen_ai.session.id': sessionId,
        'gen_ai.agent.type': agentType,
        'gen_ai.request.model': model,
        'gen_ai.input.messages_delta': [
          { role: 'user', content },
        ],
        attributes: {
          source: SOURCE,
          event_kind: 'user_prompt',
          message_id: row.id,
          sub_chat_id: row.subChatId,
          sequence: row.sequence,
        },
      }),
    );
    return out;
  }

  // system 等其他角色当前没有可靠映射，直接跳过。
  if (row.role !== 'assistant') return out;

  // 一个 assistant message 可能包含多个工具 part，因此逐项生成独立 tool.result。
  for (let i = 0; i < parts.length; i++) {
    const partRaw = (parts as unknown[])[i];
    if (!partRaw || typeof partRaw !== 'object') continue;
    const part = partRaw as Record<string, unknown>;
    const partType = stringOr(part.type, '');
    // Thinking 是推理内容而非真实工具执行结果，必须排除。
    if (!partType.startsWith('tool-') || partType === 'tool-Thinking') continue;

    const callId = stringOr(part.toolCallId, '') || stringOr(part.tool_call_id, '');
    // 字段名随版本变化；最后从 `tool-Xxx` 类型名推导工具名。
    const toolName = stringOr(part.toolName, '')
      || stringOr(part.tool_name, '')
      || stringOr(part.name, '')
      || partType.replace(/^tool-/, '');

    const rawResult = part.output ?? part.result;
    // 缺 call ID 无法与 tool.call 配对，缺结果则不应伪造成功记录。
    if (!callId || rawResult === undefined) continue;

    const resultPayload: JsonValue = typeof rawResult === 'string'
      ? rawResult
      : toJsonValue(rawResult) ?? '';

    // 结果内容也参与 ID，允许同一 call ID 的实际结果修订形成新事件。
    const eventId = hashId([sessionId, row.id, 'tool_result', callId, toolName, hashJson(resultPayload)]);
    if (emittedToolResultIds.has(eventId)) continue;
    emittedToolResultIds.add(eventId);

    out.push(
      buildAgentActivityEntry({
        timestamp: tsMs,
        'event.id': eventId,
        'event.name': 'tool.result',
        'gen_ai.session.id': sessionId,
        'gen_ai.agent.type': agentType,
        'gen_ai.request.model': model,
        'gen_ai.tool.name': toolName,
        'gen_ai.tool.call.id': callId,
        'gen_ai.tool.call.exec.id': callId,
        'gen_ai.tool.call.result': resultPayload,
        'tool.result.status': 'success',
        attributes: {
          source: SOURCE,
          event_kind: 'tool_result',
          message_id: row.id,
          sub_chat_id: row.subChatId,
          part_type: partType,
        },
      }),
    );
  }

  return out;
}

/**
 * 从用户消息 parts 中提取全部 text/content，并用换行保持 part 边界。
 * @param parts JSON 解析后的未知 part 数组。
 * @returns 合并文本；没有文本时为空字符串。
 */
function extractUserText(parts: unknown[]): string {
  const texts: string[] = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    const part = p as Record<string, unknown>;
    if (stringOr(part.type, '') !== 'text') continue;
    const t = stringOr(part.text, '') || stringOr(part.content, '');
    if (t) texts.push(t);
  }
  return texts.join('\n');
}

/**
 * 查询游标之后的非空 messages，并 LEFT JOIN sub_chats 恢复 session/model。
 * @param dbPath agents.db 完整路径。
 * @param cursor 上次成功推进的 Unix 秒 updated_at。
 * @returns 最多 SQL_BATCH_LIMIT 行，按更新时间和消息顺序升序排列。
 */
function readNewMessageRows(dbPath: string, cursor: number): Promise<MessageRow[]> {
  // LEFT JOIN 保留父 sub_chat 已缺失的消息；此时 sessionId 为 null，但消息内容仍可观察。
  const sql = `
    SELECT
      m.id           AS id,
      sc.session_id  AS sessionId,
      m.sub_chat_id  AS subChatId,
      m.sequence     AS sequence,
      m.role         AS role,
      m.parts        AS parts,
      m.updated_at   AS updatedAt,
      sc.model_level AS modelLevel
    FROM messages m
    LEFT JOIN sub_chats sc ON sc.id = m.sub_chat_id
    WHERE m.updated_at > ?
      AND m.parts IS NOT NULL
      AND m.parts != ''
      AND m.parts != '[]'
    ORDER BY m.updated_at ASC, m.sequence ASC
    LIMIT ${SQL_BATCH_LIMIT}
  `;
  return queryReadonly<MessageRow>(dbPath, sql, [cursor]);
}

/**
 * 读取 messages 当前最大 updated_at，供首次启动建立不回放历史的基线。
 * @returns 表为空时兑现为 0。
 */
function readMaxUpdatedAt(dbPath: string): Promise<number> {
  const sql = `SELECT COALESCE(MAX(updated_at), 0) AS maxUpdate FROM messages`;
  return queryReadonly<{ maxUpdate: number }>(dbPath, sql, []).then(
    rows => rows[0]?.maxUpdate ?? 0,
  );
}

/**
 * 把 sqlite3 的 open/all/close 回调链包装成 Promise，并强制只读打开。
 *
 * query 和 close 任一失败都会 reject，由 collect/onStart 上层记录并恢复；无论查询成功与否，
 * `db.close` 都在 all 回调中执行，因此不会跨轮询泄漏连接。
 *
 * @param dbPath 数据库路径。
 * @param sql 使用 `?` 占位符的查询文本。
 * @param params 与占位符顺序一致的绑定值。
 * @returns 查询结果行数组。
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
      // 先完成查询，再在 close 回调中决定 Promise，确保调用方继续前连接已释放。
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

/** 从 InputState.extra 安全读取非空字符串数组，坏类型视为空数组。 */
function getStringArray(extra: unknown, key: string): string[] {
  const value = toPlainObject(extra)[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

/** 把未知值收窄为普通对象，数组/null 等返回新空对象。 */
function toPlainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** 仅保留数组末尾 max 项，用于限制持久化去重窗口。 */
function capArray<T>(values: T[], max: number): T[] {
  return values.length > max ? values.slice(values.length - max) : values;
}

/** 读取非空字符串，否则返回调用方提供的 fallback。 */
function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** 对 JSON 值的稳定序列化结果计算 SHA-256，用于内容参与 event.id。 */
function hashJson(value: JsonValue): string {
  return crypto
    .createHash('sha256')
    .update(stableStringify(value))
    .digest('hex');
}

/**
 * 键排序 JSON 序列化；对象属性插入顺序不同但语义相同时产生同一字符串。
 * @param value 已保证可 JSON 化的值。
 */
function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/** 用 NUL 分隔关键字段后生成确定性 SHA-256 event.id，避免普通拼接边界歧义。 */
function hashId(parts: Array<string | number | undefined>): string {
  return crypto
    .createHash('sha256')
    .update(parts.map(p => p ?? '').join('\0'))
    .digest('hex');
}

/**
 * 递归把数据库中的任意值收敛为 JsonValue；undefined 被省略，其他非常规值转字符串。
 * @param value SQLite JSON part 中的未知值。
 * @returns 可安全传给 entry-builder 的值，或 undefined。
 */
function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    // 数组中的 undefined 项直接丢弃，避免生成不可序列化成员。
    const arr: JsonValue[] = [];
    for (const item of value) {
      const v = toJsonValue(item);
      if (v !== undefined) arr.push(v);
    }
    return arr;
  }
  if (typeof value === 'object') {
    // 对象属性同样跳过 undefined，保留其余键名和递归结构。
    const obj: { [key: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const json = toJsonValue(v);
      if (json !== undefined) obj[k] = json;
    }
    return obj;
  }
  return String(value);
}
