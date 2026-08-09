// 本文件是本地 Dashboard 的聚合数据层。HTTP 服务通过 `createOverviewAggregator()` 创建一个长期实例，
// 它增量读取 Collector 服务日志、规范化 JSONL 输出和失败上传目录，合并为服务、Agent、采集方式、
// 上报健康、时间线与 token 使用概览，并把缓存原子写入数据目录以减少大文件重复扫描。
//
// 模块只读取 Pilot 本地文件，不连接 Agent 或远端后端。大部分 I/O 使用 Promise；文件轮转、截断、
// 半写 JSON 和权限失败会被降级为空/部分结果并记录诊断，避免 Dashboard 请求拖垮 Collector。

import { constants as fsConstants, createReadStream } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const DEFAULT_CACHE_TTL_MS = 5_000;
// 下列上限是 Dashboard 的资源保护边界：一次 HTTP 刷新只读取有限尾部/块，
// 大文件会跨多次请求逐步追平，而不会让事件循环长时间阻塞或分配无限内存。
const DEFAULT_SERVICE_LOG_TAIL_BYTES = 512 * 1024;
const DEFAULT_JSONL_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_FAILED_LOG_MAX_BYTES = 512 * 1024;
const DEFAULT_TIMELINE_LIMIT = 200;
const DEFAULT_CACHED_OUTPUT_EVENTS_PER_FILE = 50;
const OVERVIEW_CACHE_VERSION = 1;
const DEFAULT_INDEX_BYTES_PER_REFRESH = 5 * 1024 * 1024;
const DEFAULT_INDEX_LINES_PER_REFRESH = 20_000;
// 仅记录“某文件上次已打印到哪个 offset”，防止每次轮询重复输出相同的 partial-index 告警。
const partialIndexLogState = new Map();
// 超过 30 分钟没有新事件仍不等同于服务故障，Dashboard 使用单独的 no_recent_activity 状态表达。
const STALE_AFTER_MS = 30 * 60 * 1000;

export const AGENTS = [
  {
    id: 'cursor',
    label: 'Cursor',
    methods: ['cursor-hook'],
    collectionTypes: ['Hook events'],
  },
  {
    id: 'qoder',
    label: 'Qoder',
    methods: ['qoder-sqlite'],
    collectionTypes: ['Conversation events', 'Token usage'],
  },
  {
    id: 'qoder-cli',
    label: 'Qoder CLI',
    methods: ['qoder-cli-hook', 'qoder-cli-session'],
    collectionTypes: ['CLI transcript events', 'CLI session logs'],
  },
  {
    id: 'qoder-combined',
    label: 'Qoder / Qoder CLI',
    methods: ['qoder-cli-hook', 'qoder-cli-session'],
    collectionTypes: ['Ambiguous Qoder-family events'],
    hiddenWhenEmpty: true,
  },
  {
    id: 'qoder-work',
    label: 'Qoder Work',
    methods: ['qoder-work-hook'],
    collectionTypes: ['Hook events'],
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    methods: ['claude-code-log'],
    collectionTypes: ['OpenTelemetry logs'],
  },
  {
    id: 'codex',
    label: 'Codex',
    methods: ['codex-log'],
    collectionTypes: ['OpenTelemetry logs'],
  },
];

const AGENT_BY_ID = new Map(AGENTS.map((agent) => [agent.id, agent]));

// Input ID 是 Collector 内部实现名，Dashboard 标签是面向用户的采集方式名称；两者不要反向用于启动 Input。
const METHOD_LABELS = {
  'cursor-hook': 'Cursor hook events',
  'qoder-sqlite': 'Qoder token usage',
  'qoder-cli-hook': 'Qoder/Qoder CLI hook events',
  'qoder-cli-session': 'Qoder CLI session logs',
  'qoder-work-hook': 'Qoder Work hook events',
  'claude-code-log': 'Claude Code logs',
  'codex-log': 'Codex logs',
};

