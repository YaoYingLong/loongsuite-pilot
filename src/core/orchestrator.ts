/**
 * Collector 唯一的顶层业务编排器。
 *
 * `src/index.ts` 创建本类。`start()` 依次准备目录和 checkpoint、构建输出链、部署
 * Agent 能力、注册 Input/发现条目，再启动保留、Watchdog、Pipeline、指标和状态栏
 * 等后台服务。Input 产生的标准事件经 InputManager 进入一个或多个 Flusher。
 * `stop()` 按依赖逆序停止资源、排空 Input Promise 队列、flush/shutdown 输出并保存
 * 状态；SIGINT/SIGTERM 由主入口转交到这里。部署和多数可选后台服务采用 best-effort，
 * 核心目录/状态初始化失败则向上抛出，触发启动崩溃 breadcrumb。
 */



import { EventEmitter } from 'node:events';
import { ClientType } from '../types/index.js';
import type { AnalyticsConfig, AgentDetectionEntry } from '../types/index.js';
import { AgentControlManager } from './agent-control-manager.js';
import { AgentDiscoveryService } from './agent-discovery-service.js';
import { InputManager } from './input-manager.js';
import { StateStore } from '../checkpoints/state-store.js';
import { HookManager } from '../hooks/hook-manager.js';
import { DeploymentManager } from '../deployment/deployment-manager.js';
import { detectAgent } from '../deployment/detect-utils.js';
import { GlobalAttributesProvider } from '../normalization/global-attributes.js';
import { createLogger } from '../utils/logger.js';
import { resolveHome, ensureDir, directoryExists, readJsonFile, writeJsonFile, fileExists, readInstalledVersion, cleanStaleTmpFiles } from '../utils/fs-utils.js';
import * as path from 'node:path';
import * as fsSync from 'node:fs';

// 数据输出器。
import { BaseFlusher } from '../flushers/base-flusher.js';
import { SlsFlusher } from '../flushers/sls-flusher.js';
import { JsonlFlusher } from '../flushers/jsonl-flusher.js';
import { HttpFlusher } from '../flushers/http-flusher.js';
import { MultiFlusher } from '../flushers/multi-flusher.js';
import { buildOtlpTraceConfig } from './config-loader.js';

// 具体 Agent Input 实现。
import { QoderSqliteInput } from '../inputs/qoder-sqlite/qoder-sqlite-input.js';
import { QoderCnSqliteInput } from '../inputs/qoder-cn-sqlite/qoder-cn-sqlite-input.js';
import { QoderCnInput } from '../inputs/qoder-cn/qoder-cn-input.js';
import { QoderCnTraceInput } from '../inputs/qoder-cn-trace/qoder-cn-trace-input.js';
import { QoderWorkInput } from '../inputs/qoder-work/qoder-work-input.js';
import { QoderWorkLogInput, resolveQoderWorkRoot } from '../inputs/qoder-work-log/qoder-work-log-input.js';
import { QoderWorkTraceInput as QoderWorkCNTraceInput } from '../inputs/qoder-work-log/qoder-work-trace-input.js';
import { QoderWorkSqliteInput } from '../inputs/qoder-work-sqlite/qoder-work-sqlite-input.js';
import { QoderWorkTraceInput } from '../inputs/qoder-work-trace/qoder-work-trace-input.js';
import { QoderCliInput } from '../inputs/qoder-cli/qoder-cli-input.js';
import { QoderCliSessionInput } from '../inputs/qoder-cli-session/qoder-cli-session-input.js';
import { QoderTraceInput } from '../inputs/qoder-trace/qoder-trace-input.js';
import { CursorHookInput } from '../inputs/cursor-hook/cursor-hook-input.js';
import { ClaudeCodeLogInput } from '../inputs/claude-code-log/claude-code-log-input.js';
import { CodexTranscriptInput } from '../inputs/codex-transcript/codex-transcript-input.js';
import { KiroCliLogInput } from '../inputs/kiro-cli-log/kiro-cli-log-input.js';
import { KiroCliSessionInput } from '../inputs/kiro-cli-session/kiro-cli-session-input.js';
import { OpenCodeLogInput } from '../inputs/opencode-log/opencode-log-input.js';
import { PiCodingAgentLogInput, ensurePiCodingAgentLogDir } from '../inputs/pi-coding-agent-log/pi-coding-agent-log-input.js';
import { QwenCodeCliLogInput } from '../inputs/qwen-code-cli-log/qwen-code-cli-log-input.js';
import { WukongInput } from '../inputs/wukong/wukong-input.js';

import { LogRetentionService } from './log-retention-service.js';
import { CorrelationStore } from './upstream-link/correlation-store.js';
import { TraceLinker } from './upstream-link/trace-linker.js';
import { AcpCorrelateRetentionService } from './upstream-link/acp-correlate-retention-service.js';
import { LegacySlsFailedLogCleanupService } from './legacy-sls-failed-log-cleanup-service.js';
import { HookWatchdog, type PluginCheckTarget, type InterceptCheckTarget } from './hook-watchdog.js';
import { UpdaterWatchdog } from './updater-watchdog.js';
import { PipelineManager } from '../pipeline/pipeline-manager.js';
import { MetricsWriter } from '../metrics/metrics-writer.js';
import { AlarmManager } from '../metrics/alarm-manager.js';
import { LocalWorkerActivationService } from '../local-workers/local-worker-activation-service.js';
import type { DataflowSnapshot } from '../metrics/metrics-collector.js';
import { RuntimeWriter, MetricsSummaryWriter, StatusBarAppManager } from '../status-bar/index.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { resolveLocalIp } from '../utils/network-utils.js';

const logger = createLogger('Orchestrator');

const DEFAULT_DATA_DIR = '~/.loongsuite-pilot';

/**
 * 连接全部子系统的中央编排器。
 *
 * 当前启动主线：目录/checkpoint -> 输出链 -> InputManager/上游关联 ->
 * DeploymentManager -> LocalWorker -> Input 注册 -> 动态发现 -> 保留/Watchdog/Pipeline/
 * Metrics/状态栏 -> started。Hook 部署由 DeploymentManager 完成，下面保留的
 * `installHooks()` 是未被 start() 调用的历史兼容代码，不能用于推导当前生产行为。
 *
 * 继承 EventEmitter 后，外部可监听 starting/started/stopped，内部发现服务也通过事件
 * 报告 Input 生命周期；事件回调仍运行在同一个 Node.js 事件循环中，不是新线程。
 */
export class Orchestrator extends EventEmitter {
  /**
   * listener ID 到产品级 Agent ID 的映射。一个产品可注册多个采集实现，但都必须先通过
   * `config.agents.<agentId>.enabled` 总门禁，再检查各 listener 和 agent-control 三态开关。
   */
  private static readonly LISTENER_AGENT_MAP: Record<string, string> = {
    'qoder-sqlite': 'qoder',
    'qoder-trace': 'qoder',
    'qoder-cn-trace': 'qoder-cn',
    'qoder-cn-sqlite': 'qoder-cn',
    'qoder-cn': 'qoder-cn',
    'qoder-work': 'qoder-work',
    'qoder-work-trace': 'qoder-work',
    'qoder-work-log': 'qoder-work',
    'qoder-work-sqlite': 'qoder-work',
    'qoder-work-cn-trace': 'qoder-work-cn',
    'qoder-work-cn-hook': 'qoder-work-cn',
    'qoder-work-cn-log': 'qoder-work-cn',
    'qoder-work-cn-sqlite': 'qoder-work-cn',
    'qoder-cli-hook': 'qoder',
    'qoder-cli-session': 'qoder',
    'cursor-hook': 'cursor',
    'claude-code-log': 'claude-code',
    'codex-transcript': 'codex',
    'kiro-cli-log': 'kiro-cli',
    'kiro-cli-session': 'kiro-cli',
    'opencode-log': 'opencode',
    'pi-coding-agent-log': 'pi-coding-agent',
    'qwen-code-cli-log': 'qwen-code-cli',
    'wukong': 'wukong',
  };

