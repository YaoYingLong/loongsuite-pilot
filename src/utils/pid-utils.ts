/**
 * Collector 与 Updater 的跨平台进程存活探测工具。
 *
 * 运维 CLI/watchdog 不能只相信 pid 文件，因为 PID 可能复用且文件可能陈旧。本模块先校验
 * pid 及命令行，再扫描进程表兜底；所有系统命令均有短超时并 fail-open，不启动或终止进程。
 */

// 同步 API 让一次 status/watchdog 检查看到一致的进程快照。
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';

/** 最终判定来自 pid 文件、进程扫描，或没有命中。 */
export type ProcessLivenessSource = 'pid-file' | 'process-scan' | 'none';
/** pid 文件自身的诊断状态。 */
export type PidFileState = 'missing' | 'invalid' | 'stale' | 'matched';
/** 字符串规则做包含匹配，正则用于识别带参数的 CLI 形式。 */
export type ProcessCommandPattern = string | RegExp;

/** 可直接供状态命令和 watchdog 记录的结构化存活结论。 */
export interface ProcessLiveness {
  running: boolean;
  pid?: number;
  source: ProcessLivenessSource;
  reason: string;
  pidFileState?: PidFileState;
  pidFileProcessAlive?: boolean;
  pidFileCommand?: string;
  pidFileCommandMatched?: boolean;
}

/** Collector bootstrap、二进制包装器和 `loongsuite-pilot run` 的识别规则。 */
export const COLLECTOR_PROCESS_PATTERNS: readonly ProcessCommandPattern[] = [
  'collector-daemon.js',
  '/bin/collector-daemon',
  '\\bin\\collector-daemon',
  /(?:^|[\s/\\])loongsuite-pilot(?:\.ps1)?\s+run(?:\s|$)/,
];

/** Updater bootstrap、包装器、CLI 子命令和 dist 入口的识别规则。 */
export const UPDATER_PROCESS_PATTERNS: readonly ProcessCommandPattern[] = [
  'updater-daemon.js',
  '/bin/updater-daemon',
  '\\bin\\updater-daemon',
  /(?:^|[\s/\\])loongsuite-pilot(?:\.ps1)?\s+run-updater(?:\s|$)/,
  'dist/updater/index.js',
];

/** 只检查 pid 文件指向的进程是否存在，不验证其命令归属。 */
export function isPidFileRunning(pidFile: string): boolean {
  const pid = readPidFile(pidFile);
  return pid !== null && isProcessAlive(pid);
}

