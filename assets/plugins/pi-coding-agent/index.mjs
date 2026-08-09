/**
 * LoongSuite Pilot 的 Pi Coding Agent Extension。
 *
 * `PluginInjectStrategy` 把本文件路径注入 Pi 配置；默认导出函数收到 Pi Extension API 后，
 * 在 Pi 进程内注册 session/agent/turn/context/message/tool 生命周期监听器，将事件转换为
 * `logs/pi-coding-agent/pi-coding-agent-YYYY-MM-DD.jsonl`。`PiCodingAgentLogInput` 随后读取
 * 这些标准 GenAI 记录。
 *
 * state 与监听器和宿主进程同生命周期：session_start/before_agent_start 重置 trace/turn，
 * turn_start 建 step，context 输出 user + llm.request，message_end 输出 response，工具开始/结束
 * 配对并计算时长，session_shutdown 清理暂存 Map。内容遵循 captureMessageContent。
 *
 * 插件刻意零依赖、fail-open。序列化限制深度/数组/键/字符串长度并处理循环引用；目录/文件在
 * POSIX 分别收紧到 0700/0600。任何遥测异常由 safeHandler 捕获，不能中断 Agent turn 或工具。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_TYPE = 'pi-coding-agent';
const MAX_STRING_LENGTH = 64 * 1024;
const MAX_MESSAGES = 40;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_DEPTH = 8;

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
// 安装后布局为 `$PILOT_DATA/plugins/pi-coding-agent/index.mjs`，向上两级即数据目录。
const installedDataDir = path.resolve(pluginDir, '..', '..');

/** 优先采用安装器注入的数据目录；缺少环境变量时按插件实际安装位置反推。 */
function resolveDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || installedDataDir;
}

function resolveLogDir() {
  return path.join(resolveDataDir(), 'logs', AGENT_TYPE);
}

/** 使用本地日期而非 UTC 日期分卷，和 Collector 按本地“今天”扫描日志的规则一致。 */
function todayStamp() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

/** 把宿主时间收敛为整数毫秒；NaN/Infinity 会回退到插件实际观察时间。 */
function timestampMillis(timestamp = Date.now()) {
  return Number.isFinite(timestamp) ? Math.trunc(timestamp) : Date.now();
}

/** 纳秒时间用字符串承载，避免超过 JavaScript Number 的 53 位安全整数范围。 */
function timestampNanos(timestamp = Date.now()) {
  const millis = timestampMillis(timestamp);
  return String(BigInt(millis) * 1_000_000n);
}

function timestampStrictlyAfter(timestamp, startedAt) {
  const millis = timestampMillis(timestamp);
  // 下游 OTel converter 以毫秒消费数字时间；只加 1ns 会被截断回零时长，因此至少加 1ms。
  return Number.isFinite(startedAt) ? Math.max(millis, Math.trunc(startedAt) + 1) : millis;
}

function traceId() {
  return crypto.randomBytes(16).toString('hex');
}

function spanId() {
  return crypto.randomBytes(8).toString('hex');
}

function truncate(value, max = MAX_STRING_LENGTH) {
  if (typeof value !== 'string' || value.length <= max) return value;
  return `${value.slice(0, max)}...[truncated]`;
}

/**
 * 把宿主对象裁剪成可 JSON 序列化的有限结构。
 *
 * Pi 事件可能含函数、BigInt、循环引用或很深的工具参数；直接 JSON.stringify 会抛错或生成
 * 巨型日志。本递归转换限制深度、键数、数组长度和字符串长度，同时在离开对象时移除 seen，
 * 因而“两个字段引用同一对象”不会被误判为环，只有当前递归路径上的回边才标记 Circular。
 */
