/**
 * AgentActivityEntry 级脱敏入口。
 *
 * InputManager 在内容采集策略之后、所有 Flusher 之前调用本模块。它只递归扫描字段白名单，
 * 采用 copy-on-write：没有命中时返回原对象，命中后才复制改变的容器，降低常见路径开销。
 */

import type { AgentActivityEntry, MaskConfig } from '../types/index.js';
import { shouldMaskField } from './field-whitelist.js';
import { loadEnabledRules } from './rule-loader.js';
import { maskString } from './string-masker.js';
import type { CompiledMaskRule, StringMaskOptions } from './types.js';

/** JSON 安全递归值；函数、BigInt 等不属于标准事件契约。 */
type JsonSafeValue =
  | string
  | number
  | boolean
  | null
  | JsonSafeValue[]
  | { [key: string]: JsonSafeValue };

/** 防御畸形或恶意深层对象，超过 32 层后保留原值并停止递归。 */
const MAX_MASK_JSON_DEPTH = 32;

  /**
   * 对一条标准事件中的敏感内容字段应用已启用规则。
   *
   * 扫描顺序是顶层字段白名单 -> JSON 容器递归 -> 单字符串规则匹配。字段名本身和白名单外的
   * model、ID、Git、token 指标不会送入正则。copy-on-write 通过严格引用比较判断变化：没有任何
   * 替换时返回原 entry；只有命中的字段及其祖先容器被复制，其他嵌套引用继续共享。
   *
   * 规则清单加载失败会得到空数组并 fail-open 返回原事件，同时 RuleLoader 已记录错误。该行为
   * 保证采集不中断，但意味着部署方必须监控规则加载日志。
   *
 * @param entry 待处理事件；除非发生替换，否则原样返回。
 * @param config 脱敏模式和类型配置。
 * @param rules 可注入的预编译规则，默认按 config 从缓存清单筛选。
 * @param options 字符串扫描性能上限，主要供测试或特殊部署调整。
 * @returns 原 entry 或包含脱敏值的新浅拷贝。
 */
export function maskAgentActivityEntry(
  entry: AgentActivityEntry,
  config: MaskConfig,
  rules: readonly CompiledMaskRule[] = loadEnabledRules(config),
  options: StringMaskOptions = {},
): AgentActivityEntry {
  // 未启用规则时保持对象引用不变，避免无意义复制。
  if (rules.length === 0) return entry;

  // 第一次真正命中前不创建副本。
  let maskedEntry: AgentActivityEntry | undefined;

  for (const [field, value] of Object.entries(entry)) {
    // 精确白名单阻止元数据被正则误修改。
    if (!shouldMaskField(field)) continue;
    const maskedValue = maskJsonSafeValue(value as JsonSafeValue, rules, options);
    if (maskedValue !== value) {
      maskedEntry ??= { ...entry };
      maskedEntry[field] = maskedValue;
    }
  }

  return maskedEntry ?? entry;
}

/**
 * 递归处理字符串、数组和普通对象，并尽量复用未改变的原容器。
 *
 * @param depth 当前容器深度，根字段从 0 开始；达到 32 后停止进入更深结构并 fail-open。
 * @returns 原值或脱敏后的新值；数字、布尔和 null 始终原样返回。
 */
function maskJsonSafeValue(
  value: JsonSafeValue,
  rules: readonly CompiledMaskRule[],
  options: StringMaskOptions,
  depth = 0,
): JsonSafeValue {
  // 到达深度上限后 fail-open，避免栈溢出或超深输入占用过多 CPU。
  if (depth >= MAX_MASK_JSON_DEPTH) return value;

  if (typeof value === 'string') {
    return maskString(value, rules, options);
  }
  if (Array.isArray(value)) {
    // map 会先创建候选数组；仅在至少一个子项引用改变时才返回它，否则丢弃候选并复用原数组。
    let changed = false;
    const maskedItems = value.map(item => {
      const maskedItem = maskJsonSafeValue(item, rules, options, depth + 1);
      if (maskedItem !== item) changed = true;
      return maskedItem;
    });
    return changed ? maskedItems : value;
  }
  if (value && typeof value === 'object') {
    // 标准 JSON 对象逐键递归；不对 key 本身脱敏，也不保留原型/不可枚举属性。
    let changed = false;
    const maskedObject: Record<string, JsonSafeValue> = {};
    for (const [key, child] of Object.entries(value)) {
      const maskedChild = maskJsonSafeValue(child, rules, options, depth + 1);
      maskedObject[key] = maskedChild;
      if (maskedChild !== child) changed = true;
    }
    return changed ? maskedObject : value;
  }
  return value;
}
