/**
 * 已部署 Hook、插件注入与附加拦截能力的自愈巡检器。
 *
 * `Orchestrator` 根据 DeploymentManager 的声明构造目标并启动本类。启动延迟后，
 * Watchdog 周期读取 Agent 配置；marker 缺失时调用直接 repairFn，或用 spawn 执行
 * 外部安装命令。修复受冷却时间、每日次数和超时限制，单个目标失败不会阻断其他目标
 * 或 Collector。`stop()` 清 timer，但已启动的异步检查会按自身超时结束。
 */


import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { HookWatchdogConfig } from '../types/index.js';
import { directoryExists, fileExists, readJsonFile, resolveHome } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('HookWatchdog');

const STARTUP_DELAY_MS = 30_000;
const REPAIR_TIMEOUT_MS = 30_000;
const MAX_INTERCEPT_REPAIRS_PER_DAY = 3;

export interface PluginCheckTarget {
  /** 稳定 Agent ID，同时作为冷却时间 Map 的键。 */
  agentId: string;
  /** Agent 自己的 JSON 配置文件；目录不存在表示 Agent 尚不可用。 */
  settingsPath: string;
  /** 必须包含本项目命令 marker 的 Hook 事件名。 */
  expectedHooks: string[];
  /** settings.json 中用于识别本项目 Hook 命令的子串。 */
  markers: string[];

  /** 插件型修复的外部命令；未提供 repairFn 时必填。 */
  binPath?: string;
  /** 外部安装命令参数。 */
  installArgs?: string[];
  /** HookManager 直接修复函数，优先于 binPath。 */
  repairFn?: () => Promise<boolean>;
}

export interface InterceptCheckTarget {
  /** 冷却与每日计数使用的唯一键。 */
  id: string;
  /** 返回 true 表示当前注入健康，不需要 repair。 */
  check: () => Promise<boolean>;
  /** 写 shell rc、launchctl 或插件配置；异常由本类按目标隔离。 */
  repair: () => Promise<void>;
  /** 检查 Agent/资产是否存在；false 时跳过且不消耗修复额度。 */
  precondition: () => Promise<boolean>;
  /**
   * 所属 Agent 是否被用户配置启用。返回 false 时不注入，而调用可选 cleanup 删除旧
   * 拦截；省略时为兼容旧调用方而视为启用。
   */
  enabled?: () => boolean | Promise<boolean>;
  /**
   * enabled=false 时幂等删除已安装拦截，使配置禁用真正停止采集，而不只是停止自愈。
   * 省略时仅跳过禁用目标。
   */
  cleanup?: () => Promise<void>;
}

/**
 * 从 shell rc 文本中删除含 BEGIN/END marker 的整个区块。包含 begin 的行开始跳过，
 * 包含 end 的行结束跳过，其余行原样保留。
 */
export function stripMarkerBlock(content: string, begin: string, end: string): string {
  const out: string[] = [];
  // inBlock 是逐行状态机；若只出现 begin 而没有 end，余下内容都会被视为区块并移除。
  // 因此 marker 必须足够具体，只能作用于本项目生成的受控区块。
  let inBlock = false;
  for (const line of content.split('\n')) {
    if (!inBlock && line.includes(begin)) { inBlock = true; continue; }
    if (inBlock && line.includes(end)) { inBlock = false; continue; }
    if (!inBlock) out.push(line);
  }
  return out.join('\n');
}

export interface CheckResult {
  /** Hook 健康、处于冷却或修复失败时都会计入；不是纯“健康数”。 */
  checked: number;
  /** 本轮成功完成 repair 的 Hook 与 intercept 数量。 */
  repaired: number;
  /** Agent/资产不可用或产品门禁关闭的目标数。 */
  skipped: number;
}

export interface TargetResult {
  agentId: string;
  status: 'healthy' | 'repaired' | 'cooldown' | 'unavailable' | 'repair-failed';
  expected?: number;
  found?: number;
  missing?: string[];
}

