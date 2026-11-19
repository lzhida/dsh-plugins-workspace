/**
 * 面板只读路由单测：连接状态 / 空间 / 最近笔记 / 待审队列的采集形状，
 * apiKey 不回显的硬约束，以及 prefix 内分发与 404 行为。
 */
import { describe, expect, it } from 'vitest';

import type { AnytypeClient } from '../core/index.ts';
import type { WikiStore } from '../wiki/store.ts';
import {
  buildPanelQueue,
  buildPanelStatus,
  createPanelHandler,
  PANEL_ROUTE_PREFIX,
  type PanelDeps,
} from './routes.ts';

/** 假客户端：探测结果可编排。 */
function fakeClient(
  probe: {
    configured?: boolean;
    reachable?: boolean;
    authenticated?: boolean;
    error?: string;
  } = {},
): AnytypeClient {
  return {
    probeDesktop: async () => ({
      configured: probe.configured ?? true,
      reachable: probe.reachable ?? true,
      authenticated: probe.authenticated ?? true,
      error: probe.error,
    }),
  } as unknown as AnytypeClient;
}

/** 假存储：空间列表 / 属性键 / 搜索结果可编排。 */
function fakeStore(
  options: {
    spaces?: Array<{ id: string; name: string }>;
    rows?: Array<{
      id: string;
      name: string;
      properties?: Record<string, unknown>;
    }>;
    total?: number;
    hasMore?: boolean;
    failSpaces?: boolean;
    failSearch?: boolean;
    keys?: Record<string, string>;
  } = {},
): { store: WikiStore; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const store = {
    listSpaces: async () => {
      if (options.failSpaces === true) throw new Error('spaces down');
      return options.spaces ?? [{ id: 's1', name: 'Space One' }];
    },
    resolveKeys: async () => options.keys ?? { wiki_status: 'st' },
    search: async (params: Record<string, unknown>) => {
      calls.push(params);
      if (options.failSearch === true) throw new Error('search down');
      return {
        rows: options.rows ?? [],
        total: options.total,
        hasMore: options.hasMore,
      };
    },
  } as unknown as WikiStore;
  return { store, calls };
}

/** 组装面板依赖。 */
function deps(
  client: AnytypeClient,
  store: WikiStore,
  overrides: Partial<PanelDeps> = {},
): PanelDeps {
  return {
    client,
    store,
    baseUrl: () => 'http://127.0.0.1:31009',
    apiKeyConfigured: () => true,
    ...overrides,
  };
}

/** 假 req/res（只实现 handler 用到的面）。 */
function fakeRes(): {
  res: import('node:http').ServerResponse;
  status: () => number;
  body: () => string;
  headers: () => Record<string, unknown>;
} {
  const state = { code: 0, body: '', headers: {} as Record<string, unknown> };
  const res = {
    writeHead(code: number, headers: Record<string, unknown>) {
      state.code = code;
      state.headers = headers;
      return res;
    },
    end(chunk?: string) {
      state.body = chunk ?? '';
      return res;
    },
  } as unknown as import('node:http').ServerResponse;
  return {
    res,
    status: () => state.code,
    body: () => state.body,
    headers: () => state.headers,
  };
}

/** 发一次请求（默认只读 GET；可传 method 验证非 GET 被拒）。 */
async function call(
  handler: ReturnType<typeof createPanelHandler>,
  url: string,
  method = 'GET',
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  const sink = fakeRes();
  await handler(
    {
      url,
      method,
      headers: {},
    } as unknown as import('node:http').IncomingMessage,
    sink.res,
  );
  return { status: sink.status(), body: sink.body(), headers: sink.headers() };
}

