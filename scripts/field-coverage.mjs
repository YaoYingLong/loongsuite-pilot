#!/usr/bin/env node

// 规范化事件字段覆盖率诊断命令。它从默认 JSONL 输出目录或命令行指定 Agent/日期选择文件，
// 统计各事件类型关键字段的填充率，与阈值比较后输出文本或 JSON 报告。
// 本脚本同步读取本地文件，不修改采集状态；输入/参数错误或覆盖率不达标会通过非零退出码告知 CI。
// `import`/`export` 属于项目 ESM 模式，Node.js 解析异步 API 时仍由 `main()` 顶层统一捕获错误。

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const OUTPUT_DIR = path.join(homedir(), '.loongsuite-pilot', 'logs', 'output');

const FIELD_SPECS = {
  'llm.request': {
    fields: [
      { key: 'event.id', label: 'event.id' },
      { key: 'user.id', label: 'user.id' },
      { key: 'gen_ai.session.id', label: 'session.id' },
      { key: 'gen_ai.turn.id', label: 'turn.id' },
      { key: 'gen_ai.step.id', label: 'step.id' },
      { key: 'gen_ai.provider.name', label: 'provider' },
      { key: 'gen_ai.request.model', label: 'request.model' },
      { key: 'gen_ai.input.messages_delta', label: 'input.msg_delta' },
    ],
  },
  'llm.response': {
    fields: [
      { key: 'event.id', label: 'event.id' },
      { key: 'user.id', label: 'user.id' },
      { key: 'gen_ai.session.id', label: 'session.id' },
      { key: 'gen_ai.step.id', label: 'step.id' },
      { key: 'gen_ai.response.id', label: 'response.id' },
      { key: 'gen_ai.response.model', label: 'response.model' },
      { key: 'gen_ai.response.finish_reasons', label: 'finish_reasons' },
      { key: 'gen_ai.usage.input_tokens', label: 'input_tokens' },
      { key: 'gen_ai.usage.output_tokens', label: 'output_tokens' },
      { key: 'gen_ai.output.messages', label: 'output.msg' },
    ],
  },
  'tool.call': {
    fields: [
      { key: 'event.id', label: 'event.id' },
      { key: 'user.id', label: 'user.id' },
      { key: 'gen_ai.session.id', label: 'session.id' },
      { key: 'gen_ai.step.id', label: 'step.id' },
      { key: 'gen_ai.tool.name', label: 'tool.name' },
      { key: 'gen_ai.tool.call.id', label: 'tool.call.id' },
      { key: 'gen_ai.tool.call.arguments', label: 'tool.call.args' },
    ],
  },
  'tool.result': {
    fields: [
      { key: 'event.id', label: 'event.id' },
      { key: 'user.id', label: 'user.id' },
      { key: 'gen_ai.session.id', label: 'session.id' },
      { key: 'gen_ai.step.id', label: 'step.id' },
      { key: 'gen_ai.tool.name', label: 'tool.name' },
      { key: 'gen_ai.tool.call.id', label: 'tool.call.id' },
      { key: 'gen_ai.tool.call.duration', label: 'tool.call.dur' },
    ],
  },
};

/**
 * 解析 Agent 列表、日期、阈值、格式和输出路径；非法用法以退出码 2 结束。
 * @returns {{agents:string[],date:string,threshold:number,format:string,output?:string}}
 */
function parseCli() {
  const { values } = parseArgs({
    options: {
      agents:    { type: 'string', short: 'a' },
      date:      { type: 'string', short: 'd' },
      threshold: { type: 'string', short: 't', default: '90' },
      format:    { type: 'string', short: 'f', default: 'text' },
      output:    { type: 'string', short: 'o' },
    },
    strict: true,
  });
  if (!values.agents) {
    console.error('error: --agents is required (comma-separated agent names)');
    process.exit(2);
  }
  if (!['text', 'json'].includes(values.format)) {
    console.error('error: --format must be text or json');
    process.exit(2);
  }
  const today = new Date();
  const defaultDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return {
    agents: values.agents.split(',').map(a => a.trim()),
    date: values.date || defaultDate,
    threshold: Number(values.threshold),
    format: values.format,
    output: values.output,
  };
}

/**
 * 判断规范化字段是否真正有值；`undefined`、`null`、空串和字面量 `"null"` 均视为缺失。
 * @returns {boolean}
 */
function isFilled(value) {
  if (value === undefined || value === null) return false;
  const s = String(value);
  return s !== '' && s !== 'null';
}

/**
 * 把 Agent+日期转换为 JSONL 路径，并为缺失目标列出最多三个可用文件。
 * @param {string[]} agents CLI Agent 名称。
 * @param {string} date `YYYY-MM-DD`。
 * @returns {{agent:string,filepath:string,filename:string}[]} 至少一个可读文件，否则退出码 2。
 */
function resolveFiles(agents, date) {
  const resolved = [];
  for (const agent of agents) {
    const filename = `${agent}-${date}.jsonl`;
    const filepath = path.join(OUTPUT_DIR, filename);
    try {
      readFileSync(filepath, { flag: 'r' });
      resolved.push({ agent, filepath, filename });
    } catch {
      const available = readdirSync(OUTPUT_DIR)
        .filter(f => f.startsWith(agent + '-') && f.endsWith('.jsonl'))
        .sort()
        .reverse()
        .slice(0, 3);
      console.error(`warning: ${filename} not found. Available: ${available.join(', ') || 'none'}`);
    }
  }
  if (resolved.length === 0) {
    console.error('error: no valid files found');
    process.exit(2);
  }
  return resolved;
}

