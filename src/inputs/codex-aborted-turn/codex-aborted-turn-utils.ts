/**
 * 旧 `CodexAbortedTurnInput` 的安全取值工具，当前生产 Orchestrator 不会直接走到这里。
 *
 * rollout JSONL 来自外部程序，反序列化后只能先视为 `unknown`；这些纯函数负责做运行时类型收窄，
 * 避免解析器直接读取错误形状而抛出 `TypeError`。本文件不读写文件、不修改输入，也没有全局状态。
 */
/**
 * 判断未知值是否是可按键读取的普通对象。
 * @param value `JSON.parse` 后仍未验证的数据。
 * @returns 非空、非数组对象；其他值返回 `null`。
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * 提取非空字符串，空字符串也按缺失处理，便于调用方使用默认值。
 * @param value 待检查字段。
 * @returns 非空字符串或 `undefined`。
 */
export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 把记录顶层的 ISO 时间戳转换为 Unix 毫秒。
 * @param record rollout 中的一行对象。
 * @returns 有效毫秒值；字段缺失或 `Date.parse` 失败时返回 `undefined`。
 */
export function timestampMs(record: Record<string, unknown>): number | undefined {
  const timestamp = stringValue(record.timestamp);
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}
