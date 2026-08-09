#!/usr/bin/env bash
# Shebang 让系统通过 PATH 中的 `env` 查找 Bash，而不是假定 Bash 固定安装在 `/bin/bash`。
# 严格模式含义：命令失败时退出（-e）、读取未定义变量时报错（-u）、管道任一环失败即失败
#（pipefail）。下面所有预期故障分支都会显式输出 `{}` 并 exit 0，以实现 Hook 的 fail-open。
set -euo pipefail

# Claude Code 在 Unix/macOS 上的轻量 Hook wrapper。
#
# `agents.d/claude-code.json` 声明 Stop/SubagentStart/SubagentStop；HookStrategy 按 kebab-case
# 分别把 stop/subagent-start/subagent-stop 参数写进 `~/.claude/settings.json` 中的命令：
#   $PILOT_DATA/hooks/claude-code-loongsuite-pilot-hook.sh <subcommand>
#
# Claude Code 每次触发 Hook 时将 payload JSON 写入本脚本 stdin。本脚本不解析业务字段，只负责：
# 校验子命令和 processor、找到可用的 Node.js，然后让 processor 继承同一 stdin/stdout 管道。
#
# stop 会由 processor 增量解析 transcript 并写 `logs/claude-code/*.jsonl`；Subagent 两类命令当前
# 只写 `state.events`，exportSession 尚未消费这些事件。wrapper 和 processor 都不会直接触发
# Collector 的 `entries`；常驻 `ClaudeCodeLogInput` 之后轮询 JSONL 时才会触发。
#
# Hook 的 stdout 是协议响应通道，成功或可恢复失败统一返回 `{}`；诊断只写 stderr/error JSONL，
# 尽量不阻塞 Claude Code 自身的运行和停止。

# `BASH_SOURCE[0]` 是当前脚本路径；先进入其目录再取绝对路径，使调用者 cwd 不影响模块定位。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# processor 与 wrapper 安装在同一 hooks 目录，不依赖全局 npm 包路径。
PROCESSOR="$SCRIPT_DIR/claude-code-hook-processor.mjs"
# Claude Hook 约定用空 JSON 对象表示“无附加动作”。
EMPTY_RESULT='{}'
# `${1:-unknown}` 在没有第一个参数时安全回退，避免 `set -u` 因未定义位置参数直接退出。
SUBCOMMAND="${1:-unknown}"

# 仅分派当前声明注册的子命令；旧版或未知事件返回空结果，避免重复采集。
case "$SUBCOMMAND" in
  stop|subagent-start|subagent-stop)
    ;;
  *)
    printf '%s\n' "$EMPTY_RESULT"
    exit 0
    ;;
esac

# 写 wrapper 自身的诊断日志。函数的所有 I/O 都吞掉错误，诊断路径不能反过来让 Hook 失败。
# 错误消息经 Python JSON 编码，防止引号或换行破坏 JSONL；Python 缺失时回退为空字符串。
log_error() {
  # `local` 把变量限制在函数调用内；双引号保留参数中的空格和通配符字面值。
  local stage="$1"
  local message="$2"
  local data_dir="${LOONGSUITE_PILOT_DATA_DIR:-$HOME/.loongsuite-pilot}"
  local day
  day="$(date -u +%Y-%m-%d 2>/dev/null || true)"
  [[ -n "$day" ]] || day="unknown"
  local dir="$data_dir/logs/claude-code/errors"
  local file="$dir/claude-code-error-$day.jsonl"
  # `mkdir -p` 同时创建各级目录；失败直接正常返回，不改变 Claude Code 的 Hook 结果。
  mkdir -p "$dir" 2>/dev/null || return 0
  # printf 生成一条完整 JSONL；最后的 `>>` 追加而非覆盖，stderr 与追加失败均被吞掉。
  printf '{"time":"%s","gen_ai.agent.type":"claude-code","stage":"%s","error.type":"shell_%s","error.message":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)" \
    "$stage" \
    "$stage" \
    "$(printf '%s' "$message" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '""')" \
    >> "$file" 2>/dev/null || true
}

# stdin 是 TTY 表示人工执行、没有 Claude Code 重定向的 Hook payload；不启动 Node，快速返回。
if [[ -t 0 ]]; then
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

# processor 丢失通常表示部署不完整；只记录诊断并返回空响应，不阻塞宿主。
if [[ ! -f "$PROCESSOR" ]]; then
  echo "[claude-code-hook] processor not found: $PROCESSOR" >&2
  log_error "missing_processor" "hook processor not found: $PROCESSOR"
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

# processor 使用当前 ESM/Node API，最低要求 Node.js 18。
MIN_NODE_MAJOR=18

# 排除 macOS .app 内随应用分发的 Node，它可能无法作为独立 Hook runtime 使用。
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

# 同时检查可执行权限、来源和主版本；任何探测失败均返回非零供候选循环继续。
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

# 1. 优先使用安装器写入 node-bin 的固定 Node；去掉全部空白后再验证可执行文件与版本。
if [[ -f "$NODE_PIN_FILE" ]]; then
  pinned="$(cat "$NODE_PIN_FILE" 2>/dev/null | tr -d '[:space:]')"
  if [[ -n "$pinned" ]] && node_is_suitable "$pinned"; then
    NODE_BIN="$pinned"
  fi
fi

# 2. 固定 Node 无效时只读搜索常见版本管理器和系统安装位置，不修改用户 PATH。
if [[ -z "$NODE_BIN" ]]; then
  nvm_candidates=("$HOME/.nvm/versions/node"/*/bin/node)
  candidates=()
  # glob 结果按数组当前顺序逆向加入，优先尝试通常较新的 NVM 版本目录。
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
  # 找到第一个满足条件的候选就停止；所有路径都用双引号保护空格。
  for candidate in "${candidates[@]}"; do
    if node_is_suitable "$candidate"; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

# 没有可用 Node 时无法运行 processor，但仍以 Hook 成功退出，错误留在独立诊断文件中。
if [[ -z "$NODE_BIN" ]]; then
  echo "[claude-code-hook] node >= $MIN_NODE_MAJOR not found" >&2
  log_error "missing_node" "node >= $MIN_NODE_MAJOR not found"
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

# 不显式读取 stdin，让 Node 子进程继承 Claude Code 连接给 wrapper 的同一管道，避免 JSON 被 Shell
# 拆词或重新编码。processor 自己同步读取 stdin，并只在 `stop` 时写采集 JSONL。
# `if ! ...` 把 processor 的非零退出转成诊断与 `{}`；脚本末尾始终 exit 0，保持 fail-open。
if ! "$NODE_BIN" "$PROCESSOR" "$SUBCOMMAND"; then
  echo "[claude-code-hook] processor failed (subcommand=$SUBCOMMAND)" >&2
  log_error "processor_failed" "hook processor exited non-zero (subcommand=$SUBCOMMAND)"
  printf '%s\n' "$EMPTY_RESULT"
fi

exit 0
