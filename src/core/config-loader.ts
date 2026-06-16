import * as os from 'node:os';
import type {
  AgentsConfig,
  AnalyticsConfig,
  AutoUpdateConfig,
  CmsConfig,
  FileCollectionToggle,
  FlusherConfig,
  HookWatchdogConfig,
  LogRetentionConfig,
  MaskConfig,
  MaskType,
  OtlpTraceFlusherConfig,
  OtlpTraceRawConfig,
  SlsEndpoint,
  SlsMode,
  StatusBarConfig,
} from '../types/index.js';
import { readJsonFile, resolveHome } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ConfigLoader');

const DEFAULT_CONFIG_PATH = '~/.loongsuite-pilot/config.json';

export interface SlsEndpointEntry {
  name?: string;
  endpoint: string;
  project: string;
  logstore: string;
  mode?: SlsMode;
  accessKeyId?: string;
  accessKeySecret?: string;
}

export interface SlsSingleConfig {
  enabled?: boolean;
  mode?: SlsMode;
  accessKeyId?: string;
  accessKeySecret?: string;
  endpoint?: string;
  project?: string;
  logstore?: string;
  /** @deprecated Ignored. */
  destinationOverride?: boolean;
  batchMaxSize?: number;
  flushIntervalMs?: number;
}

export interface InnerDataConfig {
  sls?: SlsEndpointEntry[];
}

/**
 * On-disk config file shape.
 * All fields optional — missing fields fall back to env vars then defaults.
 */
export interface ConfigFile {
  enabled?: boolean;
  dataDir?: string;
  userId?: string;
  'user.id'?: string;

  sls?: SlsSingleConfig | SlsEndpointEntry[];

  jsonl?: {
    enabled?: boolean;
    outputDir?: string;
    rotateDaily?: boolean;
    maxFileSizeMb?: number;
  };

  http?: {
    enabled?: boolean;
    url?: string;
    headers?: Record<string, string>;
    batchMaxSize?: number;
    flushIntervalMs?: number;
    requestTimeoutMs?: number;
  };

  listeners?: Record<string, {
    enabled?: boolean;
    pollInterval?: number;
  }>;

  retention?: {
    enabled?: boolean;
    intervalMs?: number;
    hookHistoryDays?: number;
    hookErrorDays?: number;
    hookDebugDays?: number;
    outputDays?: number;
    slsFailedDays?: number;
  };

  hookWatchdog?: {
    enabled?: boolean;
    intervalMs?: number;
    repairCooldownMs?: number;
  };

  collectLog?: boolean;
  collectTrace?: boolean;
  serviceNamePrefix?: string;

  mask?: {
    mode?: string;
    types?: string[];
  };

  cms?: {
    licenseKey?: string;
    endpoint?: string;
    workspace?: string;
    debug?: boolean;
  };

  otlpTrace?: {
    endpoint?: string;
    headers?: Record<string, string>;
    resourceAttributes?: Record<string, string>;
    serviceName?: string;
    debug?: boolean;
    captureMessageContent?: boolean;
    turnIdleTimeoutMs?: number;
  };

  agents?: Record<string, {
    enabled?: boolean;
    captureMessageContent?: boolean | string;
  }>;

  autoUpdate?: {
    enabled?: boolean;
    checkIntervalMs?: number;
    manifestUrl?: string;
    packageUrl?: string;
  };

  fileCollection?: {
    enabled?: boolean;
  };

  enableStatusBarApp?: boolean | string;

  installId?: string;
  canary?: {
    policy?: 'auto' | 'latest' | 'off';
    hotfix_version?: number;
  };
}

function env(key: string): string | undefined {
  return process.env[key];
}

/**
 * Resolve boolean env vars used by this loader.
 *
 * Only the explicit strings "false" and "0" disable a flag; every other
 * defined value is treated as true. This keeps flags such as "1", "true",
 * and arbitrary non-empty deployment values compatible with shell usage.
 */
function envBool(key: string, fallback: boolean): boolean {
  const v = env(key);
  if (v === undefined) return fallback;
  return v !== 'false' && v !== '0';
}

/**
 * Resolve numeric env vars without throwing on bad input.
 *
 * Invalid numbers silently keep the fallback so a malformed env var does not
 * prevent the collector from starting.
 */
