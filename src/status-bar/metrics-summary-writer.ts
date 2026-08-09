/**
 * 状态栏与 token-usage CLI 共用的本地指标聚合器。
 *
 * Orchestrator 注入 InputManager 计数器并启动本类。它先从 `logs/output/*.jsonl`
 * 流式读取当日规范化事件，再与 `logs/metrics-daily/*.json` digest 合并，生成
 * metrics-summary.json 中今日/7 天/30 天 token、session、request、tool 及占比统计。
 * readline 按行处理避免一次加载大文件；文件 mtime/size cache 和 digest 降低重复扫描。
 * 写入周期由 StatusBarConfig 控制，timer 使用 `unref()`，解析单行失败只跳过该行。
 */



import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { StatusBarConfig } from '../types/index.js';
import { writeJsonFile, readJsonFile, ensureDir, getTodayDateString } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('MetricsSummaryWriter');

const STARTUP_DELAY_MS = 5_000;
const DIGEST_MAX_DAYS = 200;
const FILE_NAME_PATTERN = /^(.+)-(\d{4}-\d{2}-\d{2})\.jsonl$/;

// metrics-summary.json 对外结构。

export interface MetricsSummaryRangeData {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalSessions: number;
  totalRequests: number;
  totalToolCalls: number;
  totalEvents: number;
  modelShares: ModelShareEntry[];
  agentShares: AgentShareEntry[];
  providerShares: ProviderShareEntry[];
  repoShares: RepoShareEntry[];
}

export interface ModelShareEntry {
  model: string;
  totalTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  share: number;
}

export interface AgentShareEntry {
  agentType: string;
  sessions: number;
  events: number;
  tokens: number;
  share: number;
}

export interface ProviderShareEntry {
  provider: string;
  totalTokens: number;
  share: number;
}

export interface RepoShareEntry {
  repo: string;
  sessions: number;
  events: number;
}

export interface DailyPoint {
  day: string;
  value: number;
}

export interface MetricsSummary {
  version: number;
  generatedAt: string;
  packageVersion: string;
  ranges: {
    today: MetricsSummaryRangeData;
    sevenDays: MetricsSummaryRangeData;
    thirtyDays: MetricsSummaryRangeData;
  };
  dailyTokens: DailyPoint[];
  dailySessions: DailyPoint[];
}

// 仅聚合过程使用的内部结构。

interface DayStats {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  sessions: Set<string>;
  requests: number;
  toolCalls: number;
  events: number;
  modelTokens: Map<string, { total: number; input: number; cacheRead: number }>;
  agentStats: Map<string, { sessions: Set<string>; events: number; tokens: number }>;
  providerTokens: Map<string, number>;
  repoStats: Map<string, { sessions: Set<string>; events: number }>;
}

interface DayDigest {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  sessions: number;
  requests: number;
  toolCalls: number;
  events: number;
}

interface DigestFile {
  version: number;
  days: Record<string, DayDigest>;
}

interface ScanState {
  files: Record<string, { offset: number; size: number; ino: number }>;
}

// ── 类实现 ──

/**
 * 把规范化 JSONL 增量聚合为状态栏/CLI 可快速读取的摘要与日 digest。
 *
 * refresh 使用互斥标志避免 timer 重入；单行、单文件错误尽量跳过，最终写盘失败由调用
 * 处记录。stop 只清 timer，不删除历史摘要。
 */
export class MetricsSummaryWriter {
  private readonly dataDir: string;
  private readonly config: StatusBarConfig;
  private readonly outputDir: string;
  private readonly summaryPath: string;
  private readonly digestPath: string;
  private readonly scanStatePath: string;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private isRefreshing = false;

  /** 解析 output/summary/digest/scan-state 固定路径；构造阶段不读文件。 */
  constructor(dataDir: string, config: StatusBarConfig) {
    this.dataDir = dataDir;
    this.config = config;
    this.outputDir = path.join(dataDir, 'logs', 'output');
    this.summaryPath = path.join(dataDir, 'logs', 'metrics-summary.json');
    this.digestPath = path.join(dataDir, 'cache', 'metrics-daily-digest.json');
    this.scanStatePath = path.join(dataDir, 'cache', 'metrics-scan-state.json');
  }

