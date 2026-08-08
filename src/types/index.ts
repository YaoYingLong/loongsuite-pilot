/**
 * Pilot 公共配置类型的聚合入口。
 *
 * `config-loader.ts` 将 JSON/环境变量解析为这里的 `AppConfig`，Orchestrator 再把各子配置传给
 * Input、Flusher、Updater 和后台服务。顶部 re-export 让调用方也能从同一路径获得事件、
 * ClientType 与部署类型；本文件仅提供编译期契约，不读取配置或设置默认值。
 */

// ESM re-export 保留原模块的命名导出，不在运行时复制实现。
export * from './client-type.js';
export * from './deployment.js';
export * from './events.js';

/**
 * 单个采集 Listener 的运行配置。Listener 对应具体 Input 实现，而不是整个 Agent 产品。
 */
export interface ListenerConfig {
  /** 是否允许该 Input 参与发现和启动；最终状态还会受 Agent 级策略和准入控制影响。 */
  enabled: boolean;
  /** 文件监听不可用或未提供监听路径时的兜底发现间隔，单位毫秒。 */
  pollInterval: number;
}

/** 独立 Updater 进程使用的自动更新配置。 */
export interface AutoUpdateConfig {
  /** 自动更新最终开关；只有同时存在 packageUrl 时，ConfigLoader 才会将其置为 true。 */
  enabled: boolean;
  /** 拉取版本清单、检查新版本的周期，单位毫秒。 */
  checkIntervalMs: number;
  /** 版本清单 URL；未配置时会尝试由 packageUrl 的同目录推导 latest.json。 */
  manifestUrl?: string;
  /** 更新包的兜底下载 URL，也是允许启用自动更新的必要配置。 */
  packageUrl?: string;
  /** 当前安装实例的稳定 UUID，用于确定性灰度分桶；缺失时 Updater 会生成并持久化。 */
  installId?: string;
  /** 灰度策略：auto 按比例分桶，latest 强制跟随灰度版本，off 只使用稳定版本。 */
  canaryPolicy?: 'auto' | 'latest' | 'off';
  /** 本地已安装的灰度热修订号，用于同一语义版本下判断是否还需更新。 */
  canaryHotfixVersion?: number;
}

/** 用户配置的 CMS/ARMS Trace 简写。 */
export interface CmsConfig {
  /** 简写配置是否具备 licenseKey；真正创建后端时还要求 endpoint 非空。 */
  enabled: boolean;
  /** 作为 x-arms-license-key 请求头发送的 ARMS/CMS 许可凭据。 */
  licenseKey: string;
  /** ARMS/CMS 的 OTLP HTTP Trace 地址。 */
  endpoint: string;
  /** 作为 x-cms-workspace 请求头发送的工作空间标识。 */
  workspace: string;
  /** 是否将 Trace 转换结果写入本地调试目录。 */
  debug?: boolean;
}

/** 脱敏策略：不脱敏、启用全部规则，或只启用指定规则。 */
export type MaskMode = 'none' | 'all' | 'custom';

/** 内置的敏感信息识别规则类别。 */
export type MaskType = 'cloudAccessKey' | 'apiKey' | 'privateKey' | 'databaseUrl';

/** 归一化事件进入各输出通道前使用的内容脱敏配置。 */
export interface MaskConfig {
  /** 当前脱敏模式；custom 模式会读取 types，其他模式忽略 types。 */
  mode: MaskMode;
  /** custom 模式启用的规则列表；未知规则在加载时会被过滤。 */
  types: MaskType[];
}

