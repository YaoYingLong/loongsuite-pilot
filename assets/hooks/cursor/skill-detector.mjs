/**
 * Cursor turn 组装后的 Skill 使用检测器。
 *
 * processor 先完成主记录组装，再调用本模块读取 transcript：定位与本次 prompt 匹配的 user
 * 消息，仅扫描该 turn 后续 assistant 的 Read/ReadFile tool_use，并识别
 * `~/.cursor/skills/<name>/SKILL.md`。返回值用于补造标准 Read tool 记录。读取或单行 JSON
 * 解析失败时返回 null/跳过，Skill 元数据不能阻塞正式输出。
 */

import fs from 'node:fs';

// 同时兼容 `/` 与 `\\`，并忽略大小写，覆盖 Unix/Windows transcript 路径。
const SKILL_PATH_RE = /[/\\]\.cursor[/\\]skills[/\\]([\w-]+)[/\\]SKILL\.md/i;

/**
 * 检测指定 turn 中读取过的 Skill。
 * @param {string} transcriptPath Cursor transcript JSONL 路径。
 * @param {string} userPrompt 用于定位正确 turn 的用户 prompt。
 * @returns {{skillName: string, skillPath: string}[] | null} 检测结果；无法定位时返回 null。
 */
export function detectSkillFromTranscript(transcriptPath, userPrompt) {
  if (!transcriptPath || !userPrompt) return null;

  let content;
  try {
    content = fs.readFileSync(transcriptPath, 'utf-8');
  } catch (_e) {
    return null; // transcript 不可访问，保持 fail-open。
  }

  const lines = content.trim().split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch (_e) { /* 跳过损坏行，继续检查其余记录。 */ }
  }

  if (entries.length === 0) return null;

  // 第一步：归一化两侧文本并用包含关系定位 user 消息；transcript 可能包裹 user_query/timestamp。
  const normalizedPrompt = normalizeForMatch(userPrompt);

  let matchedTurnStart = -1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.role !== 'user') continue;
    const userText = extractUserText(e);
    if (userText && normalizeForMatch(userText).includes(normalizedPrompt)) {
      matchedTurnStart = i;
    }
  }

  if (matchedTurnStart < 0) return null;

  // 第二步：扫描到下个 turn_ended/user 为止，避免把后续 turn 的 Skill 归到当前 turn。
  const skills = [];
  for (let i = matchedTurnStart + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === 'turn_ended' || e.role === 'user') break;

    if (e.role === 'assistant' && e.message?.content) {
      for (const block of e.message.content) {
        if (block.type === 'tool_use' && (block.name === 'Read' || block.name === 'ReadFile')) {
          const filePath = block.input?.path || '';
          const match = filePath.match(SKILL_PATH_RE);
          if (match) {
            skills.push({
              skillName: match[1],
              skillPath: filePath,
            });
          }
        }
      }
    }
  }

  return skills.length > 0 ? skills : null;
}

/** 从 user message 条目中提取纯文本。 */
function extractUserText(entry) {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return '';
  const textParts = content.filter(b => b.type === 'text');
  return textParts.map(b => b.text || '').join('\n');
}

/** 为模糊匹配归一化文本：去标签、合并空白并转小写。 */
function normalizeForMatch(text) {
  return text
    .replace(/<[^>]+>/g, '') // 去除 XML/HTML 标签。
    .replace(/\s+/g, ' ')    // 折叠连续空白。
    .trim()
    .toLowerCase();
}
