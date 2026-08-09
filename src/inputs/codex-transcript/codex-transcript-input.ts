/**
 * 当前 Codex 生产主链的统一 rollout transcript Input。
 *
 * Stop Hook 只写 wakeup marker；本类递归发现 `~/.codex/sessions` 各层目录中的 rollout JSONL，在首次
 * 启动 baseline 已有历史，运行中按 byte offset 恢复 active turn，调用 Extractor/Builder 生成
 * 增量标准事件。terminal 解析失败会保存 pendingTerminal 并阻塞后续 turn，优先保证不静默丢失。
 */
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Dirent, FSWatcher } from 'node:fs';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import {
  buildCodexTranscriptSegment,
  nextInputMessagesForStep,
} from './codex-transcript-builder.js';
import {
  extractCodexPartialTurn,
  extractCodexPartialTurnWithBoundaries,
  extractCodexTranscriptMeta,
  sessionIdFromTranscriptPath,
} from './codex-transcript-extractor.js';
import {
  MAX_EMITTED_TERMINAL_TURNS,
  MAX_GLOBAL_EMITTED_TERMINAL_TURNS,
  type CodexActiveTranscriptTurn,
  type CodexPendingTerminalTurn,
  type CodexTranscriptInputContext,
  type CodexTranscriptCheckpoint,
  type CodexTranscriptGlobalState,
  type CodexTranscriptSourceRange,
} from './codex-transcript-types.js';
import { stringValue, timestampMs } from './codex-transcript-utils.js';

const DEFAULT_SESSION_DIR = '~/.codex/sessions';
const READ_CHUNK_SIZE = 1024 * 1024;
const MAX_EMIT_BATCH_ENTRIES = 256;
const MAX_EMIT_BATCH_BYTES = 1024 * 1024;
const MAX_PERSISTED_INPUT_CONTEXT_BYTES = 1024 * 1024;
const MAX_TERMINALS_PER_FILE_CYCLE = 100;
const MAX_SCAN_BYTES_PER_FILE_CYCLE = 16 * 1024 * 1024;
// 这些字段由 assets/hooks/shared/resource-context.mjs 的 DEFAULT_RESOURCE_ENV_FIELD_MAP 写入 marker。
// 新增 AgentTeams resource 字段时必须同步修改写入端与此白名单，避免任意 marker 字段进入事件。
const WAKEUP_RESOURCE_ATTRIBUTE_KEYS = [
  'agentteams.worker.name',
  'agentteams.instance.id',
];
const MAX_WAKEUP_RESOURCE_ATTRIBUTE_VALUE_LENGTH = 512;

interface JsonLine {
  startOffset: number;
  endOffset: number;
  record: Record<string, unknown>;
}

interface SegmentRecoveryDiagnostics {
  sourceRecordCount: number;
  stepCount: number;
  toolCount: number;
  tokenUsageCount: number;
  unmatchedTokenUsageCount: number;
  builtEntryCount: number;
  readyEntryCount: number;
  deduplicatedEntryCount: number;
  emittedEntryCount: number;
  previouslyEmittedStepCount: number;
}

type SegmentRecoveryResult = {
  kind: 'unparseable';
  entries: [];
  consumedEndOffset: number;
  diagnostics: SegmentRecoveryDiagnostics;
} | {
  kind: 'processed-empty' | 'processed-emitted';
  entries: AgentActivityEntry[];
  consumedEndOffset: number;
  terminalStatus: 'completed' | 'interrupted';
  diagnostics: SegmentRecoveryDiagnostics;
};

interface PendingRecoveryResult {
  blocked: boolean;
  emittedCount: number;
  processedTerminalCount: number;
}

export interface CodexTranscriptInputOptions extends InputOptions {
  /** Codex rollout JSONL 根目录；默认 `~/.codex/sessions`。 */
  sessionDir?: string;
  /** Stop Hook 写入唤醒 marker 的目录；默认位于 Pilot data dir 下。 */
  wakeupDir?: string;
}

/**
 * Codex rollout transcript 的生产采集器。
 *
 * Orchestrator 创建并交给 InputManager 启停。类启动时对现有文件做 baseline，之后同时依靠 30 秒
 * 轮询与 wakeup 目录的 `fs.watch` 触发采集。每个文件维护 inode、字节 offset、active turn、待恢复
 * terminal 和事件 ID 去重状态；停止时关闭 watcher，轮询定时器和在途周期由 BaseInput 统一清理。
 */
export class CodexTranscriptInput extends BaseInput {
  readonly id = 'codex-transcript';
  readonly agentType = ClientType.CodexCliHook;
  readonly collectionMethod = CollectionMethod.SessionFilePolling;

  private readonly sessionDir: string;
  private readonly wakeupDir: string;
  private wakeupWatcher: FSWatcher | null = null;
  private processedTerminalTurnIdsLoaded = false;
  private processedTerminalTurnIdsDirty = false;
  private processedTerminalTurnIds = new Set<string>();
  private processedTerminalTurnIdOrder: string[] = [];

  /** 保存状态存储与目录配置；构造阶段不扫描文件，也不创建 watcher。 */
  constructor(opts: CodexTranscriptInputOptions) {
    super({ stateStore: opts.stateStore, pollIntervalMs: opts.pollIntervalMs ?? 30_000 });
    this.sessionDir = opts.sessionDir ?? resolveHome(DEFAULT_SESSION_DIR);
    this.wakeupDir = opts.wakeupDir ?? defaultWakeupDir();
  }

  /** 返回 AgentDiscoveryService 可用于判断 Codex 是否存在的默认会话目录。 */
  static getWatchPaths(): string[] {
    return [resolveHome(DEFAULT_SESSION_DIR)];
  }

