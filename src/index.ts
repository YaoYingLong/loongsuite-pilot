#!/usr/bin/env node

// Shebang 告诉 Unix 类系统：直接执行构建后的脚本时使用 PATH 中的 node 解释器；Windows
// 由 npm 生成的命令包装器处理这一行。本文件同时承担两个角色：既是 loongsuite-pilot
// 命令的可执行入口，也是供其他模块按需导入核心组件的包入口。Collector 服务由
// scripts/collector-daemon.js 动态加载本文件。
import * as path from 'path';
import { Orchestrator } from './core/orchestrator.js';
import { loadConfig } from './core/config-loader.js';
import { createLogger, initFileLogging } from './utils/logger.js';
import { resolveHome, readInstalledVersion } from './utils/fs-utils.js';
import { writeStartupCrash, clearStartupCrash, resolveBreadcrumbDataDir } from './utils/crash-breadcrumb.js';
import { handleWorkerCli } from './local-workers/worker-cli.js';

const logger = createLogger('Main');

/**
 * 主启动流程。
 *
 * worker、token-usage 等短生命周期命令会先行分流；未命中子命令时才加载配置并启动
 * Orchestrator，避免普通 CLI 操作误启动常驻的数据采集服务。
 *
 * @throws 配置、日志初始化或 Orchestrator 必需阶段失败时向顶层 catch 传播。
 */
async function main(): Promise<void> {
  /**
   * 下标 0：执行程序的路径（/xxx/bun、/usr/bin/node）
   * 下标 1：当前执行脚本的文件绝对路径
   * 下标 2、3、4...：你在命令行手动传入的参数
   * slice(2)从数组第 3 位（索引 = 2）开始截取，丢掉前两项程序自带路径信息，只保留业务参数
   */
  const argv = process.argv.slice(2);

  // worker 子命令拥有独立的参数解析和退出码管理；返回 true 表示命令已处理完毕。
  if (await handleWorkerCli(argv)) {
    return;
  }

  const [command, ...args] = argv;
  // 数组解构把第一个业务参数作为子命令，其余参数原样交给该子命令自己的解析器。
  if (command === 'token-usage' || command === 'tokens') {
    // 动态 import() 返回 Promise；仅在执行 token 用量命令时加载模块，避免增加 Collector
    // 常规启动阶段的依赖和初始化副作用。
    const { runTokenUsageCommand } = await import('./cli/token-usage.js');
    // 设置 exitCode 让 Node 在标准输出排空后自然退出；这里不调用 process.exit() 强制截断。
    process.exitCode = await runTokenUsageCommand(args);
    return;
  }

  // 配置加载遵循“环境变量 > 配置文件 > 默认值”的优先级，并把多种历史写法归一化为
  // Orchestrator 可直接消费的完整 AnalyticsConfig。
  const config = await loadConfig();

  // 文件日志依赖最终解析出的 dataDir，因此必须在配置加载完成后初始化。
  // resolveHome 只展开路径开头的 `~`，把默认目录转换成当前用户下的绝对路径。
  const dataDir = resolveHome(config.dataDir);
  // path.join 使用当前平台分隔符，避免手工拼接在 Windows 上生成混合路径。
  const logDir = path.join(dataDir, 'logs');
  // initFileLogging 会创建父目录并安装滚动文件输出；它完成前的日志仍只写控制台。
  await initFileLogging(path.join(logDir, 'loongsuite-pilot-service.log'));

  if (!config.enabled) {
    // 配置禁用属于主动正常退出。清除旧记录，避免 Updater 将历史崩溃误判为本次启动失败。
    clearStartupCrash(resolveBreadcrumbDataDir());
    logger.info('analytics disabled via config or LOONGSUITE_PILOT_ENABLED=false');
    return;
  }

  // Orchestrator 是顶层编排器，负责串联部署、发现、输入采集、归一化和数据输出。
  const orchestrator = new Orchestrator(config);

  // 系统服务停止或前台收到 Ctrl+C 时，先有序释放各子模块资源，再退出进程。该命名闭包
  // 捕获当前 orchestrator 实例，交给两个信号监听器复用；异常会成为监听器 Promise 的
  // rejection（当前实现没有额外 catch，待确认是否需要统一记录关闭失败）。
  const shutdown = async () => {
    logger.info('shutdown signal received');
    await orchestrator.stop();
    // stop() 已等待输出队列和 checkpoint；此处显式退出，避免第三方依赖遗留句柄拖住进程。
    process.exit(0);
  };
  // EventEmitter 风格的信号监听器不能 await Promise，因此用 void 明确丢弃返回值；SIGINT
  // 通常来自 Ctrl+C，SIGTERM 通常来自 kill、容器或服务管理器。当前闭包没有重入锁，短时间
  // 收到多个信号时可能并行调用 stop()，但最终 process.exit() 会结束进程（待确认）。
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // start() 的 rejected Promise 由文件末尾 main().catch 统一记录为启动致命错误。
  await orchestrator.start();

  // start() 完成表示所有关键子系统已进入健康运行状态，此时清除上次启动失败记录。
  // 该目录必须与 daemon 写入端、Updater 读取端采用同一套“环境变量或默认值”规则，
  // 不能直接使用 config.dataDir，否则三方路径可能不一致。
  clearStartupCrash(resolveBreadcrumbDataDir());

  // 启动日志只列出实际启用的输出通道，便于快速确认当前数据去向。
  logger.info('AI Agent Input is running', {
    dataDir: config.dataDir,
    flushers: Object.entries(config.flushers)
      .filter(([, v]) => v?.enabled)
      .map(([k]) => k),
  });
}

