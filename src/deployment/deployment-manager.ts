/**
 * Agent 采集能力的声明式部署编排器。
 *
 * `Orchestrator.start()` 调用 `deployAll()`：先兼容清理旧插件，再加载 Agent 声明与
 * deployed-agents.json，逐个检测并分派 Hook、plugin-probe、plugin-inject 或
 * detection-only Strategy。成功结果写回部署状态；单 Agent 失败被隔离并返回失败结果。
 * 动态发现与 HookWatchdog 复用 `deploySingle()`/`needsRedeploy()`。退出时仅停止
 * plugin-probe Worker，不主动卸载用户 Agent 配置，卸载清理由 installer 承担。
 */


import * as path from 'node:path';
import type {
  AgentDefinition,
  DeployResult,
  DeployStrategy,
  DeployedAgentsState,
  DeployedAgentRecord,
} from '../types/index.js';
import { AgentDefLoader, type AgentDefLoaderOptions } from './agent-def-loader.js';
import { HookStrategy } from './hook-strategy.js';
import { PluginProbeStrategy } from './plugin-probe-strategy.js';
import { PluginInjectStrategy } from './plugin-inject-strategy.js';
import { DetectionOnlyStrategy } from './detection-only-strategy.js';
import { writeDeployNotification } from './deploy-notification.js';
import { runPluginMigration } from './plugin-migration.js';
import { HookManager } from '../hooks/hook-manager.js';
import { readJsonFile, writeJsonFile } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('DeploymentManager');

export interface DeploymentManagerOptions {
  dataDir: string;
  pilotDir: string;
  builtinAgentsDir?: string;
}

/**
 * 部署子系统的统一门面和生命周期拥有者。
 *
 * Orchestrator 创建一个实例，并在启动阶段调用 `deployAll()`，运行期间由发现服务和
 * HookWatchdog 调用单 Agent 检查/修复方法，退出时调用 `stopWorkers()` 停止受管 Worker。
 * 本类持有四种 DeployStrategy、声明加载器及 deployed-agents 内存状态；声明和状态文件
 * 是输入，DeployResult 与部署状态 JSON 是输出。各 Agent 的失败会在边界内隔离，
 * 但状态文件整体写入失败仍会向 Orchestrator 抛出。
 */
export class DeploymentManager {
  private readonly dataDir: string;
  private readonly pilotDir: string;
  private readonly hookStrategy: HookStrategy;
  private readonly pluginProbeStrategy: PluginProbeStrategy;
  private readonly pluginInjectStrategy: PluginInjectStrategy;
  private readonly detectionOnlyStrategy: DetectionOnlyStrategy;
  private readonly loader: AgentDefLoader;
  private readonly stateFilePath: string;
  private state: DeployedAgentsState = {};
  private definitions: AgentDefinition[] = [];

  /**
   * 创建四种 Strategy、HookManager 和 AgentDefLoader；构造阶段不读写配置。
   * @param opts dataDir 是运行数据根，pilotDir 是当前版本包根。
   */
  constructor(opts: DeploymentManagerOptions) {
    this.dataDir = opts.dataDir;
    this.pilotDir = opts.pilotDir;
    this.stateFilePath = path.join(opts.dataDir, 'deployed-agents.json');

    const hookManager = new HookManager(
      path.join(opts.dataDir, 'hooks'),
      path.join(opts.dataDir, 'logs'),
    );
    this.hookStrategy = new HookStrategy(hookManager);
    this.pluginProbeStrategy = new PluginProbeStrategy(opts.dataDir, opts.pilotDir);
    this.pluginInjectStrategy = new PluginInjectStrategy(opts.dataDir, opts.pilotDir);
    this.detectionOnlyStrategy = new DetectionOnlyStrategy();

    const loaderOpts: AgentDefLoaderOptions = {
      builtinDir: opts.builtinAgentsDir ?? path.join(opts.pilotDir, 'agents.d'),
      localDir: path.join(opts.dataDir, 'agents.d.local'),
      pilotDir: opts.pilotDir,
      dataDir: opts.dataDir,
    };
    this.loader = new AgentDefLoader(loaderOpts);
  }

  /**
   * 迁移旧插件、加载状态/定义并顺序部署全部 Agent。单 Agent 异常转成失败结果，最后统一
   * 保存 deployed-agents.json。
   */
  async deployAll(): Promise<DeployResult[]> {
    // 阶段 0：以 fail-open 清理旧插件残留。
    try {
      await runPluginMigration();
    } catch (err) {
      logger.warn('plugin migration failed (non-blocking)', { error: String(err) });
    }

    await this.loadState();
    this.definitions = await this.loader.load();

    const results: DeployResult[] = [];

    for (const def of this.definitions) {
      try {
        const result = await this.deployAgent(def);
        results.push(result);
      } catch (err) {
        logger.error('deployment failed', { agentId: def.id, error: String(err) });
        results.push({ success: false, agentId: def.id, deployMode: def.deployMode, error: String(err) });
      }
    }

    await this.saveState();
    const deployed = results.filter(r => r.success && !r.skipped).length;
    const skipped = results.filter(r => r.skipped).length;
    const failed = results.filter(r => !r.success && r.error).length;
    logger.info('deployAll complete', { total: results.length, deployed, skipped, failed });

    return results;
  }

