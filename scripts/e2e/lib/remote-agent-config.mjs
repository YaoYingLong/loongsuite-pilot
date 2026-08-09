// 远程/L1 E2E 的 Agent 凭据和代理配置脚本生成器。
// 导出函数把环境变量安全转义为 Bash 片段，用于 Codex、Claude、OpenCode 等 CLI 的临时测试配置；
// 它们返回字符串而不直接执行命令，真正的子进程和远端写入由场景 runner 负责。
// 任何 secret 只应进入测试进程环境，不应写入日志；调用方负责提供所需变量。

import { Buffer } from 'node:buffer';
import { shellSingleQuoteBash } from './propagate-sls-install.mjs';

/**
 * Claude Code → 阿里云百炼（Anthropic 兼容 `/apps/anthropic`），与 Codex 的 OpenAI `compatible-mode` 端点不同。
 * @param {NodeJS.ProcessEnv} env
 */
export function isE2eClaudeBailianEnabled(env = process.env) {
  // 只把明确的真值字符串视为启用；未设置或其他拼写都保持关闭。
  const v = env.E2E_CLAUDE_BAILIAN?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function buildRemoteClaudeBailianExportsSh(env = process.env) {
  // 返回空串表示调用方无需向远端脚本拼接任何配置。
  if (!isE2eClaudeBailianEnabled(env)) return '';
  const apiKey = env.E2E_CLAUDE_BAILIAN_API_KEY?.trim();
  if (!apiKey) {
    console.warn(
      '[e2e] Claude 百炼: E2E_CLAUDE_BAILIAN=1 but E2E_CLAUDE_BAILIAN_API_KEY is unset — skipping ANTHROPIC_BASE_URL / ANTHROPIC_MODEL injection.',
    );
    return '';
  }
  const baseUrl =
    env.E2E_CLAUDE_BAILIAN_BASE_URL?.trim() ||
    'https://dashscope.aliyuncs.com/apps/anthropic';
  const model = env.E2E_CLAUDE_BAILIAN_MODEL?.trim() || 'qwen3-coder-plus';
  console.log(
    `[e2e] Injecting Claude 百炼 env: ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY + ANTHROPIC_MODEL (${model})`,
  );
  return (
    // 每个值都用 Bash 单引号转义，防止 key 或 URL 中的 `$`、空格等被远端 Shell 再展开。
    `export ANTHROPIC_BASE_URL=${shellSingleQuoteBash(baseUrl)}\n` +
    `export ANTHROPIC_API_KEY=${shellSingleQuoteBash(apiKey)}\n` +
    `export ANTHROPIC_MODEL=${shellSingleQuoteBash(model)}\n`
  );
}

/**
 * 在远端 probe 脚本中导出 API key，因为 SSH 不会转发本地 Shell 变量。
 * Codex：CODEX_OPENAI_API_KEY 取自 E2E_CODEX_OPENAI_API_KEY，旧配置回退到 E2E_OPENAI_API_KEY。
 * Claude：百炼 E2E_CLAUDE_BAILIAN 会覆盖普通 E2E_ANTHROPIC_API_KEY，并生成远端 ANTHROPIC_*。
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function buildRemoteSecretExportsSh(env = process.env) {
  // lines 保存最终要送入 SSH 远端 shell 的 export 语句；本函数本身不会修改 process.env。
  const lines = [];
  // 专用 Codex key 优先，旧的通用 key 仅用于兼容已有 E2E 环境。
  const codexOpenai = env.E2E_CODEX_OPENAI_API_KEY?.trim() || env.E2E_OPENAI_API_KEY?.trim();
  if (codexOpenai) {
    if (env.E2E_CODEX_OPENAI_API_KEY?.trim()) {
      console.log('[e2e] Injecting CODEX_OPENAI_API_KEY (E2E_CODEX_OPENAI_API_KEY)');
    } else {
      console.log(
        '[e2e] Injecting CODEX_OPENAI_API_KEY from E2E_OPENAI_API_KEY (prefer E2E_CODEX_OPENAI_API_KEY for Codex-only keys)',
      );
    }
    lines.push(`export CODEX_OPENAI_API_KEY=${shellSingleQuoteBash(codexOpenai)}`);
  }

  const bailianBlock = buildRemoteClaudeBailianExportsSh(env);
  const anthropicLegacy =
    env.E2E_ANTHROPIC_API_KEY?.trim() || env.E2E_CLAUDE_API_KEY?.trim();
  if (bailianBlock) {
    // 百炼模式必须整块覆盖原生 Anthropic key，避免 base URL 与凭据来自两套配置。
    if (anthropicLegacy) {
      console.warn(
        '[e2e] Claude: E2E_CLAUDE_BAILIAN=1 wins over E2E_ANTHROPIC_API_KEY / E2E_CLAUDE_API_KEY for remote ANTHROPIC_* (omit legacy keys if unintended).',
      );
    }
    lines.push(bailianBlock.trimEnd());
  } else if (anthropicLegacy) {
    console.log(
      '[e2e] Injecting ANTHROPIC_API_KEY for Claude Code (E2E_ANTHROPIC_API_KEY or E2E_CLAUDE_API_KEY; use E2E_CLAUDE_BAILIAN=1 for 百炼 /apps/anthropic)',
    );
    lines.push(`export ANTHROPIC_API_KEY=${shellSingleQuoteBash(anthropicLegacy)}`);
  }
  const cursorKey = env.E2E_CURSOR_API_KEY?.trim();
  if (cursorKey) {
    console.log('[e2e] Injecting CURSOR_API_KEY into remote script (E2E_CURSOR_API_KEY)');
    lines.push(`export CURSOR_API_KEY=${shellSingleQuoteBash(cursorKey)}`);
  }

  const qwenKey = env.E2E_QWEN_API_KEY?.trim() || env.E2E_DASHSCOPE_API_KEY?.trim() || codexOpenai;
  if (qwenKey) {
    // Qwen CLI 兼容两种 key 变量名，因此同时导出；base URL/model 仍允许专项覆盖。
    const qwenBaseUrl = env.E2E_QWEN_BASE_URL?.trim() || env.E2E_CODEX_BASE_URL?.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    const qwenModel = env.E2E_QWEN_MODEL?.trim() || env.E2E_CODEX_MODEL?.trim() || 'qwen3-coder-plus';
    console.log('[e2e] Injecting QWEN_API_KEY / DASHSCOPE_API_KEY for Qwen Code CLI probe');
    lines.push(`export QWEN_API_KEY=${shellSingleQuoteBash(qwenKey)}`);
    lines.push(`export DASHSCOPE_API_KEY=${shellSingleQuoteBash(qwenKey)}`);
    lines.push(`export QWEN_BASE_URL=${shellSingleQuoteBash(qwenBaseUrl)}`);
    lines.push(`export E2E_QWEN_MODEL=${shellSingleQuoteBash(qwenModel)}`);
  }

  // OpenCode 通过 OPENCODE_API_KEY 使用来自 https://opencode.ai/workspace 的 OpenCode Zen key。
  // Zen 是独立 Provider（model = opencode/<model>）；OpenCode 会从 models.dev 解析网关端点，
  // 因此不需要 OPENAI_BASE_URL。不要复用百炼/Dashscope key，Zen 会拒绝该凭据。
  const opencodeKey = env.E2E_OPENCODE_API_KEY?.trim();
  if (opencodeKey) {
    const opencodeModel = env.E2E_OPENCODE_MODEL?.trim() || 'opencode/big-pickle';
    console.log(`[e2e] Injecting OPENCODE_API_KEY (OpenCode Zen) for OpenCode probe (model=${opencodeModel})`);
    lines.push(`export OPENCODE_API_KEY=${shellSingleQuoteBash(opencodeKey)}`);
    lines.push(`export E2E_OPENCODE_MODEL=${shellSingleQuoteBash(opencodeModel)}`);
  } else {
    console.log('[e2e] E2E_OPENCODE_API_KEY unset — OpenCode conversation probe will skip (get a key from opencode.ai/workspace; do NOT reuse the 百炼 key)');
  }

  for (const [source, target] of [
    ['E2E_QWEN_PROBE_CMD', 'E2E_QWEN_PROBE_CMD'],
    ['E2E_OPENCODE_PROBE_CMD', 'E2E_OPENCODE_PROBE_CMD'],
    ['E2E_QWEN_NPM_SPEC', 'E2E_QWEN_NPM_SPEC'],
    ['E2E_OPENCODE_NPM_SPEC', 'E2E_OPENCODE_NPM_SPEC'],
  ]) {
    // probe 命令和 npm spec 也需显式转发，因为普通 SSH 不继承发起端进程环境。
    const value = env[source]?.trim();
    if (value) lines.push(`export ${target}=${shellSingleQuoteBash(value)}`);
  }

  if (!lines.length) return '';
  // 末尾换行使此片段与后续生成的 Bash 命令自然分隔。
  return `${lines.join('\n')}\n`;
}

/**
 * 远端 Bash：根据环境变量模板写 ~/.codex/config.toml；文件不含 secret，而是使用 env_key。
 * 默认 env_key 为 CODEX_OPENAI_API_KEY，与 E2E_CODEX_OPENAI_API_KEY/E2E_OPENAI_API_KEY 回退导出一致。
 * 设置 E2E_WRITE_REMOTE_CODEX_CONFIG=1 启用。
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function buildRemoteCodexConfigSh(env = process.env) {
  if (env.E2E_WRITE_REMOTE_CODEX_CONFIG?.trim() !== '1') return '';
  const provider =
    env.E2E_CODEX_MODEL_PROVIDER?.trim() || 'Model_Studio_Coding_Plan';
  const model = env.E2E_CODEX_MODEL?.trim() || 'qwen3.6-plus';
  const baseUrl =
    env.E2E_CODEX_BASE_URL?.trim() ||
    'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const envKey = env.E2E_CODEX_ENV_KEY?.trim() || 'CODEX_OPENAI_API_KEY';
  const wireApi = env.E2E_CODEX_WIRE_API?.trim() || 'responses';

  // TOML 双引号字符串至少需要转义反斜杠和双引号，防止用户配置破坏模板结构。
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const toml = `model_provider = "${esc(provider)}"
model = "${esc(model)}"

[model_providers.${provider}]
name = "${esc(provider)}"
base_url = "${esc(baseUrl)}"
env_key = "${esc(envKey)}"
wire_api = "${esc(wireApi)}"

[features]
hooks = true
shell_snapshot = false
`;
  const b64 = Buffer.from(`${toml}\n`, 'utf8').toString('base64');
  // 默认执行“保留 Hook 的合并”；只有显式置 1 才允许完全覆盖旧 config.toml。
  const forceReplace = env.E2E_WRITE_REMOTE_CODEX_CONFIG_REPLACE?.trim() === '1' ? '1' : '0';

  /** 在远端运行；存在 OTel Codex Hook 时合并 Dashscope 配置块，避免覆盖 SLS 相关配置。 */
  const mergeNode = [
    // 这段 Node 源码会在远端执行。使用字符串数组可避免外层模板字符串误展开其中的字符。
    "'use strict';",
    "const fs = require('fs');",
    "const os = require('os');",
    "const freshPath = '/tmp/e2e-loongsuite-codex-fresh.toml';",
    "const cfgPath = os.homedir() + '/.codex/config.toml';",
    "const hooksPath = os.homedir() + '/.codex/hooks.json';",
    "const fresh = fs.readFileSync(freshPath, 'utf8');",
    "let old = '';",
    "try { old = fs.readFileSync(cfgPath, 'utf8'); } catch (e) {}",
    "function shouldMerge() {",
    "  if (process.env.E2E_WRITE_REMOTE_CODEX_REPLACE === '1') return false;",
    "  try {",
    "    if (/otel-codex/i.test(fs.readFileSync(hooksPath, 'utf8'))) return true;",
    "  } catch (e) {}",
    "  return /otel-codex-hook/i.test(old);",
    "}",
    "function stripForMerge(text) {",
    "  const lines = text.split('\\n');",
    "  const res = [];",
    "  const seenHookState = new Set();",
    "  let i = 0;",
    "  while (i < lines.length) {",
    "    const line = lines[i];",
    "    if (/^\\s*model_provider\\s*=/.test(line)) { i++; continue; }",
    "    if (/^\\s*model\\s*=/.test(line)) { i++; continue; }",
    "    if (/^\\[model_providers\\./.test(line)) {",
    "      i++;",
    "      while (i < lines.length && !/^\\[[^\\]]+\\]/.test(lines[i])) i++;",
    "      continue;",
    "    }",
    "    if (/^\\[features\\]/.test(line)) {",
    "      i++;",
    "      while (i < lines.length && !/^\\[[^\\]]+\\]/.test(lines[i])) i++;",
    "      continue;",
    "    }",
    "    const hs = line.match(/^\\[hooks\\.state\\.(\".*?\"|[^\\]]+)\\]/);",
    "    if (hs) {",
    "      const key = hs[1];",
    "      const dup = seenHookState.has(key);",
    "      if (!dup) { seenHookState.add(key); res.push(line); }",
    "      i++;",
    "      while (i < lines.length && !/^\\[[^\\]]+\\]/.test(lines[i])) { if (!dup) res.push(lines[i]); i++; }",
    "      continue;",
    "    }",
    "    res.push(line);",
    "    i++;",
    "  }",
    "  return res.join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();",
    "}",
    "if (!shouldMerge()) {",
    "  fs.writeFileSync(cfgPath, fresh);",
    "  console.log('[e2e-ensure] wrote ~/.codex/config.toml (Dashscope template; full replace)');",
    "  process.exit(0);",
    "}",
    "const stripped = stripForMerge(old);",
    "const merged = (fresh.trim() + '\\n\\n' + stripped).trim() + '\\n';",
    "fs.writeFileSync(cfgPath, merged);",
    "console.log('[e2e-ensure] merged Dashscope template into ~/.codex/config.toml (kept OTel / other sections)');",
  ].join('\n');

  const mergeNodeB64 = Buffer.from(mergeNode, 'utf8').toString('base64');

  return (
    // 先落一份临时新配置，再让远端 Node 判断合并/替换；每一步用 `&&` 串联，失败即停止后续步骤。
    `mkdir -p "$HOME/.codex" && ` +
      `printf '%s' '${b64}' | base64 -d > /tmp/e2e-loongsuite-codex-fresh.toml && ` +
      `export E2E_WRITE_REMOTE_CODEX_REPLACE='${forceReplace}' && ` +
      `if command -v node >/dev/null 2>&1; then ` +
      // Node 可用时执行结构化合并，并在成功后清理临时文件。
      `printf '%s' '${mergeNodeB64}' | base64 -d | node && rm -f /tmp/e2e-loongsuite-codex-fresh.toml; ` +
      `else ` +
      // 无 Node 的远端无法可靠合并 TOML，只能覆盖并输出清晰警告；这是 E2E 的兼容降级路径。
      `printf '%s' '${b64}' | base64 -d > "$HOME/.codex/config.toml" && rm -f /tmp/e2e-loongsuite-codex-fresh.toml && ` +
      `echo "[e2e-ensure] WARN: node missing — wrote ~/.codex/config.toml without merge (may drop OTel blocks; install node or set hooks before E2E)"; ` +
      `fi && ` +
      `echo "[e2e-ensure] codex config key via ${envKey} env"\n`
  );
}

