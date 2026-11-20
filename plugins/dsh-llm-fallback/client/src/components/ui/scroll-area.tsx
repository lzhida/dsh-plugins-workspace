/**
 * shadcn/ui ScrollArea（@radix-ui/react-scroll-area 原语 + dsh token）：
 * 限高容器 + 自绘垂直滚动条（宿主 scrollbar token），模型目录再多也不撑
 * 长外层滚动条。
 *
 * @module dsh-llm-fallback/client/components/ui/scroll-area
 */

import * as React from 'react';
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';

import { cn } from '../../lib/cn.ts';

/** 垂直滚动条（thumb 用宿主 scrollbar-bg-l2 / hover-l2 token）。 */
function VerticalScrollbar(): React.ReactElement {
  return (
    <ScrollAreaPrimitive.Scrollbar
      orientation="vertical"
      className="flex w-2 touch-none select-none border-l border-l-transparent p-0.5 transition-colors"
    >
      <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-[var(--dsw-alias-scrollbar-bg-l2)] hover:bg-[var(--dsw-alias-scrollbar-hover-l2)]" />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

/** shadcn/ui 滚动区（maxHeight 等限高样式由调用方 className 给出）。 */
export function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root>): React.ReactElement {
  return (
    <ScrollAreaPrimitive.Root
      className={cn(
        'relative overflow-hidden rounded-lg border border-border bg-surface',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport className="size-full rounded-[inherit] outline-none">
        {children}
      </ScrollAreaPrimitive.Viewport>
      <VerticalScrollbar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}
