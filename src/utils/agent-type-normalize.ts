/**
 * Agent 类型名称规范化工具。
 *
 * Trace Resource、日志文件名和内部 Map 都需要稳定的低风险标识。本函数把上游可能含空格、
 * 大小写或标点的名称收敛为小写 kebab-case，但不会验证它是否属于已注册的 ClientType。
 */

/**
 * 把任意 Agent 名称规范化为仅含小写字母、数字和连字符的标识。
 *
 * @param raw 上游记录或配置中的 Agent 类型原文。
 * @returns 规范化名称；若原文不含可保留字符则返回 `unknown`。
 */
export function normalizeAgentType(raw: string): string {
  // 连续的非字母数字字符压缩为一个 `-`，再去掉首尾分隔符。
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // 空结果使用稳定兜底值，避免生成空文件名或空 Map key。
  return normalized || 'unknown';
}
