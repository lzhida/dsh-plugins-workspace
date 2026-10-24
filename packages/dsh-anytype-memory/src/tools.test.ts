/**
 * tools/* 行为测试：用捕获式 fetch 假体断言「意图 → HTTP 请求」的映射，
 * 以及记忆工具的关键契约（幂等、draft 态、冲突上报、召回不泄露向量）。
 */

import { AnytypeClient } from '@lzhida/dsh-anytype-core';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { describe, expect, it } from 'vitest';

import { resolveConfig } from './config.ts';
import { MemoryStore } from './store.ts';
import { buildGroupedTools } from './tools/index.ts';
import type { MemoryToolDeps } from './tools/shared.ts';

interface CapturedCall {
  url: string;
  method: string;
  body: unknown;
}

/** 路由式 fetch 假体：按「方法 + 路径片段」返回可编程响应。 */
function fakeFetch(
  routes: Array<{
    match: (url: string, method: string) => boolean;
    status?: number;
    body: unknown | ((parsed: unknown) => unknown);
  }>,
): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const parsed = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      body: parsed,
    });
    const route = routes.find((r) =>
      r.match(String(url), init.method ?? 'GET'),
    );
    const status = route?.status ?? 200;
    const body =
      typeof route?.body === 'function' ? route.body(parsed) : route?.body;
    return new Response(JSON.stringify(body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** 组装带假体 fetch 的工具依赖。 */
function makeDeps(routes: Parameters<typeof fakeFetch>[0]): {
  deps: MemoryToolDeps;
  calls: CapturedCall[];
} {
  const { fetchImpl, calls } = fakeFetch(routes);
  const deps: MemoryToolDeps = {
    store: new MemoryStore(
      new AnytypeClient(
        () => ({
          baseUrl: 'http://127.0.0.1:31009',
          apiKey: 'test-key',
          apiVersion: '2025-11-08',
          timeoutMs: 5000,
        }),
        fetchImpl,
      ),
    ),
    config: () => resolveConfig({ spaceId: '64xiwe' }),
  };
  return { deps, calls };
}

/** 最小执行上下文（工具层只用取消信号）。 */
const exec = {
  signal: new AbortController().signal,
} as unknown as ToolRunContext;

/** 按名字取工具。 */
function pick(
  deps: MemoryToolDeps,
  group: string,
  name: string,
): ToolDefinition {
  const tools = buildGroupedTools(deps).get(group as never) ?? [];
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool not found: ${name}`);
  return found;
}

/** 读工具参数。 */
async function run(
  deps: MemoryToolDeps,
  group: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = pick(deps, group, name);
  return tool.execute(args, exec);
}

describe('dsh-anytype-memory tools', () => {
  it('注册 16 个工具，组分布为 setup1/write6/read5/agent3/diag1', () => {
    const { deps } = makeDeps([]);
    const grouped = buildGroupedTools(deps);
    const counts = new Map<string, number>();
    let total = 0;
    for (const [group, tools] of grouped) {
      counts.set(group, tools.length);
      total += tools.length;
    }
    expect(total).toBe(16);
    expect(counts.get('setup')).toBe(1);
    expect(counts.get('write')).toBe(6);
    expect(counts.get('read')).toBe(5);
    expect(counts.get('agent')).toBe(3);
    expect(counts.get('diag')).toBe(1);
  });

  it('工具名唯一且全部以 memory_ 前缀', () => {
    const { deps } = makeDeps([]);
    const names: string[] = [];
    for (const tools of buildGroupedTools(deps).values()) {
      for (const tool of tools) names.push(tool.name);
    }
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.startsWith('memory_'))).toBe(true);
  });

  it('memory_setup 幂等：已存在时只读不建', async () => {
    const { deps, calls } = makeDeps([
      {
        match: (url) => url.includes('/types'),
        body: {
          data: [
            { key: 'memory', name: 'Memory', properties: [{ key: 'kind' }] },
            { key: 'memory_scope', name: 'Memory scope', properties: [] },
          ],
        },
      },
      {
        match: (url) => url.includes('/properties'),
        body: { data: [{ key: 'kind', name: 'Kind', format: 'select' }] },
      },
    ]);
    const result = (await run(deps, 'setup', 'memory_setup', {})) as {
      space_id: string;
      created: string[];
    };
    expect(result.space_id).toBe('64xiwe');
    expect(result.created.length).toBeGreaterThan(0); // 补挂缺失属性
    expect(
      calls.some((c) => c.method === 'POST' && c.url.includes('/types')),
    ).toBe(false); // 类型已存在 → 不重建
  });

  it('memory_write 命中 content_hash 时不创建对象', async () => {
    // 假体回显「请求 filter 里带的哈希」——这样才能真正验证幂等路径。
    const { deps, calls } = makeDeps([
      {
        match: (url, method) => method === 'POST' && url.includes('/search'),
        body: (parsed: unknown) => {
          const filter = String((parsed as { filter?: string })?.filter ?? '');
          const match = filter.match(
            /memory_content_hash IN \("([0-9a-f]{64})"\)/,
          );
          return {
            data: match
              ? [
                  {
                    id: 'existing-1',
                    name: '已有记忆',
                    type: 'memory',
                    properties: { memory_content_hash: match[1] },
                  },
                ]
              : [],
          };
        },
      },
    ]);
    const result = (await run(deps, 'write', 'memory_write', {
      memories: [{ kind: 'fact', content: '用户偏好使用 pnpm' }],
    })) as { written: unknown[]; deduped: Array<{ object_id: string }> };
    expect(result.written).toHaveLength(0);
    expect(result.deduped).toHaveLength(1);
    expect(result.deduped[0].object_id).toBe('existing-1');
    expect(
      calls.some((c) => c.method === 'POST' && c.url.includes('/objects')),
    ).toBe(false);
  });

  it('memory_write 新建时落 draft 态与 content_hash，并上报冲突候选', async () => {
    const { deps, calls } = makeDeps([
      {
        match: (url, method) => method === 'POST' && url.includes('/search'),
        body: {
          data: [
            {
              id: 'near-1',
              name: '相似的旧记忆',
              type: 'memory',
              properties: {
                memory_kind: ['fact'],
                memory_status: ['approved'],
              },
            },
          ],
        },
      },
      {
        match: (url, method) => method === 'POST' && url.includes('/objects'),
        status: 201,
        body: { id: 'new-1' },
      },
    ]);
    const result = (await run(deps, 'write', 'memory_write', {
      memories: [{ kind: 'fact', content: '用户偏好使用 pnpm 管理依赖' }],
    })) as {
      written: Array<{ object_id: string; status: string }>;
      conflicts: Array<{ object_id: string }>;
    };
    expect(result.written).toHaveLength(1);
    expect(result.written[0].object_id).toBe('new-1');
    expect(result.written[0].status).toBe('draft');
    expect(result.conflicts.map((c) => c.object_id)).toContain('near-1');

    const create = calls.find(
      (c) => c.method === 'POST' && c.url.includes('/objects'),
    );
    const body = create?.body as {
      type: string;
      properties: Record<string, unknown>;
    };
    expect(body.type).toBe('memory');
    expect(body.properties.memory_kind).toEqual(['fact']);
    expect(body.properties.memory_status).toEqual(['draft']);
    expect(String(body.properties.memory_content_hash)).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('memory_write 拒绝未知 kind', async () => {
    const { deps } = makeDeps([]);
    await expect(
      run(deps, 'write', 'memory_write', {
        memories: [{ kind: 'bogus', content: 'x' }],
      }),
    ).rejects.toThrow(/not a known memory kind/);
  });

  it('memory_recall 融合词法臂并返回可引用字段，且不含向量原文', async () => {
    const { deps } = makeDeps([
      {
        match: (url, method) => method === 'POST' && url.includes('/search'),
        body: {
          data: [
            {
              id: 'm-1',
              name: '记忆一',
              type: 'memory',
              properties: {
                kind: ['fact'],
                status: ['approved'],
                origin: ['agent'],
                confidence: [8],
                created_at: ['2026-10-20T00:00:00Z'],
                embedding: ['YmFzZTY0'],
              },
            },
          ],
        },
      },
    ]);
    const result = (await run(deps, 'read', 'memory_recall', {
      query: '记忆',
    })) as {
      items: Array<Record<string, unknown>>;
      truncated: boolean;
    };
    expect(result.items).toHaveLength(1);
    expect(result.items[0].object_id).toBe('m-1');
    expect(result.items[0].arms_hit).toContain('lexical');
    expect(typeof result.items[0].score).toBe('number');
    expect(result.items[0].content_hash).toBeNull();
    expect(JSON.stringify(result)).not.toContain('YmFzZTY0');
  });

  it('memory_recall 默认排除 superseded 与 archived', async () => {
    const { deps } = makeDeps([
      {
        match: (url, method) => method === 'POST' && url.includes('/search'),
        body: {
          data: [
            {
              id: 'm-old',
              name: '旧记忆',
              type: 'memory',
              properties: {
                memory_kind: ['fact'],
                memory_status: ['superseded'],
              },
            },
            {
              id: 'm-new',
              name: '新记忆',
              type: 'memory',
              properties: {
                memory_kind: ['fact'],
                memory_status: ['approved'],
              },
            },
          ],
        },
      },
    ]);
    const result = (await run(deps, 'read', 'memory_recall', {
      query: '记忆',
    })) as { items: Array<{ object_id: string }> };
    expect(result.items.map((i) => i.object_id)).toEqual(['m-new']);
  });

  it('memory_link 拒绝把边连到非记忆对象', async () => {
    const { deps } = makeDeps([
      {
        match: (url, method) => method === 'GET' && url.includes('/objects/'),
        body: { id: 'p-1', name: '普通页面', type: 'page' },
      },
    ]);
    await expect(
      run(deps, 'write', 'memory_link', {
        from_id: 'm-1',
        to_id: 'p-1',
        rel: 'relates_to',
      }),
    ).rejects.toThrow(/not "memory"/);
  });

  it('memory_link 拒绝不在受控词表里的边（参数 schema 先拦）', async () => {
    const { deps } = makeDeps([]);
    await expect(
      run(deps, 'write', 'memory_link', {
        from_id: 'm-1',
        to_id: 'm-2',
        rel: 'friend_of',
      }),
    ).rejects.toThrow(/must be one of/);
  });

  it('memory_supersede 拒绝作废人类写的记忆', async () => {
    const { deps } = makeDeps([
      {
        match: (url, method) => method === 'GET' && url.includes('/objects/'),
        body: {
          id: 'm-old',
          name: '人写的记忆',
          type: 'memory',
          properties: { memory_origin: ['user'] },
        },
      },
    ]);
    await expect(
      run(deps, 'write', 'memory_supersede', {
        old_id: 'm-old',
        new_id: 'm-new',
      }),
    ).rejects.toThrow(/origin=user/);
  });

  it('memory_supersede 用一次原子 op 同时写 valid_to 与 status（两次写会撞 etag）', async () => {
    const { deps, calls } = makeDeps([
      {
        match: (url, method) => method === 'GET' && url.includes('/objects/'),
        body: {
          id: 'm-old',
          name: '旧记忆',
          type: 'memory',
          properties: { memory_origin: ['agent'] },
        },
      },
      {
        match: (url, method) => method === 'PATCH' && url.includes('/objects/'),
        body: { etag: 'e1' },
      },
    ]);
    await run(deps, 'write', 'memory_supersede', {
      old_id: 'm-old',
      new_id: 'm-new',
    });
    const patches = calls.filter(
      (c) => c.method === 'PATCH' && c.url.includes('/objects/m-old'),
    );
    // 旧条只被写一次：valid_to 与 status 必须合并进同一个 set_properties op，
    // 否则第二次写会因 etag 已过期而 409（活体实测）。
    expect(patches).toHaveLength(1);
    const ops = (
      patches[0].body as { ops: Array<{ set: Record<string, unknown> }> }
    ).ops;
    expect(ops).toHaveLength(1);
    expect(ops[0].set).toHaveProperty('memory_valid_to');
    expect(ops[0].set).toHaveProperty('memory_status');
  });

  it('memory_set_embedding 拒绝混用不同模型的向量空间', async () => {
    const { deps } = makeDeps([
      {
        match: (url, method) => method === 'GET' && url.includes('/objects/'),
        body: {
          id: 'm-1',
          name: '记忆',
          type: 'memory',
          properties: {
            memory_embedding_model: ['bge-m3'],
            memory_embedding_dim: [4],
          },
        },
      },
    ]);
    await expect(
      run(deps, 'agent', 'memory_set_embedding', {
        object_id: 'm-1',
        vector: [0.1, 0.2, 0.3, 0.4],
        embedding_model: 'other-model',
      }),
    ).rejects.toThrow(/refusing to mix vector spaces/);
  });

  it('memory_set_embedding 要求给出模型标识', async () => {
    const { deps } = makeDeps([]);
    await expect(
      run(deps, 'agent', 'memory_set_embedding', {
        object_id: 'm-1',
        vector: [0.1],
      }),
    ).rejects.toThrow(/embedding_model is required/);
  });

  it('全部请求只打向 127.0.0.1（插件不出网）', async () => {
    const { deps, calls } = makeDeps([
      {
        match: (url, method) => method === 'POST' && url.includes('/search'),
        body: { data: [] },
      },
    ]);
    await run(deps, 'read', 'memory_list', {});
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url.startsWith('http://127.0.0.1:31009')).toBe(true);
    }
  });
});
