#!/usr/bin/env node

/**
 * OTLP Trace 离线校验命令。开发者或 CI 直接执行本文件，它读取 Collector debug JSONL，
 * 按 `docs/trace-validation-rules.json` 重建 trace 并检查层级、属性、时间、Schema 和语义。
 * 输入来自命令行路径或默认数据目录，输出可写文本/JSON 报告；任一 error 级检查失败时
 * 以退出码 1 结束，warn 不会单独令命令失败。本脚本只读采集数据，不启动 Collector。
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TAG = '[validate-trace]';
// `--latest` 只搜索 OTLP debug flusher 的默认目录；自定义数据目录需用 `--input` 显式传入。
const OTLP_DEBUG_DIR = path.join(homedir(), '.loongsuite-pilot', 'logs', 'otlp-debug');
// 这些集合既用于枚举校验，也集中记录当前校验器接受的兼容值，避免规则散落在循环中。
const VALID_SPAN_KINDS = ['ENTRY', 'AGENT', 'STEP', 'LLM', 'TOOL', 'CHAIN', 'RETRIEVER', 'RERANKER', 'EMBEDDING', 'TASK'];
const KNOWN_SUBAGENT_TOOLS = new Set(['Agent']);
// TODO：所有生产端迁移到单数 `tool_call` 后，删除旧复数别名 `tool_calls`。
const VALID_FINISH_REASONS = new Set(['stop', 'length', 'content_filter', 'tool_call', 'tool_calls', 'error', 'end_turn', 'max_tokens']);
const VALID_PART_TYPES = new Set(['text', 'tool_call', 'tool_call_response', 'reasoning']);

// ─── 命令行参数（CLI） ───────────────────────────────────────────────────────────

/**
 * 使用 Node `parseArgs` 解析并校验互斥输入、输出格式和严重级别等命令行参数。
 * @returns {Record<string, string|boolean>} 已应用默认值的 values 对象。
 * 参数不完整或非法时直接以退出码 2 结束，表示使用方式错误而非 Trace 校验失败。
 */
function parseCli() {
  // strict=true 会直接拒绝未知参数；下方再处理跨参数约束和枚举值。
  const { values } = parseArgs({
    options: {
      input:      { type: 'string', short: 'i' },
      latest:     { type: 'boolean', default: false },
      rules:      { type: 'string', short: 'r', default: path.join(__dirname, '..', 'docs', 'trace-validation-rules.json') },
      format:     { type: 'string', short: 'f', default: 'text' },
      output:     { type: 'string', short: 'o' },
      'trace-id': { type: 'string' },
      severity:   { type: 'string', default: 'warn' },
    },
    strict: true,
  });

  if (!values.input && !values.latest) {
    console.error(`${TAG} error: must specify --input <path> or --latest`);
    process.exit(2);
  }
  if (values.input && values.latest) {
    console.error(`${TAG} error: --input and --latest are mutually exclusive`);
    process.exit(2);
  }
  if (!['json', 'text', 'summary'].includes(values.format)) {
    console.error(`${TAG} error: --format must be json, text, or summary`);
    process.exit(2);
  }
  return values;
}

// ─── 输入文件发现 ────────────────────────────────────────────────────────────

/**
 * 在默认 `otlp-debug` 目录按 mtime 找出最新 JSONL。
 * @returns {string} 最新文件绝对路径；目录不可读/没有文件时以退出码 2 结束。
 */
function findLatestJsonl() {
  let files;
  try {
    // 只考虑普通命名的 JSONL；目录项是否真为文件会在后续 stat 时验证/抛错。
    files = readdirSync(OTLP_DEBUG_DIR).filter(f => f.endsWith('.jsonl'));
  } catch {
    console.error(`${TAG} error: cannot read ${OTLP_DEBUG_DIR}`);
    process.exit(2);
  }
  if (files.length === 0) {
    console.error(`${TAG} error: no .jsonl files in ${OTLP_DEBUG_DIR}`);
    process.exit(2);
  }
  // mtime 比文件名更可靠，因为 debug 文件名格式可能随版本变化。
  files.sort((a, b) => {
    const sa = statSync(path.join(OTLP_DEBUG_DIR, a)).mtimeMs;
    const sb = statSync(path.join(OTLP_DEBUG_DIR, b)).mtimeMs;
    return sb - sa;
  });
  return path.join(OTLP_DEBUG_DIR, files[0]);
}

// ─── JSONL 读取 ──────────────────────────────────────────────────────────────

/**
 * 同步读取 debug JSONL，跳过空行、失败持久化元数据和单行坏 JSON。
 * @param {string} filePath 输入文件。
 * @returns {object[]} 至少一个有效 span；文件错误或全无有效记录时退出码 2。
 */
function readSpans(filePath) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    console.error(`${TAG} error: cannot read ${filePath}`);
    process.exit(2);
  }
  const spans = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      // `_error` 行是 debug exporter 自身的失败诊断，不是 OTLP Span，不能进入 Trace 分组。
      if (obj._error) continue;
      spans.push(obj);
    } catch {
      console.error(`${TAG} warning: skipping malformed JSON line`);
    }
  }
  if (spans.length === 0) {
    console.error(`${TAG} error: no valid spans found in ${filePath}`);
    process.exit(2);
  }
  return spans;
}

// ─── 校验规则加载 ────────────────────────────────────────────────────────────

/**
 * 加载校验规则 JSON。规则是此脚本与语义约定生成器之间的契约。
 * @param {string} rulesPath 规则路径。
 * @returns {object} 已解析规则；读取/JSON 错误时以退出码 2 结束。
 */
function loadRules(rulesPath) {
  try {
    return JSON.parse(readFileSync(rulesPath, 'utf8'));
  } catch (e) {
    console.error(`${TAG} error: cannot load rules from ${rulesPath}: ${e.message}`);
    process.exit(2);
  }
}

// ─── Trace 树构建 ────────────────────────────────────────────────────────────

/**
 * 按 traceId 分组扁平 spans，并建立 spanId 索引、父子映射和内容采集标志。
 * 为每个 span 增加仅供校验使用的 `_kind` 临时字段，不会写回源 JSONL。
 * @param {object[]} spans debug 文件中的扁平 span。
 * @param {string|undefined} traceIdFilter 可选单 trace 过滤器。
 * @returns {object[]} 每个元素表示一棵可供后续规则遍历的 trace。
 */
