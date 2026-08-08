/**
 * Hook transcript bootstrap 批次的二次历史重放保护。
 *
 * Hook processor 通常已只保留最新 turn；Input 仍按 cursor_batch_id 再过滤一次，防止全局文件
 * offset 已被较早 session 初始化后，另一个旧 session 把历史批次重新送入 Trace。
 */

import type { AgentActivityEntry } from '../../types/index.js';

/**
 * 每个 bootstrap cursor batch 只保留最后观察到的逻辑 turn。
 * 非 bootstrap 记录全部保留；缺少 batch/turn 字段的混合版本记录 fail-open。
 */
export function filterBootstrapHistoryTurns(
  entries: AgentActivityEntry[],
): AgentActivityEntry[] {
  const latestTurnByBatch = new Map<string, string>();

  for (const entry of entries) {
    if (entry['agent.transcript.cursor_mode'] !== 'bootstrap') continue;
    const batchId = nonEmptyString(entry['agent.transcript.cursor_batch_id']);
    const turnId = nonEmptyString(entry['gen_ai.turn.id']);
    // Map 覆盖同 batch 之前 turn，因此循环结束值就是该批最后 turn。
    if (batchId && turnId) latestTurnByBatch.set(batchId, turnId);
  }

  if (latestTurnByBatch.size === 0) return entries;

  return entries.filter(entry => {
    if (entry['agent.transcript.cursor_mode'] !== 'bootstrap') return true;
    const batchId = nonEmptyString(entry['agent.transcript.cursor_batch_id']);
    const turnId = nonEmptyString(entry['gen_ai.turn.id']);
    // 混合版本/畸形记录缺少任一标识时无法安全区分 transcript，选择保留。
    if (!batchId || !turnId) return true;
    return latestTurnByBatch.get(batchId) === turnId;
  });
}

/** 将 unknown 收窄为非空字符串。 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
