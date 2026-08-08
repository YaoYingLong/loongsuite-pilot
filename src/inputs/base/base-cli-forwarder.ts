/**
 * CLI 原始 telemetry 文件转发基类。
 *
 * CLI 工具写原始日志，本类按 byte offset 读取新增 JSON 行，筛选后先写每日 history JSONL，
 * 再让子类转换成 AgentActivityEntry。offset 在解析前推进，畸形行被跳过而不会永久重试。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseInput, type InputOptions } from './base-input.js';
import { ensureDir, appendLine, getTodayDateString } from '../../utils/fs-utils.js';

export interface CliForwarderOptions extends InputOptions {
  /** CLI 工具写入的原始 telemetry 文件。 */
  rawTelemetryPath: string;
  /** 筛选后 history JSONL 目录。 */
  historyDir: string;
  /** history 文件前缀。 */
  historyPrefix: string;
  /** 原始文件轮询周期，默认 5 秒。 */
  forwarderPollMs?: number;
}

/**
 * CLI telemetry 的“读取 -> 筛选 -> history -> 标准事件”抽象流程。
 */
export abstract class BaseCliForwarder extends BaseInput {
  readonly collectionMethod = CollectionMethod.CliTelemetryForwarding;

  protected readonly rawTelemetryPath: string;
  protected readonly historyDir: string;
  protected readonly historyPrefix: string;

  /** 保存路径并把 BaseInput 默认轮询覆盖为 forwarderPollMs/5 秒。 */
  constructor(opts: CliForwarderOptions) {
    super(opts);
    this.rawTelemetryPath = opts.rawTelemetryPath;
    this.historyDir = opts.historyDir;
    this.historyPrefix = opts.historyPrefix;
    this.pollIntervalMs = opts.forwarderPollMs ?? 5_000;
  }

  /** 启动前创建 history 目录。 */
  protected override async onStart(): Promise<void> {
    await ensureDir(this.historyDir);
  }

  /** 转发新增原始记录，再逐条隔离转换错误。 */
  protected async collect(): Promise<AgentActivityEntry[]> {
    const newRecords = await this.forwardNewTelemetry();
    const entries: AgentActivityEntry[] = [];

    for (const record of newRecords) {
      try {
        const entry = await this.transformPayload(record);
        if (entry) entries.push(entry);
      } catch (err) {
        this.logger.warn('transformPayload failed', { error: String(err) });
      }
    }
    return entries;
  }

  /** 按当前文件 size 读取 offset 之后的全部字节，筛选并追加 history。 */
  private async forwardNewTelemetry(): Promise<Record<string, unknown>[]> {
    let stat;
    try {
      stat = await fs.stat(this.rawTelemetryPath);
    } catch {
      return [];
    }

    const offsetKey = `${this.id}:raw`;
    const offset = this.stateStore.getOffset(offsetKey);
    if (stat.size <= offset) return [];

    const handle = await fs.open(this.rawTelemetryPath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - offset);
      await handle.read(buf, 0, buf.length, offset);
      const text = buf.toString('utf-8');
      // offset 先更新到 stat.size；BaseInput 周期末统一保存 StateStore。
      this.stateStore.setOffset(offsetKey, stat.size);

      const records: Record<string, unknown>[] = [];
      const jsonObjects = this.extractJsonObjects(text);

      for (const obj of jsonObjects) {
        if (!this.isRelevantEvent(obj)) continue;

        const historyFile = path.join(
          this.historyDir,
          `${this.historyPrefix}-${getTodayDateString()}.jsonl`,
        );
        await appendLine(historyFile, JSON.stringify(obj));
        records.push(obj);
      }
      return records;
    } finally {
      await handle.close();
    }
  }

  /** 从逐行文本中提取以 `{` 开头的合法 JSON 对象。 */
  private extractJsonObjects(text: string): Record<string, unknown>[] {
    const results: Record<string, unknown>[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) continue;
      try {
        results.push(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        // 畸形行已被 offset 跨过，避免一条坏数据卡住整个转发器。
      }
    }
    return results;
  }

  /** 判断原始事件是否属于本 Input 关心的类型。 */
  protected abstract isRelevantEvent(event: Record<string, unknown>): boolean;

  /** 把已写入 history 的事件转为标准 AgentActivityEntry。 */
  protected abstract transformPayload(
    event: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null>;
}
