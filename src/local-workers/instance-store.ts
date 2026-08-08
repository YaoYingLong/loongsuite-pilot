/**
 * Local Worker 实例的声明式配置、凭据与状态读取仓库。
 *
 * worker CLI 通过 connect/reconnect/enable/delete 修改
 * `<dataDir>/local-workers/<instanceId>/instance.json`，ActivationService 再把 enabled
 * 期望状态收敛为真实进程。bootstrap token 单独以受限权限写入 credentials，避免进入
 * 可展示的 instance.json。查询函数合并 supervisor/runtime/matrix 快照生成 CLI 视图；
 * 所有 ID 和相对路径均经校验，写入使用项目原子 JSON 工具。
 */


import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ensureDir, readJsonFile, resolveHome, writeJsonFile } from '../utils/fs-utils.js';

// Local Worker 持久化目录结构：
//   <dataDir>/local-workers/<instanceId>/instance.json                 实例期望配置
//   <dataDir>/local-workers/<instanceId>/credentials/bootstrap-token   独立凭据文件
//   <dataDir>/local-workers/<instanceId>/state/                         运行状态快照
//   <dataDir>/local-workers/<instanceId>/logs/worker.log                Worker 输出日志
//   <dataDir>/local-workers/<instanceId>/bundle/                        该实例的 Runtime 包

export type RuntimeOptionValue = string | boolean;
/** `worker connect -- ...` 保存的 Runtime 专属参数。 */
export type RuntimeOptions = Record<string, RuntimeOptionValue>;