  /** 异步检查默认会话目录是否存在；不存在时返回 false，不抛出普通文件系统错误。 */
  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome(DEFAULT_SESSION_DIR));
  }

  /**
   * 加载跨文件去重状态、baseline 新发现的旧文件，并监听 Stop Hook 的唤醒目录。
   * watcher 失败不会阻止 Input 启动，因为 BaseInput 的周期轮询仍能继续采集。
   */
  protected override async onStart(): Promise<void> {
    this.loadGlobalProcessedTerminalTurnIds();
    for (const filePath of await this.discoverSessionFiles()) {
      const key = this.stateKey(filePath);
      if (!this.readCheckpoint(key)) await this.baselineFile(filePath, key);
    }
    this.saveGlobalProcessedTerminalTurnIds();
    await fs.mkdir(this.wakeupDir, { recursive: true });
    try {
      // `persistent: false` 表示单独这个 watcher 不会阻止 Node.js 进程正常退出。
      this.wakeupWatcher = fsSync.watch(this.wakeupDir, { persistent: false }, () => {
        this.requestCollection();
      });
      this.wakeupWatcher.on('error', () => {
        this.wakeupWatcher?.close();
        this.wakeupWatcher = null;
      });
    } catch {
      this.logger.warn('failed to watch Codex wakeup directory; polling remains active', {
        wakeupDir: this.wakeupDir,
      });
    }
  }

  /** 关闭 wakeup 文件系统监听器；BaseInput 随后还会等待正在执行的 collect 周期结束。 */
  protected override async onStop(): Promise<void> {
    this.wakeupWatcher?.close();
    this.wakeupWatcher = null;
  }

  /**
   * 发现并顺序处理所有 rollout 文件。
   *
   * `processFile()` 为控制批大小会直接发出 `entries` 事件，所以这里返回空数组，避免 BaseInput
   * 再次发送相同数据。单文件异常会按其内部策略处理；未捕获错误交给 BaseInput 记录。
   */
  protected override async collect(): Promise<AgentActivityEntry[]> {
    let emittedCount = 0;
    for (const filePath of await this.discoverSessionFiles()) {
      emittedCount += await this.processFile(filePath);
    }
    if (emittedCount > 0) {
      this.logger.debug('cycle produced entries', { count: emittedCount });
    }
    return [];
  }

  /**
   * 按最多 256 条或约 1 MiB 把事件同步分批交给 BaseInput 的 `entries` 监听器。
   * @returns 实际发出的事件条数；EventEmitter 本身不等待异步监听器。
   */
  private emitEntryBatches(entries: AgentActivityEntry[]): number {
    let emittedCount = 0;
    let batch: AgentActivityEntry[] = [];
    let batchBytes = 0;

    /** 发出当前批次并重置累计数组和字节数。 */
    const flush = (): void => {
      if (batch.length === 0) return;
      this.emit('entries', batch);
      emittedCount += batch.length;
      batch = [];
      batchBytes = 0;
    };

    for (const entry of entries) {
      const entryBytes = serializedEntryBytes(entry);
      if (
        batch.length > 0
        && (batch.length >= MAX_EMIT_BATCH_ENTRIES || batchBytes + entryBytes > MAX_EMIT_BATCH_BYTES)
      ) {
        flush();
      }
      batch.push(entry);
      batchBytes += entryBytes;
    }
    flush();
    return emittedCount;
  }

  /**
   * 从一个 rollout 文件的 checkpoint 继续扫描、恢复 turn、发出事件并更新状态。
   *
   * 每周期限制 terminal 数和扫描字节，避免一个大文件饿死其他 Agent。inode 改变时视为文件替换并
   * 重新 baseline；pending terminal 必须优先恢复，恢复失败会阻塞该文件后续字节以保证不漏数据。
   *
   * @returns 本文件本周期实际发出的事件数。
   */
  private async processFile(filePath: string): Promise<number> {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return 0;
    }
    const key = this.stateKey(filePath);
    let checkpoint = this.readCheckpoint(key);
    let checkpointChanged = false;
    if (!checkpoint) {
      checkpoint = {
        inode: stat.ino,
        scanOffset: 0,
        activeTurn: null,
        pendingTerminal: null,
        latestSessionMetaOffset: null,
        emittedTerminalTurnIds: [],
      };
      checkpointChanged = true;
    } else if (checkpoint.inode !== stat.ino) {
      await this.baselineFile(filePath, key);
      this.saveGlobalProcessedTerminalTurnIds();
      return 0;
    }

    let emittedCount = 0;
    let processedTerminalCount = 0;
    let scannedBytes = 0;

    const hadPendingTerminal = checkpoint.pendingTerminal !== null;
    const pendingResult = await this.recoverPendingTerminal(filePath, checkpoint);
    checkpointChanged ||= hadPendingTerminal;
    emittedCount += pendingResult.emittedCount;
    processedTerminalCount += pendingResult.processedTerminalCount;
    if (pendingResult.blocked) {
      if (checkpointChanged) this.saveCheckpoint(key, checkpoint);
      this.saveGlobalProcessedTerminalTurnIds();
      return emittedCount;
    }

    while (
      checkpoint.scanOffset < stat.size
      && processedTerminalCount < MAX_TERMINALS_PER_FILE_CYCLE
      && scannedBytes < MAX_SCAN_BYTES_PER_FILE_CYCLE
    ) {
      const scanStartOffset = checkpoint.scanOffset;
      const scanEndOffset = Math.min(
        stat.size,
        scanStartOffset + (MAX_SCAN_BYTES_PER_FILE_CYCLE - scannedBytes),
      );
      let terminalTurnId: string | null = null;
      let terminalEndOffset: number | null = null;
      /** 只识别 session meta、turn 起点和 terminal；返回 false 让扫描器停在 terminal 后。 */
      const processScannedLine = (line: JsonLine): void | false => {
        const payload = asRecord(line.record.payload);
        if (!payload) return;
        if (line.record.type === 'session_meta') {
          checkpoint.latestSessionMetaOffset = line.startOffset;
          return;
        }

        const turnId = turnIdForStart(line.record, payload);
        if (turnId) {
          if (!checkpoint.activeTurn || checkpoint.activeTurn.turnId !== turnId) {
            checkpoint.activeTurn = createActiveTurn(turnId, line.startOffset, timestampMs(line.record, Date.now()));
          }
          updateActiveTurnMetadata(checkpoint.activeTurn, line.record, payload);
          return;
        }

        const terminal = terminalTurnIdFor(line.record, payload);
        if (!terminal || checkpoint.activeTurn?.turnId !== terminal) return;
        terminalTurnId = terminal;
        terminalEndOffset = line.endOffset;
        return false;
      };
      let scan = await scanJsonLines(filePath, scanStartOffset, scanEndOffset, processScannedLine);

      // 单条 JSONL 可能超过本周期字节预算。若预算范围内连一条完整换行都没有，就额外读到文件
      // 当前末尾并消费一条完整记录，否则 scanOffset 会永远停在同一位置。
      if (scan.nextOffset === scanStartOffset && scanEndOffset < stat.size) {
        scan = await scanJsonLines(filePath, scanStartOffset, stat.size, line => {
          processScannedLine(line);
          return false;
        });
      }
      if (scan.nextOffset === scanStartOffset) break;
      // 只要消费过完整行，就需要保存 checkpoint，即使这些行最终没有生成业务事件。
      checkpointChanged = true;

      // 遇到 terminal 时严格停在 terminal 行末；否则推进到本次扫描到的最后一个完整换行。
      const nextScanOffset = terminalEndOffset ?? scan.nextOffset;
      scannedBytes += nextScanOffset - scanStartOffset;
      let blocked = false;

      if (checkpoint.activeTurn && nextScanOffset > checkpoint.activeTurn.startOffset) {
        // 单文件列表命中表示本 transcript 已处理过该 terminal，可直接清理活跃状态。
        if (terminalTurnId && checkpoint.emittedTerminalTurnIds.includes(terminalTurnId)) {
          checkpoint.activeTurn = null;
          checkpoint.pendingTerminal = null;
          processedTerminalCount++;
        // 同一个 turn 可能因文件复制出现在另一 transcript；全局列表防止跨文件重复输出。
        } else if (terminalTurnId && this.isGloballyProcessedTerminalTurn(terminalTurnId)) {
          this.rememberProcessedTerminalTurnId(checkpoint, terminalTurnId);
          checkpoint.activeTurn = null;
          checkpoint.pendingTerminal = null;
          processedTerminalCount++;
        } else {
          // 对 active turn 的可见字节做语义恢复；活跃 turn 只提交闭合 step，terminal 提交整个 turn。
          const recovered = await this.recoverTurnSegment(
            filePath,
            checkpoint,
            nextScanOffset,
            terminalTurnId !== null,
          );
          emittedCount += this.emitEntryBatches(recovered.entries);
          // 只有成功解析并实际消费了源范围才移动 turn 起点；失败时保留原范围供下次完整重试。
          if (
            recovered.kind !== 'unparseable'
            && recovered.consumedEndOffset > checkpoint.activeTurn.startOffset
          ) {
            checkpoint.activeTurn.startOffset = recovered.consumedEndOffset;
          }

          // terminal 已读到后必须得到“成功处理”或“持久化 pending”之一，不能静默越过。
          if (terminalTurnId && checkpoint.activeTurn.turnId === terminalTurnId) {
            if (recovered.kind === 'unparseable') {
              checkpoint.pendingTerminal = newPendingTerminal(
                terminalTurnId,
                nextScanOffset,
                recovered.diagnostics.sourceRecordCount,
              );
              this.logger.warn('terminal Codex turn could not be parsed; retaining it for the next scan', {
                transcriptPath: filePath,
                turnId: terminalTurnId,
                range: { startOffset: checkpoint.activeTurn.startOffset, endOffset: nextScanOffset },
                retryCount: checkpoint.pendingTerminal.retryCount,
                sourceRecordCount: recovered.diagnostics.sourceRecordCount,
              });
              blocked = true;
            } else {
              // 成功处理后同时更新文件级和全局去重表，再释放 active/pending 状态。
              this.rememberProcessedTerminalTurnId(checkpoint, terminalTurnId);
              this.rememberGlobalProcessedTerminalTurnId(terminalTurnId);
              checkpoint.activeTurn = null;
              checkpoint.pendingTerminal = null;
              processedTerminalCount++;
            }
          }
        }
      }

      // scanOffset 描述物理文件扫描位置；activeTurn.startOffset 描述语义恢复起点，两者不能混用。
      checkpoint.scanOffset = nextScanOffset;
      // 没有 terminal 时通常说明文件尾仍在写当前 turn，留到下一周期；pending 失败也必须停止后续扫描。
      if (blocked || terminalTurnId === null) break;
    }

    if (checkpointChanged) this.saveCheckpoint(key, checkpoint);
    this.saveGlobalProcessedTerminalTurnIds();
    return emittedCount;
  }

  /**
   * 优先重试已经读到、但上次无法解析的 terminal turn。
   *
   * 正常扫描的 offset 已越过 terminal 行，不会自动回头，因此必须持久化 terminalEndOffset 并在
   * 读取后续数据前重试。若仍不可解析，返回 `blocked: true`，调用方保存重试次数后停止处理该文件。
   */
  private async recoverPendingTerminal(
    filePath: string,
    checkpoint: CodexTranscriptCheckpoint,
  ): Promise<PendingRecoveryResult> {
    const pending = checkpoint.pendingTerminal;
    if (!pending) return { blocked: false, emittedCount: 0, processedTerminalCount: 0 };
    // pending 与 activeTurn 不一致说明旧状态已损坏或完成过迁移；清掉孤立 pending，避免永久阻塞。
    if (checkpoint.activeTurn?.turnId !== pending.turnId) {
      checkpoint.pendingTerminal = null;
      return { blocked: false, emittedCount: 0, processedTerminalCount: 0 };
    }
    // 若另一 transcript 已成功处理同 turn，无需重读源字节，只同步本文件去重状态。
    if (this.isGloballyProcessedTerminalTurn(pending.turnId)) {
      this.rememberProcessedTerminalTurnId(checkpoint, pending.turnId);
      checkpoint.activeTurn = null;
      checkpoint.pendingTerminal = null;
      return { blocked: false, emittedCount: 0, processedTerminalCount: 1 };
    }
    // 使用持久化 terminalEndOffset 精确重建上次失败范围，而不是依赖当前文件扫描游标回退。
    const recovered = await this.recoverTurnSegment(filePath, checkpoint, pending.terminalEndOffset, true);
    if (recovered.kind === 'unparseable') {
      const now = Date.now();
      // firstPendingAtMs 保留首次失败时间，lastAttempt/retryCount 则在每次重试更新，便于诊断卡住时长。
      checkpoint.pendingTerminal = {
        ...pending,
        retryCount: (pending.retryCount ?? 0) + 1,
        firstPendingAtMs: pending.firstPendingAtMs ?? now,
        lastAttemptAtMs: now,
        sourceRecordCount: recovered.diagnostics.sourceRecordCount,
      };
      this.logger.warn('pending Codex terminal turn still could not be parsed; will retry', {
        transcriptPath: filePath,
        turnId: pending.turnId,
        range: { startOffset: checkpoint.activeTurn.startOffset, endOffset: pending.terminalEndOffset },
        retryCount: checkpoint.pendingTerminal.retryCount,
        firstPendingAtMs: checkpoint.pendingTerminal.firstPendingAtMs,
        sourceRecordCount: recovered.diagnostics.sourceRecordCount,
      });
      return { blocked: true, emittedCount: 0, processedTerminalCount: 0 };
    }

    // 只有构建成功后才发送并登记完成；这保证异常重试不会先标记完成再丢事件。
    const emittedCount = this.emitEntryBatches(recovered.entries);
    this.rememberProcessedTerminalTurnId(checkpoint, pending.turnId);
    this.rememberGlobalProcessedTerminalTurnId(pending.turnId);
    checkpoint.activeTurn = null;
    checkpoint.pendingTerminal = null;
    return { blocked: false, emittedCount, processedTerminalCount: 1 };
  }

  /**
   * 重读 active turn 的指定字节片段，经 Extractor 和 Builder 转为新事件。
   *
   * 方法会更新 activeTurn 的模型、已发事件 ID、step 数和输入上下文，但不直接写 StateStore；
   * `processFile()` 在本轮结束时统一持久化。terminal=false 时只提交 Extractor 确认闭合的前缀。
   */
  private async recoverTurnSegment(
    filePath: string,
    checkpoint: CodexTranscriptCheckpoint,
    endOffset: number,
    terminal: boolean,
  ): Promise<SegmentRecoveryResult> {
    const activeTurn = checkpoint.activeTurn;
    if (!activeTurn) {
      // 理论上调用前应有 activeTurn；返回统一 unparseable 结构比抛错更利于文件级恢复。
      return {
        kind: 'unparseable',
        entries: [],
        consumedEndOffset: endOffset,
        diagnostics: emptySegmentRecoveryDiagnostics(),
      };
    }
    // turn 片段和最近 session_meta 分开读取；meta 可能位于 activeTurn 起点之前。
    const records = await readJsonLines(filePath, activeTurn.startOffset, endOffset);
    const metaRecord = checkpoint.latestSessionMetaOffset === null
      ? null
      : await readJsonLineAt(filePath, checkpoint.latestSessionMetaOffset);
    const meta = metaRecord ? extractCodexTranscriptMeta(metaRecord) : null;
    // Extractor 同时返回语义 step 和真实字节消费边界，二者必须一起用于增量 checkpoint。
    const extraction = extractCodexPartialTurnWithBoundaries(
      records.items,
      meta,
      sessionIdFromTranscriptPath(filePath),
      activeTurn.turnId,
      partialTurnOptions(activeTurn),
    );
    // 记录进入本轮前已经发过多少 step，后续诊断可区分“没有数据”和“全部已增量发出”。
    const previouslyEmittedStepCount = activeTurn.emittedStepCount ?? 0;
    if (!extraction) {
      return {
        kind: 'unparseable',
        entries: [],
        consumedEndOffset: activeTurn.startOffset,
        diagnostics: emptySegmentRecoveryDiagnostics(records.items.length, previouslyEmittedStepCount),
      };
    }
    const turn = extraction.turn;
    // turn_context 可能出现在恢复片段里，解析到的真实 metadata 会回填 active checkpoint。
    updateActiveTurnFromExtractedTurn(activeTurn, turn);
    if (turn.unmatchedTokenUsages.length > 0) {
      this.logger.warn('Codex transcript token samples could not be assigned to a response wave', {
        transcriptPath: filePath,
        turnId: activeTurn.turnId,
        count: turn.unmatchedTokenUsages.length,
        lastUsage: turn.unmatchedTokenUsages.at(-1),
      });
    }

    // Builder 的 step 序号必须从已发数量之后继续，确保跨轮询 ID 稳定且不重复。
    const stepStart = (activeTurn.emittedStepCount ?? 0) + 1;
    // terminal 允许闭合全部 step；活跃 turn 只能采用 extractor 判定可增量提交的连续前缀。
    const closedStepCount = terminal
      ? turn.steps.length
      : extraction.committedStepCount;
    const committedTurn = closedStepCount === turn.steps.length
      ? turn
      : { ...turn, steps: turn.steps.slice(0, closedStepCount) };
    // 超大上下文可能需要按 checkpoint 保存的源范围回读，因此这里是异步步骤。
    const inputContext = await this.resolveInputContext(filePath, activeTurn, meta);
    const built = buildCodexTranscriptSegment(committedTurn, {
      includePrompt: activeTurn.emittedPrompt !== true,
      startStepNumber: stepStart,
      ...(inputContext ? { inputContext } : {}),
      contextStepCount: committedTurn.steps.length,
    });
    const readyEntries = built.entries;
    // Builder 使用确定性 ID 重建整个片段，随后依据 checkpoint 中的 ID 集合过滤已经发出的事件。
    const entries = this.filterNewSegmentEntries(readyEntries, activeTurn);
    // 诊断计数不参与事件内容，仅帮助区分解析、构建、去重和发送各阶段的数据损失位置。
    const diagnostics: SegmentRecoveryDiagnostics = {
      sourceRecordCount: records.items.length,
      stepCount: turn.steps.length,
      toolCount: turn.steps.reduce((count, step) => count + step.tools.length, 0),
      tokenUsageCount: turn.steps.filter(step => step.tokenUsage !== undefined).length,
      unmatchedTokenUsageCount: turn.unmatchedTokenUsages.length,
      builtEntryCount: built.entries.length,
      readyEntryCount: readyEntries.length,
      deduplicatedEntryCount: readyEntries.length - entries.length,
      emittedEntryCount: entries.length,
      previouslyEmittedStepCount,
    };

    // terminal 没有新事件可能是合法空控制 turn、已增量发送完毕，也可能是异常；分别记录不同级别。
    if (terminal && entries.length === 0) {
      if (built.entries.length === 0) {
        this.logger.debug('processed terminal Codex turn without observable entries', {
          transcriptPath: filePath,
          turnId: activeTurn.turnId,
          terminalStatus: turn.status,
          diagnostics,
        });
      } else if (readyEntries.length > 0 && diagnostics.deduplicatedEntryCount === readyEntries.length) {
        this.logger.debug('terminal Codex turn entries were already emitted incrementally', {
          transcriptPath: filePath,
          turnId: activeTurn.turnId,
          terminalStatus: turn.status,
          diagnostics,
        });
      } else {
        this.logger.warn('processed terminal Codex turn produced no explainable new entries', {
          transcriptPath: filePath,
          turnId: activeTurn.turnId,
          terminalStatus: turn.status,
          diagnostics,
        });
      }
    }

    // 事件 ID 集合在 filter 中更新；这里同步高层 prompt/step 进度，供下一片段决定起始位置。
    if (turn.prompt) activeTurn.emittedPrompt = true;
    activeTurn.emittedStepCount = (activeTurn.emittedStepCount ?? 0) + closedStepCount;

    // 保存最后闭合 step 的源范围；若 delta 太大，persistedInputContext 会改存该范围而非正文。
    const lastClosedRange = closedStepCount > 0
      ? extraction.committedStepRanges[closedStepCount - 1]
      : undefined;
    if (closedStepCount > 0) {
      activeTurn.inputContext = persistedInputContext(built.nextInputContext, lastClosedRange);
    }

    // terminal 可以消费到明确结束位置；活跃 turn 只能推进到 Extractor 判定闭合的 step 边界。
    const consumedEndOffset = terminal
      ? endOffset
      : extraction.consumedEndOffset;

    // wakeup marker 的 AgentTeams 归属是可选 enrich，读取失败不会改变主事件和消费 offset。
    const resourceAttributes = await this.readWakeupResourceAttributes(turn.sessionId);
    const outputEntries = resourceAttributes ? attachWakeupResourceAttributes(entries, resourceAttributes) : entries;
    return {
      kind: outputEntries.length > 0 ? 'processed-emitted' : 'processed-empty',
      entries: outputEntries,
      consumedEndOffset,
      terminalStatus: turn.status,
      diagnostics,
    };
  }

  /**
   * 恢复 Builder 的上一个输入上下文。
   *
   * 小 delta 直接存于 checkpoint；超过 1 MiB 时只保存 transcript 字节范围，此处重读该范围并从
   * 最后一个 step 重建 delta。重建失败仅记录警告并保留哈希，不阻塞当前采集。
   */
  private async resolveInputContext(
    filePath: string,
    activeTurn: CodexActiveTranscriptTurn,
    meta: ReturnType<typeof extractCodexTranscriptMeta>,
  ): Promise<CodexTranscriptInputContext | undefined> {
    const context = activeTurn.inputContext;
    if (!context || context.delta) return context;
    const range = context.deltaRange;
    if (!range) return context;

    const records = await readJsonLines(filePath, range.startOffset, range.endOffset);
    const previous = extractCodexPartialTurn(
      records.items.map(item => item.record),
      meta,
      sessionIdFromTranscriptPath(filePath),
      activeTurn.turnId,
      partialTurnOptions(activeTurn),
    );
    const lastStep = previous?.steps.at(-1);
    if (!lastStep) {
      this.logger.warn('could not rebuild oversized Codex input delta from transcript range', {
        transcriptPath: filePath,
        turnId: activeTurn.turnId,
        range,
      });
      return context;
    }
    return { ...context, delta: nextInputMessagesForStep(lastStep) };
  }

  /**
   * 根据 activeTurn 中四类已发 ID 去掉重建片段里的重复事件，并同步更新这些有界 checkpoint 字段。
   * prompt 使用单独布尔值控制；未知事件类型原样保留，避免未来 schema 扩展被静默丢弃。
   */
  private filterNewSegmentEntries(
    entries: AgentActivityEntry[],
    activeTurn: NonNullable<CodexTranscriptCheckpoint['activeTurn']>,
  ): AgentActivityEntry[] {
    const out: AgentActivityEntry[] = [];
    activeTurn.emittedStepRequestIds ??= [];
    activeTurn.emittedStepResponseIds ??= [];
    activeTurn.emittedToolCallIds ??= [];
    activeTurn.emittedToolResultIds ??= [];

    const stepRequests = new Set(activeTurn.emittedStepRequestIds);
    const stepResponses = new Set(activeTurn.emittedStepResponseIds);
    const toolCalls = new Set(activeTurn.emittedToolCallIds);
    const toolResults = new Set(activeTurn.emittedToolResultIds);

    for (const entry of entries) {
      const eventName = entry['event.name'];
      if (eventName === 'other') {
        if (activeTurn.emittedPrompt) continue;
        activeTurn.emittedPrompt = true;
        out.push(entry);
        continue;
      }

      const stepId = typeof entry['gen_ai.step.id'] === 'string' ? entry['gen_ai.step.id'] : '';
      const toolCallId = typeof entry['gen_ai.tool.call.id'] === 'string' ? entry['gen_ai.tool.call.id'] : '';
      if (eventName === 'llm.request') {
        if (!stepId || stepRequests.has(stepId)) continue;
        stepRequests.add(stepId);
        out.push(entry);
      } else if (eventName === 'llm.response') {
        if (!stepId || stepResponses.has(stepId)) continue;
        stepResponses.add(stepId);
        out.push(entry);
      } else if (eventName === 'tool.call') {
        if (!toolCallId || toolCalls.has(toolCallId)) continue;
        toolCalls.add(toolCallId);
        out.push(entry);
      } else if (eventName === 'tool.result') {
        if (!toolCallId || toolResults.has(toolCallId)) continue;
        toolResults.add(toolCallId);
        out.push(entry);
      } else {
        out.push(entry);
      }
    }

    activeTurn.emittedStepRequestIds = [...stepRequests];
    activeTurn.emittedStepResponseIds = [...stepResponses];
    activeTurn.emittedToolCallIds = [...toolCalls];
    activeTurn.emittedToolResultIds = [...toolResults];
    return out;
  }

  /**
   * 读取 Stop Hook marker 中的 AgentTeams 归属字段。
   *
   * 只接受白名单内、长度不超过 512 的非空字符串；文件缺失、JSON 损坏或无有效字段均返回
   * `undefined`，不影响 transcript 主数据输出。
   */
  private async readWakeupResourceAttributes(sessionId: string): Promise<Record<string, JsonValue> | undefined> {
    const marker = path.join(this.wakeupDir, `${safeWakeupSessionPart(sessionId)}.json`);
    let raw: string;
    try {
      raw = await fs.readFile(marker, 'utf8');
    } catch {
      return undefined;
    }

    let markerRecord: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(raw);
      markerRecord = asRecord(parsed);
    } catch {
      this.logger.debug('Codex wakeup marker could not be parsed; resource attributes skipped', { marker });
      return undefined;
    }

    const markerAttributes = asRecord(markerRecord?.resourceAttributes);
    if (!markerAttributes) {
      this.logger.debug('Codex wakeup marker has no resourceAttributes; attribution skipped', { marker });
      return undefined;
    }

    const resourceAttributes: Record<string, JsonValue> = {};
    for (const key of WAKEUP_RESOURCE_ATTRIBUTE_KEYS) {
      const value = markerAttributes[key];
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed.length > MAX_WAKEUP_RESOURCE_ATTRIBUTE_VALUE_LENGTH) {
        this.logger.debug('Codex wakeup resource attribute skipped because value is too long', {
          marker,
          key,
          maxLength: MAX_WAKEUP_RESOURCE_ATTRIBUTE_VALUE_LENGTH,
        });
        continue;
      }
      if (trimmed) resourceAttributes[key] = trimmed;
    }

    if (Object.keys(resourceAttributes).length === 0) {
      this.logger.debug('Codex wakeup marker has no whitelisted resourceAttributes; attribution skipped', { marker });
      return undefined;
    }
    return resourceAttributes;
  }

  /**
   * 首次见到文件时扫描到当前 EOF，并把既有 terminal turn 标为已处理，不回放安装前的历史。
   * 若文件末尾存在活跃 turn，仅保存其元数据并把 startOffset 放到 EOF，之后只接收新增内容。
   */
  private async baselineFile(filePath: string, key: string): Promise<void> {
    let stat;
    try {
      // 固定当前文件大小作为 baseline 上界；扫描期间新追加的字节由首次 collect 处理。
      stat = await fs.stat(filePath);
    } catch {
      // 文件可能在发现后被轮转，等待下一轮重新发现即可，不把暂时缺失视为启动失败。
      return;
    }
    // baseline 仍需识别最近 meta 和未结束 turn，但不会构建或发送历史 entry。
    let latestSessionMetaOffset: number | null = null;
    let activeTurn: CodexActiveTranscriptTurn | null = null;
    // 已闭合 turn 写入全局去重集合，防止它在另一个重复/迁移 transcript 中被再次恢复。
    const completedTurnIds: string[] = [];
    const { nextOffset } = await scanJsonLines(filePath, 0, stat.size, line => {
      // scanJsonLines 已保证每项是完整 JSON 行；payload 仍需运行时验证，因为内容来自 Codex。
      const payload = asRecord(line.record.payload);
      if (!payload) return;
      if (line.record.type === 'session_meta') {
        // 只记字节位置，后续需要时再回读完整 meta，避免 checkpoint 存储大段 instructions。
        latestSessionMetaOffset = line.startOffset;
        return;
      }
      const turnId = turnIdForStart(line.record, payload);
      if (turnId && (!activeTurn || activeTurn.turnId !== turnId)) {
        // baseline 标志 true 让 createActiveTurn 知道这是安装前已有内容，不能把历史 prompt 当作新增输出。
        activeTurn = createActiveTurn(turnId, line.startOffset, timestampMs(line.record, Date.now()), true);
      }
      if (turnId && activeTurn?.turnId === turnId) {
        // 起点记录可能同时携带 model/cwd/developer instructions，保存它们以支持跨重启后的增量尾部。
        updateActiveTurnMetadata(activeTurn, line.record, payload);
        return;
      }
      const terminalTurnId = terminalTurnIdFor(line.record, payload);
      if (terminalTurnId === activeTurn?.turnId) {
        // 只有与 activeTurn 匹配的 terminal 才能关闭它，避免相邻或重复记录破坏状态机。
        completedTurnIds.push(terminalTurnId);
        activeTurn = null;
      }
    });
    const baselineActiveTurn = activeTurn as CodexActiveTranscriptTurn | null;
    if (baselineActiveTurn) {
      // 历史前半段已被有意跳过，把恢复起点移到最后完整行；之后只解析新增记录。
      baselineActiveTurn.startOffset = nextOffset;
    }
    // 全局集合先更新再保存文件 checkpoint，使同一启动周期扫描后续文件时立即生效。
    for (const turnId of completedTurnIds) this.rememberGlobalProcessedTerminalTurnId(turnId);
    // scanOffset 使用 nextOffset 而非 stat.size：若 EOF 是半行，下次仍会从该半行开头读取。
    this.saveCheckpoint(key, {
      inode: stat.ino,
      scanOffset: nextOffset,
      activeTurn,
      pendingTerminal: null,
      latestSessionMetaOffset,
      emittedTerminalTurnIds: [],
    });
  }

  /** 递归发现 sessionDir 下所有 `rollout-*.jsonl`，排序后返回以保持处理顺序稳定。 */
  private async discoverSessionFiles(): Promise<string[]> {
    const files: string[] = [];
    await collectRolloutFiles(this.sessionDir, files);
    return files.sort();
  }

  /** 以 Input ID 和绝对文件路径组合 StateStore key，避免不同 transcript 共享 offset。 */
  private stateKey(filePath: string): string {
    return `${this.id}:${filePath}`;
  }

  /**
   * 从通用 StateStore 验证并恢复 Codex 专用 checkpoint。
   * 旧版本缺失的新字段使用空值，非法必需字段则返回 null，让调用方重新 baseline。
   */
  private readCheckpoint(key: string): CodexTranscriptCheckpoint | null {
    // 专用状态嵌在通用 InputState.extra 中，避免 StateStore 认识每一种 Input 的私有结构。
    const raw = this.stateStore.get(key).extra?.codexTranscript;
    const value = asRecord(raw);
    // inode 和 scanOffset 是恢复增量读取所需的最小字段；任一无效都必须重新 baseline。
    if (!value || typeof value.inode !== 'number' || typeof value.scanOffset !== 'number') return null;
    // activeTurn 来自磁盘 JSON，先逐个读取可选字符串，再验证三个必需字段。
    const active = asRecord(value.activeTurn);
    const model = stringValue(active?.model);
    const cwd = stringValue(active?.cwd);
    const developerInstructions = stringValue(active?.developerInstructions);
    const activeTurn = active
      && typeof active.turnId === 'string'
      && typeof active.startOffset === 'number'
      && typeof active.startedAtMs === 'number'
      ? {
          // turnId + 起始字节 + 起始时间共同确定跨轮询恢复的范围和时间边界。
          turnId: active.turnId,
          startOffset: active.startOffset,
          startedAtMs: active.startedAtMs,
          ...(model ? { model } : {}),
          ...(cwd ? { cwd } : {}),
          ...(developerInstructions ? { developerInstructions } : {}),
          // 布尔值只接受严格 true；旧 checkpoint 没有该字段时按“尚未输出 prompt”处理。
          emittedPrompt: active.emittedPrompt === true,
          // 已输出计数和 ID 集合用于 pending terminal 重试时跳过已成功发送的事件，避免重复上报。
          emittedStepCount: typeof active.emittedStepCount === 'number' ? active.emittedStepCount : 0,
          emittedStepRequestIds: stringArray(active.emittedStepRequestIds),
          emittedStepResponseIds: stringArray(active.emittedStepResponseIds),
          emittedToolCallIds: stringArray(active.emittedToolCallIds),
          emittedToolResultIds: stringArray(active.emittedToolResultIds),
          // inputContext 可能较大且结构嵌套，交给专用解析器逐字段收窄并应用兼容默认值。
          inputContext: parseInputContext(active.inputContext),
        }
      : null;
    // pendingTerminal 表示已经看到终态，但该 turn 尚未完整构建或发送成功，需要下轮从固定边界重试。
    const pending = asRecord(value.pendingTerminal);
    const pendingTerminal = pending
      && typeof pending.turnId === 'string'
      && typeof pending.terminalEndOffset === 'number'
      ? {
          turnId: pending.turnId,
          // terminalEndOffset 固定终态闭合边界，后续追加的新 turn 不会被误读进本次重试。
          terminalEndOffset: pending.terminalEndOffset,
          // 下列诊断字段均为后来增加的可选字段；旧状态缺失时不影响恢复资格。
          ...(typeof pending.retryCount === 'number' ? { retryCount: pending.retryCount } : {}),
          ...(typeof pending.firstPendingAtMs === 'number' ? { firstPendingAtMs: pending.firstPendingAtMs } : {}),
          ...(typeof pending.lastAttemptAtMs === 'number' ? { lastAttemptAtMs: pending.lastAttemptAtMs } : {}),
          ...(typeof pending.sourceRecordCount === 'number' ? { sourceRecordCount: pending.sourceRecordCount } : {}),
        }
      : null;
    return {
      // 保留经验证的文件身份和扫描位置。
      inode: value.inode,
      scanOffset: value.scanOffset,
      activeTurn,
      pendingTerminal,
      // meta 位置不是恢复所必需；缺失时 extractor 会从文件名和协议默认值补足基础身份。
      latestSessionMetaOffset: typeof value.latestSessionMetaOffset === 'number'
        ? value.latestSessionMetaOffset
        : null,
      // 文件级终态 ID 是旧版/局部去重来源；截断可限制状态文件大小。
      emittedTerminalTurnIds: Array.isArray(value.emittedTerminalTurnIds)
        ? value.emittedTerminalTurnIds.filter((item): item is string => typeof item === 'string')
          .slice(0, MAX_EMITTED_TERMINAL_TURNS)
        : [],
    };
  }

  /** 合并写入 Codex checkpoint，并把通用 lastOffset 同步为 scanOffset。 */
  private saveCheckpoint(key: string, checkpoint: CodexTranscriptCheckpoint): void {
    const current = this.stateStore.get(key);
    this.stateStore.update(key, {
      lastOffset: checkpoint.scanOffset,
      extra: {
        ...(current.extra ?? {}),
        codexTranscript: checkpoint,
      },
    });
  }

  /**
   * 惰性加载跨文件 terminal 去重集合；若还没有全局状态，则从各文件旧 checkpoint 迁移一次。
   */
  private loadGlobalProcessedTerminalTurnIds(): void {
    if (this.processedTerminalTurnIdsLoaded) return;
    this.processedTerminalTurnIdsLoaded = true;

    const global = this.readGlobalState();
    const hasPersistedGlobalState = global.emittedTerminalTurnIds.length > 0;
    for (const turnId of global.emittedTerminalTurnIds) {
      if (this.processedTerminalTurnIds.has(turnId)) continue;
      this.processedTerminalTurnIds.add(turnId);
      this.processedTerminalTurnIdOrder.push(turnId);
    }

    if (hasPersistedGlobalState) return;
    for (const key of this.stateStore.keys()) {
      if (!key.startsWith(`${this.id}:`)) continue;
      const raw = this.stateStore.get(key).extra?.codexTranscript;
      const value = asRecord(raw);
      const emittedTerminalTurnIds = Array.isArray(value?.emittedTerminalTurnIds)
        ? value.emittedTerminalTurnIds
        : [];
      for (const turnId of emittedTerminalTurnIds) {
        if (typeof turnId === 'string') this.rememberGlobalProcessedTerminalTurnId(turnId);
      }
    }
  }

  /** 读取并验证最多 10000 个全局 terminal ID，防止损坏状态或无限增长。 */
  private readGlobalState(): CodexTranscriptGlobalState {
    const raw = this.stateStore.get(this.id).extra?.codexTranscriptGlobal;
    const value = asRecord(raw);
    return {
      emittedTerminalTurnIds: Array.isArray(value?.emittedTerminalTurnIds)
        ? value.emittedTerminalTurnIds
          .filter((item): item is string => typeof item === 'string')
          .slice(0, MAX_GLOBAL_EMITTED_TERMINAL_TURNS)
        : [],
    };
  }

  /** 仅在 dirty 时写回全局去重状态，减少每次轮询的磁盘写入。 */
  private saveGlobalProcessedTerminalTurnIds(): void {
    if (!this.processedTerminalTurnIdsDirty) return;
    const current = this.stateStore.get(this.id);
    this.stateStore.update(this.id, {
      lastOffset: this.processedTerminalTurnIdOrder.length,
      extra: {
        ...(current.extra ?? {}),
        codexTranscriptGlobal: {
          emittedTerminalTurnIds: this.processedTerminalTurnIdOrder,
        },
      },
    });
    this.processedTerminalTurnIdsDirty = false;
  }

  /** 检查 turn 是否已在任意 transcript 文件中处理，调用前确保全局状态已加载。 */
  private isGloballyProcessedTerminalTurn(turnId: string): boolean {
    this.loadGlobalProcessedTerminalTurnIds();
    return this.processedTerminalTurnIds.has(turnId);
  }

  /** 把 turn 放到单文件最近去重列表头部，并裁剪到配置上限。 */
  private rememberProcessedTerminalTurnId(checkpoint: CodexTranscriptCheckpoint, turnId: string): void {
    checkpoint.emittedTerminalTurnIds = [turnId, ...checkpoint.emittedTerminalTurnIds.filter(id => id !== turnId)]
      .slice(0, MAX_EMITTED_TERMINAL_TURNS);
  }

  /** 加入跨文件有界 Set/顺序表；新值会把状态标记为待持久化。 */
  private rememberGlobalProcessedTerminalTurnId(turnId: string, markDirty = true): void {
    if (this.processedTerminalTurnIds.has(turnId)) return;
    this.processedTerminalTurnIds.add(turnId);
    this.processedTerminalTurnIdOrder.unshift(turnId);
    while (this.processedTerminalTurnIdOrder.length > MAX_GLOBAL_EMITTED_TERMINAL_TURNS) {
      const removed = this.processedTerminalTurnIdOrder.pop();
      if (removed) this.processedTerminalTurnIds.delete(removed);
    }
    if (markDirty) this.processedTerminalTurnIdsDirty = true;
  }
}

