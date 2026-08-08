/**
 * Qoder 组织管理 OpenAPI 的带类型 HTTP 客户端。
 *
 * 该 Client 只负责 URL/query、Bearer 鉴权、JSON 解析、超时和有限重试；分页、时间窗口、并发
 * 及宽表转换由 QoderApiInput 完成。apiKey 始终为私有成员，不提供 getter，也不写入日志。
 */

import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('QoderApiClient');

/** 30 秒超时、三次请求及可重试 HTTP 状态。 */
const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** 包含 status 与 URL 的 API 错误；响应正文只保留前 256 字符。 */
export class QoderApiHttpError extends Error {
  /**
   * @param status HTTP 状态码，供上层区分 401/403、限流和服务端错误。
   * @param url 不含 Authorization header 的请求 URL。
   * @param body 服务端错误正文；进入 message 前最多保留 256 字符，限制日志体积。
   */
  constructor(readonly status: number, readonly url: string, body: string) {
    super(`Qoder API ${status} ${url}: ${body.slice(0, 256)}`);
  }
}

/** 以下接口按 Qoder API 响应建模，并保留未知字段兼容服务端扩展。 */
export interface QoderMember {
  id: string;
  name?: string;
  email?: string;
  role?: string;
  status?: string;
  joinedAt?: string;
  deletedAt?: string;
  [key: string]: unknown;
}

/** 成员列表的一页；`nextToken` 非空表示调用方还应请求下一页。 */
export interface ListMembersResponse {
  members: QoderMember[];
  maxResults?: number;
  nextToken?: string;
}

/** 一次额度消费、退款或冲正事件；服务端时间戳单位由 API 契约定义为毫秒。 */
export interface QoderUsageEvent {
  timestamp: number;
  userId?: string;
  userEmail?: string;
  source?: string;
  operation?: string;
  modelTier?: string;
  credits?: number;
  cost?: number;
  [key: string]: unknown;
}

/** usage event 的一页；成员接口使用 `nextCredits`，组织接口可能使用 `nextToken`。 */
export interface ListUsageEventsResponse {
  usages: QoderUsageEvent[];
  maxResults?: number;
  nextCredits?: string;
  nextToken?: string;
}

/** 一个额度池的已用量、上限和计量单位。 */
export interface QoderQuotaSummary {
  usedValue?: number;
  limitValue?: number;
  unit?: string;
}

/** API 在 plan/资源包/共享额度等位置复用的 quota 包装层。 */
export interface QoderQuotaBlock {
  quotaSummary?: QoderQuotaSummary;
  [key: string]: unknown;
}

/** 单成员当前额度快照；部分组织没有资源包或共享额度，因此相应字段允许 null。 */
export interface QoderQuotaResponse {
  userId?: string;
  quotaKey?: string;
  planQuota?: QoderQuotaBlock;
  resourcePackageQuota?: QoderQuotaBlock | null;
  totalQuota?: QoderQuotaBlock;
  sharedQuota?: QoderQuotaBlock | null;
  lastResetAt?: string;
  nextResetAt?: string;
  status?: string;
  [key: string]: unknown;
}

/** 单次 AI change 涉及的一个文件及其增删行数。 */
export interface QoderChangeMetadata {
  fileName?: string;
  fileExtension?: string;
  linesAdded?: number;
  linesDeleted?: number;
}

/** AI 代码 change 记录；Input 会把 metadata 数组序列化到宽表字段。 */
export interface QoderChangeItem {
  changeId?: string;
  userId?: string;
  userEmail?: string;
  source?: string;
  model?: string;
  totalLinesAdded?: number;
  totalLinesDeleted?: number;
  metadata?: QoderChangeMetadata[];
  createdAt?: string;
  [key: string]: unknown;
}

/** page/per-page 风格接口共用的分页描述。 */
export interface QoderPagination {
  currentPage?: number;
  pageSize?: number;
  totalItems?: number;
  totalPages?: number;
}

