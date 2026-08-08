/**
 * Kiro CLI delayedCollect 子进程生成 JSONL 的具体 Input。
 *
 * Kiro session 解析在 daemon 自有子进程中完成，因此 Collector 不运行就不会新增该日志；这使
 * `coldStartKeepLastTurnOnly` 对本数据源安全，可避免状态丢失后重放旧 turn。
 */

import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { transformHookRecord } from '../base/hook-record-transform.js';

/** Kiro CLI Hook 标准日志采集器。 */
export class KiroCliLogInput extends BaseHookInput {
  readonly id = 'kiro-cli-log';
  readonly agentType = ClientType.KiroCli;

  // 日志由 daemon delayedCollect 写入；无 daemon 就无新记录，冷启动可安全只保留最后 turn。
  protected coldStartKeepLastTurnOnly = true;

  /** 配置标准日志路径/前缀和 30 秒轮询。 */
  constructor(opts?: Partial<HookInputOptions> & { stateStore: HookInputOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      logDir: opts?.logDir ?? resolveHome('~/.loongsuite-pilot/logs/kiro-cli'),
      logPrefix: opts?.logPrefix ?? 'kiro-cli',
      pollIntervalMs: opts?.pollIntervalMs ?? 30_000,
    });
  }

  /** 日志目录存在即表示 Input 可用。 */
  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.loongsuite-pilot/logs/kiro-cli'));
  }

  /** 发现服务监听的标准目录。 */
  static getWatchPaths(): string[] {
    return [resolveHome('~/.loongsuite-pilot/logs/kiro-cli')];
  }

  /** 复用共享转换和 kiro-cli Git namespace。 */
  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    return transformHookRecord(record, ClientType.KiroCli, 'kiro-cli');
  }
}