function buildTraces(spans, traceIdFilter) {
  const grouped = new Map();
  for (const span of spans) {
    // trace-id 过滤在建索引前完成，减少单 Trace 排障时的内存和校验工作量。
    if (traceIdFilter && span.traceId !== traceIdFilter) continue;
    if (!grouped.has(span.traceId)) grouped.set(span.traceId, []);
    grouped.get(span.traceId).push(span);
  }

  const traces = [];
  for (const [traceId, traceSpans] of grouped) {
    // 第一次遍历建立 spanId 索引和空 children 桶；第二次才能 O(1) 关联父子。
    const spanMap = new Map();
    const childrenMap = new Map();
    for (const s of traceSpans) {
      // `_kind` 是脚本内的便捷缓存，不会调用 writeFileSync 回写输入文件。
      s._kind = s.attributes?.['gen_ai.span.kind'] || 'UNKNOWN';
      spanMap.set(s.spanId, s);
      if (!childrenMap.has(s.spanId)) childrenMap.set(s.spanId, []);
    }
    for (const s of traceSpans) {
      if (s.parentSpanId && spanMap.has(s.parentSpanId)) {
        childrenMap.get(s.parentSpanId).push(s);
      }
    }

    // 任一 Span 存在消息字段，就说明本 Trace 开启了内容采集，相关规则不再标记 skipped。
    const hasMessageContent = traceSpans.some(s =>
      s.attributes?.['gen_ai.input.messages'] || s.attributes?.['gen_ai.output.messages']
    );

    const agentSpan = traceSpans.find(s => s._kind === 'AGENT');
    const agentName = agentSpan?.attributes?.['gen_ai.agent.name'] || 'unknown';

    traces.push({ traceId, spans: traceSpans, spanMap, childrenMap, hasMessageContent, agentName });
  }
  return traces;
}

// ─── 检查结果辅助函数 ────────────────────────────────────────────────────────

// 以下四个纯函数统一检查结果结构，便于报告、去重和严重级别过滤共享同一 Schema；
// pass/warn/error/skipped 是报告状态，不是 JavaScript 异常类型。
function pass(id, detail) { return { id, status: 'pass', ...(detail ? { detail } : {}) }; }
function error(id, detail, spanId, spanName) { return { id, status: 'error', detail, ...(spanId ? { spanId } : {}), ...(spanName ? { spanName } : {}) }; }
function warn(id, detail, spanId, spanName) { return { id, status: 'warn', detail, ...(spanId ? { spanId } : {}), ...(spanName ? { spanName } : {}) }; }
function skipped(id, reason) { return { id, status: 'skipped', detail: reason || 'captureMessageContent not enabled' }; }

// ─── 5a. 结构校验 ────────────────────────────────────────────────────────────

/**
 * 检查 ENTRY/AGENT/STEP/LLM/TOOL 数量、父子层级、时间先后和从根的可达性。
 * @param {object} trace `buildTraces()` 构建的索引对象。
 * @returns {object[]} 结构化检查项；函数不会抛出“校验失败”，而是返回 error 状态。
 */
function validateStructure(trace) {
  const checks = [];
  const { spans, spanMap, childrenMap } = trace;

  // 数据量主要用于离线诊断，按种类即时 filter 比维护额外索引更直观。
  const byKind = (kind) => spans.filter(s => s._kind === kind);
  const parentKind = (s) => s.parentSpanId && spanMap.has(s.parentSpanId) ? spanMap.get(s.parentSpanId)._kind : null;

  const entries = byKind('ENTRY');
  checks.push(entries.length === 1
    ? pass('structure.single_entry')
    : error('structure.single_entry', `found ${entries.length} ENTRY spans, expected 1`));

  const agents = byKind('AGENT');
  checks.push(agents.length === 1
    ? pass('structure.single_agent')
    : error('structure.single_agent', `found ${agents.length} AGENT spans, expected 1`));

  if (entries.length === 1) {
    const e = entries[0];
    // 上游 Trace 链接时 ENTRY 可以带当前文件之外的 parentSpanId，因此“不在本 Trace 索引”也视为根。
    const isRoot = !e.parentSpanId || !spanMap.has(e.parentSpanId);
    checks.push(isRoot
      ? pass('structure.entry_is_root')
      : error('structure.entry_is_root', 'ENTRY span has a parent within this trace', e.spanId, e.name));
  }

  for (const a of agents) {
    checks.push(parentKind(a) === 'ENTRY'
      ? pass('structure.agent_under_entry')
      : error('structure.agent_under_entry', `AGENT parent is ${parentKind(a) || 'none'}, expected ENTRY`, a.spanId, a.name));
  }

  const steps = byKind('STEP');
  for (const s of steps) {
    const pk = parentKind(s);
    if (pk !== 'AGENT') {
      checks.push(error('structure.step_under_agent', `STEP parent is ${pk || 'none'}, expected AGENT`, s.spanId, s.name));
    }
  }
  if (steps.length > 0 && steps.every(s => parentKind(s) === 'AGENT')) {
    checks.push(pass('structure.step_under_agent'));
  }

  for (const l of byKind('LLM')) {
    const pk = parentKind(l);
    if (pk !== 'STEP') {
      checks.push(error('structure.llm_under_step', `LLM parent is ${pk || 'none'}, expected STEP`, l.spanId, l.name));
    }
  }
  if (byKind('LLM').length > 0 && byKind('LLM').every(l => parentKind(l) === 'STEP')) {
    checks.push(pass('structure.llm_under_step'));
  }

  for (const t of byKind('TOOL')) {
    const pk = parentKind(t);
    if (pk !== 'STEP') {
      checks.push(error('structure.tool_under_step', `TOOL parent is ${pk || 'none'}, expected STEP`, t.spanId, t.name));
    }
  }
  if (byKind('TOOL').length > 0 && byKind('TOOL').every(t => parentKind(t) === 'STEP')) {
    checks.push(pass('structure.tool_under_step'));
  } else if (byKind('TOOL').length === 0) {
    checks.push(pass('structure.tool_under_step'));
  }

  // 每个 ReAct STEP 必须恰有一个 LLM 子 Span；工具子 Span数量可以为零或多个。
  let allStepsOk = true;
  for (const s of steps) {
    const children = childrenMap.get(s.spanId) || [];
    const llmChildren = children.filter(c => c._kind === 'LLM');
    if (llmChildren.length !== 1) {
      checks.push(error('structure.step_has_one_llm', `STEP has ${llmChildren.length} LLM children, expected 1`, s.spanId, s.name));
      allStepsOk = false;
    }
  }
  if (allStepsOk && steps.length > 0) {
    checks.push(pass('structure.step_has_one_llm', `${steps.length} STEPs, each with 1 LLM`));
  }

  // 工具由模型输出触发，因此同一 STEP 内 TOOL 的开始时间不能早于 LLM 开始时间。
  let llmOrderOk = true;
  for (const s of steps) {
    const children = childrenMap.get(s.spanId) || [];
    const llm = children.find(c => c._kind === 'LLM');
    const tools = children.filter(c => c._kind === 'TOOL');
    if (llm && tools.length > 0) {
      const llmStart = BigInt(llm.startTimeUnixNano);
      for (const t of tools) {
        if (BigInt(t.startTimeUnixNano) < llmStart) {
          checks.push(error('structure.llm_before_tools', `TOOL ${t.name} starts before LLM`, t.spanId, t.name));
          llmOrderOk = false;
        }
      }
    }
  }
  if (llmOrderOk && steps.length > 0) {
    checks.push(pass('structure.llm_before_tools'));
  }

  if (entries.length === 1) {
    // 从唯一 ENTRY 做广度优先遍历；未访问 Span 即为断开父链的孤儿。
    const visited = new Set();
    const queue = [entries[0].spanId];
    while (queue.length > 0) {
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      for (const child of (childrenMap.get(id) || [])) {
        queue.push(child.spanId);
      }
    }
    const orphans = spans.filter(s => !visited.has(s.spanId));
    checks.push(orphans.length === 0
      ? pass('structure.no_orphan_spans')
      : error('structure.no_orphan_spans', `${orphans.length} orphan span(s): ${orphans.map(o => o.spanId.slice(0, 8)).join(', ')}`));
  }

  return checks;
}

