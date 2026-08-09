/**
 * Claude Code 请求侧的 Bun `fetch` preload 截获脚本。
 *
 * 它是 Claude 采集链中的“可选补充数据支线”，不是主 transcript 采集入口。完整关系如下：
 *
 * `claude` shell function 设置 BUN_OPTIONS
 * -> Bun 启动 Claude Code 前 preload 本文件
 * -> 本文件包装 globalThis.fetch，仅旁路观察 `/v1/messages`
 * -> 每个 LLM response 写一份 `<session_id>/<response_id>.json`
 * -> Claude Code 触发 `Stop` Hook
 * -> `claude-code-hook-processor.mjs` 解析原生 transcript，并按 response ID 合并这些文件
 * -> processor 写标准 Hook JSONL
 * -> 常驻 `ClaudeCodeLogInput` 轮询 JSONL 后才由 `BaseInput` 触发 `entries`。
 *
 * 当前部署方式：安装阶段先把本文件复制到 `<Pilot 数据目录>/hooks/`；Orchestrator 启动的
 * `HookWatchdog` 在 Claude Agent 获准且 watchdog 启用时，维护 `~/.zshrc`/`~/.bashrc` 中的
 * `claude()` 包装函数。该函数只在执行 `claude` 命令时设置
 * `BUN_OPTIONS="--preload=<本文件> ${BUN_OPTIONS}"`，并保留用户已有的 Bun 参数。修改 rc 后需要
 * 新开 shell 或重新 source 才能影响后续 Claude 进程；若用户已经定义 `claude` alias/function，
 * Watchdog 按当前设计不会覆盖它，因此 preload 是否生效需由实际 shell 环境确认。
 *
 * 相关环境变量的职责不同：
 * - `BUN_OPTIONS` 是真正让 Bun 加载本模块的运行时开关；没有对应 `--preload` 就不会执行本文件；
 * - `LOONGSUITE_PILOT_HOOK_WATCHDOG_ENABLED` 控制 Collector 是否维护上述 rc 注入，默认开启，但它
 *   不是 preload 内部读取的开关；
 * - `LOONGSUITE_PILOT_DATA_DIR` 只决定中间文件数据根目录；未设置时使用
 *   `$HOME/.loongsuite-pilot`，HOME 也缺失时回退 `/tmp/.loongsuite-pilot`。
 *
 * 本模块从请求和流式响应补齐 transcript 没有或不够精确的字段：
 * - 请求 body 的 `system` 转成 `system_instructions`，同时过滤 Claude 内部计费头文本；
 * - SSE `message_start.message.id` 作为 `response_id`，与 transcript 的 message ID 关联；
 * - 从调用原始 fetch 前到首个 text/thinking/input-json 增量的耗时，换算为 `ttft_ns`。
 *
 * 每次 LLM 调用最多写一份
 * `<数据根>/intercept/claude-code/<session_id>/<response_id>.json`。Stop processor 只把匹配文件的
 * system instructions 加到 `llm.request`、把 TTFT 加到 `llm.response`；正式消息、token、工具事件、
 * 时间线和归属仍以 transcript 为事实来源。匹配文件在标准 JSONL 成功写入后删除，未匹配的新文件
 * 暂留，超过一小时才由 processor 清理。
 *
 * 该文件虽为 `.mjs` 却使用 `require()`，依赖 Bun preload（测试也会从带 require 的 CommonJS
 * 宿主动态导入）；用普通 `node <本文件>` 直接执行会因 ESM 中没有 require 而失败。设计采用
 * fail-open：真实网络异常必须原样抛给 Claude Code，旁路解析/落盘异常则尽量吞掉。它不导出 API、
 * 不调用 Hook processor、不写最终采集 JSONL，也绝不直接触发 Collector 的 `entries`。
 */
// Bun preload 环境提供 CommonJS require；这里只使用同步 fs/path，保证流回调内可立即落盘。
const fs = require('node:fs');
const path = require('node:path');

// 路径在 preload 加载时固定；之后修改环境变量不会迁移当前 Claude 进程的写入目录。
const INTERCEPT_BASE = path.join(
  process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(process.env.HOME || '/tmp', '.loongsuite-pilot'),
  'intercept',
  'claude-code',
);
// 只截获 Anthropic Messages API 路径；允许其后直接结束、带查询串或继续带 `/`。
const LLM_URL_RE = /\/v1\/messages(?:\?|$|\/)/;
// Claude 会把内部计费元数据伪装成 system 文本；该前缀用于避免将其当用户指令上报。
const BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:';
// SSE 事件由一个空行分隔；pending 只在完整分隔符出现后交给 JSON 解析。
const SSE_DELIMITER = '\n\n';

