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

  /**
   * 保存 checkpoint 文件位置；构造阶段不访问磁盘。
   *
   * @param filePath checkpoint JSON 的绝对路径，例如 `logs/input-state.json`。
   */
  constructor(filePath: string) {
    // ~/.loongsuite-pilot/logs/input-state.json
    this.filePath = filePath;
  }

  /**
   * 从磁盘恢复全部 Input 状态，并替换当前内存 Map。
   *
   * `readJsonFile()` 把文件不存在、无权限和 JSON 损坏统一降级为 null，因此这些情况都按空仓库
   * 启动。每个值只接受对象，避免数组/标量进入 InputState。加载结束把 dirty 清零，表示内存与
   * 当前读取结果一致。
   *
   * @returns 读取与内存重建完成后兑现的 Promise；当前工具层读失败不会 reject。
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
   * dirty 时把完整 Map 快照原子写回磁盘；无变更时立即返回。
   *
   * 这里写的是所有 Input 的全量状态，不是单 key 增量。`writeJsonFile()` 使用同目录临时文件加
   * rename，避免读到半份 JSON。只有 await 写入成功后才清 dirty；失败时仍为 true，后续周期
   * 可以重试。
   *
   * 本类没有 save Promise 串行门。多个 Input 共享实例并同时调用 save 时，可能各自构造不同
   * 时刻的快照；当前依赖上层调用节奏降低竞争，严格并发写入语义待确认。
   *
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

  /**
   * 读取一个 Input 的 checkpoint；不存在时返回新的空对象。
   *
   * 命中时当前实现返回 Map 中对象本身，并非深拷贝。调用方应把它视为只读快照并通过
   * `set/update` 修改，否则直接改属性不会设置 dirty，也可能无法落盘。
   */
  get(inputId: string): InputState {
    return this.states.get(inputId) ?? {};
  }

  /**
   * 用浅克隆整体替换一个 checkpoint，并把仓库标记为待保存。
   * @param inputId Input 唯一 ID；复杂 Pipeline 也可使用文件路径等复合 key。
   * @param state 新的完整状态；`extra` 只再浅复制一层。
   */
  set(inputId: string, state: InputState): void {
    this.states.set(inputId, cloneState(state));
    this.dirty = true;
  }

  /**
   * 合并局部 checkpoint；extra 额外做一层合并，避免覆盖同 Input 的其他专用字段。
   *
   * 顶层和 `extra` 都是浅合并；若 extra 内还有数组/对象，其引用不会递归克隆。无论字段值是否
   * 真正变化都会设置 dirty，换取实现简单和调用方一致语义。
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

  /** 删除 checkpoint；只有实际命中时才设置 dirty，并返回 Map.delete 的布尔结果。 */
  delete(inputId: string): boolean {
    const deleted = this.states.delete(inputId);
    if (deleted) this.dirty = true;
    return deleted;
  }

  /** 返回当前 key 数组副本；修改该数组不会改变仓库，状态对象仍需通过 get 单独读取。 */
  keys(): string[] {
    return Array.from(this.states.keys());
  }

  /**
   * 读取文件型 Input 的 byte offset，未保存时从 0 开始。
   * offset 是字节数而不是 UTF-16 字符数，必须直接传给 fs.read 的 position。
   */
  getOffset(inputId: string): number {
    return this.get(inputId).lastOffset ?? 0;
  }

/** 更新文件型 Input 的字节偏移；真正写盘延迟到 save()。 */
  setOffset(inputId: string, offset: number): void {
    this.update(inputId, { lastOffset: offset });
  }

  /**
   * 读取 SQLite Input 已消费的最大 `rowid`，未保存时为 0。
   * 子类查询通常使用严格条件 `rowid > lastRowId`，避免重复读取边界行。
   */
  getRowId(inputId: string): number {
    return this.get(inputId).lastRowId ?? 0;
  }

/** 更新 SQLite Input 的最大 row id；真正写盘延迟到 save()。 */
  setRowId(inputId: string, rowId: number): void {
    this.update(inputId, { lastRowId: rowId });
  }
}
