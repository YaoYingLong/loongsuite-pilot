/**
 * 主机网络与 User-Agent 构造工具。
 *
 * SLS/HTTP 等输出可用这里生成本机标识。模块加载时会解析一次 IPv4 并缓存为 `LOCAL_IP`；
 * 后续网卡变化不会自动刷新，这是为了避免每批上报都枚举系统网卡。
 */

// `node:os` 是 Node.js 内置模块，用于读取网卡、系统类型、版本和 CPU 架构。
import * as os from 'node:os';
import { readInstalledVersion } from './fs-utils.js';

/**
 * 选择本机第一个非 loopback IPv4 地址。
 *
 * @returns 找到的网卡地址；没有合适网卡时返回 `127.0.0.1`。
 */
export function resolveLocalIp(): string {
  // `networkInterfaces()` 返回以网卡名分组的地址数组。
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    // 某些平台的网卡值可能为 undefined，空数组兜底让循环安全跳过。
    for (const iface of interfaces[name] ?? []) {
      // 排除内部回环地址和 IPv6；命中后立即采用操作系统返回顺序中的第一个地址。
      if (!iface.internal && iface.family === 'IPv4') {
        return iface.address;
      }
    }
  }
  // 离线、仅 IPv6 或接口不可用时使用回环地址，保证调用者始终获得合法字符串。
  return '127.0.0.1';
}

/** 模块首次导入时计算并缓存的本机 IPv4，供当前进程生命周期内复用。 */
export const LOCAL_IP = resolveLocalIp();

/**
 * 构建 Pilot 发起 HTTP 请求时使用的 User-Agent。
 *
 * @param dataDir Pilot 数据目录；用于沿 current 版本指针读取安装版本。
 * @returns 包含版本、操作系统、架构和本地 IP 的标识字符串。
 */
export function buildUserAgent(dataDir: string): string {
  // 版本读取失败时底层返回 `unknown`，不会阻断网络输出初始化。
  const version = readInstalledVersion(dataDir);
  return `loongsuite-pilot/${version} (${os.type()}; ${os.release()}; ${os.arch()}) ip/${LOCAL_IP}`;
}
