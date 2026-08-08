/**
 * Updater 事件、运行状态及 Collector 健康告警记录器。
 *
 * Updater 在检查、下载、部署、重启和失败阶段调用 `record()`；本类把事件缓冲后周期
 * 写本地 JSONL/内部 sender，并持续检查 Collector PID、命令行和启动崩溃 breadcrumb。
 * 连续健康失败达到阈值才告警，且有一小时冷却，避免短暂重启造成噪声。`start()` 创建
 * 多个 timer，`stop()` 清理并 flush；发送失败被记录但不改变更新事务结果。
 */



import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendLine, ensureDir } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';
import { resolveLocalIp } from '../utils/network-utils.js';
import { flattenToStrings } from '../utils/record-utils.js';
import { checkProcessLiveness, COLLECTOR_PROCESS_PATTERNS } from '../utils/pid-utils.js';
import type { ProcessLiveness } from '../utils/pid-utils.js';
import { readStartupCrash } from '../utils/crash-breadcrumb.js';
import { classifyStartupCrash } from './startup-crash-classifier.js';
import { sendAlarm, sendStatus } from '../internal/sender.js';
import type { AlarmLevel, AlarmType, AlarmEntry } from '../metrics/alarm-manager.js';

const logger = createLogger('UpdaterMetrics');

const COLLECTOR_HEALTH_INTERVAL_MS = 60_000;
const COLLECTOR_HEALTH_STARTUP_GRACE_MS = 3 * 60_000;
const COLLECTOR_HEALTH_FAILURE_THRESHOLD = 2;
const COLLECTOR_HEALTH_ALARM_COOLDOWN_MS = 60 * 60_000;
const FLUSH_INTERVAL_MS = 30_000;

export type UpdaterEventType =
  | 'updater_started'
  | 'updater_stopped'
  | 'new_version_available'
  | 'downloading'
  | 'download_verified'
  | 'deployed'
  | 'collector_restarted'
  | 'update_failure'
  | 'updater_stopped_max_failures';

export interface UpdaterEvent {
  event_type: UpdaterEventType;
  version: string;
  current_version?: string;
  latest_version?: string;
  error?: string;
  consecutive_failures?: number;
  user_id: string;
  ip: string;
  __time__: number;
}

export interface UpdaterMetricsOptions {
  dataDir: string;
  version: string;
  collectorPidFile: string;
  userId: string;
  collectorLiveness?: (pidFile: string) => ProcessLiveness;
}

/**
 * Updater 专用事件/告警缓冲器和 Collector 活性探针。
 *
 * 事件先进入内存队列，每 30 秒 flush 到本地 metric_alarm JSONL 并调用内部 sender；
 * Collector 每分钟检查，启动宽限 3 分钟、连续两次失败、一小时告警冷却。
 */
export class UpdaterMetrics {
  private readonly logsDir: string;
  private readonly dataDir: string;
  private readonly version: string;
  private readonly ip: string;
  private readonly userId: string;
  private readonly collectorPidFile: string;
  private readonly collectorLiveness: (pidFile: string) => ProcessLiveness;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private eventQueue: UpdaterEvent[] = [];
  private alarmQueue: AlarmEntry[] = [];
  private userIdAlarmEmitted = false;
  private startedAt = 0;
  private collectorConsecutiveFailures = 0;
  private lastCollectorAlarmAt = 0;

  /** 保存路径、身份和可注入活性探针；构造阶段不创建 timer。 */
  constructor(opts: UpdaterMetricsOptions) {
    this.logsDir = path.join(opts.dataDir, 'logs', 'metric_alarm');
    this.dataDir = opts.dataDir;
    this.version = opts.version;
    this.collectorPidFile = opts.collectorPidFile;
    this.collectorLiveness = opts.collectorLiveness
      ?? ((pidFile: string) => checkProcessLiveness(pidFile, COLLECTOR_PROCESS_PATTERNS));
    this.userId = opts.userId;
    this.ip = resolveLocalIp();
  }

  /** 确保日志目录并启动 unref 健康/flush timer，随后立即检查一次 Collector。 */
  async start(): Promise<void> {
    this.startedAt = Date.now();
    await ensureDir(this.logsDir);
    this.healthTimer = setInterval(
      () => void this.checkCollectorHealth(),
      COLLECTOR_HEALTH_INTERVAL_MS,
    );
    this.healthTimer.unref();
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
    void this.checkCollectorHealth();
  }

