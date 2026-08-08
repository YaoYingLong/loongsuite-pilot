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
  dataDir: string;
  version: string;
  userId: string;
  canaryPolicy?: string;
  getSnapshot: () => DataflowSnapshot;
  alarmManager?: AlarmManager;
  agentsConfig?: AgentsConfig;
  slsEndpoints?: SlsEndpoint[];
  cmsWorkspace?: string;
  updaterLiveness?: (pidFile: string) => ProcessLiveness;
}

/** 管理 L1/L2/告警三个后台周期任务。 */
export class MetricsWriter {
  private readonly logsDir: string;
  private readonly collector: MetricsCollector;
  private readonly getSnapshot: () => DataflowSnapshot;
  private readonly alarmManager: AlarmManager | null;
  private l1Timer: ReturnType<typeof setInterval> | null = null;
  private l2Timer: ReturnType<typeof setInterval> | null = null;
  private alarmTimer: ReturnType<typeof setInterval> | null = null;
  private userIdAlarmEmitted = false;
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
    await ensureDir(this.logsDir);

    this.l1Timer = setInterval(() => void this.writeL1(), L1_INTERVAL_MS);
    // unref 后如果其他服务都已关闭，定时器不会让事件循环继续存活。
    this.l1Timer.unref();
    this.l2Timer = setInterval(() => void this.writeL2(), L2_INTERVAL_MS);
    this.l2Timer.unref();

    if (this.alarmManager) {
      this.alarmTimer = setInterval(() => void this.writeAlarms(), ALARM_FLUSH_INTERVAL_MS);
      this.alarmTimer.unref();
    }

    await this.writeL1();
    logger.info('metrics-writer started');
  }

  /** 清除全部定时器并尽力写出最终 L1/L2/告警。 */
  async stop(): Promise<void> {
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
    await this.writeL1();
    await this.writeL2();
    await this.writeAlarms();
    logger.info('metrics-writer stopped');
  }

  /** 构建 L1、落盘、做阈值/基础设施检查并调用状态 sender。 */
  private async writeL1(): Promise<void> {
    try {
      const snapshot = this.getSnapshot();
      const metrics = this.collector.collectL1(snapshot);
      const filePath = path.join(this.logsDir, 'pilot-metrics.jsonl');
      await appendLine(filePath, JSON.stringify(metrics));

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

      const inputMetrics = this.collector.collectL2Inputs(snapshot);
      if (inputMetrics.length > 0) {
        const inputPath = path.join(this.logsDir, 'pilot-input-metrics.jsonl');
        for (const m of inputMetrics) {
          await appendLine(inputPath, JSON.stringify(m));
        }
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
