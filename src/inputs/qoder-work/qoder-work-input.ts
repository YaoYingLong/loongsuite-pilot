/**
 * Qoder Work / Qoder Work CN 的 Hook history JSONL 输入适配器。
 *
 * `assets/hooks/qoderwork-hook-processor.mjs` 把宿主 Hook 的 stdin 与 transcript 转成按日
 * JSONL，本类继承 `BaseHookInput` 按 byte offset 增量读取，再依次兼容 canonical event_t、
 * 旧 PostToolUse 文件事件和早期 transcript 行三种格式。输出统一为 `AgentActivityEntry[]`，
 * 由 `BaseInput` 发出 `entries`，随后进入 InputManager 的内容策略、脱敏和 MultiFlusher 链路。
 *
 * Orchestrator 会分别创建国际版和 CN 实例；对应 Trace Input 启用时，本 Input 被门控关闭，
 * 避免同一轮数据重复输出。它只持有最近版本字符串，不打开长期文件句柄；启动、轮询、停止和
 * StateStore 保存均由基类负责。读取/解析单行失败由基类隔离，Git enrich 失败由 enrich helper
 * 自身按约定处理。
 */
// 类型枚举决定标准事件中的 Agent 类型和文件动作类型。
import { ClientType, ActionType } from '../../types/index.js';
import type { AgentActivityEntry, AgentEventName, JsonValue } from '../../types/index.js';
// BaseHookInput 提供按日日志扫描、offset checkpoint、轮询和停止等待。
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
// entry-builder 把兼容输入规范化为统一字段；Git helper 根据 cwd 补仓库上下文。
import { buildAgentActivityEntry, toJsonValue } from '../../normalization/entry-builder.js';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';
// 文件工具只用于展开 home 路径和发现 Qoder Work 安装目录。
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
// canonical helper 识别 Hook processor 已经生成的标准 event_t 记录。
import { buildCanonicalHookEntry } from '../base/canonical-hook-record.js';

/** 构造 Qoder Work Hook Input 所需配置；除 stateStore 外均允许使用默认值。 */
export interface QoderWorkInputOptions extends Partial<HookInputOptions> {
  /** 全局 checkpoint 存储，由 Orchestrator 注入。 */
  stateStore: HookInputOptions['stateStore'];
  /** 产品变体；省略时为国际版 `qoder-work`。 */
  agentType?: ClientType;
}

/**
 * Qoder Work transcript JSONL 输入类。
 *
 * 解决的问题：不同版本的 Hook history 可能是已经规范化的 canonical 记录、PostToolUse 原始
 * payload，或带 `message.content` 的早期 transcript 行。本类用固定优先级逐级尝试，确保新格式
 * 不会再被旧解析器二次解释，同时保留升级期间的兼容能力。
 *
 * 调用位置：Orchestrator 注册后由 AgentDiscoveryService 根据 `~/.qoderwork` 可用性启动；
 * `BaseInput.start()` 先执行基类 onStart，再立即 collect，之后默认每 30 秒轮询。stop 会等待在途
 * Promise，不需要本类额外释放资源。
 *
 * 重要状态：`lastAgentVersion` 从记录中更新，仅供监控读取；offset 和日文件状态保存在 StateStore。
 * 国际版与 CN 共用本类，通过 `agentType/logDir/logPrefix` 参数隔离 ID、目录和输出类型。
 */
export class QoderWorkInput extends BaseHookInput {
  /** InputManager 和 listener 配置使用的唯一 ID，例如 `qoder-work-hook`。 */
  readonly id: string;
  /** 写入标准事件的 Agent 产品类型。 */
  readonly agentType: ClientType;
  /** 本进程观察到的最近非空版本；重启后重新从新记录学习。 */
  private lastAgentVersion = '';

  /**
   * 返回最近记录携带的 Qoder Work 版本，供状态/监控展示。
   * @returns 尚未采到版本时返回空字符串；本方法不访问文件系统。
   */
  getAgentVersion(): string {
    return this.lastAgentVersion;
  }

