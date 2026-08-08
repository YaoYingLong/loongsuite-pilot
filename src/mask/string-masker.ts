/**
 * 单字符串敏感信息扫描器。
 *
 * 小字符串直接运行已预编译规则；超过阈值时先用低成本 prefilter 找关键词附近窗口，再只扫描
 * 合并后的窗口，避免对巨型工具结果反复执行全量正则。所有命中先记录原始坐标，最后从后向前
 * 替换，防止前一次替换改变后续区间下标。
 */

import type {
  CompiledMaskRule,
  MaskRange,
  ResolvedStringMaskOptions,
  StringMaskOptions,
} from './types.js';
import {
  DEFAULT_STRING_MASK_OPTIONS,
  MASKED_TOKEN_PATTERN,
} from './types.js';

/** 先宽松提取 URL 候选，之后再交给 WHATWG URL 与 scheme 白名单精确判断。 */
const URL_CANDIDATE_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9._~:/?#\[\]@!$&()*+,;=%-]+/gi;

/**
 * @returns 字符串 UTF-8 字节数是否严格超过阈值；中文字符不能用 length 代替字节数。
 */
export function isLargeString(value: string, thresholdBytes: number): boolean {
  return Buffer.byteLength(value, 'utf8') > thresholdBytes;
}

  /**
   * 按一组编译规则脱敏字符串。
   *
   * 普通字符串先检查小写 prefilter，命中后才运行正式正则；超过 byte 阈值的字符串只扫描关键词
   * 周围窗口。窗口坐标与 RegExp 坐标都使用 JavaScript UTF-16 code unit 下标，只有阈值和私钥
   * 块上限使用 UTF-8 字节数。
   *
   * 完整字符串已经是 `[..._MASKED]` 占位符时直接返回以保证幂等；嵌在更长文本中的占位符不会
   * 触发该快捷路径。规则不匹配和所有范围被过滤时保持原字符串值。
   *
 * @param value 原始字符串。
 * @param rules RuleLoader 生成的规则；可同时包含 regex/block/url 类型。
 * @param options 大字符串和块大小限制。
 * @returns 无命中时返回原字符串，有命中时返回替换后的新字符串。
 */
export function maskString(
  value: string,
  rules: readonly CompiledMaskRule[],
  options: StringMaskOptions = {},
): string {
  // 空值、空规则或完整占位符均无需重复扫描，后者保证幂等。
  if (value.length === 0 || rules.length === 0 || MASKED_TOKEN_PATTERN.test(value)) {
    return value;
  }

  const resolvedOptions = resolveStringMaskOptions(options);
  // prefilter 统一小写，正式正则仍在原字符串上执行以保留精确坐标和大小写。
  const normalizedValue = value.toLowerCase();
  if (!hasAnyPrefilter(normalizedValue, rules)) return value;

  // 巨型内容只扫描关键词附近窗口；普通内容扫描完整字符串。
  const ranges = isLargeString(value, resolvedOptions.largeStringThresholdBytes)
    ? collectLargeStringRanges(value, normalizedValue, rules, resolvedOptions)
    : collectRangesForSegment(value, normalizedValue, 0, rules, resolvedOptions);

  return applyMaskRanges(value, ranges);
}

/**
 * 用默认值补齐可选配置，避免深层函数反复处理 undefined。
 * 当前不校验负数或 NaN，生产配置由内部常量提供；测试/外部调用传入异常值的行为待确认。
 */
function resolveStringMaskOptions(options: StringMaskOptions): ResolvedStringMaskOptions {
  return {
    largeStringThresholdBytes:
      options.largeStringThresholdBytes ?? DEFAULT_STRING_MASK_OPTIONS.largeStringThresholdBytes,
    keywordContextWindow:
      options.keywordContextWindow ?? DEFAULT_STRING_MASK_OPTIONS.keywordContextWindow,
    privateKeyBlockLimit:
      options.privateKeyBlockLimit ?? DEFAULT_STRING_MASK_OPTIONS.privateKeyBlockLimit,
  };
}

/**
 * 任一规则的任一预筛关键词存在时才进入成本更高的正式匹配。
 * prefilter 是性能门也是匹配前置条件：规则正则即使能命中，文本不含关键词仍不会执行。
 */
function hasAnyPrefilter(
  normalizedValue: string,
  rules: readonly CompiledMaskRule[],
): boolean {
  for (const rule of rules) {
    if (ruleHasPrefilter(normalizedValue, rule)) return true;
  }
  return false;
}

/** 判断当前规则是否可能命中已小写的字符串片段。 */
function ruleHasPrefilter(normalizedValue: string, rule: CompiledMaskRule): boolean {
  return rule.normalizedPrefilter.some(keyword => normalizedValue.includes(keyword));
}

