/**
 * Qoder 组织管理 API Pipeline 的顶层轮询编排。
 *
 * 本文件组合带鉴权/重试的 HTTP Client、窗口化 Input 和 SLS Sender。与普通 Agent Input
 * 不同，它由 pipeline config 启用并直接输出管理侧宽表，不经过 AgentActivityEntry 归一化。
 */

import type { WakeEvent } from '../../sleep-detector.js';
import type {
  Pipeline,
  PipelineConfig,
  QoderApiInputConfig,
  QoderApiPipelineOptions,
} from '../../types.js';
import { QoderApiClient } from './qoder-api-client.js';
import { QoderApiInput } from './qoder-api-input.js';
import { QoderApiSlsSender } from '../../flusher/qoder-api/qoder-api-sls-sender.js';
import { createLogger, type BoundLogger } from '../../../utils/logger.js';
import { persistFailedLogs } from '../../../flushers/sls-transport.js';
import { estimateStringRecordBytes } from '../../../flushers/sls-failure-log-writer.js';

const DEFAULT_INTERVAL_SECONDS = 300;
const DEFAULT_BACKFILL_DAYS = 7;
const DEFAULT_API_BASE = 'https://api.qoder.com';

/**
 * 将 Qoder API client、采集窗口和 SLS sender 组合为串行轮询循环。
 *
 * 生命周期：start 创建依赖/定时器并立即首轮；stop 清定时器并排空；wake 立即补一轮。
 */
export class QoderApiPipeline implements Pipeline {
  private readonly config: PipelineConfig;
  private readonly stateDir: string;
  private readonly failedLogDir: string;
  private readonly dataDir: string;
  private readonly logger: BoundLogger;

  private client: QoderApiClient | null = null;
  private input: QoderApiInput | null = null;
  private sender: QoderApiSlsSender | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** running 控制生命周期，polling 防止 interval/wake 重入同一窗口。 */
  private running = false;
  private polling = false;

  /**
   * 保存配置和目录，网络对象延迟到 `start()` 创建。
   *
   * @param opts PipelineManager 解析后的单条 pipeline 配置，以及状态、失败日志和安装数据目录。
   */
  constructor(opts: QoderApiPipelineOptions) {
    this.config = opts.config;
    this.stateDir = opts.stateDir;
    this.failedLogDir = opts.failedLogDir;
    this.dataDir = opts.dataDir;
    this.logger = createLogger(`QoderApiPipeline:${opts.config.configName}`);
  }

