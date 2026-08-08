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

function resolveDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || installedDataDir;
}

function resolveLogDir() {
  return path.join(resolveDataDir(), 'logs', AGENT_TYPE);
}

function todayStamp() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function timestampMillis(timestamp = Date.now()) {
  return Number.isFinite(timestamp) ? Math.trunc(timestamp) : Date.now();
}

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

function ensureLogDir() {
  if (logDirReady) return;
  const dir = resolveLogDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  logDirReady = true;
}

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

function safeHandler(name, handler) {
  return async (event, ctx) => {
    try {
      await handler(event, ctx);
    } catch (error) {
      writeError(name, error);
    }
  };
}

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

  const resetSessionConfig = () => {
    const config = loadPilotConfig();
    state.userId = resolveUserId(config);
    state.captureContent = shouldCaptureContent(config);
  };

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

  pi.on('turn_start', safeHandler('turn_start', async (event) => {
    state.turnId ||= crypto.randomUUID();
    state.stepId = `${state.turnId}:s${event.turnIndex + 1}`;
    state.stepStartedAt = timestampMillis(event.timestamp);
    state.requestEmitted = false;
    state.requestStartedAt = 0;
    state.userInputEmitted = false;
  }));

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

  pi.on('session_shutdown', safeHandler('session_shutdown', async () => {
    state.pendingUserInput = [];
    state.toolStarts.clear();
  }));
}
