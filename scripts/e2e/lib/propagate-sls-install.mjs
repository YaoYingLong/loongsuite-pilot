/**
 * E2E 安装命令的 SLS 参数传播工具。所有导出均为纯函数：规范化 endpoint、判断是否应传播配置，
 * 并使用 Bash 单引号规则构建参数，供本地/远程安装场景共同使用。
 * 允许像控制台和 config-loader 一样省略 `https://`，但不发起实际 SLS 请求。
 * @param {string} raw 用户输入的 endpoint。
 * @returns {string} 带协议或保持为空的 endpoint。
 */
export function normalizeSlsEndpoint(raw) {
  const t = String(raw).trim();
  if (!t) return t;
  if (/^https?:\/\//i.test(t)) return t;
  return `https://${t}`;
}

/** 传播 project+logstore 但未设置 E2E_SLS_ENDPOINT 时使用此值，与常见 cn-hangzhou Operator Logstore 对齐。 */
export const DEFAULT_E2E_INSTALL_SLS_ENDPOINT = 'https://cn-hangzhou.log.aliyuncs.com';

/**
 * 生成 Bash 单引号字符串，可安全嵌入 bash -s -- install ... 之后。
 * @param {string} s
 */
export function shellSingleQuoteBash(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * 返回 true 时，远端 install 会接收由 E2E_SLS_* 环境变量生成的 --sls-* 参数；只影响安装传播。
 * 设置 E2E_PROPAGATE_SLS_INSTALL=0 可强制执行不带这些参数的普通安装，仅使用安装包内部回退。
 * @param {NodeJS.ProcessEnv} env
 */
export function shouldPropagateSlsToRemoteInstall(env) {
  if (env.E2E_PROPAGATE_SLS_INSTALL === '0') return false;
  const project = env.E2E_SLS_PROJECT?.trim();
  const logstore = env.E2E_SLS_LOGSTORE?.trim();
  return !!(project && logstore);
}

/**
 * 用于 bash -s -- install ... 的额外 CLI token；值已经完成 Shell 引号保护。
 * 关闭传播或缺少 project/logstore 时返回空字符串。
 * @param {NodeJS.ProcessEnv} env
 */
export function buildRemoteInstallSlsCliQuotedArgs(env) {
  if (!shouldPropagateSlsToRemoteInstall(env)) return '';

  const project = env.E2E_SLS_PROJECT.trim();
  const logstore = env.E2E_SLS_LOGSTORE.trim();
  const endpointRaw = env.E2E_SLS_ENDPOINT?.trim() || DEFAULT_E2E_INSTALL_SLS_ENDPOINT;
  const endpoint = normalizeSlsEndpoint(endpointRaw);

  const parts = [
    '--sls-endpoint',
    shellSingleQuoteBash(endpoint),
    '--sls-project',
    shellSingleQuoteBash(project),
    '--sls-logstore',
    shellSingleQuoteBash(logstore),
  ];

  const ak = env.E2E_SLS_ACCESS_KEY_ID?.trim();
  const sk = env.E2E_SLS_ACCESS_KEY_SECRET?.trim();
  if (ak && sk) {
    parts.push('--sls-ak-id', shellSingleQuoteBash(ak));
    parts.push('--sls-ak-secret', shellSingleQuoteBash(sk));
  }

  return parts.join(' ');
}
