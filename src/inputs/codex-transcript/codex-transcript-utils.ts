/** Codex transcript 模块共享的确定性 hash/标量辅助函数。 */
/**
 * 读取源记录的 ISO 时间戳并转为 Unix 毫秒；缺失或格式无效时返回调用者提供的兜底值。
 * @param record rollout JSONL 中的一条已解析对象。
 * @param fallback 无法解析时间戳时使用的毫秒值。
 */
export function timestampMs(record: Record<string, unknown>, fallback: number): number {
  const value = stringValue(record.timestamp);
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 仅接受非空字符串，帮助解析器安全缩窄来自 JSON 的 `unknown` 值。 */
export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
