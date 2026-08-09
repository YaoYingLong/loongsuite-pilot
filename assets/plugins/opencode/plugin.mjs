/**
 * LoongSuite Pilot 的 OpenCode event_t 插件。
 *
 * `PluginInjectStrategy` 把本文件的 file:// spec 写入 OpenCode 配置；随后代码常驻 OpenCode
 * 的 Bun 进程，把 EventV2 生命周期转换成 `logs/opencode/opencode-YYYY-MM-DD.jsonl`，再由
 * `OpenCodeLogInput` 通过 BaseHookInput 管道读取。插件零外部依赖，只使用 Node/Bun 内置 API。
 *
 * 事件映射：chat.message 开启 turn 并采集 user；chat.params 保存模型/provider；
 * message.part.updated 处理 step、reasoning/text 和工具状态；message.updated 汇总 LLM response
 * 与 token；tool.execute.before/after 补充工具参数、结果和时长；实验性 system.transform 保存
 * system instructions；session.idle/error 清理会话内存。
 *
 * 每个 OpenCode server 实例对应一个工作目录。会话状态存在有上限的 Map 中，最多 100 个并按
 * 插入顺序淘汰。所有处理器都经 safe() 包装，序列化/落盘失败只写诊断，不得改变宿主行为。
 * 内容最长 64KB，并执行 `captureMessageContent` 配置；插件退出时无外部资源需要显式关闭。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const AGENT_TYPE = "opencode";
const MAX_SESSIONS = 100;
const MAX_CONTENT_SIZE = 64 * 1024;

// ---------------------------------------------------------------------------
// 调用方提供的 span 属性
// ---------------------------------------------------------------------------
// 宿主按每次调用以 `key=value,key=value` 设置环境变量；模块初始化时解析一次并铺到记录顶层。
// 插件独立分发不能依赖 hooks/shared，故内联实现，并与 resource-context.mjs 保持规则一致。
const SPAN_ATTR_RESERVED_PREFIXES = [
  "gen_ai.",
  "git.",
  "workspace.",
  "event.",
  "trace_",
  "user.",
  "cost_",
  "agent.",
  "time_unix_nano",
  "observed_time_unix_nano",
];
const SPAN_ATTR_MAX_VALUE_LENGTH = 512;
const SPAN_ATTR_SENSITIVE_RE =
  /(^|[_.-])(TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE)([_.-]|$)|^(API_KEY|API_HEADER)$/i;

/**
 * 解析用户附加的 span 属性，同时拒绝平台保留前缀、敏感 key 和超长 value。
 * `indexOf('=')` 只切第一个等号，因此值本身可以继续包含 `=`；重复 key 以后出现的值覆盖前值。
 */
function parseSpanAttributesFromEnv(env = process.env) {
  const out = {};
  const raw = env.LOONGSUITE_PILOT_SPAN_ATTRIBUTES;
  if (typeof raw !== "string" || raw.length === 0) return out;
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!key || !value) continue;
    if (SPAN_ATTR_RESERVED_PREFIXES.some((p) => key === p || key.startsWith(p))) continue;
    if (SPAN_ATTR_SENSITIVE_RE.test(key)) continue;
    if (value.length > SPAN_ATTR_MAX_VALUE_LENGTH) continue;
    out[key] = value;
  }
  return out;
}

const SPAN_ATTRIBUTES = parseSpanAttributesFromEnv(process.env);

// ---------------------------------------------------------------------------
// 路径辅助函数
// ---------------------------------------------------------------------------

function resolveDataDir() {
  return (
    process.env.LOONGSUITE_PILOT_DATA_DIR ||
    path.join(os.homedir(), ".loongsuite-pilot")
  );
}