function envInt(key: string, fallback: number): number {
  const v = env(key);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Load configuration with three priority layers:
 *   1. Environment variables (highest)
 *   2. Config file (~/.loongsuite-pilot/config.json or AGENT_DATA_COLLECTION_CONFIG)
 *   3. Built-in defaults (lowest)
 *
 * Env vars override config file values. Config file overrides defaults.
 */
export async function loadConfig(): Promise<AnalyticsConfig> {
  const configPath = resolveHome(env('AGENT_DATA_COLLECTION_CONFIG') ?? DEFAULT_CONFIG_PATH);
  const file = await readJsonFile<ConfigFile>(configPath);

  if (file) {
    logger.info('loaded config file', { path: configPath });
  } else {
    logger.debug('no config file found, using env + defaults', { path: configPath });
  }

  const dataDir = env('LOONGSUITE_PILOT_DATA_DIR') ?? file?.dataDir ?? '~/.loongsuite-pilot';

  // The inner config is resolved after dataDir because group/internal builds
  // may place built-in destinations under the effective data directory.
  const innerDataConfigPath = resolveHome(`${dataDir}/configs/inner/data_config.json`);
  const innerDataConfig = await readJsonFile<InnerDataConfig>(innerDataConfigPath);

  // user.id is a legacy config key kept for old installations. The normalized
  // AnalyticsConfig always exposes the camelCase userId field.
  const userId = env('LOONGSUITE_PILOT_USER_ID') ?? file?.userId ?? file?.['user.id'] ?? os.hostname();

  const serviceNamePrefix = env('LOONGSUITE_PILOT_SERVICE_NAME_PREFIX') ?? file?.serviceNamePrefix ?? 'loongsuite-pilot';

  return {
    enabled: envBool('LOONGSUITE_PILOT_ENABLED', file?.enabled ?? true),
    autoStart: true,
    dataDir,
    userId,
    collectLog: envBool('LOONGSUITE_PILOT_COLLECT_LOG', file?.collectLog ?? true),
    collectTrace: envBool('LOONGSUITE_PILOT_COLLECT_TRACE', file?.collectTrace ?? true),
    serviceNamePrefix,
    cms: buildCmsConfig(file),
    otlpTrace: buildOtlpTraceRawConfig(file),

    listeners: buildListenersConfig(file),
    flushers: buildFlushersConfig(file, dataDir, serviceNamePrefix, innerDataConfig),
    retention: buildRetentionConfig(file),
    agents: buildAgentsConfig(file),
    mask: buildMaskConfig(file),
    hookWatchdog: buildHookWatchdogConfig(file),
    fileCollection: buildFileCollectionConfig(file),
    statusBar: buildStatusBarConfig(file),
  };
}

function buildOtlpTraceRawConfig(file: ConfigFile | null): OtlpTraceRawConfig | undefined {
  // Keep this as a raw copy. buildOtlpTraceConfig() later applies runtime env
  // overrides and chooses between the generic OTLP path and legacy CMS fallback.
  if (!file?.otlpTrace) return undefined;
  return { ...file.otlpTrace };
}

/**
 * Strict optional boolean parser for config values that may be strings.
 *
 * Unlike envBool(), this intentionally accepts only true/false and returns
 * undefined for values such as "0" or "yes". Callers then decide the default.
 */
function parseOptionalBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
}

function buildCmsConfig(file: ConfigFile | null): CmsConfig {
  const licenseKey = env('LOONGSUITE_PILOT_CMS_LICENSE_KEY') ?? file?.cms?.licenseKey ?? '';
  const endpoint = env('LOONGSUITE_PILOT_CMS_ENDPOINT') ?? file?.cms?.endpoint ?? '';
  const workspace = env('LOONGSUITE_PILOT_CMS_WORKSPACE') ?? file?.cms?.workspace ?? '';
  return {
    // CMS is considered configured only when a license key exists. An endpoint
    // alone is not enough for the legacy ARMS OTLP exporter path.
    enabled: !!licenseKey,
    licenseKey,
    endpoint,
    workspace,
    debug: file?.cms?.debug ?? false,
  };
}

function buildAgentsConfig(file: ConfigFile | null): AgentsConfig {
  const result: AgentsConfig = {};
  if (!file?.agents || typeof file.agents !== 'object') return result;

  for (const [agentType, policy] of Object.entries(file.agents)) {
    if (!agentType || !policy || typeof policy !== 'object') continue;
    result[agentType] = {
      enabled: policy.enabled,
      // Default to capturing content unless an agent explicitly disables it.
      // This preserves backward compatibility for old agent policy entries.
      captureMessageContent: parseOptionalBool(policy.captureMessageContent) ?? true,
    };
  }

  return result;
}

