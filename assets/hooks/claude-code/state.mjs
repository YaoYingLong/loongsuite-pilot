// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Claude Code Hook 的会话状态持久化模块。
 *
 * Claude Code 每触发一次 `Stop`、`SubagentStart` 或 `SubagentStop`，都会启动一个短生命周期的
 * Hook processor 进程。不同 Hook 进程不能共享 JavaScript 内存，因此
 * `claude-code-hook-processor.mjs` 通过本模块按 `session_id` 读写状态文件：
 *
 * 1. `SubagentStart` 把子 Agent 启动信息追加到父 session 的 `events` 后调用 `saveState()`；
 * 2. `SubagentStop` 可调用 `readAndDeleteChildState()` 取走子 session 快照，再保存父 state；
 * 3. `Stop` 从 `transcript_offset` 开始增量解析 transcript；JSONL 成功落盘后，processor 才把
 *    临时的 `_next_transcript_offset` 提交为新的 `transcript_offset` 并再次调用 `saveState()`；
 * 4. 下一个 `Stop` 进程重新 `loadState()`，所以不会从文件头重复采集已经提交的字节。
 *
 * state 默认位于
 * `<LOONGSUITE_PILOT_DATA_DIR>/state/claude-code/sessions/<安全化 sessionId>.json`；未设置环境变量时
 * 数据根目录回退到 `~/.loongsuite-pilot`。目录常量在本 ES Module 第一次加载时计算一次，之后修改
 * `process.env.LOONGSUITE_PILOT_DATA_DIR` 不会改变本进程中的路径，测试或调用方应在 import 前设置环境变量。
 *
 * 兼容旧插件的基础结构如下；processor 还会按运行进度补充 `cwd`、`turn_count`、`stop_time` 等字段：
 * `{ session_id, start_time, prompt, model, transcript_path, transcript_offset,
 *    metrics: { input_tokens, output_tokens, tools_used, turns }, tools_used, events }`。
 *
 * 本模块只同步读写本地 JSON，不解析 transcript、不写采集 JSONL，也不直接触发 Collector 的
 * `entries`。真正的 `entries` 在 `ClaudeCodeLogInput` 后续轮询 processor 产出的 JSONL 时触发。
 * 同步 I/O 对短生命周期 Hook 而言可确保进程退出前完成落盘；`saveState()` 的失败会向 processor
 * 抛出，由 processor 的顶层 fail-open 错误处理记录，而不会有意改变 Claude Code 的业务结果。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 解析 Pilot 数据根目录。
 * @returns {string} 环境变量指定的目录，或当前用户主目录下的默认目录。
 */
function pilotDataDir() {
  // `||` 也会把空字符串视为“未配置”，避免把相对路径意外拼到当前工作目录。
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

// 每个 session 一个 JSON，既隔离并行会话，也让 offset 可以独立推进。
const STATE_DIR = path.join(pilotDataDir(), 'state', 'claude-code', 'sessions');

/**
 * 把外部提供的 session ID 转成可安全用作单个文件名的字符串。
 *
 * `path.basename()` 先去掉父目录片段，正则再把字母、数字、下划线和连字符之外的字符替换为
 * 下划线，从而避免 `../` 等路径穿越内容逃出 sessions 目录。完全为空时使用 `unknown`。
 *
 * @param {unknown} sessionId Claude Hook payload 中的 session 标识。
 * @returns {string} 不包含目录分隔符的安全文件名主体。
 */
export function sanitizeSessionId(sessionId) {
  // 先转成字符串，可统一处理数字、null 等防御性输入；正常调用方传入非空字符串。
  const base = path.basename(String(sessionId));
  return base.replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
}

/**
 * 确保状态目录存在。`recursive: true` 会一并创建缺失的父目录，目录已存在时不会报错。
 * @returns {string} 已确保存在的状态目录绝对路径。
 * @throws 没有写权限、磁盘故障等文件系统错误会原样抛给调用方。
 */
function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  return STATE_DIR;
}

/**
 * 组合某个 session 的状态文件路径。
 * @param {unknown} sessionId 原始 session ID。
 * @returns {string} `<STATE_DIR>/<安全化 ID>.json`。
 * @throws 创建状态目录失败时抛出文件系统异常。
 * @sideeffect 即使调用者只是准备读取或删除，缺失的状态目录也会在这里被创建。
 */
function stateFilePath(sessionId) {
  return path.join(ensureStateDir(), `${sanitizeSessionId(sessionId)}.json`);
}

/**
 * 读取一个 Claude session 的持久状态。
 *
 * processor 的各子命令都先调用本函数。文件存在且 JSON 合法时直接返回其中的对象；文件不存在或
 * 内容损坏时返回新的默认状态。损坏文件不会在这里删除，后续 `saveState()` 成功时会覆盖它。
 *
 * @param {string} sessionId 当前 Claude session ID，也是状态隔离键。
 * @returns {object} 已恢复的 state，或包含 offset=0、空 events 的新 state。
 * @throws 状态目录无法创建时可能抛错；单纯的 JSON 解析错误会被捕获并降级为默认状态。
 * @sideeffect 使用同步文件读取；损坏 JSON 会向 stderr 输出诊断信息。
 */
