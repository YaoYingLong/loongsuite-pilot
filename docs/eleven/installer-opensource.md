# installer-opensource.sh 逐行逻辑详解

> Last verified: 2026-07-26
> 脚本路径: `deploy/installer-opensource.sh`
> 对应脚本行数: 1970（含空行和注释）

本文档面向不熟悉 Shell 的读者，按当前代码解释入口参数、Shell 语法、执行流程、文件副作用、回滚和卸载行为。文中的行号对应已补充中文注释后的脚本；纯分隔线、空行以及连续重复赋值会合并讲解，但不跳过任何可执行逻辑。本文只描述脚本现状，不代表推荐设计。

## 1. 脚本定位

`installer-opensource.sh` 是 LoongSuite Pilot 开源版的一体化安装入口，支持三类命令：

| 命令 | 作用 |
|------|------|
| `install` | 首次安装或重新安装，下载/解压包、部署版本目录、写配置、安装 CLI、启动服务 |
| `upgrade` | 升级已有安装，保留配置，部署新版本并在启动失败时回滚 |
| `uninstall` | 停止服务、删除运行时目录和 CLI，清理 shell 包装、hook、OpenCode/Pi 配置与 Claude/Codex OTel 插件 |

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

注意：`--data-dir` 会影响配置、PID、`node-bin`、运行时 hook 路径以及写入配置中的 `dataDir`；版本目录、bootstrap 和 CLI 安装目录仍固定在 `$HOME/.loongsuite-pilot` 与 `$HOME/.local/bin`。

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
| `--purge` | `PURGE=1` | 卸载时删除 `DATA_DIR`，并连同 session 删除 Claude/Codex OTel 插件缓存目录 |
| `--system-service` | 无 | 已废弃，仅输出警告后忽略；服务类型由 `loongsuite-pilot start` 自动探测 |

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
| 当前用户是 root | 设置 `HAS_SUDO=1` 并提示启动时自动使用系统级服务 |
| 非 root | 只打印当前用户，服务类型交给后续 `loongsuite-pilot start` 自动判断 |
| 传入 `--system-service` | 参数解析阶段提示已废弃并忽略，不进入本函数处理 |

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
| bash | 总是处理 `~/.bashrc`；登录配置依次选择已存在的 `~/.bash_profile`、已存在的 `~/.bash_login`，否则处理 `~/.profile` |
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
inject_qodercli_token_intercept
inject_qoderwork_runtime_wrapper
inject_claude_code_fetch_intercept
loongsuite-pilot start
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

部署后执行 `loongsuite-pilot start`。服务级别统一由管理命令自动探测。

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
remove_qodercli_token_intercept
remove_qoderwork_runtime_wrapper
remove_claude_code_fetch_intercept
remove_otel_plugin
remove_opencode_plugin
remove_pi_coding_agent_extension
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
~/.qoder-cn/settings.json
~/.qoderwork/settings.json
~/.qoderworkcn/settings.json
~/.claude/settings.json
~/.codex/hooks.json
~/.qwen/settings.json
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
| `~/.zshrc` / `~/.bashrc` / `~/.bash_profile` / `~/.profile` | 追加 PATH、注入/移除 qodercli 与 Claude 包装函数、清理历史 OTel block |
| `~/Library/LaunchAgents/com.loongsuite-pilot.qoderwork-env.plist` | macOS 上持久化 QoderWork runtime 环境变量 |
| `~/.cursor/hooks.json` 等 agent 配置 | 卸载时删除包含 `.loongsuite-pilot` 的 hook |
| `~/.config/opencode/*.json*` | 卸载时删除 Pilot 的 OpenCode plugin 条目；JSONC 原文可能备份为 `.bak` |
| `~/.pi/agent/settings.json` | 卸载时删除 Pilot 的 Pi extension 条目 |
| `~/.cache/opentelemetry.instrumentation.*` | 卸载时清理 Claude/Codex OTel 插件 |
| `~/.codex/config.toml` | 卸载 Codex 插件 fallback 时删除相关 hook/trust 配置 |

## 21. 当前实现注意事项

1. `--data-dir` 不改变版本安装目录和 CLI 安装目录。
2. `install` 重新安装前只按 PID 文件杀进程，不调用完整 `loongsuite-pilot stop`。
3. `--system-service` 已废弃并忽略，服务类型由管理命令自动判断。
4. 卸载会无条件删除 `$HOME/.loongsuite-pilot`，默认数据目录并不会实际保留。
5. `confirm_config_overwrite()` 只检查部分字段，不覆盖所有会被写入的配置项。
6. `--agents` 不校验 ID；最终只会影响探测结果中出现的 Agent ID。
7. AK 配置写入依赖 SLS endpoint/project/logstore 任一项触发 SLS 分支。
8. 卸载 fallback 中对 `hook-entry.sh` 的匹配较宽，可能清理同名 hook entry。
9. 版本化升级的旧 commit 比较读取 `$PERMANENT_DIR`，不一定等同于 `current` 指向目录。
10. `upgrade` 不重新执行三个注入函数；依赖既有注入、postinstall 或其他自愈逻辑保持配置。
11. `deploy_package()` 判断 `scripts/postinstall.js` 使用的是安装器当前工作目录，而不是显式的 `$PERMANENT_DIR/scripts/postinstall.js`。

## 22. 阅读脚本前必须掌握的 Shell 语法

### 22.1 命令、参数和返回码

Shell 一行通常由“命令 + 参数”组成，例如：

```bash
cp -f "$source" "$target"
```

这里 `cp` 是复制命令，`-f` 表示允许覆盖，后两个字符串是源路径和目标路径。命令执行完都会返回一个整数状态码：`0` 表示成功，非 `0` 表示失败。`if command; then` 判断的正是这个状态码，而不是命令输出的文字。

### 22.2 本脚本高频符号速查

