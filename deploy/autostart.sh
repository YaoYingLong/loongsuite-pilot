#!/usr/bin/env bash
# loongsuite-pilot 自启动管理参考库。
#
# 提供 `autostart_install`、`autostart_remove`、`autostart_status`，管理 macOS launchd 与
# Linux systemd user unit 下的 Collector/Updater。生产安装的权威实现嵌入 `scripts/loongsuite-pilot.sh`；
# 本文件用于单独 source 后测试/排障，修改时必须同步核对权威脚本。
#
# 调试用法：
#   source deploy/autostart.sh
#   autostart_status
#
# 函数会创建/删除 plist 或 unit、调用 launchctl/systemctl 并写 init-type；调用者需有对应权限。

# 被 `source` 时严格模式也会影响调用者 Shell，这是测试使用本参考库时需要注意的副作用。
set -euo pipefail

# --- 常量 ---
_LOONGSUITE_PILOT_SERVICE_LABEL="com.loongsuite-pilot"
_LOONGSUITE_PILOT_UPDATER_LABEL="com.loongsuite-pilot.updater"
_LOONGSUITE_PILOT_LAUNCHD_PLIST="$HOME/Library/LaunchAgents/${_LOONGSUITE_PILOT_SERVICE_LABEL}.plist"
_LOONGSUITE_PILOT_UPDATER_PLIST="$HOME/Library/LaunchAgents/${_LOONGSUITE_PILOT_UPDATER_LABEL}.plist"
_LOONGSUITE_PILOT_SYSTEMD_UNIT="loongsuite-pilot.service"
_LOONGSUITE_PILOT_UPDATER_UNIT="loongsuite-pilot-updater.service"
_LOONGSUITE_PILOT_SYSTEMD_UNIT_DIR="$HOME/.config/systemd/user"
_LOONGSUITE_PILOT_SYSTEMD_UNIT_PATH="${_LOONGSUITE_PILOT_SYSTEMD_UNIT_DIR}/${_LOONGSUITE_PILOT_SYSTEMD_UNIT}"
_LOONGSUITE_PILOT_UPDATER_UNIT_PATH="${_LOONGSUITE_PILOT_SYSTEMD_UNIT_DIR}/${_LOONGSUITE_PILOT_UPDATER_UNIT}"

# 可由环境变量覆盖的路径。
LOONGSUITE_PILOT_BIN="${LOONGSUITE_PILOT_BIN:-$HOME/.local/bin/loongsuite-pilot}"
LOONGSUITE_PILOT_DATA_DIR="${LOONGSUITE_PILOT_DATA_DIR:-$HOME/.loongsuite-pilot}"
LOONGSUITE_PILOT_CONFIG_FILE="${LOONGSUITE_PILOT_CONFIG_FILE:-$LOONGSUITE_PILOT_DATA_DIR/config.json}"
LOONGSUITE_PILOT_LOG_FILE="${LOONGSUITE_PILOT_LOG_FILE:-$LOONGSUITE_PILOT_DATA_DIR/logs/loongsuite-pilot-service.log}"
LOONGSUITE_PILOT_UPDATER_LOG_FILE="${LOONGSUITE_PILOT_UPDATER_LOG_FILE:-$LOONGSUITE_PILOT_DATA_DIR/logs/loongsuite-pilot-updater.log}"

# ============================================================
# 内部辅助函数。
# ============================================================

# 按操作系统和 systemctl 会话可用性返回 launchd、systemd-user 或 none。
_detect_init_system() {
    # 命令替换调用本函数，因此 stdout 必须只包含机器可解析的类型值，诊断信息不能写 stdout。
    case "$(uname -s)" in
        Darwin) echo "launchd" ;;
        Linux)
            # systemctl 可执行文件存在还不够；必须确认当前用户的 systemd/DBus 会话可访问。
            if command -v systemctl &>/dev/null && systemctl --user status &>/dev/null 2>&1; then
                echo "systemd"
            else
                echo "none"
            fi
            ;;
        *) echo "none" ;;
    esac
}

