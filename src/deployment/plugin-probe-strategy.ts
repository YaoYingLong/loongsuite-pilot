/**
 * 下载/解压插件包、执行安装脚本并管理插件 Worker 的部署策略。
 *
 * plugin-probe 声明可指向本地 tarball 或远端 URL。本类计算 source hash 判断更新，
 * 下载到临时文件，解压到 staging 后替换目标目录，再在受控 cwd/env 中 spawn 安装、
 * 启动或停止脚本。安装脚本受 120 秒超时和退出码检查；tar/download 依赖各自进程或
 * 网络完成。错误转换为 DeployResult，由 DeploymentManager 隔离。
 */



import * as fs from 'node:fs/promises';
import { createWriteStream, type Dirent } from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type {
  AgentDefinition,
  DeployResult,
  DeployStrategy,
  DeployedAgentRecord,
} from '../types/index.js';
import { directoryExists, ensureDir, fileExists } from '../utils/fs-utils.js';
import { detectAgent } from './detect-utils.js';
import { createLogger } from '../utils/logger.js';
import { WorkerManifestSupervisor } from './worker-manifest-supervisor.js';

const logger = createLogger('PluginProbeStrategy');

const SCRIPT_TIMEOUT_MS = 120_000;
const REMOTE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 每 4 小时重新检查远端包。

export interface PluginProbeDeployOptions {
  /** Local Worker 实例固定字段，供 worker.manifest.json 展开。 */
  instance?: Record<string, string>;
  /** Worker CLI 保存的 Runtime 参数，供 worker.manifest.json 展开。 */
  runtimeOptions?: Record<string, string | boolean>;
}

/**
 * 实现 DeployStrategy 的插件包安装器及 Worker 生命周期适配器。
 *
 * DeploymentManager 或 LocalWorkerActivationService 调用本类。它持有 dataDir、pilotDir
 * 和 WorkerManifestSupervisor；部署期间可能发起 HTTP 下载、读取 tarball、创建临时
 * 目录、调用系统 tar/安装脚本并启动 detached Worker。公开 deploy/undeploy 将大多数
 * 失败收敛为 DeployResult，底层辅助方法仍可能抛出并由公开边界捕获。Collector 退出时，
 * DeploymentManager 会按声明调用 `stopWorker()`，释放由本策略监管的 Worker 进程。
 */
export class PluginProbeStrategy implements DeployStrategy {
  private readonly dataDir: string;
  private readonly pilotDir: string;
  private readonly workerSupervisor: WorkerManifestSupervisor;

  /**
   * 保存数据/当前版本包目录，并创建本策略独占的 `WorkerManifestSupervisor`。
   * @param dataDir 持久数据根，用于日志、临时下载和传给安装脚本的 `PILOT_DATA_DIR`。
   * @param pilotDir 当前 loongsuite-pilot 版本根，用于寻找 Agent 专用安装包装脚本。
   * @remarks 构造阶段不访问磁盘、不下载包、不启动 Worker。
   */
  constructor(dataDir: string, pilotDir: string) {
    this.dataDir = dataDir;
    this.pilotDir = pilotDir;
    this.workerSupervisor = new WorkerManifestSupervisor();
  }

  /**
   * 复用通用路径/命令探测，判断目标 Agent 是否已安装。
   * @param def `AgentDefLoader` 已展开路径占位符的声明。
   * @returns 任一 detection path/command 命中时为 `true`。
   * @remarks `DeploymentManager` 在 `needsDeploy()` 之前调用；此方法只检测 Agent，不检测插件包。
   */
  async detect(def: AgentDefinition): Promise<boolean> {
    return detectAgent(def.detection);
  }

