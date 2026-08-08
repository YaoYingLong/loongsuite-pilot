/**
 * Codex 中断 turn 的旧独立恢复 Input，仅为兼容、迁移参考和现有测试保留。
 *
 * 重要边界：当前 `Orchestrator.registerAllInputs()` 不创建或注册本类；当前正常和中断 turn 已统一
 * 由 `CodexTranscriptInput` 采集。根导出仍保留 `CodexAbortedTurnInput`，旧配置迁移逻辑也仍能识别
 * `codex-aborted-turn`，但不能据此推断它位于现在的生产调用链。
 *
 * 历史流程：`BaseInput` 定时调用 `collect()` -> 递归发现 `~/.codex/sessions` 下 rollout JSONL ->
 * 按字节 checkpoint 只读取新增完整行 -> 发现目标 `turn_aborted` 后回读该 turn 范围 -> extractor
 * 聚合语义 -> builder 生成 cancelled 标准事件。首次启动对现有文件只做 baseline，避免重放历史。
 *
 * 外部副作用：异步读取 rollout 文件，更新 `StateStore`；恢复失败或正常完成 turn 长期缺少 Hook
 * 状态时，向 diagnostics 目录追加 JSONL。文件轮转通过 inode 检测并重新 baseline；不完整尾行不会
 * 推进游标。大多数单文件/诊断错误会记录或跳过，使后续轮询能够继续。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { buildCodexAbortedTurnEntries } from './codex-aborted-turn-builder.js';
import {
  extractAbortedTurn,
  extractCodexTranscriptMeta,
  sessionIdFromTranscriptPath,
} from './codex-aborted-turn-extractor.js';
import {
  MAX_EMITTED_ABORTED_TURNS,
  MAX_PENDING_COMPLETED_TURNS,
  type CodexAbortedCheckpoint,
} from './codex-aborted-turn-types.js';
import { asRecord, stringValue, timestampMs } from './codex-aborted-turn-utils.js';

const DEFAULT_SESSION_DIR = '~/.codex/sessions';
const DEFAULT_HOOK_STATE_DIR = '~/.loongsuite-pilot/state/codex/sessions';
const DEFAULT_DIAGNOSTIC_DIR = '~/.loongsuite-pilot/logs/diagnostics';
const DEFAULT_HOOK_GAP_GRACE_MS = 60_000;

/**
 * 旧恢复 Input 的路径与时间配置。
 * `sessionDir` 是 rollout 根目录，`hookStateDir` 用于判断 Hook 是否已落状态，`diagnosticDir`
 * 接收异常 JSONL，`hookGapGraceMs` 是完成 turn 等待 Hook 状态的宽限时间。
 */
export interface CodexAbortedTurnInputOptions extends InputOptions {
  sessionDir?: string;
  hookStateDir?: string;
  diagnosticDir?: string;
  hookGapGraceMs?: number;
}

/** 一条已成功解析的完整 JSONL 行，同时保留字节起止位置供 checkpoint 和范围回读使用。 */
interface JsonLine {
  startOffset: number;
  endOffset: number;
  record: Record<string, unknown>;
}

/**
 * 旧版 Codex rollout 增量 tailer 和中断 turn 恢复协调器。
 *
 * 类继承 `BaseInput` 的定时器和 entries 事件机制；自身不创建子进程或网络连接。`collecting`
 * 缓存当前 Promise，避免短轮询间隔导致两个扫描周期并发修改 checkpoint。每个 rollout 文件使用
 * 独立状态键，因此文件间互不覆盖；停止时由 BaseInput 等待当前异步周期。
 */
export class CodexAbortedTurnInput extends BaseInput {
  readonly id = 'codex-aborted-turn';
  readonly agentType = ClientType.CodexCliHook;
  readonly collectionMethod = CollectionMethod.SessionFilePolling;

