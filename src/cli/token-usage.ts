/**
 * `loongsuite-pilot token-usage` 终端报表命令。
 *
 * 主入口仅在命中 `token-usage`/`tokens` 时动态导入本模块，避免常驻 Collector 支付
 * CLI 启动成本。模块只读取 status-bar 生成的 metrics-summary.json 与 runtime.json，
 * 选择其中今日/7 天/30 天统计，再以 ANSI 颜色、表格和进度条输出到 stdout；不启动
 * Orchestrator、网络请求或后台 timer。
 */


// `node:path` 只负责跨平台拼接数据目录；本命令不会创建或修改这些路径。
import * as path from 'node:path';
// 使用 Promise 版文件 API，便于同时读取摘要和运行状态，避免两次磁盘等待串行叠加。
import { readFile } from 'node:fs/promises';
// 复用项目的宽容 JSON 读取和 `~` 展开规则，使 CLI 与 Collector 解析同一数据目录。
import { readJsonFile, resolveHome } from '../utils/fs-utils.js';

/** CLI 支持的三个聚合区间，与 MetricsSummary.ranges key 一致。 */
export type MetricsRange = 'today' | 'sevenDays' | 'thirtyDays';

/** 带比例的排行项基类；`share` 是 0..1 的小数，渲染前还会再次做边界收敛。 */
export interface ShareEntry {
  /** 当前项占所在统计维度总量的比例；旧摘要可能缺失，所以是可选字段。 */
  share?: number;
}

/** 单模型 token 排行项，由状态栏摘要写入器预先聚合。 */
export interface ModelShareEntry extends ShareEntry {
  /** 上游模型标识；缺失时界面显示 unknown。 */
  model?: string;
  /** 该模型输入与输出 token 的合计。 */
  totalTokens?: number;
  /** 该模型累计输入 token。 */
  inputTokens?: number;
  /** 输入中命中缓存的 token 数，用于排行后的补充说明。 */
  cacheReadTokens?: number;
}

/** 单 Agent 产品的会话、事件与 token 排行项。 */
export interface AgentShareEntry extends ShareEntry {
  /** Agent ID，例如 codex 或 claude-code。 */
  agentType?: string;
  /** 选定日期区间内出现的去重会话数。 */
  sessions?: number;
  /** 选定日期区间内的 canonical 事件数。 */
  events?: number;
  /** 该 Agent 归属的 token 总量。 */
  tokens?: number;
}

/** 单模型服务商的 token 排行项。 */
export interface ProviderShareEntry extends ShareEntry {
  /** Provider 名称，例如 openai 或 anthropic。 */
  provider?: string;
  /** 该 Provider 在区间内的 token 总量。 */
  totalTokens?: number;
}

/** 单 Git 仓库的活动排行；当前摘要不计算 token 占比。 */
export interface RepoShareEntry {
  /** 规范化后的仓库名；无法推断时可能缺失。 */
  repo?: string;
  /** 仓库内出现的去重会话数。 */
  sessions?: number;
  /** 仓库关联的 canonical 事件数。 */
  events?: number;
}

/** 日趋势中的一个自然日数据点。 */
export interface DailyPoint {
  /** 本地日期字符串，通常为 YYYY-MM-DD。 */
  day?: string;
  /** 该日的 token 数或 session 数，取决于所属数组。 */
  value?: number;
}

/** 一个时间范围内的完整聚合结果；字段可选用于兼容旧版或部分生成的摘要。 */
export interface RangeData {
  /** 输入 token 与输出 token 的合计口径。 */
  totalTokens?: number;
  /** 模型请求累计输入 token。 */
  inputTokens?: number;
  /** 模型响应累计输出 token。 */
  outputTokens?: number;
  /** 输入 token 中由 Provider 报告为缓存读取的数量。 */
  cacheReadTokens?: number;
  /** Provider 报告的缓存创建/写入 token 数。 */
  cacheCreationTokens?: number;
  /** 区间内去重后的 session 数。 */
  totalSessions?: number;
  /** `llm.request` 事件数，并非 HTTP 请求数。 */
  totalRequests?: number;
  /** `tool.call` 事件数；一次调用及其结果不会计为两次。 */
  totalToolCalls?: number;
  /** 区间内读取到的全部 canonical 事件数。 */
  totalEvents?: number;
  /** 按 token 降序的模型占比列表。 */
  modelShares?: ModelShareEntry[];
  /** 按 token/活动量聚合的 Agent 列表。 */
  agentShares?: AgentShareEntry[];
  /** 按 token 聚合的 Provider 列表。 */
  providerShares?: ProviderShareEntry[];
  /** 按事件数聚合的仓库列表。 */
  repoShares?: RepoShareEntry[];
}

