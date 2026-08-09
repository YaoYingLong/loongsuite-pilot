/**
 * Claude Code Hook JSONL 的具体 Input，也是当前 Claude 生产数据进入 Collector 的入口。
 *
 * Claude Code 与 Collector 运行在不同进程中，二者通过本地文件解耦，完整时序为：
 *
 * 1. `DeploymentManager/HookStrategy` 根据 `agents.d/claude-code.json` 把 Stop、SubagentStart、
 *    SubagentStop Hook 注册到 `~/.claude/settings.json`；
 * 2. Claude Code 触发 Hook wrapper，短生命周期 `claude-code-hook-processor.mjs` 在 Stop 时读取
 *    Claude transcript，并同步追加标准化记录到
 *    `<dataDir>/logs/claude-code/claude-code-YYYY-MM-DD.jsonl`；
 * 3. Orchestrator 已把本实例注册给 InputManager；日志目录可用后，AgentDiscoveryService 调用
 *    `start()`，BaseInput 会立即执行首轮 collect，之后默认每 30 秒再轮询；
 * 4. 本类继承的 `BaseHookInput.collect()` 按 byte offset 读取 JSONL 新增部分，并逐行调用
 *    `transformRecord()`；collect 返回非空数组后，`BaseInput.runCycleOnce()` 才执行
 *    `this.emit('entries', entries)`；
 * 5. InputManager 的监听器把批次接入 Promise 队列，随后执行上游 Trace 关联、内容策略、脱敏，
 *    最终调用 Flusher。Hook processor 本身不会直接调用 Input、InputManager 或 Flusher。
 *
 * 因此 `entries` 的直接触发者是 Collector 进程中的 BaseInput，而不是 Claude Stop Hook。Hook 写盘
 * 与 Collector 轮询是两个独立异步阶段；正常情况下会有一个轮询周期以内的采集延迟。BaseHookInput
 * 负责跨日文件选择、逐文件 offset、truncate 恢复和 StateStore 更新，本类只固定 Claude 的路径、
 * ClientType 及 canonical 字段转换参数。
 */

// ClientType 是运行时枚举，最终会写入事件的 gen_ai.agent.type。
import { ClientType } from '../../types/index.js';
// `import type` 仅供 TypeScript 校验，编译后的 JavaScript 不会产生运行时模块引用。
import type { AgentActivityEntry } from '../../types/index.js';
// BaseHookInput 提供 JSONL 文件选择、byte offset、逐行解析和 BaseInput 生命周期。
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
// 路径/目录工具同时兼容 Unix HOME 和 Windows USERPROFILE。
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
// 共享转换器把不同 Hook 版本的字段别名收敛到统一 AgentActivityEntry。
import { transformHookRecord } from '../base/hook-record-transform.js';

/**
 * 读取 `<dataDir>/logs/claude-code/claude-code-YYYY-MM-DD.jsonl` 的 Claude 专用 Input。
 * 生命周期由 AgentDiscoveryService 管理；本类不创建 Hook 子进程，也不监听 Claude transcript。
 */
export class ClaudeCodeLogInput extends BaseHookInput {
  /** InputManager、Discovery 和 StateStore 使用的采集器唯一 ID。 */
  readonly id = 'claude-code-log';
  /** 写入每条标准事件的 Claude Hook 客户端类型，不等同于 Input ID。 */
  readonly agentType = ClientType.ClaudeCliHook;

  /**
   * 保存 Claude 日志目录、文件名前缀和轮询周期。
   * @param opts 必须包含共享 StateStore；测试可覆盖 logDir/logPrefix/pollIntervalMs。生产路径由
   * Orchestrator 解析，通常是 `<dataDir>/logs/claude-code`，默认轮询周期为 30 秒。
   * 构造阶段只保存配置，不创建目录、timer 或事件监听器。
   */
  constructor(opts?: Partial<HookInputOptions> & { stateStore: HookInputOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      logDir: opts?.logDir ?? resolveHome('~/.loongsuite-pilot/logs/claude-code'),
      logPrefix: opts?.logPrefix ?? 'claude-code',
      pollIntervalMs: opts?.pollIntervalMs ?? 30_000,
    });
  }

  /**
   * 检查默认日志目录是否已经存在。
   * @returns 目录存在时为 true；单个按日 JSONL 尚未创建也不影响可用性。
   * @remarks 首次安装时目录可能要等第一个 Claude Stop Hook 写日志后才出现；Discovery 在此之前
   * 保持轮询，目录出现后才启动 Input 并立即采集首批记录。
   */
  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.loongsuite-pilot/logs/claude-code'));
  }

  /**
   * 返回发现服务尝试 `fs.watch` 的默认目录。
   * 路径尚不存在时 Discovery 会退化为定时可用性检查；这不是 JSONL 内容变化的实时消费 watcher。
   */
  static getWatchPaths(): string[] {
    return [resolveHome('~/.loongsuite-pilot/logs/claude-code')];
  }

  /**
   * 把 Hook processor 已写出的一行记录再次收敛为当前 `AgentActivityEntry` 契约。
   *
   * BaseHookInput 对每条新增 JSONL 调用本方法。共享转换器兼容历史字段别名、固定 Agent 类型、
   * 调用 EntryBuilder，并从 `agent.claude-code.*` 字段提取 cwd/workspace 做 Git enrich。
   *
   * @param record `JSON.parse()` 得到的单行普通对象；来源是 Hook processor 的日 JSONL。
   * @returns 标准事件；缺少 `event.name` 时返回 null，BaseHookInput 会跳过该行。
   * @throws 意外转换/Git enrich 异常向 BaseHookInput.collectFile 的逐行 catch 传播；该行被记录并
   * 跳过，后续 JSONL 行仍继续处理。
   */
  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    return transformHookRecord(record, ClientType.ClaudeCliHook, 'claude-code');
  }
}
