/**
 * Collector 启动崩溃 breadcrumb 的稳定分类器。
 *
 * UpdaterMetrics 读取主入口或 bootstrap 写下的原始错误后调用本模块，把易变消息映射
 * 为 native_module_missing、module_not_found、config_error、permission_or_disk 或
 * unknown，供告警聚合。规则按顺序首个命中，detail 会去换行和截断；纯函数不读写
 * 文件，也不会抛出原始异常。
 */


import type { StartupCrashBreadcrumb } from '../utils/crash-breadcrumb.js';

export type StartupCrashReason =
  | 'native_module_missing'
  | 'module_not_found'
  | 'config_error'
  | 'permission_or_disk'
  | 'unknown';

export interface StartupCrashClassification {
  reason: StartupCrashReason;
  detailHead: string;
}

const DETAIL_MAX_CHARS = 300;

/**
 * 把原始崩溃记录映射为可聚合告警的稳定 reason 与可读 detail。规则按顺序首个命中；
 * unknown 仍保留清洗后的原消息，避免排障信息丢失。
 */
export function classifyStartupCrash(breadcrumb: StartupCrashBreadcrumb): StartupCrashClassification {
  const message = (breadcrumb.error_message || '').toLowerCase();
  const full = `${breadcrumb.error_message}\n${breadcrumb.error_stack_head}`.toLowerCase();
  return {
    reason: detectReason(message, full, breadcrumb.phase),
    detailHead: sanitizeDetail(firstLine(breadcrumb.error_message)),
  };
}

/** 按 native module -> module -> 权限/磁盘 -> 严格 JSON 配置签名顺序分类。 */
function detectReason(message: string, full: string, phase: string): StartupCrashReason {
  if (
    full.includes('sqlite3')
    || full.includes('err_dlopen_failed')
    || full.includes('did not self-register')
    || /cannot find module\s+['"][^'"]*\.node['"]/.test(full)
    || full.includes('install scripts')
    || full.includes('node_module_version')
    || full.includes('compiled against a different node')
  ) {
    return 'native_module_missing';
  }
  if (full.includes('cannot find module')) {
    return 'module_not_found';
  }
  // 权限/磁盘先于配置，避免含 config 文本的 EACCES 被误分类。
  if (full.includes('eacces') || full.includes('erofs') || full.includes('enospc')) {
    return 'permission_or_disk';
  }
  // config_error 仅看 startup 阶段 message 的 JSON.parse 特征；stack 常含配置文件路径，
  // 不能用裸 config/json 子串判断。
  if (
    phase === 'startup'
    && (
      message.includes('unexpected token')
      || message.includes('unexpected end of json')
      || message.includes(' in json')
      || message.includes('not valid json')
      || message.includes('json.parse')
    )
  ) {
    return 'config_error';
  }
  return 'unknown';
}

/** 只取错误 message 第一行。 */
function firstLine(text: string): string {
  return (text || '').split(/\r?\n/)[0] ?? '';
}

// 清除引号和控制字符，使文本可安全嵌入告警 `detail="..."`，并限制 300 字符。
function sanitizeDetail(text: string): string {
  return text.replace(/["\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, DETAIL_MAX_CHARS);
}