| 写法 | 含义 | 本脚本示例 |
|------|------|------------|
| `#!/usr/bin/env bash` | 用 `PATH` 中找到的 Bash 解释脚本 | 第 1 行 |
| `# ...` | 注释，不执行 | 所有中文说明 |
| `NAME="value"` | 变量赋值，等号两侧不能有空格 | `PACKAGE_NAME=...` |
| `"$NAME"` | 读取变量并保持为一个参数，路径中有空格也安全 | `rm -rf "$target"` |
| `${NAME:-x}` | 变量未设置或为空时取 `x` | `${TMP_DIR:-}` |
| `${1#*=}` | 删除 `$1` 从开头到第一个 `=` 的最短匹配部分 | 解析 `--key=value` |
| `$#` | 当前参数个数 | 参数解析循环 |
| `$1` / `$2` | 第一个/第二个参数 | 读取选项和值 |
| `$@` | 所有位置参数 | 注入的 CLI 包装函数 |
| `shift` / `shift 2` | 丢弃已处理的 1/2 个参数 | option 解析 |
| `$(command)` | 执行命令并把 stdout 作为字符串 | `current_user=$(whoami)` |
| `local x` | 函数局部变量 | 几乎所有函数 |
| `export X=...` | 设置变量并传给子进程 | `PATH`、语言 |
| `[ ... ]` | POSIX 条件测试命令 | `[ -f "$file" ]` |
| `[[ ... ]]` | Bash 增强条件语法 | 参数数值和正则判断 |
| `-n "$x"` | 字符串非空 | 是否传入选项 |
| `-z "$x"` | 字符串为空 | 是否需要默认值 |
| `-f "$p"` | 路径是普通文件 | 配置/VERSION 判断 |
| `-d "$p"` | 路径是目录 | 安装目录判断 |
| `-x "$p"` | 文件存在且可执行 | Node/npm 候选 |
| `-w "$p"` | 路径可写 | rc 和 `/usr/local/bin` |
| `-t 0` | stdin 是终端 TTY | 是否可交互提问 |
| `! command` | 对命令状态码取反 | “命令不存在”判断 |
| `a && b` | `a` 成功才执行 `b` | 多条件或短路执行 |
| `a \|\| b` | `a` 失败才执行 `b` | fallback / 忽略错误 |
| `a \| b` | 把 `a` 的 stdout 送入 `b` 的 stdin | `grep \| cut` |
| `>` / `>>` | 覆盖写入 / 追加写入文件 | current、shell rc |
| `2>/dev/null` | 丢弃标准错误 | 探测和清理 |
| `&>/dev/null` | 丢弃标准输出和标准错误，属于 Bash 语法 | `command -v` |
| `<< MARKER` | heredoc，多行文本送给命令 | 写 shell block/plist |
| `case ... esac` | 多分支匹配 | 命令、平台、结果分发 |
| `for ...; do ...; done` | 遍历数组或 glob | Node 候选和配置文件 |
| `trap '...' EXIT` | 脚本退出时执行清理 | 删除下载临时目录 |
| `return n` | 从函数返回状态码 | 探测函数 |
| `exit n` | 结束整个脚本 | 参数错误和升级失败 |
| `:` | 什么都不做且返回成功 | tar 成功分支、case 空动作 |

### 22.3 `set -euo pipefail` 为什么重要

第 27 行开启三个严格选项：

- `-e`：未被 `if`、`||` 等结构接住的失败命令会结束脚本。
- `-u`：读取不存在的变量会结束脚本，所以代码常写 `${VAR:-}`。
- `pipefail`：管道中任意一段失败，整条管道就失败。例如 npm 失败时，即使最后的 `tail -1` 成功，部署仍会停止。

看到 `|| true` 时，应理解为作者明确把这一失败降级成“可忽略”。看到 `2>/dev/null || true` 时，既不展示错误，也不让严格模式中断流程。

### 22.4 引号和展开时机

单引号中的 `$变量` 不展开，双引号中的变量会展开。heredoc 也遵守类似规则：

```bash
<< 'PATHBLOCK'   # 分隔符有单引号：正文原样写入，安装时不展开 $HOME/$PATH
<< INTERCEPTBLOCK # 分隔符无引号：正文变量会在安装时展开
```

qodercli/Claude 包装 block 需要把 `$DATA_DIR` 固化成安装时路径，但要把 `\$@`、`\${BUN_OPTIONS}` 留给未来的用户 shell，所以代码对后两者做了反斜杠转义。

### 22.5 为什么脚本里混有 JavaScript、awk 和 sed

Shell 擅长编排命令，但不适合安全地修改 JSON。因此脚本通过 `"$NODE_BIN" -e "..."` 运行内嵌 JavaScript，负责 JSON 解析、数组过滤和写回。`sed` 适合按 marker 删除连续文本，`awk` 适合维护一个小状态机清理 TOML section。阅读时要先判断当前行属于哪一种语言：

- Shell 双引号内的 JavaScript仍会先经过 Shell 变量展开。
- 单引号包围的 awk 程序通常不会被 Shell 展开。
- JavaScript 的 `process.argv[1]` 对应 `node -e` 后额外传入的第一个业务参数。

## 23. 全局执行模型

脚本加载时不会立刻安装。它先从上到下完成以下工作：

1. 开启严格模式、初始化变量、解析全部参数。
2. 校验脱敏参数并解析最终下载 URL。
3. 定义所有函数；函数体在定义阶段不执行。
4. 到达文件末尾 `case "$COMMAND"` 时，才调用 `cmd_install`、`cmd_upgrade` 或 `cmd_uninstall`。

三个主流程共享全局变量：

```text
命令行 / 环境变量
        |
        v
COMMAND、PACKAGE_URL、DATA_DIR、SELECTED_AGENTS 等
        |
        +--> 公共函数读写 NODE_BIN、NPM_BIN、TMP_DIR、INSTALL_SRC、PERMANENT_DIR
        |
        +--> install / upgrade / uninstall 主流程
```

这里最需要注意的是 `PERMANENT_DIR` 并非常量：初始为旧布局的 `package/`，迁移或版本化部署后会改成具体 `versions/<version>_<commit>/` 路径。

## 24. 最终源码行号导航

