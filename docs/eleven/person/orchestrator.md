# orchestrator.ts 逻辑梳理

> 对应源码: `src/core/orchestrator.ts`  
> 最后梳理: 2026-06-16

## 职责

`orchestrator.ts` 是 loongsuite-pilot 运行时的顶层编排入口。它不直接采集、归一化或发送具体数据，而是把配置、状态、部署、输入源、输出通道、日志保留、监控指标、告警、文件采集和状态栏能力按固定顺序组装起来。

主类是 `Orchestrator`，继承 `EventEmitter`，对外提供 `start()` / `stop()` 生命周期，并暴露 `InputManager`、`AgentControlManager`、`AgentDiscoveryService`、`DeploymentManager`、`AlarmManager` 等内部管理器的 getter。

## 核心对象

- `config`: 已由 `config-loader.ts` 合并好的运行时配置。
- `dataDir`: 运行数据目录，默认 `~/.loongsuite-pilot`。
- `StateStore`: 保存各输入源的增量读取偏移。
- `AgentControlManager`: 读取 `agent-control.json`，提供 on/off/auto 准入控制。
- `InputManager`: 注册输入源，接收 entries，应用 userId、内容策略、脱敏后交给 flusher。
- `DeploymentManager`: 根据 `agents.d/*.json` 部署 hook 或 plugin-probe 能力。
- `AgentDiscoveryService`: 通过 watch + polling 判断输入源是否可用，并触发 start/stop。
- `MultiFlusher` / `BaseFlusher`: 承接 SLS、JSONL、HTTP、OTLP trace 等输出。
- `HookWatchdog`: 定期检查 hook 是否被外部工具覆盖，必要时重新部署。
- `MetricsWriter` / `AlarmManager`: 周期写入运行指标和告警，并通过 sender 上报。
- `FileCollectionManager`: 独立文件采集管道，默认关闭。
- `RuntimeWriter` / `MetricsSummaryWriter` / `StatusBarAppManager`: 状态栏 App 支撑能力。

## start() 启动流程

`start()` 是最重要的主流程。成功启动后的状态是: 所有管理器初始化完毕，已注册输入源由 discovery 管理生命周期，输出和监控管道处于运行状态。

1. 防重复启动  
   如果 `isRunning` 已经是 `true`，只记录 warning 并返回。

2. 准备数据目录  
   创建 `dataDir` 和 `${dataDir}/logs`。后续状态文件、hook 输出、metrics、JSONL fallback 都依赖这些目录。

3. 加载状态与准入配置  
   `StateStore` 读取 `${dataDir}/logs/input-state.json`；`AgentControlManager` 读取 `${dataDir}/agent-control.json`。前者用于输入源断点续读，后者用于运行时关闭或强制启用某类 agent。

4. 构建输出通道  
   调用 `buildFlusher()`。它按配置启动 SLS、JSONL、HTTP，并按需创建 OTLP trace flusher。没有任何输出启用时，会自动回退到本地 JSONL，保证 entries 不会因为无输出通道而直接丢失。

5. 初始化告警与 InputManager  
   读取安装版本并解析本机 IP，创建 `AlarmManager`。随后创建 `InputManager`，注入 flusher、配置 userId、agent 内容采集策略、告警管理器和脱敏配置。

6. 部署采集能力  
   `resolvePilotDir()` 解析当前安装目录后创建 `DeploymentManager`，再调用 `deployAll()`。该阶段负责按 `agents.d` 声明部署 hook 或 plugin-probe。部署按 agent 粒度 best-effort，单个 agent 失败不会阻断整体启动。

7. 注册所有内置输入源  
   `registerAllInputs()` 实例化各输入类并注册到 `InputManager`，同时为每个输入源构造 `AgentDetectionEntry`。这些 entry 描述检测路径、可用性判断、启用条件、start/stop 回调和轮询间隔。

