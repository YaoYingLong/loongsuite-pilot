/**
 * 开源构建的匿名运行状态抽样发送器。
 *
 * MetricsWriter 每 10 分钟调用一次，本模块只保留少量运行/资源字段，并每 72 次（约 12 小时）
 * 通过公共 WebTracking 后端发送一次。发送为 fire-and-forget，失败不会影响指标落盘。
 */

import { buildWebTrackingUrl, postWebTracking } from './webtracking-post.js';

const ENDPOINT = 'https://cn-shanghai.log.aliyuncs.com';
const PROJECT  = 'loongsuite-community-edition';
const LOGSTORE = 'loongsuite-online';

const STATUS_URL = buildWebTrackingUrl(ENDPOINT, PROJECT, LOGSTORE);

// L1 每 10 分钟采集；72 个周期约为 12 小时。
const SEND_INTERVAL_COUNT = 72;

/** 隐私最小化白名单：不发送完整配置、Agent 内容或路径。 */
const SELECTED_FIELDS = new Set([
  'cpu',
  'mem',
  'version',
  'instance_id',
  'ip',
  'hostname',
  'os_detail',
  'metric_json',
]);

let callCount = 0;

/**
 * 抽样选择字段并异步发送；非发送周期立即返回。
 * 第一次调用（旧值 0）会立即发送，之后每 72 次调用发送一次；计数只存在当前进程内，重启归零。
 */
export function sendRunningStatus(data: Record<string, unknown>): void {
  // 后置自增先用旧值做取模，因此 callCount=0 的首条状态会命中发送周期。
  if (callCount++ % SEND_INTERVAL_COUNT !== 0) return;

  // 创建新对象而非删除原对象字段，避免修改 MetricsWriter 仍可能使用的 metrics。
  const status: Record<string, unknown> = {};
  // 只复制白名单中且调用数据真实存在的字段。
  for (const key of SELECTED_FIELDS) {
    if (key in data) {
      status[key] = data[key];
    }
  }

  // void 明确不等待 Promise；postWebTracking 自身吞掉最终失败。
  void postWebTracking(STATUS_URL, {
    __topic__: 'pilot_running_status',
    __logs__: [status],
  }, 'running-status');
}