| 行号 | 代码块 | 读完应理解什么 |
|------|--------|----------------|
| 1-25 | 解释器与使用示例 | 为什么必须用 Bash，管道安装时参数如何传递 |
| 26-65 | 严格模式、常量、变量初值 | 默认目录、环境变量 fallback、全局状态 |
| 66-150 | 子命令和 option 解析 | `shift`、`${1#*=}`、组合参数校验 |
| 152-178 | `validate_install_user` 与 URL | Linux 身份提示、下载 URL 优先级 |
| 180-198 | `detect_lang` / `msg` | locale 探测和双语输出 |
| 203-319 | Node/npm 依赖解析 | 候选顺序、版本过滤、路径固化 |
| 324-363 | 下载与解压 | 临时目录、curl/wget、tar fallback、安装源定位 |
| 368-382 | `probe_agents` | 可降级探测与 JSON 结果 |
| 387-474 | `select_agents` | TTY 分支、菜单输入、编号归一化 |
| 479-510 | `prompt_user_id` | 旧值读取和交互保留 |
| 516-574 | `confirm_config_overwrite` | 差异计算、交互确认、非交互覆盖 |
| 580-587 | bootstrap 部署 | 稳定启动脚本为何放在版本目录外 |
| 592-656 | `deploy_package` | current/previous、npm、postinstall |
| 661-695 | 旧布局迁移 | 触发条件、默认版本信息、复制策略 |
| 700-813 | `write_config` | Shell 与 Node 两层展开、配置合并规则 |
| 818-880 | 安装管理命令 | CLI 复制、PATH 和不同 shell profile |
| 886-967 | qodercli wrapper | sed 兼容、alias guard、BUN_OPTIONS preload |
| 973-1050 | QoderWork wrapper | macOS launchctl 和 LaunchAgent 持久化 |
| 1060-1136 | Claude wrapper | 用户定义检测、BUN_OPTIONS 合并与清理 |
| 1142-1198 | 版本读取 | current fallback 和 VERSION 字段 |
| 1205-1418 | OTel 清理 | 自带卸载优先、Claude/Codex fallback |
| 1420-1449 | 安装/升级摘要 | 面向用户输出哪些状态 |
| 1454-1531 | `cmd_install` | 完整安装时序和失败语义 |
| 1536-1625 | `cmd_upgrade` | 同版本判断、健康检查、回滚 |
| 1630-1656 | 版本 GC | 只保留 current/previous |
| 1661-1718 | 通用 hook 清理 | marker 所有权和 JSON 过滤 |
| 1725-1783 | OpenCode 清理 | JSONC fallback 和备份 |
| 1788-1826 | Pi 清理 | extensions 精确过滤 |
| 1831-1958 | `cmd_uninstall` | 多平台停服和所有清理副作用 |
| 1963-1970 | 主分发器 | 真正开始执行的位置 |

## 25. 按最终行号逐段精读

以下表格把结构性连续行合并说明。例如函数的右花括号只表示“函数定义结束”，不会为每个 `}` 重复建一行；成对的 `--key value` / `--key=value` 也放在同一项解释。除此之外，每一条有行为的语句都被覆盖。

### 25.1 第 1-198 行：启动、参数和语言

| 行号 | 逐行含义 |
|------|----------|
| 1 | shebang。直接执行文件时，由 `env` 在当前 `PATH` 中找 `bash`。如果用户显式运行 `sh installer-opensource.sh`，shebang 不生效并可能报语法错。 |
| 2-24 | 全部是注释。第 8 行是无参数安装；第 9-14 行展示 `bash -s --`：`-s` 表示从 stdin 读脚本，`--` 后内容成为脚本参数；行尾 `\` 连接下一物理行。16-24 分别给指定版本、升级、卸载和彻底卸载示例。 |
| 26-27 | 开启严格模式。注释不执行，`set` 才真正改变当前 Bash 的错误处理行为。 |
| 29-31 | 视觉分隔注释，无运行效果。 |
| 32 | 包名既用于构造 tar.gz 文件名，也用于优先识别解压后的顶层目录。 |
| 33 | `PERMANENT_DIR` 初始指向兼容旧版的 `package/`；后续函数可重新赋值。`$HOME` 在赋值时展开。 |
| 34 | 保存默认数据目录，便于第 51 行赋给可被参数覆盖的 `DATA_DIR`。 |
| 36-37 | 设置 OSS 根地址；变量名前下划线只是命名约定，不产生语言级私有性。 |
| 39-42 | 进入参数状态初始化区，`COMMAND` 先为空。 |
| 43-44 | 优先读取环境变量 `LOONGSUITE_PILOT_PACKAGE_URL`；未定义时取空串，避免 `set -u`。 |
| 45-62 | 把所有带值选项对应变量初始化为空。空值同时承担“用户未提供该项”的标记。第 51 行例外，数据目录先有默认值。 |
| 63 | `HAS_SUDO=0` 初始化；当前代码只在 root 情况改成 1，但后续没有读取它。 |
| 64 | `PURGE=0` 表示默认非彻底清理，只有 `--purge` 改为 1。 |
| 66-67 | `$#` 大于 0 表示至少有一个参数，才检查 `$1`。`[[ ]]` 是 Bash 条件语法。 |
| 68-70 | `case` 匹配三个合法子命令。保存到 `COMMAND` 后 `shift`，防止子命令再进入 option 循环。分号把赋值和 shift 写在同一物理行，`;;` 结束 case 分支。 |
| 71-72 | 第一个参数以 `-` 开头时不消费它，只把命令默认成 `install`，让后面的循环继续解析该 option。 |
| 73-74 | 其他首参数也暂定 `install` 且不消费，随后会落入未知 option 分支并报错。 |
| 76-78 | 没参数时直接选择 `install`；`fi` 结束 if。 |
| 80-82 | 只要仍有参数就持续进入 `case "$1"`。每个分支必须自行 shift，否则会死循环。 |
| 83-122 | 每个带值选项都有两种写法。空格写法从 `$2` 取值并 `shift 2`；等号写法用 `${1#*=}` 去掉首个等号及之前内容并 `shift`。`--userId`/`--user.id` 是同义参数；`--lang` 使用 export，使后续命令也能看到语言变量。 |
| 123 | `--purge` 是无值开关，设为 1 后只消费自己。 |
| 124-127 | `--system-service` 为兼容旧调用而保留：把英文警告写到 stderr，随后忽略参数。`>&2` 表示 stdout 重定向到文件描述符 2。 |
| 128-130 | 任意未匹配内容打印未知 option 并 `exit 1`，不会进入主流程。 |
| 131-132 | `esac` 和 `done` 结束当前轮分支与参数循环。 |
| 134-142 | 仅当 `MASK_MODE` 非空时验证枚举。`all\|none\|custom` 分支用 `:` 空命令表示合法；其他值报错退出。 |
| 143-146 | custom 模式必须同时提供非空 `MASK_TYPES`；`&&` 要求两个测试都成功。 |
| 147-150 | 反向约束：提供了 types 时 mode 必须恰好为 custom。 |
| 152-154 | 定义 `validate_install_user`，此时函数体尚未运行。 |
| 155-169 | 调用时用 `uname -s` 判断系统。只有 Linux 分支有动作：`whoami` 得到显示名；`id -u` 等于 0 代表 root，记录 `HAS_SUDO=1` 并输出对应提示；非 root 只说明服务类型自动探测。Darwin 等系统没有匹配分支，因此直接返回成功。 |
| 171-178 | 仅当最终 `PACKAGE_URL` 仍为空才构造 OSS URL。有版本号使用 `<base>/<version>/<package>.tar.gz`，否则使用 `latest`。因此命令行 URL 和环境变量 URL 都优先于 `--version`。 |
| 180-185 | 定义语言探测函数。显式语言变量非空时立刻 echo 并 return；echo 的 stdout 会被第 196 行捕获。 |
| 186-188 | 遍历四种 locale 变量。每项都用 `${VAR:-}` 防未定义；`grep -qi` 不区分大小写且静默匹配 `zh`。 |
| 189-193 | macOS 再读取全局 `AppleLanguages`。`2>/dev/null` 隐藏 defaults 错误；管道末尾 `\|\| true` 防严格模式因无中文匹配而退出。 |
| 194-196 | 全部未命中则输出 `en`；命令替换捕获函数输出，赋给全局 `LANG_MODE`。 |
| 197-198 | 定义双语输出函数：语言为 `zh` 时 echo 第一个参数，否则 echo 第二个参数。这里用 `&& ... \|\| ...` 实现简短二选一。 |