  /** ConfigLoader 已完成默认值、环境变量和兼容字段归一化的只读配置。 */
  private readonly config: AnalyticsConfig;
  /** 展开 `~` 后的持久化根目录，所有子模块都从这里派生日志和状态路径。 */
  private readonly dataDir: string;
  // 带 `!` 的成员在 start() 的固定阶段创建；TypeScript 的 definite-assignment 断言只消除
  // 编译器提示，并不提供运行时保护，所以对应 getter 只能在 start() 成功后调用。
  /** 运行时 on/off/auto 准入状态。 */
  private agentControlManager!: AgentControlManager;
  /** 负责按文件系统可用性启停 Input 与动态部署条目。 */
  private agentDiscoveryService!: AgentDiscoveryService;
  /** Input 注册、逐源 Promise 队列和统一数据处理入口。 */
  private inputManager!: InputManager;
  /** 各 Input 共享的 offset/checkpoint 持久化仓库。 */
  private stateStore!: StateStore;
  /** 唯一输出入口；可能是单 Flusher，也可能是 MultiFlusher。 */
  private flusher!: BaseFlusher;
  /** 常规 output、失败日志和诊断日志的周期保留服务。 */
  private logRetentionService!: LogRetentionService;
  /** 仅 upstreamLink 开启时存在，负责关联文件及 TraceLinker 内存状态淘汰。 */
  private acpCorrelateRetentionService?: AcpCorrelateRetentionService;
  /** 启动完成后异步渐进删除旧版 SLS 失败目录；null 表示未创建或已停止。 */
  private legacySlsFailedLogCleanupService: LegacySlsFailedLogCleanupService | null = null;
  /** Hook/插件配置周期自愈服务。 */
  private hookWatchdog!: HookWatchdog;
  /** 只有 autoUpdate.enabled 时创建的独立 Updater 进程健康检查器。 */
  private updaterWatchdog: UpdaterWatchdog | null = null;
  /** agents.d 声明加载、初次部署、单 Agent 修复与 Worker 进程管理入口。 */
  private deploymentManager!: DeploymentManager;
  /** 可选本地 Worker 包激活服务。 */
  private localWorkerActivationService: LocalWorkerActivationService | null = null;
  /** 与 Agent Input 链独立的文件/Qoder API Pipeline；配置关闭时保持 null。 */
  private pipelineManager: PipelineManager | null = null;
  /** 周期采集运行状态、写指标 JSONL 并触发告警。 */
  private metricsWriter!: MetricsWriter;
  /** 多模块共享的进程内告警聚合器。 */
  private alarmManager!: AlarmManager;
  // 以下三个成员只在 statusBar.enabled 时创建，其中原生 App 又仅限 macOS。
  private runtimeWriter: RuntimeWriter | null = null;
  private metricsSummaryWriter: MetricsSummaryWriter | null = null;
  private statusBarAppManager: StatusBarAppManager | null = null;
  /** 合并静态配置与动态文件的 OTLP Resource/Span 公共属性。 */
  private globalAttributesProvider!: GlobalAttributesProvider;
  /** start() 全部关键阶段完成后才置 true，stop() 以它作为生命周期门禁。 */
  private isRunning = false;

  /** @param config ConfigLoader 已归一化的完整配置；构造阶段只解析 dataDir。 */
  constructor(config: AnalyticsConfig) {
    super();
    this.config = config;
    // 构造阶段不创建目录、timer 或子进程，方便调用方先注册事件监听器再启动。
    this.dataDir = resolveHome(config.dataDir || DEFAULT_DATA_DIR);
  }

