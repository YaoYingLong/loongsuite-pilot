/**
 * Agent 运行时准入配置管理器。
 *
 * `Orchestrator` 从 `<dataDir>/agent-control.json` 加载 on/off/auto，再由每个发现条目的
 * enabled 回调与 `config.agents.<id>.enabled`、数据源可用性共同决定是否启动 Input。
 * 本模块只管理准入状态，不负责发现 Agent、部署 Hook 或启动采集器；`save()` 的文件
 * 写入错误会作为 rejected Promise 交给调用者处理。
 */

// 类型导入在编译后会被擦除；磁盘 JSON 的真实值仍必须由运行时代码自行防御。
import type { AgentControlConfig, AgentControlMode } from '../types/index.js';
// fs-utils 统一处理 HOME 展开和 JSON 原子写入，避免各模块自行拼临时文件。
import { readJsonFile, writeJsonFile, resolveHome } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

/** 独立使用本类时采用的默认准入文件；Orchestrator 通常会显式传入 dataDir 下的路径。 */
const DEFAULT_AGENT_CONTROL_PATH = '~/.loongsuite-pilot/agent-control.json';
const logger = createLogger('AgentControlManager');

/**
 * Agent 准入的三态控制器。
 *
 * 模式优先级：
 *   "on"  -> 在其余条件允许创建数据源时强制开启
 *   "off" -> 强制关闭
 *   "auto"（默认）-> 使用配置默认值和 isAvailable 结果
 */
export class AgentControlManager {
  /**
   * 进程内配置快照；version 供磁盘格式演进，tools 保存 Agent ID 到三态模式映射。
   * 构造时所有未出现的 Agent 都通过 getMode() 隐式得到 auto。
   */
  private config: AgentControlConfig = { version: 3, tools: {} };
  /** load/save 共用的绝对或调用方指定路径。 */
  private readonly filePath: string;

  /** @param filePath 可选准入文件路径；省略时展开用户目录下的默认路径。 */
  constructor(filePath?: string) {
    // Orchestrator 会传入 dataDir 下的路径；默认值主要供独立使用和单元测试外的库调用。
    this.filePath = filePath ?? resolveHome(DEFAULT_AGENT_CONTROL_PATH);
  }

  /**
   * 从 JSON 恢复 tools 映射；文件缺失或 tools 不是对象时保留默认 auto 配置。
   * 当前只做浅层结构判断，不逐项校验 on/off/auto；非法磁盘值最终会被 resolveEnabled
   * 当作 auto 处理，但 getMode 的静态返回类型无法反映这一运行时输入（待确认）。
   */
  async load(): Promise<void> {
    // readJsonFile 对文件不存在和 JSON 解析错误返回 null，不会让 Collector 因可选准入文件失败。
    const data = await readJsonFile<AgentControlConfig>(this.filePath);
    if (data && typeof data.tools === 'object') {
      this.config = { version: data.version ?? 3, tools: data.tools };
    }
    logger.info('loaded agent-control config', {
      tools: Object.keys(this.config.tools).length,
    });
  }

  /**
   * 将当前完整配置原子写盘；不会自动重新加载或通知 AgentDiscoveryService。
   * @returns 临时文件写入并 rename 为正式文件后兑现。
   * @throws 目录创建、写文件或 rename 失败时原样向调用者传播。
   */
  async save(): Promise<void> {
    await writeJsonFile(this.filePath, this.config);
  }

  /**
   * 解析 Agent 是否通过本层准入。
   *
   * @param agentId 稳定 Agent ID，例如 qoder、cursor。
   * @param defaultWhenAuto auto 模式时由上层配置/默认值给出的结果。
   * @returns on 为 true、off 为 false、auto 为 `defaultWhenAuto`。
   * @remarks 该方法只读内存快照，不执行 Agent 路径探测，也不读取 config.json。
   */
  resolveEnabled(agentId: string, defaultWhenAuto = true): boolean {
    const mode = this.getMode(agentId);
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    return defaultWhenAuto;
  }

  /**
   * 返回显式模式；未配置 Agent 一律视为 auto。该方法不读磁盘。
   * @returns 当前进程内的三态值；磁盘非法字符串在运行时可能穿透类型断言（待确认）。
   */
  getMode(agentId: string): AgentControlMode {
    return this.config.tools[agentId] ?? 'auto';
  }

  /**
   * 只修改内存中的模式；需要调用 save() 才会持久化，也不会自动触发发现服务刷新。
   * @param agentId 要覆盖的稳定 Agent ID。
   * @param mode 新的 on/off/auto 模式。
   */
  setMode(agentId: string, mode: AgentControlMode): void {
    this.config.tools[agentId] = mode;
  }

  /**
   * 返回 tools 映射的浅拷贝，避免调用方增删键时直接改内部状态。值是字符串，无深拷贝需求。
   * @returns 当前全部显式配置；未出现的隐式 auto Agent 不会被补入。
   */
  getAllModes(): Record<string, AgentControlMode> {
    return { ...this.config.tools };
  }
}