### 25.2 第 203-363 行：依赖、下载和解压

| 行号 | 逐行含义 |
|------|----------|
| 203-206 | `_resolve_realpath($1)` 依次尝试 `realpath`、`readlink -f`，都失败就原样 echo。错误输出隐藏，`\|\|` 形成 fallback 链。 |
| 208-218 | `_node_is_app_bundle` 先解析真实路径，再用 `case` 判断三个 macOS `.app/Contents` 模式。匹配返回 0（“是 bundle”），不匹配返回 1。这里返回码代表布尔值，不输出 true/false。 |
| 220-224 | `_node_is_suitable` 把候选保存为局部变量；不可执行或属于 app bundle 就立即返回 1。 |
| 225-230 | 执行 `node --version`；失败即淘汰。`${ver#v}` 去掉前导 v，`${major%%.*}` 去掉第一个点及其后最长内容，只留主版本。随后用 Bash 正则确保全为数字，并用算术表达式要求 `>=18`。 |
| 233-242 | 建立候选数组。NVM glob 可能展开多个路径，C 风格 `for ((...))` 从最后一个元素倒序追加到 `_candidates`。`${#array[@]}` 是数组长度。 |
| 244-250 | 按固定优先级追加 Volta、fnm、Homebrew、`/usr/local` 和用户本地 Node。括号表示多行数组追加。 |
| 252-254 | 若当前 PATH 能找到 node，再把结果作为最后一个候选；重定向只用于静默探测。 |
| 256-263 | 遍历候选，首个适合者输出真实路径并成功返回；全失败返回 1。调用方通过命令替换取得输出。 |
| 265-273 | `check_deps` 调用 `resolve_node`。成功输出赋给全局 `NODE_BIN`；失败进入 `{ ... }` 命令组，显示错误并退出整个安装器。 |
| 275-280 | 用 Node 自己读取主版本并二次检查。这看似重复，但能给出清晰错误信息，也防后续逻辑变更绕过前置过滤。`-lt` 是整数小于。 |
| 282-284 | 尝试创建数据目录并把 Node 绝对路径覆盖写入 `node-bin`。`mkdir` 失败被忽略，但紧随其后的写文件失败仍会因严格模式终止。 |
| 286-296 | 先推导同目录 npm；不可执行时 fallback 到 PATH 中 npm；仍找不到则退出。`dirname` 输出 Node 所在目录。 |
| 298-307 | 仅 macOS 比较系统架构和 `process.arch`。arm64 系统配 x64 Node 只告警，不退出。分号让 `local` 声明与赋值处在同一行。 |
| 309-313 | curl 与 wget 都不存在时退出。两个被取反的探测以 `&&` 连接，意味着必须同时缺失。 |
| 315-319 | 打印实际 Node/npm 版本和被固化的 Node 路径，再输出空行；函数自然返回最后一个 `echo` 的成功状态。 |
| 324-327 | `download_and_extract` 用 `mktemp -d` 创建临时目录并写全局 `TMP_DIR`；本函数不自行注册 trap。 |
| 329-337 | 显示 URL。curl 存在时使用 `-f` HTTP 错误失败、`-sS` 静默但保留错误、`-L` 跟随重定向；否则 wget 静默下载。两者都写到固定 tar.gz 路径。 |
| 338-339 | 下载命令未失败才会到这里，打印完成和空行。 |
| 341-347 | 先带 GNU tar 专用 warning 参数解压；失败时用跨平台通用参数重试。`-xzf` 分别代表解压、gzip、指定文件，`-C` 指定目标目录。成功分支的 `:` 不做额外动作。 |
| 349-353 | 优先识别 `<tmp>/loongsuite-pilot` 顶层目录；其次接受 package.json 直接位于临时目录的平铺包。 |
| 354-359 | 其他结构用 `find` 在两层内找 package.json，通过 `-exec dirname` 输出目录并取第一项。没找到时因 `\|\| true` 得到空字符串，再显式报结构异常。 |
| 360-363 | 结束目录选择，输出解压完成并结束函数。 |

### 25.3 第 368-574 行：Agent 选择与交互确认

