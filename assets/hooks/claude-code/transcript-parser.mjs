// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * transcript-parser.mjs — Claude Code 原生 transcript JSONL 的增量解析器。
 *
 * 所属流程与调用关系：
 * 1. Claude Code 把完整会话持续追加到
 *    `~/.claude/projects/<project-hash>/<sessionId>.jsonl`；
 * 2. Claude Code 触发 `Stop` Hook 后，`claude-code-hook-processor.mjs` 的 `exportSession()`
 *    调用本文件导出的 `parseClaudeTranscript()`；
 * 3. 本模块从上次已提交的字节 offset 开始读取，把 Claude 的原始 user/assistant JSONL
 *    归并为 `{ prompt, promptTimestamp, llmCalls }` 形式的 turn；
 * 4. processor 再把 turn 展开为标准事件并写入 Pilot 的 Claude JSONL。常驻 Collector 后续轮询
 *    那个输出文件，才会触发 `entries`；本模块本身不发事件、不写输出日志，也不保存状态。
 *
 * 为什么需要额外归并：Claude 的同一次 LLM 调用可能产生多条共享 `message.id` 的 assistant
 * 流式快照；tool_result 则以 user record 的 content block 形式出现在后续行中。解析器必须先按
 * `message.id` 合并输出，再用 `tool_use.id`/`tool_result.tool_use_id` 关联工具调用，最后根据
 * user record 的 `promptId` 切分 turn。时间完全取自 transcript 的 `record.timestamp`，不再用
 * Hook 到达时间推算。
 *
 * 增量读取约定：
 * - `byteOffset` 和返回的 `nextOffset` 都是文件“字节”位置，不是 JavaScript 字符索引；
 * - 正常前提是同一个 session transcript 只追加、不截断。若文件缩短到小于旧 offset，当前实现
 *   会保留旧 offset 并等待文件重新增长，不会自行回卷到 0；
 * - 单次未消费数据超过 `MAX_TRANSCRIPT_BYTES` 时，只解析最后 50 MiB，并舍弃更早积压；
 * - `nextOffset` 只是候选 checkpoint。`exportSession()` 先暂存为 `_next_transcript_offset`，只有
 *   标准 JSONL 写入等导出步骤正常完成后，外层 `cmdStop()` 才持久化为 `transcript_offset`。
 *   因而解析成功不等于 offset 已提交，导出失败时下次 Stop 仍可从旧位置重试。
 *
 * 外部依赖只有 Node.js 内置的 `fs`（同步读取 transcript）和 `crypto`（为缺少 message.id 的
 * assistant 记录生成本次解析唯一的兼容 ID）。所有 API 都是同步函数；这里没有 Promise、定时器、
 * 子进程或网络请求。等待 transcript 写稳的异步重试由调用方 `exportSession()` 负责。
 */

// 本文件采用 ES Module `import`；`node:` 前缀明确表示加载 Node.js 内置模块而非 npm 同名包。
import fs from 'node:fs'; // 提供 stat、按字节定位读取、文件描述符关闭等同步文件操作。
import crypto from 'node:crypto'; // 为缺少 message.id 的真实 assistant 记录生成进程内唯一 ID。

// 限制每次装入内存的未消费 transcript 尺寸，避免异常积压让短生命周期 Hook 进程占用过多内存。
export const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024; // 50 MiB 安全读取上限。
// Map 需要一个稳定键来隔离缺失 promptId 的兼容记录，不能直接依赖含义不直观的 undefined。
const MISSING_PROMPT_ID = '__missing_prompt_id__';

/**
 * 判断 user record 是否为 Claude 内部命令或恢复会话时注入的 meta 消息。
 *
 * 同时接受布尔值 `true` 和字符串 `'true'`，以兼容不同版本的 transcript。meta 记录仍可提供
 * turn 的 `promptId` 和边界时间，但不会进入用户 prompt 或传给下游的 LLM 输入增量。
 *
 * @param {object | null | undefined} record 一条已解析的 transcript record。
 * @returns {boolean} 是否为内部 meta 记录。
 */
function isMetaRecord(record) {
  return record?.isMeta === true || record?.isMeta === 'true';
}