/** 把 Date 转换为本地 YYYY-MM-DD，供每日 JSONL 文件筛选使用。 */
export function localDateString(date = new Date()) {
  // Date#getMonth 从 0 开始，因此月份需要加 1；padStart 保持与 JSONL 文件名的两位格式一致。
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

/** 把 attributes 对象或 JSON 字符串规范化为普通对象，非法值返回空对象。 */
export function parseAttributes(value) {
  // JsonlFlusher 可能输出对象，也可能输出序列化字符串；先保留已经是普通对象的情况。
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    // 数组虽属于 object，但不具备 attributes 的键值语义，故也按无效值处理。
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 根据 Input ID 判断采集方式，供 Dashboard 合并同类监听器状态。 */
export function classifyMethod(inputId) {
  switch (inputId) {
    case 'cursor-hook':
      return 'cursor';
    case 'qoder-sqlite':
      return 'qoder';
    case 'qoder-work-hook':
    case 'qoder-work':
      return 'qoder-work';
    case 'qoder-cli-hook':
    case 'qoder-cli-session':
      return 'qoder-combined';
    case 'claude-code-log':
      return 'claude-code';
    case 'codex-log':
      return 'codex';
    default:
      return 'unknown';
  }
}

/** 从规范化事件识别 Agent、采集方式、token、会话和仓库维度。 */
export function classifyRecord(record) {
  // 兼容不同版本的扁平字段与 attributes 嵌套字段；所有判定值统一小写以消除大小写差异。
  const attributes = parseAttributes(record.attributes);
  const agentType = stringValue(record['gen_ai.agent.type'] ?? record['agent.type']).toLowerCase();
  const source = stringValue(attributes.source ?? record['agent.source']).toLowerCase();
  const variant = stringValue(
    attributes.qoder_variant ??
    record['agent.qoder_variant'] ??
    record['agent.qoder.variant'] ??
    record['agent.qoderwork.variant'],
  ).toLowerCase();
  const entrypoint = stringValue(
    attributes.entrypoint ?? record['agent.entrypoint'] ?? record.entrypoint,
  ).toLowerCase();

  // 判定优先级很重要：Qoder Work/CLI 都属于 Qoder 家族，必须在宽泛的 qoder 分支前命中。
  if (agentType === 'cursor' || agentType === 'cursor-cli') return 'cursor';
  if (agentType === 'qoder-work' || variant === 'qoder-work') return 'qoder-work';
  if (agentType === 'qoder-cli' || variant === 'qoder-cli' || entrypoint === 'cli') return 'qoder-cli';
  if (agentType === 'qoder' || variant === 'qoder') return 'qoder';
  if (source === 'qoder-sqlite-chat-message') return 'qoder';
  if (source === 'qoder-cli-session-segment') return 'qoder-cli';
  if (agentType.includes('claude')) return 'claude-code';
  if (agentType.includes('codex')) return 'codex';
  return 'unknown';
}

/** 创建带内存缓存和串行刷新 Promise 的聚合器，HTTP 服务在进程生命周期内复用它。 */
export function createOverviewAggregator(options = {}) {
  // 调用方可注入目录、预算和时钟，生产环境使用默认值，测试则用临时目录和确定性时间。
  const dataDir = options.dataDir || path.join(homedir(), '.loongsuite-pilot');
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const serviceLogTailBytes = options.serviceLogTailBytes ?? DEFAULT_SERVICE_LOG_TAIL_BYTES;
  const jsonlMaxBytes = options.jsonlMaxBytes ?? DEFAULT_JSONL_MAX_BYTES;
  const failedLogMaxBytes = options.failedLogMaxBytes ?? DEFAULT_FAILED_LOG_MAX_BYTES;
  const timelineLimit = options.timelineLimit ?? DEFAULT_TIMELINE_LIMIT;
  const cachedOutputEventsPerFile = options.cachedOutputEventsPerFile ?? DEFAULT_CACHED_OUTPUT_EVENTS_PER_FILE;
  const maxIndexBytesPerRefresh = options.maxIndexBytesPerRefresh ?? DEFAULT_INDEX_BYTES_PER_REFRESH;
  const maxIndexLinesPerRefresh = options.maxIndexLinesPerRefresh ?? DEFAULT_INDEX_LINES_PER_REFRESH;
  const overviewCachePath = options.overviewCachePath
    || path.join(dataDir, 'cache', 'agent-overview', 'output-summary-cache.json');
  const nowProvider = options.nowProvider || (() => new Date());

  // cachedSummary 是短 TTL 的完整 HTTP 响应；overviewCache 是跨刷新、可落盘的逐文件增量索引。
  let cachedSummary = null;
  let cachedAt = 0;
  let overviewCache = null;
  // buildChain 充当轻量互斥锁：多个并发 HTTP 请求不会同时扫描并覆盖同一份 offset 缓存。
  let buildChain = Promise.resolve();

  /**
   * 返回 Dashboard 总览；`force` 仅绕过 TTL，仍会等待前一个构建完成以保护共享缓存。
   * @param {{force?: boolean}} [requestOptions] 请求级选项。
   * @returns {Promise<object>} 可直接序列化为 JSON 的总览对象。
   */
  async function getOverview({ force = false } = {}) {
    const now = nowProvider();
    if (!force && cachedSummary && now.getTime() - cachedAt < cacheTtlMs) {
      return {
        ...cachedSummary,
        cache: { ...cachedSummary.cache, hit: true },
      };
    }

    // 先保存旧链，再把 buildChain 换成当前请求的“闸门”；后来的请求会等待这个闸门。
    const previousBuild = buildChain;
    let releaseBuild;
    buildChain = new Promise((resolve) => {
      releaseBuild = resolve;
    });
    // 上一次构建即使失败也必须释放队列；当前请求会自行重新尝试读取数据。
    await previousBuild.catch(() => {});
    try {
      const lockedNow = nowProvider();
      // 排队期间另一个请求可能已生成新缓存，获得锁后必须二次检查，避免重复扫描。
      if (!force && cachedSummary && lockedNow.getTime() - cachedAt < cacheTtlMs) {
        return {
          ...cachedSummary,
          cache: { ...cachedSummary.cache, hit: true },
        };
      }
      // `||=` 只在本进程首次构建时读磁盘，后续直接复用并原地更新内存索引。
      overviewCache ||= await loadOverviewCache(overviewCachePath);

      const summary = await buildOverview({
        dataDir,
        now: lockedNow,
        serviceLogTailBytes,
        jsonlMaxBytes,
        failedLogMaxBytes,
        timelineLimit,
        overviewCache,
        overviewCachePath,
        cachedOutputEventsPerFile,
        maxIndexBytesPerRefresh,
        maxIndexLinesPerRefresh,
      });
      cachedSummary = summary;
      cachedAt = lockedNow.getTime();
      return summary;
    } finally {
      // finally 确保 buildOverview 抛错时也唤醒下一个排队请求，避免永久死锁。
      releaseBuild();
    }
  }

  async function getAgent(agentId) {
    // 复用完整总览而不是单独扫描该 Agent，保证详情与列表处于同一缓存快照。
    const overview = await getOverview();
    return overview.agents.find((agent) => agent.id === agentId) || null;
  }

  return { getOverview, getAgent };
}

/** 并行读取配置、版本、服务日志、JSONL 和失败上传记录，再组装一次 Dashboard 总览。 */
async function buildOverview(opts) {
  // 这些读取目前按顺序执行，因为 output 聚合会修改并落盘共享缓存；每项都采用自身的 fail-open 读取器。
  const config = await readConfig(opts.dataDir);
  const version = await readVersion(opts.dataDir);
  const service = await buildServiceSummary(opts.dataDir, version, opts.now);
  const serviceLog = await parseServiceLog(path.join(opts.dataDir, 'logs', 'loongsuite-pilot-service.log'), {
    maxBytes: opts.serviceLogTailBytes,
    timelineLimit: opts.timelineLimit,
  });
  const output = await aggregateOutputFiles(path.join(opts.dataDir, 'logs', 'output'), {
    date: localDateString(opts.now),
    overviewCache: opts.overviewCache,
    overviewCachePath: opts.overviewCachePath,
    cachedOutputEventsPerFile: opts.cachedOutputEventsPerFile,
    maxIndexBytesPerRefresh: opts.maxIndexBytesPerRefresh,
    maxIndexLinesPerRefresh: opts.maxIndexLinesPerRefresh,
  });
  const failures = await aggregateFailedUploads(path.join(opts.dataDir, 'logs', 'sls-failed-logs'), {
    maxBytes: opts.failedLogMaxBytes,
  });

  // 日志反映 Input 生命周期，JSONL 反映实际落地事件；两种证据合并后才生成方法状态。
  const methodStates = buildMethodStates(serviceLog, output, opts.now);
  const agents = buildAgentSummaries({
    methodStates,
    output,
    service,
    now: opts.now,
  });
  const reporting = buildReportingSummary(config, output, failures);
  const timeline = buildTimeline({
    serviceLog,
    output,
    failures,
    limit: opts.timelineLimit,
  });

  return {
    generatedAt: opts.now.toISOString(),
    dataDir: opts.dataDir,
    service,
    reporting,
    totals: {
      // agents 已包含每个受支持 Agent 的零值桶，reduce 因此在无输出时自然得到 0。
      eventsToday: agents.reduce((sum, agent) => sum + agent.todayEvents, 0),
      tokensToday: agents.reduce((sum, agent) => sum + agent.tokensToday, 0),
      failedUploadsToday: failures.total,
      agentsCollecting: agents.filter((agent) => agent.status === 'active').length,
    },
    agents: agents.filter((agent) => !agent.hiddenWhenEmpty || agent.todayEvents > 0),
    timeline,
    cache: {
      hit: false,
      ttlMs: DEFAULT_CACHE_TTL_MS,
      bounded: true,
      indexing: output.indexing,
      outputPartial: output.partial,
      outputProgress: output.progress,
      limits: {
        serviceLogTailBytes: opts.serviceLogTailBytes,
        timelineLimit: opts.timelineLimit,
        cachedOutputEventsPerFile: opts.cachedOutputEventsPerFile,
        maxIndexBytesPerRefresh: opts.maxIndexBytesPerRefresh,
        maxIndexLinesPerRefresh: opts.maxIndexLinesPerRefresh,
        failedLogMaxBytes: opts.failedLogMaxBytes,
      },
    },
  };
}

/** 读取并容错解析 readConfig 所需的本地状态，不把非关键 I/O 错误传播给 Dashboard。 */
async function readConfig(dataDir) {
  const configPath = path.join(dataDir, 'config.json');
  const raw = await safeReadFile(configPath, 'utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** 读取并容错解析 readVersion 所需的本地状态，不把非关键 I/O 错误传播给 Dashboard。 */
async function readVersion(dataDir) {
  const current = (await safeReadFile(path.join(dataDir, 'current'), 'utf8'))?.trim();
  const candidates = [
    // 多版本安装优先读取 current 指向版本；其余两项兼容旧 package 布局和源码运行。
    current ? path.join(dataDir, 'versions', current, 'VERSION') : '',
    path.join(dataDir, 'package', 'VERSION'),
    path.resolve(process.cwd(), 'VERSION'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const raw = await safeReadFile(candidate, 'utf8');
    if (!raw) continue;
    const parsed = {};
    // VERSION 同时兼容单行纯版本号和 `key=value` 多行格式。
    for (const line of raw.split(/\r?\n/)) {
      const [key, ...parts] = line.split('=');
      if (key && parts.length) parsed[key.trim()] = parts.join('=').trim();
    }
    if (parsed.version || raw.trim()) {
      return {
        version: parsed.version || raw.trim(),
        gitCommit: parsed.git_commit,
      };
    }
  }
  return { version: 'unknown' };
}

/** 组合已聚合数据生成 buildServiceSummary 对应的 Dashboard 视图模型，不直接写源日志。 */
async function buildServiceSummary(dataDir, version, now) {
  const pidFile = path.join(dataDir, 'loongsuite-pilot.pid');
  const pidRaw = (await safeReadFile(pidFile, 'utf8'))?.trim();
  const pid = pidRaw && /^\d+$/.test(pidRaw) ? Number(pidRaw) : null;
  // PID 文件存在不代表进程仍存活，必须用 signal 0 做无副作用探测。
  const running = pid !== null && processIsRunning(pid);
  const serviceLogPath = path.join(dataDir, 'logs', 'loongsuite-pilot-service.log');
  const serviceStat = await safeStat(serviceLogPath);

  return {
    status: running ? 'running' : 'stopped',
    running,
    pid,
    version: version.version,
    gitCommit: version.gitCommit,
    dataDir,
    lastObservedAt: serviceStat?.mtime ? serviceStat.mtime.toISOString() : null,
    checkedAt: now.toISOString(),
  };
}

/** 实现 Dashboard 聚合流程中的 processIsRunning 辅助计算；不产生网络请求。 */
function processIsRunning(pid) {
  try {
    // signal 0 不会终止进程，只检查 PID 是否存在且当前用户有权向其发送信号。
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 解析 parseServiceLog 的输入并在格式无效时返回可跳过的空值。 */
async function parseServiceLog(filePath, options) {
  // 只读日志尾部意味着较早的“registered”信息可能不在窗口中；后续 JSONL 输出仍可证明实际活跃。
  const text = await readTail(filePath, options.maxBytes);
  const events = [];
  const methodStates = {};

  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    // 服务日志不是纯 JSONL，而是固定前缀加可选 JSON metadata；无法解析的行仅跳过。
    const parsed = parseLogLine(line);
    if (!parsed) continue;
    const { timestamp, level, tag, message, meta } = parsed;

    if (message === 'input registered' && meta.id) {
      ensureMethod(methodStates, meta.id).registered = true;
    }
    if ((message === 'input started' || message === 'agent detected and started') && meta.id) {
      // 同时兼容静态启动和 Discovery 动态启动使用的两种日志消息。
      const method = ensureMethod(methodStates, meta.id);
      method.started = true;
      method.lastSeenAt = timestamp;
      events.push(activityEvent({
        timestamp,
        type: 'agent.started',
        severity: 'info',
        agentId: classifyMethod(meta.id),
        methodId: meta.id,
        summary: `Started collecting ${agentLabel(classifyMethod(meta.id))}`,
      }));
    }
    if ((message === 'input stopped' || message === 'agent stopped') && meta.id) {
      const method = ensureMethod(methodStates, meta.id);
      method.started = false;
      method.lastSeenAt = timestamp;
      events.push(activityEvent({
        timestamp,
        type: 'agent.stopped',
        severity: 'warn',
        agentId: classifyMethod(meta.id),
        methodId: meta.id,
        summary: `Stopped collecting ${agentLabel(classifyMethod(meta.id))}`,
      }));
    }
    if (message === 'dispatching entries' && meta.inputId) {
      // dispatching 发生在 InputManager 接收批次时，不等同于所有远端通道都已成功上报。
      const count = Number(meta.count) || 0;
      const method = ensureMethod(methodStates, meta.inputId);
      method.dispatchedToday += count;
      method.lastDispatchAt = timestamp;
      method.lastSeenAt = timestamp;
      events.push(activityEvent({
        timestamp,
        type: 'collection.batch',
        severity: 'info',
        agentId: classifyMethod(meta.inputId),
        methodId: meta.inputId,
        count,
        summary: `${agentLabel(classifyMethod(meta.inputId))} collected ${count} events`,
      }));
    }
    if (tag === 'Main' && message === 'AI Agent Input is running') {
      events.push(activityEvent({
        timestamp,
        type: 'service.started',
        severity: 'info',
        summary: 'LoongSuite Pilot started',
        details: { flushers: meta.flushers },
      }));
      if (Array.isArray(meta.flushers)) {
        // 启用通道事件只描述配置/启动状态，不作为远端成功证据。
        for (const flusher of meta.flushers) {
          events.push(activityEvent({
            timestamp,
            type: 'reporting.channel.enabled',
            severity: 'info',
            summary: `${String(flusher).toUpperCase()} reporting enabled`,
          }));
        }
      }
    }
    if (level === 'WARN' || level === 'ERROR') {
      // 保留 metadata 方便详情页排障；摘要不尝试从任意错误文本推断 Agent。
      events.push(activityEvent({
        timestamp,
        type: level === 'ERROR' ? 'collector.error' : 'collector.warning',
        severity: level === 'ERROR' ? 'error' : 'warn',
        summary: `${tag}: ${message}`,
        details: meta,
      }));
    }
  }

  return {
    events: events.slice(-options.timelineLimit),
    methodStates,
  };
}

/** 解析 parseLogLine 的输入并在格式无效时返回可跳过的空值。 */
function parseLogLine(line) {
  // 四个捕获组依次为时间、级别、tag、消息；末尾 JSON metadata 是可选的。
  const match = line.match(/^\[([^\]]+)] \[([^\]]+)] \[([^\]]+)] ([^{]*?)(?: (\{.*\}))?$/);
  if (!match) return null;
  const [, timestamp, level, tag, rawMessage, rawMeta] = match;
  let meta = {};
  if (rawMeta) {
    try {
      meta = JSON.parse(rawMeta);
    } catch {
      meta = {};
    }
  }
  return {
    timestamp,
    level,
    tag,
    message: rawMessage.trim(),
    meta,
  };
}

/** 枚举规范化 JSONL，并结合 offset/mtime 缓存做全量或增量汇总。 */
async function aggregateOutputFiles(outputDir, options) {
  const result = {
    files: [],
    byAgent: {},
    events: [],
    total: 0,
    tokens: 0,
    partial: false,
    indexing: false,
    progress: {
      indexedFiles: 0,
      totalFiles: 0,
      indexedBytes: 0,
      totalBytes: 0,
      files: [],
    },
  };
  const entries = await safeReaddir(outputDir);
  // Dashboard 的“今日”只读取当前本地日期文件，历史文件不进入今日统计。
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(`-${options.date}.jsonl`))
    .map((entry) => path.join(outputDir, entry.name));
  const activeFileKeys = new Set(files);
  result.progress.totalFiles = files.length;

  for (const filePath of files) {
    // 每个文件最多推进预算允许的一块；超大文件通过后续 refresh 继续从 offset 扫描。
    const fileSummary = await summarizeJsonlFile(filePath, options);
    logPartialIndexProgress(fileSummary);
    result.files.push(fileSummary.file);
    result.total += fileSummary.total;
    result.tokens += fileSummary.tokens;
    result.partial = result.partial || fileSummary.partial;
    result.indexing = result.indexing || fileSummary.indexing;
    result.progress.indexedBytes += fileSummary.file.indexedBytes || 0;
    result.progress.totalBytes += fileSummary.file.sizeBytes || 0;
    if (!fileSummary.indexing) result.progress.indexedFiles += 1;
    result.progress.files.push({
      name: fileSummary.file.name,
      sizeBytes: fileSummary.file.sizeBytes,
      indexedBytes: fileSummary.file.indexedBytes || 0,
      indexing: Boolean(fileSummary.indexing),
    });
    for (const [agentId, agentSummary] of Object.entries(fileSummary.byAgent)) {
      const target = ensureAgentOutput(result.byAgent, agentId);
      mergeAgentOutput(target, agentSummary);
    }
    result.events.push(...fileSummary.events);
  }

  result.events.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  // 删除已轮转/非今日文件的旧索引，防止持久缓存无限增长和旧计数混入。
  pruneOverviewCache(options.overviewCache, activeFileKeys, options.date);
  // 聚合完成后一次性原子落盘；保存失败被 saveOverviewCache 降级，不影响当前 HTTP 响应。
  await saveOverviewCache(options.overviewCachePath, options.overviewCache);
  return result;
}

/** 从缓存 offset 读取单个 JSONL 新增块，处理截断和轮转后更新摘要。 */
async function summarizeJsonlFile(filePath, options) {
  const fileStat = await safeStat(filePath);
  if (!fileStat) {
    return emptyFileSummary(filePath);
  }

  // 缓存需同时满足版本、路径、offset、大小、mtime 和 inode 约束，防止把轮转后的新文件续接到旧摘要。
  const cached = validOutputCacheEntry(options.overviewCache.files[filePath], filePath, fileStat);
  // 文件变小通常表示截断/轮转，旧 offset 已无意义，必须从 0 重建。
  const shouldRebuild = !cached || fileStat.size < cached.indexedThroughOffset;
  const entry = shouldRebuild
    ? newOutputCacheEntry(filePath, options.date, fileStat)
    : {
      ...cached,
      file: fileMetadata(filePath, fileStat, cached.indexedThroughOffset, cached.indexing),
    };

  if (entry.indexedThroughOffset < fileStat.size) {
    const readResult = await readJsonlChunk(filePath, {
      start: entry.indexedThroughOffset,
      fileSize: fileStat.size,
      maxBytes: options.maxIndexBytesPerRefresh,
      maxLines: options.maxIndexLinesPerRefresh,
    });
    // 先将完整 JSONL 行计入摘要，再提交 nextOffset；半行不会推进 offset，等待下次写完整。
    applyOutputLines(entry.summary, readResult.lines, options.cachedOutputEventsPerFile);
    entry.indexedThroughOffset = readResult.nextOffset;
    entry.indexing = entry.indexedThroughOffset < fileStat.size;
  } else {
    entry.indexing = false;
  }
  trimCachedOutputEvents(entry.summary, options.cachedOutputEventsPerFile);

  entry.size = fileStat.size;
  entry.mtimeMs = fileStat.mtimeMs;
  entry.dev = fileStat.dev;
  entry.ino = fileStat.ino;
  entry.file = fileMetadata(filePath, fileStat, entry.indexedThroughOffset, entry.indexing);
  entry.summary.file = entry.file;
  entry.summary.partial = entry.indexing;
  entry.summary.indexing = entry.indexing;
  // 缓存保存内部可变 entry；对调用方返回深拷贝，避免后续刷新改变已经发出的响应对象。
  options.overviewCache.files[filePath] = entry;
  return cloneSummary(entry.summary);
}

/** 把 applyOutputLines 的源数据累加到目标摘要，并更新最近活动时间。 */
function applyOutputLines(summary, lines, cachedOutputEventsPerFile) {
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // 单行损坏不会阻止 offset 推进；这是诊断视图，不承担 Collector 的可靠重放职责。
      continue;
    }
    applyOutputRecord(summary, record, cachedOutputEventsPerFile);
  }
}

/** 把一条规范化事件累加到 Agent、方法、token、会话、仓库和时间维度。 */
function applyOutputRecord(summary, record, cachedOutputEventsPerFile) {
  const agentId = classifyRecord(record);
  // 未能可靠归类的记录不应被错误计入某个 Agent；目前也不显示 unknown 桶。
  if (agentId === 'unknown') return;
  const timestamp = recordTime(record);
  const eventName = stringValue(record['event.name']) || 'event';
  // 优先读取当前 Schema 字段，旧字段只作兼容；缺失/非法值由 numberValue 归零。
  const tokens = numberValue(record['gen_ai.usage.total_tokens'] ?? record['usage.total_tokens']);
  const agent = ensureAgentOutput(summary.byAgent, agentId);
  agent.total += 1;
  agent.tokens += tokens;
  agent.lastActivityAt = maxIso(agent.lastActivityAt, timestamp);
  agent.eventTypes[eventName] = (agent.eventTypes[eventName] || 0) + 1;

  const attributes = parseAttributes(record.attributes);
  const source = stringValue(attributes.source ?? record['agent.source']) || 'normalized-output';
  // source 比 Agent 粒度更细，用于详情页显示同一 Agent 的具体采集实现。
  const method = ensureMethodOutput(agent.methods, source);
  method.count += 1;
  method.lastActivityAt = maxIso(method.lastActivityAt, timestamp);
  method.tokens += tokens;

  summary.total += 1;
  summary.tokens += tokens;
  if (timestamp) {
    summary.events.push(activityEvent({
      timestamp,
      type: 'output.record',
      severity: 'info',
      agentId,
      count: 1,
      summary: `${agentLabel(agentId)} processed ${eventName}`,
    }));
    trimCachedOutputEvents(summary, cachedOutputEventsPerFile);
  }
}

/** 实现 Dashboard 聚合流程中的 trimCachedOutputEvents 辅助计算；不产生网络请求。 */
function trimCachedOutputEvents(summary, limit) {
  summary.events = summary.events.slice(-Math.max(0, limit));
}

/** 实现 Dashboard 聚合流程中的 logPartialIndexProgress 辅助计算；不产生网络请求。 */
function logPartialIndexProgress(fileSummary) {
  if (!fileSummary || !fileSummary.file) return;
  const filePath = fileSummary.file.path;
  if (!filePath) return;

  if (fileSummary.indexing) {
    const indexed = fileSummary.file.indexedBytes || 0;
    const total = fileSummary.file.sizeBytes || 0;
    const lastLogged = partialIndexLogState.get(filePath);
    // offset 未变化通常意味着文件尾还没有完整换行，不重复刷同一条告警。
    if (lastLogged === indexed) return;
    partialIndexLogState.set(filePath, indexed);
    const remaining = Math.max(0, total - indexed);
    const indexedMib = (indexed / (1024 * 1024)).toFixed(2);
    const totalMib = (total / (1024 * 1024)).toFixed(2);
    const remainingMib = (remaining / (1024 * 1024)).toFixed(2);
    console.warn(
      `[overview] partial index: file=${fileSummary.file.name} `
        + `indexed=${indexedMib}MiB/${totalMib}MiB remaining=${remainingMib}MiB `
        + '— last activity may lag behind real time until further refreshes catch up '
        + '(per-refresh budget=5MiB / 20k lines)',
    );
    return;
  }

  if (partialIndexLogState.has(filePath)) {
    partialIndexLogState.delete(filePath);
    console.warn(
      `[overview] index caught up: file=${fileSummary.file.name} — last activity is now real-time`,
    );
  }
}

/** 创建 newOutputCacheEntry 使用的零值结构，保证缓存 Schema 字段完整。 */
function newOutputCacheEntry(filePath, date, fileStat) {
  const summary = emptyFileSummary(filePath);
  return {
    version: OVERVIEW_CACHE_VERSION,
    path: filePath,
    date,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    dev: fileStat.dev,
    ino: fileStat.ino,
    indexedThroughOffset: 0,
    indexing: fileStat.size > 0,
    file: fileMetadata(filePath, fileStat, 0, fileStat.size > 0),
    summary,
  };
}

/** 实现 Dashboard 聚合流程中的 validOutputCacheEntry 辅助计算；不产生网络请求。 */
function validOutputCacheEntry(entry, filePath, fileStat) {
  if (!entry || entry.version !== OVERVIEW_CACHE_VERSION || entry.path !== filePath) return null;
  if (!Number.isFinite(entry.indexedThroughOffset) || entry.indexedThroughOffset < 0) return null;
  if (!entry.summary || typeof entry.summary !== 'object') return null;
  if (Number.isFinite(entry.size) && entry.size < entry.indexedThroughOffset) return null;
  if (entry.indexedThroughOffset > fileStat.size) return null;
  if (entry.indexedThroughOffset === fileStat.size) {
    // 已追平文件时大小或 mtime 突变说明内容可能原地改写，不能继续信任旧摘要。
    if (Number.isFinite(entry.size) && entry.size !== fileStat.size) return null;
    if (Number.isFinite(entry.mtimeMs) && Math.abs(entry.mtimeMs - fileStat.mtimeMs) > 1) {
      return null;
    }
  }
  if (Number.isFinite(entry.dev) && Number.isFinite(entry.ino)
    && (entry.dev !== fileStat.dev || entry.ino !== fileStat.ino)) {
    return null;
  }
  return entry;
}

/** 实现 Dashboard 聚合流程中的 fileMetadata 辅助计算；不产生网络请求。 */
function fileMetadata(filePath, fileStat, indexedThroughOffset, indexing) {
  return {
    path: filePath,
    name: path.basename(filePath),
    sizeBytes: fileStat.size,
    indexedBytes: Math.min(indexedThroughOffset, fileStat.size),
    updatedAt: fileStat.mtime.toISOString(),
    partial: Boolean(indexing),
  };
}

/** 实现 Dashboard 聚合流程中的 cloneSummary 辅助计算；不产生网络请求。 */
function cloneSummary(summary) {
  // 摘要只含 JSON 数据，序列化深拷贝足够且同时剥离任何意外的原型属性。
  return JSON.parse(JSON.stringify(summary));
}

/** 实现 Dashboard 聚合流程中的 pruneOverviewCache 辅助计算；不产生网络请求。 */
function pruneOverviewCache(cache, activeFileKeys, date) {
  for (const [filePath, entry] of Object.entries(cache.files)) {
    if (entry?.date !== date || !activeFileKeys.has(filePath)) delete cache.files[filePath];
  }
}

/** 创建 emptyFileSummary 使用的零值结构，保证缓存 Schema 字段完整。 */
function emptyFileSummary(filePath) {
  return {
    file: {
      path: filePath,
      name: path.basename(filePath),
      sizeBytes: 0,
      updatedAt: null,
      partial: false,
    },
    byAgent: {},
    events: [],
    total: 0,
    tokens: 0,
    partial: false,
    indexing: false,
  };
}

/** 汇总失败持久化目录，为各上报通道生成失败计数和最近错误。 */
async function aggregateFailedUploads(failedDir, options) {
  const entries = await safeReaddir(failedDir);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(failedDir, entry.name));
  const events = [];
  let total = 0;

  for (const filePath of files) {
    // 失败目录可能长期累积，只读取每个文件有限尾部，所以 total 是“可见窗口计数”而非历史绝对总数。
    const text = await readTail(filePath, options.maxBytes);
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      total += 1;
      // 旧诊断若没有数值 ts，只能以聚合时刻展示；这不代表真实失败发生时间。
      const timestamp = typeof row.ts === 'number' ? new Date(row.ts).toISOString() : new Date().toISOString();
      events.push(activityEvent({
        timestamp,
        type: 'reporting.failure',
        severity: 'error',
        summary: 'Upload failed; diagnostic metadata was saved locally',
        details: {
          endpoint: row.endpoint,
          project: row.project,
          logstore: row.logstore,
          errorType: row.error_type,
          errorCode: row.error_code,
          httpStatus: row.http_status,
          error: row.error_summary,
          batchCount: row.batch_count,
          batchBytes: row.batch_bytes,
          file: path.basename(filePath),
        },
      }));
    }
  }

  events.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  return { total, events };
}

