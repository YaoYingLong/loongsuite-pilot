#!/usr/bin/env bash
# Linux/macOS 的稳定运维 CLI，也是 systemd、launchd 和 init.d 最终调用的服务入口。
# 安装器把本文件复制到 `~/.local/bin/loongsuite-pilot`；start/stop/restart/status/info/rollback
# 管理服务和版本指针，而 `run`/`run-updater` 在前台 `exec` 稳定 daemon 垫片。
#
# 完整启动链：`start -> autostart_install -> 服务管理器 -> run -> collector-daemon.js
# -> versions/<current>/dist/index.js`。收到停止请求时先 SIGTERM 等待，再必要时 SIGKILL，
# 并清理 PID、自启动配置和遗留进程；Updater 的 collector-only 重启会避免杀死更新进程自身。
#
# Shebang 通过 PATH 寻找 Bash；严格模式让失败命令、未定义变量和管道中任一失败立即终止，
# 因此明确写出的 `|| true` 表示该步骤被设计为 best-effort，不应阻断整体清理/探测。
set -euo pipefail

# 数据目录保存运行状态，缓存目录固定保存版本与稳定脚本；两者可分别由环境变量覆盖。
DATA_DIR="${LOONGSUITE_PILOT_DATA_DIR:-$HOME/.loongsuite-pilot}"
CACHE_DIR="${LOONGSUITE_PILOT_CACHE_DIR:-$HOME/.loongsuite-pilot}"
# `BASH_SOURCE[0]` 指当前脚本自身（不同于可能被 shift 的 `$0` 参数），`cd && pwd` 得到绝对目录。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSIONS_DIR="$CACHE_DIR/versions"
CURRENT_FILE="$CACHE_DIR/current"
PREVIOUS_FILE="$CACHE_DIR/previous"
BOOTSTRAP_DIR="$CACHE_DIR/bin"
PACKAGE_DIR="$CACHE_DIR/package"
PID_FILE="$DATA_DIR/loongsuite-pilot.pid"
UPDATER_PID_FILE="$DATA_DIR/loongsuite-pilot-updater.pid"
LOG_DIR="$DATA_DIR/logs"
LOG_FILE="$LOG_DIR/loongsuite-pilot-service.log"
UPDATER_LOG_FILE="$LOG_DIR/loongsuite-pilot-updater.log"
MONITOR_LOG_FILE="$LOG_DIR/loongsuite-pilot-monitor-process.log"
DASHBOARD_LOG_FILE="$LOG_DIR/loongsuite-pilot-dashboard.log"
CONFIG_FILE="$DATA_DIR/config.json"
SPAN_ATTR_FILE="$DATA_DIR/span-attributes.json"
MONITOR_PID_FILE="$DATA_DIR/loongsuite-pilot-monitor.pid"
DASHBOARD_PID_FILE="$DATA_DIR/loongsuite-pilot-dashboard.pid"
MONITOR_DATA_DIR="$LOG_DIR/process-monitor"

SERVICE_LABEL="com.loongsuite-pilot"
UPDATER_LABEL="com.loongsuite-pilot.updater"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/${SERVICE_LABEL}.plist"
UPDATER_PLIST="$HOME/Library/LaunchAgents/${UPDATER_LABEL}.plist"
SYSTEMD_SYSTEM_UNIT_DIR="/etc/systemd/system"
LOONGSUITE_PILOT_BIN="$HOME/.local/bin/loongsuite-pilot"
INIT_TYPE_FILE="$DATA_DIR/init-type"

# 校验 CLI 未被错误地以 root/sudo 运行，避免操作其他用户的服务和目录。
validate_current_user() {
    # `whoami` 的输出目前只用于触发系统账户解析/诊断；函数失败会受 `set -e` 约束。
    whoami
}

# 只读判断 has_sudo_interactive 对应条件，以 Shell 退出码 0/非 0 表示真/假。
has_sudo_interactive() {
    # 等于0表示root用户直接退出返回true
    [ "$(id -u)" -eq 0 ] && return 0
    if sudo -n true 2>/dev/null; then
        # 非交互模式检测：校验当前用户是否拥有免密 sudo 权限，返回true
        return 0
    elif sudo -v 2>/dev/null; then
        # 刷新/延长当前已有的 sudo 密码凭证缓存，不执行任何程序，返回true
        return 0
    else
        return 1
    fi
}

# 只读判断 has_sudo_noninteractive 对应条件，以 Shell 退出码 0/非 0 表示真/假。
has_sudo_noninteractive() {
    [ "$(id -u)" -eq 0 ] && return 0
    sudo -n true 2>/dev/null
}

# 执行需要特权的命令，仅在确有必要时提权。
# 当前为 root 时直接执行，因为容器镜像可能没有 sudo，且 root 再 sudo 没有意义；非 root 时加
# sudo 前缀，此入口允许交互式提权。
maybe_sudo() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    else
        sudo "$@"
    fi
}

# 只读检查使用的非交互变体，绝不能因密码提示阻塞。
maybe_sudo_n() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    else
        sudo -n "$@"
    fi
}

# 按兼容顺序解析 resolve_user_home 所需路径或版本，失败时返回空值供调用方回退。
resolve_user_home() {
    local user="$1"
    if command -v getent &>/dev/null; then
        # passwd 行以冒号分隔，第 6 列是 home；管道任一命令失败会因 pipefail 返回非零。
        getent passwd "$user" 2>/dev/null | cut -d: -f6
    else
        # 非 Linux/macOS 缺少 getent 时使用 Shell 的 `~用户名` 展开作为兼容回退。
        eval echo "~$user" 2>/dev/null
    fi
}

# 如果$HOME/.loongsuite-pilot/logs目录不存在就创建目录, 如果$HOME/.loongsuite-pilot/bin目录不存在就创建目录
ensure_dirs() {
    # 如果$HOME/.loongsuite-pilot/logs目录不存在就创建目录
    mkdir -p "$LOG_DIR"
    # 如果$HOME/.loongsuite-pilot/bin目录不存在就创建目录
    mkdir -p "$BOOTSTRAP_DIR"
}

# 将$HOME/.loongsuite-pilot/versions/1.0.0_d066770/scripts/collector-daemon.js脚本拷贝到$HOME/.loongsuite-pilot/bin目录
# 将$HOME/.loongsuite-pilot/versions/1.0.0_d066770/scripts/updater-daemon.js脚本拷贝到$HOME/.loongsuite-pilot/bin目录
sync_bootstrap_scripts() {
    local version_dir
    # 判断$HOME/.loongsuite-pilot/versions/1.0.0_d066770目录是否存在，存在就是赋值给version_dir
    version_dir=$(resolve_current_version 2>/dev/null) || true
    # 如果变量 version_dir 是空字符串 / 未定义，直接退出当前函数，不再执行函数后面所有代码
    if [ -z "$version_dir" ]; then return; fi
    local src_dir="$version_dir/scripts"
    # 如果$HOME/.loongsuite-pilot/versions/1.0.0_d066770/scripts/collector-daemon.js脚本文件不存在直接退出当前函数，不再执行函数后面所有代码
    if [ ! -f "$src_dir/collector-daemon.js" ]; then return; fi
    # 如果$HOME/.loongsuite-pilot/bin目录不存在就创建
    mkdir -p "$BOOTSTRAP_DIR"
    # 将$HOME/.loongsuite-pilot/versions/1.0.0_d066770/scripts/collector-daemon.js脚本拷贝到$HOME/.loongsuite-pilot/bin目录
    cp -f "$src_dir/collector-daemon.js" "$BOOTSTRAP_DIR/"
    # 将$HOME/.loongsuite-pilot/versions/1.0.0_d066770/scripts/updater-daemon.js脚本拷贝到$HOME/.loongsuite-pilot/bin目录
    # 开源包可能刻意不含 updater-daemon.js；此复制失败被设计为非致命，Collector 仍可运行。
    cp -f "$src_dir/updater-daemon.js"   "$BOOTSTRAP_DIR/" 2>/dev/null || true
}

# 确保 sync_installed_scripts_from_version 所需目录或稳定脚本与 current 版本一致。
sync_installed_scripts_from_version() {
    local version_dir="$1"
    local src_dir="$version_dir/scripts"
    # 回滚/升级只有在三份稳定入口齐全时才切换，避免 current 已变但服务入口只更新一半。
    if [ ! -f "$src_dir/collector-daemon.js" ] || [ ! -f "$src_dir/updater-daemon.js" ] || [ ! -f "$src_dir/loongsuite-pilot.sh" ]; then
        return 1
    fi

    mkdir -p "$BOOTSTRAP_DIR"
    # 先复制到同目录 `.tmp` 再 mv，使服务管理器读取时看不到半写脚本。
    cp -f "$src_dir/collector-daemon.js" "$BOOTSTRAP_DIR/collector-daemon.js.tmp"
    mv -f "$BOOTSTRAP_DIR/collector-daemon.js.tmp" "$BOOTSTRAP_DIR/collector-daemon.js"
    cp -f "$src_dir/updater-daemon.js" "$BOOTSTRAP_DIR/updater-daemon.js.tmp"
    mv -f "$BOOTSTRAP_DIR/updater-daemon.js.tmp" "$BOOTSTRAP_DIR/updater-daemon.js"

    mkdir -p "$(dirname "$LOONGSUITE_PILOT_BIN")"
    cp -f "$src_dir/loongsuite-pilot.sh" "$LOONGSUITE_PILOT_BIN.tmp"
    chmod 755 "$LOONGSUITE_PILOT_BIN.tmp"
    mv -f "$LOONGSUITE_PILOT_BIN.tmp" "$LOONGSUITE_PILOT_BIN"
}

# 只读判断 is_running 对应条件，以 Shell 退出码 0/非 0 表示真/假。
is_running() {
    # 如果$HOME/.loongsuite-pilot/loongsuite-pilot.pid文件存在
    if [ -f "$PID_FILE" ]; then
        local pid
        # 读取$HOME/.loongsuite-pilot/loongsuite-pilot.pid文件内容
        pid=$(cat "$PID_FILE")
        # 查看pid是否正在运行、进程存活，如果存在且在运行中直接退出
        # `kill -0` 不发送信号，只检测该 PID 是否存在且当前用户有权限操作。
        if kill -0 "$pid" 2>/dev/null; then
            # 命令退出码 = 0（true），退出码 ≠ 0（false）
            return 0
        fi
        # 如果存在直接删除$HOME/.loongsuite-pilot/loongsuite-pilot.pid文件
        rm -f "$PID_FILE"
    fi
    return 1
}

# 只读判断 is_pid_file_running 对应条件，以 Shell 退出码 0/非 0 表示真/假。
is_pid_file_running() {
    local pid_file="$1"
    if [ -f "$pid_file" ]; then
        local pid
        pid=$(cat "$pid_file" 2>/dev/null || true)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
        rm -f "$pid_file"
    fi
    return 1
}

