// Docker 容器内的 Bash 子进程执行器。场景入口把生成的脚本文本传给 `runLocalScript()`，
// 本模块使用 `spawn` 连接 stdout/stderr 到控制台和按时间命名的日志文件，并用 AbortController
// 在超时后终止子进程。日志流在进程内缓存复用，调用方应在全部场景结束后关闭。
// Promise 在退出码 0 时 resolve，非零退出、spawn 错误或超时则 reject。

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import * as path from 'node:path';

// 环境变量允许 CI 将 artifacts 挂载到宿主机；默认目录适用于测试镜像。
const LOG_DIR = process.env.E2E_LOG_DIR || '/opt/artifacts';
let _logStream = null;

/** 延迟创建并缓存 artifacts 追加流，保证同一 E2E 进程的子场景写入同一日志文件。 */
async function getLogStream() {
  if (_logStream) return _logStream;
  await fs.mkdir(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(LOG_DIR, `e2e-docker-${stamp}.log`);
  _logStream = createWriteStream(logFile, { flags: 'a' });
  console.log(`[e2e-docker] Log file: ${logFile}`);
  return _logStream;
}

/**
 * 在 Docker 容器内本地运行 Bash 脚本，用于替代 SSH runner。
 * @param {object} opts
 * @param {string} opts.script 完整 Bash 源码。
 * @param {string} [opts.artifactDir]
 * @param {string} [opts.artifactLabel]
 * @param {number} [opts.timeoutMs]
 */
export async function runLocalScript(opts) {
  const { script, artifactDir, artifactLabel = 'docker', timeoutMs = 600_000 } = opts;
  const logStream = await getLogStream();
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort();
    console.warn(`[e2e-docker] timeout after ${timeoutMs}ms — killing subprocess`);
  }, timeoutMs);

  const proc = spawn('bash', ['--norc', '--noprofile', '-c', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: process.env.HOME || '/home/testuser',
      PATH: `${process.env.HOME || '/home/testuser'}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    },
    signal: ac.signal,
  });

  proc.stdin?.end();

  let stdout = '';
  let stderr = '';
  proc.stdout?.on('data', c => { const s = c.toString(); stdout += s; process.stdout.write(s); logStream.write(s); });
  proc.stderr?.on('data', c => { const s = c.toString(); stderr += s; process.stderr.write(s); logStream.write(`[stderr] ${s}`); });

  const code = await new Promise((resolve, reject) => {
    proc.on('error', err => {
      clearTimeout(timer);
      if (err.name === 'AbortError' || /** @type {any} */ (err).code === 'ABORT_ERR') resolve(124);
      else reject(err);
    });
    proc.on('close', c => { clearTimeout(timer); resolve(c); });
  });

  if (artifactDir && (code !== 0 || process.env.E2E_ALWAYS_COLLECT === '1')) {
    await writeArtifact(artifactDir, artifactLabel, { stdout, stderr, code, command: script });
  }

  return { code: code ?? 1, stdout, stderr };
}

/**
 * 通过终止 Pilot 进程并重启 systemd 服务来模拟重启。
 * Docker 容器无法真正重启，因此这里只复现重启后的进程与服务效果。
 */
export async function simulateReboot() {
  console.log('[e2e-docker] Simulating reboot: killing pilot processes and restarting service...');
  const killScript = `
set +e
pkill -f 'loongsuite-pilot|collector-daemon|updater-daemon' 2>/dev/null || true
sleep 2
# 尝试重启 systemd user 服务
systemctl --user restart loongsuite-pilot.service 2>/dev/null || true
# 等待服务恢复
sleep 5
echo "[e2e-docker] Simulated reboot complete (processes killed + service restarted)"
`;
  return runLocalScript({ script: killScript, artifactLabel: 'simulate-reboot' });
}

/** 同步地对 redactSensitive 输入中的凭据字段脱敏，避免测试日志泄露 secret。 */
function redactSensitive(text) {
  let redacted = String(text ?? '');
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 4) continue;
    if (!/(SECRET|TOKEN|KEY|PASS|PAT|AK|SK)/i.test(key)) continue;
    redacted = redacted.split(value).join('<redacted>');
  }
  return redacted;
}

/** 把失败命令、输出和退出状态写入带时间戳的 artifact，便于容器退出后排障。 */
async function writeArtifact(dir, label, payload) {
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${label}-${stamp}.txt`);
  const cmd =
    payload.command.length > 8000
      ? `${payload.command.slice(0, 8000)}\n… (truncated)`
      : payload.command;
  const text = [
    `exit_code: ${payload.code}`,
    '--- script ---',
    redactSensitive(cmd),
    '--- stdout ---',
    redactSensitive(payload.stdout),
    '--- stderr ---',
    redactSensitive(payload.stderr),
    '',
  ].join('\n');
  await fs.writeFile(file, text, 'utf8');
}
