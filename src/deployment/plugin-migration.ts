/**
 * Claude/Codex 历史 OTel 插件残留的启动期迁移器。
 *
 * `DeploymentManager.deployAll()` 在加载并部署当前 `agents.d` 声明之前首先调用
 * `runPluginMigration()`。本模块没有长期实例、timer 或网络请求；它以用户 HOME 为输入，
 * 修改旧 Hook 配置、shell rc、OTel 配置和 cache 目录，并返回逐步骤报告供日志与测试检查。
 * 每个步骤都在自己的错误边界内记录 `logger.warn` 后继续，迁移失败不会阻断其他 Agent
 * 的当前版本部署，这就是这里所说的 fail-open。
 *
 * 两条迁移都把相应的旧 cache 目录作为执行门槛：cache 不存在时整条链快速跳过，即使
 * settings/rc 中仍有孤立旧配置也不会清理（当前兼容行为，维护时不要误认为它会全盘扫描）。
 *
 * Claude 迁移顺序：
 * 1. 从 `~/.claude/settings.json` 的扁平或嵌套 hooks 中删除旧插件命令；
 * 2. 删除 `~/.claude/otel-config.json`；
 * 3. 从 `.bashrc`、`.zshrc`、`.bash_profile` 删除旧 marker 区块；
 * 4. 最后递归删除 `~/.cache/opentelemetry.instrumentation.claude/`。
 *
 * Codex 迁移顺序：
 * 1. 从 `~/.codex/hooks.json` 删除旧 Hook；
 * 2. 清理 `config.toml` 的历史 `[[hooks.X]]` 区段和 `codex_hooks` feature alias；
 * 3. 保留 BEGIN/END trust block，交给当前 `HookStrategy` 用同名 marker 幂等替换；
 * 4. 删除旧 OTel 配置，最后递归删除 Codex cache 目录。
 */

// 同步 fs 只用于低成本存在性门控；真正的读写/删除使用 Promise API，避免长操作阻塞事件循环。
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
// 所有目标路径都通过 path.join 生成，兼容 Windows 与 Unix 分隔符。
import * as path from 'node:path';
// `os.homedir()` 是 HOME 未设置时的跨平台兜底。
import * as os from 'node:os';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('PluginMigration');

/** 一项迁移动作的可诊断结果；失败步骤不会阻断后续动作。 */
export interface PluginMigrationStepReport {
  /** 稳定阶段名，调用方/日志可据此定位 settings、alias、cache 等步骤。 */
  stage: string;
  /** 当前动作是否成功；目标不存在也按幂等成功处理。 */
  ok: boolean;
  /** 面向日志的英文细节，可能包含目标路径、删除数量或错误消息。 */
  detail?: string;
}

/** Claude 与 Codex 两条迁移链的完整结果。 */
export interface PluginMigrationReport {
  /** Claude 旧插件是否命中 cache 门槛，以及执行过的各步骤。 */
  claude: { migrated: boolean; steps: PluginMigrationStepReport[] };
  /** Codex 旧插件是否命中 cache 门槛，以及执行过的各步骤。 */
  codex: { migrated: boolean; steps: PluginMigrationStepReport[] };
}

/**
 * 解析要清理的用户 HOME。
 * 安装脚本可显式注入 HOME；否则使用 Node 的平台 API。函数不验证目录是否存在。
 */
function home(): string { return process.env.HOME || os.homedir(); }

/** 容错同步存在性检查；权限等异常按不存在处理。 */
function safeExistsSync(p: string): boolean {
  try { return fs.existsSync(p); } catch { return false; }
}

/** 递归删除并把成功/跳过/失败写入 steps，永不向迁移主链抛出。 */
async function safeRmRf(p: string, steps: PluginMigrationStepReport[], stage: string): Promise<void> {
  try {
    if (safeExistsSync(p)) {
      // force 允许并发清理导致目标在 rm 前消失；recursive 负责 cache 的完整目录树。
      await fsp.rm(p, { recursive: true, force: true });
      steps.push({ stage, ok: true, detail: `removed ${p}` });
    } else {
      steps.push({ stage, ok: true, detail: `not present ${p}` });
    }
  } catch (err) {
    // 报告与结构化日志同时保留失败，但函数正常兑现以继续执行剩余迁移步骤。
    steps.push({ stage, ok: false, detail: `${p}: ${(err as Error).message}` });
    logger.warn('rm -rf failed', { path: p, error: String(err) });
  }
}