  /** 动态发现/Watchdog 使用的单 Agent 部署；调用前后都刷新并保存状态。 */
  async deploySingle(def: AgentDefinition): Promise<DeployResult> {
    await this.loadState();
    const result = await this.deployAgent(def);
    await this.saveState();
    return result;
  }

  /** 返回最近 deployAll 加载的声明数组；调用方应只读。 */
  getDefinitions(): AgentDefinition[] {
    return this.definitions;
  }

  /**
   * 刷新部署状态并询问对应 Strategy 是否缺失集成。Watchdog 用它检测被其他工具覆盖的
   * Hook/spec；true 表示需要重新部署。
   */
  async needsRedeploy(def: AgentDefinition): Promise<boolean> {
    await this.loadState();
    const strategy = this.getStrategy(def);
    return strategy.needsDeploy(def, this.state[def.id]);
  }

  /** 顺序停止所有 plugin-probe Worker；每个失败只告警。 */
  async stopWorkers(): Promise<void> {
    for (const def of this.definitions) {
      if (def.deployMode !== 'plugin-probe' || !def.pluginProbe) continue;
      try {
        await this.pluginProbeStrategy.stopWorker(def);
      } catch (err) {
        logger.warn('worker stop failed', { agentId: def.id, error: String(err) });
      }
    }
  }

  /**
   * 单 Agent 部署事务：detect -> needsDeploy -> deploy -> source hash/通知 -> 内存状态。
   * 未检测到或无需部署返回 success+skipped；状态真正写盘由外层方法统一完成。
   */
  private async deployAgent(def: AgentDefinition): Promise<DeployResult> {
    const strategy = this.getStrategy(def);

    const detected = await strategy.detect(def);
    if (!detected) {
      logger.debug('agent not detected, skipping', { agentId: def.id });
      return { success: true, agentId: def.id, deployMode: def.deployMode, skipped: true };
    }

    const record = this.state[def.id];
    const isRemote = def.deployMode === 'plugin-probe'
      && def.pluginProbe
      && this.pluginProbeStrategy.isRemoteOnly(def.pluginProbe.source);

    const needs = await strategy.needsDeploy(def, record);
    if (!needs) {
      if (isRemote && record && this.pluginProbeStrategy.isRemoteCheckDue(record)) {
        record.lastRemoteCheckedAt = new Date().toISOString();
      }
      logger.debug('agent already deployed, skipping', { agentId: def.id });
      return { success: true, agentId: def.id, deployMode: def.deployMode, skipped: true };
    }

    logger.info('deploying agent', { agentId: def.id, deployMode: def.deployMode });
    const result = await strategy.deploy(def);

    if (result.success) {
      const newRecord: DeployedAgentRecord = {
        deployMode: def.deployMode,
        deployedAt: new Date().toISOString(),
      };

      if (def.deployMode === 'plugin-probe' && def.pluginProbe) {
        const hash = await this.pluginProbeStrategy.computeSourceHash(
          def.pluginProbe.source.tarball,
          def.pluginProbe.source.url ?? def.pluginProbe.source.remoteUrl,
        );
        if (hash) newRecord.sourceHash = hash;
        if (isRemote) newRecord.lastRemoteCheckedAt = new Date().toISOString();

        await writeDeployNotification(this.dataDir, def.displayName, def.pluginProbe.mountType);
      }

      this.state[def.id] = newRecord;
    }

    return result;
  }

  /** 按 deployMode 选择 Strategy；未知值抛错并由 deployAll 隔离。 */
  private getStrategy(def: AgentDefinition): DeployStrategy {
    switch (def.deployMode) {
      case 'hook':
        return this.hookStrategy;
      case 'plugin-probe':
        return this.pluginProbeStrategy;
      case 'plugin-inject':
        return this.pluginInjectStrategy;
      case 'detection-only':
        return this.detectionOnlyStrategy;
      default:
        throw new Error(`unknown deployMode: ${def.deployMode}`);
    }
  }

  /** 从 deployed-agents.json 恢复状态；文件缺失时使用空对象。 */
  private async loadState(): Promise<void> {
    this.state = (await readJsonFile<DeployedAgentsState>(this.stateFilePath)) ?? {};
  }

  /** 原子写回完整部署状态。 */
  private async saveState(): Promise<void> {
    await writeJsonFile(this.stateFilePath, this.state);
  }
}