// ─── 5b. 属性校验 ────────────────────────────────────────────────────────────

/**
 * 按规则文件校验 common、各 Span kind 和 Resource 属性。
 * `must` 缺失产生 error，`should` 缺失产生 warn，内容字段在关闭采集时产生 skipped。
 * @param {object} trace Trace 索引。
 * @param {object} rules 已解析的规则文件。
 * @returns {object[]} 属性检查结果。
 */
function validateAttributes(trace, rules) {
  const checks = [];
  const { spans, hasMessageContent } = trace;

  for (const span of spans) {
    const attrs = span.attributes || {};
    const kind = span._kind;
    const sid = span.spanId;
    const sname = span.name;

    for (const attrDef of rules.commonAttributes.must) {
      // common must 把空字符串也视为缺失；kind must 保持规则文件当前约定，只检查 null/undefined。
      if (attrs[attrDef.key] === undefined || attrs[attrDef.key] === null || attrs[attrDef.key] === '') {
        checks.push(error(`attr.common.must.${attrDef.key}`, `missing ${attrDef.key}`, sid, sname));
      }
    }
    for (const attrDef of rules.commonAttributes.should) {
      if (attrs[attrDef.key] === undefined || attrs[attrDef.key] === null || attrs[attrDef.key] === '') {
        checks.push(warn(`attr.common.should.${attrDef.key}`, `missing ${attrDef.key}`, sid, sname));
      }
    }

    const kindRules = rules.spanKinds[kind];
    // UNKNOWN 或规则尚未覆盖的扩展 Span 只接受 common/resource 检查，不擅自套用其他 kind。
    if (!kindRules) continue;

    for (const attrDef of kindRules.attributes.must) {
      const val = attrs[attrDef.key];
      if (val === undefined || val === null) {
        checks.push(error(`attr.${kind}.must.${shortKey(attrDef.key)}`, `missing ${attrDef.key}`, sid, sname));
        continue;
      }
      if (attrDef.expectedValue !== undefined && val !== attrDef.expectedValue) {
        checks.push(error(`attr.${kind}.must.${shortKey(attrDef.key)}`, `${attrDef.key}=${val}, expected ${attrDef.expectedValue}`, sid, sname));
      }
    }

    for (const attrDef of kindRules.attributes.should) {
      if (attrDef.requiresMessageContent && !hasMessageContent) {
        // 用户主动关闭内容采集时，缺少敏感字段是预期行为，不能算警告。
        checks.push(skipped(`attr.${kind}.should.${shortKey(attrDef.key)}`));
        continue;
      }
      const val = attrs[attrDef.key];
      if (val === undefined || val === null) {
        checks.push(warn(`attr.${kind}.should.${shortKey(attrDef.key)}`, `missing ${attrDef.key}`, sid, sname));
        continue;
      }
      if (attrDef.expectedValue !== undefined && val !== attrDef.expectedValue) {
        checks.push(warn(`attr.${kind}.should.${shortKey(attrDef.key)}`, `${attrDef.key}=${val}, expected ${attrDef.expectedValue}`, sid, sname));
      }
      if (attrDef.type === 'integer' && !Number.isInteger(val)) {
        checks.push(warn(`attr.${kind}.should.${shortKey(attrDef.key)}`, `${attrDef.key} is not integer: ${val}`, sid, sname));
      }
      if (attrDef.type === 'integer' && attrDef.min !== undefined && val < attrDef.min) {
        checks.push(warn(`attr.${kind}.should.${shortKey(attrDef.key)}`, `${attrDef.key}=${val} < min ${attrDef.min}`, sid, sname));
      }
    }

    const res = span.resource || {};
    for (const attrDef of rules.resourceAttributes.must) {
      if (!res[attrDef.key]) {
        checks.push(error(`attr.resource.must.${shortKey(attrDef.key)}`, `missing resource ${attrDef.key}`, sid, sname));
      }
    }
    for (const attrDef of rules.resourceAttributes.should) {
      if (!res[attrDef.key]) {
        checks.push(warn(`attr.resource.should.${shortKey(attrDef.key)}`, `missing resource ${attrDef.key}`, sid, sname));
      } else if (attrDef.expectedValue && res[attrDef.key] !== attrDef.expectedValue) {
        checks.push(warn(`attr.resource.should.${shortKey(attrDef.key)}`, `resource ${attrDef.key}=${res[attrDef.key]}, expected ${attrDef.expectedValue}`, sid, sname));
      }
    }
  }

  return checks;
}

/** 从命名空间属性键提取末段，用于生成更紧凑的诊断文本。 */
function shortKey(key) {
  const parts = key.split('.');
  return parts[parts.length - 1];
}

// ─── 5c. 时间校验 ────────────────────────────────────────────────────────────

/**
 * 以纳秒时间戳检查非零时长、STEP 重叠、父子包含、LLM 最大时长和 round 顺序。
 * 时间戳用 BigInt 比较以避免 64 位纳秒值转换为 Number 后丢失精度。
 */