/**
 * 周期验证本项目 Hook 是否仍注册在 Agent settings 中，支持两类修复：
 *
 * - 插件 Agent：spawn 外部安装命令；
 * - Hook Agent：直接调用 HookManager 部署函数。
 *
 * 共享 settings 被其他工具覆盖时检测并恢复；每目标失败相互隔离。
 */
export class HookWatchdog {
  /** ConfigLoader 补齐的总开关、周期与修复冷却。 */
  private readonly config: HookWatchdogConfig;
  /** 标准 Agent settings.hooks marker 目标。 */
  private readonly targets: PluginCheckTarget[];
  /** shell rc、launchctl、plugin-inject 等任意 check/repair 目标。 */
  private readonly interceptTargets: InterceptCheckTarget[];
  /** 成功和失败修复都会写入，避免坏配置持续触发写盘或 spawn。 */
  private readonly lastRepairAt: Map<string, number> = new Map();
  /** 仅 intercept 使用的 UTC 日修复次数；标准 Hook 只有冷却限制。 */
  private readonly dailyRepairCount: Map<string, number> = new Map();
  /** 与 dailyRepairCount 对应的 UTC YYYY-MM-DD。 */
  private dailyRepairResetDate = '';
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param targets Hook/插件配置目标；省略时使用兼容默认目标。
   * @param interceptTargets shell rc、launchctl 等额外拦截目标。
   */
  constructor(
    config: HookWatchdogConfig,
    targets?: PluginCheckTarget[],
    interceptTargets?: InterceptCheckTarget[],
  ) {
    this.config = config;
    this.targets = targets ?? HookWatchdog.defaultTargets();
    this.interceptTargets = interceptTargets ?? [];
  }

