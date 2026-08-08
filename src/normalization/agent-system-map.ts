/**
 * Agent 产品类型到 OpenTelemetry GenAI `gen_ai.agent.system` 的映射。
 *
 * 多个采集入口可能属于同一产品，例如 qoder-cli-hook 与 qoder；Trace Resource 使用这里的
 * 稳定 system 值聚合产品，未知新类型返回 `unknown`，不会凭字符串猜测。
 */

/** ClientType/标准 agent type 到产品系统名的显式映射。 */
export const AGENT_SYSTEM_MAP: Record<string, string> = {
  'claude-code': 'claude',
  'codex': 'codex',
  'codex-session': 'codex',
  'qoder': 'qoder',
  'qoder-idea': 'qoder',
  'qoder-work': 'qoder',
  'qoder-work-cn': 'qoder',
  'qoder-cli': 'qoder',
  'qoder-cli-hook': 'qoder',
  'cursor': 'cursor',
  'cursor-hook': 'cursor',
  'qwen-code-cli': 'qwen-code',
  'opencode': 'opencode',
  'pi-coding-agent': 'pi',
  'wukong': 'wukong',
};

/** @returns 对应产品系统名，未登记时为 `unknown`。 */
export function resolveAgentSystem(agentType: string): string {
  return AGENT_SYSTEM_MAP[agentType] ?? 'unknown';
}
