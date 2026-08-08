/**
 * Qoder E2E 的纯字符串工具：规范化从环境变量或文档复制的 Personal Access Token。
 * 它移除 CR、首尾空白、可选 Bearer 前缀和成对引号，避免 exchange 请求因粘贴格式失败；
 * 不验证 token、不会发网络请求，也不会记录凭据。
 * @param {string | undefined} raw 原始 PAT；`undefined` 或空白返回空字符串。
 * @returns {string} 可安全传给后续配置生成器的规范化 token。
 */
export function normalizeE2eQoderPersonalAccessToken(raw) {
  let s = String(raw ?? '').replace(/\r/g, '').trim();
  if (!s) return '';
  if (/^bearer\s+/i.test(s)) s = s.replace(/^bearer\s+/i, '').trim();
  if (s.length >= 2) {
    const quoteChar = s[0];
    if ((quoteChar === '"' || quoteChar === "'") && s.endsWith(quoteChar)) {
      s = s.slice(1, -1);
    }
  }
  return s;
}