/** 组合已聚合数据生成 buildMethodStates 对应的 Dashboard 视图模型，不直接写源日志。 */
function buildMethodStates(serviceLog, output, now) {
  // 浅拷贝顶层对象即可；下面会有意更新其中各 method 的统计字段。
  const states = { ...serviceLog.methodStates };
  for (const agent of AGENTS) {
    for (const methodId of agent.methods) ensureMethod(states, methodId);
  }

  for (const [agentId, agentOutput] of Object.entries(output.byAgent)) {
    const agent = AGENT_BY_ID.get(agentId);
    if (!agent) continue;
    for (const methodId of agent.methods) {
      const method = ensureMethod(states, methodId);
      method.outputToday += agentOutput.total;
      method.lastOutputAt = maxIso(method.lastOutputAt, agentOutput.lastActivityAt);
      method.lastSeenAt = maxIso(method.lastSeenAt, agentOutput.lastActivityAt);
    }
  }

  for (const state of Object.values(states)) {
    state.status = methodStatus(state, now);
  }
  return states;
}

/** 组合已聚合数据生成 buildAgentSummaries 对应的 Dashboard 视图模型，不直接写源日志。 */
function buildAgentSummaries({ methodStates, output, service, now }) {
  return AGENTS.map((agent) => {
    const outputSummary = output.byAgent[agent.id] || emptyAgentOutput();
    const methods = agent.methods.map((methodId) => {
      const method = methodStates[methodId] || ensureMethod({}, methodId);
      return {
        id: methodId,
        label: METHOD_LABELS[methodId] || methodId,
        status: service.running ? method.status : 'not_detected',
        registered: Boolean(method.registered),
        started: Boolean(method.started),
        dispatchedToday: method.dispatchedToday,
        outputToday: method.outputToday,
        lastSeenAt: method.lastSeenAt || null,
        lastDispatchAt: method.lastDispatchAt || null,
        lastOutputAt: method.lastOutputAt || null,
      };
    });
    const lastActivityAt = outputSummary.lastActivityAt || null;
    // 服务停止时不再把历史今日输出显示为 active，避免用户误以为采集仍在运行。
    const status = service.running ? agentStatus(outputSummary, lastActivityAt, now) : 'not_detected';
    const warnings = [];
    if (output.partial) warnings.push('Output totals are still indexing local JSONL files.');
    if (agent.id === 'qoder-combined' && outputSummary.total > 0) {
      warnings.push('Some Qoder-family records could not be split reliably.');
    }

    return {
      id: agent.id,
      label: agent.label,
      status,
      hiddenWhenEmpty: Boolean(agent.hiddenWhenEmpty),
      todayEvents: outputSummary.total,
      tokensToday: outputSummary.tokens,
      eventTypes: outputSummary.eventTypes,
      collectionTypes: agent.collectionTypes,
      lastActivityAt,
      warnings,
      methods,
    };
  });
}