const SUPPORTED_MASK_TYPES: readonly MaskType[] = [
  'cloudAccessKey',
  'apiKey',
  'privateKey',
  'databaseUrl',
];

const SUPPORTED_MASK_TYPE_SET = new Set<string>(SUPPORTED_MASK_TYPES);

function parseMaskTypes(value: string | string[] | undefined): MaskType[] {
  // Env uses comma-separated text; config.json uses an array. Both are
  // normalized into the same allow-list and unsupported values are dropped.
  const rawTypes = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return rawTypes
    .map(type => type.trim())
    .filter((type): type is MaskType => SUPPORTED_MASK_TYPE_SET.has(type));
}

function buildMaskConfig(file: ConfigFile | null): MaskConfig {
  const mode = env('LOONGSUITE_PILOT_MASK_MODE') ?? file?.mask?.mode;
  if (mode !== 'all' && mode !== 'custom' && mode !== 'none') {
    // Unknown modes fail closed to "none" rather than guessing a mask policy.
    return { mode: 'none', types: [] };
  }

  if (mode === 'all' || mode === 'none') {
    // all/none do not need an explicit type list; custom is the only mode that
    // consults LOONGSUITE_PILOT_MASK_TYPES or config.mask.types.
    return { mode, types: [] };
  }

  const types = parseMaskTypes(env('LOONGSUITE_PILOT_MASK_TYPES') ?? file?.mask?.types);

  return { mode: 'custom', types };
}

function buildListenersConfig(
  file: ConfigFile | null,
): Record<string, { enabled: boolean; pollInterval: number }> {
  // Listener defaults are intentionally declared in one place so discovery and
  // input registration can rely on a complete map even when config.json is
  // absent. Unknown listener keys from config.json are still carried through.
  const defaults: Record<string, { enabled: boolean; pollInterval: number }> = {
    qoder: { enabled: true, pollInterval: 30_000 },
    'qoder-sqlite': { enabled: true, pollInterval: 30_000 },
    'qoder-work': { enabled: true, pollInterval: 30_000 },
    'qoder-work-log': { enabled: true, pollInterval: 30_000 },
    'qoder-work-sqlite': { enabled: true, pollInterval: 30_000 },
    'qoder-cli-hook': { enabled: true, pollInterval: 30_000 },
    'qoder-cli-session': { enabled: true, pollInterval: 30_000 },
    'cursor-hook': { enabled: true, pollInterval: 30_000 },
    'claude-code-log': { enabled: true, pollInterval: 30_000 },
    'codex-log': { enabled: true, pollInterval: 30_000 },
  };

  const result = { ...defaults };

  // Merge file-level listener overrides. For unknown listener keys, missing
  // fields fall back to the standard enabled/poll interval defaults.
  if (file?.listeners) {
    for (const [key, val] of Object.entries(file.listeners)) {
      result[key] = {
        enabled: val.enabled ?? result[key]?.enabled ?? true,
        pollInterval: val.pollInterval ?? result[key]?.pollInterval ?? 30_000,
      };
    }
  }

  // Historical Qoder env override applies only to the Qoder-related pollers
  // listed below; it does not globally rewrite all listeners.
  const envPoll = envInt('QODER_ANALYTICS_POLL_INTERVAL', 0);
  if (envPoll > 0) result.qoder.pollInterval = envPoll;
  if (envPoll > 0) result['qoder-sqlite'].pollInterval = envPoll;
  if (envPoll > 0) result['qoder-cli-session'].pollInterval = envPoll;

  return result;
}

function buildRetentionConfig(file: ConfigFile | null): LogRetentionConfig {
  const unifiedDays = envInt('LOONGSUITE_PILOT_LOG_RETENTION_DAYS', 0);

  // Per-category config.json values are the most specific retention settings.
  // The unified env var only fills categories not explicitly configured.
  const resolve = (fileVal: number | undefined, fallback: number): number => {
    if (fileVal !== undefined) return fileVal;
    if (unifiedDays > 0) return unifiedDays;
    return fallback;
  };

  return {
    enabled: envBool('LOONGSUITE_PILOT_LOG_RETENTION_ENABLED', file?.retention?.enabled ?? true),
    intervalMs: envInt(
      'LOONGSUITE_PILOT_LOG_RETENTION_INTERVAL_MS',
      file?.retention?.intervalMs ?? 21_600_000, // 6 hours
    ),
    hookHistoryDays: resolve(file?.retention?.hookHistoryDays, 7),
    hookErrorDays: resolve(file?.retention?.hookErrorDays, 7),
    hookDebugDays: resolve(file?.retention?.hookDebugDays, 7),
    outputDays: resolve(file?.retention?.outputDays, 7),
    slsFailedDays: resolve(file?.retention?.slsFailedDays, 7),
  };
}

