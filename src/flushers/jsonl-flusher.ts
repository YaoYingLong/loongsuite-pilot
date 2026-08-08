/**
 * 本地 JSONL 输出通道。
 *
 * 每条标准事件序列化后立即追加到 `<agent>-<date>.jsonl`，没有内存批量缓冲。appendLine 是
 * best-effort 文件 API，因此磁盘错误不会抛回采集链；本地输出主要用于验证和离线诊断。
 */

import * as path from 'node:path';
import { BaseFlusher } from './base-flusher.js';
import { serialiseLogEntry } from '../normalization/entry-builder.js';
import type { AgentActivityEntry, JsonlFlusherConfig } from '../types/index.js';
import { appendLine, ensureDir, getTodayDateString } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('JsonlFlusher');

/**
 * 按 Agent 和日期分文件的 JSONL Flusher。
 *
 * 本类不保持打开的文件句柄；每次 send 通过 `appendLine()` 打开/追加/关闭，简单但吞吐取决于
 * 文件系统。appendLine/ensureDir 是 best-effort，Promise 正常兑现不代表该行一定落盘。
 */
export class JsonlFlusher extends BaseFlusher {
  readonly name = 'jsonl';
  private readonly config: JsonlFlusherConfig;

  /** @param config 输出目录与是否按本地日历日期轮转；构造阶段不访问文件系统。 */
  constructor(config: JsonlFlusherConfig) {
    super();
    this.config = config;
  }

  /** 启动时尽力递归创建输出目录。 */
  async start(): Promise<void> {
    // 对应的输出目录不存在就直接递归创建
    await ensureDir(this.config.outputDir);
  }

  /**
   * 序列化单条事件并追加一行，默认过滤 Agent 私有命名空间字段。
   * Agent 类型直接进入文件名，依赖上游类型值已规范化；当前方法不再额外清理路径字符。
   */
  async send(entry: AgentActivityEntry): Promise<void> {
    const agentType = entry['gen_ai.agent.type'] ?? entry['agent.type'] ?? 'unknown';
    const filePath = this.resolveFilePath(agentType);
    const serialized = serialiseLogEntry(entry, { dropAgentScopedFields: true });
    const line = JSON.stringify(serialized);
    // 将数据写入对那个的${agentType}-${dateStr}.jsonl文件中
    await appendLine(filePath, line);
  }

  /** 逐条 await 写入，保持同一批事件在文件中的顺序。 */
  async sendBatch(entries: AgentActivityEntry[]): Promise<void> {
    for (const entry of entries) {
      // 循环批量写文件
      await this.send(entry);
    }
  }

  /** 该实现没有内存缓冲，所有 send 已立即尝试 append，因此 flush 立即完成。 */
  async flush(): Promise<void> {
    // 每条 send 已立即 append，没有需要提交的内存缓冲。
  }

  /** 本类不持有 timer、连接或长生命周期文件句柄，shutdown 立即完成。 */
  async shutdown(): Promise<void> {
    // 本类不持有长连接、文件句柄或定时器，无需额外释放。
  }

  /** 把原始 topic payload 写入独立日期文件，并附加观察时间。 */
  override async sendRaw(topic: string, payload: Record<string, unknown>): Promise<void> {
    const filePath = path.join(this.config.outputDir, `${topic}-${getTodayDateString()}.jsonl`);
    const line = JSON.stringify({ logTime: new Date().toISOString(), topic, ...payload });
    await appendLine(filePath, line);
  }

  /** 根据 rotateDaily 选择日期或固定 `all` 后缀并构造跨平台路径。 */
  private resolveFilePath(agentType: string): string {
    const dateStr = this.config.rotateDaily ? getTodayDateString() : 'all';
    return path.join(this.config.outputDir, `${agentType}-${dateStr}.jsonl`);
  }
}
