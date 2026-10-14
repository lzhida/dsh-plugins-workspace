import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { apply, name } from './index.ts';

/** Capture what a mock webServer + registry expose to the plugin. */
function fakeCtx() {
  const routes: Array<{ kind: string; path: string }> = [];
  const tools: Array<{ name: string }> = [];
  const disposers: Array<() => void> = [];
  const ctx = {
    tools: {
      register: (tool: { name: string }) => {
        tools.push(tool);
        return () => undefined;
      },
    },
    webServer: {
      register: (route: { kind: string; path: string }) => {
        routes.push(route);
        return () => undefined;
      },
    },
    workspaceRegistry: {
      get: () => undefined,
      list: () => [],
      resolveByPath: async () => undefined,
    },
    effect: (fn: () => unknown, label?: string) => {
      void label;
      disposers.push(fn() as () => void);
    },
    inject: (names: string[], fn: (inner: Context) => (() => void) | void) => {
      expect(names).toEqual(['workspaceRegistry']);
      const cleanup = fn(ctx as unknown as Context);
      if (cleanup !== undefined) disposers.push(cleanup);
    },
  } as unknown as Context;
  return { ctx, routes, tools, disposers };
}

describe('dsh-open-in-zed host entry', () => {
  it('契约三符号：name 正确、无默认导出形态', () => {
    expect(name).toBe('dsh-open-in-zed');
  });

  it('apply 注册 1 个工具与 3 条路由，并可整体卸载', () => {
    const { ctx, routes, tools, disposers } = fakeCtx();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    apply(ctx);
    expect(log).toHaveBeenCalledWith(`[${name}] plugin loaded`);
    expect(tools.map((tool) => tool.name)).toEqual(['open_in_zed']);
    expect(routes.map((route) => route.path).sort()).toEqual(
      [
        '/dsh-open-in-zed/open',
        '/dsh-open-in-zed/status',
        '/dsh-open-in-zed/workspaces',
      ].sort(),
    );
    for (const dispose of disposers.splice(0)) dispose();
    log.mockRestore();
  });
});
