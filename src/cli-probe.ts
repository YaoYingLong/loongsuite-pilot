import * as path from 'node:path';
import { AgentDefLoader } from './deployment/agent-def-loader.js';
import { detectAgent, commandExists } from './deployment/detect-utils.js';
import { resolveHome, directoryExists, fileExists } from './utils/fs-utils.js';

// 安装器使用的 Agent 探测入口。标准输出是安装脚本直接消费的 JSON 协议，
// 因此本文件不能向 stdout 输出日志或额外提示文本。

// build.mjs 始终将本文件打包为 CommonJS，所以这里可以直接使用 __dirname；
// 不能改用源码目录作为基准，因为探测器实际从安装包的 dist 目录执行。
const __probe_dirname = __dirname;

/** 单个 Agent 声明的探测结果，最终会序列化到 stdout。 */
interface ProbeResult {
  /** Agent 的稳定标识，对应 agents.d/*.json 中的 id。 */
  id: string;
  /** 安装界面展示的名称。 */
  displayName: string;
  /** 任一声明路径存在或任一命令可执行时为 true。 */
  detected: boolean;
  /** 首个命中的已展开声明路径，或 `command: <命令>`；未找到原因时为空字符串。 */
  reason: string;
}

/**
 * 在已确认 Agent 存在后，尽力找出一个适合展示的命中原因。
 *
 * 原因查找与 detectAgent() 保持“路径优先、命令其次”的顺序，但这里只负责生成
 * 人类可读说明；探测结论仍以 detectAgent() 为准。例如 glob 路径由 detectAgent()
 * 展开匹配，此函数不会重复实现 glob 遍历，因而 reason 允许为空。
 */
async function findDetectionReason(detection: { paths: string[]; commands: string[] }): Promise<string> {
  for (const p of detection.paths) {
    const resolved = resolveHome(p);
    if (await directoryExists(resolved) || await fileExists(resolved)) {
      return p;
    }
  }
  for (const cmd of detection.commands) {
    try {
      if (await commandExists(cmd)) return `command: ${cmd}`;
    } catch {
      // 原因字段是辅助信息，命令查询异常不能推翻已经得到的探测结论。
    }
  }
  return '';
}

async function main(): Promise<void> {
  // cli-probe.cjs 位于 dist/，而 agents.d/ 与 dist/ 同处安装包根目录下。
  const builtinDir = path.resolve(__probe_dirname, '..', 'agents.d');
  const pilotDir = path.resolve(__probe_dirname, '..');
  const dataDir = resolveHome('~/.loongsuite-pilot');

  // 加载内置声明及用户本地声明；相同 id 的本地声明会整体覆盖内置声明。
  // pilotDir/dataDir 同时用于展开声明中的 $PILOT_DIR、$PILOT_DATA 等占位符。
  const loader = new AgentDefLoader({
    builtinDir,
    localDir: path.join(dataDir, 'agents.d.local'),
    pilotDir,
    dataDir,
  });

  const defs = await loader.load();
  const results: ProbeResult[] = [];

  for (const def of defs) {
    // 没有任何 detection 线索的声明无法被自动判断，不放入安装器候选列表。
    if (def.detection.paths.length === 0 && def.detection.commands.length === 0) {
      continue;
    }

    // paths 与 commands 中任一条件命中即视为已安装；仅对命中项补充展示原因。
    const detected = await detectAgent(def.detection);
    const reason = detected ? await findDetectionReason(def.detection) : '';
    results.push({
      id: def.id,
      displayName: def.displayName,
      detected,
      reason,
    });
  }

  // 使用紧凑 JSON 且不追加换行，便于 Bash/PowerShell 通过命令替换完整接收结果。
  process.stdout.write(JSON.stringify(results));
}

// 探测是安装流程中的可降级步骤。任何未处理异常都转换为空数组并以成功状态退出，
// 让安装器继续运行并跳过自动选择，而不是因为本机环境差异中止安装。
main().catch(() => {
  process.stdout.write('[]');
  process.exit(0);
});
