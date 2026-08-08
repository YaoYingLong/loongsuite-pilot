#!/usr/bin/env bash
# package-opensource.sh — Build the project and create distributable packages
#
# Produces both .tar.gz (Linux/macOS) and .zip (Windows) packages.
# Internal-only and updater files are stripped automatically.
#
# Usage:
#   bash deploy/package-opensource.sh                       # default output
#   bash deploy/package-opensource.sh -o /tmp/out.tar.gz    # custom .tar.gz path
#   bash deploy/package-opensource.sh --skip-build          # skip build, use existing dist/

# Shell 脚本严格模式，用来尽早暴露错误、避免静默失败
# set -e（errexit）表示命令返回非 0 退出码（失败）时，立即退出脚本，不开启：某条命令失败，脚本继续往下执行，容易出现 “前面出错后面还跑” 的隐蔽 bug
# 在 if / while 条件、&&/|| 右侧、函数返回判断里，set -e 不会触发退出
# set -u（nounset）表示使用未定义变量时，直接报错退出，防止变量拼写错误、漏传参数引发诡异问题
# set -o pipefail 表示管道 | 整条命令的返回码 = 管道中第一个失败命令的退出码
set -euo pipefail

# ${BASH_SOURCE[0]}是Bash 内置变量，代表当前正在执行的脚本文件路径
# 所以这里的SCRIPT_DIR是../loongsuite-pilot/deploy/package-opensource.sh的目录的绝对路径即../loongsuite-pilot/deploy/
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 这里得到的是../loongsuite-pilot/
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PACKAGE_NAME="loongsuite-pilot"
OUTPUT_PATH=""
SKIP_BUILD=0

# $#：Bash 内置变量，代表传入脚本 / 函数的命令行参数总个数  -gt 0 表示大于 0
while [[ $# -gt 0 ]]; do
    case "$1" in
        -o|--output)
            # shift 2 表示吃掉 2 个参数
            OUTPUT_PATH="$2"; shift 2 ;;
        --skip-build)
            # shift后面没有数字表示吃掉 1 个参数
            SKIP_BUILD=1; shift ;;
        *)
            echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

# 如果OUTPUT_PATH为空，将其默认设置为../loongsuite-pilot/loongsuite-pilot.tar.gz
if [ -z "$OUTPUT_PATH" ]; then
    OUTPUT_PATH="$PROJECT_ROOT/$PACKAGE_NAME.tar.gz"
fi
# ${var%xxx}从变量尾部，删除最短匹配的 xxx 字符串，其实就是得到../loongsuite-pilot/loongsuite-pilot.zip
ZIP_OUTPUT_PATH="${OUTPUT_PATH%.tar.gz}.zip"

# 进入到../loongsuite-pilot目录
cd "$PROJECT_ROOT"

# ── Build ──
# 如果变量SKIP_BUILD等于0，默认是等于0
if [ "$SKIP_BUILD" -eq 0 ]; then
    echo "==> Building..."
    # 删除dist目录
    rm -rf dist
    # 它读取项目 package.json 里 scripts 字段下的 build 脚本，执行对应的命令, 其实最终就是执行node build.mjs脚本
    # 从 src/index.ts 开始递归解析所有 import 依赖打包输出单个打包文件，最终产物写入 dist/index.js
    # 从 src/cli-probe.ts 开始递归解析所有 import 依赖打包输出单个打包文件，最终产物写入 dist/cli-probe.cjs
    # 从 src/updater/index.ts 开始递归解析所有 import 依赖打包输出单个打包文件，最终产物写入 dist/updater
    npm run build
    echo "    ✅ Build complete"
else
    # 如果执行脚本是使用了--skip-build参数，且dist目录不存在的话就输出异常信息，退出脚本
    echo "==> Skipping build (--skip-build)"
    if [ ! -d dist ]; then
        echo "❌ dist/ not found. Run 'npm run build' first or remove --skip-build."
        exit 1
    fi
fi

# ── Stage files into a temp directory ──
# 创建一个临时目录
STAGE_DIR="$(mktemp -d)"
# 脚本退出时删除临时目录
trap 'rm -rf "$STAGE_DIR"' EXIT

# 临时目录/loongsuite-pilot
PKG_DIR="$STAGE_DIR/$PACKAGE_NAME"
# 在临时目录下创建/loongsuite-pilot目录
mkdir -p "$PKG_DIR"

