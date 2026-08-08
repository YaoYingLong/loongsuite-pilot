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

/**
 * 生成 Agent settings 中要保存的跨平台 Hook 命令。
 * @param scriptPath Pilot 已部署 Hook 脚本的绝对路径。
 * @param args 可选子命令/参数，原样附加在脚本命令后。
 * @returns Windows 上用 PowerShell 包装 `.ps1` 并引号保护路径；Unix 直接返回脚本与参数。
 * @remarks 返回的字符串既用于执行，也用于后续精确去重/卸载，所以格式需保持稳定。
 */
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
 *
 * 本类不解析 Agent 业务语义，只按 `HookDefinition` 给出的 JSON 路径和精确
 * command 处理数组。所有公开 I/O 方法都把异常收敛为 boolean，使 `HookStrategy`
 * 能以单 Agent 结果隔离配置损坏或权限错误。
 */
export class HookManager {
  private readonly hookScriptDir: string;
  private readonly logBaseDir: string;

  /**
   * @param hookScriptDir Pilot Hook 脚本根；省略时使用 `~/.loongsuite-pilot/hooks`。
   * @param logBaseDir 各 Agent history 根；省略时使用 `~/.loongsuite-pilot/logs`。
   * @remarks 构造阶段只展开 HOME 并保存路径，不访问磁盘。
   */
  constructor(hookScriptDir?: string, logBaseDir?: string) {
    this.hookScriptDir = hookScriptDir ?? resolveHome('~/.loongsuite-pilot/hooks');
    this.logBaseDir = logBaseDir ?? resolveHome('~/.loongsuite-pilot/logs');
  }

  /**
   * 安装 Hook；已有相同命令时保持幂等，但若删除过 replaceHookCommands 仍会写回。
   * @param def 包含 Agent settings 路径、JSON 数组路径、精确命令及 flat/nested 形式。
   * @returns 目标命令已存在或已写入时为 `true`；所有读写/解析异常捕获后返回 `false`。
   * @remarks 只有新增 Hook 时才创建 history 目录；已安装分支假定该目录由旧部署已建立。
   */
  async installHook(def: HookDefinition): Promise<boolean> {
    try {
      await ensureDir(path.dirname(def.settingsPath));
      const settings = (await readJsonFile<Record<string, unknown>>(def.settingsPath)) ?? {};

      let target: any = settings;
      // 只创建到数组父节点；中间值不是对象时用新对象替换，使损坏的 Hook 局部结构可自愈。
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

      // 历史 marker 先删除，避免命令路径/包装方式升级后同一事件触发两次采集。
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

      // Qoder 系使用 matcher group + hooks 子数组；Cursor/Codex 等使用事件数组中的 flat command。
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
   * @param def 要清理的当前 command 和可选历史 commands。
   * @returns settings/路径/数组不存在也视为幂等成功；读写异常返回 `false`。
   * @remarks 仅移除命令精确匹配的条目/子条目，保留同一 event 中的第三方 Hook。
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
   * @returns 精确当前 command 存在且所有 replace command 已清理时为 `true`。
   * @remarks 它由 HookStrategy 启动检查和 Watchdog 调用；采用 fail-closed，因为“不可读”不能被当成“已正确安装”。
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
   * @param loongsuitePilotDir 可选数据根，测试/自定义安装用；省略时使用默认 HOME 目录。
   * @returns 每个 Cursor lifecycle/tool 事件一项 flat HookDefinition，共用同一命令和 history 目录。
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
   * @returns 包含单个 nested `Stop` 定义的数组，命令传入 `qoder` 子模式。
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
   * @returns 单个 nested Stop 定义；`replaceHookCommands` 同时清理旧共享 Qoder 入口及 Windows 裸脚本命令。
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

  /**
   * 构造 Qoder Work CN Stop Hook，并使用 CN 独立的 settings/Agent ID。
   * @returns 单个 nested Stop 定义，包含国际版共享入口的历史替换命令。
   */
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
   * @deprecated 使用 `buildQoderCliHooks()`。
   * @returns 待确认：当前代码读取只有一项的数组下标 1，运行时实际会得到 `undefined`，与声明返回类型不一致。
   * @remarks 本次仅补注释，未改变该兼容 API 的可执行逻辑；需核对是否已无外部调用后再修正下标。
   */
  static buildQoderCliHook(loongsuitePilotDir?: string): HookDefinition {
    return HookManager.buildQoderCliHooks(loongsuitePilotDir)[1];
  }

  /**
   * 为支持 PostToolUse 的 MCP 兼容工具构造通用 flat Hook 定义。
   * @param opts agentId 同时决定 Hook 脚本文件名，settingsDir 下使用固定 `settings.json`。
   * @returns matcher=`*` 的 `hooks.PostToolUse` 定义；本方法不检查目标工具是否安装。
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
   * @returns flat `entry.command` 命中，或 nested `entry.hooks[*].command` 任一命中时为 `true`。
   * @remarks 只比较完整字符串，不做 shell 规范化；这是安全卸载不误伤近似第三方命令的基础。
   */
  private entryMatchesCommand(entry: any, command: string): boolean {
    if (entry.command === command) return true;
    if (Array.isArray(entry.hooks)) {
      return entry.hooks.some((h: any) => h.command === command);
    }
    return false;
  }

  /**
   * 判断事件数组任一 flat/nested 条目是否匹配精确命令。
   * @returns 找到时为 `true`；空数组为 `false`。
   */
  private isCommandPresent(arr: any[], command: string): boolean {
    return arr.some((entry: any) => this.entryMatchesCommand(entry, command));
  }

  /**
   * 从数组中移除匹配任一命令的 flat/nested 内容，并保留第三方条目。
   * @returns 新数组；nested group 可部分保留，删空的 group 整体移除，输入数组不就地改写。
   */
  private removeCommands(arr: any[], commands: string[]): any[] {
    return arr
      .map((entry: any) => this.removeCommandsFromEntry(entry, commands))
      .filter((entry: any) => entry !== null);
  }

  /**
   * 对单个 flat/nested entry 删除指定命令。
   * @returns flat 命中或 nested 子数组删空时返回 `null` 让外层删 group；未命中保留原引用，部分删除返回浅拷贝。
   */
  private removeCommandsFromEntry(entry: any, commands: string[]): any | null {
    if (commands.includes(entry.command)) return null;
    if (!Array.isArray(entry.hooks)) return entry;

    const hooks = entry.hooks.filter((h: any) => !commands.includes(h.command));
    if (hooks.length === 0) return null;
    if (hooks.length === entry.hooks.length) return entry;
    return { ...entry, hooks };
  }
}
