/**
 * 周期指标/告警写入与发送调度器。
 *
 * Orchestrator 启动后创建本类：L1/L2 每 10 分钟落本地 JSONL并调用 internal sender，告警每
 * 30 秒消费 AlarmManager。三个定时器均 `unref()`，不会单独阻止 Node.js 进程自然退出；stop
 * 会清理定时器并执行最后一次写入。
 */

import * as path from 'node:path';
import { appendLine, ensureDir } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';
import { flattenToStrings } from '../utils/record-utils.js';
import { sendAlarm, sendRunningStatus, sendStatus } from '../internal/sender.js';
import { MetricsCollector } from './metrics-collector.js';
import type { DataflowSnapshot, L1Metrics } from './metrics-collector.js';
import type { AlarmManager } from './alarm-manager.js';
import type { AgentsConfig, SlsEndpoint } from '../types/index.js';
import type { ProcessLiveness } from '../utils/pid-utils.js';

const logger = createLogger('MetricsWriter');

/** 周期和资源阈值；基础设施告警一小时后可再次触发。 */
const L1_INTERVAL_MS = 600_000;
const L2_INTERVAL_MS = 600_000;
const ALARM_FLUSH_INTERVAL_MS = 30_000;
const CPU_THRESHOLD_PERCENT = 80;
const MEM_THRESHOLD_MB = 512;
const INFRA_ALARM_COOLDOWN_MS = 3_600_000;

/** MetricsWriter 构造依赖；getSnapshot 在每次周期调用时读取实时状态。 */
export interface MetricsWriterOptions {
  /** Pilot 数据根目录；本类固定写入其 logs/metric_alarm 子目录。 */
  dataDir: string;
  /** 当前软件版本，作为每条 L1 的稳定标签。 */
  version: string;
  /** 用户标识，写入所有指标和告警。 */
  userId: string;
  /** 当前灰度策略，仅用于基础设施状态标签。 */
  canaryPolicy?: string;
  /** 每次定时触发时同步读取各 Input/Flusher 最新累计状态。 */
  getSnapshot: () => DataflowSnapshot;
  /** 可选进程内告警聚合器；缺失时不创建 30 秒告警 timer。 */
  alarmManager?: AlarmManager;
  /** 用于生成关闭消息采集的 Agent 列表。 */
  agentsConfig?: AgentsConfig;
  /** 用于生成 SLS project 标签。 */
  slsEndpoints?: SlsEndpoint[];
  /** 已解析的 CMS workspace 标签。 */
  cmsWorkspace?: string;
  /** 测试或平台可替换的 Updater 存活探针。 */
  updaterLiveness?: (pidFile: string) => ProcessLiveness;
}

/** 管理 L1/L2/告警三个后台周期任务。 */
export class MetricsWriter {
  /** 四类 JSONL 文件共同使用的 `<dataDir>/logs/metric_alarm` 目录。 */
  private readonly logsDir: string;
  /** 把累计快照转换成 L1/L2 宽表的无定时器采集器。 */
  private readonly collector: MetricsCollector;
  /** Orchestrator 注入的同步快照工厂；在每次任务开始时调用一次。 */
  private readonly getSnapshot: () => DataflowSnapshot;
  /** 告警未启用时为 null，使指标落盘仍可独立工作。 */
  private readonly alarmManager: AlarmManager | null;
  /** 10 分钟 L1 interval 句柄；null 表示未启动或已停止。 */
  private l1Timer: ReturnType<typeof setInterval> | null = null;
  /** 10 分钟 L2 interval 句柄。 */
  private l2Timer: ReturnType<typeof setInterval> | null = null;
  /** 30 秒告警消费 interval 句柄，仅有 AlarmManager 时创建。 */
  private alarmTimer: ReturnType<typeof setInterval> | null = null;
  /** 限制 userId 格式告警在单进程内最多记录一次。 */
  private userIdAlarmEmitted = false;
  /** 限制降级启动方式告警在单进程内最多记录一次。 */
  private startupAlarmEmitted = false;
  /** 每类基础设施告警最近触发时间，用于可恢复故障的冷却重置。 */
  private readonly lastInfraAlarmAt: Map<string, number> = new Map();

  /** @param opts 固定身份配置、实时 snapshot 回调及可选告警依赖。 */
  constructor(opts: MetricsWriterOptions) {
    this.logsDir = path.join(opts.dataDir, 'logs', 'metric_alarm');
    this.collector = new MetricsCollector({
      version: opts.version,
      userId: opts.userId,
      dataDir: opts.dataDir,
      agentsConfig: opts.agentsConfig,
      canaryPolicy: opts.canaryPolicy,
      slsEndpoints: opts.slsEndpoints,
      cmsWorkspace: opts.cmsWorkspace,
      updaterLiveness: opts.updaterLiveness,
    });
    this.getSnapshot = opts.getSnapshot;
    this.alarmManager = opts.alarmManager ?? null;
  }

