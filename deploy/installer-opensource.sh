#!/usr/bin/env bash
# installer-opensource.sh - loongsuite-pilot 开源版安装器
#
# 本脚本同时负责首次安装、重新安装、升级和卸载。它使用了 Bash 数组、[[ ]]
# 条件表达式和 local 等 Bash 专有语法，因此必须由 Bash 执行，不能改用 sh。
#
# 首次安装（Install）：
#   curl -fsSL https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh | bash
#   curl -fsSL <URL>/installer.sh | bash -s -- install \
#     --sls-endpoint "https://cn-hangzhou.log.aliyuncs.com" \
#     --sls-project "my-project" \
#     --sls-logstore "my-logstore" \
#     --sls-ak-id "your-ak-id" \
#     --sls-ak-secret "your-ak-secret"
#
# 安装指定版本：
#   curl -fsSL <URL>/installer.sh | bash -s -- install --version 1.2.0
#
# 升级（保留配置，失败时自动回滚）：
#   curl -fsSL <URL>/installer.sh | bash -s -- upgrade
#
# 卸载：
#   curl -fsSL <URL>/installer.sh | bash -s -- uninstall
#   curl -fsSL <URL>/installer.sh | bash -s -- uninstall --purge

# 严格模式：命令失败即退出；读取未定义变量即退出；管道中任一命令失败即失败。
set -euo pipefail

# ============================================================
# 常量和默认目录
# ============================================================
PACKAGE_NAME="loongsuite-pilot"
PERMANENT_DIR="$HOME/.loongsuite-pilot/package"
DEFAULT_DATA_DIR="$HOME/.loongsuite-pilot"

# 未显式指定安装包 URL 时使用的 OSS 下载根地址。
_OSS_BASE_URL="https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot"

# ============================================================
# 初始化命令行解析所需变量
# ============================================================
COMMAND=""
# ${变量:-默认值}：环境变量未设置或为空时使用空字符串，避免触发 set -u。
PACKAGE_URL="${LOONGSUITE_PILOT_PACKAGE_URL:-}"
INSTALL_VERSION=""
SLS_ENDPOINT=""
SLS_PROJECT=""
SLS_LOGSTORE=""
SLS_AK_ID=""
SLS_AK_SECRET=""
DATA_DIR="$DEFAULT_DATA_DIR"
LOG_LEVEL=""
USER_ID=""
COLLECT_LOG=""
COLLECT_TRACE=""
CMS_LICENSE_KEY=""
CMS_ENDPOINT=""
CMS_WORKSPACE=""
SERVICE_NAME_PREFIX=""
SELECTED_AGENTS=""
MASK_MODE=""
MASK_TYPES=""
HAS_SUDO=0
PURGE=0

# 第一个参数若是子命令就取出并 shift；若直接以选项开头，则默认执行 install。
if [[ $# -gt 0 ]]; then
    case "$1" in
        install|upgrade|uninstall)
            COMMAND="$1"; shift ;;
        -*)
            COMMAND="install" ;;
        *)
            COMMAND="install" ;;
    esac
else
    COMMAND="install"
fi

# $# 是尚未解析的参数个数；循环每次用 shift 消费一个或两个参数。
while [[ $# -gt 0 ]]; do
    case "$1" in
        --sls-endpoint)       SLS_ENDPOINT="$2"; shift 2 ;;
        --sls-endpoint=*)     SLS_ENDPOINT="${1#*=}"; shift ;;
        --sls-project)        SLS_PROJECT="$2"; shift 2 ;;
        --sls-project=*)      SLS_PROJECT="${1#*=}"; shift ;;
        --sls-logstore)       SLS_LOGSTORE="$2"; shift 2 ;;
        --sls-logstore=*)     SLS_LOGSTORE="${1#*=}"; shift ;;
        --sls-ak-id)          SLS_AK_ID="$2"; shift 2 ;;
        --sls-ak-id=*)        SLS_AK_ID="${1#*=}"; shift ;;
        --sls-ak-secret)      SLS_AK_SECRET="$2"; shift 2 ;;
        --sls-ak-secret=*)    SLS_AK_SECRET="${1#*=}"; shift ;;
        --package-url)        PACKAGE_URL="$2"; shift 2 ;;
        --package-url=*)      PACKAGE_URL="${1#--package-url=}"; shift ;;
        --data-dir)           DATA_DIR="$2"; shift 2 ;;
        --data-dir=*)         DATA_DIR="${1#*=}"; shift ;;
        --log-level)          LOG_LEVEL="$2"; shift 2 ;;
        --log-level=*)        LOG_LEVEL="${1#*=}"; shift ;;
        --userId|--user.id)   USER_ID="$2"; shift 2 ;;
        --userId=*|--user.id=*) USER_ID="${1#*=}"; shift ;;
        --lang)               export LOONGSUITE_PILOT_LANG="$2"; shift 2 ;;
        --lang=*)             export LOONGSUITE_PILOT_LANG="${1#--lang=}"; shift ;;
        --version)            INSTALL_VERSION="$2"; shift 2 ;;
        --version=*)          INSTALL_VERSION="${1#*=}"; shift ;;
        --collect-log)        COLLECT_LOG="$2"; shift 2 ;;
        --collect-log=*)      COLLECT_LOG="${1#*=}"; shift ;;
        --collect-trace)      COLLECT_TRACE="$2"; shift 2 ;;
        --collect-trace=*)    COLLECT_TRACE="${1#*=}"; shift ;;
        --cms-license-key)    CMS_LICENSE_KEY="$2"; shift 2 ;;
        --cms-license-key=*)  CMS_LICENSE_KEY="${1#*=}"; shift ;;
        --cms-endpoint)       CMS_ENDPOINT="$2"; shift 2 ;;
        --cms-endpoint=*)     CMS_ENDPOINT="${1#*=}"; shift ;;
        --cms-workspace)      CMS_WORKSPACE="$2"; shift 2 ;;
        --cms-workspace=*)    CMS_WORKSPACE="${1#*=}"; shift ;;
        --service-name-prefix) SERVICE_NAME_PREFIX="$2"; shift 2 ;;
        --service-name-prefix=*) SERVICE_NAME_PREFIX="${1#*=}"; shift ;;
        --agents)             SELECTED_AGENTS="$2"; shift 2 ;;
        --agents=*)           SELECTED_AGENTS="${1#*=}"; shift ;;
        --mask-mode)          MASK_MODE="$2"; shift 2 ;;
        --mask-mode=*)        MASK_MODE="${1#*=}"; shift ;;
        --mask-types)         MASK_TYPES="$2"; shift 2 ;;
        --mask-types=*)       MASK_TYPES="${1#*=}"; shift ;;
        --purge)              PURGE=1; shift ;;
        # 兼容旧调用方：参数仍可传入，但不再影响服务类型，服务端会自动探测。
        --system-service)
            echo "⚠️  --system-service is deprecated and ignored. Auto-detection is now the default." >&2
            shift ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1 ;;
    esac
done

# -n 表示字符串非空；这里校验脱敏模式及其与 mask-types 的组合关系。
if [ -n "$MASK_MODE" ]; then
    case "$MASK_MODE" in
        all|none|custom) ;;
        *)
            echo "❌ Unknown mask mode: $MASK_MODE (use 'all', 'custom', or 'none')" >&2
            exit 1 ;;
    esac
fi
if [ "$MASK_MODE" = "custom" ] && [ -z "$MASK_TYPES" ]; then
    echo "❌ --mask-types is required when --mask-mode custom" >&2
    exit 1
fi
if [ -n "$MASK_TYPES" ] && [ "$MASK_MODE" != "custom" ]; then
    echo "❌ --mask-types can only be used with --mask-mode custom" >&2
    exit 1
fi

# Linux 安装身份提示。输出变量 HAS_SUDO 目前仅记录 root 身份，后续不再据此
# 拼接 --system-service；实际服务类型由 loongsuite-pilot start 自动判断。
validate_install_user() {
    case "$(uname -s)" in
        Linux)
            local current_user
            current_user=$(whoami)
            # 判断当前执行脚本或命令的用户是不是root超级管理员，等于0是root用户，大于0是普通用户
            if [ "$(id -u)" -eq 0 ]; then
                # 如果是root管理员，将HAS_SUDO环境变量设置为1，该变量默认值为0
                HAS_SUDO=1
                msg "   ✅ 以 root 身份安装（自动使用系统级服务）" \
                    "   ✅ Installing as root (auto system-level service)"
            else
                msg "   Install user: $current_user（服务类型将在启动时自动检测）" \
                    "   Install user: $current_user (service type auto-detected at start)"
            fi
            ;;
    esac
}

# 未通过命令行或环境变量指定 URL 时，根据版本号拼出 OSS 地址。
if [ -z "$PACKAGE_URL" ]; then
    if [ -n "$INSTALL_VERSION" ]; then
        PACKAGE_URL="${_OSS_BASE_URL}/${INSTALL_VERSION}/${PACKAGE_NAME}.tar.gz"
    else
        PACKAGE_URL="${_OSS_BASE_URL}/latest/${PACKAGE_NAME}.tar.gz"
    fi
fi

# ============================================================
# 输出语言探测
# ============================================================
detect_lang() {
    # 优先尊重显式语言；否则依次检查常见 locale 环境变量和 macOS 系统语言。
    if [ -n "${LOONGSUITE_PILOT_LANG:-}" ]; then echo "$LOONGSUITE_PILOT_LANG"; return; fi
    for v in "${LANGUAGE:-}" "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LANG:-}"; do
        if echo "$v" | grep -qi "zh"; then echo "zh"; return; fi
    done
    if [ "$(uname)" = "Darwin" ]; then
        local al
        al=$(defaults read -g AppleLanguages 2>/dev/null | grep -i "zh" | head -1 || true)
        if [ -n "$al" ]; then echo "zh"; return; fi
    fi
    echo "en"
}
LANG_MODE=$(detect_lang)
# msg 的第一个参数是中文，第二个参数是英文。
msg() { [ "$LANG_MODE" = "zh" ] && echo "$1" || echo "$2"; }

# ============================================================
# 公共逻辑：检查依赖
# ============================================================
_resolve_realpath() {
    # realpath 不可用时尝试 readlink -f；两者都失败就原样返回输入路径。
    # 标准工具，直接解析软链接、相对路径、./ ../，输出完整规范化绝对路径，执行成功（返回码 0）：整条命令到此结束，直接拿到真实路径。
    # GNU 版 readlink 自带功能，效果等价 realpath，同样递归解析所有软链接、补齐绝对路径
    realpath "$1" 2>/dev/null || readlink -f "$1" 2>/dev/null || echo "$1"
}