function validateTime(trace, rules) {
  const checks = [];
  const { spans, childrenMap } = trace;

  // 无法转换为 BigInt 的输入会作为脚本错误向上传播；当前规则假定 exporter 已输出整数字符串。
  let allNonZero = true;
  for (const s of spans) {
    const start = BigInt(s.startTimeUnixNano);
    const end = BigInt(s.endTimeUnixNano);
    if (end <= start) {
      checks.push(error('time.non_zero_duration', `duration=${Number(end - start) / 1e6}ms`, s.spanId, s.name));
      allNonZero = false;
    }
  }
  if (allNonZero) checks.push(pass('time.non_zero_duration'));

  const steps = spans.filter(s => s._kind === 'STEP');
  const agentSpan = spans.find(s => s._kind === 'AGENT');
  if (agentSpan && steps.length > 1) {
    // 复制后排序，避免改变 trace.spans 的原始调试顺序。
    const sorted = [...steps].sort((a, b) => {
      const d = BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano);
      return d < 0n ? -1 : d > 0n ? 1 : 0;
    });
    let overlap = false;
    for (let i = 0; i < sorted.length - 1; i++) {
      const curEnd = BigInt(sorted[i].endTimeUnixNano);
      const nextStart = BigInt(sorted[i + 1].startTimeUnixNano);
      if (curEnd > nextStart) {
        checks.push(error('time.no_step_overlap',
          `STEP ${sorted[i].spanId.slice(0, 8)} overlaps with ${sorted[i + 1].spanId.slice(0, 8)}`,
          sorted[i].spanId, sorted[i].name));
        overlap = true;
      }
    }
    if (!overlap) checks.push(pass('time.no_step_overlap'));
  } else if (steps.length <= 1) {
    checks.push(pass('time.no_step_overlap'));
  }

  // 父 Span 必须覆盖所有直接子 Span；逐层检查即可间接保证整棵树的时间包络。
  let allContained = true;
  for (const s of spans) {
    const children = childrenMap.get(s.spanId) || [];
    if (children.length === 0) continue;
    const pStart = BigInt(s.startTimeUnixNano);
    const pEnd = BigInt(s.endTimeUnixNano);
    for (const c of children) {
      const cStart = BigInt(c.startTimeUnixNano);
      const cEnd = BigInt(c.endTimeUnixNano);
      if (cStart < pStart || cEnd > pEnd) {
        checks.push(error('time.parent_contains_children',
          `child ${c.name} [${cStart}-${cEnd}] outside parent ${s.name} [${pStart}-${pEnd}]`,
          c.spanId, c.name));
        allContained = false;
      }
    }
  }
  if (allContained) checks.push(pass('time.parent_contains_children'));

  // 规则缺失时使用 10 分钟默认值；超长仅告警，因为真实长推理并非结构错误。
  const maxMs = (rules.timeRules.find(r => r.id === 'time.reasonable_duration')?.maxMs) || 600000;
  let allReasonable = true;
  for (const s of spans.filter(s => s._kind === 'LLM')) {
    const durationMs = Number(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1e6;
    if (durationMs > maxMs) {
      checks.push(warn('time.reasonable_duration', `LLM duration=${Math.round(durationMs)}ms > ${maxMs}ms`, s.spanId, s.name));
      allReasonable = false;
    }
  }
  if (allReasonable) checks.push(pass('time.reasonable_duration'));

  if (steps.length > 1) {
    const withRound = steps.filter(s => s.attributes?.['gen_ai.react.round'] !== undefined);
    if (withRound.length > 1) {
      const byTime = [...withRound].sort((a, b) => {
        const d = BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano);
        return d < 0n ? -1 : d > 0n ? 1 : 0;
      });
      let chrono = true;
      for (let i = 0; i < byTime.length - 1; i++) {
        const r1 = byTime[i].attributes['gen_ai.react.round'];
        const r2 = byTime[i + 1].attributes['gen_ai.react.round'];
        if (r1 >= r2) {
          checks.push(warn('time.chronological_steps', `round ${r1} before round ${r2} but starts later`));
          chrono = false;
          break;
        }
      }
      if (chrono) checks.push(pass('time.chronological_steps'));
    } else {
      checks.push(pass('time.chronological_steps'));
    }
  } else {
    checks.push(pass('time.chronological_steps'));
  }

  return checks;
}

// ─── 5d. Schema 与格式校验 ──────────────────────────────────────────────────

/**
 * 检查 OTLP ID、Span kind、token 数值关系、finish reason 和消息 parts Schema。
 * @returns {object[]} Schema 检查结果；不修改源 Span。
 */
function validateSchema(trace, rules) {
  const checks = [];
  const { spans, hasMessageContent } = trace;

  for (const s of spans) {
    if (!/^[0-9a-f]{32}$/.test(s.traceId)) {
      checks.push(error('schema.trace_id_format', `traceId=${s.traceId}`, s.spanId, s.name));
    }
    if (!/^[0-9a-f]{16}$/.test(s.spanId)) {
      checks.push(error('schema.span_id_format', `spanId=${s.spanId}`, s.spanId, s.name));
    }
  }
  if (spans.every(s => /^[0-9a-f]{32}$/.test(s.traceId))) checks.push(pass('schema.trace_id_format'));
  if (spans.every(s => /^[0-9a-f]{16}$/.test(s.spanId))) checks.push(pass('schema.span_id_format'));

  let allKindsValid = true;
  for (const s of spans) {
    if (s._kind && !VALID_SPAN_KINDS.includes(s._kind) && s._kind !== 'UNKNOWN') {
      checks.push(error('schema.span_kind_enum', `gen_ai.span.kind=${s._kind}`, s.spanId, s.name));
      allKindsValid = false;
    }
  }
  if (allKindsValid) checks.push(pass('schema.span_kind_enum'));

  const tokenKeys = ['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.total_tokens'];
  let allTokensPositive = true;
  let allTokensSumOk = true;
  for (const s of spans) {
    const attrs = s.attributes || {};
    for (const tk of tokenKeys) {
      const v = attrs[tk];
      if (v !== undefined && v !== null) {
        if (!Number.isInteger(v) || v < 0) {
          checks.push(error('schema.tokens_positive', `${tk}=${v} is not a non-negative integer`, s.spanId, s.name));
          allTokensPositive = false;
        }
      }
    }

    const inp = attrs['gen_ai.usage.input_tokens'];
    const out = attrs['gen_ai.usage.output_tokens'];
    const tot = attrs['gen_ai.usage.total_tokens'];
    // 只有三个字段都存在且都是整数时才检查等式，缺失问题由属性规则单独报告。
    if (inp !== undefined && out !== undefined && tot !== undefined) {
      if (Number.isInteger(inp) && Number.isInteger(out) && Number.isInteger(tot)) {
        if (tot !== inp + out) {
          checks.push(error('schema.tokens_sum', `total(${tot}) != input(${inp}) + output(${out})`, s.spanId, s.name));
          allTokensSumOk = false;
        }
      }
    }
  }
  if (allTokensPositive) checks.push(pass('schema.tokens_positive'));
  if (allTokensSumOk) checks.push(pass('schema.tokens_sum'));

  for (const s of spans) {
    const attrs = s.attributes || {};
    const fr = attrs['gen_ai.response.finish_reasons'];
    if (fr !== undefined && fr !== null) {
      // exporter 可能将数组保持为对象，也可能把它序列化为 JSON 字符串，两种形式都接受。
      try {
        const parsed = typeof fr === 'string' ? JSON.parse(fr) : fr;
        if (!Array.isArray(parsed) || !parsed.every(x => typeof x === 'string')) {
          checks.push(warn('schema.finish_reasons', `not a string array`, s.spanId, s.name));
        }
      } catch {
        checks.push(warn('schema.finish_reasons', `invalid JSON`, s.spanId, s.name));
      }
    }
  }

  if (hasMessageContent) {
    // 消息属于 opt-in 敏感字段；全 Trace 未采集时跳过，而不是制造大量缺失错误。
    for (const s of spans) {
      const attrs = s.attributes || {};
      validateMessageField(attrs, 'gen_ai.input.messages', 'schema.input_messages', s, checks);
      validateMessageField(attrs, 'gen_ai.output.messages', 'schema.output_messages', s, checks);
    }
  } else {
    checks.push(skipped('schema.input_messages'));
    checks.push(skipped('schema.output_messages'));
  }

  return checks;
}