/**
 * 深度优先递归收集 rollout 文件，结果追加到调用者数组。
 * 目录不存在或临时不可读时按 fail-open 返回，下一轮发现会再次尝试。
 */
async function collectRolloutFiles(dir: string, files: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectRolloutFiles(entryPath, files);
    } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }
}

/** 读取指定半开字节区间内所有完整 JSONL 记录，并返回实际消费到的换行后 offset。 */
async function readJsonLines(filePath: string, startOffset: number, endOffset: number): Promise<{
  items: JsonLine[];
  nextOffset: number;
}> {
  if (endOffset <= startOffset) return { items: [], nextOffset: startOffset };
  const items: JsonLine[] = [];
  const { nextOffset } = await scanJsonLines(filePath, startOffset, endOffset, line => {
    items.push(line);
  });
  return { items, nextOffset };
}

/**
 * 分块扫描 JSONL 文件，在完整换行处解析对象并顺序调用回调。
 *
 * `onLine` 返回 false 时立即停止；末尾没有换行的不完整记录保留到下周期，不推进 nextOffset。
 * 文件句柄在 finally 中关闭。打开或读取失败会向上抛出，由 Input 周期统一记录。
 */
async function scanJsonLines(
  filePath: string,
  startOffset: number,
  endOffset: number,
  onLine: (line: JsonLine) => void | false | Promise<void | false>,
): Promise<{ nextOffset: number }> {
  if (endOffset <= startOffset) return { nextOffset: startOffset };
  const handle = await fs.open(filePath, 'r');
  try {
    let nextOffset = startOffset;
    let position = startOffset;
    let pending = Buffer.alloc(0);
    let pendingStartOffset = startOffset;

    while (position < endOffset) {
      const length = Math.min(READ_CHUNK_SIZE, endOffset - position);
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead <= 0) break;
      position += bytesRead;

      // 上个 chunk 的半行与本次字节拼接后再找换行，避免把跨 chunk JSON 拆成两条坏记录。
      const data = pending.length > 0
        ? Buffer.concat([pending, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead);
      const dataStartOffset = pendingStartOffset;
      let cursor = 0;
      while (cursor < data.length) {
        const newline = data.indexOf(0x0a, cursor);
        if (newline < 0) break;
        const text = data.subarray(cursor, newline).toString('utf8').trim();
        if (text) {
          try {
            const record = JSON.parse(text);
            if (record && typeof record === 'object' && !Array.isArray(record)) {
              const keepGoing = await onLine({
                startOffset: dataStartOffset + cursor,
                endOffset: dataStartOffset + newline + 1,
                record,
              });
              if (keepGoing === false) {
                nextOffset = dataStartOffset + newline + 1;
                return { nextOffset };
              }
            }
          } catch {
            // 已换行但 JSON 无效的记录无法通过继续等待修复：忽略内容，但消费其字节以避免永久卡住。
          }
        }
        nextOffset = dataStartOffset + newline + 1;
        cursor = newline + 1;
      }

      pending = cursor < data.length ? Buffer.from(data.subarray(cursor)) : Buffer.alloc(0);
      pendingStartOffset = dataStartOffset + cursor;
    }

    return { nextOffset };
  } finally {
    await handle.close();
  }
}

