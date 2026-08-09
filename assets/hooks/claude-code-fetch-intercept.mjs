/**
 * Claude Code 请求侧 fetch 截获脚本。
 *
 * Claude Code 通过 `BUN_OPTIONS="--preload=<本文件>"` 在自身 Bun 进程启动前加载它。
 * 本模块包装 `globalThis.fetch`，只观察 `/v1/messages` 请求及其 SSE 响应；正式对话内容仍由
 *原生 transcript 采集。每次 LLM 调用写一个
 * `~/.loongsuite-pilot/intercept/claude-code/<session_id>/<response_id>.json`，随后
 * `claude-code-hook-processor.mjs` 在 stop 阶段按 `response_id` 与 transcript 一对一合并。
 *
 * 捕获三类 transcript 中没有或不够精确的数据：请求 `system` 转成 MessagePart[] 后的
 * `system_instructions`（过滤 Claude 计费头块）、首个 SSE `message_start.message.id`，以及从
 * 发起 fetch 到首个内容增量的 `ttft_ns`。SSE 必须按空行 `\n\n` 的完整事件边界切分；旧的
 * 滑动窗口正则会静默破坏长前导数据，不可恢复为该实现。取得 response_id 和 TTFT 后停止解析
 * 并透明转发余下数据，以限制内存。
 *
 * 该文件虽为 `.mjs` 却使用 `require()`，这是 Bun preload 环境特性，不应由普通 Node.js
 * 直接运行。所有观察逻辑均 fail-open：网络错误原样抛给 Claude Code，截获自身错误则被吞掉，
 * 不能改变请求、响应、流背压或宿主异常行为。
 */
const fs = require('node:fs');
const path = require('node:path');

const INTERCEPT_BASE = path.join(
  process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(process.env.HOME || '/tmp', '.loongsuite-pilot'),
  'intercept',
  'claude-code',
);
const LLM_URL_RE = /\/v1\/messages(?:\?|$|\/)/;
const BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:';
const SSE_DELIMITER = '\n\n';

// ─── system_instructions 提取 ─────────────────────────────────────────────

/**
 * 把 Anthropic 请求的 system 字段转换为标准 parts，并过滤内部计费头。
 * 返回 null 表示没有可上报内容；原 block 通过展开复制，不修改真实网络请求体。
 */
function extractSystemInstructions(systemField) {
  if (systemField == null) return null;
  // 兼容 system 为裸字符串的输入，并包装成规范要求的数组形式。
  if (typeof systemField === 'string') {
    if (systemField.startsWith(BILLING_HEADER_PREFIX)) return null;
    return [{ type: 'text', content: systemField }];
  }
  if (!Array.isArray(systemField)) return null;

  const result = [];
  for (const block of systemField) {
    if (!block || typeof block !== 'object') continue;
    const type = block.type;
    if (type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      if (text.startsWith(BILLING_HEADER_PREFIX)) continue;
      result.push({ type: 'text', content: text });
    } else if (typeof type === 'string') {
      // 非文本块按 GenericPart 透传；规范允许 additionalProperties，因此保留原字段供服务端使用。
      const { type: t, ...rest } = block;
      result.push({ type: t, ...rest });
    }
  }
  return result.length > 0 ? result : null;
}

// ─── 请求头和请求体工具 ─────────────────────────────────────────────────

/** 兼容 Headers 实例与普通对象，并将 key 统一为小写以便大小写无关查找 session header。 */
function dumpHeaders(h) {
  const out = {};
  if (!h) return out;
  try {
    if (typeof h.forEach === 'function') {
      h.forEach((v, k) => { out[String(k).toLowerCase()] = v; });
    } else if (typeof h === 'object') {
      for (const k of Object.keys(h)) out[k.toLowerCase()] = h[k];
    }
  } catch (_) {}
  return out;
}

/** 仅观察可无损同步解码的 string/ArrayBuffer/Uint8Array；流式请求体不消费，避免破坏网络请求。 */
function readBodyAsText(body) {
  if (body == null) return null;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) {
    try { return new TextDecoder().decode(body); } catch (_) { return null; }
  }
  if (body instanceof ArrayBuffer) {
    try { return new TextDecoder().decode(new Uint8Array(body)); } catch (_) { return null; }
  }
  return null;
}

function safeParseRequestSystem(body) {
  const text = readBodyAsText(body);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return extractSystemInstructions(parsed.system);
  } catch (_) {
    return null;
  }
}

// ─── 截获记录写入 ───────────────────────────────────────────────────────

/**
 * 每个 response_id 写独立 JSON 文件，供 Stop processor 一次性读取和删除。
 * sessionId/responseId 均来自 Claude 协议；路径合法性依赖宿主 ID 格式，额外校验待确认。
 */
