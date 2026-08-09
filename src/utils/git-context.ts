/**
 * Git 工作区上下文探测与短时缓存。
 *
 * 归一化阶段按 cwd 调用 `inferGitContext()`，本文件通过受限的 `git -C` 子进程读取仓库根、
 * 分支和 remote，并缓存 30 秒。Git 缺失、命令超时或目录不是仓库时均 fail-open，不阻断采集。
 */

// `execFile` 不经过 shell 拼接，可避免目录或参数中的特殊字符被二次解释。
import { execFile as execFileCb } from 'node:child_process';
// `promisify` 将回调 API 转成 Promise，便于用 async/await 表达顺序查询。
import { promisify } from 'node:util';
import { normalizeDomain } from '../normalization/source-context.js';

const execFile = promisify(execFileCb);

/** 同一 cwd 的探测结果缓存 30 秒，减少高频事件触发 Git 子进程。 */
const GIT_CONTEXT_TTL_MS = 30_000;
/** 不同 cwd 的缓存总量上限，防止长寿命进程内存无界增长。 */
const MAX_CACHE_ENTRIES = 256;

/** Git enrich 的公开结果；每个字段都可能因源数据不可用而缺失。 */
export interface GitContextResult {
  /** 去掉协议、host 和 `.git` 后缀的 `owner/repo` 路径。 */
  repo?: string;
  /** 当前分支；detached HEAD 时缺失。 */
  branch?: string;
  /** `git rev-parse --show-toplevel` 返回的仓库根目录。 */
  root?: string;
  /** remote.origin.url 提取并规范化后的托管域名。 */
  domain?: string;
}

/** 对外结果加绝对过期毫秒，供进程内 Map 惰性淘汰。 */
interface GitContextCacheEntry extends GitContextResult {
  /** Date.now() 达到该值后缓存失效。 */
  expiresAt: number;
}

/** 以调用方原始 probeDir 为 key；同一目录字符串复用一次 Git 探测结果。 */
const gitContextCache = new Map<string, GitContextCacheEntry>();

/** 超限时先清过期项，仍超限则按最早到期顺序淘汰旧项。 */
function evictStaleEntries(cache: Map<string, { expiresAt: number }>): void {
  // 常见的未超限路径直接返回，避免每次 set 都遍历 Map。
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  // 删除过期项后仍超限，按 expiresAt 近似移除最旧数据。
  const entries = [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  const toRemove = entries.slice(0, cache.size - MAX_CACHE_ENTRIES);
  for (const [key] of toRemove) cache.delete(key);
}

/**
 * 为指定目录推断仓库、分支、托管域名和仓库根。
 *
 * 每条 Git 命令独立降级，例如 remote 失败时仍缓存并返回已取得的 root/branch。
 *
 * @param probeDir Agent 实际工作目录。
 * @returns Promise，兑现为可能只含部分字段的上下文；Git 探测失败不会 reject。
 */
export async function inferGitContext(probeDir: string): Promise<GitContextResult> {
  const now = Date.now();
  const cached = gitContextCache.get(probeDir);
  // 返回公开字段副本，不把内部 expiresAt 暴露给调用者。
  if (cached && cached.expiresAt > now) {
    return { repo: cached.repo, branch: cached.branch, root: cached.root, domain: cached.domain };
  }

  // 先定位仓库根；后续命令尽量在根目录执行。
  // root 查询失败时仍在原 probeDir 尝试 branch/remote，让部分 Git 环境有机会返回可用信息。
  const root = await runGit(probeDir, ['rev-parse', '--show-toplevel']);
  const gitRoot = root?.trim() || undefined;
  const branch = normalizeBranch(await runGit(gitRoot ?? probeDir, ['rev-parse', '--abbrev-ref', 'HEAD']));
  const remote = await runGit(gitRoot ?? probeDir, ['config', '--get', 'remote.origin.url']);
  const repo = normalizeRepo(remote);
  const domain = normalizeDomain(remote);

  // 写新条目前执行容量保护，再为本轮结果设置统一过期时间。
  // 清理发生在 set 前；Map 恰好已达上限时本轮可能暂时多一项，下一次写入会再执行淘汰。
  evictStaleEntries(gitContextCache);
  gitContextCache.set(probeDir, {
    expiresAt: now + GIT_CONTEXT_TTL_MS,
    repo,
    branch,
    root: gitRoot,
    domain,
  });
  return { repo, branch, root: gitRoot, domain };
}

/** 执行一条只读 Git 命令；失败、超时或空输出统一返回 undefined。 */
async function runGit(root: string, args: string[]): Promise<string | undefined> {
  try {
    // 1.5 秒超时和 64 KiB 缓冲避免异常仓库拖慢整个采集批次。
    // 参数数组直接交给 execFile，不通过 shell，因此 root 中的空格不需要调用方手工加引号。
    const { stdout } = await execFile('git', ['-C', root, ...args], {
      timeout: 1500,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
    });
    const text = stdout.trim();
    return text.length > 0 ? text : undefined;
  } catch {
    // Git 信息只是可选增强，不能因探测异常丢弃原始事件。
    return undefined;
  }
}

/** detached HEAD 不是真实分支名，因此归一为缺失。 */
function normalizeBranch(raw: string | undefined): string | undefined {
  if (!raw || raw === 'HEAD') return undefined;
  return raw;
}

/**
 * 将 HTTPS 或 scp 风格 remote 规范化为不含协议、域名和 `.git` 后缀的仓库路径。
 *
 * @param raw `remote.origin.url` 原文。
 * @returns 例如 `group/repo`；空输入返回 undefined。
 */
export function normalizeRepo(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // 匹配 `git@host:owner/repo.git`；`ssh://host/path` 不命中并会走普通字符串清理路径。
  const sshMatch = trimmed.match(/^[^@]+@[^:]+:(.+)$/);
  // scp 风格取冒号后内容；HTTPS 风格由后续正则去掉协议和 host。
  const source = sshMatch ? sshMatch[1] : trimmed;
  return source
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '');
}

/**
 * 带 TTL 检查和容量上限的 Map。
 *
 * 值自带 `expiresAt`，本类不创建定时器，而是在 get/set 时惰性清理。
 */
export class BoundedTtlCache<V extends { expiresAt: number }> {
  /** 实际缓存容器；key 语义由具体调用方决定。 */
  private readonly map = new Map<string, V>();
  /** 触发惰性淘汰的软上限。 */
  private readonly maxEntries: number;

  /** @param maxEntries 最大条目数，默认与 Git 上下文缓存一致。 */
  constructor(maxEntries = MAX_CACHE_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  /** 读取未过期条目；命中过期值时同步删除并返回 undefined。 */
  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry;
  }

  /** 写入条目；超容量时触发统一淘汰。 */
  set(key: string, value: V): void {
    // Map.set 对已有 key 原位覆盖，不增加 size；新 key 才可能触发容量处理。
    this.map.set(key, value);
    if (this.map.size > this.maxEntries) {
      evictStaleEntries(this.map);
    }
  }

  /** 主动删除一个键。 */
  delete(key: string): void {
    this.map.delete(key);
  }

  /** 当前 Map 条目数，可能包含尚未被惰性访问的过期项。 */
  get size(): number {
    return this.map.size;
  }
}
