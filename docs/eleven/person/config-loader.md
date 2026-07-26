# config-loader.ts 逻辑梳理

> 对应源码: `src/core/config-loader.ts`  
> 最后梳理: 2026-06-16

## 职责

`config-loader.ts` 负责把环境变量、用户配置文件、内置配置文件和代码默认值合并成运行时使用的配置对象。主入口是 `loadConfig()`，返回 `AnalyticsConfig`；此外还导出 `buildOtlpTraceConfig()` 和 `buildAutoUpdateConfig()` 供 trace flusher 和 updater 单独构建派生配置。

## 配置来源与优先级

通用优先级是:

1. 环境变量
2. 配置文件 `~/.loongsuite-pilot/config.json`，也可由 `AGENT_DATA_COLLECTION_CONFIG` 指定路径
3. 代码内默认值

`loadConfig()` 会先解析 config 文件路径并读取 `ConfigFile`，再确定 `dataDir`。确定 `dataDir` 后，会额外读取 `${dataDir}/configs/inner/data_config.json`，这个文件主要用于集团版内置 SLS endpoint。

需要注意的例外:

- `LOONGSUITE_PILOT_LOG_RETENTION_DAYS` 是统一保留天数，只填补未在 config 文件中单独设置的分类天数；分类字段如 `retention.hookHistoryDays` 优先级更高。
- `LOONGSUITE_SLS_*` 只在 `config.json` 中存在对象形式的 `sls` 配置时参与合并；数组形式 `sls` 被当作完整多 endpoint 配置，不再套用这些环境变量。
- `buildAutoUpdateConfig()` 不在 `loadConfig()` 返回值中自动挂载，它是 updater 进程按需调用的独立构建函数。

## loadConfig 主流程

1. 解析配置路径: `AGENT_DATA_COLLECTION_CONFIG` 优先，否则使用 `~/.loongsuite-pilot/config.json`。
2. 读取 `config.json`。读取不到时不会报错，而是记录 debug 日志并继续使用环境变量和默认值。
3. 解析 `dataDir`: `LOONGSUITE_PILOT_DATA_DIR` > `file.dataDir` > `~/.loongsuite-pilot`。
4. 读取内部配置: `${dataDir}/configs/inner/data_config.json`。
5. 解析基础字段:
   - `enabled`: 默认 `true`，可由 `LOONGSUITE_PILOT_ENABLED` 或 `file.enabled` 覆盖。
   - `autoStart`: 固定为 `true`。
   - `userId`: `LOONGSUITE_PILOT_USER_ID` > `file.userId` > 兼容字段 `file["user.id"]` > `os.hostname()`。
   - `collectLog`: 默认 `true`。
   - `collectTrace`: 默认 `true`。
   - `serviceNamePrefix`: 默认 `loongsuite-pilot`。
6. 调用各 `build*Config()` 组装子配置，包括 CMS、OTLP raw、listeners、flushers、retention、agents、mask、hook watchdog、file collection、status bar。

## 子配置构建逻辑

### CMS

`buildCmsConfig()` 合并 `LOONGSUITE_PILOT_CMS_LICENSE_KEY`、`LOONGSUITE_PILOT_CMS_ENDPOINT`、`LOONGSUITE_PILOT_CMS_WORKSPACE` 和 `config.cms`。`cms.enabled` 只取决于 `licenseKey` 是否存在；只有 endpoint 但没有 license key 时不会启用 CMS。

### OTLP Trace

`loadConfig()` 只把 `config.otlpTrace` 原样复制到 `AnalyticsConfig.otlpTrace`。真正的 trace flusher 配置由 `buildOtlpTraceConfig(config)` 生成:

- `collectTrace=false` 时直接返回 `undefined`。
- 存在 `LOONGSUITE_PILOT_OTLP_ENDPOINT` 或 `config.otlpTrace.endpoint` 时走新 OTLP 路径。
- 新 OTLP 路径会透传 headers、resourceAttributes、serviceName、debug、turnIdleTimeoutMs 等字段。
- `LOONGSUITE_PILOT_OTLP_HEADERS` 可以用 JSON 字符串覆盖文件中的 headers；JSON 解析失败时只忽略这个 env headers。
- 没有新 OTLP endpoint 时尝试走 legacy CMS 路径，从 `cms.endpoint`、`cms.licenseKey`、`cms.workspace` 组装 ARMS headers。
- `captureMessageContent` 优先使用 `otlpTrace.captureMessageContent`，否则根据 `agents` 中是否存在任一 agent 显式关闭内容采集来决定。

### Agents

`buildAgentsConfig()` 读取 `config.agents`。每个 agent 只保留:

- `enabled`
- `captureMessageContent`

