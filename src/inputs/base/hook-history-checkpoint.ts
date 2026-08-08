/**
 * Hook history 首次启动的确定性消费边界。
 *
 * checkpoint 缺失而日志已存在时，无法判断哪些行在状态丢失前已发送；本策略选择 no-replay，
 * 把现有字节整体 baseline。文件尚未创建时持久化 offset 0，确保启动后首批能够消费。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { InputState } from '../../types/index.js';
import { getTodayDateString } from '../../utils/fs-utils.js';

/** 创建结果同时返回新状态和跳过字节数，供调用方记录诊断。 */
export interface HookHistoryStartupCheckpoint {
  state: InputState;
  skippedExistingBytes: number;
}

/**
 * 在首轮采集前建立 startup checkpoint。
 *
 * @returns 已有可用 checkpoint 时为 null；否则返回应持久化的新状态。
 * @throws stat 出现 ENOENT 之外错误时向上抛出，由 Input 启动层处理。
 */
export async function createHookHistoryStartupCheckpoint(
  current: InputState,
  logDir: string,
  logPrefix: string,
): Promise<HookHistoryStartupCheckpoint | null> {
  if (hasUsableCheckpoint(current)) return null;

  const logFileName = `${logPrefix}-${getTodayDateString()}.jsonl`;
  const logFile = path.join(logDir, logFileName);
  let existingBytes = 0;
  try {
    existingBytes = (await fs.stat(logFile)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Hook 会延迟创建当天文件；现在写 offset 0，可在多 session 追加前标记初始化完成。
  }

  return {
    state: {
      ...current,
      lastFile: logFileName,
      lastOffset: existingBytes,
      extra: {
        ...(current.extra ?? {}),
        hookHistoryInitialized: true,
      },
    },
    skippedExistingBytes: existingBytes,
  };
}

/** lastFile 非空且 lastOffset 为非负有限数时视为可恢复 checkpoint。 */
function hasUsableCheckpoint(state: InputState): boolean {
  return typeof state.lastFile === 'string'
    && state.lastFile.length > 0
    && Number.isFinite(state.lastOffset)
    && (state.lastOffset ?? -1) >= 0;
}
