import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { Resource } from '@opentelemetry/resources';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base';
import {
  convertEventLogToTrace,
  ExtendedTelemetryHandler,
  type EventLogRecord,
} from '@loongsuite/otel-util-genai';
import { createReadableSpanToOtlpSpanJsonArray } from './otlp-json-serializer.js';

import type { AgentActivityEntry, OtlpTraceFlusherConfig } from '../types/index.js';
import { BaseFlusher } from './base-flusher.js';
import { normalizeAgentType } from '../utils/agent-type-normalize.js';
import { resolveAgentSystem } from '../normalization/agent-system-map.js';
import {
  DEFAULT_GIT_PASSTHROUGH_KEYS,
  isReservedKey,
  type GlobalAttributesProvider,
} from '../normalization/global-attributes.js';
import { createLogger } from '../utils/logger.js';
import { appendLine, ensureDir, getTodayDateString, readInstalledVersion } from '../utils/fs-utils.js';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const logger = createLogger('otlp-trace-flusher');

/**
 * OTLP Trace 输出管道：
 * AgentActivityEntry -> Turn 聚合 -> GenAI 事件转 Span -> 按 service.name 分组 -> 多后端扇出。
 *
 * 与 JSONL/SLS/HTTP 的逐事件输出不同，本 Flusher 必须先收齐一个 Turn，才能交给
 * otel-util-genai 重建 ENTRY / AGENT / STEP / LLM / TOOL Span 层次。因此这里同时维护
 * Turn 缓冲、转换状态和导出状态三类生命周期彼此独立的对象。
 */

/** W3C Trace ID 的严格格式；只有合法的 32 位小写十六进制值才可作为稳定分组键。 */
const VALID_TRACE_ID_RE = /^[0-9a-f]{32}$/;

/** 能明确证明模型响应或整个 Turn 已结束的 finish reason。 */
const TERMINAL_FINISH_REASONS = new Set(['stop', 'end_turn', 'cancelled']);

/** 尚未完成转换的单个 Turn 事件缓冲。 */
interface TurnBuffer {
  /** 带来源前缀的 Map 唯一键，避免相同文本的 turn/session/trace ID 相互碰撞。 */
  key: string;
  /** 分组键来源；决定缺失 gen_ai.turn.id 时应回填哪个值。 */
  keySource: 'turn_id' | 'trace_id' | 'session_id' | 'ephemeral';
  /** 不带来源前缀的原始标识。 */
  keyValue: string;
  /** 归一化后的 Agent 类型，用于隔离转换状态、Resource 和 Exporter。 */
  agentType: string;
  /** 按抵达顺序保存的标准事件，完成后一次性交给 GenAI Trace 转换器。 */
  records: AgentActivityEntry[];
  /** 是否已经由终态、后继 Turn、显式 flush 或空闲超时判定为完成。 */
  completed: boolean;
  /** 最近追加记录的墙钟时间，供空闲超时兜底，单位毫秒。 */
  lastActivityMs: number;
}

/**
 * 某个“Agent + service.name + 投影 Resource 属性”组合复用的 Span 转换环境。
 * 转换器通过真实 TracerProvider 产出 Span，但先进入内存 Exporter，随后再由本类扇出。
 */
interface AgentConvertState {
  /** 绑定固定 Resource 的 OTel Provider。 */
  provider: BasicTracerProvider;
  /** otel-util-genai 使用的转换处理器。 */
  handler: ExtendedTelemetryHandler;
  /** 暂存本次转换完成 Span 的内存 Exporter。 */
  inMem: InMemorySpanExporter;
  /** 当前正在使用该状态的转换数；大于 0 时禁止 LRU 淘汰。 */
  active: number;
}

/** Flusher 实际依赖的最小 Exporter 接口，便于测试注入隔离后端的假实现。 */
export interface TraceExporterLike {
  /** 异步导出一批 Span，并通过回调报告成功或失败。 */
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void;
  /** 释放连接及 Exporter 内部资源。 */
  shutdown(): Promise<void>;
}

/** 根据已解析的单后端配置创建 Exporter；构造参数中的 name 主要供测试和定位使用。 */
export type OtlpExporterFactory = (opts: {
  /** 已补齐 /v1/traces 的最终 OTLP HTTP 地址。 */
  url: string;
  /** 当前后端独立的鉴权及扩展请求头。 */
  headers: Record<string, string>;
  /** 当前后端独立的传输压缩算法。 */
  compression: CompressionAlgorithm;
  /** 当前后端稳定名称。 */
  name: string;
}) => TraceExporterLike;

/** 构造函数完成默认值填充后的单个 OTLP Trace 后端。 */
interface ResolvedOtlpEndpoint {
  /** 日志、失败文件和 Exporter 使用的后端名称。 */
  name: string;
  /** 已规范化并补齐 /v1/traces 的发送地址。 */
  url: string;
  /** 仅属于当前后端的请求头。 */
  headers: Record<string, string>;
  /** gzip 或不压缩；原配置缺省时使用 gzip。 */
  compression: CompressionAlgorithm;
  /** 当前后端使用的 service.name 基础值，用于选择对应 Resource 和 Span 副本。 */
  serviceName: string;
}

/** 某个“Agent + service.name”组合对应的后端 Exporter 集合。 */
interface AgentExportState {
  /** 只包含 serviceName 相同的后端；批次会并行扇出到数组中的每一项。 */
  exporters: Array<{ name: string; exporter: TraceExporterLike }>;
}

/**
 * 平台负责生成的 Resource 字段。用户静态配置和事件投影都不得覆盖这些字段，
 * 否则会破坏服务归属、实例区分或 Agent 语义。
 */
