/**
 * Collector 运行状态与数据流指标的快照转换器。
 *
 * MetricsWriter 周期传入 Orchestrator/InputManager 的 `DataflowSnapshot`，本类把累计计数转成
 * L1/L2 输出，并同步探测 CPU、内存、文件描述符、版本指针、node-bin 和 Updater 存活状态。
 * 本类不写文件、不发网络，也不创建定时器。
 */

import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatTime } from '../utils/time-utils.js';
import { resolveLocalIp } from '../utils/network-utils.js';
import { checkProcessLiveness, UPDATER_PROCESS_PATTERNS } from '../utils/pid-utils.js';
import type { ProcessLiveness } from '../utils/pid-utils.js';
import type { AgentsConfig, SlsEndpoint } from '../types/index.js';

/** 十分钟级进程/安装/总数据流快照。 */
export interface L1Metrics {
  version: string;
  os_detail: string;
  hostname: string;
  ip: string;
  instance_id: string;
  user_id: string;
  pid: number;
  cpu: string;
  mem: string;
  mem_heap: string;
  start_time: string;
  capture_message_disabled_agents: string;
  project: string;
  cms_workspace: string;
  metric_json: {
    input_count: string;
    active_input_count: string;
    open_fd: string;
    send_entries_ps: string;
    received_bytes_ps: string;
    send_entries_total: string;
    received_bytes_total: string;
  };
  flusher_runner: {
    in_entries_total: string;
    in_bytes_total: string;
    out_entries_total: string;
    out_failed_entries_total: string;
    last_flush_time: string;
  };
  init_type: string;
  rollback_available: string;
  canary_policy: string;
  version_count: string;
  updater_pid_alive: string;
  node_bin_valid: string;
  current_version_valid: string;
  __time__: number;
}

/** 每 Input 的健康行；名称保留 AlarmMetrics 以兼容下游 topic。 */
export interface AlarmMetrics {
  category: 'alarm';
  input_name: string;
  instance_id: string;
  source_ip: string;
  user_id: string;
  succeed_events: string;
  failed_events: string;
  input_idle_minutes: string;
  __time__: number;
}

/** 每 Input 的累计流量明细。 */
export interface InputMetrics {
  category: 'input';
  label: {
    input_name: string;
    input_type: string;
  };
  user_id: string;
  in_events_total: string;
  in_size_bytes: string;
  out_events_total: string;
  out_failed_events_total: string;
  last_poll_time: string;
  start_time: string;
  __time__: number;
}

/** 每输出 endpoint 的累计发送明细。 */
export interface FlusherMetrics {
  category: 'flusher';
  label: {
    flusher_name: string;
    endpoint_name: string;
    project: string;
    logstore: string;
    mode: string;
  };
  user_id: string;
  in_entries_total: string;
  in_size_bytes: string;
  out_entries_total: string;
  out_failed_entries_total: string;
  total_delay_ms: string;
  last_flush_time: string;
  start_time: string;
  __time__: number;
}

/** 内部统一的输出累计计数。 */
export interface FlusherStats {
  inEntries: number;
  inBytes: number;
  outEntries: number;
  outFailed: number;
  totalDelayMs: number;
  lastFlushTime: string;
  startTime: string;
}

/** 内部统一的 Input 累计计数。 */
export interface InputStats {
  inEvents: number;
  inBytes: number;
  outEvents: number;
  outFailed: number;
  lastPollTime: string;
  startTime: string;
}

/** 指标采集时从各模块读取的一致数据流快照。 */
export interface DataflowSnapshot {
  sendEntriesTotal: number;
  receivedBytesTotal: number;
  inputCount: number;
  activeInputCount: number;
  flusherRunner: FlusherStats;
  inputs: Map<string, InputStats & { type: string }>;
  flushers: Map<string, FlusherStats & { flusherName: string; mode: string; endpoint: string; project: string; logstore: string }>;
  inputIdleMinutes: Map<string, number>;
}

/** 安装/更新基础设施的最近健康状态。 */
export interface InfraHealthSnapshot {
  updaterPidAlive: boolean;
  currentVersionValid: boolean;
  nodeBinValid: boolean;
  rollbackAvailable: boolean;
  versionCount: number;
  canaryPolicy: string;
  updaterConsecutiveFailures: number;
}

/** 将进程累计状态转换成 L1/L2 指标结构。 */
export class MetricsCollector {
  private readonly version: string;
  private readonly userId: string;
  private readonly dataDir: string;
  private readonly canaryPolicy: string;
  private readonly agentsConfig: AgentsConfig;
  private readonly slsEndpoints: SlsEndpoint[];
  private readonly cmsWorkspace: string;
  private readonly updaterLiveness: (pidFile: string) => ProcessLiveness;
  private readonly startTime: string;
  private readonly startTimestamp: number;
  private readonly instanceId: string;
  private readonly localIp: string;
  private readonly initType: string;