8. 构建动态部署检测 entry  
   `buildDeployDetectionEntries()` 会为 `agents.d` 中的声明额外生成 `deploy:<agentId>` entry。它们不采集数据，只负责在运行期发现新安装的 agent 时触发 `deploymentManager.deploySingle(def)`。

9. 启动 AgentDiscoveryService  
   discovery 同时接收输入源检测 entry 和动态部署检测 entry。启动时先为 watchPaths 建立 `fs.watch`，失败则降级 polling，然后立即执行一次 refresh。可用且启用的输入源会被启动；不可用或被禁用的运行中输入源会被停止。

10. 启动日志保留服务  
    `LogRetentionService` 按 retention 配置定期清理 hook history、hook error、hook debug、output、SLS failed 等过期日志。

11. 启动 HookWatchdog  
    watchdog 合并默认目标和 `agents.d` 中 hook 模式目标。它通过目标 settings、expected hooks 和 marker 判断 hook 是否仍存在，缺失时调用 `deploySingle()` 修复。

12. 启动独立文件采集  
    只有 `config.fileCollection.enabled` 为 `true` 时才启动。该管道读取 `${dataDir}/configs/local` 下的文件采集配置，状态写到 `${dataDir}/state/file-collection`，失败日志写到 `${dataDir}/logs/file-collection-failed`。

13. 启动指标与告警写入  
    如果存在 SLS flusher，会把 `AlarmManager` 注入进去。`MetricsWriter` 通过 `buildDataflowSnapshot()` 定期收集输入、输出、告警和资源指标，写本地 JSONL 并调用 sender 上报。

14. 启动状态栏支持  
    当 `config.statusBar.enabled` 为 `true` 时，写入 `runtime.json` 和 metrics summary。macOS 下还会尝试启动或同步原生状态栏 App；失败只记录 warning，不阻断主流程。

15. 标记运行中  
    设置 `isRunning = true`，发出 `started` 事件，并记录输入检测 entry 数量。

## stop() 停止流程

`stop()` 按“外围服务先停、采集和输出后停”的顺序释放资源:

1. 停止文件采集、metrics、状态栏 App、summary/runtime writer。
2. 停止 HookWatchdog 和 LogRetentionService。
3. 停止 AgentDiscoveryService，关闭 watcher/poll timer，并停止运行中的 entry。
4. 调用 `inputManager.stopAll()` 停止所有输入。
5. 调用 `flusher.shutdown()` 刷新并关闭输出通道。
6. 保存 `StateStore`，持久化输入源偏移。
7. 设置 `isRunning = false`，发出 `stopped` 事件。

## 输出通道 buildFlusher()

`buildFlusher()` 根据 `config.flushers` 生成输出实例:

- SLS: 需要 `cfg.sls.enabled` 且 `collectLog !== false`。
- JSONL: 需要 `cfg.jsonl.enabled`。
- HTTP: 需要 `cfg.http.enabled`。
- OTLP trace: 由 `buildOtlpTraceConfig(config)` 派生，且通过动态 import 加载。

SLS、JSONL、HTTP 的 `start()` 失败会被捕获并记录 warning，但对象仍会加入输出列表。OTLP trace flusher 如果模块不可用会跳过。最终如果只有一个 flusher，直接返回该实例；多个则包装成 `MultiFlusher`。

## 部署与发现

`DeploymentManager.deployAll()` 是当前主路径上的部署入口。它读取内置和本地 `agents.d` 声明，并根据声明选择 hook 或 plugin-probe 策略。

`buildDeployDetectionEntries()` 解决的是“启动时 agent 不存在，运行过程中后来安装了 agent”的场景。它为每个有 detection paths 的声明生成一个 `deploy:<agentId>` entry:

- `watchPaths`: 来自 agent definition 的 detection paths。
- `isAvailable`: 调用 `detectAgent(def.detection)`。
- `enabled`: 只看 `config.agents` 的 agent 级门控。
- `start`: 触发 `deploymentManager.deploySingle(def)`。
- `stop`: 空操作，因为部署检测 entry 不代表一个运行中的采集输入。