function buildHookWatchdogConfig(file: ConfigFile | null): HookWatchdogConfig {
  return {
    enabled: envBool('LOONGSUITE_PILOT_HOOK_WATCHDOG_ENABLED', file?.hookWatchdog?.enabled ?? true),
    intervalMs: envInt(
      'LOONGSUITE_PILOT_HOOK_WATCHDOG_INTERVAL_MS',
      file?.hookWatchdog?.intervalMs ?? 5 * 60_000, // 5 minutes
    ),
    repairCooldownMs: envInt(
      'LOONGSUITE_PILOT_HOOK_WATCHDOG_COOLDOWN_MS',
      file?.hookWatchdog?.repairCooldownMs ?? 10 * 60_000, // 10 minutes
    ),
  };
}

function buildFileCollectionConfig(file: ConfigFile | null): FileCollectionToggle {
  return {
    enabled: envBool('LOONGSUITE_PILOT_FILE_COLLECTION_ENABLED', file?.fileCollection?.enabled ?? false),
  };
}

function buildStatusBarConfig(file: ConfigFile | null): StatusBarConfig {
  // Intentionally accepts '0' as false (differs from parseOptionalBool which only handles 'true'/'false').
  // This matches AI Trace's resolveStatusBarAppEnabled() semantics for cross-product consistency.
  const rawEnabled = file?.enableStatusBarApp;
  const fallback = typeof rawEnabled === 'string'
    ? rawEnabled.trim().toLowerCase() !== 'false' && rawEnabled.trim() !== '0'
    : rawEnabled ?? true;
  return {
    enabled: envBool('LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP', fallback),
    metricsSummaryIntervalMs: 60_000,
    runtimeRefreshIntervalMs: 30_000,
  };
}

function buildFlushersConfig(
  file: ConfigFile | null,
  dataDir: string,
  serviceNamePrefix: string,
  innerDataConfig: InnerDataConfig | null,
): FlusherConfig {
  // Each flusher builder owns its own compatibility rules. SLS is the only one
  // that also consumes the inner data_config.json destinations.
  return {
    sls: buildSlsConfig(file, serviceNamePrefix, innerDataConfig),
    jsonl: buildJsonlConfig(file, dataDir),
    http: buildHttpConfig(file),
  };
}

/**
 * Build OtlpTraceFlusherConfig with two paths:
 *   1. New path: config.otlpTrace (generic OTLP, headers passthrough)
 *   2. Fallback: config.cms (ARMS-specific, auto-assembles x-arms-* headers)
 *
 * Both paths require collectTrace=true.
 */
export function buildOtlpTraceConfig(config: AnalyticsConfig): OtlpTraceFlusherConfig | undefined {
  if (!config.collectTrace) return undefined;

  // The explicit OTLP endpoint, whether from env or config.otlpTrace, always
  // wins over legacy CMS/ARMS settings.
  const otlpEndpoint = env('LOONGSUITE_PILOT_OTLP_ENDPOINT') ?? config.otlpTrace?.endpoint;
  if (otlpEndpoint) {
    return buildOtlpTraceConfigNew(otlpEndpoint, config);
  }

  return buildOtlpTraceConfigLegacy(config);
}

function buildOtlpTraceConfigNew(
  endpoint: string,
  config: AnalyticsConfig,
): OtlpTraceFlusherConfig {
  const otlp = config.otlpTrace;

  let headers: Record<string, string> | undefined;
  const envHeaders = env('LOONGSUITE_PILOT_OTLP_HEADERS');
  if (envHeaders) {
    // Header values are deployment-provided JSON. Invalid JSON should disable
    // only the env override, not the whole trace exporter.
    try { headers = JSON.parse(envHeaders); } catch { logger.warn('LOONGSUITE_PILOT_OTLP_HEADERS is not valid JSON, ignoring', { raw: envHeaders }); }
  } else {
    headers = otlp?.headers;
  }

  const captureMessageContent = otlp?.captureMessageContent ?? resolveCaptureMessageContent(config.agents);
  const serviceName = otlp?.serviceName ?? (config.serviceNamePrefix || 'loongsuite-pilot');

  return {
    enabled: true,
    endpoint,
    protocol: 'http/protobuf',
    headers,
    serviceName,
    resourceAttributes: otlp?.resourceAttributes,
    captureMessageContent,
    debug: otlp?.debug ?? false,
    turnIdleTimeoutMs: otlp?.turnIdleTimeoutMs ?? 0,
  };
}

