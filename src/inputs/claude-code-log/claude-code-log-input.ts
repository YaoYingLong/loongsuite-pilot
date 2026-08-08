/**
 * Claude Code Hook JSONL 的具体 Input。
 *
 * Orchestrator 注册本类，AgentDiscoveryService 在日志目录出现后启动它。BaseHookInput 负责
 * offset/轮转，本类只提供默认路径、发现路径和共享 canonical 转换参数。
 */

import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { transformHookRecord } from '../base/hook-record-transform.js';

/** 读取 `<dataDir>/logs/claude-code/claude-code-YYYY-MM-DD.jsonl`。 */
export class ClaudeCodeLogInput extends BaseHookInput {
  readonly id = 'claude-code-log';
  readonly agentType = ClientType.ClaudeCliHook;

  /** 允许测试覆盖路径/周期；生产使用标准用户数据目录。 */
  constructor(opts?: Partial<HookInputOptions> & { stateStore: HookInputOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      logDir: opts?.logDir ?? resolveHome('~/.loongsuite-pilot/logs/claude-code'),
      logPrefix: opts?.logPrefix ?? 'claude-code',
      pollIntervalMs: opts?.pollIntervalMs ?? 30_000,
    });
  }

  /** 日志目录存在即认为数据源可用，Hook 文件可稍后延迟创建。 */
  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.loongsuite-pilot/logs/claude-code'));
  }

  /** 发现服务监听的目录。 */
  static getWatchPaths(): string[] {
    return [resolveHome('~/.loongsuite-pilot/logs/claude-code')];
  }

  /** 委托共享 Hook 转换，并从 `agent.claude-code.*` 查 Git 上下文。 */
  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    return transformHookRecord(record, ClientType.ClaudeCliHook, 'claude-code');
  }
}