  private readonly sessionDir: string;
  private readonly hookStateDir: string;
  private readonly diagnosticDir: string;
  private readonly hookGapGraceMs: number;
  private collecting: Promise<AgentActivityEntry[]> | null = null;

  /**
   * 保存路径和宽限配置，不立即访问文件系统。
   * @param opts 状态存储和可选路径；轮询默认 30 秒，Hook 缺失宽限默认 60 秒。
   */
  constructor(opts: CodexAbortedTurnInputOptions) {
    super({
      stateStore: opts.stateStore,
      pollIntervalMs: opts.pollIntervalMs ?? 30_000,
    });
    this.sessionDir = opts.sessionDir ?? resolveHome(DEFAULT_SESSION_DIR);
    this.hookStateDir = opts.hookStateDir ?? resolveHome(DEFAULT_HOOK_STATE_DIR);
    this.diagnosticDir = opts.diagnosticDir ?? resolveHome(DEFAULT_DIAGNOSTIC_DIR);
    this.hookGapGraceMs = opts.hookGapGraceMs ?? DEFAULT_HOOK_GAP_GRACE_MS;
  }

  /** @returns 历史发现服务用于监听的默认 Codex session 目录。 */
  static getWatchPaths(): string[] {
    return [resolveHome(DEFAULT_SESSION_DIR)];
  }