  /**
   * 计算变体对应的日志目录、前缀和 ID，并把通用生命周期参数交给基类。
   * @param opts Orchestrator 提供的 StateStore 与可选变体/目录/轮询配置。
   */
  constructor(opts: QoderWorkInputOptions) {
    // 未显式指定时保持国际版行为；CN 实例由 Orchestrator 传入 QoderWorkCN。
    const agentType = opts.agentType ?? ClientType.QoderWork;
    // 日文件名必须与对应 wrapper 写出的前缀一致，否则基类无法发现 JSONL。
    const logPrefix = opts.logPrefix ?? (agentType === ClientType.QoderWork ? 'qoder-work' : agentType);
    const defaultLogDir = agentType === ClientType.QoderWork
      ? '~/.loongsuite-pilot/logs/qoder-work/history'
      : `~/.loongsuite-pilot/logs/${agentType}/history`;
    super({
      stateStore: opts.stateStore,
      logDir: opts.logDir ?? resolveHome(defaultLogDir),
      logPrefix,
      pollIntervalMs: opts.pollIntervalMs ?? 30_000,
    });
    this.agentType = agentType;
    this.id = `${agentType}-hook`;
  }

  /**
   * 检查国际版 Qoder Work 配置目录是否存在。
   * @returns 目录存在时兑现为 true；CN 实例在 Orchestrator 中使用自定义 availability 闭包。
   */
  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.qoderwork'));
  }

  /**
   * 返回国际版发现服务监听目录；目录变化会触发重新检查 Input 生命周期。
   * @returns 展开 home 后的单元素路径数组。
   */
  static getWatchPaths(): string[] {
    return [resolveHome('~/.qoderwork')];
  }

  /**
   * 将一条已由 BaseHookInput JSON.parse 的记录转换为统一事件。
   *
   * 顺序为 canonical -> PostToolUse -> 早期 transcript。该方法会删除兼容字段 `version`，并可能
   * 更新 `lastAgentVersion`；成功记录还会异步补 Git 上下文。
   *
   * @param record 当前 JSONL 行解析出的可变对象。
   * @returns 标准事件；无关/不完整记录返回 null，由基类跳过。
   */
  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    // 新 processor 使用 namespaced 版本字段；只缓存非空字符串。
    const ver = record['agent.qoderwork.version'];
    if (typeof ver === 'string' && ver) this.lastAgentVersion = ver;
    // 顶层通用 version 是旧格式残留，删除后避免 entry-builder 错当业务属性输出。
    delete record['version'];

    // canonical 记录已经包含 event.name/gen_ai.*，优先直通，禁止后续重复映射。
    const canonicalEntry = buildCanonicalHookEntry(record, this.agentType);
    if (canonicalEntry) {
      await enrichCanonicalEntryWithGit(canonicalEntry as Record<string, unknown>, record, 'qoder-work');
      return canonicalEntry;
    }

    // 兼容只上报 PostToolUse 的旧 Hook：把文件写操作恢复为 Create/Edit 事件。
    const hookEntry = buildPostToolUseEntry(record, this.agentType);
    if (hookEntry) {
      await enrichCanonicalEntryWithGit(hookEntry as Record<string, unknown>, record, 'qoder-work');
      return hookEntry;
    }

    // 最后兼容早期 transcript 行；system/progress 等行没有直接业务事件，跳过。
    const rowType = record.type as string | undefined;
    if (rowType !== 'assistant' && rowType !== 'user') return null;

    const message = (typeof record.message === 'object' && record.message !== null
      ? record.message
      : {}) as Record<string, unknown>;
    const role = typeof message.role === 'string' && message.role.length > 0
      ? message.role
      : rowType;
    const messageContent = message.content;

    // 早期 QoderWork Hook 每行通常只写一个 content part；先声明所有可能提取的字段。
    let partType: string | undefined;
    let partText: string | undefined;
    let partThinking: string | undefined;
    let toolName: string | undefined;
    let toolCallId: string | undefined;
    let toolArgs: JsonValue | undefined;
    let toolUseId: string | undefined;
    let toolResult: JsonValue | undefined;

    if (typeof messageContent === 'string') {
      // 某些版本把纯文本直接放在 message.content，而不是 parts 数组。
      partType = 'text';
      partText = messageContent;
    } else {
      const contentList = Array.isArray(messageContent) ? messageContent : [];
      const content0 = (contentList[0] && typeof contentList[0] === 'object' && contentList[0] !== null
        ? contentList[0]
        : null) as Record<string, unknown> | null;
      // 空数组或缺少 type 无法判定事件语义，不能编造记录。
      if (!content0 || typeof content0.type !== 'string') return null;

      partType = content0.type;
      if (typeof content0.text === 'string') partText = content0.text;
      if (typeof content0.thinking === 'string') partThinking = content0.thinking;
      if (typeof content0.name === 'string') toolName = content0.name;
      if (typeof content0.id === 'string') toolCallId = content0.id;
      if (typeof content0.tool_use_id === 'string') toolUseId = content0.tool_use_id;
      toolArgs = toJsonValue(content0.input);
      toolResult = toJsonValue(content0.content);
    }

    // part 类型优先于 role：工具调用/结果即使角色异常，也必须进入 TOOL 事件分支。
    let eventName: AgentEventName;
    if (partType === 'tool_use') eventName = 'tool.call';
    else if (partType === 'tool_result') eventName = 'tool.result';
    else if (role === 'assistant') eventName = 'llm.response';
    else eventName = 'llm.request';

    // 无有效源时间时使用采集时刻，确保 entry-builder 总能生成纳秒时间戳。
    const timestamp = parseTimestamp(record.timestamp) ?? Date.now();
    const standard: Record<string, JsonValue | undefined> = {};

    // 各事件只填充与其语义匹配的标准字段，entry-builder 负责最终规范化。
    if (eventName === 'llm.request' && typeof partText === 'string') {
      standard['gen_ai.input.messages_delta'] = [
        { role: 'user', parts: [{ type: 'text', content: partText }] },
      ];
    } else if (eventName === 'llm.response') {
      const parts: JsonValue[] = [];
      if (partType === 'thinking' && typeof partThinking === 'string') {
        parts.push({ type: 'reasoning', content: partThinking });
      } else if (typeof partText === 'string') {
        parts.push({ type: 'text', content: partText });
      }
      if (parts.length > 0) {
        const msg: { [key: string]: JsonValue } = { role: 'assistant', parts };
        if (typeof message.stop_reason === 'string' && message.stop_reason.length > 0) {
          msg.finish_reason = message.stop_reason;
        }
        standard['gen_ai.output.messages'] = [msg];
      }
      if (typeof message.stop_reason === 'string' && message.stop_reason.length > 0) {
        standard['gen_ai.response.finish_reasons'] = [message.stop_reason];
      }
      if (typeof message.id === 'string' && message.id.length > 0) {
        standard['gen_ai.response.id'] = message.id;
      }
    } else if (eventName === 'tool.call') {
      if (toolName) standard['gen_ai.tool.name'] = toolName;
      if (toolCallId) standard['gen_ai.tool.call.id'] = toolCallId;
      if (toolArgs !== undefined) standard['gen_ai.tool.call.arguments'] = toolArgs;
    } else if (eventName === 'tool.result') {
      if (toolUseId) standard['gen_ai.tool.call.id'] = toolUseId;
      if (toolResult !== undefined) standard['gen_ai.tool.call.result'] = toolResult;
    }

    // 不属于跨 Agent 标准的源字段放入 attributes，最终会展平为 agent.qoder-work.*。
    const attributes: { [key: string]: JsonValue } = {};
    if (typeof record.cwd === 'string' && record.cwd.length > 0) attributes.cwd = record.cwd;
    if (typeof record.parentUuid === 'string' && record.parentUuid.length > 0) {
      attributes.parent_uuid = record.parentUuid;
    }
    if (typeof record.userType === 'string' && record.userType.length > 0) {
      attributes.user_type = record.userType;
    }
    if (typeof record.entrypoint === 'string' && record.entrypoint.length > 0) {
      attributes.entrypoint = record.entrypoint;
    }
    if (typeof rowType === 'string') attributes.row_type = rowType;

    // 为仍读取旧 agent._c* 命名的 Dashboard 保留兼容字段；全部消费者迁移到上方 gen_ai.* 后
    // 才能删除。这里有意重复一份信息，不是标准字段映射遗漏。
    if (partType !== undefined) attributes._ctype = partType;
    if (toolName) attributes._cname = toolName;
    if (toolArgs !== undefined) attributes._cinput = toolArgs;
    if (partText !== undefined) attributes._ctext = partText;
    if (toolResult !== undefined) attributes._ccontent = toolResult;
    if (partThinking !== undefined) attributes._cthinking = partThinking;
    if (toolCallId) attributes._cid = toolCallId;
    if (toolUseId) attributes._ctool_use_id = toolUseId;

    // session/user 字段兼容三种历史大小写；没有值时交给 InputManager 补 configured userId。
    const entry = buildAgentActivityEntry({
      ...standard,
      timestamp,
      'session.id': (record.session_id as string)
        ?? (record.sessionId as string)
        ?? (record.sessionid as string)
        ?? '',
      'user.id': (record.user_id as string) ?? (record.userId as string) ?? '',
      'agent.type': this.agentType,
      'event.name': eventName,
      attributes,
    });
    if (!entry) return null;

    // 上游 UUID 稳定时覆盖 builder 生成的随机 event.id，便于重读去重和来源追踪。
    const sourceUuid = record.uuid;
    if (typeof sourceUuid === 'string' && sourceUuid.trim().length > 0) {
      entry['event.id'] = sourceUuid;
      entry.uuid = sourceUuid;
    }
    await enrichCanonicalEntryWithGit(entry as Record<string, unknown>, record, 'qoder-work');
    return entry;
  }
}

