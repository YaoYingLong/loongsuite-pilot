/**
 * 通过 Agent JSON/JSONC 配置数组注入本地插件 spec 的部署策略。
 *
 * OpenCode、Pi 等 Agent 使用本类。它查找首个候选配置，可按声明以 0600 权限创建
 * 空文件，解析时容忍 JSONC 注释，去除旧 spec 后写入解析完成的 `$PILOT_DATA` 路径。
 * 因标准 JSON.stringify 无法保留 JSONC 注释，检测到非标准格式时先生成 `.bak`；
 * Watchdog 通过 `needsDeploy()` 检查配置被覆盖的情况。undeploy 只移除本项目匹配项，
 * 保留用户其他插件。
 */


import * as fs from 'node:fs/promises';
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
  let result = '';
  let i = 0;
  let inString = false;
  let escape = false;

  while (i < text.length) {
    const ch = text[i];

    if (inString) {
      result += ch;
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      i++;
      continue;
    }

    if (ch === '/' && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === '/') {
        // 单行注释：跳到换行符，保留换行本身。
        i += 2;
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (next === '*') {
        // 多行注释：跳过到结束符。
        i += 2;
        while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
    }

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
    const config = def.pluginInject;
    if (!config) return true;

    const configPath = await this.findConfigFile(config, false);
    if (!configPath) return true;

    try {
      const raw = await fs.readFile(configPath, 'utf-8');
      const json = JSON.parse(stripJsoncComments(raw));
      const pluginKey = this.resolvePluginKey(json, config);
      const plugins: unknown[] = json[pluginKey] ?? [];
      if (!Array.isArray(plugins)) return true;

      const resolvedSpec = this.resolveSpec(config.pluginSpec);
      return !plugins.some((entry) => this.matchesSpec(entry, resolvedSpec, config.pluginId));
    } catch (err) {
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
      const configPath = await this.findConfigFile(config, config.createIfMissing === true);
      if (!configPath) {
        return {
          success: false,
          agentId: def.id,
          deployMode: 'plugin-inject',
          error: `no config file found in: ${config.configPaths.join(', ')}`,
        };
      }

      const raw = await fs.readFile(configPath, 'utf-8');
      const json = JSON.parse(stripJsoncComments(raw));
      const pluginKey = this.resolvePluginKey(json, config);

      if (!Array.isArray(json[pluginKey])) {
        json[pluginKey] = [];
      }

      const resolvedSpec = this.resolveSpec(config.pluginSpec);

      // 删除声明列出的旧版或被替换 spec。
      if (config.replaceSpecs?.length) {
        json[pluginKey] = (json[pluginKey] as unknown[]).filter((entry) => {
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

      json[pluginKey].push(resolvedSpec);

      const hasComments = raw !== JSON.stringify(JSON.parse(stripJsoncComments(raw)), null, 2) + '\n';
      if (hasComments) {
        logger.warn('config will be rewritten as JSON; JSONC comments in the original file will be removed', { configPath });
        await fs.writeFile(configPath + '.bak', raw, 'utf-8');
      }

      await fs.writeFile(configPath, JSON.stringify(json, null, 2) + '\n', 'utf-8');
      logger.info('plugin injected', { agentId: def.id, configPath, spec: resolvedSpec });
      return { success: true, agentId: def.id, deployMode: 'plugin-inject' };
    } catch (err) {
      return { success: false, agentId: def.id, deployMode: 'plugin-inject', error: String(err) };
    }
  }

  /** 从首个现有配置中删除本项目 spec；不删除用户其他插件。 */
  async undeploy(def: AgentDefinition): Promise<boolean> {
    const config = def.pluginInject;
    if (!config) return false;

    try {
      const configPath = await this.findConfigFile(config, false);
      if (!configPath) return false;

      const raw = await fs.readFile(configPath, 'utf-8');
      const json = JSON.parse(stripJsoncComments(raw));
      const pluginKey = this.resolvePluginKey(json, config);

      if (!Array.isArray(json[pluginKey])) return true;

      const resolvedSpec = this.resolveSpec(config.pluginSpec);
      const before = (json[pluginKey] as unknown[]).length;
      json[pluginKey] = (json[pluginKey] as unknown[]).filter(
        (entry) => !this.matchesSpec(entry, resolvedSpec, config.pluginId),
      );

      if ((json[pluginKey] as unknown[]).length < before) {
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
    for (const p of config.configPaths) {
      const resolved = resolveHome(p);
      if (await fileExists(resolved)) return resolved;
    }

    if (createIfMissing && config.configPaths.length > 0) {
      const resolved = resolveHome(config.configPaths[0]);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, '{}\n', {
        encoding: 'utf-8',
        flag: 'wx',
        mode: 0o600,
      }).catch(async err => {
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
    if (config.configKey) return config.configKey;
    if (Array.isArray(json.plugins)) return 'plugins';
    return 'plugin';
  }

  /** 展开运行数据目录占位符。 */
  private resolveSpec(spec: string): string {
    return spec.replace(/\$PILOT_DATA/g, this.dataDir);
  }

  /** 支持字符串 spec 与 `[spec, options]` 数组写法，并兼容按 pluginId 识别旧路径。 */
  private matchesSpec(entry: unknown, resolvedSpec: string, pluginId: string): boolean {
    const entryStr = typeof entry === 'string'
      ? entry
      : Array.isArray(entry)
        ? String(entry[0])
        : '';

    return entryStr === resolvedSpec || entryStr.includes(pluginId);
  }
}
