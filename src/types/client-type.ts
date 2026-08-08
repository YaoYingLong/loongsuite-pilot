/**
 * Agent、工具类别与采集方式的稳定枚举。
 *
 * 新增 Agent 时需要同步扩展 ClientType、Orchestrator 注册、agents.d 声明和测试。枚举值会进入
 * 配置、checkpoint、日志与 Trace Resource，因此发布后不应随意改名。
 */
export enum ClientType {
  // IDE 或桌面应用类 Agent。
  Cursor = 'cursor',
  Qoder = 'qoder',
  QoderCn = 'qoder-cn',
  QoderIdea = 'qoder-idea',
  QoderWork = 'qoder-work',
  QoderWorkCN = 'qoder-work-cn',
  Kiro = 'kiro',
  KiroCli = 'kiro-cli',
  Antigravity = 'antigravity',
  Lingma = 'lingma',
  LingmaVscode = 'lingma-vscode',
  Wukong = 'wukong',

  // 命令行或 session 文件型 Agent。
  GeminiCli = 'gemini-cli',
  YkCli = 'ykcli',
  QwenCodeCli = 'qwen-code-cli',
  KimiCodeCli = 'kimi-code-cli',
  CodexSession = 'codex-session',
  QoderCli = 'qoder-cli',
  CursorCli = 'cursor-cli',
  PiCodingAgent = 'pi-coding-agent',

  // 通过 Hook/插件产生结构化事件的 Agent。
  ClaudeCliHook = 'claude-code',
  IflowCliHook = 'iflow-cli-hook',
  CursorHook = 'cursor-hook',
  QoderCliHook = 'qoder-cli-hook',
  QoderIdeaHook = 'qoder-idea-hook',
  QoderCnHook = 'qoder-cn-hook',

  CodexCliHook = 'codex',
  ClineHook = 'cline-hook',
  GithubCopilotHook = 'github-copilot-hook',
  AoneCopilotHook = 'aone-copilot-hook',
  OpenCode = 'opencode',

}

/** Agent 产品的交互形态，供发现和展示层分类。 */
export enum ToolType {
  IDE = 'ide',
  CLI = 'cli',
  Hook = 'hook',
  Plugin = 'plugin',
}

/** Input 从源 Agent 获取数据的方式。 */
export enum CollectionMethod {
  /** 周期读取 IDE 本地 DiskKV/history 快照。 */
  IdeSnapshotPolling = 'ide-snapshot-polling',
  /** 增量查询本地 SQLite 数据库。 */
  SqlitePolling = 'sqlite-polling',
  /** 注入 Hook 产生日志，再增量读取 JSONL。 */
  HookJsonl = 'hook-jsonl',
  /** 配置工具把 telemetry 写文件，再轮询转发。 */
  CliTelemetryForwarding = 'cli-telemetry-forwarding',
  /** 读取 Agent 的 session JSON/JSONL 文件。 */
  SessionFilePolling = 'session-file-polling',
  /** 通过 HTTP 调用工具的 Language Server API。 */
  LsHttpApi = 'ls-http-api',
  /** 通过本地 CLI API 轮询，例如 Wukong。 */
  CliApiPolling = 'cli-api-polling',
}
