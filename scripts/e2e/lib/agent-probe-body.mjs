/**
 * 构建 Agent 探测使用的远端 Bash。可用单独一行 `---` 分段：第一段作为 PATH/cd 等前置命令，
 * 后续每段经 base64 送入独立 `bash -s`，防止 Codex 等 CLI 从继承的 stdin 吞掉后续 SSH 脚本。
 *
 * 没有分隔符时也会把整段放入一个 base64 包装的内层 Bash，尽量隔离外层 stdin。
 * 本函数只返回文本；命令、子进程和远端副作用由 runner 执行。
 *
 * @param {string} probeCmd 原始探测命令，可包含 `---` 分段。
 * @returns {string} 完整远端 Bash 源码；是否 `set +e` 由调用方或外层脚本决定。
 */
export function buildAgentProbeRemoteBody(probeCmd) {
  const raw = probeCmd.trim();
  if (!raw) return '';

  const parts = raw.split(/\r?\n---\r?\n/).map(p => p.trim()).filter(Boolean);
  if (parts.length === 1) {
    return [
      'set +euo pipefail',
      'echo "[e2e-probe] stdin-isolated inner bash (use lines containing only --- between agents for per-agent isolation)"',
      wrapInBase64Bash(parts[0]),
    ].join('\n');
  }

  const lines = [
    'set +euo pipefail',
    'echo "[e2e-probe] multi-block probe (' +
      String(parts.length - 1) +
      ' isolated segment(s) after preamble; divider = line --- only)"',
    wrapInBase64Bash(parts[0]),
  ];
  for (let i = 1; i < parts.length; i++) {
    lines.push(`echo "[e2e-probe] --- block ${i} ---"`);
    lines.push(wrapInBase64Bash(parts[i]));
  }
  return lines.join('\n');
}

/**
 * @param {string} bashSnippet
 * @returns {string} 一条远端命令语句。
 */
export function wrapInBase64Bash(bashSnippet) {
  const b64 = Buffer.from(`${bashSnippet}\n`, 'utf8').toString('base64');
  return `printf '%s' '${b64}' | base64 -d | bash --norc --noprofile -s`;
}
