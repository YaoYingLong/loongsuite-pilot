import * as os from 'node:os';
import type {
  AgentsConfig,
  AnalyticsConfig,
  AutoUpdateConfig,
  CmsConfig,
  FileCollectionToggle,
  PipelineToggle,
  FlusherConfig,
  HookWatchdogConfig,
  LogRetentionConfig,
  MaskConfig,
  MaskType,
  OtlpEndpoint,
  OtlpEndpointEntry,
  CmsEndpointEntry,
  OtlpTraceFlusherConfig,
  OtlpTraceRawConfig,
  SlsEndpoint,
  SlsMode,
  StatusBarConfig,
  UpstreamLinkConfig,
} from '../types/index.js';
import { readJsonFile, resolveHome } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';
import { parseKeyValueAttributes, sanitizeAttributes } from '../normalization/global-attributes.js';

const logger = createLogger('ConfigLoader');

const DEFAULT_CONFIG_PATH = '~/.loongsuite-pilot/config.json';

/** config.json 中 SLS 数组模式的单个目的地。 */
export interface SlsEndpointEntry {
  name?: string;
  endpoint: string;
  project: string;
  logstore: string;
  mode?: SlsMode;
  accessKeyId?: string;
  accessKeySecret?: string;
}

/**
 * config.json 中兼容旧版本的单 SLS 配置。
 * 新代码最终都会把它转换成 endpoints 数组，供 MultiFlusher 按目的地独立发送。
 */
export interface SlsSingleConfig {
  enabled?: boolean;
  mode?: SlsMode;
  accessKeyId?: string;
  accessKeySecret?: string;
  endpoint?: string;
  project?: string;
  logstore?: string;
  /** @deprecated 已废弃并忽略；用户端点和集团内置端点现在始终做并集。 */
  destinationOverride?: boolean;
  batchMaxSize?: number;
  flushIntervalMs?: number;
}

/**
 * 集团版控制面下发的内置数据出口配置，读取自`<dataDir>/configs/inner/data_config.json`；开源版通常没有此文件。
 */
export interface InnerDataConfig {
  sls?: SlsEndpointEntry[];
  otlp?: OtlpEndpointEntry[];
  cms?: CmsEndpointEntry[];
  serviceNamePrefix?: string;
}

/**
 * 用户磁盘配置文件 config.json 的原始结构。
 *
 * 所有字段都可选：未填写时继续回退到内置默认值；有对应环境变量的字段则由环境变量
 * 覆盖。这个类型描述“用户写进文件的内容”，不是 Orchestrator 最终使用的完整配置。
 */
export interface ConfigFile {
  /** 是否启动整个采集服务。false 时主进程正常退出，不视为崩溃。 */
  enabled?: boolean;
  /** 状态、日志、版本和本地输出的根目录。 */
  dataDir?: string;
  /** 采集记录中的用户标识；`user.id` 是旧配置兼容字段。 */
  userId?: string;
  'user.id'?: string;

  /** 支持旧的单目的地对象，也支持新的多目的地数组。 */
  sls?: SlsSingleConfig | SlsEndpointEntry[];

  jsonl?: {
    enabled?: boolean;
    outputDir?: string;
    rotateDaily?: boolean;
    maxFileSizeMb?: number;
  };

  http?: {
    enabled?: boolean;
    url?: string;
    headers?: Record<string, string>;
    batchMaxSize?: number;
    flushIntervalMs?: number;
    requestTimeoutMs?: number;
  };

  /** 按 Input 实现控制是否监听及轮询频率，例如 codex-transcript。 */
  listeners?: Record<string, {
    enabled?: boolean;
    pollInterval?: number;
  }>;

  retention?: {
    enabled?: boolean;
    intervalMs?: number;
    hookHistoryDays?: number;
    hookErrorDays?: number;
    hookDebugDays?: number;
    outputDays?: number;
    slsFailedDays?: number;
  };

  hookWatchdog?: {
    enabled?: boolean;
    intervalMs?: number;
    repairCooldownMs?: number;
  };

  /** 日志类远端采集总开关；当前由 Orchestrator 用来门控 SLS。 */
  collectLog?: boolean;
  /** 是否构建 OTLP Trace 输出。 */
  collectTrace?: boolean;
  serviceNamePrefix?: string;

  upstreamLink?: {
    enabled?: boolean;
    ttlMs?: number;
  };

  mask?: {
    mode?: string;
    types?: string[];
  };

  cms?: {
    licenseKey?: string;
    endpoint?: string;
    workspace?: string;
    debug?: boolean;
  };

  otlpTrace?: {
    endpoint?: string;
    headers?: Record<string, string>;
    resourceAttributes?: Record<string, string>;
    serviceName?: string;
    debug?: boolean;
    captureMessageContent?: boolean;
    turnIdleTimeoutMs?: number;
    resourceAttributeKeys?: string[];
    spanAttributePassthroughPrefixes?: string[];
  };

  /** 按 Agent 产品维度控制准入及是否保留消息正文，例如 codex、claude-code。 */
  agents?: Record<string, {
    enabled?: boolean;
    // 设置为 false 可避免采集完整 Prompt、Completion、工具参数和工具结果，前提是对应集成支持该策略。
    captureMessageContent?: boolean | string;
  }>;

  autoUpdate?: {
    enabled?: boolean;
    checkIntervalMs?: number;
    manifestUrl?: string;
    packageUrl?: string;
  };

  fileCollection?: {
    enabled?: boolean;
  };

  pipeline?: {
    enabled?: boolean;
    file?: { enabled?: boolean };
    qoderApi?: { enabled?: boolean };
  };

  enableStatusBarApp?: boolean | string;

  /** 注入 Trace Span 的用户自定义属性，会与 OTEL_SPAN_ATTRIBUTES 环境变量合并。 */
  globalSpanAttributes?: Record<string, unknown>;

  installId?: string;
  canary?: {
    policy?: 'auto' | 'latest' | 'off';
    hotfix_version?: number;
  };
}