  /**
   * 按依赖顺序启动 Collector 全部子系统。重复调用只记录警告。
   *
   * 必需目录、StateStore 或核心初始化异常会向主入口传播并写 startup breadcrumb；
   * Agent 部署、单输出器和 macOS 状态栏等可选能力在各自边界内 best-effort。
   * 本方法不是事务：若中途抛错，isRunning 尚未置 true，主入口会记录 breadcrumb 并退出进程；
   * 当前 stop() 不负责回滚半初始化资源，这是服务进程启动失败即退出模型的一部分。
   *
   * @throws 目录/状态、部署管理器、Input 注册或其他未在子模块隔离的启动错误。
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('already running');
      return;
    }

    logger.info('starting orchestrator');
    // emit 同步调用监听器；监听器异常会直接中断 start()，外部监听器不应在此抛错。
    this.emit('starting');

    // 1. 准备数据目录。ensureDir 使用递归创建，目录已存在时保持幂等。
    await ensureDir(this.dataDir);
    await ensureDir(path.join(this.dataDir, 'logs'));
    // 删除 logs 根目录下超过 60 秒的原子写临时文件，避免异常退出留下的 `.tmp` 持续堆积。
    await cleanStaleTmpFiles(path.join(this.dataDir, 'logs'));

    // 2. 恢复 Input checkpoint 与 Agent 准入配置。必须先 load，再构造具体 Input，确保它们
    // 首次 collect 时能从上次 offset 继续，而不是把历史文件全部重放。
    this.stateStore = new StateStore(path.join(this.dataDir, 'logs', 'input-state.json'));
    await this.stateStore.load();

    this.agentControlManager = new AgentControlManager(
      path.join(this.dataDir, 'agent-control.json'),
    );
    await this.agentControlManager.load();

    // 3. 构建输出通道。全局 Span 属性只交给 OTLP Trace，日志类输出不会注入这些字段。
    this.globalAttributesProvider = new GlobalAttributesProvider(
      this.config.globalSpanAttributes ?? {},
      path.join(this.dataDir, 'span-attributes.json'),
    );
    // buildFlusher 会逐个容错，并保证至少返回一个本地 JSONL 出口。
    this.flusher = await this.buildFlusher();

    // 4. 构建 InputManager 与告警模块。ConfigLoader 已把多来源配置整理完毕，
    // InputManager 在所有 Agent 数据分发前统一执行 userId 注入、内容策略和敏感信息脱敏。
    // 版本和本机 IP 只用于指标/告警标签，不参与事件内容转换。
    const version = readInstalledVersion(this.dataDir);
    this.alarmManager = new AlarmManager({ ip: resolveLocalIp(), version, userId: this.config.userId });

    this.inputManager = new InputManager();
    this.inputManager.setFlusher(this.flusher);
    this.inputManager.setConfiguredUserId(this.config.userId);
    this.inputManager.setAgentsConfig(this.config.agents);
    this.inputManager.setAlarmManager(this.alarmManager);
    this.inputManager.setMaskConfig(this.config.mask ?? { mode: 'none', types: [] });

    // 可选的上游 Trace 关联：从 acp-correlate 读取 trace_id/parent_span_id，
    // 让本项目采集的 Agent Span 能挂到调用方的上游 Span 下。
    if (this.config.upstreamLink?.enabled) {
      const correlateDir = path.join(this.dataDir, 'acp-correlate');
      await ensureDir(correlateDir);
      const store = new CorrelationStore(correlateDir);
      const traceLinker = new TraceLinker(store);
      this.inputManager.setTraceLinker(traceLinker);
      this.acpCorrelateRetentionService = new AcpCorrelateRetentionService(this.dataDir, this.config.upstreamLink, traceLinker);
      this.acpCorrelateRetentionService.start();
      // Adapter/环境 Hook 必须写入同一个目录。若自定义 dataDir 与写入端不一致，关联会
      // 无报错地失效，因此日志中明确输出最终目录方便诊断。
      logger.info('upstream trace linking enabled', { correlateDir, ttlMs: this.config.upstreamLink.ttlMs });
    }

    // 5. 部署 Hook、插件及 Worker 包。pilotDir 指向当前安装版本，dataDir 是可写状态根；
    // 两者在多版本布局中不能混用。
    const pilotDir = this.resolvePilotDir();
    this.deploymentManager = new DeploymentManager({
      dataDir: this.dataDir,
      pilotDir,
    });
    await this.deploymentManager.deployAll();

    // Worker 激活依赖部署声明，因此必须在 DeploymentManager 加载 definitions 后创建。
    this.localWorkerActivationService = new LocalWorkerActivationService({
      dataDir: this.dataDir,
      pilotDir,
      definitions: this.deploymentManager.getDefinitions(),
    });
    await this.localWorkerActivationService.start();

    // 6. 注册具体 Input 并构造发现条目。
    // 此阶段创建实例并绑定 entries 处理链，但不直接启动采集；Discovery 会根据路径、配置和准入
    // 状态调用各 Input 的 start()/stop()，从而避免未安装或被禁用的 Agent 占用资源。
    const detectionEntries = await this.registerAllInputs();

    // 7. 为运行期新安装的 Agent 构造动态部署条目。
    const deployDetectionEntries = this.buildDeployDetectionEntries();

    // 8. 启动 Input 与部署条目共用的 AgentDiscoveryService。事件监听器是诊断/告警旁路，
    // 真正的数据批次仍由 Input -> InputManager 的 `entries` 事件流动。
    this.agentDiscoveryService = new AgentDiscoveryService([...detectionEntries, ...deployDetectionEntries]);
    this.agentDiscoveryService.on('agent:started', (id: string) => {
      logger.info('agent detected and started', { id });
    });
    this.agentDiscoveryService.on('agent:stopped', (id: string) => {
      logger.info('agent stopped', { id });
      // 可用路径消失、门禁关闭或 stop 回调完成都会触发 stopped；当前告警文案统一按异常停止
      // 记录，无法从事件参数进一步区分原因（待确认）。
      this.alarmManager.record(
        'INPUT_STOP_ALARM', '3',
        `input ${id} stopped unexpectedly`,
        { input_name: id },
      );
    });
    await this.agentDiscoveryService.start();

    // 9. 启动本地日志保留服务。
    this.logRetentionService = new LogRetentionService(this.dataDir, this.config.retention);
    this.logRetentionService.start();

    // 10. 启动 Hook Watchdog，周期恢复被其他工具覆盖的配置。
    const hookWatchdogTargets = [
      ...HookWatchdog.defaultTargets(),
      ...this.buildHookWatchdogTargets(),
    ];
    const interceptTargets = [
      ...HookWatchdog.defaultInterceptTargets(this.dataDir, (id) => this.isAgentGatedEnabled(id)),
      ...this.buildPluginInjectInterceptTargets(),
    ];
    this.hookWatchdog = new HookWatchdog(this.config.hookWatchdog, hookWatchdogTargets, interceptTargets);
    this.hookWatchdog.start();

    // 11. 仅在最终自动更新配置启用时启动 Updater Watchdog。
    if (this.config.autoUpdate?.enabled) {
      this.updaterWatchdog = new UpdaterWatchdog({
        enabled: true,
        dataDir: this.dataDir,
        alarmManager: this.alarmManager,
      });
      this.updaterWatchdog.start();
    }

    // 12. 按配置启动独立 Pipeline 子系统，默认关闭。
    if (this.config.pipeline.enabled) {
      this.pipelineManager = new PipelineManager({
        configDir: path.join(this.dataDir, 'configs', 'local'),
        stateDir: path.join(this.dataDir, 'state', 'pipeline'),
        failedLogDir: path.join(this.dataDir, 'logs', 'pipeline-failed'),
        dataDir: this.dataDir,
        pipelineConfig: this.config.pipeline,
      });
      await this.pipelineManager.start();
    } else {
      logger.info('pipeline subsystem disabled, skipping');
    }

    // 13. 启动 MetricsWriter：周期快照、告警、本地 JSONL 与可选远端 sender。
    const slsFlusher = this.getSlsFlusher();
    if (slsFlusher) slsFlusher.setAlarmManager(this.alarmManager);
    this.metricsWriter = new MetricsWriter({
      dataDir: this.dataDir,
      version,
      userId: this.config.userId,
      canaryPolicy: this.config.autoUpdate?.canaryPolicy ?? '',
      getSnapshot: () => this.buildDataflowSnapshot(),
      alarmManager: this.alarmManager,
      agentsConfig: this.config.agents,
      slsEndpoints: this.config.flushers.sls?.endpoints ?? [],
      cmsWorkspace: this.config.cms?.workspace ?? '',
    });
    await this.metricsWriter.start();

    // 14. 启动 runtime.json、指标摘要和可选 macOS 原生状态栏 App。两个 Writer 只落盘；
    // 原生 App 读取这些快照展示，不直接持有 Orchestrator 内部对象。
    if (this.config.statusBar.enabled) {
      const packageVersion = this.readPackageVersion();

      this.runtimeWriter = new RuntimeWriter(this.dataDir, this.config.statusBar, packageVersion);
      this.runtimeWriter.start();

      this.metricsSummaryWriter = new MetricsSummaryWriter(this.dataDir, this.config.statusBar);
      this.metricsSummaryWriter.start();

      if (process.platform === 'darwin') {
        this.statusBarAppManager = new StatusBarAppManager({ dataDir: this.dataDir, packageVersion });
        // 状态栏是可选 UI；启动失败在此转换为已兑现 Promise，不能阻断 Collector 数据链。
        await this.statusBarAppManager.syncDesiredState(true).catch(err => {
          logger.warn('status bar app start failed (non-fatal)', { error: String(err) });
        });
      }
    }

    this.isRunning = true;
    // 只有所有关键启动 await 完成后才对外发布 started；emit 仍是同步调用。
    this.emit('started');
    logger.info('orchestrator started', {
      inputs: detectionEntries.length,
    });

    // 兼容清理由延迟 timer 渐进执行，放在 started 之后避免延长服务就绪时间。
    this.legacySlsFailedLogCleanupService = new LegacySlsFailedLogCleanupService(this.dataDir);
    this.legacySlsFailedLogCleanupService.start();
  }

  /**
   * 按依赖大致逆序停止后台服务、Worker、发现器和 Input，随后 shutdown Flusher 并保存
   * checkpoint。InputManager.stopAll() 会排空已发事件队列，因此输出器最后关闭。
   * 重复调用在 isRunning=false 时直接返回。
   *
   * @throws 子模块 stop/shutdown/save 的异常会向信号处理闭包传播；当前实现不会在每一步
   * 单独 catch，因此某一步失败会中止后续清理（待确认是否符合预期）。
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;
    logger.info('stopping orchestrator');

    // 先停止独立生产者和监控/UI，防止关闭数据主链时继续产生事件或读取半更新快照。
    await this.pipelineManager?.stop();
    await this.metricsWriter?.stop();
    await this.statusBarAppManager?.stop('orchestrator-shutdown').catch(() => {});
    this.metricsSummaryWriter?.stop();
    this.runtimeWriter?.stop();
    this.updaterWatchdog?.stop();
    this.updaterWatchdog = null;
    this.hookWatchdog?.stop();
    this.legacySlsFailedLogCleanupService?.stop();
    this.legacySlsFailedLogCleanupService = null;
    this.logRetentionService?.stop();
    this.acpCorrelateRetentionService?.stop();
    // Worker、发现器和 Input 都可能产生新事件，必须在关闭 Flusher 前全部停止。
    await this.localWorkerActivationService?.stop();
    await this.deploymentManager?.stopWorkers();
    await this.agentDiscoveryService?.stop();
    // Discovery.stop() 停止各发现条目；stopAll() 再兜底停止所有 Input 并排空 Promise 队列。
    await this.inputManager?.stopAll();
    // 此时没有新的批次进入，shutdown 才能安全 flush 缓冲并释放网络/文件资源。
    await this.flusher?.shutdown();
    // Input 通常在采集过程中也会更新状态；最终 save 固化最后 offset，供下次启动恢复。
    await this.stateStore?.save();

    this.isRunning = false;
    this.emit('stopped');
    logger.info('orchestrator stopped');
  }

  /** 返回启动后创建的 InputManager；start 前调用属于无效生命周期。 */
  getInputManager(): InputManager {
    return this.inputManager;
  }

  /** 返回 Agent 准入管理器。 */
  getAgentControlManager(): AgentControlManager {
    return this.agentControlManager;
  }

  /** 返回动态发现服务。 */
  getAgentDiscoveryService(): AgentDiscoveryService {
    return this.agentDiscoveryService;
  }

