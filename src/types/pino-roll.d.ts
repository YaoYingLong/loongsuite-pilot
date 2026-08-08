/**
 * pino-roll 的本地声明文件。
 *
 * 第三方包未附带完整 `.d.ts`，这里描述 logger.ts 实际使用的配置与返回流。声明仅参与类型
 * 检查，不生成 JavaScript；新增运行时选项时应同步补充，避免用 `any` 隐藏配置错误。
 */

// 当代码执行 `import build from 'pino-roll'` 时，TypeScript 使用此模块声明检查参数。
declare module 'pino-roll' {
  import { WriteStream } from 'node:fs';

  interface PinoRollOptions {
    // 日志基础文件名
    file: string;
    // 按时间切割（天/小时/秒）
    frequency?: 'daily' | 'hourly' | number;
    // 按文件大小切割
    size?: string | number;
    // 日志文件名日期格式
    dateFormat?: string;
    // 不存在目录是否自动创建
    mkdir?: boolean;
    // 文件后缀
    extension?: string;
    // 是否生成 latest 软链接
    symlink?: boolean;
    // 日志保留数量限制，自动清理旧日志
    limit?: { count?: number; removeOtherLogFiles?: boolean };
  }
  // 声明默认导出函数签名，入参：符合 PinoRollOptions 的配置对象，返回值：Promise<WriteStream>
  function build(options: PinoRollOptions): Promise<WriteStream>;
  export default build;
}