/** 读取环境变量；Windows 下去掉两端空白，兼容 PowerShell/任务计划程序传值。 */
function env(key: string): string | undefined {
  const v = process.env[key];
  return v !== undefined ? (process.platform === 'win32' ? v.trim() : v) : undefined;
}

/**
 * 读取布尔环境变量。空字符串等同于“未设置”并使用 fallback；只有精确的 `false` 和 `0`
 * 表示关闭，其余非空字符串都表示开启，保持安装脚本历史行为。
 */
function envBool(key: string, fallback: boolean): boolean {
  const v = env(key);
  if (v === undefined || v.trim() === '') return fallback; // 空字符串不是 true，而是沿用下一层配置。
  return v !== 'false' && v !== '0';
}

/**
 * 读取数值环境变量；无法转换成有限数字时使用 fallback。
 * 注意空字符串会按 JavaScript Number 规则得到 0，各调用方再按自身要求判断是否必须大于 0。
 */
function envInt(key: string, fallback: number): number {
  const v = env(key);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 加载并整理 Collector 的完整运行配置。
 *
 * 配置按以下优先级逐层覆盖：
 *   1. 环境变量：最高，方便安装脚本、容器和系统服务临时覆盖；
 *   2. 用户 config.json：默认位于 ~/.loongsuite-pilot/config.json；
 *   3. 代码内置默认值：保证首次安装没有配置文件也能启动并落本地 JSONL。
 *
 * 集团版还会额外读取 data_config.json。它不是用来覆盖用户配置，而是为 SLS/OTLP/CMS
 * 增加托管数据出口，因此用户出口和内置出口可以同时收到同一批采集数据。
 */
export async function loadConfig(): Promise<AnalyticsConfig> {
  // ?? 空值合并运算符，如果 环境变量中AGENT_DATA_COLLECTION_CONFIG 是 null 或 undefined 返回 DEFAULT_CONFIG_PATH
  const configPath = resolveHome(env('AGENT_DATA_COLLECTION_CONFIG') ?? DEFAULT_CONFIG_PATH);
  // await：暂停当前异步函数代码执行，直到 Promise 完成（成功返回结果 / 失败拒绝），然后取出 Promise 内部的值赋值给变量 file
  const file = await readJsonFile<ConfigFile>(configPath);

  if (file) {
    logger.info('loaded config file', { path: configPath });
  } else {
    logger.debug('no config file found, using env + defaults', { path: configPath });
  }

  // 如果配置了LOONGSUITE_PILOT_DATA_DIR环境变量直接使用，如果没有配置环境变量使用~/.loongsuite-pilot/config.json文件中读取的dataDir对应的内容
  // 如果该类容还是空，则默认使用~/.loongsuite-pilot
  const dataDir = env('LOONGSUITE_PILOT_DATA_DIR') ?? file?.dataDir ?? '~/.loongsuite-pilot';

  // 如果是~开头的路径，转换为绝对路径
  const innerDataConfigPath = resolveHome(`${dataDir}/configs/inner/data_config.json`);
  const innerDataConfig = await readJsonFile<InnerDataConfig>(innerDataConfigPath);

  // 兼容早期 `user.id` 写法；都没有时使用主机名，确保事件至少有稳定的机器级标识。
  const userId = env('LOONGSUITE_PILOT_USER_ID') ?? file?.userId ?? file?.['user.id'] ?? os.hostname();

  // serviceNamePrefix 用于 SLS __service_name__ 和 OTLP service.name 的默认命名。
  const serviceNamePrefix = env('LOONGSUITE_PILOT_SERVICE_NAME_PREFIX') ?? file?.serviceNamePrefix ?? 'loongsuite-pilot';

  // 从这里开始把“可选的原始配置”转换成字段齐全、可直接给 Orchestrator 使用的配置。
  return {
    // 优先使用LOONGSUITE_PILOT_ENABLED环境变量的值，如果配置使用配置文件中配置的enabled
    enabled: envBool('LOONGSUITE_PILOT_ENABLED', file?.enabled ?? true),
    autoStart: true, // 历史兼容字段，当前固定为 true；实际进程生命周期由服务管理器控制。
    dataDir,
    userId,
    collectLog: envBool('LOONGSUITE_PILOT_COLLECT_LOG', file?.collectLog ?? true),
    collectTrace: envBool('LOONGSUITE_PILOT_COLLECT_TRACE', file?.collectTrace ?? true),
    serviceNamePrefix,
    cms: buildCmsConfig(file),
    otlpTrace: buildOtlpTraceRawConfig(file),
    // SLS 在 flushers 中构建；内置 Trace 原始端点先保留，稍后与用户 Trace 出口统一做并集。
    innerTrace: innerDataConfig
      ? {
          otlp: innerDataConfig.otlp,
          cms: innerDataConfig.cms,
          serviceNamePrefix: innerDataConfig.serviceNamePrefix,
        }
      : undefined,
    autoUpdate: buildAutoUpdateConfig(file),
    // Listener 对应具体采集实现。同一个 Agent 可能有 Hook、SQLite、Session 等多个 Listener，
    // Orchestrator 会再结合 Agent 级开关和准入控制决定最终启停状态。
    listeners: buildListenersConfig(file),
    // 构建日志类输出通道。三个 Flusher 可以同时开启，Orchestrator 会组装成 MultiFlusher。
    // SLS 可合并用户与集团内置目的地；JSONL 默认写本地；HTTP 是用户自定义批量 POST。
    flushers: buildFlushersConfig(file, dataDir, serviceNamePrefix, innerDataConfig),
    // 构建日志保留时间策略配置，未配置的分类默认保留 7 天。
    retention: buildRetentionConfig(file),
    agents: buildAgentsConfig(file),
    mask: buildMaskConfig(file),
    hookWatchdog: buildHookWatchdogConfig(file),
    fileCollection: buildFileCollectionConfig(file),
    pipeline: buildPipelineConfig(file),
    statusBar: buildStatusBarConfig(file),
    upstreamLink: buildUpstreamLinkConfig(file),
    globalSpanAttributes: resolveGlobalSpanAttributes(file),
  };
}

/**
 * 构建上游 Trace 关联配置。
 * 开启后，Agent Span 会尝试挂到 acp-correlate 中记录的父 Span 下，形成跨进程完整链路。
 */
function buildUpstreamLinkConfig(file: ConfigFile | null): UpstreamLinkConfig {
  const ttlMs = envInt('LOONGSUITE_PILOT_UPSTREAM_LINK_TTL_MS', file?.upstreamLink?.ttlMs ?? 86_400_000); // 24h
  return {
    enabled: envBool('LOONGSUITE_PILOT_UPSTREAM_LINK', file?.upstreamLink?.enabled ?? false),
    // TTL 小于等于 0 会让清理截止时间落在当前或未来，刚写入的关联文件也会被删掉，
    // 最终表现为 Trace 悄悄断链，因此强制回退到 24 小时。
    ttlMs: ttlMs > 0 ? ttlMs : 86_400_000,
  };
}

/**
 * 合并用户自定义的全局 Span 属性。
 * config.json 提供稳定基线，OTEL_SPAN_ATTRIBUTES 适合部署时临时注入且同名时优先；
 * 合并后统一过滤系统保留字段和无法转成字符串的值，避免覆盖平台生成的核心语义。
 */
function resolveGlobalSpanAttributes(file: ConfigFile | null): Record<string, string> {
  const fromConfig = (file?.globalSpanAttributes as Record<string, unknown>) ?? {};
  const fromEnv = parseKeyValueAttributes(env('OTEL_SPAN_ATTRIBUTES'));
  // 配置文件和环境变量必须走同一套清洗规则，不能因来源不同而获得不同权限。
  return sanitizeAttributes({ ...fromConfig, ...fromEnv });
}

/** 保留用户 OTLP Trace 原始配置，等 Orchestrator 构建 Flusher 时再与内置出口合并。 */
function buildOtlpTraceRawConfig(file: ConfigFile | null): OtlpTraceRawConfig | undefined {
  if (!file?.otlpTrace) return undefined;
  return { ...file.otlpTrace };
}

/** 兼容 config.json 中 boolean 与字符串形式的 true/false；其他值视为未配置。 */
function parseOptionalBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
}

