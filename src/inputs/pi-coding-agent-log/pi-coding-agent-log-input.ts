/**
 * Pi Coding Agent Extension 注入日志的具体 Input。
 *
 * assets/plugins/pi-coding-agent 写 canonical JSONL；本类按实际 dataDir 解析路径，启动时以 0700
 * 创建目录，随后由 BaseHookInput 增量读取。Windows 不应用 POSIX chmod。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { transformHookRecord } from '../base/hook-record-transform.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';

/** 未显式传入/设置环境变量时的数据根。 */
const DEFAULT_PILOT_DATA_DIR = '~/.loongsuite-pilot';

/** 在 HookInputOptions 基础上要求 stateStore，并允许直接传 dataDir。 */
export type PiCodingAgentLogInputOptions =
  Omit<Partial<HookInputOptions>, 'stateStore'>
  & Pick<HookInputOptions, 'stateStore'>
  & { dataDir?: string };

/** 按“参数 > 环境变量 > 默认值”解析 Pi 日志目录。 */
export function resolvePiCodingAgentLogDir(dataDir?: string): string {
  const resolvedDataDir = resolveHome(
    dataDir || process.env.LOONGSUITE_PILOT_DATA_DIR || DEFAULT_PILOT_DATA_DIR,
  );
  return path.join(resolvedDataDir, 'logs', 'pi-coding-agent');
}

/** 递归创建日志目录，并在 POSIX 上强制仅当前用户可访问。 */
export async function ensurePiCodingAgentLogDir(logDir: string): Promise<void> {
  await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.chmod(logDir, 0o700);
}

/** Pi 扩展写出的 JSONL 日志输入。 */
export class PiCodingAgentLogInput extends BaseHookInput {
  readonly id = 'pi-coding-agent-log';
  readonly agentType = ClientType.PiCodingAgent;

  /** @throws 缺少共享 StateStore 时同步抛 TypeError，防止无 checkpoint 运行。 */
  constructor(opts: PiCodingAgentLogInputOptions) {
    if (!opts?.stateStore) {
      throw new TypeError('PiCodingAgentLogInput requires a stateStore');
    }
    super({
      stateStore: opts.stateStore,
      logDir: opts.logDir ?? resolvePiCodingAgentLogDir(opts.dataDir),
      logPrefix: opts.logPrefix ?? 'pi-coding-agent',
      pollIntervalMs: opts.pollIntervalMs ?? 30_000,
    });
  }

  /** 按同一 dataDir 规则判断日志目录。 */
  static async checkAvailability(dataDir?: string): Promise<boolean> {
    return directoryExists(resolvePiCodingAgentLogDir(dataDir));
  }

  /** 供发现服务监听的实际日志目录。 */
  static getWatchPaths(dataDir?: string): string[] {
    return [resolvePiCodingAgentLogDir(dataDir)];
  }

  /** 覆盖基类 ensureDir，额外施加 0700 权限。 */
  protected override async onStart(): Promise<void> {
    await ensurePiCodingAgentLogDir(this.logDir);
  }

  /** 使用 Pi ClientType 和 `agent.pi-coding-agent.*` Git namespace。 */
  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    return transformHookRecord(record, ClientType.PiCodingAgent, 'pi-coding-agent');
  }
}
