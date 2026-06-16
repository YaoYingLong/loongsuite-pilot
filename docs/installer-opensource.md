# installer-opensource.sh 逻辑说明

> Last verified: 2026-06-15  
> 脚本路径: `deploy/installer-opensource.sh`

本文档整理开源版安装脚本的当前实现逻辑，侧重说明入口参数、执行流程、文件副作用、回滚与卸载行为。本文只描述脚本现状，不代表推荐设计。

## 1. 脚本定位

`installer-opensource.sh` 是 LoongSuite Pilot 开源版的一体化安装入口，支持三类命令：

| 命令 | 作用 |
|------|------|
| `install` | 首次安装或重新安装，下载/解压包、部署版本目录、写配置、安装 CLI、启动服务 |
| `upgrade` | 升级已有安装，保留配置，部署新版本并在启动失败时回滚 |
| `uninstall` | 停止服务、删除运行时目录和 CLI、清理 hook 配置与 Claude/Codex OTel 插件 |

命令省略时默认执行 `install`。如果第一个参数是 option（如 `--version`），也会按 `install` 处理。

## 2. 全局常量与默认路径

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PACKAGE_NAME` | `loongsuite-pilot` | 包名和默认解压目录名 |
| `PERMANENT_DIR` | `$HOME/.loongsuite-pilot/package` | 无 `VERSION` 元信息时的传统安装目录；部署到版本化目录后会被重设 |
| `DEFAULT_DATA_DIR` | `$HOME/.loongsuite-pilot` | 默认数据目录 |
| `_OSS_BASE_URL` | `https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot` | 默认 OSS 下载根路径 |

版本化安装使用固定目录布局：

```text
~/.loongsuite-pilot/
├── current
├── previous
├── versions/<version>_<git_commit>/
├── bin/
│   ├── collector-daemon.js
│   └── updater-daemon.js
└── config.json
```

注意：`--data-dir` 只影响配置文件路径、PID 文件路径和写入配置中的 `dataDir`。版本目录、bootstrap、CLI 安装目录仍固定在 `$HOME/.loongsuite-pilot` 和 `$HOME/.local/bin`。

## 3. 参数解析

### 3.1 命令解析

脚本先读取第一个参数：

1. `install` / `upgrade` / `uninstall`：作为命令并 `shift`。
2. 以 `-` 开头：命令默认为 `install`，该参数继续参与 option 解析。
3. 其他值：命令默认为 `install`，随后会在 option 解析中被当作未知参数并退出。
4. 无参数：命令默认为 `install`。

### 3.2 支持参数

| 参数 | 变量 | 说明 |
|------|------|------|
| `--sls-endpoint` | `SLS_ENDPOINT` | SLS endpoint |
| `--sls-project` | `SLS_PROJECT` | SLS project |
| `--sls-logstore` | `SLS_LOGSTORE` | SLS logstore |
| `--sls-ak-id` | `SLS_AK_ID` | SLS AK ID |
| `--sls-ak-secret` | `SLS_AK_SECRET` | SLS AK Secret |
| `--package-url` | `PACKAGE_URL` | 指定安装包 URL，支持脚本所用 `curl/wget` 可下载的地址 |
| `--data-dir` | `DATA_DIR` | 指定配置和数据目录 |
| `--log-level` | `LOG_LEVEL` | 写入 `config.logLevel` |
| `--userId` / `--user.id` | `USER_ID` | 写入 `config.userId` |
| `--lang` | `LOONGSUITE_PILOT_LANG` | 指定输出语言 `zh` / `en` |
| `--version` | `INSTALL_VERSION` | 从 OSS 指定版本目录下载 |
| `--collect-log` | `COLLECT_LOG` | 写入 `config.collectLog` |
| `--collect-trace` | `COLLECT_TRACE` | 写入 `config.collectTrace` |
| `--cms-license-key` | `CMS_LICENSE_KEY` | 写入 `config.cms.licenseKey` |
| `--cms-endpoint` | `CMS_ENDPOINT` | 写入 `config.cms.endpoint` |
| `--cms-workspace` | `CMS_WORKSPACE` | 写入 `config.cms.workspace` |
| `--service-name-prefix` | `SERVICE_NAME_PREFIX` | 写入 `config.serviceNamePrefix` |
| `--agents` | `SELECTED_AGENTS` | 指定启用的 Agent ID 列表，逗号分隔 |
| `--mask-mode` | `MASK_MODE` | 数据脱敏模式：`all` / `custom` / `none` |
| `--mask-types` | `MASK_TYPES` | `custom` 模式下的脱敏类型列表 |
| `--purge` | `PURGE=1` | 卸载时尝试删除数据和插件 session 外内容 |
| `--system-service` | `SYSTEM_SERVICE=1` | Linux 下优先注册系统级服务 |

所有带值参数同时支持 `--key value` 和 `--key=value` 两种形式。未知参数直接退出。

### 3.3 参数校验

脚本只做三类显式校验：

1. `--mask-mode` 必须是 `all`、`custom` 或 `none`。
2. `--mask-mode custom` 时必须提供 `--mask-types`。
3. 提供 `--mask-types` 时，`--mask-mode` 必须为 `custom`。

其他参数不做格式校验，后续写入配置或传给 CLI。

### 3.4 安装包 URL 解析

`PACKAGE_URL` 的优先级：

1. 命令行 `--package-url`。
2. 环境变量 `LOONGSUITE_PILOT_PACKAGE_URL`。
3. 指定 `--version` 时：`$_OSS_BASE_URL/<version>/loongsuite-pilot.tar.gz`。
4. 默认：`$_OSS_BASE_URL/latest/loongsuite-pilot.tar.gz`。

## 4. 语言输出

`detect_lang()` 决定中英文输出：

1. 如果设置了 `LOONGSUITE_PILOT_LANG`，直接使用该值。
2. 检查 `LANGUAGE`、`LC_ALL`、`LC_MESSAGES`、`LANG`，包含 `zh` 时使用中文。
3. macOS 下额外读取 `AppleLanguages`，包含 `zh` 时使用中文。
4. 默认英文。

`msg()` 根据 `LANG_MODE` 输出中文或英文文案。

## 5. 依赖检查与 Node 解析

### 5.1 Node 查找顺序

`resolve_node()` 依次检查：

1. `$HOME/.nvm/versions/node/*/bin/node`，按 glob 结果反向遍历。
2. `$HOME/.volta/bin/node`。
3. `$HOME/.fnm/aliases/default/bin/node`。
4. `/opt/homebrew/bin/node`。
5. `/usr/local/bin/node`。
6. `$HOME/.local/bin/node`。
7. `command -v node`。

候选 Node 必须满足：

- 文件可执行。
- 不位于 macOS `.app/Contents` bundle 内。
- `node --version` 主版本号大于等于 18。

### 5.2 `check_deps()` 行为

`check_deps()` 会执行：

1. 解析可用 Node，不存在则退出。
2. 再次读取 Node 主版本，要求 `>= 18`。
3. 创建 `DATA_DIR`，把 Node 路径写入 `$DATA_DIR/node-bin`。
4. 优先使用同目录 `npm`，不存在时 fallback 到 `command -v npm`。
5. macOS Apple Silicon 上，如果系统是 `arm64` 但 Node 是 `x64`，输出架构不匹配警告。
6. 要求存在 `curl` 或 `wget`。

## 6. Linux 安装用户与服务级别

`validate_install_user()` 只在 Linux 下处理：

| 场景 | 行为 |
|------|------|
| 当前用户是 root | 设置 `HAS_SUDO=1`、`SYSTEM_SERVICE=1`，自动使用系统级服务 |
| 非 root 且指定 `--system-service` | 通过 `sudo -n true` 或 `sudo -v` 校验权限 |
| `--system-service` 校验失败 | 设置 `HAS_SUDO=0`、`SYSTEM_SERVICE=0`，降级为用户级 systemd |
| 非 root 且未指定 `--system-service` | 只打印当前用户，服务类型交给后续 `loongsuite-pilot start` 判断 |

macOS 下该函数没有额外动作。

## 7. 下载与解压

`download_and_extract()` 会：

1. 创建 `TMP_DIR=$(mktemp -d)`，由调用方的 `trap` 在退出时清理。
2. 使用 `curl -fsSL` 或 `wget -q` 下载到 `$TMP_DIR/package.tar.gz`。
3. 先尝试 `tar --warning=no-unknown-keyword -xzf`，失败再用普通 `tar -xzf`。
4. 定位安装源目录 `INSTALL_SRC`：
   - 如果 `$TMP_DIR/loongsuite-pilot` 存在，使用该目录。
   - 否则如果 `$TMP_DIR/package.json` 存在，使用 `$TMP_DIR`。
   - 否则在 `$TMP_DIR` 两层内查找 `package.json`，取第一个所在目录。
5. 找不到 `package.json` 时退出。

## 8. Agent 探测与选择

### 8.1 探测

`probe_agents()` 调用安装包内的：

```bash
$NODE_BIN "$INSTALL_SRC/dist/cli-probe.cjs"
```

输出保存到 `PROBE_RESULT`。探测失败不会中断安装，只会把 `PROBE_RESULT` 置为 `[]`。

### 8.2 选择逻辑

`select_agents()` 的优先级：

1. 如果传入 `--agents`，直接使用该值，不校验 ID 是否存在。
2. 如果探测结果为空，跳过选择。
3. 非交互环境（stdin 不是 TTY）下，自动选择所有 `detected=true` 的 Agent。
4. 交互环境下打印带编号菜单：
   - 默认选择所有检测到的 Agent。
   - 用户直接回车使用默认。
   - 用户输入编号列表后，脚本去重、过滤越界编号，再转换成 Agent ID 列表。

后续 `write_config()` 会根据 `SELECTED_AGENTS` 写入 `config.agents[agent.id].enabled`。

## 9. 交互输入与覆盖确认

### 9.1 `prompt_user_id()`

只有在交互环境且未传 `--userId` 时执行：

1. 如果 `$DATA_DIR/config.json` 已存在，读取其中 `userId`。
2. 有旧值时提示回车保留或输入新值。
3. 无旧值时提示输入 userId，可回车跳过。
4. 输入会删除所有空白字符。

### 9.2 `confirm_config_overwrite()`

当 `$DATA_DIR/config.json` 已存在时，脚本会检查部分关键字段是否会被覆盖。

检查字段：

- `sls.endpoint`
- `sls.project`
- `sls.logstore`
- `cms.licenseKey`
- `cms.endpoint`
- `cms.workspace`
- `serviceNamePrefix`
- `mask.mode`
- `mask.types`

只有“旧值非空、新值非空且两者不同”才会列为差异。`userId`、`logLevel`、`collectLog`、`collectTrace`、`agents` 不在该确认列表内。

交互环境下需要确认 `y/yes` 才继续，否则安装退出。非交互环境下直接继续覆盖。

## 10. 部署安装包

### 10.1 旧布局迁移

`migrate_legacy_layout()` 用于把历史单目录布局迁移到版本化布局：

触发条件：

- `~/.loongsuite-pilot/current` 不存在。
- `~/.loongsuite-pilot/package` 存在。
- `~/.loongsuite-pilot/package/dist/index.js` 存在。

执行行为：

1. 从旧目录 `VERSION` 读取 `version` 和 `git_commit`。
2. 缺失时使用 `0.0.0` 和 `legacy`。
3. 复制旧目录到 `~/.loongsuite-pilot/versions/<version>_<git_commit>`。
4. 写入 `~/.loongsuite-pilot/current`。
5. 将当前进程内的 `PERMANENT_DIR` 指向迁移后的版本目录。

该迁移只复制旧目录，不删除 `~/.loongsuite-pilot/package`。

### 10.2 版本化部署

`deploy_package()` 接收 `INSTALL_SRC`：

1. 如果安装源包含 `VERSION`，并且其中有 `version=` 和 `git_commit=`：
   - 目标目录为 `~/.loongsuite-pilot/versions/<version>_<git_commit>`。
   - 如果 `current` 指向其他目录，则把旧 current 写入 `previous`。
   - 删除同名目标目录后重新复制安装源。
   - 用 `current.tmp` + `mv` 原子更新 `current`。
   - 把 `PERMANENT_DIR` 改为新目标目录。
2. 如果没有完整版本元信息：
   - 删除并重建 `$HOME/.loongsuite-pilot/package`。
   - `PERMANENT_DIR` 保持传统安装目录。

### 10.3 部署后动作

部署目录完成后继续执行：

1. `deploy_bootstrap_scripts()`：
   - 从 `$PERMANENT_DIR/scripts` 复制 `collector-daemon.js` 到 `~/.loongsuite-pilot/bin/`。
   - 如果存在 `updater-daemon.js`，也复制过去。
2. 在 `$PERMANENT_DIR` 执行：

```bash
npm install --production --no-optional
```

脚本只显示该命令输出的最后一行。

3. 如果当前目录下存在 `scripts/postinstall.js`，用 `$NODE_BIN scripts/postinstall.js` 执行，用于部署 hook 脚本等运行时资源。

## 11. 配置写入逻辑

`write_config()` 目标文件为 `$DATA_DIR/config.json`。写入由内嵌 Node 脚本完成。

### 11.1 基础合并

1. 尝试读取旧配置，失败则使用空对象。
2. 新配置以旧配置为基础展开。
3. 强制设置：
   - `enabled: true`
   - `dataDir: <DATA_DIR>`
4. 删除 `internal`。
5. 如果存在旧字段 `user.id` 且没有 `userId`，迁移到 `userId`。
6. 删除 `user.id`。

### 11.2 SLS 配置

只有传入 `--sls-endpoint`、`--sls-project`、`--sls-logstore` 任一项时，才进入 SLS 更新分支。

进入分支后：

- 确保 `config.sls` 存在。
- 删除 `config.sls.destinationOverride`。
- 有 `--sls-endpoint` 时设置 `config.sls.endpoint`。
- 同时存在 `--sls-ak-id` 和 `--sls-ak-secret` 时：
  - 设置 `config.sls.mode = "ak"`。
  - 写入 `accessKeyId` 和 `accessKeySecret`。
- 同时存在 `--sls-project` 和 `--sls-logstore` 时：
  - 设置 `project` 和 `logstore`。
  - 删除 `config.sls.endpoints`。

注意：如果只传 AK ID/Secret，而没有传 endpoint/project/logstore 任一项，当前脚本不会进入 SLS 分支，也不会写入 AK。

### 11.3 其他配置

| 输入 | 写入行为 |
|------|----------|
| `--log-level` | `config.logLevel = <value>` |
| `--userId` / 交互输入 | `config.userId = <value>`，并删除 `config.identity` |
| `--collect-log true/false` | `config.collectLog = value === "true"` |
| `--collect-trace true/false` | `config.collectTrace = value === "true"` |
| CMS 任一参数 | 确保 `config.cms` 存在，并分别写入 licenseKey / endpoint / workspace |
| `--service-name-prefix` | `config.serviceNamePrefix = <value>` |
| `--mask-mode` | 确保 `config.mask` 存在，写入 `config.mask.mode` |
| `--mask-mode custom --mask-types a,b` | `config.mask.types = ["a", "b"]` |
| `--mask-mode all/none` | 删除 `config.mask.types` |
| `--agents` 或选择结果 | 对探测结果里的每个 Agent 写入 `config.agents[id].enabled` |

配置文件最终以 `JSON.stringify(config, null, 2) + "\n"` 写回。

## 12. CLI 安装逻辑

`install_loongsuite_pilot_command()` 会：

1. 创建 `$HOME/.local/bin`。
2. 复制 `$PERMANENT_DIR/scripts/loongsuite-pilot.sh` 到 `$HOME/.local/bin/loongsuite-pilot`。
3. 设置可执行权限。
4. 如果 `/usr/local/bin` 存在且可写，创建或更新 `/usr/local/bin/loongsuite-pilot` 软链接。
5. 否则按当前 `SHELL` 修改 shell rc 文件，添加：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

rc 文件选择：

| Shell | 修改文件 |
|-------|----------|
| zsh | `~/.zshrc` |
| bash | `~/.bashrc` 和 `~/.bash_profile` |
| 其他 | `~/.bashrc` |

如果目标 rc 文件已包含 `.local/bin`，不会重复追加。脚本最后会把 `$HOME/.local/bin` 加入当前进程 `PATH`。

## 13. install 主流程

`cmd_install()` 执行顺序：

```text
validate_install_user
check_deps
migrate_legacy_layout
get_installed_version 并提示重新安装
按 PID 文件停止运行中的旧服务
download_and_extract
probe_agents
select_agents
prompt_user_id
confirm_config_overwrite
deploy_package
write_config
install_loongsuite_pilot_command
loongsuite-pilot start [--system-service]
loongsuite-pilot status 检查启动状态
print_summary
```

### 13.1 重新安装前停止服务

安装流程只检查 `$DATA_DIR/loongsuite-pilot.pid`：

1. PID 文件存在且进程存活时，发送普通 `kill`。
2. 最多等待 10 秒。
3. 仍存活则 `kill -9`。
4. 删除 PID 文件。

该步骤没有调用 `loongsuite-pilot stop`，因此服务管理器状态主要依赖后续 `loongsuite-pilot start` 覆盖。

### 13.2 启动服务

安装完成后执行：

```bash
loongsuite-pilot start
```

如果 Linux 用户校验阶段确定 `SYSTEM_SERVICE=1`，则执行：

```bash
loongsuite-pilot start --system-service
```

启动后等待 2 秒，执行 `loongsuite-pilot status`。输出包含 `is running` 时认为启动成功，否则提示用户手动检查。

## 14. upgrade 主流程

`cmd_upgrade()` 执行顺序：

```text
validate_install_user
migrate_legacy_layout
get_installed_version，未安装则退出
check_deps
download_and_extract
读取新版本 version/git_commit
读取旧版本 commit
如果版本和 commit 相同则退出
loongsuite-pilot stop
deploy_package
install_loongsuite_pilot_command
loongsuite-pilot start
loongsuite-pilot status 检查启动
启动成功则 gc_old_versions 并 print_summary
启动失败则 stop + rollback + exit 1
```

### 14.1 已是最新判断

脚本比较：

- 新包 `VERSION` 中的 `version`。
- 新包 `VERSION` 中的 `git_commit`。
- 当前已安装版本号。
- `get_commit_from_dir "$PERMANENT_DIR"` 读取到的旧 commit。

如果新旧版本号和 commit 都相同，直接退出。

注意：进程启动时 `PERMANENT_DIR` 默认是 `$HOME/.loongsuite-pilot/package`。在已有版本化安装且没有执行旧布局迁移的情况下，旧 commit 可能不会从 `current` 指向的版本目录读取。

### 14.2 升级停止与启动

升级前停止服务的优先级：

1. `command -v loongsuite-pilot` 存在时，执行 `loongsuite-pilot stop`。
2. 否则如果 `$HOME/.local/bin/loongsuite-pilot` 存在，执行该路径的 `stop`。
3. 两者都不存在时不做额外停止。

部署后执行 `loongsuite-pilot start`，升级流程当前不会把 `--system-service` 透传给 start。

### 14.3 自动回滚

新版本启动失败时：

1. 执行 `loongsuite-pilot stop`。
2. 执行 `loongsuite-pilot rollback`。
3. 输出升级失败和日志提示。
4. 以状态码 1 退出。

回滚依赖 CLI 内部实现以及 `current` / `previous` 指针。

### 14.4 旧版本清理

`gc_old_versions()` 在升级成功后运行：

1. 读取 `~/.loongsuite-pilot/current` 和 `previous`。
2. 遍历 `~/.loongsuite-pilot/versions/*/`。
3. 删除既不是 current 也不是 previous 的版本目录。

## 15. uninstall 主流程

`cmd_uninstall()` 执行顺序：

```text
停止服务
删除 $HOME/.loongsuite-pilot
删除 loongsuite-pilot 命令和 /usr/local/bin 软链接
remove_hook_configs
remove_otel_plugin
如果 --purge 则删除 DATA_DIR，否则提示保留
输出卸载完成
```

### 15.1 停止服务

停止优先级：

1. 如果 `loongsuite-pilot` 在 `PATH` 中，执行 `loongsuite-pilot stop`。
2. 否则如果 `$HOME/.local/bin/loongsuite-pilot` 存在，执行该路径的 `stop`。
3. 否则进入手动清理：
   - 按 `$DATA_DIR/loongsuite-pilot.pid` 尝试杀进程。
   - macOS：卸载并删除 `~/Library/LaunchAgents/com.loongsuite-pilot.plist` 和 updater plist。
   - Linux：清理用户级 systemd unit、系统级 systemd unit、init.d 脚本。

Linux 系统级 unit 名按当前 `whoami` 生成：

```text
/etc/systemd/system/loongsuite-pilot-<user>.service
/etc/systemd/system/loongsuite-pilot-updater-<user>.service
/etc/init.d/loongsuite-pilot-<user>
/etc/init.d/loongsuite-pilot-updater-<user>
```

系统级清理使用 `sudo`，失败会被忽略。

### 15.2 安装目录与数据目录删除

脚本无条件执行：

```bash
rm -rf "$HOME/.loongsuite-pilot"
```

随后如果传入 `--purge`，再执行：

```bash
rm -rf "$DATA_DIR"
```

当前默认 `DATA_DIR` 也是 `$HOME/.loongsuite-pilot`。因此在默认配置下，即使未传 `--purge`，配置和日志所在目录也会随着 `$HOME/.loongsuite-pilot` 被删除；脚本仍会打印“数据目录已保留”的提示。只有自定义 `--data-dir` 且该目录不在 `$HOME/.loongsuite-pilot` 下时，未传 `--purge` 才会保留该自定义数据目录。

### 15.3 CLI 删除

卸载会删除：

```text
$HOME/.local/bin/loongsuite-pilot
/usr/local/bin/loongsuite-pilot
```

删除 `/usr/local/bin/loongsuite-pilot` 的失败会被忽略。

## 16. Hook 配置清理

`remove_hook_configs()` 处理以下配置文件：

```text
~/.cursor/hooks.json
~/.qoder/settings.json
~/.qoderwork/settings.json
~/.claude/settings.json
~/.codex/hooks.json
```

清理规则：

1. 使用 Node 读取 JSON。
2. 查找顶层 `hooks` 对象。
3. 遍历每个 event 的 entries 数组。
4. 删除 command 中包含 `.loongsuite-pilot` 的 entry。
5. 对 nested 格式，也会检查 `entry.hooks[].command` 是否包含 `.loongsuite-pilot`。
6. 某个 event 清空后删除该 event。
7. JSON 解析失败或没有 Node 时提示需要手动清理。

该函数只按 `.loongsuite-pilot` marker 清理，不会执行 agent 自身的卸载逻辑。

## 17. Claude/Codex OTel 插件清理

`remove_otel_plugin()` 负责清理：

```text
~/.cache/opentelemetry.instrumentation.claude
~/.cache/opentelemetry.instrumentation.codex
```

函数开始会 `unset NODE_OPTIONS`，避免删除插件后旧的 `--require intercept.js` 影响后续 Node 命令。

### 17.1 Claude 清理

如果存在：

```text
~/.cache/opentelemetry.instrumentation.claude/package/scripts/uninstall.sh
```

则直接执行该卸载脚本。

否则执行 fallback：

1. 从 `~/.bashrc`、`~/.zshrc`、`~/.bash_profile` 删除以下 block：
   - `# BEGIN otel-claude-hook` 到 `# END otel-claude-hook`
   - `# BEGIN otel-claude-hook-env` 到 `# END otel-claude-hook-env`