/** instance.json 的持久化结构，也是 ActivationService 的期望状态来源。 */
export interface LocalWorkerInstance {
  /** 用于后续兼容迁移的持久化 Schema 版本。 */
  schemaVersion: 'loongsuite.localWorker.v1';
  /** 本机唯一实例 ID，采用 `lw_` 前缀。 */
  id: string;
  /** 用于匹配 AgentDefinition.localWorkerRuntime 的 Runtime 标识。 */
  runtime: string;
  /** Worker 执行任务时使用的绝对工作目录。 */
  workDir: string;
  /** 相对于实例目录的凭据文件路径，避免把 token 明文写入 instance.json。 */
  bootstrapTokenRef: string;
  runtimeOptions: RuntimeOptions;
  /** 声明式启停开关，由 ActivationService 收敛为实际进程状态。 */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectLocalWorkerOptions {
  dataDir: string;
  runtime: string;
  bootstrapToken: string;
  workDir?: string;
  runtimeOptions?: RuntimeOptions;
}

export interface ReconnectLocalWorkerOptions {
  dataDir: string;
  instanceId: string;
  bootstrapToken?: string;
  workDir?: string;
  runtimeOptions?: RuntimeOptions;
}

/** CLI list/status 使用的聚合视图，不直接持久化。 */
export interface LocalWorkerView {
  id: string;
  runtime: string;
  workDir: string;
  enabled: boolean;
  state: string;
  pid?: number;
  workerName?: string;
  teamName?: string;
  matrix?: string;
  roomId?: string;
  heartbeat?: string;
  updatedAt: string;
  logPath: string;
}

/** Worker 有存活进程但超过两分钟没有心跳时，视图状态降级为 degraded。 */
const LOCAL_WORKER_HEARTBEAT_STALE_MS = 120_000;

// 以下路径函数集中定义实例目录约定，避免 CLI、激活服务和 Supervisor 各自拼接出不同路径。
/** 返回 `<dataDir>/local-workers`。 */
export function localWorkerRoot(dataDir: string): string {
  return path.join(resolveHome(dataDir), 'local-workers');
}

/** 返回单实例隔离目录。 */
export function instanceDir(dataDir: string, instanceId: string): string {
  return path.join(localWorkerRoot(dataDir), instanceId);
}

/** 返回实例期望配置 instance.json 路径。 */
export function instanceConfigPath(dataDir: string, instanceId: string): string {
  return path.join(instanceDir(dataDir, instanceId), 'instance.json');
}

/** 根据 instance 中的相对引用返回凭据绝对路径。 */
export function bootstrapTokenPath(dataDir: string, instance: LocalWorkerInstance): string {
  return path.join(instanceDir(dataDir, instance.id), instance.bootstrapTokenRef);
}

/** 返回实例状态快照目录。 */
export function stateDir(dataDir: string, instanceId: string): string {
  return path.join(instanceDir(dataDir, instanceId), 'state');
}

/** 返回实例日志目录。 */
export function logDir(dataDir: string, instanceId: string): string {
  return path.join(instanceDir(dataDir, instanceId), 'logs');
}

/** 返回实例独享 Runtime 包目录。 */
export function bundleDir(dataDir: string, instanceId: string): string {
  return path.join(instanceDir(dataDir, instanceId), 'bundle');
}

/**
 * 删除实例的全部持久化目录。
 * 必须先 disconnect，并等待 ActivationService 确认相关 PID 已退出，避免删除仍在运行的
 * Worker 所依赖的 token、状态目录和日志句柄。
 */
/** 前置条件不满足时抛错，满足后递归删除实例目录。 */
export async function deleteLocalWorkerInstance(dataDir: string, instanceId: string): Promise<void> {
  const instance = await readLocalWorkerInstance(dataDir, instanceId);
  if (!instance) throw new Error(`local worker not found: ${instanceId}`);
  if (instance.enabled) {
    throw new Error(`local worker must be disconnected before delete: ${instanceId}`);
  }

  if (await hasRunningLocalWorkerProcess(dataDir, instanceId)) {
    throw new Error(`local worker is still running, retry after disconnect stops it: ${instanceId}`);
  }
  await fs.rm(instanceDir(dataDir, instanceId), { recursive: true, force: true });
}

/** 创建一个默认启用的新实例，并持久化运行目录、凭据和实例配置。 */
/** 校验 runtime/token、分配 ID、创建隔离目录与凭据，并写默认 enabled 实例。 */
export async function connectLocalWorker(opts: ConnectLocalWorkerOptions): Promise<LocalWorkerInstance> {
  const runtime = opts.runtime.trim();
  if (!runtime) throw new Error('runtime is required');

  const token = opts.bootstrapToken.trim();
  if (!token) throw new Error('bootstrap token is required');

  const id = await createInstanceId(opts.dataDir);
  const dir = instanceDir(opts.dataDir, id);
  const now = new Date().toISOString();

  await ensureDir(stateDir(opts.dataDir, id));
  await ensureDir(logDir(opts.dataDir, id));
  // token 与普通配置分开保存，并尽可能限制为仅当前用户可读写。
  await writeBootstrapToken(dir, token);

  const instance: LocalWorkerInstance = {
    schemaVersion: 'loongsuite.localWorker.v1',
    id,
    runtime,
    workDir: path.resolve(opts.workDir ?? process.cwd()),
    bootstrapTokenRef: 'credentials/bootstrap-token',
    runtimeOptions: normalizeRuntimeOptions(opts.runtimeOptions),
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };

  await writeJsonFile(instanceConfigPath(opts.dataDir, id), instance);
  return instance;
}

/**
 * 重新启用已有实例，并按需更新凭据、工作目录和 Runtime 参数。
 * 未提供的可选项沿用旧值；runtimeOptions 只要显式传入（包括空对象）就整体替换。
 */
/** 重连实例；未提供字段沿用旧值，显式 runtimeOptions 整体替换。 */
export async function reconnectLocalWorker(opts: ReconnectLocalWorkerOptions): Promise<LocalWorkerInstance> {
  const instance = await readLocalWorkerInstance(opts.dataDir, opts.instanceId);
  if (!instance) throw new Error(`local worker not found: ${opts.instanceId}`);

  const token = opts.bootstrapToken?.trim();
  if (token === '') throw new Error('bootstrap token is required');

  const dir = instanceDir(opts.dataDir, instance.id);
  await ensureDir(stateDir(opts.dataDir, instance.id));
  await ensureDir(logDir(opts.dataDir, instance.id));
  if (token) await writeBootstrapToken(dir, token);

  const updated: LocalWorkerInstance = {
    ...instance,
    workDir: opts.workDir ? path.resolve(opts.workDir) : instance.workDir,
    runtimeOptions: opts.runtimeOptions !== undefined
      ? normalizeRuntimeOptions(opts.runtimeOptions)
      : instance.runtimeOptions,
    enabled: true,
    updatedAt: new Date().toISOString(),
  };

  await writeJsonFile(instanceConfigPath(opts.dataDir, instance.id), updated);
  return updated;
}

/** 读取实例配置；缺失或 JSON 无效时返回 null，并规范化旧数据中的 runtimeOptions。 */
export async function readLocalWorkerInstance(
  dataDir: string,
  instanceId: string,
): Promise<LocalWorkerInstance | null> {
  const instance = await readJsonFile<LocalWorkerInstance>(instanceConfigPath(dataDir, instanceId));
  if (!instance) return null;
  return {
    ...instance,
    runtimeOptions: normalizeRuntimeOptions(instance.runtimeOptions),
  };
}

/** 将外部或旧版本数据收敛为仅包含非空键及 string/boolean 值的 Runtime 参数。 */
function normalizeRuntimeOptions(value: unknown): RuntimeOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: RuntimeOptions = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!key) continue;
    if (typeof raw === 'boolean') {
      out[key] = raw;
    } else if (raw !== undefined && raw !== null) {
      out[key] = String(raw);
    }
  }
  return out;
}

