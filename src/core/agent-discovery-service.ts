/**
 * Agent/Input 动态发现与生命周期状态机。
 *
 * `Orchestrator` 传入声明式 `AgentDetectionEntry`：既包括 Input 条目，也包括运行期
 * 新安装 Agent 的 `deploy:<id>` 条目。本服务优先用非持久化 `fs.watch` 响应路径变化，
 * 不支持 watch 时退化为定时轮询，并另设全局刷新。每个条目按
 * idle -> starting -> running -> stopping -> idle 驱动 start/stop；退出时关闭所有 watcher、
 * timer 和仍在运行的条目。一次全量 refresh 内部按条目串行，但 watcher 与 timer 回调可能
 * 交错触发，因此条目的 start/stop 回调仍应具备幂等性。
 */

// `node:fs` 提供目录级 `watch()` 和可关闭的 `FSWatcher` 句柄；本模块不直接读写 Agent 数据。
import * as fs from 'node:fs';
// 继承 EventEmitter 后，上层可旁听 started/stopped，而无需把诊断逻辑塞进生命周期回调。
import { EventEmitter } from 'node:events';
// `import type` 只参与 TypeScript 检查，编译后的 JavaScript 不会加载 types 模块。
import type { AgentDetectionEntry, EntryState } from '../types/index.js';
// 每个模块使用独立 logger 名称，便于从 Collector 日志定位发现阶段。
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AgentDiscoveryService');

/** 未单独指定时，条目轮询和全局兜底刷新都采用 5 分钟。 */
const DEFAULT_POLL_MS = 300_000;
// 测试、网络盘或 fs.watch 不可靠的部署可强制绕过 watcher，直接使用每条目轮询。
// 常量在模块首次 import 时读取环境变量；进程运行中再修改 env 不会改变既有选择。
const FORCE_POLLING = process.env.LOONGSUITE_PILOT_FORCE_POLLING === 'true';

interface EntryRuntime {
  /** Orchestrator/InputManager 提供的纯生命周期契约。 */
  entry: AgentDetectionEntry;
  /** 最近一次状态转换结果；不是跨回调互斥锁。 */
  state: EntryState;
  /** 成功建立的第一个目录 watcher；关闭后恢复为 null。 */
  watcher: fs.FSWatcher | null;
  /** watcher 无法建立或运行期报错时使用的该条目兜底 timer。 */
  pollTimer: ReturnType<typeof setInterval> | null;
}

/**
 * Agent 动态发现服务。
 *
 * 优先使用 `fs.watch` 监听候选路径，失败时回退到定时轮询。每个条目独立遵循
 * `idle -> starting -> running -> stopping -> idle` 状态机，避免重复启停同一个 Input
 * 或部署修复任务。
 *
 * 生命周期由 `Orchestrator.start()/stop()` 拥有。服务会发出 `agent:started` 和
 * `agent:stopped` 诊断事件，但真正的数据流仍由 entry.start() 启动的 Input 进入
 * InputManager；EventEmitter 事件本身不携带采集数据。
 */
export class AgentDiscoveryService extends EventEmitter {
  /** ID 到条目运行态映射，Map 保留构造参数顺序，决定 refresh/stop 的处理顺序。 */
  private readonly runtimes: Map<string, EntryRuntime> = new Map();
  /** 即使 watcher 健康也会运行的全局兜底刷新，覆盖未产生文件事件的可用性变化。 */
  private globalPollTimer: ReturnType<typeof setInterval> | null = null;

  /** @param entries Orchestrator 构造的 Input 与 deploy 动态发现条目。 */
  constructor(entries: AgentDetectionEntry[]) {
    super();
    // 构造阶段只登记状态，不访问文件系统，也不启动 Input；实际副作用全部留到 start()。
    // ID 是 Map 主键：若调用方误传重复 ID，后出现的条目会覆盖前者，但仍占据原键的位置。
    for (const entry of entries) {
      this.runtimes.set(entry.id, {
        entry,
        state: 'idle',
        watcher: null,
        pollTimer: null,
      });
    }
  }