/** AI change 分页响应；字段均可选以兼容服务端旧版本或部分响应。 */
export interface ListChangesResponse {
  success?: boolean;
  data?: {
    items?: QoderChangeItem[];
    pagination?: QoderPagination;
  };
}

/**
 * 一次代码提交的总行数和各 Qoder 功能来源行数。
 *
 * `nonAi*`、`ideNext*`、`pluginAgent*` 等字段不能在 Client 层相加或互相替代；Input 会原样
 * 展开，便于下游按服务端口径聚合。
 */
export interface QoderCommitItem {
  commitHash?: string;
  userId?: string;
  userEmail?: string;
  repoName?: string;
  branchName?: string;
  isPrimaryBranch?: boolean;
  totalLinesAdded?: number;
  totalLinesDeleted?: number;
  ideNextLinesAdded?: number;
  ideNextLinesDeleted?: number;
  pluginNextLinesAdded?: number;
  pluginNextLinesDeleted?: number;
  ideAgentLinesAdded?: number;
  ideAgentLinesDeleted?: number;
  pluginAgentLinesAdded?: number;
  pluginAgentLinesDeleted?: number;
  cliAgentLinesAdded?: number;
  cliAgentLinesDeleted?: number;
  ideQuestLinesAdded?: number;
  ideQuestLinesDeleted?: number;
  ideInlineChatLinesAdded?: number;
  ideInlineChatLinesDeleted?: number;
  jbInlineChatLinesAdded?: number;
  jbInlineChatLinesDeleted?: number;
  nonAiLinesAdded?: number;
  nonAiLinesDeleted?: number;
  message?: string;
  commitTs?: string;
  createdAt?: string;
  [key: string]: unknown;
}

/** AI commit 分页响应。 */
export interface ListCommitsResponse {
  success?: boolean;
  data?: {
    items?: QoderCommitItem[];
    pagination?: QoderPagination;
  };
}

/** 构造 Client 所需的固定连接参数。 */
export interface QoderApiClientOptions {
  /** OpenAPI 根 URL；构造函数会去掉末尾 `/`，避免与请求路径拼出双斜杠。 */
  apiBase: string;
  /** Bearer token，仅保存在 private 成员并写入请求 header。 */
  apiKey: string;
  /** 默认组织 ID；具体方法仍显式接收 orgId，方便调用路径清晰可见。 */
  orgId: string;
  /** 单次 fetch 超时，默认 30 秒；超时错误按网络错误参与有限重试。 */
  timeoutMs?: number;
}

/**
 * Qoder OpenAPI 客户端。
 *
 * Bearer apiKey 保持私有；5xx/429/网络错误执行指数退避；不可重试 4xx 立即抛出，让 Input
 * 把 401/403 标为 fatal auth 并停止周期请求。
 */
