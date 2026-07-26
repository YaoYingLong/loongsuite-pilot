export * from './client-type.js';
export * from './deployment.js';
export * from './events.js';

/**
 * 单个采集 Listener 的运行配置。Listener 对应具体 Input 实现，而不是整个 Agent 产品。
 */
export interface ListenerConfig {
  /** 是否允许该 Input 参与发现和启动。 */
  enabled: boolean;
  /** AgentDiscoveryService 的兜底轮询间隔。 */
  pollInterval: number;
}

/** 独立 Updater 进程使用的自动更新配置。 */
export interface AutoUpdateConfig {
  enabled: boolean;
  checkIntervalMs: number;
  manifestUrl?: string;
  packageUrl?: string;
  installId?: string;
  canaryPolicy?: 'auto' | 'latest' | 'off';
  canaryHotfixVersion?: number;
}

/** 用户配置的 CMS/ARMS Trace 简写。 */
export interface CmsConfig {
  enabled: boolean;
  licenseKey: string;
  endpoint: string;
  workspace: string;
  debug?: boolean;
}

export type MaskMode = 'none' | 'all' | 'custom';

export type MaskType = 'cloudAccessKey' | 'apiKey' | 'privateKey' | 'databaseUrl';

export interface MaskConfig {
  mode: MaskMode;
  types: MaskType[];
}

export interface OtlpTraceRawConfig {
  endpoint?: string;
  headers?: Record<string, string>;
  resourceAttributes?: Record<string, string>;
  serviceName?: string;
  debug?: boolean;
  captureMessageContent?: boolean;
  turnIdleTimeoutMs?: number;
  resourceAttributeKeys?: string[];
  /** 允许原样透传为 Span Attribute 的顶层记录字段前缀，例如 `multica.`。 */
  spanAttributePassthroughPrefixes?: string[];
  maxExportBatchBytes?: number;
  compression?: 'none' | 'gzip';
}

/** 用户或集团内置配置中的单个通用 OTLP Trace 后端。 */
export interface OtlpEndpointEntry {
  name?: string;
  endpoint: string;
  headers?: Record<string, string>;
  compression?: 'none' | 'gzip';
}

/** ARMS/CMS 简写，加载时会展开为带 x-arms-* 请求头的标准 OTLP endpoint。 */
export interface CmsEndpointEntry {
  name?: string;
  endpoint: string;
  licenseKey?: string;
  workspace?: string;
  project?: string;
}

/** 从 configs/inner/data_config.json 读取的集团内置 Trace 后端。 */
export interface InnerTraceConfig {
  otlp?: OtlpEndpointEntry[];
  cms?: CmsEndpointEntry[];
  /** 内置后端的 service.name；未配置时沿用用户侧前缀。 */
  serviceNamePrefix?: string;
}

/**
 * ConfigLoader 完成默认值填充和多来源合并后的完整运行配置。
 * Orchestrator 只消费此结构，不再关心某个值来自环境变量、config.json 还是内置配置。
 */
export interface AnalyticsConfig {
  /** 整个 Collector 总开关。 */
  enabled: boolean;
  /** 历史兼容字段，当前固定为 true，不负责控制系统服务是否自启动。 */
  autoStart: boolean;
  /** 所有状态、日志、版本及本地输出的根目录。 */
  dataDir: string;
  /** 写入采集记录和运行指标的用户标识。 */
  userId: string;
  /** 日志类远端采集开关，当前用于门控 SLS。 */
  collectLog: boolean;
  /** OTLP Trace 构建总开关。 */
  collectTrace: boolean;
  serviceNamePrefix: string;
  cms: CmsConfig;
  /** 用户 Trace 原始配置，稍后与 innerTrace 合并。 */
  otlpTrace?: OtlpTraceRawConfig;
  /** 集团内置 Trace 后端，会追加到用户后端而不是覆盖用户配置。 */
  innerTrace?: InnerTraceConfig;
  /** 具体 Input 实现的开关和轮询间隔。 */
  listeners: Record<string, ListenerConfig>;
  /** SLS、JSONL、HTTP 日志输出配置。 */
  flushers: FlusherConfig;
  retention: LogRetentionConfig;
  agents: AgentsConfig;
  mask: MaskConfig;
  hookWatchdog: HookWatchdogConfig;
  fileCollection: FileCollectionToggle;
  pipeline: PipelineToggle;
  statusBar: StatusBarConfig;
  autoUpdate?: AutoUpdateConfig;
  upstreamLink: UpstreamLinkConfig;
  /** 仅注入 Trace Span 的用户自定义属性，是 config + env 合并后的启动基线。 */
  globalSpanAttributes?: Record<string, string>;
}

/**
 * 上游 Trace 关联：从 acp-correlate 存储解析 trace_id / parent_span_id，
 * 把 Agent Span 挂到上游 Span 下。默认关闭。
 */
export interface UpstreamLinkConfig {
  enabled: boolean;
  /** acp-correlate 文件和锁的保留时间，单位毫秒。 */
  ttlMs: number;
}

