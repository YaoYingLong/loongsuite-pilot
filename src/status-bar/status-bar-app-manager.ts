/**
 * macOS 原生状态栏 App 的安装校验与子进程生命周期管理器。
 *
 * Orchestrator 仅在 darwin 且配置开启时调用本类。它定位随包发布的二进制，计算指纹
 * 和版本，将 runtime 元数据写到数据目录，并用 detached spawn 启动 App；已有 PID/
 * lock 会先校验，避免重复实例。停止时先发送温和信号并轮询，超时后强制结束，同时
 * 清理状态文件。非 macOS、二进制缺失或 Xcode 签名辅助失败均按可选功能记录处理。
 */


import { existsSync, closeSync, openSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);
import { createHash } from 'node:crypto';
import { writeJsonFile, readJsonFile, ensureDir } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('StatusBarAppManager');

const BINARY_NAME = 'LoongSuitePilotMenuBarApp';
const STOP_TIMEOUT_MS = 3000;
const FORCE_STOP_TIMEOUT_MS = 1500;
const DEFAULT_XCODE_DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';

interface StatusBarAppRuntime {
  executablePath: string;
  packageVersion: string;
  pid: number | null;
  executableFingerprint: string | null;
  updatedAt: string;
}

/**
 * macOS 菜单栏 App 的期望状态收敛器和进程资源拥有者。
 *
 * Orchestrator 根据 statusBar.enabled 调用 `syncDesiredState()`，配置重载或退出时调用
 * `stop()`。本类读取/写入 App runtime 元数据，可能调用 `swift build`、`codesign`、
 * `pgrep`，并以 detached 子进程启动 App。非 macOS 直接无操作；可选 App 的构建失败
 * 会记录日志而不阻断 Collector，停止流程负责发送信号并清理运行记录。
 */
export class StatusBarAppManager {
  private readonly dataDir: string;
  private readonly packageVersion: string;

  /** 保存数据目录和期望包版本；构造阶段不检查平台或二进制。 */
  constructor(options: { dataDir: string; packageVersion: string }) {
    this.dataDir = options.dataDir;
    this.packageVersion = options.packageVersion;
  }

  /** 非 macOS 无操作；enabled=true 确保启动，false 走完整 stop。 */
  async syncDesiredState(enabled: boolean): Promise<void> {
    if (process.platform !== 'darwin') return;

    if (enabled) {
      await this.ensureStarted();
    } else {
      await this.stop('config-disabled');
    }
  }

  /**
   * 读取 runtime PID、清锁并查找同名孤儿进程；先 SIGTERM 等待，再 SIGKILL，最后删除
   * runtime 记录。reason 只用于日志。
   */
  async stop(reason: string): Promise<void> {
    if (process.platform !== 'darwin') return;

    const runtime = await this.readRuntimeRecord();
    const stoppedPids = new Set<number>();

    if (runtime?.pid) {
      if (await this.isProcessRunning(runtime.pid, runtime.executablePath)) {
        this.sendSignal(runtime.pid, 'SIGTERM');
        stoppedPids.add(runtime.pid);
      }
    }

    // 同时清理没有被 runtime 记录覆盖的同名孤儿进程。
    const orphans = await this.findRunningPids();
    for (const pid of orphans) {
      if (!stoppedPids.has(pid)) {
        this.sendSignal(pid, 'SIGTERM');
        stoppedPids.add(pid);
      }
    }

    // 先等待温和退出，超时后再强制结束。
    for (const pid of stoppedPids) {
      const exited = await this.waitForExit(pid, STOP_TIMEOUT_MS);
      if (!exited) {
        this.sendSignal(pid, 'SIGKILL');
        await this.waitForExit(pid, FORCE_STOP_TIMEOUT_MS);
      }
    }

    await this.removeRuntimeRecord();

    if (stoppedPids.size > 0) {
      logger.info(`status bar app stopped (${reason})`, { pids: Array.from(stoppedPids) });
    }
  }

  /** 解析/构建可执行文件；正确版本已运行则复用，否则停旧进程并 spawn。 */
  private async ensureStarted(): Promise<void> {
    const runtime = await this.readRuntimeRecord();

    // 正确版本和二进制指纹的进程已运行时直接返回。
    if (runtime?.pid && await this.isProcessRunning(runtime.pid, runtime.executablePath)) {
      if (runtime.packageVersion === this.packageVersion) {
        logger.debug('status bar app already running', { pid: runtime.pid });
        return;
      }
      logger.info('replacing stale status bar app', {
        oldVersion: runtime.packageVersion,
        newVersion: this.packageVersion,
      });
      await this.stop('version-upgrade');
    }

    // 优先复用随包发布或之前构建好的二进制；不存在时才尝试源码构建。
    const executablePath = this.resolveExecutable();
    if (!executablePath) {
      logger.info('status bar app binary not available, attempting build');
      const built = await this.buildExecutable();
      if (!built) {
        logger.warn('status bar app not available (no binary, build failed or not possible)');
        return;
      }
      return this.spawnProcess(built);
    }

    return this.spawnProcess(executablePath);
  }

