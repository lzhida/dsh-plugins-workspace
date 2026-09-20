import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { apply, greet, name } from './index';

function stubCtx() {
  const cleanups: Array<() => void> = [];
  const ctx = {
    // cordis 语义：effect 任务立即执行，返回的清理函数在插件卸载时调用
    effect: (fn: () => (() => void) | void) => {
      const cleanup = fn();
      if (cleanup) cleanups.push(cleanup);
    },
  } as unknown as Context;
  return { ctx, cleanups };
}

describe('hello-plugin', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('导出插件名（loader 依赖的契约）', () => {
    expect(name).toBe('hello-plugin');
  });

  it('greet 返回问候语', () => {
    expect(greet('dsh')).toBe('hello, dsh!');
  });

  it('apply 注册心跳 effect，卸载时清理定时器', () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { ctx, cleanups } = stubCtx();

    apply(ctx);
    expect(cleanups).toHaveLength(1);

    const cleanup = cleanups[0];
    vi.advanceTimersByTime(10_000);
    expect(log).toHaveBeenCalledTimes(2);

    cleanup();
    vi.advanceTimersByTime(10_000);
    expect(log).toHaveBeenCalledTimes(2);
  });
});
