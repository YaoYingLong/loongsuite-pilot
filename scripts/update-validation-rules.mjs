#!/usr/bin/env node

/**
 * Trace 校验规则生成器：从本地 `gen-ai.md` 或 GitLab raw URL 读取语义约定，
 * 解析属性表、Span 类型与 operation kind 映射，再生成 `docs/trace-validation-rules.json`。
 * 该工具用于维护校验基线，不参与 Collector 运行时；网络/解析/写文件错误会沿 `await`
 * 传播到顶层并使进程以退出码 1 结束。
 *
 * 用法：
 *   node scripts/update-validation-rules.mjs --spec-file <path>
 *   node scripts/update-validation-rules.mjs --spec-url <gitlab-raw-url>
 *   node scripts/update-validation-rules.mjs                  （默认读取本地 arms 副本）
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TAG = '[update-rules]';
const DEFAULT_SPEC = path.resolve(__dirname, '..', '..', 'arms', 'semantic-conventions', 'arms_docs', 'trace', 'gen-ai.md');
const OUTPUT_PATH = path.resolve(__dirname, '..', 'docs', 'trace-validation-rules.json');

// ─── 命令行参数解析 ──────────────────────────────────────────────────────────

const { values: opts } = parseArgs({
  options: {
    'spec-file': { type: 'string' },
    'spec-url':  { type: 'string' },
    output:      { type: 'string', short: 'o', default: OUTPUT_PATH },
    diff:        { type: 'boolean', default: false },
  },
  strict: true,
});

// ─── 获取规范内容 ────────────────────────────────────────────────────────────

/**
 * 按 CLI 选择从 URL 异步 fetch 或从本地同步读取语义约定 Markdown。
 * @returns {Promise<string>} 完整规范文本。
 * @throws {Error} 网络非 2xx；本地文件不存在时以退出码 2 结束。
 */
async function fetchSpec() {
  if (opts['spec-url']) {
    console.log(`${TAG} fetching from URL: ${opts['spec-url']}`);
    const res = await fetch(opts['spec-url']);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.text();
  }
  const filePath = opts['spec-file'] || DEFAULT_SPEC;
  if (!existsSync(filePath)) {
    console.error(`${TAG} error: spec file not found: ${filePath}`);
    process.exit(2);
  }
  console.log(`${TAG} reading local spec: ${filePath}`);
  return readFileSync(filePath, 'utf8');
}

// ─── Markdown 解析器 ─────────────────────────────────────────────────────────

const SECTION_MAP = {
  '公共部分':    'COMMON',
  'Chain':       'CHAIN',
  'Retriever':   'RETRIEVER',
  'Reranker':    'RERANKER',
  'LLM':         'LLM',
  'Embedding':   'EMBEDDING',
  'Tool':        'TOOL',
  'Agent':       'AGENT',
  'Task':        'TASK',
  'Entry':       'ENTRY',
  'ReAct Step':  'STEP',
};

const RESOURCE_SECTION = '## Resources';

const LEVEL_MAP = {
  '必须':          'must',
  '有条件时必须':  'should',
  '推荐':          'should',
  '可选':          'optional',
};

/**
 * 解析规范中的一级 Span kind、Attributes/Resources Markdown 表格和中英文约束级别。
 * 循环状态跟踪当前 section/表格，非目标章节会忽略。
 * @param {string} md Markdown 原文。
 * @returns {Record<string,{attrs:object[],resources:object[]}>} 按 Span kind 分组的原始规则。
 */