/**
 * ~/.config/claude-code-proxy/config.json 使用的 API key，结构面向 OpenAI 兼容后端。
 * 只接受 E2E_CLAUDE_PROXY_API_KEY；原生 claude CLI 不读取此文件，必须配合真实 claude-code-proxy 进程。
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveE2eClaudeProxyApiKey(env = process.env) {
  return env.E2E_CLAUDE_PROXY_API_KEY?.trim() || '';
}

/**
 * 在 headless/CI 环境跳过 Claude Code 交互式 onboarding。
 * 设置 E2E_WRITE_REMOTE_CLAUDE_ONBOARDING_SKIP=1 启用。
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function buildRemoteClaudeOnboardingSkipSh(env = process.env) {
  if (env.E2E_WRITE_REMOTE_CLAUDE_ONBOARDING_SKIP?.trim() !== '1') return '';
  const json = `${JSON.stringify({ hasCompletedOnboarding: true }, null, 2)}\n`;
  // base64 让 JSON 跨模板字符串和 SSH 时不受引号、换行影响；远端再解码为原文件。
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  return (
    `printf '%s' '${b64}' | base64 -d > "$HOME/.claude.json" && ` +
    `echo "[e2e-ensure] wrote ~/.claude.json (hasCompletedOnboarding)"\n`
  );
}

/**
 * 写入 ~/.config/claude-code-proxy/config.json；同时设置 E2E_WRITE_REMOTE_CLAUDE_PROXY_CONFIG=1 和 E2E_CLAUDE_PROXY_API_KEY 才会启用。
 * 对原生 claude + 百炼，应优先设置 E2E_CLAUDE_BAILIAN=1（…/apps/anthropic），不要只依赖此文件。
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function buildRemoteClaudeProxyConfigSh(env = process.env) {
  if (env.E2E_WRITE_REMOTE_CLAUDE_PROXY_CONFIG?.trim() !== '1') return '';
  const apiKey = resolveE2eClaudeProxyApiKey(env);
  if (!apiKey) {
    console.warn('[e2e] Claude proxy file: E2E_WRITE_REMOTE_CLAUDE_PROXY_CONFIG=1 but E2E_CLAUDE_PROXY_API_KEY is unset — skipping ~/.config/claude-code-proxy/config.json.');
    return '';
  }
  const baseURL =
    env.E2E_CLAUDE_PROXY_BASE_URL?.trim() ||
    'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const model = env.E2E_CLAUDE_PROXY_MODEL?.trim() || 'qwen3-coder-plus';
  const cfg = {
    // 此对象包含 secret，只编码后嵌入返回脚本；调用方不得把完整脚本文本写入日志。
    apiKey,
    baseURL,
    modelMapping: {
      model,
    },
  };
  const raw = `${JSON.stringify(cfg, null, 2)}\n`;
  const b64 = Buffer.from(raw, 'utf8').toString('base64');
  return (
    `mkdir -p "$HOME/.config/claude-code-proxy" && printf '%s' '${b64}' | base64 -d > "$HOME/.config/claude-code-proxy/config.json" && ` +
    `echo "[e2e-ensure] wrote ~/.config/claude-code-proxy/config.json"\n`
  );
}
