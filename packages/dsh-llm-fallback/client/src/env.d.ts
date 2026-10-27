/**
 * 客户端运行时全局类型增广：宿主 HTML 安装的模块注册门面。
 *
 * 形状对齐 @deepseek-ai/dsh-client-modules 的 ClientModuleLoaderTarget
 * （本插件只使用 load）；这里手写窄声明，避免 client 半区 import 宿主包。
 *
 * @module dsh-llm-fallback/client/env
 */

export {};

/** 一次 client bundle 的 factory 注册（ClientBundleRegistration 窄化）。 */
export interface ClientBundleRegistration {
  /** 插件 id（包名）——注册键，必须与宿主 boot graph 行一致。 */
  id: string;
  /** 闭包工厂：materialize 时以模块表 require 调用一次，返回插件导出。 */
  factory: (require: unknown) => unknown;
}

/** 宿主注册门面（HTML 阶段排队、模块系统就绪后实时注册）。 */
export interface ModuleLoaderTarget {
  load(registration: ClientBundleRegistration): void;
}

declare global {
  var __ModuleLoader__: ModuleLoaderTarget | undefined;
}
