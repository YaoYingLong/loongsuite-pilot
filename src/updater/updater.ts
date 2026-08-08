/**
 * 自动更新的版本选择、下载校验和原子部署核心。
 *
 * 独立 `src/updater/index.ts` 创建本类。检查循环获取 manifest，结合稳定版本、canary
 * policy、installId 分桶及 hotfix 选择目标；随后带超时下载包、核验 SHA-256、解压到
 * 新版本目录、安装生产依赖，并原子切换 previous/current 指针。切换后通过稳定 CLI
 * 只重启 Collector，失败则保留旧版本并指数退避；成功后每轮最多回收一个无引用旧
 * 版本。所有子进程只获得补齐 Node 路径的环境，网络和文件异常由 run loop 计数、
 * 指标记录并决定是否继续。
 */




import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import type { AutoUpdateConfig } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { readJsonFile, writeJsonFile, resolveHome } from '../utils/fs-utils.js';
import { compareVersions, computeSha256, deterministicBucket } from './version-utils.js';
import type { UpdaterMetrics } from './updater-metrics.js';
import { updaterRuntimePath, type UpdaterRuntimeState } from './runtime-state.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('Updater');

const FETCH_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const NPM_INSTALL_TIMEOUT_MS = 2 * 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000; // 失败退避最长为 6 小时。
const MAX_CONSECUTIVE_FAILURES = 10;
const MAX_VERSION_GC_REMOVALS_PER_CHECK = 1;

/**
 * 为 npm/Node 子进程补齐当前 Node 所在 PATH；只修改复制后的 env，不改变当前进程。
 *
 * Updater 在新版本目录中调用 `npm` 和 `node` 时使用这份环境。服务管理器启动的
 * 后台进程往往没有交互式 shell 的 PATH，所以必须显式放入 `process.execPath`
 * 所在目录，否则同一套更新在手工运行时成功、在 daemon 中却可能找不到 npm。
 *
 * @returns 可直接传给 `execFile` 的环境副本；原 `process.env` 不会被修改。
 */
function buildChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const nodeDir = path.dirname(process.execPath);
  const currentPath = env.PATH ?? '';
  if (!currentPath.split(path.delimiter).includes(nodeDir)) {
    env.PATH = nodeDir + path.delimiter + currentPath;
  }
  return env;
}

export interface VersionManifest {
  version: string;
  git_commit: string;
  package_url: string;
  released_at?: string;
  sha256?: string;
}

export interface CanaryManifest extends VersionManifest {
  rollout_percentage: number;
  hotfix_version?: number;
}

export interface LatestManifest extends VersionManifest {
  canary?: CanaryManifest;
}

export interface LocalVersion {
  version: string;
  gitCommit: string;
}

export interface UpdaterPaths {
  cacheDir: string;
  versionsDir: string;
  currentFile: string;
  previousFile: string;
  bootstrapDir: string;
  loongsuitePilotBin: string;
  runtimeFile: string;
}

/**
 * 解析安装缓存根使用的用户 HOME。
 *
 * @returns 优先取 Unix `HOME`，其次取 Windows `USERPROFILE`，最后交由 Node.js
 * `os.homedir()` 探测。本函数不访问磁盘。
 */
function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
}

/**
 * 返回安装器部署的稳定 CLI 路径，Windows 选择 `.ps1`。
 *
 * 这条路径不经过 `current` 指针，因此更新刚切换版本时仍能用它重启
 * Collector；`syncInstalledScripts()` 负责使这份稳定脚本与当前版本一致。
 *
 * @returns `~/.local/bin/loongsuite-pilot[.ps1]` 的绝对路径。
 */
function pilotBinPath(): string {
  const home = homeDir();
  const ext = process.platform === 'win32' ? '.ps1' : '';
  return path.join(home, '.local', 'bin', `loongsuite-pilot${ext}`);
}

/**
 * 构造生产默认路径；版本/cache 固定在 HOME，runtime 文件可随自定义 dataDir。
 *
 * 指针和版本目录必须位于同一安装根，而 `updater-runtime.json` 是给状态栏/诊断
 * 程序读取的运行数据，所以后者跟随 `LOONGSUITE_PILOT_DATA_DIR`。
 *
 * @returns 生产多版本布局使用的全部路径；不创建任何目录。
 */
function defaultPaths(): UpdaterPaths {
  const home = homeDir();
  const cacheDir = path.join(home, '.loongsuite-pilot');
  const dataDir = resolveHome(process.env.LOONGSUITE_PILOT_DATA_DIR ?? cacheDir);
  return {
    cacheDir,
    versionsDir: path.join(cacheDir, 'versions'),
    currentFile: path.join(cacheDir, 'current'),
    previousFile: path.join(cacheDir, 'previous'),
    bootstrapDir: path.join(cacheDir, 'bin'),
    loongsuitePilotBin: pilotBinPath(),
    runtimeFile: updaterRuntimePath(dataDir),
  };
}

/**
 * 为测试或显式 `baseDir` 构造一套隔离路径。
 *
 * `Updater` 构造函数在收到 `baseDir` 时调用它，使测试不会读写真实的
 * `~/.loongsuite-pilot/current`。稳定 CLI 仍使用安装路径，这与生产重启行为保持一致。
 *
 * @param baseDir 要容纳 `versions`/`current`/`previous`/`bin` 的隔离根目录。
 * @returns 纯路径对象；本函数不读写文件。
 */