| 行号 | 逐行含义 |
|------|----------|
| 368 | 全局探测结果先设为合法 JSON 空数组，确保探测失败时后续 Node 仍能解析。 |
| 370-377 | `probe_agents` 运行安装包的 `dist/cli-probe.cjs` 并捕获 stdout。失败由 `\|\| { ... }` 接住：显示告警、恢复 `[]`、返回成功，所以 install 不会中断。 |
| 378-382 | 用一小段 Node 解析数组长度；解析失败 fallback 为字符串 `0`。随后打印定义数量。注意这是 Agent 定义数，不等同于 detected 数。 |
| 387-393 | `select_agents` 首先尊重已有 `SELECTED_AGENTS`，即命令行 `--agents`；非空时打印并提前返回，不验证 ID。 |
| 395-399 | 解析探测数组长度，数组为空就不询问用户。 |
| 401-412 | `-t 0` 为假表示 stdin 不是终端。内嵌 Node 过滤 `detected`、提取 id、逗号连接；错误被 `\|\| true` 降级为空选择，然后提示自动选择结果并返回。 |
| 414-435 | 交互模式的第一段 Node 遍历定义，按语言拼接 detected 状态，打印从 1 开始的编号；同时收集 detected 项作为默认选择，并打印输入说明。`padEnd(16)` 只为菜单对齐。 |
| 437-452 | 第二段 Node readline 从 stdin 读一行，提示符写到 stderr，答案经中文标点归一化后写 stdout，供命令替换捕获。若 Node readline 失败，Shell fallback 使用 `read -r`，再用 sed 做同样替换。`-r` 禁止反斜杠转义输入。 |
| 454-466 | 第三段 Node 计算最终编号。空输入选择 detected；非空输入按空白/逗号切分、转数字、过滤范围、Set 去重，再转为零基下标、排序、映射 id。 |
| 468-474 | 根据最终字符串是否为空打印“已选择”或“未选择”，然后结束函数。 |
| 479-482 | `prompt_user_id` 在已有 `USER_ID` 或非交互 stdin 时提前成功返回。 |
| 484-490 | 指向 `$DATA_DIR/config.json`。文件存在时用 Node 尝试读取 `userId`；非法 JSON、字段缺失或命令失败均得到空串。`--` 防文件名被 Node 当 option。 |
| 492-502 | 根据是否有旧值展示不同提示：有旧值可回车保留，无旧值可回车跳过。 |
| 503-510 | `read -r` 获取输入，`tr -d '[:space:]'` 删除所有空白。非空新输入覆盖全局值；否则沿用 existing_uid。 |
| 516-519 | `confirm_config_overwrite` 只在配置文件存在时工作，否则立即返回。 |
| 521-546 | 内嵌 Node 读取旧 JSON，解析 Shell 构造的新值 JSON，定义 CSV 归一化函数和九个待比较字段。只保留“新旧均非空且不同”的项，逐行输出 `old -> new`。旧 JSON 解析失败直接退出 0，等同无差异。 |
| 547-548 | Shell 用 `printf` 构造新值 JSON 作为 Node 参数。它没有 JSON 转义特殊字符，这是当前实现的边界；Node stderr 被丢弃，失败后 `diffs` 为空。 |
| 550 | 没有差异文本时直接返回，不打扰用户。 |
| 552-556 | 有差异时逐行缩进显示。`echo "$diffs" | while IFS= read -r line` 保留每行内部空格。 |
| 558-570 | 交互模式读取确认，仅 `y/Y/yes/YES` 继续；其他输入显示取消并 `exit 0`，表示用户主动取消而非错误。 |
| 571-574 | 非交互模式无法确认，明确提示后直接允许覆盖。 |

### 25.4 第 580-813 行：部署与配置合并

| 行号 | 逐行含义 |
|------|----------|
| 580-587 | bootstrap 函数创建稳定 `bin/` 目录，强制复制 collector；updater 仅存在时复制，缺失和复制失败都被末尾 `\|\| true` 放宽。 |
| 592-600 | `deploy_package($1)` 建立缓存、版本指针路径和空版本字段。所有路径变量都是函数局部，但 `PERMANENT_DIR` 后面会改全局。 |
| 601-604 | `VERSION` 存在时，用 `grep '^key=' | cut -d= -f2` 读取 version 和 commit。只取第二字段，值中额外等号会被截断。 |
| 606-617 | 两字段都非空才启用版本化布局。目录名为 `<version>_<commit>`。若 current 已存在且不同，把旧指针去空白后覆盖写入 previous。 |
| 619-628 | 创建 versions、删除同名目标后递归复制。current 先写 `.tmp` 再原子 mv，最后把全局 `PERMANENT_DIR` 改为新目录。 |
| 629-635 | 缺少完整元数据时走旧布局：确保父目录存在，删除旧 package，再复制新包；此分支不更新 current/previous。 |
| 636-640 | 打印部署成功并调用 bootstrap 复制函数。 |
| 642-646 | 在子 shell 中 `cd` 到部署目录运行生产依赖安装，合并 stderr/stdout 后只显示最后一行。因为全局 pipefail，npm 失败仍使整个命令失败。 |
| 648-656 | 如果安装器当前工作目录有 `scripts/postinstall.js`，用固化 Node 执行；不是显式检查部署目录。随后无论文件是否存在都打印 hook 已部署和 Codex 信任提示。 |
| 661-668 | 迁移函数准备路径。已有 current 就返回；旧 package 不存在或缺少 `dist/index.js` 也返回。 |
| 670-680 | 读取旧 VERSION；任一字段为空时分别 fallback 到 `0.0.0` / `legacy`。`${ver:-0.0.0}` 同时处理未设置和空值。 |
| 685-694 | 创建目标目录、递归复制旧 package、写 current、更新全局 `PERMANENT_DIR`。旧 package 不删除，因此迁移后两份同时存在。 |
| 700-707 | `write_config` 计算目标路径、创建数据目录并启动内嵌 Node。因为外层是双引号，Shell 会先替换 `$config_file` 等变量。 |
| 708-725 | Node 读取旧 JSON，失败则空对象；对象展开保留旧字段，但强制 `enabled=true` 和本次 `dataDir`。删除 `internal`，把旧 `user.id` 迁移到 `userId` 后删除旧键。 |
| 727-733 | Shell 把 SLS、日志级别和 userId 直接插入 JavaScript 字符串。参数若含单引号等字符可能破坏代码，这是当前实现边界。 |
| 735-752 | endpoint/project/logstore 任一非空才创建/更新 `config.sls` 并删除旧 `destinationOverride`。AK 必须成对才写入；project/logstore 也必须成对，并在写入时删除旧 endpoints 数组。 |
| 754-761 | 非空 logLevel 才覆盖；非空 userId 覆盖并删除旧 identity。空字符串意味着“保留旧值”，不能用参数主动清空。 |
| 763-771 | 继续把采集开关、CMS、服务名前缀、Agent 和脱敏参数转换成 Node 常量。 |
| 773-774 | collect 参数只要非空就写布尔值，且只有字面字符串 `true` 得到 true，其他任何非空值都得到 false。 |
| 776-781 | 任一 CMS 参数非空时确保 cms 对象存在，再逐字段更新；未提供字段保留旧值。 |
| 783 | 非空 serviceNamePrefix 才覆盖旧值。 |
| 785-796 | 非空 maskMode 时更新 mode；custom 把逗号字符串 trim/filter 成数组，all/none 则删除旧 types。 |
| 798-807 | selectedAgents 非空时才更新 agents。解析探测结果，遍历每个已知 Agent，将 enabled 设置为所选 ID 是否包含它；不在探测结果里的 ID 和旧 Agent 项不被创建/遍历。 |
| 809-813 | 以两空格缩进和末尾换行覆盖写回 JSON。`-- "$PROBE_RESULT"` 把探测 JSON 作为 Node argv；随后打印成功并结束函数。 |

### 25.5 第 818-1136 行：CLI、PATH 与三种运行时包装