  /**
   * 创建排他锁后 detached spawn 原生 App，把 stdout/stderr 追加到日志，并写 runtime。
   * spawn 失败会关闭锁 fd 并向上抛出。
   */
  private async spawnProcess(executablePath: string): Promise<void> {
    const logPath = await this.prepareLogPath();
    let child;
    const logFd = openSync(logPath, 'a');
    try {
      child = spawn(executablePath, [], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: {
          ...process.env,
          HOME: process.env.HOME,
          LOONGSUITE_PILOT_DATA_DIR: this.dataDir,
        },
      });
    } finally {
      closeSync(logFd);
    }

    if (!child.pid) {
      logger.warn('spawn returned no pid, status bar app may not have started');
      return;
    }

    child.unref();

    await this.writeRuntimeRecord({
      executablePath,
      packageVersion: this.packageVersion,
      pid: child.pid,
      executableFingerprint: await this.fingerprint(executablePath),
      updatedAt: new Date().toISOString(),
    });

    logger.info('status bar app started', { pid: child.pid, executablePath });
  }

  /** 按随包二进制、历史本地构建顺序寻找可执行文件。 */
  private resolveExecutable(): string | null {
    const sourceDir = this.resolveSourceDir();
    if (!sourceDir || !existsSync(path.join(sourceDir, 'Package.swift'))) {
      return null;
    }

    // 优先检查随当前版本发布的二进制。
    const arch = process.arch;
    const candidates = ['darwin-universal'];
    if (arch === 'arm64') candidates.push('darwin-arm64');
    else if (arch === 'x64') candidates.push('darwin-x64');

    for (const bundle of candidates) {
      const candidate = path.join(sourceDir, 'bin', bundle, BINARY_NAME);
      if (existsSync(candidate)) return candidate;
    }

    // 再检查此前在数据目录本地编译的二进制。
    const builtPath = path.join(this.dataDir, 'apps', 'macos-status-bar', 'build', BINARY_NAME);
    if (existsSync(builtPath)) return builtPath;

    return null;
  }

  /** 找到 Swift 源码和可用 swiftc 后逐候选编译；全部失败返回 null。 */
  private async buildExecutable(): Promise<string | null> {
    const sourceDir = this.resolveSourceDir();
    if (!sourceDir) return null;

    const swiftSourceDir = path.join(sourceDir, 'Sources', 'LoongSuitePilotMenuBarApp');
    if (!existsSync(swiftSourceDir)) return null;

    const outDir = path.join(this.dataDir, 'apps', 'macos-status-bar', 'build');
    await ensureDir(outDir);
    const outPath = path.join(outDir, BINARY_NAME);

    const sdkCandidates = [
      '/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk',
      '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk',
    ];
    const sdk = sdkCandidates.find(s => existsSync(s));
    if (!sdk) {
      logger.warn('no macOS SDK found, cannot build status bar app');
      return null;
    }

    let sourceFiles: string[];
    try {
      sourceFiles = (await fs.readdir(swiftSourceDir))
        .filter(f => f.endsWith('.swift'))
        .map(f => path.join(swiftSourceDir, f));
    } catch {
      return null;
    }
    if (sourceFiles.length === 0) return null;

    const archTarget = process.arch === 'x64' ? 'x86_64-apple-macosx13.0' : 'arm64-apple-macosx13.0';
    const swiftcCandidates = this.resolveSwiftcPaths();

    for (const { swiftc, label, env: cmdEnv } of swiftcCandidates) {
      try {
        logger.info(`building status bar app with ${label}`);

        const args = [
          '-O', '-target', archTarget, '-sdk', sdk, '-o', outPath,
          '-framework', 'AppKit', '-framework', 'SwiftUI',
          '-framework', 'Charts', '-framework', 'Combine',
          ...sourceFiles,
        ];
        await execFileAsync(swiftc, args, {
          env: { ...process.env, ...cmdEnv },
          timeout: 180_000,
        });

        if (existsSync(outPath)) {
          logger.info('status bar app built successfully', { path: outPath });
          return outPath;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`swiftc build failed (${label})`, { error: message.slice(0, 500) });
      }
    }

    return null;
  }

  /** 返回 Xcode、xcrun 和 PATH 中的 swiftc 候选及各自环境。 */
  private resolveSwiftcPaths(): Array<{ swiftc: string; label: string; env: Record<string, string> }> {
    const candidates: Array<{ swiftc: string; label: string; env: Record<string, string> }> = [];

    if (process.env.DEVELOPER_DIR) {
      candidates.push({ swiftc: 'swiftc', label: 'env-DEVELOPER_DIR', env: {} });
      return candidates;
    }

    const xcodeSwiftc = path.join(DEFAULT_XCODE_DEVELOPER_DIR, 'Toolchains', 'XcodeDefault.xctoolchain', 'usr', 'bin', 'swiftc');
    if (existsSync(xcodeSwiftc)) {
      candidates.push({
        swiftc: xcodeSwiftc,
        env: { DEVELOPER_DIR: DEFAULT_XCODE_DEVELOPER_DIR },
        label: 'xcode-default',
      });
    }

    candidates.push({ swiftc: 'swiftc', label: 'default-path', env: {} });
    return candidates;
  }

  /** 从已安装版本相对位置查源码，开发模式再回退到 cwd。 */
  private resolveSourceDir(): string | null {
    // 先相对当前模块所在安装版本查找。
    const currentFile = path.join(this.dataDir, 'current');
    try {
      const current = readFileSync(currentFile, 'utf8').trim();
      if (current) {
        const candidate = path.join(this.dataDir, 'versions', current, 'app', 'macos-status-bar');
        if (existsSync(path.join(candidate, 'Package.swift'))) return candidate;
      }
    } catch {
      // current 指针缺失或不可读时忽略，继续尝试源码开发目录。
    }

    // 源码开发模式回退到 cwd。
    const cwdCandidate = path.resolve(process.cwd(), 'app', 'macos-status-bar');
    if (existsSync(path.join(cwdCandidate, 'Package.swift'))) return cwdCandidate;

    return null;
  }

  /** 同时验证 PID 活性和实际命令行包含目标 executablePath。 */
  private async isProcessRunning(pid: number, executablePath: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5000 });
      return stdout.includes(executablePath) || stdout.includes(BINARY_NAME);
    } catch {
      return false;
    }
  }

  /** 用 pgrep 查同名进程并解析正整数 PID；命令失败返回空数组。 */
  private async findRunningPids(): Promise<number[]> {
    try {
      const { stdout } = await execFileAsync('pgrep', ['-x', BINARY_NAME], { timeout: 5000 });
      return stdout
        .split('\n')
        .map(l => Number(l.trim()))
        .filter(n => Number.isInteger(n) && n > 0 && n !== process.pid);
    } catch {
      return [];
    }
  }

  /** best-effort 发送信号，进程已退出时忽略。 */
  private sendSignal(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(pid, signal);
    } catch {
      // 进程可能已自行退出；发送信号失败不影响后续清理。
    }
  }

  /** 100ms 轮询到进程退出或超时，返回是否已退出。 */
  private async waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await sleep(200);
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }

  /** 流式读取二进制并计算 SHA-256；失败返回 null。 */
  private async fingerprint(executablePath: string): Promise<string | null> {
    try {
      const buffer = await fs.readFile(executablePath);
      return createHash('sha256').update(buffer).digest('hex');
    } catch {
      return null;
    }
  }

  /** 确保 status-bar 日志目录并返回固定日志路径。 */
  private async prepareLogPath(): Promise<string> {
    const logDir = path.join(this.dataDir, 'logs', 'app-status-bar');
    await ensureDir(logDir);
    const today = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    return path.join(logDir, `status-bar-app-${today}.log`);
  }

  /** 返回 App runtime 元数据路径。 */
  private runtimeRecordPath(): string {
    return path.join(this.dataDir, 'logs', 'status-bar-app-runtime.json');
  }

  /** 容错读取 App runtime 元数据。 */
  private async readRuntimeRecord(): Promise<StatusBarAppRuntime | null> {
    return readJsonFile<StatusBarAppRuntime>(this.runtimeRecordPath());
  }

  /** 原子写 App runtime 元数据。 */
  private async writeRuntimeRecord(record: StatusBarAppRuntime): Promise<void> {
    await ensureDir(path.dirname(this.runtimeRecordPath()));
    await writeJsonFile(this.runtimeRecordPath(), record);
  }

  /** best-effort 删除 App runtime 元数据。 */
  private async removeRuntimeRecord(): Promise<void> {
    try {
      await fs.rm(this.runtimeRecordPath(), { force: true });
    } catch {
      // 元数据清理属于 best-effort，删除失败不能阻断 Collector 退出。
    }
  }
}

/** 简单异步延迟，供退出轮询使用。 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
