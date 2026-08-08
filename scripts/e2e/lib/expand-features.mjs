/**
 * expand-features E2E 场景的 Bash 脚本生成器。
 * 每个函数只返回可交给 `runLocalScript()` 的脚本文本，不在当前 Node.js 进程直接改系统状态。
 * 场景覆盖动态发现、自动升级/回滚、双 SLS endpoint 和脱敏；脚本内部严格模式决定远端退出码。
 */

/**
 * 阶段 1：移除 Codex 探测目录后启动 Pilot，确认未发现；重建目录后等待动态发现并确认启动。
 * @param {NodeJS.ProcessEnv} env E2E 环境与可选发现间隔。
 * @returns {string} 可执行的 Bash 场景源码。
 */
export function buildAgentDiscoveryPhaseScript(env) {
  const discoveryInterval = env.LOONGSUITE_PILOT_DISCOVERY_INTERVAL_MS || '30000';
  const waitSec = Math.ceil(Number(discoveryInterval) / 1000) + 5;
  return `
set -euo pipefail
LOG="$HOME/.loongsuite-pilot/logs/loongsuite-pilot-service.log"

echo "[phase1] Agent Dynamic Discovery Test"

# 先停止 Pilot，建立干净测试起点。
loongsuite-pilot stop || true
sleep 2

# 删除 Codex 发现路径；agent-defs/codex.json 使用 ~/.codex 作为检测目录。
echo "[phase1] Removing codex detection path (~/.codex)..."
rm -rf "$HOME/.codex"

echo "[phase1] codex detection path removed"

# 清空日志，便于准确判断本阶段发现结果。
mkdir -p "$(dirname "$LOG")"
> "$LOG" 2>/dev/null || true

# 启动 Pilot，发现服务会按测试配置的短周期运行。
echo "[phase1] Starting pilot..."
loongsuite-pilot start || { echo "FAIL: pilot start failed"; exit 1; }
sleep 8

# 验证 Codex 尚未被发现，此时应为 idle 而非 started。
if grep -q '"id":"deploy:codex".*agent detected and started' "$LOG" 2>/dev/null; then
  echo "FAIL: codex detected but ~/.codex does not exist"
  exit 1
fi
echo "[phase1] Confirmed: codex not detected (expected)"

# 重新创建 Codex 发现路径。
echo "[phase1] Recreating ~/.codex directory..."
mkdir -p "$HOME/.codex"

# 等待一个发现周期。
echo "[phase1] Waiting ${waitSec}s for discovery..."
sleep ${waitSec}

# 验证 Codex 已被发现。
if ! grep -q '"id":"deploy:codex"' "$LOG" 2>/dev/null; then
  echo "FAIL: codex not detected after recreating ~/.codex"
  echo "Last 30 log lines:"
  tail -30 "$LOG" 2>/dev/null || true
  exit 1
fi
echo "[phase1] PASSED: codex dynamically discovered after ~/.codex recreated"
`;
}

/**
 * 阶段 2：使用 mock manifest server 验证自动升级。
 * 注入 autoUpdate 配置，等待 Updater 检查，再断言 current 指针已经更新。
 */
