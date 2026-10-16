/**
 * client bundle 入口模块：导出宿主 loader 消费的三个符号。
 *
 * 打包（scripts/build-client.ts）后整个产物被包进
 * `window.__ModuleLoader__.load({ id, factory })` 的 factory 闭包，
 * factory 返回本模块的 exports（{ name, inject, apply }）。
 *
 * 契约要点（详见 dsh-client-modules 的 manifest.d.ts）：
 * - id 由构建脚本从 package.json 读取，必须与包名一致，否则 web boot
 *   抛 "loaded without registering"；
 * - react 经 factory 注入的宿主模块表 require 解析（external），绝不可
 *   打第二份 React——否则宿主渲染本卡时 hooks 跨副本调用即崩；
 * - loader 只读 name/inject/apply 三个符号。
 *
 * 功能面：设置 → 插件 → dsh-llm-fallback 的配置卡片——启用开关、模型
 * 勾选回退队列（排序/搜索/限高滚动）、最大回退次数、每候选重试次数、
 * 失败候选冷却、时段计划；文案 zh/en 经 locale 服务注册、语言切换即时
 * 生效；配色全部引用 dsh web 主题 token（明/暗双模式）。
 *
 * @module dsh-llm-fallback/client
 */

export { name, inject, apply } from './plugin.tsx';
