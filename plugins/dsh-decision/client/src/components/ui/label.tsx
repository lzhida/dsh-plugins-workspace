/**
 * 表单 label（原生 label + dsh token；替换 shadcn Radix Label——本卡无
 * 组合控件需求，原生 label 的 for 关联即满足可达性）。
 *
 * @module dsh-decision/client/components/ui/label
 */

import * as React from 'react';

import { cn } from '../../lib/cn.ts';

/** 表单标签。 */
export function Label({
  className,
  ...props
}: React.ComponentProps<'label'>): React.ReactElement {
  return (
    <label
      className={cn(
        'text-[13px] font-medium leading-4 text-foreground',
        className,
      )}
      {...props}
    />
  );
}