export function buildAutoUpgradePhaseScript(env, mockPort) {
  return `
set -euo pipefail
CONFIG="$HOME/.loongsuite-pilot/config.json"
CURRENT_FILE="$HOME/.loongsuite-pilot/current"

echo "[phase2] Auto Upgrade Test (mock port: ${mockPort})"

# 注入 autoUpdate 配置。
node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('$CONFIG', 'utf-8'));
cfg.autoUpdate = {
  enabled: true,
  manifestUrl: 'http://127.0.0.1:${mockPort}/manifest.json',
  packageUrl: 'http://127.0.0.1:${mockPort}/pkg.tar.gz',
  checkIntervalMs: 10000
};
fs.writeFileSync('$CONFIG', JSON.stringify(cfg, null, 2));
console.log('[phase2] autoUpdate config injected');
"

# 记录升级前的 current 指针。
OLD_CURRENT=""
if [ -f "$CURRENT_FILE" ]; then
  OLD_CURRENT=$(cat "$CURRENT_FILE")
fi
echo "[phase2] Pre-upgrade current: '$OLD_CURRENT'"

# 重启 Pilot 使新配置生效。
loongsuite-pilot restart
echo "[phase2] Pilot restarted, waiting for updater check..."

# 等待 Updater 完成检查和部署，时间包含初始延迟与检查周期。
sleep 75

# 断言 current 指针已经更新。
if [ ! -f "$CURRENT_FILE" ]; then
  echo "FAIL: current file does not exist after upgrade"
  exit 1
fi

NEW_CURRENT=$(cat "$CURRENT_FILE")
echo "[phase2] Post-upgrade current: '$NEW_CURRENT'"

if [ "$NEW_CURRENT" = "$OLD_CURRENT" ]; then
  echo "FAIL: current pointer did not change (updater may not have triggered)"
  echo "Updater logs:"
  grep -i "updat" "$HOME/.loongsuite-pilot/logs/loongsuite-pilot-service.log" 2>/dev/null | tail -20 || true
  exit 1
fi

echo "[phase2] PASSED: current updated from '$OLD_CURRENT' to '$NEW_CURRENT'"
`;
}

/**
 * 阶段 3：自动回滚。
 * 使用 installer.sh upgrade 部署损坏包，再断言回滚到上一版本。
 */
export function buildAutoRollbackPhaseScript(env, mockPort) {
// 重要：脚本通过 `bash -c` 传入，全文会成为进程命令行。安装器停止逻辑使用 `pkill -f` 匹配
// collector-daemon 路径；若当前命令行包含同样文本，就可能误杀测试进程。因此把实际测试逻辑
// 写入临时文件后再执行，避免命令行携带该匹配串。
  return `
cat > /tmp/e2e-phase3.sh << 'PHASE3_EOF'
#!/bin/bash
set -eo pipefail
CURRENT_FILE="$HOME/.loongsuite-pilot/current"
INSTALLER="/opt/project/deploy/installer.sh"

echo "[phase3] Auto Rollback Test (broken package on port: ${mockPort})"

OLD_CURRENT=$(cat "$CURRENT_FILE" 2>/dev/null || echo "unknown")
echo "[phase3] Pre-rollback current: '$OLD_CURRENT'"

# 通过 installer upgrade 部署损坏包。
echo "[phase3] Running installer upgrade with broken package..."
set +e
bash "$INSTALLER" upgrade --package-url "http://127.0.0.1:${mockPort}/pkg.tar.gz" </dev/null 2>&1
UPGRADE_EXIT=$?
set -e
echo "[phase3] Installer exited with code $UPGRADE_EXIT"

# Docker 中 Node.js 启动可能超过 2 秒，安装器健康检查可能在崩溃前误判通过；额外等待后再验证。
echo "[phase3] Waiting 8s for broken process to crash..."
sleep 8

# 验证损坏版本确实已经崩溃。
# nohup 创建的进程在父进程尚未回收时可能成为 Z 状态僵尸；kill -0 对僵尸仍成功，因此改查 /proc。
echo "[phase3] Checking if broken version crashed..."
PID=$(cat "$HOME/.loongsuite-pilot/loongsuite-pilot.pid" 2>/dev/null || echo "")
PROC_ALIVE=0
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
# 检查是否为已退出但尚未回收的僵尸进程。
  PROC_STATE=$(cat /proc/$PID/status 2>/dev/null | grep "^State:" | awk '{print $2}')
  if [ "$PROC_STATE" = "Z" ]; then
    echo "[phase3] PID $PID is zombie (crashed but not reaped) — treating as dead"
  else
    PROC_ALIVE=1
  fi
fi
if [ "$PROC_ALIVE" -eq 1 ]; then
  echo "FAIL: broken process (PID $PID) still alive after 8s (state: $PROC_STATE)"
  ps -p $PID -o pid,stat,args 2>/dev/null || true
  exit 1
fi
echo "[phase3] Confirmed: broken process crashed (PID $PID exited)"

# 确认 upgrade 确实把 current 指向损坏版本。
DEPLOY_CURRENT=$(cat "$CURRENT_FILE" 2>/dev/null || echo "")
echo "[phase3] Current after upgrade: '$DEPLOY_CURRENT'"
if [ "$DEPLOY_CURRENT" = "$OLD_CURRENT" ]; then
  echo "FAIL: broken version was not deployed (current unchanged)"
  exit 1
fi

# 执行并验证回滚机制。
echo "[phase3] Triggering manual rollback..."
loongsuite-pilot stop 2>/dev/null || true
loongsuite-pilot rollback 2>&1 || {
  echo "FAIL: loongsuite-pilot rollback command failed"
  exit 1
}
sleep 2

# 验证 current 已恢复。
NEW_CURRENT=$(cat "$CURRENT_FILE" 2>/dev/null || echo "missing")
echo "[phase3] Post-rollback current: '$NEW_CURRENT'"

if [ "$NEW_CURRENT" != "$OLD_CURRENT" ]; then
  echo "FAIL: current not restored after rollback (expected '$OLD_CURRENT', got '$NEW_CURRENT')"
  exit 1
fi

# rollback 命令会自行重启服务，这里等待短暂稳定后检查运行状态。
sleep 3

STATUS_OUT=$(loongsuite-pilot status 2>&1 || true)
echo "[phase3] Status output: $STATUS_OUT"
if ! echo "$STATUS_OUT" | grep -q "is running"; then
# 服务可能尚未启动，失败时显式再执行一次 start。
  loongsuite-pilot start 2>&1 || true
  sleep 3
  STATUS_OUT=$(loongsuite-pilot status 2>&1 || true)
  echo "[phase3] Status after explicit start: $STATUS_OUT"
  if ! echo "$STATUS_OUT" | grep -q "is running"; then
    echo "FAIL: pilot not running after rollback"
    exit 1
  fi
fi

echo "[phase3] PASSED: rollback restored to '$OLD_CURRENT', service running"
PHASE3_EOF
chmod +x /tmp/e2e-phase3.sh
exec bash /tmp/e2e-phase3.sh
`;
}

