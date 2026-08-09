/**
 * 声明式 Agent 定义加载器。
 *
 * 安装探测和 DeploymentManager 都通过本类读取安装包 `agents.d/*.json` 与用户
 * `<dataDir>/agents.d.local/*.json`；本地同 ID 定义覆盖内置定义。加载时递归展开
 * `$PILOT_DIR`、`$PILOT_DATA`、`~`，并在 Windows 映射脚本后缀。单文件 JSON 或骨架
 * 校验失败只跳过该 Agent，具体部署模式的专属字段由相应 Strategy 再验证。
 */


// Promise 版 fs API 让目录/文件读取可直接配合 async/await；本模块不使用同步 I/O。
import * as fs from 'node:fs/promises';
// `path` 仅用于跨平台拼接声明文件路径和识别 AppleDouble 文件名。
import * as path from 'node:path';
// 类型导入在编译后移除；JSON.parse 的结果仍需 validate 做运行时守卫。
import type { AgentDefinition } from '../types/index.js';
// resolveHome 只负责把用户目录占位写成当前运行用户的实际路径。
import { resolveHome } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AgentDefLoader');

/** 所有 Strategy 在分派前都必须看到的最低字段；模式专属字段留给各 Strategy 校验。 */
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
  /** 随当前版本发布、通常只读的内置声明目录。 */
  private readonly builtinDir: string;
  /** 用户可写覆盖目录；不存在是正常状态。 */
  private readonly localDir: string;
  /** 用于递归替换 `$PILOT_DIR` 的当前版本包根。 */
  private readonly pilotDir: string;
  /** 用于递归替换 `$PILOT_DATA` 的持久数据根。 */
  private readonly dataDir: string;

  /** 保存四个路径参数；构造时不访问目录。 */
  constructor(opts: AgentDefLoaderOptions) {
    this.builtinDir = opts.builtinDir;
    this.localDir = opts.localDir;
    this.pilotDir = opts.pilotDir;
    this.dataDir = opts.dataDir;
  }

  /**
   * 依次按来源加载，随后按 ID 让本地声明整体覆盖内置声明。
   * @returns 合并后的定义数组；顺序以首次出现的 ID 为准，本地覆盖不会把既有 ID 移到末尾。
   * @remarks 单目录和单文件错误由 loadFromDir 隔离，所以常规坏声明不会 reject 整次加载。
   */
  async load(): Promise<AgentDefinition[]> {
    // 两个目录分别读取，目录不存在或个别文件无效都不会阻断另一来源的加载。
    // 顺序读取使日志先呈现内置来源再呈现用户来源；两次 I/O 彼此不依赖但当前没有 Promise.all。
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

  /**
   * 读取一个目录的 JSON 文件；目录或单文件错误均按来源内 fail-open。
   * @param dir 内置或本地声明目录。
   * @returns 按底层 readdir 返回顺序收集的有效定义；本方法不显式排序文件名。
   */
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
        // UTF-8 文本先由 JSON.parse 还原普通对象；JSON 文件不能包含注释或尾随逗号。
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

  /**
   * 只校验跨 Strategy 共用的骨架字段和 deployMode，返回 TypeScript 类型守卫。
   * @returns 最低字段非 null 且 deployMode 在白名单中时为 true。
   * @remarks 当前不验证 id/displayName 的字符串类型或 detection 的内部结构，专属错误可能延后到 Strategy 暴露。
   */
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
  // 输入源自 JSON.parse，只包含无循环引用的普通 JSON 值，递归无需处理原型或环。
  private resolveVariables(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = this.resolveValue(value);
    }
    return result;
  }

  /**
   * 递归解析字符串、数组和普通对象中的占位符。
   * @returns 字符串被展开、容器被新建，数字/布尔/null 等原始值保持不变。
   */
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

  /**
   * 展开 Pilot/用户路径；Windows 额外规范斜杠并把命令入口 `.sh` 映射成 `.ps1`。
   * @returns 供检测和部署直接使用的最终字符串；不会检查目标路径是否真实存在。
   * @remarks `.sh` 正则只替换首个且必须位于空白或结尾前的脚本后缀，避免修改普通参数文本。
   */
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