/** 结合配置开关、成功输出和失败记录判断各上报通道健康度。 */
function buildReportingSummary(config, output, failures) {
  const sls = config.sls || {};
  const http = config.http || {};
  const jsonl = config.jsonl || {};
  const slsEnabled = resolveSlsEnabled(config);
  const jsonlEnabled = jsonl.enabled !== false;
  // 为兼容旧配置，只要存在 URL 也视为 HTTP 已配置。
  const httpEnabled = Boolean(http.enabled || http.url);

  const channels = [
    {
      id: 'jsonl',
      label: 'Local JSONL backup',
      enabled: jsonlEnabled,
      status: jsonlEnabled && output.total > 0 ? 'normal' : jsonlEnabled ? 'idle' : 'disabled',
      message: jsonlEnabled ? 'Local backup normal' : 'Local backup disabled',
    },
    {
      id: 'sls',
      label: 'SLS',
      enabled: slsEnabled,
      status: !slsEnabled ? 'disabled' : failures.total > 0 ? 'warning' : 'best_available',
      message: !slsEnabled
        ? 'SLS reporting disabled'
        : failures.total > 0
          ? `${failures.total} persisted upload failures detected`
          : 'SLS enabled; no persisted upload failures detected',
    },
    {
      id: 'http',
      label: 'HTTP',
      enabled: httpEnabled,
      status: httpEnabled ? 'best_available' : 'disabled',
      message: httpEnabled ? 'HTTP reporting enabled' : 'HTTP reporting disabled',
    },
  ];

  return {
    status: failures.total > 0 ? 'warning' : 'normal',
    wording: 'Remote upload success is best available until durable success metrics are recorded.',
    // 本地输出只能证明事件已被 Collector 处理，不能证明 SLS/HTTP/OTLP 远端已持久化。
    processedToday: output.total,
    localBackupEventsToday: output.total,
    failedUploadsToday: failures.total,
    channels,
  };
}