/** `logs/metrics-summary.json` 的只读兼容视图。 */
export interface MetricsSummary {
  /** 摘要文件 Schema 版本，而非 Pilot 软件版本。 */
  version?: number;
  /** 摘要最后生成时间的 ISO 字符串。 */
  generatedAt?: string;
  /** 生成摘要的 Pilot 包版本。 */
  packageVersion?: string;
  /** today/sevenDays/thirtyDays 中可能只存在部分范围。 */
  ranges?: Partial<Record<MetricsRange, RangeData>>;
  /** 每日 token 趋势，渲染时按所选范围截取尾部 7 或 30 项。 */
  dailyTokens?: DailyPoint[];
  /** 每日 session 趋势，通过 day 与 dailyTokens 对齐。 */
  dailySessions?: DailyPoint[];
}

/** `logs/runtime.json` 中本命令实际使用的最小字段集合。 */
export interface RuntimeRecord {
  /** RuntimeWriter 写入的生命周期状态；只有 active 才继续验证 PID。 */
  status?: string;
  /** 当前 Collector 包版本。 */
  packageVersion?: string;
  /** Collector 进程号；还需通过 signal 0 验证，不能只信任文件。 */
  pid?: number;
  /** RuntimeWriter 最近一次心跳时间。 */
  updatedAt?: string;
}

/** 用户 config.json 中用于定位真实数据目录的最小结构。 */
interface ConfigFile {
  /** Collector 实际使用的数据根目录，可包含开头的 `~`。 */
  dataDir?: string;
}

/** 参数解析完成后供读取与渲染阶段使用的选项。 */
export interface TokenUsageOptions {
  /** 展示的聚合区间，默认 today。 */
  range: MetricsRange;
  /** 显式覆盖的数据根目录；缺失时再读取环境变量和 config.json。 */
  dataDir?: string;
  /** 是否输出 ANSI SGR 控制码。 */
  color: boolean;
  /** 是否只输出帮助；为 true 时不会读取任何文件。 */
  help: boolean;
}

/** 文件读取阶段产生的纯数据视图，渲染函数不会再做 I/O。 */
export interface TokenUsageViewData {
  /** 展开 `~` 后最终采用的数据根目录。 */
  dataDir: string;
  /** 便于诊断和测试保留的摘要绝对/平台路径。 */
  summaryPath: string;
  /** 便于诊断和测试保留的 runtime 文件路径。 */
  runtimePath: string;
  /** 成功解析的指标摘要；文件缺失或损坏时为 null。 */
  summary: MetricsSummary | null;
  /** 成功解析的运行状态；文件缺失或损坏时为 null。 */
  runtime: RuntimeRecord | null;
  /** runtime.status、PID 格式和操作系统存活探测共同得出的实时结论。 */
  runtimeAlive: boolean;
  /** 摘要读取失败的用户可读类别，不暴露本地路径和底层异常细节。 */
  summaryError?: string;
  /** runtime 读取失败的用户可读类别。 */
  runtimeError?: string;
  /** 在读取结束时捕获的当前时间；可由测试固定，保证渲染稳定。 */
  now: Date;
}

/** 参数解析结果；发现首个错误时保留此前已解析选项并设置 error。 */
export interface ParseResult {
  /** 即使有错误也始终存在，调用方无需判空。 */
  options: TokenUsageOptions;
  /** 缺失值、非法范围或未知选项的英文 CLI 错误文本。 */
  error?: string;
}

