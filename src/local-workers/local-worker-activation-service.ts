/**
 * Local Worker 实例“期望状态 -> 实际进程”的收敛服务。
 *
 * Orchestrator 启动后，本类监听 local-workers 目录并每 5 秒兜底扫描 instance.json。
 * 对 enabled 实例，它从 AgentDefinition.localWorkerRuntime 派生实例专用 plugin-probe
 * 定义，按配置指纹决定部署/重启 Worker；禁用或删除实例时停止对应进程。fs.watch
 * 回调只请求异步 refresh，Promise 锁避免并发重入；单实例失败写 supervisor 状态并
 * 隔离，不阻断其他 Worker。
 */


import * as crypto from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import * as path from 'node:path';
import type { AgentDefinition } from '../types/index.js';
import { PluginProbeStrategy } from '../deployment/plugin-probe-strategy.js';
import { createLogger } from '../utils/logger.js';
import { ensureDir, writeJsonFile } from '../utils/fs-utils.js';
import {
  bootstrapTokenPath,
  bundleDir,
  listLocalWorkerInstances,
  localWorkerRoot,
  logDir,
  stateDir,
  type LocalWorkerInstance,
  type RuntimeOptions,
} from './instance-store.js';

const logger = createLogger('LocalWorkerActivationService');

const DEFAULT_SCAN_INTERVAL_MS = 5000;

export interface LocalWorkerActivationServiceOptions {
  dataDir: string;
  pilotDir: string;
  definitions: AgentDefinition[];
}

/**
 * Local Worker 期望状态收敛器。
 *
 * Worker CLI 只修改 instance.json；本服务监听实例目录并定期扫描，将 enabled、工作目录、
 * Runtime 参数和 Runtime 包版本等期望状态收敛为真实 Worker 进程。这样 CLI 无需依赖
 * Collector 所在进程，也允许服务重启后从磁盘恢复全部实例。
 *
 * `activeFingerprints` 是进程内的成功快照，只用于快速跳过“配置未变且进程存活”的实例；
 * 它不是真实状态源。Collector 重启后 Map 为空，首轮 `refresh()` 会重新核对包和 PID，
 * 必要时先停旧进程再启动，使实际状态最终回到声明值。
 */
export class LocalWorkerActivationService {
  private readonly dataDir: string;
  private readonly pilotDir: string;
  private readonly definitions: AgentDefinition[];
  private readonly strategy: PluginProbeStrategy;
  /** 已成功部署实例的配置指纹，用于跳过无变化且仍存活的 Worker。 */
  private readonly activeFingerprints = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private watcher: FSWatcher | null = null;
  private refreshing = false;

  /**
   * 保存目录和 Agent 声明快照，并创建复用的 `PluginProbeStrategy`。
   * @param options Orchestrator 提供的数据根、当前包根和已加载 AgentDefinition 列表。
   * @remarks 构造阶段不建立 watcher/timer，不读取实例，也不启停 Worker。
   */
  constructor(options: LocalWorkerActivationServiceOptions) {
    this.dataDir = options.dataDir;
    this.pilotDir = options.pilotDir;
    this.definitions = options.definitions;
    this.strategy = new PluginProbeStrategy(options.dataDir, options.pilotDir);
  }

  /**
   * 确保实例根目录，先收敛现有实例，再建立非持久化 fs.watch 和 5 秒兜底 interval。
   *
   * `Orchestrator.start()` 在 DeploymentManager 已加载模板声明后调用。首次收敛在 Promise 内
   * 完成，所以返回时启动前已存在的实例都至少被检查过一次。
   *
   * @returns 首次扫描完成且 watcher/timer 已建立后兑现。
   * @throws 根目录创建或首轮收敛的未捕获异常向 Orchestrator 传播；`fs.watch` 不可用只告警。
   */
  async start(): Promise<void> {
    const root = localWorkerRoot(this.dataDir);
    await ensureDir(root);
    // 先同步一次磁盘状态，再开始监听，确保服务启动前已经存在的实例不会被遗漏。
    await this.refresh('startup');

    try {
      // 文件系统事件用于低延迟响应 CLI 写入；事件只作为刷新提示，不依赖具体文件名。
      this.watcher = watch(root, { persistent: false }, () => {
        // 回调不等待 Promise，避免阻塞 Node.js 的 fs 事件分发；`refreshing` 在方法内合并密集事件。
        void this.refresh('watch');
      });
      this.watcher.on('error', err => {
        logger.warn('local worker watch failed', { error: String(err) });
      });
    } catch (err) {
      logger.warn('local worker watch unavailable', { error: String(err) });
    }

    // fs.watch 在部分文件系统或远程目录上可能丢事件，因此轮询作为最终一致性的兜底。
    // 环境变量为 0/NaN/空时回退 5 秒；正数值可用于测试或调整远程文件系统的收敛频率。
    const intervalMs = Number(process.env.LOONGSUITE_LOCAL_WORKER_SCAN_INTERVAL_MS) || DEFAULT_SCAN_INTERVAL_MS;
    this.timer = setInterval(() => void this.refresh('poll'), intervalMs);
    this.timer.unref();
  }

