// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * 多种 Agent Hook processor 共用的事件 ID、消息 hash 与 JSONL 写入工具。
 *
 * 文件名中的 `event-emitter` 指“生成并落下事件记录”，不是 Node.js 的 `EventEmitter`。本模块
 * 不发出 `entries` 事件，也不知道 `InputManager` 或 Flusher。以 Claude 为例，调用关系是：
 *
 *   claude-code-hook-processor.exportSession()
 *     -> `writeJsonlRecords()` 同步追加本地 JSONL
 *     -> 常驻 Collector 的 BaseHookInput 后续轮询新增行
 *     -> BaseInput 才触发 `entries`
 *
 * Hook 进程生命周期很短，因此 writer 使用同步 API，保证函数返回前数据已经交给操作系统；
 * 它没有调用 fsync，不能承诺断电后的物理持久化。序列化/建目录/追加异常会原样抛给 processor，
 * Claude 的 `cmdStop()` 因此不会提交新的 transcript offset，下次 Stop 可以重试。
 *
 * 主要导出：
 * - `INITIAL_HASH`：SHA-256(空字符串) 的前 32 个十六进制字符，作为消息 hash 链起点；
 * - `hashStep()`/`computeHash()`：按消息顺序推进 hash，支持只记录 input.messages_delta；
 * - `shouldLogFullMessages()`：增量无法重建当前全量 hash 时要求写一次完整 messages；
 * - `generateTraceId()`/`generateSpanId()`：只依赖 crypto，不要求初始化 OTel SDK；
 * - `writeJsonlRecords()`：追加 `<logDir>/<agentId>-YYYY-MM-DD.jsonl`。
 */

// Node.js 内置模块：fs 负责同步目录/文件写入，path 负责跨平台路径，crypto 负责 ID/hash。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ─── trace/span id 生成(纯 crypto,与 OTel JS SDK 内部 IdGenerator 行为一致) ───

/** 生成符合 OTel 宽度的 32 位十六进制 trace ID；使用密码学随机字节避免跨进程碰撞。 */
export function generateTraceId() {
  return crypto.randomBytes(16).toString('hex'); // 16 字节编码为 32 个十六进制字符。
}

/** 生成符合 OTel 宽度的 16 位十六进制 span ID。 */
export function generateSpanId() {
  return crypto.randomBytes(8).toString('hex'); // 8 字节编码为 16 个十六进制字符。
}

// ─── chain hash(用于增量记录 input.messages_delta + 间或写出 input.messages 全量) ───

/**
 * 按稳定键序递归序列化 JSON 值，使对象属性的插入顺序不改变消息 hash。
 * 该字符串只用于 hash，不作为最终 JSONL 输出；数组顺序保留，因为消息顺序具有业务含义。
 */
function stableSerialize(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'boolean' || typeof obj === 'number') return JSON.stringify(obj);
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(stableSerialize).join(',') + ']';
  }
  if (typeof obj === 'object') {
    // 对象键排序后再序列化，使同一语义对象不受属性插入顺序影响。
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => JSON.stringify(k) + ':' + stableSerialize(obj[k]));
    return '{' + parts.join(',') + '}';
  }
  return JSON.stringify(obj);
}

/** 消息链固定起点；截断为 32 字符是项目协议约定，不等同于 trace ID。 */
export const INITIAL_HASH = crypto.createHash('sha256').update('').digest('hex').slice(0, 32);

/** 将前序 hash 文本与一条稳定序列化消息拼接，再计算下一步 hash。 */
export function hashStep(prevHash, msg) {
  const msgBytes = Buffer.from(stableSerialize(msg), 'utf-8');
  const combined = Buffer.concat([Buffer.from(prevHash, 'utf-8'), msgBytes]);
  return crypto.createHash('sha256').update(combined).digest('hex').slice(0, 32);
}

/**
 * 按数组顺序把一组增量消息依次并入 hash 链。
 * `deltaMessages` 缺失时按空数组处理并返回原 hash，不修改输入数组或消息对象。
 */
export function computeHash(prevHash, deltaMessages) {
  // 每条新增 message 都以前一步结果为输入，形成不可交换的有序 hash 链。
  let h = prevHash;
  for (const msg of deltaMessages || []) {
    h = hashStep(h, msg);
  }
  return h;
}

/**
 * 判断下游能否仅凭旧 hash 和本次 delta 得到当前全量 hash；不能时必须附带完整 messages 重建基线。
 */
export function shouldLogFullMessages(prevHash, delta, currentFullHash) {
  // 若增量推导不出当前全量 hash，写出一次全量消息供下游重新建立基线。
  return computeHash(prevHash, delta) !== currentFullHash;
}

// ─── JSONL 文件写入 ───

/** 使用 Hook 进程本地时区生成日文件后缀；Collector 会同时轮询最近数个日文件处理跨时区迟写。 */
function todayStamp() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 计算本地日轮转 JSONL 路径，不创建目录也不访问磁盘。
 * @param {string} logDir Agent 独立日志目录。
 * @param {string} agentId 文件名前缀，例如 `claude-code`。
 * @returns {string} `<logDir>/<agentId>-YYYY-MM-DD.jsonl`。
 */
export function getJsonlFilePath(logDir, agentId) {
  return path.join(logDir, `${agentId}-${todayStamp()}.jsonl`);
}

/**
 * 把一批标准记录同步追加到当前日期的 JSONL 文件。
 *
 * 空值或空数组直接返回，不创建目录/文件，所以不会把“空批次”交给任何 Flusher。非空时先将
 * 每个对象序列化为独占一行的 JSON，并在整批末尾补换行，再通过一次 `appendFileSync` 追加。
 * 末尾换行让 BaseHookInput 按 `\n` 拆分时只看到完整记录，也把并发追加落在记录边界之后。
 *
 * 所有记录先在内存完成 JSON.stringify；若存在 BigInt、循环引用等不可序列化值，会在文件写入
 * 前抛错。mkdir/append 的权限、磁盘空间等错误也会向调用方传播，由外层决定是否提交 offset。
 *
 * @param {string} logDir 目标 Agent 日志目录。
 * @param {string} agentId 日文件前缀。
 * @param {object[]} records 已完成规范化和内容策略处理的记录数组。
 * @returns {void} 写入成功后无返回值；本函数不会触发 `entries`。
 * @throws JSON 序列化、目录创建或文件追加失败时抛出原始异常。
 */
export function writeJsonlRecords(logDir, agentId, records) {
  // 空批次不产生空文件；Collector 因而也不会在后续轮询中读到任何新增行。
  if (!records || records.length === 0) return;
  const filePath = getJsonlFilePath(logDir, agentId);
  // recursive=true 允许数据根目录尚不存在，并且目录已存在时不会报错。
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // 先构造整个字符串再 append，避免同一批在用户态被拆成多个半行写操作。
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  // append 模式保留同日已有 turn；同步调用返回时本批字节已提交给操作系统文件 API。
  fs.appendFileSync(filePath, lines, 'utf-8');
}