/**
 * 判断 assistant record 是否为 Claude Code 自己补出的占位响应。
 *
 * 例如恢复会话时的 `No response requested.` 可能使用 `<synthetic>` model；它没有真实模型调用，
 * 因而不能产生 llm_call，也不能影响后一条真实响应的请求起点。这里的 `<synthetic>` 与下方为
 * “缺少 message.id 的真实响应”生成 `_syn_...` ID 是两件不同的事。
 *
 * @param {object | null | undefined} record 一条 transcript record。
 * @returns {boolean} 是否应从 LLM 调用序列中过滤。
 */
function isSyntheticAssistantRecord(record) {
  return record?.type === 'assistant' && record?.message?.model === '<synthetic>';
}

/**
 * 把可选 promptId 转成 `lastToolResultTsByPromptId` 使用的稳定 Map key。
 *
 * @param {string | null | undefined} promptId Claude 的 turn 级标识。
 * @returns {string} 原 promptId，或缺失值专用的哨兵 key。
 */
function promptMapKey(promptId) {
  return promptId || MISSING_PROMPT_ID;
}

/**
 * 判断一条 user content 是否“仅由 tool_result block 组成”。这样的 user record 是工具回传，
 * 不是用户发起的新 prompt，因此 `splitIntoTurns()` 不会拿它覆盖该 turn 的 prompt 文本。
 *
 * @param {unknown} content `message.content` 原值。
 * @returns {boolean} content 是否为全 tool_result 数组。
 */
function isToolResultContent(content) {
  return Array.isArray(content) &&
    content.every((p) => p && p.type === 'tool_result');
}

/**
 * 从用户消息中提取可展示的 prompt 文本。
 *
 * 数组形式只拼接 `text` block，忽略 tool_result、图片等非文本 block；旧格式若直接提供字符串则
 * 原样返回。该函数不修改原始 content，完整结构仍保留在 llm_call 的 `input_messages` 中。
 *
 * @param {unknown} content Claude `message.content`。
 * @returns {string} 拼接后的纯文本，无法提取时为空字符串。
 */
function extractTextContent(content) {
  return Array.isArray(content)
    ? content.map((p) => (p && p.type === 'text' ? (p.text || p.content || '') : '')).join('')
    : (typeof content === 'string' ? content : '');
}