| 行号 | 逐行含义 |
|------|----------|
| 818-827 | 创建 `~/.local/bin`，从当前版本复制管理脚本为 `loongsuite-pilot` 并 `chmod +x`。`cp -f` 覆盖旧命令。 |
| 829-833 | `/usr/local/bin` 存在且可写时，`ln -sf` 创建/替换全局软链接；这种情况不改 shell rc。 |
| 834-844 | 否则定义内部 `ensure_path_block(file)`：目标不存在就尝试 touch，不可写只告警返回；任何位置已出现 `.local/bin` 就认为无需追加。 |
| 845-854 | 对非空且末尾无换行的文件补换行。单引号 heredoc 原样追加 PATH block，所以 `$HOME` 和 `$PATH` 留到未来 shell 启动时才展开，最后打印写入提示。 |
| 856-876 | 根据 `$SHELL` 选 rc。zsh 处理 `.zshrc`；bash 总处理 `.bashrc`，登录配置优先使用已存在 `.bash_profile`，其次 `.bash_login`，都不存在才处理 `.profile`；未知 shell fallback 到 `.bashrc`。每次调用带 `\|\| true`，单个 profile 写失败不终止安装。 |
| 878-880 | 给当前安装器进程的 PATH 前置 `~/.local/bin`，让随后 `loongsuite-pilot start` 立即可用。 |
| 886-893 | `_sed_inplace` 统一 macOS BSD sed 与 GNU sed 的原地编辑参数：Darwin 用 `sed -i ''`，其他用 `sed -i`。 |
| 895-901 | qoder 注入函数先看选择字符串是否包含 `qoder`。未选择则清旧 block 后返回；qodercli 命令或 preload 文件不存在也返回。这里是子串匹配，`qoder-work` 等 ID 也可能命中 `qoder`。 |
| 905-912 | 定义内部 rc 写入函数，只处理已经存在且可写的文件，不会像 PATH 函数那样创建 rc。 |
| 913-918 | 若找到旧 marker：带当前 alias guard 签名则认为已是最新版并返回；否则 `_sed_inplace` 删除旧 BEGIN/END block，准备迁移。 |
| 919-933 | 必要时补换行，再追加未引用 heredoc。安装时 `$DATA_DIR` 展开；`\$@` 被保留。运行期 wrapper 设置 `BUN_OPTIONS=--preload=<intercept>`，用 `command qodercli` 绕过函数自身避免递归。alias/function guard 加 eval，既保护用户定义又规避 alias 解析冲突。 |
| 935-939 | 只向当前 shell 类型对应的 `.zshrc` 或 `.bashrc` 注入。 |
| 941-951 | 扫描托管 block 外是否已有用户 qodercli 定义；若有，说明自动 guard 会跳过包装，于是给出手工启用方法。 |
| 954-963 | 移除函数遍历四个常见 rc，存在 marker 时按范围原地删除并提示。未处理 `.bash_login`，这是当前覆盖范围。 |
| 973-984 | QoderWork wrapper 只在 macOS 工作。未选择时主动清理旧状态；仅在系统级或用户级 QoderWork.app 和 wrapper 文件都存在时继续，然后打印配置提示。 |
| 986-987 | `launchctl setenv` 立刻为当前用户 launchd 会话设置 `QODER_WORKER_RUNTIME_PATH`。已启动的应用不会自动获得新环境，所以后面要求重启应用。 |
| 989-1012 | 创建 `~/Library/LaunchAgents` 并用 heredoc 覆盖写 plist。ProgramArguments 等价于登录时执行 `/bin/launchctl setenv QODER_WORKER_RUNTIME_PATH <wrapper>`；`RunAtLoad=true` 让每次登录自动恢复。`$wrapper_script` 在写文件时展开。 |
| 1014-1017 | 先 unload 再 load 新 plist，支持升级路径变化；两个失败都忽略，因为当前会话 setenv 已完成。 |
| 1019-1026 | 打印配置完成并明确要求完全退出、重开 QoderWork。 |
| 1028-1047 | 清理函数同样只在 macOS：若 plist 存在则 unload、删除；当前环境变量只有在值含 `loongsuite-pilot` 时才 unset，避免误删用户自己的值。 |
| 1049-1059 | 这段注释解释 Claude wrapper 的必要性及用户定义检测约定：Bun 主进程启动前读取 BUN_OPTIONS，settings.json 注入太晚；检查不会递归 rc source 的文件。 |
| 1060-1070 | `_rc_user_override_present(cli, begin, end)` 遍历常见 rc。先用 sed 删除托管 block 的视图，再用扩展正则匹配 alias、`name()` 和 `function name` 三类用户定义；找到返回 0，全无返回 1。 |
| 1072-1080 | Claude 注入的前置判断与 qoder 类似：未选择则清旧 block；claude 命令或 preload 文件不存在则跳过，条件满足后打印配置提示。 |
| 1082-1097 | 内部 rc 函数检查文件和写权限，并迁移旧版裸函数 block；已是带 guard 新版时保持幂等。 |
| 1098-1108 | 追加 wrapper。运行期 BUN_OPTIONS 为 `--preload=<Pilot> ${BUN_OPTIONS}`，既前置 Pilot 又保留用户原值；`command claude "$@"` 避免递归并原样转发所有参数。 |
| 1110-1126 | 按 shell 类型选择一个 rc，并在发现用户自定义 claude 时打印手工合并 BUN_OPTIONS 的提示。 |
| 1128-1137 | 遍历常见 rc，按 Claude marker 删除托管 block。 |

### 25.6 第 1142-1418 行：版本读取与历史 OTel 清理