function buildOtlpTraceConfigLegacy(config: AnalyticsConfig): OtlpTraceFlusherConfig | undefined {
  const { cms, serviceNamePrefix } = config;
  if (!cms.enabled || !cms.endpoint) return undefined;

  // Legacy CMS mode targets ARMS. Required ARMS headers are derived from the
  // CMS block so old configs can produce an OTLP exporter without otlpTrace.
  const armsProject = extractArmsProject(cms.endpoint);
  const headers: Record<string, string> = {};
  if (cms.licenseKey) headers['x-arms-license-key'] = cms.licenseKey;
  if (armsProject) headers['x-arms-project'] = armsProject;
  if (cms.workspace) headers['x-cms-workspace'] = cms.workspace;

  const captureMessageContent = resolveCaptureMessageContent(config.agents);

  return {
    enabled: true,
    endpoint: cms.endpoint,
    protocol: 'http/protobuf',
    headers,
    serviceName: serviceNamePrefix || 'loongsuite-pilot',
    resourceAttributes: { 'acs.arms.service.feature': 'genai_app' },
    captureMessageContent,
    debug: cms.debug ?? false,
    turnIdleTimeoutMs: 0,
  };
}

function extractArmsProject(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const hostParts = url.hostname.split('.');
    return hostParts[0] ?? '';
  } catch {
    return '';
  }
}

function resolveCaptureMessageContent(agents: AgentsConfig): boolean {
  const values = Object.values(agents);
  if (values.length === 0) return true;
  // Any agent-level opt-out disables message content capture for trace export.
  // The trace flusher is global, so it uses the strictest configured policy.
  return values.every(a => a.captureMessageContent !== false);
}

