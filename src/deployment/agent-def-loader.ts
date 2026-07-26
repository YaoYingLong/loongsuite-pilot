import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentDefinition } from '../types/index.js';
import { resolveHome } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AgentDefLoader');

const REQUIRED_FIELDS: (keyof AgentDefinition)[] = ['id', 'displayName', 'deployMode', 'detection'];

export interface AgentDefLoaderOptions {
  /** 随安装包发布的 agents.d 目录。 */
  builtinDir: string;
  /** 用户自定义的 agents.d.local 目录。 */
  localDir: string;
  /** 安装包根目录，用于展开 $PILOT_DIR。 */
  pilotDir: string;
  /** 运行数据目录，用于展开 $PILOT_DATA。 */
  dataDir: string;
}

/**
 * Agent 声明加载器。
 *
 * 它负责读取 JSON 声明、递归展开路径变量、执行最低限度的结构校验，并按 Agent id
 * 合并内置与本地定义。加载器被安装探测、启动部署和动态发现共同复用，因此这些流程
 * 看到的是同一份解析结果。
 */
export class AgentDefLoader {
  private readonly builtinDir: string;
  private readonly localDir: string;
  private readonly pilotDir: string;
  private readonly dataDir: string;

  constructor(opts: AgentDefLoaderOptions) {
    this.builtinDir = opts.builtinDir;
    this.localDir = opts.localDir;
    this.pilotDir = opts.pilotDir;
    this.dataDir = opts.dataDir;
  }

  async load(): Promise<AgentDefinition[]> {
    // 两个目录分别读取，目录不存在或个别文件无效都不会阻断另一来源的加载。
    const builtin = await this.loadFromDir(this.builtinDir);
    const local = await this.loadFromDir(this.localDir);

    // 先写入内置声明，再写入本地声明；Map#set 使相同 id 的本地版本整体覆盖内置版本。
    const merged = new Map<string, AgentDefinition>();
    for (const def of builtin) {
      merged.set(def.id, def);
    }
    for (const def of local) {
      merged.set(def.id, def);
    }

    const result = [...merged.values()];
    logger.info('agent definitions loaded', {
      builtin: builtin.length,
      local: local.length,
      total: result.length,
    });
    return result;
  }

  private async loadFromDir(dir: string): Promise<AgentDefinition[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      // agents.d.local 是可选目录；目录缺失或不可读时按空来源处理。
      logger.debug('agent definition directory not found', { dir });
      return [];
    }

    const defs: AgentDefinition[] = [];
    for (const entry of entries) {
      // 只接收 JSON；忽略 macOS 归档工具可能生成的 AppleDouble `._*` 元数据文件。
      if (!entry.endsWith('.json') || path.basename(entry).startsWith('._')) continue;
      const filePath = path.join(dir, entry);
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        // 变量展开先于校验和下游使用，保证部署与探测拿到的都是最终路径/命令。
        const resolved = this.resolveVariables(parsed) as unknown as AgentDefinition;

        if (!this.validate(resolved, filePath)) continue;

        defs.push(resolved);
      } catch (err) {
        // 单个声明格式错误只跳过该文件，其他 Agent 仍可继续加载。
        logger.warn('failed to parse agent definition', { file: filePath, error: String(err) });
      }
    }
    return defs;
  }

  private validate(def: unknown, filePath: string): def is AgentDefinition {
    // 此处只验证所有下游共同依赖的骨架字段，不替代各部署策略对专属配置的校验。
    if (!def || typeof def !== 'object') {
      logger.warn('invalid agent definition: not an object', { file: filePath });
      return false;
    }
    const obj = def as Record<string, unknown>;
    for (const field of REQUIRED_FIELDS) {
      if (obj[field] === undefined || obj[field] === null) {
        logger.warn('invalid agent definition: missing required field', { file: filePath, field });
        return false;
      }
    }
    const mode = obj.deployMode;
    if (mode !== 'hook' && mode !== 'plugin-probe' && mode !== 'plugin-inject' && mode !== 'detection-only') {
      logger.warn('invalid agent definition: unknown deployMode', { file: filePath, deployMode: mode });
      return false;
    }
    return true;
  }

  // 声明中的占位符可能出现在嵌套对象或数组中，因此需要递归遍历全部值。
  private resolveVariables(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = this.resolveValue(value);
    }
    return result;
  }

  private resolveValue(value: unknown): unknown {
    if (typeof value === 'string') {
      return this.resolveString(value);
    }
    if (Array.isArray(value)) {
      return value.map(v => this.resolveValue(v));
    }
    if (value && typeof value === 'object') {
      return this.resolveVariables(value as Record<string, unknown>);
    }
    return value;
  }

  private resolveString(s: string): string {
    // 先替换项目级占位符，再展开开头的 ~，使声明文件不依赖具体安装用户和绝对路径。
    let result = s
      .replace(/\$PILOT_DIR/g, this.pilotDir)
      .replace(/\$PILOT_DATA/g, this.dataDir);

    result = resolveHome(result);

    if (process.platform === 'win32') {
      // 声明统一使用正斜杠；Windows 下同时将命令中的 shell 脚本入口映射为 PowerShell。
      result = result.replace(/\\/g, '/');
      result = result.replace(/\.sh(?=\s|$)/, '.ps1');
    }
    return result;
  }
}
