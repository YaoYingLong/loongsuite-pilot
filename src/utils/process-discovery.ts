/**
 * Windows Updater 进程探测的薄封装。
 *
 * Updater watchdog 和运维状态检查通过这里复用 `pid-utils` 的命令行扫描规则。本文件只做
 * 平台门控，不启动或终止任何进程；非 Windows 平台直接返回 false，避免执行 PowerShell。
 */

// `.js` 后缀是 Node.js ESM 在编译产物中的运行时路径，TypeScript 会解析到同名 `.ts` 源文件。
import { findProcessByCommand, UPDATER_PROCESS_PATTERNS } from './pid-utils.js';

/**
 * 同步检查 Windows 上是否存在命令行匹配 Pilot Updater 的进程。
 *
 * @returns Windows 上返回进程扫描结果；其他平台始终为 false。
 */
export function isUpdaterRunningOnWindowsSync(): boolean {
  // 平台判断必须在扫描前完成，因为底层 Windows 扫描会同步调用 PowerShell/CIM。
  if (process.platform !== 'win32') return false;
  // 这里只暴露布尔结果；需要 PID 和诊断原因的调用方应直接使用 pid-utils。
  return findProcessByCommand(UPDATER_PROCESS_PATTERNS).running;
}