export function buildPaths(baseDir: string): UpdaterPaths {
  return {
    cacheDir: baseDir,
    versionsDir: path.join(baseDir, 'versions'),
    currentFile: path.join(baseDir, 'current'),
    previousFile: path.join(baseDir, 'previous'),
    bootstrapDir: path.join(baseDir, 'bin'),
    loongsuitePilotBin: pilotBinPath(),
    runtimeFile: updaterRuntimePath(baseDir),
  };
}

export interface ResolvedTarget {
  manifest: VersionManifest;
  channel: 'stable' | 'canary';
  hotfixVersion?: number;
}

const DEFAULT_CONFIG_PATH = '~/.loongsuite-pilot/config.json';

/**
 * 独立 Updater 的检查循环和部署事务。
 *
 * start 创建 heartbeat/check timer；check 用 checking 锁避免重入，失败按指数退避但在十次
 * 后仍保持降级重试。成功部署以 candidate 目录和原子 current/previous 指针切换完成。
 *
 * 生命周期由 `src/updater/index.ts` 拥有：创建后可选注入 `UpdaterMetrics`，再调用
 * `start()`；SIGINT/SIGTERM 到来时调用 `stop()`。类内不保存下载数据，临时包由
 * `downloadAndDeploy()` 的 `finally` 清理；已激活版本由 `current` 指针决定。
 */
export class Updater {
  private timer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private consecutiveFailures = 0;
  private nextCheckAt = 0;
  private readonly paths: UpdaterPaths;
  private metrics: UpdaterMetrics | null = null;
  private readonly configPath: string;

  /**
   * 创建更新器并解析所有固定路径，构造阶段不发送网络请求、不启动定时器。
   *
   * @param config ConfigLoader 解析的自动更新配置。
   * @param baseDir 测试/隔离部署路径；省略时使用生产多版本布局。
   */
  constructor(
    private config: AutoUpdateConfig,
    baseDir?: string,
  ) {
    this.paths = baseDir ? buildPaths(baseDir) : defaultPaths();
    this.configPath = resolveHome(
      process.env.AGENT_DATA_COLLECTION_CONFIG ?? DEFAULT_CONFIG_PATH,
    );
  }

  /**
   * 注入可选指标/告警记录器。
   *
   * `updater/index.ts` 在启动两个组件后调用；之后的检查和部署节点只向该对象
   * 入队，不等待遥测网络发送完成，因此监控不会卡住更新事务。
   *
   * @param metrics 已创建的 Updater 事件/告警收集器。
   * @returns 无返回值；只修改本实例的依赖引用。
   */
  setMetrics(metrics: UpdaterMetrics): void {
    this.metrics = metrics;
  }

  /**
   * 启用时立即写 heartbeat，60 秒后首检，并建立 heartbeat 与配置周期两个 timer。
   * timer 有意保持独立 Updater 进程存活。
   *
   * 方法本身是同步的；timer 回调用 `void` 触发 Promise，实际文件/网络工作会在之后的
   * 事件循环轮次完成。`check()` 内部的锁防止首检与周期检查重叠。
   *
   * @returns 无返回值。配置关闭时不创建任何资源。
   */
  start(): void {
    if (!this.config.enabled) {
      logger.debug('auto-update disabled');
      return;
    }

    logger.info('updater started', {
      intervalMs: this.config.checkIntervalMs,
      manifestUrl: this.config.manifestUrl,
    });
    void this.metrics?.writeEvent('updater_started');
    void this.writeHeartbeat();
    this.heartbeatTimer = setInterval(() => void this.writeHeartbeat(), 30_000);
    this.heartbeatTimer.unref();

    setTimeout(() => void this.check(), 60_000);

    this.timer = setInterval(
      () => void this.check(),
      this.config.checkIntervalMs,
    );
  }