_node_is_app_bundle() {
    # 返回码 0 表示 Node 位于 macOS .app 包内，这种 Node 不适合作为常驻服务运行时。
    local resolved
    # 如果是软链接、相对路径解析出绝对路径
    resolved=$(_resolve_realpath "$1")
    # 是否属于 Mac 系统标准 .app 程序包内部路径
    # /Applications/*.app/Contents/*：系统全局应用目录，所有用户可用的软件，例如/Applications/WeChat.app/Contents/MacOS/WeChat
    # /System/Applications/*.app/Contents/*：macOS 系统自带原生应用（访达、终端、照片、音乐等）所在目录
    # "$HOME"/Applications/*.app/Contents/*：当前用户个人目录下的应用文件夹，仅本用户生效
    case "$resolved" in
        /Applications/*.app/Contents/*|/System/Applications/*.app/Contents/*|"$HOME"/Applications/*.app/Contents/*)
            return 0
            ;;
    esac
    return 1
}

_node_is_suitable() {
    # 入参 $1：Node 候选路径；成功返回 0，任何条件不满足都返回 1。
    local bin="$1"
    # 文件存在 并且 文件具备可执行权限，如果文件可执行整条判断返回退出码 0，文件丢了/无执行权限，返回非 0
    [ -x "$bin" ] || return 1
    _node_is_app_bundle "$bin" && return 1
    local ver
    ver="$("$bin" --version 2>/dev/null)" || return 1
    local major="${ver#v}"
    major="${major%%.*}"
    [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 18 )) || return 1
    return 0
}

resolve_node() {
    # 输出：第一个满足条件的 Node 绝对路径；找不到时不输出并返回 1。
    # 定义局部空数组
    local _candidates=()

    # Bash glob 展开 NVM 的所有版本，再倒序检查；通常会优先较新的目录名。
    local _nvm_candidates=("$HOME/.nvm/versions/node"/*/bin/node)
    local i
    # ${#数组[@]}：bash 固定语法，获取数组元素总个数，其实就是倒叙遍历
    for (( i=${#_nvm_candidates[@]}-1; i>=0; i-- )); do
        # +=("值")，bash 数组追加语法，在原有数组基础上新增一项，不会覆盖原有数据
        _candidates+=("${_nvm_candidates[i]}")
    done

    _candidates+=(
        "$HOME/.volta/bin/node"
        "$HOME/.fnm/aliases/default/bin/node"
        /opt/homebrew/bin/node
        /usr/local/bin/node
        "$HOME/.local/bin/node"
    )
    # command -v 程序名：安全查找命令的真实可执行文件路径
    # >/dev/null 2>&1：让错误信息也跟着标准输出一起丢进黑洞
    # >/dev/null指把标准正常输出（stdout）重定向到黑洞设备/dev/null，直接丢弃
    # &1指代标准输出的目标位置，2指标准错误流stderr
    if command -v node >/dev/null 2>&1; then
        _candidates+=("$(command -v node)")
    fi
    # ${数组名[@]}：展开数组里所有独立元素，每个元素视为单独参数。
    for candidate in "${_candidates[@]}"; do
        if _node_is_suitable "$candidate"; then
            _resolve_realpath "$candidate"
            return 0
        fi
    done
    return 1
}

check_deps() {
    # 副作用：设置全局 NODE_BIN/NODE_MAJOR/NPM_BIN，并写入 $DATA_DIR/node-bin。
    msg "==> 检查依赖..." "==> Checking dependencies..."

    NODE_BIN=$(resolve_node) || {
        msg "❌ 缺少依赖: node，请先安装后重试" \
            "❌ Missing dependency: node — please install it first"
        exit 1
    }
    # process.versions.node.split('.')[0]获取主版本号，把结果输出到标准输出
    # -e：node 命令行参数，直接执行后面传入的一段 JS 字符串代码，无需新建 js 文件
    NODE_MAJOR=$("$NODE_BIN" -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
    # 如果node的版本小于18
    if [ "$NODE_MAJOR" -lt 18 ]; then
        msg "❌ 需要 Node.js >= 18，当前版本: $("$NODE_BIN" --version)" \
            "❌ Requires Node.js >= 18, current: $("$NODE_BIN" --version)"
        exit 1
    fi

    # 固化 Node 路径，后续 daemon 不必依赖用户登录 shell 中的 PATH。
    mkdir -p "$DATA_DIR" 2>/dev/null || true
    echo "$NODE_BIN" > "$DATA_DIR/node-bin"

    # 优先选择同一套 Node 安装目录中的 npm，避免 Node/npm 版本错配。
    NPM_BIN="$(dirname "$NODE_BIN")/npm"
    # 如果npm文件不存在或不是一个可执行文件
    if [ ! -x "$NPM_BIN" ]; then
        # 安全查找命令的真实可执行文件路径
        if command -v npm &>/dev/null; then
            NPM_BIN=$(command -v npm)
        else
            msg "❌ 缺少依赖: npm，请先安装后重试" \
                "❌ Missing dependency: npm — please install it first"
            exit 1
        fi
    fi

    # 判断当前系统是不是MacOS
    if [ "$(uname)" = "Darwin" ]; then
        # 获取本机 CPU 硬件架构，将结果赋值给 sys_arch
        local sys_arch; sys_arch=$(uname -m)
        # process.arch是Node内置属性，返回当前Node二进制包对应的架构标识
        local node_arch; node_arch=$("$NODE_BIN" -e "process.stdout.write(process.arch)")
        if [ "$sys_arch" = "arm64" ] && [ "$node_arch" = "x64" ]; then
            msg "⚠️  架构不匹配: 系统为 arm64 (Apple Silicon)，但 Node.js 为 x64 (Intel)" \
                "⚠️  Architecture mismatch: system is arm64 but Node.js is x64 (Intel)"
            msg "   原生模块可能无法正常加载，建议安装 arm64 版本的 Node.js" \
                "   Native modules may fail to load. Please install arm64 Node.js"
        fi
    fi

    # 如果没有安装curl也没有安装wget就答应错误信息，然后退出
    if ! command -v curl &>/dev/null && ! command -v wget &>/dev/null; then
        msg "❌ 需要 curl 或 wget，请先安装" \
            "❌ curl or wget is required — please install one first"
        exit 1
    fi

    msg "    ✅ node $("$NODE_BIN" --version)  npm $("$NPM_BIN" --version)" \
        "    ✅ node $("$NODE_BIN" --version)  npm $("$NPM_BIN" --version)"
    msg "    node pinned: $NODE_BIN" "    node pinned: $NODE_BIN"
    echo ""
}

# ============================================================
# 公共逻辑：下载安装包并解压；输出全局 INSTALL_SRC 和 TMP_DIR
# ============================================================
download_and_extract() {
    # mktemp -d 创建唯一临时目录；真正清理由 install/upgrade 注册的 EXIT trap 完成。
    TMP_DIR="$(mktemp -d)"
    # TMP_DIR 的清理由调用方设置的 trap 负责。

    msg "==> 下载安装包: $PACKAGE_URL" \
        "==> Downloading: $PACKAGE_URL"

    # command -v 只探测命令是否存在；&>/dev/null 同时丢弃标准输出和错误输出。
    # 将包通过crul或wget下载到创建好的临时目录中
    if command -v curl &>/dev/null; then
        curl -fsSL "$PACKAGE_URL" -o "$TMP_DIR/package.tar.gz"
    else
        wget -q "$PACKAGE_URL" -O "$TMP_DIR/package.tar.gz"
    fi
    msg "    ✅ 下载完成" "    ✅ Downloaded"
    echo ""

    msg "==> 解压安装包..." "==> Extracting..."
    # GNU tar 支持 --warning；BSD tar 可能不支持，所以失败后用通用参数重试。
    # 将下载到TMP_DIR临时目录的package.tar.gz解压到TMP_DIR临时目录
    if tar --warning=no-unknown-keyword -xzf "$TMP_DIR/package.tar.gz" -C "$TMP_DIR" 2>/dev/null; then
        :
    else
        tar -xzf "$TMP_DIR/package.tar.gz" -C "$TMP_DIR"
    fi
    # PACKAGE_NAME默认为loongsuite-pilot，如果该目录存在，将INSTALL_SRC赋值
    if [ -d "$TMP_DIR/$PACKAGE_NAME" ]; then
        INSTALL_SRC="$TMP_DIR/$PACKAGE_NAME"
    elif [ -f "$TMP_DIR/package.json" ]; then
        # 如果loongsuite-pilot目录不存在，则将INSTALL_SRC设置为创建的临时目录TMP_DIR
        INSTALL_SRC="$TMP_DIR"
    else
        # 通过find命令找到TMP_DIR目录下package.json文件所在的第一个目录作为INSTALL_SRC
        INSTALL_SRC=$(find "$TMP_DIR" -name "package.json" -maxdepth 2 -exec dirname {} \; | head -1 || true)
        # 如果没有找到异常退出
        if [ -z "$INSTALL_SRC" ]; then
            msg "❌ 解压后未找到 package.json，安装包结构异常" \
                "❌ package.json not found — unexpected package structure"
            exit 1
        fi
    fi
    msg "    ✅ 解压完成" "    ✅ Extracted"
    echo ""
}

# ============================================================
# Agent 探测：调用安装包中的 Node.js CLI，结果是 JSON 数组
# ============================================================
PROBE_RESULT="[]"

probe_agents() {
    # 探测失败属于可降级错误：保留空数组并继续安装，而不是让严格模式终止脚本。
    msg "==> 探测 AI Agent..." "==> Probing AI Agents..."
    # 执行src/cli-probe.ts脚本，探测已安装的Agent
    PROBE_RESULT=$("$NODE_BIN" "$INSTALL_SRC/dist/cli-probe.cjs" 2>/dev/null) || {
        msg "    ⚠️  Agent 探测失败，将跳过选择" "    ⚠️  Agent probe failed, skipping selection"
        PROBE_RESULT="[]"
        return 0
    }
    local count
    # 这里其实就是计算PROBE_RESULT数组长度
    count=$("$NODE_BIN" -e "const r=JSON.parse(process.argv[1]);process.stdout.write(String(r.length))" "$PROBE_RESULT" 2>/dev/null || echo "0")
    msg "    ✅ 探测到 ${count} 个 Agent 定义" "    ✅ Found ${count} agent definitions"
    echo ""
}

# ============================================================
# Agent 选择：优先使用 --agents，否则区分交互/非交互模式
# ============================================================
select_agents() {
    # 输出：全局 SELECTED_AGENTS，格式为逗号分隔的 Agent ID。
    # SELECTED_AGENTS初始值为""，会根据解析--agents参数传入的值，如果SELECTED_AGENTS值不为null，则不用执行后续逻辑
    if [ -n "$SELECTED_AGENTS" ]; then
        msg "    使用指定的 Agent: $SELECTED_AGENTS" "    Using specified agents: $SELECTED_AGENTS"
        echo ""
        return 0
    fi

    local agent_count
    agent_count=$("$NODE_BIN" -e "const r=JSON.parse(process.argv[1]);process.stdout.write(String(r.length))" "$PROBE_RESULT" 2>/dev/null || echo "0")
    if [ "$agent_count" = "0" ]; then
        return 0
    fi

    # stdin 不是终端时无法询问用户，自动选择 detected=true 的 Agent。
    if [ ! -t 0 ]; then
        SELECTED_AGENTS=$("$NODE_BIN" -e "
const r = JSON.parse(process.argv[1]);
const detected = r.filter(a => a.detected).map(a => a.id);
process.stdout.write(detected.join(','));
" "$PROBE_RESULT" 2>/dev/null || true)
        msg "    (非交互模式) 自动选择已检测到的 Agent: $SELECTED_AGENTS" \
            "    (non-interactive) Auto-selected detected agents: $SELECTED_AGENTS"
        echo ""
        return 0
    fi

    # 交互模式：内嵌 Node 负责打印 UTF-8 菜单并记录默认编号。
    "$NODE_BIN" -e "
const r = JSON.parse(process.argv[1]);
const lang = process.argv[2];
const defaults = [];
for (let i = 0; i < r.length; i++) {
  const a = r[i];
  const status = lang === 'zh'
    ? (a.detected ? '已检测到: ' + a.reason : '未检测到')
    : (a.detected ? 'detected: ' + a.reason : 'not detected');
  console.log('    [' + (i+1) + '] ' + a.displayName.padEnd(16) + '(' + status + ')');
  if (a.detected) defaults.push(i+1);
}
console.log('');
if (lang === 'zh') {
  console.log('    默认选择已检测到的 Agent: ' + defaults.join(','));
  console.log('    输入要启用的编号 (逗号分隔)，直接回车使用默认:');
} else {
  console.log('    Default selection (detected): ' + defaults.join(','));
  console.log('    Enter numbers to enable (comma-separated), press Enter for default:');
}
" "$PROBE_RESULT" "$LANG_MODE"

    # Node readline 负责读取 UTF-8 输入，并把中文逗号/顿号/分号归一化为英文逗号。
    # 提示符写 stderr，避免被命令替换 $(...) 捕获到 select_input 中。
    local select_input
    select_input=$("$NODE_BIN" -e "
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
rl.question('    > ', (answer) => {
  const normalized = answer.replace(/[，、；]/g, ',').trim();
  process.stdout.write(normalized);
  rl.close();
});
") || {
        printf "    > " >&2
        read -r select_input
        select_input=$(printf '%s' "$select_input" | sed 's/，/,/g; s/、/,/g; s/；/,/g')
    }

    # 空输入采用 detected 默认项；非空输入去重、丢弃越界编号，再按编号排序转成 ID。
    SELECTED_AGENTS=$("$NODE_BIN" -e "
const r = JSON.parse(process.argv[1]);
const input = (process.argv[2] || '').replace(/[，、；]/g, ',');
let indices;
if (!input.trim()) {
  indices = r.map((a, i) => a.detected ? i : -1).filter(i => i >= 0);
} else {
  indices = [...new Set(input.trim().split(/[\s,]+/).map(Number).filter(n => n >= 1 && n <= r.length))].map(n => n - 1);
}
const ids = indices.sort((a,b) => a-b).map(i => r[i].id);
process.stdout.write(ids.join(','));
" "$PROBE_RESULT" "$select_input" 2>/dev/null || true)

    if [ -n "$SELECTED_AGENTS" ]; then
        msg "    已选择: $SELECTED_AGENTS" "    Selected: $SELECTED_AGENTS"
    else
        msg "    未选择任何 Agent" "    No agents selected"
    fi
    echo ""
}

# ============================================================
# 交互输入 userId：命令行已提供或 stdin 非终端时跳过
# ============================================================
prompt_user_id() {
    # 输出：可能更新全局 USER_ID；读取配置失败和空输入都不会导致安装失败。
    # USER_ID默认为空字符串，默认会使用传入的--userId|--user.id的赋值，如果存在直接退出
    if [ -n "$USER_ID" ]; then return 0; fi
    # 判断当前脚本的标准输入（stdin）不是终端交互式窗口（管道传入数据、文件重定向输入），如果是非终端环境
    # 直接让当前函数正常返回退出（return 0）；只有在人工终端手动执行时，才会继续往下运行代码。
    if [ ! -t 0 ]; then return 0; fi

    local existing_uid=""
    # 判断$HOME/.loongsuite-pilot/config.json文件是否存在，如果存在，直接读取文件中的userId
    local config_file="$DATA_DIR/config.json"
    if [ -f "$config_file" ]; then
        existing_uid=$("$NODE_BIN" -e "
try { const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf-8')); process.stdout.write(c.userId||''); } catch {}
" -- "$config_file" 2>/dev/null || true)
    fi

    echo ""
    # 判断uid是否已经有值了，如果有的话输出值，且可以输入新值，如果没有值也会提升输出新值
    if [ -n "$existing_uid" ]; then
        msg "    当前 userId: $existing_uid" \
            "    Current userId: $existing_uid"
        msg "    直接回车保留，或输入新值:" \
            "    Press Enter to keep, or type a new value:"
    else
        msg "    请输入你的 userId（用于数据归属，可直接回车跳过）:" \
            "    Enter your userId (for data attribution, press Enter to skip):"
    fi
    printf "    > "
    local input
    # 读取输入流输入的值
    read -r input
    # 将获取的到的输入值中的空格、换行之类的去掉
    input=$(echo "$input" | tr -d '[:space:]')
    # 纯净的input如果值不为null，将USER_ID赋值为输入的值，否则将USER_ID赋值为存在的uid
    if [ -n "$input" ]; then
        USER_ID="$input"
    elif [ -n "$existing_uid" ]; then
        USER_ID="$existing_uid"
    fi
}

# ============================================================
# 交互确认：仅当现有配置中的关键非空字段将被另一个非空值覆盖时询问
# ============================================================
confirm_config_overwrite() {
    # 内嵌 Node 输出逐项差异；Shell 根据输出是否为空决定是否需要确认。
    local config_file="$DATA_DIR/config.json"
    # 如果$HOME/.loongsuite-pilot/config.json文件不存在直接退出该方法
    if [ ! -f "$config_file" ]; then return 0; fi

    # 执行node脚本并传入了两个参数：老的配置文件config_file和通过printf以及安装命令中解析出的新的参数的json
    # 脚本的作用是，判断是否有配置变化，如果有变化输出到并赋值给diffs变量，格式为：key: 旧值 -> 新值
    local diffs
    diffs=$("$NODE_BIN" -e "
const fs = require('fs');
let old = {};
try { old = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8')); } catch { process.exit(0); }

const newVals = JSON.parse(process.argv[2]);
const normalizeCsv = value => String(value || '').split(',').map(v => v.trim()).filter(Boolean).join(',');
const checks = [
  { label: 'sls.endpoint',       oldVal: (old.sls||{}).endpoint||'',       newVal: newVals.slsEndpoint },
  { label: 'sls.project',        oldVal: (old.sls||{}).project||'',        newVal: newVals.slsProject },
  { label: 'sls.logstore',       oldVal: (old.sls||{}).logstore||'',       newVal: newVals.slsLogstore },
  { label: 'cms.licenseKey',     oldVal: (old.cms||{}).licenseKey||'',     newVal: newVals.cmsLicenseKey },
  { label: 'cms.endpoint',       oldVal: (old.cms||{}).endpoint||'',       newVal: newVals.cmsEndpoint },
  { label: 'cms.workspace',      oldVal: (old.cms||{}).workspace||'',      newVal: newVals.cmsWorkspace },
  { label: 'serviceNamePrefix',  oldVal: old.serviceNamePrefix||'',        newVal: newVals.serviceNamePrefix },
  { label: 'mask.mode',          oldVal: (old.mask||{}).mode||'',          newVal: newVals.maskMode },
  { label: 'mask.types',         oldVal: Array.isArray((old.mask||{}).types) ? normalizeCsv(old.mask.types.join(',')) : '', newVal: normalizeCsv(newVals.maskTypes) },
];

const changed = checks.filter(c => c.newVal && c.oldVal && c.newVal !== c.oldVal);
if (!changed.length) process.exit(0);

for (const c of changed) {
  console.log(c.label + ': ' + c.oldVal + ' -> ' + c.newVal);
}
" -- "$config_file" "$(printf '{"slsEndpoint":"%s","slsProject":"%s","slsLogstore":"%s","cmsLicenseKey":"%s","cmsEndpoint":"%s","cmsWorkspace":"%s","serviceNamePrefix":"%s","maskMode":"%s","maskTypes":"%s"}' \
        "$SLS_ENDPOINT" "$SLS_PROJECT" "$SLS_LOGSTORE" "$CMS_LICENSE_KEY" "$CMS_ENDPOINT" "$CMS_WORKSPACE" "$SERVICE_NAME_PREFIX" "$MASK_MODE" "$MASK_TYPES")" 2>/dev/null || true)

    # 判断变量 diffs 的内容是否为空字符串；变量为空时条件成立
    if [ -z "$diffs" ]; then return 0; fi

    echo ""
    msg "⚠️  以下配置将被覆盖:" "⚠️  The following config will be overwritten:"
    # 把 $diffs 里的多行文本内容逐行读取，每一行前面统一添加 4 个空格缩进后再打印输出，实现日志格式化美化展示
    # IFS=：清空默认分隔符，保留行首、行尾的空格，不会自动裁切前后空白
    # read -r：原样读取文本，反斜杠 \ 不会被当作转义字符处理，是读取文件行的标准安全写法
    echo "$diffs" | while IFS= read -r line; do
        echo "    $line"
    done

    if [ -t 0 ]; then
        echo ""
        msg "    确认覆盖? (y/N):" "    Confirm overwrite? (y/N):"
        printf "    > "
        local answer
        read -r answer
        # 判断用户输入，如果同意直接结束方法，如果不同意退出安装脚本
        case "$answer" in
            y|Y|yes|YES) ;;
            *)
                msg "已取消安装" "Installation cancelled"
                exit 0
                ;;
        esac
    else
        msg "    (非交互模式) 继续覆盖" \
            "    (non-interactive) Proceeding with overwrite"
    fi
}

# ============================================================
# 公共逻辑：把当前版本所需的稳定启动脚本复制到版本目录之外
# ============================================================
deploy_bootstrap_scripts() {
    # collector 必须存在；updater 为可选文件，缺失时用 || true 忽略失败。
    # PERMANENT_DIR一般是$HOME/.loongsuite-pilot/versions/1.0.0_d066770，如果是老版本的为$HOME/.loongsuite-pilot/package
    local src_dir="$PERMANENT_DIR/scripts"
    local boot_dir="$HOME/.loongsuite-pilot/bin"
    # 创建$HOME/.loongsuite-pilot/bin目录
    mkdir -p "$boot_dir"
    # 将$HOME/.loongsuite-pilot/versions/1.0.0_d066770/scripts/collector-daemon.js脚本拷贝到$HOME/.loongsuite-pilot/bin目录
    cp -f "$src_dir/collector-daemon.js" "$boot_dir/"
    # 判断若$HOME/.loongsuite-pilot/versions/1.0.0_d066770/scripts/updater-daemon.js文件存在，就拷贝到$HOME/.loongsuite-pilot/bin目录
    [ -f "$src_dir/updater-daemon.js" ] && cp -f "$src_dir/updater-daemon.js" "$boot_dir/" || true
}

# ============================================================
# 公共逻辑：把安装包部署到 versions/，缺少版本元数据时兼容旧 package/ 布局
# ============================================================
deploy_package() {
    # 入参 $1：解压后的安装源目录,一般是TMP_DIR/loongsuite-pilot；输出：更新全局 PERMANENT_DIR。
    local src="$1"
    local cache_dir="$HOME/.loongsuite-pilot"
    local versions_dir="$cache_dir/versions"
    local current_file="$cache_dir/current"
    local previous_file="$cache_dir/previous"

    local ver="" commit=""
    if [ -f "$src/VERSION" ]; then
        # 读取TMP_DIR/loongsuite-pilot/VERSION文件中version=行的具体版本号
        ver=$(grep '^version=' "$src/VERSION" | cut -d= -f2)
        # 读取TMP_DIR/loongsuite-pilot/VERSION文件中git_commit=行的具体commitId
        commit=$(grep '^git_commit=' "$src/VERSION" | cut -d= -f2)
    fi

    # 如果ver和commit都存在，比如当前的ver为1.0.0，commit为d066770
    if [ -n "$ver" ] && [ -n "$commit" ]; then
        # 定义目录名称：1.0.0_d066770
        local dir_name="${ver}_${commit}"
        # $HOME/.loongsuite-pilot/versions/1.0.0_d066770
        local target="$versions_dir/$dir_name"

        # 切换版本前把旧 current 保存为 previous，供 rollback 使用。
        # 判断$HOME/.loongsuite-pilot/current文件是否存在
        if [ -f "$current_file" ]; then
            local old_dir
            # 存在的话，读取$HOME/.loongsuite-pilot/current文件内容，且替换所有空格或换行符
            old_dir=$(cat "$current_file" 2>/dev/null | tr -d '[:space:]')
            # 判断如果old_dir不为空，且值不等于1.0.0_d066770，将old_dir写入到$HOME/.loongsuite-pilot/previous文件中
            if [ -n "$old_dir" ] && [ "$old_dir" != "$dir_name" ]; then
                echo "$old_dir" > "$previous_file"
            fi
        fi

        msg "==> 部署到 $target ..." "==> Deploying to $target ..."
        # 创建$HOME/.loongsuite-pilot/versions目录
        mkdir -p "$versions_dir"
        # 删除$HOME/.loongsuite-pilot/versions/1.0.0_d066770目录
        rm -rf "$target"
        # 拷贝解压安装包后的TMP_DIR/loongsuite-pilot目录内容到$HOME/.loongsuite-pilot/versions/1.0.0_d066770目录中
        cp -r "$src" "$target"

        # 先写临时文件再 mv，避免 current 被读取时只看到半行内容。
        # 将1.0.0_d066770写入到$HOME/.loongsuite-pilot/current.tmp文件中
        echo "$dir_name" > "$current_file.tmp"
        # 将current.tmp文件更名为current
        mv -f "$current_file.tmp" "$current_file"
        # 将PERMANENT_DIR赋值为$HOME/.loongsuite-pilot/versions/1.0.0_d066770
        PERMANENT_DIR="$target"
    else
        msg "==> 部署到 $PERMANENT_DIR ..." \
            "==> Deploying to $PERMANENT_DIR ..."
        # PERMANENT_DIR默认值为$HOME/.loongsuite-pilot/package，这个可能是兼容的老版本的
        # 如果$HOME/.loongsuite-pilot/目录不存在，就创建目录
        mkdir -p "$(dirname "$PERMANENT_DIR")"
        # 删除$HOME/.loongsuite-pilot/package目录及目录中的内容
        rm -rf "$PERMANENT_DIR"
        # 拷贝解压安装包后的TMP_DIR/loongsuite-pilot目录内容到$HOME/.loongsuite-pilot/package目录中
        cp -r "$src" "$PERMANENT_DIR"
    fi
    msg "    ✅ 部署完成" "    ✅ Deployed"
    echo ""
    # 把当前版本所需的稳定启动脚本collector-daemon.js和updater-daemon.js复制到版本目录之外的$HOME/.loongsuite-pilot/bin目录
    deploy_bootstrap_scripts

    msg "==> 安装依赖..." "==> Installing dependencies..."
    # 子 shell 中切换工作目录；pipefail 保证 npm 失败不会被 tail 的成功掩盖。
    # 首先进入到$HOME/.loongsuite-pilot/versions/1.0.0_d066770目录
    # 然后调用npm执行生产环境依赖安装，只安装dependencies正式依赖，自动跳过开发依赖、可选依赖，精简部署包体积
    (cd "$PERMANENT_DIR" && "$NPM_BIN" install --production --no-optional 2>&1 | tail -1)
    msg "    ✅ 依赖安装完成" "    ✅ Dependencies installed"
    echo ""

    msg "==> 部署 hook 脚本..." "==> Deploying hook scripts..."
    # 注意：这里判断的是安装器进程当前目录$HOME/.loongsuite-pilot/versions/1.0.0_d066770下的scripts/postinstall.js。
    if [ -f scripts/postinstall.js ]; then
        # 执行postinstall脚本，作用是将项目下的assets目录中的hooks、plugins、skills目录中的内容拷贝到$HOME/.loongsuite-pilot/的hooks、plugins、skills目录中
        # 且给hooks目录下的所有sh脚本或者ps1脚本添加读和执行权限755，防止执行时无权限
        "$NODE_BIN" scripts/postinstall.js
    fi
    msg "    ✅ Hook 脚本已部署" "    ✅ Hook scripts deployed"
    msg "    如使用 Codex 桌面版，首次启动需在桌面端手动信任 hooks" \
        "    If using Codex desktop app, please manually trust hooks on first launch"
    echo ""
}

# ============================================================
# 将旧的单 package/ 布局迁移为 versions/ + current 指针布局
# ============================================================
migrate_legacy_layout() {
    # 仅复制旧目录，不删除 legacy_dir；current 已存在时认为无需迁移。
    local cache_dir="$HOME/.loongsuite-pilot"
    local current_file="$cache_dir/current"
    local legacy_dir="$cache_dir/package"
    local versions_dir="$cache_dir/versions"

    # 如果$HOME/.loongsuite-pilot/current文件已存在时认为无需迁移，直接退出
    if [ -f "$current_file" ]; then
        return 0
    fi
    # 如果$HOME/.loongsuite-pilot/package目录或$HOME/.loongsuite-pilot/dist/index.js文件不存在也直接退出
    if [ ! -d "$legacy_dir" ] || [ ! -f "$legacy_dir/dist/index.js" ]; then
        return 0
    fi

    msg "==> 迁移旧版本目录结构..." "==> Migrating legacy directory layout..."

    local ver="" commit=""
    # 如果$HOME/.loongsuite-pilot/package/VERSION文件存在
    if [ -f "$legacy_dir/VERSION" ]; then
        ver=$(grep '^version=' "$legacy_dir/VERSION" | cut -d= -f2)
        commit=$(grep '^git_commit=' "$legacy_dir/VERSION" | cut -d= -f2)
    fi
    # 如果$HOME/.loongsuite-pilot/package/VERSION文件不存在，使用默认值
    ver="${ver:-0.0.0}"
    commit="${commit:-legacy}"

    local dir_name="${ver}_${commit}"
    # target为$HOME/.loongsuite-pilot/package/version/${ver}_${commit}
    local target="$versions_dir/$dir_name"
    # 创建$HOME/.loongsuite-pilot/package/version目录
    mkdir -p "$versions_dir"
    # 拷贝$HOME/.loongsuite-pilot/package目录中的内容到$HOME/.loongsuite-pilot/package/version/${ver}_${commit}
    cp -r "$legacy_dir" "$target"
    # 将版本号${ver}_${commit}写入到$HOME/.loongsuite-pilot/current文件中
    echo "$dir_name" > "$current_file"

    PERMANENT_DIR="$target"
    msg "    ✅ 已迁移到 $target" "    ✅ Migrated to $target"
    echo ""
}

# ============================================================
# 公共逻辑：用内嵌 Node 合并写入 config.json
# ============================================================
write_config() {
    # Shell 先展开 ${...}，Node 再解析和写 JSON；PROBE_RESULT 通过 argv 传入。
    local config_file="$DATA_DIR/config.json"
    msg "==> 写入配置文件 $config_file ..." \
        "==> Writing config to $config_file ..."
    mkdir -p "$DATA_DIR"

    "$NODE_BIN" -e "
const fs = require('fs');
const path = '$config_file';

// 旧配置不存在或不是合法 JSON 时，从空对象开始。
let existing = {};
try { existing = JSON.parse(fs.readFileSync(path, 'utf-8')); } catch {}

// 展开旧配置以保留未涉及字段，但 enabled/dataDir 始终由本次安装覆盖。
const config = {
  ...existing,
  enabled: true,
  dataDir: '$DATA_DIR',
};
delete config.internal;
if (config.userId === undefined && config['user.id'] !== undefined) {
  config.userId = config['user.id'];
}
delete config['user.id'];

const slsEndpoint = '${SLS_ENDPOINT}';
const slsProject  = '${SLS_PROJECT}';
const slsLogstore = '${SLS_LOGSTORE}';
const slsAkId     = '${SLS_AK_ID}';
const slsAkSecret = '${SLS_AK_SECRET}';
const logLevel    = '${LOG_LEVEL}';
const userId      = '${USER_ID}';

// 只有 endpoint/project/logstore 至少一个非空时才进入 SLS 更新分支。
if (slsEndpoint || slsProject || slsLogstore) {
  config.sls = config.sls || {};
  delete config.sls.destinationOverride;
  if (slsEndpoint) {
    config.sls.endpoint = slsEndpoint;
  }
  if (slsAkId && slsAkSecret) {
    config.sls.mode = 'ak';
    config.sls.accessKeyId = slsAkId;
    config.sls.accessKeySecret = slsAkSecret;
  }
  if (slsProject && slsLogstore) {
    config.sls.project = slsProject;
    config.sls.logstore = slsLogstore;
    delete config.sls.endpoints;
  }
}

if (logLevel) {
  config.logLevel = logLevel;
}

if (userId) {
  config.userId = userId;
  delete config.identity;
}

const collectLog = '${COLLECT_LOG}';
const collectTrace = '${COLLECT_TRACE}';
const cmsLicenseKey = '${CMS_LICENSE_KEY}';
const cmsEndpoint = '${CMS_ENDPOINT}';
const cmsWorkspace = '${CMS_WORKSPACE}';
const serviceNamePrefix = '${SERVICE_NAME_PREFIX}';
const selectedAgents = '${SELECTED_AGENTS}';
const maskMode = '${MASK_MODE}';
const maskTypes = '${MASK_TYPES}';

if (collectLog) config.collectLog = collectLog === 'true';
if (collectTrace) config.collectTrace = collectTrace === 'true';

if (cmsLicenseKey || cmsEndpoint || cmsWorkspace) {
  config.cms = config.cms || {};
  if (cmsLicenseKey) config.cms.licenseKey = cmsLicenseKey;
  if (cmsEndpoint) config.cms.endpoint = cmsEndpoint;
  if (cmsWorkspace) config.cms.workspace = cmsWorkspace;
}

if (serviceNamePrefix) config.serviceNamePrefix = serviceNamePrefix;

if (maskMode) {
  config.mask = config.mask || {};
  config.mask.mode = maskMode;
  if (maskMode === 'custom') {
    config.mask.types = maskTypes
      .split(',')
      .map(type => type.trim())
      .filter(Boolean);
  } else {
    delete config.mask.types;
  }
}

// 只遍历探测结果中的 Agent；--agents 中未知 ID 不会凭空创建配置项。
if (selectedAgents) {
  config.agents = config.agents || {};
  const selected = selectedAgents.split(',').map(s => s.trim()).filter(Boolean);
  const allAgents = JSON.parse(process.argv[1] || '[]');
  for (const agent of allAgents) {
    config.agents[agent.id] = config.agents[agent.id] || {};
    config.agents[agent.id].enabled = selected.includes(agent.id);
  }
}
// 将最终的配置内容覆写到~/.loongsuite-pilot/config.json文件中
fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
" -- "$PROBE_RESULT"
    msg "    ✅ 配置已写入" "    ✅ Config written"
    echo ""
}

# ============================================================
# 公共逻辑：安装或更新 loongsuite-pilot 服务管理命令
# ============================================================
install_loongsuite_pilot_command() {
    # 固定安装到 ~/.local/bin；若 /usr/local/bin 可写，再创建一个全局软链接。
    msg "==> 安装服务管理脚本..." "==> Installing service management script..."
    local global_bin_dir="$HOME/.local/bin"
    mkdir -p "$global_bin_dir"

    local loongsuite_pilot_cmd="$global_bin_dir/loongsuite-pilot"
    # 拷贝$HOME/.loongsuite-pilot/1.0.0_d066770/versions/scripts/loongsuite-pilot.sh脚本到$HOME/.local/bin/loongsuite-pilot文件中
    cp -f "$PERMANENT_DIR/scripts/loongsuite-pilot.sh" "$loongsuite_pilot_cmd"
    # 给$HOME/.local/bin/loongsuite-pilot目录目录添加执行权限
    chmod +x "$loongsuite_pilot_cmd"
    msg "    ✅ 已安装: $loongsuite_pilot_cmd" "    ✅ Installed: $loongsuite_pilot_cmd"

    # /usr/local/bin 可写时创建软链接，使当前和新 shell 都能直接找到命令。
    if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
        # 如果/usr/local/bin目录存在，且可写，则创建$HOME/.local/bin/loongsuite-pilot的软连接/usr/local/bin/loongsuite-pilot
        ln -sf "$loongsuite_pilot_cmd" /usr/local/bin/loongsuite-pilot
        msg "    ✅ 已链接到 /usr/local/bin/loongsuite-pilot" "    ✅ Linked to /usr/local/bin/loongsuite-pilot"
    else
        # else的作用其实就是在不存在/usr/local/bin文件或该文件不可写的情况下，将"$HOME/.local/bin添加到环境变量PATH中
        ensure_path_block() {
            # 入参 $1：要修改的 shell 启动文件；已包含 .local/bin 时保持幂等。
            local file="$1"
            # 文件不存在或者不可写都直接跳过
            if [ ! -f "$file" ]; then
                touch "$file" 2>/dev/null || return 0
            fi
            if [ ! -w "$file" ]; then
                msg "    ⚠️  $file 不可写，跳过" "    ⚠️  $file is not writable, skipping"
                return 0
            fi
            if grep -q '\.local/bin' "$file" 2>/dev/null; then return 0; fi
            # 若文件非空且末尾没有换行，先补一个换行，避免追加内容粘到原末行。
            [ -s "$file" ] && [ "$(tail -c1 "$file" | wc -l)" -eq 0 ] && echo "" >> "$file"
            # >>的作用是追加写入，如果是>的话就是清空写入，两个 PATHBLOCK 中间包裹的所有内容，原样写入目标文件
            cat >> "$file" << 'PATHBLOCK'

# loongsuite-pilot: add ~/.local/bin to PATH
export PATH="$HOME/.local/bin:$PATH"
PATHBLOCK
            msg "    已将 ~/.local/bin 添加到 PATH ($file)" \
                "    Added ~/.local/bin to PATH ($file)"
        }

        case "${SHELL:-/bin/bash}" in
            */zsh)
                ensure_path_block "$HOME/.zshrc" || true
                ;;
            */bash)
                ensure_path_block "$HOME/.bashrc" || true
                # 不为 PATH 专门创建 ~/.bash_profile。Debian/Ubuntu 的登录 Bash 一旦
                # 发现该文件就不会再读 ~/.profile，可能连带跳过其中加载的用户别名。
                if [ -f "$HOME/.bash_profile" ]; then
                    ensure_path_block "$HOME/.bash_profile" || true
                elif [ -f "$HOME/.bash_login" ]; then
                    ensure_path_block "$HOME/.bash_login" || true
                else
                    ensure_path_block "$HOME/.profile" || true
                fi
                ;;
            *)
                ensure_path_block "$HOME/.bashrc" || true
                ;;
        esac
    fi
    echo ""

    # 立即修改当前安装器进程的 PATH，后续无需等待用户重开终端。将$HOME/.local/bin添加到PATH中
    export PATH="$global_bin_dir:$PATH"
}

# ============================================================
# qodercli token 拦截：向 shell rc 注入或移除包装函数
# ============================================================
_sed_inplace() {
    # macOS BSD sed 的 -i 必须带备份扩展名参数；GNU sed 不需要。
    if [[ "$(uname)" == "Darwin" ]]; then
        sed -i '' "$@"
    else
        sed -i "$@"
    fi
}

inject_qodercli_token_intercept() {
    # 未选择 qoder 时先清除历史注入；命令或拦截脚本不存在时直接跳过。
    if ! echo "$SELECTED_AGENTS" | grep -q 'qoder'; then remove_qodercli_token_intercept; return 0; fi
    if ! command -v qodercli >/dev/null 2>&1; then return 0; fi

    local intercept_script="$DATA_DIR/hooks/qodercli-token-intercept.mjs"
    if [ ! -f "$intercept_script" ]; then return 0; fi

    msg "==> 配置 qodercli token 采集..." "==> Configuring qodercli token intercept..."

    _inject_to_rc() {
        # 内部函数，仅修改实际存在且可写的当前 shell rc 文件。
        local file="$1"
        if [ ! -f "$file" ]; then return 0; fi
        if [ ! -w "$file" ]; then
            msg "    ⚠️  $file 不可写，跳过" "    ⚠️  $file is not writable, skipping"
            return 0
        fi
        # 如果已有当前带 alias guard 的新版 block，则保持幂等直接返回；若是旧版裸函数
        # block，则先按 BEGIN/END 范围删除，再写入不会与用户 alias 冲突的新版。
        if grep -q 'loongsuite-pilot BEGIN qodercli-intercept' "$file" 2>/dev/null; then
            if grep -qF 'if ! alias qodercli >/dev/null 2>&1' "$file"; then return 0; fi
            _sed_inplace '/# loongsuite-pilot BEGIN qodercli-intercept/,/# loongsuite-pilot END qodercli-intercept/d' "$file"
        fi
        [ -s "$file" ] && [ "$(tail -c1 "$file" | wc -l)" -eq 0 ] && echo "" >> "$file"
        # 未给 heredoc 分隔符加引号，因此安装时展开 $DATA_DIR；\$@ 被转义，留到用户
        # 真正调用 qodercli 时才展开。eval 延后函数定义，可避免交互 shell 在解析阶段
        # 展开同名 alias 而报错。此 block 需与 hook-watchdog.ts 保持字节一致。
        cat >> "$file" << INTERCEPTBLOCK

# loongsuite-pilot BEGIN qodercli-intercept
if ! alias qodercli >/dev/null 2>&1 && ! typeset -f qodercli >/dev/null 2>&1; then
  eval 'qodercli() { BUN_OPTIONS="--preload=$DATA_DIR/hooks/qodercli-token-intercept.mjs" command qodercli "\$@"; }'
fi
# loongsuite-pilot END qodercli-intercept
INTERCEPTBLOCK
        msg "    ✅ 已写入 $file (请执行 source $file 或打开新终端)" \
            "    ✅ Written to $file (run: source $file or open a new terminal)"
    }

    case "${SHELL:-/bin/bash}" in
        */zsh)  _inject_to_rc "$HOME/.zshrc" ;;
        */bash) _inject_to_rc "$HOME/.bashrc" ;;
        *)      _inject_to_rc "$HOME/.bashrc" ;;
    esac

    # 若用户在托管 block 外自定义了同名 alias/function，guard 会放弃注入；这里给出
    # 一次性提示，说明如何手动把 BUN_OPTIONS 合入用户自己的定义。
    if _rc_user_override_present qodercli \
        'loongsuite-pilot BEGIN qodercli-intercept' \
        'loongsuite-pilot END qodercli-intercept'; then
        msg "    ⚠️  检测到你已自定义 qodercli(alias/function)，为避免覆盖，采集未启用。" \
            "    ⚠️  Detected your own 'qodercli' (alias/function); collection is disabled to avoid clobbering it."
        msg "        如需启用采集，请在你的 qodercli 定义中加入： BUN_OPTIONS=\"--preload=$DATA_DIR/hooks/qodercli-token-intercept.mjs\"" \
            "        To enable collection, add to your qodercli definition: BUN_OPTIONS=\"--preload=$DATA_DIR/hooks/qodercli-token-intercept.mjs\""
    fi
    echo ""
}

remove_qodercli_token_intercept() {
    # 在所有常见 rc 文件中按成对 marker 删除托管 block；文件不存在则跳过。
    for file in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
        if [ -f "$file" ] && grep -q 'loongsuite-pilot BEGIN qodercli-intercept' "$file" 2>/dev/null; then
            _sed_inplace '/# loongsuite-pilot BEGIN qodercli-intercept/,/# loongsuite-pilot END qodercli-intercept/d' "$file"
            msg "    已清理 qodercli token intercept ($file)" \
                "    Cleaned up qodercli token intercept ($file)"
        fi
    done
}

# ============================================================
# QoderWork runtime wrapper：通过 QODER_WORKER_RUNTIME_PATH 拦截 token 用量
#
# QoderWork 在 Node.js worker_thread 而不是 Bun 中运行 SDK，不能复用 qodercli 的
# BUN_OPTIONS 方案。它支持用 QODER_WORKER_RUNTIME_PATH 指定 worker 入口；包装器先
# 安装 JSON.parse hook 再导入真实 runtime。目前仅在 macOS 用 launchctl 向 GUI 进程
# 注入环境变量，Linux/Windows 直接跳过。
# ============================================================
inject_qoderwork_runtime_wrapper() {
    # 副作用：设置当前 launchd 会话环境变量，并写入一个持久化 LaunchAgent plist。
    if [ "$(uname)" != "Darwin" ]; then return 0; fi
    # 未选择 qoder-work 时清除旧环境变量和 plist，再返回。
    if ! echo "$SELECTED_AGENTS" | grep -q 'qoder-work'; then remove_qoderwork_runtime_wrapper; return 0; fi
    # 同时兼容系统级 /Applications 和用户级 ~/Applications 安装。
    if [ ! -d "/Applications/QoderWork.app" ] && [ ! -d "$HOME/Applications/QoderWork.app" ]; then return 0; fi

    local wrapper_script="$DATA_DIR/hooks/qoderwork-runtime-wrapper.mjs"
    if [ ! -f "$wrapper_script" ]; then return 0; fi

    msg "==> 配置 QoderWork token 采集..." "==> Configuring QoderWork token intercept..."

    # 第 1 步：立即设置当前 launchd 会话，无需注销登录即可被重启后的应用继承。
    launchctl setenv QODER_WORKER_RUNTIME_PATH "$wrapper_script"

    # 第 2 步：写 LaunchAgent plist。单独的 launchctl setenv 仅对当前会话有效；
    # RunAtLoad 会在每次用户登录时重新执行 setenv，从而跨重启保留注入。
    local plist_dir="$HOME/Library/LaunchAgents"
    local plist_path="$plist_dir/com.loongsuite-pilot.qoderwork-env.plist"
    mkdir -p "$plist_dir"
    cat > "$plist_path" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.loongsuite-pilot.qoderwork-env</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/launchctl</string>
        <string>setenv</string>
        <string>QODER_WORKER_RUNTIME_PATH</string>
        <string>$wrapper_script</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
PLIST

    # 第 3 步：先 unload 再 load，以幂等方式刷新可能变化的路径；失败不致命，因为
    # 第 1 步已经满足当前会话的即时使用。
    launchctl unload "$plist_path" 2>/dev/null || true
    launchctl load "$plist_path" 2>/dev/null || true

    msg "    ✅ launchctl setenv QODER_WORKER_RUNTIME_PATH" \
        "    ✅ launchctl setenv QODER_WORKER_RUNTIME_PATH"
    msg "    ✅ LaunchAgent 已注册 (重启 macOS 后自动恢复 env)" \
        "    ✅ LaunchAgent registered (auto-restores env after macOS reboot)"
    msg "    ⚠️  请完全退出并重新打开 QoderWork 以生效" \
        "    ⚠️  Please fully quit and restart QoderWork for changes to take effect"
    echo ""
}

remove_qoderwork_runtime_wrapper() {
    # 只在 macOS 清理本脚本创建的 plist，以及值中含 loongsuite-pilot 的会话变量。
    if [ "$(uname)" != "Darwin" ]; then return 0; fi

    # 卸载并删除 LaunchAgent，阻止下次登录时再次恢复环境变量。
    local plist_path="$HOME/Library/LaunchAgents/com.loongsuite-pilot.qoderwork-env.plist"
    if [ -f "$plist_path" ]; then
        launchctl unload "$plist_path" 2>/dev/null || true
        rm -f "$plist_path"
        msg "    已清理 LaunchAgent (qoderwork-env)" \
            "    Cleaned up LaunchAgent (qoderwork-env)"
    fi

    # 同时清理当前会话；先匹配值，避免误删用户手动设置的非 Pilot 路径。
    if launchctl getenv QODER_WORKER_RUNTIME_PATH 2>/dev/null | grep -q 'loongsuite-pilot'; then
        launchctl unsetenv QODER_WORKER_RUNTIME_PATH
        msg "    已清理 QODER_WORKER_RUNTIME_PATH" \
            "    Cleaned up QODER_WORKER_RUNTIME_PATH"
    fi
}

# ============================================================
# Claude Code fetch 拦截：向 shell rc 注入或移除包装函数
#
# 采用 shell wrapper 而不是 ~/.claude/settings.json env：Claude Code 是 Bun 编译的
# 二进制，Bun 在任何 JS 执行前就读取 BUN_OPTIONS；settings.json 只影响子进程，时机
# 太晚。包装函数会在启动 claude 前前置 Pilot preload，并保留已有 BUN_OPTIONS。
# ============================================================
# 检测托管 block 之外用户定义的 <cli> alias/function。
# 入参：$1=CLI 名，$2=BEGIN marker，$3=END marker；找到返回 0，否则返回 1。
# 检查前先用 sed 剔除本脚本 block，避免把自己的函数误判为用户定义。此启发式检查
# 不会递归扫描 rc 文件 source 的其他文件。
_rc_user_override_present() {
    local cli="$1" begin="$2" end="$3" file
    for file in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
        [ -f "$file" ] || continue
        if sed "/$begin/,/$end/d" "$file" 2>/dev/null \
           | grep -Eq "^[[:space:]]*(alias[[:space:]]+$cli=|(function[[:space:]]+)?$cli[[:space:]]*\(\)|function[[:space:]]+$cli([[:space:]]|\{|\$))"; then
            return 0
        fi
    done
    return 1
}

inject_claude_code_fetch_intercept() {
    # 未选择 claude-code 时清除历史 block；claude 或拦截脚本不存在时跳过。
    # 如果用户选中的代理列表里不包含 claude-code 组件，就执行清理函数删掉 Claude 相关的拦截注入配置，然后直接结束当前函数（正常返回）；
    # 只有选中了 claude-code，才会继续往下执行加载、注入拦截的逻辑。
    if ! echo "$SELECTED_AGENTS" | grep -q 'claude-code'; then remove_claude_code_fetch_intercept; return 0; fi
    # 检查本地是否安装了claude，没有安装就直接退出
    if ! command -v claude >/dev/null 2>&1; then return 0; fi

    # 将intercept_script赋值为$HOME/.loongsuite-pilot/hooks/claude-code-fetch-intercept.mjs
    local intercept_script="$DATA_DIR/hooks/claude-code-fetch-intercept.mjs"
    # 如果$HOME/.loongsuite-pilot/hooks/claude-code-fetch-intercept.mjs文件不存在，直接退出
    if [ ! -f "$intercept_script" ]; then return 0; fi

    msg "==> 配置 claude-code fetch 拦截..." "==> Configuring claude-code fetch intercept..."

    _inject_to_rc() {
        local file="$1"
        # 如果对应的配置文件不存在，直接退出
        if [ ! -f "$file" ]; then return 0; fi
        # 如果对应的配置文件不可写  直接退出
        if [ ! -w "$file" ]; then
            msg "    ⚠️  $file 不可写，跳过" "    ⚠️  $file is not writable, skipping"
            return 0
        fi
        # 已是带 alias guard 的新版 block 时直接返回；旧版裸函数 block 先删后换。
        if grep -q 'loongsuite-pilot BEGIN claude-code-intercept' "$file" 2>/dev/null; then
            # 如果在环境变量的配置文件中存在claude的别名直接退出
            if grep -qF 'if ! alias claude >/dev/null 2>&1' "$file"; then return 0; fi
            # 先删除出配置
            _sed_inplace '/# loongsuite-pilot BEGIN claude-code-intercept/,/# loongsuite-pilot END claude-code-intercept/d' "$file"
        fi
        # -s：文件存在并且文件大小大于 0（不是空文件）
        # tail -c1：读取文件最后 1 个字节
        # wc -l 统计行数规则：只有文本末尾存在换行符（\n），最后一行才会被计数一行
        # 文件有内容，但结尾没有换行符，echo "" 会输出一个纯换行符，>> 追加写入文件尾部，补齐缺失的换行
        [ -s "$file" ] && [ "$(tail -c1 "$file" | wc -l)" -eq 0 ] && echo "" >> "$file"
        # heredoc 在安装时展开 $DATA_DIR；\${BUN_OPTIONS} 和 \$@ 留到运行包装函数时展开。
        # alias/function guard 避免覆盖用户定义，eval 避免同名 alias 引起解析错误。
        # 此 block 需与 src/core/hook-watchdog.ts 保持字节一致。
        # 当既没有名叫 claude 的 Shell 别名，也没有名叫 claude 的 Shell 函数时，进入 if 内部逻辑
        cat >> "$file" << INTERCEPTBLOCK

# loongsuite-pilot BEGIN claude-code-intercept
if ! alias claude >/dev/null 2>&1 && ! typeset -f claude >/dev/null 2>&1; then
  eval 'claude() { BUN_OPTIONS="--preload=$DATA_DIR/hooks/claude-code-fetch-intercept.mjs \${BUN_OPTIONS}" command claude "\$@"; }'
fi
# loongsuite-pilot END claude-code-intercept
INTERCEPTBLOCK
        msg "    ✅ 已写入 $file (请执行 source $file 或打开新终端)" \
            "    ✅ Written to $file (run: source $file or open a new terminal)"
    }

    case "${SHELL:-/bin/bash}" in
        */zsh)  _inject_to_rc "$HOME/.zshrc" ;;
        */bash) _inject_to_rc "$HOME/.bashrc" ;;
        *)      _inject_to_rc "$HOME/.bashrc" ;;
    esac

    # 用户自定义 claude 时不会自动覆盖，改为提示其手工合并 BUN_OPTIONS。
    # 其实添加的脚本的含义是：
    # claude() {
    #  # 把拦截脚本路径追加到 BUN_OPTIONS 最前面
    #  BUN_OPTIONS="--preload=$DATA_DIR/hooks/claude-code-fetch-intercept.mjs ${BUN_OPTIONS}"
    #  # 调用系统原生真实 claude 二进制程序，透传用户全部参数
    #  command claude "$@"
    #}
    if _rc_user_override_present claude \
        'loongsuite-pilot BEGIN claude-code-intercept' \
        'loongsuite-pilot END claude-code-intercept'; then
        msg "    ⚠️  检测到你已自定义 claude(alias/function)，为避免覆盖，采集未启用。" \
            "    ⚠️  Detected your own 'claude' (alias/function); collection is disabled to avoid clobbering it."
        msg "        如需启用采集，请在你的 claude 定义中加入： BUN_OPTIONS=\"--preload=$DATA_DIR/hooks/claude-code-fetch-intercept.mjs \${BUN_OPTIONS}\"" \
            "        To enable collection, add to your claude definition: BUN_OPTIONS=\"--preload=$DATA_DIR/hooks/claude-code-fetch-intercept.mjs \${BUN_OPTIONS}\""
    fi
    echo ""
}

