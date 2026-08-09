/**
 * 声明式 Agent 部署的类型契约。
 *
 * AgentDefLoader 从 `agents.d/*.json` 读取这些结构，DeploymentManager 按 deployMode 选择
 * Strategy。该文件只定义跨模块协议，不执行探测或写配置。
 */

// 部署模式与 Hook/插件子类型。

export type DeployMode = 'hook' | 'plugin-probe' | 'plugin-inject' | 'detection-only';
/** Plugin-Probe 把启动参数接入 Agent 的方式。 */
export type MountType = 'wrapper' | 'rc-inject' | 'env-inject';
/** Agent settings 中 Hook 是直接条目还是带 hooks 子数组的 wrapper。 */
export type HookFormat = 'flat' | 'nested';
/** 插件源码来自 OSS/远端地址还是随包 tarball。 */
export type PluginSourceType = 'oss' | 'tar';

// ─── Agent 声明（从 agents.d/*.json 加载） ───

/** Agent 可用性探测条件；paths 与 commands 中的所有候选项均为“或”关系。 */
export interface AgentDetectionConfig {
  /** 文件或目录候选路径，允许使用 `*`、`?` 通配符。 */
  paths: string[];
  /** 需要在当前进程 PATH 中查找的可执行命令名。 */
  commands: string[];
}

/**
 * Codex hook trust 写入配置。仅当 agent 的 hook 协议要求 trust hash（如 codex v0.125+）时填写。
 *
 * pilot 在 deploy 时会按此配置在目标机器上动态计算 trust hash 并写入指定 TOML 文件。
 * 算法版本号 `trustAlgo` 留作上游算法变更时的升级抓手；marker 名用于幂等替换/清理 BEGIN/END 块。
 */
export interface TrustTomlConfig {
  /** Trust state 写入的 TOML 文件路径（如 ~/.codex/config.toml）。 */
  configPath: string;
  /** Trust hash 算法版本号。当前固定为 'v1'，对齐 codex 上游 fingerprint.rs。 */
  trustAlgo: 'v1';
  /** BEGIN/END marker 名（如 "otel-codex-hook"），用于幂等替换 + 清理老 plugin 残留。 */
  marker: string;
}

/** HookStrategy 将 Agent 声明翻译为 settings 文件修改时使用的完整协议。 */
export interface AgentHookConfig {
  /** 目标 Agent 的 settings/Hook 配置文件路径，可包含已展开的用户目录。 */
  settingsPath: string;
  /** 需要安装 Pilot Hook 的事件名列表。 */
  events: string[];
  /** 每个 Hook 最终执行的基础命令。 */
  hookCommand: string;
  /** 目标 settings 使用 flat 还是 nested Hook 结构。 */
  format: HookFormat;
  /** nested 格式中的 matcher；缺失时使用策略默认值。 */
  matcher?: string;
  /** 识别并替换旧 Pilot Hook 时使用的历史命令候选。 */
  replaceHookCommands?: string[];
  /** 旧版本曾管理、当前部署时必须清理的事件名。 */
  retiredEvents?: string[];
  /**
   * 可选的 trust TOML 配置。仅 Codex 等需要 trust hash 校验的 agent 填写。
   * 设置后，HookStrategy 在 deploy 时会调用 codex-trust-writer 写入对应 TOML 文件。
   */
  trustToml?: TrustTomlConfig;
  /**
   * 是否给每个 event 拼 subcommand 后缀（kebab-case）。默认 undefined（共享 command，
   * 适用 Cursor / Qoder 等 stdin 自带 hook_event_name 的 agent）。
   *
   * Claude / Codex 的 mjs handler 通过 argv 区分事件，设为 'kebab-case' 后，
   * buildHookDefinitions 会把 hookCommand 转成 `${hookCommand} ${kebabEvent}`，
   * trust hash 也用同样字符串，保证一致性。
   *
   * Kiro CLI 的 hook trigger 是 camelCase（userPromptSubmit/postToolUse/...），
   * 设为 'as-is' 后，buildHookDefinitions 会把 hookCommand 转成
   * `${hookCommand} ${event}`（事件名原样追加）。
   */
  eventSubcommand?: 'kebab-case' | 'as-is';
  /**
   * Windows 下是否省略 `-File` 路径外层引号。
   * 某些 Agent 直接 spawn 而不经 shell，引号会成为参数中的字面字符，此时需要开启。
   */
  rawCommand?: boolean;
  /**
   * 部署时可选合并到 Agent settings.json 的 env 块。
   *
   * 值可包含 `$PILOT_DATA`；AgentDefLoader 加载声明时递归展开并尊重
   * `LOONGSUITE_PILOT_DATA_DIR`，所以 HookStrategy 接收到的是最终路径。
   *
   * 合并语义：普通 key 覆盖同名值；`BUN_OPTIONS` 按空格分词，待添加 token 已全部存在时
   * 跳过写入，以保持部署幂等并兼容用户配置的其他 preload。
   *
   * 注意：settings.json env 在 Agent 主进程启动后才读取，只能影响它创建的子进程，无法影响
   * 宿主启动时消费的 runtime flag。Bun 会在任何 JS 执行前读取 `BUN_OPTIONS`，因此此类注入
   * 应改用 shell rc wrapper（见 installer 的 inject_claude_code_fetch_intercept）。
   */
  env?: Record<string, string>;
  /**
   * Kiro CLI 专用：settingsPath 指向的是一整个 Agent 定义 JSON
   * （~/.kiro/agents/<name>.json），需要顶层 name + tools 字段。
   * HookStrategy 在 ensureSettingsFile 时若文件缺失会用此模板 seed。
   */
  kiroAgent?: {
    name: string;
    tools: string[];
  };
}

