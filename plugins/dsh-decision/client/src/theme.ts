/**
 * Tailwind 编译产物的运行时挂载（决策工具系列 6/11）。
 *
 * 与 llm-fallback theme.ts 同款：构建期 esbuild define 注入
 * `__TAILWIND_CSS__`（源码不含 CSS 文本）；模块体**同步**注入一次
 * <style data-plugin-css>——懒注入的未标注 style 会被其他插件的
 * claimStyles 误认领，因此必须同步 + 标注。
 *
 * @module dsh-decision/client/theme
 */

declare const __TAILWIND_CSS__: string;

import { PKG_NAME, PLUGIN_NAME } from './constants.ts';

/** 幂等注入主题样式（模块加载时同步执行一次）。 */
function injectThemeStyles(): void {
  if (typeof document === 'undefined') return;
  if (typeof __TAILWIND_CSS__ !== 'string' || __TAILWIND_CSS__.length === 0) {
    return;
  }
  const selector = `style[data-plugin-css="${PLUGIN_NAME}"]`;
  if (document.querySelector(selector) !== null) return;
  const style = document.createElement('style');
  style.setAttribute('data-plugin', PKG_NAME);
  style.setAttribute('data-plugin-css', PLUGIN_NAME);
  style.textContent = __TAILWIND_CSS__;
  document.head.append(style);
}

injectThemeStyles();
