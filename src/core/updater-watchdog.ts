/**
 * Collector 侧的独立 Updater 进程健康巡检器。
 *
 * 自动更新启用时，Orchestrator 周期检查 updater-runtime.json、PID 活性、命令行匹配
 * 和 heartbeat 新鲜度；睡眠唤醒与启动阶段设有宽限期。异常持续时通过稳定的
 * loongsuite-pilot CLI 子进程重启 Updater，并受冷却时间限制，同时向 AlarmManager
 * 上报状态。timer 不保持进程存活，`stop()` 只取消未来检查。
 */


import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { AlarmManager } from '../metrics/alarm-manager.js';
import { readJsonFile } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';
import { checkProcessLiveness, UPDATER_PROCESS_PATTERNS } from '../utils/pid-utils.js';
import type { ProcessLiveness } from '../utils/pid-utils.js';
import { updaterRuntimePath, type UpdaterRuntimeState } from '../updater/runtime-state.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('UpdaterWatchdog');

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_STALE_HEARTBEAT_MS = 3 * 60_000;
const DEFAULT_STARTUP_GRACE_MS = 3 * 60_000;
const DEFAULT_SLEEP_WAKE_GRACE_MS = 3 * 60_000;
const DEFAULT_RESTART_COOLDOWN_MS = 10 * 60_000;
const COMMAND_TIMEOUT_MS = 30_000;

/** 解析当前用户 HOME，兼容 Windows USERPROFILE。 */
function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
}

/** 返回稳定 CLI 路径；Windows 使用 ps1 入口。 */
function defaultPilotBinPath(): string {
  const ext = process.platform === 'win32' ? '.ps1' : '';
  return path.join(homeDir(), '.local', 'bin', `loongsuite-pilot${ext}`);
}

export type UpdaterWatchdogStatus =
  | 'disabled'
  | 'healthy'
  | 'missing-process'
  | 'command-mismatch'
  | 'missing-heartbeat'
  | 'stale-heartbeat'
  | 'pid-mismatch'
  | 'grace'
  | 'restart-rate-limited'
  | 'restart-attempted'
  | 'restart-failed';

export interface UpdaterWatchdogResult {
  status: UpdaterWatchdogStatus;
  reason?: string;
  restarted?: boolean;
}

export interface UpdaterWatchdogOptions {
  enabled: boolean;
  dataDir: string;
  loongsuitePilotBin?: string;
  intervalMs?: number;
  staleHeartbeatMs?: number;
  startupGraceMs?: number;
  sleepWakeGraceMs?: number;
  restartCooldownMs?: number;
  alarmManager?: AlarmManager;
  updaterLiveness?: (pidFile: string) => ProcessLiveness;
}

/**
 * Collector 侧 Updater 活性检查的第二道防线。
 *
 * 本类刻意不理解 manifest、版本比较、下载、指针或部署，只观察本地 Updater 进程与
 * heartbeat，并请求稳定 Runtime CLI 恢复。
 */
export class UpdaterWatchdog {
  private readonly enabled: boolean;
  private readonly dataDir: string;
  private readonly loongsuitePilotBin: string;
  private readonly intervalMs: number;
  private readonly staleHeartbeatMs: number;
  private readonly startupGraceMs: number;
  private readonly sleepWakeGraceMs: number;
  private readonly restartCooldownMs: number;
  private readonly alarmManager: AlarmManager | null;
  private readonly updaterLiveness: (pidFile: string) => ProcessLiveness;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = Date.now();
  private lastTickAt = 0;
  private sleepWakeGraceUntil = 0;
  private lastRestartAt = 0;

  /** 保存阈值、可替换活性探针与 AlarmManager；构造阶段不启动 timer。 */
  constructor(opts: UpdaterWatchdogOptions) {
    this.enabled = opts.enabled;
    this.dataDir = opts.dataDir;
    this.loongsuitePilotBin = opts.loongsuitePilotBin ?? defaultPilotBinPath();
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.staleHeartbeatMs = opts.staleHeartbeatMs ?? DEFAULT_STALE_HEARTBEAT_MS;
    this.startupGraceMs = opts.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS;
    this.sleepWakeGraceMs = opts.sleepWakeGraceMs ?? DEFAULT_SLEEP_WAKE_GRACE_MS;
    this.restartCooldownMs = opts.restartCooldownMs ?? DEFAULT_RESTART_COOLDOWN_MS;
    this.alarmManager = opts.alarmManager ?? null;
    this.updaterLiveness = opts.updaterLiveness
      ?? ((pidFile: string) => checkProcessLiveness(pidFile, UPDATER_PROCESS_PATTERNS));
  }

  /** 启用时立即异步检查一次，再按 interval 建立 unref timer。 */
  start(): void {
    if (!this.enabled) {
      logger.info('updater-watchdog disabled');
      return;
    }
    this.startedAt = Date.now();
    this.lastTickAt = 0;
    logger.info('updater-watchdog started', {
      intervalMs: this.intervalMs,
      staleHeartbeatMs: this.staleHeartbeatMs,
      restartCooldownMs: this.restartCooldownMs,
    });
    this.timer = setInterval(() => void this.runCheck(), this.intervalMs);
    this.timer.unref();
    void this.runCheck();
  }

