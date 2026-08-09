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
  /** 当前 Pilot 包版本。 */
  version: string;
  /** 由操作系统类型、release 与 CPU 架构拼成的主机描述。 */
  os_detail: string;
  /** 本机主机名。 */
  hostname: string;
  /** Collector 构造时解析并固定的本机 IP。 */
  ip: string;
  /** userId、IP 与进程启动秒组成的一次进程实例标识。 */
  instance_id: string;
  /** 用户配置或默认生成的采集用户标识。 */
  user_id: string;
  /** 当前 Collector 的操作系统 PID。 */
  pid: number;
  /** 相邻采样间当前进程消耗的单核 CPU 百分比字符串。 */
  cpu: string;
  /** RSS 常驻内存，单位 MiB，四舍五入后转字符串。 */
  mem: string;
  /** V8 heapUsed，单位 MiB，四舍五入后转字符串。 */
  mem_heap: string;
  /** Collector 构造时记录的本地格式化启动时间。 */
  start_time: string;
  /** 禁止采集消息正文的 Agent ID，以空格连接。 */
  capture_message_disabled_agents: string;
  /** 已配置 SLS endpoint 的去重 Project 列表。 */
  project: string;
  /** ConfigLoader 解析后的 CMS workspace。 */
  cms_workspace: string;
  /** 总输入、活跃输入及吞吐量指标；值统一为字符串以适配日志宽表。 */
  metric_json: {
    /** 当前已注册 Input 数。 */
    input_count: string;
    /** 最近达到活跃判定的 Input 数。 */
    active_input_count: string;
    /** 当前进程打开的文件描述符数；不支持/失败时为 -1。 */
    open_fd: string;
    /** 相邻 L1 采样间成功进入发送链的事件条数/秒；首轮为 0.0。 */
    send_entries_ps: string;
    /** 相邻 L1 采样间 Input 读取字节数/秒；首轮为 0.0。 */
    received_bytes_ps: string;
    /** 进程生命周期内累计发送条数。 */
    send_entries_total: string;
    /** 进程生命周期内累计读取字节数。 */
    received_bytes_total: string;
  };
  /** MultiFlusher 汇总的进出累计量，不代表单个 endpoint 的独立状态。 */
  flusher_runner: {
    /** 进入输出分发器的累计事件数。 */
    in_entries_total: string;
    /** 进入输出分发器的累计估算字节数。 */
    in_bytes_total: string;
    /** 各输出完成的累计条数口径。 */
    out_entries_total: string;
    /** 各输出报告失败的累计条数。 */
    out_failed_entries_total: string;
    /** 最近一次输出刷新时间。 */
    last_flush_time: string;
  };
  /** 安装脚本记录的 systemd/launchd/nohup 等启动方式。 */
  init_type: string;
  /** previous 指针是否指向存在的版本目录。 */
  rollback_available: string;
  /** 当前更新灰度策略。 */
  canary_policy: string;
  /** versions 目录下的非隐藏条目数。 */
  version_count: string;
  /** Updater 是否存活；进程前两个 L1 周期处于宽限期并报告 true。 */
  updater_pid_alive: string;
  /** node-bin 是否指向可执行文件。 */
  node_bin_valid: string;
  /** current 指针是否安全地指向存在的版本目录。 */
  current_version_valid: string;
  /** 指标生成时的 Unix 秒，符合 SLS `__time__` 约定。 */
  __time__: number;
}

/** 每 Input 的健康行；名称保留 AlarmMetrics 以兼容下游 topic。 */
export interface AlarmMetrics {
  category: 'alarm';
  input_name: string;
  instance_id: string;
  source_ip: string;
  user_id: string;
  /** 当前 Input 成功输出的进程累计事件数。 */
  succeed_events: string;
  /** 当前 Input 处理/输出失败的进程累计事件数。 */
  failed_events: string;
  /** 距最近活动的分钟数；无法计算时为 -1。 */
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
  /** Input 从来源读取到的累计原始记录数。 */
  in_events_total: string;
  /** Input 从来源读取到的累计字节数。 */
  in_size_bytes: string;
  /** Input 成功转换并交给上层的累计事件数。 */
  out_events_total: string;
  /** Input 转换/处理失败的累计记录数。 */
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
  /** 完成输出所累计的延迟毫秒总和；需要结合条数计算平均值。 */
  total_delay_ms: string;
  last_flush_time: string;
  start_time: string;
  __time__: number;
}

/** 内部统一的输出累计计数。 */
export interface FlusherStats {
  /** 进入该输出的累计事件数。 */
  inEntries: number;
  /** 进入该输出的累计估算字节数。 */
  inBytes: number;
  /** 该输出报告成功的累计事件数。 */
  outEntries: number;
  /** 该输出报告失败的累计事件数。 */
  outFailed: number;
  /** 所有刷新操作的累计延迟毫秒。 */
  totalDelayMs: number;
  /** 最近一次刷新完成时间。 */
  lastFlushTime: string;
  /** 统计对象开始累计的时间。 */
  startTime: string;
}

/** 内部统一的 Input 累计计数。 */
export interface InputStats {
  /** 从原始来源读取的累计记录数。 */
  inEvents: number;
  /** 从原始来源读取的累计字节数。 */
  inBytes: number;
  /** 成功产出的累计 canonical 事件数。 */
  outEvents: number;
  /** 处理失败的累计原始记录数。 */
  outFailed: number;
  /** 最近一次完成 poll 的时间。 */
  lastPollTime: string;
  /** Input 开始累计统计的时间。 */
  startTime: string;
}