  /** 创建日志目录、启动非保活定时器，并立即写首条 L1。 */
  async start(): Promise<void> {
    // ensureDir 是 best-effort；后续 appendLine 同样吞 I/O 错误，因此目录异常只会降低本地可观测性。
    await ensureDir(this.logsDir);

    // interval 回调不能 await，所以用 `void` 启动 Promise；若单次写入超过周期，理论上可能重叠执行。
    this.l1Timer = setInterval(() => void this.writeL1(), L1_INTERVAL_MS);
    // unref 后如果其他服务都已关闭，定时器不会让事件循环继续存活。
    this.l1Timer.unref();
    this.l2Timer = setInterval(() => void this.writeL2(), L2_INTERVAL_MS);
    this.l2Timer.unref();

    if (this.alarmManager) {
      this.alarmTimer = setInterval(() => void this.writeAlarms(), ALARM_FLUSH_INTERVAL_MS);
      this.alarmTimer.unref();
    }

    // 立即采集建立 CPU/吞吐基线，不必等待首个 10 分钟周期。
    await this.writeL1();
    logger.info('metrics-writer started');
  }

  /** 清除全部定时器并尽力写出最终 L1/L2/告警。 */
  async stop(): Promise<void> {
    // 先阻止后续调度，再做最终刷新；当前实现不跟踪已经开始的 interval Promise，可能与其短暂并发。
    if (this.l1Timer) {
      clearInterval(this.l1Timer);
      this.l1Timer = null;
    }
    if (this.l2Timer) {
      clearInterval(this.l2Timer);
      this.l2Timer = null;
    }
    if (this.alarmTimer) {
      clearInterval(this.alarmTimer);
      this.alarmTimer = null;
    }
    // 停止阶段顺序写入，保证当前调用自身按 L1 -> L2 -> 告警完成。
    await this.writeL1();
    await this.writeL2();
    await this.writeAlarms();
    logger.info('metrics-writer stopped');
  }

  /** 构建 L1、落盘、做阈值/基础设施检查并调用状态 sender。 */
  private async writeL1(): Promise<void> {
    try {
      // snapshot 是实时对象的同步汇总；采集器立即把所需数值复制到新指标结构。
      const snapshot = this.getSnapshot();
      const metrics = this.collector.collectL1(snapshot);
      const filePath = path.join(this.logsDir, 'pilot-metrics.jsonl');
      // appendLine 为 best-effort 并吞掉文件错误，所以 await 只表示追加尝试结束，不保证持久成功。
      await appendLine(filePath, JSON.stringify(metrics));

      // 本地写入尝试后再做告警检查和内部发送；三者互不提供事务一致性。
      this.checkThresholds(metrics);
      this.checkUserId();
      this.checkStartupMode(metrics);
      this.checkInfraHealth();
      // internal sender 是同步 fire-and-forget 门面，不在这里等待网络。
      sendStatus('pilot_status', flattenToStrings(metrics));
      sendRunningStatus(flattenToStrings(metrics));
    } catch (err) {
      logger.warn('L1 metrics write failed', { error: String(err) });
    }
  }

  /** CPU/内存超过固定阈值时聚合 PROCESS_RESOURCE_ALARM。 */
  private checkThresholds(metrics: { cpu: string; mem: string }): void {
    if (!this.alarmManager) return;

    // MetricsCollector 输出字符串宽表，此处只为数值比较临时 parse；NaN 不会命中 `>`。
    const cpuPercent = parseFloat(metrics.cpu);
    if (cpuPercent > CPU_THRESHOLD_PERCENT) {
      this.alarmManager.record(
        'PROCESS_RESOURCE_ALARM', '2',
        `CPU usage ${cpuPercent}% exceeds ${CPU_THRESHOLD_PERCENT}%`,
      );
    }

    const memMb = parseFloat(metrics.mem);
    if (memMb > MEM_THRESHOLD_MB) {
      this.alarmManager.record(
        'PROCESS_RESOURCE_ALARM', '2',
        `Memory usage ${memMb}MB exceeds ${MEM_THRESHOLD_MB}MB`,
      );
    }
  }

  /** 只在进程生命周期内检查一次花括号形式的疑似错误 userId。 */
  private checkUserId(): void {
    if (!this.alarmManager || this.userIdAlarmEmitted) return;
    const userId = this.collector.getUserId();
    // 只识别整个字符串被花括号包围的历史误配置，不对其他 userId 格式作强校验。
    if (/^\{.*\}$/.test(userId)) {
      this.userIdAlarmEmitted = true;
      this.alarmManager.record(
        'USER_ID_FORMAT_ALARM', '1',
        `userId "${userId}" contains braces, expected plain number like "123456"`,
      );
    }
  }