/**
 * 构建用户 CMS/ARMS 简写配置。 licenseKey 是启用标志；真正创建 Trace 出口时还要求 endpoint 非空。
 */
function buildCmsConfig(file: ConfigFile | null): CmsConfig {
  const licenseKey = env('LOONGSUITE_PILOT_CMS_LICENSE_KEY') ?? file?.cms?.licenseKey ?? '';
  const endpoint = env('LOONGSUITE_PILOT_CMS_ENDPOINT') ?? file?.cms?.endpoint ?? '';
  const workspace = env('LOONGSUITE_PILOT_CMS_WORKSPACE') ?? file?.cms?.workspace ?? '';
  return {
    enabled: !!licenseKey,
    licenseKey,
    endpoint,
    workspace,
    debug: file?.cms?.debug ?? false,
  };
}

/**
 * 解析 Agent 级策略。Agent key 是产品 ID，而不是具体 Input listener key。
 * enabled 留空表示不额外禁止；captureMessageContent 无效或未配置时保持历史默认 true。
 */
function buildAgentsConfig(file: ConfigFile | null): AgentsConfig {
  const result: AgentsConfig = {};
  if (!file?.agents || typeof file.agents !== 'object') return result;

  for (const [agentType, policy] of Object.entries(file.agents)) {
    if (!agentType || !policy || typeof policy !== 'object') continue;
    result[agentType] = {
      enabled: policy.enabled,
      captureMessageContent: parseOptionalBool(policy.captureMessageContent) ?? true,
    };
  }

  return result;
}

const SUPPORTED_MASK_TYPES: readonly MaskType[] = [
  'cloudAccessKey',
  'apiKey',
  'privateKey',
  'databaseUrl',
];

const SUPPORTED_MASK_TYPE_SET = new Set<string>(SUPPORTED_MASK_TYPES);

/** 将数组或逗号分隔文本转换为受支持的敏感信息类型，未知类型直接忽略。 */
function parseMaskTypes(value: string | string[] | undefined): MaskType[] {
  const rawTypes = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return rawTypes
    .map(type => type.trim())
    .filter((type): type is MaskType => SUPPORTED_MASK_TYPE_SET.has(type));
}

/**
 * 构建采集内容脱敏策略：none 不处理，all 启用全部规则，custom 只启用指定规则。
 * mode 缺失或拼写错误时按 none 处理，避免配置错误意外改变已有采集结果。
 */
function buildMaskConfig(file: ConfigFile | null): MaskConfig {
  const mode = env('LOONGSUITE_PILOT_MASK_MODE') ?? file?.mask?.mode;
  if (mode !== 'all' && mode !== 'custom' && mode !== 'none') {
    return { mode: 'none', types: [] };
  }

  if (mode === 'all' || mode === 'none') {
    return { mode, types: [] };
  }

  const types = parseMaskTypes(env('LOONGSUITE_PILOT_MASK_TYPES') ?? file?.mask?.types);

  return { mode: 'custom', types };
}