  /**
   * 异步检查默认 session 目录是否存在。
   * @returns 目录存在时为 `true`；工具函数把不可访问等情况折叠为 `false`。
   */
  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome(DEFAULT_SESSION_DIR));
  }

  /**
   * 为所有首次见到的 rollout 文件建立文件末尾 baseline，防止启动时回放历史中断 turn。
   * 已有 checkpoint 的文件会保留 active turn，从而支持进程重启后继续恢复。
   */
  protected override async onStart(): Promise<void> {
    for (const filePath of await this.discoverSessionFiles()) {
      const key = this.stateKey(filePath);
      if (this.readCheckpoint(key)) continue;
      await this.baselineFile(filePath, key);
    }
  }

  /**
   * BaseInput 定时调用的防重入口；已有扫描在执行时复用同一个 Promise，而不是再次启动扫描。
   * `finally` 确保成功或异常后都清空标记，async 异常继续传播给 BaseInput 的周期错误处理。
   * @returns 本轮所有文件恢复出的标准事件。
   */
  protected override async collect(): Promise<AgentActivityEntry[]> {
    if (this.collecting) return this.collecting;
    this.collecting = this.collectOnce().finally(() => {
      this.collecting = null;
    });
    return this.collecting;
  }

  /** 递归发现并按排序顺序串行处理 rollout 文件，汇总每个文件的恢复结果。 */
  private async collectOnce(): Promise<AgentActivityEntry[]> {
    const entries: AgentActivityEntry[] = [];
    for (const filePath of await this.discoverSessionFiles()) {
      entries.push(...await this.processFile(filePath));
    }
    return entries;
  }

  /**
   * 增量扫描一个 rollout 文件并推进 checkpoint。
   * inode 改变表示文件被替换，先重新 baseline；只消费以换行结束的完整 JSON；正常完成 turn 进入
   * Hook 缺失观察队列，中断 turn 则触发恢复。文件 `stat` 失败按暂时不可用返回空数组。
   * @param filePath rollout JSONL 绝对路径。
   * @returns 本文件本轮恢复出的事件；同时更新内存 StateStore 状态。
   */
  private async processFile(filePath: string): Promise<AgentActivityEntry[]> {
    // checkpoint 以完整路径为命名空间；同一天生成的多个 rollout 文件不会共享游标。
    const key = this.stateKey(filePath);
    let stat;
    try {
      // inode 用于识别“路径相同、实体已被轮转替换”的情况，size 用于限定本轮读取上界。
      stat = await fs.stat(filePath);
    } catch {
      // 文件可能在目录扫描后被 Codex 删除或移动；将它视为本轮无数据，不阻断其他文件。
      return [];
    }

    let checkpoint = this.readCheckpoint(key);
    if (!checkpoint) {
      // 没有持久化状态时从文件头扫描；正常启动会先执行 onStart() 建立文件末尾 baseline，
      // 因而该分支主要覆盖“启动后新建文件”和状态文件被清理的场景。
      checkpoint = {
        inode: stat.ino,
        scanOffset: 0,
        activeTurn: null,
        latestSessionMetaOffset: null,
        latestSessionId: null,
        emittedAbortedTurnIds: [],
        pendingCompletedTurns: [],
        emittedHookGapTurnIds: [],
      };
    } else if (checkpoint.inode !== stat.ino) {
      // 文件轮转后旧 offset 对新文件没有意义。直接在新文件末尾重建 baseline，可避免误重放历史内容。
      await this.baselineFile(filePath, key);
      return [];
    }

    if (stat.size <= checkpoint.scanOffset) {
      // 即使没有新增 transcript，也要推进基于时间的 Hook 缺失检查，否则诊断只能等下一次写文件才触发。
      await this.emitDueHookGapWarnings(checkpoint);
      this.saveCheckpoint(key, checkpoint);
      return [];
    }
    // 固定本轮终点为 stat.size；Codex 在读取期间继续追加的数据留给下一轮，避免边读边追造成饥饿。
    const lines = await readJsonLines(filePath, checkpoint.scanOffset, stat.size);
    // 尾部若只有半行，readJsonLines 不推进 nextOffset；下一轮会从同一字节重新读取完整 JSON。
    if (lines.nextOffset === checkpoint.scanOffset) return [];

    const entries: AgentActivityEntry[] = [];
    for (const line of lines.items) {
      // rollout 是外部数据源，payload 必须先做运行时类型收窄，不能仅依赖 TypeScript 静态类型。
      const payload = asRecord(line.record.payload);
      if (!payload) continue;
      if (line.record.type === 'session_meta') {
        // 只保存最近 meta 的字节位置，真正恢复 turn 时再按需回读，避免把大段说明长期放进 checkpoint。
        checkpoint.latestSessionMetaOffset = line.startOffset;
        checkpoint.latestSessionId = extractCodexTranscriptMeta(line.record)?.sessionId ?? checkpoint.latestSessionId;
        continue;
      }

      if (line.record.type === 'event_msg' && payload.type === 'task_started') {
        const turnId = stringValue(payload.turn_id);
        if (turnId && (!checkpoint.activeTurn || checkpoint.activeTurn.turnId !== turnId)) {
          // task_started 是首选边界；保存行首 offset 后，中断时即可回读该 turn 的全部记录。
          checkpoint.activeTurn = {
            turnId,
            startOffset: line.startOffset,
            startedAtMs: timestampMs(line.record) ?? Date.now(),
          };
        }
        continue;
      }

      if (line.record.type === 'turn_context') {
        const turnId = stringValue(payload.turn_id);
        if (turnId && (!checkpoint.activeTurn || checkpoint.activeTurn.turnId !== turnId)) {
          // 某些 transcript 可能缺少 task_started，turn_context 作为兼容起点保证仍可恢复。
          checkpoint.activeTurn = {
            turnId,
            startOffset: line.startOffset,
            startedAtMs: timestampMs(line.record) ?? Date.now(),
          };
        }
        continue;
      }

      // 后续两个终态都属于 event_msg；其他 response_item 已在发生中断后通过范围回读统一解析。
      if (line.record.type !== 'event_msg') continue;
      if (payload.type === 'task_complete') {
        const turnId = stringValue(payload.turn_id);
        if (turnId && checkpoint.activeTurn?.turnId === turnId && !checkpoint.emittedHookGapTurnIds.includes(turnId)) {
          // 正常完成的数据应由 Hook 主链采集；这里仅暂存一个观察项，宽限期后检查 Hook 是否确实落盘。
          checkpoint.pendingCompletedTurns.push({
            turnId,
            sessionId: checkpoint.latestSessionId ?? sessionIdFromTranscriptPath(filePath),
            completedAtMs: timestampMs(line.record) ?? Date.now(),
          });
          // checkpoint 有固定上限，防止 Hook 长期不可用时状态文件无限增长。
          checkpoint.pendingCompletedTurns = checkpoint.pendingCompletedTurns
            .slice(-MAX_PENDING_COMPLETED_TURNS);
          // task_complete 关闭当前 turn；之后的记录必须等待新的起点才能参与恢复。
          checkpoint.activeTurn = null;
        }
        continue;
      }
      // 旧链路只为中断恢复服务，普通 event_msg 在此无需处理。
      if (payload.type !== 'turn_aborted') continue;
      const turnId = stringValue(payload.turn_id);
      // 终态必须与正在跟踪的 turn 一致，避免把相邻 turn 的记录拼接到一起。
      if (!turnId || checkpoint.activeTurn?.turnId !== turnId) continue;
      if (!checkpoint.emittedAbortedTurnIds.includes(turnId)) {
        // 回读范围在 abort 行末结束，保证 extractor 能看到中断原因和精确时间。
        const recovered = await this.recoverTurn(filePath, checkpoint, line.endOffset);
        if (recovered.length > 0) {
          entries.push(...recovered);
          // 只有构建成功才加入去重集合；失败保留诊断，但当前扫描游标仍会前进。
          checkpoint.emittedAbortedTurnIds = [turnId, ...checkpoint.emittedAbortedTurnIds]
            .slice(0, MAX_EMITTED_ABORTED_TURNS);
        } else {
          await this.emitRecoveryFailureDiagnostic(filePath, turnId, line.record);
        }
      }
      // 无论已输出、恢复失败还是命中去重，中断终态都结束 active turn。
      checkpoint.activeTurn = null;
    }

    // nextOffset 只指向最后一个完整换行之后；半行会原样留给下一轮。
    checkpoint.scanOffset = lines.nextOffset;
    // 终态处理完成后顺带检查历史 pending，随后一次性保存本文件所有状态变化。
    await this.emitDueHookGapWarnings(checkpoint);
    this.saveCheckpoint(key, checkpoint);
    return entries;
  }

  /**
   * 从 active turn 起始 offset 回读到 abort 行末尾，并调用 extractor + builder 完成恢复。
   * session meta 从已记录的行位置以 64 KiB 起步按单行长度扩容，不会为该位置之后的整个历史尾部
   * 一次性分配缓冲区。
   * @returns 可输出事件；缺少 active turn 或提取失败时返回空数组。
   */
  private async recoverTurn(
    filePath: string,
    checkpoint: CodexAbortedCheckpoint,
    abortEndOffset: number,
  ): Promise<AgentActivityEntry[]> {
    const activeTurn = checkpoint.activeTurn;
    if (!activeTurn) return [];
    // 只回读当前 turn 的闭区间，而不是重新解析整个可能很大的 rollout 文件。
    const range = await readJsonLines(filePath, activeTurn.startOffset, abortEndOffset);
    // meta 不一定紧邻 turn，因此使用扫描时保存的绝对字节位置单独读取。
    const metaRecord = checkpoint.latestSessionMetaOffset === null
      ? null
      : await readJsonLineAt(filePath, checkpoint.latestSessionMetaOffset);
    // meta 缺失不会阻止恢复；extractor 会使用文件名推导的 session ID 和默认 provider。
    const meta = metaRecord ? extractCodexTranscriptMeta(metaRecord) : null;
    // extractor 负责识别 rollout 协议，builder 再把中间模型转换成统一 AgentActivityEntry。
    const turn = extractAbortedTurn(
      range.items.map(line => line.record),
      meta,
      sessionIdFromTranscriptPath(filePath),
      activeTurn.turnId,
    );
    return turn ? buildCodexAbortedTurnEntries(turn) : [];
  }

  /**
   * 扫描既有完整行以定位最近 session meta，然后把游标直接放到当前文件末尾。
   * 这一步只建立起点、不输出历史事件；`stat` 失败时等待以后重新发现。
   */
  private async baselineFile(filePath: string, key: string): Promise<void> {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return;
    }
    const lines = await readJsonLines(filePath, 0, stat.size);
    let latestSessionMetaOffset: number | null = null;
    for (const line of lines.items) {
      if (line.record.type === 'session_meta') latestSessionMetaOffset = line.startOffset;
    }
    this.saveCheckpoint(key, {
      inode: stat.ino,
      scanOffset: stat.size,
      activeTurn: null,
      latestSessionMetaOffset,
      latestSessionId: null,
      emittedAbortedTurnIds: [],
      pendingCompletedTurns: [],
      emittedHookGapTurnIds: [],
    });
  }

  /** @returns 递归发现并排序后的 `rollout-*.jsonl` 路径，目录不可读时得到空数组。 */
  private async discoverSessionFiles(): Promise<string[]> {
    const files: string[] = [];
    await collectRolloutFiles(this.sessionDir, files);
    return files.sort();
  }

  /** 为每个文件构造独立 StateStore 键，路径参与键值可避免多个 rollout 游标互相覆盖。 */
  private stateKey(filePath: string): string {
    return `${this.id}:${filePath}`;
  }

  /**
   * 从 StateStore 读取并逐字段校验 checkpoint；不可信或旧版本字段使用安全默认值。
   * @returns 至少含合法 inode/offset 时返回规范对象，否则返回 `null` 触发初始化。
   */
  private readCheckpoint(key: string): CodexAbortedCheckpoint | null {
    const raw = this.stateStore.get(key).extra?.codexAbortedTurn;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    if (typeof value.inode !== 'number' || typeof value.scanOffset !== 'number') return null;
    const active = asRecord(value.activeTurn);
    const activeTurn = active
      && typeof active.turnId === 'string'
      && typeof active.startOffset === 'number'
      && typeof active.startedAtMs === 'number'
      ? { turnId: active.turnId, startOffset: active.startOffset, startedAtMs: active.startedAtMs }
      : null;
    return {
      inode: value.inode,
      scanOffset: value.scanOffset,
      activeTurn,
      latestSessionMetaOffset: typeof value.latestSessionMetaOffset === 'number'
        ? value.latestSessionMetaOffset
        : null,
      latestSessionId: typeof value.latestSessionId === 'string' ? value.latestSessionId : null,
      emittedAbortedTurnIds: Array.isArray(value.emittedAbortedTurnIds)
        ? value.emittedAbortedTurnIds.filter((id): id is string => typeof id === 'string')
          .slice(0, MAX_EMITTED_ABORTED_TURNS)
        : [],
      pendingCompletedTurns: readCompletedTurns(value.pendingCompletedTurns),
      emittedHookGapTurnIds: Array.isArray(value.emittedHookGapTurnIds)
        ? value.emittedHookGapTurnIds.filter((id): id is string => typeof id === 'string')
          .slice(0, MAX_PENDING_COMPLETED_TURNS)
        : [],
    };
  }

  /**
   * 把专用 checkpoint 合并到现有 `extra`，并同步 `lastOffset` 供通用状态查看。
   * 这里只更新 StateStore 内存状态，实际落盘时机由上层状态存储生命周期控制。
   */
  private saveCheckpoint(key: string, checkpoint: CodexAbortedCheckpoint): void {
    const current = this.stateStore.get(key);
    this.stateStore.update(key, {
      lastOffset: checkpoint.scanOffset,
      extra: {
        ...(current.extra ?? {}),
        codexAbortedTurn: checkpoint,
      },
    });
  }

  /**
   * 检查正常完成 turn 是否在宽限期后仍没有对应 Hook 状态，并追加一次诊断 JSONL。
   * 尚在宽限期或写诊断失败的项目继续留在 pending；已经存在 Hook 状态或诊断成功的项目移除。
   * 该方法会原地更新传入 checkpoint 的 pending/去重数组。
   */
  private async emitDueHookGapWarnings(checkpoint: CodexAbortedCheckpoint): Promise<void> {
    // 同一轮检查共用 now，保证多个 pending 项目的宽限期判断基准一致。
    const now = Date.now();
    // 使用新数组重建待观察集合：已确认有 Hook 状态或已成功写诊断的项不会再次进入。
    const pending: typeof checkpoint.pendingCompletedTurns = [];
    for (const completed of checkpoint.pendingCompletedTurns) {
      if (now - completed.completedAtMs < this.hookGapGraceMs) {
        // 宽限期内允许 Hook 异步落盘，暂不产生误报警。
        pending.push(completed);
        continue;
      }
      // Hook 状态存在说明主链已接管该正常 turn，无需旧恢复链路输出或报警。
      if (await this.hasHookState(completed.sessionId)) continue;
      try {
        // recursive 使首次运行时可以同时创建多级诊断目录，并且目录已存在也不报错。
        await fs.mkdir(this.diagnosticDir, { recursive: true });
        // 按完成日期分片，便于保留策略处理；appendFile 保留同日其他 turn 的诊断。
        const day = new Date(completed.completedAtMs).toISOString().slice(0, 10);
        await fs.appendFile(path.join(this.diagnosticDir, `codex-hook-gap-${day}.jsonl`), JSON.stringify({
          type: 'codex_hook_missing',
          session_id: completed.sessionId,
          transcript_turn_id: completed.turnId,
          completed_at: new Date(completed.completedAtMs).toISOString(),
          detected_at: new Date(now).toISOString(),
        }) + '\n', 'utf8');
        this.logger.warn('Codex Hook state missing for completed transcript turn', {
          sessionId: completed.sessionId,
          transcriptTurnId: completed.turnId,
        });
        // 诊断成功后记录 turn ID；数组截断限制 checkpoint 体积。
        checkpoint.emittedHookGapTurnIds = [completed.turnId, ...checkpoint.emittedHookGapTurnIds]
          .slice(0, MAX_PENDING_COMPLETED_TURNS);
      } catch (error) {
        // 写盘失败不能丢失观察项：保留到 pending，下一轮仍可重试。
        this.logger.warn('failed to write Codex Hook gap diagnostic', {
          sessionId: completed.sessionId,
          transcriptTurnId: completed.turnId,
          error: String(error),
        });
        pending.push(completed);
      }
    }
    // 原地替换使调用者随后 saveCheckpoint 时持久化本轮筛选结果。
    checkpoint.pendingCompletedTurns = pending;
  }

  /**
   * 中断行存在但 extractor/builder 无法生成事件时，追加带日期分片的恢复失败诊断。
   * 诊断写入本身失败只记录 warning，不遮蔽后续文件和轮询周期。
   */
  private async emitRecoveryFailureDiagnostic(
    filePath: string,
    turnId: string,
    abortRecord: Record<string, unknown>,
  ): Promise<void> {
    const reason = timestampMs(abortRecord) === undefined
      ? 'missing_or_invalid_abort_timestamp'
      : 'no_entries_recovered';
    try {
      await fs.mkdir(this.diagnosticDir, { recursive: true });
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      await fs.appendFile(path.join(this.diagnosticDir, `codex-aborted-turn-recovery-failed-${day}.jsonl`), JSON.stringify({
        type: 'codex_aborted_turn_recovery_failed',
        transcript_path: filePath,
        transcript_turn_id: turnId,
        reason,
        detected_at: now.toISOString(),
      }) + '\n', 'utf8');
      this.logger.warn('Codex aborted turn recovery produced no entries', { filePath, turnId, reason });
    } catch (error) {
      this.logger.warn('failed to write Codex aborted turn recovery diagnostic', {
        filePath,
        turnId,
        error: String(error),
      });
    }
  }

  /** 通过访问 `<hookStateDir>/<sessionId>.json` 判断 Hook 是否已成功记录该 session。 */
  private async hasHookState(sessionId: string): Promise<boolean> {
    try {
      await fs.access(path.join(this.hookStateDir, `${sessionId}.json`));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 深度优先递归收集 `rollout-*.jsonl`，结果写入调用方提供的数组。
 * 目录不存在、权限不足或读取失败时直接返回，使一个坏目录不会终止整轮扫描。
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

/**
 * 按字节范围读取 JSONL，只解析最后一个换行之前的完整行。
 * @returns 成功解析的行及安全的下一 offset；无完整尾行时游标保持不变。
 * @throws 文件打开或读取失败；`finally` 始终关闭文件句柄。
 */
async function readJsonLines(filePath: string, startOffset: number, endOffset: number): Promise<{
  items: JsonLine[];
  nextOffset: number;
}> {
  if (endOffset <= startOffset) return { items: [], nextOffset: startOffset };
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(endOffset - startOffset);
    await handle.read(buffer, 0, buffer.length, startOffset);
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < 0) return { items: [], nextOffset: startOffset };
    const items: JsonLine[] = [];
    let cursor = 0;
    while (cursor <= lastNewline) {
      const newline = buffer.indexOf(0x0a, cursor);
      if (newline < 0 || newline > lastNewline) break;
      const text = buffer.subarray(cursor, newline).toString('utf8').trim();
      const lineStart = startOffset + cursor;
      const lineEnd = startOffset + newline + 1;
      if (text) {
        try {
          const record = JSON.parse(text);
          if (record && typeof record === 'object' && !Array.isArray(record)) {
            items.push({ startOffset: lineStart, endOffset: lineEnd, record });
          }
        } catch {
          // 已完整换行但 JSON 无效的行会被跳过；仍推进游标，避免每轮重复解析同一坏行。
        }
      }
      cursor = newline + 1;
    }
    return { items, nextOffset: startOffset + lastNewline + 1 };
  } finally {
    await handle.close();
  }
}