`captureMessageContent` 支持 boolean 和字符串 `"true"` / `"false"`。非法字符串或缺省值都会回退为 `true`，保持旧配置默认采集消息内容的行为。空 `agents` 对象表示不做 agent 级门控。

### Mask

`buildMaskConfig()` 支持三种模式:

- `none`: 不启用脱敏，默认值。
- `all`: 启用所有支持的脱敏类型，忽略 `types`。
- `custom`: 只启用 `types` 中支持的类型。

支持的类型目前是 `cloudAccessKey`、`apiKey`、`privateKey`、`databaseUrl`。`LOONGSUITE_PILOT_MASK_TYPES` 使用逗号分隔字符串，`config.mask.types` 使用数组；不支持的类型会被过滤掉。非法 mode 会回退到 `none`。

### Listeners

`buildListenersConfig()` 先生成完整默认表，当前默认启用:

- `qoder`
- `qoder-sqlite`
- `qoder-work`
- `qoder-work-log`
- `qoder-work-sqlite`
- `qoder-cli-hook`
- `qoder-cli-session`
- `cursor-hook`
- `claude-code-log`
- `codex-log`

默认轮询间隔是 30 秒。`config.listeners` 可以覆盖任意 listener 的 `enabled` 和 `pollInterval`，也可以携带未知 listener key。`QODER_ANALYTICS_POLL_INTERVAL` 只覆盖 `qoder`、`qoder-sqlite`、`qoder-cli-session` 三个历史 Qoder 监听器。

### Retention

`buildRetentionConfig()` 默认启用日志保留，清理周期默认 6 小时。各分类默认保留 7 天:

- `hookHistoryDays`
- `hookErrorDays`
- `hookDebugDays`
- `outputDays`
- `slsFailedDays`

优先级细节是: 单个分类的 config 文件值 > `LOONGSUITE_PILOT_LOG_RETENTION_DAYS` > 默认 7 天。`enabled` 和 `intervalMs` 则分别由 `LOONGSUITE_PILOT_LOG_RETENTION_ENABLED`、`LOONGSUITE_PILOT_LOG_RETENTION_INTERVAL_MS` 覆盖。

### Hook Watchdog

`buildHookWatchdogConfig()` 默认启用 watchdog:

- `intervalMs`: 默认 5 分钟。
- `repairCooldownMs`: 默认 10 分钟。

环境变量 `LOONGSUITE_PILOT_HOOK_WATCHDOG_ENABLED`、`LOONGSUITE_PILOT_HOOK_WATCHDOG_INTERVAL_MS`、`LOONGSUITE_PILOT_HOOK_WATCHDOG_COOLDOWN_MS` 可覆盖对应字段。

### File Collection

`buildFileCollectionConfig()` 默认关闭文件采集。可通过 `config.fileCollection.enabled` 或 `LOONGSUITE_PILOT_FILE_COLLECTION_ENABLED` 开关。

### Status Bar

`buildStatusBarConfig()` 默认启用状态栏应用。`config.enableStatusBarApp` 支持 boolean 和 string，其中字符串 `"false"` 和 `"0"` 表示关闭。环境变量 `LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP` 使用统一的 `envBool()` 解析规则，即 `"false"` 和 `"0"` 为 false，其他已定义值为 true。

固定间隔:

- `metricsSummaryIntervalMs`: 60 秒。
- `runtimeRefreshIntervalMs`: 30 秒。

## Flushers

`buildFlushersConfig()` 同时构建 `sls`、`jsonl`、`http` 三类输出配置。

### JSONL

`buildJsonlConfig()` 默认启用本地 JSONL 输出。默认目录是 `${dataDir}/logs/output`，会经过 `resolveHome()` 展开。可用 `JSONL_ENABLED` 和 `JSONL_OUTPUT_DIR` 覆盖。

默认滚动策略:

- `rotateDaily`: `true`
- `maxFileSizeMb`: `100`

### HTTP

`buildHttpConfig()` 读取 `HTTP_REPORT_URL` 或 `config.http.url`。启用规则:

- 如果定义了 `HTTP_REPORT_URL`，则 URL 非空就启用，URL 为空就关闭。
- 如果没有定义 `HTTP_REPORT_URL`，则使用 `config.http.enabled`；缺省时由 URL 是否非空决定。

`HTTP_REPORT_HEADERS` 支持 JSON 字符串。解析失败时忽略 headers，不阻塞启动。

默认发送参数:

- `batchMaxSize`: `20`
- `flushIntervalMs`: `5000`
- `requestTimeoutMs`: `10000`

### SLS

SLS 是最复杂的输出配置，支持单 endpoint、数组多 endpoint，以及内部配置合并。

#### config.sls 对象形式

