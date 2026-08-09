#!/usr/bin/env bash
# 通过 PATH 选择 Bash；严格模式检测未定义变量、命令和管道错误。
set -euo pipefail

# Codex Hook 入口：把事件交给 codex-hook-processor.mjs。
#
# HookStrategy 将命令写入 ~/.codex/hooks.json，并在 ~/.codex/config.toml 写 trust hash：
#   $PILOT_DATA/hooks/codex-loongsuite-pilot-hook.sh <subcommand>
#
# 子命令与 Codex Hook event 一一对应：
#   session-start / user-prompt-submit / pre-tool-use / post-tool-use / stop
#
# 当前 processor 不直接生成遥测，只在 stop 写 transcript wakeup marker；Collector 的
# CodexTranscriptInput 才读取 rollout 文件。任何错误均输出 `{}` 并 exit 0。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROCESSOR="$SCRIPT_DIR/codex-hook-processor.mjs"
EMPTY_RESULT='{}'
SUBCOMMAND="${1:-unknown}"

# 将包装层故障写成 JSONL。函数内部所有可能失败的命令都被兜底，返回码不会触发严格模式退出。
log_error() {
  local stage="$1"
  local message="$2"
  local data_dir="${LOONGSUITE_PILOT_DATA_DIR:-$HOME/.loongsuite-pilot}"
  local day
  day="$(date -u +%Y-%m-%d 2>/dev/null || true)"
  [[ -n "$day" ]] || day="unknown"
  local dir="$data_dir/logs/codex/errors"
  local file="$dir/codex-error-$day.jsonl"
  mkdir -p "$dir" 2>/dev/null || return 0
  printf '{"time":"%s","gen_ai.agent.type":"codex","stage":"%s","error.type":"shell_%s","error.message":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)" \
    "$stage" \
    "$stage" \
    "$(printf '%s' "$message" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '""')" \
    >> "$file" 2>/dev/null || true
}

# 判断：当前脚本的标准输入是否来自终端键盘
if [[ -t 0 ]]; then
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

# 如果$SCRIPT_DIR/codex-hook-processor.mjs脚本不存在直接输入异常日志
if [[ ! -f "$PROCESSOR" ]]; then
  echo "[codex-hook] processor not found: $PROCESSOR" >&2
  log_error "missing_processor" "hook processor not found: $PROCESSOR"
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

MIN_NODE_MAJOR=18

# macOS 应用包内的 Node 可能依赖宿主 Framework，脱离该应用启动会失败，因此显式拒绝。
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

# Shell 函数以 0 表示“可用”、非 0 表示“不可用”；调用方可直接放在 if 条件中。
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

NODE_PIN_FILE="$HOME/.loongsuite-pilot/node-bin"
NODE_BIN=""

# 先尝试安装器写入的固定路径；读取时删除所有空白，避免末尾换行进入可执行文件名。
if [[ -f "$NODE_PIN_FILE" ]]; then
  pinned="$(cat "$NODE_PIN_FILE" 2>/dev/null | tr -d '[:space:]')"
  if [[ -n "$pinned" ]] && node_is_suitable "$pinned"; then
    NODE_BIN="$pinned"
  fi
fi

# pin 不可用时按 nvm 新版本到旧版本、常见管理器路径、最后 PATH 的顺序只读搜索。
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
  echo "[codex-hook] node >= $MIN_NODE_MAJOR not found" >&2
  log_error "missing_node" "node >= $MIN_NODE_MAJOR not found"
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

# 不捕获 stdin，Node 进程直接继承原管道；`if !` 把非零退出转换为可记录的 fail-open 分支。
if ! "$NODE_BIN" "$PROCESSOR" "$SUBCOMMAND"; then
  echo "[codex-hook] processor failed (subcommand=$SUBCOMMAND)" >&2
  log_error "processor_failed" "hook processor exited non-zero (subcommand=$SUBCOMMAND)"
  printf '%s\n' "$EMPTY_RESULT"
fi

exit 0
