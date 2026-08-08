#!/usr/bin/env node
/**
 * Docker E2E 主入口，替代旧的 SSH runner，在预装 Agent 的容器内部执行场景。
 * 它解析命令行/环境变量，加载 agent-matrix，根据场景生成 Bash 文本，并交给
 * `docker-runner.mjs` 创建带超时和日志转发的子进程。失败场景会设置非零退出码。
 * 生成器与远程测试共用，避免安装、升级、卸载及 Agent 探测行为出现两套实现。
 */
import process from 'node:process';
import { runLocalScript } from './lib/docker-runner.mjs';
import { buildRemoteInstallSlsCliQuotedArgs } from './lib/propagate-sls-install.mjs';
import { loadAgentMatrix } from './lib/agent-matrix.mjs';
import {
  rebootAutostartScript,
  postRebootVerificationScript,
  multiAccountInstallScript,
  autoUpgradeScript,
  versionMatrixScript,
  buildJsonlValidationSh,
  DEFAULT_E2E_INSTALLER_URL,
  preflightScript,
  localBuildInstallScript,
  uninstallScript,
  buildJsonlAgentCoverageCheck,
  buildAgentConfigSetupScript,
  buildAgentEnsureOnlyScript,
  buildAgentProbeOnlyScript,
  buildProbeEnvInjections,
} from './lib/e2e-scenarios.mjs';

const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR?.trim() || '/opt/artifacts';

