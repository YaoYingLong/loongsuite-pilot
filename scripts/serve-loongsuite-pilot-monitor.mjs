#!/usr/bin/env node

// 本文件是 `loongsuite-pilot monitor start` 启动的本地 Dashboard HTTP 进程入口。
// 它在默认 `127.0.0.1:8765` 提供静态页面、Agent 总览和进程指标 API；数据来自本地日志/CSV，
// 不直接连接 Agent 或远端后端。监听地址、端口、数据目录均可由环境变量覆盖。
// HTTP server 长期占用事件循环；端口冲突或文件流错误会记录到 stderr，由 CLI 管理其退出状态。

import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOverviewAggregator } from './lib/agent-overview.mjs';
import { getMetricsCsv, getMetricsStatus, parseWindowMinutes } from './lib/process-metrics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dashboardPath = path.join(repoRoot, 'assets', 'monitor', 'loongsuite-pilot-monitor.html');

const port = Number(process.env.LOONGSUITE_PILOT_MONITOR_PORT || 8765);
const host = process.env.LOONGSUITE_PILOT_MONITOR_HOST || '127.0.0.1';
const dataDir = process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(homedir(), '.loongsuite-pilot');
const monitorDir = process.env.LOONGSUITE_PILOT_MONITOR_DIR || path.join(dataDir, 'logs', 'process-monitor');
const overview = createOverviewAggregator({ dataDir });
/** 当前 Dashboard Node 进程的启动 ISO 时间；用于区分多次 `monitor start` 运行。 */
const monitorDashboardStartedAt = new Date().toISOString();

/**
 * 写 JSON HTTP 响应并结束 socket；`no-store` 防止浏览器缓存实时状态。
 * @param {import('node:http').ServerResponse} response Node.js 原生响应对象。
 * @param {number} statusCode HTTP 状态码。
 * @param {unknown} body 可 JSON 序列化的响应体。
 */
function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

/**
 * 以 ReadStream 把静态文件管道到 HTTP 响应，避免一次性把页面读入内存。
 * @param {import('node:http').ServerResponse} response 响应对象。
 * @param {string} filePath 本地文件路径。
 * @param {string} contentType MIME 类型与可选 charset。
 */
function sendFile(response, filePath, contentType) {
  response.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  createReadStream(filePath).pipe(response);
}

// `createServer` 的 async 回调按请求并发运行；每个分支必须 `return`，避免同一响应重复写入。
// await 的聚合/文件错误统一被 catch 转换为 500，保持 server 继续服务后续请求。
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host}`);

    if (url.pathname === '/' || url.pathname === '/index.html') {
      sendFile(response, dashboardPath, 'text/html; charset=utf-8');
      return;
    }

    if (url.pathname === '/api/metrics') {
      const minutes = parseWindowMinutes(
        url.searchParams.get('minutes') ?? process.env.LOONGSUITE_PILOT_MONITOR_WINDOW_MINUTES,
      );
      response.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(await getMetricsCsv({ monitorDir, minutes }));
      return;
    }

    if (url.pathname === '/api/status') {
      const minutes = parseWindowMinutes(
        url.searchParams.get('minutes') ?? process.env.LOONGSUITE_PILOT_MONITOR_WINDOW_MINUTES,
      );
      sendJson(response, 200, await getMetricsStatus({ monitorDir, minutes }));
      return;
    }

    if (url.pathname === '/api/overview') {
      const body = await overview.getOverview({
        force: url.searchParams.get('force') === 'true',
      });
      sendJson(response, 200, { ...body, monitorDashboardStartedAt });
      return;
    }

    if (url.pathname.startsWith('/api/overview/agents/')) {
      const agentId = decodeURIComponent(url.pathname.replace('/api/overview/agents/', ''));
      const agent = await overview.getAgent(agentId);
      if (!agent) {
        sendJson(response, 404, { error: 'agent not found', agentId });
        return;
      }
      sendJson(response, 200, agent);
      return;
    }

    sendJson(response, 404, { error: 'not found' });
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error),
      monitorDir,
    });
  }
});

server.listen(port, host, () => {
  console.log(`LoongSuite Pilot monitor dashboard: http://${host}:${port}/`);
  console.log(`Reading monitor CSVs from: ${monitorDir}`);
});
