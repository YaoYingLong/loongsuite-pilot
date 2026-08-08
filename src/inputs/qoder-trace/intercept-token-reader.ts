/**
 * 读取 Qoder Hook/API 拦截产生的 token 与 system prompt 样本。
 *
 * 本模块每次读取整个 JSONL，再按 `sinceTs` 或默认两小时窗口过滤；它不维护 offset/checkpoint。
 * 文件超过 10 MiB 时轮转为 `.old` 后返回空结果，调用方把缺失样本视为可降级状态。
 */
import * as fs from 'node:fs/promises';
import { resolveHome } from '../../utils/fs-utils.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('InterceptTokenReader');

const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 默认只读取最近 2 小时，减少旧请求误匹配。
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 达到 10 MiB 后轮转，限制一次性 readFile 的内存占用。

export interface InterceptTokenData {
  id: string;
  ts: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface InterceptSystemPrompt {
  ts: number;
  content: string;
}

export interface InterceptData {
  tokens: InterceptTokenData[];
  systemPrompt: InterceptSystemPrompt | null;
}

// qodercli 与 QoderWork 使用不同拦截文件，避免 CLI 和 GUI worker 的 ID 命名空间混淆及并发写干扰。
/** 根据 Pilot 数据目录和调用者提供的文件名计算拦截日志绝对路径。 */
export function getInterceptFile(filename = 'qodercli-intercept.jsonl'): string {
  return resolveHome(`~/.loongsuite-pilot/logs/${filename}`);
}

/** 读取默认 Pilot logs 下的拦截文件；参数会原样传给底层文件读取函数。 */
export async function readInterceptData(sinceTs?: number, filename?: string): Promise<InterceptData> {
  return readInterceptFile(getInterceptFile(filename), sinceTs);
}

/**
 * 解析一个拦截 JSONL，返回时间窗口内 token 样本和最后观察到的 system prompt。
 * 文件不存在、无法读取或轮转时返回空结构；单行 JSON 损坏只跳过该行。
 */
export async function readInterceptFile(filePath: string, sinceTs?: number): Promise<InterceptData> {
  const result: InterceptData = { tokens: [], systemPrompt: null };

  let content: string;
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_FILE_SIZE) {
      const oldPath = filePath + '.old';
      try { await fs.unlink(oldPath); } catch {}
      await fs.rename(filePath, oldPath);
      logger.info('intercept file rotated (exceeded 10MB)');
      return result;
    }
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return result;
  }

  const cutoff = sinceTs ?? (Date.now() - MAX_AGE_MS);

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const ts = record.ts as number;
      if (ts < cutoff) continue;

      if (record.type === 'token') {
        result.tokens.push({
          id: record.id as string,
          ts,
          promptTokens: (record.prompt_tokens as number) || 0,
          completionTokens: (record.completion_tokens as number) || 0,
          cachedTokens: (record.cached_tokens as number) || 0,
          reasoningTokens: (record.reasoning_tokens as number) || 0,
          totalTokens: (record.total_tokens as number) || 0,
        });
      } else if (record.type === 'system_prompt') {
        // 同一 Agent 配置下各 qodercli session 的 system prompt 相同，因此无需按 session 分组；
        // 顺序扫描后保留时间窗口内最后一条即可。
        result.systemPrompt = {
          ts,
          content: record.content as string,
        };
      }
    } catch {
      continue;
    }
  }

  return result;
}
