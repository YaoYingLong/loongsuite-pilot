/**
 * Agent 安装可用性的通用只读探测工具。
 *
 * 声明中的 paths 与 commands 是“或”关系：路径支持逐层 `*`/`?` 匹配，命令通过
 * Windows `where.exe` 或 Unix `which` 子进程查询 PATH。缺失目录、权限错误和非零
 * 退出码都按“未检测到”处理，不向安装器或 Collector 抛出探测异常。
 */


// `execFile` 不经过 shell 解析，直接调用系统命令定位器，避免 Agent command 被当作 shell 文本执行。
import { execFile } from 'node:child_process';
// Promise 版 fs 只用于 glob 逐层 readdir/stat；普通路径复用 fs-utils 的容错存在性检查。
import { promises as fsp } from 'node:fs';
// path 提供平台分隔符和安全的逐层路径拼接。
import * as path from 'node:path';
// 类型导入编译后擦除，函数在运行时依赖调用方提供 paths/commands 数组。
import type { AgentDetectionConfig } from '../types/index.js';
import { directoryExists, fileExists, resolveHome } from '../utils/fs-utils.js';

/**
 * 根据 Agent 声明执行可用性探测。
 *
 * paths 与 commands 是“或”关系：按声明顺序先检查路径，再检查 PATH 中的命令，
 * 任一条件命中便立即返回 true。路径支持按目录层级出现的 `*` 和 `?` 通配符。
 *
 * @param detection 通常是 AgentDefLoader 已展开占位符的检测配置；独立调用时路径仍可包含 `~`。
 * @returns 任一路径或命令可用时为 true；全部失败或两个列表都为空时为 false。
 * @remarks 各项按顺序 await 并在首个命中处短路，探测失败不会阻断安装或 Collector 主流程。
 */
export async function detectAgent(detection: AgentDetectionConfig): Promise<boolean> {
  if (detection.paths.length === 0 && detection.commands.length === 0) {
    return false;
  }

  // 路径探测优先：通常只需本地 stat/readdir，比启动外部 `which`/`where.exe` 更直接。
  for (const p of detection.paths) {
    // 独立调用本工具时声明可能仍含 `~`，因此在访问文件系统前再做一次幂等 HOME 展开。
    const resolved = resolveHome(p);
    if (hasGlob(resolved)) {
      // glob 不能直接 stat；逐层寻找任意完整匹配，命中后立即结束整个 Agent 探测。
      if (await globHasMatch(resolved)) return true;
      continue;
    }
    // 声明既允许目录也允许具体文件；两个工具都把不存在、无权限或 stat 失败收敛为 false。
    if (await directoryExists(resolved) || await fileExists(resolved)) {
      return true;
    }
  }

  // 所有路径均未命中后才查询 PATH，避免每次启动为常见 Agent 额外创建定位子进程。
  for (const cmd of detection.commands) {
    if (await commandExists(cmd)) {
      return true;
    }
  }

  return false;
}

/**
 * 使用系统自带的命令定位工具判断可执行文件是否存在于当前进程的 PATH 中。
 * @param command 声明中的可执行文件名或定位工具支持的查询文本。
 * @returns `where.exe`/`which` 以 0 退出时兑现 true；非零退出或子进程创建失败时兑现 false。
 * @remarks Promise 不会 reject，便于上层把某个命令探测失败当作普通“未安装”继续检查。
 */
export function commandExists(command: string): Promise<boolean> {
  const bin = process.platform === 'win32' ? 'where.exe' : 'which';
  return new Promise(resolve => {
    // 定位工具返回非零状态（包括工具自身无法启动）时统一视为命令不存在。
    execFile(bin, [command], err => {
      resolve(!err);
    });
  });
}

/** 返回路径是否需要进入自定义 glob 分支；本模块不支持 `**`、字符组或花括号扩展。 */
function hasGlob(p: string): boolean {
  return p.includes('*') || p.includes('?');
}

/**
 * 判断 glob 路径是否至少匹配一个现有文件系统条目。
 * 每一层路径片段支持 `*` 和 `?`，无通配符的片段直接拼接，有通配符的片段才读取目录。
 * 这种逐层遍历避免扫描与模式无关的子树。
 */
async function globHasMatch(pattern: string): Promise<boolean> {
  // 绝对路径从文件系统根开始；相对路径则以第一个片段作为递归起点。
  // 当前只按 `path.sep` 分段；Windows 上若上游传入统一正斜杠的 glob，兼容性仍待确认。
  const segments = pattern.split(path.sep).filter((s, i) => i === 0 || s.length > 0);
  if (segments.length === 0) return false;
  const root = pattern.startsWith(path.sep) ? path.sep : segments[0];
  const startIdx = pattern.startsWith(path.sep) ? 0 : 1;
  return walk(root, segments, startIdx);
}

/**
 * 逐路径层递归匹配；普通片段直接下探，glob 片段才 readdir，所有 I/O 异常返回 false。
 * @param current 已匹配到的父路径。
 * @param segments 待消费的完整路径片段数组。
 * @param idx 下一段在 segments 中的下标。
 * @returns 存在至少一条能消费全部片段且最终 stat 成功的路径时为 true。
 */
async function walk(current: string, segments: string[], idx: number): Promise<boolean> {
  if (idx >= segments.length) {
    // 所有片段均已消费后仍需 stat，确认最终条目真实存在。
    try {
      await fsp.stat(current);
      return true;
    } catch {
      return false;
    }
  }
  const seg = segments[idx];
  if (!hasGlob(seg)) {
    // 普通片段无需读取父目录，直接进入下一层。
    return walk(path.join(current, seg), segments, idx + 1);
  }
  let entries: string[];
  try {
    entries = await fsp.readdir(current);
  } catch {
    return false;
  }
  const re = globToRegex(seg);
  // 找到任意一条完整匹配链即可短路返回，不继续遍历剩余目录项。
  for (const entry of entries) {
    if (!re.test(entry)) continue;
    if (await walk(path.join(current, entry), segments, idx + 1)) return true;
  }
  return false;
}

/**
 * 将单个 glob 片段转换为首尾锚定正则，其余正则元字符按字面转义。
 * @returns 不带全局标志的 RegExp，可安全地在同一目录循环中重复调用 test()。
 */
function globToRegex(glob: string): RegExp {
  // 仅赋予 * 和 ? 通配语义，其余正则特殊字符全部按字面量转义。
  let body = '';
  for (const ch of glob) {
    if (ch === '*') body += '.*';
    else if (ch === '?') body += '.';
    else body += ch.replace(/[.+^${}()\[\]|\\]/g, '\\$&');
  }
  return new RegExp(`^${body}$`);
}