// 捕获配置加载、日志初始化及 Orchestrator 启动阶段未处理的致命异常。
// 更早发生的 ESM 模块加载异常由 collector-daemon.js 记录为 module_load；这里记录为 startup。
main().catch((err) => {
  // Promise 顶层 catch 是 async/await 错误传播的最终边界；正常运行后的异步后台异常应由
  // 各子模块自行隔离，不会自动到达这里。
  logger.error('fatal startup error', { error: String(err) });
  const breadcrumbDir = resolveBreadcrumbDataDir();
  writeStartupCrash({
    dataDir: breadcrumbDir,
    phase: 'startup',
    version: readInstalledVersion(breadcrumbDir),
    error: err,
  });
  // 启动链尚未建立可靠的资源关闭顺序，写完 breadcrumb 后立即以非零码退出，交给 daemon
  // 或系统服务决定是否重启。
  process.exit(1);
});

// 以下导出用于将 loongsuite-pilot 作为库使用，不参与上面的进程启动编排。

// 核心编排、发现与准入控制能力。
export { Orchestrator } from './core/orchestrator.js';
export { InputManager } from './core/input-manager.js';
export { AgentControlManager } from './core/agent-control-manager.js';
export { AgentDiscoveryService } from './core/agent-discovery-service.js';

// HTTP Push Server 暂时停用，保留此处便于后续恢复公开导出。
// export { HttpPushServer } from './server/http-server.js';
export { loadConfig } from './core/config-loader.js';

// 输入源基类及需要对外复用的具体 Agent 输入实现。
export { BaseInput } from './inputs/base/base-input.js';
export { BaseIdeInput } from './inputs/base/base-ide-input.js';
export { BaseSqliteInput } from './inputs/base/base-sqlite-input.js';
export { BaseHookInput } from './inputs/base/base-hook-input.js';
export { BaseCliForwarder } from './inputs/base/base-cli-forwarder.js';
export { BaseSessionInput } from './inputs/base/base-session-input.js';
export { QoderSqliteInput } from './inputs/qoder-sqlite/qoder-sqlite-input.js';
export { QoderCnSqliteInput } from './inputs/qoder-cn-sqlite/qoder-cn-sqlite-input.js';
export { QoderCnInput } from './inputs/qoder-cn/qoder-cn-input.js';
export { QoderCnTraceInput } from './inputs/qoder-cn-trace/qoder-cn-trace-input.js';
export { QoderCliSessionInput } from './inputs/qoder-cli-session/qoder-cli-session-input.js';
export { CodexTranscriptInput } from './inputs/codex-transcript/codex-transcript-input.js';
export { CodexAbortedTurnInput } from './inputs/codex-aborted-turn/codex-aborted-turn-input.js';
export { PiCodingAgentLogInput } from './inputs/pi-coding-agent-log/pi-coding-agent-log-input.js';

// 数据输出接口、内置输出通道及多目标扇出实现。
export { BaseFlusher } from './flushers/base-flusher.js';
export { SlsFlusher } from './flushers/sls-flusher.js';
export { JsonlFlusher } from './flushers/jsonl-flusher.js';
export { HttpFlusher } from './flushers/http-flusher.js';
export { MultiFlusher } from './flushers/multi-flusher.js';

// Hook 部署与采集管道管理能力。
export { HookManager } from './hooks/hook-manager.js';
export { PipelineManager } from './pipeline/pipeline-manager.js';

// 统一公开事件结构、配置项和枚举等类型定义。
export * from './types/index.js';
