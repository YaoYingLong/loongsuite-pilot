/**
 * Runtime 包内 `worker.manifest.json` 的本地进程监督器。
 *
 * PluginProbeStrategy 和 LocalWorkerActivationService 通过本类按 manifest 启停 Worker。
 * 它解析 command/cwd/env 与 pid/status/log 路径，spawn 子进程并把 stdout/stderr 追加
 * 到日志；监督循环观察退出码，按 never/on-failure、最大次数和退避秒数决定重启。
 * 停止时向 detached 进程组发送信号并等待，状态直接写为 JSON。manifest 可通过绝对
 * 路径或实例占位符把 PID/状态/日志定向到实例隔离目录。
 */


import * as fs from 'node:fs/promises';
import { createWriteStream, type Dirent } from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createLogger } from '../utils/logger.js';
import { ensureDir, fileExists } from '../utils/fs-utils.js';

const logger = createLogger('WorkerManifestSupervisor');

/** Runtime 包内 worker.manifest.json 的进程启动契约。 */
export interface WorkerManifest {
  name: string;
  runtime?: string;
  version?: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  paths?: {
    pid?: string;
    status?: string;
    log?: string;
  };
  restartPolicy?: {
    type?: 'never' | 'on-failure';
    maxRestarts?: number;
    backoffSeconds?: number;
  };
}

interface ManifestLocation {
  manifestPath: string;
  bundleRoot: string;
}

interface WorkerRuntime {
  restarts: number;
  stopping: boolean;
}

export interface WorkerManifestOptions {
  /** ActivationService 提供的可信实例字段，例如 token、stateDir 和 workDir。 */
  instance?: Record<string, string>;
  /** `worker connect -- ...` 保存的用户可配置 Runtime 参数。 */
  runtimeOptions?: Record<string, string | boolean>;
}

/**
 * worker.manifest.json 驱动的轻量进程监管器。
 *
 * 负责定位并校验 manifest、展开实例占位符、启动独立进程组、持久化 PID/状态、汇总日志，
 * 以及按 manifest 的失败重启策略拉起进程。Local Worker 与普通 plugin-probe 共用该实现。
 */
export class WorkerManifestSupervisor {
  /** 仅保存当前进程启动的 Worker 运行态；跨 Collector 重启的信息通过 PID 文件恢复。 */
  private readonly runtimes = new Map<string, WorkerRuntime>();

  /**
   * 存在 manifest 时停止旧 Worker 并启动新实例；不存在时返回 true，便于普通插件包复用。
   * @param baseEnv PluginProbeStrategy 提供的基础环境。
   */
  async startIfPresent(
    agentId: string,
    installDir: string,
    env: Record<string, string>,
    options: WorkerManifestOptions = {},
  ): Promise<boolean> {
    const location = await this.findManifest(installDir);
    if (!location) return true;

    // 启动前总是尝试停止旧进程，防止包更新或参数变化后出现两个 Worker 并行运行。
    await this.stopIfPresent(agentId, installDir, options);

    const manifest = await this.readManifest(location.manifestPath);
    if (!manifest) return false;

    return this.start(agentId, location.bundleRoot, manifest, env, options);
  }

  /** 查找 manifest 并停止对应 Worker；manifest 不存在视为已停止。 */
  async stopIfPresent(
    agentId: string,
    installDir: string,
    options: WorkerManifestOptions = {},
  ): Promise<boolean> {
    const location = await this.findManifest(installDir);
    if (!location) return true;

    const manifest = await this.readManifest(location.manifestPath);
    if (!manifest) return false;

    return this.stop(agentId, location.bundleRoot, manifest, options);
  }

  /** 只检查安装目录或一级包根是否包含合法 manifest 路径。 */
  async hasManifest(installDir: string): Promise<boolean> {
    return !!await this.findManifest(installDir);
  }

  /** 展开实例路径、读取 PID 并用 signal 0 判断进程是否活跃。 */
  async isWorkerRunning(installDir: string, options: WorkerManifestOptions = {}): Promise<boolean> {
    const location = await this.findManifest(installDir);
    if (!location) return false;

    const manifest = await this.readManifest(location.manifestPath);
    if (!manifest) return false;

    const paths = this.resolvePaths(location.bundleRoot, manifest, options);
    const pid = await this.readPid(paths.pid);
    return !!pid && this.isAlive(pid);
  }