/** 把可选 ISO 时间转换为毫秒；缺失或非法值统一返回 null，供后续回退逻辑判断。 */
function parseTimestampMs(ts) {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 比较两个时间并返回较晚者，用于逐个 LLM 调用推进“可用的最近边界”。
 * 缺失值或无法解析的一方会让位给有效值，避免一个坏时间戳破坏整个 turn。
 */
function laterTimestamp(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const aMs = parseTimestampMs(a);
  const bMs = parseTimestampMs(b);
  if (aMs === null) return b;
  if (bMs === null) return a;
  return bMs > aMs ? b : a;
}

/**
 * 校正一个候选请求开始时间，防止其晚于当前 assistant 响应时间。
 *
 * @param {string | null} candidate prompt/tool_result/上一响应推导出的候选起点。
 * @param {string | null} responseTs 当前 LLM 响应首条 assistant record 的时间。
 * @returns {string | null} 可用于 span 起点的时间；明显倒置时退回响应时间。
 */
function normalizeRequestStart(candidate, responseTs) {
  if (!candidate) return responseTs || null;
  const candidateMs = parseTimestampMs(candidate);
  const responseMs = parseTimestampMs(responseTs);
  if (candidateMs !== null && responseMs !== null && candidateMs > responseMs) {
    // 防御 transcript 异常：请求开始晚于自身响应不可能成立，并会生成负时长 OTLP span。
    return responseTs;
  }
  return candidate;
}

/**
 * 从指定字节位置增量解析 Claude Code transcript JSONL 文件。
 *
 * 处理分为四个阶段：
 * 1. 读取文件的新增字节，并把每行独立解析为 JSON；
 * 2. 按 assistant `message.id` 合并流式快照并对 content block 去重；
 * 3. 按原始记录顺序构造 llm_call，关联 tool_use/tool_result，推导请求与响应时间；
 * 4. 调用 `splitIntoTurns()`，按 user record 的 `promptId` 输出 turn。
 *
 * 返回值中的 llm_call 是 processor 的中间结构，主要字段如下：
 * - `timestamp`：该 `message.id` 首次出现的 assistant record 时间，后续作为 `llm.response`
 *   事件时间；它表示首次观察到响应分块的时刻，不一定等于完整流式响应结束时刻；
 * - `request_start_time`：同一 promptId 下前一个 tool_result 时间；首个调用或无工具间隔时由
 *   `splitIntoTurns()` 用 prompt 时间/上一响应时间回填；
 * - `input_messages`：自上一条 assistant 响应之后新增的非 meta 对话片段，而非完整历史；
 * - `output_content`：同一 message.id 的流式 block 合并结果；
 * - `declaredToolIds`/`toolDetails`：工具声明 ID 以及对应调用、结果时间、内容和错误标记。
 *
 * 这是同步、只读函数，不修改 checkpoint 文件。常见的文件不存在、stat/read 失败和单行 JSON
 * 损坏均按 fail-open 方式返回或跳过，不影响 Claude Code 主进程。调用方应只在后续导出成功后提交
 * `nextOffset`，否则会丢失重试机会。
 *
 * @param {string} transcriptPath Claude Code 当前 session 的 transcript 绝对路径。
 * @param {number} byteOffset 上次成功导出后保存的字节偏移；负数会按 0 处理，默认从头读取。
 * @returns {{ turns: Array<{prompt: string, promptTimestamp: string | null, llmCalls: Array<object>}>, nextOffset: number }}
 *   `turns` 是本次可解析的新 turn；`nextOffset` 是建议提交的下一读取位置。
 * @throws 预期的文件和逐行 JSON 错误不会抛出；分组转换阶段若出现未捕获的运行时异常，则由
 *   `exportSession()` 捕获并阻止 offset 提交。
 */
export function parseClaudeTranscript(transcriptPath, byteOffset = 0) {
  // 路径尚未由 Stop payload 建立、或 transcript 还没落盘时，不前移调用方传入的 checkpoint。
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { turns: [], nextOffset: byteOffset };
  }

  // content 只保存本轮允许处理的新增文本；fileSize 同时作为本轮候选 nextOffset。
  let content;
  let fileSize;
  try {
    // 先取文件尺寸，所有增量长度都按字节计算，不能使用 UTF-16 的 JavaScript string.length。
    const stat = fs.statSync(transcriptPath);
    fileSize = stat.size;

    // 相等表示没有新增数据；大于通常表示文件被截断或替换。解析器假设 transcript 只追加，
    // 因此两种情况都保留旧 offset，不擅自从头重放并制造重复事件。
    if (byteOffset >= fileSize) {
      return { turns: [], nextOffset: byteOffset };
    }

    // 对异常负 offset 做最小防御；正常值来自 state.transcript_offset，应始终为非负整数。
    const readFrom = Math.max(byteOffset, 0);
    const readLen = fileSize - readFrom;

    if (readLen > MAX_TRANSCRIPT_BYTES) {
      // 未消费积压超过上限时，只把文件尾部 50 MiB 装入内存。这样可以保证 Hook 进程的
      // 最坏内存占用，但 readFrom 到 tailOffset 之间的旧 turn 会被明确、永久地舍弃。
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        // actualOffset 不会早于调用方 checkpoint；当前分支下通常就是文件尾部上限位置。
        const tailOffset = fileSize - MAX_TRANSCRIPT_BYTES;
        const actualOffset = Math.max(tailOffset, readFrom);
        const actualLen = fileSize - actualOffset;
        const buf = Buffer.alloc(actualLen);
        // readSync 的 position 参数按字节定位，不受 UTF-8 中文等多字节字符影响。
        fs.readSync(fd, buf, 0, actualLen, actualOffset);
        content = buf.toString('utf-8');
        if (actualOffset > readFrom) {
          // tailOffset 很可能落在某条 JSON 中间；跳到下一个换行，避免把残片误当完整 record。
          // 若整个尾部没有换行，后续 JSON.parse 会按坏行跳过，nextOffset 仍指向 fileSize。
          const firstNewline = content.indexOf('\n');
          if (firstNewline >= 0) content = content.slice(firstNewline + 1);
        }
      } finally {
        // 即使分配、读取或 UTF-8 解码抛错，也必须关闭描述符；异常随后由外层 catch 转成空结果。
        fs.closeSync(fd);
      }
    } else if (readFrom > 0) {
      // offset 是字节位置，必须用 fd/readSync 定位；先读完整字符串再按字符 slice 会在 UTF-8
      // 多字节字符处错位。Buffer 长度固定为本次 stat 得到的新增字节数。
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const buf = Buffer.alloc(readLen);
        fs.readSync(fd, buf, 0, readLen, readFrom);
        content = buf.toString('utf-8');
      } finally {
        fs.closeSync(fd);
      }
    } else {
      // 首次读取且文件未超过上限时，直接由 fs 按 UTF-8 读取全部内容，代码更简单。
      content = fs.readFileSync(transcriptPath, 'utf-8');
    }
  } catch {
    // 权限、文件竞态或临时 I/O 错误都不推进 offset；下一次 Stop 可从同一位置重试。
    return { turns: [], nextOffset: byteOffset };
  }

  // 阶段 1：一次扫描同时建立三类索引。先收集完整批次，后面才能把“先声明、后返回”的工具
  // 事件关联起来；直接逐行输出会在看到 tool_use 时拿不到未来的 tool_result。
  const assistantGroups = new Map(); // message.id -> 同一次 LLM 调用的所有流式 chunk 与元数据。
  const conversationRecords = []; // 只存 user 详情和 assistant 占位引用，保持 transcript 首次出现顺序。
  const toolResultTimestamps = new Map(); // tool_use_id -> 对应 user/tool_result record 的 ISO 时间。
  const toolResultContents = new Map(); // tool_use_id -> 工具返回内容。
  const toolResultErrors = new Map(); // tool_use_id -> `is_error` 是否为真。
  let currentPromptId = null; // 最近 user record 给出的 turn 标识，后续 assistant 会继承它。

  // JSONL 允许逐行解析和隔离错误：空行、尾部半行或单条坏 JSON 不阻塞同批其他记录。
  // 注意：成功返回时 nextOffset 仍是 fileSize；若调用方最终提交它，被跳过的坏行不会再次读取。
  // exportSession 会先等待文件尺寸稳定，以降低把尚未写完的尾行当坏行消费掉的概率。
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // 当前解析器只关心 user/assistant；summary、file-history-snapshot 等其他 Claude 记录会自然忽略。
    const recordType = record.type;
    if (!recordType) continue;

    if (recordType === 'assistant') {
      // `<synthetic>` 是 Claude 自己的流程占位，不应伪装成真实模型调用或推进输入 delta。
      if (isSyntheticAssistantRecord(record)) {
        continue;
      }

      const msg = record.message;
      if (!msg) continue;

      // 某些 end_turn 最终响应没有 msg.id。为它生成本次解析唯一的 key 后仍可保留调用；因为
      // 每条缺 ID 记录都会得到不同 UUID，它们不会误与相邻流式 chunk 合并。
      const msgId = msg.id || `_syn_${crypto.randomUUID()}`;
      const recordTs = record.timestamp || null;

      if (!assistantGroups.has(msgId)) {
        // 第一条 chunk 决定这个 LLM 调用在 conversationRecords 中的位置、所属 promptId 和响应时间。
        // 后续相同 message.id 只补充该 group，不再插入第二个 assistant 调用。
        assistantGroups.set(msgId, {
          id: msgId,
          chunks: [],
          usage: null,
          model: null,
          stop_reason: null,
          // 保留首次出现序号供兼容/诊断；当前实际输出顺序由 conversationRecords 决定。
          order: conversationRecords.length,
          firstTimestamp: recordTs,
          toolUseTimestamps: new Map(),
          promptId: currentPromptId,
        });
        conversationRecords.push({ type: 'assistant', msgId, promptId: currentPromptId });
      }

      const group = assistantGroups.get(msgId);
      // 首条 chunk 可能没有 timestamp；此时采用后续第一条有时间的 chunk，仍不覆盖已有时间。
      if (!group.firstTimestamp && recordTs) group.firstTimestamp = recordTs;

      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          // 暂时保留所有快照，阶段 2 再根据 block 类型执行对应的去重策略。
          group.chunks.push(block);
          if (block.type === 'tool_use' && block.id && recordTs) {
            // 相同 tool_use.id 重复出现时 Map 保留最后一次看到的 chunk 时间。
            group.toolUseTimestamps.set(block.id, recordTs);
          }
        }
      }
      // 流式末尾记录通常才携带完整 usage/stop_reason；后出现的非空值覆盖早期值。
      if (msg.usage) group.usage = msg.usage;
      if (msg.model) group.model = msg.model;
      if (msg.stop_reason) group.stop_reason = msg.stop_reason;
    } else if (recordType === 'user') {
      const msg = record.message;
      if (!msg) continue;
      const recordTs = record.timestamp || null;
      const promptId = record.promptId || null;
      const isMeta = isMetaRecord(record);

      // user record 是 turn 边界的事实来源。tool_result 和 meta user 也可能携带同一 promptId；
      // 它们只维持当前 turn。值真正变化后，随后的 assistant 才会归入新 turn。
      if (promptId) currentPromptId = promptId;

      // tool_result 嵌在 user message.content 数组中。这里先按 tool_use_id 建立全批次索引，
      // 阶段 3 才把结果反向挂到声明该 ID 的 assistant 调用。
      const userContent = msg.content;
      if (Array.isArray(userContent)) {
        for (const part of userContent) {
          if (part && part.type === 'tool_result' && part.tool_use_id) {
            if (recordTs) toolResultTimestamps.set(part.tool_use_id, recordTs);
            const resultContent = part.content || part.output || part.result || '';
            toolResultContents.set(part.tool_use_id, resultContent);
            if (part.is_error) toolResultErrors.set(part.tool_use_id, true);
          }
        }
      }

      // meta 记录仍保留边界信息，但阶段 3 会阻止它进入 conversationHistory。
      conversationRecords.push({
        type: 'user',
        content: userContent,
        timestamp: recordTs,
        promptId: currentPromptId,
        isMeta,
      });
    }
  }

  if (assistantGroups.size === 0) {
    // user-only、全 synthetic 或全坏行的新增内容不会产生 llm_call，但读取本身已完成；返回
    // fileSize 允许调用方在本轮导出正常结束后消费这些行，避免每次 Stop 无限重扫。
    return { turns: [], nextOffset: fileSize };
  }

  // 阶段 2：同 message.id 的多行常是不断变长的流式快照。按 block 类型去重后只保留用于
  // 下游输出的一份 mergedContent；删除 chunks 可明确表示后续不再使用未归并数据。
  for (const group of assistantGroups.values()) {
    group.mergedContent = deduplicateContentBlocks(group.chunks);
    delete group.chunks;
  }

  // 阶段 3：按 conversationRecords 的首次出现顺序构建 llm_call 中间事件。
  const llmCalls = [];
  // conversationHistory 保留到当前扫描位置为止的非 meta user 与已完成 assistant 消息。
  const conversationHistory = [];
  // prevCount 指向上一个 LLM 调用结束后的 history 长度，用来截取“本次新增输入”而非全量历史。
  let prevCount = 0;
  // 每个 promptId 单独记住最近工具结果，避免上一 turn 的工具时间污染下一 turn 的 LLM span。
  const lastToolResultTsByPromptId = new Map();
  const updateLastToolResultTs = (promptId, ts) => {
    if (!ts) return;
    const key = promptMapKey(promptId);
    const prev = lastToolResultTsByPromptId.get(key);
    // Claude timestamp 使用可按字典序比较的标准 ISO 8601 形式；并行工具只保留最晚完成时间。
    if (!prev || ts > prev) lastToolResultTsByPromptId.set(key, ts);
  };

  for (const rec of conversationRecords) {
    if (rec.type === 'user') {
      if (!rec.isMeta) {
        // 包括真实 prompt 与 tool_result：两者都会成为下一次模型调用的输入增量。
        conversationHistory.push({ role: 'user', content: rec.content });
      }
      if (!rec.isMeta && Array.isArray(rec.content)) {
        // 当扫描越过工具结果时更新同 turn 的请求边界；多个并行结果取最晚时间。
        for (const part of rec.content) {
          if (part && part.type === 'tool_result' && part.tool_use_id) {
            const ts = toolResultTimestamps.get(part.tool_use_id);
            updateLastToolResultTs(rec.promptId, ts);
          }
        }
      }
    } else if (rec.type === 'assistant') {
      const group = assistantGroups.get(rec.msgId);
      if (!group) continue;

      const usage = group.usage || {};
      // transcript 版本或中间 chunk 可能缺少 usage；缺失时用 0 保持下游字段为数值。
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      const cacheRead = usage.cache_read_input_tokens || 0;
      const cacheCreate = usage.cache_creation_input_tokens || 0;

      // 第一条调用通常得到用户 prompt；工具调用后的下一条则只得到新增 tool_result。
      // `_input_is_delta` 会告诉下游这不是完整上下文，避免按全量消息误解。
      const delta = conversationHistory.slice(prevCount);

      // 只有归并后仍存在且带 id 的 tool_use 才能参与稳定关联。
      const declaredToolIds = [];
      for (const block of group.mergedContent) {
        if (block.type === 'tool_use' && block.id) {
          declaredToolIds.push(block.id);
        }
      }

      const toolDetails = new Map();
      for (const toolId of declaredToolIds) {
        // tool call 时间优先取包含该 block 的 assistant chunk；缺失时回退到响应首条时间。
        // result 可能尚未产生，因此 resultTs/content 允许为空。
        const callTs = group.toolUseTimestamps.get(toolId) || group.firstTimestamp;
        const resultTs = toolResultTimestamps.get(toolId) || null;
        const resultContent = toolResultContents.get(toolId) || '';
        const isError = toolResultErrors.get(toolId) || false;
        toolDetails.set(toolId, { call: callTs, result: resultTs, resultContent, isError });
      }

      // 中间 LLM 调用通常由上一步工具完成触发，所以最近 tool_result 是最可靠的请求起点。
      // 首个调用没有该值，留给 splitIntoTurns 用本 turn 的 prompt 时间回填。
      const requestStartTime = lastToolResultTsByPromptId.get(promptMapKey(group.promptId)) || null;

      // 这里构造的对象仍是 Hook processor 内部格式，之后由 buildTurnRecords() 展开为标准事件。
      llmCalls.push({
        type: 'llm_call',
        timestamp: group.firstTimestamp,
        request_start_time: requestStartTime,
        protocol: 'anthropic',
        model: group.model || 'unknown',
        message_id: group.id,
        input_messages: delta,
        _input_is_delta: true,
        output_content: group.mergedContent,
        stop_reason: group.stop_reason || 'end_turn',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
        declaredToolIds,
        toolDetails,
        promptId: group.promptId,
      });

      conversationHistory.push({
        role: 'assistant',
        content: group.mergedContent,
      });
      // 把当前 assistant 也纳入已消费边界，保证下一次 delta 只含它之后的新 user 记录。
      prevCount = conversationHistory.length;

      // toolResultTimestamps 在阶段 1 已扫描完整文件，因此即使 result 行位于当前 assistant 后面，
      // 这里也能预先建立下一次 LLM 调用的起点；随后扫描 user 行时会再做同值/最晚值更新。
      for (const toolId of declaredToolIds) {
        const ts = toolResultTimestamps.get(toolId);
        updateLastToolResultTs(group.promptId, ts);
      }
    }
  }

  // 阶段 4：把平铺 llmCalls 按 promptId 装入 turn，并补齐 request_start_time。
  const turns = splitIntoTurns(conversationRecords, llmCalls);

  // fileSize 是本轮开始读取时观察到的文件末尾。调用方负责在输出成功后提交，而不是本函数。
  return { turns, nextOffset: fileSize };
}