2. 清理 `~/.claude/settings.json` 中 command 包含 `otel-claude-hook` 或 `hook-entry.sh` 的 hooks。
3. 清理 `~/.claude/otel-config.json` 中的：
   - `log_enabled`
   - `log_dir`
   - `log_filename_format`
4. 删除插件目录：
   - `--purge`：删除整个 Claude 插件目录。
   - 非 `--purge`：保留插件目录本身和 `sessions/`，删除其他顶层内容。

### 17.2 Codex 清理

如果存在：

```text
~/.cache/opentelemetry.instrumentation.codex/package/scripts/uninstall.sh
```

则直接执行该卸载脚本。

否则执行 fallback：

1. 清理 `~/.codex/hooks.json` 中 command 包含 `otel-codex-hook` 或 `hook-entry.sh` 的 hooks；如果 hooks 全部清空，则删除该文件。
2. 清理 `~/.codex/config.toml`：
   - 删除 legacy hook block。
   - 删除 `# BEGIN/END otel-codex-hook trust` 注释行。
   - 删除 `bypass_hook_trust = ...`。
   - 删除 `[hooks.state."..."]` 中 key 包含当前 `~/.codex/hooks.json` 绝对路径的 section。
   - 删除剩余包含 `otel-codex-hook` 的行。
   - 删除 `codex_hooks = ...`。
   - 合并多余空行。
