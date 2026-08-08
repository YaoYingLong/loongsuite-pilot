/**
 * 声明式 Agent 部署的类型契约。
 *
 * AgentDefLoader 从 `agents.d/*.json` 读取这些结构，DeploymentManager 按 deployMode 选择
 * Strategy。该文件只定义跨模块协议，不执行探测或写配置。
 */

// 部署模式与 Hook/插件子类型。

export type DeployMode = 'hook' | 'plugin-probe' | 'plugin-inject' | 'detection-only';
export type MountType = 'wrapper' | 'rc-inject' | 'env-inject';
export type HookFormat = 'flat' | 'nested';
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

export interface AgentHookConfig {
  settingsPath: string;
  events: string[];
  hookCommand: string;
  format: HookFormat;
  matcher?: string;
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

export interface PluginSourceConfig {
  type: PluginSourceType;
  tarball?: string;
  url?: string;
  destDir: string;
  remoteUrl?: string;
}

export interface PluginInstallConfig {
  command: string;
  args: string[];
  cwd: string;
}

export interface PluginProbeConfig {
  source: PluginSourceConfig;
  mountType: MountType;
}

export interface AgentInputConfig {
  type: string;
  logDir?: string;
  [key: string]: unknown;
}

export interface PluginInjectConfig {
  configPaths: string[];
  pluginSpec: string;
  pluginId: string;
  replaceSpecs?: string[];
  /** 目标数组字段；缺省时自动识别 `plugins` 或 `plugin`。 */
  configKey?: string;
  /** 所有候选配置都不存在时，是否以空对象创建第一个路径。 */
  createIfMissing?: boolean;
}

export interface AgentRuntimeConfig {
  /** 运行时依赖的简述，如 "required-for-transcript" */
  nodeSqlite?: string;
  /** 该 builtin 首次可用的 Node 版本 */
  nodeSqliteSince?: string;
  /** 无该 builtin 时的 fallback 行为说明 */
  fallback?: string;
}

export interface AgentDefinition {
  id: string;
  displayName: string;
  deployMode: DeployMode;
  detection: AgentDetectionConfig;
  /** Local Worker 激活时用于匹配模板的 Runtime 标识，例如 `claude-code`。 */
  localWorkerRuntime?: string;
  hook?: AgentHookConfig;
  pluginProbe?: PluginProbeConfig;
  pluginInject?: PluginInjectConfig;
  input?: AgentInputConfig;
  /** 运行时要求（如 node:sqlite）与无该依赖时的 fallback 声明 */
  runtime?: AgentRuntimeConfig;
}

// Strategy 的统一执行结果。

export interface DeployResult {
  success: boolean;
  agentId: string;
  deployMode: DeployMode;
  skipped?: boolean;
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
  deployMode: DeployMode;
  deployedAt: string;
  sourceHash?: string;
  lastRemoteCheckedAt?: string;
}

export type DeployedAgentsState = Record<string, DeployedAgentRecord>;