# 删除"$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"等文件中
# 从包含# loongsuite-pilot BEGIN claude-code-intercept的行，一直到包含# loongsuite-pilot END claude-code-intercept的行，整片区间
remove_claude_code_fetch_intercept() {
    # 按 marker 从常见 shell rc 文件中删除 Claude wrapper block。
    for file in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
        if [ -f "$file" ] && grep -q 'loongsuite-pilot BEGIN claude-code-intercept' "$file" 2>/dev/null; then
            # 匹配范围：从包含# loongsuite-pilot BEGIN claude-code-intercept的行，一直到包含# loongsuite-pilot END claude-code-intercept的行，整片区间
            # d = delete 删除匹配到的所有行
            # 精准删掉当初 loongsuite-pilot 写入在 Shell 配置里一整块的 intercept 相关配置代码段
            _sed_inplace '/# loongsuite-pilot BEGIN claude-code-intercept/,/# loongsuite-pilot END claude-code-intercept/d' "$file"
            msg "    已清理 claude-code fetch intercept ($file)" \
                "    Cleaned up claude-code fetch intercept ($file)"
        fi
    done
}

# ============================================================
# 公共逻辑：读取 VERSION 文件字段
# ============================================================
get_installed_version() {
    # 优先按 current 指针读取版本化目录；找不到时回退到 PERMANENT_DIR。
    local cache_dir="$HOME/.loongsuite-pilot"
    local current_file="$cache_dir/current"
    local versions_dir="$cache_dir/versions"

    # 如果$HOME/.loongsuite-pilot/current文件存在
    if [ -f "$current_file" ]; then
        local dir
        # 2>/dev/null的作用是将标准错误流丢弃到空设备
        # tr -d的作用是删除指定字符集，抹掉文件里所有换行、前后空格、中间空格、缩进制表符
        # [:space:] 是系统内置空白字符全集，包含：空格、制表符\t、换行\n、回车\r、纵向制表符、换页符
        dir=$(cat "$current_file" 2>/dev/null | tr -d '[:space:]')
        if [ -n "$dir" ] && [ -f "$versions_dir/$dir/VERSION" ]; then
            grep '^version=' "$versions_dir/$dir/VERSION" | cut -d= -f2
            return 0
        fi
    fi
    # PERMANENT_DIR默认值为$HOME/.loongsuite-pilot/package
    local vf="$PERMANENT_DIR/VERSION"
    if [ -f "$vf" ]; then
        # 从$HOME/.loongsuite-pilot/package/VERSION文件中匹配以version=开头的行，且通过cut命令截取等号分隔符后满的内容
        # 比如若VERSION文件内容为version=1.5.3，那最终输出1.5.3
        # cut -d= -f2的作用：-d=是指定分隔符为等号=，-f2是截取被等号分割后的第2列字段
        grep '^version=' "$vf" | cut -d= -f2
    else
        echo ""
    fi
}

