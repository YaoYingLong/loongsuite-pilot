/**
 * Hook 模式 Agent 的部署、修复与卸载策略。
 *
 * DeploymentManager 调用本类把 agents.d 中的事件声明转换为 HookDefinition，再由
 * HookManager 修改 Agent settings。部署会移除 retired/replaced 命令、按平台包装
 * PowerShell、为事件附加子命令，并为 Codex 额外写 trust hash；Kiro 还有 Agent 配置
 * 文件与默认 Agent 的兼容步骤。`needsDeploy()` 供启动和 Watchdog 判断自愈，单个设置
 * 文件异常转成 DeployResult 或由上层 best-effort 隔离。
 */


// Node.js `path` 用于规范 settings/trust 文件绝对路径，不负责实际文件读写。
import * as path from 'node:path';
// 类型导入会在编译后擦除；AgentDefinition 的模式专属字段仍需在运行时检查。
import type {
  AgentDefinition,
  AgentHookConfig,
  DeployResult,
  DeployStrategy,
  DeployedAgentRecord,
} from '../types/index.js';
// HookManager 封装 flat/nested settings JSON 的保留式读改写，避免本策略覆盖第三方 Hook。
import { HookManager, type HookDefinition } from '../hooks/hook-manager.js';
// JSON 工具负责容错读取、原子写入、HOME 展开和父目录创建。
import { readJsonFile, writeJsonFile, resolveHome, ensureDir } from '../utils/fs-utils.js';
// detectAgent 是所有部署 Strategy 共用的“路径优先、命令兜底”安装探测入口。
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
 * @param event Agent hooks JSON 中的事件 key。
 * @returns 传给单入口 Hook 脚本的 kebab-case 第一个命令行参数。
 * @remarks 该函数是纯字符串转换；新增事件时还需确认 Hook handler 实际实现了同名子命令。
 */