function logDir() {
  return path.join(resolveDataDir(), "logs", "opencode");
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

function todayStamp() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

// ---------------------------------------------------------------------------
// ID 生成器
// ---------------------------------------------------------------------------

function generateTraceId() {
  return crypto.randomBytes(16).toString("hex");
}

function generateSpanId() {
  return crypto.randomBytes(8).toString("hex");
}

function nowNanos() {
  return String(Date.now() * 1_000_000);
}

function msToNanos(ms) {
  return typeof ms === "number" && Number.isFinite(ms)
    ? String(Math.round(ms * 1_000_000))
    : undefined;
}

// ---------------------------------------------------------------------------
// 安全 JSON 序列化
// ---------------------------------------------------------------------------

/**
 * 处理循环引用、函数和 BigInt 后序列化。replacer 的 WeakSet 不会删除已遍历对象，
 * 因而重复引用也会显示为 Circular；这是日志防御性降级，不用于还原宿主对象图。
 */
function safeStringify(obj) {
  const seen = new WeakSet();
  return JSON.stringify(obj, function (_key, value) {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    if (typeof value === "function") return undefined;
    if (typeof value === "bigint") return value.toString();
    return value;
  });
}

function truncate(str, max) {
  if (typeof str !== "string") return str;
  return str.length > max ? str.slice(0, max) + "...[truncated]" : str;
}

/**
 * 只裁剪标准消息最常见的 content/response 文本，保留数组与 part 的其余结构。
 * 该函数返回浅拷贝，避免为了采集而直接改写 OpenCode 交给插件的事件对象。
 */
function truncateContent(val) {
  if (typeof val === "string") return truncate(val, MAX_CONTENT_SIZE);
  if (Array.isArray(val)) {
    return val.map((item) => {
      if (typeof item !== "object" || !item) return item;
      const out = { ...item };
      if (out.parts && Array.isArray(out.parts)) {
        out.parts = out.parts.map((p) => {
          if (typeof p?.content === "string")
            return { ...p, content: truncate(p.content, MAX_CONTENT_SIZE) };
          if (typeof p?.response === "string")
            return { ...p, response: truncate(p.response, MAX_CONTENT_SIZE) };
          return p;
        });
      }
      return out;
    });
  }
  return val;
}

// ---------------------------------------------------------------------------
// 运行时配置
// ---------------------------------------------------------------------------

function loadPilotConfig() {
  try {
    const cfgPath = path.join(resolveDataDir(), "config.json");
    const raw = fs.readFileSync(cfgPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function resolveUserId(cfg) {
  return (
    process.env.LOONGSUITE_USER_ID ||
    cfg.userId ||
    os.hostname() ||
    "unknown"
  );
}

// ---------------------------------------------------------------------------
// JSONL 写入
// ---------------------------------------------------------------------------

let _logDirReady = false;

// server 初始化时记录 OpenCode 工作目录；一个 server 对应一个项目，进程生命周期内稳定。
// 写为 agent.opencode.cwd，供后续管道丰富 git.repo/workspace.current_root。
let agentCwd;

/** 同步追加单条 JSONL；写入失败转到错误日志，任何异常都不会从插件边界抛回 OpenCode。 */
function writeRecord(record) {
  try {
    if (!_logDirReady) {
      ensureDir(logDir());
      _logDirReady = true;
    }
    const filePath = path.join(logDir(), `opencode-${todayStamp()}.jsonl`);
    fs.appendFileSync(filePath, safeStringify(record) + "\n");
  } catch (err) {
    writeError("writeRecord", err);
  }
}

function writeError(source, err) {
  try {
    ensureDir(logDir());
    const errPath = path.join(
      logDir(),
      `opencode-error-${todayStamp()}.log`
    );
    fs.appendFileSync(
      errPath,
      `${new Date().toISOString()} [${source}] ${err?.stack || err}\n`
    );
  } catch {}
}

// ---------------------------------------------------------------------------
// 会话状态（容量有上限的 Map）
// ---------------------------------------------------------------------------

const sessions = new Map();
const sessionTurnSeqs = new Map();

/**
 * 获取或创建 session 状态。状态跨不同 Hook 回调保存，用于把分散到多个 EventV2 事件中的
 * request、流式 part、token 和工具结果重新配对。Map 超限后淘汰最早插入项，并非 LRU。
 */
function getSession(sessionID) {
  if (!sessionID) return null;
  let s = sessions.get(sessionID);
  if (!s) {
    s = {
      turnSeq: sessionTurnSeqs.get(sessionID) ?? 0,
      currentTurn: null,
      systemPrompt: null,
      systemInstructionsParts: null,
      agentMeta: null,
      modelInfo: null,
      llmParams: null,
      pendingParts: [],
      emittedToolCalls: new Set(),
      stepStartTimeMs: null,
      stepFinishData: null,
    };
    sessions.set(sessionID, s);
    // Map 保持插入顺序，超限时删除最早会话，避免常驻插件无限增长内存。
    if (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      clearSession(oldest);
    }
  }
  return s;
}

/**
 * 释放完整会话状态，但短暂保留 turnSeq，使同一 sessionID 清理后再次出现时不会复用 turn 编号。
 */
function clearSession(sessionID) {
  const s = sessions.get(sessionID);
  if (s) {
    sessionTurnSeqs.delete(sessionID);
    sessionTurnSeqs.set(sessionID, s.turnSeq);
    if (sessionTurnSeqs.size > MAX_SESSIONS) {
      const oldest = sessionTurnSeqs.keys().next().value;
      sessionTurnSeqs.delete(oldest);
    }
  }
  sessions.delete(sessionID);
}

// ---------------------------------------------------------------------------
// 标准记录公共字段
// ---------------------------------------------------------------------------

/**
 * 构造每条标准事件共享的关联字段。正常路径使用 currentTurn.traceId；若事件次序异常尚无 turn，
 * 会生成临时 traceId 以保持字段合法，但这类孤立记录无法与后续 turn 自动关联。
 */
function buildCommonFields(sessionID, session, userId) {
  const turn = session.currentTurn;
  return {
    time_unix_nano: nowNanos(),
    "event.id": crypto.randomUUID(),
    trace_id: turn?.traceId ?? generateTraceId(),
    "gen_ai.session.id": sessionID,
    "gen_ai.turn.id": turn?.turnId,
    "user.id": userId,
    "gen_ai.agent.type": AGENT_TYPE,
    "gen_ai.agent.name": AGENT_TYPE,
    "gen_ai.agent.id": session.agentMeta?.name || undefined,
    ...(agentCwd ? { [`agent.${AGENT_TYPE}.cwd`]: agentCwd } : {}),
    ...SPAN_ATTRIBUTES,
  };
}

function deriveFinishReasons(info, pendingParts) {
  if (info.error) return ["error"];
  if (pendingParts && pendingParts.some((p) => p.kind === "tool_call")) {
    return ["tool_call"];
  }
  const parts = info.parts || [];
  if (parts.some((p) => p.type === "tool" || p.type === "tool-invocation")) {
    return ["tool_call"];
  }
  return ["stop"];
}

function inferProviderName(providerID) {
  if (!providerID) return undefined;
  const id = String(providerID).toLowerCase();
  if (id.includes("anthropic")) return "anthropic";
  if (id.includes("openai")) return "openai";
  if (id.includes("alibaba") || id.includes("dashscope")) return "alibaba";
  if (id.includes("google") || id.includes("gemini")) return "google";
  return providerID;
}

// ---------------------------------------------------------------------------
// 消息格式工具（ARMS 嵌套 parts 结构）
// ---------------------------------------------------------------------------

function buildUserInputMessages(systemPrompt, userPromptText) {
  const messages = [];
  if (systemPrompt) {
    messages.push({
      role: "system",
      parts: [{ type: "text", content: truncate(systemPrompt, MAX_CONTENT_SIZE) }],
    });
  }
  if (userPromptText) {
    messages.push({
      role: "user",
      parts: [{ type: "text", content: truncate(userPromptText, MAX_CONTENT_SIZE) }],
    });
  }
  return messages.length > 0 ? messages : undefined;
}

/**
 * 把上一步 assistant 输出与工具结果回灌为下一次 llm.request 的增量上下文。
 * 工具调用留在 assistant message，结果另放 tool message，保持调用和响应的角色语义。
 */
function buildInputMessagesDelta(lastOutputParts) {
  const messages = [];
  const assistantParts = [];
  const toolResultParts = [];

  for (const p of lastOutputParts) {
    if (p.kind === "tool_call") {
      assistantParts.push({
        type: "tool_call",
        id: p.callID,
        name: p.toolName,
        arguments: p.arguments
          ? typeof p.arguments === "string"
            ? p.arguments
            : safeStringify(p.arguments)
          : undefined,
      });
      if (p.result !== undefined) {
        toolResultParts.push({
          type: "tool_call_response",
          id: p.callID,
          response: typeof p.result === "string"
            ? truncate(p.result, MAX_CONTENT_SIZE)
            : truncate(safeStringify(p.result), MAX_CONTENT_SIZE),
        });
      }
    } else if (p.kind === "text" && p.content) {
      assistantParts.push({ type: "text", content: truncate(p.content, MAX_CONTENT_SIZE) });
    }
  }

  if (assistantParts.length > 0) {
    messages.push({ role: "assistant", parts: assistantParts });
  }
  if (toolResultParts.length > 0) {
    messages.push({ role: "tool", parts: toolResultParts });
  }

  return messages.length > 0 ? messages : undefined;
}

function buildOutputMessages(pendingParts, finishReason) {
  const parts = [];

  for (const p of pendingParts) {
    if (p.kind === "reasoning" && p.content) {
      parts.push({ type: "reasoning", content: truncate(p.content, MAX_CONTENT_SIZE) });
    } else if (p.kind === "text" && p.content) {
      parts.push({ type: "text", content: truncate(p.content, MAX_CONTENT_SIZE) });
    } else if (p.kind === "tool_call") {
      const args = p.arguments
        ? typeof p.arguments === "string"
          ? truncate(p.arguments, MAX_CONTENT_SIZE)
          : truncate(safeStringify(p.arguments), MAX_CONTENT_SIZE)
        : undefined;
      parts.push({
        type: "tool_call",
        id: p.callID,
        name: p.toolName,
        arguments: args,
      });
    }
  }

  if (parts.length === 0) return undefined;

  return [
    {
      role: "assistant",
      parts,
      finish_reason: finishReason || "stop",
    },
  ];
}

// ---------------------------------------------------------------------------
// OpenCode 事件处理器
// ---------------------------------------------------------------------------

// 方案1(env):首个 turn 读 process.env.TRACEPARENT,写 session 级关联记录到
// acp-correlate/<sessionId>.jsonl,每 session 只写一次(O_CREAT|O_EXCL 锁)。fail-open。
const UPSTREAM_TP_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i;
function recordUpstreamEnvOnce(sessionID) {
  try {
    const tp = (process.env.TRACEPARENT || "").trim();
    const m = UPSTREAM_TP_RE.exec(tp);
    if (!m || m[1].toLowerCase() === "0".repeat(32) || m[2].toLowerCase() === "0".repeat(16)) return;
    const dir = path.join(resolveDataDir(), "acp-correlate");
    fs.mkdirSync(dir, { recursive: true });
    const base = path.basename(String(sessionID)).replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
    try {
      fs.closeSync(fs.openSync(path.join(dir, `${base}.env.lock`), "wx"));
    } catch (e) {
      if (e && e.code === "EEXIST") return; // 已写过, 正常返回
      throw e;
    }
    const rec = { type: "session", sessionId: sessionID, traceparent: tp, ts: new Date().toISOString() };
    fs.appendFileSync(path.join(dir, `${base}.jsonl`), JSON.stringify(rec) + "\n", "utf-8");
  } catch {
    // fail-open：关联记录失败绝不影响 OpenCode。
  }
}

/**
 * `chat.message` 是新用户 turn 的边界：递增序号、创建 trace，并清空上个 turn 的临时 step 状态。
 * 此处仅立即写 user 增量；模型 request 要等 `step-start`，因为那时模型/provider 才更完整。
 */
function handleChatMessage(inp, out, userId) {
  const sessionID = inp.sessionID;
  if (!sessionID) return;

  const session = getSession(sessionID);

  session.turnSeq += 1;
  if (session.turnSeq === 1) recordUpstreamEnvOnce(sessionID);
  const turnId = `${sessionID}:t${session.turnSeq}`;
  const traceId = generateTraceId();

  session.currentTurn = {
    turnId,
    traceId,
    stepSeq: 0,
    userPromptText: null,
  };
  session.pendingParts = [];
  session.emittedToolCalls = new Set();
  session.stepStartTimeMs = null;
  session.lastStepOutputParts = null;

  const msg = out?.message;
  if (msg) {
    session.agentMeta = {
      name:
        (typeof msg.agent === "string" ? msg.agent : msg.agent?.name) ||
        (typeof inp.agent === "string" ? inp.agent : inp.agent?.name) ||
        AGENT_TYPE,
      id: msg.agent?.id || inp.agent?.id,
    };
    if (msg.model) {
      session.modelInfo = {
        providerID: msg.model.providerID,
        modelID: msg.model.modelID,
      };
    }
  }

  let userPromptText = null;
  if (out?.parts && Array.isArray(out.parts)) {
    const textParts = out.parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text);
    if (textParts.length > 0) {
      userPromptText = textParts.join("\n");
    }
  }
  session.currentTurn.userPromptText = userPromptText;

  const record = {
    ...buildCommonFields(sessionID, session, userId),
    "event.name": "other",
  };
  if (userPromptText) {
    record["gen_ai.input.messages_delta"] = [
      {
        role: "user",
        parts: [{ type: "text", content: truncate(userPromptText, MAX_CONTENT_SIZE) }],
      },
    ];
  }

  writeRecord(record);
}

function handleSystemTransform(_inp, out, sessionID) {
  if (!sessionID || !out?.system) return;
  const session = getSession(sessionID);
  const systemArr = out.system;
  if (Array.isArray(systemArr)) {
    session.systemPrompt = systemArr
      .filter((s) => typeof s === "string")
      .join("\n\n");
    session.systemInstructionsParts = systemArr
      .filter((s) => typeof s === "string" && s.length > 0)
      .map((s) => ({ type: "text", content: truncate(s, MAX_CONTENT_SIZE) }));
  }
}

function handleChatParams(inp, _out, sessionID) {
  if (!sessionID) return;
  const session = getSession(sessionID);

  if (inp.model) {
    session.modelInfo = {
      providerID: inp.model.providerID || inp.provider?.id,
      modelID: inp.model.id || inp.model.modelID,
    };
  }
}

/**
 * 消费 OpenCode 的流式 part 状态机。
 * step-start 发 request；reasoning/text 暂存到 pendingParts；工具 running/completed 分别发 call/result；
 * step-finish 只暂存 token/cost，最终 response 等 message.updated 的 completed 时间再输出。
 */
function handleMessagePartUpdated(props, userId) {
  const sessionID = props.sessionID;
  const part = props.part;
  if (!sessionID || !part) return;

  const session = getSession(sessionID);
  const turn = session.currentTurn;
  if (!turn) return;

  const partType = part.type;

  if (partType === "step-start") {
    // 新 step 先清空输出缓冲，再分配递增 stepId；这不会重置 turn 级 traceId。
    session.pendingParts = [];
    turn.stepSeq += 1;
    turn.currentStepId = `${turn.turnId}:s${turn.stepSeq}`;
    turn.currentMessageId = part.messageID;
    session.stepStartTimeMs = props.time || Date.now();

    const model = session.modelInfo;
    const record = {
      ...buildCommonFields(sessionID, session, userId),
      "event.name": "llm.request",
      "gen_ai.step.id": turn.currentStepId,
      "gen_ai.provider.name": inferProviderName(model?.providerID),
      "gen_ai.request.model": model?.modelID,
      "opencode.message.id": part.messageID,
    };
    record.time_unix_nano = msToNanos(session.stepStartTimeMs) || nowNanos();

    if (turn.stepSeq === 1) {
      // 首步携带 system + user 全量输入；后续步只携带上一轮输出增量，减少重复日志体积。
      const inputMsgs = buildUserInputMessages(
        session.systemPrompt,
        turn.userPromptText
      );
      if (inputMsgs) record["gen_ai.input.messages"] = inputMsgs;
      if (session.systemInstructionsParts && session.systemInstructionsParts.length > 0) {
        record["gen_ai.system_instructions"] = session.systemInstructionsParts;
      } else if (session.systemPrompt) {
        record["gen_ai.system_instructions"] = [
          { type: "text", content: truncate(session.systemPrompt, MAX_CONTENT_SIZE) },
        ];
      }
    } else if (session.lastStepOutputParts) {
      const delta = buildInputMessagesDelta(session.lastStepOutputParts);
      if (delta) record["gen_ai.input.messages_delta"] = delta;
    }

    writeRecord(record);
  } else if (partType === "reasoning") {
    session.pendingParts.push({
      kind: "reasoning",
      content: part.text || "",
      timeStart: part.time?.start,
      timeEnd: part.time?.end,
    });
  } else if (partType === "text" && part.messageID) {
    const isUserMessage =
      !turn.currentStepId &&
      session.pendingParts.length === 0;
    if (isUserMessage) return;

    session.pendingParts.push({
      kind: "text",
      content: part.text || "",
      timeStart: part.time?.start,
      timeEnd: part.time?.end,
    });
  } else if (partType === "tool" || partType === "tool-invocation") {
    const callID = part.callID || part.id;
    const toolName = part.tool || part.name;
    const state = part.state;

    const rawInput = state?.input;
    const hasRealInput = rawInput && typeof rawInput === "object"
      ? Object.keys(rawInput).length > 0
      : !!rawInput;
    const argsStr = hasRealInput
      ? typeof rawInput === "string" ? rawInput : safeStringify(rawInput)
      : undefined;

    if (state?.status === "running" && callID) {
      // 同一工具的 running part 可能多次更新；Set 保证 tool.call 只写一次，后续更新仅补全参数/时间。
      const existingPart = session.pendingParts.find(
        (pp) => pp.kind === "tool_call" && pp.callID === callID
      );
      if (existingPart && state.time?.start) {
        existingPart.startTimeMs = state.time.start;
      }

      if (session.emittedToolCalls.has(`call:${callID}`)) {
        if (argsStr && existingPart && !existingPart.arguments) {
          existingPart.arguments = argsStr;
        }
        return;
      }

      session.emittedToolCalls.add(`call:${callID}`);

      if (!existingPart) {
        session.pendingParts.push({
          kind: "tool_call",
          callID,
          toolName,
          arguments: argsStr,
          startTimeMs: state.time?.start || Date.now(),
        });
      }

      const toolCallRecord = {
        ...buildCommonFields(sessionID, session, userId),
        "event.name": "tool.call",
        "gen_ai.step.id": turn.currentStepId,
        "gen_ai.tool.name": toolName,
        "gen_ai.tool.call.id": callID,
        "gen_ai.tool.call.arguments": argsStr
          ? truncateContent(argsStr)
          : undefined,
        "opencode.message.id": part.messageID,
      };
      if (state.time?.start) {
        toolCallRecord.time_unix_nano = msToNanos(state.time.start);
      }
      writeRecord(toolCallRecord);
    } else if (
      (state?.status === "completed" || state?.status === "error") &&
      callID &&
      !session.emittedToolCalls.has(`result:${callID}`)
    ) {
      // result 使用独立前缀，因此 call 与 result 各允许输出一次。
      session.emittedToolCalls.add(`result:${callID}`);

      const resultPayload = state.output ?? state.error ?? "";
      const matchingPart = session.pendingParts.find(
        (pp) => pp.kind === "tool_call" && pp.callID === callID
      );
      if (matchingPart) {
        matchingPart.result = resultPayload;
        if (!matchingPart.arguments && argsStr) {
          matchingPart.arguments = argsStr;
        }
      }

      const toolResultRecord = {
        ...buildCommonFields(sessionID, session, userId),
        "event.name": "tool.result",
        "gen_ai.step.id": turn.currentStepId,
        "gen_ai.tool.name": toolName,
        "gen_ai.tool.call.id": callID,
        "gen_ai.tool.call.result": truncateContent(
          typeof resultPayload === "string"
            ? resultPayload
            : safeStringify(resultPayload)
        ),
        "tool.result.status": state?.status === "error" ? "error" : "success",
        "opencode.message.id": part.messageID,
      };
      if (state.time?.end) {
        toolResultRecord.time_unix_nano = msToNanos(state.time.end);
      }
      if (state.time?.start && state.time?.end) {
        toolResultRecord["gen_ai.tool.call.duration"] =
          Math.round(state.time.end - state.time.start);
      }
      writeRecord(toolResultRecord);
    }
  } else if (partType === "step-finish") {
    if (part.tokens) {
      session.stepFinishData = {
        tokens: part.tokens,
        cost: part.cost,
        reason: part.reason,
        time: props.time,
      };
    }
  }
}

/**
 * assistant message 真正完成时汇总当前 step 的输出、token、成本和错误并写 llm.response。
 * 未完成的流式 message 会提前返回；成功落盘后 pendingParts 转存为下一 step 的输入增量。
 */
function handleMessageUpdated(props, userId) {
  const info = props.info;
  if (!info || info.role !== "assistant") return;

  const sessionID = info.sessionID;
  if (!sessionID) return;

  const session = getSession(sessionID);
  const turn = session.currentTurn;
  if (!turn) return;

  if (!info.time?.completed) return;

  const model = session.modelInfo;
  const stepData = session.stepFinishData;
  const tokens = stepData?.tokens || info.tokens || {};
  const finishReasons = deriveFinishReasons(info, session.pendingParts);
  const outputMessages = buildOutputMessages(
    session.pendingParts,
    finishReasons[0]
  );

  // OpenCode tokens.input 已扣除 cache（input/read/write 是互斥成本桶）。标准字段要求 input 为
  // 总 prompt token，故加回 cache，使 cache_read <= input；cost_usd 已按桶正确计算，不改。
  const cacheRead = tokens.cache?.read || 0;
  const cacheWrite = tokens.cache?.write || 0;
  const outputTokens = tokens.output || 0;
  const inputTotal = (tokens.input || 0) + cacheRead + cacheWrite;

  const record = {
    ...buildCommonFields(sessionID, session, userId),
    "event.name": "llm.response",
    "gen_ai.step.id": turn.currentStepId,
    "opencode.message.id": info.id,
    "gen_ai.provider.name": inferProviderName(
      info.providerID || model?.providerID
    ),
    "gen_ai.request.model": info.modelID || model?.modelID,
    "gen_ai.response.model": info.modelID || model?.modelID,
    "gen_ai.response.id": info.id,
    "gen_ai.response.finish_reasons": finishReasons,
    "gen_ai.usage.input_tokens": inputTotal,
    "gen_ai.usage.output_tokens": outputTokens,
    "gen_ai.usage.cache_read.input_tokens": cacheRead,
    "gen_ai.usage.cache_creation.input_tokens": cacheWrite,
    "gen_ai.usage.total_tokens": inputTotal + outputTokens,
  };
  if (tokens.reasoning) {
    record["gen_ai.usage.reasoning_tokens"] = tokens.reasoning;
  }

  record.time_unix_nano = msToNanos(info.time.completed) || nowNanos();

  if (outputMessages) {
    record["gen_ai.output.messages"] = truncateContent(outputMessages);
  }
  const cost = stepData?.cost ?? info.cost;
  if (cost != null) {
    record["cost_usd"] = cost;
  }
  if (info.error) {
    record["error.type"] = "llm_error";
    record["error.message"] = truncate(
      typeof info.error === "string" ? info.error : safeStringify(info.error),
      1024
    );
  }

  writeRecord(record);

  // 使用数组副本保留已完成 step；随后清空 pending，避免下一 step 重复拼接同一输出。
  session.lastStepOutputParts = [...session.pendingParts];
  session.pendingParts = [];
  session.stepFinishData = null;
}

/**
 * 处理专用 `tool.execute.before` 回调。它与 message.part.updated 可能报告同一工具，
 * 所以共用 emittedToolCalls 去重；若 call 已发出，仍允许用这里更完整的 args 补 pending 状态。
 */
function handleToolExecuteBefore(inp, out, userId) {
  const sessionID = inp?.sessionID;
  if (!sessionID) return;

  const session = getSession(sessionID);
  const turn = session.currentTurn;
  if (!turn) return;

  const callID = inp.callID || inp.id;
  const toolName = inp.tool || inp.name;
  if (!callID) return;

  const toolArgs = out?.args;
  const argsStr = toolArgs
    ? typeof toolArgs === "string"
      ? toolArgs
      : safeStringify(toolArgs)
    : undefined;

  if (session.emittedToolCalls.has(`call:${callID}`)) {
    if (argsStr) {
      const existing = session.pendingParts.find(
        (pp) => pp.kind === "tool_call" && pp.callID === callID && !pp.arguments
      );
      if (existing) existing.arguments = argsStr;
    }
    return;
  }

  session.emittedToolCalls.add(`call:${callID}`);

  session.pendingParts.push({
    kind: "tool_call",
    callID,
    toolName,
    arguments: argsStr,
    startTimeMs: Date.now(),
  });

  writeRecord({
    ...buildCommonFields(sessionID, session, userId),
    "event.name": "tool.call",
    "gen_ai.step.id": turn.currentStepId,
    "gen_ai.tool.name": toolName,
    "gen_ai.tool.call.id": callID,
    "gen_ai.tool.call.arguments": argsStr
      ? truncateContent(argsStr)
      : undefined,
    "opencode.message.id": turn.currentMessageId,
  });
}

/** 与 before 配对输出结果和耗时；无有效结果时让更可靠的 part.state.output 路径继续处理。 */
function handleToolExecuteAfter(inp, out, userId) {
  const sessionID = inp?.sessionID;
  if (!sessionID) return;

  const session = getSession(sessionID);
  const turn = session.currentTurn;
  if (!turn) return;

  const callID = inp.callID || inp.id;
  const toolName = inp.tool || inp.name;
  if (!callID || session.emittedToolCalls.has(`result:${callID}`)) return;

  const resultPayload = out?.output ?? out?.result ?? "";

  // MCP 的 after-hook 不带结果，但 part.state.output 有真实值。这里无内容且无错误时直接返回，
  // 且不标记 result 已消费，让 message.part.updated 路径稍后输出，避免空结果抢占真实结果。
  const hasResultContent = typeof resultPayload === "string"
    ? resultPayload.length > 0
    : resultPayload != null;
  if (!hasResultContent && !out?.error) return;

  const matchingPart = session.pendingParts.find(
    (pp) => pp.kind === "tool_call" && pp.callID === callID
  );
  if (matchingPart) {
    matchingPart.result = resultPayload;
    if (!matchingPart.arguments && inp.args) {
      matchingPart.arguments = typeof inp.args === "string"
        ? inp.args
        : safeStringify(inp.args);
    }
  }

  session.emittedToolCalls.add(`result:${callID}`);

  const toolResultRecord = {
    ...buildCommonFields(sessionID, session, userId),
    "event.name": "tool.result",
    "gen_ai.step.id": turn.currentStepId,
    "gen_ai.tool.name": toolName,
    "gen_ai.tool.call.id": callID,
    "gen_ai.tool.call.result": truncateContent(
      typeof resultPayload === "string"
        ? resultPayload
        : safeStringify(resultPayload)
    ),
    "tool.result.status": out?.error ? "error" : "success",
    "opencode.message.id": turn.currentMessageId,
  };
  if (matchingPart?.startTimeMs) {
    const endMs = Date.now();
    toolResultRecord.time_unix_nano = msToNanos(endMs);
    toolResultRecord["gen_ai.tool.call.duration"] =
      Math.round(endMs - matchingPart.startTimeMs);
  }
  writeRecord(toolResultRecord);
}

// ---------------------------------------------------------------------------
// 遵循 fail-open 的处理器包装器。
// ---------------------------------------------------------------------------

function safe(fn) {
  // OpenCode 接受 async Hook；await 同时捕获同步 throw 与 Promise rejection，错误只落诊断文件。
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      writeError(fn.name || "unknown", err);
    }
  };
}

// ---------------------------------------------------------------------------
// OpenCode 插件入口
// ---------------------------------------------------------------------------

export default {
  id: "loongsuite-pilot-opencode",

  // server 回调执行一次并返回 Hook 表；userId/config 在该实例生命周期内固定，session 数据按 ID 隔离。
  server: async (input, _options) => {
    ensureDir(logDir());

    // OpenCode 在 server 回调传实例上下文；directory 是工作目录，缺失时回退宿主 process.cwd()。
    agentCwd =
      (typeof input?.directory === "string" && input.directory) ||
      process.cwd() ||
      undefined;

    const cfg = loadPilotConfig();
    const userId = resolveUserId(cfg);

    return {
      event: safe(async function handleEvent({ event }) {
        const type = event.type;
        const props = event.properties || {};

        // event 是 EventV2 总线；只消费本插件理解的类型，未知事件保持无副作用。
        switch (type) {
          case "message.part.updated":
            handleMessagePartUpdated(props, userId);
            break;
          case "message.updated":
            handleMessageUpdated(props, userId);
            break;
          case "session.idle":
          case "session.error": {
            // idle/error 都视为终态。未 flush part 只写诊断后丢弃，不能伪造成一次完整 response。
            if (props.sessionID) {
              const s = sessions.get(props.sessionID);
              if (s && s.pendingParts && s.pendingParts.length > 0) {
                writeError("session-cleanup", `session ${type}: discarding ${s.pendingParts.length} unflushed pending part(s) [${s.pendingParts.map(p => p.kind || "unknown").join(",")}]`);
              }
              clearSession(props.sessionID);
            }
            break;
          }
        }
      }),

      "chat.message": safe(async function handleChatMsg(inp, out) {
        handleChatMessage(inp, out, userId);
      }),

      "chat.params": safe(async function handleParams(inp, out) {
        const sessionID = inp?.sessionID;
        if (sessionID) handleChatParams(inp, out, sessionID);
      }),

      "experimental.chat.system.transform": safe(
        async function handleSystemXform(inp, out) {
          const sessionID = inp?.sessionID;
          handleSystemTransform(inp, out, sessionID);
        }
      ),

      "tool.execute.before": safe(async function handleToolBefore(inp, out) {
        handleToolExecuteBefore(inp, out, userId);
      }),

      "tool.execute.after": safe(async function handleToolAfter(inp, out) {
        handleToolExecuteAfter(inp, out, userId);
      }),

      dispose: safe(async function handleDispose() {}),
    };
  },
};