/** 扫描所有 `lw_` 实例目录，忽略无关目录和无法读取的实例，并按 ID 稳定排序。 */
export async function listLocalWorkerInstances(dataDir: string): Promise<LocalWorkerInstance[]> {
  const root = localWorkerRoot(dataDir);
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }

  const instances: LocalWorkerInstance[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('lw_')) continue;
    const instance = await readLocalWorkerInstance(dataDir, entry);
    if (instance) instances.push(instance);
  }
  return instances.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 更新实例的期望启用状态。
 * 此函数本身不操作进程；ActivationService 通过目录监听或定时扫描异步完成启动/停止。
 */
export async function setLocalWorkerEnabled(
  dataDir: string,
  instanceId: string,
  enabled: boolean,
): Promise<LocalWorkerInstance> {
  const instance = await readLocalWorkerInstance(dataDir, instanceId);
  if (!instance) throw new Error(`local worker not found: ${instanceId}`);
  const updated = { ...instance, enabled, updatedAt: new Date().toISOString() };
  await writeJsonFile(instanceConfigPath(dataDir, instanceId), updated);
  return updated;
}

/** 并行读取各实例的运行快照，生成 CLI 展示视图。 */
export async function listLocalWorkerViews(dataDir: string): Promise<LocalWorkerView[]> {
  const instances = await listLocalWorkerInstances(dataDir);
  const views = await Promise.all(instances.map(instance => readLocalWorkerView(dataDir, instance)));
  return views;
}

/**
 * 合并 instance.json 与四类状态快照，计算一个容错的 LocalWorkerView。
 * 快照由不同进程独立写入，字段允许缺失或处于不同版本，因此所有读取都采用安全转换
 * 和多来源回退，不把单个损坏快照升级为整个 list/status 命令失败。
 */
