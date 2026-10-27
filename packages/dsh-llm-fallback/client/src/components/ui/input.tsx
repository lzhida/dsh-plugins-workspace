/**
 * shadcn/ui Input（原生 input + dsh token）：透明底 + border-l2 边框 +
 * 品牌色 focus 环，placeholder 用次级文本。
 *
 * @module dsh-llm-fallback/client/components/ui/input
 */

import * as React from 'react';

import { cn } from '../../lib/cn.ts';

/** shadcn/ui 输入框（type 由调用方指定：search / number / text）。 */
export function Input({
  className,
  type = 'text',
  ...props
}: React.ComponentProps<'input'>): React.ReactElement {
  return (
    <input
      type={type}
      className={cn(
        'h-7 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground',
        'transition-colors duration-150 placeholder:text-muted-foreground',
        'focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring/50',
        'disabled:cursor-default disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