/**
 * 从已知 offset 读取一条 JSONL，最多尝试 16 个 64 KiB 块；用于回读 session_meta。
 * 找不到换行、超过上限或 JSON 无效时返回 null，文件句柄始终关闭。
 */
async function readJsonLineAt(filePath: string, offset: number): Promise<Record<string, unknown> | null> {
  const handle = await fs.open(filePath, 'r');
  try {
    const chunks: Buffer[] = [];
    let position = offset;
    for (let attempt = 0; attempt < 16; attempt++) {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
      chunks.push(buffer.subarray(0, newline >= 0 ? newline : bytesRead));
      if (newline >= 0) {
        try {
          const record = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
        } catch {
          return null;
        }
      }
      position += bytesRead;
    }
    return null;
  } finally {
    await handle.close();
  }
}

/** 从 `turn_context` 或 `task_started` 提取 turn 起点 ID，其他记录返回 null。 */
function turnIdForStart(record: Record<string, unknown>, payload: Record<string, unknown>): string | null {
  if (record.type !== 'turn_context' && !(record.type === 'event_msg' && payload.type === 'task_started')) return null;
  return stringValue(payload.turn_id) ?? null;
}

/** 创建新的活跃 turn checkpoint，并初始化四类事件去重数组。 */
function createActiveTurn(
  turnId: string,
  startOffset: number,
  startedAtMs: number,
  emittedPrompt = false,
): CodexActiveTranscriptTurn {
  return {
    turnId,
    startOffset,
    startedAtMs,
    emittedPrompt,
    emittedStepCount: 0,
    emittedStepRequestIds: [],
    emittedStepResponseIds: [],
    emittedToolCallIds: [],
    emittedToolResultIds: [],
  };
}

