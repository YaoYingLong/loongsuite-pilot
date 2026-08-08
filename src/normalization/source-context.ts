/**
 * Agent 原生仓库/路径信息的归一化工具。
 *
 * Hook 记录可能把 cwd、workspace roots 或路径藏在不同字段中；各 Input 先构造
 * `SourceContextInput`，本模块再选择稳定的 `git.*` 与 `workspace.current_root` 输出字段。
 */

import type { JsonValue } from '../types/index.js';

/** 不同数据源可提供的松散上下文，字段在运行时都视为 unknown。 */
export interface SourceContextInput {
  repo?: unknown;
  branch?: unknown;
  domain?: unknown;
  cwd?: unknown;
  workspaceRoots?: unknown;
  absolutePaths?: unknown[];
}

/** 可安全写入 AgentActivityEntry 的归一化结果。 */
export interface NormalizedSourceContext {
  repo?: string;
  branch?: string;
  currentRoot?: string;
  domain?: string;
}

/**
 * 规范 repo/branch/domain 并从 cwd、roots、绝对路径中选择当前 workspace root。
 */
export function normalizeSourceContext(input: SourceContextInput): NormalizedSourceContext {
  const cwd = normalizeString(input.cwd);
  const roots = normalizeStringArray(input.workspaceRoots);
  // absolutePaths 可来自多个嵌套字段，先展平、去空再限制为 Unix 绝对路径。
  const absolutePaths = (input.absolutePaths ?? [])
    .flatMap(value => normalizeStringArray(value))
    .filter(isAbsolutePath);

  return {
    repo: normalizeRepo(input.repo),
    branch: normalizeString(input.branch),
    domain: normalizeString(input.domain),
    currentRoot: selectCurrentRoot({ cwd, roots, absolutePaths }),
  };
}

/** 将存在的上下文字段投影为 canonical dotted key；缺失值不写入。 */
export function sourceFieldsFromContext(context: NormalizedSourceContext): Record<string, JsonValue> {
  const fields: Record<string, JsonValue> = {};
  if (context.repo) {
    fields['git.repo'] = context.repo;
  }
  if (context.branch) fields['git.branch'] = context.branch;
  if (context.domain) fields['git.domain'] = context.domain;
  if (context.currentRoot) fields['workspace.current_root'] = context.currentRoot;
  return fields;
}

/** 返回首个非 null/undefined/空串值，供 Input 处理多版本字段别名。 */
export function pickFirstValue(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

/**
 * 按点分路径安全读取普通对象；中途遇到空值、数组或标量时返回 undefined。
 */
export function readRecordPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** 递归收集值中出现的 Unix 绝对路径，去重后排序以保证确定性。 */
export function collectAbsolutePathValues(value: unknown): string[] {
  const out = new Set<string>();
  collectAbsolutePathValuesInto(value, out);
  return [...out].sort();
}

/** 深度受限的递归实现，避免任意原始对象造成过深遍历。 */
function collectAbsolutePathValuesInto(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 6 || value === undefined || value === null) return;
  if (typeof value === 'string') {
    // 工具参数常把多个路径放在同一字符串中，按空白拆分并去掉常见引号/标点。
    for (const candidate of value.split(/\s+/)) {
      const cleaned = candidate.replace(/^['"]|['",;)]$/g, '');
      if (isAbsolutePath(cleaned)) out.add(cleaned);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAbsolutePathValuesInto(item, out, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const nested of Object.values(value)) collectAbsolutePathValuesInto(nested, out, depth + 1);
  }
}

/** 从 HTTPS 或 scp 风格 Git remote 中提取 host。 */
export function normalizeDomain(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const httpsMatch = raw.match(/^https?:\/\/([^/]+)/);
  if (httpsMatch) return httpsMatch[1];
  const sshMatch = raw.match(/^[^@]+@([^:]+)/);
  if (sshMatch) return sshMatch[1];
  return undefined;
}

/** 去掉协议、host、`.git` 和首尾斜杠，保留仓库路径。 */
function normalizeRepo(value: unknown): string | undefined {
  const raw = normalizeString(value);
  if (!raw) return undefined;
  return raw
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/^[^@]+@([^:]+)[:/]/, '')
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '');
}

/** 只接受非空字符串并清除首尾空白。 */
function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 将字符串或字符串数组归一为去空白的数组。 */
function normalizeStringArray(value: unknown): string[] {
  if (typeof value === 'string') return [value].map(v => v.trim()).filter(Boolean);
  if (!Array.isArray(value)) return [];
  return value
    .map(item => typeof item === 'string' ? item.trim() : undefined)
    .filter((item): item is string => !!item);
}

/** 优先选择包含 cwd/绝对路径的最长 root；唯一 root 可作为最后兜底。 */
function selectCurrentRoot(input: { cwd?: string; roots: string[]; absolutePaths: string[] }): string | undefined {
  const normalizedRoots = [...new Set(input.roots.map(stripTrailingSlash).filter(Boolean))];
  if (normalizedRoots.length === 0) return undefined;

  const candidates = [input.cwd, ...input.absolutePaths].filter((value): value is string => !!value && isAbsolutePath(value));
  for (const candidate of candidates) {
    const root = longestContainingRoot(candidate, normalizedRoots);
    if (root) return root;
  }
  if (normalizedRoots.length === 1) return normalizedRoots[0];
  return undefined;
}

/** 在所有包含 value 的 root 中选最长者，避免 monorepo 父目录抢占更具体 workspace。 */
function longestContainingRoot(value: string, roots: string[]): string | undefined {
  const normalizedValue = stripTrailingSlash(value);
  return roots
    .filter(root => normalizedValue === root || normalizedValue.startsWith(`${root}/`))
    .sort((a, b) => b.length - a.length)[0];
}

/** 当前实现识别 Unix/WSL 风格绝对路径；Windows 路径支持待确认。 */
function isAbsolutePath(value: string): boolean {
  return value.startsWith('/');
}

/** 去掉多余尾斜杠，但文件系统根 `/` 保持不变。 */
function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, '') || '/';
}

