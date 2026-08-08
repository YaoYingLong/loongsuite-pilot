/**
 * OpenCode 注入插件 JSONL 的具体 Input。
 *
 * 插件由 DeploymentManager 的 plugin-inject strategy 配置；它写 canonical Hook 记录，本类复用
 * BaseHookInput 增量读取和 transformHookRecord，不直接与 OpenCode 进程通信。
 */

import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { transformHookRecord } from '../base/hook-record-transform.js';

/** OpenCode 插件日志采集器。 */
export class OpenCodeLogInput extends BaseHookInput {
  readonly id = 'opencode-log';
  readonly agentType = ClientType.OpenCode;

  /** 生产默认 30 秒轮询，测试可覆盖路径与周期。 */
  constructor(opts?: Partial<HookInputOptions> & { stateStore: HookInputOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      logDir: opts?.logDir ?? resolveHome('~/.loongsuite-pilot/logs/opencode'),
      logPrefix: opts?.logPrefix ?? 'opencode',
      pollIntervalMs: opts?.pollIntervalMs ?? 30_000,
    });
  }

  /** 插件日志目录存在时可启动。 */
  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.loongsuite-pilot/logs/opencode'));
  }

  /** 动态发现监听路径。 */
  static getWatchPaths(): string[] {
    return [resolveHome('~/.loongsuite-pilot/logs/opencode')];
  }

  /** 使用 OpenCode ClientType 和 `agent.opencode.*` Git namespace。 */
  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    return transformHookRecord(record, ClientType.OpenCode, 'opencode');
  }
}
