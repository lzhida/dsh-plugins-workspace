// @vitest-environment jsdom
/**
 * Client-half smoke: apply() against a fake client context — proves the two
 * slot registrations happen, degrade silently without the slot system, and
 * that the header button renders from a session cwd and POSTs the open
 * route on click.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { apply } from './index.tsx';
import {
  makeHeaderButton,
  makeMenuItem,
  type MenuOccupantProps,
} from './entries.tsx';

/** Poll until the probe passes (React 19 render is concurrent). */
async function waitFor(probe: () => boolean): Promise<void> {
  for (let round = 0; round < 100; round++) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor: condition never became true');
}

describe('dsh-open-in-zed client half', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    document.documentElement.lang = '';
  });

  it('无 slots 服务时静默降级不抛错', () => {
    const ctx = { get: () => undefined, effect: () => undefined };
    expect(() => apply(ctx)).not.toThrow();
  });

  it('apply 注册两个 slot 入口并可整体卸载', () => {
    const injected: string[] = [];
    const registered: Array<Record<string, unknown>> = [];
    const disposers: Array<() => void> = [];
    const slots = {
      inject: (key: string, callback: () => unknown) => {
        injected.push(key);
        disposers.push(callback() as () => void);
        return () => undefined;
      },
      register: (options: Record<string, unknown>) => {
        registered.push(options);
        return () => undefined;
      },
    };
    const effectDisposers: Array<() => void> = [];
    const ctx = {
      get: (key: string) => (key === 'slots' ? slots : undefined),
      effect: (fn: () => unknown) => {
        effectDisposers.push(fn() as () => void);
      },
    };
    apply(ctx);
    expect(injected).toEqual([
      'conversation.session.header.utilities',
      'sidebar.workspaces.session.menu.item',
    ]);
    expect(registered.map((row) => row.id)).toEqual([
      'dsh-open-in-zed',
      'dsh-open-in-zed',
    ]);
    expect(registered.map((row) => row.order)).toEqual([-9, 500]);
    for (const dispose of effectDisposers.splice(0)) dispose();
  });

  it('header 按钮渲染 cwd 并在点击时 POST /open', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('/dsh-open-in-zed/open');
      expect(init?.method).toBe('POST');
      return new Response(
        JSON.stringify({
          ok: true,
          value: {
            workspace: { id: 'ws-1', title: 'a' },
            path: 'C:\\w',
            command: ['zed', 'C:\\w'],
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('alert', vi.fn());

    const Button = makeHeaderButton(() => 'C:\\fallback');
    const container = document.createElement('div');
    document.body.append(container);
    const root: Root = createRoot(container);
    root.render(
      React.createElement(Button, {
        sessionId: 's1',
        useSessions: (
          selector: (state: {
            byId: Record<string, { cwd?: string }>;
          }) => unknown,
        ) => selector({ byId: { s1: { cwd: 'C:\\work\\alpha' } } }),
      }),
    );
    await waitFor(() => container.querySelector('.dsh-zed-open-btn') !== null);
    (container.querySelector('.dsh-zed-open-btn') as HTMLButtonElement).click();
    await waitFor(() => fetchMock.mock.calls.length > 0);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      path: 'C:\\work\\alpha',
    });
    root.unmount();
  });

  it('无 cwd 时 header 按钮不渲染', async () => {
    const Button = makeHeaderButton(() => undefined);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    root.render(
      React.createElement(Button, {
        sessionId: 's1',
        useSessions: () => undefined,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(container.querySelector('.dsh-zed-open-btn')).toBeNull();
    root.unmount();
  });

  it('菜单项点击关闭菜单并 POST cwd', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('/dsh-open-in-zed/open');
      expect(init?.method).toBe('POST');
      return new Response(
        JSON.stringify({
          ok: true,
          value: {
            workspace: { id: 'ws-1', title: 'a' },
            path: '/w',
            command: ['zed', '/w'],
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('alert', vi.fn());

    const Item = makeMenuItem((sessionId) =>
      sessionId === 's9' ? '/home/u/beta' : undefined,
    );
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let closed = false;
    const props: MenuOccupantProps = {
      sessionId: 's9',
      useMenuOpenState: () => [
        true,
        (open: boolean) => {
          closed = open;
        },
      ],
    };
    root.render(React.createElement(Item, props));
    await waitFor(() => container.querySelector('[role="menuitem"]') !== null);
    (container.querySelector('[role="menuitem"]') as HTMLButtonElement).click();
    await waitFor(() => fetchMock.mock.calls.length > 0);
    expect(closed).toBe(false);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      path: '/home/u/beta',
    });
    root.unmount();
  });

  it('打开失败时 alert 宿主消息（含 zed-not-found 指引）', async () => {
    const alertMock = vi.fn();
    vi.stubGlobal('alert', alertMock);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: {
                code: 'zed-not-found',
                message: '未找到 Zed 可执行文件',
              },
            }),
            { status: 500 },
          ),
      ),
    );
    const Button = makeHeaderButton(() => 'C:\\work\\alpha');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    root.render(
      React.createElement(Button, {
        sessionId: 's1',
        useSessions: () => undefined, // 走 fallback 闭包 cwd
      }),
    );
    await waitFor(() => container.querySelector('.dsh-zed-open-btn') !== null);
    (container.querySelector('.dsh-zed-open-btn') as HTMLButtonElement).click();
    await waitFor(() => alertMock.mock.calls.length > 0);
    expect(String(alertMock.mock.calls[0][0])).toContain('zed-not-found');
    root.unmount();
  });
});
