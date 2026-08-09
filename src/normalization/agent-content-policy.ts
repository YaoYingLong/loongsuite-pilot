/**
 * 按 Agent 配置删除消息与工具内容。
 *
 * InputManager 在脱敏之前调用本模块。`captureMessageContent=false` 表示内容根本不应进入任何
 * 输出，因此这里创建新 entry 并删除敏感字段；随后 mask 只处理仍被允许保留的内容。
 * 该开关只控制正文，不删除 session/turn、模型、token、Git 等用于统计和关联的元数据。
 */

import type {
  AgentActivityEntry,
  AgentConfig,
  AgentsConfig,
  JsonValue,
} from '../types/index.js';

/** canonical、兼容别名和已知 Agent 扩展中的内容字段。 */
const MESSAGE_CONTENT_FIELDS = new Set([
  'gen_ai.input.messages',
  'gen_ai.input.messages_delta',
  'gen_ai.output.messages',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'gen_ai.system_instructions',
  'gen_ai.tool.definitions',
  'input.messages',
  'input.messages_delta',
  'output.messages',
  'tool.arguments',
  'tool.result.payload',
  'content',
  'inlineDiffMessage',
  'agent.content',
  'agent.inline_diff_message',
]);

/** 旧 attributes 对象中需要同步删除的内容 key。 */
const MESSAGE_CONTENT_ATTRIBUTE_FIELDS = new Set([
  'content',
  'inlineDiffMessage',
  'agent.content',
  'agent.inline_diff_message',
]);

/** 未找到 Agent 专属配置时保持历史默认：允许采集内容。 */
const DEFAULT_CONFIG: AgentConfig = {
  captureMessageContent: true,
};

/** 多个 Input 类型复用公开 Agent 配置 key 的别名表。 */
const AGENT_TYPE_TO_CONFIG_KEY: Record<string, string> = {
  'qoder-cli': 'qoder',
  'qoder-cli-hook': 'qoder',
  'cursor-hook': 'cursor',
};

/**
 * 应用当前 Agent 的内容开关。
 *
 * @param entry 已归一化事件。
 * @param config `config.json -> agents` 的解析结果。
 * @returns 新的浅拷贝；关闭内容时还会复制并清理 attributes。浅拷贝只隔离顶层赋值，未被清理
 * 的嵌套对象仍可能与输入 entry 共享引用，下游应把标准事件视为只读。
 */
export function applyAgentContentPolicy(
  entry: AgentActivityEntry,
  config: AgentsConfig,
): AgentActivityEntry {
  // 策略解析只看 Agent 类型和配置，不读取内容本身，避免“先接触敏感值再决定”的额外处理。
  const agentConfig = resolveAgentConfig(entry, config);
  // 即使内容允许也返回浅拷贝，隔离后续顶层字段赋值；嵌套对象仍共享，不能原地修改。
  if (agentConfig.captureMessageContent) return { ...entry };

  const next: AgentActivityEntry = { ...entry };
  for (const field of MESSAGE_CONTENT_FIELDS) {
    delete next[field];
  }

  if (next.attributes && typeof next.attributes === 'object' && !Array.isArray(next.attributes)) {
    // attributes 只在需要时复制，删除内容但保留其他 Agent 元数据。
    const attributes = { ...next.attributes };
    for (const field of MESSAGE_CONTENT_ATTRIBUTE_FIELDS) {
      delete attributes[field];
    }
    next.attributes = attributes as { [key: string]: JsonValue };
  }

  return next;
}

/**
 * 按精确 agent type、公开别名、默认值的优先级解析策略。
 *
 * 精确配置可覆盖别名组；例如 qoder-cn 可与 qoder 使用不同开关。配置项缺失时使用允许内容的
 * 默认值，确保旧配置升级后行为与历史版本一致。
 */
function resolveAgentConfig(
  entry: AgentActivityEntry,
  config: AgentsConfig,
): AgentConfig {
  const agentType = entry['gen_ai.agent.type'] ?? entry['agent.type'];
  if (!agentType) return DEFAULT_CONFIG;
  return config[agentType]
    ?? config[AGENT_TYPE_TO_CONFIG_KEY[agentType] ?? '']
    ?? DEFAULT_CONFIG;
}