# 读取 PID 文件发送 TERM，超时后 KILL，并只清理由该文件跟踪的进程。
stop_pid_file() {
    local pid_file="$1"
    if is_pid_file_running "$pid_file"; then
        local pid
        pid=$(cat "$pid_file")
        # 不带信号名的 kill 默认发送 SIGTERM，让 Node 有机会执行 stop()/flush()/checkpoint 清理。
        kill "$pid" 2>/dev/null || true
        local count=0
        while kill -0 "$pid" 2>/dev/null && [ $count -lt 10 ]; do
            sleep 1
            count=$((count + 1))
        done
        # 最多等待 10 秒；仍存活才用 SIGKILL，SIGKILL 无法运行 JavaScript 退出清理。
        if kill -0 "$pid" 2>/dev/null; then
            kill -9 "$pid" 2>/dev/null || true
        fi
    fi
    rm -f "$pid_file"
}

# 结合 Updater PID 文件和命令行匹配判断是否存在更新进程。
updater_process_exists() {
    if [ -f "$UPDATER_PID_FILE" ]; then
        local pid
        pid=$(cat "$UPDATER_PID_FILE" 2>/dev/null || true)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            local command_line
            command_line=$(ps -p "$pid" -o command= 2>/dev/null || true)
            # PID 可能被系统复用，必须再核对命令行确实属于 Updater，不能仅信任 PID 文件。
            case "$command_line" in
                *updater-daemon.js*|*"/bin/updater-daemon"*|*"loongsuite-pilot run-updater"*|*"dist/updater/index.js"*)
                    return 0
                    ;;
            esac
        fi
    fi

    # PID 文件缺失/过期时以稳定 bootstrap 路径兜底查找孤儿 Updater。
    pgrep -f "loongsuite-pilot/bin/updater-daemon" >/dev/null 2>&1
}

# 只读判断 _node_is_suitable 对应条件，以 Shell 退出码 0/非 0 表示真/假。
_node_is_suitable() {
    local bin="$1"
    # 判断是否存在且可执行
    [ -x "$bin" ] || return 1
    _node_is_app_bundle "$bin" && return 1
    local ver
    # 命令替换捕获 stdout；Node 无法启动或版本输出异常都视为不适用。
    ver="$("$bin" --version 2>/dev/null)" || return 1
    local major="${ver#v}"
    major="${major%%.*}"
    [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 18 )) || return 1
    return 0
}

# 按兼容顺序解析 _resolve_realpath 所需路径或版本，失败时返回空值供调用方回退。
_resolve_realpath() {
    realpath "$1" 2>/dev/null || readlink -f "$1" 2>/dev/null || echo "$1"
}

# 只读判断 _node_is_app_bundle 对应条件，以 Shell 退出码 0/非 0 表示真/假。
_node_is_app_bundle() {
    local resolved
    resolved=$(_resolve_realpath "$1")
    # macOS GUI 应用内置 Node 可能依赖 bundle 环境，后台服务不应把它当稳定系统 runtime。
    case "$resolved" in
        /Applications/*.app/Contents/*|/System/Applications/*.app/Contents/*|"$HOME"/Applications/*.app/Contents/*)
            return 0
            ;;
    esac
    return 1
}

NODE_PIN_FILE="$CACHE_DIR/node-bin"

# 按 pin、版本管理器、常见安装路径和 PATH 依次寻找 Node.js 18+，并返回绝对路径。
resolve_node() {
  # 1. 优先读取已经固定的 Node 路径文件。
    # 判断$HOME/.loongsuite-pilot/node-bin文件是否存在，在安装时将node路径写入到该文件中了
    if [ -f "$NODE_PIN_FILE" ]; then
        local pinned
        # 读取$HOME/.loongsuite-pilot/node-bin文件文件中写入的node环境地址
        pinned=$(cat "$NODE_PIN_FILE" 2>/dev/null | tr -d '[:space:]')
        if [ -n "$pinned" ] && _node_is_suitable "$pinned"; then
            # 输出node环境的绝对路径
            echo "$pinned"
            return 0
        fi
    fi

    # 下面是又走了一遍installer-opensource.sh的check_deps的逻辑
  # 2. 降级搜索：用户管理的 Node 优先于应用随附的 PATH shim。
    local _candidates=()

  # nvm 版本按降序搜索，优先使用最新版本。
    # Bash glob 无匹配时可能保留字面量；后续 `_node_is_suitable -x` 会安全淘汰它。
    local _nvm_candidates=("$HOME/.nvm/versions/node"/*/bin/node)
    local i
    for (( i=${#_nvm_candidates[@]}-1; i>=0; i-- )); do
        _candidates+=("${_nvm_candidates[i]}")
    done

    # volta, fnm, homebrew, local
    _candidates+=(
        "$HOME/.volta/bin/node"
        "$HOME/.fnm/aliases/default/bin/node"
        /opt/homebrew/bin/node
        /usr/local/bin/node
        "$HOME/.local/bin/node"
    )

  # 最后才查 PATH，因为应用启动的 Shell 可能暴露应用内置而非用户期望的 Node runtime。
    if command -v node >/dev/null 2>&1; then
        _candidates+=("$(command -v node)")
    fi

    for candidate in "${_candidates[@]}"; do
        if _node_is_suitable "$candidate"; then
  # 自动修复：找到可用 Node 后更新固定路径文件。
            local resolved
            resolved=$(_resolve_realpath "$candidate")
            mkdir -p "$(dirname "$NODE_PIN_FILE")" 2>/dev/null || true
            # 自动修复 pin 失败不应阻止本次启动，当前已找到的 candidate 仍可直接返回。
            echo "$resolved" > "$NODE_PIN_FILE" 2>/dev/null || true
            echo "$candidate"
            return 0
        fi
    done
    return 1
}

# 在用户 systemd 不可用时检查可提权的 systemd-system 或传统 init.d。
_detect_system_level_init() {
    if [ -d /run/systemd/system ] && command -v systemctl &>/dev/null; then
        echo "systemd-system"
    elif [ -d /etc/init.d ]; then
        echo "initd"
    else
        echo "none"
    fi
}

# 确定当前环境应使用哪一种服务管理机制来注册、启动和管理 loongsuite-pilot 的 collector/updater
detect_init_system() {
    # 读取函数传入的第一个参数并赋值给interactive，如果没有传入第一个参数，或是第一个参数为空值，变量就自动取值为字符串true
    local interactive="${1:-true}"
    # 判断$HOME/.loongsuite-pilot/init-type文件是否存在
    # 优先复用安装时已验证的类型，避免非交互后台环境因 DBus/sudo 条件变化误选另一种机制。
    if [ -f "$INIT_TYPE_FILE" ]; then
        local saved
        # 读取$HOME/.loongsuite-pilot/init-type文件内容并去除空白
        saved=$(cat "$INIT_TYPE_FILE" 2>/dev/null | tr -d '[:space:]')
        # 如果是launchd|systemd-user|systemd-system|initd其中任何值就输出，并退出函数
        case "$saved" in
            launchd|systemd-user|systemd-system|initd)
                echo "$saved"
                return
                ;;
        esac
    fi
    # 判断当前系统类型
    case "$(uname -s)" in
        # 如果是macos直接输出launchd
        Darwin) echo "launchd" ;;
        Linux)
            if [ "$(id -u)" -eq 0 ]; then
                # 如果是linux且是root用户,
                #   如果存在/run/systemd/system且systemctl命令存在就返回systemd-system
                #   如果/etc/init.d文件存在就返回initd，如果两个都不存在，就返回none
                _detect_system_level_init
            else
                # systemctl --user show-environment读取当前登录用户专属的 systemd 运行环境变量，无用户systemd进程时，该命令会报错退出
                if command -v systemctl &>/dev/null && systemctl --user show-environment &>/dev/null 2>&1; then
                    # 检测当前会话是否支持 systemctl --user 用户级 systemd 服务
                    echo "systemd-user"
                # 交互命令允许刷新 sudo 凭据；后台自修复路径只允许免密 sudo，绝不弹密码提示。
                elif [ "$interactive" = "true" ] && has_sudo_interactive; then
                    # 如果是root用户，或者具有root权限
                    #   如果存在/run/systemd/system且systemctl命令存在就返回systemd-system
                    #   如果/etc/init.d文件存在就返回initd，如果两个都不存在，就返回none
                    _detect_system_level_init
                elif [ "$interactive" = "false" ] && has_sudo_noninteractive; then
                    # 如果是root用户，或者具有root权限
                    #   如果存在/run/systemd/system且systemctl命令存在就返回systemd-system
                    #   如果/etc/init.d文件存在就返回initd，如果两个都不存在，就返回none
                    _detect_system_level_init
                else
                    echo "none"
                fi
            fi
            ;;
        *) echo "none" ;;
    esac
}

# best-effort 启用 systemd user linger，使用户注销后 Collector 仍能运行。
enable_linger() {
    local user
    user="$(whoami)"
    # 开启该用户的 ** lingering（滞留常驻）特性
    if loginctl enable-linger "$user" 2>/dev/null; then
        echo "✓ Linger enabled — service will persist after logout."
        return 0
    else
        echo "⚠️  Cannot enable linger (requires polkit policy or root privilege)." >&2
        echo "   Service may stop when you log out." >&2
        echo "   To fix: run 'sudo loginctl enable-linger $user'." >&2
        return 1
    fi
}

# 只读判断 is_managed_by_launchd 对应条件，以 Shell 退出码 0/非 0 表示真/假。
is_managed_by_launchd() {
    [ -f "$LAUNCHD_PLIST" ] && launchctl list "$SERVICE_LABEL" &>/dev/null
}

# 只读判断 is_managed_by_systemd_user 对应条件，以 Shell 退出码 0/非 0 表示真/假。
is_managed_by_systemd_user() {
    systemctl --user is-enabled loongsuite-pilot.service &>/dev/null
}

# 只读判断 is_managed_by_systemd_system 对应条件，以 Shell 退出码 0/非 0 表示真/假。
is_managed_by_systemd_system() {
    local user
    user=$(whoami)
    local unit_name="loongsuite-pilot-${user}.service"
    [ -f "/etc/systemd/system/$unit_name" ] && maybe_sudo_n systemctl is-enabled "$unit_name" &>/dev/null
}

# 只读判断 is_managed_by_initd 对应条件，以 Shell 退出码 0/非 0 表示真/假。
is_managed_by_initd() {
    local user
    user=$(whoami)
    [ -f "/etc/init.d/loongsuite-pilot-${user}" ]
}



# 按兼容顺序解析 resolve_current_version 所需路径或版本，失败时返回空值供调用方回退。
resolve_current_version() {
    # 判断$HOME/.loongsuite-pilot/current文件是否存在
    if [ -f "$CURRENT_FILE" ]; then
        local dir
        # 读取$HOME/.loongsuite-pilot/current文件内容
        # current 文件只存版本目录名；去掉所有空白后再拼到受控的 VERSIONS_DIR 下。
        dir=$(cat "$CURRENT_FILE" 2>/dev/null | tr -d '[:space:]')
        # 判断$HOME/.loongsuite-pilot/versions/1.0.0_d066770目录是否存在, 存在就是输入日志
        if [ -n "$dir" ] && [ -d "$VERSIONS_DIR/$dir" ]; then
            echo "$VERSIONS_DIR/$dir"
            return 0
        fi
    fi
    # 兼容老版本$HOME/.loongsuite-pilot/package的逻辑
    if [ -d "$PACKAGE_DIR" ] && [ -f "$PACKAGE_DIR/dist/index.js" ]; then
        echo "$PACKAGE_DIR"
        return 0
    fi
    return 1
}