// ─── system_instructions 提取 ─────────────────────────────────────────────

/**
 * 把 Anthropic 请求的 system 字段转换为标准 parts，并过滤内部计费头。
 *
 * system 可能是裸字符串，也可能是 block 数组。文本转为 `{type:'text', content}`；非文本 block
 * 用展开语法浅复制并保留其他字段。函数从不回写输入对象，所以不会改变随后真正发往 Anthropic 的
 * 请求 body。所有有效内容都被过滤时返回 null，processor 因而不会添加 system instructions 字段。
 *
 * @param {unknown} systemField 解析请求 JSON 后得到的 `system` 字段。
 * @returns {object[]|null} 标准 MessagePart 数组；没有可上报内容时为 null。
 */
function extractSystemInstructions(systemField) {
  // null 和 undefined 都表示请求没有 system 指令。
  if (systemField == null) return null;
  // 兼容 system 为裸字符串的输入，并包装成规范要求的数组形式。
  if (typeof systemField === 'string') {
    // 整个字符串就是计费头时直接丢弃；这里只做前缀匹配，不扫描文本中部。
    if (systemField.startsWith(BILLING_HEADER_PREFIX)) return null;
    return [{ type: 'text', content: systemField }];
  }
  // 对对象等未知形状不做推断，避免错误读取/修改请求。
  if (!Array.isArray(systemField)) return null;

  const result = [];
  for (const block of systemField) {
    // 单个无效 block 被跳过，其他 system blocks 仍可正常采集。
    if (!block || typeof block !== 'object') continue;
    const type = block.type;
    if (type === 'text') {
      // 缺失或非字符串 text 降级为空字符串，保持输出 part 结构稳定。
      const text = typeof block.text === 'string' ? block.text : '';
      if (text.startsWith(BILLING_HEADER_PREFIX)) continue;
      result.push({ type: 'text', content: text });
    } else if (typeof type === 'string') {
      // 非文本块按 GenericPart 透传；规范允许 additionalProperties，因此保留原字段供服务端使用。
      // 解构会生成新对象，真实请求中的原 block 保持不变。
      const { type: t, ...rest } = block;
      result.push({ type: t, ...rest });
    }
  }
  // 用 null 而不是空数组，方便中间记录明确表达“没有可合并的 system 指令”。
  return result.length > 0 ? result : null;
}

// ─── 请求头和请求体工具 ─────────────────────────────────────────────────

/**
 * 把 Fetch `Headers` 实例或普通 header 对象复制为小写键对象。
 *
 * Fetch header 名不区分大小写，而 Claude 的 session 标识可能以不同大小写出现。这里只复制值，不
 * 修改原 headers；读取异常返回已收集的部分或空对象，调用链随后按“缺 session ID”直接透传请求。
 *
 * @param {unknown} h `init.headers` 或 Request-like 对象的 headers。
 * @returns {Record<string, unknown>} 键已转小写的新对象。
 */
function dumpHeaders(h) {
  const out = {};
  if (!h) return out;
  try {
    if (typeof h.forEach === 'function') {
      // 原生 Headers 提供 forEach；String(k) 防御非标准实现返回非字符串键。
      h.forEach((v, k) => { out[String(k).toLowerCase()] = v; });
    } else if (typeof h === 'object') {
      // 普通对象只枚举自身可枚举键，不沿原型链读取属性。
      for (const k of Object.keys(h)) out[k.toLowerCase()] = h[k];
    }
    // 旁路 header 解析失败不允许阻断真实 fetch。
  } catch (_) {}
  return out;
}

/**
 * 尽力把不会被“消费掉”的请求 body 同步解码为文本。
 *
 * 仅接受 string、Uint8Array 和 ArrayBuffer。ReadableStream、Blob、FormData 等输入返回 null，因为
 * 读取这些对象可能锁住/消费真实请求体，改变 Claude Code 的网络行为。
 *
 * @param {unknown} body Fetch 请求 body。
 * @returns {string|null} 可安全读取的文本；不支持或解码失败时为 null。
 */