/**
 * 按 user record 的 promptId 把平铺的 llmCalls 切分为 turn，并补齐请求开始时间。
 *
 * Claude Code 在同一轮用户请求产生的真实 prompt、tool_result 等 user record 上复用一个
 * `promptId`；值变化代表新 turn。函数先按首次出现顺序收集 promptId 和可展示 prompt，再把
 * parseClaudeTranscript() 已经标记 promptId 的 llm_call 归入对应 turn。
 *
 * 时间推导规则：
 * - turn 的 `promptTimestamp` 优先取第一条真实 prompt 时间；若本轮只有 meta 注入，则退回首条
 *   user 边界时间；仍无值时使用第一条 assistant 响应时间；
 * - llm_call 的响应 `timestamp` 已在前一阶段取自该 message.id 的首条 assistant record；
 * - `request_start_time` 若已有同 turn 最近 tool_result 时间则保留，否则首个调用用 prompt 时间，
 *   后续调用用当前已知的上一响应时间逐步回填；若候选起点晚于响应，则校正为响应时间。
 *
 * meta user record 参与 turn 边界和时间兜底，但不提供 prompt 文本；纯 tool_result user record 也
 * 不会被误认为新 prompt。没有任何 promptId 的旧格式数据退化为一个匿名 turn。
 *
 * @param {Array<object>} conversationRecords 按 transcript 顺序保存的 user 记录和 assistant 引用。
 * @param {Array<object>} llmCalls 已合并内容、关联工具且带 promptId 的 LLM 调用数组。
 * @returns {Array<{prompt: string, promptTimestamp: string | null, llmCalls: Array<object>}>}
 *   按 promptId 首次出现顺序排列的 turn。
 * 副作用：会原地补写传入 llmCalls 中每个正常 turn 调用的 `request_start_time`；不会读写文件。
 */