/** 生成 Docker install-smoke 使用的 Bash，安全引用安装器 URL、用户 ID 和可选 SLS 参数。 */
function installSmokeScript(installerUrl, userId, env) {
  const u = installerUrl.replace(/'/g, `'\\''`);
  const id = userId.replace(/'/g, `'\\''`);
  const slsFlags = buildRemoteInstallSlsCliQuotedArgs(env);
  const installTail = slsFlags ? ` ${slsFlags}` : '';
  return `
set -euo pipefail
INSTALLER_URL='${u}'
USER_ID='${id}'
echo "[install-smoke] INSTALLER_URL=$INSTALLER_URL"
echo "[install-smoke] command: curl -fsSL \\"$INSTALLER_URL\\" | bash -s -- install --user.id \\"$USER_ID\\"${installTail}"
curl -fsSL "$INSTALLER_URL" | bash -s -- install --user.id "$USER_ID"${installTail}
command -v loongsuite-pilot >/dev/null
test -d "$HOME/.loongsuite-pilot"
echo "install-smoke: loongsuite-pilot on PATH and data dir present"
`;
}

/**
 * Docker 适配的重启脚本：安装 Pilot、验证状态，再通过杀进程并重启服务模拟主机重启。
 */
function dockerRebootAutostartScript(installerUrl, userId, env) {
  const u = installerUrl.replace(/'/g, `'\\''`);
  const id = userId.replace(/'/g, `'\\''`);
  const slsFlags = buildRemoteInstallSlsCliQuotedArgs(env);
  const installTail = slsFlags ? ` ${slsFlags}` : '';
  return `
set -euo pipefail
INSTALLER_URL='${u}'
USER_ID='${id}'

echo "=== Phase 1: Install loongsuite-pilot ==="
curl -fsSL "$INSTALLER_URL" | bash -s -- install --user.id "$USER_ID"${installTail}
command -v loongsuite-pilot >/dev/null
echo "install: loongsuite-pilot on PATH"

echo "=== Phase 2: Verify initial service status ==="
loongsuite-pilot status || true
if systemctl --user is-active --quiet loongsuite-pilot.service 2>/dev/null; then
  echo "autostart: systemd user unit is active"
elif pgrep -f 'loongsuite-pilot|collector-daemon|updater-daemon' >/dev/null; then
  echo "autostart: process running"
else
  echo "WARNING: service not detected after install"
fi

echo "=== Pre-reboot diagnostics ==="
loongsuite-pilot info || true
ps aux | grep -E 'loongsuite-pilot|node.*dist/index' | grep -v grep || true

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$HOME/.loongsuite-pilot/.e2e-reboot-marker"
echo "Marker written: $HOME/.loongsuite-pilot/.e2e-reboot-marker"

echo "=== Phase 3: Simulating reboot (Docker: kill + restart) ==="
pkill -f 'loongsuite-pilot|collector-daemon|updater-daemon' 2>/dev/null || true
sleep 3
echo "Processes killed, waiting for auto-restart..."
sleep 5
`;
}

/** 作为 run-docker-e2e.mjs 的命令入口，编排参数、I/O 和退出码；顶层错误由文件末尾统一处理。 */
async function main() {
  const env = process.env;
  const scenario = (env.E2E_SCENARIO ?? 'preflight').trim();
  const installerUrl = (env.E2E_INSTALLER_URL ?? DEFAULT_E2E_INSTALLER_URL).trim();
  const userId = env.E2E_USER_ID?.trim();
  const userIds = env.E2E_USER_IDS?.trim();
  const profile = (env.E2E_PROFILE ?? 'linux-8u').trim().toLowerCase();

  console.log(`[e2e-docker] scenario=${scenario} profile=${profile} (Docker mode)`);

  if ((scenario === 'install-smoke' || scenario === 'reboot-autostart' || scenario === 'auto-upgrade') && !userId) {
    console.error('E2E_USER_ID is required for install-smoke, reboot-autostart, and auto-upgrade');
    process.exit(2);
  }

  if (scenario === 'multi-account' && !userIds) {
    console.error('E2E_USER_IDS (comma-separated) is required for multi-account scenario');
    process.exit(2);
  }

  let script = '';

  if (scenario === 'preflight') {
    script = preflightScript();
  } else if (scenario === 'install-smoke') {
    if (env.E2E_LOCAL_BUILD === '1') {
      console.log('[e2e-docker] LOCAL BUILD mode: deploying from /opt/project');
      script = localBuildInstallScript(userId ?? '', env);
    } else {
      script = installSmokeScript(installerUrl, userId ?? '', env);
    }
  } else if (scenario === 'uninstall') {
    script = uninstallScript(installerUrl);
  } else if (scenario === 'reboot-autostart') {
    script = dockerRebootAutostartScript(installerUrl, userId ?? '', env);
  } else if (scenario === 'post-reboot-verify') {
    script = postRebootVerificationScript();
  } else if (scenario === 'multi-account') {
    script = multiAccountInstallScript(installerUrl, userIds ?? '', env);
  } else if (scenario === 'auto-upgrade') {
    script = autoUpgradeScript(installerUrl, userId ?? '', env);
  } else if (scenario === 'version-matrix') {
    const vmMatrix = loadAgentMatrix(env);
    script = versionMatrixScript(vmMatrix, env);
  } else {
    console.error(`Unknown E2E_SCENARIO: ${scenario}`);
    console.error('Supported: preflight, install-smoke, uninstall, reboot-autostart, post-reboot-verify, multi-account, auto-upgrade, version-matrix');
    process.exit(2);
  }

  if (!script) throw new Error('Internal error: empty script');

  const r = await runLocalScript({
    script,
    artifactDir: ARTIFACT_DIR,
    artifactLabel: scenario,
  });

  if (r.code !== 0) {
    console.error(r.stderr || r.stdout);
    await keepAliveOnFailure(r.code ?? 1);
  }

  console.log(`[e2e-docker] "${scenario}" completed successfully (exit 0).`);

    // reboot-autostart 场景在模拟重启后继续执行“重启后”验证。
  if (scenario === 'reboot-autostart') {
    console.log('[e2e-docker] Running post-reboot verification...');
    const verifyScript = postRebootVerificationScript();
    const verify = await runLocalScript({
      script: verifyScript,
      artifactDir: ARTIFACT_DIR,
      artifactLabel: 'post-reboot-verify',
    });
    if (verify.code !== 0) {
      console.error('[e2e-docker] Post-reboot verification failed:');
      console.error(verify.stderr || verify.stdout);
      await keepAliveOnFailure(verify.code ?? 1);
    }
    console.log('[e2e-docker] Post-reboot verification passed.');
  }

  // install-smoke 的 Agent probe 阶段。
  if (scenario === 'install-smoke') {
    const probeBody = buildAgentProbeOnlyScript({ ...env, E2E_ENSURE_AGENT_CLIS: '0' });
    if (probeBody) {
    // 步骤 1：立即写入 Agent 配置，使 Pilot 在下一轮询发现；其中会创建 Codex 检测目录、
    // Claude 配置和 proxy 配置等。
      const configScript = buildAgentConfigSetupScript(env);
      if (configScript) {
        console.log('[e2e-docker] Writing agent configs (codex, claude, proxy)...');
        await runLocalScript({
          script: configScript,
          artifactDir: ARTIFACT_DIR,
          artifactLabel: 'agent-config-setup',
        });
      }

      const ensureScript = buildAgentEnsureOnlyScript(env);
      if (ensureScript) {
        console.log('[e2e-docker] Ensuring CLI agents before deployment wait...');
        const ensure = await runLocalScript({
          script: `${buildProbeEnvInjections(env)}${ensureScript}`,
          artifactDir: ARTIFACT_DIR,
          artifactLabel: 'agent-ensure',
        });
        if (ensure.code !== 0) {
          console.error(ensure.stderr || ensure.stdout);
          await keepAliveOnFailure(ensure.code ?? 1);
        }
      }

    // 步骤 2：等待 Pilot 完成必需声明的部署。qoder-cli 复用 qoder 声明，稍后再检查其 JSONL 覆盖。
      const requiredAgents = (env.E2E_REQUIRED_DEPLOY_AGENTS ?? 'claude-code,codex,qoder,cursor,qwen-code-cli,opencode')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      console.log(`[e2e-docker] Waiting for pilot to deploy all agents: ${requiredAgents.join(', ')}...`);
      const requiredAgentsSh = requiredAgents.join(' ');
      const waitScript = [
        'set -euo pipefail',
        'LOG="$HOME/.loongsuite-pilot/logs/loongsuite-pilot-service.log"',
        'TIMEOUT=180',
        'ELAPSED=0',
        `REQUIRED="${requiredAgentsSh}"`,
        '',
        'while [ $ELAPSED -lt $TIMEOUT ]; do',
        '  ALL_FOUND=1',
        '  for agent in $REQUIRED; do',
        '    if ! grep -q "\\\"id\\\":\\\"deploy:${agent}\\\".*agent detected and started" "$LOG" 2>/dev/null; then',
        '      ALL_FOUND=0',
        '      break',
        '    fi',
        '  done',
        '  if [ "$ALL_FOUND" -eq 1 ]; then',
        '    echo "[pilot-ready] All agents deployed (${ELAPSED}s): $REQUIRED"',
        '    exit 0',
        '  fi',
        '  sleep 3',
        '  ELAPSED=$((ELAPSED + 3))',
        'done',
        '',
        'echo "[pilot-ready] WARNING: timed out (${TIMEOUT}s). Agent deployment status:"',
        'for agent in $REQUIRED; do',
        '  if grep -q "\\\"id\\\":\\\"deploy:${agent}\\\".*agent detected and started" "$LOG" 2>/dev/null; then',
        '    echo "  OK: $agent"',
        '  else',
        '    echo "  MISSING: $agent"',
        '  fi',
        'done',
        'echo ""',
        'echo "[pilot-ready] Last 10 deploy-related log lines:"',
        'grep -iE "deploy|Discover|detected" "$LOG" 2>/dev/null | tail -10 || true',
      ].join('\n');
      await runLocalScript({
        script: waitScript,
        artifactDir: ARTIFACT_DIR,
        artifactLabel: 'pilot-ready-wait',
      });

    // 步骤 3：确认 CLI 后运行 Agent matrix probes。
      const probeScript = `${buildProbeEnvInjections(env)}${probeBody}`;
      const probe = await runLocalScript({
        script: probeScript,
        artifactDir: ARTIFACT_DIR,
        artifactLabel: 'agent-probe',
      });
      if (probe.code !== 0) {
        console.error(probe.stderr || probe.stdout);
        await keepAliveOnFailure(probe.code ?? 1);
      }
      console.log('[e2e-docker] agent probe phase completed successfully.');

    // 等待 Pilot 把已采集 Agent 活动 flush 到 JSONL/SLS。
      console.log('[e2e-docker] Waiting 60s for pilot to process agent activity logs...');
      await new Promise(resolve => setTimeout(resolve, 60_000));

    // 输出诊断：检查 Pilot 状态和日志目录。
      await runLocalScript({
        script: `set +e
echo "=== [diagnostics] pilot process ==="
ps aux | grep -E 'loongsuite-pilot|node.*dist/index' | grep -v grep || echo "NO pilot process found"
echo ""
echo "=== [diagnostics] logs directory tree ==="
find "$HOME/.loongsuite-pilot/logs" -type f 2>/dev/null | head -30 || echo "logs dir not found"
echo ""
echo "=== [diagnostics] logs/output contents ==="
ls -la "$HOME/.loongsuite-pilot/logs/output/" 2>/dev/null || echo "logs/output dir not found"
echo ""
echo "=== [diagnostics] logs/codex contents ==="
ls -la "$HOME/.loongsuite-pilot/logs/codex/" 2>/dev/null || echo "logs/codex dir not found"
echo ""
echo "=== [diagnostics] logs/claude contents ==="
ls -la "$HOME/.loongsuite-pilot/logs/claude/" 2>/dev/null || echo "logs/claude dir not found"
`,
        artifactDir: ARTIFACT_DIR,
        artifactLabel: 'diagnostics',
      });

    // 给 Pilot 留出处理时间后校验 JSONL。
      const jsonlSh = buildJsonlValidationSh(env);
      if (jsonlSh) {
        console.log('[e2e-docker] Running JSONL validation...');
        const jsonlResult = await runLocalScript({
          script: jsonlSh,
          artifactDir: ARTIFACT_DIR,
          artifactLabel: 'jsonl-validate',
        });
        if (jsonlResult.code !== 0) {
          console.error('[e2e-docker] JSONL validation failed.');
          await keepAliveOnFailure(jsonlResult.code ?? 1);
        }
        console.log('[e2e-docker] JSONL validation passed.');
      }

    // Agent 覆盖检查：所有预期 Agent 都必须产出 JSONL 数据。
      const requiredJsonlAgents = (env.E2E_REQUIRED_JSONL_AGENTS ?? 'claude-code,codex,qoder-cli,cursor-cli,qwen-code-cli,opencode').trim();
      if (requiredJsonlAgents) {
        console.log(`[e2e-docker] Checking JSONL agent coverage: ${requiredJsonlAgents}`);
        const coverageScript = buildJsonlAgentCoverageCheck(requiredJsonlAgents);
        const coverageResult = await runLocalScript({
          script: coverageScript,
          artifactDir: ARTIFACT_DIR,
          artifactLabel: 'jsonl-agent-coverage',
        });
        if (coverageResult.code !== 0) {
          console.error('[e2e-docker] JSONL agent coverage check FAILED — not all required agents produced data.');
          console.error(coverageResult.stdout || coverageResult.stderr);
          await keepAliveOnFailure(coverageResult.code ?? 1);
        }
        console.log('[e2e-docker] JSONL agent coverage check passed.');
      }
    }
  }

  await keepAliveIfRequested(0);
  process.exit(0);
}

/**
 * 保持容器存活，便于通过 `docker exec -it <container> bash` 调试。
 *
 * 行为矩阵：
 * `E2E_DOCKER_KEEP_ALIVE=1` 无论成功失败都保持；`E2E_DOCKER_EXIT_ON_FAILURE=1` 失败立即退出；
 * 默认只在失败时保持容器。
 */
async function keepAliveIfRequested(code) {
  const keepAlive = process.env.E2E_DOCKER_KEEP_ALIVE === '1';
  const exitOnFailure = process.env.E2E_DOCKER_EXIT_ON_FAILURE === '1';

  if (code === 0 && !keepAlive) return;
  if (code !== 0 && exitOnFailure && !keepAlive) {
    process.exit(code);
  }

  const status = code === 0 ? 'PASSED' : 'FAILED';
  console.log(`[e2e-docker] Test ${status} (exit ${code}). Container kept alive for debugging.`);
  console.log('[e2e-docker] Attach with: docker exec -it <container> bash');
  console.log('[e2e-docker] Set E2E_DOCKER_KEEP_ALIVE=0 to exit immediately on success.');
    // setInterval 会让 Node.js 事件循环保持活跃；单独一个未完成 Promise 不具备该效果。
  await new Promise(() => { setInterval(() => {}, 1 << 30); });
}

/** 按 E2E 保活开关等待，便于失败后进入容器排障；默认立即返回原退出码。 */
async function keepAliveOnFailure(code) {
  await keepAliveIfRequested(code);
  process.exit(code);
}

main().catch(async err => {
  console.error(err);
  await keepAliveOnFailure(1);
});