  /** 返回声明式部署管理器。 */
  getDeploymentManager(): DeploymentManager {
    return this.deploymentManager;
  }

  /**
   * 设置异步解析得到的回退 user id；显式配置 userId 仍由 InputManager 优先使用。
   */
  setUserId(userId: string): void {
    this.inputManager?.setUserId(userId);
  }

  /**
   * 为 Agent 声明构造 deploy:<id> 动态发现条目。路径出现且准入允许时调用 deploySingle，
   * 路径消失不卸载已有配置。
   */
  private buildDeployDetectionEntries(): AgentDetectionEntry[] {
    const defs = this.deploymentManager.getDefinitions();
    const entries: AgentDetectionEntry[] = [];

    for (const def of defs) {
      // 声明路径允许 `~`；其他绝对或相对写法保持原样交给检测工具处理。
      const watchPaths = def.detection.paths.map(p =>
        p.startsWith('~') ? resolveHome(p) : p,
      );
      if (watchPaths.length === 0) continue;

      const entryId = `deploy:${def.id}`;
      entries.push({
        id: entryId,
        type: 'deploy-detection',
        watchPaths,
        isAvailable: () => detectAgent(def.detection),
        enabled: () => this.isAgentGatedEnabled(def.id),
        start: async () => {
          logger.info('new agent discovered, deploying', { agentId: def.id });
          await this.deploymentManager.deploySingle(def);
        },
        // Agent 消失时不回滚已写配置，避免删除用户仍可能需要的 Hook；因此 stop 是显式空操作。
        stop: async () => {},
        pollIntervalMs: 300_000,
      });
    }

    return entries;
  }

  /** 把当前 hook 声明转换为 Watchdog marker 目标，修复动作复用 deploySingle。 */
  private buildHookWatchdogTargets(): PluginCheckTarget[] {
    const defs = this.deploymentManager.getDefinitions();
    const targets: PluginCheckTarget[] = [];

    for (const def of defs) {
      if (def.deployMode !== 'hook' || !def.hook) continue;

      // Watchdog 不解析完整 shell 命令，只取首个命令 token 的文件名作为本项目 marker。
      const scriptName = path.basename(def.hook.hookCommand.split(' ')[0]);
      targets.push({
        agentId: def.id,
        settingsPath: def.hook.settingsPath,
        expectedHooks: def.hook.events,
        markers: [scriptName],
        repairFn: () => this.deploymentManager.deploySingle(def).then(r => r.success),
      });
    }

    return targets;
  }

  /**
   * 为 plugin-inject Agent 构造自愈目标，例如 OpenCode、Qwen Code CLI。
   *
   * 它们把 spec 写入各自配置而非共享 Hook 数组，因此使用任意 check/repair 的 intercept
   * 机制，并复用冷却和每日上限，限制可能移除 JSONC 注释的配置重写次数。
   */
  private buildPluginInjectInterceptTargets(): InterceptCheckTarget[] {
    const defs = this.deploymentManager.getDefinitions();
    const targets: InterceptCheckTarget[] = [];

    for (const def of defs) {
      if (def.deployMode !== 'plugin-inject' || !def.pluginInject) continue;

      const pluginFile = this.resolvePluginSpecPath(def.pluginInject.pluginSpec);

      targets.push({
        id: `plugin-inject:${def.id}`,
        enabled: () => this.isAgentGatedEnabled(def.id),
        precondition: async () => {
          // 仅在插件资产存在且 Agent 已安装时自愈，避免写入悬空 spec 或持续失败。
          if (pluginFile && !(await fileExists(pluginFile))) return false;
          return detectAgent(def.detection);
        },
        check: async () => {
          // needsRedeploy=false 表示配置中的 spec 仍然健康。
          return !(await this.deploymentManager.needsRedeploy(def));
        },
        repair: async () => {
          const result = await this.deploymentManager.deploySingle(def);
          if (!result.success) {
            throw new Error(result.error ?? `re-inject failed for ${def.id}`);
          }
        },
      });
    }

    return targets;
  }

  /**
   * 将 file:// 或绝对 plugin spec 解析为本地路径。npm 包名等返回 null，从而跳过文件
   * 存在性前置门控。
   */
  private resolvePluginSpecPath(spec: string): string | null {
    // agents.d 中的 `$PILOT_DATA` 是部署时路径占位符，不是 shell 环境变量展开。
    const resolved = spec.replace(/\$PILOT_DATA/g, this.dataDir);
    if (resolved.startsWith('file://')) return resolved.slice('file://'.length);
    return path.isAbsolute(resolved) ? resolved : null;
  }

  /**
   * 按配置创建并启动 SLS、JSONL、HTTP、OTLP Trace 输出。每个可选输出启动失败只告警；
   * 没有任何可用输出时强制创建 JSONL fallback。单个结果直接返回，多结果包装为
   * MultiFlusher。
   */
  private async buildFlusher(): Promise<BaseFlusher> {
    // 数组顺序即 MultiFlusher 的扇出顺序，也决定状态/日志中展示的通道顺序。
    const flushers: BaseFlusher[] = [];
    const cfg = this.config.flushers;

    // collectLog 当前是 SLS 日志采集总开关；JSONL 和 HTTP 仍分别服从自身 enabled。
    // 这样可以关闭远端日志上报，同时保留本地审计文件或自定义 HTTP 出口。
    if (cfg.sls?.enabled && this.config.collectLog !== false) {
      const r = new SlsFlusher(cfg.sls, this.dataDir);
      // start 失败被降级为警告，但实例仍加入列表；发送阶段会按 Flusher 自身失败策略处理。
      await r.start().catch(err => logger.warn('sls flusher start failed', { error: String(err) }));
      flushers.push(r);
    }

    if (cfg.jsonl?.enabled) {
      const r = new JsonlFlusher(cfg.jsonl);
      // JsonlFlusher.start() 创建输出目录并准备当前日期文件；不在构造函数执行文件 I/O。
      await r.start().catch(err => logger.warn('jsonl flusher start failed', { error: String(err) }));
      flushers.push(r);
    }

    if (cfg.http?.enabled) {
      const r = new HttpFlusher(cfg.http);
      await r.start().catch(err => logger.warn('http flusher start failed', { error: String(err) }));
      flushers.push(r);
    }

    try {
      // Trace 与日志通道相互独立：collectTrace=false 只会让此构建函数返回 undefined。
      const otlpTraceCfg = buildOtlpTraceConfig(this.config);
      if (otlpTraceCfg?.enabled && otlpTraceCfg.endpoints.length > 0) {
        // 动态导入让未启用 Trace 的日志采集进程无需加载 OpenTelemetry SDK 及其依赖。
        const { OtlpTraceFlusher } = await import('../flushers/otlp-trace-flusher.js');
        const r = new OtlpTraceFlusher(
          { ...otlpTraceCfg, dataDir: this.dataDir },
          this.globalAttributesProvider,
        );
        flushers.push(r);
      }
    } catch (err) {
      // Trace 配置格式错误不能拖垮已经可用的 SLS/JSONL/HTTP 输出。
      logger.warn('OtlpTraceFlusher unavailable, skipping', { error: String(err) });
    }

    if (flushers.length === 0) {
      // Collector 必须至少保留一个数据出口。用户关闭或漏配所有通道时，回退到默认 JSONL，
      // 避免采集流程看似正常运行却把数据静默丢弃。
      logger.warn('no flushers enabled, using JSONL fallback');
      const fallback = new JsonlFlusher({
        enabled: true,
        outputDir: path.join(this.dataDir, 'logs', 'output'),
        rotateDaily: true,
        maxFileSizeMb: 100,
      });
      await fallback.start().catch(err => logger.warn('jsonl fallback flusher start failed', { error: String(err) }));
      flushers.push(fallback);
    }

    // 单通道直接返回可少一层分发；两种返回值都遵循 BaseFlusher 契约，InputManager 无感知。
    return flushers.length === 1 ? flushers[0] : new MultiFlusher(flushers);
  }