function splitIntoTurns(conversationRecords, llmCalls) {
  // 没有真实 assistant 调用就没有可导出的 turn，user-only 记录不会单独形成事件。
  if (llmCalls.length === 0) return [];

  // 第一遍只扫描 user record：建立稳定 turn 顺序、边界时间和第一条真实 prompt 信息。
  const promptIdOrder = [];
  const promptIdSet = new Set();
  const promptIdInfo = new Map(); // promptId -> 第一条非 meta、非纯 tool_result 的 prompt 文本与时间。
  const promptIdBoundaryTs = new Map(); // promptId -> 首条 user record 时间，包含 meta/tool_result。

  for (const rec of conversationRecords) {
    // assistant 在阶段 1 已继承 promptId，这里只需从 user 记录确定 turn 的展示和顺序。
    if (rec.type !== 'user' || !rec.promptId) continue;
    if (!promptIdSet.has(rec.promptId)) {
      // Set 用于判重，数组用于保留 transcript 中第一次出现的顺序；Map 自身虽也有插入顺序，
      // 这里把“顺序”和“信息是否已找到”分开表达。
      promptIdSet.add(rec.promptId);
      promptIdOrder.push(rec.promptId);
    }

    // 边界时间不要求是真实 prompt，确保 meta-only 的 resume turn 仍有合理起点。
    if (!promptIdBoundaryTs.has(rec.promptId) && rec.timestamp) {
      promptIdBoundaryTs.set(rec.promptId, rec.timestamp);
    }

    // 每个 turn 只采用第一条真实用户输入作为 prompt。后续 tool_result 负责驱动下一次 LLM，
    // 但不应覆盖用户最初的问题；meta 注入同样不能暴露为用户文本。
    if (promptIdInfo.has(rec.promptId) || rec.isMeta || isToolResultContent(rec.content)) {
      continue;
    }

    promptIdInfo.set(rec.promptId, {
      promptText: extractTextContent(rec.content),
      promptTimestamp: rec.timestamp,
    });
  }

  if (promptIdOrder.length === 0) {
    // 兼容没有 promptId 的旧 transcript 或 assistant-only 片段：全部调用放入一个匿名 turn。
    // 这个提前返回保留 llmCalls 现有的 request_start_time，不额外按 prompt 边界回填。
    const firstTs = llmCalls[0]?.timestamp || null;
    return [{
      prompt: '',
      promptTimestamp: firstTs,
      llmCalls,
    }];
  }

  // 第二遍按 promptId 过滤调用。filter 保持 llmCalls 原顺序，因此 turn 内 LLM 顺序不变。
  const turns = [];
  for (const pid of promptIdOrder) {
    const turnLlmCalls = llmCalls.filter((c) => c.promptId === pid);
    // 只有 user 边界、尚无真实 assistant 响应的 prompt 不输出空 turn。
    if (turnLlmCalls.length === 0) continue;

    const info = promptIdInfo.get(pid) || {};
    // 真实 prompt 时间最准确；meta/tool_result 边界其次；最后才使用响应时间避免空 span 起点。
    const promptTimestamp = info.promptTimestamp || promptIdBoundaryTs.get(pid) || turnLlmCalls[0]?.timestamp || null;

    // 一个 turn 可能因 tool_use/tool_result 往返包含多个真实 LLM 调用，所以不能只给第一条补时间。
    // 前一阶段已为工具后的调用填入 tool_result 时间；其余调用按 prompt/上一响应时间依次兜底，
    // 防止下游生成 time_unix_nano=0。`<synthetic>` 占位已在阶段 1 过滤，不参与这里的序列。
    let fallbackTs = promptTimestamp || turnLlmCalls[0]?.timestamp || null;
    for (const call of turnLlmCalls) {
      // 优先级：明确的 tool_result 起点 > 已推进的 turn 边界 > 当前响应自身。
      const candidate = call.request_start_time || fallbackTs || call.timestamp || null;
      call.request_start_time = normalizeRequestStart(candidate, call.timestamp);
      // 下一次无工具起点的调用最多回退到本次响应时间；laterTimestamp 防止异常乱序让边界倒退。
      fallbackTs = laterTimestamp(fallbackTs, call.timestamp);
    }

    turns.push({
      prompt: info.promptText || '',
      promptTimestamp,
      llmCalls: turnLlmCalls,
    });
  }

  // assistant 在第一条带 promptId 的 user 之前出现时，其 group.promptId 为 null，形成 orphanCalls。
  const orphanCalls = llmCalls.filter((c) => !c.promptId);
  if (orphanCalls.length > 0) {
    if (turns.length > 0) {
      // 当前兼容策略把孤立调用附到最后一个有效 turn，而不是额外暴露无 prompt turn。这里发生在
      // 正常 turn 的时间回填之后，因此 orphan 自身的 request_start_time 不会由该 turn 再次补齐。
      turns[turns.length - 1].llmCalls.push(...orphanCalls);
    } else {
      // 理论上 promptIdOrder 非空但没有任何对应调用时会走到这里，为孤立调用建立匿名 turn。
      turns.push({
        prompt: '',
        promptTimestamp: orphanCalls[0]?.timestamp || null,
        llmCalls: orphanCalls,
      });
    }
  }

  return turns;
}

