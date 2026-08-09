/**
 * pino-roll 的本地声明文件。
 *
 * 第三方包未附带完整 `.d.ts`，这里描述 logger.ts 实际使用的配置与返回流。声明仅参与类型
 * 检查，不生成 JavaScript；新增运行时选项时应同步补充，避免用 `any` 隐藏配置错误。
 */

// 当代码执行 `import build from 'pino-roll'` 时，TypeScript 使用此模块声明检查参数。
declare module 'pino-roll' {
  import { WriteStream } from 'node:fs';

  /** logger.ts 创建轮转写入流时实际使用到的 pino-roll 选项子集。 */
  interface PinoRollOptions {
    /** 日志基础文件名；轮转器会按 dateFormat 生成实际文件名。 */
    file: string;
    /** 按天、小时或数值周期触发时间轮转。 */
    frequency?: 'daily' | 'hourly' | number;
    /** 达到指定字节数/带单位字符串时触发大小轮转。 */
    size?: string | number;
    /** 轮转文件名使用的日期格式。 */
    dateFormat?: string;
    /** 父目录不存在时是否递归创建。 */
    mkdir?: boolean;
    /** 轮转文件后缀。 */
    extension?: string;
    /** 是否维护指向最新日志的软链接。 */
    symlink?: boolean;
    /** 保留数量和是否清理同目录其他日志文件。 */
    limit?: { count?: number; removeOtherLogFiles?: boolean };
  }
  /** 创建异步轮转文件流；Promise reject 会传播给 initFileLogging 的启动边界。 */
  function build(options: PinoRollOptions): Promise<WriteStream>;
  export default build;
}
