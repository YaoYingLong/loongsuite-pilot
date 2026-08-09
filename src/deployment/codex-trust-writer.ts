/**
 * codex-trust-writer.ts — Codex hook trust hash 写入 / 校验。
 *
 * 移植自 codex-plugin .../src/trust.ts,改 ESM TypeScript + 新增能力:
 *   - verifyTrustHashes() 自洽性检查(Q8 决策)
 *   - EVENT_KEY_MAP 扩展到 10 个事件(为未来 codex 全事件兼容留余地)
 *   - forceBypass 应急通道(R4):写 bypass_hook_trust = true 顶层字段
 *   - marker 名从外部传入(不再硬编码 "otel-codex-hook")
 *
 * 算法核心(对齐 codex-rs/config/src/fingerprint.rs):
 *   computeHookTrustHash(eventName, command):
 *     identity = NormalizedHookIdentity {
 *       event_name,
 *       hooks: [{ type:"command", command, timeout:600, async:false }]
 *     }
 *     SHA-256(canonical_json(identity)) → "sha256:<hex>"
 *
 * Trust block 结构:
 *     # BEGIN <marker> trust
 *     bypass_hook_trust = true   # 仅 forceBypass=true 时
 *     [hooks.state."<hooks.json>:<event>:0:0"]
 *     trusted_hash = "sha256:..."
 *     ...
 *     # END <marker> trust
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

/** 已知 Codex hook 事件 → snake_case label。 */
const EVENT_KEY_MAP: Record<string, string> = {
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  PostToolUseFailure: 'post_tool_use_failure',
  PreCompact: 'pre_compact',
  PostCompact: 'post_compact',
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Stop: 'stop',
};

/** 递归按对象 key 排序，数组保持顺序，为跨运行稳定 hash 准备 canonical 值。 */
function canonicalJson(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** 对 canonical JSON 做 SHA-256，并加 Codex 期望的 `sha256:` 前缀。 */
function versionForToml(obj: unknown): string {
  const canonical = canonicalJson(obj);
  const serialized = JSON.stringify(canonical);
  const hex = crypto.createHash('sha256').update(serialized, 'utf-8').digest('hex');
  return `sha256:${hex}`;
}

/**
 * 计算单个 hook 的 trust hash。
 * 对齐 codex-rs `command_hook_hash`(见 hooks/src/engine/discovery.rs)。
 *
 * NormalizedHookIdentity { event_name, #[flatten] group: MatcherGroup }
 * MatcherGroup { matcher: Option<String>, hooks: Vec<HookHandlerConfig> }
 *   matcher = None → TOML 中字段缺失
 * HookHandlerConfig::Command { type:"command", command, timeout_sec:Some(600), async:false, status_message:None, command_windows:None }
 *   timeout_sec serde rename "timeout";command_windows / status_message 缺省时跳过
 */
/** 未知 event 会抛错，调用方新增事件时必须同步 EVENT_KEY_MAP。 */
export function computeHookTrustHash(eventName: string, command: string): string {
  const eventKey = EVENT_KEY_MAP[eventName];
  if (!eventKey) throw new Error(`Unknown hook event: ${eventName}`);

  const identity: Record<string, unknown> = {
    event_name: eventKey,
    // matcher: None → 缺失字段
    hooks: [
      {
        type: 'command',
        command,
        timeout: 600,
        async: false,
        // status_message: None / command_windows: None → 缺失字段
      },
    ],
  };
  return versionForToml(identity);
}

/**
 * 构建 trust state key。
 *
 * key 格式: `<hooks.json 绝对路径>:<event_label>:<group_index>:<handler_index>`
 *
 * group_index = hook 在 hooks.json 中的数组位置(0-based),由调用方传入。
 * 如果其他第三方 hook(如 r2c)排在前面,pilot 的 hook 会在 1、2... 的位置。
 * handler_index 目前固定 0(每个 group 只有一个 handler)。
 */
/** groupIndex 必须是 Hook group 在对应事件数组中的真实下标。 */
export function hookStateKey(
  hooksJsonAbsPath: string,
  eventName: string,
  groupIndex: number = 0,
): string {
  const eventKey = EVENT_KEY_MAP[eventName];
  if (!eventKey) throw new Error(`Unknown hook event: ${eventName}`);
  return `${hooksJsonAbsPath}:${eventKey}:${groupIndex}:0`;
}

interface ParsedTrustHash {
  key: string;     // 完整 hook state key,如 "/abs/hooks.json:session_start:0:0"
  hash: string;    // sha256:xxx
}

/**
 * 从 config.toml content 中提取所有 [hooks.state."..."].trusted_hash 条目。
 * 仅按 marker BEGIN/END 包裹的 block 内提取。
 */
/** marker 块缺失或倒置时返回空数组，坏 section 不会匹配正则。 */
function parseTrustBlock(content: string, marker: string): ParsedTrustHash[] {
  const begin = `# BEGIN ${marker} trust`;
  const end = `# END ${marker} trust`;
  const beginIdx = content.indexOf(begin);
  const endIdx = content.indexOf(end);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return [];

  const block = content.slice(beginIdx, endIdx);
  const out: ParsedTrustHash[] = [];
  const sectionRe = /\[hooks\.state\."([^"]+)"\]\s*\n\s*trusted_hash\s*=\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = sectionRe.exec(block)) !== null) {
    out.push({ key: m[1]!, hash: m[2]! });
  }
  return out;
}