/** 用户 otlpTrace 配置在与内置 Trace 后端合并前的原始形态。 */
export interface OtlpTraceRawConfig {
  /** 用户 OTLP HTTP 基础地址；缺少 /v1/traces 时由 Flusher 自动补齐。 */
  endpoint?: string;
  /** 发往用户 OTLP 后端的请求头，通常承载鉴权信息。 */
  headers?: Record<string, string>;
  /** 附加到所有导出 Span 所属 Resource 的静态属性。 */
  resourceAttributes?: Record<string, string>;
  /** 用户后端使用的 service.name；缺省时使用 AnalyticsConfig.serviceNamePrefix。 */
  serviceName?: string;
  /** 是否把转换后的 Span 写入 <dataDir>/logs/otlp-debug 便于诊断。 */
  debug?: boolean;
  /** 是否允许 Trace Span 保留 Prompt、Completion、工具参数和工具结果等消息正文。 */
  captureMessageContent?: boolean;
  /** Turn 长时间无新记录时强制结束并导出的空闲阈值，单位毫秒；0 或缺省表示关闭。 */
  turnIdleTimeoutMs?: number;
  /** 允许从顶层采集记录提升为 OTLP Resource Attribute 的字段名白名单。 */
  resourceAttributeKeys?: string[];
  /** 允许原样透传为 Span Attribute 的顶层记录字段前缀，例如 multica.。 */
  spanAttributePassthroughPrefixes?: string[];
  /** 单次 OTLP 导出批次的估算字节上限；缺省为 10 MiB，超限时会拆分 Span 批次。 */
  maxExportBatchBytes?: number;
  /** 用户 OTLP 后端的传输压缩方式；缺省按 gzip 处理。 */
  compression?: 'none' | 'gzip';
}

/** 用户或集团内置配置中的单个通用 OTLP Trace 后端。 */
export interface OtlpEndpointEntry {
  /** 后端标识，用于运行日志和失败文件名；缺省时按来源及数组下标生成。 */
  name?: string;
  /** OTLP HTTP 基础地址，Flusher 会规范化为 /v1/traces 导出地址。 */
  endpoint: string;
  /** 仅发送给该后端的请求头。 */
  headers?: Record<string, string>;
  /** 该后端的压缩方式；缺省使用 gzip。 */
  compression?: 'none' | 'gzip';
}

/** ARMS/CMS 简写，加载时会展开为带 x-arms-* 请求头的标准 OTLP endpoint。 */
export interface CmsEndpointEntry {
  /** 后端标识，用于运行日志和失败文件名；缺省时按数组下标生成。 */
  name?: string;
  /** ARMS/CMS 的 OTLP HTTP Trace 地址。 */
  endpoint: string;
  /** 转换为 x-arms-license-key 请求头的许可凭据。 */
  licenseKey?: string;
  /** 转换为 x-cms-workspace 请求头的工作空间标识。 */
  workspace?: string;
  /** 转换为 x-arms-project 请求头的项目名；缺省时尝试从 endpoint 主机名推导。 */
  project?: string;
}

/** 从 configs/inner/data_config.json 读取的集团内置 Trace 后端。 */
export interface InnerTraceConfig {
  /** 托管的通用 OTLP 后端列表，会追加到用户后端。 */
  otlp?: OtlpEndpointEntry[];
  /** 托管的 ARMS/CMS 简写后端列表，会追加到用户后端。 */
  cms?: CmsEndpointEntry[];
  /** 内置后端的 service.name；未配置时沿用用户侧前缀。 */
  serviceNamePrefix?: string;
}

/**
 * ConfigLoader 完成默认值填充和多来源合并后的完整运行配置。
 * Orchestrator 只消费此结构，不再关心某个值来自环境变量、config.json 还是内置配置。
 */