/** 从 turn_context 增量补充 model、cwd 和 developer instructions。 */
function updateActiveTurnMetadata(
  activeTurn: CodexActiveTranscriptTurn,
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
): void {
  if (record.type !== 'turn_context') return;
  const model = stringValue(payload.model);
  const cwd = stringValue(payload.cwd);
  const developerInstructions = stringValue(payload.developer_instructions);
  if (model) activeTurn.model = model;
  if (cwd) activeTurn.cwd = cwd;
  if (developerInstructions) activeTurn.developerInstructions = developerInstructions;
}

/** 把 checkpoint 中持久化的 turn 元数据转换为 Extractor 的恢复选项。 */
function partialTurnOptions(activeTurn: CodexActiveTranscriptTurn): {
  startedAtMs: number;
  model?: string;
  cwd?: string;
  developerInstructions?: string;
} {
  return {
    startedAtMs: activeTurn.startedAtMs,
    ...(activeTurn.model ? { model: activeTurn.model } : {}),
    ...(activeTurn.cwd ? { cwd: activeTurn.cwd } : {}),
    ...(activeTurn.developerInstructions ? { developerInstructions: activeTurn.developerInstructions } : {}),
  };
}

/** 解析成功后用更完整的 turn 数据回填 checkpoint，但不以 `unknown` 覆盖已有模型。 */
function updateActiveTurnFromExtractedTurn(
  activeTurn: CodexActiveTranscriptTurn,
  turn: { model: string; cwd?: string; developerInstructions?: string },
): void {
  if (turn.model && turn.model !== 'unknown') activeTurn.model = turn.model;
  if (turn.cwd) activeTurn.cwd = turn.cwd;
  if (turn.developerInstructions) activeTurn.developerInstructions = turn.developerInstructions;
}

