/**
 * Qoder Work 家族 worker runtime 的透明、与具体应用无关的包装器。
 *
 * 整个 `@qoder-ai/qoder-agent-sdk` 家族都读取共享环境变量 `QODER_WORKER_RUNTIME_PATH`；
 * macOS 又通过用户级全局 `launchctl setenv` 设置它，所以 QoderWork、QwenWorkCN、
 * Qoder Work CN 等任一同族应用都可能把本文件当 worker 入口。只有实际使用该 SDK 的应用会
 * 加载，但本模块绝不能假设宿主应用名称。
 *
 * 首要约束是绝不破坏宿主：只能根据当前 process 动态定位并加载“宿主自己的”bundle runtime，
 * 没有任何硬编码的应用回退路径。若无法确定路径，就不安装 JSON 拦截器也不加载其他 runtime，
 * 宁可丢失 token，也不能把 QoderWork runtime 交给 QwenWorkCN 等错误宿主。成功路径才把
 * token/system prompt 追加到 `~/.loongsuite-pilot/logs/qoderwork-intercept.jsonl`。
 *
 * 本文件使用 createRequire 从 ESM 加载宿主 runtime；全局 JSON 包装必须调用保存的原函数。
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');

const INTERCEPT_DIR = path.join(process.env.HOME || '/tmp', '.loongsuite-pilot', 'logs');
const INTERCEPT_FILE = path.join(INTERCEPT_DIR, 'qoderwork-intercept.jsonl');
const ERROR_LOG = path.join(INTERCEPT_DIR, 'qoderwork-wrapper-error.log');
const MIN_SYSTEM_PROMPT_LENGTH = 100;

const origParse = JSON.parse;
const origStringify = JSON.stringify;
let lastId = null;
let systemPromptCaptured = false;

function logDiag(msg) {
  try {
    fs.mkdirSync(INTERCEPT_DIR, { recursive: true });
    fs.appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

// 仅在即将导入已确认的宿主 runtime 前安装 JSON 包装；定位失败的 worker 完全不被修改。
function installInterceptHooks() {
  try { fs.mkdirSync(INTERCEPT_DIR, { recursive: true }); } catch {}

  // 截获 SSE 被解析后的 token usage。
  JSON.parse = function (text, reviver) {
    const result = origParse.call(JSON, text, reviver);
    try {
      if (result && typeof result === "object"
          && result.usage && result.choices !== undefined
          && result.id !== lastId) {
        lastId = result.id;
        const u = result.usage;
        const rec = {
          type: "token",
          ts: Date.now(),
          id: result.id,  // chatcmpl-xxx，与 transcript message.id 对应。
          model: result.model || "",
          prompt_tokens: u.prompt_tokens || 0,
          cached_tokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0,
          completion_tokens: u.completion_tokens || 0,
          reasoning_tokens: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0,
          total_tokens: u.total_tokens || 0,
        };
        // token 记录约 200 字节，小于 POSIX PIPE_BUF，适合单次追加。
        fs.appendFileSync(INTERCEPT_FILE, origStringify.call(JSON, rec) + "\n");
      }
    } catch {}
    return result;
  };

  // 请求加密前捕获 system prompt，每个进程最多一次。
  JSON.stringify = function (value, replacer, space) {
    try {
      if (!systemPromptCaptured && value && typeof value === "object"
          && value.messages && Array.isArray(value.messages)) {
        const sys = value.messages.find(m => m.role === "system");
        if (sys && typeof sys.content === "string" && sys.content.length > MIN_SYSTEM_PROMPT_LENGTH) {
          systemPromptCaptured = true;
          const rec = { type: "system_prompt", ts: Date.now(), content: sys.content };
          fs.appendFileSync(INTERCEPT_FILE, origStringify.call(JSON, rec) + "\n");
        }
      }
    } catch {}
    return origStringify.call(JSON, value, replacer, space);
  };
}

// SDK worker 相对应用 Resources 的路径固定；它包含 sharp/node-pty/keytar 等原生依赖，
// 必须位于 asar 解包目录，已发布应用中应是磁盘实体文件。
const SDK_WORKER_REL = path.join(
  'app.asar.unpacked', 'node_modules', '@qoder-ai', 'qoder-agent-sdk', 'dist', '_worker',
);
const RUNTIME_NAMES = ['qoder-worker-runtime.obf.mjs', 'qoder-worker-runtime.mjs'];

// 资源根只从当前进程推导，始终指向实际宿主，不硬编码任何应用名。
function candidateResourceRoots() {
  const roots = [];

  // 1. 从可执行文件路径找最外层 .app；Electron worker 的 execPath 是宿主自身二进制，例如：
  //   /Applications/QwenWorkCN.app/Contents/MacOS/QwenWorkCN
  // 非贪婪匹配第一个 .app，避免嵌套 Helper.app 遮蔽外层 bundle；这是 macOS 布局保证。
  const exec = process.execPath || '';
  const m = /^(.*?\.app)(?:\/|$)/.exec(exec);
  if (m) roots.push(path.join(m[1], 'Contents', 'Resources'));

  // 2. Electron 提供 resourcesPath 时，它直接指向 <App>/Contents/Resources。
  if (process.resourcesPath) roots.push(process.resourcesPath);

  return roots;
}

// 定位宿主自己的 worker runtime；确定时返回绝对路径，否则返回 null。
function findHostAppRuntime() {
  let selfPath = '';
  try { selfPath = fs.realpathSync(fileURLToPath(import.meta.url)); } catch {}

  const seen = new Set();
  for (const root of candidateResourceRoots()) {
    for (const name of RUNTIME_NAMES) {
      const cand = path.join(root, SDK_WORKER_REL, name);
      if (seen.has(cand)) continue;
      seen.add(cand);
      try {
        if (!fs.existsSync(cand)) continue;
        const real = fs.realpathSync(cand);
        if (real === selfPath) continue; // 防递归：绝不能再次导入包装器自身。
        return real;
      } catch {}
    }
  }
  return null;
}

const hostRuntime = findHostAppRuntime();

if (hostRuntime) {
  // 已确认是宿主自己的 runtime 后才安装截获并加载；除额外记录 token 外应保持原行为。
  installInterceptHooks();
  try {
    await import(hostRuntime);
  } catch (e) {
    // 宿主自身 runtime 加载失败时也不在模块顶层抛错，否则会崩 worker_thread 并阻断 SDK
    // 使用宿主自身的传输回退路径；同时绝不尝试其他应用的 runtime。
    logDiag(`host runtime import failed: ${hostRuntime} :: ${e && e.message}`);
  }
} else {
  // 无法定位时不猜测、不加载外部 runtime，也不安装截获器；SDK 会自行识别空 worker 并降级。
  logDiag(
    'host app runtime not found — skipping intercept to avoid loading a foreign runtime '
    + `(execPath=${process.execPath || ''}, resourcesPath=${process.resourcesPath || ''})`,
  );
}