export interface AnalyticsConfig {
  /** 整个 Collector 的运行总开关；false 时启动流程正常结束，不创建采集组件。 */
  enabled: boolean;
  /** 历史兼容字段，当前固定为 true，不负责控制系统服务是否自启动。 */
  autoStart: boolean;
  /** 状态、日志、缓存、版本和本地输出使用的数据根目录。 */
  dataDir: string;
  /** 注入采集事件、告警及运行指标的用户标识；默认回退到主机名。 */
  userId: string;
  /** 日志类远端输出总开关；当前只门控 SLS，不直接关闭 JSONL 或 HTTP。 */
  collectLog: boolean;
  /** OTLP Trace 输出总开关；关闭时即使配置了后端也不创建 Trace Flusher。 */
  collectTrace: boolean;
  /** SLS 的 __service_name__ 和 OTLP 的 service.name 使用的公共默认名称。 */
  serviceNamePrefix: string;
  /** 用户 CMS/ARMS 简写经默认值和环境变量处理后的配置。 */
  cms: CmsConfig;
  /** 用户 Trace 原始配置，稍后与 innerTrace 做并集并转换为最终 Flusher 配置。 */
  otlpTrace?: OtlpTraceRawConfig;
  /** 集团内置 Trace 后端，会追加到用户后端而不是覆盖用户配置。 */
  innerTrace?: InnerTraceConfig;
  /** 按具体 Input 实现索引的开关和兜底轮询间隔。 */
  listeners: Record<string, ListenerConfig>;
  /** 可并行启用的 SLS、JSONL、HTTP 日志输出配置。 */
  flushers: FlusherConfig;
  /** 本地各类日志的定期清理周期和保留天数。 */
  retention: LogRetentionConfig;
  /** 按 Agent 产品 ID 索引的准入与消息正文采集策略。 */
  agents: AgentsConfig;
  /** 归一化事件分发到输出端之前执行的敏感信息脱敏策略。 */
  mask: MaskConfig;
  /** Hook 完整性巡检、自动修复及修复限流配置。 */
  hookWatchdog: HookWatchdogConfig;
  /** 已废弃的文件采集兼容视图；内容与 pipeline 相同。 */
  fileCollection: FileCollectionToggle;
  /** 独立 Pipeline 子系统及其文件、Qoder API 子管道开关。 */
  pipeline: PipelineToggle;
  /** 本地状态栏运行心跳和指标摘要生成配置。 */
  statusBar: StatusBarConfig;
  /** 自动更新配置；未配置有效 packageUrl 时仍会返回 disabled 配置。 */
  autoUpdate?: AutoUpdateConfig;
  /** 将 Agent Trace 连接到外部父 Span 的上游关联配置。 */
  upstreamLink: UpstreamLinkConfig;
  /** 仅注入 Trace Span 的用户自定义属性，是 config 和环境变量合并、清洗后的启动基线。 */
  globalSpanAttributes?: Record<string, string>;
}

/**
 * 上游 Trace 关联：从 acp-correlate 存储解析 trace_id / parent_span_id，
 * 把 Agent Span 挂到上游 Span 下。默认关闭。
 */
export interface UpstreamLinkConfig {
  /** 是否启用跨进程父子 Span 关联；解析失败时保持 fail-open，不影响正常采集。 */
  enabled: boolean;
  /** acp-correlate 关联文件和锁文件的保留时间，单位毫秒；非正值会回退到 24 小时。 */
  ttlMs: number;
}

/** Agent 产品级策略，会作用于该 Agent 下的多个 Listener。 */
export interface AgentConfig {
  /** 产品级启用状态；缺省表示不额外禁止，继续由 Listener 和准入控制决定。 */
  enabled?: boolean;
  /** 是否保留完整 Prompt、Completion、工具参数和工具结果；具体集成需支持该策略。 */
  captureMessageContent: boolean;
}

/** 以 Agent 产品 ID（如 codex、claude-code）为键的产品级策略表。 */
export type AgentsConfig = Record<string, AgentConfig>;

/** 日志事件输出通道集合；各通道可独立启用并由 MultiFlusher 扇出。 */
export interface FlusherConfig {
  /** 阿里云 SLS 批量输出配置。 */
  sls?: SlsFlusherConfig;
  /** 本地 JSONL 输出配置。 */
  jsonl?: JsonlFlusherConfig;
  /** 自定义 HTTP POST 输出配置。 */
  http?: HttpFlusherConfig;
}