function writeRecord(sessionId, record) {
  try {
    const dir = path.join(INTERCEPT_BASE, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${record.response_id}.json`);
    // 每个 response 独占新文件（最坏约 27KB），不用 append，避免多个调用把内容交错写入。
    // processor 只会在 stop 后读取，正常情况下不会观察到写到一半的文件。
    fs.writeFileSync(file, JSON.stringify(record));
  } catch (_) {
    // 截获记录落盘失败不能影响 Claude Code 的网络请求。
  }
}

// ─── SSE 完整事件块解析 ─────────────────────────────────────────────────

/**
 * 解析两个 `\n\n` 之间的一条完整 SSE 事件块。
 * @param {string} block SSE 文本块。
 * @returns {{event: string, data: string} | null} 事件名和合并后的 data；格式不完整时返回 null。
 */
function parseSseBlock(block) {
  let event = null;
  const dataLines = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!event || dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

// ─── 包装 globalThis.fetch ──────────────────────────────────────────────

const origFetch = globalThis.fetch;
if (typeof origFetch === 'function') {
  globalThis.fetch = async function patchedFetch(input, init) {
    let url;
    try {
      url = typeof input === 'string' ? input
          : (input && typeof input === 'object' && typeof input.url === 'string') ? input.url
          : String(input);
    } catch (_) {
      url = '';
    }

    if (!url || !LLM_URL_RE.test(url)) {
      return origFetch.call(this, input, init);
    }

    // session_id 请求头决定输出目录；缺失时 processor 无法关联记录，因此仅透传请求而不落盘。
    let sessionId = null;
    let systemInstructions = null;
    try {
      const headers = dumpHeaders(
        init?.headers ?? (input && typeof input === 'object' ? input.headers : null),
      );
      sessionId = headers['x-claude-code-session-id'] || null;
      if (sessionId) {
        const body = init?.body
          ?? (input && typeof input === 'object' ? input.body : null);
        systemInstructions = safeParseRequestSystem(body);
      }
    } catch (_) {}

    if (!sessionId) {
      return origFetch.call(this, input, init);
    }

    const startMs = performance.now();
    let response;
    try {
      response = await origFetch.call(this, input, init);
    } catch (err) {
      // 真实网络失败必须原样抛给宿主；本模块不能伪装请求成功。
      throw err;
    }

    // 没有 body（例如 204）时无流可观察，直接返回原响应。
    if (!response || !response.body) return response;

    let responseId = null;
    let ttftNs = null;
    let recordWritten = false;
    let stopParsing = false;
    const decoder = new TextDecoder();
    let pending = '';

    // 只允许写一次；message_start 先到时会等待 TTFT，流结束仍无 delta 时由 flush 保存部分信息。
    const tryEmit = () => {
      if (recordWritten || !responseId) return;
      writeRecord(sessionId, {
        session_id: sessionId,
        response_id: responseId,
        ttft_ns: ttftNs,
        system_instructions: systemInstructions,
      });
      recordWritten = true;
    };

    const processBlock = (block) => {
      const parsed = parseSseBlock(block);
      if (!parsed) return;
      if (parsed.event === 'message_start' && responseId === null) {
        try {
          const evt = JSON.parse(parsed.data);
          if (evt?.message?.id) responseId = String(evt.message.id);
        } catch (_) {}
      } else if (parsed.event === 'content_block_delta' && ttftNs === null) {
        try {
          const evt = JSON.parse(parsed.data);
          const dtype = evt?.delta?.type;
          if (dtype === 'text_delta' || dtype === 'thinking_delta' || dtype === 'input_json_delta') {
            const ms = performance.now() - startMs;
            ttftNs = Math.max(0, Math.round(ms * 1e6));
          }
        } catch (_) {}
      }
    };

    let transform;
    try {
      transform = new TransformStream({
        transform(chunk, controller) {
          // TransformStream 按下游拉取节奏调用 transform；先 enqueue 同一 chunk，保留原始字节和背压链。
          controller.enqueue(chunk); // 先透传数据；解析仅为尽力而为的旁路操作。
          if (stopParsing) return;
          try {
            pending += decoder.decode(chunk, { stream: true });
            let idx;
            while ((idx = pending.indexOf(SSE_DELIMITER)) !== -1) {
              const block = pending.slice(0, idx);
              pending = pending.slice(idx + SSE_DELIMITER.length);
              processBlock(block);
            }
            if (responseId && ttftNs !== null) {
              tryEmit();
              stopParsing = true;
              pending = '';
            }
          } catch (_) {}
        },
        flush() {
          // 流正常结束但从未出现内容增量（如纯工具响应或中途服务端错误）时，保存已取得的字段。
          if (!recordWritten && responseId) tryEmit();
        },
      });
    } catch (_) {
      // 很旧的运行时若无法创建 TransformStream，则放弃观察并原样返回响应。
      return response;
    }

    let wrappedBody;
    try {
      // pipeThrough 返回新的可读流，原 body 仍只被消费一次，不调用 clone/arrayBuffer 造成整流缓存。
      wrappedBody = response.body.pipeThrough(transform);
    } catch (_) {
      return response;
    }

    try {
      // 用相同状态码、状态文本和头构造透明响应；正文仅替换为旁路观察后的等价流。
      return new Response(wrappedBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (_) {
      return response;
    }
  };
}
