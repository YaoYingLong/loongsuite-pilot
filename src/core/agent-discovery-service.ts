/**
 * Agent/Input 动态发现与生命周期状态机。
 *
 * `Orchestrator` 传入声明式 `AgentDetectionEntry`：既包括 Input 条目，也包括运行期
 * 新安装 Agent 的 `deploy:<id>` 条目。本服务优先用非持久化 `fs.watch` 响应路径变化，
 * 不支持 watch 时退化为定时轮询，并另设全局刷新。每个条目按
 * idle -> starting -> running -> stopping -> idle 串行调用 start/stop；退出时关闭所有
 * watcher、timer 和仍在运行的条目。
 */

import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type { AgentDetectionEntry, EntryState } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AgentDiscoveryService');

const DEFAULT_POLL_MS = 300_000; // 默认每 5 分钟轮询一次。
const FORCE_POLLING = process.env.LOONGSUITE_PILOT_FORCE_POLLING === 'true';

interface EntryRuntime {
  entry: AgentDetectionEntry;
  state: EntryState;
  watcher: fs.FSWatcher | null;
  pollTimer: ReturnType<typeof setInterval> | null;
}

/**
 * Agent 动态发现服务。
 *
 * 优先使用 `fs.watch` 监听候选路径，失败时回退到定时轮询。每个条目独立遵循
 * `idle -> starting -> running -> stopping -> idle` 状态机，避免重复启停同一个 Input
 * 或部署修复任务。
 */
export class AgentDiscoveryService extends EventEmitter {
  private readonly runtimes: Map<string, EntryRuntime> = new Map();
  private globalPollTimer: ReturnType<typeof setInterval> | null = null;

  /** @param entries Orchestrator 构造的 Input 与 deploy 动态发现条目。 */
  constructor(entries: AgentDetectionEntry[]) {
    super();
    for (const entry of entries) {
      this.runtimes.set(entry.id, {
        entry,
        state: 'idle',
        watcher: null,
        pollTimer: null,
      });
    }
  }

  /**
   * 为每个条目建立 watcher，立即串行刷新一次，再创建全局轮询 timer。
   * 首轮条目异常通常已在 processEntry 内隔离。
   */
  async start(): Promise<void> {
    for (const [id, rt] of this.runtimes) {
      this.setupWatcher(rt);
    }
    await this.refresh('startup');

    const intervalMs = Number(process.env.LOONGSUITE_PILOT_DISCOVERY_INTERVAL_MS) || DEFAULT_POLL_MS;
    this.globalPollTimer = setInterval(() => void this.refresh('poll'), intervalMs);
  }

  /**
   * 关闭全部 timer/watcher，并顺序停止处于 running/starting 的条目。
   * @returns 所有 stop 回调完成后兑现。
   */
  async stop(): Promise<void> {
    if (this.globalPollTimer) {
      clearInterval(this.globalPollTimer);
      this.globalPollTimer = null;
    }

    for (const rt of this.runtimes.values()) {
      if (rt.watcher) {
        rt.watcher.close();
        rt.watcher = null;
      }
      if (rt.pollTimer) {
        clearInterval(rt.pollTimer);
        rt.pollTimer = null;
      }
      if (rt.state === 'running' || rt.state === 'starting') {
        await this.stopEntry(rt);
      }
    }
  }

  /** 按注册顺序重新计算所有条目可用性；串行处理避免集中修改多个 Agent 配置。 */
  async refresh(trigger: string = 'manual'): Promise<void> {
    logger.debug('refresh triggered', { trigger });
    for (const rt of this.runtimes.values()) {
      await this.processEntry(rt);
    }
  }

  /** 返回每个条目状态的普通对象快照。 */
  getStates(): Record<string, EntryState> {
    const out: Record<string, EntryState> = {};
    for (const [id, rt] of this.runtimes) {
      out[id] = rt.state;
    }
    return out;
  }

  /**
   * 执行 enabled/isAvailable 判断并驱动状态转换。runOnActive 条目即使已 running 也会
   * 再调用 start，用于活跃时刷新部署；异常被记录并将状态退回 idle。
   */
  private async processEntry(rt: EntryRuntime): Promise<void> {
    const { entry } = rt;
    try {
      const enabled = entry.enabled ? entry.enabled() : true;
      const available = enabled ? await entry.isAvailable() : false;
      const shouldRun = enabled && available;

      if (!shouldRun && rt.state === 'idle') {
        logger.debug('agent skipped', {
          id: entry.id,
          enabled,
          available,
        });
      }

      if (shouldRun && rt.state !== 'running') {
        rt.state = 'starting';
        logger.info('starting agent', { id: entry.id });
        await entry.start();
        rt.state = 'running';
        this.emit('agent:started', entry.id);
      } else if (!shouldRun && (rt.state === 'running' || rt.state === 'starting')) {
        await this.stopEntry(rt);
      } else if (shouldRun && rt.state === 'running' && entry.runOnActive) {
        await entry.start();
      }
    } catch (err) {
      logger.error('processEntry failed', { id: entry.id, error: String(err) });
      rt.state = 'idle';
    }
  }

  /** 调用条目 stop；即使 stop 抛错也恢复 idle 并发出 agent:stopped。 */
  private async stopEntry(rt: EntryRuntime): Promise<void> {
    rt.state = 'stopping';
    try {
      await rt.entry.stop();
    } catch (err) {
      logger.warn('entry stop failed', { id: rt.entry.id, error: String(err) });
    }
    rt.state = 'idle';
    this.emit('agent:stopped', rt.entry.id);
  }

  /**
   * 尝试监听首个可用 watchPath；监听错误后关闭 watcher 并切换为 polling。
   * `persistent:false` 表示 watcher 本身不能阻止 Node 进程退出。
   */
  private setupWatcher(rt: EntryRuntime): void {
    if (FORCE_POLLING) {
      this.setupPolling(rt);
      return;
    }

    for (const watchPath of rt.entry.watchPaths) {
      try {
        const watcher = fs.watch(watchPath, { persistent: false }, () => {
          void this.processEntry(rt);
        });
        watcher.on('error', () => {
          watcher.close();
          this.setupPolling(rt);
        });
        rt.watcher = watcher;
        return;
      } catch {
        // 路径不存在或平台不支持监听时，继续尝试其他候选路径。
      }
    }

    this.setupPolling(rt);
  }

  /** 为条目创建兜底 interval；已有 timer 时保持幂等。 */
  private setupPolling(rt: EntryRuntime): void {
    if (rt.pollTimer) return;
    const interval = rt.entry.pollIntervalMs || DEFAULT_POLL_MS;
    rt.pollTimer = setInterval(() => void this.processEntry(rt), interval);
  }
}