/** 已解析完成、可直接交给 Flusher 的单个 OTLP 后端。 */
export interface OtlpEndpoint {
  /** 后端唯一标识，用于日志、Exporter 标识和隔离失败文件。 */
  name: string;
  /** OTLP HTTP 基础地址；Flusher 会在需要时追加 /v1/traces。 */
  endpoint: string;
  /** 仅发送给当前后端的请求头。 */
  headers?: Record<string, string>;
  /** 当前后端的压缩方式；缺省使用 gzip。 */
  compression?: 'none' | 'gzip';
  /** 只为该后端覆盖公共 serviceName，使同一批 Span 可按后端使用不同 Resource。 */
  serviceName?: string;
}

/** OTLP Trace Flusher 消费的完整配置。 */
export interface OtlpTraceFlusherConfig {
  /** Flusher 启用标记；当前仅在存在有效后端时构建为 true。 */
  enabled: boolean;
  /** 一个或多个后端；同一批逻辑 Span 会独立发送到每个后端。 */
  endpoints: OtlpEndpoint[];
  /** 当前唯一支持的 OTLP 传输协议。 */
  protocol: 'http/protobuf';
  /** 后端未单独覆盖时写入 Resource 的公共 service.name。 */
  serviceName: string;
  /** 合并到所有 Span Resource 的静态属性。 */
  resourceAttributes?: Record<string, string>;
  /** 是否允许 OpenTelemetry GenAI 转换保留消息正文。 */
  captureMessageContent?: boolean;
  /** 是否将转换后的 Span 写入本地调试目录。 */
  debug?: boolean;
  /** Turn 空闲达到该毫秒数时强制结束并导出；0 或缺省表示关闭空闲检测。 */
  turnIdleTimeoutMs?: number;
  /** 允许从采集记录提升为 Resource Attribute 的顶层字段白名单。 */
  resourceAttributeKeys?: string[];
  /** 允许原样透传为 Span Attribute 的顶层记录字段前缀。 */
  spanAttributePassthroughPrefixes?: string[];
  /** 单个导出批次的估算字节上限；缺省为 10 MiB。 */
  maxExportBatchBytes?: number;
  /** 调试文件、失败持久化文件和版本信息使用的数据根目录。 */
  dataDir?: string;
}

/** SLS 发送模式：AK/SK 签名 API 或匿名 WebTracking API。 */
export type SlsMode = 'ak' | 'webtracking';

/** SLS Flusher 的公共批处理设置和多目的地列表。 */
export interface SlsFlusherConfig {
  /** 是否创建并启动 SLS Flusher。 */
  enabled: boolean;
  /** 首个目的地的兼容模式字段；实际发送以 endpoints 中每项的 mode 为准。 */
  mode: SlsMode;
  /** 首个目的地的兼容 AccessKey ID 字段；多目的地发送不读取此字段。 */
  accessKeyId: string;
  /** 首个目的地的兼容 AccessKey Secret 字段；多目的地发送不读取此字段。 */
  accessKeySecret: string;
  /** 首个目的地的兼容 endpoint 字段；实际发送以 endpoints 为准。 */
  endpoint: string;
  /** 实际接收每条日志的 SLS 目的地列表，支持逐目的地认证、重试和失败隔离。 */
  endpoints: SlsEndpoint[];
  /** 每个目的地积累到该日志条数时立即触发批量发送。 */
  batchMaxSize: number;
  /** 未达到批量条数时的定时刷新周期，单位毫秒。 */
  flushIntervalMs: number;
  /** 生成 __service_name__ 标签时使用的公共前缀。 */
  serviceNamePrefix: string;
}