function readBodyAsText(body) {
  if (body == null) return null;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) {
    // TextDecoder 默认按 UTF-8 解码，符合 JSON 请求体编码。
    try { return new TextDecoder().decode(body); } catch (_) { return null; }
  }
  if (body instanceof ArrayBuffer) {
    // ArrayBuffer 先建立不复制语义的 Uint8Array 视图，再交给 TextDecoder。
    try { return new TextDecoder().decode(new Uint8Array(body)); } catch (_) { return null; }
  }
  return null;
}

/**
 * 从可安全读取的 JSON 请求体中提取并转换 `system` 字段。
 * @param {unknown} body Fetch 请求 body。
 * @returns {object[]|null} 标准 system instruction parts；无法读取/解析时为 null。
 */
function safeParseRequestSystem(body) {
  const text = readBodyAsText(body);
  if (!text) return null;
  try {
    // 只解析旁路副本；JSON.parse 抛错被下方捕获，不影响 origFetch 接收的原 body。
    const parsed = JSON.parse(text);
    return extractSystemInstructions(parsed.system);
  } catch (_) {
    return null;
  }
}

// ─── 截获记录写入 ───────────────────────────────────────────────────────

/**
 * 每个 response_id 写独立 JSON 文件，供 Stop processor 一次性读取和删除。
 *
 * 目录按 session 隔离，文件名按 Anthropic response ID 隔离，所以同一会话的多次 LLM 调用不会
 * 追加到同一个文件。processor 在 Stop 时扫描整个 session 目录，以 transcript 的 message ID 查找
 * 同名记录；成功写出最终 JSONL 后删除已合并文件，未匹配文件留待后续 Stop 或一小时陈旧清理。
 *
 * 该函数使用直接 `writeFileSync`，没有 state 模块的临时文件 + rename。正常顺序是响应流先完成、
 * 后触发 Stop，因此 processor 通常只会看到完整文件；若两者极端并发，半写文件会被 processor 当作
 * 损坏 JSON 跳过，待后续/陈旧清理。sessionId/responseId 直接来自 Claude 协议，当前没有调用
 * `path.basename` 进行额外路径安全化，这项假设仍待确认。
 *
 * @param {string} sessionId `x-claude-code-session-id` 请求头的值。
 * @param {{response_id: string, [key: string]: unknown}} record 要落盘的截获记录。
 * @returns {void}
 * @sideeffect 同步创建 session 目录并覆盖同 response ID 的 JSON 文件。
 * @throws 不向调用方抛错；所有序列化/文件系统异常都被吞掉以保持 fetch fail-open。
 */
function writeRecord(sessionId, record) {
  try {
    // INTERCEPT_BASE 已含 agent 维度，这里再用 session ID 隔离并行 Claude 会话。
    const dir = path.join(INTERCEPT_BASE, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    // response_id 后续必须与 transcript 中的 ev.message_id 完全相等才能合并。
    const file = path.join(dir, `${record.response_id}.json`);
    // 每个 response 独占新文件（最坏约 27KB），不用 append，避免多个调用把内容交错写入。
    // processor 只会在 stop 后读取，正常情况下不会观察到写到一半的文件。
    // JSON.stringify 不缩进，减少 preload 在响应流回调中的同步磁盘开销。
    fs.writeFileSync(file, JSON.stringify(record));
  } catch (_) {
    // 截获记录落盘失败不能影响 Claude Code 的网络请求。
  }
}

// ─── SSE 完整事件块解析 ─────────────────────────────────────────────────

/**
 * 解析两个 `\n\n` 之间的一条完整 SSE 事件块。
 *
 * SSE 允许一个事件包含多行 `data:`；这里去掉字段名前缀和两端空白后以换行重新拼接，供调用方
 * `JSON.parse`。未使用的 id/retry/注释行会被忽略。没有 event 或 data 的块不具备本模块所需信息。
 *
 * @param {string} block SSE 文本块。
 * @returns {{event: string, data: string} | null} 事件名和合并后的 data；格式不完整时返回 null。
 */
function parseSseBlock(block) {
  // event 初始为 null，用于区分“还没看到 event 行”和合法的非空事件名。
  let event = null;
  const dataLines = [];
  for (const line of block.split('\n')) {
    // slice(6)/slice(5) 去掉字段名和冒号，trim 再兼容冒号后的可选空格。
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  // 不完整事件采用跳过而非抛错，避免异常影响宿主响应流。
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
