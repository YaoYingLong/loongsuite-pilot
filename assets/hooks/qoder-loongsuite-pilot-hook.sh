#!/usr/bin/env bash
# `env` 会从当前 PATH 查找 Bash，兼容 Bash 不在 `/bin/bash` 的系统。
# `-e` 遇未处理失败即停止，`-u` 把未定义变量视为错误，`pipefail` 让管道中任一命令失败；
# 脚本末尾仍会把采集故障转换为 exit 0，保证这些严格选项不会阻塞宿主 Agent。
set -euo pipefail

# ============================================================================
# Qoder Hook 入口：把宿主通过 stdin 发送的 JSON 交给 qoder-hook-processor.mjs。
# ============================================================================
# 调用方式：
#   qoder-loongsuite-pilot-hook.sh [agent-id]
#
#   agent-id  可选，默认 `qoder`；决定日志子目录、history 文件前缀和归一化变体。
#
# 安装与调用链：postinstall 把 assets/hooks 复制到 ~/.loongsuite-pilot/hooks，
# HookStrategy/HookManager 再把本命令注入 ~/.qoder/settings.json。processor 解析 transcript，
# 最终把标准记录追加到 logs/<agent-id>/history/*.jsonl，供 Collector 的 Input 读取。
# ============================================================================

# stdin 仍连接终端说明是人工直接运行，没有 Hook payload；直接成功退出。
[[ -t 0 ]] && exit 0

AGENT_ID="${1:-qoder}"

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROCESSOR="$HOOKS_DIR/qoder-hook-processor.mjs"

# processor 缺失属于部署不完整；保持 fail-open，不影响 Qoder 自身运行。
[[ -f "$PROCESSOR" ]] || exit 0

MIN_NODE_MAJOR=18

# 候选探针只通过退出码表达结果，不向 stdout 写内容，以免污染 Hook 的输出协议。
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

# realpath/readlink 解析软链接后再识别 .app，防止 PATH 中的链接绕过私有 runtime 检查。
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

# 1. 优先读取安装器固定的 Node 路径，确保 Hook 与 Collector 使用同一兼容版本。
if [[ -f "$NODE_PIN_FILE" ]]; then
  pinned="$(cat "$NODE_PIN_FILE" 2>/dev/null | tr -d '[:space:]')"
  if [[ -n "$pinned" ]] && node_is_suitable "$pinned"; then
    NODE_BIN="$pinned"
  fi
fi

# 2. 固定路径不可用时只读搜索常见版本管理器/PATH；这里不回写 pin，避免并发 Hook 改配置。
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

# exec 用 Node 替换当前 Shell：stdin、stdout 和最终退出码直接属于 processor，不残留额外父进程。
exec "$NODE_BIN" "$PROCESSOR" --agent-id "$AGENT_ID"