  private lastCpuUsage: NodeJS.CpuUsage | null = null;
  private lastCpuTime = 0;
  private lastCollectTime = 0;
  private isFirstCpuSample = true;
  // 首次 L1 前没有速率基线；使用 null 区分累计值恰好为 0，并在首轮输出 0 rate。
  private prevSendEntries: number | null = null;
  private prevReceivedBytes: number | null = null;
  private l1CycleCount = 0;
  private updaterConsecutiveFailures = 0;
  private lastInfraHealth: InfraHealthSnapshot | null = null;

  /**
   * 构造时固定实例身份、启动时间和初始化类型，后续周期保持一致。
   * updaterLiveness 可由测试注入，生产默认使用 pid 文件+命令行扫描。
   */
  constructor(opts: { version: string; userId: string; dataDir: string; canaryPolicy?: string; agentsConfig?: AgentsConfig; slsEndpoints?: SlsEndpoint[]; cmsWorkspace?: string; updaterLiveness?: (pidFile: string) => ProcessLiveness }) {
    this.version = opts.version;
    this.userId = opts.userId;
    this.dataDir = opts.dataDir;
    this.canaryPolicy = opts.canaryPolicy ?? '';
    this.agentsConfig = opts.agentsConfig ?? {};
    this.slsEndpoints = opts.slsEndpoints ?? [];
    this.cmsWorkspace = opts.cmsWorkspace ?? '';
    this.updaterLiveness = opts.updaterLiveness
      ?? ((pidFile: string) => checkProcessLiveness(pidFile, UPDATER_PROCESS_PATTERNS));
    this.startTimestamp = Math.floor(Date.now() / 1000);
    this.startTime = formatTime(new Date());
    this.localIp = resolveLocalIp();
    this.instanceId = `${opts.userId}_${this.localIp}_${this.startTimestamp}`;
    this.initType = readInitType(opts.dataDir);
  }

  /** 返回固定用户标识，供 MetricsWriter 做格式告警。 */
  getUserId(): string {
    return this.userId;
  }

  /** 采集进程、总流量、速率和安装健康状态的一条 L1 记录。 */
  collectL1(snapshot: DataflowSnapshot): L1Metrics {
    const now = Date.now();
    const cpuPercent = this.calcCpuPercent(now);
    const mem = process.memoryUsage();

    // 首轮只建立累计基线并输出 0，避免用全部历史计数除以接近 0 的时间窗。
    let entriesPs = '0.0';
    let bytesPs = '0.0';
    if (this.prevSendEntries === null || this.prevReceivedBytes === null) {
      this.prevSendEntries = snapshot.sendEntriesTotal;
      this.prevReceivedBytes = snapshot.receivedBytesTotal;
    } else {
      // 时间差至少按 1ms，防止测试或重复调用出现除零。
      const elapsedSec = Math.max((now - this.lastCollectTime) / 1000, 0.001);
      const entriesDelta = snapshot.sendEntriesTotal - this.prevSendEntries;
      const bytesDelta = snapshot.receivedBytesTotal - this.prevReceivedBytes;
      entriesPs = (entriesDelta / elapsedSec).toFixed(1);
      bytesPs = (bytesDelta / elapsedSec).toFixed(1);
      this.prevSendEntries = snapshot.sendEntriesTotal;
      this.prevReceivedBytes = snapshot.receivedBytesTotal;
    }

    this.lastCollectTime = now;

    const health = this.collectInfraHealth();

    return {
      version: this.version,
      os_detail: `${os.type()}; ${os.release()}; ${os.arch()}`,
      hostname: os.hostname(),
      ip: this.localIp,
      instance_id: this.instanceId,
      user_id: this.userId,
      pid: process.pid,
      cpu: String(cpuPercent),
      mem: String(Math.round(mem.rss / 1024 / 1024)),
      mem_heap: String(Math.round(mem.heapUsed / 1024 / 1024)),
      start_time: this.startTime,
      capture_message_disabled_agents: this.buildCaptureMessageDisabledAgents(),
      project: this.buildProject(),
      cms_workspace: this.buildCmsWorkspace(),
      metric_json: {
        input_count: String(snapshot.inputCount),
        active_input_count: String(snapshot.activeInputCount),
        open_fd: String(getOpenFdCount()),
        send_entries_ps: entriesPs,
        received_bytes_ps: bytesPs,
        send_entries_total: String(snapshot.sendEntriesTotal),
        received_bytes_total: String(snapshot.receivedBytesTotal),
      },
      flusher_runner: {
        in_entries_total: String(snapshot.flusherRunner.inEntries),
        in_bytes_total: String(snapshot.flusherRunner.inBytes),
        out_entries_total: String(snapshot.flusherRunner.outEntries),
        out_failed_entries_total: String(snapshot.flusherRunner.outFailed),
        last_flush_time: snapshot.flusherRunner.lastFlushTime,
      },
      init_type: this.initType,
      rollback_available: String(health.rollbackAvailable),
      canary_policy: health.canaryPolicy,
      version_count: String(health.versionCount),
      updater_pid_alive: String(health.updaterPidAlive),
      node_bin_valid: String(health.nodeBinValid),
      current_version_valid: String(health.currentVersionValid),
      __time__: Math.floor(now / 1000),
    };
  }

