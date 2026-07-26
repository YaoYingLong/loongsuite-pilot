/**
 * Updater 独立进程入口。
 *
 * `scripts/updater-daemon.js` 根据 current 指针加载本文件的构建产物；本文件负责
 * 初始化日志、解析自动更新配置、启动指标采集并管理 Updater 的进程生命周期。
 * 版本检查、下载、校验和部署等核心更新逻辑由 Updater 类实现。
 */
import * as path from 'path';
import * as os from 'os';
import { Updater } from './updater.js';
import { UpdaterMetrics } from './updater-metrics.js';
import { buildAutoUpdateConfig, type ConfigFile } from '../core/config-loader.js';
import { createLogger, initFileLogging } from '../utils/logger.js';
import { readJsonFile, resolveHome, readInstalledVersion } from '../utils/fs-utils.js';

const logger = createLogger('UpdaterMain');

const DEFAULT_CONFIG_PATH = '~/.loongsuite-pilot/config.json';

async function main(): Promise<void> {
  // 数据目录用于存放 updater 日志、版本指针、运行状态以及 collector PID 文件。
  // LOONGSUITE_PILOT_DATA_DIR 可覆盖默认的 ~/.loongsuite-pilot 目录。
  const dataDir = resolveHome(
    process.env.LOONGSUITE_PILOT_DATA_DIR ?? path.join(os.homedir(), '.loongsuite-pilot'),
  );

  // 先初始化文件日志，使后续配置读取和启动阶段的异常也能写入 updater 日志。
  await initFileLogging(path.join(dataDir, 'logs', 'loongsuite-pilot-updater.log'));

  logger.info('updater process starting');

  // CLI 启动服务时会通过 AGENT_DATA_COLLECTION_CONFIG 指定配置文件；
  // 未指定时使用用户目录下的默认配置。
  const configPath = resolveHome(
    process.env.AGENT_DATA_COLLECTION_CONFIG ?? DEFAULT_CONFIG_PATH,
  );

  // buildAutoUpdateConfig 按“环境变量 > 配置文件 > 内置默认值”的优先级
  // 生成 updater 实际使用的配置。配置文件不存在时 file 为 null，仍可使用默认值。
  const file = await readJsonFile<ConfigFile>(configPath);
  const config = buildAutoUpdateConfig(file);

  // 关闭自动更新属于正常配置状态，因此以成功状态码退出，避免服务管理器反复重启。
  if (!config.enabled) {
    logger.info('auto-update disabled via config, exiting');
    process.exit(0);
  }

  // userId 用于 updater 指标标识，优先级与主 collector 保持一致。
  const userId = process.env.LOONGSUITE_PILOT_USER_ID
    ?? file?.userId ?? file?.['user.id'] ?? os.hostname();

  // 指标模块记录 updater 事件并监测 collector 进程健康状态，因此需要当前版本、
  // 用户标识以及 collector PID 文件路径。
  const version = readInstalledVersion(dataDir);
  const metrics = new UpdaterMetrics({
    dataDir,
    version,
    collectorPidFile: path.join(dataDir, 'loongsuite-pilot.pid'),
    userId,
  });
  await metrics.start();

  // 将指标实例注入 Updater，使更新检查、成功、失败等事件能够统一上报。
  const updater = new Updater(config);
  updater.setMetrics(metrics);

  // 收到退出信号后先停止更新定时任务，再等待指标模块刷新剩余数据。
  // 若清理过程超过 10 秒，则以失败状态强制退出，避免服务停止流程永久挂起。
  const shutdown = () => {
    logger.info('received shutdown signal');
    updater.stop();
    const exitTimeout = setTimeout(() => process.exit(1), 10_000);
    exitTimeout.unref();
    metrics.stop()
      .catch(err => logger.warn('metrics stop failed', { error: String(err) }))
      .finally(() => process.exit(0));
  };

  // 同时响应服务管理器常用的 SIGTERM 和终端中断产生的 SIGINT。
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // 启动定时版本检查和 updater 运行状态心跳。
  updater.start();

  logger.info('updater process running', {
    checkIntervalMs: config.checkIntervalMs,
    manifestUrl: config.manifestUrl,
  });
}

// 捕获初始化阶段未处理异常，记录致命错误后以非零状态退出，交由服务管理器处理。
main().catch((err) => {
  logger.error('updater fatal error', { error: String(err) });
  process.exit(1);
});