/**
 * 对大字符串构建并扫描关键词窗口，返回相对于原字符串的全局区间。
 * 每个局部 matcher 返回前加回 window.start，因此最终范围仍可直接作用于完整原文。
 */
function collectLargeStringRanges(
  value: string,
  normalizedValue: string,
  rules: readonly CompiledMaskRule[],
  options: ResolvedStringMaskOptions,
): MaskRange[] {
  const windows = buildKeywordWindows(normalizedValue, rules, options.keywordContextWindow);
  if (windows.length === 0) return [];

  const ranges: MaskRange[] = [];
  for (const window of windows) {
    // segment 用原文匹配，normalizedSegment 只用于低成本 prefilter。
    const segment = value.slice(window.start, window.end);
    const normalizedSegment = normalizedValue.slice(window.start, window.end);
    ranges.push(
      ...collectRangesForSegment(segment, normalizedSegment, window.start, rules, options),
    );
  }
  return ranges;
}

  /**
   * 找出每个唯一关键词周围的上下文窗口，并合并相交/相邻窗口。
   *
   * `contextWindow` 单位是 JavaScript 字符串下标，不是 UTF-8 字节。搜索游标至少前进 1，防止
   * 异常空关键词导致死循环；正常规则在加载阶段已过滤空关键词。
   *
 * @returns 按 start 升序、互不重叠的半开区间数组。
 */
function buildKeywordWindows(
  normalizedValue: string,
  rules: readonly CompiledMaskRule[],
  contextWindow: number,
): Array<{ start: number; end: number }> {
  const windows: Array<{ start: number; end: number }> = [];
  const seenKeywords = new Set<string>();

  for (const rule of rules) {
    for (const keyword of rule.normalizedPrefilter) {
      // 多条规则可共享关键词，同一关键词只扫描一遍位置。
      if (seenKeywords.has(keyword)) continue;
      seenKeywords.add(keyword);

      let fromIndex = 0;
      while (fromIndex < normalizedValue.length) {
        const index = normalizedValue.indexOf(keyword, fromIndex);
        if (index === -1) break;
        windows.push({
          // 在关键词两侧保留固定上下文，确保完整密钥/私钥块进入正式匹配段。
          start: Math.max(0, index - contextWindow),
          end: Math.min(normalizedValue.length, index + keyword.length + contextWindow),
        });
        fromIndex = index + Math.max(keyword.length, 1);
      }
    }
  }

  if (windows.length <= 1) return windows;

  windows.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const window of windows) {
    const previous = merged[merged.length - 1];
    // 交叠窗口合并，避免同一密钥被重复扫描并产生重叠范围。
    if (previous && window.start <= previous.end) {
      previous.end = Math.max(previous.end, window.end);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

/**
 * 在单个片段内按规则 kind 分派 matcher，并把 offset 加回全局坐标。
 * 同一片段会按规则清单顺序运行；重叠冲突最后统一交给 normalizeMaskRanges 决策。
 */
function collectRangesForSegment(
  segment: string,
  normalizedSegment: string,
  offset: number,
  rules: readonly CompiledMaskRule[],
  options: ResolvedStringMaskOptions,
): MaskRange[] {
  const ranges: MaskRange[] = [];
  for (const rule of rules) {
    // 当前片段不含此规则关键词时跳过正式正则。
    if (!ruleHasPrefilter(normalizedSegment, rule)) continue;

    if (rule.kind === 'regex' && rule.regex) {
      ranges.push(...collectRegexRanges(segment, offset, rule));
    } else if (rule.kind === 'block' && rule.blockRegex) {
      ranges.push(...collectBlockRanges(segment, offset, rule, options.privateKeyBlockLimit));
    } else if (rule.kind === 'urlWithPassword' && rule.schemeSet) {
      ranges.push(...collectUrlWithPasswordRanges(segment, offset, rule));
    }
  }
  return ranges;
}

/**
 * 收集普通正则的全部非空命中，并在前后重置共享 RegExp 的 `lastIndex`。
 * 编译规则缓存在进程级并跨事件复用；若不归零，全局正则会从上次位置继续而漏掉前部命中。
 */
function collectRegexRanges(
  segment: string,
  offset: number,
  rule: CompiledMaskRule,
): MaskRange[] {
  const ranges: MaskRange[] = [];
  // 编译阶段已保证 regex 存在；非空断言在 kind 分支后成立。
  const regex = rule.regex!;
  regex.lastIndex = 0;

  for (const match of segment.matchAll(regex)) {
    if (match.index === undefined || match[0].length === 0) continue;
    ranges.push({
      start: offset + match.index,
      end: offset + match.index + match[0].length,
      replacement: rule.replacement,
      ruleId: rule.id,
      type: rule.type,
    });
  }
  regex.lastIndex = 0;
  return ranges;
}

/**
 * 收集跨行块命中；超过字节上限的块不替换，避免异常输入造成巨额复制。
 * 这是资源保护性的 fail-open：超大敏感块会保留原文，部署方应通过内容采集开关限制此风险。
 */
function collectBlockRanges(
  segment: string,
  offset: number,
  rule: CompiledMaskRule,
  blockLimit: number,
): MaskRange[] {
  const ranges: MaskRange[] = [];
  const regex = rule.blockRegex!;
  regex.lastIndex = 0;

  for (const match of segment.matchAll(regex)) {
    if (match.index === undefined || match[0].length === 0) continue;
    // 私钥块按 UTF-8 字节限制，而不是 JavaScript UTF-16 code unit 数。
    if (Buffer.byteLength(match[0], 'utf8') > blockLimit) continue;
    ranges.push({
      start: offset + match.index,
      end: offset + match.index + match[0].length,
      replacement: rule.replacement,
      ruleId: rule.id,
      type: rule.type,
    });
  }
  regex.lastIndex = 0;
  return ranges;
}

/**
 * 提取带密码且 scheme 在规则白名单中的数据库 URL。
 * 一旦确认命中，替换整个 URL 而不只是 password，避免用户名、主机、数据库名等连接信息泄露。
 */
function collectUrlWithPasswordRanges(
  segment: string,
  offset: number,
  rule: CompiledMaskRule,
): MaskRange[] {
  const ranges: MaskRange[] = [];
  URL_CANDIDATE_PATTERN.lastIndex = 0;

  for (const match of segment.matchAll(URL_CANDIDATE_PATTERN)) {
    if (match.index === undefined || match[0].length === 0) continue;
    // 文本标点先从候选末尾移除，防止把句号/括号一起替换。
    const candidate = trimUrlCandidate(match[0]);
    if (!candidate || !isDatabaseUrlWithPassword(candidate, rule)) continue;
    ranges.push({
      start: offset + match.index,
      end: offset + match.index + candidate.length,
      replacement: rule.replacement,
      ruleId: rule.id,
      type: rule.type,
    });
  }
  URL_CANDIDATE_PATTERN.lastIndex = 0;
  return ranges;
}

/** 删除自然语言中紧跟 URL 的常见右侧标点。 */
function trimUrlCandidate(candidate: string): string {
  return candidate.replace(/[),.;\]}]+$/g, '');
}

