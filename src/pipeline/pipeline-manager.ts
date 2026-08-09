/**
 * 独立 Pipeline 的动态配置发现与生命周期管理器。
 *
 * Orchestrator 可选启动本类；它扫描 pipeline-configs JSON、校验配置、按 Type 创建文件或
 * Qoder API Pipeline，并监听配置新增/修改/删除。fs.watch 仅用于低延迟提示，每 60 秒 rescan
 * 是最终兜底；相同配置通过稳定 JSON hash 避免无意义重建。
 */

// 回调版 fs 只用于长生命周期目录 watcher；句柄由 stop() 显式关闭。
import * as fs from 'node:fs';
// Promise 版 fs 配合 async/await 完成扫描、读取和兼容目录迁移。
import * as fsPromises from 'node:fs/promises';
// path 用于把配置文件名拼成绝对路径；configName 自身另有白名单防止路径穿越。
import * as path from 'node:path';
// 类型导入编译后擦除，磁盘 JSON 仍必须经过 validateConfig 的运行时校验。
import type { PipelineConfig, PipelineManagerOptions, PipelineToggle, Pipeline } from './types.js';
// 两种具体 Pipeline 都实现 start/stop，并可选实现睡眠唤醒恢复钩子。
import { FilePipeline } from './input/file/file-pipeline.js';
import { QoderApiPipeline } from './input/qoder-api/qoder-api-pipeline.js';
// SleepDetector 只在 macOS 启动，用于补偿系统睡眠造成的 reader/watcher 时间跳跃。
import { SleepDetector, type WakeEvent } from './sleep-detector.js';
import { createLogger } from '../utils/logger.js';
import { ensureDir } from '../utils/fs-utils.js';

const logger = createLogger('PipelineManager');

/** 即使 fs.watch 没有事件，也至少每 60 秒让磁盘配置与运行实例收敛一次。 */
const RESCAN_INTERVAL_MS = 60_000;
/** configName 同时用于状态文件和 topic，只允许安全文件名字符。 */
const VALID_CONFIG_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * 管理运行中的 `configName -> Pipeline` 实例集合。
 *
 * PipelineManager 是独立采集子系统的所有者：Orchestrator 只调用 start/stop，本类负责动态配置
 * 热更新、实例构造和资源清理。`configHashes` 保存规范化配置指纹，`pipelines` 保存已经成功
 * start 的实例，两者共同决定新增、重建和删除。
 */
export class PipelineManager {
  /** 用户放置 Pipeline JSON 的动态配置目录。 */
  private readonly configDir: string;
  /** 各 Pipeline 保存 checkpoint/读取偏移的持久目录。 */
  private readonly stateDir: string;
  /** 独立 Pipeline 失败记录目录，不与主 Input 输出失败日志混用。 */
  private readonly failedLogDir: string;
  /** 运行数据根，继续传给具体 Pipeline 构造参数。 */
  private readonly dataDir: string;
  /** file/qoderApi 类型子开关；总开关在 Orchestrator 是否创建本类时已经应用。 */
  private readonly pipelineConfig: PipelineToggle;
  /** 仅保存 `start()` 已成功的实例，键是经校验的 configName。 */
  private readonly pipelines: Map<string, Pipeline> = new Map();
  /** configName 到稳定序列化文本；用于判断同名配置内容是否真正变化。 */
  private readonly configHashes: Map<string, string> = new Map();
  /** 配置目录 watcher；创建失败时保持 null 并依赖 rescanTimer。 */
  private watcher: fs.FSWatcher | null = null;
  /** 60 秒兜底扫描句柄；未 unref，因此 Orchestrator 必须在退出时调用 stop()。 */
  private rescanTimer: ReturnType<typeof setInterval> | null = null;
  /** Manager 私有的睡眠探测器，不与其他子系统共享 listener。 */
  private readonly sleepDetector = new SleepDetector();
  /** start/stop 和扫描循环共同读取的生命周期门禁。 */
  private running = false;
  /** rescanInProgress/Queued 把 watcher、timer、wake 的并发请求合并成串行扫描。 */
  private rescanInProgress = false;
  private rescanQueued = false;