export function loadState(sessionId) {
  const sf = stateFilePath(sessionId);
  // 先判断存在性，使新会话不会把正常的 ENOENT 当成错误记录。
  if (fs.existsSync(sf)) {
    try {
      // 明确使用 UTF-8 文本读取，再交给 JSON.parse 恢复普通 JavaScript 对象。
      return JSON.parse(fs.readFileSync(sf, 'utf-8'));
    } catch (err) {
      // 文件损坏时忽略其内容并在下方重建默认状态；Hook 不能因旧 state JSON 中止。
      // eslint-disable-next-line no-console
      console.error(
        `[claude-code-hook] state file for session ${sessionId} corrupted; starting fresh (${err.message})`,
      );
    }
  }
  // 秒级 Unix 时间与 processor 生成的其他 Hook 状态字段保持一致。
  return {
    session_id: sessionId,
    start_time: Date.now() / 1000,
    prompt: '',
    model: 'unknown',
    transcript_path: null,
    // offset 是 transcript 的字节位置，不是行号；0 表示尚未提交任何已处理内容。
    transcript_offset: 0,
    // 这些旧插件字段为结构兼容而保留；当前主导出逻辑主要使用 offset/turn_count/events。
    metrics: { input_tokens: 0, output_tokens: 0, tools_used: 0, turns: 0 },
    tools_used: [],
    events: [],
  };
}

/**
 * 用“同目录临时文件 + rename”保存完整 state 快照。
 *
 * 先写临时文件可避免另一个 Hook 进程读到半段 JSON；临时文件包含 `process.pid`，用于降低不同
 * Hook 进程互相覆盖临时文件的概率。rename 与目标文件位于同一目录，因此不会跨文件系统移动。
 * 这里没有跨进程锁：若同一 session 的两个 Hook 同时“读取旧快照 -> 各自修改 -> 保存”，最后完成
 * rename 的快照会覆盖前一个快照，原子替换只防半写 JSON，并不能防止这种更新丢失；并发行为待确认。
 *
 * @param {string} sessionId 决定目标文件名的 session ID。
 * @param {object} state 要序列化的完整状态对象；本函数不会克隆或修改它。
 * @returns {void}
 * @throws JSON 序列化、临时文件写入或 rename 失败时，清理临时文件后原样抛出异常。
 * @sideeffect 同步创建目录并替换对应 session 的持久状态文件。
 */
export function saveState(sessionId, state) {
  const dest = stateFilePath(sessionId);
  const dir = path.dirname(dest);
  const tmp = path.join(dir, `${sanitizeSessionId(sessionId)}.${process.pid}.tmp`);
  try {
    // 不做 pretty-print，以减小短生命周期 Hook 每次更新状态的磁盘写入量。
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf-8');
    // 只有完整临时文件写完后才替换正式文件，读者看到的是旧快照或新快照之一。
    fs.renameSync(tmp, dest);
  } catch (err) {
    // 清理失败不覆盖原始异常；调用方更需要知道保存失败的根因。
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/**
 * 尽力删除某个 session 的状态文件。
 *
 * 当前 Claude processor 主流程没有调用该导出；它作为兼容能力保留。不存在、无权限等删除错误
 * 均被吞掉，因此调用方不能根据返回值判断是否真的删除成功。
 *
 * @param {string} sessionId 要清理的 session ID。
 * @returns {void}
 * @sideeffect `stateFilePath()` 会先确保状态目录存在，随后同步尝试删除文件。
 */
export function clearState(sessionId) {
  const sf = stateFilePath(sessionId);
  try { fs.unlinkSync(sf); } catch {}
}

/**
 * 读取并尽力删除一个子 session 的状态快照，供 `SubagentStop` 合并到父 state。
 *
 * `cmdSubagentStop()` 只在 child ID 有效、与父 ID 不同时调用本函数。解析成功后先尝试删除子文件，
 * 再把返回快照放到父 session event 的 `_child_state`。当前 `exportSession()` 尚未消费 `events`，
 * 成功处理下一次 `Stop` 时这些 events 会被清空，所以子 state 目前不会直接变成采集事件。
 *
 * @param {string} childSessionId Claude 提供的子 Agent session ID。
 * @returns {object|null} 成功解析的子 state；文件不存在或无法解析时返回 null。
 * @sideeffect 成功解析后同步尝试删除子状态文件；删除失败仍返回快照。
 * @throws 状态目录创建失败仍可能由 `stateFilePath()` 抛出。
 */
export function readAndDeleteChildState(childSessionId) {
  const sf = stateFilePath(childSessionId);
  // 没有子 state 是合法情况，例如子进程未曾触发可记录的 Hook。
  if (!fs.existsSync(sf)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(sf, 'utf-8'));
    // 删除使快照最多被一个 SubagentStop 正常消费；删除异常采用 fail-open。
    try { fs.unlinkSync(sf); } catch {}
    return data;
  } catch {
    // 解析失败时保留原文件，便于后续诊断；父 Hook 继续运行但不合并快照。
    return null;
  }
}

// ─── 兼容/清理辅助导出 ───

/**
 * 列出状态目录顶层的全部 JSON 文件绝对路径。
 *
 * 这是从旧插件迁移保留的清理辅助能力；截至当前代码，现有 `HookWatchdog` 没有导入它，实际清理
 * 策略待确认。函数只列目录，不递归、不解析 JSON，也不删除文件。
 *
 * @returns {string[]} 读取成功时的 JSON 文件路径；目录不存在或读取失败时返回空数组。
 */
export function listStateFiles() {
  try {
    if (!fs.existsSync(STATE_DIR)) return [];
    // 先保留 `.json` 文件名，再映射为调用方可直接 stat/unlink 的完整路径。
    return fs.readdirSync(STATE_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(STATE_DIR, f));
  } catch {
    return [];
  }
}

/**
 * 尽力读取文件最后修改时间，供兼容清理器判断状态是否陈旧。
 * @param {string} filePath 待检查的状态文件路径。
 * @returns {number} 成功时为 Unix 毫秒时间戳；文件不存在或 stat 失败时为 0。
 */
export function getStateMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

// 导出实际状态目录供外部诊断/兼容工具使用；常量本身不会创建目录。
export const CLAUDE_STATE_DIR = STATE_DIR;
