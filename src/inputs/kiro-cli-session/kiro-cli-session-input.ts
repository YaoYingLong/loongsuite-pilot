// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Kiro CLI sidecar 文件的延迟采集调度器。
 *
 * 背景：Kiro CLI 在 Stop Hook 返回后，才异步把耗时信息写入
 * `~/.kiro/sessions/cli/<session_id>.json` 的 `user_turn_metadatas[]`。如果 Hook 当场同步读取，
 * 经常只能看到空数组或缺失的 turn，最终使 step 的 `time_unix_nano` 变成 0。
 *
 * 解决方式：Stop Hook 不解析会话，只把 cwd、offset、assistant_response、userId 等信息写为
 * `$PILOT_DATA/state/kiro-cli/pending-stops/ready/` 下的一条待处理记录，然后向守护进程发送
 * `SIGUSR1` 并立即返回 `{}`，因此不会阻塞 Kiro CLI。
 *
 * 收到信号后，本 Input 等待 `matureDelayMs`（默认 10 秒）再触发 `collect()`，让 sidecar 有时间
 * 完整落盘。采集周期通过 `rename ready/ -> inflight/` 原子认领记录，并创建 Node.js 子进程执行
 * `kiro-cli-hook-processor.mjs delayedCollect <pending-file>`。子进程读取成熟的 sidecar、构造带
 * 正确耗时的记录并追加到每日 Hook JSONL，随后由 `KiroCliLogInput` 走标准输入管道读取。
 *
 * BaseInput 的低频轮询（默认 60 秒）是信号丢失时的兜底。超过 `maxAgeMs`（默认 5 分钟）的记录
 * 会携带 `--allow-fallback` 强制处理，以当前可得的耗时信息输出，避免永久滞留。
 *
 * 启动时会把上次崩溃遗留的 inflight 文件退回 ready，停止时移除进程级信号监听器并清除定时器。
 * 注意本类本身始终返回空事件数组，真正的事件输出发生在子进程写 JSONL 后的 `KiroCliLogInput`。
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';

const DEFAULT_MATURE_DELAY_MS = 10_000;
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_SUBPROCESS_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONCURRENT_PROCESSES = 4;

export interface KiroCliSessionInputOptions extends InputOptions {
  /** Hook 处理器 `.mjs` 的绝对路径，例如 `<pilotDir>/hooks/kiro-cli-hook-processor.mjs`。 */
  hookProcessorPath: string;
  /** Pilot 数据根目录，例如 `~/.loongsuite-pilot`。 */
  dataDir: string;
  /** 待处理记录至少等待多少毫秒才可认领，默认 10 秒。 */
  matureDelayMs?: number;
  /** 等待超过多少毫秒后强制启用 `--allow-fallback`，默认 5 分钟。 */
  maxAgeMs?: number;
  /** 每个待处理文件允许子进程运行的最长毫秒数。 */
  subprocessTimeoutMs?: number;
  /** 单次采集周期最多并行处理的待处理文件数。 */
  maxConcurrent?: number;
}

interface PendingRecord {
  schemaVersion?: number;
  enqueueMs?: number;
  cwd?: string;
  stopUnixMs?: number;
  sinceMs?: number;
  sessionSinceMs?: number;
  assistantResponse?: string | null;
  userId?: string;
}

interface PendingItem {
  readyPath: string;
  record: PendingRecord;
}

/**
 * 协调 Kiro Stop Hook 与延迟 sidecar 解析子进程的 Input。
 *
 * Orchestrator 创建并启动此类；`BaseInput` 负责轮询串行化和停止等待，本类另外监听进程级
 * `SIGUSR1`。ready/inflight 目录组成一个轻量文件队列，原子重命名保证同一任务不会被并发领取。
 */
export class KiroCliSessionInput extends BaseInput {
  readonly id = 'kiro-cli-session';
  readonly agentType = ClientType.KiroCli;
  readonly collectionMethod = CollectionMethod.HookJsonl;

  private readonly hookProcessorPath: string;
  private readonly readyDir: string;
  private readonly inflightDir: string;
  private readonly pidFilePath: string;
  private readonly matureDelayMs: number;
  private readonly maxAgeMs: number;
  private readonly subprocessTimeoutMs: number;
  private readonly maxConcurrent: number;
  private pendingCollectTimer: ReturnType<typeof setTimeout> | null = null;
  private signalHandler: (() => void) | null = null;

  /**
   * 保存目录、延迟、超时与并发配置；此时不创建目录、不注册信号，也不启动子进程。
   * @param opts Input 通用依赖以及 Hook 处理器和数据目录配置。
   */
  constructor(opts: KiroCliSessionInputOptions) {
    super({
      stateStore: opts.stateStore,
      pollIntervalMs: opts.pollIntervalMs ?? 60_000,
    });
    this.hookProcessorPath = opts.hookProcessorPath;
    const pendingRoot = path.join(opts.dataDir, 'state', 'kiro-cli', 'pending-stops');
    this.readyDir = path.join(pendingRoot, 'ready');
    this.inflightDir = path.join(pendingRoot, 'inflight');
    this.pidFilePath = path.join(opts.dataDir, 'loongsuite-pilot.pid');
    this.matureDelayMs = opts.matureDelayMs ?? DEFAULT_MATURE_DELAY_MS;
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.subprocessTimeoutMs = opts.subprocessTimeoutMs ?? DEFAULT_SUBPROCESS_TIMEOUT_MS;
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_PROCESSES;
  }