| 行号 | 逐行含义 |
|------|----------|
| 1142-1154 | `get_installed_version` 先读取 `~/.loongsuite-pilot/current`，去掉所有空白，把它拼到 `versions/<dir>/VERSION`；文件存在就输出 `version=` 值并提前返回。 |
| 1156-1162 | current 路径不可用时 fallback 到 `$PERMANENT_DIR/VERSION`；文件不存在显式输出空行。 |
| 1165-1172 | `get_version_from_dir($1)` 只读取指定目录 VERSION 的 `version=`，不存在输出空。 |
| 1175-1182 | `get_commit_from_dir($1)` 同理读取 `git_commit=`。 |
| 1185-1198 | `show_version_info($1)` 读取 version/commit/build_time，格式化为 `v... (..., ...)`；VERSION 缺失输出 `unknown`。字段缺失时对应位置为空但不会报错。 |
| 1205-1212 | `remove_otel_plugin` 定义 Claude/Codex 两个缓存目录，并 `unset NODE_OPTIONS`。unset 只影响当前卸载进程及其后续子进程，不直接编辑用户永久环境。 |
| 1213-1217 | Claude 插件自带 uninstall.sh 时优先运行。显式 `bash` 不依赖文件可执行位；错误隐藏并忽略。 |
| 1218-1230 | 没有自带卸载脚本时遍历三个 rc，用带 `.bak` 的跨平台 sed 删除两类历史 block，随后删除临时备份。不存在 marker 就不写文件。 |
| 1232-1257 | 若 Claude settings 同时存在、文本先验命中 marker 且 Node 可用，则结构化解析 hooks。逐 event 保留非 Pilot hook，删除空 matcher 和空 event；所有 hooks 清空时删除顶层 hooks。JSON 异常在 JavaScript catch 中吞掉。 |
| 1259-1271 | 结构化读取 `~/.claude/otel-config.json`，删除三个日志字段后写回；解析/写入异常被 catch 和 `\|\| true` 忽略。 |
| 1273-1286 | Claude 缓存目录存在时：PURGE=1 整目录删除；否则 `find -maxdepth 1` 排除根目录本身和 sessions，只删其他顶层内容。 |
| 1288-1293 | Codex 同样先尝试插件自带 uninstall.sh；存在时不进入 fallback hooks/config.toml 清理。 |
| 1294-1321 | fallback 新格式清理 hooks.json。过滤嵌套 group.hooks 中的 Pilot 命令，空 group/event 逐级删除；hooks 对象最终为空时直接删除整个 hooks.json，否则格式化写回。 |
| 1323-1339 | 若 config.toml 文本含 `otel-codex-hook`，先用 awk 状态变量删除 legacy hook block：遇起始 marker 进入 skip=1，遇 stop 命令转 skip=2，再跳过紧随空行，之后恢复打印。临时文件成功生成后 mv 覆盖。 |
| 1340-1346 | 删除 trust BEGIN/END 注释本身；`grep -v` 即输出“不匹配的行”。即使所有行被过滤导致 grep 返回 1，也由 `\|\| true` 接住。 |
| 1347-1352 | 删除 `bypass_hook_trust = ...` 行，再用临时文件替换。正则中的 `\s` 依赖当前 grep 实现的行为，脚本现状如此。 |
| 1353-1366 | 算出 Codex hooks.json 绝对路径，用 awk 删除 section 标题中含该 owned path 的 `hooks.state` 段；遇下一非 hooks.state section 时停止 skip。 |
| 1367-1378 | 兜底删除残留 `otel-codex-hook` 行，再删除旧 `codex_hooks = ...` 开关。两步都采用临时文件 + mv。 |
| 1379-1388 | 用 awk 把连续空行压成最多一行，打印 Codex TOML 清理完成。 |
| 1390-1402 | 清理 Codex otel-config.json 的三个日志字段，逻辑与 Claude 相同。 |
| 1404-1418 | Codex 插件目录按 PURGE 决定整目录删除，或仅保留根目录和 sessions。函数结束。 |

### 25.7 第 1420-1656 行：摘要、安装、升级和版本 GC

| 行号 | 逐行含义 |
|------|----------|
| 1420-1425 | `print_summary(action)` 保存 action 和配置路径，打印分隔线，并通过命令替换取得当前 `PERMANENT_DIR` 的格式化版本。 |
| 1426-1431 | `case` 只对 install/upgrade 输出对应完成文案；其他 action 不输出完成句，但函数仍继续。 |
| 1432-1436 | 打印配置、数据、Hook 目录。这里是展示字符串，不检查路径是否真实存在。 |
| 1438-1443 | 只有本次命令行 `SLS_ENDPOINT` 非空才显示 SLS 后端；project/logstore 各自非空时才显示。它不回读已有 config。 |
| 1445-1449 | 打印两个常用管理命令和结束分隔线。 |
| 1454-1464 | `cmd_install` 显示开始信息，依次执行用户检查、依赖检查和旧布局迁移。任一未放宽的失败都会因严格模式退出。 |
| 1466-1472 | 调用 `get_installed_version`；非空只提示“重新安装”，不会改走 upgrade，也不询问确认。 |
| 1474-1497 | 若 PID 文件存在，读取 PID 并用 `kill -0` 探活。活着则发送默认 TERM，每秒重试、最多 10 秒；仍活着发送 KILL，最后删除 PID。若 PID 已失效也删除陈旧文件。所有 kill 错误都被忽略。 |
| 1499-1500 | 注册 EXIT trap。`${TMP_DIR:-}` 确保即使下载前失败也不会被 `set -u` 中断；空路径传给带引号的 `rm -rf` 不会删除其他目录。 |
| 1501-1507 | 严格按顺序下载、探测/选择 Agent、询问 userId、确认覆盖、部署包、写配置。前一步成功才进入后一步。 |
| 1508-1511 | 安装管理命令后执行 qodercli、QoderWork、Claude 三个注入函数。它们内部根据 Agent 选择和本机条件决定注入或清旧状态。 |
| 1513-1527 | 调用 `loongsuite-pilot start`。start 成功后等 2 秒并捕获 status；只有输出含 `is running` 才显示已启动，否则告警可能未就绪。start 返回非 0 也只告警，不 exit 1。 |
| 1528-1531 | 输出空行和安装摘要。即使服务未启动，安装流程仍可能以 0 成功结束。 |
| 1536-1545 | `cmd_upgrade` 显示开始，检查用户并迁移旧布局。与 install 不同，依赖检查放在确认已有安装之后。 |
| 1547-1556 | 读取旧版本；空值表示未安装，报错退出 1。否则打印当前版本。 |
| 1558-1561 | 检查依赖、注册临时目录 trap、下载解压新包。 |
| 1563-1565 | 读取新 version/new commit 和旧 commit。旧 commit 直接从当前进程的 `PERMANENT_DIR` 读取，可能未跟 current 指针同步。 |
| 1567-1570 | 只有新 version 非空、版本相等且 commit 相等时才判“已是最新”并退出 0。commit 同为空也可满足相等，但前提 version 非空。 |
| 1573-1575 | 打印新版本；`${new_ver:-unknown}` 在值为空时展示 unknown。 |
| 1577-1584 | 停旧服务：优先 PATH 命令，其次用户级绝对路径，错误都忽略；二者都没有时不做手工 PID 停止。 |
| 1586-1588 | 部署新版本并更新 CLI。这里没有调用 `write_config`、Agent probe/selection 或三个 runtime 注入函数，因此升级保留原配置。 |
| 1590-1606 | 启动新版本并等 2 秒。start 成功且 status 含固定英文文本时才算健康；随后 GC、打印摘要并 `return 0`。 |
| 1608-1625 | 任何启动/健康检查失败都进入回滚：尝试停服，优先 PATH CLI 执行 rollback，否则直接调用用户级 CLI；回滚命令失败也被忽略，但最终固定提示已回滚并 `exit 1`。提示不能证明 rollback 命令真实成功。 |
| 1630-1637 | `gc_old_versions` 建立路径，versions 不存在就返回成功。 |
| 1639-1645 | 分别读取 current/previous 并去掉空白；文件缺失则保留空字符串。 |
| 1647-1656 | 遍历每个版本子目录，非目录跳过；basename 等于 current 或 previous 就保留，其余 `rm -rf`。删除失败未放宽，会使升级成功路径转为失败退出。 |

