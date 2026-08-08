/** Qoder CLI Hook JSONL Input，解析 CLI canonical 记录并维护版本/历史消费状态。 */
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry, AgentEventName, JsonValue } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import {
  normalizeSourceContext,
  pickFirstValue,
  sourceFieldsFromContext,
} from '../../normalization/source-context.js';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { inferGitContext } from '../../utils/git-context.js';
import { buildCanonicalHookEntry } from '../base/canonical-hook-record.js';

const SOURCE = 'qoder-transcript-hook';
const IGNORED_ROW_TYPES = new Set(['ai-title', 'last-prompt', 'session_meta', 'progress']);
const UNKNOWN_MODEL = 'unknown';
type QoderVariant = 'qoder-cli' | 'qoder';

/**
 * 读取 Qoder/Qoder CLI Hook 追加 JSONL 的输入适配器。
 *
 * BaseHookInput 管理文件发现、字节 offset、轮转和坏行隔离。本类优先识别 canonical Hook schema，
 * 再兼容 PostToolUse 与历史 transcript 形状，并补充 Git/source context 后构建标准事件。
 */
export class QoderCliInput extends BaseHookInput {
  readonly id = 'qoder-cli-hook';
  readonly agentType = ClientType.QoderCli;
  private lastAgentVersion = '';

  /** 返回最近一条记录中观察到的 Qoder 版本，供 InputManager/状态输出展示。 */
  getAgentVersion(): string {
    return this.lastAgentVersion;
  }

