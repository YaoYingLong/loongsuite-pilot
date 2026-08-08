/**
 * Collector 启动失败面包屑的读写工具。
 *
 * Bootstrap、Collector 与 Updater 通过一个小型 JSON 文件共享最近一次异常启动原因。这里的
 * 同步 I/O 位于错误或退出路径，采用 best-effort 语义，不能覆盖真正的异常或改变退出码。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveHome } from './fs-utils.js';

/** 标识异常发生在模块加载、业务启动还是正常运行阶段。 */
export type StartupCrashPhase = 'module_load' | 'startup' | 'runtime';

/** Updater 与 bootstrap 共同识别的版本 1 面包屑结构。 */
export interface StartupCrashBreadcrumb {
  /** 数据结构版本；读取者据此拒绝未知格式。 */
  schema: 1;
  /** 异常发生的 Unix 秒时间戳。 */
  ts: number;
  /** 异常发生阶段，用于区分依赖加载失败和业务启动失败。 */
  phase: StartupCrashPhase;
  /** 发生异常的安装版本。 */
  version: string;
  /** 写入文件的进程 PID，仅用于排障。 */
  pid: number;
  /** 原始异常的简短文本。 */
  error_message: string;
  /** 截断后的堆栈头，避免诊断文件无限增大。 */
  error_stack_head: string;
}

/** 三个进程约定的稳定文件名。 */
const FILE_NAME = 'last-startup-crash.json';
/** 堆栈同时受行数和字符数限制。 */
const STACK_HEAD_MAX_LINES = 10;
const STACK_HEAD_MAX_CHARS = 4000;

/**
 * @param dataDir Pilot 数据根目录。
 * @returns `logs/last-startup-crash.json` 的平台兼容路径。
 */
export function startupCrashPath(dataDir: string): string {
  return path.join(dataDir, 'logs', FILE_NAME);
}

/**
 * 解析面包屑唯一使用的数据目录。
 *
 * Updater（读取者）和 bootstrap（最早写入者）都只能可靠看到环境变量或默认路径，不能依赖
 * `config.dataDir`。写入、清理和读取统一使用这里，才能让“残留文件代表最近一次启动失败”
 * 在自定义配置目录场景下仍保持成立。
 *
 * @returns 已展开 `~` 的数据目录。
 */
export function resolveBreadcrumbDataDir(): string {
  // 环境变量由安装/服务脚本传入；未设置时使用标准用户数据目录。
  return resolveHome(process.env.LOONGSUITE_PILOT_DATA_DIR ?? '~/.loongsuite-pilot');
}

/** 截取堆栈头部；缺失堆栈时返回空字符串。 */
function truncateStackHead(stack: string | undefined): string {
  if (!stack) return '';
  // 同时兼容 Windows CRLF 和 Unix LF，优先保留最接近异常的前十行。
  const head = stack.split(/\r?\n/).slice(0, STACK_HEAD_MAX_LINES).join('\n');
  return head.length > STACK_HEAD_MAX_CHARS ? head.slice(0, STACK_HEAD_MAX_CHARS) : head;
}

/**
 * 持久化异常退出原因，供 Updater 后续判断启动健康度或回滚。
 *
 * @param opts 数据目录、失败阶段、当前版本和原始异常。
 * @returns 无返回值；任何文件系统错误都会被吞掉。
 */
export function writeStartupCrash(opts: {
  dataDir: string;
  phase: StartupCrashPhase;
  version: string;
  error: unknown;
}): void {
  try {
    // `unknown` 兼容 Error、字符串以及第三方代码抛出的任意值。
    const { error } = opts;
    const breadcrumb: StartupCrashBreadcrumb = {
      schema: 1,
      // Date.now() 是毫秒，落盘契约使用 Unix 秒。
      ts: Math.floor(Date.now() / 1000),
      phase: opts.phase,
      version: opts.version || 'unknown',
      pid: process.pid,
      error_message: error instanceof Error ? error.message : String(error),
      error_stack_head: truncateStackHead(error instanceof Error ? error.stack : undefined),
    };
    const file = startupCrashPath(opts.dataDir);
    // 先创建父目录，再写同目录临时文件并 rename，避免读取者看到半截 JSON。
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(breadcrumb, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // 尽力写诊断：失败不能掩盖调用方正在处理的真正崩溃。
  }
}

/**
 * 健康启动后删除旧面包屑，使残留文件始终表示最近一次启动失败。
 *
 * @param dataDir Pilot 数据根目录。
 */
export function clearStartupCrash(dataDir: string): void {
  try {
    // `force:true` 让文件不存在也视为成功，适合重复清理。
    fs.rmSync(startupCrashPath(dataDir), { force: true });
  } catch {
    // 清理失败只降低诊断准确性，不应让已健康的 Collector 退出。
  }
}

/**
 * 读取最近一次启动失败面包屑。
 *
 * @param dataDir Pilot 数据根目录。
 * @returns 合法的版本 1 数据；文件缺失、不可读、JSON 损坏或 schema 未知时返回 null。
 */
export function readStartupCrash(dataDir: string): StartupCrashBreadcrumb | null {
  try {
    // 类型断言只帮助 TypeScript；下面仍用 schema 做最小运行时校验。
    const parsed = JSON.parse(fs.readFileSync(startupCrashPath(dataDir), 'utf8')) as StartupCrashBreadcrumb;
    return parsed && parsed.schema === 1 ? parsed : null;
  } catch {
    return null;
  }
}