const DEFAULT_DATA_DIR = '~/.loongsuite-pilot';

const RANGE_LABELS: Record<MetricsRange, string> = {
  today: 'Today',
  sevenDays: 'Last 7 days',
  thirtyDays: 'Last 30 days',
};

const TABLE_NAME_WIDTH = 26;
const TABLE_VALUE_WIDTH = 8;
const TABLE_METRIC_WIDTH = 6;
const TABLE_META_WIDTH = 4;
const TABLE_BAR_WIDTH = 24;

/**
 * 解析范围、dataDir、颜色和帮助参数。`--once` 是兼容无操作项，因为命令本就单次输出。
 *
 * @param env 用于 NO_COLOR，默认当前进程环境；测试可注入。
 * @param isTTY 非 TTY 默认关闭 ANSI 颜色。
 */
export function parseTokenUsageArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  isTTY = Boolean(process.stdout.isTTY),
): ParseResult {
  // 默认只展示今日数据；颜色同时受 TTY 与 NO_COLOR 通用约定控制。
  const options: TokenUsageOptions = {
    range: 'today',
    color: isTTY && env.NO_COLOR === undefined,
    help: false,
  };

  // 使用索引循环是因为 `--range value` 和 `--data-dir value` 需要额外消费下一项。
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // help 只设置标记，仍继续扫描，以便解析结果保持确定；主流程稍后优先输出帮助。
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      options.help = true;
      continue;
    }
    if (arg === '--once') {
      // 历史版本可能支持持续刷新；当前命令固定单次运行，保留参数只为脚本兼容。
      continue;
    }
    if (arg === '--no-color') {
      options.color = false;
      continue;
    }
    if (arg === '--today') {
      options.range = 'today';
      continue;
    }
    if (arg === '--7d' || arg === '--seven-days') {
      options.range = 'sevenDays';
      continue;
    }
    if (arg === '--30d' || arg === '--thirty-days') {
      options.range = 'thirtyDays';
      continue;
    }
    if (arg.startsWith('--range=')) {
      // `slice` 只取等号后的值，再统一交给别名解析器处理。
      const range = parseRangeValue(arg.slice('--range='.length));
      if (!range) return { options, error: `Invalid range: ${arg.slice('--range='.length)}` };
      options.range = range;
      continue;
    }
    if (arg === '--range') {
      // 前置递增让下一轮循环跳过已经作为 value 使用的参数。
      const value = args[++i];
      const range = parseRangeValue(value);
      if (!range) return { options, error: `Invalid range: ${value ?? ''}` };
      options.range = range;
      continue;
    }
    if (arg.startsWith('--data-dir=')) {
      options.dataDir = arg.slice('--data-dir='.length);
      continue;
    }
    if (arg === '--data-dir') {
      // 与 range 一样消费后一项；空字符串或已到数组末尾都视为缺值。
      const value = args[++i];
      if (!value) return { options, error: 'Missing value for --data-dir' };
      options.dataDir = value;
      continue;
    }
    return { options, error: `Unknown option: ${arg}` };
  }

  return { options };
}

/**
 * token-usage CLI 主流程：解析 -> 读取视图 -> 渲染 -> 写 stdout/stderr。
 * @returns 建议进程退出码；不直接 process.exit，主入口负责设置 exitCode。
 */
export async function runTokenUsageCommand(args: string[] = process.argv.slice(3)): Promise<number> {
  // `slice(3)` 跳过 node、入口脚本和 token-usage 子命令本身。
  const parsed = parseTokenUsageArgs(args);
  if (parsed.error) {
    // 参数错误写 stderr，供 shell 管道区分正常报表输出；返回 1 但不强制终止进程。
    process.stderr.write(`${parsed.error}\n\n${renderHelp()}\n`);
    return 1;
  }
  if (parsed.options.help) {
    // 帮助属于成功路径，只写 stdout 且不访问磁盘。
    process.stdout.write(`${renderHelp()}\n`);
    return 0;
  }

  const options = parsed.options;
  // 文件错误被 loadViewData 收敛为 null/error，所以这里通常不会因摘要缺失而 reject。
  const data = await loadViewData(options);
  process.stdout.write(`${renderTokenUsage(data, options, terminalWidth())}\n`);
  return data.summary ? 0 : 1;
}