/** 从 task_complete/turn_aborted 提取 terminal turn ID，其他事件返回 null。 */
function terminalTurnIdFor(record: Record<string, unknown>, payload: Record<string, unknown>): string | null {
  if (record.type !== 'event_msg' || (payload.type !== 'task_complete' && payload.type !== 'turn_aborted')) return null;
  return stringValue(payload.turn_id) ?? null;
}

/** 将未知 JSON 值安全缩窄为普通对象。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** 从旧 checkpoint 中只保留真正的字符串数组元素。 */
function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** 估算事件 UTF-8 JSON 字节数；序列化异常时返回单批上限以强制单独发送。 */
function serializedEntryBytes(entry: AgentActivityEntry): number {
  try {
    return Buffer.byteLength(JSON.stringify(entry), 'utf8');
  } catch {
    return MAX_EMIT_BATCH_BYTES;
  }
}

/** 为首次解析失败的 terminal 创建带时间和诊断计数的重试状态。 */
function newPendingTerminal(
  turnId: string,
  terminalEndOffset: number,
  sourceRecordCount: number,
): CodexPendingTerminalTurn {
  const now = Date.now();
  return {
    turnId,
    terminalEndOffset,
    retryCount: 1,
    firstPendingAtMs: now,
    lastAttemptAtMs: now,
    sourceRecordCount,
  };
}