  /** 配置 Hook history 目录、文件前缀和轮询间隔；构造阶段不读取日志。 */
  constructor(opts?: Partial<HookInputOptions> & { stateStore: HookInputOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      logDir: opts?.logDir ?? resolveHome('~/.loongsuite-pilot/logs/qoder/history'),
      logPrefix: opts?.logPrefix ?? 'qoder',
      pollIntervalMs: opts?.pollIntervalMs ?? 30_000,
    });
  }

  /** 通过 `~/.qoder` 是否存在判断本机是否可能安装了 Qoder。 */
  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.qoder'));
  }

  /** 返回发现服务应监听的 Qoder 用户目录。 */
  static getWatchPaths(): string[] {
    return [resolveHome('~/.qoder')];
  }

  /**
   * 将一条未知版本的 Qoder Hook/transcript record 转成标准事件。
   *
   * 处理优先级为 canonical -> PostToolUse -> assistant/user transcript；控制行和无法识别的内容返回
   * null。Git 推断涉及子进程调用，由 `inferGitContext()` 自身做缓存和失败降级。
   */
  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    // 版本号属于 Input 运行状态而非单条事件转换结果，后续状态页通过 getAgentVersion() 读取。
    const ver = record['agent.qoder.version'] ?? record.version;
    if (typeof ver === 'string' && ver) this.lastAgentVersion = ver;

    // 新 Hook 已输出统一 canonical schema，优先直通可避免再次猜测旧 transcript 字段。
    const canonicalEntry = buildCanonicalHookEntry(record, ClientType.QoderCli);
    if (canonicalEntry) {
      await enrichCanonicalEntryWithGit(canonicalEntry, record, 'qoder');
      return canonicalEntry;
    }

    // 部分 CLI 版本仍写 PostToolUse 专用结构，canonical 失败后再走该兼容分支。
    const hookEntry = await buildPostToolUseEntry(record);
    if (hookEntry) return hookEntry;

    // 剩余分支处理 Claude 风格的 assistant/user transcript；标题、进度等控制行没有业务事件。
    const rowType = record.type as string | undefined;
    if (!rowType || IGNORED_ROW_TYPES.has(rowType)) return null;
    if (rowType !== 'assistant' && rowType !== 'user') return null;

    // 一条 message 可能同时含 thinking/text/tool 块，只选择最能代表本事件语义的主块。
    const message = asRecord(record.message);
    const contentBlock = selectDominantContentBlock(message.content);
    if (!contentBlock) return null;

    // 旧日志目录可能混有 CLI 与 IDE 记录，variant 同时决定 agent.type 和 turn.id 处理方式。
    const variant = inferVariant(record);
    const eventName = inferEventName(rowType, contentBlock);
    const timestamp = parseTimestamp(record.timestamp) ?? Date.now();
    // 历史版本使用过多种 session 字段名，按明确优先级兼容读取，仍缺失时保留空串。
    const sessionId = getStringValue(record, 'sessionId')
      ?? getStringValue(record, 'session_id')
      ?? getStringValue(record, 'sessionid')
      ?? getStringValue(record, 'conversation_id')
      ?? '';
    const turnId = variant === 'qoder-cli' ? undefined : getStringValue(record, 'turn_id');
    const model = getStringValue(message, 'model') ?? UNKNOWN_MODEL;
    const toolResultPayload = buildToolResultPayload(record, contentBlock);
    const messageId = getStringValue(message, 'id');
    // sourceFields 可能触发一次有缓存的 Git 子进程探测，因此必须在 async transform 中 await。
    const sourceFields = await buildSourceFields(record);

    return buildAgentActivityEntry({
      ...sourceFields,
      timestamp,
      'event.id': getStringValue(record, 'uuid') ?? undefined,
      'event.name': eventName,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.agent.type': variant === 'qoder-cli' ? ClientType.QoderCli : ClientType.Qoder,
      'gen_ai.request.model': model,
      'gen_ai.response.model': model,
      'gen_ai.response.id': eventName === 'llm.response' ? messageId : undefined,
      'response.finish_reasons': getStringValue(message, 'stop_reason'),
      'gen_ai.input.messages_delta': eventName === 'llm.request'
        ? buildInputMessagesDelta(contentBlock)
        : undefined,
      'gen_ai.output.messages': eventName === 'llm.response'
        ? buildOutputMessages(contentBlock)
        : undefined,
      'gen_ai.tool.name': eventName === 'tool.call' ? getStringValue(contentBlock, 'name') : undefined,
      // call 与 result 使用相同 ID 字段，OTLP 转换时才能把两条事件闭合为一个工具 span。
      'gen_ai.tool.call.id': eventName === 'tool.call' || eventName === 'tool.result'
        ? getStringValue(contentBlock, 'id') ?? getStringValue(contentBlock, 'tool_use_id')
        : undefined,
      'gen_ai.tool.call.exec.id': eventName === 'tool.call' || eventName === 'tool.result'
        ? getStringValue(contentBlock, 'id') ?? getStringValue(contentBlock, 'tool_use_id')
        : undefined,
      'gen_ai.tool.call.arguments': eventName === 'tool.call'
        ? toJsonValue(contentBlock.input)
        : undefined,
      'gen_ai.tool.call.result': eventName === 'tool.result'
        ? toolResultPayload
        : undefined,
      'tool.result.status': eventName === 'tool.result'
        ? inferToolResultStatus(contentBlock)
        : undefined,
      attributes: buildAttributes(record, message, contentBlock, variant),
    });
  }
}

/** 兼容毫秒 number、数字字符串和日期字符串；无法解析时返回 undefined。 */
function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;

  const num = Number(value);
  if (Number.isFinite(num)) return num;

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * 识别 Qoder CLI 的 PostToolUse Hook，并构建成功的 tool.result；其他事件类型返回 null。
 */