/** Plugin-Probe 安装包的来源与本地目标。 */
export interface PluginSourceConfig {
  /** 下载/解包来源类别。 */
  type: PluginSourceType;
  /** 随 Pilot 包发布的 tarball 路径。 */
  tarball?: string;
  /** OSS 或 HTTP 下载地址。 */
  url?: string;
  /** 插件解包后的目标目录。 */
  destDir: string;
  /** 用于周期检查新包的远端地址；可与首次 url 不同。 */
  remoteUrl?: string;
}

/** 安装插件所需的外部命令调用描述。 */
export interface PluginInstallConfig {
  /** 不经 shell 执行的命令名或路径。 */
  command: string;
  /** 原样传给命令的参数数组。 */
  args: string[];
  /** 子进程工作目录。 */
  cwd: string;
}

/** PluginProbeStrategy 所需的源码和挂载方式。 */
export interface PluginProbeConfig {
  /** 插件包来源及解包位置。 */
  source: PluginSourceConfig;
  /** Agent 启动时加载插件的接入方式。 */
  mountType: MountType;
}

/** 声明文件提供给 Input 注册层的开放扩展配置。 */
export interface AgentInputConfig {
  /** Input 实现标识。 */
  type: string;
  /** 可选日志目录覆盖。 */
  logDir?: string;
  /** Agent 专用配置由对应 Input 自行解释。 */
  [key: string]: unknown;
}

/** PluginInjectStrategy 修改 JSON 插件数组时使用的声明。 */
export interface PluginInjectConfig {
  /** 按优先级尝试的目标配置路径。 */
  configPaths: string[];
  /** 要加入插件数组的完整 spec。 */
  pluginSpec: string;
  /** 用于识别同一插件不同版本/spec 的稳定 ID。 */
  pluginId: string;
  /** 部署新 spec 时需要移除的历史 spec 列表。 */
  replaceSpecs?: string[];
  /** 目标数组字段；缺省时自动识别 `plugins` 或 `plugin`。 */
  configKey?: string;
  /** 所有候选配置都不存在时，是否以空对象创建第一个路径。 */
  createIfMissing?: boolean;
}

/** 仅描述运行时能力要求；当前部署策略不会据此自动安装 Node。 */
export interface AgentRuntimeConfig {
  /** 运行时依赖的简述，如 "required-for-transcript" */
  nodeSqlite?: string;
  /** 该 builtin 首次可用的 Node 版本 */
  nodeSqliteSince?: string;
  /** 无该 builtin 时的 fallback 行为说明 */
  fallback?: string;
}

/** 一个 `agents.d/*.json` 文件经校验和路径展开后的内存结构。 */
export interface AgentDefinition {
  /** Agent 稳定 ID，同时作为部署状态表 key。 */
  id: string;
  /** 日志和 CLI 展示名称。 */
  displayName: string;
  /** DeploymentManager 选择 Strategy 的判别字段。 */
  deployMode: DeployMode;
  /** 本机可用性探测条件。 */
  detection: AgentDetectionConfig;
  /** Local Worker 激活时用于匹配模板的 Runtime 标识，例如 `claude-code`。 */
  localWorkerRuntime?: string;
  /** hook 模式需要的配置；其他模式通常缺失。 */
  hook?: AgentHookConfig;
  /** plugin-probe 模式需要的配置。 */
  pluginProbe?: PluginProbeConfig;
  /** plugin-inject 模式需要的配置。 */
  pluginInject?: PluginInjectConfig;
  /** 对应 Input 的可选声明。 */
  input?: AgentInputConfig;
  /** 运行时要求（如 node:sqlite）与无该依赖时的 fallback 声明 */
  runtime?: AgentRuntimeConfig;
}

// Strategy 的统一执行结果。

export interface DeployResult {
  /** 当前部署动作是否完成；skipped 也可以是 success。 */
  success: boolean;
  /** 产生结果的 Agent ID。 */
  agentId: string;
  /** 实际使用的部署模式。 */
  deployMode: DeployMode;
  /** true 表示无需写入或目标不可用而有意跳过。 */
  skipped?: boolean;
  /** 失败时的可读错误摘要。 */
  error?: string;
}

// 所有具体部署 Strategy 必须实现的异步接口。

export interface DeployStrategy {
  /** 判断目标 Agent 当前是否存在。 */
  detect(def: AgentDefinition): Promise<boolean>;
  /** 比较当前配置/源码 hash，判断是否需要重新部署。 */
  needsDeploy(def: AgentDefinition, record?: DeployedAgentRecord): Promise<boolean>;
  /** 执行部署并返回结构化结果；实现通常自行捕获可恢复错误。 */
  deploy(def: AgentDefinition): Promise<DeployResult>;
  /** 移除 Pilot 管理的注入内容。 */
  undeploy(def: AgentDefinition): Promise<boolean>;
}

// 持久化到 deployed-agents.json 的幂等记录。

export interface DeployedAgentRecord {
  /** 上次成功部署使用的模式。 */
  deployMode: DeployMode;
  /** 上次部署完成的 ISO 时间。 */
  deployedAt: string;
  /** 已部署 Hook/插件源码内容哈希，用于 needsDeploy 幂等判断。 */
  sourceHash?: string;
  /** 上次检查远端插件包的 ISO 时间，用于控制检查频率。 */
  lastRemoteCheckedAt?: string;
}

/** deployed-agents.json 的顶层结构，以 Agent ID 索引最后一次部署记录。 */
export type DeployedAgentsState = Record<string, DeployedAgentRecord>;