function parseSlsEndpointEntry(ep: SlsEndpointEntry, index: number): SlsEndpoint {
  // Multi-endpoint config already describes complete endpoints. Infer AK mode
  // from credentials when mode is omitted; otherwise default to webtracking.
  const mode: SlsMode = ep.mode ?? (ep.accessKeyId && ep.accessKeySecret ? 'ak' : 'webtracking');
  const rawEndpoint = ep.endpoint ?? '';
  const endpoint = rawEndpoint
    ? (/^https?:\/\//.test(rawEndpoint) ? rawEndpoint : `https://${rawEndpoint}`)
    : '';
  const result: SlsEndpoint = {
    name: ep.name ?? `sls-${index}`,
    endpoint,
    project: ep.project,
    logstore: ep.logstore,
    kind: 'agentActivity',
    mode,
    redact: false,
  };
  if (mode === 'ak') {
    result.accessKeyId = ep.accessKeyId ?? '';
    result.accessKeySecret = ep.accessKeySecret ?? '';
  }
  return result;
}

function buildSlsConfig(file: ConfigFile | null, serviceNamePrefix: string, innerDataConfig: InnerDataConfig | null) {
  const rawSls = file?.sls;
  const isArray = Array.isArray(rawSls);
  const single = isArray ? null : (rawSls as SlsSingleConfig | undefined) ?? null;

  if (single?.destinationOverride !== undefined) {
    logger.warn('config.sls.destinationOverride is deprecated and ignored — remove it from config.json');
  }

  let endpoints: SlsEndpoint[];

  if (isArray) {
    // New shape: config.sls is an array and each item is a destination. Env
    // LOONGSUITE_SLS_* overrides are intentionally not applied to this shape.
    endpoints = (rawSls as SlsEndpointEntry[]).map((ep, i) => parseSlsEndpointEntry(ep, i));
  } else if (single) {
    // Legacy/single shape: config.sls describes the user destination and env
    // LOONGSUITE_SLS_* may override each destination field.
    const userMode = readUserSlsMode(single);
    const userAk = env('LOONGSUITE_SLS_ACCESS_KEY_ID') ?? single.accessKeyId;
    const userSk = env('LOONGSUITE_SLS_ACCESS_KEY_SECRET') ?? single.accessKeySecret;
    const userRawEndpoint = env('LOONGSUITE_SLS_ENDPOINT') ?? single.endpoint;
    const userProject = env('LOONGSUITE_SLS_PROJECT') ?? single.project;
    const userLogstore = env('LOONGSUITE_SLS_LOGSTORE') ?? single.logstore;

    // A user destination is created only after project and logstore are known.
    // endpoint may still be empty; the later enabled derivation will then
    // disable SLS while preserving the parsed endpoint for diagnostics.
    const hasUserDestination = !!(userProject && userLogstore);

    if (hasUserDestination) {
      const userEndpoint = buildUserSlsEndpoint({
        mode: userMode,
        rawEndpoint: userRawEndpoint,
        project: userProject!,
        logstore: userLogstore!,
        accessKeyId: userAk,
        accessKeySecret: userSk,
      });
      endpoints = [userEndpoint];
    } else {
      endpoints = [];
    }
  } else {
    endpoints = [];
  }

  if (innerDataConfig?.sls && Array.isArray(innerDataConfig.sls)) {
    // Inner endpoints are appended after user config so de-duplication keeps the
    // user's entry when both sources describe the same endpoint/project/logstore.
    const innerEndpoints = innerDataConfig.sls
      .filter(ep => ep.endpoint && ep.logstore)
      .map((ep, i) => parseSlsEndpointEntry(ep, i));
    endpoints = [...endpoints, ...innerEndpoints];
  }

  endpoints = dedupSlsEndpoints(endpoints);

  // Top-level SlsFlusherConfig fields mirror the first endpoint for legacy
  // consumers. New code should prefer the per-endpoint endpoints array.
  const primary = endpoints[0] as SlsEndpoint | undefined;
  const topLevelMode = primary?.mode ?? 'webtracking';
  const topLevelEndpoint = primary?.endpoint ?? '';
  const topLevelAk = primary?.accessKeyId ?? '';
  const topLevelSk = primary?.accessKeySecret ?? '';

  const enabled = single?.enabled !== undefined
    ? single.enabled
    : endpoints.length > 0 && endpoints.every(ep => {
        // webtracking accepts an empty project, but every mode requires endpoint
        // and logstore. AK additionally requires project and both credentials.
        if (!ep.endpoint || !ep.logstore) return false;
        if (ep.mode === 'ak') return !!(ep.project && ep.accessKeyId && ep.accessKeySecret);
        return true;
      });

  return {
    enabled,
    mode: topLevelMode,
    accessKeyId: topLevelAk,
    accessKeySecret: topLevelSk,
    endpoint: topLevelEndpoint,
    endpoints,
    batchMaxSize: single?.batchMaxSize ?? 20,
    flushIntervalMs: single?.flushIntervalMs ?? 2_000,
    serviceNamePrefix,
  };
}

function readUserSlsMode(single: SlsSingleConfig | null): SlsMode | undefined {
  const raw = env('LOONGSUITE_SLS_MODE') ?? single?.mode;
  if (raw === 'ak' || raw === 'webtracking') return raw;
  return undefined;
}

function buildUserSlsEndpoint(args: {
  mode: SlsMode | undefined;
  rawEndpoint: string | undefined;
  project: string;
  logstore: string;
  accessKeyId: string | undefined;
  accessKeySecret: string | undefined;
}): SlsEndpoint {
  // For the single-user destination, missing mode is inferred from the presence
  // of both credentials; otherwise the safer anonymous webtracking path is used.
  const mode: SlsMode = args.mode ?? (args.accessKeyId && args.accessKeySecret ? 'ak' : 'webtracking');

  const rawEndpoint = args.rawEndpoint ?? '';
  const endpoint = rawEndpoint
    ? (/^https?:\/\//.test(rawEndpoint) ? rawEndpoint : `https://${rawEndpoint}`)
    : '';

  const result: SlsEndpoint = {
    name: 'user-sls',
    endpoint,
    project: args.project,
    logstore: args.logstore,
    kind: 'agentActivity',
    mode,
    redact: false,
  };
  if (mode === 'ak') {
    result.accessKeyId = args.accessKeyId ?? '';
    result.accessKeySecret = args.accessKeySecret ?? '';
  }
  return result;
}

/**
 * Normalize an SLS endpoint URL for dedup comparison:
 *   - prepend https:// if no scheme
 *   - strip trailing slash
 *   - lowercase host (preserve path case)
 */
function normalizeEndpointUrl(raw: string): string {
  let s = raw.trim();
  if (!/^https?:\/\//.test(s)) s = `https://${s}`;
  s = s.replace(/\/+$/, '');
  // Lowercase scheme + host portion only.
  return s.replace(/^(https?:\/\/)([^/]+)/i, (_, scheme: string, host: string) =>
    `${scheme.toLowerCase()}${host.toLowerCase()}`,
  );
}

function dedupSlsEndpoints(endpoints: SlsEndpoint[]): SlsEndpoint[] {
  const seen = new Set<string>();
  const result: SlsEndpoint[] = [];
  for (const ep of endpoints) {
    const key = `${normalizeEndpointUrl(ep.endpoint)}|${ep.project}|${ep.logstore}`;
    // Keep the first endpoint for each normalized destination. Because buildSlsConfig
    // appends inner destinations after config.json, user config wins conflicts.
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ep);
  }
  return result;
}

function buildJsonlConfig(file: ConfigFile | null, dataDir: string) {
  return {
    // JSONL is the local fallback output and is enabled by default.
    enabled: envBool('JSONL_ENABLED', file?.jsonl?.enabled ?? true),
    outputDir: resolveHome(
      env('JSONL_OUTPUT_DIR') ?? file?.jsonl?.outputDir ?? `${dataDir}/logs/output`,
    ),
    rotateDaily: file?.jsonl?.rotateDaily ?? true,
    maxFileSizeMb: file?.jsonl?.maxFileSizeMb ?? 100,
  };
}

function buildHttpConfig(file: ConfigFile | null) {
  const url = env('HTTP_REPORT_URL') ?? file?.http?.url ?? '';
  let headers: Record<string, string> | undefined;
  const envHeaders = env('HTTP_REPORT_HEADERS');
  if (envHeaders) {
    // Malformed HTTP_REPORT_HEADERS should not block startup; the request is
    // sent without headers instead.
    try { headers = JSON.parse(envHeaders); } catch { /* ignore */ }
  } else {
    headers = file?.http?.headers;
  }

  const enabled = env('HTTP_REPORT_URL') !== undefined
    // When the env URL is present it becomes the source of truth: empty disables
    // HTTP, non-empty enables HTTP regardless of config.http.enabled.
    ? !!url
    : file?.http?.enabled ?? !!url;

  return {
    enabled,
    url,
    headers,
    batchMaxSize: file?.http?.batchMaxSize ?? 20,
    flushIntervalMs: file?.http?.flushIntervalMs ?? 5_000,
    requestTimeoutMs: file?.http?.requestTimeoutMs ?? 10_000,
  };
}

const DEFAULT_CHECK_INTERVAL_MS = 60_000; // 1 minute

/**
 * Build AutoUpdateConfig from env vars + config file.
 * Exported for use by the standalone updater process.
 */
export function buildAutoUpdateConfig(
  file: ConfigFile | null,
): AutoUpdateConfig {
  const packageUrl = env('LOONGSUITE_PILOT_PACKAGE_URL') ?? file?.autoUpdate?.packageUrl;

  let manifestUrl = env('LOONGSUITE_PILOT_MANIFEST_URL') ?? file?.autoUpdate?.manifestUrl;
  if (!manifestUrl && packageUrl) {
    // If only a package URL is provided, the updater expects latest.json next to
    // the package. Explicit manifestUrl still takes precedence.
    const lastSlash = packageUrl.lastIndexOf('/');
    manifestUrl = lastSlash >= 0
      ? packageUrl.substring(0, lastSlash + 1) + 'latest.json'
      : undefined;
  }

  const hasPackageConfig = !!packageUrl;

  return {
    // Auto update cannot be enabled without a package URL, even if the flag is true.
    enabled: hasPackageConfig && envBool('LOONGSUITE_PILOT_AUTO_UPDATE_ENABLED', file?.autoUpdate?.enabled ?? true),
    checkIntervalMs: envInt(
      'LOONGSUITE_PILOT_AUTO_UPDATE_INTERVAL_MS',
      file?.autoUpdate?.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
    ),
    manifestUrl,
    packageUrl,
    installId: file?.installId,
    canaryPolicy: file?.canary?.policy,
    canaryHotfixVersion: file?.canary?.hotfix_version ?? 0,
  };
}
