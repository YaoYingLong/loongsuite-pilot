import { readJsonFile, resolveHome } from '../utils/fs-utils.js';
import {
  connectLocalWorker,
  deleteLocalWorkerInstance,
  listLocalWorkerViews,
  readLocalWorkerInstance,
  readLocalWorkerView,
  reconnectLocalWorker,
  setLocalWorkerEnabled,
  type RuntimeOptions,
} from './instance-store.js';

/** worker 子命令解析后的四类参数。 */
interface ParsedArgs {
  /** `--key value`、`--key=value` 或无值布尔开关。 */
  flags: Record<string, string | boolean>;
  /** 不以 `--` 开头的普通位置参数，例如已有实例 ID。 */
  positional: string[];
  /** 首个独立 `--` 之后、原样交给 Worker Runtime 的参数。 */
  passthrough: string[];
  /** 是否显式出现过 `--`；用于区分“保持旧配置”和“显式清空 Runtime 参数”。 */
  passthroughProvided: boolean;
}

/**
 * 尝试处理 `loongsuite-pilot worker ...` 子命令。
 *
 * 返回 false 表示当前 argv 不属于 worker CLI，主入口应继续处理其他命令；返回 true
 * 表示本函数已经完成输出和退出码设置。这里不直接 process.exit()，以便调用方和测试
 * 仍有机会完成必要的异步收尾。
 */
