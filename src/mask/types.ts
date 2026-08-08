/**
 * 脱敏规则清单、编译结果和字符串扫描选项的类型定义。
 *
 * `sensitive-rules.json` 不能写注释，其字段含义集中说明在这里；RuleLoader 将声明转换成带
 * RegExp/Set 的 `CompiledMaskRule`，StringMasker 只消费编译结果。
 */

import type { MaskType } from '../types/index.js';

/** 三类匹配器：普通正则、跨行块、带密码的数据库 URL。 */
export type MaskRuleKind = 'regex' | 'block' | 'urlWithPassword';

/** 敏感规则 JSON 文件的版本 1 顶层结构。 */
export interface SensitiveRulesManifest {
  version: 1;
  rules: SensitiveRuleDefinition[];
}

/** 单条可序列化规则声明。 */
export interface SensitiveRuleDefinition {
  id: string;
  type: MaskType;
  kind: MaskRuleKind;
  replacement: string;
  prefilter: string[];
  pattern?: string;
  flags?: string;
  beginPattern?: string;
  endPattern?: string;
  schemes?: string[];
}

/** RuleLoader 预编译后供高频扫描复用的规则。 */
export interface CompiledMaskRule extends SensitiveRuleDefinition {
  regex?: RegExp;
  blockRegex?: RegExp;
  schemeSet?: Set<string>;
  normalizedPrefilter: string[];
}

/** 在原字符串中的半开区间 `[start,end)` 及其替换标记。 */
export interface MaskRange {
  start: number;
  end: number;
  replacement: string;
  ruleId: string;
  type: MaskType;
}

/** 调用方可覆盖的性能/安全上限。 */
export interface StringMaskOptions {
  largeStringThresholdBytes?: number;
  keywordContextWindow?: number;
  privateKeyBlockLimit?: number;
}

/** 填充默认值后的完整扫描选项。 */
export interface ResolvedStringMaskOptions {
  largeStringThresholdBytes: number;
  keywordContextWindow: number;
  privateKeyBlockLimit: number;
}

/** 默认超过 64 KiB 使用窗口扫描，并限制单个私钥块为 64 KiB。 */
export const DEFAULT_STRING_MASK_OPTIONS: ResolvedStringMaskOptions = {
  largeStringThresholdBytes: 64 * 1024,
  keywordContextWindow: 8 * 1024,
  privateKeyBlockLimit: 64 * 1024,
};

/** 已经脱敏的完整占位符；再次扫描时直接返回，保证幂等。 */
export const MASKED_TOKEN_PATTERN =
  /^\[(?:ACCESSKEY|APIKEY|PRIVATEKEY|DATABASEURL)_MASKED\]$/;