/** 构造所有统计为 0 的恢复诊断对象，统一不可解析分支的返回结构。 */
function emptySegmentRecoveryDiagnostics(
  sourceRecordCount = 0,
  previouslyEmittedStepCount = 0,
): SegmentRecoveryDiagnostics {
  return {
    sourceRecordCount,
    stepCount: 0,
    toolCount: 0,
    tokenUsageCount: 0,
    unmatchedTokenUsageCount: 0,
    builtEntryCount: 0,
    readyEntryCount: 0,
    deduplicatedEntryCount: 0,
    emittedEntryCount: 0,
    previouslyEmittedStepCount,
  };
}

/**
 * 把白名单 resourceAttributes 附加到事件；存在 worker name 时同时作为 Agent 显示名称。
 * 此函数会原地修改传入事件数组，随后返回同一数组。
 */
function attachWakeupResourceAttributes(
  entries: AgentActivityEntry[],
  resourceAttributes: Record<string, JsonValue>,
): AgentActivityEntry[] {
  const workerName = resourceAttributes['agentteams.worker.name'];
  for (const entry of entries) {
    entry.resourceAttributes = resourceAttributes;
    if (typeof workerName === 'string' && workerName.trim()) {
      entry['gen_ai.agent.name'] = workerName.trim();
    }
  }
  return entries;
}

