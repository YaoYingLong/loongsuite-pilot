/**
 * Cursor IDE/CLI Hook canonical JSONL Input。
 *
 * 同一日志目录可能包含 Cursor IDE 和 Cursor CLI；本类根据显式 agent type 或日期式 CLI 版本号
 * 区分，并按对应 Git namespace enrich。首次无 offset 时 baseline 当天已有历史，防止 daemon
 * 重启重放旧 Trace；Stop 记录的 token/cost 会被删除，避免与响应事件重复计算。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';
import { getTodayDateString, resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { buildCanonicalHookEntry } from '../base/canonical-hook-record.js';

/** Cursor CLI 当前版本形如 YYYY.MM.DD；用于无显式类型的兼容推断。 */
const CLI_VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}/;

/** 按显式类型、版本特征、默认 IDE 的优先级判断 Cursor 变体。 */
function inferCursorVariant(record: Record<string, unknown>): ClientType.Cursor | ClientType.CursorCli {
  const explicitType = record['gen_ai.agent.type'];
  if (explicitType === 'cursor-cli') return ClientType.CursorCli;
  const version = record['agent.cursor.cursor_version'] ?? record['cursor_version'];
  if (typeof version === 'string' && CLI_VERSION_PATTERN.test(version)) return ClientType.CursorCli;
  return ClientType.Cursor;
}

/** 读取 record 中的非空字符串。 */
function getStringValue(data: Record<string, unknown>, key: string): string | undefined {
  const val = data[key];
  return typeof val === 'string' && val.length > 0 ? val : undefined;
}

/** Cursor Hook 日志采集器。 */
export class CursorHookInput extends BaseHookInput {
  readonly id = 'cursor-hook';
  readonly agentType = ClientType.Cursor;
  private lastAgentVersion = '';

  /** 返回最近记录观察到的 Cursor 版本，供发现/指标层使用。 */
  getAgentVersion(): string {
    return this.lastAgentVersion;
  }

  /** 使用 `logs/cursor/history` 和 cursor 日文件前缀。 */
  constructor(opts?: Partial<HookInputOptions> & { stateStore: HookInputOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      logDir: opts?.logDir ?? resolveHome('~/.loongsuite-pilot/logs/cursor/history'),
      logPrefix: opts?.logPrefix ?? 'cursor',
      pollIntervalMs: opts?.pollIntervalMs ?? 30_000,
    });
  }
  /** 日志 history 目录存在时可启动。 */
  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.loongsuite-pilot/logs/cursor/history'));
  }
  /** 动态发现监听路径。 */
  static getWatchPaths(): string[] {
    return [resolveHome('~/.loongsuite-pilot/logs/cursor/history')];
  }
  /** 构建 canonical entry、区分 IDE/CLI、清 Stop token 并 enrich Git。 */
  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    const ver = record['agent.cursor.cursor_version'];
    if (typeof ver === 'string' && ver) this.lastAgentVersion = ver;

    const payload = getPayload(record);
    const hookEvent = getHookEvent(record, payload);
    const canonicalEntry = buildCanonicalHookEntry(
      record,
      ClientType.Cursor,
      buildAttributes(record, payload, hookEvent),
    );
    if (!canonicalEntry) return null;

    const variant = inferCursorVariant(record);
    if (variant === ClientType.CursorCli) {
      canonicalEntry['gen_ai.agent.type'] = ClientType.CursorCli;
    }
    if (hookEvent.toLowerCase() === 'stop') {
      stripTokenFields(canonicalEntry);
    }
    const gitNamespace = variant === ClientType.CursorCli ? 'cursor_cli' : 'cursor';
    await enrichCanonicalEntryWithGit(canonicalEntry, record, gitNamespace);
    return canonicalEntry;
  }

  /**
   * 首次无 offset 时把当天现有文件 baseline 到末尾，只消费启动后追加内容。
   * 即使文件尚不存在也写 offset 0，避免下一轮文件刚出现时误把首批当历史跳过。
   */
  protected override async collect(): Promise<AgentActivityEntry[]> {
    const state = this.getState();
    const today = getTodayDateString();
    const logFileName = `${this.logPrefix}-${today}.jsonl`;

    if (!state.lastFile) {
      const logFile = path.join(this.logDir, logFileName);
      try {
        const stat = await fs.stat(logFile);
        if (stat.size > 0) {
          this.setState({ lastFile: logFileName, lastOffset: stat.size });
          this.logger.info('first-run guard: skipping existing history', {
            file: logFileName,
            skippedBytes: stat.size,
          });
        } else {
          // 空文件也标记 guard 完成，没有历史需要跳过。
          this.setState({ lastFile: logFileName, lastOffset: 0 });
        }
      } catch {
        // 文件尚不存在仍记录 offset 0；下轮走基类正常采集，不会跳过刚写入的首条记录。
        this.setState({ lastFile: logFileName, lastOffset: 0 });
      }
    }

    return super.collect();
  }
}