function toSerializable(value, depth = 0, seen = new WeakSet()) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (depth >= MAX_DEPTH) return '[Max depth]';

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map(item => toSerializable(item, depth + 1, seen))
      .filter(item => item !== undefined);
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out = {};
    for (const [key, nested] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      const serializable = toSerializable(nested, depth + 1, seen);
      if (serializable !== undefined) out[key] = serializable;
    }
    seen.delete(value);
    return out;
  }

  return String(value);
}

function safeStringify(value) {
  return JSON.stringify(toSerializable(value));
}

let logDirReady = false;

/** 首次写入时创建目录；成功后用进程内布尔值省掉每条事件一次 stat/mkdir。 */
function ensureLogDir() {
  if (logDirReady) return;
  const dir = resolveLogDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  logDirReady = true;
}

/**
 * 同步追加一段 UTF-8 文本并保证文件权限。
 * 同步 I/O 会短暂占用 Pi 的 JavaScript 线程，但单条记录已受大小限制，且可确保 Hook 返回前数据落盘。
 * 若目录被外部清理，ENOENT 分支会清除缓存并重建一次；其他错误交给 safeHandler 记录后吞掉。
 */
function appendLogFile(fileName, content) {
  const filePath = path.join(resolveLogDir(), fileName);
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      ensureLogDir();
      fd = fs.openSync(filePath, 'a', 0o600);
      // open 的 mode 只在创建时生效；每次 append 前对真实 fd 再 chmod，防止日志轮转后权限变宽。
      if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, content, { encoding: 'utf8' });
      return;
    } catch (error) {
      if (attempt === 0 && error?.code === 'ENOENT') {
        logDirReady = false;
        continue;
      }
      throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}

function writeError(source, error) {
  try {
    appendLogFile(
      `${AGENT_TYPE}-error-${todayStamp()}.log`,
      `${new Date().toISOString()} [${source}] ${error?.stack || error}\n`,
    );
  } catch {
    // 遥测错误有意忽略，不能反向影响 Pi。
  }
}

function writeRecord(record) {
  try {
    appendLogFile(`${AGENT_TYPE}-${todayStamp()}.jsonl`, `${safeStringify(record)}\n`);
  } catch (error) {
    writeError('writeRecord', error);
  }
}

/**
 * 给 Pi 的异步监听器增加统一异常边界。
 * `await` 会捕获同步异常和 Promise rejection；包装器自身不再抛出，从而保持遥测 fail-open。
 */
function safeHandler(name, handler) {
  return async (event, ctx) => {
    try {
      await handler(event, ctx);
    } catch (error) {
      writeError(name, error);
    }
  };
}

/** 每次 session/agent 开始时重新读配置，使用户无需重启 Pi 也能更新 userId/内容采集开关。 */
function loadPilotConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(resolveDataDir(), 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function resolveUserId(config) {
  return process.env.LOONGSUITE_PILOT_USER_ID
    || process.env.LOONGSUITE_USER_ID
    || config.userId
    || config['user.id']
    || os.hostname()
    || 'unknown';
}

function shouldCaptureContent(config) {
  const value = config.agents?.[AGENT_TYPE]?.captureMessageContent;
  if (typeof value === 'string') return value.trim().toLowerCase() !== 'false';
  return value !== false;
}

function normalizeProvider(provider) {
  if (typeof provider !== 'string' || provider.length === 0) return 'unknown';
  const value = provider.toLowerCase();
  if (value.includes('anthropic')) return 'anthropic';
  if (value.includes('openai')) return 'openai';
  if (value.includes('google') || value.includes('gemini')) return 'gcp.gemini';
  if (value.includes('bedrock')) return 'aws.bedrock';
  if (value.includes('azure')) return 'azure.ai.openai';
  if (value.includes('qwen') || value.includes('dashscope')) return 'qwen';
  if (value.includes('deepseek')) return 'deepseek';
  return provider;
}

function normalizeFinishReason(reason) {
  if (reason === 'toolUse') return 'tool_call';
  if (reason === 'aborted') return 'cancelled';
  return reason || 'stop';
}

/** 把 Pi 自有 content block 转成统一 message parts；图片只保留类型信息，不复制二进制正文。 */
function contentParts(content) {
  if (typeof content === 'string') {
    return [{ type: 'text', content: truncate(content) }];
  }
  if (!Array.isArray(content)) return [];

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      parts.push({ type: 'text', content: truncate(block.text || '') });
    } else if (block.type === 'thinking') {
      parts.push({ type: 'reasoning', content: truncate(block.thinking || '') });
    } else if (block.type === 'toolCall') {
      parts.push({
        type: 'tool_call',
        id: block.id || null,
        name: block.name || 'unknown',
        arguments: toSerializable(block.arguments),
      });
    } else if (block.type === 'image') {
      parts.push({
        type: 'image',
        mime_type: block.mimeType || 'application/octet-stream',
        modality: 'image',
      });
    }
  }
  return parts;
}

