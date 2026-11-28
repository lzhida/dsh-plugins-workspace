/**
 * className 合成（clsx + tailwind-merge，与 llm-fallback 同款）。
 *
 * @module dsh-decision/client/lib/cn
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 合成 class 名（后写优先）。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