  /**
   * 历史 Hook 安装实现：检测 Cursor/Qoder 后直接用 HookManager 写配置。
   *
   * 当前 `start()` 不调用本方法；生产主链已迁移到 `DeploymentManager.deployAll()`。
   * 保留它仅为兼容和历史阅读，新增 Agent 不应接入这里。
   */
  private async installHooks(): Promise<void> {
    const hookManager = new HookManager(
      path.join(this.dataDir, 'hooks'),
      path.join(this.dataDir, 'logs'),
    );

    // 历史 Cursor Hook 分支。
    const cursorDir = resolveHome('~/.cursor');
    if (await directoryExists(cursorDir)) {
      const cursorHooksPath = resolveHome('~/.cursor/hooks.json');
      const existing = await readJsonFile<Record<string, unknown>>(cursorHooksPath);
      if (!existing) {
        await writeJsonFile(cursorHooksPath, { version: 1, hooks: {} });
      } else if (existing.version === undefined) {
        existing.version = 1;
        await writeJsonFile(cursorHooksPath, existing);
      }

      const defs = HookManager.buildCursorHooks(this.dataDir);
      for (const def of defs) {
        const installed = await hookManager.isHookInstalled(def);
        if (!installed) {
          const ok = await hookManager.installHook(def);
          if (ok) {
            const event = def.hookJsonPath[def.hookJsonPath.length - 1];
            logger.info('cursor hook registered', { event });
          } else {
            this.alarmManager.record('HOOK_INSTALL_ALARM', '2',
              `cursor hook install failed: ${def.hookJsonPath.join('.')}`,
              { input_name: 'cursor-hook' });
          }
        }
      }
    }

    // 历史 Qoder CLI Hook 分支。
    const qoderCliAvailable = await QoderCliInput.checkAvailability();
    if (qoderCliAvailable) {
      const defs = HookManager.buildQoderCliHooks(this.dataDir);
      for (const def of defs) {
        const installed = await hookManager.isHookInstalled(def);
        if (!installed) {
          const ok = await hookManager.installHook(def);
          if (ok) {
            const event = def.hookJsonPath[def.hookJsonPath.length - 1];
            logger.info('qoder-cli hook registered', { event });
          } else {
            this.alarmManager.record('HOOK_INSTALL_ALARM', '2',
              `qoder-cli hook install failed: ${def.hookJsonPath.join('.')}`,
              { input_name: 'qoder-cli-hook' });
          }
        }
      }
    }

    const qoderWorkAvailable = await QoderWorkInput.checkAvailability();
    if (qoderWorkAvailable) {
      const defs = HookManager.buildQoderWorkHooks(this.dataDir);
      for (const def of defs) {
        const installed = await hookManager.isHookInstalled(def);
        if (!installed) {
          const ok = await hookManager.installHook(def);
          if (ok) {
            const event = def.hookJsonPath[def.hookJsonPath.length - 1];
            logger.info('qoder-work hook registered', { event });
          } else {
            this.alarmManager.record('HOOK_INSTALL_ALARM', '2',
              `qoder-work hook install failed: ${def.hookJsonPath.join('.')}`,
              { input_name: 'qoder-work' });
          }
        }
      }
    }

    const qoderWorkCNAvailable = await directoryExists(resolveHome('~/.qoderworkcn'));
    if (qoderWorkCNAvailable) {
      const defs = HookManager.buildQoderWorkCNHooks(this.dataDir);
      for (const def of defs) {
        const installed = await hookManager.isHookInstalled(def);
        if (!installed) {
          const ok = await hookManager.installHook(def);
          if (ok) {
            const event = def.hookJsonPath[def.hookJsonPath.length - 1];
            logger.info('qoder-work-cn hook registered', { event });
          } else {
            this.alarmManager.record('HOOK_INSTALL_ALARM', '2',
              `qoder-work-cn hook install failed: ${def.hookJsonPath.join('.')}`,
              { input_name: 'qoder-work-cn' });
          }
        }
      }
    }
  }

  /**
   * 注册所有内置 Input，并返回 AgentDiscoveryService 使用的发现条目。
   *
   * ConfigLoader 中的 listeners 控制具体采集实现；agents 控制产品级总门禁；
   * agent-control.json 再提供 on/off/auto 运行时准入。三层共同决定 Input 是否启动。
   * 接入新 Agent 时需要创建 Input 类并在这里注册。
   */
  private async registerAllInputs(): Promise<AgentDetectionEntry[]> {
    // `entries` 只描述发现生命周期；Input 实例本身同时注册到 InputManager 监听数据事件。
    const entries: AgentDetectionEntry[] = [];
    const listenerCfg = this.config.listeners;

    // Qoder Trace 的互斥闭包，供下面 SQLite/Hook/Session 门控复用。每次发现刷新时重新读取
    // 当前内存配置/准入状态，而不是在注册阶段固化一个布尔值。
    const qoderTraceEnabled = () =>
      this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-trace']) &&
      this.agentControlManager.resolveEnabled(
        'qoder-trace',
        listenerCfg['qoder-trace']?.enabled ?? true,
      );

    // Qoder SQLite token 轮询：Trace 关闭时的回退。
    const qoderSqliteInput = new QoderSqliteInput({ stateStore: this.stateStore });
    this.inputManager.registerInput(qoderSqliteInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderSqliteInput, {
        watchPaths: QoderSqliteInput.getWatchPaths(),
        isAvailable: QoderSqliteInput.checkAvailability,
        enabled: () => !qoderTraceEnabled() &&
          this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-sqlite']) &&
          this.agentControlManager.resolveEnabled(
            'qoder-sqlite',
            listenerCfg['qoder-sqlite']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['qoder-sqlite']?.pollInterval,
      }),
    );

    // Qoder Work Trace：国际版多源合并 Input；启用后取代对应 Hook/Log/SQLite 来源。
    const qoderWorkTraceInput = new QoderWorkTraceInput({
      stateStore: this.stateStore,
      logDir: path.join(this.dataDir, 'logs', 'qoder-work', 'history'),
    });
    this.inputManager.registerInput(qoderWorkTraceInput);
    // 该闭包同时提供给 Trace 自身及与它互斥的回退 Input，保证一次判断使用同一门禁规则。
    const qoderWorkTraceEnabled = () => this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-work-trace']) &&
      this.agentControlManager.resolveEnabled(
        'qoder-work-trace',
        listenerCfg['qoder-work-trace']?.enabled ?? true,
      );
    entries.push(
      this.inputManager.buildDetectionEntry(qoderWorkTraceInput, {
        watchPaths: QoderWorkTraceInput.getWatchPaths(),
        isAvailable: QoderWorkTraceInput.checkAvailability,
        enabled: qoderWorkTraceEnabled,
        pollIntervalMs: listenerCfg['qoder-work-trace']?.pollInterval,
      }),
    );

    // Qoder CN Trace 互斥闭包。
    const qoderCnTraceEnabled = () =>
      this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-cn-trace']) &&
      this.agentControlManager.resolveEnabled(
        'qoder-cn-trace',
        listenerCfg['qoder-cn-trace']?.enabled ?? true,
      );

    // Qoder CN SQLite token 轮询：Trace 关闭时回退。
    const qoderCnSqliteInput = new QoderCnSqliteInput({ stateStore: this.stateStore });
    this.inputManager.registerInput(qoderCnSqliteInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderCnSqliteInput, {
        watchPaths: QoderCnSqliteInput.getWatchPaths(),
        isAvailable: QoderCnSqliteInput.checkAvailability,
        enabled: () => !qoderCnTraceEnabled() &&
          this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-cn-sqlite']) &&
          this.agentControlManager.resolveEnabled(
            'qoder-cn-sqlite',
            listenerCfg['qoder-cn-sqlite']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['qoder-cn-sqlite']?.pollInterval,
      }),
    );

    // Qoder CN IDE 快照（文件历史 + ai_tracker）；qoder-cn-trace 启用时关闭。
    const qoderCnInput = new QoderCnInput({ stateStore: this.stateStore });
    this.inputManager.registerInput(qoderCnInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderCnInput, {
        watchPaths: QoderCnInput.getWatchPaths(),
        isAvailable: QoderCnInput.checkAvailability,
        enabled: () => !qoderCnTraceEnabled() &&
          this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-cn']) &&
          this.agentControlManager.resolveEnabled(
            'qoder-cn',
            listenerCfg['qoder-cn']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['qoder-cn']?.pollInterval,
      }),
    );

    // Qoder CN Trace：多源合并，取代 SQLite/IDE。
    const qoderCnLogDir = path.join(this.dataDir, 'logs', 'qoder-cn', 'history');
    const qoderCnTraceInput = new QoderCnTraceInput({
      stateStore: this.stateStore,
      logDir: qoderCnLogDir,
    });
    this.inputManager.registerInput(qoderCnTraceInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderCnTraceInput, {
        watchPaths: QoderCnTraceInput.getWatchPaths(),
        isAvailable: QoderCnTraceInput.checkAvailability,
        enabled: qoderCnTraceEnabled,
        pollIntervalMs: listenerCfg['qoder-cn-trace']?.pollInterval,
      }),
    );