  /** 在 installDir 自身及一级子目录中定位 manifest，并返回真实 bundleRoot。 */
  private async findManifest(installDir: string): Promise<ManifestLocation | undefined> {
    // 同时兼容包内容直接落在 destDir，以及 tar 解压后额外包含一层顶级目录的结构。
    const direct = path.join(installDir, 'worker.manifest.json');
    if (await fileExists(direct)) {
      return { manifestPath: direct, bundleRoot: installDir };
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(installDir, { withFileTypes: true });
    } catch {
      return undefined;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const bundleRoot = path.join(installDir, entry.name);
      const manifestPath = path.join(bundleRoot, 'worker.manifest.json');
      if (await fileExists(manifestPath)) {
        return { manifestPath, bundleRoot };
      }
    }

    return undefined;
  }

  /** 解析 JSON 并验证 name/command 最小契约；坏文件记录警告后返回 undefined。 */
  private async readManifest(manifestPath: string): Promise<WorkerManifest | undefined> {
    try {
      const raw = await fs.readFile(manifestPath, 'utf-8');
      const parsed = JSON.parse(raw) as WorkerManifest;
      // name 和非空 command 是启动所需的最小契约，其余字段均有默认值或可选语义。
      if (!parsed.name || !Array.isArray(parsed.command) || parsed.command.length === 0) {
        logger.warn('invalid worker manifest', { manifestPath });
        return undefined;
      }
      return parsed;
    } catch (err) {
      logger.warn('failed to read worker manifest', { manifestPath, error: String(err) });
      return undefined;
    }
  }