/** 兼容旧配置并规范化 resolveSlsEnabled 的返回值，供状态计算使用。 */
function resolveSlsEnabled(config) {
  const sls = config.sls || {};
  // 新版显式 enabled 的优先级最高；缺失时才按旧版凭据完整性推断。
  if (sls.enabled !== undefined) return Boolean(sls.enabled);

  const destinationOverride = sls.destinationOverride === true;
  const mode = normalizeSlsMode(
    process.env.LOONGSUITE_SLS_MODE
      ?? (destinationOverride ? sls.mode : undefined)
      ?? 'webtracking',
  );

  const endpoint = process.env.LOONGSUITE_SLS_ENDPOINT
    ?? (destinationOverride ? sls.endpoint : undefined)
    ?? '__internal_sls_endpoint__';
  const project = process.env.LOONGSUITE_SLS_PROJECT
    ?? (destinationOverride ? sls.project : undefined)
    ?? '__internal_sls_project__';
  const logstore = process.env.LOONGSUITE_SLS_LOGSTORE
    ?? (destinationOverride ? sls.logstore : undefined)
    ?? '__internal_sls_logstore__';
  const hasEndpoint = Boolean(project && logstore);

  if (mode === 'webtracking') return Boolean(endpoint && hasEndpoint);

  const accessKeyId = process.env.LOONGSUITE_SLS_ACCESS_KEY_ID
    ?? (destinationOverride ? sls.accessKeyId : undefined)
    ?? '';
  const accessKeySecret = process.env.LOONGSUITE_SLS_ACCESS_KEY_SECRET
    ?? (destinationOverride ? sls.accessKeySecret : undefined)
    ?? '';
  return Boolean(accessKeyId && accessKeySecret && endpoint && hasEndpoint);
}