export async function readLocalWorkerView(
  dataDir: string,
  instance: LocalWorkerInstance,
): Promise<LocalWorkerView> {
  const sDir = stateDir(dataDir, instance.id);
  const lDir = logDir(dataDir, instance.id);
  const supervisor = await readJsonFile<Record<string, unknown>>(path.join(sDir, 'supervisor-status.json'));
  const worker = await readJsonFile<Record<string, unknown>>(path.join(sDir, 'status.json'));
  const runtimeSnapshot = await readJsonFile<Record<string, unknown>>(path.join(sDir, 'runtime-state.json'));
  const matrixSnapshot = await readJsonFile<Record<string, unknown>>(path.join(sDir, 'matrix-state.json'));
  const runtimeMember = readRecord(runtimeSnapshot?.member);
  const pid = readNumber(supervisor?.pid);
  const alive = pid ? isAlive(pid) : false;
  const heartbeatAt = readTimestampMs(worker?.updatedAt ?? worker?.lastHeartbeatAt ?? worker?.heartbeatAt);
  const degraded = isWorkerDegraded(worker)
    || (alive && heartbeatAt !== undefined && Date.now() - heartbeatAt > LOCAL_WORKER_HEARTBEAT_STALE_MS);

  // 状态优先级：禁用 > Supervisor 失败 > Worker 降级/心跳过期 > 进程存活 > PID 残留
  // > Supervisor 自报状态 > pending。高优先级条件可覆盖尚未及时刷新的低层快照。
  let state = 'pending';
  if (!instance.enabled) {
    state = 'disabled';
  } else if (String(supervisor?.state ?? '') === 'failed') {
    state = 'failed';
  } else if (degraded) {
    state = 'degraded';
  } else if (alive) {
    state = 'running';
  } else if (pid) {
    state = 'stale';
  } else if (typeof supervisor?.state === 'string') {
    state = supervisor.state;
  }

  return {
    id: instance.id,
    runtime: instance.runtime,
    workDir: instance.workDir,
    enabled: instance.enabled,
    state,
    pid,
    // Worker 自报字段优先；缺失时逐步回退到 Runtime 成员快照。
    workerName: readString(worker?.workerName)
      ?? readString(worker?.runtimeName)
      ?? readString(runtimeMember?.runtimeName)
      ?? readString(runtimeMember?.name),
    teamName: readString(worker?.teamName) ?? readTeamName(runtimeSnapshot, runtimeMember),
    matrix: readDisplayValue(worker?.matrixConnected)
      ?? readDisplayValue(readRecord(worker?.matrix)?.connected)
      ?? readMatrixSnapshot(matrixSnapshot),
    roomId: readString(worker?.teamRoomId)
      ?? readString(worker?.roomId)
      ?? firstRecordKey(matrixSnapshot?.matrixCursors)
      ?? readString(runtimeMember?.teamRoomId)
      ?? readString(runtimeMember?.personalRoomId),
    heartbeat: readString(worker?.lastHeartbeatAt)
      ?? readString(worker?.heartbeatAt)
      ?? readTimestampDisplay(worker?.updatedAt),
    updatedAt: readString(worker?.updatedAt) ?? instance.updatedAt,
    logPath: path.join(lDir, 'worker.log'),
  };
}

/** 从实例引用的独立凭据文件读取 bootstrap token。 */
/** 文件缺失/不可读时透传异常给 Worker 启动流程。 */
export async function readBootstrapToken(dataDir: string, instance: LocalWorkerInstance): Promise<string> {
  return (await fs.readFile(bootstrapTokenPath(dataDir, instance), 'utf-8')).trim();
}

/** 同时检查 worker.pid 与 Supervisor 状态中的 PID，任一仍存活都禁止删除实例。 */
async function hasRunningLocalWorkerProcess(dataDir: string, instanceId: string): Promise<boolean> {
  const pids = new Set<number>();
  const pidFromFile = await readPidFile(path.join(stateDir(dataDir, instanceId), 'worker.pid'));
  if (pidFromFile) pids.add(pidFromFile);

  const supervisor = await readJsonFile<Record<string, unknown>>(
    path.join(stateDir(dataDir, instanceId), 'supervisor-status.json'),
  );
  const pidFromStatus = readNumber(supervisor?.pid);
  if (pidFromStatus) pids.add(pidFromStatus);

  for (const pid of pids) {
    if (isAlive(pid)) return true;
  }
  return false;
}

