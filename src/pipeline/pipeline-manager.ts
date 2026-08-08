/**
 * 独立 Pipeline 的动态配置发现与生命周期管理器。
 *
 * Orchestrator 可选启动本类；它扫描 pipeline-configs JSON、校验配置、按 Type 创建文件或
 * Qoder API Pipeline，并监听配置新增/修改/删除。fs.watch 仅用于低延迟提示，每 60 秒 rescan
 * 是最终兜底；相同配置通过稳定 JSON hash 避免无意义重建。
 */

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import type { PipelineConfig, PipelineManagerOptions, PipelineToggle, Pipeline } from './types.js';
import { FilePipeline } from './input/file/file-pipeline.js';
import { QoderApiPipeline } from './input/qoder-api/qoder-api-pipeline.js';
import { SleepDetector, type WakeEvent } from './sleep-detector.js';
import { createLogger } from '../utils/logger.js';
import { ensureDir } from '../utils/fs-utils.js';

const logger = createLogger('PipelineManager');

const RESCAN_INTERVAL_MS = 60_000;
/** configName 同时用于状态文件和 topic，只允许安全文件名字符。 */
const VALID_CONFIG_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** 管理运行中的 configName -> Pipeline 实例集合。 */
export class PipelineManager {
  private readonly configDir: string;
  private readonly stateDir: string;
  private readonly failedLogDir: string;
  private readonly dataDir: string;
  private readonly pipelineConfig: PipelineToggle;
  private readonly pipelines: Map<string, Pipeline> = new Map();
  private readonly configHashes: Map<string, string> = new Map();
  private watcher: fs.FSWatcher | null = null;
  private rescanTimer: ReturnType<typeof setInterval> | null = null;
  private readonly sleepDetector = new SleepDetector();
  private running = false;
  /** rescanInProgress/Queued 把 watcher、timer、wake 的并发请求合并成串行扫描。 */
  private rescanInProgress = false;
  private rescanQueued = false;

  /** @param opts 配置/状态/失败目录、数据根及 file/qoderApi 子开关。 */
  constructor(opts: PipelineManagerOptions) {
    this.configDir = opts.configDir;
    this.stateDir = opts.stateDir;
    this.failedLogDir = opts.failedLogDir;
    this.dataDir = opts.dataDir;
    this.pipelineConfig = opts.pipelineConfig;
  }

  /** 创建/迁移目录，首轮扫描，建立 watcher/周期扫描，并在 macOS 启动睡眠探测。 */
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

  /** 停止探测/watcher/timer，并行尽力关闭全部 Pipeline 后清内存状态。 */
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

  /** 并行通知所有支持 handleWake 的 Pipeline 恢复，随后触发完整配置重扫。 */
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

  /** 串行化完整重扫；扫描期间的新请求只设置 queued，结束后再补一轮。 */
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

  /** 对比磁盘配置与运行实例：删除缺失、创建新增、hash 变化时停止后重建。 */
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

  /** 读取目录内所有 `.json`，逐个解析/校验；单文件损坏不影响其他配置。 */
  private async scanConfigDir(): Promise<PipelineConfig[]> {
    let entries: string[];
    try {
      entries = await fsPromises.readdir(this.configDir);
    } catch {
      return [];
    }

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

  /** 校验安全 configName、至少一个 input/flusher 和各类型必填字段。 */
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

  /** 根据 input Type 和子开关构造、启动并登记 Pipeline；失败只影响该配置。 */
  private async createPipeline(config: PipelineConfig): Promise<void> {
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

  /** 幂等停止并移除指定实例及其配置 hash。 */
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

/** 对普通对象递归按 key 排序后 JSON.stringify，用作配置内容稳定指纹。 */
function stableStringify(obj: unknown): string {
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