/** 兼容旧配置并规范化 normalizeSlsMode 的返回值，供状态计算使用。 */
function normalizeSlsMode(mode) {
  return mode === 'ak' ? 'ak' : 'webtracking';
}

/** 组合已聚合数据生成 buildTimeline 对应的 Dashboard 视图模型，不直接写源日志。 */
function buildTimeline({ serviceLog, output, failures, limit }) {
  const outputEvents = output.events
    .slice(-limit)
    .map((event) => ({
      ...event,
      type: 'collection.output',
      summary: `${agentLabel(event.agentId)} processed an event`,
    }));
  return [
    ...serviceLog.events,
    ...outputEvents,
    ...failures.events,
  ]
    .filter((event) => event.timestamp)
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
    .slice(-limit)
    .reverse();
}

/** 取得或创建 ensureMethod 对应的零值统计桶，供后续原地累加。 */
function ensureMethod(states, methodId) {
  if (!states[methodId]) {
    states[methodId] = {
      id: methodId,
      registered: false,
      started: false,
      dispatchedToday: 0,
      outputToday: 0,
      lastSeenAt: null,
      lastDispatchAt: null,
      lastOutputAt: null,
      status: 'unavailable',
    };
  }
  return states[methodId];
}

/** 取得或创建 ensureAgentOutput 对应的零值统计桶，供后续原地累加。 */
function ensureAgentOutput(byAgent, agentId) {
  if (!byAgent[agentId]) byAgent[agentId] = emptyAgentOutput();
  return byAgent[agentId];
}

