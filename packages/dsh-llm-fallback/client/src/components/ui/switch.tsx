/**
 * shadcn/ui Switch（@radix-ui/react-switch 原语 + dsh token）：轨道未选
 * 用 border-l2、选中用 brand-primary，thumb 直接用宿主
 * --dsw-alias-switch-thumb token；焦点环与禁用态齐备。
 *
 * @module dsh-llm-fallback/client/components/ui/switch
 */

import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';

import { cn } from '../../lib/cn.ts';

/** shadcn/ui 开关。 */
export function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>): React.ReactElement {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border border-transparent',
        'transition-colors duration-150',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        'disabled:pointer-events-none disabled:opacity-50',
        'data-[state=unchecked]:bg-input data-[state=checked]:bg-primary',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block h-[14px] w-[14px] rounded-full',
          'bg-[var(--dsw-alias-switch-thumb)] shadow-sm',
          'transition-transform duration-150',
          'data-[state=unchecked]:translate-x-0 data-[state=checked]:translate-x-[7px]',
        )}
      />
    </SwitchPrimitive.Root>
  );
}