function buildListenersConfig(
  file: ConfigFile | null,
): Record<string, { enabled: boolean; pollInterval: number }> {
  // Listener 对应具体采集实现。同一个 Agent 可能有 Hook、SQLite、Session 等多个 Listener，
  // Orchestrator 会再结合 Agent 级开关和准入控制决定最终启停状态。
  // Record<KeyType, ValueType> 是 TS 内置工具类型：
  const defaults: Record<string, { enabled: boolean; pollInterval: number }> = {
    qoder: { enabled: true, pollInterval: 30_000 },
    'qoder-sqlite': { enabled: true, pollInterval: 30_000 },
    'qoder-work': { enabled: true, pollInterval: 30_000 },
    'qoder-work-log': { enabled: true, pollInterval: 30_000 },
    'qoder-work-sqlite': { enabled: true, pollInterval: 30_000 },
    'qoder-work-cn-trace': { enabled: true, pollInterval: 30_000 },
    'qoder-work-cn-hook': { enabled: true, pollInterval: 30_000 },
    'qoder-work-cn-log': { enabled: true, pollInterval: 30_000 },
    'qoder-work-cn-sqlite': { enabled: true, pollInterval: 30_000 },
    'qoder-cli-hook': { enabled: true, pollInterval: 30_000 },
    'qoder-cli-session': { enabled: true, pollInterval: 30_000 },
    'cursor-hook': { enabled: true, pollInterval: 30_000 },
    'claude-code-log': { enabled: true, pollInterval: 30_000 },
    'codex-transcript': { enabled: true, pollInterval: 30_000 },
    'pi-coding-agent-log': { enabled: true, pollInterval: 30_000 },
  };
  // ... 是对象展开运算符，浅拷贝对象自身可枚举属性，等价于const result = Object.assign({}, defaults);
  // 创建了一个全新对象，result 和 defaults 不是同一个引用 后续可以修改 result 而不污染原 defaults
  // 对象里的 value 依然是引用类型，如果直接修改 result.xxx 内部属性，会影响原对象
  const result = { ...defaults };

  // 用户只需写想覆盖的字段；其余字段继承该 Listener 默认值。
  if (file?.listeners) {
    // Object.entries把对象转换成 [key, value][] 数组
    for (const [key, val] of Object.entries(file.listeners)) {
      result[key] = {
        enabled: val.enabled ?? result[key]?.enabled ?? true,
        pollInterval: val.pollInterval ?? result[key]?.pollInterval ?? 30_000,
      };
    }
  }

  // Codex 的正常结束和中断会话现在统一由 codex-transcript 采集。若用户尚未配置新 key，
  // 继续迁移 codex-log / codex-aborted-turn 的旧配置，避免升级后开关突然失效。
  if (!file?.listeners?.['codex-transcript']) {
    const legacy = file?.listeners?.['codex-log'] ?? file?.listeners?.['codex-aborted-turn'];
    if (legacy) {
      result['codex-transcript'] = {
        enabled: legacy.enabled ?? defaults['codex-transcript'].enabled,
        pollInterval: legacy.pollInterval ?? defaults['codex-transcript'].pollInterval,
      };
    }
  }

  // 历史 Qoder 环境变量同时控制相关的 IDE、SQLite 和 CLI Session 轮询间隔。
  const envPoll = envInt('QODER_ANALYTICS_POLL_INTERVAL', 0);
  if (envPoll > 0) result.qoder.pollInterval = envPoll;
  if (envPoll > 0) result['qoder-sqlite'].pollInterval = envPoll;
  if (envPoll > 0) result['qoder-cli-session'].pollInterval = envPoll;

  return result;
}

/**
 * 构建日志保留策略。 LOONGSUITE_PILOT_LOG_RETENTION_DAYS 是“一键统一天数”；
 * config.json 中某个分类显式配置后，该分类优先使用自己的值。未配置的分类默认保留 7 天。
 */
function buildRetentionConfig(file: ConfigFile | null): LogRetentionConfig {
  const unifiedDays = envInt('LOONGSUITE_PILOT_LOG_RETENTION_DAYS', 0);

  const resolve = (fileVal: number | undefined, fallback: number): number => {
    if (fileVal !== undefined) return fileVal;
    if (unifiedDays > 0) return unifiedDays;
    return fallback;
  };

  return {
    enabled: envBool('LOONGSUITE_PILOT_LOG_RETENTION_ENABLED', file?.retention?.enabled ?? true),
    intervalMs: envInt(
      'LOONGSUITE_PILOT_LOG_RETENTION_INTERVAL_MS',
      file?.retention?.intervalMs ?? 21_600_000, // 6 hours
    ),
    hookHistoryDays: resolve(file?.retention?.hookHistoryDays, 7),
    hookErrorDays: resolve(file?.retention?.hookErrorDays, 7),
    hookDebugDays: resolve(file?.retention?.hookDebugDays, 7),
    outputDays: resolve(file?.retention?.outputDays, 7),
    slsFailedDays: resolve(file?.retention?.slsFailedDays, 7),
  };
}

/**
 * Hook Watchdog 定期检查 Agent 配置中的采集 Hook 是否被升级或其他工具覆盖，并尝试修复。
 * repairCooldownMs 用来限流，避免持续损坏时反复写文件。
 */
function buildHookWatchdogConfig(file: ConfigFile | null): HookWatchdogConfig {
  return {
    enabled: envBool('LOONGSUITE_PILOT_HOOK_WATCHDOG_ENABLED', file?.hookWatchdog?.enabled ?? true),
    intervalMs: envInt(
      'LOONGSUITE_PILOT_HOOK_WATCHDOG_INTERVAL_MS',
      file?.hookWatchdog?.intervalMs ?? 5 * 60_000, // 5 minutes
    ),
    repairCooldownMs: envInt(
      'LOONGSUITE_PILOT_HOOK_WATCHDOG_COOLDOWN_MS',
      file?.hookWatchdog?.repairCooldownMs ?? 10 * 60_000, // 10 minutes
    ),
  };
}

/** 旧的 fileCollection 对外字段保留为 pipeline 配置别名，供历史调用方平滑升级。 */
function buildFileCollectionConfig(file: ConfigFile | null): FileCollectionToggle {
  return buildPipelineConfig(file);
}

/**
 * 构建独立 Pipeline 子系统开关。
 * 总开关默认关闭；启用后 file 与 qoderApi 两条子管道默认开启，也可分别关闭。
 * 优先读取新 pipeline 字段，同时兼容旧 fileCollection 字段和环境变量。
 */
function buildPipelineConfig(file: ConfigFile | null): PipelineToggle {
  const legacyEnabled = file?.fileCollection?.enabled;
  const enabled = envBool(
    'LOONGSUITE_PILOT_PIPELINE_ENABLED',
    envBool('LOONGSUITE_PILOT_FILE_COLLECTION_ENABLED', file?.pipeline?.enabled ?? legacyEnabled ?? false),
  );
  return {
    enabled,
    file: {
      enabled: envBool('LOONGSUITE_PILOT_PIPELINE_FILE_ENABLED', file?.pipeline?.file?.enabled ?? true),
    },
    qoderApi: {
      enabled: envBool('LOONGSUITE_PILOT_PIPELINE_QODER_API_ENABLED', file?.pipeline?.qoderApi?.enabled ?? true),
    },
  };
}

