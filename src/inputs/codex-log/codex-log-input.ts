/**
 * Codex 旧版 Hook JSONL Input（兼容保留，非当前生产主链）。
 *
 * 当前 Orchestrator 只注册 `CodexTranscriptInput`，Stop Hook 也只写 wakeup marker，不再生成这里
 * 读取的完整 codex JSONL。本类仍供兼容/测试使用，判断当前行为不得沿此入口推导。
 */

import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { transformHookRecord } from '../base/hook-record-transform.js';

/** 旧 `<dataDir>/logs/codex/codex-YYYY-MM-DD.jsonl` 读取器。 */
export class CodexLogInput extends BaseHookInput {
  readonly id = 'codex-log';
  readonly agentType = ClientType.CodexCliHook;

  /** 兼容默认路径和 30 秒周期。 */
  constructor(opts?: Partial<HookInputOptions> & { stateStore: HookInputOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      logDir: opts?.logDir ?? resolveHome('~/.loongsuite-pilot/logs/codex'),
      logPrefix: opts?.logPrefix ?? 'codex',
      pollIntervalMs: opts?.pollIntervalMs ?? 30_000,
    });
  }

  /** 旧日志目录存在时返回 true；不代表 Orchestrator 会注册本类。 */
  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.loongsuite-pilot/logs/codex'));
  }

  /** 旧动态发现 watcher 路径。 */
  static getWatchPaths(): string[] {
    return [resolveHome('~/.loongsuite-pilot/logs/codex')];
  }

  /** 复用共享 Hook 事件转换。 */
  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    return transformHookRecord(record, ClientType.CodexCliHook, 'codex');
  }
}