function eventToSubcommand(event: string): string {
  return event.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Windows 必须用 `powershell -File` 调用 ps1 才能正确接收 stdin；经 cmd/child_process
 * 直接执行裸 ps1 路径会丢失管道输入。
 * @param cmd 已展开 HOME/Pilot 占位符的 Hook 命令及可选原参数。
 * @returns Windows + `.ps1` 时加上 `powershell -NoProfile -ExecutionPolicy Bypass -File`；其他情况原样返回。
 * @remarks 当前按空格切分第一项，声明中脚本路径若自身含空格需另行验证引号兼容性。
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
 * @param hookCommand Agent 声明的 Hook 脚本入口。
 * @param event 当前正在生成的 hooks JSON 事件名。
 * @param style `kebab-case`/`as-is` 决定附加的子命令，未配置时不附加。
 * @returns HookManager 应写入的精确 command；该值同时作为 Codex trust hash 的输入。
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
 *
 * 实例由 `DeploymentManager` 持有，本身没有 timer/子进程。真实资源是用户 Agent
 * 的 settings/hooks JSON 以及 Codex `config.toml` trust block；运行期 HookWatchdog 会重新调用
 * `needsDeploy()` 和 `deploy()`，修复被 Agent 升级或用户工具覆盖的项。
 */
export class HookStrategy implements DeployStrategy {
  /** settings JSON 的具体读写器；本策略负责把 AgentDefinition 翻译成其输入契约。 */
  private readonly hookManager: HookManager;

  /**
   * @param hookManager 负责 settings JSON 中 flat/nested Hook 数组的具体读写与第三方条目保留。
   * @remarks 构造阶段仅保存引用，不读写 Agent 配置。
   */
  constructor(hookManager: HookManager) {
    this.hookManager = hookManager;
  }

  /**
   * 按声明路径/命令判断 Agent 是否存在，是 DeploymentManager 部署流程的第一道准入检查。
   * @returns detection path/command 任一命中时为 `true`；只读文件系统/PATH，不修改 settings。
   */
  async detect(def: AgentDefinition): Promise<boolean> {
    // 复用统一探测顺序和 fail-open 语义，避免不同 Strategy 对同一声明得出不同安装结论。
    return detectAgent(def.detection);
  }

  /**
   * 检查专用设置结构、预期 Hook、retired Hook 和 Codex version 字段；任一不符合即需修复。
   * @param def 已加载并展开路径的 Hook Agent 声明。
   * @param _record 为统一 `DeployStrategy` 签名保留；Hook 完整性以实际 settings 为准，不信任状态记录。
   * @returns 发现历史字段、Kiro 定义不完整、当前 Hook 缺失或 retired Hook 残留时为 `true`。
   * @remarks 方法会读 JSON 但不写入；HookWatchdog 将 `true` 解释为需要自愈部署。
   */
  async needsDeploy(def: AgentDefinition, _record?: DeployedAgentRecord): Promise<boolean> {
    if (await this.needsSettingsRepairForCodex(def)) {
      return true;
    }

    if (def.hook?.kiroAgent) {
      return this.kiroAgentNeedsDeploy(def);
    }

    const hookDefs = this.buildHookDefinitions(def);
    // 当前事件必须全部存在；第一个缺失即可确定需修复，无需继续打开同一份文件。
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

  /**
   * 检查 Codex `hooks.json` 是否存在旧 Pilot 曾注入的顶层 `version`。
   * @returns 非 Codex hooks 路径或无历史 version 时为 `false`；存在时为 `true`。
   * @remarks Codex 对该 JSON 使用 deny_unknown_fields，所以 Cursor 需要的 `version` 在 Codex 中会使整份 Hook 配置失效。
   */
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
   *
   * @param def 必须包含 hook 配置的 AgentDefinition。
   * @returns 所有必要 Hook 已幂等安装时 `success:true`；缺配置或关键 JSON 读写失败时返回错误结果。
   * @remarks env 合并和 Codex trust 写入是非阻断增强；它们失败会记录，但基础 transcript Hook 仍可工作。
   */
  async deploy(def: AgentDefinition): Promise<DeployResult> {
    const hookConfig = def.hook;
    if (!hookConfig) {
      return { success: false, agentId: def.id, deployMode: 'hook', error: 'missing hook config' };
    }

    try {
      // 在任何数组读改写前补齐基础文件结构；后续 HookManager 可以据此执行幂等检查。
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

      // 先删 retired 再安装当前事件，可防止旧新事件在一次 Agent 操作中重复上报。
      const retiredHookDefs = this.buildRetiredHookDefinitions(def);
      for (const retiredHookDef of retiredHookDefs) {
        const removed = await this.hookManager.uninstallHook(retiredHookDef);
        if (!removed) {
          return { success: false, agentId: def.id, deployMode: 'hook', error: 'failed to remove retired hook event' };
        }
      }
      if (hookConfig.trustToml && retiredHookDefs.length > 0) {
        // Hook JSON 旧事件已经移除，对应 trust key 也要同步删掉，避免残留授权继续存在。
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

      // 每个事件独立形成 HookDefinition，任何一个关键写入失败都会让本次部署返回失败。
      const hookDefs = this.buildHookDefinitions(def);
      for (const hookDef of hookDefs) {
        // 先检查再写入，使周期 Watchdog 修复在配置正常时不会不必要地改变文件 mtime。
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
   * 写 Codex trust hash，并立即回读做自洽性校验。
   * 校验失败只记录 logger.error，不阻塞 deploy，由 hook-watchdog 的后续活性检查兜底重试。
   *
   * 注意：command 字符串必须与 HookManager.installHook 写入 hooks.json 时一致，否则 hash 对不上。
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

    // 构建 event -> 实际写入 hooks.json 的完整 command；唯一格式化函数保证安装值与 hash 输入一致。
    const eventToCmd: Record<string, string> = {};
    for (const ev of def.hook!.events) {
      eventToCmd[ev] = formatHookCommand(hookCommand, ev, def.hook!.eventSubcommand);
    }

    // 回读 hooks.json，算出每个 event 中 Pilot Hook 的实际 group index。
    // 当其他第三方 Hook 排在前面时，Pilot 条目会位于后续位置；trust key 必须使用真实下标，
    // 否则 Codex 会把命令视为 Untrusted。
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

  /**
   * 卸载当前、retired 及 `replaceHookCommands` 匹配项；Codex 同时移除归本项目拥有的 trust block。
   * @returns 所有当前 Hook 删除都成功时为 `true`；单个失败仍继续处理其余事件并最终返回 `false`。
   * @remarks trust 清理失败是非阻断告警，不改变 Hook JSON 卸载结果。本方法不删用户第三方 Hook。
   */
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
   * 回读 hooks.json，找到 Pilot Hook command 在每个 event 数组中的实际 group index。
   * 支持 nested format({hooks:[{command}]}) 和 flat format({command})两种结构。
   * @returns event -> group index 的部分 Map；读取失败或事件未命中时省略对应 key，trust writer 回退为 0。
   * @remarks index 是 trust state key 的一部分；第三方 Hook 位于 Pilot 前面时，不能假设 Pilot 永远是第 0 组。
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

  /**
   * 把当前事件逐一转换为 HookManager 可处理的 `HookDefinition`。
   * @returns 每个 event 一项，其 command 已按 `eventSubcommand` 拼成精确文本；缺 hook 配置返回空数组。
   * @remarks 命令文本不仅决定实际执行，也是 Codex trust hash 输入，不可在两条路径各自拼接。
   */
  private buildHookDefinitions(def: AgentDefinition): HookDefinition[] {
    const hookConfig = def.hook;
    if (!hookConfig) return [];

    // map 保持声明中的事件顺序；DeploymentManager/HookManager 随后会按该顺序检查和安装。
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

  /**
   * 把 `retiredEvents` 转换为仅用于卸载的 `HookDefinition`。
   * @returns 去重后的历史事件，并过滤仍在当前 events 中的项，避免先删掉仍需使用的 Hook。
   */
  private buildRetiredHookDefinitions(def: AgentDefinition): HookDefinition[] {
    const hookConfig = def.hook;
    if (!hookConfig?.retiredEvents?.length) return [];
    // Set 同时用于当前事件快速查找和 retiredEvents 去重，避免同一 settings 数组重复卸载。
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
   *
   * @param settingsPath Agent 会读取的 settings JSON。
   * @param env 声明希望注入/更新的顶层 env 键值。
   * @returns 无差异时不写文件并立即兑现；有差异时等待原子 JSON 替换。
   * @throws 读写或现有 JSON 结构异常，由 `deploy()` 转为非阻断告警。
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
   * @param def 包含 `hook.kiroAgent` 的声明，调用前由 `deploy()` 完成前置检查。
   * @returns Agent JSON 和可选默认 Agent 设置处理完成后兑现。
   * @remarks 合并时保留其他顶层字段与第三方 Hook，只替换 command 以本项目入口开头的条目。
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
      // 移除旧的 Pilot Hook 条目（command 以 hookCommandBase 开头），保留第三方条目。
      const filtered = arr.filter((e) => {
        const existingCmd = (e as any)?.command;
        return typeof existingCmd !== 'string' || !existingCmd.startsWith(hookCommandBase);
      });
      // 幂等性：精确命令已存在时不重复 push。
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
   * @param agentName `kiroAgent.name` 声明的默认 Agent 名。
   * @returns 已有用户选择时不写盘；否则等待 cli.json 写入。所有错误在内部降级为告警。
   * @remarks 这是一次性默认值，不覆盖用户已选 Agent，用户仍可使用 `--agent` 临时切换。
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

  /**
   * 验证 Kiro Agent 文件中每个声明事件的 flat command 是否完整。
   * @returns 文件/hooks/事件数组缺失或任一精确 command 未命中时为 `true`；全部存在时为 `false`。
   * @remarks 现有实现不比较 name/tools 字段，文件头部的历史表述需以此代码行为为准。
   */
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
   * @param settingsPath 经 AgentDefLoader 展开后的 Agent 配置路径。
   * @returns 缺失文件已初始化、需要的 version 已补齐/清理，或无需修改时兑现。
   * @throws JSON 写入失败传给 `deploy()` 转为失败结果。
   * @remarks 非 hooks.json 文件不会在缺失时自动初始化；Kiro 分支会在专用方法中创建。
   */
  private async ensureSettingsFile(settingsPath: string): Promise<void> {
    const isHooksJson = settingsPath.endsWith('hooks.json');
    const needsVersion = isHooksJson && settingsPath.includes('.cursor');

    // readJsonFile 将“文件缺失、不可读、JSON 无效”统一为 null；对于 hooks.json，这些情况
    // 都会进入初始化分支并写入基础结构，现有坏 JSON 是否应先备份仍待确认。
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
