/**
 * Tailwind 编译产物的运行时挂载（构建期注入，源码不含 CSS 文本）。
 *
 * 机制（可行性 spike 结论，见任务卡评论）：宿主 client-modules 无独立
 * CSS 产物通道，但一等支持 factory 执行期间注入 <style>——materialize 后
 * claimStyles(id) 给未标注 <style> 打 data-plugin 属性，卸载/HMR/prune 时
 * removeOwnedStyles(id) 自动移除。因此：
 * - 本模块必须在模块体（factory 执行内）同步调用 injectThemeStyles()，
 *   不能懒到首次渲染——懒注入的未标注 <style> 会在后续其他插件
 *   materialize 时被其 claimStyles 误认领，被别人卸载时连带移除；
 * - 自打 data-plugin + data-plugin-css 属性双保险：前者是宿主清理键，
 *   后者是本卡幂等去重键（重复 materialize / 双实例不重复注入）。
 *
 * CSS 文本由 scripts/build-client.ts 经 esbuild define 以
 * __TAILWIND_CSS__ 注入；vitest 无 define 时 typeof 为 "undefined"，安全
 * 跳过（esbuild 在 typeof 上下文同样替换——产物中恒为 "string"）。
 *
 * @module dsh-llm-fallback/client/theme
 */

import { PKG_NAME, PLUGIN_NAME } from './constants.ts';

/** 构建期由 esbuild define 注入的 Tailwind 编译产物（minified CSS）。 */
declare const __TAILWIND_CSS__: string;

/** 幂等注入 <style data-plugin="..." data-plugin-css="llm-fallback">。 */
export function injectThemeStyles(): void {
  if (typeof document === 'undefined') return;
  if (typeof __TAILWIND_CSS__ !== 'string' || __TAILWIND_CSS__ === '') return;
  const selector = 'style[data-plugin-css="' + PLUGIN_NAME + '"]';
  if (document.querySelector(selector) !== null) return;
  const el = document.createElement('style');
  el.setAttribute('data-plugin', PKG_NAME);
  el.setAttribute('data-plugin-css', PLUGIN_NAME);
  el.textContent = __TAILWIND_CSS__;
  document.head.appendChild(el);
}

// 模块体同步执行：factory materialize 即挂载，宿主 claimStyles 立即认领。
injectThemeStyles();
