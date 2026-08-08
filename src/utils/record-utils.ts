/**
 * 记录序列化辅助工具。
 *
 * 日志型后端通常只接受字符串列，本文件将普通对象浅层转换成字符串字典。调用方仍负责
 * 决定哪些字段可以输出；本函数不会递归筛选敏感字段，也不会捕获 JSON 序列化异常。
 */

/**
 * 将对象第一层的非空字段转换为字符串。
 *
 * @param obj 要转换的普通对象。
 * @returns 新建的字符串字典；`null` 和 `undefined` 字段不会出现在结果中。
 * @throws 当对象字段包含循环引用或不支持序列化的值时，`JSON.stringify` 的异常会向上抛出。
 */
export function flattenToStrings(obj: object): Record<string, string> {
  // 创建新对象，避免改变 InputManager 仍可能交给其他 flusher 的原始 entry。
  const result: Record<string, string> = {};
  // `Object.entries` 只遍历对象自身可枚举的第一层键值。
  for (const [key, value] of Object.entries(obj)) {
    // 日志后端用“字段缺失”表达空值，避免写入含义模糊的文本 `null`/`undefined`。
    if (value === null || value === undefined) continue;
    // 数组和对象保留 JSON 结构；数字、布尔值等标量使用统一的字符串表示。
    result[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  // 返回新字典，调用者可继续追加后端专用字段。
  return result;
}