## 输入注册与互斥关系

`registerAllInputs()` 做两件事: 创建输入源实例并注册到 `InputManager`，再为 discovery 返回对应检测 entry。

启用判断通常同时经过两层门控:

1. agent 级门控: `isAgentGatedEnabled(agentId)`，读取 `config.agents[agentId].enabled`。
2. listener 级门控: `agentControlManager.resolveEnabled(listenerId, config.listeners[listenerId]?.enabled ?? default)`。

几个 trace 聚合输入会压制旧输入，避免同一个 agent 的数据被重复采集:

| trace 输入 | 被压制输入 |
|------------|------------|
| `qoder-trace` | `qoder-sqlite`、`qoder-cli-hook`、`qoder-cli-session` |
| `qoder-cn-trace` | `qoder-cn-sqlite`、`qoder-cn` |
| `qoder-work-trace` | `qoder-work`、`qoder-work-log`、`qoder-work-sqlite` |
| `qoder-work-cn-trace` | `qoder-work-cn-hook`、`qoder-work-cn-log`、`qoder-work-cn-sqlite` |

已注册的输入包括:

- Qoder: SQLite、trace、CLI hook、CLI session。
- Qoder CN: SQLite、IDE snapshot、trace。
- Qoder Work: trace、hook JSONL、SDK log、SQLite。
- Qoder Work CN: trace、hook JSONL、SDK log、SQLite。
- Cursor: hook JSONL。
- Claude Code: OTel plugin JSONL。
- Codex: OTel plugin JSONL。
- Wukong: CLI API polling。

## 路径解析

- `resolvePilotDir()` 优先读取 `${dataDir}/current` 指针，定位 `${dataDir}/versions/<versionName>`；否则兼容旧布局 `${dataDir}/package`；再否则回退到 `dataDir`。
- `readPackageVersion()` 从 `resolvePilotDir()/VERSION` 中读取 `version=<value>`，失败返回 `unknown`。
- `resolveCodexLogDir()` 读取 `~/.codex/otel-config.json` 的 `log_dir`，失败或不存在时回退 `${dataDir}/logs/codex`。
- `resolveClaudeCodeLogDir()` 读取 `~/.claude/otel-config.json` 的 `log_dir`，失败或不存在时回退 `${dataDir}/logs/claude-code`。

## 指标快照 buildDataflowSnapshot()

`buildDataflowSnapshot()` 是 `MetricsWriter` 的数据来源。它从 `InputManager` 和 SLS flusher 聚合出:

- 输入总发送条数 `sendEntriesTotal`。
- 输入总接收字节 `receivedBytesTotal`。
- 已注册输入数和当前运行输入数。
- 每个输入的计数器、类型、最后轮询时间、启动时间和空闲分钟数。
- SLS endpoint 维度的 flusher 计数器。
- 聚合后的 flusher runner 总计数器。
- 输入源探测到的 agent 版本。

当前只细分 SLS flusher endpoint 计数器；JSONL、HTTP、OTLP trace 没有在这里展开成 endpoint 级指标。

## 维护注意事项

- 新增输入源时，需要同时补充输入类、注册逻辑、`LISTENER_AGENT_MAP` 映射、listener 默认配置和测试。
- 新增 agent 声明式部署时，优先通过 `agents.d` + `DeploymentManager` 接入，而不是扩展旧的 `installHooks()` 主路径。
- trace 聚合输入如果会覆盖旧输入，必须在 `enabled` 闭包里显式互斥，避免重复采集。
- flusher 构建需要保持 fallback JSONL 语义，避免配置错误导致无输出通道。
- `AgentDiscoveryService` 只消费 `AgentDetectionEntry`，不要让它直接依赖具体 input 或 deployment 类。
- `stop()` 需要保存 `StateStore`，否则下次启动可能重复读取历史数据。
