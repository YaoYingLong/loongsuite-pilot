/**
 * qodercli 的 token 与 system prompt 请求侧截获脚本。
 *
 * 通过 `BUN_OPTIONS="--preload=<本文件>" qodercli ...` 注入 Bun 进程，临时包装全局
 * JSON.parse 以观察 SSE 尾部 usage/choices，包装 JSON.stringify 以在请求加密前取得首个
 * role=system 消息。结果追加到 `~/.loongsuite-pilot/logs/qodercli-intercept.jsonl`，供后续
 * token enricher 按 response id 合并；本文件不生成正式 history 事件。
 *
 * `.mjs` 中的 `require()` 是 Bun preload 特性，普通 Node.js 不应直接运行。每次包装先调用
 * 原函数并返回同一结果，截获错误全部吞掉，不能改变 qodercli 行为。
 */

const fs = require("node:fs");
const path = require("node:path");

const INTERCEPT_DIR = path.join(process.env.HOME || "/tmp", ".loongsuite-pilot", "logs");
const INTERCEPT_FILE = path.join(INTERCEPT_DIR, "qodercli-intercept.jsonl");
const MIN_SYSTEM_PROMPT_LENGTH = 100;

try { fs.mkdirSync(INTERCEPT_DIR, { recursive: true }); } catch {}

// 安装包装前保存原始引用；包装内部序列化诊断记录时必须调用 origStringify，避免递归进入自身。
const origParse = JSON.parse;
const origStringify = JSON.stringify;
let lastId = null;
let systemPromptCaptured = false;

// 全局包装 JSON.parse 捕获 SSE usage；实测每次约增加 0.01ms、会话总开销低于 0.2%。
JSON.parse = function (text, reviver) {
  const result = origParse.call(JSON, text, reviver);
  try {
    if (result && typeof result === "object"
        && result.usage && result.choices !== undefined
        && result.id !== lastId) {
      // response id 是跨多次 JSON.parse 的去重键；同一 SSE 响应重复出现 usage 时只落一条。
      lastId = result.id;
      const u = result.usage;
      const rec = {
        type: "token",
        ts: Date.now(),
        id: result.id,
        model: result.model || "",
        prompt_tokens: u.prompt_tokens || 0,
        cached_tokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0,
        completion_tokens: u.completion_tokens || 0,
        reasoning_tokens: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0,
        total_tokens: u.total_tokens || 0,
      };
      // token 记录约 200 字节，小于 POSIX PIPE_BUF，单次追加不会与同类小写入交错。
      fs.appendFileSync(INTERCEPT_FILE, origStringify.call(JSON, rec) + "\n");
    }
  } catch {}
  return result;
};

// 全局包装 JSON.stringify，在请求加密前捕获 system prompt；每进程最多一次。
JSON.stringify = function (value, replacer, space) {
  try {
    if (!systemPromptCaptured && value && typeof value === "object"
        && value.messages && Array.isArray(value.messages)) {
      const sys = value.messages.find(function (m) { return m.role === "system"; });
      if (sys && typeof sys.content === "string" && sys.content.length > MIN_SYSTEM_PROMPT_LENGTH) {
        // 先置位再写文件：即使落盘失败，也不会让每次 stringify 都重复执行大消息扫描。
        systemPromptCaptured = true;
        const rec = {
          type: "system_prompt",
          ts: Date.now(),
          content: sys.content,
        };
        fs.appendFileSync(INTERCEPT_FILE, origStringify.call(JSON, rec) + "\n");
      }
    }
  } catch {}
  return origStringify.call(JSON, value, replacer, space);
};
