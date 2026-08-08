/** Qoder CN IDE history 快照 Input，路径/ClientType 与国际版隔离，生命周期复用 BaseIdeInput。 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClientType, ActionType } from '../../types/index.js';
import type { AgentActivityEntry, CodeGenerationEvent } from '../../types/index.js';
import { BaseIdeInput, type IdeInputOptions } from '../base/base-ide-input.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { resolveHome } from '../../utils/fs-utils.js';

const DEFAULT_QODER_CN_ROOT_MAC = '~/Library/Application Support/QoderCN';
const DEFAULT_QODER_CN_ROOT_LINUX = '~/.config/QoderCN';

/** 按 macOS、Windows、Linux/XDG 约定解析 Qoder CN 的本地数据根目录。 */
function resolveQoderCnRoot(): string {
  if (process.platform === 'darwin') {
    return resolveHome(DEFAULT_QODER_CN_ROOT_MAC);
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'QoderCN');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'QoderCN');
  return resolveHome(DEFAULT_QODER_CN_ROOT_LINUX);
}

/**
 * Qoder CN IDE 的历史快照备用采集器。
 *
 * 数据源是 `User/History` 的 VS Code 风格编辑快照和 `SharedClientCache/cache/ai_tracker`
 * 的 Agent 活动 JSONL。生命周期、去重和事件发送复用 BaseIdeInput；状态和 ClientType 与国际版隔离。
 */
export class QoderCnInput extends BaseIdeInput {
  readonly id = 'qoder-cn';
  readonly agentType = ClientType.QoderCn;

  /** 保存 CN 数据目录、快照状态文件和轮询间隔；构造阶段不访问磁盘。 */
  constructor(opts?: Partial<IdeInputOptions> & { stateStore: IdeInputOptions['stateStore'] }) {
    const dataRoot = opts?.dataRoot ?? resolveQoderCnRoot();
    super({
      stateStore: opts!.stateStore,
      dataRoot,
      snapshotStorePath: opts?.snapshotStorePath
        ?? resolveHome('~/.loongsuite-pilot/logs/qoder-cn/qoder-cn-snapshot-store.json'),
      pollIntervalMs: opts?.pollIntervalMs
        ?? (Number(process.env.QODER_CN_ANALYTICS_POLL_INTERVAL) || 30_000),
      snapshotRetentionMs: opts?.snapshotRetentionMs,
    });
  }

  /** 返回 CN 根目录及父目录，供 Agent 发现服务监听安装和目录创建。 */
  static getWatchPaths(): string[] {
    const root = resolveQoderCnRoot();
    const parent = path.dirname(root);
    return [parent, root];
  }

  /** 检查默认 CN 数据目录是否可访问，普通文件系统错误转换为 false。 */
  static async checkAvailability(): Promise<boolean> {
    try {
      await fs.access(resolveQoderCnRoot());
      return true;
    } catch {
      return false;
    }
  }

  /** 顺序合并历史快照与 ai_tracker 中不早于 sinceTs 的候选事件。 */
  protected async scanHistoryEntries(sinceTs: number): Promise<CodeGenerationEvent[]> {
    const events: CodeGenerationEvent[] = [];

    await this.scanFileHistory(events, sinceTs);
    await this.scanAiTracker(events, sinceTs);

    return events;
  }

  /** 扫描 History 子目录并筛出 source 名称可确认由 AI 产生的编辑记录。 */
  private async scanFileHistory(events: CodeGenerationEvent[], sinceTs: number): Promise<void> {
    // Qoder CN 与国际版使用相同的 VS Code History 结构，但数据根目录和状态完全隔离。
    const historyRoot = path.join(this.dataRoot, 'User', 'History');

    let dirs: string[];
    try {
      dirs = await fs.readdir(historyRoot);
    } catch {
      return;
    }

    // 每个 History 子目录独立解析，单目录损坏不会终止整个采集周期。
    for (const dir of dirs) {
      const entriesFile = path.join(historyRoot, dir, 'entries.json');
      try {
        const raw = await fs.readFile(entriesFile, 'utf-8');
        const data = JSON.parse(raw) as {
          resource?: string;
          entries?: Array<{ id?: string; timestamp?: number; source?: string }>;
        };
        // 缺少目标资源或版本列表时无法判断编辑对象，直接跳过。
        if (!data.entries || !data.resource) continue;

        for (const entry of data.entries) {
          const ts = entry.timestamp ?? 0;
          // 只保留 BaseIdeInput 查询窗口内的版本，减少 SnapshotStore 后续去重成本。
          if (ts < sinceTs) continue;

          const source = entry.source?.toLowerCase() ?? '';
          // 排除人工编辑历史，只接受来源名称明确包含 AI/Agent 语义的版本。
          const isAI = /qoder|ai|agent|copilot|assistant|completion/.test(source);
          if (!isAI) continue;

          events.push({
            agentType: ClientType.QoderCn,
            filePath: data.resource,
            actionType: ActionType.Edit,
            sourceTimestamp: ts,
            rawData: {
              historyDir: dir,
              entryId: entry.id,
              source: entry.source,
              toolName: 'qoder-cn-history',
            },
          });
        }
      } catch { /* 单个 entries.json 损坏时跳过，避免中断完整轮询。 */ }
    }
  }

