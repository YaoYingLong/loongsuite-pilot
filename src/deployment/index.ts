/**
 * deployment 子系统的公共导出入口。
 *
 * 这里只用 ES Module 的再导出语法集中暴露加载器、编排器、策略和通知工具；导入本
 * 文件不会主动探测或部署，实际副作用始于调用 DeploymentManager 的异步方法。
 */

export { AgentDefLoader } from './agent-def-loader.js';
export { DeploymentManager } from './deployment-manager.js';
export { HookStrategy } from './hook-strategy.js';
export { PluginProbeStrategy } from './plugin-probe-strategy.js';
export { writeDeployNotification, buildRcSnippet, readPendingNotifications } from './deploy-notification.js';
export { detectAgent } from './detect-utils.js';
