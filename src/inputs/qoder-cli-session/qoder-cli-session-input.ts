/** Qoder CLI session 文件轮询备用 Input；从本地对话记录增量构建标准事件。 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { buildAgentActivityEntry, timestampToUnixNanos } from '../../normalization/entry-builder.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';
import {
  BaseSessionInput,
  type SessionInputOptions,
} from '../base/base-session-input.js';

const DEFAULT_SESSION_DIR = '~/.qoder/logs/sessions';
const SOURCE = 'qoder-cli-session-segment';
const SUPPORTED_EVENT_TYPE = 'model.response.completed';
const UNKNOWN_MODEL = 'unknown';

export interface QoderCliSessionInputOptions extends Omit<SessionInputOptions, 'sessionDir' | 'filePattern'> {
  sessionDir?: string;
  filePattern?: string;
}

/**
 * Qoder CLI 原生 session segment token usage 输入。
 *
 * BaseSessionInput 按 offset tail `segments` 目录下的 JSONL；本类只把
 * `model.response.completed` 转为 llm.response，其他 session 事件忽略。首次启动 baseline 到现有
 * 文件 EOF，不回放安装前历史。该来源主要补充 token 用量，不尝试伪造 prompt 或工具事件。
 */
export class QoderCliSessionInput extends BaseSessionInput {
  readonly id = 'qoder-cli-session';
  readonly agentType = ClientType.QoderCli;

  /** 配置 session 根目录、glob 文件模式和轮询间隔；文件读取由 BaseSessionInput 启动后执行。 */
  constructor(opts: QoderCliSessionInputOptions) {
    super({
      stateStore: opts.stateStore,
      sessionDir: opts.sessionDir ?? resolveHome(DEFAULT_SESSION_DIR),
      filePattern: opts.filePattern ?? '**/segments/*.jsonl',
      pollIntervalMs: opts.pollIntervalMs
        ?? (Number(process.env.QODER_ANALYTICS_POLL_INTERVAL) || 30_000),
    });
  }

  /** 返回 Qoder CLI session 根目录，供发现服务监听。 */
  static getWatchPaths(): string[] {
    return [resolveHome(DEFAULT_SESSION_DIR)];
  }

  /** 检查默认 session 目录是否存在。 */
  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome(DEFAULT_SESSION_DIR));
  }

  /**
   * 枚举启动时已有 segment，并把每个文件 offset 设置到当前大小，同时记录 inode 供轮转检测。
   */
  protected override async onStart(): Promise<void> {
    // BaseSessionInput 默认会从 0 读取新文件；这里显式 baseline 现有文件，避免重复采集安装前 usage。
    const files = await this.discoverSessionFiles();
    for (const filePath of files) {
      try {
        const stat = await fs.stat(filePath);
        const stateKey = this.stateKey(filePath);
        // offset 与 inode 分开保存：offset 用于增量读取，inode 用于识别同名文件是否已被替换。
        this.stateStore.setOffset(stateKey, stat.size);
        this.stateStore.update(stateKey, { extra: { inode: (stat as any).ino } });
      } catch {
        // Qoder 可能在 stat 前后轮转或删除 session 文件；忽略本次，后续发现周期会重新扫描。
      }
    }
  }

  /** 按 cwd/session/segments 三层结构发现 JSONL，并排序以获得稳定处理顺序。 */
  protected async discoverSessionFiles(): Promise<string[]> {
    const files: string[] = [];
    // 辅助函数会把结果原地追加到同一数组，避免每层递归创建和合并临时数组。
    await collectSegmentFiles(this.sessionDir, files);
    return files.sort();
  }

  /**
   * 将一条 model.response.completed 转为 token usage 事件；其他类型返回 null。
   * 文件路径提供 session/cwd key，event.id 由稳定源字段哈希得到，便于重试去重。
   */
  protected async processSessionLine(
    record: Record<string, unknown>,
    filePath: string,
  ): Promise<AgentActivityEntry | null> {
    // segment 还包含 request/tool/日志事件；本 Input 的职责仅是补齐 response token usage。
    if (record.type !== SUPPORTED_EVENT_TYPE) return null;

    // data 来自不可信 JSON，先收窄为普通对象，后续每个标量再分别校验类型。
    const data = asRecord(record.data);
    const sessionInfo = extractSessionInfo(filePath);
    const timestamp = parseTimestamp(record.ts);
    const inputTokens = finiteNumber(data.input_tokens);
    const outputTokens = finiteNumber(data.output_tokens);
    const cacheReadTokens = finiteNumber(data.cache_read_input_tokens);
    const cacheWriteTokens = finiteNumber(data.cache_creation_input_tokens);
    const model = stringValue(data.model) ?? UNKNOWN_MODEL;
    const responseId = stringValue(record.request_id);

    // segment 文件和原始序号放入 attributes，便于 token 对不上时定位源数据。
    const attributes: Record<string, JsonValue> = {
      source: SOURCE,
      'qoder.type': SUPPORTED_EVENT_TYPE,
      segment_file: filePath,
      segment_name: path.basename(filePath),
    };
    if (sessionInfo.cwdKey) attributes.cwd_key = sessionInfo.cwdKey;
    addIfPresent(attributes, 'seq', finiteNumber(record.seq));
    addIfPresent(attributes, 'level', stringValue(record.level));
    addIfPresent(attributes, 'request_id', responseId);
    addIfPresent(attributes, 'turn_id', stringValue(record.turn_id));
    addIfPresent(attributes, 'loop_id', stringValue(record.loop_id));
    addIfPresent(attributes, 'request_index', finiteNumber(data.request_index));
    addIfPresent(attributes, 'stop_reason', stringValue(data.stop_reason));
    addIfPresent(attributes, 'content_block_count', finiteNumber(data.content_block_count));

    // requestId 不一定存在，因此 event.id 还包含路径、seq、turn 和时间等稳定字段。
    return buildAgentActivityEntry({
      timestamp,
      time_unix_nano: timestampToUnixNanos(timestamp),
      'event.id': buildDeterministicEventId(filePath, record, responseId),
      'event.name': 'llm.response',
      'gen_ai.session.id': sessionInfo.sessionId,
      'gen_ai.agent.type': ClientType.QoderCli,
      'gen_ai.request.model': model,
      'gen_ai.response.model': model,
      'gen_ai.usage.input_tokens': inputTokens,
      'gen_ai.usage.output_tokens': outputTokens,
      'gen_ai.usage.cache_read.input_tokens': cacheReadTokens,
      'gen_ai.usage.cache_creation.input_tokens': cacheWriteTokens,
      // 输入/输出任一缺失时省略 total，避免把缺失字段按 0 计算。
      'gen_ai.usage.total_tokens': sumIfPresent(inputTokens, outputTokens),
      attributes,
    });
  }

  /** 为每个 segment 文件生成独立 StateStore key。 */
  private stateKey(filePath: string): string {
    return `${this.id}:${filePath}`;
  }
}