/** 返回纯文本英文 CLI 帮助，不带 ANSI 控制码。 */
export function renderHelp(): string {
  return [
    'Usage: loongsuite-pilot token-usage [options]',
    '',
    'Shows token usage from logs/metrics-summary.json and service state from logs/runtime.json.',
    '',
    'Options:',
    '  --once                    Print once and exit (default)',
    '  --range <today|7d|30d>    Aggregation range (default: today)',
    '  --today, --7d, --30d      Shortcut range selectors',
    '  --data-dir <path>         Override LoongSuite Pilot data directory',
    '  --no-color                Disable ANSI colors',
    '  --help, -h                Show this help',
  ].join('\n');
}

/**
 * dataDir 优先级：显式参数 > LOONGSUITE_PILOT_DATA_DIR > 指定/默认 config.json > 默认目录。
 */
export async function resolveTokenUsageDataDir(explicitDataDir?: string): Promise<string> {
  // 命令行显式值拥有最高优先级，适合临时查看另一套安装目录。
  if (explicitDataDir) return resolveHome(explicitDataDir);
  // 服务脚本通常设置该变量，因此 CLI 与正在运行的 Collector 会自然指向同一目录。
  if (process.env.LOONGSUITE_PILOT_DATA_DIR) {
    return resolveHome(process.env.LOONGSUITE_PILOT_DATA_DIR);
  }

  const configPath = resolveHome(
    process.env.AGENT_DATA_COLLECTION_CONFIG ?? path.join(DEFAULT_DATA_DIR, 'config.json'),
  );
  const config = await readJsonFile<ConfigFile>(configPath);
  // readJsonFile 对缺失/坏 JSON 返回 null；CLI 因此可安全回退标准目录。
  return resolveHome(config?.dataDir ?? DEFAULT_DATA_DIR);
}

/**
 * 并行读取 metrics-summary.json 与 runtime.json，保留各自错误文本并用 PID signal 0
 * 判断 runtime 是否真实存活。
 */
export async function loadViewData(options: TokenUsageOptions): Promise<TokenUsageViewData> {
  const dataDir = await resolveTokenUsageDataDir(options.dataDir);
  const summaryPath = path.join(dataDir, 'logs', 'metrics-summary.json');
  const runtimePath = path.join(dataDir, 'logs', 'runtime.json');

  // 两个文件互不依赖，用 Promise.all 并行读取；各 Promise 自己捕获错误，不会相互取消。
  const [summaryResult, runtimeResult] = await Promise.all([
    readJsonWithError<MetricsSummary>(summaryPath),
    readJsonWithError<RuntimeRecord>(runtimePath),
  ]);

  // runtime.json 可能是上次异常退出遗留，必须再向操作系统验证 PID。
  const runtimeAlive = runtimeResult.data ? isRuntimeAlive(runtimeResult.data) : false;

  return {
    dataDir,
    summaryPath,
    runtimePath,
    summary: summaryResult.data,
    runtime: runtimeResult.data,
    runtimeAlive,
    summaryError: summaryResult.error,
    runtimeError: runtimeResult.error,
    now: new Date(),
  };
}

/**
 * 把 ViewData 渲染为单个终端字符串；summary 缺失时输出诊断提示，其余段落按 KPI、
 * token、Provider、Model、Agent、Repo、趋势顺序排列。
 */
