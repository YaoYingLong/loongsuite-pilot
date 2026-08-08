#!/usr/bin/env bash
# L1 E2E Shell 入口：读取 `.env.e2e`，构建/启动 Docker 环境，再把场景交给 `run-l1.mjs`。
# Docker、Node 或场景任一步失败都会因严格模式向调用方返回非零退出码。
#
# 用法：
#   ./scripts/e2e/run-e2e.sh                  # default scenario: install-smoke
#   ./scripts/e2e/run-e2e.sh preflight        # validate container only
#   ./scripts/e2e/run-e2e.sh install-smoke    # install + CLI-agent probe + JSONL/SLS check
#   ./scripts/e2e/run-e2e.sh uninstall        # install + uninstall + residue check
#
# 必需环境变量（写在 .env.e2e 中）：
#   E2E_USER_ID
#   E2E_CODEX_OPENAI_API_KEY / E2E_ANTHROPIC_API_KEY / E2E_QODER_PERSONAL_ACCESS_TOKEN
#   E2E_SLS_PROJECT / E2E_SLS_LOGSTORE / E2E_SLS_ACCESS_KEY_ID / E2E_SLS_ACCESS_KEY_SECRET
# 完整 CLI 覆盖的可选环境变量：
#   E2E_CURSOR_API_KEY / E2E_QWEN_API_KEY / E2E_OPENCODE_API_KEY
#   E2E_QWEN_PROBE_CMD / E2E_OPENCODE_PROBE_CMD
# 可选：E2E_SLS_ENDPOINT（默认 cn-hangzhou.log.aliyuncs.com）
# 调试：E2E_KEEP_ALIVE=1（失败时保留容器，便于执行 docker exec）
#
# L2（复杂场景/SSH 远程）请参阅 docs/E2E-REMOTE-TEST-GUIDE.md。

set -euo pipefail
cd "$(dirname "$0")/../.."

ENV_FILE=".env.e2e"
SCENARIO="${1:-install-smoke}"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found."
  echo "Copy .env.e2e.example to .env.e2e and fill in your values:"
  echo "  cp .env.e2e.example .env.e2e"
  exit 1
fi

set -a
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%#*}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [ -z "$line" ] && continue
  eval "$line"
done < "$ENV_FILE"
set +a

export E2E_SCENARIO="$SCENARIO"

echo "=== L1 E2E Runner (Docker, current branch code) ==="
echo "Scenario: $SCENARIO"
echo "User ID:  ${E2E_USER_ID:-<MISSING>}"
echo "SLS:      ${E2E_SLS_PROJECT:-<MISSING>}/${E2E_SLS_LOGSTORE:-<MISSING>}"
echo "===================================================="

echo "[e2e-l1] Building package (deploy/package.sh)..."
bash deploy/package.sh -o "$(pwd)/loongsuite-pilot.tar.gz"
echo "[e2e-l1] Package ready: $(pwd)/loongsuite-pilot.tar.gz"

docker compose -f tests/e2e-docker/docker-compose.l1.yml down -v 2>/dev/null || true
exec docker compose -f tests/e2e-docker/docker-compose.l1.yml up --build --exit-code-from e2e-agent