/**
 * 校验单个可能包含 JSON 字符串的消息属性，并把问题追加到共享 checks。
 * @param {object} attrs Span 属性。
 * @param {string} key 要检查的属性键。
 * @param {string} ruleId 报告规则 ID。
 */
function validateMessageField(attrs, key, ruleId, span, checks) {
  const raw = attrs[key];
  if (raw === undefined || raw === null) return;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) {
      checks.push(error(ruleId, `${key} is not an array`, span.spanId, span.name));
      return;
    }
    for (let i = 0; i < parsed.length; i++) {
      const msg = parsed[i];
      if (!msg.role) {
        checks.push(error(ruleId, `${key}[${i}] missing role`, span.spanId, span.name));
      }
      if (ruleId === 'schema.output_messages') {
        // 只有输出消息要求 finish_reason；输入用户消息没有结束原因。
        if (msg.finish_reason === undefined) {
          checks.push(warn(ruleId, `${key}[${i}] missing finish_reason`, span.spanId, span.name));
        } else if (!VALID_FINISH_REASONS.has(msg.finish_reason)) {
          checks.push(error(ruleId,
            `${key}[${i}] finish_reason="${msg.finish_reason}" is not a valid FinishReason (expected: ${[...VALID_FINISH_REASONS].join(', ')})`,
            span.spanId, span.name));
        }
      }
      if (msg.parts && Array.isArray(msg.parts)) {
        // parts 的具体必填字段取决于 type，先验证 discriminator 再进入类型分支。
        for (let j = 0; j < msg.parts.length; j++) {
          const part = msg.parts[j];
          if (!part.type) {
            checks.push(error(ruleId, `${key}[${i}].parts[${j}] missing type`, span.spanId, span.name));
            continue;
          }
          if (VALID_PART_TYPES.has(part.type)) {
            if (part.type === 'text' && part.content === undefined) {
              checks.push(error(ruleId, `${key}[${i}].parts[${j}] TextPart missing required "content"`, span.spanId, span.name));
            }
            if (part.type === 'tool_call' && !part.id) {
              checks.push(warn(ruleId, `${key}[${i}].parts[${j}] ToolCallPart missing "id"`, span.spanId, span.name));
            }
            if (part.type === 'tool_call_response' && !part.id) {
              checks.push(warn(ruleId, `${key}[${i}].parts[${j}] ToolCallResponsePart missing "id"`, span.spanId, span.name));
            }
          } else {
            checks.push(warn(ruleId, `${key}[${i}].parts[${j}] unknown part type="${part.type}"`, span.spanId, span.name));
          }
        }
      }
    }
  } catch {
    checks.push(error(ruleId, `${key} is not valid JSON`, span.spanId, span.name));
  }
}

// ─── 5e. 语义校验 ────────────────────────────────────────────────────────────

/**
 * 校验跨 Span 才能判断的语义：标识一致性、operation 映射、token 汇总、工具调用配对和最终输出。
 * @param {object} trace Trace 索引。
 * @param {object} rules 规则配置。
 * @returns {object[]} 语义检查结果。
 */