  /**
   * 展开路径/命令/env，创建日志流并 detached spawn Worker；随后写 PID 和 running 状态，
   * 注册 exit/error 回调进入重启状态机。
   */
  private async start(
    agentId: string,
    bundleRoot: string,
    manifest: WorkerManifest,
    env: Record<string, string>,
    options: WorkerManifestOptions = {},
    runtime?: WorkerRuntime,
  ): Promise<boolean> {
    // PID、状态和日志路径也支持实例占位符，Local Worker 因而可以统一写回自己的目录。
    const paths = this.resolvePaths(bundleRoot, manifest, options);
    await ensureDir(path.dirname(paths.pid));
    await ensureDir(path.dirname(paths.status));
    await ensureDir(path.dirname(paths.log));

    // 在 spawn 前一次性展开命令、工作目录和环境变量，避免子进程依赖 Collector 内部状态。
    const command = manifest.command.map(part => this.expand(part, bundleRoot, env, options));
    const executable = this.resolveCommand(bundleRoot, command[0]);
    const args = command.slice(1);
    const cwd = this.resolvePath(bundleRoot, this.expand(manifest.cwd ?? '.', bundleRoot, env, options));
    const workerEnv = {
      ...env,
      ...this.expandEnv(manifest.env ?? {}, bundleRoot, env, options),
    };
    const log = createWriteStream(paths.log, { flags: 'a' });

    await this.writeStatus(paths.status, {
      state: 'starting',
      name: manifest.name,
      agentId,
      startedAt: new Date().toISOString(),
      restartCount: 0,
    });

    try {
      // detached=true 创建独立进程组，停止时可以连同 Worker 派生的子进程一起发送信号。
      const child = spawn(executable, args, {
        cwd,
        env: workerEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      let settled = false;
      let startPersisted = false;
      // 子进程可能在 PID/状态落盘前退出，先暂存退出信息，待 running 状态写完后统一处理。
      let earlyExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      // 启动阶段任一步骤失败时只执行一次：关日志、删 PID、写 failed 状态并释放运行态。
      const failStart = async (err: unknown): Promise<void> => {
        if (settled) return;
        settled = true;
        log.end();
        await fs.rm(paths.pid, { force: true });
        this.runtimes.delete(paths.pid);
        await this.writeStatus(paths.status, {
          state: 'failed',
          name: manifest.name,
          agentId,
          error: String(err),
          updatedAt: new Date().toISOString(),
        });
        logger.error('worker start failed', { agentId, error: String(err) });
      };

      // stdout/stderr 汇入同一追加日志；任一流结束都不能提前关闭共享文件流。
      child.stdout?.pipe(log, { end: false });
      child.stderr?.pipe(log, { end: false });
      child.once('error', err => {
        void failStart(err);
      });
      child.once('exit', (code, signal) => {
        if (settled) return;
        if (!startPersisted) {
          earlyExit = { code, signal };
          return;
        }
        settled = true;
        log.end();
        const activeRuntime = this.runtimes.get(paths.pid);
        if (activeRuntime) {
          void this.handleExit(agentId, bundleRoot, manifest, env, options, paths.pid, activeRuntime, code, signal);
        }
      });

      if (!child.pid) {
        await failStart(new Error('worker process did not expose a pid'));
        return false;
      }

      child.unref();
      if (settled) return false;

      // 重启沿用同一个 Runtime 计数器；首次启动则创建新的监管状态。
      const activeRuntime = runtime ?? { restarts: 0, stopping: false };
      this.runtimes.set(paths.pid, activeRuntime);
      await fs.writeFile(paths.pid, `${child.pid}\n`, 'utf-8');
      if (settled) return false;
      await this.writeStatus(paths.status, {
        state: 'running',
        name: manifest.name,
        agentId,
        pid: child.pid,
        startedAt: new Date().toISOString(),
        restartCount: runtime?.restarts ?? 0,
      });
      if (settled) return false;
      startPersisted = true;

      if (earlyExit) {
        settled = true;
        log.end();
        void this.handleExit(
          agentId,
          bundleRoot,
          manifest,
          env,
          options,
          paths.pid,
          activeRuntime,
          earlyExit.code,
          earlyExit.signal,
        );
      }

      logger.info('worker started', { agentId, pid: child.pid, manifest: manifest.name });
      return true;
    } catch (err) {
      log.end();
      await this.writeStatus(paths.status, {
        state: 'failed',
        name: manifest.name,
        agentId,
        error: String(err),
        updatedAt: new Date().toISOString(),
      });
      logger.error('worker start failed', { agentId, error: String(err) });
      return false;
    }
  }

  /**
   * 标记主动停止，取消待重启 timer，向整个进程组发 SIGTERM；5 秒后仍活跃则 SIGKILL，
   * 最后删除 PID 并写 stopped 状态。
   */
  private async stop(
    agentId: string,
    bundleRoot: string,
    manifest: WorkerManifest,
    options: WorkerManifestOptions = {},
  ): Promise<boolean> {
    const paths = this.resolvePaths(bundleRoot, manifest, options);
    const runtime = this.runtimes.get(paths.pid);
    if (runtime) runtime.stopping = true;

    const pid = await this.readPid(paths.pid);
    if (!pid) return true;

    await this.writeStatus(paths.status, {
      state: 'stopping',
      name: manifest.name,
      agentId,
      pid,
      updatedAt: new Date().toISOString(),
    });

    try {
      this.signalProcessGroup(pid, 'SIGTERM');
    } catch (err) {
      logger.warn('failed to stop worker', { agentId, pid, error: String(err) });
      return false;
    }

    await this.waitForExit(pid, 5000);
    try {
      // SIGTERM 后最多等待 5 秒，再防御性补发 SIGKILL；若进程组已退出则会被安全忽略。
      this.signalProcessGroup(pid, 'SIGKILL');
    } catch {
      // 两次检查之间进程组可能已经自行退出，此时无需视为停止失败。
    }

    await fs.rm(paths.pid, { force: true });
    await this.writeStatus(paths.status, {
      state: 'stopped',
      name: manifest.name,
      agentId,
      pid,
      stoppedAt: new Date().toISOString(),
    });
    logger.info('worker stopped', { agentId, pid });
    return true;
  }

  /**
   * 处理子进程退出并写状态。只有非零/信号退出、on-failure、非主动停止且次数未超限时，
   * 才按 backoffSeconds 安排下一次 start。
   */
  private async handleExit(
    agentId: string,
    bundleRoot: string,
    manifest: WorkerManifest,
    env: Record<string, string>,
    options: WorkerManifestOptions,
    runtimeKey: string,
    runtime: WorkerRuntime,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    const paths = this.resolvePaths(bundleRoot, manifest, options);
    await fs.rm(paths.pid, { force: true });

    const failed = code !== 0 || signal !== null;
    const policy = manifest.restartPolicy ?? {};
    const shouldRestart = !runtime.stopping
      && failed
      && policy.type === 'on-failure'
      && runtime.restarts < (policy.maxRestarts ?? 0);

    // 只有异常退出、策略为 on-failure、未主动停止且未超过次数上限时才自动重启。
    await this.writeStatus(paths.status, {
      state: shouldRestart ? 'restarting' : 'exited',
      name: manifest.name,
      agentId,
      exitCode: code,
      signal,
      restartCount: runtime.restarts,
      exitedAt: new Date().toISOString(),
    });

    if (!shouldRestart) {
      this.runtimes.delete(runtimeKey);
      return;
    }

    runtime.restarts += 1;
    const delayMs = Math.max(0, policy.backoffSeconds ?? 0) * 1000;
    setTimeout(() => {
      if (runtime.stopping) return;
      void this.start(agentId, bundleRoot, manifest, env, options, runtime);
    }, delayMs).unref();
  }

  /** 解析 PID/status/log 的 manifest 路径，未配置时使用包内 `.agent-worker` 默认目录。 */
  private resolvePaths(
    bundleRoot: string,
    manifest: WorkerManifest,
    options: WorkerManifestOptions = {},
  ): { pid: string; status: string; log: string } {
    // 普通 Plugin Worker 默认写入包内 .agent-worker；Local Worker 的 manifest 通常使用
    // `${instance:stateDir}` / `${instance:logDir}` 将文件重定向到实例隔离目录。
    const defaults = {
      pid: '.agent-worker/worker.pid',
      status: '.agent-worker/status.json',
      log: '.agent-worker/worker.log',
    };
    return {
      pid: this.resolvePath(bundleRoot, this.expand(manifest.paths?.pid ?? defaults.pid, bundleRoot, {}, options)),
      status: this.resolvePath(bundleRoot, this.expand(manifest.paths?.status ?? defaults.status, bundleRoot, {}, options)),
      log: this.resolvePath(bundleRoot, this.expand(manifest.paths?.log ?? defaults.log, bundleRoot, {}, options)),
    };
  }

  /** 合并基础环境与 manifest env，并对所有值执行占位符展开。 */
  private expandEnv(
    source: Record<string, string>,
    bundleRoot: string,
    env: Record<string, string>,
    options: WorkerManifestOptions,
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(source)) {
      result[key] = this.expand(value, bundleRoot, env, options);
    }
    return result;
  }

  /** 展开 `${bundleRoot}`、`${destDir}` 与 `${instance:<name>}`。 */
  private expand(
    value: string,
    bundleRoot: string,
    env: Record<string, string>,
    options: WorkerManifestOptions = {},
  ): string {
    // destDir 指向实际包根目录；instance 占位符同时承载固定实例字段和 Runtime 参数。
    return value
      .replace(/\$\{destDir\}/g, bundleRoot)
      .replace(/\$\{instance:([^}]+)\}/g, (_match, name: string) => this.expandInstanceValue(name, options));
  }

