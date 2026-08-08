/**
 * Updater 使用的无状态版本与校验工具。
 *
 * `compareVersions()` 按数字段比较简化 semver，非标准格式退回字符串排序；
 * `deterministicBucket()` 用 installId+version 的 SHA-256 生成稳定 0..99 灰度桶；
 * `computeSha256()` 以文件流增量计算摘要，避免将更新包整体读入内存。
 */


import * as crypto from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * 按点分数字段比较简化 semver。
 * @returns a>b 为 1、a<b 为 -1、相等为 0；非数字格式回退字符串比较。
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  if (pa.some(isNaN) || pb.some(isNaN)) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na > nb ? 1 : -1;
  }
  return 0;
}

/** 对 installId+version 做 SHA-256，取前 32 位整数映射到 0..99 稳定桶。 */
export function deterministicBucket(installId: string, version: string): number {
  const hash = crypto.createHash('sha256').update(installId + version).digest();
  const num = hash.readUInt32BE(0);
  return num % 100;
}

/** 流式计算文件 SHA-256 十六进制；读取错误通过 rejected Promise 传播。 */
export async function computeSha256(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}
