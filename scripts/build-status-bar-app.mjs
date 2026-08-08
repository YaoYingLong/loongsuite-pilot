#!/usr/bin/env node
/**
 * macOS 菜单栏应用构建入口。`build.mjs` 在 macOS 主构建中调用它，它再执行 SwiftPM，
 * 把可执行文件和 BuildInfo 放到打包目录。非 macOS 平台直接跳过。
 *
 * 用法：
 *   node scripts/build-status-bar-app.mjs [--arch arm64|x64|universal]
 *
 * 依赖 Xcode 或匹配的 Command Line Tools。构建子进程通过 `execFileSync/execSync` 同步执行；
 * 本步骤是 best-effort，失败只输出 warning 并保持退出码 0，不阻断 Node.js 主包构建。
 */
import { execSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ES Module（ESM）内置变量 返回当前脚本文件的 file:// 协议 URL 字符串
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 从右向左拼接路径，并自动解析 ./ ../，返回绝对路径, 返回__dirname的上级目录即../loongsuite-pilot
const repoRoot = path.resolve(__dirname, '..');
// 得到../loongsuite-pilot/app/macos-status-bar/Sources/LoongSuitePilotMenuBarApp
const sourceDir = path.join(repoRoot, 'app', 'macos-status-bar', 'Sources', 'LoongSuitePilotMenuBarApp');
const binaryName = 'LoongSuitePilotMenuBarApp';

if (process.platform !== 'darwin') {
  console.log('[status-bar-app] skipped: not macOS');
  process.exit(0);
}

if (!existsSync(path.join(sourceDir, 'AppDelegate.swift'))) {
  console.log('[status-bar-app] skipped: source not found');
  process.exit(0);
}

const requestedArch = process.argv.includes('--arch')
  ? process.argv[process.argv.indexOf('--arch') + 1]
  : process.arch === 'arm64' ? 'arm64' : 'x64';

const archTarget = requestedArch === 'x64' ? 'x86_64-apple-macosx13.0' : 'arm64-apple-macosx13.0';
const outDirName = `darwin-${requestedArch}`;
const outDir = path.join(repoRoot, 'app', 'macos-status-bar', 'bin', outDirName);
const outPath = path.join(outDir, binaryName);

const sdkPath = '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk';
const xcodeSdkPath = '/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk';

const resolvedSdk = existsSync(xcodeSdkPath) ? xcodeSdkPath : sdkPath;

const xcodeSwift = '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc';
const swiftc = existsSync(xcodeSwift) ? xcodeSwift : 'swiftc';

const sourceFiles = path.join(sourceDir, '*.swift');

console.log(`[status-bar-app] building ${outDirName} with ${swiftc === 'swiftc' ? 'system swiftc' : 'Xcode swiftc'}`);

try {
  mkdirSync(outDir, { recursive: true });

  const cmd = [
    swiftc,
    '-O',
    '-target', archTarget,
    '-sdk', resolvedSdk,
    '-o', outPath,
    '-framework', 'AppKit',
    '-framework', 'SwiftUI',
    '-framework', 'Charts',
    '-framework', 'Combine',
  ];

  // swiftc 不支持 glob，因此需要手工列出源文件。
  const { readdirSync } = await import('node:fs');
  const swiftFiles = readdirSync(sourceDir)
    .filter(f => f.endsWith('.swift'))
    .map(f => path.join(sourceDir, f));

  const fullCmd = [...cmd.slice(1), ...swiftFiles];

  execFileSync(cmd[0], fullCmd, {
    stdio: 'pipe',
    timeout: 180_000,
    env: {
      ...process.env,
      ...(existsSync('/Applications/Xcode.app/Contents/Developer')
        ? { DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer' }
        : {}),
    },
  });

  console.log(`[status-bar-app] built: ${outPath}`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  const stderr = err.stderr?.toString?.()?.slice(0, 500) ?? '';
  console.warn(`[status-bar-app] build failed (non-fatal): ${message}`);
  if (stderr) console.warn(`[status-bar-app] stderr: ${stderr}`);
  process.exit(0);
}