# 按兼容顺序解析 resolve_previous_version 所需路径或版本，失败时返回空值供调用方回退。
resolve_previous_version() {
    if [ -f "$PREVIOUS_FILE" ]; then
        local dir
        dir=$(cat "$PREVIOUS_FILE" 2>/dev/null | tr -d '[:space:]')
        if [ -n "$dir" ] && [ -d "$VERSIONS_DIR/$dir" ]; then
            echo "$VERSIONS_DIR/$dir"
            return 0
        fi
    fi
    return 1
}

# 按兼容顺序解析 resolve_script 所需路径或版本，失败时返回空值供调用方回退。
resolve_script() {
    local script_name="$1"
    local version_dir
    version_dir=$(resolve_current_version 2>/dev/null) || true
    # 顺序为当前多版本布局、旧 package 布局、源码仓库布局，首个存在文件即返回。
    for base in "$version_dir" "$PACKAGE_DIR" "$(dirname "$SCRIPT_DIR")"; do
        if [ -n "$base" ] && [ -f "$base/scripts/$script_name" ]; then
            echo "$base/scripts/$script_name"
            return 0
        fi
    done
    return 1
}

# ---- 内部入口：以前台方式运行，供 launchd/systemd 管理。 ----

# 设置配置路径和 PID 后以前台 exec 方式启动稳定 Collector daemon，供服务管理器调用。
cmd_run() {
    # 如果$HOME/.loongsuite-pilot/logs目录不存在就创建目录, 如果$HOME/.loongsuite-pilot/bin目录不存在就创建目录
    ensure_dirs
    # 将$HOME/.loongsuite-pilot/versions/1.0.0_d066770/scripts/collector-daemon.js脚本拷贝到$HOME/.loongsuite-pilot/bin目录
    # 将$HOME/.loongsuite-pilot/versions/1.0.0_d066770/scripts/updater-daemon.js脚本拷贝到$HOME/.loongsuite-pilot/bin目录
    sync_bootstrap_scripts

    # 判断$HOME/.loongsuite-pilot/bin/collector-daemon.js文件是否存在，不存在直接退出
    if [ ! -f "$BOOTSTRAP_DIR/collector-daemon.js" ]; then
        echo "❌ Bootstrap script missing" >&2
        exit 1
    fi

    # 获取node环境
    local node_bin
    node_bin=$(resolve_node) || {
        echo "❌ node runtime not found" >&2
        exit 1
    }

    # 将当前执行 loongsuite-pilot.sh 的 Shell 进程 PID覆盖写入$HOME/.loongsuite-pilot/loongsuite-pilot.pid文件
    # `$$` 是当前 Shell PID；紧接着 exec 会让 Node 替换同一进程，因此 PID 在替换后仍有效。
    echo "$$" > "$PID_FILE"
    # 导出环境变量$HOME/.loongsuite-pilot/config.json
    export AGENT_DATA_COLLECTION_CONFIG="$CONFIG_FILE"
    # 执行$HOME/.loongsuite-pilot/bin/collector-daemon.js脚本，即scripts/collector-daemon.js
    # `exec` 不创建额外子进程，服务管理器的信号会直接送达 daemon/Collector。
    exec "$node_bin" "$BOOTSTRAP_DIR/collector-daemon.js"
}

# 以前台 exec 方式启动稳定 Updater daemon，供独立服务单元调用。
cmd_run_updater() {
    ensure_dirs
    sync_bootstrap_scripts

    # 开源安装通常没有 Updater；以 0 退出表示“可选组件不存在”，不让服务反复失败重启。
    if [ ! -f "$BOOTSTRAP_DIR/updater-daemon.js" ]; then
        exit 0
    fi

    local node_bin
    node_bin=$(resolve_node) || {
        echo "❌ node runtime not found" >&2
        exit 1
    }

    echo "$$" > "$UPDATER_PID_FILE"
    export AGENT_DATA_COLLECTION_CONFIG="$CONFIG_FILE"
    exec "$node_bin" "$BOOTSTRAP_DIR/updater-daemon.js"
}

# ---- 面向用户的命令实现。 ----

# 同步稳定脚本、注册合适的自启动机制并启动 Collector/可选 Updater。
cmd_start() {
    # 遍历传入的参数列表
    for arg in "$@"; do
        case "$arg" in
            --system-service)
                echo "⚠️  --system-service is deprecated and ignored. Auto-detection is now the default." >&2
                ;;
        esac
    done

    # 如果$HOME/.loongsuite-pilot/loongsuite-pilot.pid中的进程id在运行中，直接输出日志，返回true
    if is_running; then
        echo "✅ loongsuite-pilot is already running (PID $(cat "$PID_FILE"))"
        # 命令退出码 = 0（true），退出码 ≠ 0（false）
        return 0
    fi

    # 如果$HOME/.loongsuite-pilot/logs目录不存在就创建目录
    # 如果$HOME/.loongsuite-pilot/bin目录不存在就创建目录
    ensure_dirs
    # 将$HOME/.loongsuite-pilot/versions/1.0.0_d066770/scripts/collector-daemon.js脚本拷贝到$HOME/.loongsuite-pilot/bin目录
    # 将$HOME/.loongsuite-pilot/versions/1.0.0_d066770/scripts/updater-daemon.js脚本拷贝到$HOME/.loongsuite-pilot/bin目录
    sync_bootstrap_scripts
    # 执行autostart_install函数
    # 这里的核心作用就是将loongsuite-pilot.sh run注册成系统服务，用户登录开机自启，程序崩溃会被自动重启，并启动执行loongsuite-pilot.sh run
    # `true` 表示用户主动执行 start，可在需要 system-level 服务时交互获取 sudo。
    if autostart_install "true"; then
        sleep 2
        if is_running; then
            local init_type
            init_type=$(cat "$INIT_TYPE_FILE" 2>/dev/null | tr -d '[:space:]')
            # 输出日志，并显示是哪一种服务管理机制来注册、启动和管理loongsuite-pilot的
            echo "✅ loongsuite-pilot started ($init_type)"
            return 0
        fi
        local init_type
        init_type=$(cat "$INIT_TYPE_FILE" 2>/dev/null | tr -d '[:space:]')
        echo "⚠️  Service registered (${init_type:-unknown}) but collector process not found after 2s. Check logs: $LOG_FILE" >&2
        echo "   Autostart is configured; the service manager will keep retrying." >&2
        # 注册成功但 2 秒内尚未观察到 PID 仍返回成功，因为服务管理器会按 Restart 策略继续拉起。
        return 0
    fi

    echo "❌ Failed to register system service." >&2
    echo "   No supported init system could be configured." >&2
    case "$(uname -s)" in
        Linux)
            echo "   Tried: systemd-user, systemd-system, init.d" >&2
            echo "   Possible causes:" >&2
            echo "     - No systemd user session (XDG_RUNTIME_DIR not set)" >&2
            echo "     - No sudo access for system-level service" >&2
            echo "     - Container without init system or /etc/init.d" >&2
            ;;
    esac
    exit 1
}

# 移除自启动、发送 TERM 等待退出，必要时 KILL，并清理 PID 与遗留进程。
cmd_stop() {
    # monitor 是附属进程，先停它可避免 Collector 清理期间 Dashboard 继续读取变化中的状态文件。
    cmd_monitor_stop >/dev/null 2>&1 || true
    # autostart_remove 先 disable/unload，防止下面发送 SIGTERM 后服务管理器立即重新拉起。
    autostart_remove 2>/dev/null || true

    local target_user
    target_user=$(whoami)
    local init_type=""
    if [ -f "$INIT_TYPE_FILE" ]; then
        init_type=$(cat "$INIT_TYPE_FILE" 2>/dev/null | tr -d '[:space:]')
    fi

    case "$(uname -s)" in
        Darwin)
            launchctl stop "$SERVICE_LABEL" 2>/dev/null || true
            launchctl stop "$UPDATER_LABEL" 2>/dev/null || true
            ;;
        Linux)
            case "$init_type" in
                systemd-user)
                    systemctl --user stop loongsuite-pilot.service &>/dev/null || true
                    systemctl --user stop loongsuite-pilot-updater.service &>/dev/null || true
                    ;;
                systemd-system|systemd)
                    maybe_sudo systemctl stop "loongsuite-pilot-${target_user}.service" &>/dev/null || true
                    maybe_sudo systemctl stop "loongsuite-pilot-updater-${target_user}.service" &>/dev/null || true
                    ;;
                initd)
                    [ -f "/etc/init.d/loongsuite-pilot-${target_user}" ] && maybe_sudo "/etc/init.d/loongsuite-pilot-${target_user}" stop &>/dev/null || true
                    [ -f "/etc/init.d/loongsuite-pilot-updater-${target_user}" ] && maybe_sudo "/etc/init.d/loongsuite-pilot-updater-${target_user}" stop &>/dev/null || true
                    ;;
            esac
            ;;
    esac

  # 先停止 PID 文件明确记录的进程。
    if is_running; then
        local pid
        pid=$(cat "$PID_FILE")
        kill "$pid" 2>/dev/null || true
        local count=0
        while kill -0 "$pid" 2>/dev/null && [ $count -lt 10 ]; do
            sleep 1
            count=$((count + 1))
        done
        if kill -0 "$pid" 2>/dev/null; then
            kill -9 "$pid" 2>/dev/null || true
        fi
    fi

  # 停止 Updater PID 文件记录的进程。
    stop_pid_file "$UPDATER_PID_FILE"

  # 再清理没有被 PID 文件覆盖的残留孤儿进程。
    # `pkill -f` 匹配完整命令行，作为 PID 文件未覆盖进程的兜底；误匹配风险由稳定路径片段控制。
    pkill -f "loongsuite-pilot/bin/collector-daemon" 2>/dev/null || true
    pkill -f "loongsuite-pilot/bin/updater-daemon" 2>/dev/null || true

    rm -f "$PID_FILE"
    echo "✅ loongsuite-pilot stopped"
}

# 后台启动 Shell 资源采样器、记录 PID，并避免重复实例。
cmd_process_monitor_start() {
    if is_pid_file_running "$MONITOR_PID_FILE"; then
        echo "✅ loongsuite-pilot process monitor is already running (PID $(cat "$MONITOR_PID_FILE"))"
        return 0
    fi

    ensure_dirs
    local script
    script=$(resolve_script "monitor-loongsuite-pilot.sh") || {
        echo "❌ monitor script missing"
        exit 1
    }

    # nohup 使采样器不随当前终端关闭；`>> ... 2>&1` 把 stdout/stderr 都追加到同一日志。
    nohup bash "$script" >> "$MONITOR_LOG_FILE" 2>&1 &
    # `$!` 是最近一个后台命令 PID，必须紧接 nohup 保存，避免被其他后台任务覆盖。
    echo "$!" > "$MONITOR_PID_FILE"
    echo "✅ loongsuite-pilot process monitor started (PID $!)"
}