    // Qoder Work 国际版 Hook JSONL；国际版聚合 Trace 活跃时关闭，避免同一 turn 重复采集。
    const qoderWorkLogDir = path.join(this.dataDir, 'logs', 'qoder-work', 'history');
    const qoderWorkInput = new QoderWorkInput({
      stateStore: this.stateStore,
      logDir: qoderWorkLogDir,
    });
    this.inputManager.registerInput(qoderWorkInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderWorkInput, {
        watchPaths: QoderWorkInput.getWatchPaths(),
        isAvailable: QoderWorkInput.checkAvailability,
        enabled: () => !qoderWorkTraceEnabled() &&
          this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-work']) &&
          this.agentControlManager.resolveEnabled(
            'qoder-work',
            listenerCfg['qoder-work']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['qoder-work']?.pollInterval,
      }),
    );

    // Qoder Work 国际版 SDK Log tail；国际版聚合 Trace 活跃时关闭。
    const qoderWorkLogInput = new QoderWorkLogInput({ stateStore: this.stateStore });
    this.inputManager.registerInput(qoderWorkLogInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderWorkLogInput, {
        watchPaths: QoderWorkLogInput.getWatchPaths(),
        isAvailable: QoderWorkLogInput.checkAvailability,
        enabled: () => !qoderWorkTraceEnabled() &&
          this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-work-log']) &&
          this.agentControlManager.resolveEnabled(
            'qoder-work-log',
            listenerCfg['qoder-work-log']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['qoder-work-log']?.pollInterval,
      }),
    );

    // Qoder Work 国际版 SQLite agents.db；国际版聚合 Trace 活跃时关闭。
    const qoderWorkSqliteInput = new QoderWorkSqliteInput({ stateStore: this.stateStore });
    this.inputManager.registerInput(qoderWorkSqliteInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderWorkSqliteInput, {
        watchPaths: QoderWorkSqliteInput.getWatchPaths(),
        isAvailable: QoderWorkSqliteInput.checkAvailability,
        enabled: () => !qoderWorkTraceEnabled() &&
          this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-work-sqlite']) &&
          this.agentControlManager.resolveEnabled(
            'qoder-work-sqlite',
            listenerCfg['qoder-work-sqlite']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['qoder-work-sqlite']?.pollInterval,
      }),
    );

    // Qoder Work CN 系列 Input。
    const qoderWorkCNDataRoot = resolveQoderWorkRoot('cn');
    const qoderWorkCNLogDir = path.join(this.dataDir, 'logs', 'qoder-work-cn', 'history');
    const qoderWorkCNDetectionPath = resolveHome('~/.qoderworkcn');

    // Qoder Work CN Trace：SDK Log 与 SQLite 聚合。
    const qoderWorkCNTraceInput = new QoderWorkCNTraceInput({
      stateStore: this.stateStore,
      agentType: ClientType.QoderWorkCN,
      dataRoot: qoderWorkCNDataRoot,
    });
    this.inputManager.registerInput(qoderWorkCNTraceInput);
    // CN Trace 开关也被 Hook/Log/SQLite 回退源复用，Trace 活跃时这些来源必须关闭。
    const qoderWorkCNTraceEnabled = () =>
      this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-work-cn-trace']) &&
      this.agentControlManager.resolveEnabled(
        'qoder-work-cn-trace',
        listenerCfg['qoder-work-cn-trace']?.enabled ?? true,
      );
    entries.push(
      this.inputManager.buildDetectionEntry(qoderWorkCNTraceInput, {
        watchPaths: [path.join(qoderWorkCNDataRoot, 'logs')],
        isAvailable: () => directoryExists(path.join(qoderWorkCNDataRoot, 'logs')),
        enabled: qoderWorkCNTraceEnabled,
        pollIntervalMs: listenerCfg['qoder-work-cn-trace']?.pollInterval,
      }),
    );

    // Qoder Work CN Hook JSONL；CN Trace 活跃时关闭。
    const qoderWorkCNHookInput = new QoderWorkInput({
      stateStore: this.stateStore,
      agentType: ClientType.QoderWorkCN,
      logDir: qoderWorkCNLogDir,
    });
    this.inputManager.registerInput(qoderWorkCNHookInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderWorkCNHookInput, {
        watchPaths: [qoderWorkCNDetectionPath],
        isAvailable: () => directoryExists(qoderWorkCNDetectionPath),
        enabled: () => !qoderWorkCNTraceEnabled() &&
          this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-work-cn-hook']) &&
          this.agentControlManager.resolveEnabled(
            'qoder-work-cn-hook',
            listenerCfg['qoder-work-cn-hook']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['qoder-work-cn-hook']?.pollInterval,
      }),
    );

    // Qoder Work CN SDK Log tail；CN Trace 活跃时关闭。
    const qoderWorkCNLogInput = new QoderWorkLogInput({
      stateStore: this.stateStore,
      agentType: ClientType.QoderWorkCN,
      dataRoot: qoderWorkCNDataRoot,
    });
    this.inputManager.registerInput(qoderWorkCNLogInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderWorkCNLogInput, {
        watchPaths: [path.join(qoderWorkCNDataRoot, 'logs')],
        isAvailable: () => directoryExists(path.join(qoderWorkCNDataRoot, 'logs')),
        enabled: () => !qoderWorkCNTraceEnabled() &&
          this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-work-cn-log']) &&
          this.agentControlManager.resolveEnabled(
            'qoder-work-cn-log',
            listenerCfg['qoder-work-cn-log']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['qoder-work-cn-log']?.pollInterval,
      }),
    );

    // Qoder Work CN SQLite agents.db；CN Trace 活跃时关闭。
    const qoderWorkCNSqliteInput = new QoderWorkSqliteInput({
      stateStore: this.stateStore,
      agentType: ClientType.QoderWorkCN,
      dataRoot: qoderWorkCNDataRoot,
    });
    this.inputManager.registerInput(qoderWorkCNSqliteInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderWorkCNSqliteInput, {
        watchPaths: [path.join(qoderWorkCNDataRoot, 'data')],
        isAvailable: () => fileExists(path.join(qoderWorkCNDataRoot, 'data', 'agents.db')),
        enabled: () => !qoderWorkCNTraceEnabled() &&
          this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-work-cn-sqlite']) &&
          this.agentControlManager.resolveEnabled(
            'qoder-work-cn-sqlite',
            listenerCfg['qoder-work-cn-sqlite']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['qoder-work-cn-sqlite']?.pollInterval,
      }),
    );