/**
 * 将 Builder 上下文压缩为可持久化形状：小 delta 直接保存，大 delta 改存可重读的源字节范围。
 */
function persistedInputContext(
  context: CodexTranscriptInputContext,
  sourceRange: CodexTranscriptSourceRange | undefined,
): CodexTranscriptInputContext {
  const delta = context.delta ?? [];
  const deltaBytes = Buffer.byteLength(JSON.stringify(delta), 'utf8');
  return {
    hash: context.hash,
    ...(context.fullMessages ? { fullMessages: context.fullMessages } : {}),
    ...(deltaBytes <= MAX_PERSISTED_INPUT_CONTEXT_BYTES || !sourceRange
      ? { delta }
      : { deltaRange: sourceRange }),
  };
}

/** 验证旧状态中的输入上下文，忽略不认识或类型错误的可选字段。 */
function parseInputContext(value: unknown): CodexTranscriptInputContext | undefined {
  const context = asRecord(value);
  if (!context || typeof context.hash !== 'string') return undefined;
  const range = asRecord(context.deltaRange);
  return {
    hash: context.hash,
    ...(Array.isArray(context.delta) ? { delta: context.delta as JsonValue[] } : {}),
    ...(Array.isArray(context.fullMessages) ? { fullMessages: context.fullMessages as JsonValue[] } : {}),
    ...(range && typeof range.startOffset === 'number' && typeof range.endOffset === 'number'
      ? { deltaRange: { startOffset: range.startOffset, endOffset: range.endOffset } }
      : {}),
  };
}

/** 把不可信 session ID 清洗为单个安全文件名片段，阻止 `..` 或路径分隔符逃逸目录。 */
function safeWakeupSessionPart(value: string): string {
  return path.basename(String(value)).replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
}

/** 根据环境变量或用户主目录计算 Codex wakeup marker 默认目录。 */
function defaultWakeupDir(): string {
  const dataDir = process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
  return path.join(dataDir, 'state', 'codex', 'transcript-wakeups');
}
