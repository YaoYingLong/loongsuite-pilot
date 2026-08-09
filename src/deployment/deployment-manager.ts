/**
 * Agent 采集能力的声明式部署编排器。
 *
 * `Orchestrator.start()` 调用 `deployAll()`：先兼容清理旧插件，再加载 Agent 声明与
 * deployed-agents.json，逐个检测并分派 Hook、plugin-probe、plugin-inject 或
 * detection-only Strategy。成功结果写回部署状态；单 Agent 失败被隔离并返回失败结果。
 * 动态发现与 HookWatchdog 复用 `deploySingle()`/`needsRedeploy()`。退出时仅停止
 * plugin-probe Worker，不主动卸载用户 Agent 配置，卸载清理由 installer 承担。
 */


// Node.js `path` 只负责跨平台拼接 dataDir/pilotDir 下的状态、Hook 和声明目录。
import * as path from 'node:path';
// `import type` 不产生运行时依赖；DeployStrategy 是四种部署实现共享的调用契约。
import type {
  AgentDefinition,
  DeployResult,
  DeployStrategy,
  DeployedAgentsState,
  DeployedAgentRecord,
} from '../types/index.js';
// Loader 将 JSON 声明和本地覆盖先解析成最终 AgentDefinition，再交给本编排器。
import { AgentDefLoader, type AgentDefLoaderOptions } from './agent-def-loader.js';
// 四种 Strategy 各自拥有具体副作用，本类只按 deployMode 分派并保存结果状态。
import { HookStrategy } from './hook-strategy.js';
import { PluginProbeStrategy } from './plugin-probe-strategy.js';
import { PluginInjectStrategy } from './plugin-inject-strategy.js';
import { DetectionOnlyStrategy } from './detection-only-strategy.js';
// plugin-probe 首次成功后写用户可见提示；旧插件迁移则在所有声明部署前 best-effort 执行。
import { writeDeployNotification } from './deploy-notification.js';
import { runPluginMigration } from './plugin-migration.js';
// HookManager 承担 Agent settings JSON 的保留式读改写，HookStrategy 不直接拼数组。
import { HookManager } from '../hooks/hook-manager.js';
// 部署状态使用统一 JSON 工具读写；writeJsonFile 的失败会向启动主链传播。
import { readJsonFile, writeJsonFile } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('DeploymentManager');

export interface DeploymentManagerOptions {
  /** 持久数据根：状态、已复制 Hook、用户本地声明都位于这里。 */
  dataDir: string;
  /** 当前版本发布包根：包含内置 agents.d 和可选安装包装脚本。 */
  pilotDir: string;
  /** 测试或嵌入场景可覆盖内置声明目录；省略时使用 `<pilotDir>/agents.d`。 */
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
  /** 用户可写运行数据根，供状态、通知和各 Strategy 使用。 */
  private readonly dataDir: string;
  /** 当前版本包根；升级切换版本后新进程会收到新的目录。 */
  private readonly pilotDir: string;
  /** 修改各 Agent Hook settings，并维护 Codex trust/Kiro 兼容结构。 */
  private readonly hookStrategy: HookStrategy;
  /** 获取插件包、运行 install/uninstall，并监管 manifest Worker。 */
  private readonly pluginProbeStrategy: PluginProbeStrategy;
  /** 向 Agent 配置数组注入本地 plugin/extension spec。 */
  private readonly pluginInjectStrategy: PluginInjectStrategy;
  /** 只执行安装探测，不写 Agent 配置的占位 Strategy。 */
  private readonly detectionOnlyStrategy: DetectionOnlyStrategy;
  /** 合并内置与 `<dataDir>/agents.d.local` 定义的加载器。 */
  private readonly loader: AgentDefLoader;
  /** 成功部署摘要的持久化文件路径。 */
  private readonly stateFilePath: string;
  /** 最近一次 loadState() 得到的内存快照；deployAgent 成功后原地更新。 */
  private state: DeployedAgentsState = {};
  /** 最近 deployAll() 加载的定义，也是发现、Watchdog 和退出停 Worker 的共享声明快照。 */
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
   *
   * @returns 与 definitions 相同顺序的 DeployResult；未安装/无需部署也以 success+skipped 表示。
   * @throws 状态读取通常容错为空对象；声明目录整体加载的意外异常或最终状态写入失败仍会传播给 Orchestrator。
   * @remarks 历史状态中已不再存在的 Agent 不会在这里删除，状态文件会保留原记录。
   */
  async deployAll(): Promise<DeployResult[]> {
    // 阶段 0：以 fail-open 清理旧插件残留。
    try {
      await runPluginMigration();
    } catch (err) {
      logger.warn('plugin migration failed (non-blocking)', { error: String(err) });
    }

    // 先恢复上次 source hash/远端检查时间，再加载本次声明；二者共同决定 needsDeploy。
    await this.loadState();
    // 保存定义快照不仅用于本循环，Orchestrator 随后还据此创建动态部署和 Watchdog 目标。
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

    // 单 Agent 失败已变成结果；但整个状态文件无法落盘属于启动级持久化错误，继续向上抛。
    await this.saveState();
    const deployed = results.filter(r => r.success && !r.skipped).length;
    const skipped = results.filter(r => r.skipped).length;
    const failed = results.filter(r => !r.success && r.error).length;
    logger.info('deployAll complete', { total: results.length, deployed, skipped, failed });

    return results;
  }