3. 清理 `~/.codex/otel-config.json` 中的：
   - `log_enabled`
   - `log_dir`
   - `log_filename_format`
4. 删除插件目录：
   - `--purge`：删除整个 Codex 插件目录。
   - 非 `--purge`：保留插件目录本身和 `sessions/`，删除其他顶层内容。

## 18. 版本信息读取

脚本通过 `VERSION` 文件读取版本信息：

| 函数 | 读取内容 |
|------|----------|
| `get_installed_version()` | 优先从 `current` 指向的版本目录读取 `version=`，否则读 `$PERMANENT_DIR/VERSION` |
| `get_version_from_dir(dir)` | 从指定目录读取 `version=` |
| `get_commit_from_dir(dir)` | 从指定目录读取 `git_commit=` |
| `show_version_info(dir)` | 输出 `v<version> (<git_commit>, <build_time>)`，缺失则输出 `unknown` |

## 19. 错误处理特点

脚本启用：

```bash
set -euo pipefail
```

因此未被显式忽略的命令失败会导致脚本退出。以下场景被设计为 best-effort：

- Agent 探测失败：继续安装，`PROBE_RESULT=[]`。
- 服务停止失败：多数分支使用 `|| true` 忽略。
- postinstall 只在文件存在时执行。
- OTel 插件卸载脚本和 fallback 清理大多忽略错误。
- 服务启动失败不会导致 install 失败退出，只提示用户手动启动；upgrade 启动失败会触发回滚并退出 1。

