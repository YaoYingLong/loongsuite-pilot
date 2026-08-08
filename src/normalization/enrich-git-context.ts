/**
 * 用 Agent 工作目录补齐 canonical Git/workspace 字段。
 *
 * Hook 型 Input 在构建 entry 后调用本函数；它先保留源记录显式字段，再通过 git 子进程只填补
 * 缺失项。探测失败由 inferGitContext fail-open，因此不会阻断事件输出。
 */

import { inferGitContext } from '../utils/git-context.js';

/**
 * @param entry 正在构建的 canonical 记录，会原地补充 workspace/git 字段。
 * @param record 原始 Hook 记录，作为 cwd/workspace roots 的兜底来源。
 * @param namespace `agent.<namespace>.*` 中使用的 Agent 命名空间。
 */
export async function enrichCanonicalEntryWithGit(
  entry: Record<string, unknown>,
  record: Record<string, unknown>,
  namespace: string,
): Promise<void> {
  const probeDir = extractProbeDir(entry, record, namespace);
  // workspace.path 表示实际 cwd，与是否为 Git 仓库无关。
  if (probeDir && !entry['workspace.path']) entry['workspace.path'] = probeDir;

  // repo 和 branch 均已由源端提供时，无需再创建 Git 子进程。
  if (entry['git.repo'] && entry['git.branch']) return;
  if (!probeDir) return;

  // 采用 fill-only，绝不覆盖 Agent 自己提供的更权威字段。
  // await 会暂停当前转换，但不会阻塞事件循环；inferGitContext 内有 TTL 缓存并吞掉 Git 探测失败。
  const inferred = await inferGitContext(probeDir);
  if (!entry['git.repo'] && inferred.repo) entry['git.repo'] = inferred.repo;
  if (!entry['git.branch'] && inferred.branch) entry['git.branch'] = inferred.branch;
  if (!entry['git.domain'] && inferred.domain) entry['git.domain'] = inferred.domain;
  if (!entry['workspace.current_root'] && inferred.root) entry['workspace.current_root'] = inferred.root;
}

/**
 * 从 Agent namespace 的 cwd 或 workspace_roots 中选择首个可探测目录。
 * 只接受 Unix/WSL `/` 路径；字符串数组可来自真实数组或 JSON 文本，其他结构 fail-open 返回空。
 */
function extractProbeDir(
  entry: Record<string, unknown>,
  record: Record<string, unknown>,
  namespace: string,
): string | undefined {
  const cwd = normalizeString(entry[`agent.${namespace}.cwd`])
    ?? normalizeString(record[`agent.${namespace}.cwd`]);
  // 当前仅接受 `/` 开头路径，与 source-context 的平台边界一致。
  if (cwd?.startsWith('/')) return cwd;

  const roots = entry[`agent.${namespace}.workspace_roots`]
    ?? record[`agent.${namespace}.workspace_roots`];
  const rootList = normalizeStringArray(roots);
  if (rootList.length > 0 && rootList[0].startsWith('/')) return rootList[0];

  return undefined;
}

/** 将 unknown 收敛为去空白非空字符串。 */
function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 兼容 JSON 字符串数组、普通字符串和真实数组。 */
function normalizeStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    } catch { /* 不是 JSON 时按单个路径处理。 */ }
    return [value].map(v => v.trim()).filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value
    .map(item => typeof item === 'string' ? item.trim() : undefined)
    .filter((item): item is string => !!item);
}