/** 删除单文件并记录步骤；不存在视为成功幂等。 */
async function safeUnlink(p: string, steps: PluginMigrationStepReport[], stage: string): Promise<void> {
  try {
    if (safeExistsSync(p)) {
      // 此处目标约定为单文件，故意不用 recursive rm，避免路径配置异常时扩大删除范围。
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
  // 只操作当前 HOME 下 Claude 的用户级 settings，不扫描项目级配置。
  const settingsPath = path.join(home(), '.claude', 'settings.json');
  if (!safeExistsSync(settingsPath)) {
    steps.push({ stage: 'claude_settings', ok: true, detail: 'settings.json not present' });
    return;
  }
  try {
    // 先读完整 UTF-8 文本再 parse；迁移不会尝试修复损坏 JSON。
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
    // hooks 的 key 是事件名；每个事件数组独立过滤，未知事件和非数组值原样保留。
    for (const event of Object.keys(data.hooks)) {
      const arr = data.hooks[event];
      if (!Array.isArray(arr)) continue;
      const filtered = arr
        .map((entry: any) => {
          // 嵌套格式：{hooks: [{command}]}。
          if (Array.isArray(entry?.hooks)) {
            const subFiltered = entry.hooks.filter((h: any) => !isClaudeOldPath(h?.command));
            // 子数组完全未变化时返回原对象，避免无意义重写其余未知字段。
            if (subFiltered.length === entry.hooks.length) return entry;
            removed += entry.hooks.length - subFiltered.length;
            // 嵌套 hooks 被清空时移除整个 wrapper；否则浅拷贝并保留 matcher 等第三方字段。
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
        // 事件已无任何 Hook 时删除 key；保留空事件数组没有部署意义。
        delete data.hooks[event];
      } else {
        data.hooks[event] = filtered;
      }
    }
    if (removed === 0) {
      // 没命中旧条目时不重写 JSON，避免仅因格式化造成用户配置 churn。
      steps.push({ stage: 'claude_settings', ok: true, detail: 'no otel-claude-hook entries' });
      return;
    }
    // 命中后以两空格格式化覆盖原文件；该迁移没有临时文件/rename 原子写保护。
    await fsp.writeFile(settingsPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    steps.push({ stage: 'claude_settings', ok: true, detail: `removed ${removed} entries` });
  } catch (err) {
    steps.push({ stage: 'claude_settings', ok: false, detail: (err as Error).message });
    logger.warn('claude settings cleanup failed', { error: String(err) });
  }
}

/** 从常见 shell rc 删除旧 Claude marker 区块。 */
async function cleanClaudeShellAliases(steps: PluginMigrationStepReport[]): Promise<void> {
  // 当前只覆盖三种常见用户启动文件，不处理 fish/profile.d 等其他 shell 配置。
  const targets = ['.bashrc', '.zshrc', '.bash_profile'];
  // [\s\S]*? 以非贪婪方式跨行匹配每一对 marker，前后换行也一并收敛。
  const re = /\n?# BEGIN otel-claude-hook\n[\s\S]*?# END otel-claude-hook\n?/g;
  for (const f of targets) {
    const p = path.join(home(), f);
    if (!safeExistsSync(p)) continue;
    try {
      const content = await fsp.readFile(p, 'utf-8');
      // 快速字符串门控可避免没有 marker 的 rc 文件被无意义重写。
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
    // cache 是整条迁移链的检测门槛：只有 settings/rc 残留但 cache 已不存在时不会在此清理。
    return { migrated: false, steps: [{ stage: 'detect', ok: true, detail: 'no claude plugin residue' }] };
  }
  logger.info('cleaning up old claude plugin residue');
  // 各 helper 自己捕获错误，所以后一步不会因前一步失败而被跳过。
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
  // 与 Claude 类似，只清理用户级 hooks.json 中明确指向 Pilot 旧 OTel 插件的命令。
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
    // 同时兼容 `{hooks:[...]}` wrapper 和直接 `{command}` 两种历史 JSON shape。
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
      // 这里按整个 hooks 对象为空删除文件，即使原文件本来就是空 hooks 也会执行删除。
      await fsp.unlink(hooksPath);
      steps.push({ stage: 'codex_hooks_json', ok: true, detail: 'hooks.json removed (empty)' });
      return;
    }
    if (removed === 0) {
      // 保留所有非 Pilot Hook 和原有 JSON 排版。
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
    // 迁移采用受限行扫描而非完整 TOML parser，只处理已知旧插件生成格式。
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
    // 删除区段后最多保留一个空行，并保证文件以单个换行结尾。
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

  // 保留未命中行的原始文本；split/join 只在实际调用者确认变化后才写回文件。
  const lines = content.split('\n');
  const out: string[] = [];
  const hooksArrayHeader = /^\s*\[\[hooks\.[A-Za-z][A-Za-z0-9_]*\]\]\s*$/;
  const anyHeader = /^\s*\[/;

  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trim() === marker) {
      // 丢弃 marker 本身，再消费其后连续的旧 hooks 数组 section。
      i++;
      while (i < lines.length) {
        const line = lines[i]!;
        const trimmed = line.trim();
        // section 之间的空行属于旧生成块，也随之删除。
        if (trimmed === '') { i++; continue; }
        if (hooksArrayHeader.test(line)) {
          // 先跳过 [[hooks.X]] 头，再跳过直到空行或下一个 TOML section 的字段行。
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
    // 清理 marker 块外的孤立旧命令行，但保留同名 BEGIN/END trust marker。
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
  // 没有目标文本时原样返回，避免不必要的数组分配。
  if (!content.includes('codex_hooks')) return content;
  // 仅删除行首字段赋值，不删除注释或值中偶然出现的同名文本。
  const lines = content.split('\n').filter((l) => !/^\s*codex_hooks\s*=/.test(l));
  // 如果 [features] 段下没有任何字段了,顺带删 [features] 行
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\[features\]\s*$/.test(line)) {
      let j = i + 1;
      // 越过空行寻找本 section 的下一项；遇到新 section/EOF 才判定为空。
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
    // 与 Claude 一致，以旧 cache 目录存在作为执行配置清理的唯一门槛。
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
  // 顺序执行可避免两条链同时改写同一用户 HOME；当前目标文件不同，但报告顺序因此稳定。
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