/**
 * 移除老版本插件留下的"裸" [hooks.state."<hooksJsonAbsPath>:<event>:<group>:0"] 段。
 * 不在 marker 块内,但 path/event 匹配 + handler=0 → pilot 拥有的 slot,清掉。
 * 匹配任意 group index(老插件可能在 :0:0,新 pilot 可能在 :1:0 等)。
 */
/** 纯字符串变换：删除 path/event 匹配且 handler=0 的本项目历史 state section。 */
function removeStaleTrustState(
  content: string,
  hooksJsonAbsPath: string,
  hookEvents: readonly string[],
): string {
  const ownedEventKeys = new Set(
    hookEvents.map((event) => {
      const eventKey = EVENT_KEY_MAP[event];
      if (!eventKey) throw new Error(`Unknown hook event: ${event}`);
      return eventKey;
    }),
  );

  const lines = content.split('\n');
  const out: string[] = [];
  let skipping = false;

  const sectionHeader = /^\s*\[hooks\.state\."([^"]+)"\]\s*$/;
  const anyHeader = /^\s*\[/;

  /** 判断 trust section key 是否属于本项目当前 hooks.json、事件和 handler。 */
  const isOwnedKey = (key: string): boolean => {
    // key 格式: "<path>:<event>:<group>:<handler>"
    const lastColon = key.lastIndexOf(':');
    if (lastColon === -1) return false;
    const handlerPart = key.slice(lastColon + 1);
    const rest = key.slice(0, lastColon);
    const groupColon = rest.lastIndexOf(':');
    if (groupColon === -1) return false;
    const groupPart = rest.slice(groupColon + 1);
    const eventStart = rest.slice(0, groupColon);
    const eventColon = eventStart.lastIndexOf(':');
    if (eventColon === -1) return false;
    const eventKey = eventStart.slice(eventColon + 1);
    const pathPart = eventStart.slice(0, eventColon);

    return (
      pathPart === hooksJsonAbsPath &&
      ownedEventKeys.has(eventKey) &&
      handlerPart === '0'
    );
  };

  for (const line of lines) {
    const headerMatch = line.match(sectionHeader);
    if (headerMatch) {
      skipping = isOwnedKey(headerMatch[1]!);
      if (skipping) continue;
      out.push(line);
      continue;
    }
    if (anyHeader.test(line)) {
      // 任何其他 table header 终止跳过区
      skipping = false;
      out.push(line);
      continue;
    }
    if (skipping) continue;
    out.push(line);
  }

  let result = out.join('\n');
  result = result.replace(/\n{3,}/g, '\n\n');
  return result;
}

export interface WriteTrustedHashesOpts {
  configPath: string;            // ~/.codex/config.toml
  hooksJsonAbsPath: string;      // ~/.codex/hooks.json 绝对路径
  hookEvents: readonly string[]; // 要写 trust 的 event 列表(如 ["SessionStart", ...])
  /**
   * event → 实际写入 hooks.json 的完整 command 字符串。
   * trust hash 算法必须用相同字符串,否则 codex 端校验失败。
   */
  eventToCommand: Record<string, string>;
  /**
   * event → hooks.json 中实际的 group index(0-based 数组位置)。
   * 当其他第三方 hook 排在前面时,pilot 的 hook 可能在 1、2... 位置。
   * 由 HookStrategy.writeCodexTrust 从 hooks.json 回读提供。
   */
  eventToGroupIndex: Record<string, number>;
  marker: string;                // BEGIN/END marker 名(如 "otel-codex-hook")
  forceBypass?: boolean;         // R4 应急:写 bypass_hook_trust = true
}