export function renderTokenUsage(
  data: TokenUsageViewData,
  options: TokenUsageOptions,
  width = 100,
): string {
  const color = makeColor(options.color);
  // 缺少所选 range 时使用空对象，使所有 KPI 按 0 展示而不是中断整个报表。
  const rangeData = data.summary?.ranges?.[options.range] ?? {};
  const generatedAt = formatDateTime(data.summary?.generatedAt);
  const runtimeUpdated = formatDateTime(data.runtime?.updatedAt);
  const serviceState = formatServiceState(data, color);
  const heading = `${color.bold('LoongSuite Pilot Token Usage')}  ${serviceState}`;
  // 先分别构造元信息行，后续 trimLines 会统一处理宽度与尾空格。
  const rangeLine = [
    `Range ${RANGE_LABELS[options.range]}`,
    `Generated ${generatedAt ?? data.summaryError ?? 'not found'}`,
    `Runtime ${runtimeUpdated ?? data.runtimeError ?? 'not found'}`,
  ].join('  |  ');
  const versionLine = [
    `Version ${data.runtime?.packageVersion ?? data.summary?.packageVersion ?? 'unknown'}`,
    `Now ${formatDateTime(data.now.toISOString())}`,
  ].join('  |  ');

  const lines: string[] = [
    heading,
    rangeLine,
    versionLine,
    '',
  ];

  if (!data.summary) {
    // 摘要是报表主体；runtime 单独存在不足以生成 KPI，因此提前返回可操作的空状态。
    lines.push(color.yellow('No metrics summary found yet.'));
    lines.push('Start loongsuite-pilot and wait for the metrics summary writer to refresh.');
    return trimLines(lines, width);
  }

  // 各 section 返回字符串或字符串数组，这里只负责固定展示顺序和空行分隔。
  lines.push(...renderKpis(rangeData, color));
  lines.push('');
  lines.push(renderTokenBreakdown(rangeData, width, color));
  lines.push('');
  lines.push(...renderShareSection('Providers', rangeData.providerShares ?? [], width, color, {
    nameHeader: 'Provider',
    name: (item) => item.provider ?? 'unknown',
    value: (item) => item.totalTokens ?? 0,
  }));
  lines.push('');
  lines.push(...renderShareSection('Models', rangeData.modelShares ?? [], width, color, {
    nameHeader: 'Model',
    name: (item) => item.model ?? 'unknown',
    value: (item) => item.totalTokens ?? 0,
    detail: (item) => `in ${compactNumber(item.inputTokens ?? 0)}, cache ${compactNumber(item.cacheReadTokens ?? 0)}`,
  }));
  lines.push('');
  lines.push(...renderAgentSection(rangeData.agentShares ?? [], width, color));
  lines.push('');
  lines.push(...renderRepoSection(rangeData.repoShares ?? [], width, color));
  lines.push('');
  lines.push(...renderTrendSection(options.range, data.summary.dailyTokens ?? [], data.summary.dailySessions ?? [], width, color));

  return trimLines(lines, width);
}

/** 兼容 today/1d、7d/seven、30d/thirty 等范围别名。 */
function parseRangeValue(value: string | undefined): MetricsRange | null {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'today':
    case '1d':
    case 'day':
      return 'today';
    case '7d':
    case '7':
    case 'seven':
    case 'sevendays':
    case 'seven-days':
      return 'sevenDays';
    case '30d':
    case '30':
    case 'thirty':
    case 'thirtydays':
    case 'thirty-days':
      return 'thirtyDays';
    default:
      return null;
  }
}

/** 读取并 JSON.parse；ENOENT 与其他不可读错误分别返回文本，不抛出。 */
async function readJsonWithError<T>(filePath: string): Promise<{ data: T | null; error?: string }> {
  try {
    const raw = await readFile(filePath, 'utf8');
    // JSON.parse 的 SyntaxError 与读取错误都由下方 catch 转成稳定类别，不向 CLI 顶层传播。
    return { data: JSON.parse(raw) as T };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { data: null, error: 'not found' };
    return { data: null, error: 'unreadable' };
  }
}