const RESERVED_RESOURCE_KEYS = new Set([
  'service.name',
  'service.version',
  'service.instance.id',
  'service.namespace',
  'host.name',
  'gen_ai.agent.type',
  'gen_ai.agent.system',
]);

/** OTel Resource 可安全接受且适合稳定分组的标量值。 */
type ResourceProjectionValue = string | number | boolean;

/** 根据字段名阻止凭据被提升到 Resource；Resource 会复制到每个 Span，泄漏面更大。 */
const SENSITIVE_RESOURCE_KEY_RE = /(^|[_.-])(TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE)([_.-]|$)|^(API_KEY|API_HEADER)$/i;

/** 去掉末尾斜杠并补齐 OTLP HTTP/protobuf Trace 路径。 */
function resolveEndpointUrl(raw: string): string {
  let url = raw.replace(/\/+$/, '');
  if (!url.endsWith('/v1/traces')) {
    url += '/v1/traces';
  }
  return url;
}

/** 生产环境默认使用 OpenTelemetry 官方 OTLP HTTP/protobuf Exporter。 */
const defaultExporterFactory: OtlpExporterFactory = ({ url, headers, compression }) =>
  new OTLPTraceExporter({ url, headers, compression });

/** 默认单批估算上限为 10 MiB；这是拆批保护值，不是精确序列化后的硬限制。 */
const DEFAULT_MAX_EXPORT_BATCH_BYTES = 10 * 1024 * 1024;

/** 限制高基数 Resource 组合长期持有 Provider 和内存 Exporter。 */
const MAX_CONVERT_STATES = 64;

/**
 * 低成本估算 Span 导出大小，用于在真正 protobuf 序列化前拆批。
 * 固定开销覆盖 Span 元数据，字符串按字符数累加，其他标量按常量估算；单个超大 Span
 * 不会被拆开，因此最终批次仍可能超过配置阈值。
 */
function estimateSpanSize(span: ReadableSpan): number {
  let size = 512;
  for (const val of Object.values(span.attributes)) {
    if (typeof val === 'string') size += val.length;
    else size += 32;
  }
  for (const event of span.events ?? []) {
    size += 64;
    for (const val of Object.values(event.attributes ?? {})) {
      if (typeof val === 'string') size += val.length;
      else size += 32;
    }
  }
  return size;
}

/**
 * 把规范化事件重建为 GenAI Trace，并通过 OTLP HTTP/protobuf 扇出到一个或多个后端。
 *
 * 生命周期分为三段：
 * 1. send/sendBatch 将事件按 Turn 聚合；
 * 2. Turn 完成后通过内存 Provider 转换出 ReadableSpan；
 * 3. Span 按大小拆批，并行投递到各后端，失败后按后端隔离落盘。
 */
export class OtlpTraceFlusher extends BaseFlusher {
  /** MultiFlusher 和运行日志识别本输出通道的稳定名称。 */
  readonly name = 'otlp-trace';

  /** ConfigLoader 已完成后端合并与默认值解析的最终配置。 */
  private readonly cfg: OtlpTraceFlusherConfig;

  /** 尚未满足结束条件的 Turn，键由 resolveGroupKey 统一加来源前缀。 */
  private readonly turnBuffers = new Map<string, TurnBuffer>();

  /** 按 Agent、serviceName 和 Resource 属性组合缓存的转换环境，带 64 项软上限。 */
  private readonly agentConvertStates = new Map<string, AgentConvertState>();

  /** 按 Agent 和 serviceName 缓存的真实后端 Exporter；一直保留到 shutdown。 */
  private readonly agentExportStates = new Map<string, AgentExportState>();

  /** 当前 Flusher 进程实例 ID，写入所有 Resource 的 service.instance.id。 */
  private readonly instanceId = randomUUID();

  /** 安装版本，写入 Resource 的 service.version。 */
  private readonly pilotVersion: string;

  /** 已补全名称、URL、Header、压缩和 serviceName 的后端列表。 */
  private readonly endpoints: ResolvedOtlpEndpoint[];

  /** 生产使用默认工厂，测试可注入可观测且不访问网络的假 Exporter。 */
  private readonly exporterFactory: OtlpExporterFactory;

  /** 开启 debug 时写入转换后 Span JSONL 的目录。 */
  private readonly debugDir: string;

  /** 后端导出失败时按 endpoint 隔离写入 Span JSONL 的目录。 */
  private readonly failedDir: string;

  /** 允许从事件顶层字段提升到 Resource 的白名单。 */
  private readonly resourceAttributeKeys: string[];

  /** 允许原样透传到 Span Attribute 的事件顶层字段前缀。 */
  private readonly spanAttributePassthroughPrefixes: string[];

  /** 合并 config、环境变量和动态文件的 Trace 专用全局属性提供器。 */
  private readonly globalAttributesProvider?: GlobalAttributesProvider;

  /** 开启 Turn 空闲超时后，每秒扫描缓冲区的非阻塞定时器。 */
  private idleTimer?: ReturnType<typeof setInterval>;

  /** triggerFlush 启动但尚未结束的后台转换/导出任务，flush 和 shutdown 会等待它们。 */
  private inFlightExports = new Set<Promise<void>>();

  /** 已按明确终态导出的 Turn 键；阻止终态之后迟到的记录产生重复 Trace。 */
  private flushedTurnKeys = new Set<string>();

  /**
   * 每个转换状态的 Promise 链。InMemorySpanExporter 是共享可变对象，同一状态若并发执行
   * forceFlush/getFinishedSpans/reset 会互相窃取 Span，因此必须按 convertKey 串行化。
   */
  private readonly convertLocks = new Map<string, Promise<void>>();