/** 已规范化、可由 SlsFlusher 直接发送的单个 SLS 目的地。 */
export interface SlsEndpoint {
  /** 目的地唯一名称，用于运行日志、指标及隔离失败缓存文件。 */
  name: string;
  /** 当前目的地的基础 URL，例如 https://cn-hangzhou.log.aliyuncs.com。 */
  endpoint: string;
  /** SLS Project 名；AK 模式也将其传给签名 API。 */
  project: string;
  /** 接收日志的 Logstore 名。 */
  logstore: string;
  /** 写入 SLS topic 的数据类别；mcp 和 trace 目的地还可接收辅助载荷。 */
  kind: 'agentActivity' | 'agentTelemetry' | 'mcp' | 'trace';
  /** 当前目的地的传输模式；ak 模式必须提供 accessKeyId 和 accessKeySecret。 */
  mode: SlsMode;
  /** ak 模式使用的 AccessKey ID；webtracking 模式不需要。 */
  accessKeyId?: string;
  /** ak 模式使用的 AccessKey Secret；webtracking 模式不需要。 */
  accessKeySecret?: string;
  /** 是否在发送到该目的地前额外移除代码生成相关字段。 */
  redact?: boolean;
  /** 只为该目的地覆盖公共 __service_name__ 标签。 */
  serviceName?: string;
}

/** 本地 JSONL Flusher 配置。 */
export interface JsonlFlusherConfig {
  /** 是否启用常规本地 JSONL 输出；所有输出关闭时 Orchestrator 仍可能启用兜底实例。 */
  enabled: boolean;
  /** 按 Agent 类型写入 JSONL 文件的目录。 */
  outputDir: string;
  /** 是否按本地日期分文件；false 时文件名日期部分固定为 all。 */
  rotateDaily: boolean;
  /** 预留的单文件大小阈值（MiB）；当前 JsonlFlusher 尚未据此执行大小轮转。 */
  maxFileSizeMb: number;
}

/** 自定义 HTTP 批量 POST Flusher 配置。 */
export interface HttpFlusherConfig {
  /** 是否启用 HTTP 输出。 */
  enabled: boolean;
  /** 接收序列化事件数组的 HTTP POST 地址。 */
  url: string;
  /** 随每次 POST 发送的自定义请求头，通常用于鉴权。 */
  headers?: Record<string, string>;
  /** 缓冲区达到该事件条数时立即发送。 */
  batchMaxSize: number;
  /** 未达到批量条数时的定时刷新周期，单位毫秒。 */
  flushIntervalMs: number;
  /** 单次 HTTP 请求的超时时间，单位毫秒。 */
  requestTimeoutMs: number;
}

/**
 * AgentDiscoveryService 消费的单个发现和生命周期条目。
 * 一个条目对应具体 Input 或部署动作，不一定等同于整个 Agent 产品。
 */
export interface AgentDetectionEntry {
  /** 条目唯一 ID，也是状态机、日志和事件通知使用的标识。 */
  id: string;
  /** 采集或部署类型说明，通常取 Input 的 CollectionMethod。 */
  type: string;
  /** 异步探测目标 Agent 或数据源当前是否存在且可用。 */
  isAvailable: () => Promise<boolean>;
  /** 触发重新探测的文件或目录；为空或监听失败时使用定时轮询。 */
  watchPaths: string[];
  /** 动态准入回调，合并配置开关和 AgentControl 策略后给出当前启用状态。 */
  enabled: () => boolean;
  /** 将条目从 idle/starting 推进为 running 时调用的异步启动动作。 */
  start: () => Promise<void>;
  /** 条目不可用或服务停止时调用的异步清理动作。 */
  stop: () => Promise<void>;
  /** 无文件监听时重新执行可用性探测的周期，单位毫秒。 */
  pollIntervalMs: number;
  /** 为 true 时，条目已运行且再次活跃也会重复调用 start，用于需要刷新部署的实现。 */
  runOnActive?: boolean;
}