get_version_from_dir() {
    # 入参 $1：包目录；输出 version= 后的值，缺失时输出空字符串。
    local vf="$1/VERSION"
    if [ -f "$vf" ]; then
        grep '^version=' "$vf" | cut -d= -f2
    else
        echo ""
    fi
}

get_commit_from_dir() {
    # 入参 $1：包目录；输出 git_commit= 后的值。
    local vf="$1/VERSION"
    if [ -f "$vf" ]; then
        grep '^git_commit=' "$vf" | cut -d= -f2
    else
        echo ""
    fi
}

show_version_info() {
    # 将三个字段格式化为面向用户的单行版本摘要。
    local dir="$1"
    local vf="$dir/VERSION"
    if [ -f "$vf" ]; then
        local v; v=$(grep '^version=' "$vf" | cut -d= -f2)
        local c; c=$(grep '^git_commit=' "$vf" | cut -d= -f2)
        local t; t=$(grep '^build_time=' "$vf" | cut -d= -f2)
        echo "v${v} (${c}, ${t})"
    else
        echo "unknown"
    fi
}

# ============================================================
# 以下函数先处理卸载清理；安装/升级摘要函数定义在其后。
# ============================================================
# ============================================================
# 卸载清理：Claude/Codex 历史 OTel 插件
# ============================================================
remove_otel_plugin() {
    # PURGE=0 时尽量保留 sessions/，PURGE=1 时删除整个插件缓存目录。
    local OTEL_CLAUDE_DIR="$HOME/.cache/opentelemetry.instrumentation.claude"
    local OTEL_CODEX_DIR="$HOME/.cache/opentelemetry.instrumentation.codex"

    # 先清掉当前进程的 NODE_OPTIONS，避免删除 intercept.js 后后续 node 仍尝试 require 它。
    unset NODE_OPTIONS 2>/dev/null || true

    if [ -f "$OTEL_CLAUDE_DIR/package/scripts/uninstall.sh" ]; then
        bash "$OTEL_CLAUDE_DIR/package/scripts/uninstall.sh" 2>/dev/null || true
        msg "    ✅ Claude Code 插件 hooks 和 alias 已清理" \
            "    ✅ Claude Code plugin hooks and alias cleaned"
    else
        for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.bash_profile"; do
            [ -f "$rc" ] || continue
            if grep -q "# BEGIN otel-claude-hook" "$rc" 2>/dev/null; then
                sed -i.bak '/# BEGIN otel-claude-hook/,/# END otel-claude-hook/d' "$rc"
                rm -f "${rc}.bak"
            fi
            if grep -q "# BEGIN otel-claude-hook-env" "$rc" 2>/dev/null; then
                sed -i.bak '/# BEGIN otel-claude-hook-env/,/# END otel-claude-hook-env/d' "$rc"
                rm -f "${rc}.bak"
            fi
        done
        msg "    ✅ claude alias 已清理" "    ✅ claude alias cleaned"

        # 官方卸载脚本缺失时，回退到结构化清理 ~/.claude/settings.json hooks。
        local claude_settings="$HOME/.claude/settings.json"
        if [ -f "$claude_settings" ] && grep -qE "otel-claude-hook|hook-entry\.sh" "$claude_settings" 2>/dev/null && command -v node &>/dev/null; then
            node -e "
const fs = require('fs');
const f = process.argv[1];
const isOurs = c => c.includes('otel-claude-hook') || c.includes('hook-entry.sh');
try {
  const d = JSON.parse(fs.readFileSync(f, 'utf-8'));
  if (d && d.hooks) {
    for (const ev of Object.keys(d.hooks)) {
      if (!Array.isArray(d.hooks[ev])) continue;
      d.hooks[ev] = d.hooks[ev].map(m => {
        if (!Array.isArray(m.hooks)) return m;
        m.hooks = m.hooks.filter(h => !(h.command && isOurs(h.command)));
        return m.hooks.length > 0 ? m : null;
      }).filter(Boolean);
      if (d.hooks[ev].length === 0) delete d.hooks[ev];
    }
    if (Object.keys(d.hooks).length === 0) delete d.hooks;
    fs.writeFileSync(f, JSON.stringify(d, null, 2) + '\n');
  }
} catch {}
" "$claude_settings" 2>/dev/null || true
            msg "    ✅ settings.json hooks 已清理" "    ✅ settings.json hooks cleaned"
        fi
    fi

    local otel_config="$HOME/.claude/otel-config.json"
    if [ -f "$otel_config" ] && command -v node &>/dev/null; then
        node -e "
const fs = require('fs');
try {
  const cfg = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
  delete cfg.log_enabled;
  delete cfg.log_dir;
  delete cfg.log_filename_format;
  fs.writeFileSync(process.argv[1], JSON.stringify(cfg, null, 2) + '\n');
} catch {}
" "$otel_config" 2>/dev/null || true
    fi

    if [ -d "$OTEL_CLAUDE_DIR" ]; then
        if [ "$PURGE" -eq 1 ]; then
            rm -rf "$OTEL_CLAUDE_DIR"
            msg "    ✅ 插件目录已完全删除 (--purge): $OTEL_CLAUDE_DIR" \
                "    ✅ Plugin directory fully removed (--purge): $OTEL_CLAUDE_DIR"
        else
            find "$OTEL_CLAUDE_DIR" -maxdepth 1 \
              ! -name sessions \
              ! -name "$(basename "$OTEL_CLAUDE_DIR")" \
              -exec rm -rf {} + 2>/dev/null || true
            msg "    ✅ 插件文件已删除（sessions/ 已保留）" \
                "    ✅ Plugin files removed (sessions/ preserved)"
        fi
    fi

    # Codex OTel 插件清理：同样优先调用插件自带卸载脚本。
    if [ -f "$OTEL_CODEX_DIR/package/scripts/uninstall.sh" ]; then
        bash "$OTEL_CODEX_DIR/package/scripts/uninstall.sh" 2>/dev/null || true
        msg "    ✅ Codex 插件 hooks 已清理" \
            "    ✅ Codex plugin hooks cleaned"
    else
        # 新格式：用 Node 解析 hooks.json，只删除命令中带插件 marker 的 hook。
        local codex_hooks_json="$HOME/.codex/hooks.json"
        if [ -f "$codex_hooks_json" ] && grep -qE "otel-codex-hook|hook-entry\.sh" "$codex_hooks_json" 2>/dev/null && command -v node &>/dev/null; then
            node -e "
const fs = require('fs');
const f = process.argv[1];
const isOurs = c => c.includes('otel-codex-hook') || c.includes('hook-entry.sh');
try {
  const d = JSON.parse(fs.readFileSync(f, 'utf-8'));
  if (d && d.hooks) {
    for (const ev of Object.keys(d.hooks)) {
      d.hooks[ev] = d.hooks[ev].filter(g => {
        if (!g.hooks) return true;
        g.hooks = g.hooks.filter(h => !(h.command && isOurs(h.command)));
        return g.hooks.length > 0;
      });
      if (d.hooks[ev].length === 0) delete d.hooks[ev];
    }
    if (Object.keys(d.hooks).length === 0) {
      fs.unlinkSync(f);
    } else {
      fs.writeFileSync(f, JSON.stringify(d, null, 2) + '\n');
    }
  }
} catch {}
" "$codex_hooks_json" 2>/dev/null || true
        fi

        # 旧格式：清理 config.toml 中 legacy hooks、信任状态及相关开关。
        local codex_config="$HOME/.codex/config.toml"
        if [ -f "$codex_config" ] && grep -q "otel-codex-hook" "$codex_config" 2>/dev/null; then
            # awk 状态机删除从 legacy 起始注释到 stop 命令的整块内容。
            local marker="# OpenTelemetry instrumentation hooks"
            local end_str='command = "otel-codex-hook stop"'
            if grep -q "$marker" "$codex_config" 2>/dev/null && grep -qF "$end_str" "$codex_config" 2>/dev/null; then
                local tmp; tmp=$(mktemp)
                awk -v m="$marker" -v e="$end_str" '
                    BEGIN { skip=0 }
                    skip==0 && index($0, m) { skip=1; next }
                    skip==1 { if (index($0, e)) { skip=2 }; next }
                    skip==2 && /^[[:space:]]*$/ { next }
                    { skip=0; print }
                ' "$codex_config" > "$tmp"
                mv "$tmp" "$codex_config"
            fi
            # 信任配置逐条精确删除，不用大范围 BEGIN/END 删除，以免误伤用户数据。
            # a. 只删除 BEGIN/END marker 注释行本身。
            if grep -qE "# (BEGIN|END) otel-codex-hook trust" "$codex_config" 2>/dev/null; then
                local tmp; tmp=$(mktemp)
                grep -v "# BEGIN otel-codex-hook trust\|# END otel-codex-hook trust" "$codex_config" > "$tmp" || true
                mv "$tmp" "$codex_config"
            fi
            # b. 删除 bypass_hook_trust 行。
            if grep -q "bypass_hook_trust" "$codex_config" 2>/dev/null; then
                local tmp; tmp=$(mktemp)
                grep -v '^\s*bypass_hook_trust\s*=' "$codex_config" > "$tmp" || true
                mv "$tmp" "$codex_config"
            fi
            # c. 删除 key 中含 Pilot hooks.json 绝对路径的 hooks.state section，保留其他路径。
            local codex_hooks_json_path
            codex_hooks_json_path="$(cd "$HOME/.codex" 2>/dev/null && pwd)/hooks.json"
            if grep -q "$codex_hooks_json_path" "$codex_config" 2>/dev/null; then
                local tmp; tmp=$(mktemp)
                awk -v owned_path="$codex_hooks_json_path" '
                    /^\[hooks\.state\."/ {
                        if (index($0, owned_path) > 0) { skip=1; next }
                    }
                    /^\[/ && !/^\[hooks\.state\."/ { skip=0 }
                    skip { next }
                    { print }
                ' "$codex_config" > "$tmp"
                mv "$tmp" "$codex_config"
            fi
            # d. 兜底删除剩余 otel-codex-hook 行，此时目标 hooks.state section 已先处理。
            if grep -q "otel-codex-hook" "$codex_config" 2>/dev/null; then
                local tmp; tmp=$(mktemp)
                grep -v "otel-codex-hook" "$codex_config" > "$tmp" || true
                mv "$tmp" "$codex_config"
            fi
            # 删除旧版 codex_hooks 开关。
            if grep -q "codex_hooks" "$codex_config" 2>/dev/null; then
                local tmp; tmp=$(mktemp)
                grep -v '^\s*codex_hooks\s*=' "$codex_config" > "$tmp" || true
                mv "$tmp" "$codex_config"
            fi
            # 把连续空行压缩为最多一行。
            if [ -f "$codex_config" ]; then
                local tmp; tmp=$(mktemp)
                awk 'NF{blank=0} !NF{blank++} blank<=1' "$codex_config" > "$tmp"
                mv "$tmp" "$codex_config"
            fi
            msg "    ✅ Codex hooks 已从 config.toml 清理" \
                "    ✅ Codex hooks cleaned from config.toml"
        fi
    fi

    local codex_otel_config="$HOME/.codex/otel-config.json"
    if [ -f "$codex_otel_config" ] && command -v node &>/dev/null; then
        node -e "
const fs = require('fs');
try {
  const cfg = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
  delete cfg.log_enabled;
  delete cfg.log_dir;
  delete cfg.log_filename_format;
  fs.writeFileSync(process.argv[1], JSON.stringify(cfg, null, 2) + '\n');
} catch {}
" "$codex_otel_config" 2>/dev/null || true
    fi

    if [ -d "$OTEL_CODEX_DIR" ]; then
        if [ "$PURGE" -eq 1 ]; then
            rm -rf "$OTEL_CODEX_DIR"
            msg "    ✅ Codex 插件目录已完全删除 (--purge): $OTEL_CODEX_DIR" \
                "    ✅ Codex plugin directory fully removed (--purge): $OTEL_CODEX_DIR"
        else
            find "$OTEL_CODEX_DIR" -maxdepth 1 \
              ! -name sessions \
              ! -name "$(basename "$OTEL_CODEX_DIR")" \
              -exec rm -rf {} + 2>/dev/null || true
            msg "    ✅ Codex 插件文件已删除（sessions/ 已保留）" \
                "    ✅ Codex plugin files removed (sessions/ preserved)"
        fi
    fi
}

print_summary() {
    # 入参 $1 仅允许 install/upgrade；打印版本、目录、SLS 和常用命令。
    local action="$1"  # install / upgrade
    local config_file="$DATA_DIR/config.json"
    echo "============================================================"
    local ver; ver=$(show_version_info "$PERMANENT_DIR")
    case "$action" in
        install)
            msg "✅ 安装完成！版本: $ver" "✅ Installation complete! Version: $ver" ;;
        upgrade)
            msg "✅ 升级完成！版本: $ver" "✅ Upgrade complete! Version: $ver" ;;
    esac
    echo ""
    msg "配置文件: $config_file" "Config file: $config_file"
    msg "数据目录: $DATA_DIR" "Data directory: $DATA_DIR"
    msg "Hook 目录: $DATA_DIR/hooks" "Hooks directory: $DATA_DIR/hooks"
    echo ""

    if [ -n "$SLS_ENDPOINT" ]; then
        msg "SLS 后端: $SLS_ENDPOINT" "SLS backend: $SLS_ENDPOINT"
        [ -n "$SLS_PROJECT" ]  && msg "   项目: $SLS_PROJECT" "   Project: $SLS_PROJECT"
        [ -n "$SLS_LOGSTORE" ] && msg "   日志库: $SLS_LOGSTORE" "   Logstore: $SLS_LOGSTORE"
        echo ""
    fi

    msg "命令:" "Commands:"
    echo "   loongsuite-pilot status   # 查看状态 / Status"
    echo "   loongsuite-pilot info     # 版本与配置 / Version & config"
    echo "============================================================"
}