function parseSpec(md) {
  const lines = md.split('\n');
  const sections = {};
  let currentSection = null;
  let inAttrTable = false;
  let inResourceTable = false;
  let headerCols = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 识别一级章节标题，例如 `# SectionName`。
    const h1 = line.match(/^# (.+)/);
    if (h1) {
      const name = h1[1].trim();
      const mapped = SECTION_MAP[name];
      if (mapped) {
        currentSection = mapped;
        if (!sections[currentSection]) sections[currentSection] = { attrs: [], resources: [] };
      } else {
        currentSection = null;
      }
      inAttrTable = false;
      inResourceTable = false;
      continue;
    }

    // 识别 `## Resources` 资源属性子章节。
    if (line.trim() === '## Resources') {
      inResourceTable = true;
      inAttrTable = false;
      continue;
    }
    if (line.trim() === '## Attributes') {
      inAttrTable = true;
      inResourceTable = false;
      continue;
    }
    if (line.startsWith('## ') && line.trim() !== '## Attributes' && line.trim() !== '## Resources') {
      inAttrTable = false;
      inResourceTable = false;
      continue;
    }

    // 解析 Markdown 表头并记住各列位置。
    if ((inAttrTable || inResourceTable) && (line.includes('AttributeKey') || line.includes('ResourceKey'))) {
      headerCols = line.split('|').map(c => c.trim()).filter(Boolean);
      continue;
    }
    // 跳过表头下方的 `---` 分隔行。
    if (line.match(/^\|\s*---/)) continue;

    // 逐行解析表格数据，遇到非表格行即结束当前表。
    if ((inAttrTable || inResourceTable) && line.startsWith('|') && currentSection) {
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length < 4) continue;

      const key = cols[0].replace(/`/g, '').replace(/\s*\[.*\]/, '').trim();
      if (!key || key === '---') continue;

      const typeStr = cols[2]?.toLowerCase().trim() || 'string';

      // 从右向左寻找已知 requirement level，兼容缺列的表格，例如 tool.name 没有 Example。
      let levelStr = '';
      for (let ci = 3; ci < cols.length; ci++) {
        const val = cols[ci].trim();
        if (LEVEL_MAP[val]) { levelStr = val; break; }
      }
      // 标准六列表格的 level 位于 cols[4]，也显式检查这个常见位置。
      if (!levelStr && cols[4] && LEVEL_MAP[cols[4].trim()]) {
        levelStr = cols[4].trim();
      }

      const level = LEVEL_MAP[levelStr];
      if (!level) continue;

      // 从 Example 列提取期望值；标准六列表格中它位于 cols[3]。
      const example = cols[3]?.replace(/`/g, '').trim() || '';
      const isExampleALevel = !!LEVEL_MAP[example];

      const attr = { key, type: normalizeType(typeStr) };

      // 对 span.kind 字段进一步推导结构化 expectedValue。
      if (key === 'gen_ai.span.kind') {
        if (!isExampleALevel && example && SECTION_MAP[example] !== undefined) {
          attr.expectedValue = example;
        } else {
          const kindFromSection = currentSection;
          if (kindFromSection !== 'COMMON') attr.expectedValue = kindFromSection;
        }
      }

      attr.level = level;

      if (inResourceTable) {
        sections[currentSection].resources.push(attr);
      } else {
        sections[currentSection].attrs.push(attr);
      }
    }
  }

  return sections;
}

/**
 * 将规范中的类型文本归一化为校验器支持的 integer/number/string_array/string。
 * @param {string} t 原始类型描述。
 * @returns {string} 稳定规则类型。
 */
function normalizeType(t) {
  if (t.includes('int')) return 'integer';
  if (t.includes('float') || t.includes('double')) return 'number';
  if (t.includes('string[]')) return 'string_array';
  return 'string';
}

// ─── Operation 与 Span Kind 映射解析器 ──────────────────────────────────────

/**
 * 从 operation.name 映射表解析每个操作所属 `gen_ai.span.kind`。
 * @param {string} md 同一份规范 Markdown。
 * @returns {Record<string,string>} operation name 到 Span kind 的映射。
 */