/** 构建桌面状态栏功能配置；当前刷新周期由产品固定，不从用户配置读取。 */
function buildStatusBarConfig(file: ConfigFile | null): StatusBarConfig {
  // 此开关有意把字符串 `0` 也识别为 false，与 AI Trace 的同名能力保持一致；
  // 它和只接受 true/false 的 Agent 消息正文开关语义不同。
  const rawEnabled = file?.enableStatusBarApp;
  const fallback = typeof rawEnabled === 'string'
    ? rawEnabled.trim().toLowerCase() !== 'false' && rawEnabled.trim() !== '0'
    : rawEnabled ?? true;
  return {
    enabled: envBool('LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP', fallback),
    metricsSummaryIntervalMs: 60_000,
    runtimeRefreshIntervalMs: 30_000,
  };
}

/**
 * 构建日志类输出通道。三个 Flusher 可以同时开启，Orchestrator 会组装成 MultiFlusher。
 * SLS 可合并用户与集团内置目的地；JSONL 默认写本地；HTTP 是用户自定义批量 POST。
 */
function buildFlushersConfig(
  file: ConfigFile | null,
  dataDir: string,
  serviceNamePrefix: string,
  innerDataConfig: InnerDataConfig | null,
): FlusherConfig {
  return {
    sls: buildSlsConfig(file, serviceNamePrefix, innerDataConfig),
    jsonl: buildJsonlConfig(file, dataDir),
    http: buildHttpConfig(file),
  };
}

/**
 * 构建 OTLP Trace Flusher 的最终配置。
 *
 * 项目允许同一批 Agent Activity 同时发送到多个 Trace 后端，来源包括：
 *   1. 用户配置的通用 OTLP endpoint；
 *   2. 用户配置的 CMS/ARMS 简写；
 *   3. 集团内置的通用 OTLP endpoint 数组；
 *   4. 集团内置的 CMS/ARMS endpoint 数组。
 *
 * 这里采用“做并集再去重”，不是后者覆盖前者。只有 collectTrace=true 且至少存在一个
 * 有效 endpoint 时才返回配置。日志类 SLS/JSONL/HTTP 不受此函数影响。
 */
export function buildOtlpTraceConfig(config: AnalyticsConfig): OtlpTraceFlusherConfig | undefined {
  if (!config.collectTrace) return undefined;

  const endpoints: OtlpEndpoint[] = [];
  // 任一 CMS/ARMS 出口都会要求公共 Resource 带上 ARMS GenAI 产品标记。
  const armsResourceAttributes: Record<string, string> = {};
  // 用户出口使用顶层 serviceName；集团内置出口只有在 prefix 确实不同时才单独覆盖。
  // 相同名称不重复标记，既便于端点去重，也避免无意义地走多 serviceName 转换路径。
  const userServiceName = config.otlpTrace?.serviceName ?? (config.serviceNamePrefix || 'loongsuite-pilot');
  const innerPrefix = config.innerTrace?.serviceNamePrefix;
  const innerServiceName = innerPrefix && innerPrefix !== userServiceName ? innerPrefix : undefined;

  // 1. 用户通用 OTLP：endpoint 和 headers 都允许环境变量临时覆盖文件配置。
  const userOtlpEndpoint = env('LOONGSUITE_PILOT_OTLP_ENDPOINT') ?? config.otlpTrace?.endpoint;
  if (userOtlpEndpoint) {
    let headers: Record<string, string> | undefined;
    const envHeaders = env('LOONGSUITE_PILOT_OTLP_HEADERS');
    if (envHeaders) {
      // Headers 可能包含 license key/token，解析失败只记录长度，绝不能输出原文泄漏凭据。
      try { headers = JSON.parse(envHeaders); } catch { logger.warn('LOONGSUITE_PILOT_OTLP_HEADERS is not valid JSON, ignoring', { length: envHeaders.length }); }
    } else {
      headers = config.otlpTrace?.headers;
    }
    endpoints.push({
      name: 'user-otlp',
      endpoint: userOtlpEndpoint,
      headers,
      compression: config.otlpTrace?.compression,
    });
  }

  // 2. 用户 CMS/ARMS 简写：这是兼容旧配置的入口，现在与通用 OTLP 并存而非二选一。
  if (config.cms.enabled && config.cms.endpoint) {
    endpoints.push(cmsEntryToOtlpEndpoint('user-cms', {
      endpoint: config.cms.endpoint,
      licenseKey: config.cms.licenseKey,
      workspace: config.cms.workspace,
    }, armsResourceAttributes));
  }

  // 3. 集团内置通用 OTLP。data_config.json 由控制面下发，运行时仍用 Array.isArray 防御
  // 错误序列化；单次坏配置不能拖垮全部日志和 Trace 输出。
  const innerOtlp = Array.isArray(config.innerTrace?.otlp) ? config.innerTrace!.otlp : [];
  innerOtlp.forEach((ep, i) => {
    if (!ep.endpoint) return;
    endpoints.push({
      name: ep.name ?? `inner-otlp-${i}`,
      endpoint: ep.endpoint,
      headers: ep.headers,
      compression: ep.compression,
      serviceName: innerServiceName,
    });
  });

  // 4. 集团内置 CMS/ARMS 简写。
  const innerCms = Array.isArray(config.innerTrace?.cms) ? config.innerTrace!.cms : [];
  innerCms.forEach((ep, i) => {
    if (!ep.endpoint) return;
    endpoints.push(
      cmsEntryToOtlpEndpoint(ep.name ?? `inner-cms-${i}`, ep, armsResourceAttributes, innerServiceName),
    );
  });

  const deduped = dedupOtlpEndpoints(endpoints);
  // 没有有效 Trace 出口时不创建 Flusher，也不影响其他日志 Flusher 继续工作。
  if (deduped.length === 0) return undefined;

  const otlp = config.otlpTrace;
  // OTLP 顶层策略优先；未配置时从各 Agent 内容策略推导一个公共默认值。
  const captureMessageContent = otlp?.captureMessageContent ?? resolveCaptureMessageContent(config.agents);
  const serviceName = userServiceName;
  // ARMS 必需属性后合并，因此同名时覆盖普通用户 Resource 属性。
  const resourceAttributes = { ...(otlp?.resourceAttributes ?? {}), ...armsResourceAttributes };

  return {
    enabled: true,
    endpoints: deduped,
    protocol: 'http/protobuf',
    serviceName,
    resourceAttributes: Object.keys(resourceAttributes).length > 0 ? resourceAttributes : undefined,
    captureMessageContent,
    debug: otlp?.debug ?? config.cms.debug ?? false,
    turnIdleTimeoutMs: otlp?.turnIdleTimeoutMs ?? 0,
    resourceAttributeKeys: resolveResourceAttributeKeys(otlp),
    spanAttributePassthroughPrefixes: resolveSpanAttributePassthroughPrefixes(otlp),
    maxExportBatchBytes: otlp?.maxExportBatchBytes,
  };
}