async function buildPostToolUseEntry(record: Record<string, unknown>): Promise<AgentActivityEntry | null> {
  // 某些 wrapper 把 Hook payload 包在 data 中，另一些直接写顶层；这里统一展开为 data。
  const data = (record.data && typeof record.data === 'object' && !Array.isArray(record.data))
    ? record.data as Record<string, unknown>
    : record;
  const eventType = (data.event_type ?? data.hook_event_name ?? record.hookEvent) as string | undefined;
  if (eventType !== 'PostToolUse') return null;

  // tool_input 必须是普通对象；异常类型降级为空对象，避免读取属性时抛错。
  const toolInput = (data.tool_input && typeof data.tool_input === 'object' && !Array.isArray(data.tool_input))
    ? data.tool_input as Record<string, unknown>
    : {};
  // cwd/repo 等上下文优先从解包后的 Hook data 推断。
  const sourceFields = await buildSourceFields(data);

  return buildAgentActivityEntry({
    ...sourceFields,
    timestamp: parseTimestamp(data.timestamp) ?? Date.now(),
    'event.name': 'tool.result',
    'gen_ai.session.id': getStringValue(data, 'session_id') ?? '',
    'user.id': getStringValue(data, 'user_id') ?? '',
    'gen_ai.agent.type': ClientType.QoderCli,
    'gen_ai.request.model': UNKNOWN_MODEL,
    'gen_ai.response.model': UNKNOWN_MODEL,
    'gen_ai.tool.name': getStringValue(data, 'tool_name'),
    'gen_ai.tool.call.id': getStringValue(data, 'tool_use_id'),
    'gen_ai.tool.call.exec.id': getStringValue(data, 'tool_use_id'),
    'gen_ai.tool.call.arguments': toJsonValue(toolInput),
    'gen_ai.tool.call.result': toJsonValue({
      file_path: getStringValue(toolInput, 'file_path') ?? getStringValue(data, 'file_path'),
      content: toolInput.content ?? toolInput.new_string,
    }),
    'tool.result.status': 'success',
    attributes: toJsonObject({
      source: SOURCE,
      qoder_variant: 'qoder-cli',
      raw_type: eventType,
      cwd: data.cwd,
      loongsuite_pilot_pre_file_exists: data.loongsuite_pilot_pre_file_exists,
      file_path: getStringValue(toolInput, 'file_path') ?? getStringValue(data, 'file_path'),
    }),
  });
}

/** 依据 CLI 专有字段判断记录来自 Qoder CLI 还是 IDE 兼容格式。 */
function inferVariant(record: Record<string, unknown>): QoderVariant {
  if (
    getStringValue(record, 'entrypoint') === 'cli' ||
    record.promptId !== undefined ||
    record.permissionMode !== undefined ||
    record.userType !== undefined
  ) {
    return 'qoder-cli';
  }
  return 'qoder';
}

/** 将 transcript 行角色和主内容块类型映射为四种 GenAI 事件名。 */
function inferEventName(rowType: string, content: Record<string, unknown>): AgentEventName {
  const contentType = getStringValue(content, 'type');
  if (contentType === 'tool_result') return 'tool.result';
  if (contentType === 'tool_use') return 'tool.call';
  if (rowType === 'assistant') return 'llm.response';
  return 'llm.request';
}

/**
 * 从 message.content 选择本条事件最有语义的块，优先级为 tool_result、tool_use、text、thinking。
 * 字符串内容会先包装成 text 块；没有可识别对象时返回 null。
 */
function selectDominantContentBlock(rawContent: unknown): Record<string, unknown> | null {
  if (typeof rawContent === 'string') return { type: 'text', text: rawContent };
  const blocks = Array.isArray(rawContent)
    ? rawContent
        .filter((block): block is Record<string, unknown> => (
          !!block && typeof block === 'object' && !Array.isArray(block)
        ))
    : [];
  return blocks.find(block => block.type === 'tool_result')
    ?? blocks.find(block => block.type === 'tool_use')
    ?? blocks.find(block => block.type === 'text')
    ?? blocks.find(block => block.type === 'thinking')
    ?? null;
}

/** 把用户文本包装为本次 llm.request 的增量消息。 */
function buildInputMessagesDelta(content: Record<string, unknown>): JsonValue | undefined {
  const text = getStringValue(content, 'text') ?? getStringValue(content, 'content');
  if (!text) return undefined;
  return [{ role: 'user', content: text }];
}

/** 把 assistant 文本或 thinking 内容映射为 text/reasoning 输出 part。 */
function buildOutputMessages(content: Record<string, unknown>): JsonValue | undefined {
  const contentType = getStringValue(content, 'type');
  const text = getStringValue(content, 'text')
    ?? getStringValue(content, 'thinking')
    ?? getStringValue(content, 'content');
  if (!text) return undefined;
  return [{
    type: contentType === 'thinking' ? 'reasoning' : 'text',
    content: text,
  }];
}

/** 从顶层 toolUseResult 或内容块 content 中提取 JSON 兼容的工具结果。 */
function buildToolResultPayload(
  record: Record<string, unknown>,
  content: Record<string, unknown>,
): JsonValue | undefined {
  const raw = record.toolUseResult ?? content.content;
  return toJsonValue(raw);
}

