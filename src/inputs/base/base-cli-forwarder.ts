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

  /**
   * 保存路径并把 BaseInput 默认轮询覆盖为 `forwarderPollMs` 或 5 秒。
   *
   * `super(opts)` 会先采用通用 pollIntervalMs，但本类随后明确覆盖；构造阶段不 stat 原始文件，
   * 也不创建 history 目录。
   */
  constructor(opts: CliForwarderOptions) {
    super(opts);
    this.rawTelemetryPath = opts.rawTelemetryPath;
    this.historyDir = opts.historyDir;
    this.historyPrefix = opts.historyPrefix;
    this.pollIntervalMs = opts.forwarderPollMs ?? 5_000;
  }

  /**
   * 启动首轮采集前递归创建 history 目录。
   * `ensureDir` 是 best-effort；失败被工具函数吞掉，后续 appendLine 仍可能静默写入失败。
   */
  protected override async onStart(): Promise<void> {
    await ensureDir(this.historyDir);
  }

  /**
   * 先把新增且相关的原始记录追加到 history，再逐条转换为标准事件。
   *
   * `transformPayload()` 串行执行，保证返回顺序与原文件一致；一条转换异常只记录告警，其他记录
   * 继续。由于 offset 已在 forward 阶段推进，转换失败记录不会在下轮自动重试。
   */
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

  /**
   * 按本轮 `stat.size` 读取 offset 之后的全部字节，筛选并追加每日 history。
   *
   * 读取边界固定后，并发追加留到下一轮。句柄在 finally 中关闭。当前实现没有保存 inode，也
   * 没有在 `stat.size < offset` 时显式重置；原始 telemetry 若会 truncate/rename，恢复行为待
   * 对应 CLI writer 契约确认。
   *
   * offset 在解析和 history 写入前先更新内存；`appendLine` 采用 best-effort 且吞写入错误，
   * 所以 history 是辅助副本，不是可靠队列。
   */
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

  /**
   * 从逐行文本中提取以 `{` 开头的合法 JSON 对象。
   *
   * 空行、非对象前缀和 JSON.parse 失败都跳过。方法没有半行缓存：本轮末尾尚未写完的 JSON 会
   * 因 offset 已推进而永久跳过，因此依赖上游以完整行方式追加。
   */
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

  /**
   * 判断原始事件是否属于本 Input 关心的类型。
   * @returns false 时既不写 history，也不调用 transformPayload。
   */
  protected abstract isRelevantEvent(event: Record<string, unknown>): boolean;

  /**
   * 把已尝试写入 history 的事件转为标准 AgentActivityEntry。
   * @returns 标准事件；null 表示主动忽略。
   * @throws 单条异常由 collect 捕获，offset 不回退。
   */
  protected abstract transformPayload(
    event: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null>;
}