/** Agent 产品级策略，会作用于该 Agent 下的多个 Listener。 */
export interface AgentConfig {
  enabled?: boolean;
  captureMessageContent: boolean;
}

export type AgentsConfig = Record<string, AgentConfig>;

export interface FlusherConfig {
  sls?: SlsFlusherConfig;
  jsonl?: JsonlFlusherConfig;
  http?: HttpFlusherConfig;
}

/** 已解析完成、可直接交给 Flusher 的单个 OTLP 后端。name 用于日志和故障定位。 */
export interface OtlpEndpoint {
  name: string;
  endpoint: string;
  headers?: Record<string, string>;
  compression?: 'none' | 'gzip';
  /** 只为该后端覆盖公共 serviceName。 */
  serviceName?: string;
}

export interface OtlpTraceFlusherConfig {
  enabled: boolean;
  /** 一个或多个后端；同一批逻辑 Span 会发送到每个后端。 */
  endpoints: OtlpEndpoint[];
  protocol: 'http/protobuf';
  // 后端未单独配置 serviceName 时使用此公共名称。
  serviceName: string;
  resourceAttributes?: Record<string, string>;
  captureMessageContent?: boolean;
  debug?: boolean;
  turnIdleTimeoutMs?: number;
  resourceAttributeKeys?: string[];
  /** 允许原样透传为 Span Attribute 的顶层记录字段前缀。 */
  spanAttributePassthroughPrefixes?: string[];
  maxExportBatchBytes?: number;
  dataDir?: string;
}

export type SlsMode = 'ak' | 'webtracking';

export interface SlsFlusherConfig {
  enabled: boolean;
  /** 上报模式：'ak' 使用 AK/SK 签名的 postLogStoreLogs，'webtracking' 使用匿名 PutWebtracking */
  mode: SlsMode;
  accessKeyId: string;
  accessKeySecret: string;
  /** 完整 SLS endpoint URL，如 https://cn-hangzhou.log.aliyuncs.com */
  endpoint: string;
  endpoints: SlsEndpoint[];
  batchMaxSize: number;
  flushIntervalMs: number;
  serviceNamePrefix: string;
}

export interface SlsEndpoint {
  /** 目的地唯一名称，用于日志及隔离失败缓存文件。 */
  name: string;
  /** 当前目的地的基础 URL，例如 https://cn-hangzhou.log.aliyuncs.com。 */
  endpoint: string;
  project: string;
  logstore: string;
  kind: 'agentActivity' | 'agentTelemetry' | 'mcp' | 'trace';
  /** 当前目的地的传输模式；ak 模式必须提供 accessKeyId/accessKeySecret。 */
  mode: SlsMode;
  accessKeyId?: string;
  accessKeySecret?: string;
  redact?: boolean;
  /** 只为该目的地覆盖公共 __service_name__ 标签。 */
  serviceName?: string;
}

export interface JsonlFlusherConfig {
  enabled: boolean;
  outputDir: string;
  rotateDaily: boolean;
  maxFileSizeMb: number;
}

export interface HttpFlusherConfig {
  enabled: boolean;
  url: string;
  headers?: Record<string, string>;
  batchMaxSize: number;
  flushIntervalMs: number;
  requestTimeoutMs: number;
}

/**
 * Agent detection entry — describes how to discover and manage a single agent.
 */
export interface AgentDetectionEntry {
  id: string;
  type: string;
  isAvailable: () => Promise<boolean>;
  watchPaths: string[];
  enabled: () => boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  pollIntervalMs: number;
  runOnActive?: boolean;
}

export interface LogRetentionConfig {
  /** 是否执行定期清理。 */
  enabled: boolean;
  /** 两次清理扫描的时间间隔。 */
  intervalMs: number;
  hookHistoryDays: number;
  hookErrorDays: number;
  hookDebugDays: number;
  outputDays: number;
  slsFailedDays: number;
}

export interface HookWatchdogConfig {
  /** 是否定期检查并修复被覆盖的采集 Hook。 */
  enabled: boolean;
  intervalMs: number;
  repairCooldownMs: number;
}

export interface PipelineToggle {
  /** 独立 Pipeline 子系统总开关。 */
  enabled: boolean;
  file: { enabled: boolean };
  qoderApi: { enabled: boolean };
}

/** @deprecated 旧文件采集开关的兼容别名，请使用 PipelineToggle。 */
export type FileCollectionToggle = PipelineToggle;

export interface StatusBarConfig {
  enabled: boolean;
  metricsSummaryIntervalMs: number;
  runtimeRefreshIntervalMs: number;
}

export type AgentControlMode = 'on' | 'off' | 'auto';

export interface AgentControlConfig {
  version: number;
  tools: Record<string, AgentControlMode>;
}

/**
 * Input state persisted between runs.
 */
export interface InputState {
  lastOffset?: number;
  lastFile?: string;
  lastRowId?: number;
  lastTimestamp?: number;
  highWatermark?: number;
  extra?: Record<string, unknown>;
}

export type EntryState = 'idle' | 'starting' | 'running' | 'stopping';