  // 批量模式标记：为 true 时 send() 中 Signal A（终态 finish_reason）只标记
  // completed 不立即 flush，由 sendBatch() 在所有 entries 处理完后统一 flush。
  // 解决的问题：Cursor subagent 的子 records 可能排在父 stop 之后，如果 Signal A
  // 即时 flush 会把 key 加入 flushedTurnKeys，导致同一 batch 后续同 key 记录被丢弃。
  private _deferSignalA = false;

  /**
   * 校验必要配置、解析后端，并准备转换和诊断运行环境。
   *
   * @param cfg 已合并用户与托管后端的最终 OTLP 配置。
   * @param globalAttributesProvider 可动态刷新的 Span 自定义属性来源。
   * @param exporterFactory 测试注入点；缺省创建官方 OTLPTraceExporter。
   */
  constructor(
    cfg: OtlpTraceFlusherConfig,
    globalAttributesProvider?: GlobalAttributesProvider,
    exporterFactory?: OtlpExporterFactory,
  ) {
    super();

    // 没有后端时无法形成有效扇出；正常启动路径应在 ConfigLoader 阶段避免构造本类。
    if (!cfg.endpoints || cfg.endpoints.length === 0) {
      throw new Error('[otlp-trace-flusher] config.endpoints must be non-empty when enabled');
    }
    // serviceName 是生成 Resource 和按后端分组的基线，不能静默使用空值。
    if (!cfg.serviceName) {
      throw new Error('[otlp-trace-flusher] config.serviceName is required when enabled');
    }

    this.cfg = cfg;
    this.globalAttributesProvider = globalAttributesProvider;
    this.exporterFactory = exporterFactory ?? defaultExporterFactory;

    // 每个后端保留自己的认证、压缩和 serviceName；未显式关闭压缩时默认 gzip。
    this.endpoints = cfg.endpoints.map((ep, i) => ({
      name: ep.name || `otlp-${i}`,
      url: resolveEndpointUrl(ep.endpoint),
      headers: ep.headers ?? {},
      compression: ep.compression === 'none' ? CompressionAlgorithm.NONE : CompressionAlgorithm.GZIP,
      serviceName: ep.serviceName || cfg.serviceName,
    }));

    // 诊断输出与 Collector 其他运行数据共用 dataDir，未传入时兼容早期默认目录。
    const dataDir = cfg.dataDir ?? os.homedir() + '/.loongsuite-pilot';
    this.pilotVersion = readInstalledVersion(dataDir);
    this.debugDir = path.join(dataDir, 'logs', 'otlp-debug');
    this.failedDir = path.join(dataDir, 'logs', 'otlp-failed');

    // ConfigLoader 通常已清洗；构造函数再次去空白，支持测试和其他直接调用方。
    this.resourceAttributeKeys = (cfg.resourceAttributeKeys ?? [])
      .map(key => key.trim())
      .filter(key => key.length > 0);
    this.spanAttributePassthroughPrefixes = (cfg.spanAttributePassthroughPrefixes ?? [])
      .map(prefix => prefix.trim())
      .filter(prefix => prefix.length > 0);

    // 仅在调用方未预设时启用 GenAI 实验语义和消息 Span 内容，尊重宿主进程显式配置。
    if (cfg.captureMessageContent !== false) {
      process.env.OTEL_SEMCONV_STABILITY_OPT_IN ??= 'gen_ai_latest_experimental';
      process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT ??= 'SPAN_ONLY';
    }

    // 扫描粒度固定为 1 秒；真正超时阈值由 turnIdleTimeoutMs 控制。
    if (cfg.turnIdleTimeoutMs && cfg.turnIdleTimeoutMs > 0) {
      this.idleTimer = setInterval(() => this.tickIdleTimeout(), 1000);
      // 定时器本身不应阻止 Node.js 进程自然退出。
      this.idleTimer.unref();
    }

    logger.info(
      `OTLP trace flusher initialized → ${this.endpoints.map(e => `${e.name}(${e.url})`).join(', ')}`,
    );
  }

  // --- BaseFlusher 公共生命周期 ---

  /**
   * 接收单条标准事件并推进对应 Turn 缓冲。
   *
   * Turn 有两个主动结束信号：
   * - Signal A：当前记录带终态 finish_reason；
   * - Signal B：同一 Agent 出现另一个稳定分组键，说明前一个 Turn 已被后继活动取代。
   *
   * 无稳定键的孤立记录无法可靠等待后续事件，因此直接按单记录转换和导出。
   */
  async send(entry: AgentActivityEntry): Promise<void> {
    const { source, value, key } = this.resolveGroupKey(entry);
    const agentType = normalizeAgentType(
      (entry['gen_ai.agent.type'] as string) ?? '',
    );

    // ephemeral 键只为本次调用提供唯一性，不进入 Map，避免永远无法自然完成的缓冲泄漏。
    if (source === 'ephemeral') {
      await this.convertAndExport(agentType, [entry]);
      return;
    }

    // 明确终态之后抵达的同 Turn 记录视为迟到数据，丢弃以避免生成重复 Trace。
    if (this.flushedTurnKeys.has(key)) {
      logger.debug(`Dropping late entry for already-flushed turn ${key}`);
      return;
    }

    // Signal B：同一 Agent 已出现新键时，结束旧的未完成 Turn。
    // 这里 markFlushed=false，因为旧 Turn 没有明确终态，后续若再次出现仍允许重新聚合。
    for (const [bufKey, buf] of this.turnBuffers) {
      if (buf.agentType === agentType && bufKey !== key && !buf.completed) {
        buf.completed = true;
        this.triggerFlush(buf, false);
      }
    }

    // 第一次看到稳定键时创建缓冲；之后同键记录保持到达顺序追加。
    let buf = this.turnBuffers.get(key);
    if (!buf) {
      buf = {
        key,
        keySource: source,
        keyValue: value,
        agentType,
        records: [],
        completed: false,
        lastActivityMs: Date.now(),
      };
      this.turnBuffers.set(key, buf);
    }
    buf.records.push(entry);
    buf.lastActivityMs = Date.now();

    // Signal A：终态 finish_reason 是最可靠边界。逐条模式立即启动后台 flush；
    // 批量模式只标记 completed，等待 batch 后续可能属于同 Turn 的子记录全部追加完成。
    if (hasTerminalFinishReason(entry['gen_ai.response.finish_reasons'])) {
      buf.completed = true;
      if (!this._deferSignalA) {
        this.triggerFlush(buf);
      }
    }
  }