  /** 启用时延迟 5 秒首刷，再按配置建立 unref interval。 */
  start(): void {
    if (!this.config.enabled) {
      logger.info('metrics summary writer disabled');
      return;
    }

    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.refresh();
      this.intervalTimer = setInterval(
        () => void this.refresh(),
        this.config.metricsSummaryIntervalMs,
      );
    }, STARTUP_DELAY_MS);

    logger.info('metrics summary writer scheduled', {
      intervalMs: this.config.metricsSummaryIntervalMs,
    });
  }

  /** 清启动和周期 timer。 */
  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    logger.info('metrics summary writer stopped');
  }

  /** 防重入执行 aggregate；异常记录后恢复锁，供下轮重试。 */
  async refresh(): Promise<void> {
    if (this.isRefreshing) return;
    this.isRefreshing = true;
    try {
      await this.aggregate();
    } catch (err) {
      logger.warn('metrics summary refresh failed', { error: String(err) });
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * 加载 digest/scan-state，扫描输出文件，更新历史日摘要，构造三个时间范围和日趋势，
   * 再按 digest -> scan-state -> summary 顺序原子写盘。顺序保证崩溃时宁可重扫不丢数据。
   */
  private async aggregate(): Promise<void> {
    const today = getTodayDateString();
    const scanState = await this.loadScanState();
    const digest = await this.loadDigest();

    const files = await this.listOutputFiles();
    const liveStats = new Map<string, DayStats>();
    const fullScanDays = new Set<string>();

    for (const file of files) {
      const match = FILE_NAME_PATTERN.exec(path.basename(file));
      if (!match) continue;
      const day = match[2];

      const fileStat = await this.safeStat(file);
      if (!fileStat) continue;

      const baseName = path.basename(file);
      const isToday = day === today;

      // 当日文件为维持 session Set 与各维度分解，每次从 0 重扫；历史文件按 offset 增量。
      // 历史日期尚无 digest 时也从头扫，避免 scan-state 与 digest 不一致造成漏计。
      let startOffset = 0;
      if (!isToday) {
        const hasDigest = !!digest.days[day];
        const cached = scanState.files[baseName];
        if (hasDigest && cached && cached.ino === fileStat.ino && cached.size <= fileStat.size) {
          startOffset = cached.offset;
        }
        if (startOffset >= fileStat.size && hasDigest) {
          this.ensureDayStats(liveStats, day);
          continue;
        }
      }

      if (startOffset === 0 && !isToday) fullScanDays.add(day);

      const dayStats = this.ensureDayStats(liveStats, day);
      const newOffset = await this.scanFile(file, startOffset, dayStats);

      scanState.files[baseName] = {
        offset: newOffset,
        size: fileStat.size,
        ino: fileStat.ino,
      };
    }

    // 历史日 live 结果永久合入 digest。
    for (const [day, stats] of liveStats) {
      if (day !== today) {
        const existing = digest.days[day];
        if (!existing || stats.events > 0) {
          // 某日从 0 重扫时整体替换 digest，避免 scan-state 丢失后重复累加。
          digest.days[day] = fullScanDays.has(day)
            ? this.dayStatsToDigest(stats)
            : this.dayStatsToDigest(stats, existing);
        }
      }
    }

    // 当前日合并 live 与已有部分 digest。
    const todayLive = liveStats.get(today);

    // 清理保留窗口外 digest。
    this.pruneDigest(digest, today);

    // 从 digest 与 live 构建派生 summary。
    const summary = this.buildSummary(digest, todayLive, today);

    // 先写事实来源再写派生摘要；崩溃恢复时宁可重扫，不能漏计。
    await ensureDir(path.dirname(this.digestPath));
    await ensureDir(path.dirname(this.summaryPath));
    await writeJsonFile(this.digestPath, digest);
    await writeJsonFile(this.scanStatePath, scanState);
    await writeJsonFile(this.summaryPath, summary);

    logger.debug('metrics summary written', {
      totalTokensToday: summary.ranges.today.totalTokens,
      sessionsToday: summary.ranges.today.totalSessions,
    });
  }

  /** 列出符合 `<agent>-YYYY-MM-DD.jsonl` 的普通文件并排序。 */
  private async listOutputFiles(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.outputDir);
      return entries
        .filter(e => e.endsWith('.jsonl'))
        .map(e => path.join(this.outputDir, e));
    } catch {
      return [];
    }
  }

  /** 容错 stat；不存在/权限错误返回 null。 */
  private async safeStat(filePath: string): Promise<fsSync.Stats | null> {
    try {
      return await fs.stat(filePath);
    } catch {
      return null;
    }
  }

  /** 获取或创建某日可变统计容器。 */
  private ensureDayStats(map: Map<string, DayStats>, day: string): DayStats {
    let stats = map.get(day);
    if (!stats) {
      // 数字计数器从 0 开始；需要去重的 session 使用 Set，需要按维度累加的项使用 Map。
      stats = {
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        sessions: new Set(),
        requests: 0,
        toolCalls: 0,
        events: 0,
        // model/agent/provider/repo 都按需建子项，避免无数据维度出现在最终 summary。
        modelTokens: new Map(),
        agentStats: new Map(),
        providerTokens: new Map(),
        repoStats: new Map(),
      };
      map.set(day, stats);
    }
    return stats;
  }

  /**
   * 从字节 offset 建流、按行解析 JSON 并应用记录，返回扫描后的文件 size 作为新 offset。
   */
  private async scanFile(filePath: string, startOffset: number, stats: DayStats): Promise<number> {
    // readline 是事件式 API，因此手动包装 Promise，让调用方可以 await 到 close 或 error。
    return new Promise<number>((resolve, reject) => {
      // offset 按 UTF-8 字节而非 JavaScript 字符计数，才能直接用于下一次 createReadStream.start。
      let currentOffset = startOffset;
      const stream = createReadStream(filePath, {
        start: startOffset,
        encoding: 'utf8',
      });
      // crlfDelay=Infinity 把 CRLF 当作一个换行边界，避免 Windows 文件产生额外空行。
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      rl.on('line', (line) => {
        // JSONL writer 使用单字节 LF；中文字符必须通过 Buffer.byteLength 计算实际 UTF-8 长度。
        currentOffset += Buffer.byteLength(line, 'utf8') + 1; // 额外的 1 字节用于换行符。
        if (!line.trim()) return;

        try {
          // 输出 Flusher 已把所有值字符串化，因此这里读取字符串宽表并直接累计。
          const record = JSON.parse(line) as Record<string, string>;
          this.applyRecord(record, stats);
        } catch {
          // 跳过写入中断或格式损坏的单行。
        }
      });

      // close 表示输入流已消费到本轮 EOF，此时 offset 才能作为完整扫描结果提交。
      rl.on('close', () => resolve(currentOffset));
      // 流或 readline 错误向 await 调用方传播，由上层决定是否保留旧 checkpoint 重试。
      rl.on('error', reject);
    });
  }

  /** 将一条字符串化规范事件累加到 token/session/request/tool/维度统计。 */
  private applyRecord(record: Record<string, string>, stats: DayStats): void {
    stats.events++;

    const eventName = record['event.name'] ?? '';
    const sessionId = record['gen_ai.session.id'];
    const agentType = record['gen_ai.agent.type'] ?? 'unknown';

    if (sessionId) {
      stats.sessions.add(sessionId);
    }

    // Agent 维度统计。
    let agent = stats.agentStats.get(agentType);
    if (!agent) {
      agent = { sessions: new Set(), events: 0, tokens: 0 };
      stats.agentStats.set(agentType, agent);
    }
    agent.events++;
    if (sessionId) agent.sessions.add(sessionId);

    // 仓库维度统计。
    const repo = record['git.repo'];
    if (repo) {
      let repoEntry = stats.repoStats.get(repo);
      if (!repoEntry) {
        repoEntry = { sessions: new Set(), events: 0 };
        stats.repoStats.set(repo, repoEntry);
      }
      repoEntry.events++;
      if (sessionId) repoEntry.sessions.add(sessionId);
    }

    if (eventName === 'llm.request') {
      stats.requests++;
    }

    if (eventName === 'tool.call') {
      stats.toolCalls++;
    }

    if (eventName === 'llm.response') {
      const inputTokens = toNumber(record['gen_ai.usage.input_tokens']);
      const outputTokens = toNumber(record['gen_ai.usage.output_tokens']);
      const cacheReadTokens = toNumber(record['gen_ai.usage.cache_read.input_tokens']);
      const cacheCreationTokens = toNumber(record['gen_ai.usage.cache_creation.input_tokens']);
      const totalTokens = toNumber(record['gen_ai.usage.total_tokens']);

      // input_tokens 已包含 cache read/creation，它们是子集，不能再次相加。
      // total_tokens = input_tokens + output_tokens
      const effectiveTotal = totalTokens > 0
        ? totalTokens
        : inputTokens + outputTokens;

      stats.tokens += effectiveTotal;
      stats.inputTokens += inputTokens;
      stats.outputTokens += outputTokens;
      stats.cacheReadTokens += cacheReadTokens;
      stats.cacheCreationTokens += cacheCreationTokens;

      agent.tokens += effectiveTotal;

      // 模型维度明细。
      const model = record['gen_ai.request.model'] ?? record['gen_ai.response.model'] ?? 'unknown';
      let modelEntry = stats.modelTokens.get(model);
      if (!modelEntry) {
        modelEntry = { total: 0, input: 0, cacheRead: 0 };
        stats.modelTokens.set(model, modelEntry);
      }
      modelEntry.total += effectiveTotal;
      modelEntry.input += inputTokens;
      modelEntry.cacheRead += cacheReadTokens;

      // Provider 维度明细。
      const provider = record['gen_ai.provider.name'] ?? 'unknown';
      stats.providerTokens.set(provider, (stats.providerTokens.get(provider) ?? 0) + effectiveTotal);
    }
  }

  /** 把含 Set/Map 的内存统计转换为可 JSON 序列化日 digest。 */
  private dayStatsToDigest(stats: DayStats, existing?: DayDigest): DayDigest {
    if (existing && stats.events === 0) return existing;
    return {
      tokens: (existing?.tokens ?? 0) + stats.tokens,
      inputTokens: (existing?.inputTokens ?? 0) + stats.inputTokens,
      outputTokens: (existing?.outputTokens ?? 0) + stats.outputTokens,
      cacheReadTokens: (existing?.cacheReadTokens ?? 0) + stats.cacheReadTokens,
      cacheCreationTokens: (existing?.cacheCreationTokens ?? 0) + stats.cacheCreationTokens,
      sessions: (existing?.sessions ?? 0) + stats.sessions.size,
      requests: (existing?.requests ?? 0) + stats.requests,
      toolCalls: (existing?.toolCalls ?? 0) + stats.toolCalls,
      events: (existing?.events ?? 0) + stats.events,
    };
  }

  /** 只保留最近 200 天且不晚于今天的 digest。 */
  private pruneDigest(digest: DigestFile, today: string): void {
    const cutoff = dateDaysAgo(DIGEST_MAX_DAYS, today);
    for (const day of Object.keys(digest.days)) {
      if (day < cutoff) {
        delete digest.days[day];
      }
    }
  }

  /** 构造最终 Summary，包含今日/7日/30日、日趋势、版本和更新时间。 */
  private buildSummary(
    digest: DigestFile,
    todayLive: DayStats | undefined,
    today: string,
  ): MetricsSummary {
    const todayDigest = digest.days[today];
    const packageVersion = this.readPackageVersion();

    const rangeToday = this.buildRangeData(
      [today],
      digest,
      todayLive ? new Map([[today, todayLive]]) : new Map(),
      today,
    );
    const range7 = this.buildRangeData(
      daysInRange(7, today),
      digest,
      todayLive ? new Map([[today, todayLive]]) : new Map(),
      today,
    );
    const range30 = this.buildRangeData(
      daysInRange(30, today),
      digest,
      todayLive ? new Map([[today, todayLive]]) : new Map(),
      today,
    );

    const dailyTokens = this.buildDailyPoints(daysInRange(30, today), digest, todayLive, today, 'tokens');
    const dailySessions = this.buildDailyPoints(daysInRange(30, today), digest, todayLive, today, 'sessions');

    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      packageVersion,
      ranges: {
        today: rangeToday,
        sevenDays: range7,
        thirtyDays: range30,
      },
      dailyTokens,
      dailySessions,
    };
  }

  /** 聚合一组日期，计算总量、去重 session 和模型/Agent/Provider/Repo shares。 */
  private buildRangeData(
    days: string[],
    digest: DigestFile,
    liveStats: Map<string, DayStats>,
    today: string,
  ): MetricsSummaryRangeData {
    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let totalSessions = 0;
    let totalRequests = 0;
    let totalToolCalls = 0;
    let totalEvents = 0;
    const modelMap = new Map<string, { total: number; input: number; cacheRead: number }>();
    const agentMap = new Map<string, { sessions: number; events: number; tokens: number }>();
    const providerMap = new Map<string, number>();
    const repoMap = new Map<string, { sessions: number; events: number }>();

    for (const day of days) {
      const live = liveStats.get(day);
      if (day === today && live) {
        totalTokens += live.tokens;
        inputTokens += live.inputTokens;
        outputTokens += live.outputTokens;
        cacheReadTokens += live.cacheReadTokens;
        cacheCreationTokens += live.cacheCreationTokens;
        totalSessions += live.sessions.size;
        totalRequests += live.requests;
        totalToolCalls += live.toolCalls;
        totalEvents += live.events;

        for (const [model, data] of live.modelTokens) {
          const m = modelMap.get(model) ?? { total: 0, input: 0, cacheRead: 0 };
          m.total += data.total;
          m.input += data.input;
          m.cacheRead += data.cacheRead;
          modelMap.set(model, m);
        }

        for (const [at, data] of live.agentStats) {
          const a = agentMap.get(at) ?? { sessions: 0, events: 0, tokens: 0 };
          a.sessions += data.sessions.size;
          a.events += data.events;
          a.tokens += data.tokens;
          agentMap.set(at, a);
        }

        for (const [provider, tokens] of live.providerTokens) {
          providerMap.set(provider, (providerMap.get(provider) ?? 0) + tokens);
        }

        for (const [repo, data] of live.repoStats) {
          const r = repoMap.get(repo) ?? { sessions: 0, events: 0 };
          r.sessions += data.sessions.size;
          r.events += data.events;
          repoMap.set(repo, r);
        }
      } else {
        const d = digest.days[day];
        if (!d) continue;
        totalTokens += d.tokens;
        inputTokens += d.inputTokens;
        outputTokens += d.outputTokens;
        cacheReadTokens += d.cacheReadTokens;
        cacheCreationTokens += d.cacheCreationTokens;
        totalSessions += d.sessions;
        totalRequests += d.requests;
        totalToolCalls += d.toolCalls;
        totalEvents += d.events;
      }
    }

    const modelShares = buildModelShares(modelMap, totalTokens);
    const agentShares = buildAgentShares(agentMap, totalEvents);
    const providerShares = buildProviderShares(providerMap, totalTokens);
    const repoShares = buildRepoShares(repoMap);

    return {
      totalTokens,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalSessions,
      totalRequests,
      totalToolCalls,
      totalEvents,
      modelShares,
      agentShares,
      providerShares,
      repoShares,
    };
  }

  /** 为指定日期序列生成每天 token/session/request/tool 趋势点。 */
  private buildDailyPoints(
    days: string[],
    digest: DigestFile,
    todayLive: DayStats | undefined,
    today: string,
    metric: 'tokens' | 'sessions',
  ): DailyPoint[] {
    return days.map(day => {
      if (day === today && todayLive) {
        return {
          day,
          value: metric === 'tokens' ? todayLive.tokens : todayLive.sessions.size,
        };
      }
      const d = digest.days[day];
      return {
        day,
        value: d ? (metric === 'tokens' ? d.tokens : d.sessions) : 0,
      };
    });
  }

  /** 从当前版本目录 VERSION 读取版本，失败回退 package.json，再失败为 unknown。 */
  private readPackageVersion(): string {
    try {
      const versionFile = path.join(this.dataDir, 'package', 'VERSION');
      if (fsSync.existsSync(versionFile)) {
        const content = fsSync.readFileSync(versionFile, 'utf8');
        const match = content.match(/^version=(.+)$/m);
        if (match) return match[1].trim();
      }

      const currentFile = path.join(this.dataDir, 'current');
      if (fsSync.existsSync(currentFile)) {
        const current = fsSync.readFileSync(currentFile, 'utf8').trim();
        if (current) {
          const vf = path.join(this.dataDir, 'versions', current, 'VERSION');
          if (fsSync.existsSync(vf)) {
            const content = fsSync.readFileSync(vf, 'utf8');
            const match = content.match(/^version=(.+)$/m);
            if (match) return match[1].trim();
          }
        }
      }
    } catch {
      // 版本指针或 VERSION 文件不可读时忽略，下面统一返回 unknown。
    }
    return 'unknown';
  }

  /** 容错加载文件 offset/mtime 缓存。 */
  private async loadScanState(): Promise<ScanState> {
    const data = await readJsonFile<ScanState>(this.scanStatePath);
    return data && data.files ? data : { files: {} };
  }

  /** 容错加载持久化日 digest。 */
  private async loadDigest(): Promise<DigestFile> {
    const data = await readJsonFile<DigestFile>(this.digestPath);
    return data && data.days ? data : { version: 1, days: {} };
  }
}

