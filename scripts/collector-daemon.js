'use strict';

// 本文件是系统服务长期指向的稳定 CommonJS 启动垫片，不随 `current` 指针切换而搬迁。
// Collector 进程的稳定启动垫片。系统服务始终启动此文件，再由它根据版本指针
// 动态加载真正的 Collector 入口，因此升级时只需切换指针，无需修改服务配置。
// 它优先读取 current，入口缺失时回退 previous；动态 import 在 ESM 模块加载阶段失败时，
// 会原子写入 `logs/last-startup-crash.json` 并设置非零退出码，让 Updater 能区分模块加载崩溃。
// CommonJS 的 `require` 在旧/新版本切换之间保持最小依赖面，实际业务入口仍为 ESM。
const fs = require('fs');
const path = require('path');
// 将本地路径转换为 file URL，确保 CommonJS 脚本能在 Windows 和 POSIX 上动态加载 ESM。
const { pathToFileURL } = require('url');

// 安装目录结构：
//   ~/.loongsuite-pilot/current                         当前版本目录名
//   ~/.loongsuite-pilot/previous                        上一版本目录名
//   ~/.loongsuite-pilot/versions/<版本目录>/dist/index.js  Collector 实际入口
const HOME = process.env.HOME || process.env.USERPROFILE || '';
const CACHE_DIR = path.join(HOME, '.loongsuite-pilot');
const CURRENT_FILE = path.join(CACHE_DIR, 'current');
const PREVIOUS_FILE = path.join(CACHE_DIR, 'previous');
const VERSIONS_DIR = path.join(CACHE_DIR, 'versions');

/**
 * 解析版本指针并检查对应的 Collector 入口是否存在。
 * 指针文件中保存的是 versions 下的目录名，而不是入口文件的绝对路径。
 * 指针缺失、内容为空、读取失败或入口不存在时统一返回 null，交由调用方决定是否回退。
 */
function loadVersion(pointerFile) {
  try {
    // 传入的是~/.loongsuite-pilot/current或~/.loongsuite-pilot/previous，所以到的是具体的version_git_commit信息
    const name = fs.readFileSync(pointerFile, 'utf-8').trim();
    if (!name) return null;
    // 这里返回的是~/.loongsuite-pilot/versions/<版本目录>/dist/index.js
    const entry = path.join(VERSIONS_DIR, name, 'dist', 'index.js');
    if (fs.existsSync(entry)) return entry;
  } catch {}
  return null;
}

// 解析启动崩溃记录所在的数据目录。这里必须与 Updater 的读取规则一致，
// 否则 Updater 无法发现 Collector 在业务入口运行前发生的异常。
function resolveDataDir() {
  const raw = process.env.LOONGSUITE_PILOT_DATA_DIR;
  if (!raw) return CACHE_DIR;
  if (raw === '~') return HOME;
  if (raw.startsWith('~/')) return path.join(HOME, raw.slice(2));
  return raw;
}

// 从 current 指向的版本目录读取 VERSION，用于标记崩溃发生在哪个已安装版本。
// 读取失败时返回 unknown，避免版本信息解析失败影响原始异常的记录与上报。
function resolveInstalledVersion() {
  try {
    const name = fs.readFileSync(CURRENT_FILE, 'utf-8').trim();
    const content = fs.readFileSync(path.join(VERSIONS_DIR, name, 'VERSION'), 'utf-8');
    const match = content.match(/^version=(.+)$/m);
    return match ? match[1] : (name || 'unknown');
  } catch {
    return 'unknown';
  }
}

// 某些致命错误发生在 ESM 模块依赖图解析阶段（例如顶层依赖加载失败），此时
// dist/index.js 的 main() 尚未执行。启动垫片是唯一能捕获并留存这类真实原因的位置。
function writeStartupCrash(err) {
  try {
    const breadcrumb = {
      schema: 1,
      ts: Math.floor(Date.now() / 1000),
      phase: 'module_load',
      version: resolveInstalledVersion(),
      pid: process.pid,
      error_message: err && err.message ? String(err.message) : String(err),
      error_stack_head: err && err.stack
        ? String(err.stack).split(/\r?\n/).slice(0, 10).join('\n')
        : '',
    };
    const dir = path.join(resolveDataDir(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'last-startup-crash.json');
    // 先完整写入同目录临时文件，再原子替换目标文件，防止 Updater 读到半写入的 JSON。
    const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(breadcrumb, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // 崩溃记录仅用于辅助诊断，写入失败不能掩盖原始启动异常或改变退出行为。
  }
}

// 优先启动 current；当前版本不可用时回退到 previous，为升级异常保留基本可用性。
const entry = loadVersion(CURRENT_FILE) || loadVersion(PREVIOUS_FILE);
if (!entry) {
  console.error('[loongsuite-pilot] No valid collector version found');
  process.exit(1);
}

// 构建产物为 ESM，动态导入失败时先留下崩溃记录，再以非零状态退出供服务管理器感知。
import(pathToFileURL(entry).href).catch(err => {
  writeStartupCrash(err);
  console.error('[loongsuite-pilot] Failed to load collector:', err.message);
  process.exit(1);
});