function toolResultResponse(content) {
  if (typeof content === 'string') return truncate(content);
  const parts = contentParts(content);
  if (parts.every(part => part.type === 'text')) {
    return truncate(parts.map(part => part.content).join('\n'));
  }
  return truncate(safeStringify(parts));
}

/**
 * 将 Pi 的 user/assistant/toolResult/custom/bashExecution 角色映射为统一消息结构。
 * 返回 null 表示该角色没有可靠映射，调用方随后过滤；函数不修改宿主 message。
 */
function canonicalMessage(message) {
  if (!message || typeof message !== 'object') return null;

  if (message.role === 'toolResult') {
    return {
      role: 'tool',
      parts: [{
        type: 'tool_call_response',
        id: message.toolCallId || null,
        response: toolResultResponse(message.content),
        name: message.toolName || 'unknown',
        is_error: message.isError === true,
      }],
    };
  }

  if (message.role === 'assistant' || message.role === 'user') {
    return { role: message.role, parts: contentParts(message.content) };
  }

  if (message.role === 'custom') {
    return { role: 'user', parts: contentParts(message.content) };
  }

  if (message.role === 'bashExecution') {
    return {
      role: 'tool',
      parts: [{
        type: 'tool_call_response',
        id: null,
        response: truncate(message.output || ''),
        name: 'bash',
        is_error: typeof message.exitCode === 'number' && message.exitCode !== 0,
      }],
    };
  }

  return null;
}

/** 只保留最近 MAX_MESSAGES 条上下文，限制 llm.request 单条 JSONL 的体积。 */
function canonicalMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .slice(-MAX_MESSAGES)
    .map(canonicalMessage)
    .filter(Boolean);
}

function canonicalOutputMessage(message) {
  const canonical = canonicalMessage(message);
  if (!canonical) return undefined;
  return [{
    ...canonical,
    role: 'assistant',
    finish_reason: normalizeFinishReason(message.stopReason),
  }];
}

/** 仅上报当前启用的工具定义，避免把安装但不可供本轮模型调用的工具误记为请求上下文。 */
function activeToolDefinitions(pi) {
  const active = new Set(pi.getActiveTools());
  return pi.getAllTools()
    .filter(tool => active.has(tool.name))
    .map(tool => ({
      type: 'function',
      name: tool.name,
      description: truncate(tool.description || '', 8 * 1024),
      parameters: toSerializable(tool.parameters),
    }));
}

/**
 * 构造同一 turn 内所有事件共享的身份字段，并在缺失时惰性创建 traceId/turnId。
 * state 会被原地补齐，因此后续 request/response/tool 记录能够关联到相同 trace 与 turn。
 */