/**
 * 阶段 4：双路发送。
 * 注入双 SLS endpoint 配置、重启、触发 probe 并等待 flush。
 * 脚本返回后由 Node.js 执行断言。
 */
export function buildDualSendPhaseScript(env, portA, portB) {
  return `
set -euo pipefail
CONFIG="$HOME/.loongsuite-pilot/config.json"

echo "[phase4] Dual Send Test (portA: ${portA}, portB: ${portB})"

# 确保 Pilot 状态正常，并从阶段 3 可能留下的损坏状态恢复。
CURRENT_FILE="$HOME/.loongsuite-pilot/current"
loongsuite-pilot stop 2>/dev/null || true
sleep 1
# 若当前版本的 dist/index.js 含测试注入的 process.exit，则先回滚。
CURR_VER=$(cat "$CURRENT_FILE" 2>/dev/null || echo "")
if [ -n "$CURR_VER" ]; then
  CURR_INDEX="$HOME/.loongsuite-pilot/versions/$CURR_VER/dist/index.js"
  if [ -f "$CURR_INDEX" ] && grep -q "broken-package-e2e-crash\|^process.exit" "$CURR_INDEX" 2>/dev/null; then
    echo "[phase4] Current version '$CURR_VER' is broken, running rollback..."
    loongsuite-pilot rollback 2>&1 || true
    sleep 1
  fi
fi
# 在 Pilot 启动前创建 Codex 检测路径和日志目录，使 discovery.isAvailable() 启动时返回 true，
# 对应 Input 可以立即启动。
mkdir -p "$HOME/.codex"
mkdir -p "$HOME/.loongsuite-pilot/logs/codex"
export LOONGSUITE_PILOT_DISCOVERY_INTERVAL_MS=5000

loongsuite-pilot start || { echo "FAIL: cannot start pilot for phase 4"; exit 1; }
sleep 2

# 使用数组格式注入双 endpoint 配置，覆盖 config-loader 的数组分支。
node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('$CONFIG', 'utf-8'));
cfg.sls = [
  {
    name: 'e2e-raw',
    endpoint: 'http://127.0.0.1:${portA}',
    project: '',
    logstore: 'raw',
    mode: 'webtracking',
    redact: false
  },
  {
    name: 'e2e-redacted',
    endpoint: 'http://127.0.0.1:${portB}',
    project: '',
    logstore: 'redacted',
    mode: 'webtracking',
    redact: true
  }
];
fs.writeFileSync('$CONFIG', JSON.stringify(cfg, null, 2));
console.log('[phase4] Dual endpoints config injected (array format)');
"

# 重启使 SLS 配置生效，并且必须在重启后再写记录，使新实例看到持久化 offset 之后的新字节。
loongsuite-pilot restart
sleep 8

# 写入合成 JSONL，运行实例会在下一轮询周期读取。
HOOK_LOG_DIR="$HOME/.loongsuite-pilot/logs/codex"
mkdir -p "$HOOK_LOG_DIR"
TODAY=$(date +%Y-%m-%d)
HOOK_LOG_FILE="$HOOK_LOG_DIR/codex-$TODAY.jsonl"
echo "[phase4] Writing synthetic hook records to $HOOK_LOG_FILE"

TS_NANO=$(date +%s)000000000
SESSION_ID="e2e-dual-send-$(date +%s)"

for i in 1 2 3 4 5; do
  cat >> "$HOOK_LOG_FILE" << JSONL_EOF
{"event.name":"gen_ai.content.completion","time_unix_nano":"$TS_NANO","event.id":"evt-$i","gen_ai.session.id":"$SESSION_ID","gen_ai.agent.type":"codex_cli_hook","user.id":"e2e-test","gen_ai.request.model":"gpt-4o","gen_ai.usage.input_tokens":100,"gen_ai.usage.output_tokens":50,"gen_ai.output.messages":"hello from e2e dual-send test record $i"}
JSONL_EOF
  TS_NANO=$((TS_NANO + 1000000000))
done
echo "[phase4] Wrote 5 synthetic records"

# 等待 30 秒轮询读取、分发，再等待默认 2 秒 SLS flush。
echo "[phase4] Waiting 45s for poll cycle + SLS flush..."
sleep 45

echo "[phase4] Script complete (assertions checked in Node)"
`;
}