  /**
   * 按输入顺序接收一个批次，并延迟 Signal A 的导出时点。
   * finally 确保单条处理抛错时也能恢复逐条模式；正常遍历结束后再统一等待已完成缓冲。
   */
  async sendBatch(entries: AgentActivityEntry[]): Promise<void> {
    // Cursor 等 Agent 的 subagent 记录可能排在父 stop 后面，不能在遍历中途加入迟到黑名单。
    this._deferSignalA = true;
    try {
      for (const entry of entries) {
        await this.send(entry);
      }
    } finally {
      this._deferSignalA = false;
    }

    // 等待本批次中仍保留在 Map 且已完成的 Turn；Signal B 启动的后台任务由 flush/shutdown 排空。
    await this.flushCompleted();
  }

  /**
   * 强制完成所有缓冲并等待当前所有后台导出，用于显式刷新及 shutdown。
   * inFlightExports 使用循环快照，确保等待期间集合发生变化时不会漏掉仍在执行的任务。
   */
  async flush(): Promise<void> {
    for (const buf of this.turnBuffers.values()) {
      buf.completed = true;
    }
    await this.flushCompleted();

    while (this.inFlightExports.size > 0) {
      const batch = [...this.inFlightExports];
      await Promise.allSettled(batch);
    }

    // flush 构成一个外部边界；之后允许复用相同 ID，避免黑名单无限跨周期保留。
    this.flushedTurnKeys.clear();
  }

  /**
   * 停止定时器、排空 Turn 和导出任务，再关闭全部 Exporter 与转换 Provider。
   * 单个后端或 Provider 关闭失败不会阻塞其他资源释放。
   */
  async shutdown(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }

    await this.flush();

    const exportShutdowns = [...this.agentExportStates.values()].flatMap(
      (s) => s.exporters.map((e) => e.exporter.shutdown()),
    );
    const providerShutdowns = [...this.agentConvertStates.values()].map(
      (s) => s.provider.shutdown(),
    );
    await Promise.allSettled([...exportShutdowns, ...providerShutdowns]);