  /**
   * 保存目录和功能开关；构造阶段不创建目录、watcher 或 Pipeline。
   *
   * @param opts 配置/状态/失败目录、数据根及 file/qoderApi 子开关。
   */
  constructor(opts: PipelineManagerOptions) {
    this.configDir = opts.configDir;
    this.stateDir = opts.stateDir;
    this.failedLogDir = opts.failedLogDir;
    this.dataDir = opts.dataDir;
    this.pipelineConfig = opts.pipelineConfig;
  }

  /**
   * 创建/迁移目录，完成首轮扫描，再建立 watcher 和周期兜底扫描。
   *
   * 首轮 `await fullRescan()` 保证 start 返回前当前合法配置已经尝试创建。`fs.watch` 回调只发起
   * 重扫，配置文件内容始终由 `scanConfigDir()` 重新完整读取，避免依赖不可靠的事件类型。
   * watcher 创建或运行失败不会让 start reject，而是保留 60 秒 timer 作为降级路径。
   *
   * @returns 首轮扫描完成、watcher/timer（以及 macOS SleepDetector）安装后兑现。
   * @throws 目录创建或首轮扫描的未隔离异常向 Orchestrator 传播。running 已先置 true，失败后
   * 再调用 start 会直接返回，是否应在异常路径恢复为 false 仍待确认。
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await ensureDir(this.configDir);
    await this.migrateStateDir();
    await this.migrateFailedLogDir();
    await ensureDir(this.stateDir);
    await ensureDir(this.failedLogDir);

    await this.fullRescan();

    try {
      // watcher 默认 persistent=true，会维持事件循环；这是常驻 Collector 的预期行为。
      this.watcher = fs.watch(this.configDir, (_event, filename) => {
        // 只对 JSON 文件提示触发；完整 rescan 会重新读取整个目录处理删除/改名。
        if (filename && filename.endsWith('.json')) {
          void this.fullRescan();
        }
      });
      this.watcher.on('error', (err) => {
        logger.warn('config dir watcher error, relying on rescan', {
          error: String(err),
        });
        this.watcher?.close();
        this.watcher = null;
      });
    } catch (err) {
      logger.warn('failed to watch config dir, relying on rescan', {
        error: String(err),
      });
    }

    this.rescanTimer = setInterval(
      () => void this.fullRescan(),
      RESCAN_INTERVAL_MS,
    );

    // 当前只在 macOS 启用睡眠探测；其他平台依赖定时 rescan/各 Pipeline polling。
    if (process.platform === 'darwin') {
      this.sleepDetector.on('wake', (event: WakeEvent) => void this.handleWake(event));
      this.sleepDetector.start();
    }

    logger.info('started', {
      configDir: this.configDir,
      pipelines: this.pipelines.size,
    });
  }

  /**
   * 停止探测、watcher 和 timer，并行尽力关闭全部 Pipeline 后清理内存状态。
   *
   * 每个 `pipeline.stop()` 单独 catch，确保一个实例关闭失败不阻止其他实例释放资源；
   * `Promise.all` 等所有关闭任务 settle 后才清 Map。方法不抛单实例停止错误，只通过日志暴露。
   *
   * @returns 本轮快照中的全部 Pipeline 完成停止尝试后兑现。
   * @remarks 当前不保存正在执行的 fullRescan Promise；若 stop 与 createPipeline 的 await 重叠，
   * 新实例是否可能在 Map 清理后登记仍待确认。
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    this.sleepDetector.stop();

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = null;
    }

    const stopTasks = Array.from(this.pipelines.entries()).map(
      async ([name, pipeline]) => {
        try {
          await pipeline.stop();
        } catch (err) {
          logger.error('error stopping pipeline', {
            configName: name,
            error: String(err),
          });
        }
      },
    );
    await Promise.all(stopTasks);
    this.pipelines.clear();
    this.configHashes.clear();

    logger.info('stopped');
  }

  /**
   * 一次性兼容迁移：旧 `state/file-collection` 存在且新 `state/pipeline` 不存在时 rename，
   * 保留升级前文件 checkpoint。迁移失败只告警，随后仍创建新目录继续启动。
   */
  private async migrateStateDir(): Promise<void> {
    // 正则只替换目录末尾的 pipeline，避免误改父路径中恰好同名的片段。
    const oldDir = this.stateDir.replace(/[/\\]pipeline$/, '/file-collection');
    if (oldDir === this.stateDir) return;

    try {
      const oldExists = await fsPromises.access(oldDir).then(() => true).catch(() => false);
      const newExists = await fsPromises.access(this.stateDir).then(() => true).catch(() => false);

      if (oldExists && !newExists) {
        await fsPromises.rename(oldDir, this.stateDir);
        logger.info('migrated state directory', { from: oldDir, to: this.stateDir });
      }
    } catch (err) {
      logger.warn('state directory migration failed', {
        from: oldDir,
        to: this.stateDir,
        error: String(err),
      });
    }
  }