# ============================================================
# 主命令：install
# ============================================================
cmd_install() {
    # install 允许覆盖已有版本；服务启动失败只告警，不把安装命令判为失败。
    msg "==> 开始安装 $PACKAGE_NAME ..." \
        "==> Installing $PACKAGE_NAME ..."
    echo ""
    # 如果是Linux且是root管理员，将HAS_SUDO环境变量设置为1，该变量默认值为0
    validate_install_user
    # 检查Node是否安装，以及安装版本是否大于18，将node可执行命令路径写入$DATA_DIR/node-bin
    # 给NODE_BIN变量赋值为node可执行命令的绝对路径，将NPM_BIN赋值，默认是$NODE_BIN/npm
    # 检查是否安装curl或wget，如果都没有安装会报错退出
    check_deps

    # 如有旧版单目录安装，先复制迁移到版本化布局。
    migrate_legacy_layout

    # 检测到旧版本只提示，仍继续重新安装，获取到版本号，如果没有安装，版本号返回空字符串
    local cur_ver; cur_ver=$(get_installed_version)
    # 检查变量 cur_ver 是否有值且非空
    if [ -n "$cur_ver" ]; then
        msg "⚠️  检测到已安装版本 v${cur_ver}，将执行重新安装" \
            "⚠️  Existing installation v${cur_ver} detected, re-installing"
        echo ""
    fi

    # 重装前只依据 PID 文件停止旧进程：先 TERM，最多等 10 秒，再 KILL。
    local pid_file="$DATA_DIR/loongsuite-pilot.pid"
    # 如果PID文件存在
    if [ -f "$pid_file" ]; then
        local old_pid
        # 获取到具体的pid
        old_pid=$(cat "$pid_file")
        # kill掉pid对应的进程，kill -0不会发送任何杀死类信号，只做权限 + 进程存在性校验
        if kill -0 "$old_pid" 2>/dev/null; then
            msg "==> 停止运行中的服务 (PID $old_pid)..." \
                "==> Stopping running service (PID $old_pid)..."
            # || true表示前面命令失败（非 0 退出码）时，才执行后面的 true
            # 向$old_pid进程发送默认终止信号（SIGTERM，优雅退出），屏蔽所有报错；就算杀进程这条命令执行失败，也强制返回成功状态码，不会造成脚本异常退出。
            # 不带信号的 kill pid = 发送 15 号 SIGTERM，让程序正常收尾、释放资源退出（温柔关闭进程）
            kill "$old_pid" 2>/dev/null || true
            local count=0
            # 循环等待旧进程 old_pid 退出，最长等待 10 秒
            while kill -0 "$old_pid" 2>/dev/null && [ $count -lt 10 ]; do
                sleep 1
                count=$((count + 1))
            done
            # 如果进程还存在，再执行一次kill -9
            if kill -0 "$old_pid" 2>/dev/null; then
                # kill -9 = SIGKILL 强制杀死，程序无法捕获信号做收尾，尽量当作最后手段使用
                kill -9 "$old_pid" 2>/dev/null || true
            fi
            # 删除存在的pid文件
            rm -f "$pid_file"
            msg "    ✅ 已停止" "    ✅ Stopped"
            echo ""
        else
            rm -f "$pid_file"
        fi
    fi

    # 注册一个退出钩子，无论正常结束还是中途失败，退出时都删除临时目录；:- 防止未定义变量触发 set -u。
    trap 'rm -rf "${TMP_DIR:-}"' EXIT
    # 下载安装包并解压；输出全局INSTALL_SRC和TMP_DIR, INSTALL_SRC一般默认为TMP_DIR/loongsuite-pilot
    download_and_extract
    # 执行src/cli-probe.ts脚本，探测已安装的Agent列表，并赋值给PROBE_RESULT，探测失败不会直接退出
    probe_agents
    # Agent 选择：优先使用 --agents，否则区分交互/非交互模式
    select_agents
    # 如果命令中通过--userId|--user.id传入了直接使用，如果没有传入，从$HOME/.loongsuite-pilot/config.json配置文件读取userId
    # 且可以交互式修改和输入新的userId，最终将其赋值给USER_ID
    prompt_user_id
    # 判断$HOME/.loongsuite-pilot/config.json文件中的配置，与安装脚本传入的非空参数对比
    # 交互确认：仅当现有配置中的关键非空字段将被另一个非空值覆盖时询问
    confirm_config_overwrite
    # 删除旧的$HOME/.loongsuite-pilot/versions/1.0.0_d066770目录，将新下载的包解压的数据拷贝到该目录中
    # 把当前版本所需的稳定启动脚本collector-daemon.js和updater-daemon.js复制到版本目录之外的$HOME/.loongsuite-pilot/bin目录
    # 进入到$HOME/.loongsuite-pilot/versions/1.0.0_d066770目录，然后调用npm执行生产环境依赖安装，只安装dependencies正式依赖，自动跳过开发依赖、可选依赖，精简部署包体积
    # 执行$HOME/.loongsuite-pilot/versions/1.0.0_d066770/scripts/postinstall.js脚本
    # 作用是将项目下的assets目录中的hooks、plugins、skills目录中的内容拷贝到$HOME/.loongsuite-pilot/的hooks、plugins、skills目录中
    # 且给hooks目录下的所有sh脚本或者ps1脚本添加读和执行权限755，防止执行时无权限
    deploy_package "$INSTALL_SRC"
    # 将最终的配置内容覆写到$HOME/.loongsuite-pilot/config.json文件中
    write_config
    # 安装或更新loongsuite-pilot服务管理命令，其实就是将loongsuite-pilot.sh脚本添加到PATH环境变量中，以便直接通过loongsuite-pilot执行loongsuite-pilot.s脚本
    install_loongsuite_pilot_command
    inject_qodercli_token_intercept
    inject_qoderwork_runtime_wrapper
    # 这里其实是修改claude启动命令为：
    # claude() {
    #  # 把拦截脚本路径追加到 BUN_OPTIONS 最前面
    #  BUN_OPTIONS="--preload=$DATA_DIR/hooks/claude-code-fetch-intercept.mjs ${BUN_OPTIONS}"
    #  # 调用系统原生真实 claude 二进制程序，透传用户全部参数
    #  command claude "$@"
    #}
    inject_claude_code_fetch_intercept

    msg "==> 启动服务..." "==> Starting service..."
    # 这里其实就是执行loongsuite-pilot.sh start命令
    if loongsuite-pilot start; then
        sleep 2
        local _status_out
        _status_out="$(loongsuite-pilot status 2>/dev/null || true)"
        if echo "$_status_out" | grep -q "is running"; then
            msg "    ✅ 服务已启动" "    ✅ Service started"
        else
            msg "    ⚠️  服务可能尚未就绪，请检查: loongsuite-pilot status" \
                "    ⚠️  Service may not be ready. Check: loongsuite-pilot status"
        fi
    else
        msg "    ⚠️  服务启动失败，请手动运行: loongsuite-pilot start" \
            "    ⚠️  Service failed to start, run manually: loongsuite-pilot start"
    fi
    echo ""

    print_summary "install"
}