export class QoderApiClient {
  readonly apiBase: string;
  readonly orgId: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  /**
   * 验证必填配置，去掉 apiBase 尾斜杠并固定超时。
   * 构造过程不发起网络连接，真正的 I/O 发生在各公开 API 方法调用 `request()` 时。
   *
   * @param opts API 根地址、密钥、组织 ID 和可选超时。
   * @throws apiKey/apiBase/orgId 任一为空时同步抛错。
   */
  constructor(opts: QoderApiClientOptions) {
    if (!opts.apiKey) throw new Error('QoderApiClient: apiKey is required');
    if (!opts.apiBase) throw new Error('QoderApiClient: apiBase is required');
    if (!opts.orgId) throw new Error('QoderApiClient: orgId is required');
    this.apiKey = opts.apiKey;
    this.apiBase = opts.apiBase.replace(/\/+$/, '');
    this.orgId = opts.orgId;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** 分页列出组织成员。 */
  async listMembers(
    orgId: string,
    opts: { nextToken?: string; maxResults?: number; includeDeleted?: boolean } = {},
  ): Promise<ListMembersResponse> {
    const query = this.toQuery({
      maxResults: opts.maxResults ?? 100,
      nextToken: opts.nextToken,
      includeDeleted: opts.includeDeleted ? 'true' : undefined,
    });
    return this.request<ListMembersResponse>(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/members${query}`,
    );
  }

  /** 分页列出单成员在时间窗口内的 usage events。 */
  async listMemberUsageEvents(
    orgId: string,
    memberId: string,
    opts: {
      startDate?: string;
      endDate?: string;
      maxResults?: number;
      nextCredits?: string;
    } = {},
  ): Promise<ListUsageEventsResponse> {
    const query = this.toQuery({
      startDate: opts.startDate,
      endDate: opts.endDate,
      maxResults: opts.maxResults ?? 100,
      nextCredits: opts.nextCredits,
    });
    return this.request<ListUsageEventsResponse>(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(memberId)}/usage-events${query}`,
    );
  }

  /** 读取单成员当前配额快照。 */
  async getMemberQuota(
    orgId: string,
    memberId: string,
  ): Promise<QoderQuotaResponse> {
    return this.request<QoderQuotaResponse>(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(memberId)}/quota`,
    );
  }

  /** 按 offset page 查询 AI 代码 change 记录。 */
  async listAiCodeChanges(
    orgId: string,
    opts: {
      startDate?: string;
      endDate?: string;
      page?: number;
      pageSize?: number;
      source?: string;
      userId?: string;
      userEmail?: string;
    } = {},
  ): Promise<ListChangesResponse> {
    const query = this.toQuery({
      startDate: opts.startDate,
      endDate: opts.endDate,
      page: opts.page,
      pageSize: opts.pageSize ?? 200,
      source: opts.source,
      userId: opts.userId,
      userEmail: opts.userEmail,
    });
    return this.request<ListChangesResponse>(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/ai-code-tracking/changes${query}`,
    );
  }

  /** 按 offset page 查询 AI 代码 commit 记录。 */
  async listAiCodeCommits(
    orgId: string,
    opts: {
      startDate?: string;
      endDate?: string;
      page?: number;
      pageSize?: number;
      repoName?: string;
      userId?: string;
      userEmail?: string;
    } = {},
  ): Promise<ListCommitsResponse> {
    const query = this.toQuery({
      startDate: opts.startDate,
      endDate: opts.endDate,
      page: opts.page,
      pageSize: opts.pageSize ?? 200,
      repoName: opts.repoName,
      userId: opts.userId,
      userEmail: opts.userEmail,
    });
    return this.request<ListCommitsResponse>(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/ai-code-tracking/commits${query}`,
    );
  }

  /** 查询组织级 usage events。 */
  async listOrgUsageEvents(
    orgId: string,
    opts: {
      startDate?: string;
      endDate?: string;
      sources?: string;
      operations?: string;
      modelTiers?: string;
      maxResults?: number;
      nextToken?: string;
    } = {},
  ): Promise<ListUsageEventsResponse> {
    const query = this.toQuery({
      startDate: opts.startDate,
      endDate: opts.endDate,
      sources: opts.sources,
      operations: opts.operations,
      modelTiers: opts.modelTiers,
      maxResults: opts.maxResults ?? 100,
      nextToken: opts.nextToken,
    });
    return this.request<ListUsageEventsResponse>(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/usage-events${query}`,
    );
  }

