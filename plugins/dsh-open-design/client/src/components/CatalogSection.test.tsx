/**
 * 目录浏览节（系列 5/6）组件测试：jsdom + 真实 createRoot 渲染。
 *
 * 覆盖：三 tab 切换、技能搜索渲染与行展开、加载更多（offset 追加）、
 * 「用于生成」回填回调、插件/agent 视图懒加载与错误降级。取数经
 * vi.stubGlobal('fetch') 按路径分发替身（duck-typed response）。
 *
 * @module dsh-open-design/client/components/CatalogSection.test
 */

// @vitest-environment jsdom
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { panelApi } from '../api.ts';
import { ROUTE_PREFIX } from '../constants.ts';
import { DICT } from '../dict.ts';
import type { TFn } from '../types.ts';
import {
  CATALOG_PAGE_SIZE,
  CATALOG_SEARCH_DEBOUNCE_MS,
  CatalogSection,
  type CatalogEntry,
} from './CatalogSection.tsx';

const en = DICT.en;
const t: TFn = (key: string, vars?: Record<string, unknown>) => {
  let text = en[key] ?? key;
  if (vars !== undefined) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
};

/** 三个固定技能 + 两个插件 + 一个 agent 的替身响应。 */
function routeFor(
  path: string,
): { ok: boolean; status: number; json: unknown } | null {
  const url = new URL(path, 'http://localhost');
  if (url.pathname === `${ROUTE_PREFIX}/skills`) {
    const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10);
    const all = [0, 1, 2, 3, 4].map((i) => ({
      id: `skill-${i}`,
      name: `技能 ${i}`,
      description: `描述文本 ${i}，`.repeat(3),
      triggers: [`trigger-${i}`],
    }));
    const items = all.slice(offset, offset + 3);
    return {
      ok: true,
      status: 200,
      json: {
        total: all.length,
        matched: all.length,
        returned: items.length,
        truncated: offset + items.length < all.length,
        nextOffset:
          offset + items.length < all.length ? offset + items.length : null,
        items,
      },
    };
  }
  if (url.pathname === `${ROUTE_PREFIX}/plugins`) {
    return {
      ok: true,
      status: 200,
      json: {
        total: 2,
        returned: 2,
        truncated: false,
        items: [
          { id: 'p1', name: 'motion-design' },
          { id: 'p2', name: 'brand-kit' },
        ],
      },
    };
  }
  if (url.pathname === `${ROUTE_PREFIX}/agents`) {
    return {
      ok: true,
      status: 200,
      json: { agents: [{ id: 'a1', name: 'Codex', version: '1.0' }] },
    };
  }
  return null;
}

function stubFetch(
  routes?: (
    path: string,
  ) => { ok: boolean; status: number; json: unknown } | null,
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input.toString();
      const hit = (routes ?? routeFor)(path);
      if (hit === null) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: 'no mock' }),
        };
      }
      return { ok: hit.ok, status: hit.status, json: async () => hit.json };
    }),
  );
}

async function waitFor(
  predicate: () => boolean,
  rounds = 300,
  intervalMs = 20,
): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor 超时');
}

describe('dsh-open-design 目录浏览节（系列 5/6）', () => {
  let root: Root;
  let uses: CatalogEntry[];
  let container: HTMLDivElement | null = null;

  const mount = async (): Promise<void> => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // 直接用 panelApi 默认实现（吃全局 fetch stub），与真实取数路径一致。
    root.render(
      React.createElement(CatalogSection, {
        t,
        api: panelApi,
        onUse: (entry: CatalogEntry) => {
          uses.push(entry);
        },
      }),
    );
    await waitFor(() => document.body.textContent?.includes('技能 0') ?? false);
  };

  beforeEach(() => {
    uses = [];
    stubFetch();
  });

  afterEach(() => {
    if (container !== null) {
      root.unmount();
      container.remove();
      container = null;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('默认技能视图渲染列表、匹配数与触发词', async () => {
    await mount();
    const text = document.body.textContent ?? '';
    expect(text).toContain('技能 0');
    expect(text).toContain('trigger-0');
    expect(text).toContain(`${en['catalog.matched']} 5`);
  });

  it('点击「用于生成」回调 skill id', async () => {
    await mount();
    const buttons = Array.from(document.querySelectorAll('button'));
    const use = buttons.find((b) => b.textContent === en['catalog.use']);
    expect(use).toBeDefined();
    use?.click();
    await waitFor(() => uses.length > 0);
    expect(uses[0]).toEqual({ skill: 'skill-0' });
  });

  it('「加载更多」按 offset 追加下一页', async () => {
    await mount();
    const more = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === en['catalog.loadMore'],
    );
    expect(more).toBeDefined();
    more?.click();
    await waitFor(
      () =>
        (document.body.textContent ?? '').includes('技能 3') &&
        (document.body.textContent ?? '').includes('技能 4'),
    );
    const text = document.body.textContent ?? '';
    expect(text).toContain(en['catalog.noMore']);
  });

  it('切换到插件视图懒加载并回调 plugin id', async () => {
    await mount();
    const tab = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === en['catalog.tabPlugins'],
    );
    tab?.click();
    await waitFor(() =>
      (document.body.textContent ?? '').includes('motion-design'),
    );
    const use = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === en['catalog.use'],
    );
    use?.click();
    await waitFor(() => uses.length > 0);
    expect(uses[0]).toEqual({ plugin: 'p1' });
  });

  it('切换到 agent 视图懒加载并回调 agent id', async () => {
    await mount();
    const tab = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === en['catalog.tabAgents'],
    );
    tab?.click();
    await waitFor(() => (document.body.textContent ?? '').includes('Codex'));
    const use = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === en['catalog.use'],
    );
    use?.click();
    await waitFor(() => uses.length > 0);
    expect(uses[0]).toEqual({ agent: 'a1' });
  });

  it('技能端点失败时降级为可读错误', async () => {
    vi.unstubAllGlobals();
    stubFetch(() => null);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(
      React.createElement(CatalogSection, {
        t,
        api: panelApi,
        onUse: (entry: CatalogEntry) => {
          uses.push(entry);
        },
      }),
    );
    await waitFor(() =>
      (document.body.textContent ?? '').includes(en['catalog.loadFailed']),
    );
    expect(document.body.textContent).toContain('no mock');
  });

  it('文件头常量：分页大小不超服务端硬上限', () => {
    expect(CATALOG_PAGE_SIZE).toBeLessThanOrEqual(200);
    expect(CATALOG_SEARCH_DEBOUNCE_MS).toBeGreaterThan(0);
  });
});
