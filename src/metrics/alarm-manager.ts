/**
 * 进程内告警聚合器。
 *
 * Input、Flusher、watchdog 把同类型告警记录到 Map；MetricsWriter 每 30 秒 serialize 一次，
 * 将计数转成输出记录并清空本轮。它不自行创建定时器或发送网络请求。
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('AlarmManager');

/** 约定的告警级别字符串；具体严重度语义由下游平台解释。 */
export type AlarmLevel = '1' | '2' | '3';

/** 当前代码可产生的低基数告警类型。 */
export type AlarmType =
  | 'FLUSH_SEND_ALARM'
  | 'FLUSH_QUOTA_ALARM'
  | 'HOOK_INSTALL_ALARM'
  | 'PROCESS_RESOURCE_ALARM'
  | 'DISPATCH_DROP_ALARM'
  | 'INPUT_STOP_ALARM'
  | 'SERVICE_NOT_RUNNING_ALARM'
  | 'UPDATER_FAILURE_ALARM'
  | 'USER_ID_FORMAT_ALARM'
  | 'DEGRADED_STARTUP_ALARM'
  | 'UPDATER_NOT_RUNNING_ALARM'
  | 'BROKEN_VERSION_POINTER_ALARM'
  | 'INVALID_NODE_BIN_ALARM';

/** 可选维度参与聚合 key，避免不同 Input/endpoint 相互合并。 */
export interface AlarmContext {
  /** 发生告警的 Input 实例名；参与聚合 key。 */
  input_name?: string;
  /** 发生告警的输出 endpoint 名；参与聚合 key。 */
  endpoint_name?: string;
}

/** 序列化后写 JSONL/发送内部后端的字符串宽表。 */
export interface AlarmEntry {
  /** AlarmType 的字符串值。 */
  alarm_type: string;
  /** 下游约定的严重级别 1/2/3。 */
  alarm_level: string;
  /** 同一聚合 key 最近一次 record 提供的消息。 */
  alarm_message: string;
  /** 当前消费周期内同 key 发生次数。 */
  alarm_count: string;
  /** 固定用户身份。 */
  user_id: string;
  /** 固定主机 IP。 */
  ip: string;
  /** 固定 Pilot 版本。 */
  ver: string;
  /** 可选 Input 维度。 */
  input_name?: string;
  /** 可选 endpoint 维度。 */
  endpoint_name?: string;
  /** serialize 时统一生成的 Unix 秒。 */
  __time__: number;
}

/** Map 内部保留最新消息和累计次数。 */
interface AlarmItem {
  /** 低基数类型，用于下游分类。 */
  alarmType: AlarmType;
  /** 首次 record 时保存的级别；同 key 后续 record 不会更新它。 */
  level: AlarmLevel;
  /** 每次重复 record 都覆盖为最新消息。 */
  message: string;
  /** 当前 flush 周期内的累计发生次数。 */
  count: number;
  /** 首次 record 时保存的聚合维度。 */
  context?: AlarmContext;
}

/** 按类型与上下文聚合当前周期告警。 */
export class AlarmManager {
  /** key 由类型、input、endpoint 直接以下划线连接；serialize 后整体清空。 */
  private readonly alarms: Map<string, AlarmItem> = new Map();
  /** 每条输出固定附带的本机 IP。 */
  private readonly ip: string;
  /** 每条输出固定附带的软件版本。 */
  private readonly version: string;
  /** 每条输出固定附带的用户标识。 */
  private readonly userId: string;

  /** @param opts 每条告警固定附带的主机/版本/用户身份。 */
  constructor(opts: { ip: string; version: string; userId: string }) {
    this.ip = opts.ip;
    this.version = opts.version;
    this.userId = opts.userId;
  }

  /** 同一聚合 key 重复发生时累加 count，并保留最新 message。 */
  record(type: AlarmType, level: AlarmLevel, message: string, context?: AlarmContext): void {
    // 空维度转为空串，使同类型全局告警聚合到同一个稳定 key。
    const key = `${type}_${context?.input_name ?? ''}_${context?.endpoint_name ?? ''}`;
    const existing = this.alarms.get(key);
    if (existing) {
      // 重复项只递增次数并刷新文本；level/context 沿用首次记录值。
      existing.count++;
      existing.message = message;
    } else {
      this.alarms.set(key, { alarmType: type, level, message, count: 1, context });
    }
  }

  /**
   * 将当前告警转成输出记录并清空 Map。
   * 调用方只有成功取得返回值后才负责落盘/发送；后续发送失败不会把告警重新放回。
   */
  serialize(): AlarmEntry[] {
    if (this.alarms.size === 0) return [];

    // 告警输出使用 Unix 秒，与 SLS __time__ 约定一致。
    const now = Math.floor(Date.now() / 1000);
    const entries: AlarmEntry[] = [];

    for (const item of this.alarms.values()) {
      // 目前 count 从 1 起且只递增；零值检查保留为防御性保护。
      if (item.count === 0) continue;
      const entry: AlarmEntry = {
        alarm_type: item.alarmType,
        alarm_level: item.level,
        alarm_message: item.message,
        alarm_count: String(item.count),
        user_id: this.userId,
        ip: this.ip,
        ver: this.version,
        __time__: now,
      };
      if (item.context?.input_name) entry.input_name = item.context.input_name;
      if (item.context?.endpoint_name) entry.endpoint_name = item.context.endpoint_name;
      entries.push(entry);
    }

    // 清空发生在文件/网络发送之前；AlarmManager 是周期聚合器，不是可靠消息队列。
    this.alarms.clear();
    return entries;
  }
}
