/**
 * decision-tools 客户端入口（决策工具系列 6/11）。
 *
 * 与 llm-fallback 同款：整个产物被 `window.__ModuleLoader__.load({ id,
 * factory })` 包住，factory 返回 { name, inject, apply } 三符号；id 必须
 * 与包名一致（PKG_NAME）。
 *
 * @module dsh-decision/client/main
 */

export { name, inject, apply } from './plugin.tsx';