/**
 * 写入 trust block(幂等):
 *   1. 清已有 BEGIN/END 块
 *   2. 清裸的 [hooks.state."<owned>"] 残留(老插件残留)
 *   3. 写新 BEGIN/END 块(forceBypass=true 时块顶含 bypass_hook_trust = true)
 *
 * 注意 command 字符串与 hook 注册到 hooks.json 时一致:`bash <entryPath> <subcommand>`
 */
/** 同步读写 config.toml；文件错误或未知事件向 HookStrategy 抛出。 */
export function writeTrustedHashes(opts: WriteTrustedHashesOpts): void {
  const { configPath, hooksJsonAbsPath, hookEvents, eventToCommand, eventToGroupIndex, marker, forceBypass } = opts;

  let content = '';
  if (fs.existsSync(configPath)) {
    content = fs.readFileSync(configPath, 'utf-8');
  }

  const TRUST_BEGIN = `# BEGIN ${marker} trust`;
  const TRUST_END = `# END ${marker} trust`;

  // 步骤 1：删除 BEGIN/END marker 注释行（仅删注释行本身，不按范围删除，
  // 因为 codex 桌面版会重新序列化 TOML,导致 END marker 位移,范围删会误伤用户数据)
  content = content.split('\n')
    .filter((line) => line.trim() !== TRUST_BEGIN && line.trim() !== TRUST_END)
    .join('\n');

  // 步骤 1b：删除上次 forceBypass 留下的 bypass_hook_trust 行。
  content = content.split('\n')
    .filter((line) => !/^\s*bypass_hook_trust\s*=/.test(line))
    .join('\n');

  // 步骤 2：清理所有本项目拥有的 [hooks.state."<our path>:<our event>:<any group>:0"] 区段。
  content = removeStaleTrustState(content, hooksJsonAbsPath, hookEvents);

  // 步骤 3：写入新的 trust 区块。
  const lines: string[] = [TRUST_BEGIN];
  if (forceBypass) {
    lines.push('bypass_hook_trust = true');
    lines.push('');
  }
  for (const event of hookEvents) {
    const command = eventToCommand[event];
    if (!command) throw new Error(`Missing eventToCommand[${event}]`);
    const groupIndex = eventToGroupIndex[event] ?? 0;
    const hash = computeHookTrustHash(event, command);
    const key = hookStateKey(hooksJsonAbsPath, event, groupIndex);
    lines.push(`[hooks.state."${key}"]`);
    lines.push(`trusted_hash = "${hash}"`);
    lines.push('');
  }
  lines.push(TRUST_END);

  const separator = !content || content.endsWith('\n') ? '' : '\n';
  let out = content + separator + '\n' + lines.join('\n') + '\n';
  out = out.replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(configPath, out, 'utf-8');
}

/**
 * 删除 pilot 写入的 trust 条目(uninstall / 卸载场景)。
 *
 * 策略:逐条精确删除,不依赖 BEGIN/END 范围(codex 桌面版会重新序列化 TOML,
 * 导致 END marker 位移,范围删除会误伤 marker 之间的用户数据)。
 *
 * 删除顺序:
 *   1. 删 `# BEGIN <marker> trust` 和 `# END <marker> trust` 注释行
 *   2. 删 `bypass_hook_trust = true` 行(forceBypass 应急开关)
 *   3. 逐条删 `[hooks.state."<hooksJsonAbsPath>:<owned_event>:<any_group>:0"]` section
 *
 * @param hooksJsonAbsPath 不传时退化为只删 marker 注释行(兼容老的 installer 调用)
 * @param hookEvents 不传时退化为只删 marker 注释行
 */
