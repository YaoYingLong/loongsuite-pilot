// BUN_OPTIONS preload script for Claude Code fetch interception.
// Injected via: BUN_OPTIONS="--preload=<this-file>" claude ...
// Writes one JSON file per LLM call to:
//   ~/.loongsuite-pilot/intercept/claude-code/<session_id>/<response_id>.json
//
// What it captures:
//   1. system_instructions — parsed from the outgoing /v1/messages request
//      body's `system` field, mapped to the MessagePart[] form defined by
//      loongsuite-pilot/specs/gen-ai-system_instructions.json (TextPart uses
//      `content`, not the Anthropic `text` field). The first block, which is
//      a Claude Code billing-header marker, is filtered out.
//   2. response_id — extracted from the first SSE `message_start` event's
//      `message.id`. Same value pilot already stores under
//      `gen_ai.response.id`, so the hook processor can join 1:1.
//   3. ttft_ns — performance.now() delta (ms) at the moment the first
//      content_block_delta (text_delta / thinking_delta / input_json_delta)
//      arrives, converted to integer nanoseconds.
//
// Design notes:
//   - SSE is parsed by splitting the accumulated buffer on `\n\n` event
//     boundaries. A sliding-window regex was tried first and silently
//     corrupted long preambles — do NOT change back.
//   - Once both response_id and ttft_ns are captured we stop parsing and
//     transparently pipe the rest of the stream, keeping memory bounded.
//   - All work is wrapped in try/catch; an exception here must never break
//     Claude Code's own fetch flow.
//   - NOTE: This file uses require() which is Bun-specific in .mjs context.
//     It only runs under BUN_OPTIONS --preload inside a compiled Bun binary
//     (Claude Code CLI).
//
// 捕获的三类数据：
// 1.系统提示词（system_instructions） 从向外发送的 /v1/messages 请求请求体的 system 字段中解析提取，并且转换为 MessagePart[] 格式（该格式由
//    loongsuite-pilot/specs/gen-ai-system_instructions.json 规范定义）；其中文本结构体使用字段名content，而非 Anthropic 接口标准的text字段。
//    同时会过滤掉第一段作为 Claude Code 计费标识的头部内容块。
// 2.响应 ID（response_id） 从第一条 SSE 推送的message_start事件里的message.id字段提取。该 ID
//    与采集器已存入gen_ai.response.id字段的值完全一致，上层钩子处理器可依靠此字段实现一对一的数据关联匹配。
// 3.首字符抵达耗时 ttft_ns 当首个content_block_delta事件（包含文本增量、思考过程增量、入参 JSON 增量三类）到达时，
//    通过performance.now()计算时间差值（毫秒），最终转换为整型纳秒值保存。
//
// 设计说明
// 1.SSE 数据流解析方式：将累积缓冲区按照\n\n事件分隔符做切割解析。项目早期曾尝试滑动窗口正则方案，但长前置报文场景下会出现静默数据损坏问题，禁止改回正则实现方案。
// 2.一旦成功捕获到response_id与ttft_ns两项指标，即刻停止解析逻辑，后续的原始流式数据直接透传转发，以此控制内存占用不会持续上涨。
// 3.全部解析逻辑包裹在try/catch异常捕获中：本钩子内部抛出任何异常，都绝对不能破坏 Claude Code 原生的网络请求流程。
//
// 重要备注：本文件为.mjs格式却使用require()导入模块，该写法仅 Bun 运行环境支持。此脚本只会由 Claude Code 编译后的 Bun 二进制程序，通过BUN_OPTIONS --preload预加载方式运行。
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

// ─── system_instructions extraction ──────────────────────────────────────

function extractSystemInstructions(systemField) {
  if (systemField == null) return null;
  // Defensive: accept a bare string and wrap (spec returns array form)
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
      // Non-text block: pass through under GenericPart (spec allows
      // additionalProperties). Preserve all original fields so server-side
      // consumers see everything.
      const { type: t, ...rest } = block;
      result.push({ type: t, ...rest });
    }
  }
  return result.length > 0 ? result : null;
}

// ─── header / body helpers ────────────────────────────────────────────────

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

// ─── intercept record writer ──────────────────────────────────────────────

function writeRecord(sessionId, record) {
  try {
    const dir = path.join(INTERCEPT_BASE, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${record.response_id}.json`);
    // Single record per file (~27KB worst case) — POSIX guarantees writes
    // under PIPE_BUF (~4KB) are atomic; for larger writes appendFileSync
    // could interleave, but writeFileSync writes once to a fresh inode so
    // partial reads aren't a concern in practice.
    fs.writeFileSync(file, JSON.stringify(record));
  } catch (_) {
    // intercept storage failure must not affect the host process
  }
}

// ─── SSE event-block parsing ──────────────────────────────────────────────

/**
 * Parse a single complete SSE event block (text between two `\n\n`).
 * Returns { event, data } or null if malformed.
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

// ─── globalThis.fetch monkey-patch ───────────────────────────────────────

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

    // Header session_id is required to scope intercept output. Without it
    // we have no way for the hook processor to find this record, so we
    // skip writing — let the request go through normally.
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
      // Network failure: nothing useful to record; rethrow to host.
      throw err;
    }

    // No body (HEAD-style, 204, etc.) → can't observe stream.
    if (!response || !response.body) return response;

    let responseId = null;
    let ttftNs = null;
    let recordWritten = false;
    let stopParsing = false;
    const decoder = new TextDecoder();
    let pending = '';

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
          controller.enqueue(chunk); // pass through first, parsing is best-effort
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
          // Stream ended normally without ever producing a content delta
          // (e.g. tool-only response that arrived as a single block, or
          // server returned an error mid-stream). Persist whatever we have.
          if (!recordWritten && responseId) tryEmit();
        },
      });
    } catch (_) {
      // TransformStream construction failed (very old runtime): bail out
      // and return the original response untouched.
      return response;
    }

    let wrappedBody;
    try {
      wrappedBody = response.body.pipeThrough(transform);
    } catch (_) {
      return response;
    }

    try {
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