  /**
   * 为每个条目建立 watcher，立即串行刷新一次，再创建全局轮询 timer。
   * 首轮条目异常通常已在 processEntry 内隔离。
   *
   * @returns 首轮所有条目完成可用性检查和启停尝试后兑现。
   * @remarks 全局 interval 没有 `unref()`，会维持 Node.js 事件循环；正常退出必须调用 stop()。
   */
  async start(): Promise<void> {
    // 先尽力建立低延迟监听；路径不存在的条目会在 setupWatcher() 内自动改用轮询。
    for (const [id, rt] of this.runtimes) {
      this.setupWatcher(rt);
    }
    // watcher 只响应未来变化，因此启动时必须主动评估一次当前磁盘状态。
    await this.refresh('startup');

    // Number(...) 的 NaN/0 都回退默认值；负数虽会被 Node 截断为短间隔，调用方应传正数。
    const intervalMs = Number(process.env.LOONGSUITE_PILOT_DISCOVERY_INTERVAL_MS) || DEFAULT_POLL_MS;
    // interval 回调不能声明 async 给 setInterval 等待，因此显式丢弃 Promise；processEntry
    // 在内部捕获条目错误。timer 触发不保证上一轮 refresh 已完成。
    this.globalPollTimer = setInterval(() => void this.refresh('poll'), intervalMs);
  }

  /**
   * 关闭全部 timer/watcher，并顺序停止处于 running/starting 的条目。
   * @returns 所有 stop 回调完成后兑现。
   * @remarks `stopEntry()` 会隔离单条目的停止异常，因此一次失败不会中断后续条目清理。
   */
  async stop(): Promise<void> {
    // 先切断所有未来调度源，再停止条目，避免关闭过程中由 timer/watch 再次启动 Input。
    if (this.globalPollTimer) {
      clearInterval(this.globalPollTimer);
      this.globalPollTimer = null;
    }

    for (const rt of this.runtimes.values()) {
      if (rt.watcher) {
        rt.watcher.close();
        rt.watcher = null;
      }
      if (rt.pollTimer) {
        clearInterval(rt.pollTimer);
        rt.pollTimer = null;
      }
      if (rt.state === 'running' || rt.state === 'starting') {
        // starting 可能正处在 entry.start() 的 await 中；当前实现没有等待该 Promise 的专门
        // 句柄，条目的 stop() 必须自行处理“启动未完全结束”的生命周期场景（待确认）。
        await this.stopEntry(rt);
      }
    }
  }

  /**
   * 按注册顺序重新计算所有条目可用性；串行处理避免集中修改多个 Agent 配置。
   * @param trigger 仅写入 debug 日志，常见值为 startup、poll、manual，不影响判断规则。
   * @returns 本轮所有 `processEntry()` 完成后兑现；条目级错误已在内部隔离。
   */
  async refresh(trigger: string = 'manual'): Promise<void> {
    logger.debug('refresh triggered', { trigger });
    for (const rt of this.runtimes.values()) {
      await this.processEntry(rt);
    }
  }

  /**
   * 返回每个条目状态的普通对象快照。
   * @returns 新建的 `id -> EntryState` 对象；修改返回值不会改变内部状态机。
   */
  getStates(): Record<string, EntryState> {
    const out: Record<string, EntryState> = {};
    for (const [id, rt] of this.runtimes) {
      out[id] = rt.state;
    }
    return out;
  }

