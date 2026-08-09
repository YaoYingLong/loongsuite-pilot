/**
 * `loongsuite-pilot worker` 子命令解析与输出层。
 *
 * `src/index.ts` 在加载 Collector 配置前调用 `handleWorkerCli()`；命中 connect/list/
 * status/disconnect/delete 后，本模块校验 flags、位置参数及 `--` 后 Runtime 透传参数，
 * 再调用 instance-store 修改声明文件或读取视图。函数通过设置 `process.exitCode` 表达
 * 命令失败而不直接 `process.exit()`，使异步写盘和测试有机会收尾；输出仅写 stdout/
 * stderr，不会启动常驻采集服务。
 */


// CLI 只读取全局 config.json 来定位 dataDir；实例状态的具体 I/O 委托给 instance-store。
import { readJsonFile, resolveHome } from '../utils/fs-utils.js';
// Store API 同时承担校验、凭据文件写入和原子状态更新，CLI 层只负责翻译用户输入/输出。
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
/** 命令错误由内部捕获并设置 process.exitCode=1。 */
export async function handleWorkerCli(argv: string[]): Promise<boolean> {
  // 只认相对于主命令的 argv；未命中时绝不能修改 stdout、stderr 或 exitCode。
  if (argv[0] !== 'worker') return false;

  // 缺少子命令时保留空串，default 分支会打印帮助并把它视为成功的帮助请求。
  const command = argv[1] ?? '';
  try {
    // 所有实例配置和运行快照都以同一个 dataDir 为根目录。
    const dataDir = await resolveWorkerDataDir();

    switch (command) {
      case 'connect':
        // 每个分支独立解析 argv[2..]，避免 `worker` 和子命令被误当位置参数。
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
  // 非空环境变量是服务脚本和测试最直接的覆盖入口。
  const envDataDir = process.env.LOONGSUITE_PILOT_DATA_DIR;
  if (envDataDir && envDataDir.trim() !== '') {
    return resolveHome(envDataDir);
  }

  // AGENT_DATA_COLLECTION_CONFIG 改的是配置文件位置，不等于 dataDir 本身。
  const configPath = resolveHome(process.env.AGENT_DATA_COLLECTION_CONFIG ?? '~/.loongsuite-pilot/config.json');
  // readJsonFile 对不存在/坏 JSON 返回 null，因此此处自然降级到标准数据目录。
  const file = await readJsonFile<{ dataDir?: string }>(configPath);
  return resolveHome(file?.dataDir ?? '~/.loongsuite-pilot');
}

/**
 * 新建 Local Worker 实例，或按第一个位置参数重连已有实例。
 *
 * @param dataDir 实例声明、凭据和运行快照所在的数据根目录。
 * @param args 已拆分的 Pilot flags、位置参数及 Runtime 透传参数。
 * @returns 所有写盘和输出完成后兑现；没有业务返回值。
 * @throws 参数组合非法、bootstrap token 无效或 Store 持久化失败时抛出，由 handleWorkerCli
 * 统一写 stderr 并设置退出码 1。
 *
 * 副作用：可能创建实例目录、写 token/instance.json，并向 stdout 输出人类文本或 JSON。
 */
async function connectCommand(dataDir: string, args: ParsedArgs): Promise<void> {
  // `--` 后的参数只在 connect 中合法，稍后会保存为 runtimeOptions。
  validateFlags(args, ['runtime', 'bootstrap-token', 'work-dir', 'json'], { allowRuntimeOptions: true });
  const existingId = args.positional[0];
  if (existingId) {
    // 带位置参数时进入重连模式，Runtime 类型沿用原实例，不允许被 CLI 改写。
    if (optionalString(args, 'runtime')) {
      throw new Error('--runtime is only valid when creating a new local worker');
    }
    // reconnectLocalWorker 会验证实例存在，并在成功持久化后返回更新后的声明。
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
  // requiredString 不接受单独的 `--runtime` 布尔形态，也不接受纯空白值。
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

/**
 * 列出全部实例聚合视图，默认输出等宽表，`--json` 输出完整数组。
 * 该命令只读磁盘；即使某个进程正在变化，也以 Store 读取到的瞬时快照为准。
 */
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

/**
 * 输出单实例详细视图；未给 ID 时复用 list 行为，不存在时抛用户输入错误。
 * `readLocalWorkerView` 会把声明和多个状态文件合并，但不会启动或探测新的 Worker。
 */
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
  // PID 为 0/undefined 时省略该行，避免把“无进程”展示成有效进程号。
  if (view.pid) console.log(`PID:         ${view.pid}`);
  console.log(`WorkDir:     ${view.workDir}`);
  console.log(`Worker:      ${view.workerName ?? '-'}`);
  console.log(`Team:        ${view.teamName ?? '-'}`);
  console.log(`Matrix:      ${view.matrix ?? '-'}`);
  console.log(`Room:        ${view.roomId ?? '-'}`);
  console.log(`Heartbeat:   ${view.heartbeat ?? '-'}`);
  console.log(`Log:         ${view.logPath}`);
}

/**
 * 把实例期望状态 `enabled` 写为 false；本命令本身不发送信号或等待子进程退出。
 * 常驻 Collector 的 ActivationService 在下一轮状态收敛时才真正停止 Worker。
 */
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

/**
 * 删除已禁用且无存活进程的实例目录。
 * Store 层负责危险条件校验；成功后人类输出和 JSON 输出都只确认删除结果。
 */
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
  // Record 采用最后一次赋值覆盖前值；重复 flag 的最终值由最靠后的参数决定。
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const passthrough: string[] = [];
  let passthroughProvided = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (passthroughProvided) {
      // 分界线后不再解析，连第二个 `--` 也会作为 Runtime 原始参数保留。
      passthrough.push(arg);
      continue;
    }
    if (arg === '--') {
      passthroughProvided = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      // Pilot CLI 的位置参数主要是实例 ID；具体数量由各命令自行解释。
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      // 等号形式允许空值，例如 --work-dir=；后续 optionalString 会把空白视为未提供。
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      // 下一个非选项 token 归属于当前 flag，并通过 i += 1 阻止它再次进入位置参数。
      flags[key] = next;
      i += 1;
    } else {
      // 无显式值的 flag 保存 true；只应被 --json 等布尔选项接受。
      flags[key] = true;
    }
  }
  return { flags, positional, passthrough, passthroughProvided };
}

/** 校验 CLI 选项白名单，并限制只有 connect 能接收 Runtime 透传参数。 */
/** 校验未知 flag；allowRuntimeOptions 时接受 `runtime.*` 前缀。 */
function validateFlags(
  args: ParsedArgs,
  allowed: string[],
  opts: { allowRuntimeOptions?: boolean } = {},
): void {
  const allowedSet = new Set(allowed);
  for (const name of Object.keys(args.flags)) {
    // 白名单仅约束 Pilot 自身 flags；Runtime flags 必须放到独立 `--` 后，不能混入此 Record。
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
/** 把 key/value、key=value 和布尔开关解析为 RuntimeOptions。 */
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
      // `--name=` 是合法的显式空字符串，与完全不提供该选项不同。
      const key = body.slice(0, eq);
      if (!key) throw new Error(`runtime worker argument has empty name: ${arg}`);
      options[key] = body.slice(eq + 1);
      continue;
    }

    if (!body) throw new Error(`runtime worker argument has empty name: ${arg}`);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      // Runtime 参数也使用“下一非选项 token 是值”的约定；负数等非 `--` 文本可作为值。
      options[body] = next;
      i += 1;
    } else {
      options[body] = true;
    }
  }
  return options;
}

/** 读取必填字符串选项；缺失、布尔开关或纯空白值都视为未提供。 */
/** 读取必填非空字符串 flag，否则抛用户输入错误。 */
function requiredString(args: ParsedArgs, name: string): string {
  const value = optionalString(args, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

/** 读取非空字符串选项，布尔开关不会被隐式转换成字符串。 */
/** 读取可选字符串 flag；布尔形态视为未提供值。 */
function optionalString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** 按每列最长内容生成简单的等宽文本表格。 */
/** 按列最大宽度输出左对齐纯文本表格。 */
function printTable(rows: string[][]): void {
  // 调用方保证至少有表头且每行列数一致；padEnd 只按 JS 字符长度，不处理全角字符宽度。
  const widths = rows[0].map((_, index) => Math.max(...rows.map(row => row[index].length)));
  for (const row of rows) {
    console.log(row.map((cell, index) => cell.padEnd(widths[index])).join('  '));
  }
}

/** 输出 worker 子命令帮助文本。 */
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
