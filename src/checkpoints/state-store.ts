/**
 * Input 增量 checkpoint 的通用持久化仓库。
 *
 * `Orchestrator.start()` 在注册采集器前加载本类，并把同一实例交给所有 Input。
 * 文件 Input 保存字节 offset，SQLite Input 保存 row id，复杂采集器把专用状态放在
 * `extra`。`BaseInput` 在采集轮次和退出时调用 `save()`，最终原子写入
 * `<dataDir>/logs/input-state.json`。本类只有进程内 Map，不提供跨进程锁。
 */


import { InputState } from '../types/index.js';
import { readJsonFile, writeJsonFile } from '../utils/fs-utils.js';

/** 内存 Map 写入 JSON 文件时使用的可序列化对象结构。 */
type StateFileShape = Record<string, InputState>;

/** 复制状态，避免仓库保存调用方可继续直接修改的同一对象；extra 只做一层浅复制。 */
function cloneState(s: InputState): InputState {
  return {
    ...s,
    extra:
      s.extra && typeof s.extra === 'object'
        ? { ...s.extra }
        : s.extra,
  };
}

/**
 * 所有增量 Input 共用的 checkpoint 内存视图和延迟写盘器。
 *
 * Orchestrator 启动时先 `load()`，再把同一实例注入各 Input；Input 通过 `get/set/update`
 * 修改内存并设置 dirty，采集轮次或退出时调用 `save()` 原子持久化。类中没有后台任务，
 * 也没有跨进程锁，因此同一状态文件应只由一个 Collector 进程写入。读取方法返回快照
 * 或默认值，写入失败通过 Promise 拒绝交给调用方处理。
 */
export class StateStore {
  private readonly states: Map<string, InputState> = new Map();
  private readonly filePath: string;
  private dirty = false;

/** @param filePath checkpoint JSON 绝对路径；构造阶段不会访问磁盘。 */
  constructor(filePath: string) {
    // ~/.loongsuite-pilot/logs/input-state.json
    this.filePath = filePath;
  }

/**
 * 从磁盘恢复全部 Input 状态。文件不存在、为空或不是对象时按空仓库启动。
 * @returns 读取与内存重建完成后兑现的 Promise。
 */
  async load(): Promise<void> {
    const data = await readJsonFile<StateFileShape | null>(this.filePath);
    this.states.clear();
    if (!data || typeof data !== 'object' || data === null) {
      this.dirty = false;
      return;
    }
    for (const [id, st] of Object.entries(data)) {
      if (st && typeof st === 'object') {
        this.states.set(id, cloneState(st as InputState));
      }
    }
    this.dirty = false;
  }

/**
 * dirty 时将完整 Map 快照原子写回磁盘；无变更时立即返回。
 * @throws 文件写入失败时透传异常，由 BaseInput 采集循环或 Orchestrator 关闭流程记录。
 */
  async save(): Promise<void> {
    if (!this.dirty) {
      return;
    }
    const out: StateFileShape = {};
    for (const [k, v] of this.states) {
      out[k] = cloneState(v);
    }
    await writeJsonFile(this.filePath, out);
    this.dirty = false;
  }

/** 读取一个 Input 的 checkpoint；不存在时返回空对象。 */
  get(inputId: string): InputState {
    return this.states.get(inputId) ?? {};
  }

/** 整体替换 checkpoint，并把仓库标记为待保存。 */
  set(inputId: string, state: InputState): void {
    this.states.set(inputId, cloneState(state));
    this.dirty = true;
  }

/**
 * 合并局部 checkpoint；extra 额外做一层合并，避免覆盖同 Input 的其他专用字段。
 */
  update(inputId: string, partial: Partial<InputState>): void {
    const current = { ...this.get(inputId) };
    const merged = { ...current, ...partial };
    if (partial.extra && current.extra && typeof current.extra === 'object' && typeof partial.extra === 'object') {
      merged.extra = { ...current.extra, ...partial.extra };
    }
    this.states.set(inputId, cloneState(merged));
    this.dirty = true;
  }

/** 删除 checkpoint；只有实际命中时才设置 dirty，并返回 true。 */
  delete(inputId: string): boolean {
    const deleted = this.states.delete(inputId);
    if (deleted) this.dirty = true;
    return deleted;
  }

/** 返回 Input ID 数组副本。 */
  keys(): string[] {
    return Array.from(this.states.keys());
  }

/** 读取文件型 Input 的字节偏移，未保存时从 0 开始。 */
  getOffset(inputId: string): number {
    return this.get(inputId).lastOffset ?? 0;
  }

/** 更新文件型 Input 的字节偏移；真正写盘延迟到 save()。 */
  setOffset(inputId: string, offset: number): void {
    this.update(inputId, { lastOffset: offset });
  }

/** 读取 SQLite Input 的最大 row id，未保存时为 0。 */
  getRowId(inputId: string): number {
    return this.get(inputId).lastRowId ?? 0;
  }

/** 更新 SQLite Input 的最大 row id；真正写盘延迟到 save()。 */
  setRowId(inputId: string, rowId: number): void {
    this.update(inputId, { lastRowId: rowId });
  }
}