# 停止采样器 PID 并清理监控状态文件。
cmd_process_monitor_stop() {
    stop_pid_file "$MONITOR_PID_FILE"
    pkill -f "monitor-loongsuite-pilot\.sh" 2>/dev/null || true
    echo "✅ loongsuite-pilot process monitor stopped"
}

# 后台启动本地 Dashboard HTTP server，写 PID/日志并检查早期退出。
cmd_dashboard_start() {
    if is_pid_file_running "$DASHBOARD_PID_FILE"; then
        echo "✅ loongsuite-pilot dashboard is already running (PID $(cat "$DASHBOARD_PID_FILE"))"
        return 0
    fi

    ensure_dirs
    local script node_bin
    script=$(resolve_script "serve-loongsuite-pilot-monitor.mjs") || {
        echo "❌ dashboard script missing"
        exit 1
    }
    node_bin=$(resolve_node) || {
        echo "❌ node runtime not found" >&2
        exit 1
    }

    # HTTP server 绑定地址/端口由其自身环境变量决定；这里仅负责脱离终端并记录 PID。
    nohup "$node_bin" "$script" >> "$DASHBOARD_LOG_FILE" 2>&1 &
    echo "$!" > "$DASHBOARD_PID_FILE"
    echo "✅ loongsuite-pilot dashboard started (PID $!)"
    echo "   open http://127.0.0.1:${LOONGSUITE_PILOT_MONITOR_PORT:-8765}/"
}

# 停止 Dashboard HTTP 进程并清理 PID 文件。
cmd_dashboard_stop() {
    stop_pid_file "$DASHBOARD_PID_FILE"
    pkill -f "serve-loongsuite-pilot-monitor\.mjs" 2>/dev/null || true
    echo "✅ loongsuite-pilot dashboard stopped"
}

# 依次启动资源采样器和 Dashboard，形成完整 monitor 功能。
cmd_monitor_start() {
    # `set -e` 下采样器启动失败会阻止 Dashboard 启动，避免显示缺少资源指标的半成品监控。
    cmd_process_monitor_start
    cmd_dashboard_start
    echo "✅ loongsuite-pilot monitor is running"
    echo "   dashboard: http://127.0.0.1:${LOONGSUITE_PILOT_MONITOR_PORT:-8765}/"
}

# 依次停止 Dashboard 与资源采样器，允许组件已停止。
cmd_monitor_stop() {
    cmd_dashboard_stop
    cmd_process_monitor_stop
    echo "✅ loongsuite-pilot monitor stopped"
}

  # 只重启 Collector；Updater 部署新版本后使用此入口。
cmd_restart_collector() {
    local target_user
    target_user=$(whoami)
    local sys_unit="loongsuite-pilot-${target_user}.service"
    local initd_script="/etc/init.d/loongsuite-pilot-${target_user}"
    local init_type=""
    if [ -f "$INIT_TYPE_FILE" ]; then
        init_type=$(cat "$INIT_TYPE_FILE" 2>/dev/null | tr -d '[:space:]')
    fi

  # 只停止 Collector，保持 Updater 继续运行。
    case "$(uname -s)" in
        Darwin)
            launchctl stop "$SERVICE_LABEL" 2>/dev/null || true
            ;;
        Linux)
            case "$init_type" in
                systemd-user)
                    systemctl --user stop loongsuite-pilot.service &>/dev/null || true
                    ;;
                systemd-system|systemd)
                    maybe_sudo systemctl stop "$sys_unit" &>/dev/null || true
                    ;;
                initd)
                    [ -f "$initd_script" ] && maybe_sudo "$initd_script" stop &>/dev/null || true
                    ;;
            esac
            ;;
    esac
    pkill -f "loongsuite-pilot/bin/collector-daemon" 2>/dev/null || true

    if is_running; then
        local pid
        pid=$(cat "$PID_FILE")
        kill "$pid" 2>/dev/null || true
        local count=0
        while kill -0 "$pid" 2>/dev/null && [ $count -lt 10 ]; do
            sleep 1
            count=$((count + 1))
        done
        if kill -0 "$pid" 2>/dev/null; then
            kill -9 "$pid" 2>/dev/null || true
        fi
        rm -f "$PID_FILE"
    fi

    sleep 1

    ensure_dirs
    sync_bootstrap_scripts

    local _restarted=false
    case "$(uname -s)" in
        Darwin)
            if launchctl list "$SERVICE_LABEL" &>/dev/null; then
                launchctl start "$SERVICE_LABEL" 2>/dev/null || true
                echo "✅ collector restarted (launchd)"
                _restarted=true
            fi
            ;;
        Linux)
            case "$init_type" in
                systemd-user)
                    if systemctl --user is-enabled loongsuite-pilot.service &>/dev/null; then
                        systemctl --user start loongsuite-pilot.service &>/dev/null
                        echo "✅ collector restarted (systemd user-level)"
                        _restarted=true
                    fi
                    ;;
                systemd-system|systemd)
                    if [ -f "$SYSTEMD_SYSTEM_UNIT_DIR/$sys_unit" ] && maybe_sudo_n systemctl is-enabled "$sys_unit" &>/dev/null; then
                        maybe_sudo systemctl start "$sys_unit" &>/dev/null
                        echo "✅ collector restarted (systemd system-level)"
                        _restarted=true
                    fi
                    ;;
                initd)
                    if [ -f "$initd_script" ]; then
                        maybe_sudo "$initd_script" start &>/dev/null
                        echo "✅ collector restarted (init.d)"
                        _restarted=true
                    fi
                    ;;
            esac
            ;;
    esac
    if [ "$_restarted" = true ]; then
        sleep 1
        if ! is_running; then
            echo "⚠️  service manager reported success but collector process not found"
            _restarted=false
        fi
    fi
    if [ "$_restarted" = false ]; then
  # 自修复：对退化为 nohup/unknown 的安装尝试注册正式系统服务。
        case "$init_type" in
            nohup|unknown|"")
                local _new_init
                _new_init=$(detect_init_system "false")
                if [ "$_new_init" != "none" ]; then
                    if autostart_install_collector_only "false" 2>>"$LOG_FILE"; then
                        sleep 1
                        if is_running; then
                            echo "✅ collector self-healed: registered as $_new_init"
                            _restarted=true
                        else
                            echo "⚠️  collector self-heal registered ($_new_init) but process not found" >&2
                        fi
                    fi
                fi
                if [ "$_restarted" = false ]; then
                    local entry="$BOOTSTRAP_DIR/collector-daemon.js"
                    if [ ! -f "$entry" ]; then
                        echo "❌ Bootstrap script missing"
                        exit 1
                    fi
                    local node_bin
                    node_bin=$(resolve_node) || {
                        echo "❌ node runtime not found" >&2
                        exit 1
                    }
                    export AGENT_DATA_COLLECTION_CONFIG="$CONFIG_FILE"
                    nohup "$node_bin" "$entry" >> "$LOG_FILE" 2>&1 &
                    echo "$!" > "$PID_FILE"
                    echo "⚠️  collector restarted (nohup fallback, self-heal failed)"
                fi
                ;;
            *)
                echo "❌ Service manager failed to restart collector (init_type=$init_type)" >&2
                exit 1
                ;;
        esac
    fi

    if ! is_running; then
        echo "❌ collector process not found after restart" >&2
        exit 1
    fi

  # 在新的进程组中安排 Updater 重启，避免停止旧 Updater 的 launchctl/systemctl 命令顺带杀死该子进程。
    local _restart_bin="$LOONGSUITE_PILOT_BIN"
    local _restart_log="$UPDATER_LOG_FILE"
    if command -v setsid &>/dev/null; then
        setsid bash -c 'sleep 10 && "$0" restart-updater' "$_restart_bin" >> "$_restart_log" 2>&1 &
    else
        perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' -- bash -c 'sleep 10 && "$0" restart-updater' "$_restart_bin" >> "$_restart_log" 2>&1 &
    fi
}

# 独立停止并重启 Updater，避免与 Collector 生命周期耦合。
cmd_restart_updater() {
    local target_user
    target_user=$(whoami)
    local sys_unit="loongsuite-pilot-updater-${target_user}.service"
    local initd_script="/etc/init.d/loongsuite-pilot-updater-${target_user}"
    local init_type=""
    if [ -f "$INIT_TYPE_FILE" ]; then
        init_type=$(cat "$INIT_TYPE_FILE" 2>/dev/null | tr -d '[:space:]')
    fi

  # 通过当前服务管理器停止 Updater。
    case "$(uname -s)" in
        Darwin)
            launchctl stop "$UPDATER_LABEL" 2>/dev/null || true
            ;;
        Linux)
            case "$init_type" in
                systemd-user)
                    systemctl --user stop loongsuite-pilot-updater.service &>/dev/null || true
                    ;;
                systemd-system|systemd)
                    maybe_sudo systemctl stop "$sys_unit" &>/dev/null || true
                    ;;
                initd)
                    [ -f "$initd_script" ] && maybe_sudo "$initd_script" stop &>/dev/null || true
                    ;;
            esac
            ;;
    esac
    pkill -f "loongsuite-pilot/bin/updater-daemon" 2>/dev/null || true
    stop_pid_file "$UPDATER_PID_FILE"

    sleep 1

    ensure_dirs
    sync_bootstrap_scripts

  # 通过当前服务管理器启动 Updater。
    local _restarted=false
    case "$(uname -s)" in
        Darwin)
            if launchctl list "$UPDATER_LABEL" &>/dev/null; then
                launchctl start "$UPDATER_LABEL" 2>/dev/null || true
                _restarted=true
            fi
            ;;
        Linux)
            case "$init_type" in
                systemd-user)
                    if systemctl --user is-enabled loongsuite-pilot-updater.service &>/dev/null; then
                        systemctl --user start loongsuite-pilot-updater.service &>/dev/null
                        echo "✅ updater restarted (systemd user-level)"
                        _restarted=true
                    fi
                    ;;
                systemd-system|systemd)
                    if [ -f "$SYSTEMD_SYSTEM_UNIT_DIR/$sys_unit" ] && maybe_sudo_n systemctl is-enabled "$sys_unit" &>/dev/null; then
                        maybe_sudo systemctl start "$sys_unit" &>/dev/null
                        echo "✅ updater restarted (systemd system-level)"
                        _restarted=true
                    fi
                    ;;
                initd)
                    if [ -f "$initd_script" ]; then
                        maybe_sudo "$initd_script" start &>/dev/null
                        echo "✅ updater restarted (init.d)"
                        _restarted=true
                    fi
                    ;;
            esac
            ;;
    esac
  # 验证服务管理器确实创建了 Updater 进程。
    if [ "$_restarted" = true ]; then
        sleep 1
        if ! updater_process_exists; then
            echo "⚠️  service manager reported success but updater process not found"
            _restarted=false
        fi
    fi
    if [ "$_restarted" = false ]; then
  # 自修复：对退化安装尝试补注册正式服务。
        case "$init_type" in
            nohup|unknown|"")
                local _new_init
                _new_init=$(detect_init_system "false")
                if [ "$_new_init" != "none" ]; then
                    if autostart_install_updater_only "false" 2>>"$UPDATER_LOG_FILE"; then
                        sleep 1
                        if updater_process_exists; then
                            echo "✅ updater self-healed: registered as $_new_init"
                            _restarted=true
                        else
                            echo "⚠️  updater self-heal registered ($_new_init) but process not found" >&2
                        fi
                    fi
                fi
                if [ "$_restarted" = false ]; then
                    local entry="$BOOTSTRAP_DIR/updater-daemon.js"
                    if [ ! -f "$entry" ]; then
                        echo "❌ Updater bootstrap script missing"
                        return 1
                    fi
                    local node_bin
                    node_bin=$(resolve_node) || {
                        echo "❌ node runtime not found" >&2
                        return 1
                    }
                    export AGENT_DATA_COLLECTION_CONFIG="$CONFIG_FILE"
                    nohup "$node_bin" "$entry" >> "$UPDATER_LOG_FILE" 2>&1 &
                    echo "$!" > "$UPDATER_PID_FILE"
                    echo "⚠️  updater restarted (nohup fallback, self-heal failed)"
                fi
                ;;
            *)
                echo "❌ Service manager failed to restart updater (init_type=$init_type)" >&2
                return 1
                ;;
        esac
    fi

    if ! updater_process_exists; then
        echo "❌ updater process not found after restart" >&2
        return 1
    fi
}