  /** 将每个 Input 的累计状态展开为独立 L2 行。 */
  collectL2Inputs(snapshot: DataflowSnapshot): InputMetrics[] {
    const now = Math.floor(Date.now() / 1000);
    const results: InputMetrics[] = [];

    for (const [name, stats] of snapshot.inputs) {
      results.push({
        category: 'input',
        label: {
          input_name: name,
          input_type: stats.type,
        },
        user_id: this.userId,
        in_events_total: String(stats.inEvents),
        in_size_bytes: String(stats.inBytes),
        out_events_total: String(stats.outEvents),
        out_failed_events_total: String(stats.outFailed),
        last_poll_time: stats.lastPollTime,
        start_time: stats.startTime,
        __time__: now,
      });
    }
    return results;
  }

  /** 将每个 Flusher endpoint 的累计状态展开为独立 L2 行。 */
  collectL2Flushers(snapshot: DataflowSnapshot): FlusherMetrics[] {
    const now = Math.floor(Date.now() / 1000);
    const results: FlusherMetrics[] = [];

    for (const [epName, stats] of snapshot.flushers) {
      results.push({
        category: 'flusher',
        label: {
          flusher_name: stats.flusherName,
          endpoint_name: stats.endpoint,
          project: stats.project,
          logstore: stats.logstore,
          mode: stats.mode,
        },
        user_id: this.userId,
        in_entries_total: String(stats.inEntries),
        in_size_bytes: String(stats.inBytes),
        out_entries_total: String(stats.outEntries),
        out_failed_entries_total: String(stats.outFailed),
        total_delay_ms: String(stats.totalDelayMs),
        last_flush_time: stats.lastFlushTime,
        start_time: stats.startTime,
        __time__: now,
      });
    }
    return results;
  }

  // 这里仅生成每 Input 健康行。全局 Flusher 失败/延迟只属于 collectL2Flushers；若复制到
  // 每个 Input 行，会让单个 endpoint 故障看起来像所有 Input 同时失败。
  collectL2Alarms(snapshot: DataflowSnapshot): AlarmMetrics[] {
    const now = Math.floor(Date.now() / 1000);
    const results: AlarmMetrics[] = [];

    for (const [name, stats] of snapshot.inputs) {
      const idleMinutes = snapshot.inputIdleMinutes.get(name) ?? -1;
      results.push({
        category: 'alarm',
        input_name: name,
        instance_id: this.instanceId,
        source_ip: this.localIp,
        user_id: this.userId,
        succeed_events: String(stats.outEvents),
        failed_events: String(stats.outFailed),
        input_idle_minutes: String(idleMinutes),
        __time__: now,
      });
    }
    return results;
  }

  /** 返回关闭 message content 的 Agent ID 排序列表。 */
  private buildCaptureMessageDisabledAgents(): string {
    const disabled: string[] = [];
    for (const [agentType, cfg] of Object.entries(this.agentsConfig)) {
      if (cfg.captureMessageContent === false) disabled.push(agentType);
    }
    disabled.sort();
    return disabled.join(' ');
  }

  /** 汇总所有 SLS endpoint 的唯一 project，稳定排序后空格分隔。 */
  private buildProject(): string {
    const seen = new Set<string>();
    for (const ep of this.slsEndpoints) {
      if (ep.project) seen.add(ep.project);
    }
    return Array.from(seen).sort().join(' ');
  }

  /** CMS workspace 已由 ConfigLoader 解析，直接输出固定值。 */
  private buildCmsWorkspace(): string {
    return this.cmsWorkspace;
  }

