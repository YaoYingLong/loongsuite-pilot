/**
 * 时间格式化工具。
 *
 * 本文件属于无状态的通用工具层，供日志、指标和诊断输出把 `Date` 转成便于人阅读的
 * 本地时间字符串。它不读取配置、不访问文件，也不会改变传入的 `Date`。
 */

/**
 * 将时间格式化为本地时区的 `YYYY-MM-DD HH:mm:ss`。
 *
 * @param date 要格式化的 JavaScript `Date`；各字段通过本地时区 getter 读取。
 * @returns 固定宽度的日期时间字符串，不包含时区和毫秒。
 */
export function formatTime(date: Date): string {
  // 年份无需补零；月、日、时、分、秒统一补成两位，便于日志按字符串对齐。
  const y = date.getFullYear();
  // JavaScript 的月份从 0 开始，因此对外显示前必须加 1。
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  // 模板字符串按固定顺序拼接，不会修改原始 date。
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}