  /**
   * 执行 enabled/isAvailable 判断并驱动状态转换。runOnActive 条目即使已 running 也会
   * 再调用 start，用于活跃时刷新部署；异常被记录并将状态退回 idle。
   * @param rt 单个条目的声明、状态及 watcher/timer 句柄。
   * @returns 本次检查及可能的 start/stop 完成后兑现。
   */
  private async processEntry(rt: EntryRuntime): Promise<void> {
    const { entry } = rt;
    try {
      // enabled 是廉价同步门禁；关闭时不再访问磁盘执行 isAvailable()。
      const enabled = entry.enabled ? entry.enabled() : true;
      const available = enabled ? await entry.isAvailable() : false;
      const shouldRun = enabled && available;

      if (!shouldRun && rt.state === 'idle') {
        logger.debug('agent skipped', {
          id: entry.id,
          enabled,
          available,
        });
      }

      if (shouldRun && rt.state !== 'running') {
        // 在 await start() 前标记 starting，让 stop() 能识别半启动状态；但该条件只排除
        // running，另一个重叠回调看到 starting 时仍可能再次调用 start()，所以条目回调必须
        // 幂等（待确认是否需要为每个 runtime 增加 in-flight Promise）。
        rt.state = 'starting';
        logger.info('starting agent', { id: entry.id });
        // 调用具体的BaseInput的start方法
        await entry.start();
        rt.state = 'running';
        this.emit('agent:started', entry.id);
      } else if (!shouldRun && (rt.state === 'running' || rt.state === 'starting')) {
        await this.stopEntry(rt);
      } else if (shouldRun && rt.state === 'running' && entry.runOnActive) {
        // deploy:<id> 使用此分支做“仍活跃时重新校验/修复部署”；普通 Input 不设置它。
        await entry.start();
      }
    } catch (err) {
      // 发现与单 Agent 启停属于可选能力，异常被隔离在条目边界；下一轮会从 idle 重试。
      logger.error('processEntry failed', { id: entry.id, error: String(err) });
      rt.state = 'idle';
    }
  }

  /**
   * 调用条目 stop；即使 stop 抛错也恢复 idle 并发出 agent:stopped。
   * @param rt 将被原地更新为 stopping，最终恢复 idle 的条目运行态。
   */
  private async stopEntry(rt: EntryRuntime): Promise<void> {
    rt.state = 'stopping';
    try {
      await rt.entry.stop();
    } catch (err) {
      logger.warn('entry stop failed', { id: rt.entry.id, error: String(err) });
    }
    rt.state = 'idle';
    this.emit('agent:stopped', rt.entry.id);
  }

  /**
   * 尝试监听首个可用 watchPath；监听错误后关闭 watcher 并切换为 polling。
   * `persistent:false` 表示 watcher 本身不能阻止 Node 进程退出。
   * @param rt 要安装监听器的条目运行态；方法会原地写入 watcher 或 pollTimer。
   * @remarks 只保留第一个成功创建的 watcher；其余候选路径不会同时监听，全局轮询负责兜底。
   */
  private setupWatcher(rt: EntryRuntime): void {
    if (FORCE_POLLING) {
      this.setupPolling(rt);
      return;
    }

    for (const watchPath of rt.entry.watchPaths) {
      try {
        // 对 watchPath 目录 / 文件创建文件系统监听（inotify / FSEvents），当路径下发生新增、修改、删除、重命名时，触发回调函数。
        const watcher = fs.watch(watchPath, { persistent: false }, () => {
          // fs.watch 回调不能被文件系统等待；processEntry 自行捕获异常。多个文件事件可能
          // 在前一次异步检查完成前到达，状态字段只提供生命周期门禁，不提供 Promise 锁。
          void this.processEntry(rt);
        });
        watcher.on('error', () => {
          // 运行期 watcher 失效后立即关闭句柄，再建立且仅建立一个 interval 兜底。
          watcher.close();
          this.setupPolling(rt);
        });
        rt.watcher = watcher;
        return;
      } catch {
        // 路径不存在或平台不支持监听时，继续尝试其他候选路径。
      }
    }

    this.setupPolling(rt);
  }

  /**
   * 为条目创建兜底 interval；已有 timer 时保持幂等。
   * @param rt watcher 不可用或运行期失效的条目运行态。
   * @remarks 该 interval 也未 `unref()`，会由 stop() 明确清理。
   */
  private setupPolling(rt: EntryRuntime): void {
    if (rt.pollTimer) return;
    const interval = rt.entry.pollIntervalMs || DEFAULT_POLL_MS;
    // 与 watcher 回调相同，timer 只负责触发，不持有异步操作；错误在 processEntry 隔离。
    rt.pollTimer = setInterval(() => void this.processEntry(rt), interval);
  }
}
