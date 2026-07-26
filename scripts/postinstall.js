#!/usr/bin/env node
/**
 * Post-install script for loongsuite-pilot
 * 
 * This script runs automatically after `npm install` and:
 * 1. Copies hook scripts from assets/hooks/ to ~/.loongsuite-pilot/hooks/
 * 2. Sets permissions with least-privilege defaults
 * 
 * This mirrors the approach used by @ali/loongsuite-pilot
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve paths
const PROJECT_ROOT = path.resolve(__dirname, '..');
const HOOKS_SOURCE_DIR = path.join(PROJECT_ROOT, 'assets', 'hooks');
const SKILLS_SOURCE_DIR = path.join(PROJECT_ROOT, 'assets', 'skills');
const PLUGINS_SOURCE_DIR = path.join(PROJECT_ROOT, 'assets', 'plugins');
const LOONGSUITE_PILOT_DIR = process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '', '.loongsuite-pilot');
const HOOKS_TARGET_DIR = path.join(LOONGSUITE_PILOT_DIR, 'hooks');
const SKILLS_TARGET_DIR = path.join(LOONGSUITE_PILOT_DIR, 'skills');
const PLUGINS_TARGET_DIR = path.join(LOONGSUITE_PILOT_DIR, 'plugins');

/**
 * Ensure directory exists
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Copy file and make it executable
 */
function getFileMode(filePath) {
  // Shell/PowerShell scripts need execute bit; processors do not.
  if (filePath.endsWith('.sh') || filePath.endsWith('.ps1')) return 0o755;
  return 0o644;
}

function installHookFile(sourcePath, targetPath) {
  const content = fs.readFileSync(sourcePath);
  fs.writeFileSync(targetPath, content, { mode: getFileMode(sourcePath) });
}

/**
 * Main installation logic
 */
