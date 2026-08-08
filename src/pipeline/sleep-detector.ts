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

/**
 * 通过 EventEmitter 发布系统唤醒事件。
 *
 * Node.js 没有跨平台统一的系统唤醒事件，本类用定时器实际触发间隔近似判断。`emit()` 会同步
 * 调用所有 listener；PipelineManager 的 listener 用 `void` 启动异步恢复，因此 tick 本身不会
 * 等待文件扫描结束。该估算也可能把事件循环长时间阻塞误判为睡眠，调用方的恢复操作需幂等。
 */
export class SleepDetector extends EventEmitter {
  private lastTickTime = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * 幂等启动非保活 tick 定时器。
   * `unref()` 表示只有该 timer 存在时 Node.js 可以自然退出；重复 start 不会注册第二个 timer。
   */
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

  /**
   * 比较实际/预期间隔，并在超过阈值时同步发布 `wake`。
   *
   * 无论是否达到阈值都先更新 `lastTickTime`，避免一次长延迟在后续 tick 被重复报告。
   */
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