# 按 stop 后 start 的顺序完整重启 Collector 和可选 Updater。
cmd_restart() {
    cmd_stop
    sleep 1
    cmd_start
}

# 综合 PID 和服务管理器状态输出 Collector、Updater 与自启动健康信息。
cmd_status() {
    local ver_info=""
    local version_dir
    version_dir=$(resolve_current_version) || true
    if [ -n "$version_dir" ] && [ -f "$version_dir/VERSION" ]; then
        local v; v=$(grep '^version=' "$version_dir/VERSION" | cut -d= -f2)
        local c; c=$(grep '^git_commit=' "$version_dir/VERSION" | cut -d= -f2)
        ver_info=" v${v} (${c})"
    fi

    if is_running; then
        local pid
        pid=$(cat "$PID_FILE")
        echo "✅ loongsuite-pilot${ver_info} is running (PID $pid)"
    else
        echo "⚪ loongsuite-pilot${ver_info} is not running"
    fi
    if is_pid_file_running "$UPDATER_PID_FILE"; then
        echo "   updater: running (PID $(cat "$UPDATER_PID_FILE"))"
    else
        echo "   updater: stopped"
    fi
    local sampler_pid=""
    local dashboard_pid=""
    if is_pid_file_running "$MONITOR_PID_FILE"; then sampler_pid=$(cat "$MONITOR_PID_FILE"); fi
    if is_pid_file_running "$DASHBOARD_PID_FILE"; then dashboard_pid=$(cat "$DASHBOARD_PID_FILE"); fi
    if [ -n "$sampler_pid" ] && [ -n "$dashboard_pid" ]; then
        echo "   monitor: running (sampler PID $sampler_pid, dashboard PID $dashboard_pid)"
    elif [ -n "$sampler_pid" ] || [ -n "$dashboard_pid" ]; then
        echo "   monitor: partially running (sampler PID ${sampler_pid:-stopped}, dashboard PID ${dashboard_pid:-stopped})"
    else
        echo "   monitor: stopped"
    fi
    autostart_status
}

# 输出当前/上一版本、路径、Node、日志和服务管理方式等诊断信息。
cmd_info() {
    local version_dir
    version_dir=$(resolve_current_version) || true
    if [ -n "$version_dir" ] && [ -f "$version_dir/VERSION" ]; then
        cat "$version_dir/VERSION"
    else
        echo "version=unknown"
    fi
    echo ""
    echo "data_dir=$DATA_DIR"
    echo "config=$CONFIG_FILE"
    echo "log=$LOG_FILE"
    echo "versions_dir=$VERSIONS_DIR"

    if [ -f "$NODE_PIN_FILE" ]; then
        local pinned_node
        pinned_node=$(cat "$NODE_PIN_FILE" 2>/dev/null | tr -d '[:space:]')
        if [ -n "$pinned_node" ] && [ -x "$pinned_node" ]; then
            echo "node_bin=$pinned_node"
            echo "node_version=$("$pinned_node" --version 2>/dev/null || echo 'unknown')"
        else
            echo "node_bin=$pinned_node (stale)"
            local resolved
            resolved=$(resolve_node 2>/dev/null) || true
            echo "node_version=$("${resolved:-node}" --version 2>/dev/null || echo 'unknown')"
        fi
    else
        echo "node_bin=not pinned"
        local resolved
        resolved=$(resolve_node 2>/dev/null) || true
        if [ -n "$resolved" ]; then
            echo "node_resolved=$resolved"
            echo "node_version=$("$resolved" --version 2>/dev/null || echo 'unknown')"
        fi
    fi

    echo ""
    if [ -f "$CONFIG_FILE" ]; then
        cat "$CONFIG_FILE"
    fi
}

# 把 worker 子命令和剩余参数转发给当前版本 dist 入口。
cmd_worker() {
    ensure_dirs
    sync_bootstrap_scripts

    local node_bin
    node_bin=$(resolve_node) || {
        echo "❌ node runtime not found" >&2
        exit 1
    }

    local version_dir
    version_dir=$(resolve_current_version) || {
        echo "❌ No valid loongsuite-pilot version found" >&2
        exit 1
    }
    local entry="$version_dir/dist/index.js"

    export AGENT_DATA_COLLECTION_CONFIG="$CONFIG_FILE"
    exec "$node_bin" "$entry" worker "$@"
}

# 定位当前版本入口并启动 token usage TUI，保持终端标准输入输出。
cmd_token_usage() {
    ensure_dirs

    local repo_dir version_dir entry candidate node_bin
    repo_dir="$(dirname "$SCRIPT_DIR")"
    entry=""

    if [ -f "$repo_dir/package.json" ] && [ -d "$repo_dir/src" ]; then
        if [ -f "$repo_dir/dist/index.js" ]; then
            entry="$repo_dir/dist/index.js"
        else
            echo "❌ local dist/index.js not found; run 'npm run build' first"
            exit 1
        fi
    else
        version_dir=$(resolve_current_version 2>/dev/null) || true
        for candidate in \
            "${version_dir:-}/dist/index.js" \
            "$PACKAGE_DIR/dist/index.js"; do
            if [ -f "$candidate" ]; then
                entry="$candidate"
                break
            fi
        done
    fi

    if [ -z "$entry" ]; then
        echo "❌ loongsuite-pilot runtime entry not found"
        exit 1
    fi

    node_bin=$(resolve_node) || {
        echo "❌ node runtime not found" >&2
        exit 1
    }

    export AGENT_DATA_COLLECTION_CONFIG="$CONFIG_FILE"
    exec "$node_bin" "$entry" token-usage "$@"
}

# 校验 previous，交换版本指针、同步脚本并重启；失败则恢复指针。
cmd_rollback() {
    if [ ! -f "$PREVIOUS_FILE" ]; then
        echo "❌ No previous version to roll back to"
        exit 1
    fi

    local prev_dir
    prev_dir=$(cat "$PREVIOUS_FILE" 2>/dev/null | tr -d '[:space:]')
    if [ -z "$prev_dir" ] || [ ! -d "$VERSIONS_DIR/$prev_dir" ]; then
        echo "❌ Previous version directory not found: $prev_dir"
        exit 1
    fi

    local curr_dir=""
    if [ -f "$CURRENT_FILE" ]; then
        curr_dir=$(cat "$CURRENT_FILE" 2>/dev/null | tr -d '[:space:]')
    fi

    # 指针先写临时文件再同目录 mv，daemon 不会在切换瞬间读到空/半写 current。
    echo "$prev_dir" > "$CURRENT_FILE.tmp"
    mv -f "$CURRENT_FILE.tmp" "$CURRENT_FILE"
    if [ -n "$curr_dir" ]; then
        echo "$curr_dir" > "$PREVIOUS_FILE.tmp"
        mv -f "$PREVIOUS_FILE.tmp" "$PREVIOUS_FILE"
    fi

    # 稳定 bootstrap/CLI 同步失败时恢复两个指针和旧脚本，避免指针与实际入口版本分裂。
    if ! sync_installed_scripts_from_version "$VERSIONS_DIR/$prev_dir"; then
        if [ -n "$curr_dir" ]; then
            echo "$curr_dir" > "$CURRENT_FILE.tmp"
            mv -f "$CURRENT_FILE.tmp" "$CURRENT_FILE"
            echo "$prev_dir" > "$PREVIOUS_FILE.tmp"
            mv -f "$PREVIOUS_FILE.tmp" "$PREVIOUS_FILE"
            sync_installed_scripts_from_version "$VERSIONS_DIR/$curr_dir" 2>/dev/null || true
        fi
        echo "❌ Failed to sync scripts for rollback target: $prev_dir"
        exit 1
    fi

    echo "✅ Rolled back to version: $prev_dir"
    echo "   Restarting service..."
    cmd_restart
}

# ---- 内部自动启动管理。 ----

# 用未加引号的 heredoc 生成 launchd plist；`${...}` 会在写入时展开为当前用户的绝对路径。
# 这里直接覆盖目标文件，并非原子替换；调用方会先 unload 旧 job，避免 launchd 同时读取。
_write_launchd_plist() {
    # 如果$HOME/Library/LaunchAgents/com.loongsuite-pilot.plist目录不存在，则创建目录
    mkdir -p "$(dirname "$LAUNCHD_PLIST")"
    ensure_dirs
    # 覆盖写$HOME/Library/LaunchAgents/com.loongsuite-pilot.plist文件
    cat > "$LAUNCHD_PLIST" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${LOONGSUITE_PILOT_BIN}</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_FILE}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>AGENT_DATA_COLLECTION_CONFIG</key>
        <string>${CONFIG_FILE}</string>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
PLISTEOF
}

SYSTEMD_USER_UNIT_DIR="$HOME/.config/systemd/user"

# 写 systemd user unit。`%h` 由 systemd 在服务启动时展开为该用户 HOME，不由当前 Shell 展开。
_write_systemd_user_unit() {
    mkdir -p "$SYSTEMD_USER_UNIT_DIR"
    cat > "$SYSTEMD_USER_UNIT_DIR/loongsuite-pilot.service" << UNITEOF
[Unit]
Description=LoongSuite Pilot
After=default.target

[Service]
Type=simple
ExecStart=%h/.local/bin/loongsuite-pilot run
WorkingDirectory=%h/.loongsuite-pilot
Environment=AGENT_DATA_COLLECTION_CONFIG=%h/.loongsuite-pilot/config.json
Restart=on-failure
RestartSec=10
LimitNOFILE=65536

[Install]
WantedBy=default.target
UNITEOF
}

