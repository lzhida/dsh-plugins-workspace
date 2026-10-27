/**
 * shadcn/ui Badge（CVA variants + dsh token）：outline 变体 = border-l1
 * 边框 + 次级文本，solid 变体 = 品牌色填充。
 *
 * @module dsh-llm-fallback/client/components/ui/badge
 */

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/cn.ts';

const badgeVariants = cva(
  'inline-flex items-center whitespace-nowrap rounded-full border px-1.5 text-[11px] font-normal leading-4',
  {
    variants: {
      variant: {
        outline: 'border-border text-muted-foreground',
        solid: 'border-transparent bg-primary text-primary-foreground',
      },
    },
    defaultVariants: { variant: 'outline' },
  },
);

/** Badge props（variants + 原生 span 属性）。 */
export type BadgeProps = React.ComponentProps<'span'> &
  VariantProps<typeof badgeVariants>;

/** shadcn/ui 徽标。 */
export function Badge({
  className,
  variant,
  ...props
}: BadgeProps): React.ReactElement {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
