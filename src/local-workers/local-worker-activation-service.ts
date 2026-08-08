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

  /** 保存目录和声明，并创建复用的 PluginProbeStrategy；不建立 watcher。 */
  constructor(options: LocalWorkerActivationServiceOptions) {
    this.dataDir = options.dataDir;
    this.pilotDir = options.pilotDir;
    this.definitions = options.definitions;
    this.strategy = new PluginProbeStrategy(options.dataDir, options.pilotDir);
  }

  /**
   * 确保实例根目录，先收敛现有实例，再建立非持久化 fs.watch 和 5 秒兜底 interval。
   */
  async start(): Promise<void> {
    const root = localWorkerRoot(this.dataDir);
    await ensureDir(root);
    // 先同步一次磁盘状态，再开始监听，确保服务启动前已经存在的实例不会被遗漏。
    await this.refresh('startup');

    try {
      // 文件系统事件用于低延迟响应 CLI 写入；事件只作为刷新提示，不依赖具体文件名。
      this.watcher = watch(root, { persistent: false }, () => {
        void this.refresh('watch');
      });
      this.watcher.on('error', err => {
        logger.warn('local worker watch failed', { error: String(err) });
      });
    } catch (err) {
      logger.warn('local worker watch unavailable', { error: String(err) });
    }

    // fs.watch 在部分文件系统或远程目录上可能丢事件，因此轮询作为最终一致性的兜底。
    const intervalMs = Number(process.env.LOONGSUITE_LOCAL_WORKER_SCAN_INTERVAL_MS) || DEFAULT_SCAN_INTERVAL_MS;
    this.timer = setInterval(() => void this.refresh('poll'), intervalMs);
    this.timer.unref();
  }

  /**
   * 清 watcher/timer，并停止所有实例进程但不改变 instance.enabled，便于下次启动恢复。
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

  /** 用进程内锁把 watch/poll 合并为单轮串行 reconcile。 */
  async refresh(trigger: string): Promise<void> {
    // watch 和 poll 可能同时触发；用轻量锁避免对同一实例并发部署或停止。
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const instances = await listLocalWorkerInstances(this.dataDir);
      for (const instance of instances) {
        await this.reconcile(instance, trigger);
      }
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * 单实例收敛：disabled 停止；缺模板写失败；指纹未变且存活跳过；否则停旧并重新部署。
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

  /** 派生实例定义后调用 Strategy 停 Worker；停止异常只告警。 */
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

  /** Runtime 优先匹配显式 localWorkerRuntime，同时兼容直接使用 Agent id。 */
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

  /** 提供 manifest 中 `${instance:<name>}` 可引用且不允许 Runtime 参数覆盖的固定字段。 */
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

  /** 返回用户保存的 Runtime 参数；Supervisor 负责具体展开。 */
  private buildRuntimeOptions(instance: LocalWorkerInstance): RuntimeOptions {
    return instance.runtimeOptions;
  }

  /**
   * 计算会影响 Worker 运行结果的配置指纹。
   * 包括 Runtime、工作目录、透传参数、启用状态和本地包内容哈希；任一变化都会触发收敛。
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

  /** 用实例展开参数查询 Supervisor 记录的 PID 活性。 */
  private async isInstanceWorkerAlive(template: AgentDefinition, instance: LocalWorkerInstance): Promise<boolean> {
    const def = this.buildDefinition(template, instance);
    return this.strategy.isWorkerRunning(def, {
      instance: this.buildManifestInstance(instance),
      runtimeOptions: this.buildRuntimeOptions(instance),
    });
  }

  /** 将收敛失败写入 CLI status 会读取的 Supervisor 快照。 */
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
