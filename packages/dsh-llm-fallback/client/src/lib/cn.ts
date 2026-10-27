/**
 * shadcn/ui 约定的类名合成工具：条件类名拼接 + Tailwind 冲突消解。
 *
 * @module dsh-llm-fallback/client/lib/cn
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 合并条件类名并消解 Tailwind 类冲突（后者覆盖前者）。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