  /**
   * 清理周期检查与 heartbeat timer，并异步记录 stopped 事件。
   *
   * 上层信号处理器在退出时调用。它不强制中断正在执行的 `check()`，也不删除
   * runtime 文件；最后一次 heartbeat 中的 PID 将在进程退出后被消费者判定为失活。
   *
   * @returns 无返回值；重复调用是幂等的。
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    logger.info('updater stopped');
    void this.metrics?.writeEvent('updater_stopped');
  }

  /**
   * 单轮主流程：manifest -> installId/灰度目标 -> 版本判断 -> 下载部署 -> 持久化 canary
   * -> 重启 Collector/Monitor -> GC。网络 fetch 返回 null 时安静结束；抛出的部署异常会
   * 增加失败次数、计算最多 6 小时退避、写告警和 heartbeat。
   *
   * 该方法由首次延迟 timer、周期 timer 或测试直接调用。它返回的 Promise 在本轮
   * 所有文件、子进程和重启操作处理完后兑现；内部捕获部署异常，通常不向 timer
   * 传播 rejected Promise。
   *
   * @returns 无业务值。防重入、处于退避期或无 manifest 时会提前兑现。
   */
  async check(): Promise<void> {
    // timer 可能在上一轮下载/安装尚未结束时再次触发；返回而不排队可避免两个候选版本竞争切指针。
    if (this.checking) return;

    // 退避时间是绝对毫秒时刻；周期 timer 仍会唤醒，但在这里不会产生网络或磁盘副作用。
    if (Date.now() < this.nextCheckAt) {
      logger.debug('skipping check due to backoff', {
        nextCheckAt: new Date(this.nextCheckAt).toISOString(),
      });
      return;
    }

    this.checking = true;

    try {
      // fetchManifest 将可预期的网络/HTTP/JSON 问题收敛为 null，不把短暂的 manifest 故障视为安装失败。
      const latestManifest = await this.fetchManifest() as LatestManifest | null;
      if (!latestManifest) return;

      await this.ensureInstallId();
      const { manifest: target, channel, hotfixVersion } = this.resolveTargetVersion(latestManifest);

      const local = await this.readLocalVersion();
      if (!this.needsUpdate(local, target, channel)) {
        logger.debug('already up to date', {
          local: local?.version ?? 'unknown',
          remote: target.version,
          channel,
        });
        this.consecutiveFailures = 0;
        this.nextCheckAt = 0;
        await this.gcOldVersions();
        await this.writeHeartbeat();
        return;
      }

      logger.info('new version available', {
        current: local?.version ?? 'unknown',
        latest: target.version,
        commit: target.git_commit,
        channel,
      });
      void this.metrics?.writeEvent('new_version_available', {
        current_version: local?.version ?? 'unknown',
        latest_version: target.version,
      });

      // manifest 中的包地址优先；配置值是兼容旧 manifest 的后备来源。
      const packageUrl = target.package_url || this.config.packageUrl;
      if (!packageUrl) {
        logger.warn('no package URL in manifest or config');
        return;
      }

      void this.metrics?.writeEvent('downloading', {
        latest_version: target.version,
      });
      await this.downloadAndDeploy(packageUrl, target);
      void this.metrics?.writeEvent('deployed', {
        latest_version: target.version,
      });

      // 只有 canary 安装成功后才推进本地 hotfix 水位，避免失败的候选版本被误认为已应用。
      if (channel === 'canary') {
        await this.persistCanaryState(hotfixVersion ?? 0);
        this.config = { ...this.config, canaryHotfixVersion: hotfixVersion ?? 0 };
      }

      await this.restartCollector();
      void this.metrics?.writeEvent('collector_restarted', {
        latest_version: target.version,
      });

      await this.restartMonitorIfRunning();
      await this.gcOldVersions();
      this.consecutiveFailures = 0;
      this.nextCheckAt = 0;
      await this.writeHeartbeat();
    } catch (err) {
      // 只有抛出到事务边界的异常才进入指数退避；这通常代表下载、校验、安装或指针提交失败。
      this.consecutiveFailures++;
      const backoffMs = Math.min(
        this.config.checkIntervalMs * Math.pow(2, this.consecutiveFailures),
        MAX_BACKOFF_MS,
      );
      this.nextCheckAt = Date.now() + backoffMs;
      logger.warn('update check failed', {
        error: String(err),
        consecutiveFailures: this.consecutiveFailures,
        nextRetryIn: `${Math.round(backoffMs / 1000)}s`,
      });

      void this.metrics?.writeEvent('update_failure', {
        error: String(err),
        consecutive_failures: this.consecutiveFailures,
      });
      void this.metrics?.writeAlarm(
        'UPDATER_FAILURE_ALARM', '2',
        `update check failed (attempt ${this.consecutiveFailures}): ${String(err)}`,
      );

      // 超过阈值后仅标记 degraded，不停止 timer；这样网络或磁盘恢复后可无人工介入自愈。
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        logger.error('too many consecutive failures, updater entering degraded retry');
        void this.metrics?.writeEvent('updater_stopped_max_failures', {
          error: `${MAX_CONSECUTIVE_FAILURES} consecutive failures; degraded retry continues`,
          consecutive_failures: this.consecutiveFailures,
        });
      }
      await this.writeHeartbeat();
    } finally {
      // 不论中途 return 还是失败，都必须释放进程内锁，否则后续所有 timer 都会永久跳过。
      this.checking = false;
    }
  }

  /**
   * 以 30 秒 AbortSignal 获取 manifest。无 URL、非 2xx、网络或 JSON 异常返回 null，
   * 当前不会计入连续失败退避。
   *
   * @returns 解析后的最新版本声明；未配置 URL 或可预期请求失败时返回 `null`。
   * @throws 当前实现会捕获 `fetch`/JSON 异常，不向 `check()` 抛出。
   */
  private async fetchManifest(): Promise<VersionManifest | null> {
    const url = this.config.manifestUrl;
    if (!url) {
      logger.debug('no manifest URL configured');
      return null;
    }

    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) {
        logger.warn('manifest fetch failed', { status: resp.status, url });
        return null;
      }
      return await resp.json() as VersionManifest;
    } catch (err) {
      logger.debug('manifest fetch error', { error: String(err), url });
      return null;
    }
  }

  /**
   * 从 `current` 指向目录的 `VERSION` 读取 `version`/`git_commit`。
   *
   * @returns 当前版本元数据；指针、目录或 VERSION 文件不可用时返回 `null`，使上层按
   * “本地未安装”决定是否部署。
   */
  private async readLocalVersion(): Promise<LocalVersion | null> {
    const currentDir = await this.resolveCurrentVersionDir();
    if (!currentDir) return null;

    const versionFile = path.join(currentDir, 'VERSION');
    try {
      const content = await fs.readFile(versionFile, 'utf-8');
      const version = content.match(/^version=(.+)$/m)?.[1] ?? '';
      const gitCommit = content.match(/^git_commit=(.+)$/m)?.[1] ?? '';
      return { version, gitCommit };
    } catch {
      return null;
    }
  }

  /**
   * 远端数字版本更高、同版本 canary hotfix 更高或 git commit 不同时需要更新；远端版本
   * 更低明确跳过。
   *
   * @param local `readLocalVersion()` 读到的本地版本，`null` 表示需要初始安装。
   * @param manifest 经 `resolveTargetVersion()` 选中的 stable 或 canary 声明。
   * @param channel 决定是否比较 canary `hotfix_version`。
   * @returns `true` 表示后续应进入下载部署事务；本方法不读写文件。
   */
  needsUpdate(local: LocalVersion | null, manifest: VersionManifest, channel: 'stable' | 'canary' = 'stable'): boolean {
    if (!local) return true;
    const cmp = compareVersions(manifest.version, local.version);
    if (cmp > 0) return true;
    if (cmp < 0) {
      logger.debug('remote version is older than local, skipping', {
        local: local.version,
        remote: manifest.version,
      });
      return false;
    }

    if (channel === 'canary') {
      const remoteHotfix = (manifest as CanaryManifest).hotfix_version ?? 0;
      const localHotfix = this.config.canaryHotfixVersion ?? 0;
      if (remoteHotfix > localHotfix) return true;
    }

    if (manifest.git_commit && local.gitCommit !== manifest.git_commit) return true;
    return false;
  }

  /**
   * 按 canary policy 选择 stable/canary：off 固定稳定，latest 固定灰度，auto 使用
   * installId+canary version 的稳定 0..99 分桶；任何解析异常回退 stable。
   *
   * 分桶输入包含版本号，因此同一安装对同一版本的选择稳定，但新 canary 可以重新
   * 分布。本方法只选目标，不会修改 installId 或安装状态。
   *
   * @param latest 包含稳定版本及可选 canary 的顶层 manifest。
   * @returns 最终目标声明、通道及可选 hotfix 水位。
   */
  resolveTargetVersion(latest: LatestManifest): ResolvedTarget {
    try {
      const canary = latest.canary;
      if (!canary || typeof canary.rollout_percentage !== 'number') {
        logger.info('rollout resolved: channel=stable (no canary in manifest)', {
          stableVersion: latest.version,
          stableCommit: latest.git_commit,
        });
        return { manifest: latest, channel: 'stable' };
      }

      const canaryInfo = {
        canaryVersion: canary.version,
        canaryCommit: canary.git_commit,
        canaryHotfix: canary.hotfix_version ?? 0,
        rolloutPercentage: canary.rollout_percentage,
        stableVersion: latest.version,
        stableCommit: latest.git_commit,
      };

      if (this.config.canaryPolicy === 'off') {
        logger.info('rollout resolved: channel=stable (canary policy=off)', {
          ...canaryInfo,
          target: latest.version,
        });
        return { manifest: latest, channel: 'stable' };
      }

      if (this.config.canaryPolicy === 'latest') {
        logger.info('rollout resolved: channel=canary (canary policy=latest)', {
          ...canaryInfo,
          target: canary.version,
        });
        return { manifest: canary, channel: 'canary', hotfixVersion: canary.hotfix_version };
      }

      const installId = this.config.installId;
      if (!installId) {
        logger.warn('rollout resolved: channel=stable (no installId for bucketing)', canaryInfo);
        return { manifest: latest, channel: 'stable' };
      }
      const bucket = deterministicBucket(installId, canary.version);

      if (bucket < canary.rollout_percentage) {
        logger.info('rollout resolved: channel=canary', {
          ...canaryInfo,
          target: canary.version,
          installId,
          bucket,
        });
        return { manifest: canary, channel: 'canary', hotfixVersion: canary.hotfix_version };
      }

      logger.info('rollout resolved: channel=stable', {
        ...canaryInfo,
        target: latest.version,
        installId,
        bucket,
      });
      return { manifest: latest, channel: 'stable' };
    } catch (err) {
      logger.warn('canary resolution failed, falling back to stable', {
        error: String(err),
        stableVersion: latest.version,
        hasCanary: !!latest.canary,
      });
      return { manifest: latest, channel: 'stable' };
    }
  }

  /**
   * 缺 `installId` 时生成 UUID 并 best-effort 回写 config。
   *
   * `check()` 在灰度分桶前调用。内存配置无论写盘成败都会更新，保证当前进程
   * 后续轮次的分桶稳定；如果写盘失败，下次进程启动可能生成新 ID。
   *
   * @returns installId 已存在或已在内存中建立后兑现；持久化失败不 reject。
   */
  private async ensureInstallId(): Promise<void> {
    if (this.config.installId) return;

    const id = crypto.randomUUID();
    this.config = { ...this.config, installId: id };

    try {
      const configFile = await readJsonFile<Record<string, unknown>>(this.configPath) ?? {};
      configFile.installId = id;
      await writeJsonFile(this.configPath, configFile);
      logger.info('generated installId', { installId: id });
    } catch (err) {
      logger.warn('failed to persist installId', { error: String(err) });
    }
  }

  /**
   * best-effort 把已安装 canary `hotfix_version` 合并回 `config.canary`。
   *
   * @param hotfixVersion 已成功激活的灰度热修编号；下次 `needsUpdate()` 以它作为本地水位。
   * @returns 写入完成后兑现；文件失败只告警，不否定已成功的版本激活。
   */
  private async persistCanaryState(hotfixVersion: number): Promise<void> {
    try {
      const configFile = await readJsonFile<Record<string, unknown>>(this.configPath) ?? {};
      const existing = (configFile.canary as Record<string, unknown>) ?? {};
      configFile.canary = { ...existing, hotfix_version: hotfixVersion };
      await writeJsonFile(this.configPath, configFile);
    } catch (err) {
      logger.warn('failed to persist canary state', { error: String(err) });
    }
  }

  /**
   * 更新部署事务：
   * 1. 五分钟超时下载并可选校验 SHA-256；
   * 2. tar 解压、校验 package/dist，复制到 candidate；
   * 3. npm production install、sqlite3 smoke test、best-effort postinstall；
   * 4. candidate 改名为版本目录，原子切 previous/current，并同步稳定启动脚本。
   *
   * 最终激活失败会恢复指针和旧脚本；临时目录在 finally 清理。成功后 Collector 重启由
   * 外层 check 单独调用。
   *
   * @param packageUrl 选中版本的 tar.gz 地址，需要能由 Node.js `fetch` 访问。
   * @param manifest 目标版本/提交和可选 SHA-256，用于目录命名与完整性校验。
   * @returns 新版本目录、稳定脚本和指针全部提交后兑现。
   * @throws 下载超时/HTTP 失败、哈希不匹配、tar 或 npm/sqlite3 校验失败、文件系统错误。
   */
  private async downloadAndDeploy(
    packageUrl: string,
    manifest: VersionManifest,
  ): Promise<void> {
    const { cacheDir, versionsDir } = this.paths;
    const tmpDir = path.join(cacheDir, 'download-tmp');
    const tarball = path.join(tmpDir, 'package.tar.gz');
    const dirName = `${manifest.version}_${manifest.git_commit}`;
    const targetDir = path.join(versionsDir, dirName);
    const stagingDir = path.join(versionsDir, `${dirName}.candidate`);
    let activated = false;
    let oldCurrent: string | null = null;
    let oldPrevious: string | null = null;

    try {
      // 每轮先清掉上次崩溃可能留下的临时包和 candidate，避免新旧文件混合。
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.rm(stagingDir, { recursive: true, force: true });
      await fs.mkdir(tmpDir, { recursive: true });

      logger.info('downloading update', { url: packageUrl });
      const resp = await fetch(packageUrl, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!resp.ok) {
        throw new Error(`download failed: ${resp.status} ${resp.statusText}`);
      }
      if (!resp.body) {
        throw new Error('download returned empty body');
      }

      const writeStream = createWriteStream(tarball);
      await pipeline(Readable.fromWeb(resp.body as any), writeStream);

      // 只有 manifest 声明了期望值才能做完整性校验；不匹配必须在解压和执行包内代码前终止。
      if (manifest.sha256) {
        const actual = await computeSha256(tarball);
        if (actual !== manifest.sha256) {
          throw new Error(
            `SHA-256 mismatch: expected ${manifest.sha256}, got ${actual}`,
          );
        }
        logger.info('SHA-256 verified');
        void this.metrics?.writeEvent('download_verified', {
          latest_version: manifest.version,
        });
      } else {
        logger.warn('manifest missing sha256, skipping integrity check');
      }

      logger.info('extracting update');
      await execFileAsync('tar', ['-xzf', tarball, '-C', tmpDir]);

      const extractedDir = await this.findExtractedPackage(tmpDir);
      if (!extractedDir) {
        throw new Error('extracted package has no package.json');
      }

      const distIndex = path.join(extractedDir, 'dist', 'index.js');
      const hasDist = await fs.access(distIndex).then(() => true).catch(() => false);
      if (!hasDist) {
        throw new Error('extracted package missing dist/index.js');
      }

      await fs.mkdir(versionsDir, { recursive: true });
      // 依赖安装和 smoke test 都在未被 current 引用的 candidate 中进行，失败不会污染在线版本。
      await fs.cp(extractedDir, stagingDir, { recursive: true });

      const childEnv = buildChildEnv();

      logger.info('running npm install', { PATH: childEnv.PATH });
      await execFileAsync('npm', ['install', '--production', '--no-optional'], {
        cwd: stagingDir,
        env: childEnv,
        timeout: NPM_INSTALL_TIMEOUT_MS,
        shell: process.platform === 'win32',
      });

      logger.info('checking sqlite3 runtime');
      await execFileAsync(process.execPath, ['-e', "require('sqlite3')"], {
        cwd: stagingDir,
        env: childEnv,
        timeout: 30_000,
      });

      // postinstall 只同步辅助资源，它失败不应否定已通过 npm/sqlite3 检查的主包。
      const postinstallScript = path.join(stagingDir, 'scripts', 'postinstall.js');
      if (await fs.access(postinstallScript).then(() => true).catch(() => false)) {
        try {
          await execFileAsync(process.execPath, [postinstallScript], {
            cwd: stagingDir,
            env: childEnv,
            timeout: 30_000,
          });
        } catch (err) {
          logger.warn('postinstall failed, continuing', { error: String(err) });
        }
      }

      const { currentFile, previousFile } = this.paths;
      oldCurrent = await this.readPointerFile(currentFile);
      oldPrevious = await this.readPointerFile(previousFile);

      // 从改名 candidate 到同步稳定脚本是激活提交区；任一步失败都用事务前快照恢复指针。
      try {
        await fs.rm(targetDir, { recursive: true, force: true });
        await fs.rename(stagingDir, targetDir);

        if (oldCurrent && oldCurrent !== dirName) {
          await this.writePointerFile(previousFile, oldCurrent);
        }

        await this.writePointerFile(currentFile, dirName);
        await this.syncInstalledScripts(targetDir);
        activated = true;
      } catch (err) {
        logger.warn('failed to finalize update, restoring previous installation', { error: String(err) });
        await this.restorePointers(oldCurrent, oldPrevious);
        if (oldCurrent) {
          await this.syncInstalledScriptsForPointer(oldCurrent).catch((restoreErr) => {
            logger.warn('failed to restore installed scripts', { error: String(restoreErr) });
          });
        }
        throw err;
      }

      logger.info('update deployed', { version: manifest.version, dir: dirName });
    } finally {
      // 下载目录始终是临时资源；candidate 只在未成功改名为正式版本时需要额外删除。
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      if (!activated) {
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  /**
   * 在解压目录自身或一级子目录寻找 `package.json`，兼容 tarball 是否包含外层包目录。
   *
   * @param dir `tar -C` 使用的解压目录。
   * @returns 可作为版本根的目录，找不到时返回 `null`。
   * @throws `readdir`/`stat` 异常会交给部署事务计入失败和退避。
   */
  private async findExtractedPackage(dir: string): Promise<string | null> {
    const entries = await fs.readdir(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory() && entry !== '.' && entry !== '..') {
        const has = await fs.access(path.join(fullPath, 'package.json'))
          .then(() => true).catch(() => false);
        if (has) return fullPath;
      }
    }
    const hasRoot = await fs.access(path.join(dir, 'package.json'))
      .then(() => true).catch(() => false);
    return hasRoot ? dir : null;
  }

  /**
   * 写 updater-runtime.json：PID、版本指针、失败次数、下次检查时间。读取/写入异常只告警，
   * 避免健康文件故障终止更新循环。
   *
   * 它由 `start()` 立即触发、heartbeat timer 周期触发，也由 `check()` 在成功/失败边界调用。
   * 写入采用 `writeJsonFile` 的原子替换语义，供 CLI/状态栏跨进程读取。
   *
   * @returns 尝试写入完成后兑现；配置关闭或 I/O 失败也不 reject。
   */
  private async writeHeartbeat(): Promise<void> {
    if (!this.config.enabled) return;

    try {
      const currentName = await this.readPointerFile(this.paths.currentFile);
      let local: LocalVersion | null = null;
      if (currentName) {
        const versionFile = path.join(this.paths.versionsDir, currentName, 'VERSION');
        try {
          const content = await fs.readFile(versionFile, 'utf-8');
          const version = content.match(/^version=(.+)$/m)?.[1] ?? 'unknown';
          const gitCommit = content.match(/^git_commit=(.+)$/m)?.[1] ?? '';
          local = { version, gitCommit };
        } catch {
          local = null;
        }
      }

      const state: UpdaterRuntimeState = {
        status: this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? 'degraded' : 'running',
        pid: process.pid,
        version: local?.version ?? 'unknown',
        versionDir: currentName,
        updatedAt: new Date().toISOString(),
        consecutiveFailures: this.consecutiveFailures,
      };
      if (local?.gitCommit) state.gitCommit = local.gitCommit;
      if (this.nextCheckAt > 0) {
        state.nextCheckAt = new Date(this.nextCheckAt).toISOString();
      }

      await writeJsonFile(this.paths.runtimeFile, state);
    } catch (err) {
      logger.warn('failed to write updater heartbeat', { error: String(err) });
    }
  }

  /**
   * 把版本内两个 bootstrap daemon 与平台 CLI 原子同步到不随 `current` 变化的稳定路径。
   *
   * 服务管理器不直接执行版本目录里的文件，因此切换指针时必须同步这些稳定入口。
   * 激活失败时，`syncInstalledScriptsForPointer()` 会用旧指针内容恢复它们。
   *
   * @param versionDir 已安装且已通过运行时检查的版本根目录。
   * @throws 源文件缺失或目标不可写会向激活事务抛出，从而触发指针回滚。
   */
  private async syncInstalledScripts(versionDir: string): Promise<void> {
    const { bootstrapDir, loongsuitePilotBin } = this.paths;
    const srcDir = path.join(versionDir, 'scripts');

    await fs.mkdir(bootstrapDir, { recursive: true });
    for (const name of ['collector-daemon.js', 'updater-daemon.js']) {
      const src = path.join(srcDir, name);
      const dst = path.join(bootstrapDir, name);
      await this.copyFileAtomic(src, dst);
    }

    const cliExt = process.platform === 'win32' ? '.ps1' : '.sh';
    const cliScript = path.join(srcDir, `loongsuite-pilot${cliExt}`);
    await fs.mkdir(path.dirname(loongsuitePilotBin), { recursive: true });
    await this.copyFileAtomic(cliScript, loongsuitePilotBin, 0o755);

    logger.info('installed scripts synced');
  }

  /**
   * 指针目录存在时同步其稳定脚本，供激活失败后回滚恢复。
   *
   * @param versionName `current` 快照中的目录名，不是任意绝对路径。
   * @returns 目录不存在时直接兑现；存在时等待全部脚本同步完成。
   */
  private async syncInstalledScriptsForPointer(versionName: string): Promise<void> {
    const dir = path.join(this.paths.versionsDir, versionName);
    const exists = await fs.access(dir).then(() => true).catch(() => false);
    if (!exists) return;
    await this.syncInstalledScripts(dir);
  }

  /**
   * 内容相同则只校正权限；不同时先复制到 `.tmp`、chmod，再 rename，避免启动器读半文件。
   *
   * @param src 版本目录中的源脚本。
   * @param dst 服务管理器或用户命令使用的稳定目标。
   * @param mode 需要校正的 Unix 权限；省略时保持系统默认。
   * @throws 读、写、chmod 或 rename 错误会向激活/回滚调用方传播。
   */
  private async copyFileAtomic(src: string, dst: string, mode?: number): Promise<void> {
    const srcContent = await fs.readFile(src);
    const dstContent = await fs.readFile(dst).catch(() => null);
    if (dstContent && srcContent.equals(dstContent)) {
      if (mode !== undefined) {
        const stat = await fs.stat(dst);
        if ((stat.mode & 0o777) !== mode) {
          await fs.chmod(dst, mode);
        }
      }
      return;
    }
    const tmp = dst + '.tmp';
    await fs.copyFile(src, tmp);
    if (mode !== undefined) {
      await fs.chmod(tmp, mode);
    }
    await fs.rename(tmp, dst);
  }

  /**
   * 通过 `.tmp` + rename 原子写单行版本指针。
   *
   * @param filePath `current` 或 `previous` 指针文件。
   * @param value `versions` 下的目录名；会自动补换行符便于 shell 工具读取。
   * @throws 临时文件写入或替换失败向事务调用方传播。
   */
  private async writePointerFile(filePath: string, value: string): Promise<void> {
    const tmp = filePath + '.tmp';
    await fs.writeFile(tmp, value + '\n');
    await fs.rename(tmp, filePath);
  }

  /**
   * 按事务前快照恢复 `current`/`previous`；原值为空时删除相应指针。
   *
   * @param currentValue 激活前 `current` 文件的内容。
   * @param previousValue 激活前 `previous` 文件的内容。
   * @throws 恢复失败会向 `downloadAndDeploy()` 传播；此时需通过日志人工核对指针。
   */
  private async restorePointers(currentValue: string | null, previousValue: string | null): Promise<void> {
    const { currentFile, previousFile } = this.paths;
    if (currentValue) {
      await this.writePointerFile(currentFile, currentValue);
    } else {
      await fs.rm(currentFile, { force: true });
    }

    if (previousValue) {
      await this.writePointerFile(previousFile, previousValue);
    } else {
      await fs.rm(previousFile, { force: true });
    }
  }

  /**
   * 调稳定 CLI 的 restart-collector，避免 Updater 重启自身。命令失败只告警，不回滚已激活
   * 版本，也不向 check 抛出。
   *
   * @returns 子进程退出或超时后兑现；非零退出已转换为日志，不 reject。
   * @remarks Windows 通过 `powershell.exe -File`执行 `.ps1`，Unix 直接执行已设可执行权限的 CLI。
   */
  private async restartCollector(): Promise<void> {
    logger.info('restarting collector service');
    try {
      const bin = this.paths.loongsuitePilotBin;
      let result: { stdout: string; stderr: string };
      if (process.platform === 'win32') {
        result = await execFileAsync('powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bin, 'restart-collector',
        ], { timeout: 30_000 });
      } else {
        result = await execFileAsync(bin, ['restart-collector'], { timeout: 30_000 });
      }
      const output = (result.stdout || '').trim();
      if (output) logger.info('restart-collector output', { output });
      logger.info('collector restarted');
    } catch (err: any) {
      const stderr = err?.stderr?.trim?.() || '';
      const stdout = err?.stdout?.trim?.() || '';
      logger.warn('collector restart failed', {
        error: String(err?.message || err),
        stdout: stdout || undefined,
        stderr: stderr || undefined,
      });
    }
  }

  /**
   * 仅当 monitor/dashboard 任一 PID 存活时，用稳定 CLI 执行 stop/start。
   *
   * 这个条件保留用户更新前的期望状态：本来未运行的监控不会被更新器擅自启动。
   *
   * @returns 无需重启时立即兑现；子进程失败只记录告警，不回滚版本。
   */
  private async restartMonitorIfRunning(): Promise<void> {
    const monitorPidFile = path.join(this.paths.cacheDir, 'loongsuite-pilot-monitor.pid');
    const dashboardPidFile = path.join(this.paths.cacheDir, 'loongsuite-pilot-dashboard.pid');
    const monitorRunning = await this.isPidFileRunning(monitorPidFile);
    const dashboardRunning = await this.isPidFileRunning(dashboardPidFile);

    if (!monitorRunning && !dashboardRunning) return;

    logger.info('restarting monitor after update');
    try {
      const bin = this.paths.loongsuitePilotBin;
      if (process.platform === 'win32') {
        await execFileAsync('powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bin, 'monitor', 'stop',
        ], { timeout: 30_000 });
        await execFileAsync('powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bin, 'monitor', 'start',
        ], { timeout: 30_000 });
      } else {
        await execFileAsync(bin, ['monitor', 'stop'], { timeout: 30_000 });
        await execFileAsync(bin, ['monitor', 'start'], { timeout: 30_000 });
      }
      logger.info('monitor restarted');
    } catch (err) {
      logger.warn('monitor restart failed', { error: String(err) });
    }
  }

  /**
   * 读取正整数 PID 并用 signal 0 检查活性。
   *
   * @param pidFile monitor 或 dashboard 的 PID 文件。
   * @returns 文件合法且内核仍能找到该 PID 时为 `true`；任何异常按未运行处理。
   */
  private async isPidFileRunning(pidFile: string): Promise<boolean> {
    try {
      const raw = await fs.readFile(pidFile, 'utf-8');
      const pid = Number(raw.trim());
      if (!Number.isInteger(pid) || pid <= 0) return false;
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 保护 current/previous，其余版本按 mtime 从旧到新排序，每轮最多删除一个，控制 I/O。
   *
   * 无 `current` 时禁止 GC，因为此时无法证明哪个目录正被服务使用。单轮限制删除数
   * 可避免大量历史版本同时回收占用更新循环。整个 GC 是 best-effort，失败不影响已激活版本。
   *
   * @returns 本轮删除尝试结束后兑现；所有异常在内部降级为 debug 日志。
   */
  private async gcOldVersions(): Promise<void> {
    const { versionsDir, currentFile, previousFile } = this.paths;
    try {
      const currentName = await this.readPointerFile(currentFile);
      if (!currentName) {
        logger.debug('skipping version gc: current pointer missing');
        return;
      }
      const previousName = await this.readPointerFile(previousFile);

      let entries: string[];
      try {
        entries = await fs.readdir(versionsDir);
      } catch {
        return;
      }

      const staleVersions: Array<{ entry: string; fullPath: string; mtimeMs: number }> = [];
      for (const entry of entries) {
        if (entry === currentName || entry === previousName) continue;
        const fullPath = path.join(versionsDir, entry);
        const stat = await fs.stat(fullPath).catch(() => null);
        if (stat?.isDirectory()) {
          staleVersions.push({ entry, fullPath, mtimeMs: stat.mtimeMs ?? Number.MAX_SAFE_INTEGER });
        }
      }

      staleVersions.sort((a, b) => a.mtimeMs - b.mtimeMs || a.entry.localeCompare(b.entry));
      for (const version of staleVersions.slice(0, MAX_VERSION_GC_REMOVALS_PER_CHECK)) {
        logger.info('removing old version', {
          dir: version.entry,
          remaining: staleVersions.length - 1,
        });
        await fs.rm(version.fullPath, { recursive: true, force: true });
      }
    } catch (err) {
      logger.debug('gc failed', { error: String(err) });
    }
  }

  /**
   * 解析 `current` 版本目录，不可用时兼容旧 `<cache>/package/dist/index.js` 布局。
   *
   * @returns 存在的多版本目录或 legacy package 目录；两种布局都不可用时返回 `null`。
   * @remarks 本方法只验证目录/旧 `dist/index.js` 存在，具体 VERSION 解析由调用方完成。
   */
  private async resolveCurrentVersionDir(): Promise<string | null> {
    const { versionsDir, currentFile, cacheDir } = this.paths;
    const name = await this.readPointerFile(currentFile);
    if (name) {
      const dir = path.join(versionsDir, name);
      const exists = await fs.access(dir).then(() => true).catch(() => false);
      if (exists) return dir;
    }

    // 兼容旧单 package 布局。
    const legacyDir = path.join(cacheDir, 'package');
    const legacyExists = await fs.access(path.join(legacyDir, 'dist', 'index.js'))
      .then(() => true).catch(() => false);
    return legacyExists ? legacyDir : null;
  }

  /**
   * 容错读取并 trim 版本指针。
   *
   * @param filePath `current` 或 `previous` 文件路径。
   * @returns 非空目录名；文件缺失、空白或不可读时返回 `null`。
   */
  private async readPointerFile(filePath: string): Promise<string | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const trimmed = content.trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }
}
