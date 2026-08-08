/**
 * Hook 模式 Agent 的部署、修复与卸载策略。
 *
 * DeploymentManager 调用本类把 agents.d 中的事件声明转换为 HookDefinition，再由
 * HookManager 修改 Agent settings。部署会移除 retired/replaced 命令、按平台包装
 * PowerShell、为事件附加子命令，并为 Codex 额外写 trust hash；Kiro 还有 Agent 配置
 * 文件与默认 Agent 的兼容步骤。`needsDeploy()` 供启动和 Watchdog 判断自愈，单个设置
 * 文件异常转成 DeployResult 或由上层 best-effort 隔离。
 */


import * as path from 'node:path';
import type {
  AgentDefinition,
  AgentHookConfig,
  DeployResult,
  DeployStrategy,
  DeployedAgentRecord,
} from '../types/index.js';
import { HookManager, type HookDefinition } from '../hooks/hook-manager.js';
import { readJsonFile, writeJsonFile, resolveHome, ensureDir } from '../utils/fs-utils.js';
import { detectAgent } from './detect-utils.js';
import { createLogger } from '../utils/logger.js';
import {
  writeTrustedHashes,
  removeTrustBlock,
  verifyTrustHashes,
} from './codex-trust-writer.js';

const logger = createLogger('HookStrategy');

/**
 * 把 hook event 名(JSON 中的 PascalCase,如 "SessionStart") → mjs handler 期望的
 * subcommand 名(kebab-case,如 "session-start")。两端必须保持一致,否则 trust hash
 * 会因 command 字符串差异而对不上。
 */
