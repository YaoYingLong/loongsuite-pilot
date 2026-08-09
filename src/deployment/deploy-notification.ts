/**
 * 插件部署后的“一次性终端提示”文件工具。
 *
 * plugin-probe 部署成功后，DeploymentManager 将不同 mountType 的生效提示追加到
 * `<dataDir>/notifications`。安装器可把 `buildRcSnippet()` 注入 shell rc：新终端读取、
 * 展示并删除该文件。通知写入是辅助功能，异常只记录警告，不能让采集能力部署失败。
 */


import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MountType } from '../types/index.js';
import { ensureDir } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('DeployNotification');

/**
 * 根据 wrapper/rc/env 三种挂载方式生成用户下一步提示。
 * @returns 多行纯文本，不执行命令。
 */
function buildNotificationMessage(agentDisplayName: string, mountType: MountType): string {
  // 所有通知共享首行；后续按挂载机制告诉用户何时能让新配置进入 shell 环境。
  const lines = [
    `  loongsuite-pilot: 已为 ${agentDisplayName} 部署采集能力`,
  ];

  // MountType 是受类型约束的联合类型，因此三个 case 已覆盖当前全部部署方式。
  switch (mountType) {
    case 'wrapper':
      lines.push('  如果命令未生效，请执行：hash -r');
      lines.push('  或者打开一个新的终端窗口。');
      break;
    case 'rc-inject':
      lines.push('  请执行：source ~/.bashrc 或 source ~/.zshrc');
      lines.push('  或者打开一个新的终端窗口。');
      break;
    case 'env-inject':
      lines.push('  请打开一个新的终端窗口以生效。');
      break;
  }

  // 通知文件允许连续追加多个 Agent，因此单条消息内部用换行而非立即输出终端。
  return lines.join('\n');
}

/**
 * 把通知追加到 `<dataDir>/notifications`。辅助写入失败只告警，不向部署主链抛出。
 */
export async function writeDeployNotification(
  dataDir: string,
  agentDisplayName: string,
  mountType: MountType,
): Promise<void> {
  // 使用固定文件名作为 shell rc 与部署端的交接点；这里不创建独立的每 Agent 文件。
  const notificationPath = path.join(dataDir, 'notifications');
  const message = buildNotificationMessage(agentDisplayName, mountType);

  try {
    // ensureDir 使用递归创建，适配首次安装时 dataDir 尚不存在的情况。
    await ensureDir(dataDir);
    // appendFile 保留此前其他 Agent 的提示；额外空行在一次性展示时分隔多条通知。
    await fs.appendFile(notificationPath, message + '\n\n', 'utf-8');
    logger.info('notification written', { agent: agentDisplayName, mountType });
  } catch (err) {
    logger.warn('failed to write notification', { error: String(err) });
  }
}

const RC_BEGIN = '# loongsuite-pilot BEGIN';
const RC_END = '# loongsuite-pilot END';

/**
 * 生成可注入 bash/zsh rc 的 shell 代码：存在通知时显示后删除，保证只展示一次。
 */
export function buildRcSnippet(dataDir: string): string {
  // path.join 生成平台路径；该片段实际面向 bash/zsh，调用方应传可信的普通本地路径。
  // 双引号可以保留空格，但当前实现没有额外转义路径中的 `"`、`$` 或反引号（待确认）。
  const notificationPath = path.join(dataDir, 'notifications');
  // BEGIN/END marker 让安装器能幂等替换整段，而不是每次安装都向 rc 重复追加。
  return [
    RC_BEGIN,
    // `-f` 只在普通文件存在时进入；没有待处理通知时启动 shell 不产生任何输出。
    `if [ -f "${notificationPath}" ]; then`,
    '  echo ""',
    // cat 把部署端累计的所有提示原样写到当前终端标准输出。
    `  cat "${notificationPath}"`,
    '  echo ""',
    // 展示后 `rm -f` 删除交接文件；-f 让并发 shell 已删除文件时仍返回成功。
    `  rm -f "${notificationPath}"`,
    'fi',
    RC_END,
  ].join('\n');
}

/** 只读待展示通知；文件缺失、不可读或空内容返回 null。 */
export async function readPendingNotifications(dataDir: string): Promise<string | null> {
  const notificationPath = path.join(dataDir, 'notifications');
  try {
    const content = await fs.readFile(notificationPath, 'utf-8');
    // trim 去掉部署端用于分隔的首尾空行；纯空白文件按“没有通知”返回 null。
    return content.trim() || null;
  } catch {
    // 文件不存在和权限/读取错误都属于可选提示不可用，不影响调用方主流程。
    return null;
  }
}
