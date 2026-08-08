import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

// 读取执行打包脚本时设置的环境变量 BUILD_MODE，判断环境变量的值严格等于字符串 proprietary
// 相等 → isProprietary = true（商业专有版本构建），不相等 / 环境变量不存在 → isProprietary = false（开源版本构建）
const isProprietary = process.env.BUILD_MODE === 'proprietary';

const commonDefine = {
  // esbuild 在打包阶段，扫描源码，把代码里出现的标识符 __PROPRIETARY_BUILD__，直接替换成你指定的字符串字面量
  // // 不要直接传布尔值！esbuild 会把它识别成变量引用，而不是字面量
  // 如果是字符串常量（例如版本号）需要额外加引号，如：'__VERSION__': JSON.stringify('1.0.0')
  '__PROPRIETARY_BUILD__': String(isProprietary),
};

// internalStubPlugin 是一个 esbuild 插件，作用：在开源版本中，把 .internal 私有模块做 “空实现桩（stub）”；商业专有版直接跳过，使用真实代码。
const internalStubPlugin = {
  // 插件唯一名称
  name: 'internal-stub',
  setup(b) {
    // 如果是专有商业版本，直接 return，不注册任何逻辑
    if (isProprietary) return;
    // 钩子1：拦截导入路径匹配 /\.internal/ 的模块, 把所有 .internal 的模块归类，方便后续 onLoad 精准捕获，避免和普通文件冲突
    b.onResolve({ filter: /\.internal/ }, (args) => ({
      path: args.path,
      // 给这类模块打上专属命名空间 internal-stub
      namespace: 'internal-stub',
    }));
    // 钩子2：专门拦截 alarm-sender.internal, 当 esbuild 需要加载 alarm-sender.internal 模块时，不去磁盘读取真实文件，直接返回内存里写好的源码
    b.onLoad({ filter: /alarm-sender\.internal/, namespace: 'internal-stub' }, () => ({
      // 虚拟模块源代码（空函数桩代码 stub）
      contents: 'export function sendAlarm() {} export function sendStatus() {}',
      // 告诉 esbuild 这段内容按照 TypeScript 解析编译
      loader: 'ts',
    }));
    // 钩子3：专门拦截 statistic.internal
    b.onLoad({ filter: /statistic\.internal/, namespace: 'internal-stub' }, () => ({
      contents: 'export function sendRunningStatus() {}',
      loader: 'ts',
    }));
  },
};

// 放入插件数组，传给 esbuild build API
const commonPlugins = [internalStubPlugin];

// 这是调用 esbuild 执行一次打包构建，用于编译 TS 源码产出 Node.js ESM 产物
await build({
  // 入口文件，构建起点；从 src/index.ts 开始递归解析所有 import 依赖
  entryPoints: ['src/index.ts'],
  // 输出单个打包文件，最终产物写入 dist/index.js。
  outfile: 'dist/index.js',
  // 平台目标：运行环境是 Node.js, esbuild 会适配 Node API（process、fs、path等）不会注入浏览器相关 polyfill
  platform: 'node',
  // 生成 JS 语法标准为 ES2022,不会向下降级到更低版本语法，要求运行的 Node 版本支持 ES2022。
  target: 'es2022',
  // 输出模块规范：ES Module（import / export）产物使用 import/export，不是 CommonJS require/module.exports；运行的项目 package.json 需要配置 "type":"module"。
  format: 'esm',
  // 开启打包：把入口 + 所有依赖合并到单个文件。
  bundle: true,
  // 开启代码压缩：删除空格、换行、缩短变量名、移除注释，减小体积。
  minify: true,
  // 开启树摇，剔除没被使用的导出代码（dead-code elimination）；前提：代码使用 ES Module，不混用动态 require。
  treeShaking: true,
  // 所有 node_modules/* 第三方包标记为外部依赖（external）
  // 如果不设置 packages:'external'，esbuild 会把第三方库一起打包进 dist/index.js，做成单文件可直接运行（类似 pkg、单二进制前置打包）
  // 效果是不会把 package.json 里的依赖打进 bundle，产物代码依旧保留 import xxx from 'xxx'；部署环境运行时，仍然需要在目标机器安装 node_modules。
  packages: 'external',
  // 全局变量替换（编译期常量注入）
  define: commonDefine,
  // 载入插件数组，也就是你上一段代码里的 internalStubPlugin； 构建期间拦截 .internal 虚拟模块，开源版注入空桩函数
  plugins: commonPlugins,
});

await build({
  entryPoints: ['src/cli-probe.ts'],
  outfile: 'dist/cli-probe.cjs',
  platform: 'node',
  target: 'es2022',
  // 探测器需要基于 __dirname 从 dist 回溯并定位安装包根目录下的 agents.d，
  // 因此固定输出为 CommonJS 单文件。
  format: 'cjs',
  // 开启打包：把入口 + 所有依赖合并到单个文件。
  bundle: true,
  // stdout 是安装器消费的纯 JSON 协议，构建产物启动时强制关闭依赖模块日志。
  banner: { js: "process.env.LOG_LEVEL = 'silent';" },
  minifySyntax: true,
  define: commonDefine,
  plugins: commonPlugins,
});

await build({
  entryPoints: ['src/updater/index.ts'],
  outdir: 'dist/updater',
  platform: 'node',
  target: 'es2022',
  format: 'esm',
  // 开启打包：把入口 + 所有依赖合并到单个文件。
  bundle: true,
  // 开启代码压缩：删除空格、换行、缩短变量名、移除注释，减小体积。
  minify: true,
  treeShaking: true,
  packages: 'external',
  define: commonDefine,
  plugins: commonPlugins,
});

await mkdir('dist', { recursive: true });
// 将项目目录src/mask/sensitive-rules.json文件拷贝到dist/sensitive-rules.json
await copyFile('src/mask/sensitive-rules.json', 'dist/sensitive-rules.json');

// Best-effort: build macOS status bar app (Swift)
if (process.platform === 'darwin') {
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('node', ['scripts/build-status-bar-app.mjs'], { stdio: 'inherit', timeout: 200_000 });
  } catch {
    // non-fatal — status bar app build failure doesn't block the main build
  }
}
