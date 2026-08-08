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
  /** 判别字段，PipelineManager 据此创建 FilePipeline。 */
  Type: 'input_file';
  /** 一个或多个文件/glob 路径；当前 glob 只匹配 basename 的 `*`。 */
  FilePaths: string[];
  /** Buffer 解码名称，默认 utf8。 */
  FileEncoding?: string;
  /** FileTailer 从 pattern 父目录向下递归的最大层数。 */
  MaxDirSearchDepth?: number;
  /** 配置契约保留字段；当前运行代码未依据它执行跨配置排他检查。 */
  AllowingIncludedByMultiConfigs?: boolean;
}

/** Qoder 组织管理 API 的连接、轮询和首次回溯配置。 */
export interface QoderApiInputConfig {
  /** 判别字段，PipelineManager 据此创建 QoderApiPipeline。 */
  Type: 'input_qoder_api';
  /** Bearer token；只应进入 QoderApiClient 私有成员。 */
  ApiKey: string;
  /** 需要采集的组织 ID。 */
  OrgId: string;
  /** OpenAPI 根地址，缺省为官方地址。 */
  ApiBase?: string;
  /** 轮询间隔，单位为秒。 */
  Interval?: number;
  /** 没有 checkpoint 时的首次回溯天数。 */
  BackfillDays?: number;
}

/** 通过 `Type` 判别的 Pipeline 输入联合类型。 */
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
  /** 独立 Pipeline 子系统总开关，由 Orchestrator 判断是否创建 Manager。 */
  enabled: boolean;
  /** 文件采集类型子开关。 */
  file: { enabled: boolean };
  /** Qoder 管理 API 类型子开关。 */
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
  /** Unix inode；Windows/特殊文件系统上仍使用 Node stat 返回值。 */
  inode: number;
  /** 设备号，与 inode 组合后标识物理文件。 */
  dev: number;
  /** 文件头签名用于 inode 不可靠或复用时再次校验身份。 */
  signatureHash: string;
  /** 计算签名时读取的文件头字节数，用于 checkpoint 版本兼容。 */
  signatureSize: number;
  /** reader 最后读写时间，供一小时无活动清理。 */
  lastUpdateTime: number;
  /** offset 已跨过但尚未遇到换行符的文本残片。 */
  cache: string;
}

/** FileTailer 运行期可变 reader；比 FileCheckpoint 多删除/rotation 状态。 */
export interface FileReaderState {
  /** reader 创建时的逻辑路径；rename 后实际读取路径可能由 inode 重新查找。 */
  filePath: string;
  /** 当前物理文件身份。 */
  devInode: DevInode;
  /** 下一次读取的 byte offset。 */
  offset: number;
  /** 文件头 MD5 身份签名，不用于安全校验。 */
  signatureHash: string;
  /** 最近活动时间。 */
  lastUpdateTime: number;
  /** 未形成完整行的尾部文本。 */
  cache: string;
  /** 逻辑路径是否已消失或转而指向新 inode。 */
  deleted: boolean;
  /** 首次标记 deleted 的时间，用于等待 rename 文件出现。 */
  deletedTime: number;
}

// 便捷 re-export，让其他 Pipeline 只依赖 types.ts。
export type { WakeEvent } from './sleep-detector.js';