/** 兼容 processor 把原 payload 放在 data 下或直接写顶层。 */
function getPayload(record: Record<string, unknown>): Record<string, unknown> {
  if (record.data && typeof record.data === 'object' && !Array.isArray(record.data)) {
    return record.data as Record<string, unknown>;
  }
  return record;
}

/** 按多版本字段优先级取得 Hook 事件名。 */
function getHookEvent(record: Record<string, unknown>, payload: Record<string, unknown>): string {
  return getStringValue(record, 'hookEvent')
    ?? getStringValue(payload, 'hook_event_name')
    ?? getStringValue(payload, 'hookEventName')
    ?? getStringValue(payload, 'hookEvent')
    ?? getStringValue(record, 'agent.cursor.hook_event_name')
    ?? 'unknown';
}

/** 从 Hook payload 白名单构建 Agent 扩展属性。 */
function buildAttributes(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
  hookEvent: string,
): { [key: string]: JsonValue } {
  // 只复制已知、对诊断有价值的 Cursor 字段；toJsonObject 会过滤 undefined 和不可 JSON 化值。
  return toJsonObject({
    // hook_event_name 是规范后的事件来源，后续字段保留 Cursor 原始运行上下文。
    'cursor.hook_event_name': hookEvent,
    user_email: payload.user_email,
    cursor_version: payload.cursor_version,
    workspace_roots: payload.workspace_roots,
    transcript_path: payload.transcript_path,
    cwd: payload.cwd,
    // command/sandbox 描述工具执行环境，composer_mode/attachments 描述交互形态。
    command: payload.command,
    sandbox: payload.sandbox,
    composer_mode: payload.composer_mode,
    attachments: payload.attachments,
    // status/loop_count 主要用于 Stop 与 Agent 循环诊断，不提升为跨 Agent 公共字段。
    status: payload.status,
    loop_count: payload.loop_count,
  });
}

/** Stop 事件不得重复携带的 token/cost canonical keys。 */
const TOKEN_COST_KEYS = [
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.cache_read.input_tokens',
  'gen_ai.usage.cache_creation.input_tokens',
  'gen_ai.usage.total_tokens',
  'gen_ai.usage.input_cost',
  'gen_ai.usage.output_cost',
  'gen_ai.usage.cache_read.input_cost',
  'gen_ai.usage.cache_creation.input_cost',
  'gen_ai.usage.total_cost',
] as const;

/** 原地删除 Stop 事件 token/cost，保留实际 llm.response 的 usage。 */
function stripTokenFields(entry: AgentActivityEntry): void {
  for (const key of TOKEN_COST_KEYS) {
    delete (entry as Record<string, unknown>)[key];
  }
}

/** 把 unknown object 递归转换成 JSON 安全属性。 */
function toJsonObject(value: Record<string, unknown>): { [key: string]: JsonValue } {
  const out: { [key: string]: JsonValue } = {};
  for (const [key, raw] of Object.entries(value)) {
    const json = toJsonValue(raw);
    if (json !== undefined) out[key] = json;
  }
  return out;
}

/** 递归转换 JSON 值；undefined 删除，非 JSON 类型 String 化。 */
function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map(item => toJsonValue(item))
      .filter((item): item is JsonValue => item !== undefined);
  }
  if (typeof value === 'object') return toJsonObject(value as Record<string, unknown>);
  return String(value);
}