  /**
   * 清 watcher/timer，并停止所有实例进程但不改变 instance.enabled，便于下次启动恢复。
   *
   * `Orchestrator.stop()` 在关闭输入/输出资源前后的生命周期清理中调用。它顺序停止实例，
   * 避免同时发大量进程组信号。单个 `stopInstance()` 将错误转成告警，因此其他实例仍会继续清理。
   *
   * @returns watcher 已关闭、timer 已清理且所有已知实例都完成停止尝试后兑现。
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    // Collector 自身退出时，无论实例 enabled 是否为 true，都要停止由当前服务监管的进程；
    // instance.json 保持不变，下次 Collector 启动会按期望状态重新拉起。
    const instances = await listLocalWorkerInstances(this.dataDir);
    for (const instance of instances) {
      await this.stopInstance(instance);
    }
    this.activeFingerprints.clear();
  }

  /**
   * 用进程内锁把 startup/watch/poll 触发合并为单轮串行 reconcile。
   * @param trigger 仅用于日志标明本轮来源，不改变收敛规则。
   * @returns 本轮快照中的所有实例已串行处理后兑现；已有一轮执行时立即兑现。
   * @remarks 锁不排队中途触发；即使 watch 提示被合并，5 秒 poll 也会再次读取最新状态。
   */
  async refresh(trigger: string): Promise<void> {
    // watch 和 poll 可能同时触发；用轻量锁避免对同一实例并发部署或停止。
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const instances = await listLocalWorkerInstances(this.dataDir);
      // 串行保证包获取、安装脚本与进程组操作不在本服务内并发抢占系统资源。
      for (const instance of instances) {
        await this.reconcile(instance, trigger);
      }
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * 单实例收敛：disabled 停止；缺模板写失败；指纹未变且存活跳过；否则停旧并重新部署。
   * @param instance 本轮从 `instance.json` 读得的期望状态快照。
   * @param trigger 用于记录是 startup/watch/poll 中哪一条路径发现变化。
   * @returns 该实例已停止、已跳过、已部署或已写失败快照后兑现。
   * @remarks 部署失败不写 active fingerprint，因此下一轮 poll 会自动再尝试。
   */
  private async reconcile(instance: LocalWorkerInstance, trigger: string): Promise<void> {
    if (!instance.enabled) {
      // disconnect 写入 enabled=false 后会进入此分支，实际停止动作在这里完成。
      await this.stopInstance(instance);
      this.activeFingerprints.delete(instance.id);
      return;
    }

    // Runtime 必须匹配一个带 pluginProbe 配置的 Agent 模板，否则无法取得 Worker 包。
    const template = this.findTemplate(instance.runtime);
    if (!template?.pluginProbe) {
      await this.writeSupervisorStatus(instance, 'failed', `missing local worker runtime template: ${instance.runtime}`);
      logger.warn('local worker template missing', { instanceId: instance.id, runtime: instance.runtime });
      return;
    }

    // 指纹在活性检查前计算；本地 tarball 内容变化即使文件名不变，也会触发重新部署。
    const fingerprint = await this.fingerprint(instance, template);
    // 配置和 Runtime 包均未变化且进程仍存活时，不做任何磁盘或进程操作。
    if (this.activeFingerprints.get(instance.id) === fingerprint && await this.isInstanceWorkerAlive(template, instance)) return;

    logger.info('reconciling local worker', { instanceId: instance.id, runtime: instance.runtime, trigger });
    // 新建、重连、配置变化、包变化或进程丢失统一走“先停旧实例，再部署并启动”的路径。
    await this.stopInstance(instance);

    // 基于共享模板构造实例隔离的定义，再复用 PluginProbeStrategy 完成包获取和 Worker 启动。
    const def = this.buildDefinition(template, instance);
    const result = await this.strategy.deploy(def, {
      instance: this.buildManifestInstance(instance),
      runtimeOptions: this.buildRuntimeOptions(instance),
    });

    if (!result.success) {
      await this.writeSupervisorStatus(instance, 'failed', result.error ?? 'local worker deploy failed');
      logger.warn('local worker deploy failed', { instanceId: instance.id, error: result.error });
      return;
    }

    this.activeFingerprints.set(instance.id, fingerprint);
  }

  /**
   * 派生实例定义后调用 PluginProbeStrategy 停 Worker。
   * @param instance 提供 Runtime 模板键和 PID 路径展开所需的实例信息。
   * @returns 无可匹配模板时立即兑现；否则等待 Supervisor 停止尝试。
   * @remarks 停止异常在此转成告警，避免一个实例阻断整体退出或扫描。
   */
  private async stopInstance(instance: LocalWorkerInstance): Promise<void> {
    const template = this.findTemplate(instance.runtime);
    if (!template?.pluginProbe) return;

    const def = this.buildDefinition(template, instance);
    await this.strategy.stopWorker(def, {
      instance: this.buildManifestInstance(instance),
      runtimeOptions: this.buildRuntimeOptions(instance),
    }).catch(err => {
      logger.warn('local worker stop failed', { instanceId: instance.id, error: String(err) });
    });
  }

  /**
   * 从启动时声明快照中寻找 Local Worker Runtime 模板。
   * @param runtime `worker connect --runtime` 持久化的值。
   * @returns 首个 deployMode=plugin-probe 且带配置的匹配声明；无匹配时返回 `undefined`。
   * @remarks 优先级由声明数组顺序决定；既支持显式 `localWorkerRuntime`，也兼容旧配置直接使用 Agent id。
   */
  private findTemplate(runtime: string): AgentDefinition | undefined {
    return this.definitions.find(def =>
      def.deployMode === 'plugin-probe'
      && !!def.pluginProbe
      && (
        def.localWorkerRuntime === runtime
        || def.id === runtime
      ),
    );
  }

  /**
   * 为实例派生独立 AgentDefinition。
   * 唯一 id 隔离 Supervisor 状态，独立 bundle 目录避免不同实例更新或卸载时相互覆盖。
   * @param template 不得直接修改的共享声明。
   * @param instance 提供唯一 ID 和实例 bundle 路径。
   * @returns 浅拷贝后的新声明；原 template 及其 pluginProbe/source 对象不会被改写。
   */
  private buildDefinition(template: AgentDefinition, instance: LocalWorkerInstance): AgentDefinition {
    const source = template.pluginProbe!.source;
    return {
      ...template,
      id: `local-worker:${instance.id}`,
      displayName: `${template.displayName} (${instance.id})`,
      pluginProbe: {
        ...template.pluginProbe!,
        source: {
          ...source,
          destDir: bundleDir(this.dataDir, instance.id),
        },
      },
    };
  }

  /**
   * 构造 manifest 中 `${instance:<name>}` 可引用的受信固定字段。
   * @returns id/runtime/workDir/token 文件/stateDir/logDir 的字符串 Map。
   * @remarks Supervisor 让这些值优先于同名 Runtime 参数，防止用户把 Worker 的凭据或状态引向其他实例。
   */
  private buildManifestInstance(instance: LocalWorkerInstance): Record<string, string> {
    return {
      id: instance.id,
      runtime: instance.runtime,
      workDir: instance.workDir,
      bootstrapTokenFile: bootstrapTokenPath(this.dataDir, instance),
      stateDir: stateDir(this.dataDir, instance.id),
      logDir: logDir(this.dataDir, instance.id),
    };
  }

  /**
   * 返回用户保存的 Runtime 参数，供 Supervisor 展开非受信的 manifest 选项。
   * @returns 当前实例的 `runtimeOptions` 引用；调用方当前只读，不应修改。
   */
  private buildRuntimeOptions(instance: LocalWorkerInstance): RuntimeOptions {
    return instance.runtimeOptions;
  }

  /**
   * 计算会影响 Worker 运行结果的配置指纹。
   * 包括 Runtime、工作目录、透传参数、启用状态和本地包内容哈希；任一变化都会触发收敛。
   * @returns 对稳定 JSON 字段集合计算的 SHA-256 十六进制字符串。
   * @remarks 只有本地 tarball 纳入 sourceHash；纯远端源的变化检查由 PluginProbeStrategy 的远端复查机制负责。
   */
  private async fingerprint(instance: LocalWorkerInstance, template: AgentDefinition): Promise<string> {
    const source = template.pluginProbe?.source;
    const sourceHash = source?.tarball
      ? await this.strategy.computeSourceHash(source.tarball, undefined)
      : undefined;
    return crypto.createHash('sha256').update(JSON.stringify({
      runtime: instance.runtime,
      workDir: instance.workDir,
      runtimeOptions: instance.runtimeOptions,
      enabled: instance.enabled,
      sourceHash: sourceHash ?? '',
    })).digest('hex');
  }

  /**
   * 用与启动相同的实例展开参数查询 Supervisor 记录的 PID 活性。
   * @returns PID 文件指向存活进程时为 `true`；本方法不修复残留 PID 或状态快照。
   */
  private async isInstanceWorkerAlive(template: AgentDefinition, instance: LocalWorkerInstance): Promise<boolean> {
    const def = this.buildDefinition(template, instance);
    return this.strategy.isWorkerRunning(def, {
      instance: this.buildManifestInstance(instance),
      runtimeOptions: this.buildRuntimeOptions(instance),
    });
  }

  /**
   * 将收敛失败写入 CLI `worker status/list` 会读取的 Supervisor 快照。
   * @param state 通常为 `failed`，保留为参数以支持其他收敛态。
   * @param error 可展示的模板缺失或部署失败原因。
   * @returns 原子 JSON 写入完成后兑现；写入异常会向本轮 refresh 传播。
   */
  private async writeSupervisorStatus(instance: LocalWorkerInstance, state: string, error: string): Promise<void> {
    const statusPath = path.join(stateDir(this.dataDir, instance.id), 'supervisor-status.json');
    await writeJsonFile(statusPath, {
      state,
      name: instance.runtime,
      agentId: `local-worker:${instance.id}`,
      error,
      updatedAt: new Date().toISOString(),
    });
  }
}
