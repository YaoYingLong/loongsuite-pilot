/**
 * plugin-migration.ts — 清理老 Claude/Codex plugin 残留。
 *
 * 在 DeploymentManager.deployAll() 入口最先运行（阶段 0）。Q15 决策：每次启动扫描，
 * 不写 marker 文件;若 cache 目录不存在则快速跳过(纳秒级 fs.exists 调用)。
 *
 * 完全 fail-open:任何一步失败 logger.warn + 继续,不阻断 deployAll。
 *
 * Claude 清理(R10):
 *   1. ~/.cache/opentelemetry.instrumentation.claude/ 存在 → 进入清理
 *   2. parse ~/.claude/settings.json,删 hooks.* 中含 "otel-claude-hook" 或
 *      "/.cache/opentelemetry.instrumentation.claude" 的 command
 *   3. rm ~/.claude/otel-config.json
 *   4. 扫 ~/.bashrc / ~/.zshrc / ~/.bash_profile,删 # BEGIN otel-claude-hook ... # END 段
 *   5. rm -rf ~/.cache/opentelemetry.instrumentation.claude/
 *
 * Codex 清理(R11):
 *   1. ~/.cache/opentelemetry.instrumentation.codex/ 存在 → 进入清理
 *   2. parse ~/.codex/hooks.json,删含 otel-codex-hook 的条目
 *   3. 改 ~/.codex/config.toml:
 *      - 清 # OpenTelemetry instrumentation hooks marker 段(legacy [[hooks.X]] 段;
 *        支持两种历史 shape:含 command 的 / 仅 type 的空段)
 *      - 删 codex_hooks = true(legacy alias);[features] 段空了一并删
 *      - **不在这里删 BEGIN/END trust block** — 留给 hook-strategy 用同名 marker 自然替换,
 *        避免一次 write 一次 read 来回操作
 *   4. rm ~/.codex/otel-config.json
 *   5. rm -rf ~/.cache/opentelemetry.instrumentation.codex/
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('PluginMigration');

export interface PluginMigrationStepReport {
  stage: string;
  ok: boolean;
  detail?: string;
}

export interface PluginMigrationReport {
  claude: { migrated: boolean; steps: PluginMigrationStepReport[] };
  codex: { migrated: boolean; steps: PluginMigrationStepReport[] };
}

/** 解析要清理的用户 HOME。 */
function home(): string { return process.env.HOME || os.homedir(); }

/** 容错同步存在性检查；权限等异常按不存在处理。 */
function safeExistsSync(p: string): boolean {
  try { return fs.existsSync(p); } catch { return false; }
}

/** 递归删除并把成功/跳过/失败写入 steps，永不向迁移主链抛出。 */
async function safeRmRf(p: string, steps: PluginMigrationStepReport[], stage: string): Promise<void> {
  try {
    if (safeExistsSync(p)) {
      await fsp.rm(p, { recursive: true, force: true });
      steps.push({ stage, ok: true, detail: `removed ${p}` });
    } else {
      steps.push({ stage, ok: true, detail: `not present ${p}` });
    }
  } catch (err) {
    steps.push({ stage, ok: false, detail: `${p}: ${(err as Error).message}` });
    logger.warn('rm -rf failed', { path: p, error: String(err) });
  }
}

/** 删除单文件并记录步骤；不存在视为成功幂等。 */
async function safeUnlink(p: string, steps: PluginMigrationStepReport[], stage: string): Promise<void> {
  try {
    if (safeExistsSync(p)) {
      await fsp.unlink(p);
      steps.push({ stage, ok: true, detail: `removed ${p}` });
    } else {
      steps.push({ stage, ok: true, detail: `not present ${p}` });
    }
  } catch (err) {
    steps.push({ stage, ok: false, detail: `${p}: ${(err as Error).message}` });
    logger.warn('unlink failed', { path: p, error: String(err) });
  }
}

// ─── Claude 清理 ───

/** 判断命令是否引用历史 Claude OTel Hook/cache。 */
function isClaudeOldPath(s: string): boolean {
  return typeof s === 'string'
    && (s.includes('otel-claude-hook') || s.includes('.cache/opentelemetry.instrumentation.claude'));
}