## 20. 主要文件副作用

| 路径 | 操作 |
|------|------|
| `$DATA_DIR/node-bin` | 写入安装时解析到的 Node 路径 |
| `$DATA_DIR/config.json` | 安装时合并写入配置 |
| `$DATA_DIR/loongsuite-pilot.pid` | install 停止旧进程时读取/删除 |
| `~/.loongsuite-pilot/current` | 版本化部署时写入当前版本目录名 |
| `~/.loongsuite-pilot/previous` | 版本化部署时记录上一版本目录名 |
| `~/.loongsuite-pilot/versions/*` | 安装/升级复制包，升级成功后清理旧版本 |
| `~/.loongsuite-pilot/bin/*` | 复制 collector/updater daemon bootstrap |
| `~/.loongsuite-pilot/hooks/*` | 由 postinstall 部署 hook 脚本 |
| `~/.local/bin/loongsuite-pilot` | 安装 CLI 管理命令 |
| `/usr/local/bin/loongsuite-pilot` | root 或可写时创建软链接，卸载时删除 |
| `~/.zshrc` / `~/.bashrc` / `~/.bash_profile` | CLI 不在全局路径时追加 PATH；卸载插件时可能删除 OTel block |
| `~/.cursor/hooks.json` 等 agent 配置 | 卸载时删除包含 `.loongsuite-pilot` 的 hook |
| `~/.cache/opentelemetry.instrumentation.*` | 卸载时清理 Claude/Codex OTel 插件 |
| `~/.codex/config.toml` | 卸载 Codex 插件 fallback 时删除相关 hook/trust 配置 |

## 21. 当前实现注意事项

1. `--data-dir` 不改变版本安装目录和 CLI 安装目录。
2. `install` 重新安装前只按 PID 文件杀进程，不调用完整 `loongsuite-pilot stop`。
3. `upgrade` 启动新版本时不会透传 `--system-service`。
4. 卸载会无条件删除 `$HOME/.loongsuite-pilot`，默认数据目录并不会实际保留。
5. `confirm_config_overwrite()` 只检查部分字段，不覆盖所有会被写入的配置项。
6. `--agents` 不校验 ID；最终只会影响探测结果中出现的 Agent ID。
7. AK 配置写入依赖 SLS endpoint/project/logstore 任一项触发 SLS 分支。
8. 卸载 fallback 中对 `hook-entry.sh` 的匹配较宽，可能清理同名 hook entry。
9. 版本化升级的旧 commit 比较读取 `$PERMANENT_DIR`，不一定等同于 `current` 指向目录。