  /** 清除周期 timer。 */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 检查 runtime heartbeat、PID 文件和命令行；健康返回状态，异常按宽限/冷却决定是否
   * 调 restart。调用被 timer 触发时错误会在本方法内转为结果与告警。
   */
  async runCheck(): Promise<UpdaterWatchdogResult> {
    if (!this.enabled) return { status: 'disabled' };

    const now = Date.now();
    if (this.lastTickAt > 0 && now - this.lastTickAt > this.intervalMs + this.sleepWakeGraceMs) {
      this.sleepWakeGraceUntil = now + this.sleepWakeGraceMs;
      logger.info('updater-watchdog sleep/wake grace started', {
        graceUntil: new Date(this.sleepWakeGraceUntil).toISOString(),
      });
    }
    this.lastTickAt = now;

    const processState = await this.readUpdaterProcess();
    if (!processState.running) {
      this.recordServiceAlarm(processState.reason);
      return this.restart('missing-process', processState.reason);
    }

    if (!processState.commandOk) {
      const reason = `updater pid ${processState.pid} command mismatch`;
      this.recordFailureAlarm(reason);
      return this.restart('command-mismatch', reason);
    }

    const heartbeat = await readJsonFile<UpdaterRuntimeState>(updaterRuntimePath(this.dataDir));
    if (!heartbeat) {
      const reason = 'updater heartbeat is missing';
      if (this.inGraceWindow(now)) return { status: 'grace', reason };
      this.recordFailureAlarm(reason);
      return this.restart('missing-heartbeat', reason);
    }

    if (processState.pid !== undefined && heartbeat.pid !== processState.pid && process.platform !== 'win32') {
      const reason = `updater heartbeat pid ${heartbeat.pid} does not match running pid ${processState.pid}`;
      if (this.inGraceWindow(now)) return { status: 'grace', reason };
      this.recordFailureAlarm(reason);
      return this.restart('pid-mismatch', reason);
    }

    const heartbeatAt = Date.parse(heartbeat.updatedAt);
    if (!Number.isFinite(heartbeatAt) || now - heartbeatAt > this.staleHeartbeatMs) {
      const reason = 'updater heartbeat is stale';
      if (this.inGraceWindow(now)) return { status: 'grace', reason };
      this.recordFailureAlarm(reason);
      return this.restart('stale-heartbeat', reason);
    }

    return { status: 'healthy' };
  }

  /** 读取 Updater runtime 状态并调用 pid-utils 验证进程身份。 */
  private async readUpdaterProcess(): Promise<{
    running: boolean;
    pid?: number;
    commandOk?: boolean;
    reason: string;
  }> {
    const pidFile = path.join(this.dataDir, 'loongsuite-pilot-updater.pid');
    const liveness = this.updaterLiveness(pidFile);
    if (!liveness.running) {
      if (liveness.pid !== undefined && liveness.pidFileProcessAlive && liveness.pidFileCommandMatched === false) {
        return {
          running: true,
          pid: liveness.pid,
          commandOk: false,
          reason: `unexpected updater command: ${liveness.pidFileCommand || 'unknown'}`,
        };
      }
      return { running: false, pid: liveness.pid, reason: liveness.reason };
    }

    return {
      running: true,
      pid: liveness.pid,
      commandOk: true,
      reason: liveness.reason,
    };
  }

  /** 判断仍处于启动或系统睡眠唤醒宽限窗口。 */
  private inGraceWindow(now: number): boolean {
    return now - this.startedAt < this.startupGraceMs || now < this.sleepWakeGraceUntil;
  }

  /**
   * 受冷却限制地执行 `loongsuite-pilot restart-updater` 子进程，并返回新的巡检结果。
   */
  private async restart(
    status: Exclude<UpdaterWatchdogStatus, 'disabled' | 'healthy' | 'grace' | 'restart-rate-limited' | 'restart-attempted' | 'restart-failed'>,
    reason: string,
  ): Promise<UpdaterWatchdogResult> {
    const now = Date.now();
    if (this.lastRestartAt > 0 && now - this.lastRestartAt < this.restartCooldownMs) {
      logger.warn('updater-watchdog restart skipped by cooldown', { reason });
      return { status: 'restart-rate-limited', reason, restarted: false };
    }

    this.lastRestartAt = now;
    try {
      if (process.platform === 'win32') {
        await execFileAsync('powershell.exe', [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          this.loongsuitePilotBin,
          'restart-updater',
        ], {
          timeout: COMMAND_TIMEOUT_MS,
          windowsHide: true,
        });
      } else {
        await execFileAsync(this.loongsuitePilotBin, ['restart-updater'], {
          timeout: COMMAND_TIMEOUT_MS,
        });
      }
      logger.warn('updater-watchdog requested updater restart', { status, reason });
      return { status: 'restart-attempted', reason, restarted: true };
    } catch (err) {
      const message = `updater restart command failed: ${String(err)}`;
      this.recordFailureAlarm(message);
      logger.error('updater-watchdog restart failed', { reason, error: String(err) });
      return { status: 'restart-failed', reason: message, restarted: false };
    }
  }

  /** 上报 Updater 服务不存在/身份异常类告警。 */
  private recordServiceAlarm(message: string): void {
    this.alarmManager?.record(
      'SERVICE_NOT_RUNNING_ALARM',
      '3',
      message,
      { input_name: 'updater' },
    );
  }

  /** 上报重启命令失败类告警。 */
  private recordFailureAlarm(message: string): void {
    this.alarmManager?.record(
      'UPDATER_FAILURE_ALARM',
      '2',
      message,
      { input_name: 'updater' },
    );
  }
}
