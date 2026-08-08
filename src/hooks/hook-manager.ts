/**
 * Agent JSON settings 中 Hook 条目的底层读写器。
 *
 * HookStrategy 把声明转换为 HookDefinition 后调用本类。它按 JSON 路径读取/创建数组，
 * 识别本项目 marker，去重安装或精准卸载 flat/nested Hook，并在 Windows 把脚本包装
 * 成 PowerShell 命令。写入前保留用户已有配置，必要时创建目录和 settings 文件；
 * Hook 脚本自身位于 `<dataDir>/hooks`，history 日志位于 `<dataDir>/logs`。公开 I/O
 * 方法会捕获文件错误、记录日志并返回 false，Strategy 再转换为 DeployResult。
 */


import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import {
  readJsonFile,
  writeJsonFile,
  ensureDir,
  resolveHome,
  fileExists,
} from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('HookManager');
const hookExt = process.platform === 'win32' ? '.ps1' : '.sh';
const isWin = process.platform === 'win32';

/** Windows 用 PowerShell 包装 ps1；Unix 直接返回脚本与可选参数。 */
function wrapHookCommand(scriptPath: string, args?: string): string {
  if (!isWin) return args ? `${scriptPath} ${args}` : scriptPath;
  const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`;
  return args ? `${cmd} ${args}` : cmd;
}

export interface HookDefinition {
  /** Agent 稳定 ID，例如 qoder、claude。 */
  agentId: string;
  /** Agent settings 文件路径。 */
  settingsPath: string;
  /** 注入数组的 JSON 路径，例如 ["hooks", "PostToolUse"]。 */
  hookJsonPath: string[];
  /** 要写入的完整命令字符串。 */
  hookCommand: string;
  /** 可选 Hook matcher。 */
  matcher?: string;
  /** 控制 ID 与存储路径不同时显式指定 history 目录。 */
  historyDir?: string;
  /** 安装当前定义时应移除的历史命令 marker。 */
  replaceHookCommands?: string[];
  /**
   * true 使用 Qoder nested 格式：
   *   { matcher: "...", hooks: [{ command, type }] }
   * false 使用 flat 格式：
   *   { command, type, matcher }
   */
  useNestedFormat?: boolean;
}

/**
 * 在 AI 工具配置文件中安装和移除 Hook 命令。
 *
 * 流程：读取 settings -> 沿 hookJsonPath 创建对象/数组 -> 移除历史命令 -> 幂等追加
 * 当前 flat/nested 条目 -> 原子写回 -> 确保 Agent history 目录。
 */
export class HookManager {
  private readonly hookScriptDir: string;
  private readonly logBaseDir: string;

  /** 路径省略时使用默认 Pilot hooks/logs；构造阶段不访问磁盘。 */
  constructor(hookScriptDir?: string, logBaseDir?: string) {
    this.hookScriptDir = hookScriptDir ?? resolveHome('~/.loongsuite-pilot/hooks');
    this.logBaseDir = logBaseDir ?? resolveHome('~/.loongsuite-pilot/logs');
  }

  /**
   * 安装 Hook；已有相同命令时保持幂等，但若删除过 replaceHookCommands 仍会写回。
   * @returns 成功 true；所有读写/解析异常捕获后返回 false。
   */
  async installHook(def: HookDefinition): Promise<boolean> {
    try {
      await ensureDir(path.dirname(def.settingsPath));
      const settings = (await readJsonFile<Record<string, unknown>>(def.settingsPath)) ?? {};

      let target: any = settings;
      for (let i = 0; i < def.hookJsonPath.length - 1; i++) {
        const key = def.hookJsonPath[i];
        if (!target[key] || typeof target[key] !== 'object') {
          target[key] = {};
        }
        target = target[key];
      }

      const lastKey = def.hookJsonPath[def.hookJsonPath.length - 1];
      if (!Array.isArray(target[lastKey])) {
        target[lastKey] = [];
      }

      const arr = target[lastKey] as any[];

      if (def.replaceHookCommands?.length) {
        target[lastKey] = this.removeCommands(arr, def.replaceHookCommands);
      }

      const updatedArr = target[lastKey] as any[];

      if (this.isCommandPresent(updatedArr, def.hookCommand)) {
        if (updatedArr !== arr) {
          await writeJsonFile(def.settingsPath, settings);
        }
        logger.debug('hook already installed', { agentId: def.agentId });
        return true;
      }

      const hookEntry = def.useNestedFormat
        ? {
            matcher: def.matcher ?? '*',
            hooks: [{ command: def.hookCommand, type: 'command' }],
          }
        : {
            type: 'command',
            command: def.hookCommand,
            ...(def.matcher ? { matcher: def.matcher } : {}),
          };

      updatedArr.push(hookEntry);
      await writeJsonFile(def.settingsPath, settings);

      // Hook 成功写入后确保对应 Agent history 目录存在。
      await ensureDir(def.historyDir ?? path.join(this.logBaseDir, def.agentId, 'history'));

      logger.info('hook installed', { agentId: def.agentId });
      return true;
    } catch (err) {
      logger.error('hook installation failed', {
        agentId: def.agentId,
        error: String(err),
      });
      return false;
    }
  }

  /**
   * 删除当前和历史替换命令；事件数组清空时移除该 JSON key。
   * @returns settings 不存在也视为幂等成功，异常返回 false。
   */
  async uninstallHook(def: HookDefinition): Promise<boolean> {
    try {
      const settings = await readJsonFile<Record<string, unknown>>(def.settingsPath);
      if (!settings) return true;

      let target: any = settings;
      for (let i = 0; i < def.hookJsonPath.length - 1; i++) {
        const key = def.hookJsonPath[i];
        if (!target[key]) return true;
        target = target[key];
      }

      const lastKey = def.hookJsonPath[def.hookJsonPath.length - 1];
      if (!Array.isArray(target[lastKey])) return true;

      const commands = [def.hookCommand, ...(def.replaceHookCommands ?? [])];
      target[lastKey] = this.removeCommands(target[lastKey] as any[], commands);
      if ((target[lastKey] as any[]).length === 0) {
        delete target[lastKey];
      }

      await writeJsonFile(def.settingsPath, settings);
      logger.info('hook uninstalled', { agentId: def.agentId });
      return true;
    } catch (err) {
      logger.error('hook uninstall failed', { agentId: def.agentId, error: String(err) });
      return false;
    }
  }

  /**
   * 只读检查当前命令存在且历史替换命令均不存在；任何异常返回 false 触发修复。
   */
  async isHookInstalled(def: HookDefinition): Promise<boolean> {
    try {
      const settings = await readJsonFile<Record<string, unknown>>(def.settingsPath);
      if (!settings) return false;

      let target: any = settings;
      for (const key of def.hookJsonPath.slice(0, -1)) {
        if (!target[key]) return false;
        target = target[key];
      }

      const lastKey = def.hookJsonPath[def.hookJsonPath.length - 1];
      if (!Array.isArray(target[lastKey])) return false;

      const hooks = target[lastKey] as any[];
      if (def.replaceHookCommands?.some(command => this.isCommandPresent(hooks, command))) {
        return false;
      }

      return this.isCommandPresent(hooks, def.hookCommand);
    } catch {
      return false;
    }
  }

  /**
   * 为 Cursor 关键事件构造指向 cursor-loongsuite-pilot-hook 的定义数组。
   */
  static buildCursorHooks(loongsuitePilotDir?: string): HookDefinition[] {
    const baseDir = loongsuitePilotDir ?? resolveHome('~/.loongsuite-pilot');
    const command = wrapHookCommand(`${baseDir}/hooks/cursor-loongsuite-pilot-hook${hookExt}`);
    const settingsPath = resolveHome('~/.cursor/hooks.json');

    const events = [
      'stop',
      'preToolUse',
      'postToolUse',
      'postToolUseFailure',
      'beforeSubmitPrompt',
      'preCompact',
      'sessionStart',
      'sessionEnd',
      'subagentStart',
      'subagentStop',
      'afterAgentResponse',
      'afterAgentThought',
    ];

    return events.map(event => ({
      agentId: 'cursor',
      settingsPath,
      hookJsonPath: ['hooks', event],
      hookCommand: command,
      historyDir: path.join(baseDir, 'logs', 'cursor', 'history'),
    }));
  }

  /**
   * 构造 Qoder CLI Stop Hook。
   */
  static buildQoderCliHooks(loongsuitePilotDir?: string): HookDefinition[] {
    const baseDir = loongsuitePilotDir ?? resolveHome('~/.loongsuite-pilot');
    const command = wrapHookCommand(`${baseDir}/hooks/qoder-loongsuite-pilot-hook${hookExt}`, 'qoder');
    const settingsPath = resolveHome('~/.qoder/settings.json');

    return [
      {
        agentId: 'qoder',
        settingsPath,
        hookJsonPath: ['hooks', 'Stop'],
        hookCommand: command,
        matcher: '*',
        useNestedFormat: true,
      },
    ];
  }

  /**
   * 构造 Qoder Work Stop Hook。
   */
  static buildQoderWorkHooks(loongsuitePilotDir?: string): HookDefinition[] {
    const baseDir = loongsuitePilotDir ?? resolveHome('~/.loongsuite-pilot');
    const command = wrapHookCommand(`${baseDir}/hooks/qoderwork-loongsuite-pilot-hook${hookExt}`);
    const legacyCommand = wrapHookCommand(`${baseDir}/hooks/qoder-loongsuite-pilot-hook${hookExt}`, 'qoder-work');
    const settingsPath = resolveHome('~/.qoderwork/settings.json');

    const replaceCmds = [legacyCommand];
    if (isWin) {
      replaceCmds.push(`${baseDir}/hooks/qoderwork-loongsuite-pilot-hook.sh`);
      replaceCmds.push(`${baseDir}/hooks/qoderwork-loongsuite-pilot-hook.ps1`);
      replaceCmds.push(`${baseDir}/hooks/qoder-loongsuite-pilot-hook.sh qoder-work`);
      replaceCmds.push(`${baseDir}/hooks/qoder-loongsuite-pilot-hook.ps1 qoder-work`);
    }

    return [
      {
        agentId: 'qoder-work',
        settingsPath,
        hookJsonPath: ['hooks', 'Stop'],
        hookCommand: command,
        replaceHookCommands: replaceCmds,
        matcher: '*',
        useNestedFormat: true,
      },
    ];
  }

  /** 构造 Qoder Work CN Stop Hook，并显式映射其 history 目录。 */
  static buildQoderWorkCNHooks(loongsuitePilotDir?: string): HookDefinition[] {
    const baseDir = loongsuitePilotDir ?? resolveHome('~/.loongsuite-pilot');
    const command = wrapHookCommand(`${baseDir}/hooks/qoderworkcn-loongsuite-pilot-hook${hookExt}`);
    const legacyCommand = wrapHookCommand(`${baseDir}/hooks/qoder-loongsuite-pilot-hook${hookExt}`, 'qoder-work-cn');
    const settingsPath = resolveHome('~/.qoderworkcn/settings.json');

    const replaceCmds = [legacyCommand];
    if (isWin) {
      replaceCmds.push(`${baseDir}/hooks/qoderworkcn-loongsuite-pilot-hook.sh`);
      replaceCmds.push(`${baseDir}/hooks/qoderworkcn-loongsuite-pilot-hook.ps1`);
      replaceCmds.push(`${baseDir}/hooks/qoder-loongsuite-pilot-hook.sh qoder-work-cn`);
      replaceCmds.push(`${baseDir}/hooks/qoder-loongsuite-pilot-hook.ps1 qoder-work-cn`);
    }

    return [
      {
        agentId: 'qoder-work-cn',
        settingsPath,
        hookJsonPath: ['hooks', 'Stop'],
        hookCommand: command,
        replaceHookCommands: replaceCmds,
        matcher: '*',
        useNestedFormat: true,
      },
    ];
  }

  /**
   * @deprecated 使用 buildQoderCliHooks()；这里只返回数组首项兼容旧调用方。
   */
  static buildQoderCliHook(loongsuitePilotDir?: string): HookDefinition {
    return HookManager.buildQoderCliHooks(loongsuitePilotDir)[1];
  }

  /**
   * 为支持 PostToolUse 的 MCP 兼容工具构造通用 flat Hook 定义。
   */
  static buildGenericHook(opts: {
    agentId: string;
    settingsDir: string;
    loongsuitePilotDir?: string;
  }): HookDefinition {
    const baseDir = opts.loongsuitePilotDir ?? resolveHome('~/.loongsuite-pilot');
    return {
      agentId: opts.agentId,
      settingsPath: path.join(opts.settingsDir, 'settings.json'),
      hookJsonPath: ['hooks', 'PostToolUse'],
      hookCommand: wrapHookCommand(`${baseDir}/hooks/${opts.agentId}-hook${hookExt}`),
      matcher: '*',
    };
  }

  /**
   * 检查单个数组条目是否含精确命令，兼容 flat 与 nested 两种结构。
   */
  private entryMatchesCommand(entry: any, command: string): boolean {
    if (entry.command === command) return true;
    if (Array.isArray(entry.hooks)) {
      return entry.hooks.some((h: any) => h.command === command);
    }
    return false;
  }

  /** 判断数组任一条目是否匹配命令。 */
  private isCommandPresent(arr: any[], command: string): boolean {
    return arr.some((entry: any) => this.entryMatchesCommand(entry, command));
  }

  /** 从数组中移除匹配任一命令的 flat/nested 内容，并保留第三方条目。 */
  private removeCommands(arr: any[], commands: string[]): any[] {
    return arr
      .map((entry: any) => this.removeCommandsFromEntry(entry, commands))
      .filter((entry: any) => entry !== null);
  }

  /** nested 子数组删空时返回 null 让外层删除 group；未命中时保留原 entry。 */
  private removeCommandsFromEntry(entry: any, commands: string[]): any | null {
    if (commands.includes(entry.command)) return null;
    if (!Array.isArray(entry.hooks)) return entry;

    const hooks = entry.hooks.filter((h: any) => !commands.includes(h.command));
    if (hooks.length === 0) return null;
    if (hooks.length === entry.hooks.length) return entry;
    return { ...entry, hooks };
  }
}