  /**
   * 探测 Updater、current、node-bin、previous 和 versions 目录。
   * 前两轮跳过 Updater 存活扫描，给服务启动/调度留出宽限时间。
   */
  private collectInfraHealth(): InfraHealthSnapshot {
    this.l1CycleCount++;

    let updaterPidAlive = true;
    if (this.l1CycleCount > 2) {
      updaterPidAlive = this.updaterLiveness(
        path.join(this.dataDir, 'loongsuite-pilot-updater.pid'),
      ).running;
      if (updaterPidAlive) {
        this.updaterConsecutiveFailures = 0;
      } else {
        this.updaterConsecutiveFailures++;
      }
    }

    const currentVersionValid = checkVersionPointer(this.dataDir);
    const nodeBinValid = checkNodeBin(this.dataDir);
    const rollbackAvailable = checkRollbackAvailable(this.dataDir);
    const versionCount = countVersions(this.dataDir);

    this.lastInfraHealth = {
      updaterPidAlive,
      currentVersionValid,
      nodeBinValid,
      rollbackAvailable,
      versionCount,
      canaryPolicy: this.canaryPolicy,
      updaterConsecutiveFailures: this.updaterConsecutiveFailures,
    };

    return this.lastInfraHealth;
  }

  /** 返回最近一次 L1 保存的基础设施状态；尚未采集时为 null。 */
  getLastInfraHealth(): InfraHealthSnapshot | null {
    return this.lastInfraHealth;
  }

  /** 通过两次 process.cpuUsage 差值计算当前进程占单核百分比。 */
  private calcCpuPercent(now: number): number {
    const cpuUsage = process.cpuUsage();

    if (this.isFirstCpuSample) {
      this.isFirstCpuSample = false;
      this.lastCpuUsage = cpuUsage;
      this.lastCpuTime = now;
      return 0;
    }

    let percent = 0;
    if (this.lastCpuUsage && this.lastCpuTime > 0) {
      const elapsedMs = now - this.lastCpuTime;
      if (elapsedMs > 0) {
        const userDelta = cpuUsage.user - this.lastCpuUsage.user;
        const systemDelta = cpuUsage.system - this.lastCpuUsage.system;
        percent = ((userDelta + systemDelta) / 1000 / elapsedMs) * 100;
      }
    }

    this.lastCpuUsage = cpuUsage;
    this.lastCpuTime = now;
    return Math.round(percent * 100) / 100;
  }
}

/** Linux 读 `/proc/<pid>/fd`，macOS 读 `/dev/fd`；其他平台或失败返回 -1。 */
function getOpenFdCount(): number {
  if (os.platform() === 'linux' || os.platform() === 'darwin') {
    try {
      const fdDir = os.platform() === 'linux'
        ? `/proc/${process.pid}/fd`
        : `/dev/fd`;
      return fs.readdirSync(fdDir).length;
    } catch {
      return -1;
    }
  }
  return -1;
}

/** 读取安装脚本写入的 init-type；缺失时为 unknown。 */
function readInitType(dataDir: string): string {
  try {
    const raw = fs.readFileSync(path.join(dataDir, 'init-type'), 'utf-8').trim();
    return raw || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 校验 current 指针非空、未逃逸 versions 目录且目标存在。 */
function checkVersionPointer(dataDir: string): boolean {
  try {
    const current = fs.readFileSync(path.join(dataDir, 'current'), 'utf-8').trim();
    if (!current) return false;
    const resolved = path.resolve(path.join(dataDir, 'versions', current));
    if (!resolved.startsWith(path.join(dataDir, 'versions') + path.sep)) return false;
    return fs.existsSync(resolved);
  } catch {
    return false;
  }
}

/** 校验 node-bin 指向当前用户可执行文件。 */
function checkNodeBin(dataDir: string): boolean {
  try {
    const nodePath = fs.readFileSync(path.join(dataDir, 'node-bin'), 'utf-8').trim();
    if (!nodePath) return false;
    fs.accessSync(nodePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 校验 previous 指针对应版本存在，从而判断 rollback 是否可用。 */
function checkRollbackAvailable(dataDir: string): boolean {
  try {
    const previous = fs.readFileSync(path.join(dataDir, 'previous'), 'utf-8').trim();
    if (!previous) return false;
    const resolved = path.resolve(path.join(dataDir, 'versions', previous));
    if (!resolved.startsWith(path.join(dataDir, 'versions') + path.sep)) return false;
    return fs.existsSync(resolved);
  } catch {
    return false;
  }
}

/** 统计 versions 下非隐藏条目；目录缺失/不可读时返回 0。 */
function countVersions(dataDir: string): number {
  try {
    return fs.readdirSync(path.join(dataDir, 'versions')).filter(e => !e.startsWith('.')).length;
  } catch {
    return 0;
  }
}