function validateSemantic(trace, rules) {
  const checks = [];
  const { spans, childrenMap, hasMessageContent } = trace;

  // 检查 consistent_session_id：同一 Trace 中所有已提供的 session ID 应一致。
  const sessionIds = new Set(spans.map(s => s.attributes?.['gen_ai.session.id']).filter(Boolean));
  checks.push(sessionIds.size <= 1
    ? pass('semantic.consistent_session_id')
    : error('semantic.consistent_session_id', `found ${sessionIds.size} distinct session IDs: ${[...sessionIds].join(', ')}`));

  // 检查 consistent_user_id：过滤缺失值后，不允许出现多个用户 ID。
  const userIds = new Set(spans.map(s => s.attributes?.['gen_ai.user.id']).filter(Boolean));
  checks.push(userIds.size <= 1
    ? pass('semantic.consistent_user_id')
    : error('semantic.consistent_user_id', `found ${userIds.size} distinct user IDs`));

  // 检查 consistent_agent_name：多 Agent 名可能源于兼容数据，当前仅作为 warn。
  const agentNames = new Set(spans.map(s => s.attributes?.['gen_ai.agent.name']).filter(Boolean));
  checks.push(agentNames.size <= 1
    ? pass('semantic.consistent_agent_name')
    : warn('semantic.consistent_agent_name', `found ${agentNames.size} distinct agent names: ${[...agentNames].join(', ')}`));

  // 检查 operation_kind_mapping：规则表把 operation.name 映射到唯一 Span kind。
  const mapping = rules.operationKindMapping || {};
  let allMappingOk = true;
  for (const s of spans) {
    const opName = s.attributes?.['gen_ai.operation.name'];
    const spanKind = s._kind;
    if (opName && mapping[opName] && mapping[opName] !== spanKind) {
      checks.push(error('semantic.operation_kind_mapping',
        `operation=${opName} maps to ${mapping[opName]}, but span.kind=${spanKind}`, s.spanId, s.name));
      allMappingOk = false;
    }
  }
  if (allMappingOk) checks.push(pass('semantic.operation_kind_mapping'));

  // 检查 span_name_pattern：带 `{占位符}` 的动态模式暂不做字面比较。
  let allNamesOk = true;
  for (const s of spans) {
    const kindRules = rules.spanKinds[s._kind];
    if (!kindRules?.namePattern) continue;
    const pattern = kindRules.namePattern;
    if (!pattern.includes('{')) {
      if (s.name !== pattern && !s.name.startsWith(pattern)) {
        checks.push(warn('semantic.span_name_pattern', `name="${s.name}", expected pattern "${pattern}"`, s.spanId, s.name));
        allNamesOk = false;
      }
    }
  }
  if (allNamesOk) checks.push(pass('semantic.span_name_pattern'));

  // 检查 agent_token_sum：AGENT 聚合 token 应等于所有 LLM 子工作量之和。
  const agentSpan = spans.find(s => s._kind === 'AGENT');
  if (agentSpan) {
    const llmSpans = spans.filter(s => s._kind === 'LLM');
    for (const tokenKey of ['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.total_tokens']) {
      const agentVal = agentSpan.attributes?.[tokenKey];
      if (agentVal === undefined || agentVal === null) continue;
      const llmSum = llmSpans.reduce((sum, l) => sum + (l.attributes?.[tokenKey] || 0), 0);
      if (agentVal !== llmSum) {
        checks.push(error('semantic.agent_token_sum',
          `AGENT ${tokenKey}=${agentVal}, sum of LLM=${llmSum}`, agentSpan.spanId, agentSpan.name));
      }
    }
    const hasAnyToken = ['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.total_tokens']
      .some(k => agentSpan.attributes?.[k] !== undefined);
    if (hasAnyToken) {
      const allMatch = ['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.total_tokens'].every(k => {
        const av = agentSpan.attributes?.[k];
        if (av === undefined || av === null) return true;
        const llmSum = llmSpans.reduce((sum, l) => sum + (l.attributes?.[k] || 0), 0);
        return av === llmSum;
      });
      if (allMatch) checks.push(pass('semantic.agent_token_sum'));
    }
  }

  // 检查 tool_matches_llm_output：双向验证 LLM 声明和实际 TOOL Span，既不能多也不能漏。
  if (!hasMessageContent) {
    checks.push(skipped('semantic.tool_matches_llm_output'));
  } else {
    let allToolsMatch = true;
    const stepSpans = spans.filter(s => s._kind === 'STEP');
    for (const step of stepSpans) {
      const children = childrenMap.get(step.spanId) || [];
      const llm = children.find(c => c._kind === 'LLM');
      const tools = children.filter(c => c._kind === 'TOOL');
      if (!llm || tools.length === 0) continue;

      const outputRaw = llm.attributes?.['gen_ai.output.messages'];
      if (!outputRaw) continue;

      let expectedToolCalls = [];
      try {
        const output = typeof outputRaw === 'string' ? JSON.parse(outputRaw) : outputRaw;
        if (Array.isArray(output)) {
          for (const msg of output) {
            if (msg.parts && Array.isArray(msg.parts)) {
              for (const part of msg.parts) {
                if (part.type === 'tool_call') {
                  expectedToolCalls.push({ id: part.id, name: part.name });
                }
              }
            }
          }
        }
      } catch {
        // JSON 格式错误会由 Schema 检查报告；本规则无法可靠提取调用时避免重复误报。
        continue;
      }

      for (const tool of tools) {
        const toolCallId = tool.attributes?.['gen_ai.tool.call.id'];
        const toolName = tool.attributes?.['gen_ai.tool.name'];
        const matched = expectedToolCalls.some(tc =>
          // call.id 最可靠；某些 Agent 没有稳定 ID 时退回工具名配对。
          (toolCallId && tc.id && tc.id === toolCallId) || (toolName && tc.name && tc.name === toolName)
        );
        if (!matched) {
          checks.push(error('semantic.tool_matches_llm_output',
            `TOOL ${toolName || toolCallId} not found in LLM output tool_calls`, tool.spanId, tool.name));
          allToolsMatch = false;
        }
      }

      for (const tc of expectedToolCalls) {
        const matched = tools.some(t =>
          (tc.id && t.attributes?.['gen_ai.tool.call.id'] === tc.id) ||
          (tc.name && t.attributes?.['gen_ai.tool.name'] === tc.name)
        );
        if (!matched) {
          if (KNOWN_SUBAGENT_TOOLS.has(tc.name)) {
            // 已知子 Agent 工具尚未生成 TOOL Span，因此降级为警告而非阻断 CI。
            checks.push(warn('semantic.tool_matches_llm_output',
              `LLM declared subagent tool_call ${tc.name} — subagent TOOL span not yet supported`, llm.spanId, llm.name));
          } else {
            checks.push(error('semantic.tool_matches_llm_output',
              `LLM declared tool_call ${tc.name || tc.id} but no matching TOOL span`, llm.spanId, llm.name));
            allToolsMatch = false;
          }
        }
      }
    }
    if (allToolsMatch) checks.push(pass('semantic.tool_matches_llm_output'));
  }

  // 检查 entry_input_exists：ENTRY 代表整轮入口，应保留非空用户输入快照。
  if (!hasMessageContent) {
    checks.push(skipped('semantic.entry_input_exists'));
  } else {
    const entry = spans.find(s => s._kind === 'ENTRY');
    if (entry) {
      const raw = entry.attributes?.['gen_ai.input.messages'];
      if (raw) {
        try {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          checks.push(Array.isArray(parsed) && parsed.length > 0
            ? pass('semantic.entry_input_exists')
            : warn('semantic.entry_input_exists', 'ENTRY input.messages is empty'));
        } catch {
          checks.push(warn('semantic.entry_input_exists', 'ENTRY input.messages is not valid JSON'));
        }
      } else {
        checks.push(warn('semantic.entry_input_exists', 'ENTRY missing input.messages'));
      }
    }
  }

  // 检查 entry_output_matches：ENTRY 的最终输出应与结束时间最晚的 LLM 输出一致。
  if (!hasMessageContent) {
    checks.push(skipped('semantic.entry_output_matches'));
  } else {
    const entry = spans.find(s => s._kind === 'ENTRY');
    const llmSpans = spans.filter(s => s._kind === 'LLM');
    if (entry && llmSpans.length > 0) {
      // 注意这里会排序局部 llmSpans 数组，不会改变原 trace.spans。
      const lastLlm = llmSpans.sort((a, b) => {
        const d = BigInt(a.endTimeUnixNano) - BigInt(b.endTimeUnixNano);
        return d < 0n ? -1 : d > 0n ? 1 : 0;
      })[llmSpans.length - 1];

      const entryOutput = entry.attributes?.['gen_ai.output.messages'];
      const llmOutput = lastLlm.attributes?.['gen_ai.output.messages'];
      if (entryOutput && llmOutput) {
        const eq = JSON.stringify(entryOutput) === JSON.stringify(llmOutput);
        checks.push(eq
          ? pass('semantic.entry_output_matches')
          : warn('semantic.entry_output_matches', 'ENTRY output.messages differs from last LLM output'));
      }
    }
  }

  // 检查 llm_has_input_output：启用内容采集后，每个模型调用都应形成完整输入/输出对。
  if (!hasMessageContent) {
    checks.push(skipped('semantic.llm_has_input_output'));
  } else {
    let allOk = true;
    for (const s of spans.filter(s => s._kind === 'LLM')) {
      const hasInput = s.attributes?.['gen_ai.input.messages'] !== undefined;
      const hasOutput = s.attributes?.['gen_ai.output.messages'] !== undefined;
      if (!hasInput || !hasOutput) {
        checks.push(error('semantic.llm_has_input_output',
          `LLM missing ${!hasInput ? 'input' : ''}${!hasInput && !hasOutput ? ' and ' : ''}${!hasOutput ? 'output' : ''}.messages`,
          s.spanId, s.name));
        allOk = false;
      }
    }
    if (allOk) checks.push(pass('semantic.llm_has_input_output'));
  }

  // tool_response_role：含 tool_call_response part 的输入消息必须使用 role=tool。
  if (!hasMessageContent) {
    checks.push(skipped('semantic.tool_response_role'));
  } else {
    let allRolesOk = true;
    for (const s of spans.filter(s => s._kind === 'LLM')) {
      const raw = s.attributes?.['gen_ai.input.messages'];
      if (!raw) continue;
      try {
        const msgs = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(msgs)) continue;
        for (const msg of msgs) {
          const parts = msg.parts;
          if (!Array.isArray(parts)) continue;
          const hasToolResponse = parts.some(p => p.type === 'tool_call_response');
          if (hasToolResponse && msg.role !== 'tool') {
            checks.push(error('semantic.tool_response_role',
              `input.messages role='${msg.role}' but contains tool_call_response part, expected role='tool'`,
              s.spanId, s.name));
            allRolesOk = false;
          }
        }
      } catch {
        // JSON 解析错误已由 validateMessageField 报告，此处只避免重复同一根因。
      }
    }
    if (allRolesOk) checks.push(pass('semantic.tool_response_role'));
  }

  // tool_has_arguments：TOOL span 应包含 gen_ai.tool.call.arguments。
  {
    const toolSpans = spans.filter(s => s._kind === 'TOOL');
    let allHaveArgs = true;
    for (const t of toolSpans) {
      const args = t.attributes?.['gen_ai.tool.call.arguments'];
      if (args === undefined || args === null || args === '') {
        checks.push(error('semantic.tool_has_arguments',
          `TOOL ${t.attributes?.['gen_ai.tool.name'] || t.name} missing gen_ai.tool.call.arguments`,
          t.spanId, t.name));
        allHaveArgs = false;
      }
    }
    if (allHaveArgs && toolSpans.length > 0) checks.push(pass('semantic.tool_has_arguments'));
    if (toolSpans.length === 0) checks.push(pass('semantic.tool_has_arguments'));
  }

  // last_step_no_tool_call：最后一个 STEP 的 LLM 输出不应再包含 tool_call。
  if (!hasMessageContent) {
    checks.push(skipped('semantic.last_step_no_tool_call'));
  } else {
    const stepSpans = spans.filter(s => s._kind === 'STEP');
    if (stepSpans.length > 0) {
      const sorted = [...stepSpans].sort((a, b) => {
        const d = BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano);
        return d < 0n ? -1 : d > 0n ? 1 : 0;
      });
      const lastStep = sorted[sorted.length - 1];
      const children = childrenMap.get(lastStep.spanId) || [];
      const llm = children.find(c => c._kind === 'LLM');
      if (llm) {
        const raw = llm.attributes?.['gen_ai.output.messages'];
        if (raw) {
          try {
            const msgs = typeof raw === 'string' ? JSON.parse(raw) : raw;
            let hasToolCall = false;
            if (Array.isArray(msgs)) {
              for (const msg of msgs) {
                if (Array.isArray(msg.parts)) {
                  for (const part of msg.parts) {
                    if (part.type === 'tool_call') hasToolCall = true;
                  }
                }
              }
            }
            checks.push(hasToolCall
              ? error('semantic.last_step_no_tool_call',
                  'last STEP LLM output contains tool_call, expected final answer without tool calls',
                  llm.spanId, llm.name)
              : pass('semantic.last_step_no_tool_call'));
          } catch {
            checks.push(pass('semantic.last_step_no_tool_call'));
          }
        } else {
          checks.push(pass('semantic.last_step_no_tool_call'));
        }
      }
    }
  }

  return checks;
}