  /**
   * 一次性迁移旧 `logs/file-collection-failed` 到 `logs/pipeline-failed`，避免升级后诊断孤立。
   */
  private async migrateFailedLogDir(): Promise<void> {
    // 与状态迁移相同，仅在传入目录使用当前标准后缀时才能推导旧目录。
    const oldDir = this.failedLogDir.replace(/[/\\]pipeline-failed$/, '/file-collection-failed');
    if (oldDir === this.failedLogDir) return;

    try {
      const oldExists = await fsPromises.access(oldDir).then(() => true).catch(() => false);
      const newExists = await fsPromises.access(this.failedLogDir).then(() => true).catch(() => false);

      if (oldExists && !newExists) {
        await fsPromises.rename(oldDir, this.failedLogDir);
        logger.info('migrated failed-log directory', { from: oldDir, to: this.failedLogDir });
      }
    } catch (err) {
      logger.warn('failed-log directory migration failed', {
        from: oldDir,
        to: this.failedLogDir,
        error: String(err),
      });
    }
  }

  /**
   * 并行通知所有支持 `handleWake` 的 Pipeline 恢复，随后触发完整配置重扫。
   *
   * optional chaining 让未实现唤醒钩子的 Pipeline 立即完成。每个恢复任务隔离异常；全部结束后
   * 用 fire-and-forget 发起 rescan，扫描串行门会处理它与 watcher/timer 请求的竞争。
   */
  private async handleWake(event: WakeEvent): Promise<void> {
    if (!this.running) return;
    logger.info('handling system wake, recovering pipelines', {
      sleepDurationMs: event.sleepDurationMs,
      pipelines: this.pipelines.size,
    });

    const wakeTasks = Array.from(this.pipelines.entries()).map(
      async ([name, pipeline]) => {
        try {
          await pipeline.handleWake?.(event);
        } catch (err) {
          logger.error('wake recovery failed for pipeline', {
            configName: name,
            error: String(err),
          });
        }
      },
    );
    await Promise.all(wakeTasks);

    void this.fullRescan();
  }

  /**
   * 把 watcher、timer 和 wake 触发的完整重扫串行化。
   *
   * 扫描期间再收到任意数量的请求只设置一个布尔 `rescanQueued`，相当于合并通知；当前扫描的
   * `finally` 释放门后最多补一轮。`finally` 同时保证 `doRescan()` 抛错时不会永久锁住热更新。
   */
  private async fullRescan(): Promise<void> {
    if (this.rescanInProgress) {
      this.rescanQueued = true;
      return;
    }
    this.rescanInProgress = true;
    this.rescanQueued = false;

    try {
      await this.doRescan();
    } finally {
      this.rescanInProgress = false;
      if (this.rescanQueued && this.running) {
        this.rescanQueued = false;
        void this.fullRescan();
      }
    }
  }