/** 容错解析正整数 PID；文件缺失或非法返回 undefined。 */
async function readPidFile(pidPath: string): Promise<number | undefined> {
  try {
    const pid = Number.parseInt((await fs.readFile(pidPath, 'utf-8')).trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** 最多尝试五次随机 ID，避免极低概率碰撞或命中已有实例目录。 */
async function createInstanceId(dataDir: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = `lw_${base32(crypto.randomBytes(10)).slice(0, 16).toLowerCase()}`;
    if (!await readLocalWorkerInstance(dataDir, id)) return id;
  }
  throw new Error('failed to allocate local worker instance id');
}

/** 将凭据写入独立文件，并在支持 chmod 的平台尽力设置为 0600。 */
async function writeBootstrapToken(dir: string, token: string): Promise<void> {
  const tokenPath = path.join(dir, 'credentials', 'bootstrap-token');
  await ensureDir(path.dirname(tokenPath));
  await fs.writeFile(tokenPath, token, { encoding: 'utf-8', mode: 0o600 });
  await fs.chmod(tokenPath, 0o600).catch(() => {});
}

/** 将随机字节编码为不区分大小写文件系统也可安全使用的 Base32 文本。 */
/** 把随机字节编码为无填充 Base32，用于可读实例 ID。 */
function base32(bytes: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

/** 读取非空字符串。 */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** 将字符串/数字/布尔转成 CLI 展示文本。 */
function readDisplayValue(value: unknown): string | undefined {
  if (typeof value === 'boolean') return value ? 'connected' : 'disconnected';
  if (typeof value === 'string' && value !== '') return value;
  return undefined;
}

/** 根据 Worker 自报 state/status/connected 判断降级。 */
function isWorkerDegraded(worker: Record<string, unknown> | null): boolean {
  const phase = String(worker?.phase ?? worker?.state ?? '').toLowerCase();
  const reason = String(worker?.reason ?? '').toLowerCase();
  return phase === 'degraded' || reason.includes('degraded');
}

/** 同时兼容秒、毫秒、纯数字字符串和 ISO 日期字符串格式的时间戳。 */
/** 兼容 ISO 字符串与毫秒/秒数值时间戳，统一返回毫秒。 */
function readTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 将可解析时间戳规范成 ISO 展示值。 */
function readTimestampDisplay(value: unknown): string | undefined {
  const raw = readString(value);
  if (raw) return raw;
  const ms = readTimestampMs(value);
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

/** 只接受非数组对象。 */
function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** 从多个 Runtime 快照层级回退解析 team name。 */
function readTeamName(
  runtimeSnapshot: Record<string, unknown> | null,
  runtimeMember?: Record<string, unknown>,
): string | undefined {
  const direct = readString(runtimeSnapshot?.teamName)
    ?? readString(runtimeMember?.teamName);
  if (direct) return direct;

  const storage = readRecord(runtimeSnapshot?.storage);
  const storageName = readString(storage?.teamName);
  if (storageName) return storageName;

  const teamPrefix = readString(storage?.teamPrefix);
  if (!teamPrefix) return undefined;
  const match = teamPrefix.match(/(?:^|\/)teams\/([^/]+)/);
  return match?.[1];
}

/** 将 Matrix 快照收敛为 connected/disconnected 等展示字符串。 */
function readMatrixSnapshot(value: Record<string, unknown> | null): string | undefined {
  if (!value) return undefined;
  if (readString(value.matrixSyncToken)) return 'connected';
  const cursors = readRecord(value.matrixCursors);
  return cursors && Object.keys(cursors).length > 0 ? 'connected' : undefined;
}

/** 返回对象首个 key，常用于从 cursor Map 推断 roomId。 */
function firstRecordKey(value: unknown): string | undefined {
  const record = readRecord(value);
  return record ? Object.keys(record).find(key => key !== '') : undefined;
}

/** 只接受有限数值。 */
function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 用 signal 0 检测 PID；异常按不存活。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