echo "==> Generating VERSION file..."
# node -e "代码" 表示直接在命令行执行一段 Node.js 代码，不用单独写 js 文件
# 读取当前目录下 package.json 文件并解析成 JS 对象
# process.stdout.write的作用把版本号输出到标准输出
PKG_VERSION=$(node -e "process.stdout.write(require('./package.json').version)")
# git rev-parse HEAD：获取当前分支最新 commit 的完整哈希值，例如 a729df34ce216...
# --short：输出简短 8 位 commit hash，如 a729df34，如果不存在输出unknown
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
# --abbrev-ref：输出分支短名称，其实就是获取分支名称
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
BUILD_TIME=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# 在当前目录创建并写入VERSION文件
cat > VERSION << VEOF
version=${PKG_VERSION}
git_commit=${GIT_COMMIT}
git_branch=${GIT_BRANCH}
build_time=${BUILD_TIME}
VEOF
echo "    ✅ VERSION: v${PKG_VERSION} (${GIT_COMMIT}, ${BUILD_TIME})"

echo "==> Staging files..."

# Core distributable dirs
# 拷贝文件到创建的临时目录内的loongsuite-pilot目录中
cp -r dist     "$PKG_DIR/dist"
cp -r assets   "$PKG_DIR/assets"
cp -r scripts  "$PKG_DIR/scripts"

# Agent definition files (declarative deployment configs)
if [ -d agents.d ]; then
    # 拷贝文件到创建的临时目录内的loongsuite-pilot目录中
    cp -r agents.d "$PKG_DIR/agents.d"
    echo "    ✅ Agent definitions bundled: $(ls agents.d/*.json 2>/dev/null | wc -l | tr -d ' ') files"
fi

# Plugin tarballs (pre-built, bundled)
if [ -d plugins ] && ls plugins/*.tar.gz &>/dev/null; then
    cp -r plugins  "$PKG_DIR/plugins"
    echo "    ✅ Plugins bundled: $(ls plugins/*.tar.gz | xargs -I{} basename {} | tr '\n' ' ')"
fi

# Status bar app (macOS native binary + Swift source)
if [ -d app/macos-status-bar ]; then
    mkdir -p "$PKG_DIR/app/macos-status-bar"
    cp -r app/macos-status-bar/Sources "$PKG_DIR/app/macos-status-bar/Sources"
    cp app/macos-status-bar/Package.swift "$PKG_DIR/app/macos-status-bar/"
    # Include pre-built binaries if available
    if [ -d app/macos-status-bar/bin ]; then
        cp -r app/macos-status-bar/bin "$PKG_DIR/app/macos-status-bar/bin"
        echo "    ✅ Status bar app bundled (with pre-built binary)"
    else
        echo "    ✅ Status bar app bundled (source only, will build on install)"
    fi
fi

# Package metadata & version
cp package.json      "$PKG_DIR/"
cp package-lock.json "$PKG_DIR/" 2>/dev/null || true
cp .npmrc            "$PKG_DIR/" 2>/dev/null || true
cp README.md         "$PKG_DIR/" 2>/dev/null || true
cp VERSION           "$PKG_DIR/"

# Ensure scripts are executable
# 给所有sh脚本添加执行权限
chmod +x "$PKG_DIR/scripts/"*.sh 2>/dev/null || true
chmod +x "$PKG_DIR/assets/hooks/"*.sh 2>/dev/null || true

# Strip internal-only files (always for opensource)
rm -f "$PKG_DIR/scripts/migrate-internal-config.js"
rm -f "$PKG_DIR/scripts/updater-daemon.js"
echo "    ✅ Stripped internal-only files"

echo "    ✅ Staged into $PKG_DIR"

# ── Create .tar.gz (Linux/macOS) ──
echo "==> Creating .tar.gz package..."
tar -czf "$OUTPUT_PATH" -C "$STAGE_DIR" "$PACKAGE_NAME"

PKG_SIZE=$(du -h "$OUTPUT_PATH" | cut -f1)
echo "    ✅ $OUTPUT_PATH ($PKG_SIZE)"

# ── Create .zip (Windows) ──
echo "==> Creating .zip package..."
(cd "$STAGE_DIR" && zip -qr "$ZIP_OUTPUT_PATH" "$PACKAGE_NAME")

ZIP_SIZE=$(du -h "$ZIP_OUTPUT_PATH" | cut -f1)
echo "    ✅ $ZIP_OUTPUT_PATH ($ZIP_SIZE)"

# ── Summary ──
echo ""
echo "==> Contents:"
tar -tzf "$OUTPUT_PATH" | sed -n '1,20p'
echo "    ... (truncated)"
echo ""
echo "Done."

