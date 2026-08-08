/**
 * 上游调用链关联所需的稳定内容摘要工具。
 *
 * Adapter 写入关联记录、Collector 读取用户输入时必须使用完全相同的算法，才能用摘要匹配
 * `traceparent`。摘要只用于关联与索引，不具备密码存储用途，也不能替代内容脱敏。
 */

// `createHash` 来自 Node.js 内置 crypto 模块；这里只使用同步 SHA-256，输入通常是一段 prompt。
import { createHash } from 'node:crypto';

/**
 * 计算用于关联上游 traceparent 与当前用户输入的稳定内容摘要。
 *
 * @param text 未经预处理的原始文本；空白和换行差异都会产生不同摘要。
 * @returns SHA-256 十六进制结果的前 16 个字符。
 */
export function contentHash(text: string): string {
  // 显式指定 UTF-8，确保不同平台对同一 Unicode 文本得到相同结果。
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}