# ============================================================
# 主命令：upgrade
# ============================================================
cmd_upgrade() {
    # upgrade 要求已有安装；新版本启动失败会调用 rollback 并以状态码 1 退出。
    msg "==> 开始升级 $PACKAGE_NAME ..." \
        "==> Upgrading $PACKAGE_NAME ..."
    echo ""

    validate_install_user

    # 升级前兼容迁移旧布局。
    migrate_legacy_layout

    # 必须能读到已安装版本，否则要求用户先 install。
    local old_ver; old_ver=$(get_installed_version)
    if [ -z "$old_ver" ]; then
        msg "❌ 未检测到已安装的 loongsuite-pilot，请先执行 install" \
            "❌ No existing installation found. Please run install first."
        exit 1
    fi

    msg "   当前版本: ${old_ver:-unknown}" "   Current version: ${old_ver:-unknown}"
    echo ""

    check_deps

    trap 'rm -rf "${TMP_DIR:-}"' EXIT
    download_and_extract

    local new_ver; new_ver=$(get_version_from_dir "$INSTALL_SRC")
    local new_commit; new_commit=$(get_commit_from_dir "$INSTALL_SRC")
    local old_commit; old_commit=$(get_commit_from_dir "$PERMANENT_DIR")

    if [ -n "$new_ver" ] && [ "$new_ver" = "$old_ver" ] && [ "$new_commit" = "$old_commit" ]; then
        msg "✅ 已是最新版本 v${new_ver} (${new_commit})，无需升级" \
            "✅ Already at latest version v${new_ver} (${new_commit}), nothing to do"
        exit 0
    fi

    msg "   新版本: ${new_ver:-unknown} (${new_commit:-unknown})" \
        "   New version: ${new_ver:-unknown} (${new_commit:-unknown})"
    echo ""

    # 优先调用 PATH 中的 CLI，找不到时再用 ~/.local/bin 的绝对路径停止服务。
    msg "==> 停止服务..." "==> Stopping service..."
    if command -v loongsuite-pilot &>/dev/null; then
        loongsuite-pilot stop 2>/dev/null || true
    elif [ -f "$HOME/.local/bin/loongsuite-pilot" ]; then
        "$HOME/.local/bin/loongsuite-pilot" stop 2>/dev/null || true
    fi
    echo ""

    # 新包部署到 versions/<ver>_<commit>/；旧目录保留，current/previous 由部署函数更新。
    deploy_package "$INSTALL_SRC"
    install_loongsuite_pilot_command

    # 启动后不仅检查 start 返回码，还要求 status 输出包含固定文本 "is running"。
    msg "==> 启动新版本..." "==> Starting new version..."
    if loongsuite-pilot start; then
        sleep 2
        local _status_out
        _status_out="$(loongsuite-pilot status 2>/dev/null || true)"
        if echo "$_status_out" | grep -q "is running"; then
            msg "    ✅ 新版本启动成功" "    ✅ New version started successfully"
            echo ""

            # 启动成功后只保留 current 和 previous 两个版本目录。
            gc_old_versions

            print_summary "upgrade"
            return 0
        fi
    fi

    # 启动失败：通过 CLI rollback 切换版本指针并恢复旧版本。
    echo ""
    msg "⚠️  新版本启动失败，正在回滚..." \
        "⚠️  New version failed to start, rolling back..."

    loongsuite-pilot stop 2>/dev/null || true

    if command -v loongsuite-pilot &>/dev/null; then
        loongsuite-pilot rollback 2>/dev/null || true
    else
        "$HOME/.local/bin/loongsuite-pilot" rollback 2>/dev/null || true
    fi

    msg "❌ 升级失败，已回滚到 v${old_ver:-unknown}" \
        "❌ Upgrade failed, rolled back to v${old_ver:-unknown}"
    msg "   请检查日志: loongsuite-pilot log" "   Check logs: loongsuite-pilot log"
    exit 1
}

