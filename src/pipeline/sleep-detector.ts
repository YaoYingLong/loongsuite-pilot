/**
 * 系统睡眠/唤醒的事件循环延迟探测器。
 *
 * Node.js 定时器在机器睡眠期间暂停；预期 5 秒的 tick 若间隔超过 15 秒，就估算睡眠时长并
 * 发出 `wake`。PipelineManager 收到后刷新 watcher、reader 时间戳并立即重扫。
 */

import { EventEmitter } from 'node:events';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SleepDetector');

const CHECK_INTERVAL_MS = 5_000;
const SLEEP_THRESHOLD_MS = 15_000;

/** wake 监听器收到的估算睡眠时长。 */
export interface WakeEvent {
  sleepDurationMs: number;
}

/** 通过 EventEmitter 发布系统唤醒事件。 */
export class SleepDetector extends EventEmitter {
  private lastTickTime = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** 幂等启动非保活 tick 定时器。 */
  start(): void {
    if (this.timer) return;
    this.lastTickTime = Date.now();
    this.timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS);
    // unref 避免仅剩探测器时阻止进程退出。
    this.timer.unref();
  }

  /** 清理定时器和 wake 监听器，防止重启服务后重复回调。 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.removeAllListeners('wake');
  }

  /** 比较实际/预期间隔，并在超过阈值时同步 emit。 */
  private tick(): void {
    const now = Date.now();
    const elapsed = now - this.lastTickTime;
    this.lastTickTime = now;

    if (elapsed > SLEEP_THRESHOLD_MS) {
      // 扣除正常 tick 周期，得到近似真正睡眠时间。
      const sleepDurationMs = elapsed - CHECK_INTERVAL_MS;
      logger.info('system wake detected', {
        elapsedMs: elapsed,
        estimatedSleepMs: sleepDurationMs,
      });
      this.emit('wake', { sleepDurationMs } satisfies WakeEvent);
    }
  }
}