/** 创建 emptyAgentOutput 使用的零值结构，保证缓存 Schema 字段完整。 */
function emptyAgentOutput() {
  return {
    total: 0,
    tokens: 0,
    eventTypes: {},
    methods: {},
    lastActivityAt: null,
  };
}

/** 把 mergeAgentOutput 的源数据累加到目标摘要，并更新最近活动时间。 */
function mergeAgentOutput(target, source) {
  target.total += source.total;
  target.tokens += source.tokens;
  target.lastActivityAt = maxIso(target.lastActivityAt, source.lastActivityAt);
  for (const [eventName, count] of Object.entries(source.eventTypes)) {
    target.eventTypes[eventName] = (target.eventTypes[eventName] || 0) + count;
  }
  for (const [methodId, method] of Object.entries(source.methods)) {
    const targetMethod = ensureMethodOutput(target.methods, methodId);
    targetMethod.count += method.count;
    targetMethod.tokens += method.tokens;
    targetMethod.lastActivityAt = maxIso(targetMethod.lastActivityAt, method.lastActivityAt);
  }
}

/** 取得或创建 ensureMethodOutput 对应的零值统计桶，供后续原地累加。 */
function ensureMethodOutput(methods, methodId) {
  if (!methods[methodId]) {
    methods[methodId] = { count: 0, tokens: 0, lastActivityAt: null };
  }
  return methods[methodId];
}

/** 实现 Dashboard 聚合流程中的 methodStatus 辅助计算；不产生网络请求。 */
function methodStatus(method, now) {
  if (method.outputToday > 0 || method.dispatchedToday > 0) {
    if (method.lastSeenAt && now.getTime() - new Date(method.lastSeenAt).getTime() > STALE_AFTER_MS) {
      return 'no_recent_activity';
    }
    return 'active';
  }
  return 'not_detected';
}

/** 实现 Dashboard 聚合流程中的 agentStatus 辅助计算；不产生网络请求。 */
function agentStatus(outputSummary, lastActivityAt, now) {
  if (outputSummary.total > 0) {
    if (lastActivityAt && now.getTime() - new Date(lastActivityAt).getTime() > STALE_AFTER_MS) return 'no_recent_activity';
    return 'active';
  }
  return 'not_detected';
}