  /**
   * 配置开启时延迟 30 秒首检，再按 intervalMs 周期执行。timer 当前未 unref，会维持
   * Node 进程；Orchestrator.stop() 必须调用 stop()。重复 start 目前也不会清旧 timer，
   * 生命周期约定是每个实例只启动一次。
   */
  start(): void {
    if (!this.config.enabled) {
      logger.info('hook-watchdog disabled');
      return;
    }
    logger.info('scheduling hook watchdog', {
      intervalMs: this.config.intervalMs,
      repairCooldownMs: this.config.repairCooldownMs,
      targets: this.targets.map(t => t.agentId),
    });

    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      // timer 不等待 Promise；runCheck 在目标边界捕获错误。若一轮超过 interval，后续轮次
      // 可能重叠，lastRepairAt 可限制重复修复，但不构成完整的运行中互斥锁（待确认）。
      void this.runCheck();
      this.intervalTimer = setInterval(() => void this.runCheck(), this.config.intervalMs);
    }, STARTUP_DELAY_MS);
  }

  /** 清除尚未执行的启动与周期 timer；已开始的检查、文件写入或子进程继续完成。 */
  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  /**
   * 顺序检查 Hook 目标，再检查 intercept 目标。
   * @returns checked/repaired/skipped 汇总；单目标异常只记录，不 reject 整轮。
   */
  async runCheck(): Promise<CheckResult> {
    const summary: CheckResult = { checked: 0, repaired: 0, skipped: 0 };

    for (const target of this.targets) {
      // 顺序 await 避免多个安装命令同时改共享 Agent 配置，也让日志顺序稳定。
      try {
        const result = await this.checkTarget(target);
        if (result.status === 'unavailable') {
          summary.skipped++;
        } else if (result.status === 'repaired') {
          summary.repaired++;
        } else {
          // cooldown 与 repair-failed 也归入 checked，表示目标已完成检查但本轮未成功修复。
          summary.checked++;
        }
      } catch (err) {
        logger.error('hook-watchdog target failed', {
          agent: target.agentId,
          error: String(err),
        });
      }
    }

    await this.checkInterceptTargets(summary);

    return summary;
  }

  /** 检查单 Agent settings、marker 和冷却时间，必要时执行修复并返回结构化状态。 */
  private async checkTarget(target: PluginCheckTarget): Promise<TargetResult> {
    // 先检查父目录，不为未安装 Agent 创建配置目录，也避免 readJsonFile 产生无意义告警。
    const settingsDirOk = await directoryExists(path.dirname(target.settingsPath));
    if (!settingsDirOk) {
      logger.debug('hook-watchdog.skipped', {
        agent: target.agentId,
        reason: 'settings-dir-missing',
      });
      return { agentId: target.agentId, status: 'unavailable' };
    }

    if (!target.repairFn && target.binPath) {
      // 直接 repairFn 不依赖外部 bin；命令型目标必须先确认安装器存在。
      const binOk = await fileExists(target.binPath);
      if (!binOk) {
        logger.debug('hook-watchdog.skipped', {
          agent: target.agentId,
          reason: 'bin-missing',
        });
        return { agentId: target.agentId, status: 'unavailable' };
      }
    }

    // 文件缺失、坏 JSON 都会得到 null，findMissingHooks 会把所有期望事件视为缺失并修复。
    const settings = await readJsonFile<Record<string, unknown>>(target.settingsPath);
    const missing = this.findMissingHooks(settings, target);
    const found = target.expectedHooks.length - missing.length;

    if (missing.length === 0) {
      logger.info('hook-watchdog.check', {
        agent: target.agentId,
        expected: target.expectedHooks.length,
        found,
        healthy: true,
      });
      return {
        agentId: target.agentId,
        status: 'healthy',
        expected: target.expectedHooks.length,
        found,
      };
    }

    const lastAt = this.lastRepairAt.get(target.agentId);
    if (lastAt !== undefined) {
      const sinceLast = Date.now() - lastAt;
      if (sinceLast < this.config.repairCooldownMs) {
        logger.debug('hook-watchdog.skipped', {
          agent: target.agentId,
          reason: 'cooldown',
          remainingMs: this.config.repairCooldownMs - sinceLast,
          missing,
        });
        return { agentId: target.agentId, status: 'cooldown', missing };
      }
    }

    logger.warn('hook-watchdog.repair', {
      agent: target.agentId,
      expected: target.expectedHooks.length,
      found,
      missing,
      action: target.repairFn ? 'hook-manager' : 'install',
    });

    const ok = await this.repairTarget(target);
    // 失败尝试也进入冷却，避免权限错误或坏安装器在每次巡检中重复执行。
    this.lastRepairAt.set(target.agentId, Date.now());

    if (!ok) {
      return { agentId: target.agentId, status: 'repair-failed', missing };
    }
    return { agentId: target.agentId, status: 'repaired', missing };
  }

  /** 返回 settings.hooks 中缺失本项目 marker 的事件名。 */
  private findMissingHooks(
    settings: Record<string, unknown> | null,
    target: PluginCheckTarget,
  ): string[] {
    const missing: string[] = [];
    const hooksRoot = settings?.hooks as Record<string, unknown> | undefined;

    for (const event of target.expectedHooks) {
      const arr = hooksRoot?.[event];
      if (!Array.isArray(arr)) {
        missing.push(event);
        continue;
      }
      const hasOurs = arr.some(entry => this.entryContainsMarker(entry, target.markers));
      if (!hasOurs) missing.push(event);
    }

    return missing;
  }

  /**
   * 同时兼容 flat `{command}` 与 nested `{hooks:[{command}]}` 条目。
   * markers 采用子串匹配，只识别“至少有一个本项目命令”，不会要求数组中仅包含本项目 Hook。
   */
  private entryContainsMarker(entry: unknown, markers: string[]): boolean {
    if (!entry || typeof entry !== 'object') return false;
    const e = entry as Record<string, unknown>;

    const cmd = typeof e.command === 'string' ? e.command : '';
    if (cmd && markers.some(m => cmd.includes(m))) return true;

    if (Array.isArray(e.hooks)) {
      return e.hooks.some(sub => {
        if (!sub || typeof sub !== 'object') return false;
        const c = (sub as Record<string, unknown>).command;
        return typeof c === 'string' && markers.some(m => c.includes(m));
      });
    }

    return false;
  }

  /** 优先调用直接修复函数；否则退到受超时保护的外部命令。 */
  private async repairTarget(target: PluginCheckTarget): Promise<boolean> {
    if (target.repairFn) {
      try {
        return await target.repairFn();
      } catch (err) {
        logger.error('hook-watchdog.repair-failed', {
          agent: target.agentId,
          error: String(err),
        });
        return false;
      }
    }
    return this.repairViaCommand(target);
  }

  /**
   * 启动外部安装子进程，清空 NODE_OPTIONS 防止继承旧 preload；stderr 在进程结束前累积，
   * 记录日志时最多截取 500 字符（内存缓冲本身当前没有上限，待确认）。
   * 30 秒未退出则 SIGKILL，并以 false 兑现而非 reject。
   */
  private repairViaCommand(target: PluginCheckTarget): Promise<boolean> {
    return new Promise(resolve => {
      // settled 保证 timeout、spawn error 和 exit 三个异步终点只有第一个能兑现 Promise。
      let settled = false;
      // 使用当前 Node 可执行文件启动 JavaScript bin；非空断言依赖目标契约保证 binPath 与
      // installArgs 在没有 repairFn 时提供，TypeScript 不会在运行时校验该约束。
      const child = spawn(process.execPath, [target.binPath!, ...target.installArgs!], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_OPTIONS: '' },
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // kill 只是发出终止请求；Promise 立即按失败兑现，之后 exit 事件由 settled 忽略。
        child.kill('SIGKILL');
        logger.error('hook-watchdog.repair-timeout', {
          agent: target.agentId,
          timeoutMs: REPAIR_TIMEOUT_MS,
        });
        resolve(false);
      }, REPAIR_TIMEOUT_MS);

      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        // stdout 只为防止管道无人读取导致子进程阻塞，不参与错误诊断；stderr 保存到退出。
        stderr += chunk.toString();
      });

      child.on('error', err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        logger.error('hook-watchdog.repair-failed', {
          agent: target.agentId,
          error: String(err),
        });
        resolve(false);
      });

      child.on('exit', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          logger.info('hook-watchdog.repair-ok', { agent: target.agentId });
          resolve(true);
        } else {
          logger.error('hook-watchdog.repair-failed', {
            agent: target.agentId,
            exitCode: code,
            stderr: stderr.slice(0, 500),
          });
          resolve(false);
        }
      });
    });
  }

  // 以下处理不在 Agent JSON hooks 中的 shell/launchctl 拦截自愈。

  /** 对附加拦截执行启用门控、前置条件、健康检查、冷却和每日三次限流。 */
  private async checkInterceptTargets(summary: CheckResult): Promise<void> {
    this.resetDailyCounterIfNeeded();

    for (const target of this.interceptTargets) {
      try {
        // 用户禁用门控先于检查/修复，避免消耗限流额度，并清除历史拦截以真正停止采集。
        if (target.enabled && !(await target.enabled())) {
          if (target.cleanup) {
            try {
              await target.cleanup();
              logger.info('intercept-watchdog.disabled-cleanup', { id: target.id });
            } catch (err) {
              logger.warn('intercept-watchdog.cleanup-failed', { id: target.id, error: String(err) });
            }
          } else {
            logger.debug('intercept-watchdog.disabled', { id: target.id });
          }
          summary.skipped++;
          continue;
        }

        // precondition 通常只检查 Agent 与本地资产，不读取/修改目标配置。
        const preOk = await target.precondition();
        if (!preOk) {
          logger.debug('intercept-watchdog.skipped', { id: target.id, reason: 'precondition' });
          summary.skipped++;
          continue;
        }

        const healthy = await target.check();
        if (healthy) {
          logger.debug('intercept-watchdog.healthy', { id: target.id });
          summary.checked++;
          continue;
        }

        const lastAt = this.lastRepairAt.get(target.id);
        if (lastAt !== undefined && Date.now() - lastAt < this.config.repairCooldownMs) {
          logger.debug('intercept-watchdog.cooldown', { id: target.id });
          continue;
        }

        const dayKey = target.id;
        const count = this.dailyRepairCount.get(dayKey) ?? 0;
        if (count >= MAX_INTERCEPT_REPAIRS_PER_DAY) {
          logger.warn('intercept-watchdog.daily-limit', { id: target.id, count });
          continue;
        }

        logger.warn('intercept-watchdog.repairing', { id: target.id });
        // intercept 的计数只在 repair 成功后增加；抛错由外层 catch 隔离，下轮仍可重试。
        await target.repair();
        this.lastRepairAt.set(target.id, Date.now());
        this.dailyRepairCount.set(dayKey, count + 1);
        summary.repaired++;
        logger.info('intercept-watchdog.repaired', { id: target.id });
      } catch (err) {
        logger.warn('intercept-watchdog.repair-failed', { id: target.id, error: String(err) });
      }
    }
  }

  /** UTC 日期变化时清空每目标修复次数。 */
  private resetDailyCounterIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dailyRepairResetDate) {
      this.dailyRepairCount.clear();
      this.dailyRepairResetDate = today;
    }
  }

  // 兼容默认目标；生产通常传入由当前 Agent 声明构造的目标。

  /** 返回无外部注入时使用的 Claude/Codex 兼容插件目标。 */
  static defaultTargets(): PluginCheckTarget[] {
    return [
      {
        agentId: 'claude-code',
        settingsPath: resolveHome('~/.claude/settings.json'),
        expectedHooks: [
          'Stop',
          'SubagentStart',
          'SubagentStop',
        ],
        binPath: resolveHome(
          '~/.cache/opentelemetry.instrumentation.claude/package/bin/otel-claude-hook',
        ),
        installArgs: ['install', '--user', '--no-alias', '--quiet'],
        markers: ['otel-claude-hook', 'opentelemetry.instrumentation.claude'],
      },
      {
        agentId: 'codex',
        settingsPath: resolveHome('~/.codex/hooks.json'),
        expectedHooks: [
          'SessionStart',
          'UserPromptSubmit',
          'PreToolUse',
          'PostToolUse',
          'Stop',
        ],
        binPath: resolveHome(
          '~/.cache/opentelemetry.instrumentation.codex/package/bin/otel-codex-hook',
        ),
        installArgs: ['install'],
        markers: ['otel-codex-hook', 'opentelemetry.instrumentation.codex'],
      },
    ];
  }

  /**
   * qodercli 与 claude-code 的 shell rc 拦截块定义。
   *
   * blockFn 必须与 installer 写入内容逐字节一致。`if ! alias ... eval '...'` 既避免
   * 覆盖用户 alias/function，也绕开交互 shell 在解析阶段先展开 alias 的语法问题。
   *
   * 静态纯函数让测试能为任意路径渲染精确文本，而无需触碰真实 HOME/文件系统。
   *
   * signature 是当前形状独有子串；同时验证 marker 与 signature 才能识别并迁移共用旧
   * marker 的历史块。endMarker 界定删除范围。
   */
  /** 返回 shell rc 拦截块的纯描述，不触碰文件系统。 */
  static interceptRcBlockDefs(): Array<{
    id: string;
    agentId: string;
    marker: string;
    endMarker: string;
    signature: string;
    scriptName: string;
    blockFn: (scriptPath: string) => string;
  }> {
    return [
      {
        id: 'qodercli-rc',
        agentId: 'qoder',
        marker: 'loongsuite-pilot BEGIN qodercli-intercept',
        endMarker: 'loongsuite-pilot END qodercli-intercept',
        signature: 'if ! alias qodercli >/dev/null 2>&1',
        scriptName: 'qodercli-token-intercept.mjs',
        blockFn: (p) => [
          '',
          '# loongsuite-pilot BEGIN qodercli-intercept',
          'if ! alias qodercli >/dev/null 2>&1 && ! typeset -f qodercli >/dev/null 2>&1; then',
          `  eval 'qodercli() { BUN_OPTIONS="--preload=${p}" command qodercli "$@"; }'`,
          'fi',
          '# loongsuite-pilot END qodercli-intercept',
        ].join('\n'),
      },
      {
        id: 'claude-code-rc',
        agentId: 'claude-code',
        marker: 'loongsuite-pilot BEGIN claude-code-intercept',
        endMarker: 'loongsuite-pilot END claude-code-intercept',
        signature: 'if ! alias claude >/dev/null 2>&1',
        scriptName: 'claude-code-fetch-intercept.mjs',
        blockFn: (p) => [
          '',
          '# loongsuite-pilot BEGIN claude-code-intercept',
          'if ! alias claude >/dev/null 2>&1 && ! typeset -f claude >/dev/null 2>&1; then',
          `  eval 'claude() { BUN_OPTIONS="--preload=${p} \${BUN_OPTIONS}" command claude "$@"; }'`,
          'fi',
          '# loongsuite-pilot END claude-code-intercept',
        ].join('\n'),
      },
    ];
  }

  /**
   * 构造 macOS launchctl 与 shell rc 的附加拦截目标。rcPathsOverride 仅供测试把真实
   * check/repair/cleanup 闭包指向临时文件。
   */
  static defaultInterceptTargets(
    dataDir: string,
    isAgentEnabled: (agentId: string) => boolean = () => true,
    // 测试可注入 rcPaths 使用临时目录；生产省略并使用 ~/.zshrc、~/.bashrc。
    rcPathsOverride?: string[],
  ): InterceptCheckTarget[] {
    // 静态工厂返回带闭包的新对象数组，每次调用都有独立 dataDir/home/测试路径捕获值。
    const targets: InterceptCheckTarget[] = [];
    const home = os.homedir();

    // macOS：同时维护 qoderwork 的 launchctl 环境变量与 LaunchAgent plist。
    if (process.platform === 'darwin') {
      const wrapperPath = path.join(dataDir, 'hooks', 'qoderwork-runtime-wrapper.mjs');
      const plistPath = path.join(home, 'Library', 'LaunchAgents', 'com.loongsuite-pilot.qoderwork-env.plist');
      const plistLabel = 'com.loongsuite-pilot.qoderwork-env';

      targets.push({
        id: 'qoderwork-env',
        enabled: () => isAgentEnabled('qoder-work'),
        precondition: async () => {
          if (!await fileExists(wrapperPath)) return false;
          const sysApp = await directoryExists('/Applications/QoderWork.app');
          const userApp = await directoryExists(path.join(home, 'Applications', 'QoderWork.app'));
          return sysApp || userApp;
        },
        check: async () => {
          try {
            const { stdout } = await execFileAsync('launchctl', ['getenv', 'QODER_WORKER_RUNTIME_PATH']);
            if (stdout.trim() !== wrapperPath) return false;
            // 同时验证 plist；否则环境变量重启后会丢失。
            return fileExists(plistPath);
          } catch {
            return false;
          }
        },
        repair: async () => {
          await execFileAsync('launchctl', ['setenv', 'QODER_WORKER_RUNTIME_PATH', wrapperPath]);
          // 用固定行数组生成 XML，避免模板缩进把空白意外写入 launchctl 参数值。
          const plistContent = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
            '<plist version="1.0">',
            '<dict>',
            '    <key>Label</key>',
            `    <string>${plistLabel}</string>`,
            '    <key>ProgramArguments</key>',
            '    <array>',
            '        <string>/bin/launchctl</string>',
            '        <string>setenv</string>',
            '        <string>QODER_WORKER_RUNTIME_PATH</string>',
            `        <string>${wrapperPath}</string>`,
            '    </array>',
            '    <key>RunAtLoad</key>',
            '    <true/>',
            '</dict>',
            '</plist>',
            '',
          ].join('\n');
          await fs.mkdir(path.dirname(plistPath), { recursive: true });
          await fs.writeFile(plistPath, plistContent);
          // load/unload 虽已被 bootstrap/bootout 取代，但跨支持版本更稳定且无需查 uid。
          await execFileAsync('launchctl', ['unload', plistPath]).catch(() => {});
          await execFileAsync('launchctl', ['load', plistPath]).catch(() => {});
        },
        cleanup: async () => {
          // 与 installer 对称：仅当 env 仍指向本项目 wrapper 时删除，并移除 plist。
          try {
            const { stdout } = await execFileAsync('launchctl', ['getenv', 'QODER_WORKER_RUNTIME_PATH']);
            if (stdout.trim() === wrapperPath) {
              await execFileAsync('launchctl', ['unsetenv', 'QODER_WORKER_RUNTIME_PATH']).catch(() => {});
            }
          } catch {
            // 未设置时 getenv 非零退出，无需清理。
          }
          if (await fileExists(plistPath)) {
            await execFileAsync('launchctl', ['unload', plistPath]).catch(() => {});
            await fs.rm(plistPath, { force: true }).catch(() => {});
          }
        },
      });
    }

    // 无论 daemon 的 SHELL 为何都检查 zshrc/bashrc；launchd 环境可能不同于交互终端。
    const rcPaths = rcPathsOverride ?? [
      path.join(home, '.zshrc'),
      path.join(home, '.bashrc'),
    ];

    for (const rc of HookWatchdog.interceptRcBlockDefs()) {
      const scriptPath = path.join(dataDir, 'hooks', rc.scriptName);

      targets.push({
        id: rc.id,
        enabled: () => isAgentEnabled(rc.agentId),
        precondition: async () => {
          // Hook 脚本存在即可；daemon 最小 PATH 和非交互 shell 无法可靠使用 which。
          return fileExists(scriptPath);
        },
        check: async () => {
          // 健康判断必须看当前 signature；任一 rc 含旧形状都触发迁移。
          let anyCurrent = false;
          let anyRcExists = false;
          for (const rcPath of rcPaths) {
            if (!await fileExists(rcPath)) continue;
            anyRcExists = true;
            // 顺序读取两个 rc，防止同时修改时覆盖用户在另一文件中的独立变更。
            const content = await fs.readFile(rcPath, 'utf-8');
            if (content.includes(rc.marker)) {
              if (content.includes(rc.signature)) anyCurrent = true;
              else return false; // marker 存在但结构已过时，需要迁移。
            }
          }
          if (anyCurrent) return true;
          // 无块且无 rc 文件时无处可写，视为健康；有 rc 时 repair 会追加。
          return !anyRcExists;
        },
        repair: async () => {
          for (const rcPath of rcPaths) {
            if (!await fileExists(rcPath)) continue; // 绝不替用户创建不存在的 rc 文件。
            const content = await fs.readFile(rcPath, 'utf-8');
            if (content.includes(rc.marker)) {
              if (content.includes(rc.signature)) continue; // 当前结构已生效，无需修复。
              // 删除旧 marker 区域，再追加当前形状。
              // 先把旧完整区块删除，再统一为一个结尾换行并追加新版本，避免重复 marker。
              const stripped = stripMarkerBlock(content, rc.marker, rc.endMarker).replace(/\n+$/, '\n');
              await fs.writeFile(rcPath, stripped + rc.blockFn(scriptPath) + '\n');
            } else {
              await fs.appendFile(rcPath, rc.blockFn(scriptPath) + '\n');
            }
          }
        },
        cleanup: async () => {
          // Agent 禁用时从所有 rc 幂等移除本项目区块。
          for (const rcPath of rcPaths) {
            if (!await fileExists(rcPath)) continue;
            const content = await fs.readFile(rcPath, 'utf-8');
            if (!content.includes(rc.marker)) continue;
            const stripped = stripMarkerBlock(content, rc.marker, rc.endMarker).replace(/\n{3,}$/, '\n\n');
            await fs.writeFile(rcPath, stripped);
          }
        },
      });
    }

    return targets;
  }
}
