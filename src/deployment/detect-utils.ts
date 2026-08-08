/**
 * Agent 安装可用性的通用只读探测工具。
 *
 * 声明中的 paths 与 commands 是“或”关系：路径支持逐层 `*`/`?` 匹配，命令通过
 * Windows `where.exe` 或 Unix `which` 子进程查询 PATH。缺失目录、权限错误和非零
 * 退出码都按“未检测到”处理，不向安装器或 Collector 抛出探测异常。
 */


import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { AgentDetectionConfig } from '../types/index.js';
import { directoryExists, fileExists, resolveHome } from '../utils/fs-utils.js';

/**
 * 根据 Agent 声明执行可用性探测。
 *
 * paths 与 commands 是“或”关系：按声明顺序先检查路径，再检查 PATH 中的命令，
 * 任一条件命中便立即返回 true。路径支持按目录层级出现的 `*` 和 `?` 通配符。
 */
export async function detectAgent(detection: AgentDetectionConfig): Promise<boolean> {
  if (detection.paths.length === 0 && detection.commands.length === 0) {
    return false;
  }

  for (const p of detection.paths) {
    const resolved = resolveHome(p);
    if (hasGlob(resolved)) {
      if (await globHasMatch(resolved)) return true;
      continue;
    }
    if (await directoryExists(resolved) || await fileExists(resolved)) {
      return true;
    }
  }

  for (const cmd of detection.commands) {
    if (await commandExists(cmd)) {
      return true;
    }
  }

  return false;
}

/** 使用系统自带的命令定位工具判断可执行文件是否存在于当前进程的 PATH 中。 */
export function commandExists(command: string): Promise<boolean> {
  const bin = process.platform === 'win32' ? 'where.exe' : 'which';
  return new Promise(resolve => {
    // 定位工具返回非零状态（包括工具自身无法启动）时统一视为命令不存在。
    execFile(bin, [command], err => {
      resolve(!err);
    });
  });
}

/** 判断路径片段是否包含本模块支持的 `*` 或 `?`。 */
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
  const segments = pattern.split(path.sep).filter((s, i) => i === 0 || s.length > 0);
  if (segments.length === 0) return false;
  const root = pattern.startsWith(path.sep) ? path.sep : segments[0];
  const startIdx = pattern.startsWith(path.sep) ? 0 : 1;
  return walk(root, segments, startIdx);
}

/**
 * 逐路径层递归匹配；普通片段直接下探，glob 片段才 readdir，所有 I/O 异常返回 false。
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

/** 将单个 glob 片段转换为首尾锚定正则，其余正则元字符按字面转义。 */
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
