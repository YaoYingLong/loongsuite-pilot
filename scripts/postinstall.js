#!/usr/bin/env node
/**
 * Post-install script for loongsuite-pilot
 * 
 * This script runs automatically after `npm install` and:
 * 1. Copies hook scripts from assets/hooks/ to ~/.loongsuite-pilot/hooks/
 * 2. Sets permissions with least-privilege defaults
 * 3. Copies bundled skill docs when the package variant contains them
 * 4. Runs package-local config migrations when available
 * 
 * This mirrors the approach used by @ali/loongsuite-pilot
 *
 * Keep this script self-contained and tolerant of partial failures:
 * postinstall is executed in many package-manager environments, and a failed
 * optional migration or compatibility stub should not make `npm install` fail.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve package and install paths once at startup.  The package root is the
// parent directory of scripts/, while the writable data directory defaults to
// ~/.loongsuite-pilot and can be overridden for tests or custom deployments.
const PROJECT_ROOT = path.resolve(__dirname, '..');
const HOOKS_SOURCE_DIR = path.join(PROJECT_ROOT, 'assets', 'hooks');
const SKILLS_SOURCE_DIR = path.join(PROJECT_ROOT, 'assets', 'skills');
const LOONGSUITE_PILOT_DIR = process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(process.env.HOME || '', '.loongsuite-pilot');
const HOOKS_TARGET_DIR = path.join(LOONGSUITE_PILOT_DIR, 'hooks');
const SKILLS_TARGET_DIR = path.join(LOONGSUITE_PILOT_DIR, 'skills');

/**
 * Ensure directory exists.
 *
 * All target directories are user-writable data paths, so recursive creation is
 * enough here.  Callers do not need to care whether the parent directory has
 * already been created by a previous install, service start, or manual setup.
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Return the least-privilege mode for installed files.
 *
 * Hook entrypoints must be executable because IDEs and CLIs may invoke them
 * directly.  Processor modules and helper files are read by those entrypoints,
 * so they keep normal read/write permissions instead of getting an execute bit.
 */
function getFileMode(filePath) {
  // Shell/PowerShell scripts need execute bit; processors do not.
  if (filePath.endsWith('.sh') || filePath.endsWith('.ps1')) return 0o755;
  return 0o644;
}

/**
 * Copy one hook-related file using the mode selected above.
 *
 * This is used by the manual recursive fallback below.  The preferred cpSync
 * path can preserve directory trees in one operation, but older Node versions or
 * unusual filesystems may fail there; the fallback keeps installation useful.
 */
function installHookFile(sourcePath, targetPath) {
  const content = fs.readFileSync(sourcePath);
  fs.writeFileSync(targetPath, content, { mode: getFileMode(sourcePath) });
}

/**
 * Main installation logic
 */
function main() {
  console.log('[loongsuite-pilot] Installing hook scripts...');

  // Check if source directory exists.  Some package variants may not bundle
  // hook assets, so missing hooks are treated as a normal no-op.
  if (!fs.existsSync(HOOKS_SOURCE_DIR)) {
    console.log('[loongsuite-pilot] No hook scripts found, skipping.');
    return;
  }

  // Create the target before copying; nested subdirectories are handled by
  // cpSync or by the recursive fallback below.
  ensureDir(HOOKS_TARGET_DIR);

  // Recursively copy all hook scripts, including agent-specific and shared
  // subdirectories such as shared/, claude-code/, and codex/.
  let copySuccess = false;
  try {
    fs.cpSync(HOOKS_SOURCE_DIR, HOOKS_TARGET_DIR, { recursive: true });
    copySuccess = true;
  } catch (error) {
    console.error('[loongsuite-pilot] Recursive copy failed, falling back to file-by-file:', error.message);
    // Fallback: walk source dir and copy files individually.  Directories are
    // created before visiting their children, and files are written with the
    // explicit mode from getFileMode().
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

  // Ensure executable hooks still have the execute bit after the recursive
  // copy.  cpSync preserves modes on most platforms, but npm package extraction,
  // archives, and cross-platform installs can normalize them.  Count executable
  // scripts plus processor files so the install log reports the full hook set.
  let installedCount = 0;
  function fixPermissions(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        fixPermissions(fullPath);
      } else if (entry.name.endsWith('.sh') || entry.name.endsWith('.ps1')) {
        try { fs.chmodSync(fullPath, 0o755); } catch {}
        installedCount++;
      } else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.py')) {
        installedCount++;
      }
    }
  }
  fixPermissions(HOOKS_TARGET_DIR);

  console.log(`[loongsuite-pilot] Installed ${installedCount} hook script(s) to ${HOOKS_TARGET_DIR}`);

  // Skill docs are optional package assets.  Install them next to hooks so
  // downstream tooling can discover local skill documentation from the same data
  // root without depending on the package installation directory.
  if (fs.existsSync(SKILLS_SOURCE_DIR)) {
    try {
      fs.cpSync(SKILLS_SOURCE_DIR, SKILLS_TARGET_DIR, { recursive: true });
      console.log(`[loongsuite-pilot] Installed skill docs to ${SKILLS_TARGET_DIR}`);
    } catch (error) {
      console.error('[loongsuite-pilot] Failed to install skill docs:', error.message);
    }
  }

  // Place a no-op intercept.js stub at the legacy path.
  //
  // Old otel-claude-hook versions injected NODE_OPTIONS="--require intercept.js"
  // into shell profiles.  After upgrade the real file is removed, but already
  // open terminals may still inherit NODE_OPTIONS and ask Node to require it,
  // causing MODULE_NOT_FOUND before any loongsuite-pilot code can run.  Creating
  // an empty module at the old path makes those stale environments harmless.
  const legacyIntercept = path.join(process.env.HOME || '', '.cache', 'opentelemetry.instrumentation.claude', 'intercept.js');
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

// Run installation.  Errors are logged but not rethrown because postinstall
// should be best-effort: the package can still be installed and diagnosed even
// when hook deployment is blocked by the local environment.
try {
  main();
} catch (error) {
  console.error('[loongsuite-pilot] Post-install failed:', error.message);
}

// Run config migrations, if this package variant includes them.  Open-source
// and internal packages may not ship the same migration scripts, so the dynamic
// import is guarded by an existence check and migration failures are non-fatal.
const migrationScript = path.join(__dirname, 'migrate-internal-config.js');
if (fs.existsSync(migrationScript)) {
  try {
    const { migrate } = await import(pathToFileURL(migrationScript).href);
    const dataDir = process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(process.env.HOME || '', '.loongsuite-pilot');
    const configPath = path.join(dataDir, 'config.json');
    if (migrate(configPath)) {
      console.log('[loongsuite-pilot] Config migrated: internal SLS moved to configs/inner/data_config.json');
    }
  } catch (err) {
    console.error('[loongsuite-pilot] Config migration failed (non-fatal):', err.message);
  }
}