describe('面板只读路由', () => {
  it('status 载荷含连接状态、空间列表与最近笔记', async () => {
    const { store } = fakeStore({
      spaces: [{ id: 's1', name: 'Space One' }],
      rows: [
        {
          id: 'o1',
          name: '笔记一',
          properties: {
            st: 'draft',
            wiki_source: '源码',
            wiki_updated_at: '2026-01-01',
          },
        },
      ],
    });
    const status = await buildPanelStatus(deps(fakeClient(), store));
    expect(status.connection.authenticated).toBe(true);
    expect(status.connection.baseUrl).toBe('http://127.0.0.1:31009');
    expect(status.spaces).toEqual([{ id: 's1', name: 'Space One' }]);
    expect(status.recentNotes).toHaveLength(1);
    expect(status.recentNotes[0]).toMatchObject({
      id: 'o1',
      name: '笔记一',
      status: 'draft',
    });
    expect(status.checkedAt.length).toBeGreaterThan(10);
  });

  it('apiKey 只报布尔，载荷里不出现密钥值', async () => {
    const { store } = fakeStore();
    const panelDeps = deps(fakeClient(), store, {
      apiKeyConfigured: () => true,
      baseUrl: () => 'http://127.0.0.1:31009',
    });
    // 依赖面只有布尔开关，没有明文密钥字段。
    expect(Object.keys(panelDeps)).not.toContain('apiKey');
    const status = await buildPanelStatus(panelDeps);
    expect(status.connection.apiKeyConfigured).toBe(true);
    // 载荷里与密钥相关的字段只有布尔量，没有值字段。
    expect(
      Object.keys(status.connection).filter((key) =>
        key.toLowerCase().includes('apikey'),
      ),
    ).toEqual(['apiKeyConfigured']);
    expect(JSON.stringify(status)).not.toContain('secret-token');
  });

  it('非 GET 请求一律 405，面板端点只读', async () => {
    const { store } = fakeStore();
    const handler = createPanelHandler(deps(fakeClient(), store));
    const post = await call(handler, `${PANEL_ROUTE_PREFIX}/status`, 'POST');
    expect(post.status).toBe(405);
    expect(post.body).toContain('METHOD_NOT_ALLOWED');
  });

  it('queue 只取 draft 待审并按更新时间倒序', async () => {
    const { store, calls } = fakeStore({
      rows: [{ id: 'o2', name: '待审笔记' }],
      total: 1,
    });
    const queue = await buildPanelQueue(deps(fakeClient(), store));
    expect(queue.spaceId).toBe('s1');
    expect(queue.pending).toHaveLength(1);
    expect(queue.total).toBe(1);
    const params = calls[0] as { filter?: string; sorts?: unknown };
    expect(params.filter).toContain('IN ("draft")');
    expect(Array.isArray(params.sorts)).toBe(true);
  });

  it('上游不可用时降级为空并带提示，不抛错', async () => {
    const { store } = fakeStore({ failSpaces: true, failSearch: true });
    const status = await buildPanelStatus(deps(fakeClient(), store));
    expect(status.spaces).toEqual([]);
    expect(status.warning).toContain('spaces unavailable');
    const queue = await buildPanelQueue(deps(fakeClient(), store));
    expect(queue.pending).toEqual([]);
    expect(queue.warning).toContain('spaces unavailable');
  });

  it('handler 在 prefix 内分发 status/queue，未知路径回 404 信封', async () => {
    const { store } = fakeStore();
    const handler = createPanelHandler(deps(fakeClient(), store));
    const ok = await call(handler, `${PANEL_ROUTE_PREFIX}/status`);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(ok.body).ok).toBe(true);
    const queue = await call(handler, `${PANEL_ROUTE_PREFIX}/queue`);
    expect(JSON.parse(queue.body).ok).toBe(true);
    const missing = await call(handler, `${PANEL_ROUTE_PREFIX}/nope`);
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body).error.code).toBe('NOT_FOUND');
  });

  it('handler 支持 space 查询参数指定空间', async () => {
    const { store, calls } = fakeStore();
    const handler = createPanelHandler(deps(fakeClient(), store));
    await call(handler, `${PANEL_ROUTE_PREFIX}/queue?space=space-9`);
    const params = calls[0] as { spaceId?: string };
    expect(params.spaceId).toBe('space-9');
  });
});
