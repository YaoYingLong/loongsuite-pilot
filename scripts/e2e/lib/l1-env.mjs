/**
 * L1 E2E 环境变量契约：用户只需提供 8 个变量，可选 `E2E_SLS_ENDPOINT` 后为 9 个；
 * 其余旧 SSH 时代开关在运行时使用固定默认值，降低本地测试配置复杂度。
 *
 * L1 是 CLI/headless 层。报告中 Qoder CLI 使用 `qoder-cli`，部署 ID 仍为 `qoder`，
 * 因为 CLI Hook 与桌面端共享 `agents.d/qoder.json`。本模块只校验/合并对象，不读写文件。
 */

const COMMON_REQUIRED = [
  'E2E_USER_ID',
  'E2E_CODEX_OPENAI_API_KEY',
  'E2E_ANTHROPIC_API_KEY',
  'E2E_QODER_PERSONAL_ACCESS_TOKEN',
  'E2E_SLS_PROJECT',
  'E2E_SLS_LOGSTORE',
  'E2E_SLS_ACCESS_KEY_ID',
  'E2E_SLS_ACCESS_KEY_SECRET',
];

export const L1_REQUIRED_BY_SCENARIO = {
  preflight: [],
  'install-smoke': COMMON_REQUIRED,
  uninstall: COMMON_REQUIRED,
  'expand-features': COMMON_REQUIRED,
};

export const L1_SCENARIOS = Object.keys(L1_REQUIRED_BY_SCENARIO);

/** 按场景检查必需 E2E 环境变量；未知场景或缺失值直接抛错阻止误运行。 */
export function assertL1Env(scenario, env) {
  const required = L1_REQUIRED_BY_SCENARIO[scenario];
  if (required === undefined) {
    throw new Error(
      `unknown scenario: ${scenario}. Available: ${L1_SCENARIOS.join(', ')}`,
    );
  }
  return required.filter(k => !env[k] || !String(env[k]).trim());
}

const DEFAULTS = {
  E2E_PROFILE: 'linux-8u',
  E2E_LOCAL_BUILD: '1',
  E2E_USE_MATRIX_PROBE: '1',
  E2E_WRITE_REMOTE_CODEX_CONFIG: '1',
  E2E_WRITE_REMOTE_CLAUDE_ONBOARDING_SKIP: '1',
  E2E_CLAUDE_BAILIAN: '1',
  E2E_CLAUDE_BAILIAN_BASE_URL: 'https://dashscope.aliyuncs.com/apps/anthropic',
  E2E_CLAUDE_BAILIAN_MODEL: 'qwen3-coder-plus',
  E2E_CODEX_MODEL_PROVIDER: 'Model_Studio_Coding_Plan',
  E2E_CODEX_MODEL: 'qwen3.6-plus',
  E2E_PROPAGATE_SLS_INSTALL: '1',
  E2E_JSONL_VALIDATE: '1',
  E2E_REQUIRED_DEPLOY_AGENTS: 'claude-code,codex,qoder,cursor,qwen-code-cli,opencode',
  // 排除 cursor-cli：headless cursor-agent -p 只触发 sessionStart/afterAgentThought/sessionEnd；
  // 它不触发 beforeSubmitPrompt/afterAgentResponse/stop，因此 Hook assembler 无法生成 JSONL turn 记录。
  E2E_REQUIRED_JSONL_AGENTS: 'claude-code,codex,qoder-cli,qwen-code-cli,opencode',
  E2E_SLS_ENDPOINT: 'cn-hangzhou.log.aliyuncs.com',
  E2E_EXPAND_MOCK_PORT_BASE: '19100',
};

/** 只为未设置变量写入 L1 固定默认值，并归一化兼容开关，保持用户显式值优先。 */
export function applyL1Defaults(env) {
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (!env[k] || !String(env[k]).trim()) env[k] = v;
  }
  if (
    (!env.E2E_CLAUDE_BAILIAN_API_KEY ||
      !String(env.E2E_CLAUDE_BAILIAN_API_KEY).trim()) &&
    env.E2E_ANTHROPIC_API_KEY
  ) {
    env.E2E_CLAUDE_BAILIAN_API_KEY = env.E2E_ANTHROPIC_API_KEY;
  }
}
