/**
 * 进程级结构化日志门面。
 *
 * 模块加载时先创建默认 Pino logger；`src/index.ts` 解析 dataDir 后调用 `initFileLogging()`
 * 切换为按日轮转文件流。各模块持有的门面在每次写入时取得当前 child logger，因此无需重建。
 */

// Pino 负责结构化 JSON 日志，项目使用 ESM 默认导入。
import pino from 'pino';
// pino-roll 的默认导出 `build` 用于创建轮转写入流。
import build from 'pino-roll';
import { writeFile } from 'node:fs/promises';

/** 日志级别在模块加载时读取一次；未配置时为 info。 */
const LOG_LEVEL = (process.env.LOG_LEVEL?.toLowerCase() ?? 'info') as pino.Level;

const pinoOpts: pino.LoggerOptions = {
  level: LOG_LEVEL,
  formatters: {
    // Pino 默认输出数字 level；这里改为大写文本，便于直接阅读 JSONL 服务日志。
    level(label) {
      return { level: label.toUpperCase() };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

/** 初始化文件输出前使用的根 logger，之后会替换为 multistream logger。 */
let rootLogger: pino.Logger = pino(pinoOpts);

/** 防止重复创建 pino-roll stream。 */
let fileLoggingInitialized = false;
/** 根 logger 每替换一次递增，使旧 child cache 失效。 */
let loggerVersion = 0;
const childCache = new Map<string, { version: number; child: pino.Logger }>();

/** 获取带模块 tag 的 child logger，并按根 logger 版本缓存。 */
function getChild(tag: string): pino.Logger {
  const cached = childCache.get(tag);
  if (cached && cached.version === loggerVersion) return cached.child;
  const child = rootLogger.child({ tag });
  childCache.set(tag, { version: loggerVersion, child });
  return child;
}

/**
 * 启用由 pino-roll 管理的按日轮转文件日志。
 *
 * 使用进程内直写流而不是 worker transport，使快速退出前的日志更可能及时落盘。
 *
 * @param logFilePath 服务日志基础路径；实际轮转文件会带日期后缀。
 * @returns 初始化完成的 Promise；创建轮转流失败会向启动层 reject。
 */
export async function initFileLogging(logFilePath: string): Promise<void> {
  // 初始化是一次性操作；重复调用直接复用当前根 logger。
  // 标记在 await build 前设置，因此首次 build 失败后，本进程内再次调用不会自动重试。
  if (fileLoggingInitialized) return;
  fileLoggingInitialized = true;

  const fileStream = await build({
    // 日志文件地址，默认是~/.loongsuite-pilot/logs/loongsuite-pilot-service.log
    file: logFilePath,
    frequency: 'daily',
    mkdir: true,
    size: '50m',
    dateFormat: 'yyyy-MM-dd',
    limit: { count: 10, removeOtherLogFiles: true },
  });
  // 交互终端或显式开关下同时写 stdout；后台服务默认只写轮转文件，避免重复日志。
  const useStdout = process.stdout.isTTY || process.env.LOONGSUITE_PILOT_STDOUT === '1';
  // multistream 会把同一条达到级别阈值的日志复制到每个 StreamEntry。
  const streams: pino.StreamEntry[] = [{ stream: fileStream, level: LOG_LEVEL }];
  if (useStdout) {
    // 交互运行时把 stdout 放到数组前部，文件流仍始终保留。
    streams.unshift({ stream: process.stdout, level: LOG_LEVEL });
  } else {
    // Daemon 模式清空 launchd/服务管理器可能通过 StandardOutPath 打开的基础文件；
    // pino-roll 实际写日期后缀文件，基础文件保留旧内容会误导排障。
    await writeFile(logFilePath, '', 'utf8').catch(() => {});
  }
  // 以同一套格式选项创建新根 logger，并将日志扇出到所有启用的流。
  rootLogger = pino(pinoOpts, pino.multistream(streams));

  // 版本递增并清缓存，确保后续 tag 日志绑定新输出流。
  loggerVersion++;
  childCache.clear();
}

/** 业务模块可用的最小日志接口；meta 会作为结构化字段输出。 */
export type BoundLogger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
};

/**
 * 创建带固定模块 tag 的日志门面。
 *
 * @param tag 模块标识，例如 `input-manager`。
 * @returns 四种级别的方法；调用时才解析 child logger，兼容后续文件输出切换。
 */
export function createLogger(tag: string): BoundLogger {
  return {
    info: (message, meta) => {
      const c = getChild(tag);
      meta ? c.info(meta, message) : c.info(message);
    },
    warn: (message, meta) => {
      const c = getChild(tag);
      meta ? c.warn(meta, message) : c.warn(message);
    },
    error: (message, meta) => {
      const c = getChild(tag);
      meta ? c.error(meta, message) : c.error(message);
    },
    debug: (message, meta) => {
      const c = getChild(tag);
      meta ? c.debug(meta, message) : c.debug(message);
    },
  };
}