# 用 heredoc 直接覆盖 Collector plist；变量在写入时展开，因此配置保存的是当前路径快照。
# 此处不是临时文件+rename，调用方会先 unload 旧 job 后再写。
_write_launchd_plist() {
    mkdir -p "$(dirname "$_LOONGSUITE_PILOT_LAUNCHD_PLIST")"
    mkdir -p "$(dirname "$LOONGSUITE_PILOT_LOG_FILE")"
    cat > "$_LOONGSUITE_PILOT_LAUNCHD_PLIST" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${_LOONGSUITE_PILOT_SERVICE_LABEL}</string>
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
    <string>${LOONGSUITE_PILOT_LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>${LOONGSUITE_PILOT_LOG_FILE}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>AGENT_DATA_COLLECTION_CONFIG</key>
        <string>${LOONGSUITE_PILOT_CONFIG_FILE}</string>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
PLISTEOF
}

# 直接写 Updater plist，日志和配置路径与 Collector 分开，便于独立启停与排障。
_write_launchd_updater_plist() {
    mkdir -p "$(dirname "$_LOONGSUITE_PILOT_UPDATER_PLIST")"
    mkdir -p "$(dirname "$LOONGSUITE_PILOT_UPDATER_LOG_FILE")"
    cat > "$_LOONGSUITE_PILOT_UPDATER_PLIST" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${_LOONGSUITE_PILOT_UPDATER_LABEL}</string>
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
    <string>${LOONGSUITE_PILOT_UPDATER_LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>${LOONGSUITE_PILOT_UPDATER_LOG_FILE}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>AGENT_DATA_COLLECTION_CONFIG</key>
        <string>${LOONGSUITE_PILOT_CONFIG_FILE}</string>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
PLISTEOF
}

# 写 systemd user Collector unit；Type=simple 要求 `loongsuite-pilot run` 保持前台且使用 exec。
_write_systemd_unit() {
    mkdir -p "$_LOONGSUITE_PILOT_SYSTEMD_UNIT_DIR"
    mkdir -p "$(dirname "$LOONGSUITE_PILOT_LOG_FILE")"
    cat > "$_LOONGSUITE_PILOT_SYSTEMD_UNIT_PATH" << UNITEOF
[Unit]
Description=LoongSuite Pilot
After=default.target

[Service]
Type=simple
ExecStart=${LOONGSUITE_PILOT_BIN} run
Restart=on-failure
RestartSec=10
Environment=AGENT_DATA_COLLECTION_CONFIG=${LOONGSUITE_PILOT_CONFIG_FILE}

[Install]
WantedBy=default.target
UNITEOF
}

# 写 systemd user Updater unit；60 秒重启间隔避免更新端点持续失败时形成紧密重启循环。
_write_systemd_updater_unit() {
    mkdir -p "$_LOONGSUITE_PILOT_SYSTEMD_UNIT_DIR"
    mkdir -p "$(dirname "$LOONGSUITE_PILOT_UPDATER_LOG_FILE")"
    cat > "$_LOONGSUITE_PILOT_UPDATER_UNIT_PATH" << UNITEOF
[Unit]
Description=LoongSuite Pilot Auto-Updater
After=default.target

[Service]
Type=simple
ExecStart=${LOONGSUITE_PILOT_BIN} run-updater
Restart=on-failure
RestartSec=60
Environment=AGENT_DATA_COLLECTION_CONFIG=${LOONGSUITE_PILOT_CONFIG_FILE}

[Install]
WantedBy=default.target
UNITEOF
}

# ============================================================
# 对外可调用 API。
# ============================================================

# 为检测到的服务管理器生成配置、加载并启动 Collector/Updater。
autostart_install() {
    local init_system
    # 捕获探测结果后只执行一个平台分支；任一未处理命令失败会受严格模式约束。
    init_system=$(_detect_init_system)

    case "$init_system" in
        launchd)
            # unload 失败允许继续，常见原因是首次安装尚未加载；随后生成并 load 新配置。
            launchctl unload -w "$_LOONGSUITE_PILOT_LAUNCHD_PLIST" 2>/dev/null || true
            launchctl unload -w "$_LOONGSUITE_PILOT_UPDATER_PLIST" 2>/dev/null || true
            _write_launchd_plist
            _write_launchd_updater_plist
            launchctl load -w "$_LOONGSUITE_PILOT_LAUNCHD_PLIST"
            launchctl load -w "$_LOONGSUITE_PILOT_UPDATER_PLIST"
            echo "✅ Autostart enabled (launchd)"
            echo "   Collector: $_LOONGSUITE_PILOT_LAUNCHD_PLIST"
            echo "   Updater:   $_LOONGSUITE_PILOT_UPDATER_PLIST"
            ;;
        systemd)
            _write_systemd_unit
            _write_systemd_updater_unit
            # 写 unit 后 daemon-reload 让 systemd 重读文件，enable --now 同时注册自启并立即启动。
            systemctl --user daemon-reload
            systemctl --user enable --now "$_LOONGSUITE_PILOT_SYSTEMD_UNIT"
            systemctl --user enable --now "$_LOONGSUITE_PILOT_UPDATER_UNIT"
            echo "✅ Autostart enabled and services started (systemd user units)"
            echo "   Collector: $_LOONGSUITE_PILOT_SYSTEMD_UNIT_PATH"
            echo "   Updater:   $_LOONGSUITE_PILOT_UPDATER_UNIT_PATH"
            # linger 是增强项：失败不改变服务已注册的事实，只影响用户注销后是否继续运行。
            if command -v loginctl &>/dev/null; then
                if loginctl enable-linger "$(whoami)" 2>/dev/null; then
                    echo "   Linger enabled (services start at boot without login)"
                else
                    echo "   ⚠️  Could not enable linger (services only run while logged in)"
                fi
            fi
            ;;
        *)
            # 本参考库本身没有实现输出所述的 nohup fallback，只返回 1；调用者若需要必须自行启动。
            echo "⚠️  No supported init system detected (need launchd or systemd)"
            echo "   Service will run via nohup but won't auto-start on boot"
            return 1
            ;;
    esac
}