/** 纯字符串变换：删除 marker 注释及可识别的 owned state。 */
export function removeTrustBlock(
  configPath: string,
  marker: string,
  hooksJsonAbsPath?: string,
  hookEvents?: readonly string[],
): boolean {
  if (!fs.existsSync(configPath)) return false;
  let content = fs.readFileSync(configPath, 'utf-8');
  const before = content;

  const TRUST_BEGIN = `# BEGIN ${marker} trust`;
  const TRUST_END = `# END ${marker} trust`;

  // 步骤 1：删除 BEGIN/END marker 注释行（只删注释行，不删除中间内容）。
  content = content.split('\n')
    .filter((line) => line.trim() !== TRUST_BEGIN && line.trim() !== TRUST_END)
    .join('\n');

  // 步骤 2：删除 bypass_hook_trust 行（如果存在）。
  content = content.split('\n')
    .filter((line) => !/^\s*bypass_hook_trust\s*=/.test(line))
    .join('\n');

  // 步骤 3：逐条删除本项目拥有的 [hooks.state."<owned>"] 区段。
  if (hooksJsonAbsPath && hookEvents) {
    content = removeStaleTrustState(content, hooksJsonAbsPath, hookEvents);
  }

  content = content.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

  if (content === before) return false;
  fs.writeFileSync(configPath, content, 'utf-8');
  return true;
}

export interface VerifyTrustHashesOpts {
  /** Codex 用户配置文件；函数只读取其中由 Pilot 管理的 trust block。 */
  configPath: string;
  /** 参与 trust key 计算的 hooks.json 绝对路径。 */
  hooksJsonAbsPath: string;
  /** 需要逐项核验的 Hook 事件名，顺序不影响结果。 */
  hookEvents: readonly string[];
  /** event → 实际写入 hooks.json 的完整 command 字符串(与 writeTrustedHashes 一致)。 */
  eventToCommand: Record<string, string>;
  /** event → hooks.json 中实际的 group index(与 writeTrustedHashes 一致)。 */
  eventToGroupIndex: Record<string, number>;
  /** BEGIN/END 管理块标记，用来隔离用户自行维护的 trust 条目。 */
  marker: string;
}

export interface VerifyResult {
  /** 所有目标事件都存在且 hash 一致时为 true。 */
  valid: boolean;
  /** 面向日志的缺失映射、缺失 key 或 hash 不一致说明。 */
  mismatches: string[];
}

/**
 * 自洽性检查 (Q8):重新 parse config.toml,把每条 trust state 与本地重算的 hash 对比。
 * 仅校验 pilot 自己写入的(BEGIN/END 块内的)条目。
 *
 * 用途: deploy 后立即调用,确认我们写入正确(防止 string 拼接错位等);失败时 logger.error。
 *       不直接阻塞 deploy(让 hook-watchdog 活性检查再次触发 redeploy 兜底)。
 */
/** 重读并逐事件比较 expected/actual，返回报告而不因不一致抛错。 */
export function verifyTrustHashes(opts: VerifyTrustHashesOpts): VerifyResult {
  const { configPath, hooksJsonAbsPath, hookEvents, eventToCommand, eventToGroupIndex, marker } = opts;
  // 配置文件不存在属于核验失败而非异常，让部署调用方仍可按既定 fail-open 策略继续。
  if (!fs.existsSync(configPath)) {
    return { valid: false, mismatches: ['config.toml missing'] };
  }
  // parseTrustBlock 只返回 marker 管理范围内的 key/hash，避免把用户条目误判为 Pilot 输出。
  const content = fs.readFileSync(configPath, 'utf-8');
  const parsed = parseTrustBlock(content, marker);
  const parsedMap = new Map(parsed.map((p) => [p.key, p.hash]));

  const mismatches: string[] = [];
  for (const event of hookEvents) {
    // command 必须与 hooks.json 实际写入文本逐字一致，否则重算 hash 没有意义。
    const command = eventToCommand[event];
    if (!command) {
      mismatches.push(`event=${event} missing command mapping`);
      continue;
    }
    // groupIndex 缺失时沿用 writer 的默认组 0，确保生成相同 trust state key。
    const groupIndex = eventToGroupIndex[event] ?? 0;
    const expectedKey = hookStateKey(hooksJsonAbsPath, event, groupIndex);
    const expectedHash = computeHookTrustHash(event, command);
    const actualHash = parsedMap.get(expectedKey);
    if (!actualHash) {
      // 分开报告“没有 key”和“有 key 但 hash 不同”，便于判断是拼接位置还是 command 内容错误。
      mismatches.push(`event=${event} missing key=${expectedKey}`);
    } else if (actualHash !== expectedHash) {
      mismatches.push(`event=${event} hash mismatch (expected=${expectedHash}, got=${actualHash})`);
    }
  }
  return { valid: mismatches.length === 0, mismatches };
}