/** 实现 Dashboard 聚合流程中的 activityEvent 辅助计算；不产生网络请求。 */
function activityEvent(event) {
  return {
    timestamp: event.timestamp,
    type: event.type,
    severity: event.severity || 'info',
    agentId: event.agentId,
    agentLabel: event.agentId ? agentLabel(event.agentId) : undefined,
    methodId: event.methodId,
    count: event.count,
    summary: event.summary,
    details: event.details,
  };
}

/** 实现 Dashboard 聚合流程中的 agentLabel 辅助计算；不产生网络请求。 */
function agentLabel(agentId) {
  return AGENT_BY_ID.get(agentId)?.label || agentId || 'LoongSuite Pilot';
}

/** 实现 Dashboard 聚合流程中的 recordTime 辅助计算；不产生网络请求。 */
function recordTime(record) {
  const rawNano = stringValue(record.time_unix_nano || record.observed_time_unix_nano);
  if (/^\d+$/.test(rawNano)) {
    // 纳秒值可能超过 Number 安全整数，先用 BigInt 除到毫秒后再转换。
    const ms = Number(BigInt(rawNano) / 1_000_000n);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const timestamp = record.timestamp || record.logTime;
  if (typeof timestamp === 'number') return new Date(timestamp).toISOString();
  if (typeof timestamp === 'string') {
    const ms = Date.parse(timestamp);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  return null;
}

/** 读取并容错解析 readTail 所需的本地状态，不把非关键 I/O 错误传播给 Dashboard。 */
async function readTail(filePath, maxBytes) {
  const fileStat = await safeStat(filePath);
  if (!fileStat || fileStat.size === 0) return '';
  // offset 按字节计算；从中间开始时首段可能是半行，下面会丢弃到第一个换行。
  const start = Math.max(0, fileStat.size - maxBytes);
  const length = fileStat.size - start;
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const text = buffer.toString('utf8');
    if (start === 0) return text;
    const firstNewline = text.indexOf('\n');
    return firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
  } finally {
    // 无论 read 或 UTF-8 解码后处理是否失败，都关闭文件描述符。
    await handle.close();
  }
}

/** 从指定 offset 读取有限大小 JSONL 块，只返回最后完整换行前的数据。 */
async function readJsonlChunk(filePath, options) {
  const remaining = Math.max(0, options.fileSize - options.start);
  if (remaining === 0) return { lines: [], nextOffset: options.start };
  const length = Math.min(remaining, options.maxBytes);
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, options.start);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    // 只有到达本次 stat 看到的 EOF，末尾无换行内容才可作为完整一行处理。
    const reachedEof = options.start + bytesRead >= options.fileSize;
    const lastNewline = text.lastIndexOf('\n');
    let processText = text;
    let nextOffset = options.start + bytesRead;

    if (!reachedEof) {
      if (lastNewline < 0) {
        // 整块都没有完整行时保持原 offset，下次可在文件继续增长或提高预算后重读。
        return { lines: [], nextOffset: options.start };
      }
      processText = text.slice(0, lastNewline + 1);
      nextOffset = options.start + Buffer.byteLength(processText);
    }

    const availableLines = processText.split(/\r?\n/).filter(Boolean);
    const lines = availableLines.slice(0, options.maxLines);
    if (availableLines.length > lines.length) {
      // 行数预算比字节预算先耗尽时，重新按实际采用的 UTF-8 内容计算提交 offset。
      nextOffset = options.start + Buffer.byteLength(`${lines.join('\n')}\n`);
    }
    return { lines, nextOffset };
  } finally {
    await handle.close();
  }
}

/** 读取并容错解析 loadOverviewCache 所需的本地状态，不把非关键 I/O 错误传播给 Dashboard。 */
async function loadOverviewCache(cachePath) {
  const raw = await safeReadFile(cachePath, 'utf8');
  if (!raw) return emptyOverviewCache();
  try {
    const parsed = JSON.parse(raw);
    // Schema 版本不匹配时全量重建，避免旧字段被误解释为有效 offset。
    if (parsed?.version !== OVERVIEW_CACHE_VERSION || !parsed.files || typeof parsed.files !== 'object') {
      return emptyOverviewCache();
    }
    return {
      version: OVERVIEW_CACHE_VERSION,
      files: parsed.files,
    };
  } catch {
    return emptyOverviewCache();
  }
}

/** 创建 emptyOverviewCache 使用的零值结构，保证缓存 Schema 字段完整。 */
function emptyOverviewCache() {
  return {
    version: OVERVIEW_CACHE_VERSION,
    files: {},
  };
}

/** 先写同目录临时文件再 rename，原子持久化聚合缓存。 */
async function saveOverviewCache(cachePath, cache) {
  try {
    await mkdir(path.dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
    // 同目录 rename 在支持的平台上是原子的，读者不会看到半写 JSON。
    await rename(tmpPath, cachePath);
  } catch {}
}

/** 以 fail-open 语义执行 safeReadFile；文件轮转、缺失或权限错误时返回空值。 */
async function safeReadFile(filePath, encoding) {
  try {
    return await readFile(filePath, encoding);
  } catch {
    return null;
  }
}

/** 以 fail-open 语义执行 safeStat；文件轮转、缺失或权限错误时返回空值。 */
async function safeStat(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

/** 以 fail-open 语义执行 safeReaddir；文件轮转、缺失或权限错误时返回空值。 */
async function safeReaddir(dirPath) {
  try {
    return await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 实现 Dashboard 聚合流程中的 stringValue 辅助计算；不产生网络请求。 */
function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

/** 实现 Dashboard 聚合流程中的 numberValue 辅助计算；不产生网络请求。 */
function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** 实现 Dashboard 聚合流程中的 maxIso 辅助计算；不产生网络请求。 */
function maxIso(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

/** 实现 Dashboard 聚合流程中的 latestIso 辅助计算；不产生网络请求。 */
function latestIso(values) {
  return values.filter(Boolean).reduce((latest, value) => maxIso(latest, value), null);
}

/** 异步检查路径可访问性，任何 fs 错误均返回 false。 */
export async function pathExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** 创建文件 ReadStream，供 HTTP 层流式发送大文件。 */
export function streamFile(filePath) {
  return createReadStream(filePath);
}