  /**
   * 对比磁盘配置与运行实例：先删除磁盘已缺失项，再创建新增项，hash 变化时停止后重建。
   *
   * 顺序执行而非并行，避免两个配置同时迁移/写相同运行目录时扩大竞态。每处理一项都检查
   * `running`，使 stop 可以阻止扫描继续创建新资源。稳定序列化忽略对象键顺序，但保留数组顺序。
   */
  private async doRescan(): Promise<void> {
    if (!this.running) return;

    const diskConfigs = await this.scanConfigDir();
    const diskNames = new Set(diskConfigs.map((c) => c.configName));

    for (const [name] of this.pipelines) {
      if (!diskNames.has(name)) {
        await this.destroyPipeline(name);
      }
    }

    for (const config of diskConfigs) {
      // stableStringify 忽略对象 key 原始顺序，避免格式化 JSON 引起重建。
      const configJson = stableStringify(config);
      const existingHash = this.configHashes.get(config.configName);

      if (!this.running) return;

      if (!this.pipelines.has(config.configName)) {
        await this.createPipeline(config);
        this.configHashes.set(config.configName, configJson);
      } else if (existingHash !== configJson) {
        logger.info('config changed, recreating pipeline', {
          configName: config.configName,
        });
        await this.destroyPipeline(config.configName);
        await this.createPipeline(config);
        this.configHashes.set(config.configName, configJson);
      }
    }
  }

  /**
   * 读取目录内所有 `.json`，逐个解析并做运行时最低限度校验。
   *
   * TypeScript 接口不会验证磁盘 JSON，所以必须在这里检查必填字段。目录不存在返回空数组；
   * 单文件读取、JSON.parse 或校验失败只记录并跳过，不影响同目录其他 Pipeline。
   */
  private async scanConfigDir(): Promise<PipelineConfig[]> {
    let entries: string[];
    try {
      entries = await fsPromises.readdir(this.configDir);
    } catch {
      return [];
    }

    // 目录项不显式排序；若多个文件声明同一 configName，本轮最后处理的有效文件决定最终实例。
    const configs: PipelineConfig[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const filePath = path.join(this.configDir, entry);
      try {
        const raw = await fsPromises.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as PipelineConfig;
        if (!this.validateConfig(parsed, entry)) continue;
        configs.push(parsed);
      } catch (err) {
        logger.warn('failed to parse config file', {
          file: entry,
          error: String(err),
        });
      }
    }
    return configs;
  }

  /**
   * 校验安全 `configName`、至少一个 input/flusher 和当前类型的必填字段。
   *
   * `configName` 会进入状态文件名和 SLS topic，所以只允许字母、数字、点、下划线和连字符，
   * 且首字符必须是字母或数字；这样可排除路径分隔符和以点开头的隐藏/相对路径形式。
   * 当前运行逻辑只读取数组第 0 项；校验额外条目不会让它们自动变成多路输出。
   */
  private validateConfig(config: PipelineConfig, fileName: string): boolean {
    if (!config.configName) {
      logger.warn('config missing configName', { file: fileName });
      return false;
    }
    if (!VALID_CONFIG_NAME.test(config.configName)) {
      logger.warn('config has invalid configName (must match [a-zA-Z0-9._-])', {
        file: fileName,
        configName: config.configName,
      });
      return false;
    }
    if (!config.inputs || config.inputs.length === 0) {
      logger.warn('config missing inputs', { file: fileName });
      return false;
    }
    if (!config.flushers || config.flushers.length === 0) {
      logger.warn('config missing flushers', { file: fileName });
      return false;
    }

    // 当前实现只消费 inputs[0] 和 flushers[0]，额外条目不会创建多路 Pipeline。
    const input = config.inputs[0];
    const flusher = config.flushers[0];
    if (!flusher.Endpoint || !flusher.Project || !flusher.Logstore) {
      logger.warn('config flusher missing required fields', { file: fileName });
      return false;
    }

    switch (input.Type) {
      case 'input_file': {
        if (!input.FilePaths || input.FilePaths.length === 0) {
          logger.warn('config input missing FilePaths', { file: fileName });
          return false;
        }
        return true;
      }
      case 'input_qoder_api': {
        if (!input.ApiKey || !input.OrgId) {
          logger.warn('config input missing ApiKey or OrgId', { file: fileName });
          return false;
        }
        return true;
      }
      default:
        logger.warn('unknown input type', { file: fileName, type: (input as Record<string, unknown>).Type });
        return false;
    }
  }

