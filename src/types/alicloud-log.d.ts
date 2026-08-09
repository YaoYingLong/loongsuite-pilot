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
    /**
     * 使用 AK、区域和可选 endpoint 创建 SDK Client。
     * 构造阶段只建立客户端配置；真正的网络请求由下方各异步方法发起。
     */
    constructor(config: LogClientConfig);

    /** 异步写入一组日志，失败时 Promise reject，由 SlsTransport 重试。 */
    postLogStoreLogs(
      projectName: string,
      logstoreName: string,
      data: LogGroup,
      options?: Record<string, unknown>,
    ): Promise<string>;

    /** 查询 Project 是否存在；返回结构未被本项目读取，因此保留 unknown。 */
    getProject(projectName: string): Promise<unknown>;
    /** 列出 Project 下 Logstore；可选 data 承载 SDK 查询参数。 */
    listLogStore(projectName: string, data?: Record<string, unknown>): Promise<unknown>;
    /** 创建 Logstore；失败时 Promise reject，由调用方决定是否降级。 */
    createLogStore(
      projectName: string,
      logstoreName: string,
      data?: Record<string, unknown>,
    ): Promise<unknown>;
    /** 查询时间区间内日志；当前声明只约束本项目实际使用的参数形态。 */
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
