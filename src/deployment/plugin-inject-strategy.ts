/**
 * 通过 Agent JSON/JSONC 配置数组注入本地插件 spec 的部署策略。
 *
 * OpenCode、Pi 等 Agent 使用本类。它查找首个候选配置，可按声明以 0600 权限创建
 * 空文件，解析时容忍 JSONC 注释，去除旧 spec 后写入解析完成的 `$PILOT_DATA` 路径。
 * 因标准 JSON.stringify 无法保留 JSONC 注释，检测到非标准格式时先生成 `.bak`；
 * Watchdog 通过 `needsDeploy()` 检查配置被覆盖的情况。undeploy 只移除本项目匹配项，
 * 保留用户其他插件。
 */


// Promise 版 fs 用于异步读取、备份和重写 Agent 配置，避免在 Collector 启动链中同步阻塞。
import * as fs from 'node:fs/promises';
// path 只负责跨平台计算配置父目录；候选配置路径本身来自 agents.d 声明。
import * as path from 'node:path';
import type {
  AgentDefinition,
  DeployResult,
  DeployStrategy,
  DeployedAgentRecord,
  PluginInjectConfig,
} from '../types/index.js';
import { fileExists, resolveHome } from '../utils/fs-utils.js';
import { detectAgent } from './detect-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('PluginInjectStrategy');

/**
 * 去掉 JSONC 单行/多行注释，使标准 JSON.parse 可以读取；字符串内部的斜杠不处理。
 */