# 写独立 Updater user unit；KillMode=process 避免重启 Updater 时连带终止它安排的 Collector 重启任务。
_write_systemd_user_updater_unit() {
    mkdir -p "$SYSTEMD_USER_UNIT_DIR"
    cat > "$SYSTEMD_USER_UNIT_DIR/loongsuite-pilot-updater.service" << UNITEOF
[Unit]
Description=LoongSuite Pilot Auto-Updater
After=default.target

[Service]
Type=simple
ExecStart=%h/.local/bin/loongsuite-pilot run-updater
WorkingDirectory=%h/.loongsuite-pilot
Environment=AGENT_DATA_COLLECTION_CONFIG=%h/.loongsuite-pilot/config.json
KillMode=process
Restart=on-failure
RestartSec=60
LimitNOFILE=65536

[Install]
WantedBy=default.target
UNITEOF
}

# 用 `sudo tee` 写 system-level unit；重定向的是 tee 的 stdout，文件内容由 heredoc 经 stdin 提供。
_write_systemd_system_unit() {
    local target_user="$1"
    local target_home
    target_home=$(resolve_user_home "$target_user")
    local target_bin="$target_home/.local/bin/loongsuite-pilot"
    local target_config="$target_home/.loongsuite-pilot/config.json"
    local target_workdir="$target_home/.loongsuite-pilot"
    local unit_name="loongsuite-pilot-${target_user}.service"
    local unit_path="$SYSTEMD_SYSTEM_UNIT_DIR/$unit_name"

    maybe_sudo mkdir -p "$SYSTEMD_SYSTEM_UNIT_DIR"
    ensure_dirs
    # Group 命令替换在 heredoc 写入阶段执行；查询失败时回退到与用户名同名的组。
    maybe_sudo tee "$unit_path" > /dev/null << UNITEOF
[Unit]
Description=LoongSuite Pilot (${target_user})
After=network.target

[Service]
Type=simple
User=${target_user}
Group=$(id -gn "$target_user" 2>/dev/null || echo "$target_user")
ExecStart=${target_bin} run
WorkingDirectory=${target_workdir}
Environment=HOME=${target_home}
Environment=AGENT_DATA_COLLECTION_CONFIG=${target_config}
Restart=on-failure
RestartSec=10
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNITEOF
}

# 生成 Updater launchd plist；AbandonProcessGroup 允许其派生的延迟重启进程脱离 Updater 生命周期。
_write_launchd_updater_plist() {
    mkdir -p "$(dirname "$UPDATER_PLIST")"
    ensure_dirs
    cat > "$UPDATER_PLIST" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${UPDATER_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${LOONGSUITE_PILOT_BIN}</string>
        <string>run-updater</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${UPDATER_LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>${UPDATER_LOG_FILE}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>AGENT_DATA_COLLECTION_CONFIG</key>
        <string>${CONFIG_FILE}</string>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
    <key>AbandonProcessGroup</key>
    <true/>
</dict>
</plist>
PLISTEOF
}

# 生成 system-level Updater unit，显式设置 HOME/config 以弥补系统服务精简的环境变量。
_write_systemd_system_updater_unit() {
    local target_user="$1"
    local target_home
    target_home=$(resolve_user_home "$target_user")
    local target_bin="$target_home/.local/bin/loongsuite-pilot"
    local target_config="$target_home/.loongsuite-pilot/config.json"
    local target_workdir="$target_home/.loongsuite-pilot"
    local unit_name="loongsuite-pilot-updater-${target_user}.service"
    local unit_path="$SYSTEMD_SYSTEM_UNIT_DIR/$unit_name"

    maybe_sudo mkdir -p "$SYSTEMD_SYSTEM_UNIT_DIR"
    ensure_dirs
    maybe_sudo tee "$unit_path" > /dev/null << UNITEOF
[Unit]
Description=LoongSuite Pilot Auto-Updater (${target_user})
After=network.target

[Service]
Type=simple
User=${target_user}
Group=$(id -gn "$target_user" 2>/dev/null || echo "$target_user")
ExecStart=${target_bin} run-updater
WorkingDirectory=${target_workdir}
Environment=HOME=${target_home}
Environment=AGENT_DATA_COLLECTION_CONFIG=${target_config}
KillMode=process
Restart=on-failure
RestartSec=60
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNITEOF
}

# 先在普通临时文件生成 init.d 模板，再替换占位符并以 755 权限安装到 `/etc/init.d`。
# 引用的 heredoc 分隔符禁止当前 Shell 提前展开模板里的 `$PID_FILE` 等变量。
_write_initd_script() {
    local target_user="$1"
    local target_home
    target_home=$(resolve_user_home "$target_user")
    local daemon_bin="$target_home/.local/bin/loongsuite-pilot"
    local daemon_name="loongsuite-pilot-${target_user}"
    local pid_file="$target_home/.loongsuite-pilot/loongsuite-pilot.pid"
    local log_file="$target_home/.loongsuite-pilot/logs/loongsuite-pilot-service.log"
    local config_file="$target_home/.loongsuite-pilot/config.json"
    local script_path="/etc/init.d/$daemon_name"
    local daemon_group
    daemon_group=$(id -gn "$target_user" 2>/dev/null || echo "$target_user")

    local tmp_script
    tmp_script=$(mktemp)

    cat > "$tmp_script" << 'INITEOF'
#!/bin/bash
### BEGIN INIT INFO
# Provides:          DAEMON_NAME_PLACEHOLDER
# Required-Start:    $local_fs $network
# Required-Stop:     $local_fs $network
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Description:       LoongSuite Pilot data collector (USER_PLACEHOLDER)
### END INIT INFO
# chkconfig: 2345 90 10

DAEMON_USER="USER_PLACEHOLDER"
DAEMON_GROUP="GROUP_PLACEHOLDER"
DAEMON_HOME="HOME_PLACEHOLDER"
DAEMON_BIN="BIN_PLACEHOLDER"
DAEMON_NAME="DAEMON_NAME_PLACEHOLDER"
PID_FILE="PID_PLACEHOLDER"
LOG_FILE="LOG_PLACEHOLDER"
CONFIG_FILE="CONFIG_PLACEHOLDER"

# 由生成的 init.d 脚本调用，后台启动 daemon、记录 PID 并返回启动结果。
do_start() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE" 2>/dev/null)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            echo "$DAEMON_NAME is already running (PID $pid)"
            return 0
        fi
        rm -f "$PID_FILE"
    fi

    echo -n "Starting $DAEMON_NAME... "
    mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$PID_FILE")"

    if command -v start-stop-daemon &>/dev/null; then
        start-stop-daemon --start --chuid "$DAEMON_USER" \
            --background --make-pidfile --pidfile "$PID_FILE" \
            --exec "$DAEMON_BIN" -- run \
            >>"$LOG_FILE" 2>&1
        chown "$DAEMON_USER:$DAEMON_GROUP" "$LOG_FILE" "$PID_FILE"
    else
        su - "$DAEMON_USER" -c "
            export AGENT_DATA_COLLECTION_CONFIG='$CONFIG_FILE'
            nohup '$DAEMON_BIN' run >> '$LOG_FILE' 2>&1 &
            echo \$! > '$PID_FILE'
        "
    fi
    echo "done"
}

# 由生成的 init.d 脚本调用，TERM/KILL 停止 PID 并清理状态文件。
do_stop() {
    if [ ! -f "$PID_FILE" ]; then
        echo "$DAEMON_NAME is not running"
        return 0
    fi
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null)
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$PID_FILE"
        echo "$DAEMON_NAME is not running"
        return 0
    fi

    echo -n "Stopping $DAEMON_NAME... "
    kill "$pid" 2>/dev/null || true
    local count=0
    while kill -0 "$pid" 2>/dev/null && [ $count -lt 10 ]; do
        sleep 1
        count=$((count + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    echo "done"
}

# 由生成的 init.d 脚本调用，以标准 LSB 退出码报告进程状态。
do_status() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE" 2>/dev/null)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            echo "$DAEMON_NAME is running (PID $pid)"
            return 0
        fi
    fi
    echo "$DAEMON_NAME is not running"
    return 1
}

case "$1" in
    start)   do_start ;;
    stop)    do_stop ;;
    restart) do_stop; sleep 1; do_start ;;
    status)  do_status ;;
    *)       echo "Usage: $0 {start|stop|restart|status}"; exit 1 ;;
esac
INITEOF

    # `|` 作为 sed 分隔符，减少路径中 `/` 的转义；`.bak` 兼容 BSD/GNU sed，随后删除备份。
    sed -i.bak \
        -e "s|USER_PLACEHOLDER|${target_user}|g" \
        -e "s|GROUP_PLACEHOLDER|${daemon_group}|g" \
        -e "s|HOME_PLACEHOLDER|${target_home}|g" \
        -e "s|BIN_PLACEHOLDER|${daemon_bin}|g" \
        -e "s|DAEMON_NAME_PLACEHOLDER|${daemon_name}|g" \
        -e "s|PID_PLACEHOLDER|${pid_file}|g" \
        -e "s|LOG_PLACEHOLDER|${log_file}|g" \
        -e "s|CONFIG_PLACEHOLDER|${config_file}|g" \
        "$tmp_script"
    rm -f "${tmp_script}.bak"

    maybe_sudo install -m 755 "$tmp_script" "$script_path"
    rm -f "$tmp_script"
}

# 与 Collector 模板相同，但入口是 `run-updater`，PID/日志/服务名相互独立。
_write_initd_updater_script() {
    local target_user="$1"
    local target_home
    target_home=$(resolve_user_home "$target_user")
    local daemon_bin="$target_home/.local/bin/loongsuite-pilot"
    local daemon_name="loongsuite-pilot-updater-${target_user}"
    local pid_file="$target_home/.loongsuite-pilot/loongsuite-pilot-updater.pid"
    local log_file="$target_home/.loongsuite-pilot/logs/loongsuite-pilot-updater.log"
    local config_file="$target_home/.loongsuite-pilot/config.json"
    local script_path="/etc/init.d/$daemon_name"
    local daemon_group
    daemon_group=$(id -gn "$target_user" 2>/dev/null || echo "$target_user")

    local tmp_script
    tmp_script=$(mktemp)

    cat > "$tmp_script" << 'INITEOF'
#!/bin/bash
### BEGIN INIT INFO
# Provides:          DAEMON_NAME_PLACEHOLDER
# Required-Start:    $local_fs $network
# Required-Stop:     $local_fs $network
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Description:       LoongSuite Pilot auto-updater (USER_PLACEHOLDER)
### END INIT INFO
# chkconfig: 2345 91 9

DAEMON_USER="USER_PLACEHOLDER"
DAEMON_GROUP="GROUP_PLACEHOLDER"
DAEMON_HOME="HOME_PLACEHOLDER"
DAEMON_BIN="BIN_PLACEHOLDER"
DAEMON_NAME="DAEMON_NAME_PLACEHOLDER"
PID_FILE="PID_PLACEHOLDER"
LOG_FILE="LOG_PLACEHOLDER"
CONFIG_FILE="CONFIG_PLACEHOLDER"

# 由生成的 init.d 脚本调用，后台启动 daemon、记录 PID 并返回启动结果。
do_start() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE" 2>/dev/null)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            echo "$DAEMON_NAME is already running (PID $pid)"
            return 0
        fi
        rm -f "$PID_FILE"
    fi

    echo -n "Starting $DAEMON_NAME... "
    mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$PID_FILE")"

    if command -v start-stop-daemon &>/dev/null; then
        start-stop-daemon --start --chuid "$DAEMON_USER" \
            --background --make-pidfile --pidfile "$PID_FILE" \
            --exec "$DAEMON_BIN" -- run-updater \
            >>"$LOG_FILE" 2>&1
        chown "$DAEMON_USER:$DAEMON_GROUP" "$LOG_FILE" "$PID_FILE"
    else
        su - "$DAEMON_USER" -c "
            export AGENT_DATA_COLLECTION_CONFIG='$CONFIG_FILE'
            nohup '$DAEMON_BIN' run-updater >> '$LOG_FILE' 2>&1 &
            echo \$! > '$PID_FILE'
        "
    fi
    echo "done"
}

