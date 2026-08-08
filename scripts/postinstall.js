#!/usr/bin/env node
/**
 * npm 安装后置入口。安装器在版本目录完成生产依赖安装时会触发它，源码构建也可手动执行。
 *
 * 它把 `assets/hooks`、`assets/skills`、`assets/plugins` 复制到 Pilot 数据目录，设置脚本权限，
 * 清理旧 Claude preload 遗留，并以 fail-open 方式运行可选迁移。这里仅部署资产文件；
 * 把 Hook 配置写入各 Agent 的动作由 Collector 启动后的 `DeploymentManager.deployAll()` 完成。
 *
 * 输入来自项目目录与 `LOONGSUITE_PILOT_DATA_DIR`，输出是本地文件；必需复制失败会抛异常，
 * 顶层捕获后设置非零退出码，从而让 npm/安装器感知失败。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 从当前 ESM 文件 URL 还原项目根目录，并集中计算源资产和用户数据目标路径。
const PROJECT_ROOT = path.resolve(__dirname, '..');
const HOOKS_SOURCE_DIR = path.join(PROJECT_ROOT, 'assets', 'hooks');
const SKILLS_SOURCE_DIR = path.join(PROJECT_ROOT, 'assets', 'skills');
const PLUGINS_SOURCE_DIR = path.join(PROJECT_ROOT, 'assets', 'plugins');
const LOONGSUITE_PILOT_DIR = process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '', '.loongsuite-pilot');
const HOOKS_TARGET_DIR = path.join(LOONGSUITE_PILOT_DIR, 'hooks');
const SKILLS_TARGET_DIR = path.join(LOONGSUITE_PILOT_DIR, 'skills');
const PLUGINS_TARGET_DIR = path.join(LOONGSUITE_PILOT_DIR, 'plugins');

/**
 * 以类似 `mkdir -p` 的语义同步确保目录存在。
 * @param {string} dirPath 要创建的绝对或相对路径。
 * @returns {void}
 * @throws {Error} 权限不足或父路径不是目录时由上层安装流程处理。
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * 根据文件扩展名选择最小权限：Shell/PowerShell 需要可执行位，其他处理器只需读写。
 * @param {string} filePath 源文件路径，仅使用扩展名判断。
 * @returns {number} 可传给 Node.js fs 的八进制 mode。
 */
function getFileMode(filePath) {
  // Shell/PowerShell 脚本需要执行位；由 Node 读取的处理器不需要。
  if (filePath.endsWith('.sh') || filePath.endsWith('.ps1')) return 0o755;
  return 0o644;
}

/**
 * 同步复制单个 Hook 文件并应用 `getFileMode()` 权限，供递归复制失败后的回退路径调用。
 * @throws {Error} 读取或写入失败时抛给外层 fallback catch。
 */
function installHookFile(sourcePath, targetPath) {
  const content = fs.readFileSync(sourcePath);
  fs.writeFileSync(targetPath, content, { mode: getFileMode(sourcePath) });
}

/**
 * 执行资产安装主流程。必需 hooks 先尝试 `cpSync(recursive)`，失败后逐文件回退；
 * skills/plugins 和旧 preload stub 属于可选步骤，各自失败只记录而不阻断 npm install。
 * @returns {void}
 */
function main() {
  console.log('[loongsuite-pilot] Installing hook scripts...');

  // 判断assets/hooks目录是否存在
  if (!fs.existsSync(HOOKS_SOURCE_DIR)) {
    console.log('[loongsuite-pilot] No hook scripts found, skipping.');
    return;
  }

  // 判断$HOME/.loongsuite-pilot/hooks目录是否存在，如果不存在就创建
  ensureDir(HOOKS_TARGET_DIR);

  // 优先递归复制全部 Hook 子目录（shared、claude-code、codex 等）。
  let copySuccess = false;
  try {
    // 将项目中的assets/hooks目录的内容拷贝到$HOME/.loongsuite-pilot/hooks目录中
    fs.cpSync(HOOKS_SOURCE_DIR, HOOKS_TARGET_DIR, { recursive: true });
    copySuccess = true;
  } catch (error) {
    console.error('[loongsuite-pilot] Recursive copy failed, falling back to file-by-file:', error.message);
    // 回退方案：手工遍历目录并逐个复制，使旧 Node/特殊文件系统仍可安装。
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

  // 即使 cpSync 通常保留 mode，仍再次确保 .sh/.ps1 具有执行权限，覆盖不同平台差异。
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

  // 在旧路径放置 no-op stub，避免已打开终端残留 NODE_OPTIONS 时因真实 intercept.js 被移除而报错。
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
      // 兼容占位文件不是核心安装条件，失败只记录，不改变安装退出行为。
      console.error(`  ✗ Failed to create intercept.js stub:`, error.message);
    }
  }
}

// 顶层直接执行同步安装；捕获异常后打印诊断，避免可选后置脚本让 npm 包完全不可安装。
try {
  main();
} catch (error) {
  console.error('[loongsuite-pilot] Post-install failed:', error.message);
}

// 某些包变体会携带配置迁移模块；动态 import 只在文件存在时执行，并保持 fail-open。
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