/**
 * 合并同一 assistant message.id 收集到的流式 content block。
 *
 * Claude transcript 中的 text/thinking 通常是“后一个快照包含前一个快照”的累计形式，而不是
 * 必须首尾拼接的 delta，因此分别选择字符数最长的一份；相同长度保留先出现者。这个策略默认
 * 每个 message 只需要一个最终 text 和一个最终 thinking block，若上游改成真正的分片 delta，
 * 则需要重新确认，不能直接把本函数理解为字符串拼接器。
 *
 * `tool_use` 以 id 为业务唯一键，重复 id 保留第一份，缺少 id 时无法可靠判重所以全部保留；图片
 * 等其他 block 原样保留。输出顺序统一为 thinking、text，再接原先保留下来的 tool_use/其他 block，
 * 方便下游按稳定顺序构造事件。
 *
 * @param {Array<object> | null | undefined} blocks 同一 message.id 的全部 content block 快照。
 * @returns {Array<object>} 新数组；block 对象本身不克隆，也不会修改输入数组。
 */
export function deduplicateContentBlocks(blocks) {
  // 统一把缺失或空输入归一化为空数组，调用方无需额外判空。
  if (!blocks || blocks.length === 0) return [];

  // result 先收集无需“选最佳版本”的 block；text/thinking 最后统一插到数组前方。
  const result = [];
  const seenToolUseIds = new Set();
  let bestText = null;
  let bestThinking = null;

  for (const block of blocks) {
    // 跳过 null、标量或缺少 type 的损坏 block，不让单个异常内容中断整个 turn。
    if (!block || !block.type) continue;

    if (block.type === 'text') {
      // 流式累计快照越长通常越完整；使用严格大于可让同长度时稳定保留第一份。
      if (!bestText || (block.text || '').length > (bestText.text || '').length) {
        bestText = block;
      }
    } else if (block.type === 'thinking') {
      // thinking 与 text 独立选取最长快照，避免二者互相覆盖。
      if (!bestThinking || (block.thinking || '').length > (bestThinking.thinking || '').length) {
        bestThinking = block;
      }
    } else if (block.type === 'tool_use') {
      if (block.id && !seenToolUseIds.has(block.id)) {
        // 有 id 时第一份进入结果，后续同 id 快照会被忽略。
        seenToolUseIds.add(block.id);
        result.push(block);
      } else if (!block.id) {
        // 无 id 的 tool_use 无法证明是重复项；保留比误删更安全，但它不会进入 declaredToolIds。
        result.push(block);
      }
    } else {
      // image 等未知/扩展类型不做猜测性转换，按遇到顺序透传给下游。
      result.push(block);
    }
  }

  // 先 unshift text、再 unshift thinking，最终得到 thinking -> text -> 其余 block 的规范顺序。
  if (bestText) result.unshift(bestText);
  if (bestThinking) result.unshift(bestThinking);

  return result;
}
