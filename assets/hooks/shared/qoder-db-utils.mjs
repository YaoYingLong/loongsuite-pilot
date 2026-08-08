/**
 * Qoder 会话来源判定工具。
 *
 * Hook transcript 本身不足以区分 Qoder Desktop 与 IntelliJ 插件，因此 normalizer 会调用
 * 本模块只读查询 `~/.qoder/shared_client/cache/db/local.db`。Node 22+ 才提供内置
 * `node:sqlite`；项目最低 Node 18 环境会自然回退并返回 null，由调用方按 Desktop 处理。
 * 查询结果仅在当前短生命周期 Hook 进程内缓存，数据库连接始终在 finally 中关闭。
 */

import fs from 'node:fs';
import { homedir } from 'node:os';

// `node:sqlite` 仅在 Node 22+ 可用；模块初始化时只尝试加载一次。Node 18 下导入失败会被吞掉，
// `isQoderIdeaSession()` 返回 null，调用方安全回退为 `qoder`（Desktop IDE）。
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch { /* Node < 22：无法使用数据库判定，回退为 qoder。 */ }

// 以 sessionId 缓存结果，避免同一 Hook 进程内反复打开和关闭 SQLite。
const _cache = new Map();

/**
 * 检查 session 是否存在于 IntelliJ 专用 SQLite 数据库。
 *
 * @param {string} sessionId 待查会话 ID；作为 SQL 参数绑定，不进行字符串拼接。
 * @returns {boolean | null} true 表示 IntelliJ 会话；false 表示数据库存在但无此会话；
 * null 表示 SQLite 不可用、数据库不存在或查询失败。
 */
export function isQoderIdeaSession(sessionId) {
  if (!DatabaseSync) return null;
  if (_cache.has(sessionId)) return _cache.get(sessionId);

  const dbPath = homedir() + '/.qoder/shared_client/cache/db/local.db';
  if (!fs.existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readonly: true });
  try {
    // `?` 占位符由 SQLite 绑定参数，可避免 sessionId 改变 SQL 结构。
    const row = db.prepare('SELECT 1 FROM chat_session WHERE session_id = ? LIMIT 1').get(sessionId);
    const result = row !== undefined;
    _cache.set(sessionId, result);
    return result;
  } catch {
    return null;
  } finally {
    // 无论查询成功还是抛错都释放文件句柄，避免短时间大量 Hook 累积连接。
    db.close();
  }
}
