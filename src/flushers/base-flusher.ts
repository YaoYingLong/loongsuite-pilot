/**
 * 所有输出通道共享的生命周期抽象。
 *
 * Orchestrator 根据配置构造子类，先调用 start，再由 InputManager 调用 send/sendBatch；停止时
 * 依次 flush 和 shutdown。新增后端应继承本类，使 MultiFlusher 能统一扇出和释放资源。
 */

import type { AgentActivityEntry } from '../types/index.js';

/**
 * 数据输出通道的抽象基类。
 * 子类负责明确自己的缓冲、失败与关闭语义。
 */
export abstract class BaseFlusher {
  /** 日志和 MultiFlusher 识别通道的稳定名称。 */
  abstract readonly name: string;

  /** 接收单条已应用内容策略和脱敏的标准事件。 */
  abstract send(entry: AgentActivityEntry): Promise<void>;
  /** 接收一个有序批次；实现应保持批次内必要的顺序语义。 */
  abstract sendBatch(entries: AgentActivityEntry[]): Promise<void>;
  /** 提交当前内存缓冲，但不一定释放连接或定时器。 */
  abstract flush(): Promise<void>;
  /** 停止定时器、提交余量并释放网络/文件资源。 */
  abstract shutdown(): Promise<void>;

  /** 可选异步初始化；无初始化需求的子类继承空实现。 */
  async start(): Promise<void> {
    // 子类可覆盖，例如创建目录、启动定时器或初始化客户端。
  }

  /** 原样输出 session/诊断等非 AgentActivityEntry 数据；默认不处理。 */
  async sendRaw(_topic: string, _payload: Record<string, unknown>): Promise<void> {
    // 下划线参数表示基类有意不使用；需要原始通道的子类自行覆盖。
  }
}
