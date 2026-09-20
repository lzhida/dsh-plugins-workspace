import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { apply, greet, name } from './index';

function stubCtx() {
  const cleanups: Array<() => void> = [];
  const register = vi.fn();
  const ctx = {
    // cordis 语义：effect 任务立即执行，返回的清理函数在插件卸载时调用
    effect: (fn: () => (() => void) | void) => {
      const cleanup = fn();
      if (cleanup) cleanups.push(cleanup);
    },
    tools: { register },
  } as unknown as Context;
  return { ctx, cleanups, register };
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

  it('apply 注册 hello-greet 工具且工具行为正确', async () => {
    const { ctx, register } = stubCtx();

    apply(ctx);
    expect(register).toHaveBeenCalledTimes(1);

    const tool = register.mock.calls[0][0] as {
      name: string;
      execute: (args: { who?: string }) => Promise<string>;
    };
    expect(tool.name).toBe('hello-greet');
    await expect(tool.execute({ who: 'zed' })).resolves.toBe('hello, zed!');
    await expect(tool.execute({ who: 'dsh' })).resolves.toBe('hello, dsh!');
  });

  it('apply 注册心跳 effect，卸载时清理定时器', () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { ctx, cleanups } = stubCtx();

    apply(ctx);
    expect(cleanups).toHaveLength(1);
    expect(log).toHaveBeenCalledWith('[hello-plugin] plugin loaded');

    const cleanup = cleanups[0];
    vi.advanceTimersByTime(10_000);
    expect(log).toHaveBeenCalledTimes(3);

    cleanup();
    vi.advanceTimersByTime(10_000);
    expect(log).toHaveBeenCalledTimes(3);
  });
});