// ─── 报告格式化 ──────────────────────────────────────────────────────────────

/**
 * 对每棵 Trace 执行五组校验，去重、按严重级别过滤并汇总最终 verdict。
 * @param {object[]} traces `buildTraces()` 结果。
 * @param {string} inputFile 用于报告 metadata 的输入路径。
 * @param {object} rules 校验规则。
 * @param {string} severityFilter CLI 严重级别阈值。
 * @returns {object} JSON/text formatter 共用的结构化报告。
 */
function buildReport(traces, inputFile, rules, severityFilter) {
  const traceReports = [];
  let totalSpans = 0;
  const totalChecks = { total: 0, pass: 0, warn: 0, error: 0, skipped: 0 };

  for (const trace of traces) {
    // 各校验器独立返回结果；展开到同一数组后统一处理重复 pass/逐 Span 错误。
    const allChecks = [
      ...validateStructure(trace),
      ...validateAttributes(trace, rules),
      ...validateTime(trace, rules),
      ...validateSchema(trace, rules),
      ...validateSemantic(trace, rules),
    ];

    const deduped = deduplicateChecks(allChecks);
    const filtered = filterBySeverity(deduped, severityFilter);

    const counts = { entry: 0, agent: 0, steps: 0, llms: 0, tools: 0, other: 0 };
    for (const s of trace.spans) {
      switch (s._kind) {
        case 'ENTRY': counts.entry++; break;
        case 'AGENT': counts.agent++; break;
        case 'STEP':  counts.steps++; break;
        case 'LLM':   counts.llms++;  break;
        case 'TOOL':  counts.tools++; break;
        default:       counts.other++; break;
      }
    }

    // warn/skipped 不会令单 Trace 失败，只有过滤后仍存在 error 才是 FAIL。
    const hasError = filtered.some(c => c.status === 'error');

    for (const c of filtered) {
      totalChecks.total++;
      totalChecks[c.status]++;
    }
    totalSpans += trace.spans.length;

    traceReports.push({
      traceId: trace.traceId,
      agent: trace.agentName,
      spans: trace.spans.length,
      structure: counts,
      verdict: hasError ? 'FAIL' : 'PASS',
      checks: filtered,
    });
  }

  const verdict = totalChecks.error > 0 ? 'FAIL' : 'PASS';

  return {
    meta: {
      tool: 'validate-trace',
      version: rules.version,
      rulesVersion: rules.version,
      timestamp: new Date().toISOString(),
      input: path.basename(inputFile),
      captureMessageContent: traces.some(t => t.hasMessageContent),
    },
    summary: {
      traces: traces.length,
      spans: totalSpans,
      checks: totalChecks,
      verdict,
    },
    traces: traceReports,
  };
}

