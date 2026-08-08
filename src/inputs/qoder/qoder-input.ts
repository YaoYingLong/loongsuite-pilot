/** Qoder IDE history 快照 Input：扫描本地历史，借助 BaseIdeInput/SnapshotStore 去重并归一化。 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClientType, ActionType } from '../../types/index.js';
import type { AgentActivityEntry, CodeGenerationEvent } from '../../types/index.js';
import { BaseIdeInput, type IdeInputOptions } from '../base/base-ide-input.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { resolveHome } from '../../utils/fs-utils.js';

const DEFAULT_QODER_ROOT_MAC = '~/Library/Application Support/Qoder';
const DEFAULT_QODER_ROOT_LINUX = '~/.config/Qoder';

/** 按 macOS、Windows、Linux/XDG 约定解析 Qoder IDE 的本地数据根目录。 */
function resolveQoderRoot(): string {
  if (process.platform === 'darwin') {
    return resolveHome(DEFAULT_QODER_ROOT_MAC);
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Qoder');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'Qoder');
  return resolveHome(DEFAULT_QODER_ROOT_LINUX);
}

/**
 * Qoder IDE 的历史快照备用采集器。
 *
 * 数据源一是 `User/History` 下 VS Code 风格的文件编辑快照；数据源二是
 * `SharedClientCache/cache/ai_tracker` 下的 Agent 活动 JSONL。BaseIdeInput 负责定时轮询、
 * SnapshotStore 去重和统一发出事件，本类只负责 Qoder 路径、解析和标准 Entry 构建。
 */
export class QoderInput extends BaseIdeInput {
  readonly id = 'qoder';
  readonly agentType = ClientType.Qoder;

  /** 保存状态存储、数据目录、快照文件和轮询间隔；实际文件访问发生在启动后的采集周期。 */
  constructor(opts?: Partial<IdeInputOptions> & { stateStore: IdeInputOptions['stateStore'] }) {
    const dataRoot = opts?.dataRoot ?? resolveQoderRoot();
    super({
      stateStore: opts!.stateStore,
      dataRoot,
      snapshotStorePath: opts?.snapshotStorePath
        ?? resolveHome('~/.loongsuite-pilot/logs/qoder/qoder-snapshot-store.json'),
      pollIntervalMs: opts?.pollIntervalMs
        ?? (Number(process.env.QODER_ANALYTICS_POLL_INTERVAL) || 30_000),
      snapshotRetentionMs: opts?.snapshotRetentionMs,
    });
  }

  /** 返回根目录及其父目录，让目录尚未创建时发现服务也能观察到后续安装。 */
  static getWatchPaths(): string[] {
    const root = resolveQoderRoot();
    const parent = path.dirname(root);
    return [parent, root];
  }

  /** 检查 Qoder 数据目录是否可访问；不存在或无权限时返回 false。 */
  static async checkAvailability(): Promise<boolean> {
    try {
      await fs.access(resolveQoderRoot());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 汇总两个来源中时间不早于 `sinceTs` 的候选事件；单个来源不存在时按空结果处理。
   */
  protected async scanHistoryEntries(sinceTs: number): Promise<CodeGenerationEvent[]> {
    const events: CodeGenerationEvent[] = [];

    // 来源一：VS Code 风格的文件编辑历史。
    await this.scanFileHistory(events, sinceTs);

    // 来源二：ai_tracker 追加式 JSONL 中的 Agent 活动。
    await this.scanAiTracker(events, sinceTs);

    return events;
  }

  /** 扫描每个 History 子目录的 entries.json，只保留来源名称明确指向 AI 的编辑。 */
  private async scanFileHistory(events: CodeGenerationEvent[], sinceTs: number): Promise<void> {
    // Qoder 复用 VS Code 的 History 布局：每个随机子目录用 entries.json 描述同一资源的版本列表。
    const historyRoot = path.join(this.dataRoot, 'User', 'History');

    let dirs: string[];
    try {
      dirs = await fs.readdir(historyRoot);
    } catch {
      return;
    }

    // 单个目录损坏不应阻断其他文件的历史扫描，因此异常边界放在循环内部。
    for (const dir of dirs) {
      const entriesFile = path.join(historyRoot, dir, 'entries.json');
      try {
        const raw = await fs.readFile(entriesFile, 'utf-8');
        const data = JSON.parse(raw) as {
          resource?: string;
          entries?: Array<{ id?: string; timestamp?: number; source?: string }>;
        };
        // resource 是被编辑文件，entries 是版本索引；两者缺一都无法构造有意义事件。
        if (!data.entries || !data.resource) continue;

        for (const entry of data.entries) {
          const ts = entry.timestamp ?? 0;
          // BaseIdeInput 已根据 SnapshotStore 计算查询窗口，这里再次按源时间快速裁剪旧版本。
          if (ts < sinceTs) continue;

          const source = entry.source?.toLowerCase() ?? '';
          // History 同时包含人工保存和扩展编辑，只接受来源名称明确指向 AI 的版本。
          const isAI = /qoder|ai|agent|copilot|assistant|completion/.test(source);
          if (!isAI) continue;

          events.push({
            agentType: ClientType.Qoder,
            filePath: data.resource,
            actionType: ActionType.Edit,
            sourceTimestamp: ts,
            rawData: {
              historyDir: dir,
              entryId: entry.id,
              source: entry.source,
              toolName: 'qoder-history',
            },
          });
        }
      } catch { /* 单个历史目录损坏时跳过，不影响其他目录。 */ }
    }
  }

  /**
   * 按文件 offset 增量读取 ai_tracker JSONL，并把 offset 写入 StateStore。
   * 文件句柄在 finally 中关闭；坏行被跳过，文件级 I/O 错误会记录警告。
   */
  private async scanAiTracker(events: CodeGenerationEvent[], sinceTs: number): Promise<void> {
    // ai_tracker 是追加写 JSONL；与快照 History 不同，它按文件字节 offset 增量消费。
    const trackerDir = path.join(this.dataRoot, 'SharedClientCache', 'cache', 'ai_tracker');

    let files: string[];
    try {
      files = await fs.readdir(trackerDir);
    } catch {
      return;
    }

    for (const file of files.filter(f => f.endsWith('.jsonl'))) {
      const filePath = path.join(trackerDir, file);
      // 每个 tracker 文件使用独立 key，避免多个文件共享 offset 后互相跳过数据。
      const stateKey = `qoder-tracker:${file}`;
      let offset: number;
      try {
        const stat = await fs.stat(filePath);
        const prev = this.stateStore.get(stateKey);
        offset = prev.lastOffset ?? 0;
        // 文件没有增长时无需打开。注意当前实现不主动识别同名文件截断，依赖轮转产生新文件名。
        if (stat.size <= offset) continue;

        const handle = await fs.open(filePath, 'r');
        try {
          // 只分配 offset 之后的字节，避免每天重复读取整个 tracker 文件。
          const buf = Buffer.alloc(stat.size - offset);
          await handle.read(buf, 0, buf.length, offset);
          const text = buf.toString('utf-8');
          // 读取成功后先记录本次文件尾；单行 JSON 损坏仍会被消费，防止坏行永久卡住采集。
          this.stateStore.update(stateKey, { lastOffset: stat.size });

          for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
              const record = JSON.parse(line) as Record<string, unknown>;
              const fp = record.filePath as string ?? '';
              const aiAddedLines = record.aiAddedLines as string[] ?? [];
              const aiDeletedLines = record.aiDeletedLines as string[] ?? [];
              const modifiedContent = record.aiModifiedContent as string ?? '';

              // tracker 没有可靠事件时间，沿用当前采集时间；正文最多保留 2000 字符控制事件体积。
              events.push({
                agentType: ClientType.Qoder,
                filePath: fp,
                actionType: ActionType.Edit,
                sourceTimestamp: Date.now(),
                content: modifiedContent.slice(0, 2000),
                rawData: {
                  toolName: 'qoder-ai-tracker',
                  trackerFile: file,
                  aiAddedLines,
                  aiDeletedLines,
                },
              });
            } catch { /* 跳过损坏 JSONL 行，后续完整行仍可继续采集。 */ }
          }
        } finally {
          await handle.close();
        }
      } catch (err) {
        this.logger.warn('failed to scan ai_tracker file', { file, error: String(err) });
      }
    }
  }

  /** 将中间 CodeGenerationEvent 交给统一 EntryBuilder，补齐标准字段和时间格式。 */
  protected async buildEntry(event: CodeGenerationEvent): Promise<AgentActivityEntry | null> {
    // History entryId 是可用的次级 session 标识；两个来源都缺失时保留空串，由下游按无会话处理。
    return buildAgentActivityEntry({
      sessionId: (event.rawData.sessionId as string)
        ?? (event.rawData.entryId as string)
        ?? '',
      userId: '',
      agentType: ClientType.Qoder,
      actionType: event.actionType,
      filePath: event.filePath,
      content: event.content,
      inlineDiffMessage: event.diff,
      timestamp: event.sourceTimestamp,
      extra: event.rawData,
    });
  }
}