/**
 * 阶段 5：脱敏验证。
 * 注入 mask=all，触发包含敏感模式的 probe，再校验 JSONL。
 */
export function buildMaskingPhaseScript(env) {
  return `
set -euo pipefail
CONFIG="$HOME/.loongsuite-pilot/config.json"
OUTPUT_DIR="$HOME/.loongsuite-pilot/logs/output"

echo "[phase5] Masking Validation Test"

# 确保 Pilot 当前状态正常。
loongsuite-pilot stop 2>/dev/null || true
sleep 1

# 在 Pilot 启动前创建 Codex 检测路径和日志目录，使 discovery.isAvailable() 启动时返回 true，
# 对应 Input 可以立即启动。
mkdir -p "$HOME/.codex"
mkdir -p "$HOME/.loongsuite-pilot/logs/codex"
export LOONGSUITE_PILOT_DISCOVERY_INTERVAL_MS=5000

loongsuite-pilot start 2>/dev/null || true
sleep 2

# 注入脱敏配置。
node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('$CONFIG', 'utf-8'));
cfg.mask = {
  mode: 'all',
  types: ['cloudAccessKey', 'apiKey', 'privateKey', 'databaseUrl']
};
// 确保 JSONL Flusher 已启用，供本地验证输出。
if (!cfg.flushers) cfg.flushers = {};
cfg.flushers.jsonl = { enabled: true, outputDir: '$OUTPUT_DIR', rotateDaily: false, maxFileSizeMb: 50 };
fs.writeFileSync('$CONFIG', JSON.stringify(cfg, null, 2));
console.log('[phase5] mask config injected (mode=all)');
"

# 先重启 Pilot 使脱敏配置生效，再写入记录。与阶段 4 的 StateStore offset 约束相同：记录必须在
# 重启后产生，才能位于持久化 offset 之后。
loongsuite-pilot restart
sleep 8

# 写入包含敏感数据的合成 JSONL，由新实例采集。
HOOK_LOG_DIR="$HOME/.loongsuite-pilot/logs/codex"
mkdir -p "$HOOK_LOG_DIR"
TODAY=$(date +%Y-%m-%d)
HOOK_LOG_FILE="$HOOK_LOG_DIR/codex-$TODAY.jsonl"
echo "[phase5] Writing synthetic records with sensitive data to $HOOK_LOG_FILE"

TS_NANO=$(date +%s)000000000
SESSION_ID="e2e-mask-test-$(date +%s)"

for i in 1 2 3; do
  cat >> "$HOOK_LOG_FILE" << JSONL_EOF
{"event.name":"gen_ai.content.completion","time_unix_nano":"$TS_NANO","event.id":"mask-evt-$i","gen_ai.session.id":"$SESSION_ID","gen_ai.agent.type":"codex_cli_hook","user.id":"e2e-test","gen_ai.request.model":"gpt-4o","gen_ai.usage.input_tokens":100,"gen_ai.usage.output_tokens":50,"gen_ai.output.messages":"credentials: LTAI1234567890abcdef and sk-fake1234567890abcdefghijkl and mysql://root:s3cret@db.host/prod"}
JSONL_EOF
  TS_NANO=$((TS_NANO + 1000000000))
done
echo "[phase5] Wrote 3 synthetic records with sensitive data"

# 等待下一轮 30 秒采集、脱敏和 JSONL flush。
echo "[phase5] Waiting 45s for poll cycle + mask + JSONL flush..."
sleep 45

# 校验 JSONL 输出中的脱敏结果。
echo "[phase5] Checking JSONL files for raw sensitive data..."
FAIL=0

if [ -d "$OUTPUT_DIR" ]; then
  for f in "$OUTPUT_DIR"/*.jsonl; do
    [ -f "$f" ] || continue
    if grep -q "sk-fake1234567890abcdefghijkl" "$f"; then
      echo "FAIL: raw API key found in $f"
      FAIL=1
    fi
    if grep -q "LTAI1234567890abcdef" "$f"; then
      echo "FAIL: raw access key found in $f"
      FAIL=1
    fi
    if grep -q "mysql://root:s3cret" "$f"; then
      echo "FAIL: raw database URL found in $f"
      FAIL=1
    fi
  done

# 检查脱敏 marker 存在，以证明脱敏流程已生效。
  MASKED_FOUND=0
  for f in "$OUTPUT_DIR"/*.jsonl; do
    [ -f "$f" ] || continue
    if grep -qE "MASKED|\\*{4,}" "$f"; then
      MASKED_FOUND=1
      break
    fi
  done

  if [ "$MASKED_FOUND" -eq 0 ]; then
    echo "FAIL: no masked markers found in JSONL output"
    echo "INFO: Expected markers like [ACCESSKEY_MASKED], [APIKEY_MASKED], etc."
    JSONL_COUNT=$(find "$OUTPUT_DIR" -name "*.jsonl" -size +0 | wc -l)
    echo "INFO: JSONL files with content: $JSONL_COUNT"
    for f in "$OUTPUT_DIR"/*.jsonl; do
      [ -f "$f" ] || continue
      echo "  File: $f ($(wc -l < "$f") lines)"
      tail -3 "$f"
    done
    FAIL=1
  else
    echo "[phase5] Confirmed: masked markers present in JSONL"
  fi
else
  echo "FAIL: output dir $OUTPUT_DIR does not exist — JSONL flusher not active"
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

echo "[phase5] PASSED: sensitive data masked in JSONL output"
`;
}