# 由生成的 init.d 脚本调用，TERM/KILL 停止 PID 并清理状态文件。
do_stop() {
    if [ ! -f "$PID_FILE" ]; then
        echo "$DAEMON_NAME is not running"
        return 0
    fi
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null)
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$PID_FILE"
        echo "$DAEMON_NAME is not running"
        return 0
    fi

    echo -n "Stopping $DAEMON_NAME... "
    kill "$pid" 2>/dev/null || true
    local count=0
    while kill -0 "$pid" 2>/dev/null && [ $count -lt 10 ]; do
        sleep 1
        count=$((count + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    echo "done"
}

# 由生成的 init.d 脚本调用，以标准 LSB 退出码报告进程状态。
do_status() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE" 2>/dev/null)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            echo "$DAEMON_NAME is running (PID $pid)"
            return 0
        fi
    fi
    echo "$DAEMON_NAME is not running"
    return 1
}

case "$1" in
    start)   do_start ;;
    stop)    do_stop ;;
    restart) do_stop; sleep 1; do_start ;;
    status)  do_status ;;
    *)       echo "Usage: $0 {start|stop|restart|status}"; exit 1 ;;
esac
INITEOF

    sed -i.bak \
        -e "s|USER_PLACEHOLDER|${target_user}|g" \
        -e "s|GROUP_PLACEHOLDER|${daemon_group}|g" \
        -e "s|HOME_PLACEHOLDER|${target_home}|g" \
        -e "s|BIN_PLACEHOLDER|${daemon_bin}|g" \
        -e "s|DAEMON_NAME_PLACEHOLDER|${daemon_name}|g" \
        -e "s|PID_PLACEHOLDER|${pid_file}|g" \
        -e "s|LOG_PLACEHOLDER|${log_file}|g" \
        -e "s|CONFIG_PLACEHOLDER|${config_file}|g" \
        "$tmp_script"
    rm -f "${tmp_script}.bak"

    maybe_sudo install -m 755 "$tmp_script" "$script_path"
    rm -f "$tmp_script"
}

# 使用 update-rc.d 或 chkconfig 注册 init.d 开机启动，工具缺失时提示手工管理。
_register_initd_boot() {
    local name="$1"
    if command -v chkconfig &>/dev/null; then
        maybe_sudo chkconfig --add "$name" &>/dev/null || true
    elif command -v update-rc.d &>/dev/null; then
        maybe_sudo update-rc.d "$name" defaults &>/dev/null || true
    else
        echo "⚠️  Neither chkconfig nor update-rc.d found, boot registration skipped for $name"
    fi
}

# 使用发行版可用工具移除 init.d 开机链接，清理时保持 best-effort。
_unregister_initd_boot() {
    local name="$1"
    if command -v chkconfig &>/dev/null; then
        maybe_sudo chkconfig --del "$name" &>/dev/null || true
    elif command -v update-rc.d &>/dev/null; then
        maybe_sudo update-rc.d "$name" remove &>/dev/null || true
    fi
}

# 只重建并启动 Collector 服务配置，不触碰正在运行的 Updater。
autostart_install_collector_only() {
    local interactive="${1:-true}"

    local init_system
    # detect_init_system 的 stdout 是选择结果，命令替换不会保留其末尾换行。
    init_system=$(detect_init_system "$interactive")
    local target_user
    target_user=$(whoami)

    case "$init_system" in
        launchd)
            launchctl unload -w "$LAUNCHD_PLIST" 2>/dev/null || true
            _write_launchd_plist
            launchctl load -w "$LAUNCHD_PLIST"
            echo "launchd" > "$INIT_TYPE_FILE"
            ;;
        systemd-user)
            _write_systemd_user_unit
            systemctl --user daemon-reload &>/dev/null
            systemctl --user enable --now loongsuite-pilot.service &>/dev/null
            enable_linger || true
            echo "systemd-user" > "$INIT_TYPE_FILE"
            ;;
        systemd-system)
            _write_systemd_system_unit "$target_user"
            maybe_sudo systemctl daemon-reload &>/dev/null
            maybe_sudo systemctl enable --now "loongsuite-pilot-${target_user}.service" &>/dev/null
            echo "systemd-system" > "$INIT_TYPE_FILE"
            ;;
        initd)
            _write_initd_script "$target_user"
            _register_initd_boot "loongsuite-pilot-${target_user}"
            maybe_sudo "/etc/init.d/loongsuite-pilot-${target_user}" start &>/dev/null || true
            echo "initd" > "$INIT_TYPE_FILE"
            ;;
        *)
            return 1
            ;;
    esac
}

# 只重建并启动 Updater 服务配置，不重启 Collector。
autostart_install_updater_only() {
    local interactive="${1:-true}"

    local init_system
    init_system=$(detect_init_system "$interactive")
    local target_user
    target_user=$(whoami)

    case "$init_system" in
        launchd)
            launchctl unload -w "$UPDATER_PLIST" 2>/dev/null || true
            _write_launchd_updater_plist
            launchctl load -w "$UPDATER_PLIST"
            echo "launchd" > "$INIT_TYPE_FILE"
            ;;
        systemd-user)
            _write_systemd_user_updater_unit
            systemctl --user daemon-reload &>/dev/null
            systemctl --user enable --now loongsuite-pilot-updater.service &>/dev/null
            enable_linger || true
            echo "systemd-user" > "$INIT_TYPE_FILE"
            ;;
        systemd-system)
            _write_systemd_system_updater_unit "$target_user"
            maybe_sudo systemctl daemon-reload &>/dev/null
            maybe_sudo systemctl enable --now "loongsuite-pilot-updater-${target_user}.service" &>/dev/null
            echo "systemd-system" > "$INIT_TYPE_FILE"
            ;;
        initd)
            _write_initd_updater_script "$target_user"
            _register_initd_boot "loongsuite-pilot-updater-${target_user}"
            maybe_sudo "/etc/init.d/loongsuite-pilot-updater-${target_user}" start &>/dev/null || true
            echo "initd" > "$INIT_TYPE_FILE"
            ;;
        *)
            return 1
            ;;
    esac
}

# 这里的核心作用就是将loongsuite-pilot.sh run注册成系统服务，用户登录开机自启，程序崩溃会被自动重启，并启动执行loongsuite-pilot.sh run
autostart_install() {
    # 读取函数传入的第一个参数并赋值给interactive，如果没有传入第一个参数，或是第一个参数为空值，变量就自动取值为字符串true
    local interactive="${1:-true}"

    local init_system
    # 确定当前环境应使用哪一种服务管理机制来注册、启动和管理 loongsuite-pilot 的 collector/updater
    init_system=$(detect_init_system "$interactive")
    local target_user
    # 获取当前正在执行脚本的系统用户名
    target_user=$(whoami)

    case "$init_system" in
        launchd)
            # LAUNCHD_PLIST默认为"$HOME/Library/LaunchAgents/com.loongsuite-pilot.plist"
            # 卸载指定 plist 守护进程配置文件，让对应后台程序停止运行、从当前会话移除
            launchctl unload -w "$LAUNCHD_PLIST" 2>/dev/null || true
            # 覆盖写$HOME/Library/LaunchAgents/com.loongsuite-pilot.plist文件内容
            _write_launchd_plist
            # 仅 macOS，用来加载 launchd 守护配置文件（plist），管理后台常驻程序开机自启
            launchctl load -w "$LAUNCHD_PLIST"
            # 判断$HOME/.loongsuite-pilot/updater-daemon.js文件是否存在
            # Updater 资产存在才注册第二个服务；Collector 始终独立可用。
            if [ -f "$BOOTSTRAP_DIR/updater-daemon.js" ]; then
                # 存在就卸载指定 plist 守护进程配置文件，让对应后台程序停止运行、从当前会话移除
                # $HOME/Library/LaunchAgents/com.loongsuite-pilot.updater.plist
                launchctl unload -w "$UPDATER_PLIST" 2>/dev/null || true
                # 覆盖写$HOME/Library/LaunchAgents/com.loongsuite-pilot.updater.plist文件内容
                _write_launchd_updater_plist
                # 仅 macOS，用来加载 launchd 守护配置文件（plist），管理后台常驻程序开机自启
                launchctl load -w "$UPDATER_PLIST"
            fi
            # 覆盖写$HOME/.loongsuite-pilot/init-type文件内容
            echo "launchd" > "$INIT_TYPE_FILE"
            ;;
        systemd-user)
            # 覆盖写入$HOME/.config/systemd/user/loongsuite-pilot.service文件内容
            # 启动时执行loongsuite-pilot run命令
            _write_systemd_user_unit
            if [ -f "$BOOTSTRAP_DIR/updater-daemon.js" ]; then
                # 覆盖写入$HOME/.config/systemd/user/loongsuite-pilot-updater.service文件内容
                # 启动时执行loongsuite-pilot run-updater命令
                _write_systemd_user_updater_unit
            fi
            # 重新加载用户级systemd，让systemd守护进程重读全部service、socket配置文件，更新内部数据库
            systemctl --user daemon-reload &>/dev/null
            # 立刻运行loongsuite-pilot后台采集/拦截服务，永久配置为用户登录开机自启，程序崩溃会被自动重启、统一收集日志、方便用systemctl管控启停状态
            systemctl --user enable --now loongsuite-pilot.service &>/dev/null
            if [ -f "$BOOTSTRAP_DIR/updater-daemon.js" ]; then
                # 立刻运行loongsuite-pilot跟新后台采集/拦截服务，永久配置为用户登录开机自启，程序崩溃会被自动重启、统一收集日志、方便用systemctl管控启停状态
                systemctl --user enable --now loongsuite-pilot-updater.service &>/dev/null
            fi
            enable_linger || true
            # 覆盖写$HOME/.loongsuite-pilot/init-type文件内容
            echo "systemd-user" > "$INIT_TYPE_FILE"
            ;;
        systemd-system)
            _write_systemd_system_unit "$target_user"
            if [ -f "$BOOTSTRAP_DIR/updater-daemon.js" ]; then
                _write_systemd_system_updater_unit "$target_user"
            fi
            maybe_sudo systemctl daemon-reload &>/dev/null
            maybe_sudo systemctl enable --now "loongsuite-pilot-${target_user}.service" &>/dev/null
            if [ -f "$BOOTSTRAP_DIR/updater-daemon.js" ]; then
                maybe_sudo systemctl enable --now "loongsuite-pilot-updater-${target_user}.service" &>/dev/null
            fi
            echo "systemd-system" > "$INIT_TYPE_FILE"
            ;;
        initd)
            _write_initd_script "$target_user"
            _register_initd_boot "loongsuite-pilot-${target_user}"
            maybe_sudo "/etc/init.d/loongsuite-pilot-${target_user}" start &>/dev/null || true
            if [ -f "$BOOTSTRAP_DIR/updater-daemon.js" ]; then
                _write_initd_updater_script "$target_user"
                _register_initd_boot "loongsuite-pilot-updater-${target_user}"
                maybe_sudo "/etc/init.d/loongsuite-pilot-updater-${target_user}" start &>/dev/null || true
            fi
            echo "initd" > "$INIT_TYPE_FILE"
            ;;
        *)
            return 1
            ;;
    esac
}