/**
 * 把 CMS/ARMS 简写展开成标准 OTLP endpoint。
 * licenseKey、project 和 workspace 会转换为 x-arms-* / x-cms-* 请求头；project 未显式
 * 提供时尝试从 endpoint 主机名第一段推导。
 */
function cmsEntryToOtlpEndpoint(
  name: string,
  cms: { endpoint: string; licenseKey?: string; workspace?: string; project?: string },
  armsResourceAttributes: Record<string, string>,
  serviceName?: string,
): OtlpEndpoint {
  const headers: Record<string, string> = {};
  const armsProject = cms.project || extractArmsProject(cms.endpoint);
  if (cms.licenseKey) headers['x-arms-license-key'] = cms.licenseKey;
  if (armsProject) headers['x-arms-project'] = armsProject;
  if (cms.workspace) headers['x-cms-workspace'] = cms.workspace;
  armsResourceAttributes['acs.arms.service.feature'] = 'genai_app';
  return { name, endpoint: cms.endpoint, headers, serviceName };
}

/** 按 key 排序后稳定序列化 Headers，避免对象插入顺序不同导致相同端点无法去重。 */
function stableHeaderKey(headers?: Record<string, string>): string {
  if (!headers) return '';
  return Object.keys(headers)
    .sort()
    .map(k => `${k}=${headers[k]}`)
    .join('&');
}

/**
 * 按“规范化 URL + 完整 Headers + serviceName”去重，先出现的端点保留。
 *
 * CMS 的 licenseKey/project/workspace 已经编码进 Headers，因此相同 URL 但认证信息不同的
 * 后端不会被误合并；同一 URL 使用不同 serviceName 时也会保留为两个独立出口。
 */