/**
 * 把数字、数字字符串或 ISO 8601 时间统一解析为 entry-builder 接受的毫秒时间。
 * @param value 原始 timestamp 字段。
 * @returns 有限数字或可解析日期；其他值返回 undefined，由调用方决定回退值。
 */
function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;

  // 先尝试纯数字字符串，避免 Date.parse 对年份样式数字产生不同解释。
  const num = Number(value);
  if (Number.isFinite(num)) return num;

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * 兼容旧版 PostToolUse payload，把真实文件写入映射为 Create/Edit 活动。
 *
 * @param record Hook 原始对象；payload 可能位于 record.data，也可能直接平铺。
 * @param agentType 当前国际版或 CN 产品类型。
 * @returns 仅 PostToolUse 且可解析 file_path 时返回事件，否则返回 null。
 */
function buildPostToolUseEntry(
  record: Record<string, unknown>,
  agentType: ClientType,
): AgentActivityEntry | null {
  // 新旧 wrapper 对 payload 的包裹层不同，先得到统一 data 视图。
  const data = (record.data && typeof record.data === 'object' && !Array.isArray(record.data))
    ? record.data as Record<string, unknown>
    : record;
  const eventType = (data.event_type ?? data.hook_event_name ?? record.hookEvent) as string | undefined;
  if (eventType !== 'PostToolUse') return null;

  // tool_input 缺失时使用空对象，使后续属性读取保持安全。
  const toolInput = (data.tool_input && typeof data.tool_input === 'object' && !Array.isArray(data.tool_input))
    ? data.tool_input as Record<string, unknown>
    : {};
  const filePath = typeof toolInput.file_path === 'string'
    ? toolInput.file_path
    : typeof data.file_path === 'string'
      ? data.file_path
      : '';
  // 没有目标路径无法形成文件活动，宁可跳过也不输出含义不明的事件。
  if (!filePath) return null;

  return buildAgentActivityEntry({
    sessionId: (data.session_id as string) ?? '',
    userId: (data.user_id as string) ?? '',
    agentType,
    // pre-file 标记明确为 false 才判定新建；未知状态保守归为编辑。
    actionType: data.loongsuite_pilot_pre_file_exists === false ? ActionType.Create : ActionType.Edit,
    filePath,
    content: typeof toolInput.content === 'string'
      ? toolInput.content
      : typeof toolInput.new_string === 'string'
        ? toolInput.new_string
        : undefined,
    timestamp: parseTimestamp(data.timestamp) ?? Date.now(),
    extra: data,
  });
}