    // Qoder Trace：多源合并，取代 Hook/Session/SQLite。
    const qoderCliLogDir = path.join(this.dataDir, 'logs', 'qoder', 'history');
    const qoderTraceInput = new QoderTraceInput({
      stateStore: this.stateStore,
      logDir: qoderCliLogDir,
    });
    this.inputManager.registerInput(qoderTraceInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderTraceInput, {
        watchPaths: QoderTraceInput.getWatchPaths(),
        isAvailable: QoderTraceInput.checkAvailability,
        enabled: qoderTraceEnabled,
        pollIntervalMs: listenerCfg['qoder-trace']?.pollInterval,
      }),
    );

    // Qoder CLI Hook JSONL；qoder-trace 启用时关闭。
    const qoderCliInput = new QoderCliInput({
      stateStore: this.stateStore,
      logDir: qoderCliLogDir,
    });
    this.inputManager.registerInput(qoderCliInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderCliInput, {
        watchPaths: QoderCliInput.getWatchPaths(),
        isAvailable: QoderCliInput.checkAvailability,
        enabled: () => !qoderTraceEnabled() &&
          this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-cli-hook']) &&
          this.agentControlManager.resolveEnabled(
            'qoder-cli-hook',
            listenerCfg['qoder-cli-hook']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['qoder-cli-hook']?.pollInterval,
      }),
    );

    // Qoder CLI 原生 session segments；qoder-trace 启用时关闭。
    const qoderCliSessionInput = new QoderCliSessionInput({ stateStore: this.stateStore });
    this.inputManager.registerInput(qoderCliSessionInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderCliSessionInput, {
        watchPaths: QoderCliSessionInput.getWatchPaths(),
        isAvailable: QoderCliSessionInput.checkAvailability,
        enabled: () => !qoderTraceEnabled() &&
          this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-cli-session']) &&
          this.agentControlManager.resolveEnabled(
            'qoder-cli-session',
            listenerCfg['qoder-cli-session']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['qoder-cli-session']?.pollInterval,
      }),
    );

    // Cursor Hook 生成的 JSONL。
    const cursorHookLogDir = path.join(this.dataDir, 'logs', 'cursor', 'history');
    const cursorHookInput = new CursorHookInput({
      stateStore: this.stateStore,
      logDir: cursorHookLogDir,
    });
    this.inputManager.registerInput(cursorHookInput);
    entries.push(
      this.inputManager.buildDetectionEntry(cursorHookInput, {
        watchPaths: [cursorHookLogDir],
        isAvailable: async () => directoryExists(cursorHookLogDir),
        enabled: () => this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['cursor-hook']) &&
          this.agentControlManager.resolveEnabled(
            'cursor-hook',
            listenerCfg['cursor-hook']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['cursor-hook']?.pollInterval,
      }),
    );

    // Claude Code OTel 插件 JSONL。
    const claudeCodeLogDir = this.resolveClaudeCodeLogDir();
    const claudeCodeLogInput = new ClaudeCodeLogInput({
      stateStore: this.stateStore,
      logDir: claudeCodeLogDir,
    });
    // 注册后只建立统一 entries 处理链；Claude 日志目录命中时才由 Discovery 启动轮询。
    this.inputManager.registerInput(claudeCodeLogInput);
    entries.push(
      this.inputManager.buildDetectionEntry(claudeCodeLogInput, {
        watchPaths: [claudeCodeLogDir],
        isAvailable: async () => directoryExists(claudeCodeLogDir),
        enabled: () => this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['claude-code-log']) &&
          this.agentControlManager.resolveEnabled(
            'claude-code-log',
            listenerCfg['claude-code-log']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['claude-code-log']?.pollInterval,
      }),
    );

    // Kiro CLI 日志：SQLite 会话记录与 Hook JSONL。
    const kiroCliLogDir = this.resolveKiroCliLogDir();
    // 首次启动先建目录，否则 availability 检查失败，而目录又要等 delayedCollect 才创建。
    await ensureDir(kiroCliLogDir);
    const kiroCliLogInput = new KiroCliLogInput({
      stateStore: this.stateStore,
      logDir: kiroCliLogDir,
    });
    this.inputManager.registerInput(kiroCliLogInput);
    entries.push(
      this.inputManager.buildDetectionEntry(kiroCliLogInput, {
        watchPaths: [kiroCliLogDir],
        isAvailable: async () => directoryExists(kiroCliLogDir),
        enabled: () => this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['kiro-cli-log']) &&
          this.agentControlManager.resolveEnabled(
            'kiro-cli-log',
            listenerCfg['kiro-cli-log']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['kiro-cli-log']?.pollInterval,
      }),
    );

    // Kiro CLI Session：延迟 sidecar 扫描并运行 Hook processor delayedCollect。
    const kiroCliHookProcessorPath = path.join(
      this.dataDir,
      'hooks',
      'kiro-cli-hook-processor.mjs',
    );
    const kiroCliSessionWatchPaths = KiroCliSessionInput.getWatchPaths(this.dataDir);
    const kiroCliSessionInput = new KiroCliSessionInput({
      stateStore: this.stateStore,
      hookProcessorPath: kiroCliHookProcessorPath,
      dataDir: this.dataDir,
      pollIntervalMs: listenerCfg['kiro-cli-session']?.pollInterval,
    });
    this.inputManager.registerInput(kiroCliSessionInput);
    entries.push(
      this.inputManager.buildDetectionEntry(kiroCliSessionInput, {
        watchPaths: kiroCliSessionWatchPaths,
        isAvailable: async () => KiroCliSessionInput.checkAvailability(kiroCliHookProcessorPath),
        enabled: () => this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['kiro-cli-session']) &&
          this.agentControlManager.resolveEnabled(
            'kiro-cli-session',
            listenerCfg['kiro-cli-session']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['kiro-cli-session']?.pollInterval,
      }),
    );

    // Codex rollout transcript：统一处理正常结束与中断 turn。
    const codexTranscriptInput = new CodexTranscriptInput({
      stateStore: this.stateStore,
    });
    // Codex 当前生产主链统一处理正常和中断 turn；注册完成后仍由 Discovery 根据 session 目录启停。
    this.inputManager.registerInput(codexTranscriptInput);
    entries.push(
      this.inputManager.buildDetectionEntry(codexTranscriptInput, {
        watchPaths: CodexTranscriptInput.getWatchPaths(),
        isAvailable: CodexTranscriptInput.checkAvailability,
        enabled: () => this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['codex-transcript']) &&
          this.agentControlManager.resolveEnabled(
            'codex-transcript',
            listenerCfg['codex-transcript']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['codex-transcript']?.pollInterval,
      }),
    );

    // OpenCode event_t 插件 JSONL。plugin-inject 部署不创建日志目录，需在此预建，
    // 使 fs.watch 立即成功并避免首次安装退回 5 分钟轮询。
    const opencodeLogDir = path.join(this.dataDir, 'logs', 'opencode');
    await ensureDir(opencodeLogDir);
    const opencodeLogInput = new OpenCodeLogInput({
      stateStore: this.stateStore,
      logDir: opencodeLogDir,
    });
    this.inputManager.registerInput(opencodeLogInput);
    entries.push(
      this.inputManager.buildDetectionEntry(opencodeLogInput, {
        watchPaths: [opencodeLogDir],
        isAvailable: async () => directoryExists(opencodeLogDir),
        enabled: () => this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['opencode-log']) &&
          this.agentControlManager.resolveEnabled(
            'opencode-log',
            listenerCfg['opencode-log']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['opencode-log']?.pollInterval,
      }),
    );

    // Pi Coding Agent 扩展写出的 JSONL。
    const piCodingAgentLogDir = path.join(this.dataDir, 'logs', 'pi-coding-agent');
    await ensurePiCodingAgentLogDir(piCodingAgentLogDir);
    const piCodingAgentLogInput = new PiCodingAgentLogInput({
      stateStore: this.stateStore,
      logDir: piCodingAgentLogDir,
    });
    this.inputManager.registerInput(piCodingAgentLogInput);
    entries.push(
      this.inputManager.buildDetectionEntry(piCodingAgentLogInput, {
        watchPaths: [piCodingAgentLogDir],
        isAvailable: async () => directoryExists(piCodingAgentLogDir),
        enabled: () => this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['pi-coding-agent-log']) &&
          this.agentControlManager.resolveEnabled(
            'pi-coding-agent-log',
            listenerCfg['pi-coding-agent-log']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['pi-coding-agent-log']?.pollInterval,
      }),
    );

    // Qwen Code CLI transcript 驱动的 Hook JSONL。
    const qwenCodeCliLogDir = path.join(this.dataDir, 'logs', 'qwen-code-cli');
    // 预建目录使 AgentDiscoveryService 的 fs.watch 立即生效。
    await ensureDir(qwenCodeCliLogDir);
    const qwenCodeCliLogInput = new QwenCodeCliLogInput({
      stateStore: this.stateStore,
      logDir: qwenCodeCliLogDir,
    });
    this.inputManager.registerInput(qwenCodeCliLogInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qwenCodeCliLogInput, {
        watchPaths: [qwenCodeCliLogDir],
        isAvailable: async () => directoryExists(qwenCodeCliLogDir),
        enabled: () => this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qwen-code-cli-log']) &&
          this.agentControlManager.resolveEnabled(
            'qwen-code-cli-log',
            listenerCfg['qwen-code-cli-log']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['qwen-code-cli-log']?.pollInterval,
      }),
    );

    // Wukong 本地 CLI API 轮询。
    const wukongInput = new WukongInput({ stateStore: this.stateStore });
    this.inputManager.registerInput(wukongInput);
    entries.push(
      this.inputManager.buildDetectionEntry(wukongInput, {
        watchPaths: WukongInput.getWatchPaths(),
        isAvailable: WukongInput.checkAvailability,
        enabled: () => this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['wukong']) &&
          this.agentControlManager.resolveEnabled(
            'wukong',
            listenerCfg['wukong']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['wukong']?.pollInterval,
      }),
    );

    // 返回时只完成实例创建和事件订阅，尚未调用任何 Input.start()；DiscoveryService 的
    // startup refresh 会根据 enabled + isAvailable 决定真正启动哪些来源。
    return entries;
  }

  /** 从 Claude OTel 配置读取 log_dir，失败或缺失时回退到 Pilot 日志目录。 */
  private resolveClaudeCodeLogDir(): string {
    try {
      const configPath = path.join(os.homedir(), '.claude', 'otel-config.json');
      // 只在启动注册阶段同步读取一次，不位于持续采集热路径。
      const raw = fs.readFileSync(configPath, 'utf-8');
      const cfg = JSON.parse(raw);
      if (cfg.log_dir && typeof cfg.log_dir === 'string') {
        // 配置中的 `~` 仅在字符串开头替换；绝对路径和普通相对路径保持原样。
        return cfg.log_dir.replace(/^~/, os.homedir());
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('failed to read otel-config.json', { error: String(err) });
      }
    }
    return path.join(this.dataDir, 'logs', 'claude-code');
  }

  /** 返回 Kiro CLI 在 Pilot 数据目录中的固定日志路径。 */
  private resolveKiroCliLogDir(): string {
    return path.join(this.dataDir, 'logs', 'kiro-cli');
  }

  /**
   * 检查 config.agents 产品级门禁。
   * - 没有 agents 配置或对象为空：全部放行，兼容旧配置；
   * - 存在配置：只有对应 Agent 明确写 enabled=false 时禁止。
   *
   * 这里不替代 listener 开关和 agent-control.json，它只是最外层产品级判断。
   */
  private isAgentGatedEnabled(agentId: string): boolean {
    const agents = this.config.agents;
    if (!agents || Object.keys(agents).length === 0) return true;
    return agents[agentId]?.enabled !== false;
  }

  /**
   * 从当前 Pilot 目录的 VERSION 读取 package version；读取失败返回 unknown。
   */
  private readPackageVersion(): string {
    try {
      const pilotDir = this.resolvePilotDir();
      const versionFile = path.join(pilotDir, 'VERSION');
      if (fsSync.existsSync(versionFile)) {
        const content = fsSync.readFileSync(versionFile, 'utf8');
        const match = content.match(/^version=(.+)$/m);
        if (match) return match[1].trim();
      }
    } catch {
      // 版本只用于状态展示，读取失败不影响采集主流程。
    }
    return 'unknown';
  }

  /**
   * 解析实际 Pilot 包目录：current 版本目录 -> 旧 package 目录 -> dataDir。
   * 这样源码、旧布局与多版本安装均能找到 agents.d 和 VERSION。
   */
  private resolvePilotDir(): string {
    try {
      const currentFile = path.join(this.dataDir, 'current');
      const versionName = fsSync.readFileSync(currentFile, 'utf-8').trim();
      if (versionName) {
        const versionDir = path.join(this.dataDir, 'versions', versionName);
        if (fsSync.existsSync(versionDir)) {
          logger.debug('resolved pilotDir from current pointer', { pilotDir: versionDir });
          return versionDir;
        }
      }
    } catch {
      // current 不存在时继续尝试旧布局或源码开发布局。
    }

    const legacyPackageDir = path.join(this.dataDir, 'package');
    if (fsSync.existsSync(path.join(legacyPackageDir, 'dist', 'index.js'))) {
      return legacyPackageDir;
    }

    return this.dataDir;
  }

  /** 聚合 Input/SLS 计数和空闲时间，生成 MetricsWriter 的 DataflowSnapshot。 */
  private buildDataflowSnapshot(): DataflowSnapshot {
    const inputCounters = this.inputManager.getInputCounters();
    const activeIds = this.inputManager.getActiveInputIds();

    // sendEntriesTotal 使用 InputManager 的成功输出计数，而不是各 SLS endpoint 之和，避免
    // 多目的地扇出时把同一业务事件重复计数。
    let sendEntriesTotal = 0;
    let receivedBytesTotal = 0;
    for (const counter of inputCounters.values()) {
      sendEntriesTotal += counter.outEvents;
      receivedBytesTotal += counter.inBytes;
    }

    // 所有 SLS endpoint 聚合成一个 flusher runner 汇总。
    const flusherRunner = {
      inEntries: 0, inBytes: 0, outEntries: 0, outFailed: 0,
      totalDelayMs: 0, lastFlushTime: '', startTime: '',
    };

    // Map 保留 endpoint 名称和配置标签，供 MetricsCollector 生成逐目的地指标。
    const flushers = new Map<string, { inEntries: number; inBytes: number; outEntries: number; outFailed: number; totalDelayMs: number; lastFlushTime: string; startTime: string; flusherName: string; mode: string; endpoint: string; project: string; logstore: string }>();

    // 仅 SLS 当前暴露 endpoint 级计数；其他 Flusher 不进入该 Map。
    const slsFlusher = this.getSlsFlusher();
    if (slsFlusher) {
      for (const [epName, counter] of slsFlusher.getEndpointCounters()) {
        flusherRunner.inEntries += counter.inEntries;
        flusherRunner.inBytes += counter.inBytes;
        flusherRunner.outEntries += counter.outEntries;
        flusherRunner.outFailed += counter.outFailed;
        flusherRunner.totalDelayMs += counter.totalDelayMs;
        if (counter.lastFlushTime > flusherRunner.lastFlushTime) {
          flusherRunner.lastFlushTime = counter.lastFlushTime;
        }
        if (!flusherRunner.startTime || counter.startTime < flusherRunner.startTime) {
          flusherRunner.startTime = counter.startTime;
        }
        flushers.set(epName, {
          ...counter,
          flusherName: 'sls',
        });
      }
    }

    const inputs = new Map<string, { inEvents: number; inBytes: number; outEvents: number; outFailed: number; lastPollTime: string; startTime: string; type: string }>();
    const inputIdleMinutes = new Map<string, number>();
    for (const [id, counter] of inputCounters) {
      inputs.set(id, { ...counter });
      inputIdleMinutes.set(id, this.inputManager.getInputIdleMinutes(id));
    }

    return {
      sendEntriesTotal,
      receivedBytesTotal,
      inputCount: inputCounters.size,
      activeInputCount: activeIds.length,
      flusherRunner,
      inputs,
      flushers,
      inputIdleMinutes,
    };
  }

  /** 从单 Flusher 或 MultiFlusher 中查找首个 SlsFlusher。 */
  private getSlsFlusher(): SlsFlusher | null {
    if (this.flusher instanceof SlsFlusher) return this.flusher;
    if (this.flusher instanceof MultiFlusher) {
      for (const f of this.flusher.getFlushers()) {
        if (f instanceof SlsFlusher) return f;
      }
    }
    return null;
  }

  /** 返回已初始化的告警管理器。 */
  getAlarmManager(): AlarmManager {
    return this.alarmManager;
  }
}
