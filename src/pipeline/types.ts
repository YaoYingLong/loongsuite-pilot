/**
 * 独立 Pipeline 子系统的配置、生命周期和 checkpoint 类型。
 *
 * PipelineManager 从 `<dataDir>/pipeline-configs/*.json` 解析这些 PascalCase 配置，按 Input Type
 * 创建 FilePipeline 或 QoderApiPipeline。该子系统直接上报 SLS，不经过主 InputManager。
 */

import type { WakeEvent } from './sleep-detector.js';

// 所有独立 Pipeline 的生命周期协议。

export interface Pipeline {
  /** 创建定时器/监听器并执行首轮采集。 */
  start(): Promise<void>;
  /** 停止采集并尽量排空发送缓冲。 */
  stop(): Promise<void>;
  /** 可选的系统睡眠恢复处理。 */
  handleWake?(event: WakeEvent): Promise<void>;
}

// 文件和 Qoder 管理 API 两类输入配置。

export interface FileInputConfig {
  Type: 'input_file';
  FilePaths: string[];
  FileEncoding?: string;
  MaxDirSearchDepth?: number;
  AllowingIncludedByMultiConfigs?: boolean;
}

export interface QoderApiInputConfig {
  Type: 'input_qoder_api';
  ApiKey: string;
  OrgId: string;
  ApiBase?: string;
  Interval?: number;
  BackfillDays?: number;
}

export type PipelineInputConfig = FileInputConfig | QoderApiInputConfig;

// Pipeline 当前只支持 WebTracking 风格 SLS 输出。

export interface PipelineSlsFlusherConfig {
  Type: 'flusher_sls';
  Endpoint: string;
  Project: string;
  Logstore: string;
  Region?: string;
  Aliuid?: string;
  TelemetryType?: string;
}

// 单个配置文件解析后的顶层结构。

export interface PipelineConfig {
  configName: string;
  inputs: PipelineInputConfig[];
  flushers: PipelineSlsFlusherConfig[];
}

// Orchestrator 注入 PipelineManager 的目录和总开关。

export interface PipelineManagerOptions {
  configDir: string;
  stateDir: string;
  failedLogDir: string;
  dataDir: string;
  pipelineConfig: PipelineToggle;
}

export interface PipelineToggle {
  enabled: boolean;
  file: { enabled: boolean };
  qoderApi: { enabled: boolean };
}

// FilePipeline 需要的已验证配置与运行目录。

export interface FilePipelineOptions {
  config: PipelineConfig;
  stateDir: string;
  failedLogDir: string;
  dataDir: string;
}

// QoderApiPipeline 需要的已验证配置与运行目录。

export interface QoderApiPipelineOptions {
  config: PipelineConfig;
  stateDir: string;
  failedLogDir: string;
  dataDir: string;
}

// 从旧 file-collection 模块迁移来的文件增量读取状态。

export interface DevInode {
  dev: number;
  ino: number;
}

export interface FileCheckpoint {
  /** 已确认消费到的字节偏移。 */
  offset: number;
  inode: number;
  dev: number;
  /** 文件头签名用于 inode 不可靠或复用时再次校验身份。 */
  signatureHash: string;
  signatureSize: number;
  lastUpdateTime: number;
  cache: string;
}

export interface FileReaderState {
  filePath: string;
  devInode: DevInode;
  offset: number;
  signatureHash: string;
  lastUpdateTime: number;
  cache: string;
  deleted: boolean;
  deletedTime: number;
}

// 便捷 re-export，让其他 Pipeline 只依赖 types.ts。
export type { WakeEvent } from './sleep-detector.js';