  /** 固定实例字段优先，再按原名和 kebab-case 查询用户 Runtime 参数。 */
  private expandInstanceValue(name: string, options: WorkerManifestOptions): string {
    // 固定实例字段优先，防止用户通过同名 Runtime 参数覆盖 token 路径、状态目录等关键值。
    const fixedValue = options.instance?.[name];
    if (fixedValue !== undefined) return fixedValue;

    // manifest 可使用 camelCase 名称，CLI 参数通常为 kebab-case；先精确匹配，再自动转换。
    const direct = options.runtimeOptions?.[name];
    if (direct !== undefined) return String(direct);

    const kebab = camelToKebab(name);
    const runtimeValue = options.runtimeOptions?.[kebab];
    return runtimeValue !== undefined ? String(runtimeValue) : '';
  }

  /** 相对路径命令锚定 bundleRoot，裸命令保留给 PATH 解析。 */
  private resolveCommand(bundleRoot: string, command: string): string {
    // 带路径语义的相对命令以包根目录为基准；裸命令名则交给操作系统 PATH 查找。
    if (path.isAbsolute(command)) return command;
    if (command.includes(path.sep) || command.startsWith('.')) {
      return path.join(bundleRoot, command);
    }
    return command;
  }

  /** 展开后的相对文件路径锚定 bundleRoot。 */
  private resolvePath(bundleRoot: string, value: string): string {
    return path.isAbsolute(value) ? value : path.join(bundleRoot, value);
  }

  /** 容错读取正整数 PID；文件缺失或非法返回 undefined。 */
  private async readPid(pidPath: string): Promise<number | undefined> {
    try {
      const raw = await fs.readFile(pidPath, 'utf-8');
      const pid = Number.parseInt(raw.trim(), 10);
      return Number.isFinite(pid) && pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  /** 确保父目录后直接覆盖写状态 JSON。 */
  private async writeStatus(statusPath: string, payload: Record<string, unknown>): Promise<void> {
    await ensureDir(path.dirname(statusPath));
    await fs.writeFile(statusPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  }

  /** 使用 signal 0 探测 PID；EPERM 也由 Node 表现为异常，当前按不活跃处理。 */
  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** 向负 PGID 发信号覆盖 detached 子进程组；ESRCH 返回 false，其他错误抛出。 */
  private signalProcessGroup(pgid: number, signal: NodeJS.Signals): boolean {
    try {
      // start() 使用 detached=true，子进程在 Linux/macOS 上会成为进程组组长。
      process.kill(-pgid, signal);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw err;
    }
  }

  /** 以 100ms 轮询等待退出，达到 timeout 后返回，不自行发送信号。 */
  private async waitForExit(pid: number, timeoutMs: number): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (!this.isAlive(pid)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

/** 将 manifest 中的 camelCase 占位符名称转换为 CLI 常用的 kebab-case 选项名。 */
function camelToKebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}