function turnFields(ctx, state, timestamp = Date.now()) {
  const sessionId = ctx.sessionManager.getSessionId();
  const eventTime = timestampMillis(timestamp);
  const observedTime = Math.max(Date.now(), eventTime);
  state.traceId ||= traceId();
  state.turnId ||= crypto.randomUUID();
  return {
    time_unix_nano: timestampNanos(eventTime),
    observed_time_unix_nano: timestampNanos(observedTime),
    'event.id': crypto.randomUUID(),
    trace_id: state.traceId,
    span_id: spanId(),
    'user.id': state.userId,
    'gen_ai.session.id': sessionId,
    'gen_ai.turn.id': state.turnId,
    'gen_ai.agent.type': AGENT_TYPE,
    'gen_ai.agent.name': 'Pi Coding Agent',
    [`agent.${AGENT_TYPE}.cwd`]: ctx.cwd,
  };
}

/** 在 turn 公共字段上补 step 与模型信息；stepId 在 turn_start 未到达时也有防御性默认值。 */
function commonFields(ctx, state, timestamp = Date.now()) {
  const model = ctx.model;
  state.turnId ||= crypto.randomUUID();
  state.stepId ||= `${state.turnId}:s1`;
  return {
    ...turnFields(ctx, state, timestamp),
    'gen_ai.step.id': state.stepId,
    'gen_ai.provider.name': normalizeProvider(model?.provider),
    'gen_ai.request.model': model?.id || 'unknown',
  };
}

function promptInputMessages(event) {
  const content = [];
  if (typeof event?.prompt === 'string' && event.prompt.length > 0) {
    content.push({ type: 'text', text: event.prompt });
  }
  if (Array.isArray(event?.images)) content.push(...event.images);
  const message = canonicalMessage({ role: 'user', content });
  return message?.parts?.length > 0 ? [message] : [];
}

function trailingUserInputMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  const recent = messages.slice(-MAX_MESSAGES);
  for (let index = recent.length - 1; index >= 0; index--) {
    const message = recent[index];
    if (message?.role !== 'user' && message?.role !== 'custom') break;
    const canonical = canonicalMessage(message);
    if (canonical?.parts?.length > 0) out.unshift(canonical);
  }
  return out;
}

/**
 * 注册 LoongSuite Pilot 的全部 Pi 生命周期监听器。
 * @param {object} pi Pi Coding Agent 提供的 Extension API，需支持 `on()` 和工具查询方法。
 * @returns {void} 监听器随 Pi session 生命周期运行，由宿主负责调度。
 */