function main() {
  console.log('[loongsuite-pilot] Installing hook scripts...');

  // Check if source directory exists
  // 判断assets/hooks目录是否存在
  if (!fs.existsSync(HOOKS_SOURCE_DIR)) {
    console.log('[loongsuite-pilot] No hook scripts found, skipping.');
    return;
  }

  // Create target directory
  // 判断$HOME/.loongsuite-pilot/hooks目录是否存在，如果不存在就创建
  ensureDir(HOOKS_TARGET_DIR);

  // Recursively copy all hook scripts (including subdirectories: shared/, claude-code/, codex/)
  let copySuccess = false;
  try {
    // 将项目中的assets/hooks目录的内容拷贝到$HOME/.loongsuite-pilot/hooks目录中
    fs.cpSync(HOOKS_SOURCE_DIR, HOOKS_TARGET_DIR, { recursive: true });
    copySuccess = true;
  } catch (error) {
    console.error('[loongsuite-pilot] Recursive copy failed, falling back to file-by-file:', error.message);
    // Fallback: walk source dir and copy files individually
    try {
      function copyRecursive(src, dest) {
        ensureDir(dest);
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
          const srcPath = path.join(src, entry.name);
          const destPath = path.join(dest, entry.name);
          if (entry.isDirectory()) {
            copyRecursive(srcPath, destPath);
          } else {
            installHookFile(srcPath, destPath);
          }
        }
      }
      copyRecursive(HOOKS_SOURCE_DIR, HOOKS_TARGET_DIR);
      copySuccess = true;
    } catch (fallbackError) {
      console.error('[loongsuite-pilot] File-by-file fallback also failed:', fallbackError.message);
    }
  }

  if (!copySuccess) {
    console.error('[loongsuite-pilot] Hook scripts installation failed. Hooks may not work correctly.');
    return;
  }

  // Ensure .sh files have execute permission (cpSync preserves mode on most OS, belt-and-suspenders)
  let installedCount = 0;
  function fixPermissions(dir) {
    // 同步读取指定目录下所有文件、子目录，并且直接携带每个条目详细类型信息（文件 / 文件夹 / 软链接等），不用额外再调用 fs.stat 判断类型，提升代码效率
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // 如果是目录继续递归调用
        fixPermissions(fullPath);
      } else if (entry.name.endsWith('.sh') || entry.name.endsWith('.ps1')) {
        // 如果是sh文件或是ps1文件，修改文件权限为755
        try { fs.chmodSync(fullPath, 0o755); } catch {}
        installedCount++;
      } else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.py')) {
        // 如果是mjs或者py文件，不做任何处理
        installedCount++;
      }
    }
  }
  fixPermissions(HOOKS_TARGET_DIR);

  console.log(`[loongsuite-pilot] Installed ${installedCount} hook script(s) to ${HOOKS_TARGET_DIR}`);

  if (fs.existsSync(SKILLS_SOURCE_DIR)) {
    try {
      // 将项目的assets/skills中的内容拷贝到$HOME/.loongsuite-pilot/skills目录中
      // recursive参数的作用是开启递归拷贝
      fs.cpSync(SKILLS_SOURCE_DIR, SKILLS_TARGET_DIR, { recursive: true });
      console.log(`[loongsuite-pilot] Installed skill docs to ${SKILLS_TARGET_DIR}`);
    } catch (error) {
      console.error('[loongsuite-pilot] Failed to install skill docs:', error.message);
    }
  }

  if (fs.existsSync(PLUGINS_SOURCE_DIR)) {
    try {
      // 将项目的assets/plugins中的内容拷贝到$HOME/.loongsuite-pilot/plugins目录中
      fs.cpSync(PLUGINS_SOURCE_DIR, PLUGINS_TARGET_DIR, { recursive: true });
      let pluginCount = 0;
      function countPlugins(dir) {
        // 同步读取指定目录下所有文件、子目录，并且直接携带每个条目详细类型信息（文件 / 文件夹 / 软链接等），不用额外再调用 fs.stat 判断类型，提升代码效率
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            // 如果是目录递归调用
            countPlugins(path.join(dir, entry.name));
          } else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) {
            // 如果是mjs或者js文件只是pluginCount加一
            pluginCount++;
          }
        }
      }
      countPlugins(PLUGINS_TARGET_DIR);
      console.log(`[loongsuite-pilot] Installed ${pluginCount} plugin(s) to ${PLUGINS_TARGET_DIR}`);
    } catch (error) {
      console.error('[loongsuite-pilot] Failed to install plugins:', error.message);
    }
  }

  // Place a no-op intercept.js stub at the legacy path.
  // Old otel-claude-hook versions injected NODE_OPTIONS="--require intercept.js" into shell profiles.
  // After upgrade the real file is removed, but already-open terminals still have NODE_OPTIONS set,
  // causing MODULE_NOT_FOUND errors. This stub prevents that.
  // 在旧版文件路径放置一个空实现的占位文件 intercept.js
  // 旧版本的 otel-claude-hook 工具会在系统 Shell 配置文件里注入环境变量：NODE_OPTIONS="--require intercept.js"
  // 升级组件后，真正的 intercept.js 实体文件会被删除；但已经打开的终端窗口依然保留着旧的 NODE_OPTIONS 环境变量
  // 会导致程序抛出「模块找不到（MODULE_NOT_FOUND）」的异常，这份占位文件就是用来规避该报错的
  const legacyIntercept = path.join(process.env.HOME || process.env.USERPROFILE || '', '.cache', 'opentelemetry.instrumentation.claude', 'intercept.js');
  if (!fs.existsSync(legacyIntercept)) {
    try {
      ensureDir(path.dirname(legacyIntercept));
      fs.writeFileSync(legacyIntercept, '/* no-op stub for legacy NODE_OPTIONS --require */\n');
      console.log(`  ✓ Created legacy intercept.js stub`);
    } catch (error) {
      // Non-critical, don't fail
      console.error(`  ✗ Failed to create intercept.js stub:`, error.message);
    }
  }
}

// Run installation
try {
  main();
} catch (error) {
  console.error('[loongsuite-pilot] Post-install failed:', error.message);
}

// Run config migrations (if any exist in this package variant)
const migrationScript = path.join(__dirname, 'migrate-internal-config.js');
// 判断与postinstall.js脚本同级目录下是否存在migrate-internal-config.js脚本，如果存在就执行该脚本并传入.loongsuite-pilot/config.json配置文件
if (fs.existsSync(migrationScript)) {
  try {
    const { migrate } = await import(pathToFileURL(migrationScript).href);
    const dataDir = process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '', '.loongsuite-pilot');
    const configPath = path.join(dataDir, 'config.json');
    if (migrate(configPath)) {
      console.log('[loongsuite-pilot] Config migrated: internal SLS moved to configs/inner/data_config.json');
    }
  } catch (err) {
    console.error('[loongsuite-pilot] Config migration failed (non-fatal):', err.message);
  }
}