# ============================================================
# 版本垃圾回收：删除 current 和 previous 以外的历史目录
# ============================================================
gc_old_versions() {
    # versions/ 不存在时直接成功返回；glob 无匹配时也由 -d 判断安全跳过。
    local cache_dir="$HOME/.loongsuite-pilot"
    local versions_dir="$cache_dir/versions"
    local current_file="$cache_dir/current"
    local previous_file="$cache_dir/previous"

    [ -d "$versions_dir" ] || return 0

    local keep_current="" keep_previous=""
    if [ -f "$current_file" ]; then
        keep_current=$(cat "$current_file" 2>/dev/null | tr -d '[:space:]')
    fi
    if [ -f "$previous_file" ]; then
        keep_previous=$(cat "$previous_file" 2>/dev/null | tr -d '[:space:]')
    fi

    for d in "$versions_dir"/*/; do
        [ -d "$d" ] || continue
        local name
        name=$(basename "$d")
        if [ "$name" = "$keep_current" ] || [ "$name" = "$keep_previous" ]; then
            continue
        fi
        rm -rf "$d"
    done
}

# ============================================================
# 卸载清理：从各 Agent JSON 配置中移除 Pilot 注入的 hook
# ============================================================
remove_hook_configs() {
    # 以命令路径中的 .loongsuite-pilot 为所有权 marker，避免删除其他工具的 hook。
    local HOOK_MARKER=".loongsuite-pilot"
    local configs=(
        "$HOME/.cursor/hooks.json"
        "$HOME/.qoder/settings.json"
        "$HOME/.qoder-cn/settings.json"
        "$HOME/.qoderwork/settings.json"
        "$HOME/.qoderworkcn/settings.json"
        "$HOME/.claude/settings.json"
        "$HOME/.codex/hooks.json"
        "$HOME/.qwen/settings.json"
    )

    for cfg in "${configs[@]}"; do
        [ -f "$cfg" ] || continue
        local short="${cfg/#$HOME/\~}"

        local ok=0
        if command -v node &>/dev/null; then
            node -e "
const fs = require('fs');
const cfg = process.argv[1];
const marker = process.argv[2];
try {
  const data = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
  const hooks = data.hooks;
  if (!hooks || typeof hooks !== 'object') process.exit(0);
  let changed = false;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const filtered = entries.filter(e => {
      const cmd = e.command || '';
      const nested = Array.isArray(e.hooks) ? e.hooks : [];
      const hasMarker = cmd.includes(marker) || nested.some(h => (h.command || '').includes(marker));
      if (hasMarker) changed = true;
      return !hasMarker;
    });
    if (filtered.length === 0) { delete hooks[event]; changed = true; }
    else hooks[event] = filtered;
  }
  if (changed) {
    fs.writeFileSync(cfg, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    process.stdout.write('cleaned');
  } else {
    process.stdout.write('skip');
  }
} catch(e) { process.stderr.write(e.message); process.exit(1); }
" "$cfg" "$HOOK_MARKER" && ok=1
        fi

        if [ "$ok" -eq 1 ]; then
            msg "    ✅ 已清理: $short" "    ✅ Cleaned: $short"
        else
            msg "    ⚠️  跳过: $short (需手动清理)" "    ⚠️  Skipped: $short (manual cleanup needed)"
        fi
    done
}

# ============================================================
# 卸载清理：OpenCode plugin/plugin-inject 配置
# ============================================================
# OpenCode 将插件 spec 写进自身配置的 plugin/plugins 数组，不属于通用 hooks 对象，
# 因此必须单独清理，避免卸载后遗留指向已删除数据目录的路径。
remove_opencode_plugin() {
    # 同时兼容 JSON 和 JSONC；修改带注释文件前会把原文备份为 .bak。
    local configs=(
        "$HOME/.config/opencode/opencode.jsonc"
        "$HOME/.config/opencode/opencode.json"
        "$HOME/.config/opencode/config.json"
    )

    for cfg in "${configs[@]}"; do
        [ -f "$cfg" ] || continue
        local short="${cfg/#$HOME/\~}"

        if ! command -v node &>/dev/null; then
            msg "    ⚠️  跳过: $short (无 node,需手动清理)" "    ⚠️  Skipped: $short (node unavailable, manual cleanup needed)"
            continue
        fi

        local result
        result=$(node -e "
const fs = require('fs');
const f = process.argv[1];
// 通过 Pilot 专属 pluginId 或插件文件路径识别本项目写入的条目。
const isOurs = s => typeof s === 'string' && (s.includes('loongsuite-pilot-opencode') || s.includes('plugins/opencode/plugin.mjs'));
const entryStr = e => typeof e === 'string' ? e : (Array.isArray(e) ? String(e[0]) : '');
// JSONC 回退解析：移除块注释、整行 // 注释及前有空白的尾注释；file:/// 中的
// 斜线前没有空白，因此不会被这一规则误删。
const stripJsonc = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*\$/gm, '')
  .replace(/[ \t]+\/\/.*\$/gm, '');
try {
  const raw = fs.readFileSync(f, 'utf-8');
  let data, hadComments = false;
  try { data = JSON.parse(raw); }
  catch { data = JSON.parse(stripJsonc(raw)); hadComments = true; }
  const key = Array.isArray(data.plugins) ? 'plugins' : (Array.isArray(data.plugin) ? 'plugin' : null);
  if (!key) { process.stdout.write('nochange'); process.exit(0); }
  const before = data[key].length;
  data[key] = data[key].filter(e => !isOurs(entryStr(e)));
  if (data[key].length === before) { process.stdout.write('nochange'); process.exit(0); }
  if (hadComments) fs.writeFileSync(f + '.bak', raw, 'utf-8');
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  process.stdout.write(hadComments ? 'cleaned-bak' : 'cleaned');
} catch (e) { process.stderr.write(e.message); process.exit(1); }
" "$cfg" 2>/dev/null) || result="error"

        case "$result" in
            cleaned)
                msg "    ✅ 已清理: $short" "    ✅ Cleaned: $short" ;;
            cleaned-bak)
                msg "    ✅ 已清理: $short (含注释,原文件备份为 $short.bak)" \
                    "    ✅ Cleaned: $short (had comments, original backed up to $short.bak)" ;;
            nochange)
                : ;;
            *)
                msg "    ⚠️  跳过: $short (需手动清理)" "    ⚠️  Skipped: $short (manual cleanup needed)" ;;
        esac
    done
}

# ============================================================
# 卸载清理：Pi Coding Agent extension 注入
# ============================================================
remove_pi_coding_agent_extension() {
    # 只过滤 extensions 数组中带 Pilot 专属 ID/路径的字符串项。
    local cfg="$HOME/.pi/agent/settings.json"
    [ -f "$cfg" ] || return 0

    local short="${cfg/#$HOME/\~}"
    if ! command -v node &>/dev/null; then
        msg "    ⚠️  跳过: $short (无 node,需手动清理)" "    ⚠️  Skipped: $short (node unavailable, manual cleanup needed)"
        return 0
    fi

    local result
    result=$(node -e "
const fs = require('fs');
const f = process.argv[1];
const isOurs = s => typeof s === 'string' && (
  s.includes('loongsuite-pilot-pi-coding-agent') ||
  s.includes('plugins/pi-coding-agent/index.mjs')
);
try {
  const data = JSON.parse(fs.readFileSync(f, 'utf-8'));
  if (!Array.isArray(data.extensions)) { process.stdout.write('nochange'); process.exit(0); }
  const before = data.extensions.length;
  data.extensions = data.extensions.filter(entry => !isOurs(typeof entry === 'string' ? entry : ''));
  if (data.extensions.length === before) { process.stdout.write('nochange'); process.exit(0); }
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  process.stdout.write('cleaned');
} catch (e) { process.stderr.write(e.message); process.exit(1); }
" "$cfg" 2>/dev/null) || result="error"

    case "$result" in
        cleaned)
            msg "    ✅ 已清理: $short" "    ✅ Cleaned: $short" ;;
        nochange)
            : ;;
        *)
            msg "    ⚠️  跳过: $short (需手动清理)" "    ⚠️  Skipped: $short (manual cleanup needed)" ;;
    esac
}

# ============================================================
# 主命令：uninstall
# ============================================================
cmd_uninstall() {
    # 大部分清理采用 best-effort：单项失败尽量不阻止后续清理。
    msg "🗑️  开始卸载 $PACKAGE_NAME ..." \
        "🗑️  Uninstalling $PACKAGE_NAME ..."
    echo ""

    # 优先让 CLI 停服并移除自启动；CLI 不可用时按平台手工清理。
    msg "==> 停止服务..." "==> Stopping service..."
    if command -v loongsuite-pilot &>/dev/null; then
        loongsuite-pilot stop 2>/dev/null || true
    elif [ -f "$HOME/.local/bin/loongsuite-pilot" ]; then
        "$HOME/.local/bin/loongsuite-pilot" stop 2>/dev/null || true
    else
        local pid_file="$DATA_DIR/loongsuite-pilot.pid"
        if [ -f "$pid_file" ]; then
            local pid; pid=$(cat "$pid_file")
            kill "$pid" 2>/dev/null || true
            sleep 2
            kill -9 "$pid" 2>/dev/null || true
            rm -f "$pid_file"
        fi
        # CLI 不存在时手动清理 macOS launchd 或 Linux systemd/init.d 自启动项。
        case "$(uname -s)" in
            Darwin)
                local _plist="$HOME/Library/LaunchAgents/com.loongsuite-pilot.plist"
                local _uplist="$HOME/Library/LaunchAgents/com.loongsuite-pilot.updater.plist"
                for f in "$_uplist" "$_plist"; do
                    if [ -f "$f" ]; then
                        launchctl unload -w "$f" 2>/dev/null || true
                        rm -f "$f"
                    fi
                done
                ;;
            Linux)
                local _run_user
                _run_user="$(whoami)"

                # 清理当前用户的 systemd user units。
                local _user_unit_dir="$HOME/.config/systemd/user"
                if [ -f "$_user_unit_dir/loongsuite-pilot.service" ]; then
                    systemctl --user disable --now loongsuite-pilot.service &>/dev/null || true
                    systemctl --user disable --now loongsuite-pilot-updater.service &>/dev/null || true
                    rm -f "$_user_unit_dir/loongsuite-pilot.service"
                    rm -f "$_user_unit_dir/loongsuite-pilot-updater.service"
                    systemctl --user daemon-reload &>/dev/null || true
                fi

                # 清理以当前用户名命名的系统级 systemd units；失败不阻断卸载。
                local _sys_unit="/etc/systemd/system/loongsuite-pilot-${_run_user}.service"
                local _sys_uunit="/etc/systemd/system/loongsuite-pilot-updater-${_run_user}.service"
                for f in "$_sys_uunit" "$_sys_unit"; do
                    if [ -f "$f" ]; then
                        sudo systemctl disable --now "$(basename "$f")" &>/dev/null || true
                        sudo rm -f "$f"
                    fi
                done
                sudo systemctl daemon-reload &>/dev/null || true

                # 兼容没有 systemd 的发行版，清理 SysV init.d 脚本及注册信息。
                local _initd="/etc/init.d/loongsuite-pilot-${_run_user}"
                local _initd_u="/etc/init.d/loongsuite-pilot-updater-${_run_user}"
                for f in "$_initd_u" "$_initd"; do
                    if [ -f "$f" ]; then
                        sudo "$f" stop &>/dev/null || true
                        local _name; _name=$(basename "$f")
                        if command -v chkconfig &>/dev/null; then sudo chkconfig --del "$_name" &>/dev/null || true
                        elif command -v update-rc.d &>/dev/null; then sudo update-rc.d "$_name" remove &>/dev/null || true; fi
                        sudo rm -f "$f"
                    fi
                done
                ;;
        esac
    fi
    msg "    ✅ 服务已停止" "    ✅ Service stopped"
    echo ""

    # 无条件删除默认安装根目录；这也会删除默认 DATA_DIR 中的配置和日志。
    msg "==> 删除安装目录..." "==> Removing installation..."
    rm -rf "$HOME/.loongsuite-pilot"
    msg "    ✅ 已删除 $HOME/.loongsuite-pilot" \
        "    ✅ Removed $HOME/.loongsuite-pilot"

    # 删除用户级 CLI 和可选的 /usr/local/bin 软链接。
    msg "==> 删除 loongsuite-pilot 命令..." "==> Removing loongsuite-pilot command..."
    rm -f "$HOME/.local/bin/loongsuite-pilot"
    rm -f /usr/local/bin/loongsuite-pilot 2>/dev/null || true
    msg "    ✅ loongsuite-pilot 命令已删除" "    ✅ loongsuite-pilot command removed"
    echo ""

    # 清理通用 JSON hooks 以及三个 shell/macOS 专用包装器。
    msg "==> 清理 hook 配置..." "==> Cleaning up hook configs..."
    remove_hook_configs
    remove_qodercli_token_intercept
    remove_qoderwork_runtime_wrapper
    remove_claude_code_fetch_intercept
    echo ""

    # 清理 Claude/Codex 历史 OTel 插件。
    msg "==> 清理 Claude/Codex 插件..." "==> Cleaning up Claude/Codex plugins..."
    remove_otel_plugin
    echo ""

    # OpenCode 和 Pi 的配置结构特殊，分别调用专用清理函数。
    msg "==> 清理 OpenCode 插件配置..." "==> Cleaning up OpenCode plugin config..."
    remove_opencode_plugin
    echo ""

    msg "==> 清理 Pi Coding Agent Extension 配置..." "==> Cleaning up Pi Coding Agent extension config..."
    remove_pi_coding_agent_extension
    echo ""

    # 自定义 DATA_DIR 仅在 --purge 时删除；默认目录此前已被无条件删除。
    if [ "$PURGE" -eq 1 ]; then
        msg "==> 删除数据目录 (--purge)..." "==> Removing data directory (--purge)..."
        rm -rf "$DATA_DIR"
        msg "    ✅ 已删除 $DATA_DIR" "    ✅ Removed $DATA_DIR"
    else
        msg "📁 数据目录已保留: $DATA_DIR" \
            "📁 Data directory preserved: $DATA_DIR"
        msg "   (包含配置和日志，如需彻底删除请加 --purge)" \
            "   (contains config and logs, add --purge to remove)"
    fi
    echo ""

    echo "============================================================"
    msg "✅ 卸载完成！" "✅ Uninstallation complete!"
    echo "============================================================"
}

# ============================================================
# 主分发器：根据解析出的 COMMAND 调用唯一一条主流程
# ============================================================
case "$COMMAND" in
    install)   cmd_install ;;
    upgrade)   cmd_upgrade ;;
    uninstall) cmd_uninstall ;;
    *)
        echo "Usage: $0 {install|upgrade|uninstall} [options]"
        exit 1 ;;
esac
