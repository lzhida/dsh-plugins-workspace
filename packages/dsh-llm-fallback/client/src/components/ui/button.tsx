/**
 * shadcn/ui Button（shadcn 官方组件的 dsh token 裁剪版）：CVA variants
 * + Radix Slot 省略（本卡无 asChild 用法，少带一个依赖）。
 *
 * 颜色全部走 theme.css 映射的宿主 --dsw-alias-* 语义 token：default 用
 * brand-primary 填充 + button-primary-hover 悬停态；outline/ghost 透明底
 * + interactive-bg-hover 悬停态；交互态（hover/focus-visible/disabled）
 * 齐备。
 *
 * @module dsh-llm-fallback/client/components/ui/button
 */

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/cn.ts';

const buttonVariants = cva(
  [
    'inline-flex cursor-pointer select-none items-center justify-center gap-1.5',
    'whitespace-nowrap rounded-md text-[13px] font-medium leading-none',
    'transition-colors duration-150',
    'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
    'disabled:pointer-events-none disabled:opacity-50',
  ].join(' '),
  {
    variants: {
      variant: {
        default:
          'border border-transparent bg-primary text-primary-foreground hover:bg-primary-hover',
        outline:
          'border border-border-strong bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground',
        ghost:
          'border border-transparent bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground',
      },
      size: {
        default: 'h-8 px-3.5 py-1.5',
        sm: 'h-6 px-2 text-xs',
        icon: 'h-6 w-6 p-0 text-xs',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

/** Button props（variants + 原生 button 属性）。 */
export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

/** shadcn/ui 按钮（默认 type="button"，防嵌表单误提交）。 */
export function Button({
  className,
  variant,
  size,
  type = 'button',
  ...props
}: ButtonProps): React.ReactElement {
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