/** 使用标准 URL 解析器确认协议白名单和非空 password；畸形 URL 返回 false。 */
function isDatabaseUrlWithPassword(candidate: string, rule: CompiledMaskRule): boolean {
  try {
    const parsed = new URL(candidate);
    const scheme = parsed.protocol.slice(0, -1).toLowerCase();
    if (!rule.schemeSet?.has(scheme)) return false;
    return parsed.password.length > 0;
  } catch {
    return false;
  }
}

  /**
   * 规范化命中区间后，从字符串末尾向前应用替换。
   *
   * 倒序是必要的：先替换高下标区间，不会改变低下标区间坐标。每次模板字符串都会创建新字符串，
   * 命中数很多时有复制成本，因此上游预筛与窗口合并尽量减少范围数量。
   *
 * @param value 原始字符串。
 * @param ranges 以原字符串坐标表示的候选命中。
 * @returns 替换后的字符串；没有合法区间时保持原引用。
 */
export function applyMaskRanges(value: string, ranges: readonly MaskRange[]): string {
  const normalizedRanges = normalizeMaskRanges(value.length, ranges);
  if (normalizedRanges.length === 0) return value;

  let result = value;
  // 倒序替换保证较后位置的坐标不受较前替换文本长度影响。
  for (let i = normalizedRanges.length - 1; i >= 0; i--) {
    const range = normalizedRanges[i];
    result = `${result.slice(0, range.start)}${range.replacement}${result.slice(range.end)}`;
  }
  return result;
}

/**
 * 过滤越界/空区间，按“起点升序、同起点更长优先”排序并消除重叠。
 * 不按规则类型设置优先级；不同规则重叠时，排序后最先接受的范围决定最终 replacement。
 */
function normalizeMaskRanges(
  valueLength: number,
  ranges: readonly MaskRange[],
): MaskRange[] {
  const sorted = ranges
    .filter(range => range.start >= 0 && range.end > range.start && range.end <= valueLength)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const result: MaskRange[] = [];
  let lastEnd = -1;
  for (const range of sorted) {
    // 重叠时保留排序后更早、同起点更长的区间，避免重复替换。
    if (range.start < lastEnd) continue;
    result.push(range);
    lastEnd = range.end;
  }
  return result;
}