    this.agentExportStates.clear();
    this.agentConvertStates.clear();
    logger.info('OTLP trace flusher shut down');
  }

  // --- 测试入口 ---

  /**
   * 跳过 Turn 聚合与事件转换，直接把已有 ReadableSpan 发往全部后端。
   * 主要用于验证拆批、后端隔离和生命周期；生产数据路径使用 convertAndExport。
   */
  async exportSpansForAgent(agentType: string, spans: ReadableSpan[]): Promise<void> {
    if (this.cfg.debug) {
      await this.writeDebugLog(agentType, spans);
    }

    // 同一 serviceName 组只调用一次 exportInBatches，组内函数再扇出到每个 endpoint。
    const serviceNames = [...new Set(this.endpoints.map((e) => e.serviceName))];
    await Promise.all(
      serviceNames.map((serviceName) =>
        this.exportInBatches(this.getOrCreateExportState(agentType, serviceName), agentType, spans),
      ),
    );
  }

  // --- Turn 聚合与转换 ---

  /**
   * 按可靠性从高到低选择 Turn 分组键：
   * gen_ai.turn.id > 合法 trace_id > gen_ai.session.id > event.id/随机 UUID。
   *
   * session_id 只能作为兼容兜底，同一会话通常包含多个 Turn；Signal A/B 和空闲超时负责
   * 防止其无限聚合。ephemeral 表示没有可跨记录关联的稳定 ID，调用方会立即导出。
   */
  private resolveGroupKey(entry: AgentActivityEntry): {
    source: TurnBuffer['keySource'];
    value: string;
    key: string;
  } {
    const turnId = entry['gen_ai.turn.id'] as string | undefined;
    if (turnId && turnId.length > 0) {
      return { source: 'turn_id', value: turnId, key: `turn:${turnId}` };
    }

    const traceId = entry['trace_id'] as string | undefined;
    if (traceId && VALID_TRACE_ID_RE.test(traceId)) {
      return { source: 'trace_id', value: traceId, key: `trace:${traceId}` };
    }

    const sessionId = entry['gen_ai.session.id'] as string | undefined;
    if (sessionId && sessionId.length > 0) {
      return { source: 'session_id', value: sessionId, key: `session:${sessionId}` };
    }

    const ephemeralId = (entry['event.id'] as string) ?? randomUUID();
    return { source: 'ephemeral', value: ephemeralId, key: `ephemeral:${ephemeralId}` };
  }

  /**
   * 从缓冲 Map 原子摘除一个 Turn，并在后台执行转换和导出。
   * Promise 被登记到 inFlightExports，使 send 保持低延迟，同时让 flush/shutdown 可以排空。
   *
   * @param markFlushed 是否把键加入迟到黑名单；明确终态为 true，Signal B 推断边界为 false。
   */
  private triggerFlush(buf: TurnBuffer, markFlushed = true): void {
    if (markFlushed) {
      this.flushedTurnKeys.add(buf.key);
    }
    this.turnBuffers.delete(buf.key);

    const p = this.flushSingleTurn(buf).catch((err) => {
      // 后台任务不能向 send 调用栈传播异常，但必须保留可定位日志。
      logger.error(`Failed to flush turn ${buf.key}`, { err: String(err) });
    }).finally(() => {
      this.inFlightExports.delete(p);
    });
    this.inFlightExports.add(p);
  }

  /** 摘除并等待当前所有 completed 缓冲；未完成的 Turn 继续留在 Map 中。 */
  private async flushCompleted(): Promise<void> {
    const completed: TurnBuffer[] = [];
    for (const [key, buf] of this.turnBuffers) {
      if (buf.completed) {
        completed.push(buf);
        this.flushedTurnKeys.add(key);
        this.turnBuffers.delete(key);
      }
    }

    // allSettled 保证某个 Turn 转换失败时，其他已完成 Turn 仍能继续导出。
    await Promise.allSettled(
      completed.map((buf) => this.flushSingleTurn(buf)),
    );
  }

  /**
   * 为缺少 gen_ai.turn.id 的兼容事件补齐稳定 Turn ID，再进入转换。
   * 此处会修改缓冲中的原始 record；这些记录已进入 Trace 专用路径，不会回流到其他 Flusher。
   */
  private async flushSingleTurn(buf: TurnBuffer): Promise<void> {
    if (buf.keySource !== 'turn_id') {
      for (const record of buf.records) {
        if (!record['gen_ai.turn.id']) {
          (record as Record<string, unknown>)['gen_ai.turn.id'] = buf.keyValue;
        }
      }
    }
    await this.convertAndExport(buf.agentType, buf.records);
  }

  /**
   * 计算本 Turn 的 Resource 投影，并按不同 service.name 分别转换和导出。
   *
   * Resource 属于 Span 的不可变组成部分；用户后端与托管后端若 serviceName 不同，就必须
   * 各自创建带对应 Resource 的 Span。相同 serviceName 的多个 endpoint 只转换一次。
   */
  private async convertAndExport(
    agentType: string,
    records: AgentActivityEntry[],
  ): Promise<void> {
    if (records.length === 0) return;

    const projectedResourceAttributes = this.collectResourceAttributes(records);
    const serviceNames = [...new Set(this.endpoints.map((e) => e.serviceName))];

    // 不同 convertKey 可并行；相同 key 串行，保护共享 InMemorySpanExporter 的读写/清空序列。
    await Promise.all(
      serviceNames.map((serviceName) => {
        const convertKey = this.buildConvertStateKey(agentType, serviceName, projectedResourceAttributes);
        const prev = this.convertLocks.get(convertKey) ?? Promise.resolve();
        const current = prev.then(() => this.doConvertAndExport(
          agentType,
          serviceName,
          records,
          projectedResourceAttributes,
          convertKey,
        ));

        // 锁尾必须吞掉失败，否则一个历史失败会让该 key 后续任务永远无法执行。
        this.convertLocks.set(convertKey, current.catch(() => {}));
        return current;
      }),
    );
  }

  /**
   * 在指定 Resource 的转换环境中，把一个 Turn 的事件转换为 Span 并发送到对应后端组。
   *
   * 调用方已经通过 convertLocks 保证同一 convertKey 不并发，因此本函数可以安全地清空
   * 共享 InMemorySpanExporter。所有异常在此收敛为日志，单个 Turn 失败不影响采集主链路。
   */
  private async doConvertAndExport(
    agentType: string,
    serviceName: string,
    records: AgentActivityEntry[],
    projectedResourceAttributes: Record<string, ResourceProjectionValue>,
    convertKey: string,
  ): Promise<void> {
    const convertState = this.getOrCreateConvertState(agentType, serviceName, projectedResourceAttributes, convertKey);
    const { handler, provider, inMem } = convertState;

    // active 保护本状态在整个转换、读取和导出期间不被 LRU 淘汰。
    convertState.active += 1;

    try {
      try {
        // 每个 Turn 都重新解析动态 span-attributes.json，使运行中修改无需重启即可生效。
        // 自定义属性只进入 Trace 转换副本，不修改原始事件，因此不会意外进入 JSONL/SLS/HTTP。
        const customAttrs = this.globalAttributesProvider?.resolve() ?? {};
        const customKeys = Object.keys(customAttrs);

        // Hook/Plugin 写入的调用方字段已经位于事件顶层。这里只收集匹配配置前缀的字段名，
        // 再交给 converter 的 passthroughKeys；值仍由 converter 从各 record 自己读取。
        const prefixKeys = this.spanAttributePassthroughPrefixes.length === 0
          ? []
          : [...new Set(
              records.flatMap(r =>
                Object.keys(r).filter(k =>
                  // 二次防御：即使误配 gen_ai. 等宽泛前缀，也不得原样透传平台保留字段。
                  !isReservedKey(k) &&
                  this.spanAttributePassthroughPrefixes.some(p => k.startsWith(p)),
                ),
              ),
            )];

        // Git/workspace 是平台默认透传项；自定义键和前缀命中键在同一 Turn 内统一去重。
        const passthroughKeys = [...new Set([...DEFAULT_GIT_PASSTHROUGH_KEYS, ...customKeys, ...prefixKeys])];

        // fill-only 语义：事件自身的值优先。只有存在全局属性时才复制，避免常规路径多余分配。
        const recordsForConversion = customKeys.length === 0
          ? records
          : records.map((r) => {
              const copy: AgentActivityEntry = { ...r };
              for (const [k, v] of Object.entries(customAttrs)) {
                if (copy[k] === undefined) copy[k] = v;
              }
              return copy;
            });

        // strict=false 允许部分 Agent 记录不完整时尽量生成可用 Span，结构问题通过 warnings 暴露。
        const result = convertEventLogToTrace(
          recordsForConversion as unknown as EventLogRecord[],
          { handler, strict: false, passthroughKeys },
        );
        if (result.warnings.length > 0) {
          logger.warn(`Conversion warnings for ${agentType}`, { warnings: result.warnings.join('; ') });
        }
      } catch (err) {
        // 转换失败时没有可信的完整 Span 集合可发送，记录错误并结束当前 Turn。
        logger.error(`convertEventLogToTrace failed for ${agentType}`, { err: String(err) });
        return;
      }

      // SimpleSpanProcessor 可能仍在处理转换器结束的 Span；forceFlush 后才能完整读取内存结果。
      await provider.forceFlush();
      const spans = inMem.getFinishedSpans();

      // 当前 convertKey 已由锁串行化，读取后立即 reset，不让 Span 混入下一 Turn。
      inMem.reset();

      if (spans.length === 0) return;

      const exportState = this.getOrCreateExportState(agentType, serviceName);

      // Debug 落盘是诊断副本，内部失败只告警，不阻断远端导出。
      if (this.cfg.debug) {
        await this.writeDebugLog(agentType, spans);
      }

      await this.exportInBatches(exportState, agentType, spans);
    } catch (err) {
      logger.error(`convert and export failed for ${agentType}`, { err: String(err) });
    } finally {
      convertState.active -= 1;
      // 每次转换退出都重试软上限清理，处理此前全部状态都 active 导致的临时溢出。
      this.evictConvertStates();
    }
  }

  /**
   * 按估算字节数拆分 Span，并把相同批次集合扇出到 serviceName 组内所有后端。
   * Span 顺序保持不变，单个 Span 不会被拆开。
   */
  private async exportInBatches(
    exportState: AgentExportState,
    agentType: string,
    spans: ReadableSpan[],
  ): Promise<void> {
    const maxBytes = this.cfg.maxExportBatchBytes ?? DEFAULT_MAX_EXPORT_BATCH_BYTES;
    const batches: ReadableSpan[][] = [];
    let current: ReadableSpan[] = [];
    let currentSize = 0;

    // 贪心装批：加入下一个 Span 会超限时先提交当前非空批次。
    for (const span of spans) {
      const size = estimateSpanSize(span);
      if (current.length > 0 && currentSize + size > maxBytes) {
        batches.push(current);
        current = [];
        currentSize = 0;
      }
      current.push(span);
      currentSize += size;
    }
    if (current.length > 0) batches.push(current);

    if (batches.length > 1) {
      logger.info(`Exporting ${spans.length} spans in ${batches.length} batches`, { agentType, maxBytes });
    }

    // 后端之间并行，避免慢后端对健康后端造成队头阻塞；同一后端内部按批次顺序串行，
    // 保持 Turn Span 的相对顺序并限制该后端的并发请求数。
    await Promise.allSettled(
      exportState.exporters.map(({ name, exporter }) =>
        this.exportBatchesToEndpoint(exporter, name, agentType, batches),
      ),
    );
  }

  /** 将拆好的批次按顺序交给单个后端；其他后端由 exportInBatches 并行驱动。 */
  private async exportBatchesToEndpoint(
    exporter: TraceExporterLike,
    endpointName: string,
    agentType: string,
    batches: ReadableSpan[][],
  ): Promise<void> {
    for (const batch of batches) {
      await this.doExport(exporter, endpointName, agentType, batch);
    }
  }

  /**
   * 把 OpenTelemetry callback 风格的 export 包装成 Promise。
   * 回调报告的后端失败会记录并异步落盘，但 Promise 正常完成，从而隔离后端业务失败；
   * 若第三方 Exporter 在调用 export 时同步抛错，Promise 仍会拒绝并由上层 allSettled 隔离。
   */
  private doExport(
    exporter: TraceExporterLike,
    endpointName: string,
    agentType: string,
    spans: ReadableSpan[],
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      exporter.export(spans, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) {
          const errMsg = result.error?.message ?? 'unknown export error';
          logger.warn(`Export failed for ${agentType} → ${endpointName}: ${errMsg}`);

          // 失败日志不阻塞 Exporter 回调；writeFailedLog 自身也会收敛文件系统异常。
          this.writeFailedLog(agentType, endpointName, spans, {
            code: result.code,
            message: errMsg,
          }).catch(() => undefined);
        }
        resolve();
      });
    });
  }

  /**
   * 获取绑定固定 Resource 的转换环境，并用 Map 插入顺序维护近似 LRU。
   * Resource 一旦创建不能修改，因此投影属性不同必须使用不同 Provider。
   */
  private getOrCreateConvertState(
    agentType: string,
    serviceName: string,
    projectedResourceAttributes: Record<string, ResourceProjectionValue> = {},
    key = this.buildConvertStateKey(agentType, serviceName, projectedResourceAttributes),
  ): AgentConvertState {
    let state = this.agentConvertStates.get(key);
    if (state) {
      // delete + set 将命中项移动到 Map 尾部，头部始终是最久未使用候选。
      this.agentConvertStates.delete(key);
      this.agentConvertStates.set(key, state);
      return state;
    }

    // 真实 OTLP Exporter 不挂在此 Provider 上：转换 Span 先进入内存，再由本类多后端扇出。
    const resource = this.buildResource(agentType, serviceName, projectedResourceAttributes);
    const inMem = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      resource,
      spanProcessors: [new SimpleSpanProcessor(inMem)],
    });
    const handler = new ExtendedTelemetryHandler({ tracerProvider: provider });

    state = { provider, handler, inMem, active: 0 };
    this.agentConvertStates.set(key, state);
    this.evictConvertStates();
    return state;
  }

  /**
   * 将转换状态控制在软上限内，优先淘汰 Map 中最旧的空闲项。
   * Provider 仍在转换时宁可临时超过上限，也不能关闭后导致当前 Turn 丢 Span。
   */
  private evictConvertStates(): void {
    while (this.agentConvertStates.size > MAX_CONVERT_STATES) {
      const entry = [...this.agentConvertStates.entries()].find(([, state]) => state.active === 0);
      if (!entry) {
        // 当前全部状态都在使用；转换 finally 会再次调用本函数。
        return;
      }

      const [key, state] = entry;
      this.agentConvertStates.delete(key);
      // 对应 Promise 链不再需要；未来同 key 会创建全新的 Provider 和锁。
      this.convertLocks.delete(key);

      // 淘汰不阻塞当前导出主链路，关闭失败只记录告警。
      state.provider.shutdown().catch(err => {
        logger.warn('failed to shut down evicted convert state', { key, error: String(err) });
      });
    }
  }

  /** 组合所有会改变 Resource 的维度，作为转换状态和串行锁的共同键。 */
  private buildConvertStateKey(
    agentType: string,
    serviceName: string,
    projectedResourceAttributes: Record<string, ResourceProjectionValue>,
  ): string {
    return `${agentType}|${serviceName}|${this.stableJson(projectedResourceAttributes)}`;
  }

  /** 按属性名排序后序列化，避免相同对象因字段插入顺序不同制造重复 Provider。 */
  private stableJson(value: Record<string, ResourceProjectionValue>): string {
    const sorted: Record<string, ResourceProjectionValue> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = value[key];
    }
    return JSON.stringify(sorted);
  }

  /**
   * 从一个 Turn 的记录中收集动态 Resource 属性。
   *
   * 两类来源：
   * - record.resourceAttributes：由受信任 Hook/Plugin 显式提供，全部尝试收集；
   * - record 顶层字段：只有列入 resourceAttributeKeys 白名单才允许提升。
   *
   * 同一字段在 Turn 内冲突时保留首个有效值，保证整个 Turn 的 Resource 稳定。
   */
  private collectResourceAttributes(records: AgentActivityEntry[]): Record<string, ResourceProjectionValue> {
    const allowed = new Set(this.resourceAttributeKeys);
    const attributes: Record<string, ResourceProjectionValue> = {};

    for (const record of records) {
      this.collectResourceAttributeMap(attributes, record.resourceAttributes);
      if (allowed.size === 0) continue;

      for (const [key, rawValue] of Object.entries(record)) {
        if (!allowed.has(key)) continue;
        this.collectResourceAttribute(attributes, key, rawValue);
      }
    }

    return attributes;
  }

  /** 校验 resourceAttributes 确为普通对象后，逐字段套用统一安全规则。 */
  private collectResourceAttributeMap(
    attributes: Record<string, ResourceProjectionValue>,
    rawMap: unknown,
  ): void {
    if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return;

    for (const [key, rawValue] of Object.entries(rawMap as Record<string, unknown>)) {
      this.collectResourceAttribute(attributes, key, rawValue);
    }
  }

  /**
   * 收集单个动态 Resource 属性：拒绝疑似凭据、非标量值和 Turn 内冲突值。
   * 保留首值使到达顺序成为确定的冲突解决规则，避免一个 Turn 被拆成多个 Resource。
   */
  private collectResourceAttribute(
    attributes: Record<string, ResourceProjectionValue>,
    key: string,
    rawValue: unknown,
  ): void {
    if (SENSITIVE_RESOURCE_KEY_RE.test(key)) {
      logger.warn(`resource attribute key "${key}" looks sensitive and will be ignored`);
      return;
    }

    const value = this.normalizeResourceAttributeValue(rawValue);
    if (value === undefined) return;

    if (attributes[key] !== undefined && attributes[key] !== value) {
      logger.warn(`resource attribute key "${key}" has conflicting values in one turn; keeping first value`);
      return;
    }
    attributes[key] = value;
  }

  /** 只接受非空字符串、布尔值和有限数字；对象、数组、NaN 与 Infinity 均忽略。 */
  private normalizeResourceAttributeValue(value: unknown): ResourceProjectionValue | undefined {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return undefined;
  }

  // --- Exporter、Resource 与诊断输出 ---

  /**
   * 为指定 Agent 和 serviceName 延迟创建真实后端 Exporter。
   * 只选择 serviceName 完全匹配的 endpoint，保证每个后端只收到对应 Resource 的 Span。
   */
  private getOrCreateExportState(agentType: string, serviceName: string): AgentExportState {
    const key = `${agentType}|${serviceName}`;
    let state = this.agentExportStates.get(key);
    if (state) return state;

    const exporters = this.endpoints
      .filter((ep) => ep.serviceName === serviceName)
      .map((ep) => ({
        name: ep.name,
        exporter: this.exporterFactory({
          url: ep.url,
          headers: ep.headers,
          compression: ep.compression,
          name: ep.name,
        }),
      }));

    state = { exporters };
    this.agentExportStates.set(key, state);
    return state;
  }

  /**
   * 构造绑定到转换 Provider 的 OTel Resource。
   *
   * 合并优先级为：平台固定字段 -> 用户静态 resourceAttributes -> Turn 动态投影属性。
   * 保留键在两类外部属性中都会被拒绝；动态投影还额外拒绝疑似凭据字段。动态值覆盖
   * 同名静态值，因为它更贴近当前 Turn 的实际执行上下文。
   */
  private buildResource(
    agentType: string,
    serviceName: string,
    projectedResourceAttributes: Record<string, ResourceProjectionValue> = {},
  ): Resource {
    // 用户静态配置被视为显式受信任输入，但仍不能覆盖平台核心字段。
    const userAttrs: Record<string, string> = {};
    if (this.cfg.resourceAttributes) {
      for (const [k, v] of Object.entries(this.cfg.resourceAttributes)) {
        if (RESERVED_RESOURCE_KEYS.has(k)) {
          logger.warn(`resourceAttributes key "${k}" is reserved and will be ignored`);
          continue;
        }
        userAttrs[k] = v;
      }
    }

    // 动态值来自事件，因此同时执行保留键和敏感名称检查。
    const projectedAttrs: Record<string, ResourceProjectionValue> = {};
    for (const [k, v] of Object.entries(projectedResourceAttributes)) {
      if (RESERVED_RESOURCE_KEYS.has(k)) {
        logger.warn(`projected resource attribute key "${k}" is reserved and will be ignored`);
        continue;
      }
      if (SENSITIVE_RESOURCE_KEY_RE.test(k)) {
        logger.warn(`projected resource attribute key "${k}" looks sensitive and will be ignored`);
        continue;
      }
      if (userAttrs[k] !== undefined && userAttrs[k] !== String(v)) {
        logger.warn(`resourceAttributes key "${k}" is overridden by projected resource attribute`);
      }
      projectedAttrs[k] = v;
    }

    return new Resource({
      // serviceName 是用户/托管后端组前缀，再拼 Agent 类型形成最终 service.name。
      'service.name': `${serviceName}-${agentType}`,
      'service.version': this.pilotVersion,
      'service.instance.id': this.instanceId,
      'service.namespace': 'loongsuite-pilot',
      'host.name': os.hostname(),
      'gen_ai.agent.type': agentType,
      'gen_ai.agent.system': resolveAgentSystem(agentType),
      ...userAttrs,
      ...projectedAttrs,
    });
  }

  /**
   * 将转换后的 Span 以 OTLP JSON 形态逐行写入按日期分隔的调试文件。
   * 文件名使用公共 cfg.serviceName 便于统一查找；每行 Resource 仍保留实际后端组 service.name。
   * 任何文件错误都只记录告警，不影响远端导出。
   */
  private async writeDebugLog(agentType: string, spans: ReadableSpan[]): Promise<void> {
    try {
      const svcName = `${this.cfg.serviceName}-${agentType}`;
      const dir = this.debugDir;
      await ensureDir(dir);
      const filename = `${svcName}-${getTodayDateString()}.jsonl`;
      const filepath = path.join(dir, filename);
      const jsonLines = createReadableSpanToOtlpSpanJsonArray(spans);

      // 保持序列顺序逐行 append，方便直接使用常规 JSONL 工具诊断。
      for (const line of jsonLines) {
        await appendLine(filepath, line);
      }
    } catch (err) {
      logger.warn('Debug log write failed (non-blocking)', { err: String(err) });
    }
  }

  /**
   * 为单个失败后端持久化可诊断、可按行读取的 Span，并附加 ExportResult 错误摘要。
   * 不同 endpoint 写入不同文件，健康后端不会产生失败副本。
   */
  private async writeFailedLog(
    agentType: string,
    endpointName: string,
    spans: ReadableSpan[],
    error: { code: number; message: string },
  ): Promise<void> {
    try {
      // endpointName 可来自托管配置，必须移除路径分隔符和其他特殊字符，防止目录穿越。
      const safeEndpoint = endpointName.replace(/[^A-Za-z0-9._-]/g, '_');
      const svcName = `${this.cfg.serviceName}-${agentType}__${safeEndpoint}`;
      const dir = this.failedDir;
      await ensureDir(dir);
      const filepath = path.join(dir, `${svcName}.jsonl`);
      const jsonLines = createReadableSpanToOtlpSpanJsonArray(spans);

      for (const line of jsonLines) {
        const obj = JSON.parse(line);
        obj._error = error;
        await appendLine(filepath, JSON.stringify(obj));
      }
    } catch (err) {
      // 失败落盘本身失败时不能递归影响采集或其他后端。
      logger.warn('Failed-log write failed', { err: String(err) });
    }
  }

  /**
   * 每秒检查未完成 Turn 的空闲时长，超时后按明确终态处理并启动后台导出。
   * 这是缺少 finish_reason 和后继键时的可选兜底；默认 timeout=0 不启用。
   */
  private tickIdleTimeout(): void {
    const timeout = this.cfg.turnIdleTimeoutMs ?? 0;
    if (timeout <= 0) return;

    const now = Date.now();
    for (const [, buf] of this.turnBuffers) {
      if (!buf.completed && now - buf.lastActivityMs > timeout) {
        buf.completed = true;
        this.triggerFlush(buf);
      }
    }
  }
}

/** 仅数组中的 stop/end_turn/cancelled 字符串被视为可靠终态，其他形态保持继续缓冲。 */
function hasTerminalFinishReason(finishReasons: unknown): boolean {
  return Array.isArray(finishReasons)
    && finishReasons.some(reason => typeof reason === 'string' && TERMINAL_FINISH_REASONS.has(reason));
}