/** 以规则 ID、Span ID 和状态为键移除重复检查，保留第一次结果。 */
function deduplicateChecks(checks) {
  const seen = new Map();
  const result = [];
  for (const c of checks) {
    const key = `${c.id}:${c.spanId || ''}:${c.status}`;
    if (c.status === 'pass') {
      // 同一规则的成功只显示一次；失败则按 spanId 保留，便于定位每个问题 Span。
      if (!seen.has(c.id)) {
        seen.set(c.id, true);
        result.push(c);
      }
    } else {
      if (!seen.has(key)) {
        seen.set(key, true);
        result.push(c);
      }
    }
  }
  return result;
}

/** 根据 CLI severity 阈值保留 error 或 error+warn，同时保留上下文所需结果。 */
function filterBySeverity(checks, severity) {
  const levels = { error: 0, warn: 1, info: 2 };
  const statusToLevel = { error: 0, warn: 1, pass: 2, skipped: 2 };
  const minLevel = levels[severity] ?? 1;
  // pass/skipped 始终保留以展示规则覆盖情况；阈值只隐藏较低级别的问题项。
  return checks.filter(c => (statusToLevel[c.status] ?? 2) <= minLevel || c.status === 'pass' || c.status === 'skipped');
}

/** 同步地将结构化结果格式化为 formatText 对应的输出文本，不执行文件 I/O。 */
function formatText(report) {
  const lines = [];
  const mc = report.meta.captureMessageContent ? 'enabled' : 'disabled';
  lines.push('');
  lines.push('╔' + '═'.repeat(62) + '╗');
  lines.push('║  GenAI Trace Validation Report' + ' '.repeat(32) + '║');
  lines.push('║  Input: ' + report.meta.input.padEnd(53) + '║');
  lines.push('║  Rules: v' + report.meta.rulesVersion.padEnd(52) + '║');
  lines.push('║  Message Content: ' + mc.padEnd(43) + '║');
  lines.push('╚' + '═'.repeat(62) + '╝');
  lines.push('');

  for (const t of report.traces) {
    lines.push(`Trace ${t.traceId.slice(0, 12)}... (${t.agent}, ${t.spans} spans)`);
    const s = t.structure;
    lines.push(`  Structure: ${s.entry} ENTRY, ${s.agent} AGENT, ${s.steps} STEPs, ${s.llms} LLMs, ${s.tools} TOOLs`);

    for (const c of t.checks) {
      const icon = c.status === 'pass' ? '✅' : c.status === 'error' ? '❌' : c.status === 'warn' ? '⚠️ ' : '⏭️ ';
      const detail = c.detail ? ` — ${c.detail}` : '';
      const span = c.spanId ? ` [${c.spanId.slice(0, 8)}]` : '';
      lines.push(`  ${icon} ${c.id}${span}${detail}`);
    }
    lines.push('');
    lines.push('─'.repeat(50));
    lines.push('');
  }

  const ck = report.summary.checks;
  lines.push(`Summary: ${report.summary.traces} traces, ${report.summary.spans} spans`);
  lines.push(`  ✅ Pass: ${ck.pass}  ⚠️  Warn: ${ck.warn}  ❌ Error: ${ck.error}  ⏭️  Skipped: ${ck.skipped}`);
  lines.push(`  Verdict: ${report.summary.verdict}`);
  lines.push('');
  return lines.join('\n');
}

/** 将报告压缩为单行/少量行统计，适合 CI 日志。 */
function formatSummary(report) {
  const ck = report.summary.checks;
  const icon = ck.error > 0 ? '❌' : '✅';
  return `${icon} ${report.summary.traces} traces, ${report.summary.spans} spans, ${ck.error} errors, ${ck.warn} warnings, ${ck.skipped} skipped`;
}

// ─── 主流程 ────────────────────────────────────────────────────────────────────

/** 作为 validate-trace.mjs 的命令入口，编排参数、I/O 和退出码；顶层错误由文件末尾统一处理。 */
function main() {
  // 主流程同步执行，适合一次性 CLI；所有输入/用法错误约定退出码 2。
  const opts = parseCli();

  const inputFile = opts.latest ? findLatestJsonl() : opts.input;
  console.error(`${TAG} validating: ${inputFile}`);

  const spans = readSpans(inputFile);
  console.error(`${TAG} loaded ${spans.length} spans`);

  const rules = loadRules(opts.rules);
  // 可选 trace-id 在分组阶段过滤，不影响读取文件中其他行的健壮性处理。
  const traces = buildTraces(spans, opts['trace-id']);

  if (traces.length === 0) {
    console.error(`${TAG} error: no traces found${opts['trace-id'] ? ` for trace-id ${opts['trace-id']}` : ''}`);
    process.exit(2);
  }
  console.error(`${TAG} found ${traces.length} trace(s)`);

  const report = buildReport(traces, inputFile, rules, opts.severity);

  let output;
  switch (opts.format) {
    case 'json':
      output = JSON.stringify(report, null, 2);
      break;
    case 'summary':
      output = formatSummary(report);
      break;
    default:
      output = formatText(report);
  }

  if (opts.output) {
    // 报告正文写目标文件，进度日志走 stderr，便于 CI 分离产物与控制台信息。
    writeFileSync(opts.output, output, 'utf8');
    console.error(`${TAG} report written to ${opts.output}`);
  } else {
    console.log(output);
  }

  // 0=通过（可含 warning），1=Trace 规则错误，2=参数/输入/规则文件错误。
  process.exit(report.summary.verdict === 'FAIL' ? 1 : 0);
}

main();