/** 指标采集时从各模块读取的一致数据流快照。 */
export interface DataflowSnapshot {
  /** 所有 Input 成功进入输出分发链的进程累计事件数。 */
  sendEntriesTotal: number;
  /** 所有 Input 从来源读取的进程累计字节数。 */
  receivedBytesTotal: number;
  /** 当前注册 Input 总数。 */
  inputCount: number;
  /** 当前满足活跃条件的 Input 数。 */
  activeInputCount: number;
  /** MultiFlusher 层的整体累计计数。 */
  flusherRunner: FlusherStats;
  /** 以 Input 实例名为键的实时累计统计。 */
  inputs: Map<string, InputStats & { type: string }>;
  /** 以 endpoint 配置名为键的实时累计统计和标签。 */
  flushers: Map<string, FlusherStats & { flusherName: string; mode: string; endpoint: string; project: string; logstore: string }>;
  /** 以 Input 实例名为键的最近空闲分钟数。 */
  inputIdleMinutes: Map<string, number>;
}

/** 安装/更新基础设施的最近健康状态。 */
export interface InfraHealthSnapshot {
  /** Updater 进程探测结论；前两个 L1 周期按 true 处理。 */
  updaterPidAlive: boolean;
  /** current 指针是否未逃逸且目标存在。 */
  currentVersionValid: boolean;
  /** node-bin 内容是否非空并具备当前平台的执行权限。 */
  nodeBinValid: boolean;
  /** previous 指针是否可作为回滚目标。 */
  rollbackAvailable: boolean;
  /** 本地保留版本条目数量。 */
  versionCount: number;
  /** 构造时传入的灰度策略字符串。 */
  canaryPolicy: string;
  /** 宽限期后连续探测不到 Updater 的 L1 次数。 */
  updaterConsecutiveFailures: number;
}

/** 将进程累计状态转换成 L1/L2 指标结构。 */
export class MetricsCollector {
  /** 构造时固定的包版本，保证同一进程各周期标签稳定。 */
  private readonly version: string;
  /** 构造时固定的用户标识。 */
  private readonly userId: string;
  /** 用于探测安装指针和 Updater pid 文件的数据根目录。 */
  private readonly dataDir: string;
  /** 仅作为指标标签输出，不由 Collector 解释策略。 */
  private readonly canaryPolicy: string;
  /** 用于统计哪些 Agent 关闭了消息正文采集。 */
  private readonly agentsConfig: AgentsConfig;
  /** 用于汇总 project 标签，不参与实际发送。 */
  private readonly slsEndpoints: SlsEndpoint[];
  /** 已解析的 CMS workspace 标签。 */
  private readonly cmsWorkspace: string;
  /** 可注入的同步 Updater 存活探针，便于测试且避免 Collector 依赖具体扫描实现。 */
  private readonly updaterLiveness: (pidFile: string) => ProcessLiveness;
  /** 本地格式化后的进程启动时间。 */
  private readonly startTime: string;
  /** 构造时的 Unix 秒，用于生成稳定 instanceId。 */
  private readonly startTimestamp: number;
  /** 同一进程生命周期不变的指标实例 ID。 */
  private readonly instanceId: string;
  /** 构造时解析一次的本机 IP，避免周期采样反复枚举网卡。 */
  private readonly localIp: string;
  /** 安装脚本记录的启动管理方式。 */
  private readonly initType: string;

  /** 上一次 `process.cpuUsage()` 的微秒累计值。 */
  private lastCpuUsage: NodeJS.CpuUsage | null = null;
  /** 上一次 CPU 样本对应的墙钟毫秒。 */
  private lastCpuTime = 0;
  /** 上一次吞吐速率样本时间；与 CPU 采样时间独立维护。 */
  private lastCollectTime = 0;
  /** 首次 CPU 样本只建立基线并报告 0。 */
  private isFirstCpuSample = true;
  // 首次 L1 前没有速率基线；使用 null 区分累计值恰好为 0，并在首轮输出 0 rate。
  private prevSendEntries: number | null = null;
  /** 上一轮累计接收字节，供差分计算每秒速率。 */
  private prevReceivedBytes: number | null = null;
  /** 已执行的 L1 周期数，同时控制 Updater 两轮启动宽限。 */
  private l1CycleCount = 0;
  /** 宽限期后连续 Updater 失败次数，成功一次即归零。 */
  private updaterConsecutiveFailures = 0;
  /** 最近一次 L1 同步保存的基础设施视图，供 MetricsWriter 随后检查告警。 */
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
    // 同一 now 同时用于速率时间窗与输出 __time__，避免一次采集中出现边界秒不一致。
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
      // 输入计数原则上单调递增；若上游重置计数，这里会如实产生负速率，不做静默钳制。
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

    // Map 的插入顺序会成为输出顺序；Collector 不在这里排序或复制统计对象。
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
      // Map key 是 endpoint 配置别名；实际 URL 另放在 endpoint_name，二者语义不能互换。
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
      // -1 明确表示没有空闲时长数据，与真正的 0 分钟活跃状态区分。
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
    // `collectL1` 每调用一次即算一个周期；测试直接调用也会推进宽限状态。
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

    // 四项文件系统探测互相独立，任何一项失败只影响自己的布尔值。
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
    // Node 返回进程从启动起累计的 user/system CPU 微秒，而不是即时百分比。
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
        // CPU 微秒先除以 1000 变毫秒，再除墙钟毫秒；结果是单核百分比，可在多核负载下超过 100。
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
    // resolve 后必须仍位于 versions 的子级，阻止 `../` 指针把健康检查带出版本目录。
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
    // 当前实现统计所有非隐藏条目，不额外验证它们是否目录或是否包含完整安装。
    return fs.readdirSync(path.join(dataDir, 'versions')).filter(e => !e.startsWith('.')).length;
  } catch {
    return 0;
  }
}

