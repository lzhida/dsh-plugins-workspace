/**
 * shadcn/ui Checkbox（@radix-ui/react-checkbox 原语 + dsh token）：选中态
 * 品牌色填充 + 白色对勾，focus 环与禁用态齐备。
 *
 * @module dsh-llm-fallback/client/components/ui/checkbox
 */

import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';

import { cn } from '../../lib/cn.ts';

/** shadcn/ui 勾选框。 */
export function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>): React.ReactElement {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'h-4 w-4 shrink-0 cursor-pointer rounded border border-input bg-transparent p-0',
        'transition-colors duration-150',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        'disabled:cursor-default disabled:opacity-50',
        'data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3 w-3"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
