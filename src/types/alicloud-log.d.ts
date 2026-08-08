/**
 * `@alicloud/log` 的本地类型补充。
 *
 * 第三方包的运行时实现由 node_modules 提供，本声明只让 TypeScript 能检查 SlsTransport 调用；
 * 不会生成 JavaScript，也不会改变 SDK 行为。字段和方法应以当前实际使用面为准。
 */
declare module '@alicloud/log' {
  /** 创建 SLS Client 所需的鉴权和区域配置。 */
  interface LogClientConfig {
    accessKeyId: string;
    accessKeySecret: string;
    region: string;
    net?: string;
    endpoint?: string;
    securityToken?: string;
  }

  /** SLS 单条日志的字符串列。 */
  interface LogContent {
    [key: string]: string;
  }

  /** SDK 接受的带秒级时间戳日志。 */
  interface LogEntry {
    timestamp: number;
    content: LogContent;
  }

  /** 一次 postLogStoreLogs 请求中的日志组。 */
  interface LogGroup {
    logs: LogEntry[];
    topic?: string;
    source?: string;
    tags?: Array<Record<string, string>>;
  }

  /** 本项目使用到的 SDK Client 最小方法集合。 */
  class Client {
    constructor(config: LogClientConfig);

    /** 异步写入一组日志，失败时 Promise reject，由 SlsTransport 重试。 */
    postLogStoreLogs(
      projectName: string,
      logstoreName: string,
      data: LogGroup,
      options?: Record<string, unknown>,
    ): Promise<string>;

    getProject(projectName: string): Promise<unknown>;
    listLogStore(projectName: string, data?: Record<string, unknown>): Promise<unknown>;
    createLogStore(
      projectName: string,
      logstoreName: string,
      data?: Record<string, unknown>,
    ): Promise<unknown>;
    getLogs(
      projectName: string,
      logstoreName: string,
      from: Date,
      to: Date,
      data?: Record<string, unknown>,
    ): Promise<unknown[]>;
  }

  // CommonJS `export =` 与运行时 SDK 的导出方式保持一致。
  export = Client;
}