# 停止并卸载 launchd/systemd/init.d 配置，删除 init-type 记录。
autostart_remove() {
    local init_system
    # 卸载/停止必须非交互，不能在清理路径等待 sudo 密码；保存的 init-type 会优先返回。
    init_system=$(detect_init_system "false")
    local target_user
    target_user=$(whoami)

    case "$init_system" in
        launchd)
            launchctl unload -w "$UPDATER_PLIST" 2>/dev/null || true
            rm -f "$UPDATER_PLIST"
            launchctl unload -w "$LAUNCHD_PLIST" 2>/dev/null || true
            rm -f "$LAUNCHD_PLIST"
            ;;
        systemd-user)
            systemctl --user disable --now loongsuite-pilot-updater.service &>/dev/null || true
            systemctl --user disable --now loongsuite-pilot.service &>/dev/null || true
            rm -f "$SYSTEMD_USER_UNIT_DIR/loongsuite-pilot.service"
            rm -f "$SYSTEMD_USER_UNIT_DIR/loongsuite-pilot-updater.service"
            systemctl --user daemon-reload &>/dev/null || true
            ;;
        systemd-system|systemd)
            maybe_sudo systemctl disable --now "loongsuite-pilot-updater-${target_user}.service" &>/dev/null || true
            maybe_sudo systemctl disable --now "loongsuite-pilot-${target_user}.service" &>/dev/null || true
            maybe_sudo rm -f "$SYSTEMD_SYSTEM_UNIT_DIR/loongsuite-pilot-${target_user}.service"
            maybe_sudo rm -f "$SYSTEMD_SYSTEM_UNIT_DIR/loongsuite-pilot-updater-${target_user}.service"
            maybe_sudo systemctl daemon-reload &>/dev/null || true
            ;;
        initd)
            maybe_sudo "/etc/init.d/loongsuite-pilot-${target_user}" stop &>/dev/null || true
            maybe_sudo "/etc/init.d/loongsuite-pilot-updater-${target_user}" stop &>/dev/null || true
            _unregister_initd_boot "loongsuite-pilot-${target_user}"
            _unregister_initd_boot "loongsuite-pilot-updater-${target_user}"
            maybe_sudo rm -f "/etc/init.d/loongsuite-pilot-${target_user}"
            maybe_sudo rm -f "/etc/init.d/loongsuite-pilot-updater-${target_user}"
            ;;
        *)
            ;;
    esac
    rm -f "$INIT_TYPE_FILE"
}

# 只读查询当前自启动配置是否存在且处于运行状态。
autostart_status() {
    local init_system
    init_system=$(detect_init_system)
    local target_user
    target_user=$(whoami)

    case "$init_system" in
        launchd)
            if [ -f "$LAUNCHD_PLIST" ] && launchctl list "$SERVICE_LABEL" &>/dev/null; then
                echo "   autostart: enabled (launchd)"
            else
                echo "   autostart: disabled"
            fi
            ;;
        systemd-user)
            if systemctl --user is-enabled loongsuite-pilot.service &>/dev/null; then
                local linger_status=""
                if [ -f "/var/lib/systemd/linger/$target_user" ]; then
                    linger_status=", linger active"
                fi
                echo "   autostart: enabled (systemd user-level${linger_status})"
            else
                echo "   autostart: disabled"
            fi
            ;;
        systemd-system|systemd)
            local unit_name="loongsuite-pilot-${target_user}.service"
            if [ -f "$SYSTEMD_SYSTEM_UNIT_DIR/$unit_name" ] && maybe_sudo_n systemctl is-enabled "$unit_name" &>/dev/null; then
                echo "   autostart: enabled (systemd system-level)"
            else
                echo "   autostart: disabled"
            fi
            ;;
        initd)
            if [ -f "/etc/init.d/loongsuite-pilot-${target_user}" ]; then
                echo "   autostart: enabled (init.d)"
            else
                echo "   autostart: disabled"
            fi
            ;;
        none)
            echo "   autostart: not available"
            ;;
        *)
            echo "   autostart: not available"
            ;;
    esac
}

# 管理 `~/.loongsuite-pilot/span-attributes.json`：其中的用户属性只注入 trace span，不进入事件日志。
# Collector 每个 turn 都会重读该文件，因此修改无需重启即可生效。
_span_attr_run() {
    local node_bin
    node_bin=$(resolve_node) || { echo "[span-attr] node runtime not found" >&2; exit 1; }
    # 单引号包住内嵌 JavaScript，Shell 不展开其中 `$`；文件路径和子命令从后续 argv 传入。
    "$node_bin" -e '
const fs = require("fs");
const file = process.argv[1], op = process.argv[2], key = process.argv[3], value = process.argv[4];
const RESERVED = ["gen_ai.","git.","workspace.","event.","trace_","user.","cost_","agent.","time_unix_nano","observed_time_unix_nano"];
const isReserved = k => RESERVED.some(p => k === p || k.indexOf(p) === 0);
function read() { try { const o = JSON.parse(fs.readFileSync(file, "utf-8")); return (o && typeof o === "object" && !Array.isArray(o)) ? o : {}; } catch { return {}; } }
function write(o) { const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + "\n"); fs.renameSync(tmp, file); }
if (op === "set") {
  if (!key || value === undefined) { console.error("usage: span-attr set <key> <value>"); process.exit(1); }
  if (isReserved(key)) { console.error("refused: \"" + key + "\" uses a reserved prefix (gen_ai./git./workspace./event./trace_/user./cost_/agent./...)"); process.exit(1); }
  const o = read(); o[key] = String(value); write(o); console.log("set " + key + "=" + o[key]);
} else if (op === "unset") {
  if (!key) { console.error("usage: span-attr unset <key>"); process.exit(1); }
  const o = read(); if (Object.prototype.hasOwnProperty.call(o, key)) { delete o[key]; write(o); console.log("unset " + key); } else { console.log("(no such key: " + key + ")"); }
} else if (op === "list") {
  const o = read(); const ks = Object.keys(o);
  if (ks.length === 0) { console.log("(no custom span attributes)"); } else { for (const k of ks) console.log(k + "=" + o[k]); }
}
' "$SPAN_ATTR_FILE" "$@"
}

# 通过 Node 小程序原子管理 span-attributes.json 的 list/set/remove 子命令。
cmd_span_attr() {
    local sub="${1:-}"
    case "$sub" in
        set)   shift; _span_attr_run set "$@" ;;
        unset) shift; _span_attr_run unset "$@" ;;
        list)  _span_attr_run list ;;
        clear)
            rm -f "$SPAN_ATTR_FILE"
            echo "cleared custom span attributes ($SPAN_ATTR_FILE)"
            ;;
        ""|help|-h|--help)
            echo "Usage: loongsuite-pilot span-attr <set|unset|list|clear>"
            echo ""
            echo "  set <key> <value>   Set a custom trace span attribute"
            echo "  unset <key>         Remove a custom attribute"
            echo "  list                Show current custom attributes"
            echo "  clear               Remove all custom attributes"
            echo ""
            echo "Attributes are injected into trace spans only (not the event log)."
            echo "Reserved-prefix keys (gen_ai./git./workspace./event./trace_/user./cost_/agent./...) are rejected."
            echo "Changes take effect on the next turn — no restart needed." ;;
        *)
            echo "Unknown span-attr command: $sub" >&2
            echo "Usage: loongsuite-pilot span-attr <set|unset|list|clear>" >&2
            exit 1 ;;
    esac
}

# 打印运维 CLI 支持的命令、monitor 与 span-attr 用法。
cmd_help() {
    echo "Usage: loongsuite-pilot <command> [options]"
    echo ""
    echo "Commands:"
    echo "  start           Start the collector service"
    echo "  stop            Stop the collector service"
    echo "  restart         Restart the collector service"
    echo "  status          Show service status (default)"
    echo "  info            Show version and config info"
    echo "  token-usage     Show token usage TUI"
    echo "  span-attr ...   Manage custom trace span attributes (set/unset/list/clear)"
    echo "  monitor start   Start process resource monitor"
    echo "  monitor stop    Stop process resource monitor"
    echo "  worker ...      Manage local remote-controlled workers"
    echo "  rollback        Roll back to the previous version"
    echo "  help            Show this help message"
}

# 解析 monitor 的 start/stop/status 子命令并分派到采样器和 Dashboard。
cmd_monitor() {
    case "${1:-}" in
        start) cmd_monitor_start ;;
        stop)  cmd_monitor_stop ;;
        *)
            echo "Unknown monitor command: ${1:-}"
            echo "Usage: loongsuite-pilot monitor <start|stop>"
            exit 1 ;;
    esac
}

# ---- 根据首个命令行参数分派子命令。 ----
# ${1:-status}：读取脚本第一个入参 $1；如果没传任何参数，默认值填充为 status
case "${1:-status}" in
    # 丢弃已经匹配完毕的第一个参数 start，参数列表整体向前挪一位
    start)       shift; cmd_start "$@" ;;
    stop)        cmd_stop ;;
    restart)     cmd_restart ;;
    status)      cmd_status ;;
    info)        cmd_info ;;
    token-usage) shift; cmd_token_usage "$@" ;;
    tokens)      shift; cmd_token_usage "$@" ;;
    span-attr)   shift; cmd_span_attr "$@" ;;
    monitor)             cmd_monitor "${2:-}" ;;
    worker)              shift; cmd_worker "$@" ;;
    rollback)            cmd_rollback ;;
    restart-collector)   cmd_restart_collector ;;
    restart-updater)     cmd_restart_updater ;;
    # run/run-updater 是服务管理器内部入口，普通用户通常调用 start/stop 而不是直接调用它们。
    run)                 cmd_run ;;
    run-updater)         cmd_run_updater ;;
    help|--help|-h) cmd_help ;;
    *)
        echo "Unknown command: $1"
        cmd_help
        exit 1 ;;
esac
