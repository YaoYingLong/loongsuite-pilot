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
  const lines = [
    `  loongsuite-pilot: 已为 ${agentDisplayName} 部署采集能力`,
  ];

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
  const notificationPath = path.join(dataDir, 'notifications');
  const message = buildNotificationMessage(agentDisplayName, mountType);

  try {
    await ensureDir(dataDir);
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
  const notificationPath = path.join(dataDir, 'notifications');
  return [
    RC_BEGIN,
    `if [ -f "${notificationPath}" ]; then`,
    '  echo ""',
    `  cat "${notificationPath}"`,
    '  echo ""',
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
    return content.trim() || null;
  } catch {
    return null;
  }
}