/** LogRetentionService 使用的分类保留策略。 */
export interface LogRetentionConfig {
  /** 是否执行启动后及周期性的本地日志清理。 */
  enabled: boolean;
  /** 两次清理扫描的时间间隔，单位毫秒。 */
  intervalMs: number;
  /** <dataDir>/logs/history 下日期日志的保留天数。 */
  hookHistoryDays: number;
  /** <dataDir>/logs/errors 下日期日志的保留天数。 */
  hookErrorDays: number;
  /** <dataDir>/logs/debug 下日期日志的保留天数。 */
  hookDebugDays: number;
  /** <dataDir>/logs/output 下 JSONL 事件文件的常规保留天数。 */
  outputDays: number;
  /** <dataDir>/logs/sls-failed-logs 下 SLS 失败诊断日志的保留天数。 */
  slsFailedDays: number;
}

/** 防止 Agent 升级或其他工具覆盖已部署采集 Hook 的巡检配置。 */
export interface HookWatchdogConfig {
  /** 是否定期检查并修复被覆盖的采集 Hook。 */
  enabled: boolean;
  /** 两次 Hook 完整性检查的间隔，单位毫秒。 */
  intervalMs: number;
  /** 同一目标两次修复之间的最短间隔，单位毫秒，避免持续损坏时反复写文件。 */
  repairCooldownMs: number;
}

/** 独立 Pipeline 子系统及各输入类型的开关。 */
export interface PipelineToggle {
  /** PipelineManager 总开关；关闭时不扫描或启动任何声明式管道。 */
  enabled: boolean;
  /** 文件尾读采集管道开关。 */
  file: {
    /** 是否允许启动 input_file 类型的 Pipeline。 */
    enabled: boolean;
  };
  /** Qoder API 轮询采集管道开关。 */
  qoderApi: {
    /** 是否允许启动 input_qoder_api 类型的 Pipeline。 */
    enabled: boolean;
  };
}

/** @deprecated 旧文件采集开关的兼容别名；其值现在是完整 PipelineToggle，请使用 pipeline。 */
export type FileCollectionToggle = PipelineToggle;

/** 本地状态栏应用所需运行文件的刷新配置。 */
export interface StatusBarConfig {
  /** 是否生成 runtime.json 和 metrics-summary.json 等状态栏数据。 */
  enabled: boolean;
  /** 重新聚合本地 JSONL 指标摘要的周期，单位毫秒。 */
  metricsSummaryIntervalMs: number;
  /** 重写 Collector 运行心跳 runtime.json 的周期，单位毫秒。 */
  runtimeRefreshIntervalMs: number;
}

/** Agent 准入模式：强制开启、强制关闭，或沿用配置和可用性判断。 */
export type AgentControlMode = 'on' | 'off' | 'auto';

/** 持久化在 agent-control.json 中的 Agent 产品级准入控制。 */
export interface AgentControlConfig {
  /** 配置文件结构版本，供后续迁移和兼容判断使用；当前写入版本为 3。 */
  version: number;
  /** 以 Agent ID 为键的准入模式；未列出的 Agent 默认按 auto 处理。 */
  tools: Record<string, AgentControlMode>;
}

/**
 * StateStore 按 Input ID 持久化的增量采集游标。
 * 各 Input 只使用适合自身数据源的字段，未使用字段可以缺省。
 */
export interface InputState {
  /** 已处理到的文件字节偏移；文件尾读和 Session 输入用它避免重复读取。 */
  lastOffset?: number;
  /** 与 lastOffset 配对的当前文件标识；文件切换时用于判断是否应从头读取。 */
  lastFile?: string;
  /** SQLite 输入已处理的最大 rowid，后续查询只读取更大的记录。 */
  lastRowId?: number;
  /** 时间戳型输入可使用的最近处理时间游标；通用 StateStore 仅负责原样持久化。 */
  lastTimestamp?: number;
  /** 输入实现可使用的单调高水位；通用 StateStore 不解释其具体单位或含义。 */
  highWatermark?: number;
  /** Input 私有的可序列化扩展状态，例如 inode、已发窗口或模型策略；update 时浅层合并。 */
  extra?: Record<string, unknown>;
}

/** AgentDiscoveryService 条目的生命周期状态。 */
export type EntryState = 'idle' | 'starting' | 'running' | 'stopping';
