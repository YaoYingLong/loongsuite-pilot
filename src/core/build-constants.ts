/**
 * 构建模式常量桥接模块。
 *
 * `build.mjs` 在打包时替换全局编译常量 `__PROPRIETARY_BUILD__`；业务代码只导入
 * 本模块的布尔值，从而在开源构建与内部构建间做静态分支。源码直接由 tsc 检查时，
 * `declare` 只声明类型，不会生成运行时代码。
 */
declare const __PROPRIETARY_BUILD__: boolean;
export const PROPRIETARY_BUILD = __PROPRIETARY_BUILD__;