function stripJsoncComments(text: string): string {
  // result 逐字符累积去掉注释后的 JSON；不直接用正则，是为了不误删字符串中的 `//`。
  let result = '';
  // i 是 UTF-16 code unit 下标；这里只识别 ASCII 语法字符，因此逐下标访问足够。
  let i = 0;
  // inString/escape 共同区分 JSON 字符串内容与真正的注释起始符。
  let inString = false;
  let escape = false;

  while (i < text.length) {
    // 每轮只判断当前位置，分支负责把 i 推进到下一个尚未处理的字符。
    const ch = text[i];

    if (inString) {
      // 字符串内容必须原样保留，包括看起来像 `//` 或 `/*` 的 URL、路径等文本。
      result += ch;
      if (escape) {
        // 前一个反斜杠已经转义当前字符；当前字符不能再结束字符串。
        escape = false;
      } else if (ch === '\\') {
        // 下一字符被转义，例如 `\"` 中的双引号不是字符串结束符。
        escape = true;
      } else if (ch === '"') {
        // 只有未转义双引号才退出字符串状态。
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      // 起始引号本身属于合法 JSON，写入结果后再进入字符串状态。
      inString = true;
      result += ch;
      i++;
      continue;
    }

    if (ch === '/' && i + 1 < text.length) {
      // 单独的 `/` 不是注释；必须结合下一字符判断 `//` 或 `/*`。
      const next = text[i + 1];
      if (next === '/') {
        // 单行注释：跳到换行符，保留换行本身。
        i += 2;
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (next === '*') {
        // 多行注释：跨行跳到第一个 `*/`。输入若未闭合，循环会自然消费到文本末尾；
        // 本函数不单独报告该语法问题，剩余 JSON 若也不完整，JSON.parse 会交给上层处理。
        i += 2;
        while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
    }

    // 普通 JSON 语法或空白不需要转换，保持原字符和换行位置。
    result += ch;
    i++;
  }

  return result;
}

/**
 * 实现 DeployStrategy 的 JSON/JSONC 插件配置注入器。
 *
 * DeploymentManager 根据 Agent 声明调用 `detect()`、`needsDeploy()`、`deploy()` 和
 * `undeploy()`。实例只保存 dataDir；每次操作都重新读取目标配置，避免长期缓存覆盖
 * 用户修改。部署会写配置并可能创建备份，卸载只删除本项目 spec；本类不启动 Worker、
 * timer 或网络请求，文件异常会转换为失败 DeployResult 或“需要修复”的判断。
 */
export class PluginInjectStrategy implements DeployStrategy {
  /** 插件 spec 中 `$PILOT_DATA` 占位符的展开值，不等同于当前安装版本目录。 */
  private readonly dataDir: string;

  /** @param dataDir 用于展开 pluginSpec 中的 $PILOT_DATA。 */
  constructor(dataDir: string, _pilotDir: string) {
    this.dataDir = dataDir;
  }

  /** 按声明路径/命令判断 Agent 是否安装。 */
  async detect(def: AgentDefinition): Promise<boolean> {
    return detectAgent(def.detection);
  }

  /**
   * 查找配置并验证目标 plugin 数组是否含匹配 spec；读取/解析异常按需要修复返回 true。
   */
  async needsDeploy(def: AgentDefinition, _record?: DeployedAgentRecord): Promise<boolean> {
    // 声明缺少本策略必需配置时无法证明部署健康，返回 true 让 deploy() 生成明确失败结果。
    const config = def.pluginInject;
    if (!config) return true;

    // 健康检查必须只读；这里禁止为了检查而提前创建用户配置文件。
    const configPath = await this.findConfigFile(config, false);
    if (!configPath) return true;

    try {
      // 解析前只移除 JSONC 注释；尾逗号等其他 JSONC 扩展并未支持，解析失败会要求重部署。
      const raw = await fs.readFile(configPath, 'utf-8');
      const json = JSON.parse(stripJsoncComments(raw));
      // 不同 Agent 分别使用 `plugin`、`plugins` 或声明指定的键，统一解析后再读取数组。
      const pluginKey = this.resolvePluginKey(json, config);
      const plugins: unknown[] = json[pluginKey] ?? [];
      if (!Array.isArray(plugins)) return true;

      // 比较时必须使用部署后真实路径，否则声明里的 `$PILOT_DATA` 永远无法与磁盘值相等。
      const resolvedSpec = this.resolveSpec(config.pluginSpec);
      return !plugins.some((entry) => this.matchesSpec(entry, resolvedSpec, config.pluginId));
    } catch (err) {
      // Watchdog 也调用 needsDeploy()。读文件或解析失败时采用“需要修复”，让后续 deploy()
      // 尝试恢复并留下可诊断结果，而不是把异常抛出导致整轮健康检查中断。
      logger.warn('failed to read config file', { configPath, error: String(err) });
      return true;
    }
  }

  /**
   * 注入插件 spec。按需创建 0600 空配置，删除替换项/重复项；若原文件可能含 JSONC，
   * 先写 `.bak` 再以标准 JSON 重写。所有异常转换为失败 DeployResult。
   */
  async deploy(def: AgentDefinition): Promise<DeployResult> {
    const config = def.pluginInject;
    if (!config) {
      return { success: false, agentId: def.id, deployMode: 'plugin-inject', error: 'missing pluginInject config' };
    }

    try {
      // createIfMissing 由 Agent 声明决定；关闭时不会擅自创建一个全新的用户配置。
      const configPath = await this.findConfigFile(config, config.createIfMissing === true);
      if (!configPath) {
        return {
          success: false,
          agentId: def.id,
          deployMode: 'plugin-inject',
          error: `no config file found in: ${config.configPaths.join(', ')}`,
        };
      }

      // 每次部署重新读取最新磁盘内容，避免覆盖 Agent 或用户在 Collector 运行期间的修改。
      const raw = await fs.readFile(configPath, 'utf-8');
      const json = JSON.parse(stripJsoncComments(raw));
      const pluginKey = this.resolvePluginKey(json, config);

      // 键不存在或类型不对时重建为空数组；其他顶层配置字段保持原值。
      if (!Array.isArray(json[pluginKey])) {
        json[pluginKey] = [];
      }

      // 从此处起数组中写入的是展开后的本机绝对路径，不再保留占位符。
      const resolvedSpec = this.resolveSpec(config.pluginSpec);

      // 删除声明列出的旧版或被替换 spec。
      if (config.replaceSpecs?.length) {
        json[pluginKey] = (json[pluginKey] as unknown[]).filter((entry) => {
          // Agent 配置既可能用字符串，也可能用 `[spec, options]`；这里只检查数组首项的 spec。
          const entryStr = typeof entry === 'string' ? entry : Array.isArray(entry) ? entry[0] : '';
          return !config.replaceSpecs!.some((old) =>
            typeof entryStr === 'string' && entryStr.includes(old),
          );
        });
      }

      // 先删除当前匹配项，再追加一次，保证幂等且顺序稳定。
      json[pluginKey] = (json[pluginKey] as unknown[]).filter(
        (entry) => !this.matchesSpec(entry, resolvedSpec, config.pluginId),
      );

      // push 放在去重之后，所以重复执行 deploy() 最终仍只保留一个本项目条目。
      json[pluginKey].push(resolvedSpec);

      // 这个比较同时会把“含注释”和“排版不同于两空格标准 JSON”判为 true；因此 `.bak`
      // 不只保护注释，也会在格式被重写前保留原始文本。备份失败会使本次部署整体失败。
      const hasComments = raw !== JSON.stringify(JSON.parse(stripJsoncComments(raw)), null, 2) + '\n';
      if (hasComments) {
        logger.warn('config will be rewritten as JSON; JSONC comments in the original file will be removed', { configPath });
        await fs.writeFile(configPath + '.bak', raw, 'utf-8');
      }

      // 标准 JSON.stringify 会丢掉 JSONC 注释；上面的备份是当前唯一恢复入口。此处不是
      // 临时文件 + rename 的原子写，进程中断可能留下不完整配置（当前行为，待确认）。
      await fs.writeFile(configPath, JSON.stringify(json, null, 2) + '\n', 'utf-8');
      logger.info('plugin injected', { agentId: def.id, configPath, spec: resolvedSpec });
      return { success: true, agentId: def.id, deployMode: 'plugin-inject' };
    } catch (err) {
      // DeployStrategy 用结构化结果报告失败；DeploymentManager 会记录后继续处理其他 Agent。
      return { success: false, agentId: def.id, deployMode: 'plugin-inject', error: String(err) };
    }
  }

  /** 从首个现有配置中删除本项目 spec；不删除用户其他插件。 */
  async undeploy(def: AgentDefinition): Promise<boolean> {
    const config = def.pluginInject;
    if (!config) return false;

    try {
      // 卸载不会创建配置；目标已不存在时返回 false，交给调用方解释为无可清理内容。
      const configPath = await this.findConfigFile(config, false);
      if (!configPath) return false;

      // 与 deploy 使用同一 JSONC 兼容读取和键选择逻辑，确保识别规则对称。
      const raw = await fs.readFile(configPath, 'utf-8');
      const json = JSON.parse(stripJsoncComments(raw));
      const pluginKey = this.resolvePluginKey(json, config);

      if (!Array.isArray(json[pluginKey])) return true;

      const resolvedSpec = this.resolveSpec(config.pluginSpec);
      const before = (json[pluginKey] as unknown[]).length;
      // 只删除路径完全相等或包含 pluginId 的本项目条目；其他插件及其 options 原样保留。
      json[pluginKey] = (json[pluginKey] as unknown[]).filter(
        (entry) => !this.matchesSpec(entry, resolvedSpec, config.pluginId),
      );

      if ((json[pluginKey] as unknown[]).length < before) {
        // 只有确实删除了条目才重写文件，避免健康配置产生无意义 mtime/格式变化。
        const hasComments = raw !== JSON.stringify(JSON.parse(stripJsoncComments(raw)), null, 2) + '\n';
        if (hasComments) {
          logger.warn('config will be rewritten as JSON; JSONC comments in the original file will be removed', { configPath });
          await fs.writeFile(configPath + '.bak', raw, 'utf-8');
        }
        await fs.writeFile(configPath, JSON.stringify(json, null, 2) + '\n', 'utf-8');
        logger.info('plugin removed', { agentId: def.id, configPath });
      }

      return true;
    } catch (err) {
      logger.error('undeploy failed', { agentId: def.id, error: String(err) });
      return false;
    }
  }

  /**
   * 返回首个存在的候选配置；允许创建时用 `wx` 避免覆盖并发新建文件。
   */
  private async findConfigFile(
    config: PluginInjectConfig,
    createIfMissing: boolean,
  ): Promise<string | null> {
    // 候选顺序由 agents.d 声明定义；首个已存在路径胜出，不会合并多个配置文件。
    for (const p of config.configPaths) {
      const resolved = resolveHome(p);
      if (await fileExists(resolved)) return resolved;
    }

    if (createIfMissing && config.configPaths.length > 0) {
      // 全部候选均不存在时只创建第一项，这是声明作者指定的首选位置。
      const resolved = resolveHome(config.configPaths[0]);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      // `wx` 表示“仅当文件不存在时创建”，0600 限制为当前用户读写，避免默认配置
      // 在 Unix 上继承过宽权限；Windows 会按平台能力处理 mode。
      await fs.writeFile(resolved, '{}\n', {
        encoding: 'utf-8',
        flag: 'wx',
        mode: 0o600,
      }).catch(async err => {
        // 检查与创建之间可能由 Agent 自己生成配置；EEXIST 代表竞态中的另一方已成功创建，
        // 此时继续使用该路径。其他权限或 I/O 错误仍向 deploy() 传播。
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      });
      return resolved;
    }
    return null;
  }

  /** 显式 configKey 优先，否则沿用现有 plugins 数组，最后默认 plugin。 */
  private resolvePluginKey(
    json: Record<string, unknown>,
    config: PluginInjectConfig,
  ): string {
    // 显式声明最可靠；否则只有当前值确为数组时才沿用复数键，避免把任意同名对象当列表。
    if (config.configKey) return config.configKey;
    if (Array.isArray(json.plugins)) return 'plugins';
    return 'plugin';
  }

  /** 展开运行数据目录占位符。 */
  private resolveSpec(spec: string): string {
    // 使用全局正则替换同一字符串中的所有占位符；不执行 shell/env 展开。
    return spec.replace(/\$PILOT_DATA/g, this.dataDir);
  }

  /** 支持字符串 spec 与 `[spec, options]` 数组写法，并兼容按 pluginId 识别旧路径。 */
  private matchesSpec(entry: unknown, resolvedSpec: string, pluginId: string): boolean {
    // 数组格式的第 0 项是插件定位符，其余 options 不参与归属判断。
    const entryStr = typeof entry === 'string'
      ? entry
      : Array.isArray(entry)
        ? String(entry[0])
        : '';

    // includes(pluginId) 用于识别版本变化或旧安装路径，但也可能命中名称中包含该 ID 的
    // 第三方 spec；agents.d 中的 pluginId 因此必须足够具体。
    return entryStr === resolvedSpec || entryStr.includes(pluginId);
  }
}