/**
 * 从指定 offset 回读单行，缓冲区从 64 KiB 按需倍增但不会超过文件剩余大小。
 * @returns 完整且合法的对象行；没有换行、JSON 无效或 offset 到达末尾时返回 `null`。
 */
async function readJsonLineAt(filePath: string, offset: number): Promise<Record<string, unknown> | null> {
  const stat = await fs.stat(filePath);
  const available = stat.size - offset;
  if (available <= 0) return null;
  const handle = await fs.open(filePath, 'r');
  try {
    let size = Math.min(64 * 1024, available);
    while (size > 0) {
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, offset);
      const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
      if (newline >= 0) {
        try {
          return asRecord(JSON.parse(buffer.subarray(0, newline).toString('utf8')));
        } catch {
          return null;
        }
      }
      if (bytesRead < size || size === available) return null;
      size = Math.min(size * 2, available);
    }
    return null;
  } finally {
    await handle.close();
  }
}

/** 校验旧状态中的 completed turn 数组并裁剪到上限，丢弃字段缺失或类型错误的项目。 */
function readCompletedTurns(value: unknown): CodexAbortedCheckpoint['pendingCompletedTurns'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const record = asRecord(item);
    const turnId = record && stringValue(record.turnId);
    const sessionId = record && stringValue(record.sessionId);
    const completedAtMs = record?.completedAtMs;
    return turnId && sessionId && typeof completedAtMs === 'number'
      ? [{ turnId, sessionId, completedAtMs }]
      : [];
  }).slice(-MAX_PENDING_COMPLETED_TURNS);
}