/** 同步地汇总 collectStats 的输入记录，返回供报告或 Dashboard 使用的统计结构。 */
function collectStats(files) {
  // stats[eventName][agentType] = { total, filled: { fieldKey: count } }
  const stats = {};
  for (const eventName of Object.keys(FIELD_SPECS)) {
    stats[eventName] = {};
  }
  for (const { filepath } of files) {
    const content = readFileSync(filepath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const eventName = entry['event.name'];
      if (!FIELD_SPECS[eventName]) continue;
      const agentType = entry['gen_ai.agent.type'] || 'unknown';
      if (!stats[eventName][agentType]) {
        stats[eventName][agentType] = { total: 0, filled: {} };
        for (const f of FIELD_SPECS[eventName].fields) {
          stats[eventName][agentType].filled[f.key] = 0;
        }
      }
      const bucket = stats[eventName][agentType];
      bucket.total++;
      for (const f of FIELD_SPECS[eventName].fields) {
        if (isFilled(entry[f.key])) {
          bucket.filled[f.key]++;
        }
      }
    }
  }
  return stats;
}

/**
 * 把计数换算为一位小数百分比，标记是否达到阈值并按样本数排序。
 * @param {object} stats `collectStats` 结果。
 * @param {number} threshold 通过百分比阈值。
 * @returns {{threshold:number,tables:object[]}}
 */
function buildReport(stats, threshold) {
  const report = { threshold, tables: [] };
  for (const [eventName, spec] of Object.entries(FIELD_SPECS)) {
    const agentStats = stats[eventName];
    const rows = [];
    for (const [agentType, bucket] of Object.entries(agentStats)) {
      if (bucket.total === 0) continue;
      const fieldResults = spec.fields.map(f => {
        const pct = Math.round((bucket.filled[f.key] / bucket.total) * 1000) / 10;
        return { label: f.label, key: f.key, pct, pass: pct >= threshold };
      });
      const avg = Math.round((fieldResults.reduce((s, r) => s + r.pct, 0) / fieldResults.length) * 10) / 10;
      rows.push({ agentType, total: bucket.total, avg, fields: fieldResults });
    }
    rows.sort((a, b) => b.total - a.total);
    report.tables.push({ eventName, rows });
  }
  return report;
}

/**
 * 渲染中文终端表格并收集未达标字段，返回的 failures 供 main 决定退出码。
 */
function formatText(report) {
  const lines = [];
  const failures = [];
  for (const table of report.tables) {
    if (table.rows.length === 0) {
      lines.push(`\n═══ ${table.eventName} 填充率 ═══`);
      lines.push('  (无数据)');
      continue;
    }
    const fields = FIELD_SPECS[table.eventName].fields;
    const headerLabels = fields.map(f => f.label);
    lines.push(`\n═══ ${table.eventName} 填充率 (阈值: ${report.threshold}%) ═══\n`);
    const colWidths = [
      Math.max(12, ...table.rows.map(r => r.agentType.length + 2)),
      6, 7,
      ...headerLabels.map(l => Math.max(l.length + 1, 7)),
    ];
    const header = [
      'agent_type'.padEnd(colWidths[0]),
      '事件数'.padEnd(colWidths[1]),
      '综合(%)'.padEnd(colWidths[2]),
      ...headerLabels.map((l, i) => l.padEnd(colWidths[i + 3])),
    ].join(' | ');
    lines.push(`  ${header}`);
    lines.push(`  ${'-'.repeat(header.length)}`);
    for (const row of table.rows) {
      const cells = [
        row.agentType.padEnd(colWidths[0]),
        String(row.total).padStart(colWidths[1]),
        String(row.avg.toFixed(1)).padStart(colWidths[2]),
        ...row.fields.map((f, i) => {
          const val = f.pct.toFixed(1) + (f.pass ? '' : '\u274C');
          return val.padStart(colWidths[i + 3]);
        }),
      ].join(' | ');
      lines.push(`  ${cells}`);
      const failing = row.fields.filter(f => !f.pass);
      if (failing.length > 0) {
        failures.push({
          agent: row.agentType,
          event: table.eventName,
          fields: failing.map(f => `${f.label}(${f.pct.toFixed(1)}%)`),
        });
      }
    }
  }
  if (failures.length > 0) {
    lines.push(`\n⚠️  未达标字段 (< ${report.threshold}%):\n`);
    for (const f of failures) {
      lines.push(`  ${f.agent} / ${f.event}: ${f.fields.join(', ')}`);
    }
  } else {
    lines.push('\n✅ 所有字段填充率均达标！');
  }
  lines.push('');
  return lines.join('\n');
}

/** 作为 field-coverage.mjs 的命令入口，编排参数、I/O 和退出码；顶层错误由文件末尾统一处理。 */
function main() {
  const opts = parseCli();
  console.error(`[field-coverage] agents: ${opts.agents.join(', ')} | date: ${opts.date} | threshold: ${opts.threshold}%`);
  const files = resolveFiles(opts.agents, opts.date);
  console.error(`[field-coverage] loaded ${files.length} file(s): ${files.map(f => f.filename).join(', ')}`);
  const stats = collectStats(files);
  const report = buildReport(stats, opts.threshold);
  let output;
  if (opts.format === 'json') {
    output = JSON.stringify(report, null, 2);
  } else {
    output = formatText(report);
  }
  if (opts.output) {
    writeFileSync(opts.output, output, 'utf8');
    console.error(`[field-coverage] report written to ${opts.output}`);
  } else {
    console.log(output);
  }
  const hasFailure = report.tables.some(t => t.rows.some(r => r.fields.some(f => !f.pass)));
  process.exit(hasFailure ? 1 : 0);
}

main();
