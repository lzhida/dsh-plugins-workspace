/**
 * 侧栏图标 glyph：宿主 sidebar.panellist 行自带按钮（点击行即打开面板），
 * 本组件只渲染图形——再包一层 button 会得到嵌套 button（无效 HTML）。
 *
 * @module dsh-open-design/client/components/OpenDesignIcon
 */

import * as React from 'react';

/**
 * Open Design 面板图标（原创画板 + 焦点圆 + 曲线，跟随宿主前景色）。
 */
export function OpenDesignIcon(): React.ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="1.5"
        y="1.5"
        width="13"
        height="13"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <circle cx="6.2" cy="6.4" r="1.8" fill="currentColor" />
      <path
        d="M4.5 11.5c2-2.2 5-2.6 7-1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
