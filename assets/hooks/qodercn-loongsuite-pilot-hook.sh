#!/usr/bin/env bash
# 通过 PATH 定位 Bash；严格模式尽早暴露未定义变量、失败命令和失败管道。
set -euo pipefail

# ============================================================================
# Qoder CN Hook 入口：把 stdin JSON 委托给 qoder-hook-processor.mjs。
# ============================================================================
# 调用方式：
#   qodercn-loongsuite-pilot-hook.sh [agent-id]
#
#   agent-id  可选，默认 `qoder-cn`，用于选择归一化变体和日志目录。
#
# 安装器复制本脚本、processor 和 shared 模块后，HookManager 将命令注入
# ~/.qoder-cn/settings.json。processor 读取 transcript 增量并写 history JSONL。
# 所有采集错误最终均以 exit 0 收敛，不能阻塞 Qoder CN。
# ============================================================================

# stdin 是终端表示没有 Hook payload，人工调用时立即成功返回。
[[ -t 0 ]] && exit 0

AGENT_ID="${1:-qoder-cn}"

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROCESSOR="$HOOKS_DIR/qoder-hook-processor.mjs"

# processor 不存在时静默退出，部署异常不得影响 Agent。
[[ -f "$PROCESSOR" ]] || exit 0

MIN_NODE_MAJOR=18

# 候选验证失败只让搜索继续，不能因为一个陈旧版本管理器目录终止整个 Hook。
node_is_suitable() {
  local bin="$1"
  [[ -x "$bin" ]] || return 1
  node_is_app_bundle "$bin" && return 1
  local ver
  ver="$("$bin" --version 2>/dev/null)" || return 1
  local major="${ver#v}"
  major="${major%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] && (( major >= MIN_NODE_MAJOR )) || return 1
  return 0
}

# 解析真实路径后排除 macOS 应用私有 Node，避免其 Framework 依赖在 Hook 环境中缺失。
node_is_app_bundle() {
  local resolved
  resolved="$(realpath "$1" 2>/dev/null || readlink -f "$1" 2>/dev/null || echo "$1")"
  case "$resolved" in
    /Applications/*.app/Contents/*|/System/Applications/*.app/Contents/*|"$HOME"/Applications/*.app/Contents/*)
      return 0
      ;;
  esac
  return 1
}

NODE_PIN_FILE="$HOME/.loongsuite-pilot/node-bin"

NODE_BIN=""

# 1. 优先使用安装器记录在 node-bin 中的 Node。
if [[ -f "$NODE_PIN_FILE" ]]; then
  pinned="$(cat "$NODE_PIN_FILE" 2>/dev/null | tr -d '[:space:]')"
  if [[ -n "$pinned" ]] && node_is_suitable "$pinned"; then
    NODE_BIN="$pinned"
  fi
fi

# 2. 只读搜索 nvm/Volta/fnm/PATH，不在 Hook 中修改 node-bin。
if [[ -z "$NODE_BIN" ]]; then
  nvm_candidates=("$HOME/.nvm/versions/node"/*/bin/node)
  candidates=()
  for (( i=${#nvm_candidates[@]}-1; i>=0; i-- )); do
    candidates+=("${nvm_candidates[i]}")
  done
  candidates+=(
    "$HOME/.volta/bin/node"
    "$HOME/.fnm/aliases/default/bin/node"
    /opt/homebrew/bin/node
    /usr/local/bin/node
    "$HOME/.local/bin/node"
  )
  if command -v node >/dev/null 2>&1; then
    candidates+=("$(command -v node)")
  fi
  for candidate in "${candidates[@]}"; do
    if node_is_suitable "$candidate"; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "[loongsuite-pilot] node >= $MIN_NODE_MAJOR not found" >&2
  exit 0
fi

# exec 保留宿主 stdin 的原始字节，并把 Shell 进程替换为真正处理器。
exec "$NODE_BIN" "$PROCESSOR" --agent-id "$AGENT_ID"