  /** 按 source 或 operation 查询成员 usage 汇总。 */
  async getMemberUsageSummary(
    orgId: string,
    memberId: string,
    opts: { startDate: string; endDate: string; groupBy: 'source' | 'operation' },
  ): Promise<{ summary?: Record<string, number> }> {
    const query = this.toQuery({
      startDate: opts.startDate,
      endDate: opts.endDate,
      groupBy: opts.groupBy,
    });
    return this.request<{ summary?: Record<string, number> }>(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(memberId)}/usage-summary${query}`,
    );
  }

  /** 分页查询组织资源包。 */
  async listResourcePackages(
    orgId: string,
    opts: {
      status?: string;
      orderBy?: string;
      order?: string;
      maxResults?: number;
      nextToken?: string;
    } = {},
  ): Promise<{
    resourcePackages?: Array<Record<string, unknown>>;
    maxResults?: number;
    nextToken?: string;
  }> {
    const query = this.toQuery({
      status: opts.status,
      orderBy: opts.orderBy,
      order: opts.order,
      maxResults: opts.maxResults ?? 100,
      nextToken: opts.nextToken,
    });
    return this.request(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/resource-packages${query}`,
    );
  }

  /** 查询 seat-month 批次（仅第三方购买）。 */
  async listSeatMonthBatches(
    orgId: string,
    opts: {
      status?: string;
      pageSize?: number;
      pageToken?: string;
    } = {},
  ): Promise<{
    seatMonthBatches?: Array<Record<string, unknown>>;
    pageSize?: number;
    nextToken?: string;
  }> {
    const query = this.toQuery({
      status: opts.status,
      pageSize: opts.pageSize ?? 100,
      pageToken: opts.pageToken,
    });
    return this.request(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/seat-month-batches${query}`,
    );
  }

  /** 查询 AI 代码统计总览。 */
  async getAiCodeStatsOverview(
    orgId: string,
    opts: { startDate: string; endDate: string; repoName?: string; primaryBranchOnly?: boolean },
  ): Promise<Record<string, unknown>> {
    const query = this.toQuery({
      start_date: opts.startDate,
      end_date: opts.endDate,
      repo_name: opts.repoName,
      primary_branch_only: opts.primaryBranchOnly ? 'true' : undefined,
    });
    return this.request<Record<string, unknown>>(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/ai-code/stats/overview${query}`,
    );
  }

  /** 查询 AI 代码每日趋势。 */
  async getAiCodeDailyTrend(
    orgId: string,
    opts: { startDate: string; endDate: string; repoName?: string; primaryBranchOnly?: boolean },
  ): Promise<{
    items?: Array<Record<string, unknown>>;
    extItems?: Array<Record<string, unknown>>;
    nextItems?: Array<Record<string, unknown>>;
  }> {
    const query = this.toQuery({
      start_date: opts.startDate,
      end_date: opts.endDate,
      repo_name: opts.repoName,
      primary_branch_only: opts.primaryBranchOnly ? 'true' : undefined,
    });
    return this.request(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/ai-code/stats/daily-trend${query}`,
    );
  }

  /** 查询 AI 代码成员排名。 */
  async getAiCodeMemberRanking(
    orgId: string,
    opts: { startDate: string; endDate: string; limit?: number },
  ): Promise<{ items?: Array<Record<string, unknown>> }> {
    const query = this.toQuery({
      start_date: opts.startDate,
      end_date: opts.endDate,
      limit: opts.limit ?? 100,
    });
    return this.request(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/ai-code/stats/member-ranking${query}`,
    );
  }

  /** 分页查询 AI 代码仓库。 */
  async listAiCodeRepos(
    orgId: string,
    opts: {
      startDate?: string;
      endDate?: string;
      query?: string;
      page?: number;
      perPage?: number;
    } = {},
  ): Promise<{
    repos?: Array<Record<string, unknown>>;
    totalCount?: number;
    page?: number;
    perPage?: number;
  }> {
    const query = this.toQuery({
      start_date: opts.startDate,
      end_date: opts.endDate,
      query: opts.query,
      page: opts.page ?? 1,
      per_page: opts.perPage ?? 100,
    });
    return this.request(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/ai-code/repos${query}`,
    );
  }

  /** 查询 AI 代码文件扩展名统计。 */
  async listAiCodeFileExtensions(
    orgId: string,
    opts: { startDate?: string; endDate?: string } = {},
  ): Promise<{ fileExtensions?: Array<Record<string, unknown>> }> {
    const query = this.toQuery({
      start_date: opts.startDate,
      end_date: opts.endDate,
    });
    return this.request(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/ai-code/file-extensions${query}`,
    );
  }

  /**
   * 对非空 query 参数执行 URI 编码并拼成 `?k=v&...`。
   *
   * `undefined`、`null` 和空字符串表示“不发送该参数”；数字 0 与布尔 false 是有效值，不能
   * 用普通真假判断过滤。键和值都编码，避免邮箱、token 或日期中的特殊字符破坏 URL。
   */
  private toQuery(params: Record<string, string | number | boolean | undefined>): string {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    return parts.length === 0 ? '' : `?${parts.join('&')}`;
  }

  /**
   * 执行一个 JSON 请求，按状态/网络错误分类重试。
   *
   * 每次 attempt 都创建新的 `AbortSignal.timeout()`，前一次超时不会污染下一次请求。成功时
   * `await resp.json()` 完成后才兑现 Promise；JSON 非法也进入 catch 并按网络/未知错误重试。
   * 401/403 等不可重试状态保留为 `QoderApiHttpError` 立即向上抛，QoderApiInput 据此停止窗口
   * 推进并设置 fatal auth。
   *
   * @param method 当前调用均为 GET，参数保留是为了让底层请求函数表达完整 HTTP 语义。
   * @param pathAndQuery 已编码的路径和 query，不含 `apiBase`。
   * @returns 解析后的泛型 JSON；TypeScript 类型只在编译期生效，不做运行时 schema 校验。
   * @throws 不可重试 4xx 立即抛 QoderApiHttpError；三次仍失败抛最后异常。
   */
  private async request<T>(method: string, pathAndQuery: string): Promise<T> {
    const url = `${this.apiBase}${pathAndQuery}`;

    let lastErr: unknown;
    for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
      const startedAt = Date.now();
      try {
        const resp = await fetch(url, {
          method,
          headers: {
            // Authorization 值只在请求对象中构造，任何日志都不输出 apiKey。
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!resp.ok) {
          // 非 2xx 也要读取正文，便于诊断；错误类负责限制长度，且正文不应包含本地 token。
          const text = await resp.text().catch(() => '');
          const err = new QoderApiHttpError(resp.status, url, text);
          if (
            !RETRYABLE_STATUS_CODES.has(resp.status) ||
            attempt === RETRY_MAX_ATTEMPTS - 1
          ) {
            throw err;
          }
          lastErr = err;
        } else {
          // await JSON 解析后再 return，调用方不会拿到仍需消费的 Response 流。
          const json = (await resp.json()) as T;
          logger.debug('qoder api ok', {
            method,
            path: pathAndQuery,
            elapsedMs: Date.now() - startedAt,
          });
          return json;
        }
      } catch (err) {
        // catch 同时覆盖 fetch 拒绝、AbortError、JSON 解析失败和上面主动抛出的 HTTP 错误。
        if (err instanceof QoderApiHttpError && !RETRYABLE_STATUS_CODES.has(err.status)) {
          throw err;
        }
        lastErr = err;
        if (attempt === RETRY_MAX_ATTEMPTS - 1) break;
      }

      // 退避序列为 1s、2s；第三次失败后不会再等待。（常量描述的下一阶 4s 不会执行。）
      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
      logger.warn('qoder api retrying', {
        method,
        path: pathAndQuery,
        attempt: attempt + 1,
        delayMs: delay,
        error: redactError(lastErr),
      });
      await sleep(delay);
    }

    throw lastErr;
  }
}

/** 对最终错误文本再做一次防御性 Bearer token 替换。 */
function redactError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // 即使底层 fetch 把 header 拼入异常，也不让 token 进入日志。
  return msg.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer <redacted>');
}

/** Promise 化退避等待。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