/** 仅在源记录明确提供 is_error 布尔值时输出 success/failure。 */
function inferToolResultStatus(content: Record<string, unknown>): string | undefined {
  const isError = getBooleanValue(content, 'is_error');
  if (isError === true) return 'failure';
  if (isError === false) return 'success';
  return undefined;
}

/** 收集仍有诊断价值但不属于统一 schema 顶层字段的 Qoder 原始属性。 */
function buildAttributes(
  record: Record<string, unknown>,
  message: Record<string, unknown>,
  content: Record<string, unknown>,
  variant: QoderVariant,
): { [key: string]: JsonValue } {
  return toJsonObject({
    source: SOURCE,
    qoder_variant: variant,
    raw_type: record.type,
    content_type: content.type,
    cwd: record.cwd,
    entrypoint: record.entrypoint,
    permissionMode: record.permissionMode,
    userType: record.userType,
    parentUuid: record.parentUuid,
    promptId: record.promptId,
    sourceToolAssistantUUID: record.sourceToolAssistantUUID,
    isSidechain: record.isSidechain,
    version: record.version,
    message_id: message.id,
    message_type: message.type,
  });
}

/**
 * 归一化记录中不同命名的 repo/branch/domain/workspace 字段；缺项时按 cwd 调用 Git 探测补齐。
 */
async function buildSourceFields(
  record: Record<string, unknown>,
): Promise<Record<string, JsonValue>> {
  const context = normalizeSourceContext({
    repo: pickFirstValue(
      record['git.repo'],
      record.repo,
      record.repository,
      record.repo_path,
      record.repository_path,
      record.project_path,
    ),
    branch: pickFirstValue(
      record['git.branch'],
      record.branch,
      record.git_branch,
      record.current_branch,
      record.currentBranch,
    ),
    domain: pickFirstValue(
      record['git.domain'],
      record.domain,
    ),
    cwd: record.cwd,
    workspaceRoots: record.workspace_roots,
  });

  let inferredRoot: string | undefined;
  if (!context.repo || !context.branch || !context.domain) {
    const gitProbeDir = pickFirstValue(record.cwd, context.currentRoot);
    if (typeof gitProbeDir === 'string' && gitProbeDir.trim().length > 0) {
      const inferred = await inferGitContext(gitProbeDir);
      if (!context.repo && inferred.repo) context.repo = inferred.repo;
      if (!context.branch && inferred.branch) context.branch = inferred.branch;
      if (!context.domain && inferred.domain) context.domain = inferred.domain;
      inferredRoot = inferred.root;
    }
  }

  if (!context.currentRoot && inferredRoot) {
    context.currentRoot = inferredRoot;
  }

  const fields = sourceFieldsFromContext(context);
  if (inferredRoot) {
    fields['git.repo_root'] = inferredRoot;
  }
  return fields;
}


/** 从不可信对象读取非空字符串字段。 */
function getStringValue(data: Record<string, unknown>, key: string): string | undefined {
  const val = data[key];
  return typeof val === 'string' && val.length > 0 ? val : undefined;
}

/** 从不可信对象读取严格布尔字段，不把字符串 true/false 强制转换。 */
function getBooleanValue(data: Record<string, unknown>, key: string): boolean | undefined {
  const val = data[key];
  return typeof val === 'boolean' ? val : undefined;
}

/** 把普通对象原样返回，其余值转换为空对象以简化兼容解析。 */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** 递归过滤 undefined 等 JSON 不可表示值，生成可序列化对象。 */
function toJsonObject(value: Record<string, unknown>): { [key: string]: JsonValue } {
  const out: { [key: string]: JsonValue } = {};
  for (const [key, raw] of Object.entries(value)) {
    const json = toJsonValue(raw);
    if (json !== undefined) out[key] = json;
  }
  return out;
}

/** 将未知值递归转换成 JsonValue；函数等非常规值最后退化为字符串。 */
function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map(item => toJsonValue(item))
      .filter((item): item is JsonValue => item !== undefined);
  }
  if (typeof value === 'object') return toJsonObject(value as Record<string, unknown>);
  return String(value);
}
