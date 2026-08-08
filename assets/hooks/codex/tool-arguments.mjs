// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Codex 工具参数兼容归一化工具。
 *
 * 早期 Hook 实现会把 Hook payload 与 transcript 中的工具参数合并：`bash` 与
 * `exec_command` 字段名不同，`apply_patch` 又可能直接给字符串。本模块把它们整理为稳定对象。
 * 当前仓库生产入口未发现对本文件的引用，仅单元测试仍覆盖；是否供外部已部署旧插件动态导入
 * 待确认，因此保留兼容行为，不应据此推断当前 Codex 主采集链仍解析 Hook 工具事件。
 */

/**
 * 仅使用单一来源归一化工具参数。
 * @param {string} toolName Codex 工具名。
 * @param {unknown} input 原始参数。
 * @returns {unknown} 归一化参数对象或原值。
 */
export function normalizeCodexToolArguments(toolName, input) {
  return mergeCodexToolArguments(toolName, input, toolName, input);
}

/**
 * 合并 Hook 与 transcript 两路参数，优先保留 Hook 中更直接的 command/workdir。
 * @param {string} toolName Hook 工具名。
 * @param {unknown} hookInput Hook 参数。
 * @param {string} transcriptToolName transcript 工具名。
 * @param {unknown} transcriptInput transcript 参数。
 * @returns {unknown} 适合写入 `gen_ai.tool.call.arguments` 的值。
 */
export function mergeCodexToolArguments(toolName, hookInput, transcriptToolName, transcriptInput) {
  const hookArgs = isPlainObject(hookInput) ? hookInput : {};
  const transcriptArgs = isPlainObject(transcriptInput) ? transcriptInput : {};
  const normalizedName = String(toolName || transcriptToolName || '').toLowerCase();
  const normalizedTranscriptName = String(transcriptToolName || '').toLowerCase();

  // 旧 Hook 称为 bash，rollout 称为 exec_command；两者统一只保留 command/workdir。
  if (normalizedName === 'bash' || normalizedTranscriptName === 'exec_command') {
    const command = hookArgs.command ?? transcriptArgs.command ?? transcriptArgs.cmd;
    const workdir = hookArgs.workdir ?? transcriptArgs.workdir;
    const out = {};
    if (command !== undefined) out.command = command;
    if (workdir !== undefined) out.workdir = workdir;
    return Object.keys(out).length > 0 ? out : hookInput;
  }

  // apply_patch 的历史输入可能是 `{command}` 或裸 patch 字符串，统一为对象。
  if (normalizedName === 'apply_patch') {
    if (hookArgs.command !== undefined) return hookArgs;
    if (transcriptArgs.command !== undefined) return transcriptArgs;
    if (typeof hookInput === 'string') return { command: hookInput };
    if (typeof transcriptInput === 'string') return { command: transcriptInput };
    if (isPlainObject(hookInput)) return hookInput;
    if (isPlainObject(transcriptInput)) return transcriptInput;
    const command = hookInput ?? transcriptInput;
    return command != null ? { command } : hookInput;
  }

  if (isPlainObject(transcriptInput)) return transcriptInput;
  return hookInput ?? transcriptInput;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