  /** 清 timer 并等待最后一批队列 flush。 */
  async stop(): Promise<void> {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  /** 组装公共 version/user/ip/秒时间戳并入事件队列；不立即 I/O。 */
  writeEvent(
    eventType: UpdaterEventType,
    extra?: Partial<Omit<UpdaterEvent, 'event_type' | 'version' | 'user_id' | 'ip' | '__time__'>>,
  ): void {
    this.eventQueue.push({
      event_type: eventType,
      version: this.version,
      ...extra,
      user_id: this.userId,
      ip: this.ip,
      __time__: Math.floor(Date.now() / 1000),
    });
  }

  /** 组装统一 AlarmEntry 并入告警队列。 */
  writeAlarm(type: AlarmType, level: AlarmLevel, message: string): void {
    this.alarmQueue.push({
      alarm_type: type,
      alarm_level: level,
      alarm_message: message,
      alarm_count: '1',
      user_id: this.userId,
      ip: this.ip,
      ver: this.version,
      __time__: Math.floor(Date.now() / 1000),
    });
  }

  /**
   * 首次检测可疑 userId 后补告警，交换队列快照，再分别写本地并调用 sender。写盘失败只
   * 告警，队列不会回放；sender 的错误语义由内部实现负责。
   */
  private async flush(): Promise<void> {
    if (!this.userIdAlarmEmitted && /^\{.*\}$/.test(this.userId)) {
      this.userIdAlarmEmitted = true;
      this.writeAlarm(
        'USER_ID_FORMAT_ALARM', '1',
        `userId "${this.userId}" contains braces, expected plain number like "123456"`,
      );
    }

    const events = this.eventQueue;
    const alarms = this.alarmQueue;
    if (events.length === 0 && alarms.length === 0) return;
    this.eventQueue = [];
    this.alarmQueue = [];

    if (events.length > 0) {
      try {
        const filePath = path.join(this.logsDir, 'pilot-updater-events.jsonl');
        for (const ev of events) {
          await appendLine(filePath, JSON.stringify(ev));
        }
      } catch (err) {
        logger.warn('updater event write failed', { error: String(err) });
      }
      for (const ev of events) {
        sendStatus('pilot_updater_event', flattenToStrings(ev));
      }
    }

    if (alarms.length > 0) {
      try {
        const filePath = path.join(this.logsDir, 'pilot-alarms.jsonl');
        for (const al of alarms) {
          await appendLine(filePath, JSON.stringify(al));
        }
      } catch (err) {
        logger.warn('updater alarm write failed', { error: String(err) });
      }
      for (const al of alarms) {
        sendAlarm('pilot_alarm', flattenToStrings(al));
      }
    }
  }

  /**
   * 结合 PID 文件和进程扫描判断 Collector。恢复时清失败计数；宽限后连续失败达阈值且
   * 超过冷却才排入 SERVICE_NOT_RUNNING_ALARM。
   */
  private checkCollectorHealth(): void {
    const liveness = this.collectorLiveness(this.collectorPidFile);
    if (liveness.running) {
      if (this.collectorConsecutiveFailures > 0 || liveness.source === 'process-scan') {
        logger.warn('collector liveness recovered or pid file inconsistent', {
          source: liveness.source,
          reason: liveness.reason,
          pid: liveness.pid,
          pidFileState: liveness.pidFileState,
        });
      }
      this.collectorConsecutiveFailures = 0;
      return;
    }

    const now = Date.now();
    if (now - this.startedAt < COLLECTOR_HEALTH_STARTUP_GRACE_MS) {
      logger.warn('collector process not running during startup grace', { reason: liveness.reason });
      return;
    }

    this.collectorConsecutiveFailures++;
    logger.warn('collector process not running', {
      reason: liveness.reason,
      consecutiveFailures: this.collectorConsecutiveFailures,
    });

    if (this.collectorConsecutiveFailures < COLLECTOR_HEALTH_FAILURE_THRESHOLD) return;
    if (now - this.lastCollectorAlarmAt < COLLECTOR_HEALTH_ALARM_COOLDOWN_MS) return;

    this.lastCollectorAlarmAt = now;
    this.writeAlarm(
      'SERVICE_NOT_RUNNING_ALARM', '3',
      this.buildNotRunningMessage(liveness.reason),
    );
  }

  // 活性防抖确认缺失后，把 Collector 写下的真实启动原因补进 message，不改变告警 schema。
  /** 读取 startup crash breadcrumb 并拼稳定 cause/detail/phase/version。 */
  private buildNotRunningMessage(livenessReason: string): string {
    const base = `loongsuite-pilot collector process is not running after ${this.collectorConsecutiveFailures} checks: ${livenessReason}`;
    const breadcrumb = readStartupCrash(this.dataDir);
    if (!breadcrumb) return base;
    const { reason, detailHead } = classifyStartupCrash(breadcrumb);
    return `${base} | cause=${reason} detail="${detailHead}" phase=${breadcrumb.phase} version=${breadcrumb.version}`;
  }
}