export async function handleWorkerCli(argv: string[]): Promise<boolean> {
  if (argv[0] !== 'worker') return false;

  const command = argv[1] ?? '';
  try {
    // 所有实例配置和运行快照都以同一个 dataDir 为根目录。
    const dataDir = await resolveWorkerDataDir();

    switch (command) {
      case 'connect':
        await connectCommand(dataDir, parseArgs(argv.slice(2)));
        return true;
      case 'list':
        await listCommand(dataDir, parseArgs(argv.slice(2)));
        return true;
      case 'status':
        await statusCommand(dataDir, parseArgs(argv.slice(2)));
        return true;
      case 'disconnect':
        await disconnectCommand(dataDir, parseArgs(argv.slice(2)));
        return true;
      case 'delete':
        await deleteCommand(dataDir, parseArgs(argv.slice(2)));
        return true;
      default:
        printUsage();
        // 仅输入 `worker` 时视为帮助请求；输入未知子命令时返回失败退出码。
        process.exitCode = command ? 1 : 0;
        return true;
    }
  } catch (err) {
    // 参数错误、实例不存在和持久化失败都由 CLI 边界统一转成可读错误及退出码 1。
    console.error(`loongsuite-pilot worker: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return true;
  }
}

/**
 * 解析 Local Worker 数据目录。
 * 优先级为 LOONGSUITE_PILOT_DATA_DIR > 配置文件中的 dataDir > 默认目录；配置文件
 * 自身的位置可由 AGENT_DATA_COLLECTION_CONFIG 覆盖。配置缺失或 JSON 无效时回退默认值。
 */
async function resolveWorkerDataDir(): Promise<string> {
  const envDataDir = process.env.LOONGSUITE_PILOT_DATA_DIR;
  if (envDataDir && envDataDir.trim() !== '') {
    return resolveHome(envDataDir);
  }

  const configPath = resolveHome(process.env.AGENT_DATA_COLLECTION_CONFIG ?? '~/.loongsuite-pilot/config.json');
  const file = await readJsonFile<{ dataDir?: string }>(configPath);
  return resolveHome(file?.dataDir ?? '~/.loongsuite-pilot');
}

async function connectCommand(dataDir: string, args: ParsedArgs): Promise<void> {
  // `--` 后的参数只在 connect 中合法，稍后会保存为 runtimeOptions。
  validateFlags(args, ['runtime', 'bootstrap-token', 'work-dir', 'json'], { allowRuntimeOptions: true });
  const existingId = args.positional[0];
  if (existingId) {
    // 带位置参数时进入重连模式，Runtime 类型沿用原实例，不允许被 CLI 改写。
    if (optionalString(args, 'runtime')) {
      throw new Error('--runtime is only valid when creating a new local worker');
    }
    const instance = await reconnectLocalWorker({
      dataDir,
      instanceId: existingId,
      // token/workDir 未提供时保留旧值；出现 `--` 时则用解析结果替换全部 Runtime 参数，
      // 因此单独传一个空的 `--` 可以显式清空之前保存的 runtimeOptions。
      bootstrapToken: optionalString(args, 'bootstrap-token'),
      workDir: optionalString(args, 'work-dir'),
      runtimeOptions: args.passthroughProvided ? parseRuntimeOptions(args.passthrough) : undefined,
    });
    if (args.flags.json) {
      console.log(JSON.stringify(instance, null, 2));
      return;
    }
    console.log(`reconnected ${instance.id}`);
    console.log(`runtime: ${instance.runtime}`);
    console.log(`workDir: ${instance.workDir}`);
    return;
  }

  // 新建实例必须明确 Runtime 类型和首次认证所需的 bootstrap token。
  const runtime = requiredString(args, 'runtime');
  const bootstrapToken = requiredString(args, 'bootstrap-token');
  const instance = await connectLocalWorker({
    dataDir,
    runtime,
    bootstrapToken,
    workDir: optionalString(args, 'work-dir'),
    runtimeOptions: parseRuntimeOptions(args.passthrough),
  });

  if (args.flags.json) {
    console.log(JSON.stringify(instance, null, 2));
    return;
  }

  console.log(`connected ${instance.id}`);
  console.log(`runtime: ${instance.runtime}`);
  console.log(`workDir: ${instance.workDir}`);
}

async function listCommand(dataDir: string, args: ParsedArgs): Promise<void> {
  validateFlags(args, ['json']);
  // View 会把实例配置与 supervisor/worker/runtime/matrix 状态快照合并为展示模型。
  const views = await listLocalWorkerViews(dataDir);
  if (args.flags.json) {
    console.log(JSON.stringify(views, null, 2));
    return;
  }
  if (views.length === 0) {
    console.log('No local workers.');
    return;
  }

  // 先按列计算最大宽度，再统一补空格，保证多行终端输出纵向对齐。
  const rows = [
    ['ID', 'RUNTIME', 'STATE', 'WORKDIR', 'WORKER', 'UPDATED'],
    ...views.map(view => [
      view.id,
      view.runtime,
      view.state,
      view.workDir,
      view.workerName ?? '-',
      view.updatedAt,
    ]),
  ];
  printTable(rows);
}

async function statusCommand(dataDir: string, args: ParsedArgs): Promise<void> {
  validateFlags(args, ['json']);
  const id = args.positional[0];
  if (!id) {
    // status 未指定实例 ID 时与 list 等价，便于快速查看全部实例状态。
    await listCommand(dataDir, args);
    return;
  }

  const instance = await readLocalWorkerInstance(dataDir, id);
  if (!instance) throw new Error(`local worker not found: ${id}`);
  const view = await readLocalWorkerView(dataDir, instance);
  if (args.flags.json) {
    console.log(JSON.stringify(view, null, 2));
    return;
  }

  console.log(`ID:          ${view.id}`);
  console.log(`Runtime:     ${view.runtime}`);
  console.log(`State:       ${view.state}`);
  if (view.pid) console.log(`PID:         ${view.pid}`);
  console.log(`WorkDir:     ${view.workDir}`);
  console.log(`Worker:      ${view.workerName ?? '-'}`);
  console.log(`Team:        ${view.teamName ?? '-'}`);
  console.log(`Matrix:      ${view.matrix ?? '-'}`);
  console.log(`Room:        ${view.roomId ?? '-'}`);
  console.log(`Heartbeat:   ${view.heartbeat ?? '-'}`);
  console.log(`Log:         ${view.logPath}`);
}

async function disconnectCommand(dataDir: string, args: ParsedArgs): Promise<void> {
  validateFlags(args, ['json']);
  const id = args.positional[0];
  if (!id) throw new Error('instance id is required');
  // disconnect 只写入 enabled=false 的期望状态；后台 ActivationService 随后异步停止进程。
  const instance = await setLocalWorkerEnabled(dataDir, id, false);
  if (args.flags.json) {
    console.log(JSON.stringify(instance, null, 2));
    return;
  }
  console.log(`disconnect requested ${instance.id}`);
}

async function deleteCommand(dataDir: string, args: ParsedArgs): Promise<void> {
  validateFlags(args, ['json']);
  const id = args.positional[0];
  if (!id) throw new Error('instance id is required');
  // Store 层会再次确认实例已禁用且进程已退出，防止误删仍在使用的状态和凭据。
  await deleteLocalWorkerInstance(dataDir, id);
  if (args.flags.json) {
    console.log(JSON.stringify({ id, deleted: true }, null, 2));
    return;
  }
  console.log(`deleted ${id}`);
}

/**
 * 解析 worker CLI 自身的参数。
 *
 * 独立的 `--` 是不可逆分界线：其后的内容即使以 `--` 开头也不再由本层解释，而是
 * 原样收集到 passthrough。分界线之前同时支持 `--key=value`、`--key value` 和布尔开关。
 */
function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const passthrough: string[] = [];
  let passthroughProvided = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (passthroughProvided) {
      passthrough.push(arg);
      continue;
    }
    if (arg === '--') {
      passthroughProvided = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { flags, positional, passthrough, passthroughProvided };
}

/** 校验 CLI 选项白名单，并限制只有 connect 能接收 Runtime 透传参数。 */
function validateFlags(
  args: ParsedArgs,
  allowed: string[],
  opts: { allowRuntimeOptions?: boolean } = {},
): void {
  const allowedSet = new Set(allowed);
  for (const name of Object.keys(args.flags)) {
    if (allowedSet.has(name)) continue;
    throw new Error(`unknown option --${name}; pass runtime worker arguments after "--"`);
  }
  if (!opts.allowRuntimeOptions && args.passthroughProvided) {
    throw new Error('runtime worker arguments are only supported by connect');
  }
}

/**
 * 将 `--` 后的 Runtime 参数规范化为持久化对象。
 * 只接受选项形式，不接受位置参数；有值选项保存为字符串，无值选项保存为 true。
 */
function parseRuntimeOptions(argv: string[]): RuntimeOptions {
  const options: RuntimeOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--') || arg === '--') {
      throw new Error(`runtime worker argument must be an option: ${arg}`);
    }

    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      const key = body.slice(0, eq);
      if (!key) throw new Error(`runtime worker argument has empty name: ${arg}`);
      options[key] = body.slice(eq + 1);
      continue;
    }

    if (!body) throw new Error(`runtime worker argument has empty name: ${arg}`);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      options[body] = next;
      i += 1;
    } else {
      options[body] = true;
    }
  }
  return options;
}

/** 读取必填字符串选项；缺失、布尔开关或纯空白值都视为未提供。 */
function requiredString(args: ParsedArgs, name: string): string {
  const value = optionalString(args, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

/** 读取非空字符串选项，布尔开关不会被隐式转换成字符串。 */
function optionalString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** 按每列最长内容生成简单的等宽文本表格。 */
function printTable(rows: string[][]): void {
  const widths = rows[0].map((_, index) => Math.max(...rows.map(row => row[index].length)));
  for (const row of rows) {
    console.log(row.map((cell, index) => cell.padEnd(widths[index])).join('  '));
  }
}

function printUsage(): void {
  console.log(`Usage:
  loongsuite-pilot worker connect --runtime claude-code --bootstrap-token <token> [--work-dir <dir>] [-- <runtime-options...>]
  loongsuite-pilot worker connect <instanceId> [--bootstrap-token <token>] [--work-dir <dir>] [-- <runtime-options...>]
  loongsuite-pilot worker list [--json]
  loongsuite-pilot worker status [instanceId] [--json]
  loongsuite-pilot worker disconnect <instanceId>
  loongsuite-pilot worker delete <instanceId>

Notes:
  connect <instanceId> reconnects an existing disconnected worker without
  requiring the bootstrap token again. Pass --bootstrap-token to rotate the
  saved token file for that instance. Options after "--" are stored as runtime
  options and expanded by worker.manifest.json instance placeholders.`);
}