function parseOperationKindMapping(md) {
  const mapping = {};
  const lines = md.split('\n');
  let inMappingTable = false;

  for (const line of lines) {
    if (line.includes('`gen_ai.span.kind`') && line.includes('`gen_ai.operation.name`') && line.includes('Description')) {
      inMappingTable = true;
      continue;
    }
    if (inMappingTable && line.match(/^\|\s*---/)) continue;
    if (inMappingTable && line.startsWith('|')) {
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length < 3) { inMappingTable = false; continue; }
      const spanKind = cols[0].trim();
      const opNames = cols[1].replace(/`/g, '').split(';').map(s => s.trim()).filter(s => s && s !== '-');
      for (const op of opNames) {
        mapping[op] = spanKind;
      }
    } else if (inMappingTable && !line.startsWith('|')) {
      inMappingTable = false;
    }
  }

  // 补充规范表格之外、由当前设计明确约定的映射。
  if (!mapping['enter']) mapping['enter'] = 'ENTRY';
  if (!mapping['react']) mapping['react'] = 'STEP';
  if (!mapping['run_task']) mapping['run_task'] = 'TASK';
  if (!mapping['workflow']) mapping['workflow'] = 'CHAIN';
  if (!mapping['task']) mapping['task'] = 'CHAIN';
  if (!mapping['rerank']) mapping['rerank'] = 'RERANKER';

  return mapping;
}

// ─── 构建规则 JSON ───────────────────────────────────────────────────────────

// 覆盖项：当前设计决策与原始规范 requirement level 不同的部分。
const LEVEL_OVERRIDES = {
  // 设计文档规定：这些字段在所有 span 上都是 MUST。
  'gen_ai.session.id': 'must',
  'gen_ai.user.id': 'must',
  'gen_ai.agent.name': 'must',
  // 设计文档规定：TOOL span 的 tool.name 是 MUST。
  'TOOL:gen_ai.tool.name': 'must',
  // 设计文档规定：AGENT span 的 agent.name 是 MUST。
  'AGENT:gen_ai.agent.name': 'must',
};

// 这些属性虽然出现在公共表中，实际应归到各 kind 规则，不能写入 common。
const PER_KIND_ONLY_KEYS = new Set([
  'gen_ai.span.kind',
  'gen_ai.operation.name',
]);

// 规范标为“可选”但设计文档提升为 SHOULD 的属性。
const OPTIONAL_TO_SHOULD = {
  'RERANKER:reranker.query': true,
  'RERANKER:reranker.model_name': true,
  'RERANKER:reranker.top_k': true,
  'RETRIEVER:gen_ai.retrieval.documents': true,
  'RETRIEVER:gen_ai.retrieval.query.text': true,
  'TASK:input.value': true,
  'TASK:input.mime_type': true,
  'TASK:output.value': true,
  'TASK:output.mime_type': true,
  'EMBEDDING:gen_ai.usage.input_tokens': true,
  'EMBEDDING:gen_ai.usage.total_tokens': true,
};

// 仅在启用 captureMessageContent 时才应校验的内容属性。
const MESSAGE_CONTENT_KEYS = new Set([
  'gen_ai.input.messages', 'gen_ai.output.messages',
  'gen_ai.system_instructions', 'gen_ai.tool.definitions',
  'gen_ai.tool.call.arguments', 'gen_ai.tool.call.result',
  'gen_ai.input.multimodal_metadata', 'gen_ai.output.multimodal_metadata',
]);

// 已知属性到校验值类型的 schema 映射。
const SCHEMA_MAP = {
  'gen_ai.input.messages': 'input_messages',
  'gen_ai.output.messages': 'output_messages',
  'gen_ai.system_instructions': 'system_instructions',
  'gen_ai.tool.definitions': 'tool_definitions',
  'gen_ai.retrieval.documents': 'retrieval_documents',
};

// Span kind 的结构元数据来自设计文档，无法单从属性表推导。
const SPAN_KIND_META = {
  ENTRY:     { namePattern: 'enter_ai_application_system', operationName: 'enter', multiplicity: 'exactly_one', parentKind: null, allowedChildren: ['AGENT'] },
  AGENT:     { namePattern: '{gen_ai.operation.name} {gen_ai.agent.name}', operationName: ['invoke_agent', 'create_agent'], multiplicity: 'exactly_one', parentKind: 'ENTRY', allowedChildren: ['STEP'],
               aggregation: { 'gen_ai.usage.input_tokens': { rule: 'sum', source: 'LLM' }, 'gen_ai.usage.output_tokens': { rule: 'sum', source: 'LLM' }, 'gen_ai.usage.total_tokens': { rule: 'sum', source: 'LLM' } } },
  STEP:      { namePattern: 'react step', operationName: 'react', multiplicity: 'one_or_more', parentKind: 'AGENT', allowedChildren: ['LLM', 'TOOL'],
               constraints: [{ rule: 'exactly_one_child_of_kind', kind: 'LLM' }, { rule: 'llm_starts_before_all_tools' }, { rule: 'no_time_overlap_between_siblings' }] },
  LLM:       { namePattern: '{gen_ai.operation.name} {gen_ai.request.model}', operationName: ['chat', 'generate_content', 'text_completion'], multiplicity: 'one_or_more', parentKind: 'STEP', allowedChildren: [] },
  TOOL:      { namePattern: 'execute_tool {gen_ai.tool.name}', operationName: 'execute_tool', multiplicity: 'zero_or_more', parentKind: 'STEP', allowedChildren: [] },
  CHAIN:     { namePattern: 'chain {chain_name}', operationName: ['workflow', 'task'], multiplicity: 'zero_or_more', parentKind: null, allowedChildren: [] },
  RETRIEVER: { namePattern: '{gen_ai.operation.name} {gen_ai.data_source.id}', operationName: 'retrieval', multiplicity: 'zero_or_more', parentKind: null, allowedChildren: [] },
  RERANKER:  { namePattern: 'rerank {reranker.model_name}', operationName: 'rerank', multiplicity: 'zero_or_more', parentKind: null, allowedChildren: [] },
  EMBEDDING: { namePattern: '{gen_ai.operation.name} {gen_ai.request.model}', operationName: 'embeddings', multiplicity: 'zero_or_more', parentKind: null, allowedChildren: [] },
  TASK:      { namePattern: 'run_task {gen_ai.task.name}', operationName: 'run_task', multiplicity: 'zero_or_more', parentKind: null, allowedChildren: [] },
};

/**
 * 将解析结果、项目覆盖项和固定时间/语义/消息 Schema 规则组合成最终 JSON 对象。
 * 函数会提升部分 optional 属性、补齐 service.name 等兜底规则，但不写文件。
 * @param {object} sections `parseSpec` 的结果。
 * @param {object} operationKindMapping operation 映射。
 * @returns {object} `trace-validation-rules.json` 的完整结构。
 */
function buildRulesJson(sections, operationKindMapping) {
  // 构建公共属性，同时排除只能属于某个 kind 的 key。
  const commonRaw = sections['COMMON']?.attrs || [];
  const commonMust = [];
  const commonShould = [];
  for (const a of commonRaw) {
    if (PER_KIND_ONLY_KEYS.has(a.key)) continue;
    const overrideLevel = LEVEL_OVERRIDES[a.key];
    const level = overrideLevel || a.level;
    if (level === 'must') commonMust.push(buildAttrEntry(a, null));
    else if (level === 'should') commonShould.push(buildAttrEntry(a, null));
  }

  // Span 类型。
  const spanKinds = {};
  for (const [kind, meta] of Object.entries(SPAN_KIND_META)) {
    const sectionAttrs = sections[kind]?.attrs || [];
    const must = [];
    const should = [];

    for (const a of sectionAttrs) {
      const overrideLevel = LEVEL_OVERRIDES[`${kind}:${a.key}`] || LEVEL_OVERRIDES[a.key];
      let level = overrideLevel || a.level;
  // 按设计文档把指定属性从 optional 提升为 should。
      if (level === 'optional' && OPTIONAL_TO_SHOULD[`${kind}:${a.key}`]) level = 'should';
      const entry = buildAttrEntry(a, kind);

      if (level === 'must') must.push(entry);
      else if (level === 'should') should.push(entry);
    }

    const kindDef = { ...meta, attributes: { must, should } };
    if (meta.aggregation) kindDef.aggregation = meta.aggregation;
    if (meta.constraints) kindDef.constraints = meta.constraints;
    spanKinds[kind] = kindDef;
  }

  // 构建 Resource 属性规则。
  const resourceRaw = sections['COMMON']?.resources || [];
  const resMust = [];
  const resShould = [];
  for (const a of resourceRaw) {
    const entry = { key: a.key, type: a.type };
    if (a.expectedValue) entry.expectedValue = a.expectedValue;
    if (a.level === 'must') resMust.push(entry);
    else if (a.level === 'should') resShould.push(entry);
  }
  // 强制保证 service.name 始终属于 must。
  if (!resMust.some(r => r.key === 'service.name')) {
    resMust.push({ key: 'service.name', type: 'string' });
  }
  // 强制保证 acs.arms.service.feature 属于 should。
  if (!resShould.some(r => r.key === 'acs.arms.service.feature')) {
    resShould.push({ key: 'acs.arms.service.feature', type: 'string', expectedValue: 'genai_app' });
  }

  return {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    specSource: 'docs/EVENT_LOG_TO_TRACE_SPEC.md',

    commonAttributes: { must: commonMust, should: commonShould },
    spanKinds,
    operationKindMapping,

    timeRules: [
      { id: 'time.non_zero_duration', applies: 'all', severity: 'error' },
      { id: 'time.no_step_overlap', applies: 'STEP', severity: 'error' },
      { id: 'time.parent_contains_children', applies: 'all', severity: 'error', toleranceMs: 0 },
      { id: 'time.reasonable_duration', applies: 'LLM', maxMs: 600000, severity: 'warn' },
      { id: 'time.chronological_steps', applies: 'STEP', severity: 'warn' },
    ],

    semanticRules: [
      { id: 'semantic.agent_token_sum', severity: 'error' },
      { id: 'semantic.tool_matches_llm_output', severity: 'error', requiresMessageContent: true },
      { id: 'semantic.entry_input_exists', severity: 'warn', requiresMessageContent: true },
      { id: 'semantic.entry_output_matches', severity: 'warn', requiresMessageContent: true },
      { id: 'semantic.consistent_session_id', severity: 'error' },
      { id: 'semantic.consistent_user_id', severity: 'error' },
      { id: 'semantic.consistent_agent_name', severity: 'warn' },
      { id: 'semantic.llm_has_input_output', severity: 'warn', requiresMessageContent: true },
      { id: 'semantic.operation_kind_mapping', severity: 'error' },
      { id: 'semantic.span_name_pattern', severity: 'warn' },
      { id: 'semantic.tool_response_role', severity: 'error', requiresMessageContent: true },
      { id: 'semantic.last_step_no_tool_call', severity: 'error', requiresMessageContent: true },
    ],

    resourceAttributes: { must: resMust, should: resShould },

    messageSchemas: {
      input_messages: '$ref:tests/schemas/gen-ai-input-messages.json',
      output_messages: '$ref:tests/schemas/gen-ai-output-messages.json',
      system_instructions: '$ref:tests/schemas/gen-ai-system_instructions.json',
      tool_definitions: '$ref:tests/schemas/gen-ai-tool-definitions.json',
      retrieval_documents: '$ref:tests/schemas/gen-ai-retrieval-documents.json',
    },
  };
}

/**
 * 把单条规范属性转换为校验器条目，并附加数值下界、Schema 和内容采集前置条件。
 * @param {object} raw 解析后的属性。
 * @param {string|null} spanKind 所属 Span kind；当前只作为扩展参数保留。
 * @returns {object} 规则条目。
 */
function buildAttrEntry(raw, spanKind) {
  const entry = { key: raw.key, type: raw.type };
  if (raw.expectedValue) entry.expectedValue = raw.expectedValue;
  if (raw.type === 'integer') entry.min = 0;
  if (SCHEMA_MAP[raw.key]) { entry.schema = SCHEMA_MAP[raw.key]; }
  if (MESSAGE_CONTENT_KEYS.has(raw.key)) entry.requiresMessageContent = true;
  return entry;
}

// ─── 差异比较 ──────────────────────────────────────────────────────────────────

/**
 * 比较旧/新规则的 Span kind、属性级别和 operation 映射，生成面向维护者的变更摘要。
 * @param {object} oldRules 已存在规则。
 * @param {object} newRules 新生成规则。
 * @returns {string[]} 以 +、-、^、v、~ 标识变化的文本行。
 */
function diffRules(oldRules, newRules) {
  const changes = [];

  // 比较各 span kind 的字段规则。
  for (const kind of new Set([...Object.keys(oldRules.spanKinds || {}), ...Object.keys(newRules.spanKinds || {})])) {
    const oldK = oldRules.spanKinds?.[kind];
    const newK = newRules.spanKinds?.[kind];
    if (!oldK && newK) { changes.push(`+ added span kind: ${kind}`); continue; }
    if (oldK && !newK) { changes.push(`- removed span kind: ${kind}`); continue; }

    const oldKeys = new Set([...oldK.attributes.must.map(a => a.key), ...oldK.attributes.should.map(a => a.key)]);
    const newKeys = new Set([...newK.attributes.must.map(a => a.key), ...newK.attributes.should.map(a => a.key)]);
    for (const k of newKeys) { if (!oldKeys.has(k)) changes.push(`+ ${kind}: added attribute ${k}`); }
    for (const k of oldKeys) { if (!newKeys.has(k)) changes.push(`- ${kind}: removed attribute ${k}`); }

    const oldMustKeys = new Set(oldK.attributes.must.map(a => a.key));
    const newMustKeys = new Set(newK.attributes.must.map(a => a.key));
    for (const k of newMustKeys) { if (!oldMustKeys.has(k) && oldKeys.has(k)) changes.push(`^ ${kind}: ${k} upgraded to MUST`); }
    for (const k of oldMustKeys) { if (!newMustKeys.has(k) && newKeys.has(k)) changes.push(`v ${kind}: ${k} downgraded from MUST`); }
  }

  // 比较 operation 到 kind 的映射。
  for (const op of new Set([...Object.keys(oldRules.operationKindMapping || {}), ...Object.keys(newRules.operationKindMapping || {})])) {
    const oldV = oldRules.operationKindMapping?.[op];
    const newV = newRules.operationKindMapping?.[op];
    if (!oldV && newV) changes.push(`+ mapping: ${op} -> ${newV}`);
    else if (oldV && !newV) changes.push(`- mapping: ${op} -> ${oldV}`);
    else if (oldV !== newV) changes.push(`~ mapping: ${op}: ${oldV} -> ${newV}`);
  }

  return changes;
}

// ─── 主流程 ────────────────────────────────────────────────────────────────────

/**
 * 异步命令入口：读取规范、解析、构建、可选 diff，最后同步写 JSON 输出文件。
 * fetch/解析/写入错误通过 rejected Promise 传播到文件末尾的 catch，并设置退出码 1。
 * @returns {Promise<void>}
 */
async function main() {
  const specContent = await fetchSpec();
  console.log(`${TAG} spec loaded (${specContent.length} chars)`);

  const sections = parseSpec(specContent);
  const parsedKinds = Object.keys(sections).filter(k => k !== 'COMMON');
  console.log(`${TAG} parsed sections: COMMON, ${parsedKinds.join(', ')}`);
  for (const [kind, data] of Object.entries(sections)) {
    console.log(`${TAG}   ${kind}: ${data.attrs.length} attributes, ${data.resources.length} resources`);
  }

  const operationKindMapping = parseOperationKindMapping(specContent);
  console.log(`${TAG} operation-kind mappings: ${Object.keys(operationKindMapping).length}`);

  const newRules = buildRulesJson(sections, operationKindMapping);

  // 与当前落盘规则比较并按 --diff 决定输出方式。
  const outputPath = opts.output;
  if (existsSync(outputPath)) {
    const oldRules = JSON.parse(readFileSync(outputPath, 'utf8'));
    const changes = diffRules(oldRules, newRules);
    if (changes.length === 0) {
      console.log(`${TAG} no changes detected`);
    } else {
      console.log(`${TAG} ${changes.length} change(s) detected:`);
      for (const c of changes) console.log(`${TAG}   ${c}`);
    }
    if (opts.diff) {
      process.exit(0);
    }
  }

  writeFileSync(outputPath, JSON.stringify(newRules, null, 2) + '\n', 'utf8');
  console.log(`${TAG} rules written to ${outputPath}`);

  // 验证生成结果。
  const verify = JSON.parse(readFileSync(outputPath, 'utf8'));
  const kindCount = Object.keys(verify.spanKinds).length;
  const totalAttrs = Object.values(verify.spanKinds).reduce((sum, k) => sum + k.attributes.must.length + k.attributes.should.length, 0);
  console.log(`${TAG} verification: ${kindCount} span kinds, ${totalAttrs} total attributes, ${Object.keys(verify.operationKindMapping).length} mappings`);
}

main().catch(e => { console.error(`${TAG} error: ${e.message}`); process.exit(1); });