  /** nohup/unknown 启动方式无法保证重启后自恢复，仅告警一次。 */
  private checkStartupMode(metrics: L1Metrics): void {
    if (!this.alarmManager || this.startupAlarmEmitted) return;

    const initType = metrics.init_type;
    if (initType === 'nohup' || initType === 'unknown') {
      this.startupAlarmEmitted = true;
      this.alarmManager.record(
        'DEGRADED_STARTUP_ALARM', '2',
        `Service started without autostart registration (init_type=${initType}), will not survive reboot`,
      );
    }
  }

  // 基础设施故障可由运维在线修复，因此不用永久 once guard；冷却一小时后仍失败可再次告警。
  private recordInfraAlarm(
    type: 'UPDATER_NOT_RUNNING_ALARM' | 'BROKEN_VERSION_POINTER_ALARM' | 'INVALID_NODE_BIN_ALARM',
    level: '2' | '3',
    message: string,
  ): void {
    if (!this.alarmManager) return;
    const now = Date.now();
    // 冷却 key 只使用告警类型；同类故障的不同消息共享一个小时窗口。
    const last = this.lastInfraAlarmAt.get(type) ?? 0;
    if (now - last < INFRA_ALARM_COOLDOWN_MS) return;
    this.lastInfraAlarmAt.set(type, now);
    this.alarmManager.record(type, level, message);
  }

  /** 根据最近一次 L1 健康快照触发 Updater/current/node-bin 告警。 */
  private checkInfraHealth(): void {
    if (!this.alarmManager) return;

    const health = this.collector.getLastInfraHealth();
    if (!health) return;

    // Updater 连续两次探测失败才告警，降低启动竞态或单次扫描失败的噪声。
    if (health.updaterConsecutiveFailures >= 2) {
      this.recordInfraAlarm(
        'UPDATER_NOT_RUNNING_ALARM', '3',
        'Updater process is not running, automatic updates will not be applied',
      );
    }

    if (!health.currentVersionValid) {
      this.recordInfraAlarm(
        'BROKEN_VERSION_POINTER_ALARM', '2',
        'Version pointer (current) references a non-existent directory, service will fail on restart',
      );
    }

    if (!health.nodeBinValid) {
      this.recordInfraAlarm(
        'INVALID_NODE_BIN_ALARM', '2',
        'Node.js binary path (node-bin) is invalid or not executable, service will fail on restart',
      );
    }
  }

  /** 展开并逐行写 Input、Flusher 和 Input 健康三类 L2 指标。 */
  private async writeL2(): Promise<void> {
    try {
      const snapshot = this.getSnapshot();

      // 三类明细独立生成并使用不同文件/topic；某一段抛错会进入外层 catch 并跳过后续段。
      const inputMetrics = this.collector.collectL2Inputs(snapshot);
      if (inputMetrics.length > 0) {
        const inputPath = path.join(this.logsDir, 'pilot-input-metrics.jsonl');
        // 串行 append 保持同一采样内的 Map 顺序；appendLine 自身不保证写入成功。
        for (const m of inputMetrics) {
          await appendLine(inputPath, JSON.stringify(m));
        }
        // internal sender 是同步 fire-and-forget 门面，循环不会等待实际 HTTP 完成。
        for (const m of inputMetrics) {
          sendStatus('pilot_input_detail', flattenToStrings(m));
        }
      }

      const flusherMetrics = this.collector.collectL2Flushers(snapshot);
      if (flusherMetrics.length > 0) {
        const flusherPath = path.join(this.logsDir, 'pilot-flusher-metrics.jsonl');
        for (const m of flusherMetrics) {
          await appendLine(flusherPath, JSON.stringify(m));
        }
        for (const m of flusherMetrics) {
          sendStatus('pilot_flusher_detail', flattenToStrings(m));
        }
      }

      const alarmMetrics = this.collector.collectL2Alarms(snapshot);
      if (alarmMetrics.length > 0) {
        const alarmPath = path.join(this.logsDir, 'pilot-alarm-metrics.jsonl');
        for (const m of alarmMetrics) {
          await appendLine(alarmPath, JSON.stringify(m));
        }
        for (const m of alarmMetrics) {
          sendStatus('pilot_alarm_metric', flattenToStrings(m));
        }
      }
    } catch (err) {
      logger.warn('L2 metrics write failed', { error: String(err) });
    }
  }

  /** 消费 AlarmManager 当前聚合项，先落本地再调用内部 sender。 */
  private async writeAlarms(): Promise<void> {
    if (!this.alarmManager) return;
    try {
      // serialize 在返回数组前已经清空 Map；之后本地/远端失败不会自动回填或重试本批告警。
      const entries = this.alarmManager.serialize();
      if (entries.length === 0) return;
      const filePath = path.join(this.logsDir, 'pilot-alarms.jsonl');
      for (const entry of entries) {
        await appendLine(filePath, JSON.stringify(entry));
      }
      for (const entry of entries) {
        sendAlarm('pilot_alarm', flattenToStrings(entry));
      }
    } catch (err) {
      logger.warn('alarm write failed', { error: String(err) });
    }
  }
}