/** 按 Qoder 的 cwd/session 目录结构递归到 segments，并把发现结果追加到 files。 */
async function collectSegmentFiles(dir: string, files: string[]): Promise<void> {
  let cwdDirs: Dirent[];
  try {
    cwdDirs = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const cwdDir of cwdDirs) {
    // 根目录第一层是编码后的工作目录 key，普通文件与其他辅助项都不进入 session 扫描。
    if (!cwdDir.isDirectory()) continue;

    const cwdPath = path.join(dir, cwdDir.name);
    let sessionDirs: Dirent[];
    try {
      sessionDirs = await fs.readdir(cwdPath, { withFileTypes: true });
    } catch {
      continue;
    }

    // 第二层目录名就是 sessionId；每个 session 的数据只从固定 segments 子目录读取。
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue;
      await collectJsonlFilesInSegments(
        path.join(cwdPath, sessionDir.name, 'segments'),
        files,
      );
    }
  }
}

/** 收集单个 segments 目录中的 `.jsonl` 普通文件；目录不可读时按空目录处理。 */
async function collectJsonlFilesInSegments(dir: string, files: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(path.join(dir, entry.name));
    }
  }
}

/** 从 `<cwdKey>/<sessionId>/segments/<file>.jsonl` 路径反向取得 session 和 cwd key。 */
function extractSessionInfo(filePath: string): { sessionId: string; cwdKey: string } {
  const segmentsDir = path.dirname(filePath);
  const sessionDir = path.dirname(segmentsDir);
  const cwdDir = path.dirname(sessionDir);
  return {
    sessionId: path.basename(sessionDir),
    cwdKey: path.basename(cwdDir),
  };
}

/** 用文件、序号、请求和 turn 等稳定字段计算 SHA-256 event ID。 */
function buildDeterministicEventId(
  filePath: string,
  record: Record<string, unknown>,
  requestId: string | undefined,
): string {
  const data = asRecord(record.data);
  return crypto
    .createHash('sha256')
    .update([
      filePath,
      stableValue(record.seq),
      stringValue(record.type) ?? '',
      requestId ?? '',
      stableValue(record.ts),
      stringValue(record.turn_id) ?? '',
      stringValue(record.loop_id) ?? '',
      stableValue(data.request_index),
    ].join('\0'))
    .digest('hex');
}

/** 兼容 number、数字字符串和日期字符串；全部无效时使用当前时间。 */
function parseTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return Date.now();

  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/** 把普通对象原样返回，其余值转换为空对象。 */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** 只接受非空字符串。 */
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 将可用于稳定 ID 的字符串或有限数字转为字符串，其他值退回空串。 */
function stableValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** 仅保留有限 number。 */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 两个 token 分项均存在时才生成总数。 */
function sumIfPresent(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined || right === undefined) return undefined;
  return left + right;
}

/** 只在值不为 undefined 时写入 attributes，避免输出无意义空字段。 */
function addIfPresent(
  target: Record<string, JsonValue>,
  key: string,
  value: JsonValue | undefined,
): void {
  if (value !== undefined) target[key] = value;
}