# 停止并卸载 launchd/systemd/init.d 配置，删除 init-type 记录。
autostart_remove() {
    local init_system
    init_system=$(_detect_init_system)

    case "$init_system" in
        launchd)
            launchctl unload -w "$_LOONGSUITE_PILOT_UPDATER_PLIST" 2>/dev/null || true
            rm -f "$_LOONGSUITE_PILOT_UPDATER_PLIST"
            launchctl unload -w "$_LOONGSUITE_PILOT_LAUNCHD_PLIST" 2>/dev/null || true
            rm -f "$_LOONGSUITE_PILOT_LAUNCHD_PLIST"
            echo "✅ Autostart disabled (launchd plists removed)"
            ;;
        systemd)
            # 先 disable --now 再删 unit，避免删除文件后 systemd 仍按内存中的旧配置运行。
            systemctl --user disable --now "$_LOONGSUITE_PILOT_UPDATER_UNIT" 2>/dev/null || true
            rm -f "$_LOONGSUITE_PILOT_UPDATER_UNIT_PATH"
            systemctl --user disable --now "$_LOONGSUITE_PILOT_SYSTEMD_UNIT" 2>/dev/null || true
            rm -f "$_LOONGSUITE_PILOT_SYSTEMD_UNIT_PATH"
            systemctl --user daemon-reload 2>/dev/null || true
            echo "✅ Autostart disabled (systemd units removed)"
            ;;
        *)
            echo "No autostart configuration found"
            ;;
    esac
}

# 只读查询当前自启动配置是否存在且处于运行状态。
autostart_status() {
    local init_system
    init_system=$(_detect_init_system)

    case "$init_system" in
        launchd)
            if [ -f "$_LOONGSUITE_PILOT_LAUNCHD_PLIST" ]; then
                # plist 存在仅表示已生成；launchctl/systemctl 查询用于区分“文件存在”与“已加载/启用”。
                if launchctl list 2>/dev/null | grep -q "$_LOONGSUITE_PILOT_SERVICE_LABEL$"; then
                    echo "✅ Collector autostart: enabled (launchd, loaded)"
                else
                    echo "⚠️  Collector autostart: plist exists but not loaded"
                fi
            else
                echo "⚪ Collector autostart: not configured"
            fi
            if [ -f "$_LOONGSUITE_PILOT_UPDATER_PLIST" ]; then
                if launchctl list 2>/dev/null | grep -q "$_LOONGSUITE_PILOT_UPDATER_LABEL"; then
                    echo "✅ Updater autostart:   enabled (launchd, loaded)"
                else
                    echo "⚠️  Updater autostart:   plist exists but not loaded"
                fi
            else
                echo "⚪ Updater autostart:   not configured"
            fi
            ;;
        systemd)
            if [ -f "$_LOONGSUITE_PILOT_SYSTEMD_UNIT_PATH" ]; then
                if systemctl --user is-enabled "$_LOONGSUITE_PILOT_SYSTEMD_UNIT" &>/dev/null; then
                    echo "✅ Collector autostart: enabled (systemd)"
                else
                    echo "⚠️  Collector autostart: unit exists but not enabled"
                fi
            else
                echo "⚪ Collector autostart: not configured"
            fi
            if [ -f "$_LOONGSUITE_PILOT_UPDATER_UNIT_PATH" ]; then
                if systemctl --user is-enabled "$_LOONGSUITE_PILOT_UPDATER_UNIT" &>/dev/null; then
                    echo "✅ Updater autostart:   enabled (systemd)"
                else
                    echo "⚠️  Updater autostart:   unit exists but not enabled"
                fi
            else
                echo "⚪ Updater autostart:   not configured"
            fi
            ;;
        *)
            echo "⚪ Autostart: not available (no supported init system)"
            ;;
    esac
}