  /** 按 StateStore offset 增量读取 CN ai_tracker JSONL，坏行跳过且句柄始终关闭。 */
  private async scanAiTracker(events: CodeGenerationEvent[], sinceTs: number): Promise<void> {
    // ai_tracker 是追加式 JSONL，使用 StateStore offset 而不是按时间遍历全部历史。
    const trackerDir = path.join(this.dataRoot, 'SharedClientCache', 'cache', 'ai_tracker');

    let files: string[];
    try {
      files = await fs.readdir(trackerDir);
    } catch {
      return;
    }

    for (const file of files.filter(f => f.endsWith('.jsonl'))) {
      const filePath = path.join(trackerDir, file);
      // CN 使用独立前缀，避免与国际版同名 tracker 文件共享状态。
      const stateKey = `qoder-cn-tracker:${file}`;
      let offset: number;
      try {
        const stat = await fs.stat(filePath);
        const prev = this.stateStore.get(stateKey);
        offset = prev.lastOffset ?? 0;
        // 未增长时跳过；同名文件截断不会在此重置，当前依赖轮转使用新文件名建立新状态。
        if (stat.size <= offset) continue;

        const handle = await fs.open(filePath, 'r');
        try {
          // 从上次文件尾读取到本次 stat.size，finally 确保异常时也关闭句柄。
          const buf = Buffer.alloc(stat.size - offset);
          await handle.read(buf, 0, buf.length, offset);
          const text = buf.toString('utf-8');
          // 完整读取后推进 offset；坏 JSON 行随后被单独跳过，不在下周期反复重试。
          this.stateStore.update(stateKey, { lastOffset: stat.size });

          for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
              const record = JSON.parse(line) as Record<string, unknown>;
              const fp = record.filePath as string ?? '';
              const aiAddedLines = record.aiAddedLines as string[] ?? [];
              const aiDeletedLines = record.aiDeletedLines as string[] ?? [];
              const modifiedContent = record.aiModifiedContent as string ?? '';

              // CN tracker 有时提供源时间；类型不可靠时才回退到当前采集时间。
              const recordTs = typeof record.timestamp === 'number' ? record.timestamp : Date.now();

              // 正文截断为 2000 字符，added/deleted 行列表仍放在 rawData 供诊断。
              events.push({
                agentType: ClientType.QoderCn,
                filePath: fp,
                actionType: ActionType.Edit,
                sourceTimestamp: recordTs,
                content: modifiedContent.slice(0, 2000),
                rawData: {
                  toolName: 'qoder-cn-ai-tracker',
                  trackerFile: file,
                  aiAddedLines,
                  aiDeletedLines,
                },
              });
            } catch { /* 跳过损坏 JSONL 行，继续处理同文件的后续记录。 */ }
          }
        } finally {
          await handle.close();
        }
      } catch (err) {
        this.logger.warn('failed to scan ai_tracker file', { file, error: String(err) });
      }
    }
  }

  /** 使用统一 EntryBuilder 把 CN 中间事件转换为 AgentActivityEntry。 */
  protected async buildEntry(event: CodeGenerationEvent): Promise<AgentActivityEntry | null> {
    // 优先使用来源显式 sessionId，再退回 History entryId；空值不在这里猜测生成。
    return buildAgentActivityEntry({
      sessionId: (event.rawData.sessionId as string)
        ?? (event.rawData.entryId as string)
        ?? '',
      userId: '',
      agentType: ClientType.QoderCn,
      actionType: event.actionType,
      filePath: event.filePath,
      content: event.content,
      inlineDiffMessage: event.diff,
      timestamp: event.sourceTimestamp,
      extra: event.rawData,
    });
  }
}