### 25.8 第 1661-1826 行：Agent 配置清理

| 行号 | 逐行含义 |
|------|----------|
| 1661-1673 | 通用 hook 清理定义所有权 marker 和八个候选配置路径，Bash 数组每行一个元素。 |
| 1675-1680 | 遍历配置；不存在就 `continue`。`${cfg/#$HOME/\~}` 只把路径开头的 HOME 替换成显示用 `~`。`ok=0` 默认表示清理器未成功运行。 |
| 1681-1709 | Node 可用时解析 JSON。遍历 hooks 的每个 event，只处理数组；同时检查 entry.command 和 nested hooks[].command 是否含 marker。过滤后删除空 event，发生改变才写回；无改变输出 skip。Node 整体成功后 Shell 的 `&& ok=1` 把状态标记为成功，无论结果是 cleaned 还是 skip。 |
| 1712-1718 | `ok=1` 提示已清理，解析失败或 Node 缺失则提示需手工清理。这里“已清理”也可能只是配置无需变化。 |
| 1725-1731 | OpenCode 清理列出三个可能配置文件。 |
| 1733-1740 | 逐文件处理；Node 缺失时告警并继续下一个，不中断卸载。 |
| 1742-1754 | JavaScript 定义 Pilot 条目标识、兼容字符串/数组 entry 的取值函数，以及简化 JSONC 去注释函数。它不是完整 JSONC 解析器，只覆盖代码列出的三类注释。 |
| 1755-1760 | 先按 JSON 解析；失败后剥注释重试并标记 `hadComments=true`。优先选择数组 `plugins`，否则数组 `plugin`，都不是数组则返回 nochange。 |
| 1762-1769 | 记录原长度，过滤 Pilot 条目；长度没变返回 nochange。原文件含注释时先备份 `.bak`，然后以标准 JSON 覆盖写入并输出不同结果。异常输出 stderr 并 exit 1，Shell 把结果改成 `error`。 |
| 1771-1783 | case 根据 cleaned、cleaned-bak、nochange、其他结果打印不同提示。`:` 让 nochange 静默成功。 |
| 1788-1797 | Pi 清理锁定单一 settings.json；文件不存在返回，Node 不存在只告警返回。 |
| 1799-1816 | JavaScript 识别两种 Pilot 标记，只处理数组 extensions，过滤字符串项并在长度变化时写回。异常转换成 Shell 的 `result=error`。 |
| 1818-1826 | 根据结果打印已清理、静默无变化或手工清理警告。 |

### 25.9 第 1831-1970 行：卸载和主分发

| 行号 | 逐行含义 |
|------|----------|
| 1831-1843 | `cmd_uninstall` 先尝试 PATH 中的管理命令 stop，其次用户级绝对路径。两者都不可用才进入手工分支；stop 失败都忽略。 |
| 1844-1851 | 手工分支若有 PID 文件，读 PID、发送 TERM、固定等 2 秒、再无条件尝试 KILL，最后删 PID 文件。这里第二次 kill 前不再探活。 |
| 1853-1863 | macOS 手工清理 collector/updater 两个 LaunchAgent：存在就 `launchctl unload -w` 并删除 plist；错误被忽略。 |
| 1864-1876 | Linux 获取当前用户名。用户级 service 文件存在时，disable/stop collector 和 updater、删除 unit 文件并 daemon-reload。注意只用 collector service 文件是否存在作为进入条件。 |
| 1878-1887 | 构造带用户名的系统级 systemd unit，逐个用 sudo disable/stop 并删除；最后无条件 sudo daemon-reload。失败大多忽略。 |
| 1889-1902 | 构造两个 init.d 路径。存在时先 stop，再按系统可用命令用 chkconfig 或 update-rc.d 注销，最后 sudo 删除。`; fi` 等写在同一行只是压缩格式。 |
| 1903-1905 | 结束平台和 CLI fallback 分支，无论具体清理是否成功都打印“服务已停止”。 |
| 1907-1911 | 无条件 `rm -rf ~/.loongsuite-pilot`。默认 DATA_DIR 就在这里，因此默认配置和日志此时已经被删除。 |
| 1913-1918 | 删除用户 CLI；尝试删除 `/usr/local/bin` 链接，权限失败被忽略。 |
| 1920-1926 | 依次清理八类通用 JSON hooks、qodercli rc block、macOS QoderWork 环境/plist、Claude rc block。 |
| 1928-1931 | 清理 Claude/Codex 历史 OTel 插件。 |
| 1933-1940 | 分别清理 OpenCode plugin 和 Pi extension 配置。 |
| 1942-1952 | `PURGE=1` 时再删除 `$DATA_DIR`。否则打印保留提示；该提示仅对位于默认安装根目录之外的自定义 DATA_DIR 准确。 |
| 1953-1958 | 打印卸载完成分隔线并结束函数。没有对各 best-effort 清理结果做汇总。 |
| 1963-1966 | 这是脚本真正的执行入口。按 `COMMAND` 只调用 install、upgrade、uninstall 中一个函数。 |
| 1967-1970 | 理论兜底分支打印 usage 并退出 1；前面的解析逻辑通常不会生成其他 COMMAND。`esac` 结束脚本。 |

## 26. 建议的实际阅读顺序

第一次阅读不必机械地从第 1 行一路读到第 1970 行。更容易建立心智模型的顺序是：

1. 先看第 1963-1970 行，确认主分发入口。
2. 根据关心的命令阅读第 1454、1536 或 1831 行开始的主流程。
3. 主流程遇到函数调用，再跳到第 24 节表格对应的函数定义。
4. 遇到不熟悉的符号，回查第 22 节语法表。
5. 最后阅读第 20、21 节，确认文件副作用和当前实现边界。

如果要单步观察执行而不真正安装，可在隔离环境中使用：

```bash
bash -n deploy/installer-opensource.sh       # 只做语法检查，不执行
bash -x deploy/installer-opensource.sh ...   # 执行并把展开后的命令轨迹打印到 stderr
```

不要在生产 HOME 下用 `bash -x ... uninstall` 做学习实验，因为卸载流程包含多处 `rm -rf`。`-x` 也可能把命令行中的 AK 等敏感值打印出来，带凭据时不应启用。