  /**
   * 根据部署记录、目标目录、Worker 活性、远端复查间隔与 source hash 判断是否重部署。
   * Local Worker 模板没有实例上下文时不要求全局 Worker 常驻。
   *
   * @param def plugin-probe 声明，其 `source.destDir` 是安装快照的期望位置。
   * @param record `deployed-agents.json` 中上次成功部署的 source hash/远端检查时间。
   * @returns `true` 表示目录缺失、Worker 应运行但已退出、无法获取 hash 或 hash 变化。
   * @remarks 纯远端源在 4 小时窗口内不下载完整包计算 hash，以限制网络开销。
   */
  async needsDeploy(def: AgentDefinition, record?: DeployedAgentRecord): Promise<boolean> {
    // 没有成功记录时不能仅凭目录存在推断部署完整，必须走一次完整事务。
    if (!record) return true;

    const config = def.pluginProbe;
    if (!config) return true;

    if (!await directoryExists(config.source.destDir)) {
      logger.info('destDir missing, re-deploy needed', { agentId: def.id, destDir: config.source.destDir });
      return true;
    }

    // 带 localWorkerRuntime 的定义只是可复用模板，没有具体实例时不要求全局 Worker 常驻。
    const shouldStartWorker = !def.localWorkerRuntime;
    const hasWorkerManifest = await this.workerSupervisor.hasManifest(config.source.destDir);
    if (shouldStartWorker && hasWorkerManifest && !await this.workerSupervisor.isWorkerRunning(config.source.destDir)) {
      return true;
    }

    // 纯远端包没有本地可快速比较的 tarball；在复查窗口内直接信任上次 hash。
    if (this.isRemoteOnly(config.source) && !this.isRemoteCheckDue(record)) {
      logger.debug('remote check skipped, within interval', {
        agentId: def.id,
        lastChecked: record.lastRemoteCheckedAt,
      });
      return false;
    }

    const currentHash = await this.computeSourceHash(config.source.tarball, config.source.url ?? config.source.remoteUrl);
    if (!currentHash) return true;

    if (currentHash !== record.sourceHash) return true;

    return false;
  }

  /**
   * 停旧 Worker/卸载脚本 -> 原子获取新包 -> 安装脚本 -> 可选启动 Worker。
   *
   * `DeploymentManager` 和 Local Worker 收敛服务共用该入口。包目录的替换有 staging/backup
   * 保护，但旧包的 uninstall.sh 在替换前执行，其外部副作用无法由目录回滚撤销。
   *
   * @param def 必须包含 `pluginProbe` 的 Agent 声明。
   * @param options Local Worker 实例字段与 Runtime 参数；普通 Agent 省略。
   * @returns 包含 agentId/deployMode 的 `DeployResult`；缺配置、获包或 install 失败都以 `success:false` 表示。
   * @remarks 公开边界将内部 I/O/子进程异常收敛为结果，不向 DeploymentManager 抛出。
   */
  async deploy(def: AgentDefinition, options: PluginProbeDeployOptions = {}): Promise<DeployResult> {
    const config = def.pluginProbe;
    if (!config) {
      return { success: false, agentId: def.id, deployMode: 'plugin-probe', error: 'missing pluginProbe config' };
    }

    try {
      const destDir = config.source.destDir;
      const existingRoot = await this.resolvePackageRoot(destDir);

      // 必须先停 Worker，否则旧进程可能持续读取正在被替换的包文件或与新进程双写状态。
      await this.workerSupervisor.stopIfPresent(def.id, destDir, {
        instance: options.instance,
        runtimeOptions: options.runtimeOptions,
      });

      const existingUninstallScript = existingRoot ? path.join(existingRoot, 'scripts', 'uninstall.sh') : '';
      if (existingUninstallScript && await fileExists(existingUninstallScript)) {
        logger.info('running uninstall script before update', { agentId: def.id });
        await this.runScript(existingUninstallScript, existingRoot!, def.id);
      }

      // 只有 staging 中的包完整获取后才会与 destDir 交换，避免下载中断留下半个正式安装。
      const acquired = await this.acquirePackageIntoDest(config.source);
      if (!acquired) {
        return { success: false, agentId: def.id, deployMode: 'plugin-probe', error: 'failed to acquire package' };
      }

      const packageRoot = await this.resolvePackageRoot(destDir);
      const installCwd = packageRoot ?? destDir;
      const installScript = await this.resolveInstallScript(def.id, installCwd);
      if (installScript) {
        const ok = await this.runScript(installScript, installCwd, def.id);
        if (!ok) {
          return { success: false, agentId: def.id, deployMode: 'plugin-probe', error: 'install script failed' };
        }
      } else {
        logger.debug('no install script found, skipping', { agentId: def.id });
      }

      // 普通 plugin-probe 直接启动 Worker；Local Worker 模板只有在传入具体实例上下文后启动。
      const shouldStartWorker = !def.localWorkerRuntime || !!options.instance;
      if (!shouldStartWorker) {
        logger.info('local worker runtime template installed; worker start skipped', {
          agentId: def.id,
          runtime: def.localWorkerRuntime,
        });
      } else {
        const workerStarted = await this.workerSupervisor.startIfPresent(
          def.id,
          destDir,
          this.buildScriptEnv(def.id),
          {
            instance: options.instance,
            runtimeOptions: options.runtimeOptions,
          },
        );
        // Worker 启动失败不把已安装的插件包标成整体部署失败；后续 needsDeploy 会根据 PID 再尝试修复。
        if (!workerStarted) {
          logger.warn('plugin deployed but worker failed to start', { agentId: def.id });
        }
      }

      logger.info('plugin deployed', { agentId: def.id });
      return { success: true, agentId: def.id, deployMode: 'plugin-probe' };
    } catch (err) {
      return { success: false, agentId: def.id, deployMode: 'plugin-probe', error: String(err) };
    }
  }

