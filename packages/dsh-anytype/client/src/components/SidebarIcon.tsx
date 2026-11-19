/**
 * 侧栏图标（`sidebar.panellist` 插槽）：宿主侧栏行自带按钮、标题与选中态，
 * 本组件**只渲染 glyph**（宿主把渲染结果放进 16/18px 的图标槽）。
 *
 * 为什么不自己包按钮：宿主侧栏行本身就是 `<button>`（aria-label 取注册时的
 * label，点击即 selectPanel），再包一层按钮会得到嵌套 button（无效 HTML），
 * 点击也会重复触发。
 *
 * 为什么只画图标不画文字：宿主行已用 label 显示标题，再画一遍文案会出现
 * 重复的「Anytype」条目。
 *
 * @module dsh-anytype/client/components/SidebarIcon
 */

import * as React from 'react';

/** 宿主插槽 owner props（尺寸与选中态由宿主给定）。 */
export interface SidebarIconProps {
  /** 宿主请求的图标边长（像素）。 */
  size?: number;
  /** 是否为当前选中面板（宿主自行渲染选中态，图标只消费尺寸）。 */
  active?: boolean;
}

/**
 * Anytype 侧栏图标（纯 glyph）。
 *
 * @param props - 宿主 owner props。
 */
export function SidebarIcon(props: SidebarIconProps): React.ReactElement {
  const size =
    typeof props.size === 'number' &&
    Number.isFinite(props.size) &&
    props.size > 0
      ? props.size
      : 18;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M1.9 4.3a1.4 1.4 0 0 1 1.4-1.4h2.6l1.2 1.5h5.6a1.4 1.4 0 0 1 1.4 1.4v5.5a1.4 1.4 0 0 1-1.4 1.4H3.3a1.4 1.4 0 0 1-1.4-1.4z" />
    </svg>
  );
}
