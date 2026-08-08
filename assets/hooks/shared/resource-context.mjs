// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * 从 Hook 子进程环境变量提取资源归属和调用方自定义 span 属性。
 *
 * 各 Agent wrapper/processor 继承宿主进程环境，并调用本模块把 worker 名称、实例 ID 和
 * `LOONGSUITE_PILOT_SPAN_ATTRIBUTES` 转为事件顶层字段。后续 normalization/trace flusher
 * 再把允许的字段带入 span。输入是不可信环境变量，因此这里限制长度、拒绝敏感字段名和
 * 管道保留前缀；所有告警只写 stderr，绝不抛错阻塞 Agent。
 */

const MAX_RESOURCE_FIELD_VALUE_LENGTH = 512;
const SENSITIVE_FIELD_NAME_RE = /(^|[_.-])(TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE)([_.-]|$)|^(API_KEY|API_HEADER)$/i;

export const DEFAULT_RESOURCE_ENV_FIELD_MAP = {
  AGENTTEAMS_WORKER_NAME: 'agentteams.worker.name',
  AGENTTEAMS_INSTANCE_ID: 'agentteams.instance.id',
};

// 调用方用 `key=value,key=value` 传入 span 属性。宿主进程会为每次 Agent 调用设置它，
// Hook 将解析结果铺到记录顶层，供 trace flusher 透传为 span attribute。
const DEFAULT_SPAN_ATTRIBUTES_ENV = 'LOONGSUITE_PILOT_SPAN_ATTRIBUTES';

// 这些前缀由转换器或采集管道管理。拒绝同前缀自定义键，避免调用方覆盖事件语义；该列表应与
// `src/normalization/global-attributes.ts` 的 `RESERVED_PREFIXES` 保持一致。
const SPAN_ATTR_RESERVED_PREFIXES = [
  'gen_ai.',
  'git.',
  'workspace.',
  'event.',
  'trace_',
  'user.',
  'cost_',
  'agent.',
  'time_unix_nano',
  'observed_time_unix_nano',
];

function isReservedSpanAttrKey(key) {
  return SPAN_ATTR_RESERVED_PREFIXES.some((p) => key === p || key.startsWith(p));
}

function shouldSkipFieldName(name) {
  return SENSITIVE_FIELD_NAME_RE.test(String(name || ''));
}

function warnSkip(agentId, envName, reason) {
  try {
    process.stderr.write(`[${agentId || 'hook'}] skip resource marker ${envName}: ${reason}\n`);
  } catch {
    // fail-open：资源标记采集失败绝不能阻塞宿主 Agent。
  }
}

export function collectResourceAttributesFromEnv(env = process.env, opts = {}) {
  const agentId = opts.agentId || 'hook';
  const fieldMap = opts.fieldMap || DEFAULT_RESOURCE_ENV_FIELD_MAP;
  const fields = {};

  for (const [envName, fieldName] of Object.entries(fieldMap)) {
    if (shouldSkipFieldName(envName) || shouldSkipFieldName(fieldName)) {
      warnSkip(agentId, envName, 'sensitive field name');
      continue;
    }

    const raw = env[envName];
    if (typeof raw !== 'string') continue;

    const value = raw.trim();
    if (!value) continue;
    if (value.length > MAX_RESOURCE_FIELD_VALUE_LENGTH) {
      warnSkip(agentId, envName, 'value too long');
      continue;
    }

    fields[fieldName] = value;
  }

  return fields;
}

/**
 * 解析环境变量中的调用方自定义 span 属性（`key=value,key=value`）。
 *
 * 返回扁平 `{ field: value }` 对象，可用展开语法放到事件顶层。格式错误、保留前缀、敏感
 * 名称和超长值都会被丢弃；value 中第一个 `=` 之后的内容会原样保留。函数不抛异常。
 * @param {NodeJS.ProcessEnv | Record<string, string>} env 环境变量映射，默认 `process.env`。
 * @param {{agentId?: string, envName?: string}} opts 告警标识和可覆盖的变量名。
 * @returns {Record<string, string>} 通过校验的自定义属性。
 */
export function parseSpanAttributesFromEnv(env = process.env, opts = {}) {
  const agentId = opts.agentId || 'hook';
  const envName = opts.envName || DEFAULT_SPAN_ATTRIBUTES_ENV;
  const out = {};

  const raw = env[envName];
  if (typeof raw !== 'string' || raw.length === 0) return out;

  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;

    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!key || !value) continue;

    if (isReservedSpanAttrKey(key)) {
      warnSkip(agentId, key, 'reserved prefix');
      continue;
    }
    if (shouldSkipFieldName(key)) {
      warnSkip(agentId, key, 'sensitive field name');
      continue;
    }
    if (value.length > MAX_RESOURCE_FIELD_VALUE_LENGTH) {
      warnSkip(agentId, key, 'value too long');
      continue;
    }

    out[key] = value;
  }

  return out;
}

export function agentBaseFieldPatch(resourceAttributes = {}, opts = {}) {
  const nameField = opts.nameField || 'agentteams.worker.name';
  const agentName = resourceAttributes[nameField];
  return typeof agentName === 'string' && agentName.trim()
    ? { 'gen_ai.agent.name': agentName.trim() }
    : {};
}
