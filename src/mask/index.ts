/**
 * 脱敏模块的公开出口。
 *
 * 这些 ESM re-export 让 Orchestrator/InputManager 从一个路径访问 entry、规则和字符串 API；
 * 文件本身不加载规则，实际缓存只会在调用 RuleLoader 时建立。
 */

export * from './entry-masker.js';
export * from './field-whitelist.js';
export * from './rule-loader.js';
export * from './string-masker.js';
export * from './types.js';