function eventToSubcommand(event: string): string {
  return event.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Windows 必须用 `powershell -File` 调用 ps1 才能正确接收 stdin；经 cmd/child_process
 * 直接执行裸 ps1 路径会丢失管道输入。
 */
function wrapPs1Command(cmd: string): string {
  if (process.platform !== 'win32') return cmd;
  const parts = cmd.split(' ');
  const script = parts[0];
  if (!script.endsWith('.ps1')) return cmd;
  const args = parts.slice(1).join(' ');
  const wrapped = `powershell -NoProfile -ExecutionPolicy Bypass -File ${script}`;
  return args ? `${wrapped} ${args}` : wrapped;
}

/**
 * 拼 hooks.json 中实际写入的 command 字符串。
 * 必须与 codex trust hash 算用的字符串完全一致。
 */
function formatHookCommand(
  hookCommand: string,
  event: string,
  style: AgentHookConfig['eventSubcommand'],
): string {
  const cmd = wrapPs1Command(hookCommand);
  if (style === 'kebab-case') {
    return `${cmd} ${eventToSubcommand(event)}`;
  }
  if (style === 'as-is') {
    return `${cmd} ${event}`;
  }
  return cmd;
}

/**
 * agents.d Hook 声明的 DeployStrategy 实现。
 *
 * detect/needsDeploy 只读检查；deploy/undeploy 通过 HookManager 修改 Agent JSON，Codex
 * 还同步 config.toml trust，Kiro 使用专用 flat Agent 文件格式。
 */
export class HookStrategy implements DeployStrategy {
  private readonly hookManager: HookManager;

  /** @param hookManager 负责 settings JSON 具体数组读写。 */
  constructor(hookManager: HookManager) {
    this.hookManager = hookManager;
  }

  /** 按声明路径/命令判断 Agent 是否存在。 */
  async detect(def: AgentDefinition): Promise<boolean> {
    return detectAgent(def.detection);
  }

  /**
   * 检查专用设置结构、预期 Hook、retired Hook 和 Codex version 字段；任一不符合即需修复。
   */
  async needsDeploy(def: AgentDefinition, _record?: DeployedAgentRecord): Promise<boolean> {
    if (await this.needsSettingsRepairForCodex(def)) {
      return true;
    }

    if (def.hook?.kiroAgent) {
      return this.kiroAgentNeedsDeploy(def);
    }

    const hookDefs = this.buildHookDefinitions(def);
    for (const hookDef of hookDefs) {
      if (!(await this.hookManager.isHookInstalled(hookDef))) {
        return true;
      }
    }
    for (const retiredDef of this.buildRetiredHookDefinitions(def)) {
      if (await this.hookManager.isHookInstalled(retiredDef)) {
        return true;
      }
    }
    return false;
  }

  /** Codex hooks.json 只能有 hooks 顶层字段；存在历史 version 或结构损坏时需要修复。 */
  private async needsSettingsRepairForCodex(def: AgentDefinition): Promise<boolean> {
    const settingsPath = def.hook?.settingsPath;
    if (!settingsPath) return false;

    const isCodexHooksJson = settingsPath.endsWith('hooks.json') && settingsPath.includes('.codex');
    if (!isCodexHooksJson) return false;

    const existing = await readJsonFile<Record<string, unknown>>(settingsPath);
    return existing?.version !== undefined;
  }

  /**
   * 确保 settings 文件，移除 retired/replaced Hook，安装当前事件，合并可选 env，最后为
   * Codex 写 trust。Kiro 分支采用专用格式并提前返回。
   */
  async deploy(def: AgentDefinition): Promise<DeployResult> {
    const hookConfig = def.hook;
    if (!hookConfig) {
      return { success: false, agentId: def.id, deployMode: 'hook', error: 'missing hook config' };
    }

    try {
      await this.ensureSettingsFile(hookConfig.settingsPath);

      // Kiro CLI: settingsPath 是整个 Agent 定义 JSON，需要顶层 name + tools +
      // hooks:<event>:[{command, matcher}]（flat，无 type 字段）。
      // 此分支提前返回，不执行共享 retiredEvents/env。当前 Kiro 声明没有这两项；未来
      // 若增加，必须在 deployKiroAgent 显式实现，不能假设共享路径会覆盖。
      if (hookConfig.kiroAgent) {
        await this.deployKiroAgent(def);
        logger.info('hooks deployed', { agentId: def.id, events: hookConfig.events.length });
        return { success: true, agentId: def.id, deployMode: 'hook' };
      }

      const retiredHookDefs = this.buildRetiredHookDefinitions(def);
      for (const retiredHookDef of retiredHookDefs) {
        const removed = await this.hookManager.uninstallHook(retiredHookDef);
        if (!removed) {
          return { success: false, agentId: def.id, deployMode: 'hook', error: 'failed to remove retired hook event' };
        }
      }
      if (hookConfig.trustToml && retiredHookDefs.length > 0) {
        const trust = hookConfig.trustToml;
        removeTrustBlock(
          resolveHome(trust.configPath),
          trust.marker,
          path.resolve(resolveHome(hookConfig.settingsPath)),
          retiredHookDefs.map(definition => definition.hookJsonPath.at(-1)!),
        );
      }

      if (hookConfig.env) {
        try {
          await this.applyEnvToSettings(hookConfig.settingsPath, hookConfig.env);
        } catch (err) {
          // env 注入失败不阻断 Hook；无 preload 时仍可采集基础 transcript 事件。
          logger.warn('settings.env merge failed (non-blocking)', {
            agentId: def.id,
            error: String(err),
          });
        }
      }

      const hookDefs = this.buildHookDefinitions(def);
      for (const hookDef of hookDefs) {
        const installed = await this.hookManager.isHookInstalled(hookDef);
        if (!installed) {
          const ok = await this.hookManager.installHook(hookDef);
          if (!ok) {
            return { success: false, agentId: def.id, deployMode: 'hook', error: `failed to install hook for event` };
          }
        }
      }

      // Codex 类 hook 需要写 trust hash 到 config.toml(forceBypass 应急通道由 pilot
      // config.json 的 agents.<id>.trust.forceBypass 控制 — 后续可由 hook-watchdog 读取)
      if (hookConfig.trustToml) {
        try {
          await this.writeCodexTrust(def);
        } catch (err) {
          logger.error('codex trust write failed (deploy continues)', {
            agentId: def.id,
            error: String(err),
          });
        }
      }

      logger.info('hooks deployed', { agentId: def.id, events: hookConfig.events.length });

      if (hookConfig.trustToml) {
        logger.info(
          'Codex desktop app note: if hooks show as "Untrusted" in the desktop UI, ' +
          'please manually trust them once via the desktop hook review prompt. ' +
          'CLI codex will trust them automatically via trusted_hash.',
          { agentId: def.id },
        );
      }
      return { success: true, agentId: def.id, deployMode: 'hook' };
    } catch (err) {
      return { success: false, agentId: def.id, deployMode: 'hook', error: String(err) };
    }
  }

  /**
   * 写 Codex trust hash + 立即自洽性校验(Q8)。
   * 校验失败仅记 logger.error,不阻塞 deploy(让 hook-watchdog 活性检查兜底重试)。
   *
   * 注:command 字符串必须与 HookManager.installHook 写入 hooks.json 时一致,否则 hash 对不上。
   * HookManager nested format 写入的 command 就是原始 def.hook.hookCommand + 末尾空格 + subcommand
   * (subcommand 在我们 buildHookDefinitions 里没拼,因为 mjs handler 是单入口、subcommand 当 argv)。
   * 这里 trust hash 算的是 `bash <hookCommand> <subcommand>` — 与实际 hooks.json 中条目对齐。
   *
   * 重要:HookManager 写 hooks.json 时把 hookCommand 整体作为 command(不会拼 subcommand),
   * 所以**每个 event** 的 hooks.json 条目共享同一个 hookCommand 字符串。但 codex 上游 trust hash
   * 是基于 hooks.json 中 entry 的精确 command 算的;hooks.json 里写 `bash $entryPath` 而 trust 算
   * `bash $entryPath <sub>` 会对不上。
   *
   * 解决:HookManager 已支持每事件独立 hookCommand(我们在 buildHookDefinitions 里拼了 subcommand),
   * 见下方 buildHookDefinitions 改动。
   */
  private async writeCodexTrust(def: AgentDefinition): Promise<void> {
    const cfg = def.hook!.trustToml!;
    const configPath = resolveHome(cfg.configPath);
    const hooksJsonAbsPath = path.resolve(resolveHome(def.hook!.settingsPath));
    const hookCommand = resolveHome(def.hook!.hookCommand);

    // 构建 event → 实际写入 hooks.json 的完整 command(与 buildHookDefinitions 一致)
    const eventToCmd: Record<string, string> = {};
    for (const ev of def.hook!.events) {
      eventToCmd[ev] = formatHookCommand(hookCommand, ev, def.hook!.eventSubcommand);
    }

    // 回读 hooks.json,算出每个 event 中 pilot hook 的实际 group index。
    // 当其他第三方 hook(如 r2c)排在前面时,pilot 的 hook 会被 push 到后面的位置。
    // trust hash 的 key 必须用实际 index,否则 codex 端校验失败(静默 Untrusted)。
    const eventToGroupIndex = await this.resolveGroupIndices(def);

    writeTrustedHashes({
      configPath,
      hooksJsonAbsPath,
      hookEvents: def.hook!.events,
      eventToCommand: eventToCmd,
      eventToGroupIndex,
      marker: cfg.marker,
      forceBypass: process.env.LOONGSUITE_PILOT_CODEX_FORCE_BYPASS === '1',
    });

    if (process.env.LOONGSUITE_PILOT_CODEX_FORCE_BYPASS === '1') {
      logger.warn('Codex trust bypass enabled via LOONGSUITE_PILOT_CODEX_FORCE_BYPASS — hook trust verification is DISABLED', { agentId: def.id });
    }

    const verify = verifyTrustHashes({
      configPath,
      hooksJsonAbsPath,
      hookEvents: def.hook!.events,
      eventToCommand: eventToCmd,
      eventToGroupIndex,
      marker: cfg.marker,
    });
    if (!verify.valid) {
      logger.error('codex trust hash verification failed', {
        agentId: def.id,
        mismatches: verify.mismatches,
      });
    } else {
      logger.info('codex trust hash verified', { agentId: def.id });
    }
  }

  /** 卸载当前、retired 及 replaceHookCommands 匹配项；Codex 同时移除 trust block。 */
  async undeploy(def: AgentDefinition): Promise<boolean> {
    const hookDefs = this.buildHookDefinitions(def);
    let allOk = true;
    for (const hookDef of hookDefs) {
      const ok = await this.hookManager.uninstallHook(hookDef);
      if (!ok) allOk = false;
    }

    if (def.hook?.trustToml) {
      try {
        const cfg = def.hook.trustToml;
        const configPath = resolveHome(cfg.configPath);
        const hooksJsonAbsPath = path.resolve(resolveHome(def.hook.settingsPath));
        removeTrustBlock(configPath, cfg.marker, hooksJsonAbsPath, def.hook.events);
      } catch (err) {
        logger.warn('codex trust cleanup failed (non-blocking)', { error: String(err) });
      }
    }

    return allOk;
  }

  /**
   * 回读 hooks.json,找到 pilot hook command 在每个 event 数组中的实际 group index。
   * 支持 nested format({hooks:[{command}]}) 和 flat format({command})两种结构。
   */
  private async resolveGroupIndices(def: AgentDefinition): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    const hookCommand = resolveHome(def.hook!.hookCommand);

    try {
      const settings = await readJsonFile<Record<string, unknown>>(def.hook!.settingsPath);
      const hooks = (settings as any)?.hooks;
      if (!hooks || typeof hooks !== 'object') {
        return result;
      }

      for (const event of def.hook!.events) {
        const arr = hooks[event];
        if (!Array.isArray(arr)) continue;
        const cmd = formatHookCommand(hookCommand, event, def.hook!.eventSubcommand);
        for (let i = 0; i < arr.length; i++) {
          const entry = arr[i];
          // nested 结构：{hooks: [{command}]}。
          if (Array.isArray(entry?.hooks)) {
            if (entry.hooks.some((h: any) => h.command === cmd)) {
              result[event] = i;
              break;
            }
          }
          // flat 结构：{command}。
          if (entry?.command === cmd) {
            result[event] = i;
            break;
          }
        }
      }
    } catch {
      // 读取失败时回退下标 0；首次安装且无第三方 Hook 时成立。
    }

    return result;
  }

  /** 把当前事件逐一转换为 HookDefinition，并按 eventSubcommand 拼出精确命令。 */
  private buildHookDefinitions(def: AgentDefinition): HookDefinition[] {
    const hookConfig = def.hook;
    if (!hookConfig) return [];

    return hookConfig.events.map(event => ({
      agentId: def.id,
      settingsPath: hookConfig.settingsPath,
      hookJsonPath: ['hooks', event],
      hookCommand: formatHookCommand(
        hookConfig.hookCommand, event, hookConfig.eventSubcommand,
      ),
      matcher: hookConfig.matcher,
      useNestedFormat: hookConfig.format === 'nested',
      replaceHookCommands: hookConfig.replaceHookCommands,
    }));
  }

  /** 把 retiredEvents 转换为仅用于卸载的 HookDefinition。 */
  private buildRetiredHookDefinitions(def: AgentDefinition): HookDefinition[] {
    const hookConfig = def.hook;
    if (!hookConfig?.retiredEvents?.length) return [];
    const currentEvents = new Set(hookConfig.events);
    return [...new Set(hookConfig.retiredEvents)]
      .filter(event => !currentEvents.has(event))
      .map(event => ({
        agentId: def.id,
        settingsPath: hookConfig.settingsPath,
        hookJsonPath: ['hooks', event],
        hookCommand: formatHookCommand(
          hookConfig.hookCommand, event, hookConfig.eventSubcommand,
        ),
        matcher: hookConfig.matcher,
        useNestedFormat: hookConfig.format === 'nested',
        replaceHookCommands: hookConfig.replaceHookCommands,
      }));
  }

  /**
   * 把 Hook 声明 env 合并进 settings 顶层 env。
   *
   * 幂等规则：普通 key 覆盖旧值；BUN_OPTIONS 视为空格分隔 flag，若已含相同 preload
   * token 则不重复追加，以便与用户 preload 共存。
   *
   * 失败为非致命，deploy 调用方负责捕获。
   */
  private async applyEnvToSettings(
    settingsPath: string,
    env: Record<string, string>,
  ): Promise<void> {
    // `$PILOT_DATA` 已由 AgentDefLoader 递归展开，此处不再处理。
    const existing =
      (await readJsonFile<Record<string, unknown>>(settingsPath)) ?? {};
    const envBlock =
      (existing.env as Record<string, string> | undefined) ?? {};
    let changed = false;

    for (const [key, value] of Object.entries(env)) {
      if (key === 'BUN_OPTIONS') {
        const current = envBlock[key];
        if (typeof current === 'string' && current.length > 0) {
          // 按完整空白分隔 token 匹配，避免 `intercept.mjs-debug` 之类超字符串误判。
          const ourTokens = value.split(/\s+/).filter(Boolean);
          const currentTokens = current.split(/\s+/).filter(Boolean);
          if (ourTokens.every((t) => currentTokens.includes(t))) {
            continue; // 精确 token 已存在，说明无需重复注入。
          }
          envBlock[key] = `${current} ${value}`.trim();
          changed = true;
          continue;
        }
      }

      if (envBlock[key] !== value) {
        envBlock[key] = value;
        changed = true;
      }
    }

    if (!changed) return;
    existing.env = envBlock;
    await writeJsonFile(settingsPath, existing);
    logger.info('settings.env merged', { settingsPath, keys: Object.keys(env) });
  }

  /**
   * Kiro CLI Agent 定义 JSON（~/.kiro/agents/<name>.json）专用 deploy。
   *
   * 文件结构（round3 实证，hook.rs Hook 扁平结构无 type 字段）：
   *   { "name": "...", "tools": [...], "hooks": { "<event>": [{"command": "..."}] } }
   * 每个 hook 条目是 flat {command, matcher?}（无 type 字段，否则 Kiro loader 拒绝）。
   */
  private async deployKiroAgent(def: AgentDefinition): Promise<void> {
    const hookConfig = def.hook!;
    const settingsPath = resolveHome(hookConfig.settingsPath);
    const agent = hookConfig.kiroAgent!;
    const hookCommandBase = resolveHome(hookConfig.hookCommand);

    await ensureDir(path.dirname(settingsPath));
    const existing = (await readJsonFile<Record<string, unknown>>(settingsPath)) ?? {};

    const merged: Record<string, unknown> = { ...existing };
    merged['name'] = agent.name;
    merged['tools'] = agent.tools;

    const hooks = (merged['hooks'] && typeof merged['hooks'] === 'object')
      ? { ...(merged['hooks'] as Record<string, unknown>) }
      : {};

    for (const event of hookConfig.events) {
      const cmd = formatHookCommand(hookCommandBase, event, hookConfig.eventSubcommand);
      const entry: Record<string, unknown> = { command: cmd };
      if (hookConfig.matcher) entry['matcher'] = hookConfig.matcher;

      const arr = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
      // 移除旧的 pilot hook 条目（command 以 hookCommandBase 开头），保留第三方
      const filtered = arr.filter((e) => {
        const existingCmd = (e as any)?.command;
        return typeof existingCmd !== 'string' || !existingCmd.startsWith(hookCommandBase);
      });
      // 幂等：已存在则不重复 push
      const present = filtered.some((e) => (e as any)?.command === cmd);
      if (!present) filtered.push(entry);
      hooks[event] = filtered;
    }

    merged['hooks'] = hooks;
    await writeJsonFile(settingsPath, merged);

    // 仅在缺失时设默认 pilot-kiro，不覆盖用户显式选择；用户仍可临时传 --agent。
    await this.setKiroDefaultAgentIfMissing(agent.name);
  }

  /**
   * ~/.kiro/settings/cli.json 尚未设置时写 chat.defaultAgent，使 Kiro 默认加载 Pilot Agent。
   */
  private async setKiroDefaultAgentIfMissing(agentName: string): Promise<void> {
    // 这是 CLI 默认选择文件，不是 hookConfig.settingsPath 的 Agent 定义；两路径并非一一对应。
    const cliSettingsPath = resolveHome('~/.kiro/settings/cli.json');
    try {
      await ensureDir(path.dirname(cliSettingsPath));
      const cli = (await readJsonFile<Record<string, unknown>>(cliSettingsPath)) ?? {};
      const cur = cli['chat.defaultAgent'];
      if (typeof cur === 'string' && cur.length > 0) return; // 保留用户已有选择。
      cli['chat.defaultAgent'] = agentName;
      await writeJsonFile(cliSettingsPath, cli);
      logger.info('kiro default agent set', { path: cliSettingsPath, agent: agentName });
    } catch (err) {
      logger.warn('failed to set kiro default agent', { error: String(err) });
    }
  }

  /** 验证 Kiro Agent 文件的 name、tools 和每个事件 flat command 是否完整。 */
  private async kiroAgentNeedsDeploy(def: AgentDefinition): Promise<boolean> {
    const hookConfig = def.hook!;
    const settings = await readJsonFile<Record<string, unknown>>(resolveHome(hookConfig.settingsPath));
    if (!settings) return true;
    const hooks = settings['hooks'] as Record<string, unknown> | undefined;
    if (!hooks || typeof hooks !== 'object') return true;
    const base = resolveHome(hookConfig.hookCommand);
    for (const event of hookConfig.events) {
      const cmd = formatHookCommand(base, event, hookConfig.eventSubcommand);
      const arr = hooks[event];
      if (!Array.isArray(arr)) return true;
      const found = arr.some((e) => (e as any)?.command === cmd);
      if (!found) return true;
    }
    return false;
  }

  /**
   * 确保 settings 文件存在且顶层结构有效。Cursor hooks.json 需要 version；Codex 使用
   * deny_unknown_fields，只允许 hooks，必须移除旧版注入的 version。
   */
  private async ensureSettingsFile(settingsPath: string): Promise<void> {
    const isHooksJson = settingsPath.endsWith('hooks.json');
    const needsVersion = isHooksJson && settingsPath.includes('.cursor');

    const existing = await readJsonFile<Record<string, unknown>>(settingsPath);
    if (!existing) {
      if (isHooksJson) {
        const initial: Record<string, unknown> = { hooks: {} };
        if (needsVersion) {
          initial.version = 1;
        }
        await writeJsonFile(settingsPath, initial);
      }
    } else if (needsVersion && existing.version === undefined) {
      existing.version = 1;
      await writeJsonFile(settingsPath, existing);
    } else if (isHooksJson && settingsPath.includes('.codex') && existing.version !== undefined) {
      // 清理旧 Pilot 注入的 version，否则 Codex 会拒绝整个文件。
      delete existing.version;
      await writeJsonFile(settingsPath, existing);
    }
  }
}