  /**
   * 停止 Worker 并运行包内 `scripts/uninstall.sh`。
   * @param def 要卸载的 plugin-probe 声明。
   * @returns 卸载脚本退出 0 时为 `true`；缺配置/脚本或执行失败时为 `false`。
   * @remarks 停 Worker 的结果当前不改变卸载脚本的执行；本方法也不删除 `destDir`。
   */
  async undeploy(def: AgentDefinition): Promise<boolean> {
    const config = def.pluginProbe;
    if (!config) return false;

    const destDir = config.source.destDir;
    await this.workerSupervisor.stopIfPresent(def.id, destDir);

    const packageRoot = await this.resolvePackageRoot(destDir);
    const uninstallRoot = packageRoot ?? destDir;
    const uninstallScript = path.join(uninstallRoot, 'scripts', 'uninstall.sh');

    if (await fileExists(uninstallScript)) {
      logger.info('running uninstall script', { agentId: def.id });
      return this.runScript(uninstallScript, uninstallRoot, def.id);
    }

    logger.warn('no uninstall script found', { agentId: def.id });
    return false;
  }

  /**
   * 只停止 manifest Worker，不运行 uninstall 也不移除包。
   * @param options 必须与启动时一致，用于解析 Local Worker 的 PID 路径。
   * @returns 无配置/无 manifest/已停止均为 `true`，发信号失败时为 `false`。
   */
  async stopWorker(def: AgentDefinition, options: PluginProbeDeployOptions = {}): Promise<boolean> {
    const config = def.pluginProbe;
    if (!config) return true;
    return this.workerSupervisor.stopIfPresent(def.id, config.source.destDir, {
      instance: options.instance,
      runtimeOptions: options.runtimeOptions,
    });
  }

  /**
   * 查询实例展开后的 Worker PID 是否仍活跃。
   * @returns manifest 可读、PID 合法且 signal 0 成功时为 `true`；本方法不启动或修复 Worker。
   */
  async isWorkerRunning(def: AgentDefinition, options: PluginProbeDeployOptions = {}): Promise<boolean> {
    const config = def.pluginProbe;
    if (!config) return false;
    return this.workerSupervisor.isWorkerRunning(config.source.destDir, {
      instance: options.instance,
      runtimeOptions: options.runtimeOptions,
    });
  }

  /**
   * 本地 tarball 直接 SHA-256；仅远端 URL 时下载到临时文件后计算。
   * @param tarball 可选本地包，只有文件存在时才优先使用。
   * @param url 本地包不可用时的远端地址。
   * @returns 带 `sha256:` 前缀的内容摘要；无来源、下载或读取失败时返回 `undefined`。
   */
  async computeSourceHash(tarball?: string, url?: string): Promise<string | undefined> {
    if (tarball && await fileExists(tarball)) {
      return this.hashFile(tarball);
    }

    if (url) {
      return this.resolveRemoteHash(url);
    }

    return undefined;
  }

  /**
   * 判断 source 是否只有远端地址，供 DeploymentManager/`needsDeploy()` 应用 4 小时复查窗口。
   * @returns 未声明 tarball 且 `url`/`remoteUrl` 任一存在时为 `true`。
   */
  isRemoteOnly(source: { tarball?: string; url?: string; remoteUrl?: string }): boolean {
    return !source.tarball && !!(source.url || source.remoteUrl);
  }