function dedupOtlpEndpoints(endpoints: OtlpEndpoint[]): OtlpEndpoint[] {
  const seen = new Set<string>();
  const result: OtlpEndpoint[] = [];
  for (const ep of endpoints) {
    const key = `${normalizeEndpointUrl(ep.endpoint)}|${stableHeaderKey(ep.headers)}|${ep.serviceName ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ep);
  }
  return result;
}

/** 清理并去重允许从记录提升为 Resource Attribute 的字段名。 */
function resolveResourceAttributeKeys(
  otlp: AnalyticsConfig['otlpTrace'],
): string[] {
  const keys = Array.isArray(otlp?.resourceAttributeKeys)
    ? otlp.resourceAttributeKeys
    : [];
  return [...new Set(
    keys
      .filter((key): key is string => typeof key === 'string')
      .map(key => key.trim())
      .filter(key => key.length > 0),
  )];
}

/** 清理并去重允许原样透传为 Span Attribute 的顶层字段前缀。 */
function resolveSpanAttributePassthroughPrefixes(
  otlp: AnalyticsConfig['otlpTrace'],
): string[] {
  const prefixes = Array.isArray(otlp?.spanAttributePassthroughPrefixes)
    ? otlp.spanAttributePassthroughPrefixes
    : [];
  return [...new Set(
    prefixes
      .filter((prefix): prefix is string => typeof prefix === 'string')
      .map(prefix => prefix.trim())
      .filter(prefix => prefix.length > 0),
  )];
}

/** 从 ARMS endpoint 的主机名中尽力提取 project，URL 无效时返回空字符串。 */
function extractArmsProject(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const hostParts = url.hostname.split('.');
    return hostParts[0] ?? '';
  } catch {
    return '';
  }
}

/**
 * OTLP Flusher 只有一份公共 captureMessageContent 默认值：未配置 Agent 策略时默认采集；
 * 只要任一 Agent 明确禁止消息正文，公共默认值就关闭，具体事件还会经过内容策略层处理。
 */
function resolveCaptureMessageContent(agents: AgentsConfig): boolean {
  const values = Object.values(agents);
  if (values.length === 0) return true;
  return values.every(a => a.captureMessageContent !== false);
}

/**
 * 把 config.json / data_config.json 中的 SLS 目的地转换成 Flusher 使用的统一结构。
 * 未写 mode 时，有完整 AK/SK 就选签名模式，否则使用 WebTracking 匿名模式。
 */
function parseSlsEndpointEntry(ep: SlsEndpointEntry, index: number): SlsEndpoint {
  const mode: SlsMode = ep.mode ?? (ep.accessKeyId && ep.accessKeySecret ? 'ak' : 'webtracking');
  const rawEndpoint = ep.endpoint ?? '';
  const endpoint = rawEndpoint
    ? (/^https?:\/\//.test(rawEndpoint) ? rawEndpoint : `https://${rawEndpoint}`)
    : '';
  const result: SlsEndpoint = {
    name: ep.name ?? `sls-${index}`,
    endpoint,
    project: ep.project,
    logstore: ep.logstore,
    kind: 'agentActivity',
    mode,
    redact: false,
  };
  if (mode === 'ak') {
    result.accessKeyId = ep.accessKeyId ?? '';
    result.accessKeySecret = ep.accessKeySecret ?? '';
  }
  return result;
}

/**
 * 构建 SLS 多目的地配置。
 *
 * 用户配置支持两种写法：旧版单对象和新版 endpoint 数组。随后再追加集团内置 SLS
 * 目的地，并按目标地址去重；用户目的地排在前面，所以重复时优先保留用户配置。
 * 每个 endpoint 保存自己的模式和凭据，SlsFlusher 会按目的地分别发送、重试和落失败日志。
 */
function buildSlsConfig(file: ConfigFile | null, serviceNamePrefix: string, innerDataConfig: InnerDataConfig | null) {
  const rawSls = file?.sls;
  const isArray = Array.isArray(rawSls);
  const single = isArray ? null : (rawSls as SlsSingleConfig | undefined) ?? null;

  if (single?.destinationOverride !== undefined) {
    // 旧版本曾允许二选一目的地；现在固定采用并集，保留警告帮助用户清理无效字段。
    logger.warn('config.sls.destinationOverride is deprecated and ignored — remove it from config.json');
  }

  let endpoints: SlsEndpoint[];

  if (isArray) {
    // 数组写法中的每一项都是完整目的地，不再套用单对象专用的 SLS 环境变量。
    endpoints = (rawSls as SlsEndpointEntry[]).map((ep, i) => parseSlsEndpointEntry(ep, i));
  } else if (single) {
    // 旧单对象写法允许部署环境通过环境变量覆盖目标地址和 AK/SK。
    const userMode = readUserSlsMode(single);
    const userAk = env('LOONGSUITE_SLS_ACCESS_KEY_ID') ?? single.accessKeyId;
    const userSk = env('LOONGSUITE_SLS_ACCESS_KEY_SECRET') ?? single.accessKeySecret;
    const userRawEndpoint = env('LOONGSUITE_SLS_ENDPOINT') ?? single.endpoint;
    const userProject = env('LOONGSUITE_SLS_PROJECT') ?? single.project;
    const userLogstore = env('LOONGSUITE_SLS_LOGSTORE') ?? single.logstore;

    // 用户目的地至少要有 project 和 logstore 才加入列表；endpoint/凭据是否完整会在
    // enabled 推导阶段按传输模式继续判断。
    const hasUserDestination = !!(userProject && userLogstore);

    if (hasUserDestination) {
      const userEndpoint = buildUserSlsEndpoint({
        mode: userMode,
        rawEndpoint: userRawEndpoint,
        project: userProject!,
        logstore: userLogstore!,
        accessKeyId: userAk,
        accessKeySecret: userSk,
      });
      endpoints = [userEndpoint];
    } else {
      endpoints = [];
    }
  } else {
    endpoints = [];
  }

  if (innerDataConfig?.sls && Array.isArray(innerDataConfig.sls)) {
    // 集团内置出口可使用自己的 __service_name__。只有与用户 prefix 不同时才逐端点标记，
    // 相同时继续使用公共值，便于去重并保持已有数据标签不变。
    const innerPrefix = innerDataConfig.serviceNamePrefix;
    const innerServiceName = innerPrefix && innerPrefix !== serviceNamePrefix ? innerPrefix : undefined;
    const innerEndpoints = innerDataConfig.sls
      .filter(ep => ep.endpoint && ep.logstore)
      .map((ep, i) => {
        const parsed = parseSlsEndpointEntry(ep, i);
        return innerServiceName ? { ...parsed, serviceName: innerServiceName } : parsed;
      });
    endpoints = [...endpoints, ...innerEndpoints];
  }

  endpoints = dedupSlsEndpoints(endpoints);

  // 顶层 mode/endpoint/AK/SK 是旧 SlsFlusherConfig 的兼容字段，以首个目的地作为主值；
  // 新的多目的地发送逻辑实际读取 endpoints 数组。
  const primary = endpoints[0] as SlsEndpoint | undefined;
  const topLevelMode = primary?.mode ?? 'webtracking';
  const topLevelEndpoint = primary?.endpoint ?? '';
  const topLevelAk = primary?.accessKeyId ?? '';
  const topLevelSk = primary?.accessKeySecret ?? '';

  // 旧单对象允许显式 enabled 覆盖完整性判断；否则只有所有 endpoint 都具备当前模式
  // 所需字段时才自动开启，避免一条坏目的地让运行期持续报错。
  const enabled = single?.enabled !== undefined
    ? single.enabled
    : endpoints.length > 0 && endpoints.every(ep => {
        if (!ep.endpoint || !ep.logstore) return false;
        if (ep.mode === 'ak') return !!(ep.project && ep.accessKeyId && ep.accessKeySecret);
        return true;
      });

  return {
    enabled,
    mode: topLevelMode,
    accessKeyId: topLevelAk,
    accessKeySecret: topLevelSk,
    endpoint: topLevelEndpoint,
    endpoints,
    batchMaxSize: single?.batchMaxSize ?? 20,
    flushIntervalMs: single?.flushIntervalMs ?? 2_000,
    serviceNamePrefix,
  };
}

/** 读取旧单 SLS 配置的显式模式；未知字符串留空，交给凭据情况自动推导。 */
function readUserSlsMode(single: SlsSingleConfig | null): SlsMode | undefined {
  const raw = env('LOONGSUITE_SLS_MODE') ?? single?.mode;
  if (raw === 'ak' || raw === 'webtracking') return raw;
  return undefined;
}

/** 根据旧单对象字段创建名为 user-sls 的统一 SLS endpoint。 */
function buildUserSlsEndpoint(args: {
  mode: SlsMode | undefined;
  rawEndpoint: string | undefined;
  project: string;
  logstore: string;
  accessKeyId: string | undefined;
  accessKeySecret: string | undefined;
}): SlsEndpoint {
  const mode: SlsMode = args.mode ?? (args.accessKeyId && args.accessKeySecret ? 'ak' : 'webtracking');

  const rawEndpoint = args.rawEndpoint ?? '';
  const endpoint = rawEndpoint
    ? (/^https?:\/\//.test(rawEndpoint) ? rawEndpoint : `https://${rawEndpoint}`)
    : '';

  const result: SlsEndpoint = {
    name: 'user-sls',
    endpoint,
    project: args.project,
    logstore: args.logstore,
    kind: 'agentActivity',
    mode,
    redact: false,
  };
  if (mode === 'ak') {
    result.accessKeyId = args.accessKeyId ?? '';
    result.accessKeySecret = args.accessKeySecret ?? '';
  }
  return result;
}

/**
 * 规范化 SLS/OTLP endpoint URL，仅用于比较去重：
 *   - 没有协议时补 https://；
 *   - 删除末尾 `/`；
 *   - 协议和主机名转小写，但保留路径大小写。
 */
function normalizeEndpointUrl(raw: string): string {
  let s = raw.trim();
  if (!/^https?:\/\//.test(s)) s = `https://${s}`;
  s = s.replace(/\/+$/, '');
  // 只处理协议和主机部分，不能破坏某些后端区分大小写的 URL path。
  return s.replace(/^(https?:\/\/)([^/]+)/i, (_, scheme: string, host: string) =>
    `${scheme.toLowerCase()}${host.toLowerCase()}`,
  );
}

/**
 * 按“规范化 URL + project + logstore + serviceName”去重 SLS 目的地。
 * serviceName 不同意味着数据标签不同，即使物理地址相同也必须保留两份。
 */
function dedupSlsEndpoints(endpoints: SlsEndpoint[]): SlsEndpoint[] {
  const seen = new Set<string>();
  const result: SlsEndpoint[] = [];
  for (const ep of endpoints) {
    const key = `${normalizeEndpointUrl(ep.endpoint)}|${ep.project}|${ep.logstore}|${ep.serviceName ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ep);
  }
  return result;
}

/**
 * 构建本地 JSONL 输出。它默认开启，是开箱即用的本地数据出口和无远端配置时的诊断依据。
 * collectLog 不直接关闭 JSONL；显式设置 jsonl.enabled=false 可关闭常规 JSONL 通道，
 * 但若其他输出也全部关闭，Orchestrator 仍会重新启用 JSONL 作为最后兜底。
 */
function buildJsonlConfig(file: ConfigFile | null, dataDir: string) {
  return {
    enabled: envBool('JSONL_ENABLED', file?.jsonl?.enabled ?? true),
    // 如果有配置JSONL_OUTPUT_DIR环境变量则使用该环境变量，若没有配置使用配置文件中配置的
    // 如配置文件中也没有就使用默认路径~/.loongsuite-pilot/logs/output
    outputDir: resolveHome(
      env('JSONL_OUTPUT_DIR') ?? file?.jsonl?.outputDir ?? `${dataDir}/logs/output`,
    ),
    rotateDaily: file?.jsonl?.rotateDaily ?? true,
    maxFileSizeMb: file?.jsonl?.maxFileSizeMb ?? 100,
  };
}

/**
 * 构建通用 HTTP 批量输出。只要设置 HTTP_REPORT_URL 就由该环境变量决定启停：非空开启、空字符串关闭；未设置时
 * 使用 config.json 的 enabled，若 enabled 也未写则根据 url 是否非空自动判断。
 */
function buildHttpConfig(file: ConfigFile | null) {
  const url = env('HTTP_REPORT_URL') ?? file?.http?.url ?? '';
  let headers: Record<string, string> | undefined;
  const envHeaders = env('HTTP_REPORT_HEADERS');
  if (envHeaders) {
    try {
      headers = JSON.parse(envHeaders);
    } catch {
      // Header JSON 无效时忽略，避免一个可选输出的配置错误阻断 Collector 启动。
    }
  } else {
    headers = file?.http?.headers;
  }

  const enabled = env('HTTP_REPORT_URL') !== undefined
    ? !!url
    : file?.http?.enabled ?? !!url;

  return {
    enabled,
    url,
    headers,
    batchMaxSize: file?.http?.batchMaxSize ?? 20,
    flushIntervalMs: file?.http?.flushIntervalMs ?? 5_000,
    requestTimeoutMs: file?.http?.requestTimeoutMs ?? 10_000,
  };
}

const DEFAULT_CHECK_INTERVAL_MS = 60_000; // 默认每分钟检查一次更新。

/**
 * 构建自动更新配置，主 Collector 和独立 Updater 进程共同复用。
 *
 * 自动更新只有配置 packageUrl 后才可能启用，避免默认环境意外访问网络。manifestUrl 未填
 * 时从 packageUrl 同目录推导 latest.json；installId 和 canary 字段用于灰度分桶与热修比较。
 */
export function buildAutoUpdateConfig(
  file: ConfigFile | null,
): AutoUpdateConfig {
  const packageUrl = env('LOONGSUITE_PILOT_PACKAGE_URL') ?? file?.autoUpdate?.packageUrl;

  let manifestUrl = env('LOONGSUITE_PILOT_MANIFEST_URL') ?? file?.autoUpdate?.manifestUrl;
  if (!manifestUrl && packageUrl) {
    // 例如 https://host/releases/pkg.tar.gz -> https://host/releases/latest.json。
    const lastSlash = packageUrl.lastIndexOf('/');
    manifestUrl = lastSlash >= 0
      ? packageUrl.substring(0, lastSlash + 1) + 'latest.json'
      : undefined;
  }

  const hasPackageConfig = !!packageUrl;

  return {
    // 即使 enabled=true，没有包地址也必须保持关闭，因为 Updater 无法完成下载。
    enabled: hasPackageConfig && envBool('LOONGSUITE_PILOT_AUTO_UPDATE_ENABLED', file?.autoUpdate?.enabled ?? true),
    checkIntervalMs: envInt(
      'LOONGSUITE_PILOT_AUTO_UPDATE_INTERVAL_MS',
      file?.autoUpdate?.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
    ),
    manifestUrl,
    packageUrl,
    installId: file?.installId,
    canaryPolicy: file?.canary?.policy,
    canaryHotfixVersion: file?.canary?.hotfix_version ?? 0,
  };
}