// ── 辅助函数 ──

/** 把字符串等转换为有限 number，非法值按 0。 */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** 相对 YYYY-MM-DD 计算若干天前的本地日期字符串。 */
function dateDaysAgo(days: number, reference: string): string {
  const d = new Date(reference + 'T00:00:00');
  d.setDate(d.getDate() - days);
  return formatDate(d);
}

/** 生成以 today 结束、长度为 count 的连续日期数组。 */
function daysInRange(count: number, today: string): string[] {
  const result: string[] = [];
  const base = new Date(today + 'T00:00:00');
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    result.push(formatDate(d));
  }
  return result;
}

/** 生成本地 YYYY-MM-DD。 */
function formatDate(d: Date): string {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

/** 从模型累加 Map 生成按 token 降序的占比列表。 */
function buildModelShares(
  modelMap: Map<string, { total: number; input: number; cacheRead: number }>,
  totalTokens: number,
): ModelShareEntry[] {
  return Array.from(modelMap.entries())
    .map(([model, data]) => ({
      model,
      totalTokens: data.total,
      inputTokens: data.input,
      cacheReadTokens: data.cacheRead,
      share: totalTokens > 0 ? data.total / totalTokens : 0,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

/** 从 Agent 累加 Map 生成按 token 降序的占比列表。 */
function buildAgentShares(
  agentMap: Map<string, { sessions: number; events: number; tokens: number }>,
  totalEvents: number,
): AgentShareEntry[] {
  return Array.from(agentMap.entries())
    .map(([agentType, data]) => ({
      agentType,
      sessions: data.sessions,
      events: data.events,
      tokens: data.tokens,
      share: totalEvents > 0 ? data.events / totalEvents : 0,
    }))
    .sort((a, b) => b.events - a.events);
}

/** 从 Provider 累加 Map 生成按 token 降序的占比列表。 */
function buildProviderShares(
  providerMap: Map<string, number>,
  totalTokens: number,
): ProviderShareEntry[] {
  return Array.from(providerMap.entries())
    .map(([provider, tokens]) => ({
      provider,
      totalTokens: tokens,
      share: totalTokens > 0 ? tokens / totalTokens : 0,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

/** 从 Repo 累加 Map 生成按 event 降序的列表。 */
function buildRepoShares(
  repoMap: Map<string, { sessions: number; events: number }>,
): RepoShareEntry[] {
  return Array.from(repoMap.entries())
    .map(([repo, data]) => ({
      repo,
      sessions: data.sessions,
      events: data.events,
    }))
    .sort((a, b) => b.events - a.events);
}