  /**
   * 根据 input Type 和子开关构造、启动并登记 Pipeline。
   *
   * 只有 `await pipeline.start()` 成功后才写入 Map，因此 Map 中实例都满足“已启动”不变量。
   * 构造/启动异常在本方法内记录并吞掉，使一个错误配置不阻断其他配置；下次 rescan 因 Map 中
   * 仍无该名称会再次尝试。
   */
  private async createPipeline(config: PipelineConfig): Promise<void> {
    // 当前 Schema 是数组，但一条 config 只实例化 inputs[0]；validateConfig 已确保它存在。
    const inputType = config.inputs[0].Type;

    // 总开关由 Orchestrator 决定是否创建 Manager，这里再执行类型子开关。
    if (inputType === 'input_file' && !this.pipelineConfig.file.enabled) {
      logger.info('file pipeline disabled, skipping', { configName: config.configName });
      return;
    }
    if (inputType === 'input_qoder_api' && !this.pipelineConfig.qoderApi.enabled) {
      logger.info('qoder-api pipeline disabled, skipping', { configName: config.configName });
      return;
    }

    try {
      let pipeline: Pipeline;
      // 两种实现共享同一组选项；具体 Input/Flusher 细节在各 Pipeline 构造函数中创建。
      const opts = {
        config,
        stateDir: this.stateDir,
        failedLogDir: this.failedLogDir,
        dataDir: this.dataDir,
      };

      switch (inputType) {
        case 'input_file':
          pipeline = new FilePipeline(opts);
          break;
        case 'input_qoder_api':
          pipeline = new QoderApiPipeline(opts);
          break;
        default:
          logger.warn('unsupported input type, skipping', {
            configName: config.configName,
            type: inputType,
          });
          return;
      }

      await pipeline.start();
      this.pipelines.set(config.configName, pipeline);
      logger.info('pipeline created', { configName: config.configName, type: inputType });
    } catch (err) {
      logger.error('failed to create pipeline', {
        configName: config.configName,
        error: String(err),
      });
    }
  }

  /**
   * 幂等停止并移除指定实例及其配置 hash。
   *
   * 即使 stop 抛错也会删除 Map 条目，防止管理器继续把已要求删除的配置视为健康运行实例。
   */
  private async destroyPipeline(configName: string): Promise<void> {
    const pipeline = this.pipelines.get(configName);
    if (!pipeline) return;
    try {
      await pipeline.stop();
    } catch (err) {
      logger.error('error stopping pipeline', {
        configName,
        error: String(err),
      });
    }
    this.pipelines.delete(configName);
    this.configHashes.delete(configName);
    logger.info('pipeline destroyed', { configName });
  }
}

/**
 * 对普通对象递归按 key 排序后 `JSON.stringify`，用作配置内容稳定指纹。
 *
 * replacer 会在每个对象层级生成按键排序的新对象；数组不排序，因为 inputs/flushers 顺序具有
 * 语义。该值不是密码学 hash，只用于同一进程内比较配置内容是否改变。
 */
function stableStringify(obj: unknown): string {
  // JSON.stringify 会递归调用 replacer；每次遇到普通对象都复制为按 key 排序的新对象。
  return JSON.stringify(obj, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce<Record<string, unknown>>((sorted, k) => {
        sorted[k] = (value as Record<string, unknown>)[k];
        return sorted;
      }, {});
    }
    return value;
  });
}
