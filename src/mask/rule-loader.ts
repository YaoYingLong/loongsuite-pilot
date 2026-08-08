/**
 * 敏感规则清单的加载、校验、预编译和配置筛选。
 *
 * 首次调用同步读取随构建产物分发的 `sensitive-rules.json`，随后在进程内缓存 RegExp/Set。
 * 清单损坏时记录错误并缓存空数组，让采集继续运行；显式编译 API 则会抛错供测试发现问题。
 */

// 规则只在首次使用时读取一次，同步 API 可确保缓存建立过程没有并发竞态。
import { readFileSync } from 'node:fs';
import type { MaskConfig, MaskType } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import type {
  CompiledMaskRule,
  MaskRuleKind,
  SensitiveRuleDefinition,
  SensitiveRulesManifest,
} from './types.js';

/** 相对当前 ESM 模块解析资源，兼容源码和 dist 中的位置。 */
const RULES_URL = new URL('./sensitive-rules.json', import.meta.url);
const logger = createLogger('MaskRuleLoader');
const SUPPORTED_RULE_KINDS = new Set<MaskRuleKind>(['regex', 'block', 'urlWithPassword']);
const SUPPORTED_MASK_TYPES = new Set<MaskType>([
  'cloudAccessKey',
  'apiKey',
  'privateKey',
  'databaseUrl',
]);

/** 进程级编译结果；空数组也表示已尝试加载，避免每条事件重复读盘。 */
let cachedRules: CompiledMaskRule[] | undefined;

  /**
   * 加载并缓存全部内置敏感规则。
   *
   * 首次调用同步 read/JSON.parse/compile；Node.js 同一线程内该过程不会被另一个事件循环回调插入。
   * 成功数组和失败空数组都会缓存到进程退出，运行时修改 JSON 不会热更新。返回的是缓存数组
   * 本身，调用方应只读，避免破坏后续事件使用的规则和共享 RegExp 状态。
   *
 * @returns 可复用的编译规则数组；资源读取或格式错误时为空数组。
 */
export function loadSensitiveRules(): CompiledMaskRule[] {
  if (!cachedRules) {
    try {
      const raw = readFileSync(RULES_URL, 'utf8');
      cachedRules = compileSensitiveRules(JSON.parse(raw) as SensitiveRulesManifest);
    } catch (err) {
      logger.error('failed to load sensitive rules, mask disabled', { error: String(err) });
      cachedRules = [];
    }
  }
  return cachedRules;
}

/**
 * 按 MaskConfig 返回当前启用类型的内置规则新数组。
 * 规则对象和其中 RegExp/Set 仍与进程缓存共享，StringMasker 会负责重置正则 lastIndex。
 */
export function loadEnabledRules(config: MaskConfig): CompiledMaskRule[] {
  const enabledTypes = resolveEnabledMaskTypes(config);
  if (enabledTypes.size === 0) return [];
  return loadSensitiveRules().filter(rule => enabledTypes.has(rule.type));
}

/** 对调用方提供的编译规则再次应用配置筛选，便于测试注入。 */
export function filterRulesByConfig(
  rules: readonly CompiledMaskRule[],
  config: MaskConfig,
): CompiledMaskRule[] {
  const enabledTypes = resolveEnabledMaskTypes(config);
  if (enabledTypes.size === 0) return [];
  return rules.filter(rule => enabledTypes.has(rule.type));
}

/**
 * 将 none/all/custom 模式解析为受支持类型 Set。
 * Set 同时去重；custom 中未知类型被静默丢弃，避免错误配置启用未实现 matcher。
 */