对象形式是 legacy/user destination 配置:

```json
{
  "sls": {
    "endpoint": "https://cn-shanghai.log.aliyuncs.com",
    "project": "user-project",
    "logstore": "user-logstore",
    "mode": "webtracking"
  }
}
```

此时 `LOONGSUITE_SLS_MODE`、`LOONGSUITE_SLS_ACCESS_KEY_ID`、`LOONGSUITE_SLS_ACCESS_KEY_SECRET`、`LOONGSUITE_SLS_ENDPOINT`、`LOONGSUITE_SLS_PROJECT`、`LOONGSUITE_SLS_LOGSTORE` 可以逐项覆盖文件值。

只有同时存在 `project` 和 `logstore` 时才会创建 `user-sls` endpoint。`endpoint` 缺失时仍会生成 endpoint 对象，但最终 `enabled` 推导会因为 endpoint 为空而关闭 SLS。

`destinationOverride` 是废弃字段，当前只记录 warning，不参与逻辑。

#### config.sls 数组形式

数组形式用于多 endpoint:

```json
{
  "sls": [
    {
      "name": "user-sls",
      "endpoint": "https://cn-hangzhou.log.aliyuncs.com",
      "project": "user-proj",
      "logstore": "user-store"
    },
    {
      "name": "internal-sls",
      "endpoint": "https://cn-heyuan.log.aliyuncs.com",
      "project": "ai-coding-devops",
      "logstore": "loongsuite_pilot_for_ai_coding"
    }
  ]
}
```

数组中的每项直接转换为 `SlsEndpoint`。没有 `name` 时使用 `sls-<index>`。没有 scheme 的 endpoint 会补 `https://`。没有显式 `mode` 但存在 AK/SK 时推导为 `ak`，否则默认 `webtracking`。

数组形式不会应用 `LOONGSUITE_SLS_*` 覆盖。

#### inner data_config.json 合并

如果 `${dataDir}/configs/inner/data_config.json` 存在 `sls` 数组，会在用户配置之后追加。追加前会过滤掉缺少 `endpoint` 或 `logstore` 的内置项。

最终会按 `normalizeEndpointUrl(endpoint)|project|logstore` 去重:

- endpoint 去重时会补 `https://`、去掉末尾 `/`、把 scheme 和 host 转小写。
- 去重保留第一次出现的 endpoint。
- 因为用户配置先加入，内部配置后加入，所以同一目的地冲突时用户配置优先。

#### SLS enabled 推导

如果对象形式的 `config.sls.enabled` 明确存在，则直接使用这个值。否则按 endpoints 推导:

- endpoints 为空时关闭。
- 每个 endpoint 都必须有 `endpoint` 和 `logstore`。
- `webtracking` 允许 `project` 为空。
- `ak` 必须有 `project`、`accessKeyId`、`accessKeySecret`。

顶层 `mode`、`endpoint`、`accessKeyId`、`accessKeySecret` 会镜像第一个 endpoint，主要服务旧调用方；新逻辑应优先读取 `endpoints` 数组。

## AutoUpdate

`buildAutoUpdateConfig(file)` 从 env 和 config 文件构建 updater 配置:

- `packageUrl`: `LOONGSUITE_PILOT_PACKAGE_URL` > `file.autoUpdate.packageUrl`
- `manifestUrl`: `LOONGSUITE_PILOT_MANIFEST_URL` > `file.autoUpdate.manifestUrl`
- 如果只有 `packageUrl`，会推导同目录的 `latest.json` 作为 manifest。
- 必须有 `packageUrl` 才可能启用自动更新，即使 `enabled=true` 也不能绕过。
- `checkIntervalMs` 默认 60 秒。
- `installId`、`canary.policy`、`canary.hotfix_version` 从 config 文件透传给 updater。

## 布尔和数字解析规则

`envBool()` 的规则是:

- 未定义: 使用 fallback。
- 字符串 `"false"` 或 `"0"`: false。
- 其他已定义值: true。

`envInt()` 的规则是:

- 未定义: 使用 fallback。
- 可解析为有限数字: 使用解析值。
- 非数字或无限值: 使用 fallback。

`parseOptionalBool()` 只用于部分 config 文件字段，规则更严格:

- boolean 原样返回。
- 字符串 `"true"` 返回 true。
- 字符串 `"false"` 返回 false。
- 其他值返回 undefined，由调用方决定默认值。

## 相关测试

当前主要测试在:

- `tests/unit/core/config-loader.test.ts`
- `tests/unit/core/config-loader.sls-resolution.test.ts`

覆盖重点包括三层优先级、缺省值、SLS endpoint 解析与去重、inner data_config 合并、retention、agents、mask、file collection、CMS/OTLP fallback 等行为。
