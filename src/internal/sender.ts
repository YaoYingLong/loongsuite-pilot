/**
 * 开源/专有内部发送实现的运行时选择门面。
 *
 * build.mjs 在不同发行模式下提供 `.internal` 实现或声明；这里根据编译常量用顶层 await
 * 动态 import 一次，再导出稳定函数引用。业务模块无需知道当前构建类型。
 */

import { PROPRIETARY_BUILD } from '../core/build-constants.js';

// 先声明同签名变量，两个动态 import 分支都必须完成赋值后模块才会解析完毕。
let _sendAlarm: (topic: string, data: Record<string, unknown>) => void;
let _sendStatus: (topic: string, data: Record<string, unknown>) => void;
let _sendRunningStatus: (data: Record<string, unknown>) => void;

if (PROPRIETARY_BUILD) {
  // 专有构建由未进入开源仓库的实现真正发送告警与状态。
  const m = await import('./alarm-sender.internal.js');
  _sendAlarm = m.sendAlarm;
  _sendStatus = m.sendStatus;
  const s = await import('./statistic.internal.js');
  _sendRunningStatus = s.sendRunningStatus;
} else {
  // 开源告警/status 是 no-op；running status 使用社区抽样实现。
  const m = await import('./alarm-sender.js');
  _sendAlarm = m.sendAlarm;
  _sendStatus = m.sendStatus;
  const s = await import('./statistic.js');
  _sendRunningStatus = s.sendRunningStatus;
}

// 顶层 await 会让依赖本模块的 ESM 初始化等待分支 import 完成；初始化后导出固定引用，
// 调用方使用普通同步函数，不需要在每次指标周期重复动态 import 或 await。
export const sendAlarm = _sendAlarm;
export const sendStatus = _sendStatus;
export const sendRunningStatus = _sendRunningStatus;