export default function loongSuitePilotPiCodingAgent(pi) {
  // 这是插件唯一的可变全局状态，闭包与本次 Pi Extension 实例同生命周期。
  // requestEmitted/userInputEmitted 防止同一 step 的重复 context 回调产生重复记录；
  // toolStarts 按 toolCallId 保存开始时刻，供 tool_execution_end 计算成对时长。
  const state = {
    userId: 'unknown',
    captureContent: true,
    traceId: null,
    turnId: null,
    stepId: null,
    stepStartedAt: 0,
    requestEmitted: false,
    requestStartedAt: 0,
    systemPrompt: null,
    pendingUserInput: [],
    userInputEmitted: false,
    toolStarts: new Map(),
  };

  // 只刷新可配置字段，不在这里重置 turn；调用它的生命周期回调各自负责自己的状态边界。
  const resetSessionConfig = () => {
    const config = loadPilotConfig();
    state.userId = resolveUserId(config);
    state.captureContent = shouldCaptureContent(config);
  };

  // session_start 可能先于任何模型调用：清除上一个 session 遗留的 ID 和未完成工具。
  pi.on('session_start', safeHandler('session_start', async () => {
    resetSessionConfig();
    state.traceId = null;
    state.turnId = null;
    state.stepId = null;
    state.stepStartedAt = 0;
    state.requestEmitted = false;
    state.requestStartedAt = 0;
    state.pendingUserInput = [];
    state.userInputEmitted = false;
    state.toolStarts.clear();
  }));

  // before_agent_start 对应一次新的用户请求/Agent 运行，也是新 trace 与 turn 的真实起点。
  pi.on('before_agent_start', safeHandler('before_agent_start', async (event) => {
    resetSessionConfig();
    state.traceId = traceId();
    state.turnId = crypto.randomUUID();
    state.stepId = null;
    state.stepStartedAt = 0;
    state.requestEmitted = false;
    state.requestStartedAt = 0;
    state.systemPrompt = event.systemPrompt;
    state.pendingUserInput = promptInputMessages(event);
    state.userInputEmitted = false;
    state.toolStarts.clear();
  }));

  // 一个 Agent 运行中可以有多个模型 step；turnIndex 用于生成稳定、可读的 step 序号。
  pi.on('turn_start', safeHandler('turn_start', async (event) => {
    state.turnId ||= crypto.randomUUID();
    state.stepId = `${state.turnId}:s${event.turnIndex + 1}`;
    state.stepStartedAt = timestampMillis(event.timestamp);
    state.requestEmitted = false;
    state.requestStartedAt = 0;
    state.userInputEmitted = false;
  }));

  // context 可能重复触发，因此“判断 -> 标记 -> 写入”由同一同步函数完成，防止单线程内重复发射。
  const emitUserInput = (event, ctx) => {
    if (state.userInputEmitted || !state.captureContent) return;
    const messages = trailingUserInputMessages(event.messages);
    const inputDelta = messages.length > 0 ? messages : state.pendingUserInput;
    if (inputDelta.length === 0) return;
    state.userInputEmitted = true;
    state.pendingUserInput = [];
    writeRecord({
      ...turnFields(ctx, state, state.stepStartedAt || Date.now()),
      'event.name': 'other',
      'gen_ai.input.messages_delta': inputDelta,
    });
  };

  // request 必须在 response 之前存在；若 Pi 没给 context，message_end 会用空 messages 补发一次。
  const emitLlmRequest = (event, ctx) => {
    if (state.requestEmitted) return;
    state.requestEmitted = true;
    state.requestStartedAt = timestampMillis(state.stepStartedAt || Date.now());

    const record = {
      ...commonFields(ctx, state, state.requestStartedAt),
      'event.name': 'llm.request',
    };
    if (state.captureContent) {
      const messages = canonicalMessages(event.messages);
      if (messages.length > 0) record['gen_ai.input.messages'] = messages;
      if (state.systemPrompt) {
        record['gen_ai.system_instructions'] = [
          { type: 'text', content: truncate(state.systemPrompt) },
        ];
      }
      const tools = activeToolDefinitions(pi);
      if (tools.length > 0) record['gen_ai.tool.definitions'] = tools;
    }
    writeRecord(record);
  };

  // context 是模型真正消费上下文前的最后时机，因此先发用户增量，再发包含完整上下文的 request。
  pi.on('context', safeHandler('context', async (event, ctx) => {
    emitUserInput(event, ctx);
    emitLlmRequest(event, ctx);
  }));

  pi.on('message_end', safeHandler('message_end', async (event, ctx) => {
    const message = event.message;
    if (!message || message.role !== 'assistant') return;

    // 若 response 前没有 context，先补 user/request，避免下游得到零时长的孤立 response span。
    emitUserInput({ messages: [] }, ctx);
    emitLlmRequest({ messages: [] }, ctx);
    // Pi 的 AssistantMessage.timestamp 是流开始时间；处理器收到事件的时刻最接近完成时间。
    const responseAt = timestampStrictlyAfter(Date.now(), state.requestStartedAt);

    // Pi 的 usage.input 不含缓存读写，而平台 input_tokens 采用总输入口径，故在此显式相加；
    // 各缓存分量仍单独保留，便于下游计算成本。缺失字段按 0 处理，不会产生 NaN。
    const usage = message.usage || {};
    const cacheRead = Number(usage.cacheRead) || 0;
    const cacheWrite = Number(usage.cacheWrite) || 0;
    const inputTokens = (Number(usage.input) || 0) + cacheRead + cacheWrite;
    const outputTokens = Number(usage.output) || 0;
    const cost = usage.cost || {};
    const record = {
      ...commonFields(ctx, state, responseAt),
      'event.name': 'llm.response',
      'gen_ai.provider.name': normalizeProvider(message.provider || ctx.model?.provider),
      'gen_ai.request.model': message.model || ctx.model?.id || 'unknown',
      'gen_ai.response.model': message.responseModel || message.model || ctx.model?.id || 'unknown',
      'gen_ai.response.finish_reasons': [normalizeFinishReason(message.stopReason)],
      'gen_ai.usage.input_tokens': inputTokens,
      'gen_ai.usage.output_tokens': outputTokens,
      'gen_ai.usage.cache_read.input_tokens': cacheRead,
      'gen_ai.usage.cache_creation.input_tokens': cacheWrite,
      'gen_ai.usage.total_tokens': Number(usage.totalTokens) || inputTokens + outputTokens,
      'gen_ai.usage.input_cost': Number(cost.input) || 0,
      'gen_ai.usage.output_cost': Number(cost.output) || 0,
      'gen_ai.usage.cache_read.input_cost': Number(cost.cacheRead) || 0,
      'gen_ai.usage.cache_creation.input_cost': Number(cost.cacheWrite) || 0,
      'gen_ai.usage.total_cost': Number(cost.total) || 0,
    };
    if (message.responseId) record['gen_ai.response.id'] = message.responseId;
    if (state.captureContent) {
      const output = canonicalOutputMessage(message);
      if (output) record['gen_ai.output.messages'] = output;
    }
    if (message.stopReason === 'error') {
      record['error.type'] = 'llm_error';
      if (state.captureContent && message.errorMessage) {
        record['error.message'] = truncate(message.errorMessage, 8 * 1024);
      }
    }
    writeRecord(record);
  }));

  // 工具开始事件先保存本地毫秒时间，再写 tool.call；Map 键使用宿主提供的 toolCallId 完成配对。
  pi.on('tool_execution_start', safeHandler('tool_execution_start', async (event, ctx) => {
    const startedAt = timestampMillis();
    state.toolStarts.set(event.toolCallId, startedAt);
    const record = {
      ...commonFields(ctx, state, startedAt),
      'event.name': 'tool.call',
      'gen_ai.tool.name': event.toolName,
      'gen_ai.tool.call.id': event.toolCallId,
    };
    if (state.captureContent) {
      record['gen_ai.tool.call.arguments'] = toSerializable(event.args);
    }
    writeRecord(record);
  }));

  // 即使缺失开始事件也保留 tool.result，只是不输出 duration；这比丢弃孤立结果更利于诊断。
  pi.on('tool_execution_end', safeHandler('tool_execution_end', async (event, ctx) => {
    const startedAt = state.toolStarts.get(event.toolCallId);
    const endedAt = timestampStrictlyAfter(Date.now(), startedAt);
    state.toolStarts.delete(event.toolCallId);
    const record = {
      ...commonFields(ctx, state, endedAt),
      'event.name': 'tool.result',
      'gen_ai.tool.name': event.toolName,
      'gen_ai.tool.call.id': event.toolCallId,
      'tool.result.status': event.isError ? 'error' : 'success',
    };
    if (startedAt !== undefined) {
      record['gen_ai.tool.call.duration'] = endedAt - startedAt;
    }
    if (state.captureContent) {
      record['gen_ai.tool.call.result'] = toSerializable(event.result);
    }
    if (event.isError) record['error.type'] = 'tool_error';
    writeRecord(record);
  }));

  // 关闭时不删除已落盘日志，只释放闭包中可能引用大对象的队列和未完成工具状态。
  pi.on('session_shutdown', safeHandler('session_shutdown', async () => {
    state.pendingUserInput = [];
    state.toolStarts.clear();
  }));
}
