'use strict';

// 本文件使用 CommonJS（`require`）而非项目默认 ESM，因为它是安装到稳定 `bin/` 目录的极小启动垫片。
// Updater 进程的稳定 CommonJS 启动垫片。服务管理器启动此文件后，
// 它会根据 `current` 指针确定当前版本目录，并加载其中的 ESM updater 入口。
// 与 Collector 垫片不同，Updater 不回退 `previous`：它必须跟随当前版本的更新协议。
// 找不到入口或动态 import 失败会写 stderr 并以退出码 1 结束，交由服务管理器记录/重启。
const fs = require('fs');
const path = require('path');
// 使用 pathToFileURL() 是为了让 CommonJS 启动脚本能够跨平台动态加载 ESM 构建产物
const { pathToFileURL } = require('url');

// 已安装版本采用以下基于指针的目录结构：
//   ~/.loongsuite-pilot/current
//   ~/.loongsuite-pilot/versions/<version-dir>/dist/updater/index.js其实是就是src/updater/index.ts
const CACHE_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '', '.loongsuite-pilot');
const CURRENT_FILE = path.join(CACHE_DIR, 'current');
const VERSIONS_DIR = path.join(CACHE_DIR, 'versions');

/**
 * 同步读取版本指针并验证该版本的 Updater ESM 入口。
 * @param {string} pointerFile `current` 指针文件路径。
 * @returns {string|null} 可动态 import 的入口路径；指针/入口无效时返回 `null`。
 * 读取异常被视为无可用版本，由顶层输出统一错误并返回退出码 1。
 */
function loadVersion(pointerFile) {
  try {
    // 指针文件保存的是版本目录名称，而不是绝对路径。
    const name = fs.readFileSync(pointerFile, 'utf-8').trim();
    if (!name) return null;
    const entry = path.join(VERSIONS_DIR, name, 'dist', 'updater', 'index.js');
    if (fs.existsSync(entry)) return entry;
  } catch {
    // 指针不存在或无法读取时，由下方调用方统一输出错误信息。
  }
  return null;
}

// Updater 只跟随 `current` 指针，确保运行安装器当前选定版本中的 updater 代码。
const entry = loadVersion(CURRENT_FILE);
if (!entry) {
  console.error('[loongsuite-pilot] No valid updater version found');
  process.exit(1);
}

// 构建后的 updater 使用 ESM，而此启动垫片使用 CommonJS。
// 将文件路径转换为 file URL，可确保动态导入兼容 POSIX 和 Windows 路径。
import(pathToFileURL(entry).href).catch(err => {
  console.error('[loongsuite-pilot] Failed to load updater:', err.message);
  process.exit(1);
});
