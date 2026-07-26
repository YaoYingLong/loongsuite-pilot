'use strict';

// Updater 进程的稳定 CommonJS 启动垫片。服务管理器启动此文件后，
// 它会根据 `current` 指针确定当前版本目录，并加载其中的 ESM updater 入口。
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