export function resolveEnabledMaskTypes(config: MaskConfig): Set<MaskType> {
  if (config.mode === 'none') return new Set();
  if (config.mode === 'all') return new Set(SUPPORTED_MASK_TYPES);
  return new Set(config.types.filter(type => SUPPORTED_MASK_TYPES.has(type)));
}

  /**
   * 校验版本 1 manifest 并预编译每条规则。
   *
   * `map(compileRule)` 是全有或全无：任何一条非法都会中止并抛出，不返回部分规则。生产加载器
   * 捕获后禁用全部脱敏，以免产生“看似启用但只保护部分密钥”的不确定状态。
   *
 * @throws manifest 结构或任一规则非法时抛出；生产加载器会捕获并禁用脱敏。
 */
export function compileSensitiveRules(manifest: SensitiveRulesManifest): CompiledMaskRule[] {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.rules)) {
    throw new Error('invalid sensitive rules manifest');
  }

  return manifest.rules.map(compileRule);
}

/**
 * 根据 kind 构建 RegExp、跨行 block RegExp 或 scheme Set，并把预筛关键词统一转小写。
 * block 使用非贪婪 `*?` 在最近 end marker 停止；urlWithPassword 不编译 regex，而由 URL API 验证。
 */
function compileRule(rule: SensitiveRuleDefinition): CompiledMaskRule {
  validateBaseRule(rule);

  if (rule.kind === 'regex') {
    if (!rule.pattern) throw new Error(`mask rule ${rule.id} missing pattern`);
    const flags = ensureGlobalFlag(rule.flags ?? 'g');
    try {
      return {
        ...rule,
        flags,
        regex: new RegExp(rule.pattern, flags),
        normalizedPrefilter: normalizePrefilter(rule.prefilter),
      };
    } catch (err) {
      throw new Error(`failed to compile mask rule ${rule.id}: ${String(err)}`);
    }
  }

  if (rule.kind === 'block') {
    if (!rule.beginPattern || !rule.endPattern) {
      throw new Error(`mask rule ${rule.id} missing block pattern`);
    }
    try {
      return {
        ...rule,
        blockRegex: new RegExp(`${rule.beginPattern}[\\s\\S]*?${rule.endPattern}`, 'g'),
        normalizedPrefilter: normalizePrefilter(rule.prefilter),
      };
    } catch (err) {
      throw new Error(`failed to compile mask rule ${rule.id}: ${String(err)}`);
    }
  }

  if (!Array.isArray(rule.schemes) || rule.schemes.length === 0) {
    throw new Error(`mask rule ${rule.id} missing schemes`);
  }

  return {
    ...rule,
    schemeSet: new Set(rule.schemes.map(scheme => scheme.toLowerCase())),
    normalizedPrefilter: normalizePrefilter(rule.prefilter),
  };
}

/** 校验所有规则共有的 id、type、kind、replacement 和 prefilter。 */
function validateBaseRule(rule: SensitiveRuleDefinition): void {
  if (!rule || typeof rule !== 'object') {
    throw new Error('invalid mask rule');
  }
  if (!rule.id || typeof rule.id !== 'string') {
    throw new Error('mask rule missing id');
  }
  if (!SUPPORTED_MASK_TYPES.has(rule.type)) {
    throw new Error(`mask rule ${rule.id} has unsupported type`);
  }
  if (!SUPPORTED_RULE_KINDS.has(rule.kind)) {
    throw new Error(`mask rule ${rule.id} has unsupported kind`);
  }
  if (!rule.replacement || typeof rule.replacement !== 'string') {
    throw new Error(`mask rule ${rule.id} missing replacement`);
  }
  if (!Array.isArray(rule.prefilter) || rule.prefilter.length === 0) {
    throw new Error(`mask rule ${rule.id} missing prefilter`);
  }
}

/** matchAll 依赖全局正则；声明忘记 `g` 时在这里补齐。 */
function ensureGlobalFlag(flags: string): string {
  return flags.includes('g') ? flags : `${flags}g`;
}

/** 删除空关键词并转小写，使预筛与 normalized input 可直接 includes 比较。 */
function normalizePrefilter(prefilter: string[]): string[] {
  return prefilter
    .filter(keyword => typeof keyword === 'string' && keyword.length > 0)
    .map(keyword => keyword.toLowerCase());
}
