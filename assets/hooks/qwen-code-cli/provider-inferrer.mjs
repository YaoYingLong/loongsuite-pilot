// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * 从 Qwen Code 会话推断 `gen_ai.provider.name`。
 *
 * assistant 通常带模型名，api_response telemetry 带 auth_type；模型更具体，故优先模型，
 * 再用 auth_type，最后回退 qwen。枚举与 entry-builder 的 inferProviderName 保持一致。
 * 本模块是无副作用纯函数，不读配置、文件或网络。
 */

/**
 * @param {string|undefined} model assistant.model 中的模型名。
 * @param {string|undefined} authType system.ui_telemetry 的 auth_type。
 * @returns {string} 标准 provider 枚举值。
 */
export function inferProvider(model, authType) {
  const m = (model || '').toLowerCase();
  if (/claude|anthropic/.test(m))     return 'anthropic';
  if (/qwen|tongyi/.test(m))          return 'qwen';
  if (/gpt|openai|codex|^o[1-9]/.test(m)) return 'openai';
  if (/gemini/.test(m))               return 'gcp.gemini';
  if (/deepseek/.test(m))             return 'deepseek';
  if (/grok|xai|x_ai/.test(m))        return 'x_ai';

  const a = (authType || '').toLowerCase();
  if (a === 'openai')    return 'openai';
  if (a === 'anthropic') return 'anthropic';
  if (a === 'gemini')    return 'gcp.gemini';
  if (a === 'qwen')      return 'qwen';

  // 默认端点是 DashScope；模型与 auth_type 都未知时回退 qwen，与下游按 agentType 推断一致。
  return 'qwen';
}