  /**
   * 根据部署记录判断纯远端包是否到了下一次 hash 复查时间。
   * @returns 从未检查或距上次至少 4 小时时为 `true`。无效日期会得到 `false`，待确认是否应收敛为立即复查。
   */
  isRemoteCheckDue(record: DeployedAgentRecord): boolean {
    if (!record.lastRemoteCheckedAt) return true;
    const elapsed = Date.now() - new Date(record.lastRemoteCheckedAt).getTime();
    return elapsed >= REMOTE_CHECK_INTERVAL_MS;
  }

  /**
   * 读取整个本地 tarball 并计算 SHA-256。
   * @returns 带 `sha256:` 前缀的摘要；读取失败返回 `undefined` 并由上层判定需重部署。
   * @remarks 当前是整文件读入内存，不是流式 hash。
   */
  private async hashFile(filePath: string): Promise<string | undefined> {
    try {
      const data = await fs.readFile(filePath);
      return `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`;
    } catch {
      return undefined;
    }
  }

  /**
   * 下载远端包到 `<dataDir>/.tmp` 后计算 hash，并在 finally 删除临时文件。
   * 当前未使用 HEAD/ETag，因此远端复查会下载完整包。
   * @returns 远端内容摘要；下载或读取失败时返回 `undefined`。
   */
  private async resolveRemoteHash(url: string): Promise<string | undefined> {
    const tmpDir = path.join(this.dataDir, '.tmp');
    const tmpFile = path.join(tmpDir, `remote-hash-${Date.now()}.tar.gz`);

    try {
      await ensureDir(tmpDir);
      const ok = await this.downloadToFile(url, tmpFile);
      if (!ok) return undefined;
      return this.hashFile(tmpFile);
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }

  /**
   * 优先使用 Pilot 针对 Agent 的包装安装脚本，再尝试包内 `scripts/install.sh`。
   * @returns 第一个存在脚本的绝对路径；两者都不存在时返回 `undefined`。
   * @remarks 包装脚本可以在通用插件安装前注入 Pilot 特定环境/兼容处理。
   */
  private async resolveInstallScript(agentId: string, destDir: string): Promise<string | undefined> {
    const wrapper = path.join(this.pilotDir, 'scripts', `plugin-install-${agentId}.sh`);
    if (await fileExists(wrapper)) {
      return wrapper;
    }

    const pluginScript = path.join(destDir, 'scripts', 'install.sh');
    if (await fileExists(pluginScript)) {
      return pluginScript;
    }

    return undefined;
  }

  /**
   * 识别解压根：destDir 自身含脚本/manifest 时直接返回，否则检查其一级子目录。
   * @returns 可作为安装脚本 cwd 的包根；不可读或未命中特征时返回 `undefined`。
   * @remarks 只搜一级，避免误将依赖包里的 manifest/脚本当作主包入口。
   */
  private async resolvePackageRoot(destDir: string): Promise<string | undefined> {
    if (await fileExists(path.join(destDir, 'scripts', 'install.sh'))
      || await fileExists(path.join(destDir, 'scripts', 'uninstall.sh'))
      || await fileExists(path.join(destDir, 'worker.manifest.json'))) {
      return destDir;
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(destDir, { withFileTypes: true });
    } catch {
      return undefined;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(destDir, entry.name);
      if (await fileExists(path.join(candidate, 'scripts', 'install.sh'))
        || await fileExists(path.join(candidate, 'scripts', 'uninstall.sh'))
        || await fileExists(path.join(candidate, 'worker.manifest.json'))) {
        return candidate;
      }
    }

    return undefined;
  }

  /**
   * 为安装脚本补齐 Node 所在 PATH、Pilot 目录变量，并清空继承的 NODE_OPTIONS。
   * @returns 新环境对象；`PILOT_LOG_DIR` 按 agentId 隔离，不会在此创建目录。
   * @remarks 清空 `NODE_OPTIONS` 可防止 Collector 自身的 preload/instrumentation 透传到安装器和 Worker。
   */
  private buildScriptEnv(agentId: string): Record<string, string> {
    const nodeBin = process.execPath;
    const nodeDir = path.dirname(nodeBin);
    const npmBin = path.join(nodeDir, 'npm');
    const existingPath = process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin';
    const augmentedPath = existingPath.includes(nodeDir)
      ? existingPath
      : `${nodeDir}:${existingPath}`;

    return {
      ...process.env as Record<string, string>,
      PATH: augmentedPath,
      NODE_OPTIONS: '',
      PILOT_DATA_DIR: this.dataDir,
      PILOT_LOG_DIR: path.join(this.dataDir, 'logs', agentId),
      PILOT_NODE_BIN: nodeBin,
      PILOT_NPM_BIN: npmBin,
    };
  }

  /**
   * 用 bash 执行安装/卸载脚本，120 秒超时后 SIGKILL；错误、非零退出均以 false 兑现。
   * @param scriptPath 包装脚本或包内 install/uninstall 脚本。
   * @param cwd 脚本使用的包根，相对路径在此解析。
   * @returns 只在退出码为 0 时兑现 `true`；Promise 本身不 reject。
   * @remarks stdout 由管道消费但未记录，stderr 最多截取 500 字符进入失败日志。
   */
  private runScript(scriptPath: string, cwd: string, agentId: string): Promise<boolean> {
    return new Promise(resolve => {
      let settled = false;

      const child = spawn('bash', [scriptPath], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this.buildScriptEnv(agentId),
      });

      // 超时回调与 error/exit 事件可能竞争；`settled` 保证 Promise 只兑现一次。
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        logger.error('script timed out', { agentId, scriptPath, timeoutMs: SCRIPT_TIMEOUT_MS });
        resolve(false);
      }, SCRIPT_TIMEOUT_MS);

      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        logger.error('script failed', { agentId, scriptPath, error: String(err) });
        resolve(false);
      });

      child.on('exit', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          logger.info('script succeeded', { agentId, scriptPath });
          resolve(true);
        } else {
          logger.error('script failed', { agentId, scriptPath, exitCode: code, stderr: stderr.slice(0, 500) });
          resolve(false);
        }
      });
    });
  }

  /**
   * 按 `source.type` 把 tar/OSS 包获取到指定目录。
   * @param source `destDir` 在此通常是 staging，而不是正在服务的正式目录。
   * @returns 解压成功时为 `true`；未知类型或获取失败时为 `false`。
   */
  private async acquirePackage(source: {
    type: string;
    tarball?: string;
    url?: string;
    destDir: string;
    remoteUrl?: string;
  }): Promise<boolean> {
    await ensureDir(source.destDir);

    if (source.type === 'tar') {
      return this.acquireTar(source.tarball, source.destDir, source.remoteUrl);
    }
    if (source.type === 'oss') {
      return this.acquireOss(source.url, source.destDir);
    }

    logger.error('unknown source type', { type: source.type });
    return false;
  }

  /**
   * 在同父目录 staging 中完整获取，再把旧目录改名为 backup、staging 改为正式目录。
   * 安装失败时尽力恢复 backup，finally 清理 staging。
   * @returns 新包已交换到 `source.destDir` 时为 `true`；获包/交换失败时为 `false`。
   * @remarks 这个事务仅覆盖包目录；之后 install.sh 的外部配置副作用不在此回滚边界内。
   */
  private async acquirePackageIntoDest(source: {
    type: string;
    tarball?: string;
    url?: string;
    destDir: string;
    remoteUrl?: string;
  }): Promise<boolean> {
    const parentDir = path.dirname(source.destDir);
    const stagingPrefix = path.join(parentDir, `.${path.basename(source.destDir)}.staging-`);

    await ensureDir(parentDir);
    const stagingDir = await fs.mkdtemp(stagingPrefix);
    let backupDir: string | undefined;
    let installed = false;

    try {
      const acquired = await this.acquirePackage({ ...source, destDir: stagingDir });
      if (!acquired) return false;

      // backup 名带时间和 UUID，避免并发/崩溃遗留目录被误覆盖。
      backupDir = path.join(parentDir, `.${path.basename(source.destDir)}.backup-${Date.now()}-${crypto.randomUUID()}`);
      try {
        await this.renamePath(source.destDir, backupDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        backupDir = undefined;
      }

      await this.renamePath(stagingDir, source.destDir);
      installed = true;
      if (backupDir) {
        await fs.rm(backupDir, { recursive: true, force: true }).catch(err => {
          logger.warn('failed to remove package backup', { backupDir, error: String(err) });
        });
      }
      return true;
    } catch (err) {
      if (backupDir && !installed) {
        await fs.rm(source.destDir, { recursive: true, force: true }).catch(() => {});
        await this.renamePath(backupDir, source.destDir).catch(restoreErr => {
          logger.warn('failed to restore previous package', {
            destDir: source.destDir,
            backupDir,
            error: String(restoreErr),
          });
        });
      }
      logger.error('package acquire failed', { destDir: source.destDir, error: String(err) });
      return false;
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * 优先用 `rename` 快速移动目录；跨文件系统 `EXDEV` 时退化为递归 copy + remove。
   * @throws 非 EXDEV 或 copy/remove 异常传给 staging 事务触发 backup 恢复。
   * @remarks copy + remove 不具有单步原子性，仅在文件系统不允许 rename 时作兼容回退。
   */
  private async renamePath(source: string, target: string): Promise<void> {
    try {
      await fs.rename(source, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await fs.cp(source, target, { recursive: true });
      await fs.rm(source, { recursive: true, force: true });
    }
  }

  /**
   * 优先解压本地 tarball；文件不存在时尝试 `remoteUrl`。
   * @returns 任一来源成功解压时为 `true`；无可用来源时警告并返回 `false`。
   */
  private async acquireTar(
    tarball: string | undefined,
    destDir: string,
    remoteUrl: string | undefined,
  ): Promise<boolean> {
    if (tarball && await fileExists(tarball)) {
      return this.extractTar(tarball, destDir);
    }

    if (remoteUrl) {
      logger.info('local tarball not found, trying remote', { remoteUrl });
      return this.downloadAndExtract(remoteUrl, destDir);
    }

    logger.warn('no tarball or remote URL available');
    return false;
  }

  /**
   * 校验 OSS URL 存在后复用下载并解压流程。
   * @returns URL 缺失时为 `false`，否则返回 `downloadAndExtract()` 结果。
   */
  private async acquireOss(url: string | undefined, destDir: string): Promise<boolean> {
    if (!url) {
      logger.warn('no OSS URL configured');
      return false;
    }
    return this.downloadAndExtract(url, destDir);
  }

  /**
   * spawn 系统 `tar` 执行 `-xzf <tarball> -C <destDir>`。
   * @returns tar 退出 0 时兑现 `true`；spawn error 或非零退出时兑现 `false`，不 reject。
   * @remarks 目标目录由上层事先创建；stdout/stderr 建立管道但当前不收集内容。
   */
  private async extractTar(tarball: string, destDir: string): Promise<boolean> {
    return new Promise(resolve => {
      const child = spawn('tar', ['-xzf', tarball, '-C', destDir], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.on('error', err => {
        logger.error('tar extraction failed', { error: String(err) });
        resolve(false);
      });

      child.on('exit', code => {
        if (code === 0) {
          resolve(true);
        } else {
          logger.error('tar extraction failed', { exitCode: code });
          resolve(false);
        }
      });
    });
  }

  /**
   * 依据 http/https 发起 GET，并把 200 响应流写入文件；非 200 或请求错误返回 false。
   * 当前调用未设置显式网络超时或重定向处理。
   * @param url 只根据是否以 `https` 开头选择 Node.js http/https 客户端。
   * @param destFile 直接覆盖写入的目标文件，父目录必须已存在。
   * @returns 文件流 finish 并关闭后为 `true`；其他结果为 `false`。
   */
  private async downloadToFile(url: string, destFile: string): Promise<boolean> {
    try {
      const { default: https } = await import('node:https');
      const { default: http } = await import('node:http');
      const protocol = url.startsWith('https') ? https : http;

      await new Promise<void>((resolve, reject) => {
        const file = createWriteStream(destFile);
        protocol.get(url, response => {
          if (response.statusCode !== 200) {
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
          }
          response.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        }).on('error', reject);
      });

      return true;
    } catch (err) {
      logger.error('download failed', { url, error: String(err) });
      return false;
    }
  }

  /**
   * 下载到目标目录内临时 tar.gz，再调用系统 tar 解压。
   * @returns 下载和解压都成功时为 `true`；任一阶段失败为 `false`。
   * @remarks 临时包在正常与异常路径都 best-effort 删除，删除失败不覆盖主结果。
   */
  private async downloadAndExtract(url: string, destDir: string): Promise<boolean> {
    const tmpFile = path.join(destDir, '.download.tmp.tar.gz');
    try {
      const ok = await this.downloadToFile(url, tmpFile);
      if (!ok) return false;
      const extracted = await this.extractTar(tmpFile, destDir);
      await fs.unlink(tmpFile).catch(() => {});
      return extracted;
    } catch (err) {
      logger.error('download and extract failed', { url, error: String(err) });
      await fs.unlink(tmpFile).catch(() => {});
      return false;
    }
  }
}