  /**
   * 动态发现/Watchdog 使用的单 Agent 部署；调用前后都刷新并保存状态。
   * @param def 通常来自最近一次 deployAll() 的定义快照。
   * @returns 探测、跳过或部署结果。
   * @throws 与 deployAll 不同，本方法不把 Strategy 异常转换为失败结果；调用它的发现/Watchdog 边界负责隔离。
   */
  async deploySingle(def: AgentDefinition): Promise<DeployResult> {
    await this.loadState();
    const result = await this.deployAgent(def);
    await this.saveState();
    return result;
  }

  /**
   * 返回最近 deployAll 加载的声明数组；调用方应只读。
   * @returns 内部数组引用而非副本，调用方修改会影响 stopWorkers 和后续主链（因此约定只读）。
   */
  getDefinitions(): AgentDefinition[] {
    return this.definitions;
  }

  /**
   * 刷新部署状态并询问对应 Strategy 是否缺失集成。Watchdog 用它检测被其他工具覆盖的
   * Hook/spec；true 表示需要重新部署。
   * @returns 对应 Strategy 基于真实配置和状态记录给出的修复判断。
   * @throws 状态读取或 Strategy 检查异常交给 Watchdog 的目标级边界处理。
   */
  async needsRedeploy(def: AgentDefinition): Promise<boolean> {
    await this.loadState();
    const strategy = this.getStrategy(def);
    return strategy.needsDeploy(def, this.state[def.id]);
  }

  /**
   * 顺序停止所有 plugin-probe Worker；每个失败只告警。
   * @returns 已加载定义中的全部受管 Worker 完成停止尝试后兑现。
   * @remarks 只处理 deployAll 已写入 definitions 的普通 Worker；Local Worker 由其 ActivationService 单独停止。
   */
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
    // Strategy 选择只依赖声明 deployMode，之后所有 detect/needs/deploy 都走统一接口。
    const strategy = this.getStrategy(def);

    // 先做只读安装探测；未安装的 Agent 不应创建 settings、下载插件或污染部署状态。
    const detected = await strategy.detect(def);
    if (!detected) {
      logger.debug('agent not detected, skipping', { agentId: def.id });
      return { success: true, agentId: def.id, deployMode: def.deployMode, skipped: true };
    }

    // 状态按稳定 Agent ID 索引；本地同 ID 声明覆盖后仍会继承此前的部署摘要。
    const record = this.state[def.id];
    const isRemote = def.deployMode === 'plugin-probe'
      && def.pluginProbe
      && this.pluginProbeStrategy.isRemoteOnly(def.pluginProbe.source);

    const needs = await strategy.needsDeploy(def, record);
    if (!needs) {
      if (isRemote && record && this.pluginProbeStrategy.isRemoteCheckDue(record)) {
        // 到期 hash 检查确认内容没变时，只刷新“已检查时间”；外层 saveState 负责落盘。
        record.lastRemoteCheckedAt = new Date().toISOString();
      }
      logger.debug('agent already deployed, skipping', { agentId: def.id });
      return { success: true, agentId: def.id, deployMode: def.deployMode, skipped: true };
    }

    logger.info('deploying agent', { agentId: def.id, deployMode: def.deployMode });
    const result = await strategy.deploy(def);

    if (result.success) {
      // 只有 Strategy 明确返回 success 才覆盖记录；失败会保留上次成功摘要供下一轮判断。
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

        // 通知只是终端提示；writeDeployNotification 在内部把写入失败降级为告警，不影响成功状态。
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

  /**
   * 从 deployed-agents.json 恢复状态；文件缺失或 JSON 无法解析时使用空对象。
   * @returns 内存 state 替换完成后兑现。
   */
  private async loadState(): Promise<void> {
    this.state = (await readJsonFile<DeployedAgentsState>(this.stateFilePath)) ?? {};
  }

  /**
   * 原子写回完整部署状态。
   * @throws 父目录、临时文件写入或 rename 失败时向 deployAll/deploySingle 传播。
   */
  private async saveState(): Promise<void> {
    await writeJsonFile(this.stateFilePath, this.state);
  }
}