/** 读取 Claude settings，删除 nested/flat 历史 Hook，保留第三方条目。 */
async function cleanClaudeSettings(steps: PluginMigrationStepReport[]): Promise<void> {
  const settingsPath = path.join(home(), '.claude', 'settings.json');
  if (!safeExistsSync(settingsPath)) {
    steps.push({ stage: 'claude_settings', ok: true, detail: 'settings.json not present' });
    return;
  }
  try {
    const raw = await fsp.readFile(settingsPath, 'utf-8');
    let data: any;
    try { data = JSON.parse(raw); } catch {
      steps.push({ stage: 'claude_settings', ok: false, detail: 'settings.json invalid JSON' });
      return;
    }
    if (!data || !data.hooks || typeof data.hooks !== 'object') {
      steps.push({ stage: 'claude_settings', ok: true, detail: 'no hooks section' });
      return;
    }
    let removed = 0;
    for (const event of Object.keys(data.hooks)) {
      const arr = data.hooks[event];
      if (!Array.isArray(arr)) continue;
      const filtered = arr
        .map((entry: any) => {
          // 嵌套格式：{hooks: [{command}]}。
          if (Array.isArray(entry?.hooks)) {
            const subFiltered = entry.hooks.filter((h: any) => !isClaudeOldPath(h?.command));
            if (subFiltered.length === entry.hooks.length) return entry;
            removed += entry.hooks.length - subFiltered.length;
            return subFiltered.length === 0 ? null : { ...entry, hooks: subFiltered };
          }
          // 扁平格式：{command}。
          if (isClaudeOldPath(entry?.command)) {
            removed++;
            return null;
          }
          return entry;
        })
        .filter((e: any) => e !== null);
      if (filtered.length === 0) {
        delete data.hooks[event];
      } else {
        data.hooks[event] = filtered;
      }
    }
    if (removed === 0) {
      steps.push({ stage: 'claude_settings', ok: true, detail: 'no otel-claude-hook entries' });
      return;
    }
    await fsp.writeFile(settingsPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    steps.push({ stage: 'claude_settings', ok: true, detail: `removed ${removed} entries` });
  } catch (err) {
    steps.push({ stage: 'claude_settings', ok: false, detail: (err as Error).message });
    logger.warn('claude settings cleanup failed', { error: String(err) });
  }
}

/** 从常见 shell rc 删除旧 Claude marker 区块。 */
async function cleanClaudeShellAliases(steps: PluginMigrationStepReport[]): Promise<void> {
  const targets = ['.bashrc', '.zshrc', '.bash_profile'];
  const re = /\n?# BEGIN otel-claude-hook\n[\s\S]*?# END otel-claude-hook\n?/g;
  for (const f of targets) {
    const p = path.join(home(), f);
    if (!safeExistsSync(p)) continue;
    try {
      const content = await fsp.readFile(p, 'utf-8');
      if (!content.includes('# BEGIN otel-claude-hook')) continue;
      const replaced = content.replace(re, '\n');
      await fsp.writeFile(p, replaced, 'utf-8');
      steps.push({ stage: 'claude_alias', ok: true, detail: `cleaned ${p}` });
    } catch (err) {
      steps.push({ stage: 'claude_alias', ok: false, detail: `${p}: ${(err as Error).message}` });
      logger.warn('claude alias cleanup failed', { path: p, error: String(err) });
    }
  }
}

/** cache 存在时执行 Claude 全套清理，否则返回 migrated=false。 */
async function migrateClaude(): Promise<{ migrated: boolean; steps: PluginMigrationStepReport[] }> {
  const cacheDir = path.join(home(), '.cache', 'opentelemetry.instrumentation.claude');
  const steps: PluginMigrationStepReport[] = [];
  if (!safeExistsSync(cacheDir)) {
    return { migrated: false, steps: [{ stage: 'detect', ok: true, detail: 'no claude plugin residue' }] };
  }
  logger.info('cleaning up old claude plugin residue');
  await cleanClaudeSettings(steps);
  await safeUnlink(path.join(home(), '.claude', 'otel-config.json'), steps, 'claude_otel_config');
  await cleanClaudeShellAliases(steps);
  await safeRmRf(cacheDir, steps, 'claude_cache_dir');
  return { migrated: true, steps };
}

// ─── Codex 清理 ───

/** 判断命令是否引用历史 Codex OTel Hook/cache。 */
function isCodexOldPath(s: string): boolean {
  return typeof s === 'string'
    && (s.includes('otel-codex-hook') || s.includes('.cache/opentelemetry.instrumentation.codex'));
}

/** 从 Codex hooks.json 删除 nested/flat 历史 Hook，保留第三方条目。 */
async function cleanCodexHooksJson(steps: PluginMigrationStepReport[]): Promise<void> {
  const hooksPath = path.join(home(), '.codex', 'hooks.json');
  if (!safeExistsSync(hooksPath)) {
    steps.push({ stage: 'codex_hooks_json', ok: true, detail: 'hooks.json not present' });
    return;
  }
  try {
    const raw = await fsp.readFile(hooksPath, 'utf-8');
    let data: any;
    try { data = JSON.parse(raw); } catch {
      steps.push({ stage: 'codex_hooks_json', ok: false, detail: 'invalid JSON' });
      return;
    }
    if (!data?.hooks || typeof data.hooks !== 'object') {
      steps.push({ stage: 'codex_hooks_json', ok: true, detail: 'no hooks section' });
      return;
    }
    let removed = 0;
    for (const event of Object.keys(data.hooks)) {
      const arr = data.hooks[event];
      if (!Array.isArray(arr)) continue;
      const filtered = arr
        .map((entry: any) => {
          if (Array.isArray(entry?.hooks)) {
            const subFiltered = entry.hooks.filter((h: any) => !isCodexOldPath(h?.command));
            if (subFiltered.length === entry.hooks.length) return entry;
            removed += entry.hooks.length - subFiltered.length;
            return subFiltered.length === 0 ? null : { ...entry, hooks: subFiltered };
          }
          if (isCodexOldPath(entry?.command)) {
            removed++;
            return null;
          }
          return entry;
        })
        .filter((e: any) => e !== null);
      if (filtered.length === 0) {
        delete data.hooks[event];
      } else {
        data.hooks[event] = filtered;
      }
    }
    if (Object.keys(data.hooks).length === 0) {
      await fsp.unlink(hooksPath);
      steps.push({ stage: 'codex_hooks_json', ok: true, detail: 'hooks.json removed (empty)' });
      return;
    }
    if (removed === 0) {
      steps.push({ stage: 'codex_hooks_json', ok: true, detail: 'no otel-codex-hook entries' });
      return;
    }
    await fsp.writeFile(hooksPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    steps.push({ stage: 'codex_hooks_json', ok: true, detail: `removed ${removed} entries` });
  } catch (err) {
    steps.push({ stage: 'codex_hooks_json', ok: false, detail: (err as Error).message });
    logger.warn('codex hooks.json cleanup failed', { error: String(err) });
  }
}

/**
 * 清 codex config.toml 中的 legacy hook 段:
 *   1. # OpenTelemetry instrumentation hooks marker + 后续 [[hooks.X]] 段
 *   2. codex_hooks = true(legacy alias);[features] 段空了一并删
 *
 * 不动 BEGIN/END otel-codex-hook trust block — hook-strategy 写新 trust 时用同名 marker
 * 自然替换。
 */
/** 清 config.toml legacy Hook/feature alias，trust block 留给新策略替换。 */
async function cleanCodexConfigToml(steps: PluginMigrationStepReport[]): Promise<void> {
  const configPath = path.join(home(), '.codex', 'config.toml');
  if (!safeExistsSync(configPath)) {
    steps.push({ stage: 'codex_config_toml', ok: true, detail: 'config.toml not present' });
    return;
  }
  try {
    let content = await fsp.readFile(configPath, 'utf-8');
    const before = content;

    // 步骤 1：清理旧版 marker 区段。
    content = removeLegacyMarkerHooks(content);

    // 步骤 2：删除 codex_hooks 行及空的 [features] 区段。
    content = removeCodexHooksAlias(content);

    if (content === before) {
      steps.push({ stage: 'codex_config_toml', ok: true, detail: 'no legacy hook entries' });
      return;
    }
    content = content.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
    await fsp.writeFile(configPath, content, 'utf-8');
    steps.push({ stage: 'codex_config_toml', ok: true, detail: 'cleaned legacy hooks' });
  } catch (err) {
    steps.push({ stage: 'codex_config_toml', ok: false, detail: (err as Error).message });
    logger.warn('codex config.toml cleanup failed', { error: String(err) });
  }
}

/**
 * 清 # OpenTelemetry instrumentation hooks marker 段(支持两种 shape:
 *   - 含 command 的 [[hooks.X]] 段
 *   - 仅 type 的空 [[hooks.X]] 段(极老插件残留)
 */
/**
 * 从 TOML 文本删除历史 OpenTelemetry marker 及相邻旧 section；不执行文件 I/O。
 */
function removeLegacyMarkerHooks(content: string): string {
  const marker = '# OpenTelemetry instrumentation hooks';
  if (!content.includes(marker) && !content.includes('otel-codex-hook')) return content;

  const lines = content.split('\n');
  const out: string[] = [];
  const hooksArrayHeader = /^\s*\[\[hooks\.[A-Za-z][A-Za-z0-9_]*\]\]\s*$/;
  const anyHeader = /^\s*\[/;

  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trim() === marker) {
      i++;
      while (i < lines.length) {
        const line = lines[i]!;
        const trimmed = line.trim();
        if (trimmed === '') { i++; continue; }
        if (hooksArrayHeader.test(line)) {
          i++;
          while (i < lines.length) {
            const t = lines[i]!.trim();
            if (t === '' || anyHeader.test(lines[i]!)) break;
            i++;
          }
          continue;
        }
        break;
      }
      continue;
    }
    // 流浪的 otel-codex-hook 行(在 marker 块外)
    if (
      lines[i]!.includes('otel-codex-hook')
      && !lines[i]!.includes('# BEGIN otel-codex-hook')
      && !lines[i]!.includes('# END otel-codex-hook')
    ) {
      i++;
      continue;
    }
    out.push(lines[i]!);
    i++;
  }
  return out.join('\n');
}

/** 删除 `[features]` 中旧 codex_hooks alias，并移除清空后的 section。 */
function removeCodexHooksAlias(content: string): string {
  if (!content.includes('codex_hooks')) return content;
  const lines = content.split('\n').filter((l) => !/^\s*codex_hooks\s*=/.test(l));
  // 如果 [features] 段下没有任何字段了,顺带删 [features] 行
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\[features\]\s*$/.test(line)) {
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim() === '') j++;
      if (j >= lines.length || /^\[/.test(lines[j]!)) {
        i = j - 1; // 跳过已处理的 [features] 区段。
        continue;
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

/** cache 存在时执行 Codex 全套清理，否则返回 migrated=false。 */
async function migrateCodex(): Promise<{ migrated: boolean; steps: PluginMigrationStepReport[] }> {
  const cacheDir = path.join(home(), '.cache', 'opentelemetry.instrumentation.codex');
  const steps: PluginMigrationStepReport[] = [];
  if (!safeExistsSync(cacheDir)) {
    return { migrated: false, steps: [{ stage: 'detect', ok: true, detail: 'no codex plugin residue' }] };
  }
  logger.info('cleaning up old codex plugin residue');
  await cleanCodexHooksJson(steps);
  await cleanCodexConfigToml(steps);
  await safeUnlink(path.join(home(), '.codex', 'otel-config.json'), steps, 'codex_otel_config');
  await safeRmRf(cacheDir, steps, 'codex_cache_dir');
  return { migrated: true, steps };
}

// DeploymentManager 在阶段 0 调用的公共入口。

/**
 * 顺序运行 Claude 与 Codex 迁移并返回逐步骤报告；子步骤均 fail-open。
 */
export async function runPluginMigration(): Promise<PluginMigrationReport> {
  const claude = await migrateClaude();
  const codex = await migrateCodex();
  if (claude.migrated || codex.migrated) {
    logger.info('plugin migration complete', {
      claude_migrated: claude.migrated,
      codex_migrated: codex.migrated,
    });
  }
  return { claude, codex };
}
