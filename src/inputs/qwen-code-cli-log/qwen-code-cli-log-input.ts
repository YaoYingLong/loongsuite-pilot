/**
 * Qwen Code CLI Stop Hook 生成日志的增量 Input。
 *
 * Hook processor 解析 Qwen transcript 后写 canonical JSONL；本类不重新解析 transcript，只负责
 * BaseHookInput offset 与共享转换。Orchestrator 当前注册该 Input。
 */

import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { transformHookRecord } from '../base/hook-record-transform.js';

/**
 * 读取 `qwen-code-cli-YYYY-MM-DD.jsonl`，记录已使用 canonical `gen_ai.*` 字段。
 */
export class QwenCodeCliLogInput extends BaseHookInput {
  readonly id = 'qwen-code-cli-log';
  readonly agentType = ClientType.QwenCodeCli;

  /** 测试可覆盖默认目录、前缀和 30 秒周期。 */
  constructor(opts?: Partial<HookInputOptions> & { stateStore: HookInputOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      logDir: opts?.logDir ?? resolveHome('~/.loongsuite-pilot/logs/qwen-code-cli'),
      logPrefix: opts?.logPrefix ?? 'qwen-code-cli',
      pollIntervalMs: opts?.pollIntervalMs ?? 30_000,
    });
  }

  /** 目录存在表示 Hook 资产已开始产生或准备产生数据。 */
  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.loongsuite-pilot/logs/qwen-code-cli'));
  }

  /** 供 AgentDiscoveryService 建立目录 watcher。 */
  static getWatchPaths(): string[] {
    return [resolveHome('~/.loongsuite-pilot/logs/qwen-code-cli')];
  }

  /** 复用共享转换并选择 qwen-code-cli Git namespace。 */
  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    return transformHookRecord(record, ClientType.QwenCodeCli, 'qwen-code-cli');
  }
}