  /** 返回发现服务可监听的待处理队列根目录，不会访问文件系统。 */
  static getWatchPaths(dataDir = resolveHome('~/.loongsuite-pilot')): string[] {
    return [path.join(dataDir, 'state', 'kiro-cli', 'pending-stops')];
  }

  /**
   * 检查延迟采集所需的 Hook 处理器是否可访问。
   * @returns 文件可访问时为 `true`；不存在或无权限时为 `false`，不向上抛出该检查错误。
   */
  static async checkAvailability(
    hookProcessorPath: string,
  ): Promise<boolean> {
    try {
      await fs.access(hookProcessorPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * BaseInput 启动阶段回调：创建队列目录、恢复崩溃任务并注册 `SIGUSR1` 监听器。
   * @throws 目录创建或恢复操作失败时错误会交给 `BaseInput.start()` 处理。
   */
  protected override async onStart(): Promise<void> {
    await this.ensureDirs();
    // 上次进程崩溃时可能来不及完成 inflight 任务；先退回 ready，保证可以重试。
    const recovered = await this.recoverInflight();
    if (recovered > 0) {
      this.logger.info('recovered inflight pending-stops', { count: recovered });
    }
    // Stop Hook 入队后发送 SIGUSR1。每次信号都重置同一个定时器，避免密集信号堆积多次 collect()。
    // 必须调用 requestCollection() 而非直接调用 collect()，这样信号和轮询都会经过 BaseInput 的
    // runCycle 串行化；停止流程也能等待信号触发的采集周期结束。
    //
    // SIGUSR1 属于进程全局信号，Node.js 会调用全部同名监听器。目前只有本类使用；如果将来还有
    // 组件需要 SIGUSR1，应改用命名管道或标记文件等定向 IPC，避免每次 Kiro 事件误触发其他组件。
    this.signalHandler = () => {
      if (this.pendingCollectTimer) clearTimeout(this.pendingCollectTimer);
      this.pendingCollectTimer = setTimeout(() => {
        this.pendingCollectTimer = null;
        this.requestCollection();
      }, this.matureDelayMs);
    };
    process.on('SIGUSR1', this.signalHandler);
  }

  /** 停止阶段移除进程信号监听器并取消尚未触发的延迟采集定时器。 */
  protected override async onStop(): Promise<void> {
    if (this.signalHandler) {
      process.off('SIGUSR1', this.signalHandler);
      this.signalHandler = null;
    }
    if (this.pendingCollectTimer) {
      clearTimeout(this.pendingCollectTimer);
      this.pendingCollectTimer = null;
    }
  }

  /**
   * 找出已经成熟的 ready 记录，并在并发上限内交给子进程处理。
   * @returns 始终为空数组；子进程写出的 JSONL 之后由 `KiroCliLogInput` 发出。
   */
  protected async collect(): Promise<AgentActivityEntry[]> {
    // 防止停止过程中的竞态：定时器可能恰好在 running 置为 false 与 clearTimeout 之间触发。
    if (!this.running) return [];
    await this.ensureDirs();
    const items = await this.listReady();
    if (items.length === 0) return [];

    const now = Date.now();
    const due: PendingItem[] = [];
    for (const item of items) {
      const stopMs = item.record.stopUnixMs ?? item.record.enqueueMs ?? 0;
      if (stopMs > 0 && now - stopMs < this.matureDelayMs) continue;
      due.push(item);
      if (due.length >= this.maxConcurrent) break;
    }
    if (due.length === 0) return [];

    await Promise.all(due.map((item) => this.processOne(item, now)));
    // 本 Input 不直接发事件；下游可见数据来自 KiroCliLogInput 对子进程追加 JSONL 的读取。
    return [];
  }

  /** 原子认领一个任务，按处理器状态删除或退回任务；异常时保留任务以供后续轮询重试。 */
  private async processOne(item: PendingItem, nowMs: number): Promise<void> {
    const claimed = await this.claim(item.readyPath);
    // rename 失败通常说明另一个周期或恢复流程已经取得该文件，本周期无需重复处理。
    if (!claimed) return;

    const stopMs = item.record.stopUnixMs ?? item.record.enqueueMs ?? nowMs;
    const allowFallback = nowMs - stopMs >= this.maxAgeMs;
    const args: string[] = ['delayedCollect', claimed];
    if (allowFallback) args.push('--allow-fallback');

    try {
      const status = await this.spawnProcessor(args);
      if (status === 'ok' || status === 'no_data') {
        await this.discardInflight(claimed);
      } else if (status === 'timing_pending') {
        await this.releaseInflight(claimed);
      } else {
        // 未知状态也退回队列；任务达到 maxAgeMs 后会自动启用 fallback，避免无期限重试。
        await this.releaseInflight(claimed);
      }
    } catch (err) {
      this.logger.warn('delayedCollect spawn failed', {
        file: claimed,
        error: String(err),
      });
      // 子进程失败时退回队列；持续失败的老任务最终会通过 maxAgeMs 分支强制 fallback。
      await this.releaseInflight(claimed);
    }
  }

  /**
   * 创建独立 Node.js 子进程执行 Hook 处理器，并把其 stdout 中的状态解析为字符串。
   * @throws 启动失败、超时或非零退出码时拒绝 Promise；调用方负责记录并重新排队。
   */
  private spawnProcessor(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [this.hookProcessorPath, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGKILL'); } catch { /* 忽略终止阶段的二次错误。 */ }
        reject(new Error(`delayedCollect timeout after ${this.subprocessTimeoutMs}ms`));
      }, this.subprocessTimeoutMs);

      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`delayedCollect exit ${code}: ${stderr.trim().slice(0, 200)}`));
          return;
        }
        resolve(parseStatus(stdout));
      });
    });
  }

  /** 读取并解析 ready 目录，删除无法解析的坏 JSON，再按入队时间从早到晚排序。 */
  private async listReady(): Promise<PendingItem[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.readyDir);
    } catch {
      return [];
    }
    const items: PendingItem[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
      const readyPath = path.join(this.readyDir, name);
      try {
        const raw = await fs.readFile(readyPath, 'utf-8');
        const record = JSON.parse(raw) as PendingRecord;
        items.push({ readyPath, record });
      } catch {
        // 损坏记录无法恢复；删除它，避免每个轮询周期都被同一个文件干扰。
        try { await fs.unlink(readyPath); } catch { /* 删除失败时忽略，后续周期仍会重试。 */ }
      }
    }
    items.sort((a, b) => (a.record.enqueueMs ?? 0) - (b.record.enqueueMs ?? 0));
    return items;
  }

  /** 通过同一文件系统内的原子 rename 把 ready 任务认领为 inflight。 */
  private async claim(readyPath: string): Promise<string | null> {
    const base = path.basename(readyPath);
    const inflightPath = path.join(this.inflightDir, base);
    try {
      await fs.rename(readyPath, inflightPath);
      return inflightPath;
    } catch {
      return null;
    }
  }

  /** 任务成功或确认无数据后删除 inflight 标记；删除失败按 fail-open 处理。 */
  private async discardInflight(inflightPath: string): Promise<void> {
    try { await fs.unlink(inflightPath); } catch { /* 清理失败按 fail-open 处理。 */ }
  }

  /** 把可重试任务移回 ready；若无法回移则删除残留，避免队列卡死。 */
  private async releaseInflight(inflightPath: string): Promise<void> {
    const base = path.basename(inflightPath);
    const readyPath = path.join(this.readyDir, base);
    try {
      await fs.rename(inflightPath, readyPath);
    } catch {
      try { await fs.unlink(inflightPath); } catch { /* 回移和删除均失败时等待后续恢复。 */ }
    }
  }

  /** 启动时将崩溃遗留的 inflight 文件恢复到 ready，并返回成功恢复的数量。 */
  private async recoverInflight(): Promise<number> {
    let names: string[];
    try {
      names = await fs.readdir(this.inflightDir);
    } catch {
      return 0;
    }
    let n = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const inflightPath = path.join(this.inflightDir, name);
      const readyPath = path.join(this.readyDir, name);
      try {
        await fs.rename(inflightPath, readyPath);
        n++;
      } catch {
        try { await fs.unlink(inflightPath); } catch { /* 无法恢复的残留留待下次启动处理。 */ }
      }
    }
    return n;
  }

  /** 递归创建 ready 和 inflight 目录；目录已存在时不会报错。 */
  private async ensureDirs(): Promise<void> {
    await fs.mkdir(this.readyDir, { recursive: true });
    await fs.mkdir(this.inflightDir, { recursive: true });
  }
}

/** 从 Hook 处理器的多行 stdout 中找出第一条含字符串 `status` 的 JSON 对象。 */
function parseStatus(stdout: string): string {
  // 子命令先写 `{status:<s>}\n`，dispatcher 的 finally 又固定追加 fail-open 默认值 `{}`。
  // 因此不能只取最后一行，否则所有任务都会被误判为 unknown 并反复退回 ready。
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.status === 'string') return obj.status;
    } catch {
      // stdout 可能混有普通日志或不完整 JSON；忽略当前行并继续寻找真正的状态对象。
    }
  }
  return 'unknown';
}

// 重新导出通用目录检查函数，供已有外部调用者继续从本模块导入。
export { directoryExists };