  /**
   * 解析默认值，按 Client -> Input -> Sender 顺序创建组件并启动轮询。
   *
   * `setInterval` 回调只触发 Promise，不等待它；真正的串行约束由 `polling` 门控制。`unref()`
   * 表示这个 timer 单独存在时不会阻止 Node.js 退出。首轮使用 fire-and-forget，是为了不让慢速
   * 管理 API 阻塞 Orchestrator 完成其他模块启动，错误会在 `pollCycle()` 内捕获并记录。
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const inputConfig = this.config.inputs[0] as QoderApiInputConfig;
    const flusherConfig = this.config.flushers[0];
    const configName = this.config.configName;

    const apiBase = inputConfig.ApiBase ?? DEFAULT_API_BASE;
    const interval = inputConfig.Interval ?? DEFAULT_INTERVAL_SECONDS;
    const backfillDays = inputConfig.BackfillDays ?? DEFAULT_BACKFILL_DAYS;

    // 1. Client 保存 API key，只在 Authorization header 使用，错误日志会脱敏。
    this.client = new QoderApiClient({
      apiBase,
      apiKey: inputConfig.ApiKey,
      orgId: inputConfig.OrgId,
    });

    // 2. Input 负责窗口、分页、并发成员查询和行转换。
    this.input = new QoderApiInput({
      client: this.client,
      orgId: inputConfig.OrgId,
      configName,
      stateDir: this.stateDir,
      interval,
      backfillDays,
    });

    // 3. Sender 负责有界内存缓冲和 WebTracking。
    this.sender = new QoderApiSlsSender({
      flusherConfig,
      configName,
      failedLogDir: this.failedLogDir,
      dataDir: this.dataDir,
    });

    // 4. 先启动 sender，确保首轮采集有可接收缓冲。
    this.sender.start();

    // 5. API Interval 单位为秒，Node 定时器需要毫秒。
    const intervalMs = interval * 1000;
    this.pollTimer = setInterval(
      () => void this.pollCycle(),
      intervalMs,
    );
    this.pollTimer.unref();

    // 6. 首轮不阻塞 start；pollCycle 内部捕获并记录错误。
    void this.pollCycle();

    this.logger.info('started', {
      configName,
      orgId: inputConfig.OrgId,
      apiBase,
      intervalSeconds: interval,
      backfillDays,
      logstore: flusherConfig.Logstore,
    });
  }

  /**
   * 停止产生新轮询并等待 Sender 按其关闭策略排空。
   *
   * 本方法不会等待当前 `pollCycle()`：它先把 `running` 置 false 并清 timer，再关闭 Sender。
   * 若采集请求恰好仍在途，它完成后的 enqueue 行为由既有执行顺序决定；该时序由上层统一停止
   * 顺序保护。重复调用因 `running` 门直接返回。
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.sender) {
      await this.sender.shutdown();
    }

    this.logger.info('stopped', { configName: this.config.configName });
  }

  /** 睡眠恢复后立即触发一次轮询；polling 门控会处理与定时器碰撞。 */
  async handleWake(_event: WakeEvent): Promise<void> {
    if (!this.running) return;
    this.logger.info('wake recovery: running immediate poll cycle');
    void this.pollCycle();
  }

  /**
   * 执行一次“采集但不提交窗口 -> sender 接受 -> 确认窗口”事务式流程。
   * sender 满时不推进窗口，下轮会重采；确定性 event_id 供 SLS 去重。
   *
   * 这里没有数据库事务，而是用调用顺序实现两阶段确认：先 `collect()` 生成候选窗口，再
   * `enqueue()` 转移内存所有权，最后 `confirmCycle()` 落 checkpoint。catch 吞掉周期异常，
   * 因为 timer 回调没有 await 的调用者；`finally` 必须释放 `polling`，否则一次失败会永久停采。
   */
  private async pollCycle(): Promise<void> {
    if (!this.running || !this.input || !this.sender) return;
    if (this.polling) {
      this.logger.debug('previous poll cycle still running; skipping');
      return;
    }

    // 鉴权被判定为永久失败后停止重复请求，等待配置变更/重建 Pipeline。
    if (this.input.hasFatalAuthError()) {
      this.logger.warn('skipping cycle: fatal auth error previously detected');
      return;
    }

    this.polling = true;
    try {
      // collect 只产生候选行，尚不持久化新窗口。
      const rows = await this.input.collect();

      if (rows.length === 0) return;

      // enqueue 只表示内存缓冲已接管，不表示远端已发送成功。
      const accepted = this.sender.enqueue(rows);

      if (accepted) {
        // 缓冲已接管后提交窗口。若 flush 前崩溃导致窗口重采，确定性 event_id 可供下游去重。
        await this.input.confirmCycle();
      } else {
        // 缓冲满时不提交窗口；只写有界失败元数据，下轮重新请求同一时间窗。
        this.logger.warn('sender buffer full, persisting rows to failed-log', {
          configName: this.config.configName,
          droppedRows: rows.length,
          bufferSize: this.sender.bufferSize(),
        });
        const flusherConfig = this.config.flushers[0];
        await persistFailedLogs(
          this.failedLogDir,
          this.config.configName,
          {
            mode: 'webtracking',
            project: flusherConfig.Project,
            logstore: flusherConfig.Logstore,
            kind: this.config.configName,
            batchCount: rows.length,
            batchBytes: estimateStringRecordBytes(rows),
          },
          new Error('sender buffer full, window not advanced'),
        );
      }
    } catch (err) {
      this.logger.error('poll cycle failed', {
        configName: this.config.configName,
        error: String(err),
      });
    } finally {
      this.polling = false;
    }
  }
}