/** runtime 必须自报 active、PID 为正且 signal 0 成功才视为在线。 */
function isRuntimeAlive(runtime: RuntimeRecord): boolean {
  if (runtime.status !== 'active') return false;
  if (!runtime.pid || runtime.pid <= 0) return false;
  try {
    // signal 0 不终止进程，只让内核检查 PID 是否存在以及当前用户是否有权访问。
    process.kill(runtime.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 将八个核心 KPI 排成两组四列。 */
function renderKpis(rangeData: RangeData, color: ReturnType<typeof makeColor>): string[] {
  // 颜色函数与值一起保存，方便 Input/Output 等普通指标保持默认颜色。
  const cells = [
    { label: 'Tokens', value: compactNumber(rangeData.totalTokens ?? 0), paint: color.cyan },
    { label: 'Input', value: compactNumber(rangeData.inputTokens ?? 0), paint: color.normal },
    { label: 'Output', value: compactNumber(rangeData.outputTokens ?? 0), paint: color.normal },
    { label: 'Cache', value: compactNumber(rangeData.cacheReadTokens ?? 0), paint: color.normal },
    { label: 'Sessions', value: String(rangeData.totalSessions ?? 0), paint: color.normal },
    { label: 'Requests', value: String(rangeData.totalRequests ?? 0), paint: color.normal },
    { label: 'Tools', value: String(rangeData.totalToolCalls ?? 0), paint: color.normal },
    { label: 'Events', value: String(rangeData.totalEvents ?? 0), paint: color.normal },
  ];

  const width = 12;
  const rows: string[] = [color.bold('Summary')];
  // 每四项输出一行标签和一行值，固定宽度确保上下列对齐。
  for (let i = 0; i < cells.length; i += 4) {
    const row = cells.slice(i, i + 4);
    rows.push(`  ${row.map(cell => color.dim(padRight(cell.label, width))).join('  ')}`);
    rows.push(`  ${row.map(cell => cell.paint(padRight(cell.value, width))).join('  ')}`);
    if (i + 4 < cells.length) rows.push('');
  }
  return rows;
}

/** 渲染 input/output 占总 token、cache 占 input 的分解表。 */
function renderTokenBreakdown(rangeData: RangeData, width: number, color: ReturnType<typeof makeColor>): string {
  const total = rangeData.totalTokens ?? 0;
  const input = rangeData.inputTokens ?? 0;
  const output = rangeData.outputTokens ?? 0;
  const cache = rangeData.cacheReadTokens ?? 0;
  const cacheCreation = rangeData.cacheCreationTokens ?? 0;
  const inputShare = total > 0 ? input / total : 0;
  const outputShare = total > 0 ? output / total : 0;
  const cacheShare = input > 0 ? cache / input : 0;
  const barWidth = tableBarWidth(width);
  // 统一生成分解表的数据行，避免每种 token 比例重复拼装列宽和进度条。
  const row = (label: string, share: number, value: string) =>
    tableRow(label, value, percent(share), '', renderBar(share, barWidth, color));

  return [
    color.bold('Token Breakdown'),
    row('Input', inputShare, compactNumber(input)),
    row('Output', outputShare, compactNumber(output)),
    tableRow('Cache read', compactNumber(cache), percent(cacheShare), '', color.dim('of input')),
    cacheCreation > 0
      ? tableRow('Cache write', compactNumber(cacheCreation))
      : undefined,
  ].filter(Boolean).join('\n');
}

/**
 * 通用 Provider/Model 占比段落，最多显示六项；fields 回调适配不同数据结构。
 */
function renderShareSection<T extends ShareEntry>(
  title: string,
  items: T[],
  width: number,
  color: ReturnType<typeof makeColor>,
  fields: {
    nameHeader: string;
    name: (item: T) => string;
    value: (item: T) => number;
    detail?: (item: T) => string;
  },
): string[] {
  const lines = [color.bold(title)];
  if (items.length === 0) {
    lines.push(color.dim('  no data'));
    return lines;
  }

  const barWidth = tableBarWidth(width);
  lines.push(color.dim(tableRow(fields.nameHeader, 'Tokens', 'Share', '', 'Usage')));
  for (const item of items.slice(0, 6)) {
    const share = clampShare(item.share ?? 0);
    const name = truncateMiddle(fields.name(item), TABLE_NAME_WIDTH);
    const value = compactNumber(fields.value(item));
    const detail = fields.detail ? `  ${color.dim(fields.detail(item))}` : '';
    lines.push(tableRow(name, value, percent(share), '', renderBar(share, barWidth, color), detail));
  }
  return lines;
}

/** 渲染最多八个 Agent 的 token、event、session 和活动条。 */
function renderAgentSection(
  items: AgentShareEntry[],
  width: number,
  color: ReturnType<typeof makeColor>,
): string[] {
  const lines = [color.bold('Agents')];
  if (items.length === 0) {
    lines.push(color.dim('  no data'));
    return lines;
  }

  const barWidth = tableBarWidth(width);
  lines.push(color.dim(tableRow('Agent', 'Tokens', 'Events', 'Sess', 'Activity')));
  for (const item of items.slice(0, 8)) {
    const share = clampShare(item.share ?? 0);
    const name = truncateMiddle(item.agentType ?? 'unknown', TABLE_NAME_WIDTH);
    lines.push(tableRow(
      name,
      compactNumber(item.tokens ?? 0),
      String(item.events ?? 0),
      String(item.sessions ?? 0),
      renderBar(share, barWidth, color),
    ));
  }
  return lines;
}

/** 渲染最多六个仓库的 event/session 计数。 */
function renderRepoSection(
  items: RepoShareEntry[],
  width: number,
  color: ReturnType<typeof makeColor>,
): string[] {
  const lines = [color.bold('Repositories')];
  if (items.length === 0) {
    lines.push(color.dim('  no data'));
    return lines;
  }

  lines.push(color.dim(tableRow('Repository', '', 'Events', 'Sess')));
  for (const item of items.slice(0, 6)) {
    const repo = truncateMiddle(item.repo ?? 'unknown', TABLE_NAME_WIDTH);
    lines.push(tableRow(repo, '', String(item.events ?? 0), String(item.sessions ?? 0)));
  }
  return lines;
}

/** 根据范围取最近 7/30 点，以最大 token 为 100% 渲染日趋势。 */
function renderTrendSection(
  range: MetricsRange,
  dailyTokens: DailyPoint[],
  dailySessions: DailyPoint[],
  width: number,
  color: ReturnType<typeof makeColor>,
): string[] {
  const count = range === 'thirtyDays' ? 30 : 7;
  const tokenPoints = dailyTokens.slice(-count);
  const sessionPoints = dailySessions.slice(-count);
  const lines = [color.bold(range === 'thirtyDays' ? 'Token Trend (30d)' : 'Token Trend (7d)')];
  if (tokenPoints.length === 0) {
    lines.push(color.dim('  no trend data'));
    return lines;
  }

  const maxValue = Math.max(1, ...tokenPoints.map((p) => p.value ?? 0));
  const barWidth = Math.min(26, Math.max(8, width - 38));
  lines.push(color.dim(`  ${padRight('Day', 5)} ${padLeft('Tokens', 8)}  Trend${' '.repeat(Math.max(0, barWidth - 3))} Sessions`));
  for (const point of tokenPoints) {
    const value = point.value ?? 0;
    const day = point.day?.slice(5) ?? '--';
    const sessions = sessionPoints.find((p) => p.day === point.day)?.value ?? 0;
    lines.push(`  ${day} ${padLeft(compactNumber(value), 8)}  ${renderBar(value / maxValue, barWidth, color)} ${padLeft(String(sessions), 3)}`);
  }
  return lines;
}

/** 根据 runtime 文件存在、status 和 PID 活性渲染服务状态。 */
function formatServiceState(data: TokenUsageViewData, color: ReturnType<typeof makeColor>): string {
  if (data.runtimeAlive) {
    return color.green(`active pid ${data.runtime?.pid ?? '-'}`);
  }
  if (data.runtime?.status) {
    return color.yellow(`${data.runtime.status} pid ${data.runtime.pid ?? '-'}`);
  }
  return color.yellow('service not running');
}

/** 以 K/M/B 缩写数值，保留一位小数。 */
function compactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${formatOneDecimal(value / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${formatOneDecimal(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${formatOneDecimal(value / 1_000)}K`;
  return String(Math.round(value));
}

/** 固定一位小数。 */
function formatOneDecimal(value: number): string {
  return value.toFixed(1);
}

/** 将 0..1 占比格式为整数百分比，先做边界收敛。 */
function percent(value: number): string {
  return `${Math.round(clampShare(value) * 100)}%`;
}

/** 以 #/- 绘制固定宽度 ASCII 进度条；非零值至少显示一格。 */
function renderBar(value: number, width: number, color: ReturnType<typeof makeColor>): string {
  const share = clampShare(value);
  const filled = share > 0 ? Math.max(1, Math.round(width * share)) : 0;
  return color.cyan(`[${'#'.repeat(filled)}${'-'.repeat(Math.max(0, width - filled))}]`);
}

/** 根据终端宽度计算 10..24 的表格 bar 宽度。 */
function tableBarWidth(width: number): number {
  return Math.min(TABLE_BAR_WIDTH, Math.max(10, width - 58));
}

/** 按固定列宽拼一行表格，tail/detail 可追加 bar 与说明。 */
function tableRow(
  name: string,
  value = '',
  metric = '',
  meta = '',
  tail = '',
  detail = '',
): string {
  const row = [
    `  ${padRight(name, TABLE_NAME_WIDTH)}`,
    padLeft(value, TABLE_VALUE_WIDTH),
    padLeft(metric, TABLE_METRIC_WIDTH),
    padLeft(meta, TABLE_META_WIDTH),
  ].join(' ');
  const tailPart = tail ? `  ${tail}` : '';
  return `${row}${tailPart}${detail}`;
}

/** 非有限值归零，其余限制在 0..1。 */
function clampShare(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** 解析时间并按当前 locale 输出月日时分秒；无效返回 null。 */
function formatDateTime(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** 读取 stdout 列数并设置最小 72、默认 100。 */
function terminalWidth(): number {
  return Math.max(72, process.stdout.columns || 100);
}

/** 展开嵌入换行、限制过长可见行并移除行尾空白。 */
function trimLines(lines: string[], width: number): string {
  return lines
    .flatMap((line) => line.split('\n'))
    .map((line) => stripAnsi(line).length > width + 20 ? truncateAnsiUnsafe(line, width + 20) : line)
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');
}

/**
 * 粗略截断可能含 ANSI 的字符串。注意它按原始 code unit slice，因此仅用于异常长行兜底。
 */
function truncateAnsiUnsafe(value: string, maxLength: number): string {
  if (stripAnsi(value).length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}...`;
}

/** 超长名称保留首尾，中间用三个点替代。 */
function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  const left = Math.ceil((maxLength - 3) / 2);
  const right = Math.floor((maxLength - 3) / 2);
  return `${value.slice(0, left)}...${value.slice(value.length - right)}`;
}

/** 按去 ANSI 后的可见长度右补空格。 */
function padRight(value: string, width: number): string {
  const length = visibleLength(value);
  return length >= width ? value : value + ' '.repeat(width - length);
}

/** 按去 ANSI 后的可见长度左补空格。 */
function padLeft(value: string, width: number): string {
  const length = visibleLength(value);
  return length >= width ? value : ' '.repeat(width - length) + value;
}

/** 移除本模块生成的 SGR 颜色控制码。 */
function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

/** 返回不含 ANSI 的字符串长度。 */
function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

/** 返回可开关的颜色函数集合；关闭时所有函数原样返回文本。 */
function makeColor(enabled: boolean) {
  // 根据 ANSI code 包装文本；关闭颜色时直接返回原字符串，便于重定向到文件。
  const paint = (code: string, text: string) => enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
  return {
    normal: (text: string) => text,
    bold: (text: string) => paint('1', text),
    dim: (text: string) => paint('2', text),
    green: (text: string) => paint('32', text),
    yellow: (text: string) => paint('33', text),
    cyan: (text: string) => paint('36', text),
  };
}
