/**
 * 仅探测、不修改 Agent 配置的部署策略。
 *
 * 用于与另一 Agent 共享既有 Hook 的产品，例如 Qoder for JetBrains。`detect()` 仍按
 * Agent 声明判断安装状态，但 `needsDeploy()` 永远为 false，deploy/undeploy 都是成功
 * 的无操作，因此不会重复写 settings 或创建额外 Hook。
 */


import type {
  AgentDefinition,
  DeployResult,
  DeployStrategy,
  DeployedAgentRecord,
} from '../types/index.js';
import { detectAgent } from './detect-utils.js';

/**
 * 供共享既有 Hook 的 Agent 使用，例如 Qoder for JetBrains 共享 ~/.qoder/settings.json
 * 中的 Qoder Stop Hook。只有 detect 执行真实检查；deploy/undeploy 均不写文件。
 */
export class DetectionOnlyStrategy implements DeployStrategy {
  /** 复用通用路径/命令探测。 */
  async detect(def: AgentDefinition): Promise<boolean> {
    return detectAgent(def.detection);
  }

  /** 永远不需要部署。 */
  async needsDeploy(_def: AgentDefinition, _record?: DeployedAgentRecord): Promise<boolean> {
    return false;
  }

  /** 返回成功且 skipped 的无操作结果。 */
  async deploy(def: AgentDefinition): Promise<DeployResult> {
    return { success: true, agentId: def.id, deployMode: 'detection-only', skipped: true };
  }

  /** 无资源可卸载，因此直接返回 true。 */
  async undeploy(_def: AgentDefinition): Promise<boolean> {
    return true;
  }
}