/** 读取正整数 PID；文件缺失、不可读或内容非法时返回 null。 */
export function readPidFile(pidFile: string): number | null {
  try {
    const raw = fs.readFileSync(pidFile, 'utf-8');
    const pid = Number(raw.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * 通过 signal 0 探测进程，不真正发送终止信号。
 * EPERM 表示进程存在但当前用户无权发信号，因此仍视为存活。
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return isErrnoCode(err, 'EPERM');
  }
}

/** 判断完整命令行是否命中任一字符串包含规则或正则规则。 */
export function isCommandMatch(command: string, patterns: readonly ProcessCommandPattern[]): boolean {
  return patterns.some(pattern => typeof pattern === 'string'
    ? command.includes(pattern)
    : pattern.test(command));
}

/** 按当前操作系统选择 CIM 或 ps 扫描实现。 */
export function findProcessByCommand(patterns: readonly ProcessCommandPattern[]): ProcessLiveness {
  if (process.platform === 'win32') {
    return findWindowsProcessByCommand(patterns);
  }
  return findUnixProcessByCommand(patterns);
}

/**
 * 综合 pid 文件、PID 存活、命令归属和全系统扫描得出详细状态。
 *
 * @param pidFile 服务管理脚本维护的 pid 文件。
 * @param patterns 允许归属于目标进程的命令行规则。
 * @returns 不抛出探测异常的诊断结构。
 */
export function checkProcessLiveness(pidFile: string, patterns: readonly ProcessCommandPattern[]): ProcessLiveness {
  // 区分“文件不存在”和“文件存在但内容非法”，让上层日志更有诊断价值。
  const pid = readPidFile(pidFile);
  const pidFileStateWhenMissing: PidFileState = fs.existsSync(pidFile) ? 'invalid' : 'missing';
  let pidFileProcessAlive = false;
  let pidFileCommand = '';
  let pidFileCommandMatched: boolean | undefined;

  if (pid !== null) {
    // PID 存活仍不代表归属正确，因为操作系统可能复用旧 PID。
    pidFileProcessAlive = isProcessAlive(pid);
    if (pidFileProcessAlive) {
      pidFileCommand = readProcessCommand(pid);
      pidFileCommandMatched = pidFileCommand ? isCommandMatch(pidFileCommand, patterns) : undefined;
      if (pidFileCommandMatched === true) {
        // PID 与命令均匹配时优先信任 pid 文件，无需扫描全系统。
        return {
          running: true,
          pid,
          source: 'pid-file',
          reason: 'process is running with matching command',
          pidFileState: 'matched',
          pidFileProcessAlive,
          pidFileCommand,
          pidFileCommandMatched,
        };
      }
    }
  }

  const discovered = findProcessByCommand(patterns);
  if (discovered.running) {
    // 扫描命中说明服务实际运行，同时保留 pid 文件陈旧原因供修复。
    return {
      ...discovered,
      reason: pid === null
        ? `${discovered.reason}; pid file is ${pidFileStateWhenMissing}`
        : `${discovered.reason}; pid file points to stale or mismatched pid ${pid}`,
      pidFileState: pid === null ? pidFileStateWhenMissing : 'stale',
      pidFileProcessAlive,
      pidFileCommand,
      pidFileCommandMatched,
    };
  }

  return {
    running: false,
    pid: pid ?? undefined,
    source: 'none',
    reason: pid === null
      ? `pid file is ${pidFileStateWhenMissing}; no matching process found`
      : `pid file points to stale or mismatched pid ${pid}; no matching process found`,
    pidFileState: pid === null ? pidFileStateWhenMissing : 'stale',
    pidFileProcessAlive,
    pidFileCommand,
    pidFileCommandMatched,
  };
}

/** 按 PID 读取单个进程命令行；查询失败返回空串。 */
function readProcessCommand(pid: number): string {
  try {
    if (process.platform === 'win32') {
      // CIM 能取得完整 CommandLine；隐藏 PowerShell 窗口避免后台服务弹窗。
      return execFileSync('powershell.exe', [
        '-NoProfile',
        '-WindowStyle',
        'Hidden',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine`,
      ], { timeout: 5000, encoding: 'utf-8', windowsHide: true }).trim();
    }
    // Unix `command=` 末尾的等号表示省略 ps 表头。
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      timeout: 5000,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return '';
  }
}

/** 扫描 Unix 进程表并返回首个命中项。 */
function findUnixProcessByCommand(patterns: readonly ProcessCommandPattern[]): ProcessLiveness {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,command='], {
      timeout: 5000,
      encoding: 'utf-8',
    });
    for (const line of out.split(/\r?\n/)) {
      // 每行解析为开头 PID 与其后的完整命令行。
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const command = match[2] ?? '';
      if (pid === process.pid || !Number.isInteger(pid) || pid <= 0) continue;
      if (isCommandMatch(command, patterns)) {
        return {
          running: true,
          pid,
          source: 'process-scan',
          reason: 'matching process command found',
        };
      }
    }
  } catch {
    // ps 缺失、超时或权限失败属于尽力诊断，统一降级为未找到。
  }
  return { running: false, source: 'none', reason: 'no matching process found' };
}

/** 通过 PowerShell CIM 扫描 Windows 进程表。 */
function findWindowsProcessByCommand(patterns: readonly ProcessCommandPattern[]): ProcessLiveness {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile',
      '-WindowStyle',
      'Hidden',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
    ], { timeout: 8000, encoding: 'utf-8', windowsHide: true });
    for (const line of out.split(/\r?\n/)) {
      // PowerShell 输出使用制表符分隔 PID 和可能带空格的 CommandLine。
      const [pidRaw, command = ''] = line.split(/\t/, 2);
      const pid = Number(pidRaw);
      if (pid === process.pid || !Number.isInteger(pid) || pid <= 0) continue;
      if (isCommandMatch(command, patterns)) {
        return {
          running: true,
          pid,
          source: 'process-scan',
          reason: 'matching process command found',
        };
      }
    }
  } catch {
    // CIM 不可用、超时或权限失败时保持 fail-open。
  }
  return { running: false, source: 'none', reason: 'no matching process found' };
}

/** 类型安全地检查 Node.js 系统异常对象的 `code`。 */
function isErrnoCode(err: unknown, code: string): boolean {
  return err !== null
    && typeof err === 'object'
    && 'code' in err
    && (err as NodeJS.ErrnoException).code === code;
}
