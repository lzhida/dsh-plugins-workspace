/**
 * wiki tools 行为测试：用捕获式 fetch 假体断言「意图 → HTTP 请求」的映射，
 * 以及笔记工具的关键契约（setup 幂等、write 查重/draft 态/source 溯源、
 * review 裁决与 If-Match 并发保护、get/list 只读、lint 规则）。
 */

import { AnytypeClient } from '../core/index.ts';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { describe, expect, it } from 'vitest';

import { resolveConfig } from './config.ts';
import { WIKI_PROPERTIES } from './schema.ts';
import { WikiStore } from './store.ts';
import { buildGroupedTools } from './tools/index.ts';
import type { WikiToolDeps } from './tools/shared.ts';

interface CapturedCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/** 路由式 fetch 假体：按「方法 + 路径片段」返回可编程响应（可带响应头）。 */
function fakeFetch(
  routes: Array<{
    match: (url: string, method: string) => boolean;
    status?: number;
    headers?: Record<string, string>;
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
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    const route = routes.find((r) =>
      r.match(String(url), init.method ?? 'GET'),
    );
    const status = route?.status ?? 200;
    const body =
      typeof route?.body === 'function' ? route.body(parsed) : route?.body;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(route?.headers ?? {}),
    };
    return new Response(JSON.stringify(body ?? {}), { status, headers });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** 组装带假体 fetch 的工具依赖（空间钉在 64xiwe）。 */
function makeDeps(routes: Parameters<typeof fakeFetch>[0]): {
  deps: WikiToolDeps;
  calls: CapturedCall[];
} {
  const { fetchImpl, calls } = fakeFetch(routes);
  const deps: WikiToolDeps = {
    store: new WikiStore(
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
function pick(deps: WikiToolDeps, group: string, name: string): ToolDefinition {
  const tools = buildGroupedTools(deps).get(group as never) ?? [];
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool not found: ${name}`);
  return found;
}

/** 读工具参数。 */
async function run(
  deps: WikiToolDeps,
  group: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = pick(deps, group, name);
  return tool.execute(args, exec);
}

/** 全部 7 个 wiki 属性的属性清单响应体。 */
function allPropertiesBody(): unknown {
  return {
    data: WIKI_PROPERTIES.map((p) => ({
      key: p.key,
      name: p.name,
      format: p.format,
    })),
  };
}

describe('dsh-anytype-wiki tools', () => {
  it('注册 6 个工具，组分布为 setup1/write1/review1/read2/lint1', () => {
    const { deps } = makeDeps([]);
    const grouped = buildGroupedTools(deps);
    const counts = new Map<string, number>();
    let total = 0;
    for (const [group, tools] of grouped) {
      counts.set(group, tools.length);
      total += tools.length;
    }
    expect(total).toBe(6);
    expect(counts.get('setup')).toBe(1);
    expect(counts.get('write')).toBe(1);
    expect(counts.get('review')).toBe(1);
    expect(counts.get('read')).toBe(2);
    expect(counts.get('lint')).toBe(1);
  });

  it('工具名唯一且全部以 wiki_ 前缀', () => {
    const { deps } = makeDeps([]);
    const names: string[] = [];
    for (const tools of buildGroupedTools(deps).values()) {
      for (const tool of tools) names.push(tool.name);
    }
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.startsWith('wiki_'))).toBe(true);
  });

  it('wiki_setup 幂等：类型与属性齐全时只读不建（零 POST）', async () => {
    const { deps, calls } = makeDeps([
      {
        // 类型文档（字段表）：必须排在通用 /types 之前
        match: (url) => url.includes('/types/wiki_note'),
        body: {
          blocks: [
            {
              type: 'dataview',
              properties: WIKI_PROPERTIES.map((p) => ({ property: p.key })),
            },
          ],
        },
      },
      {
        match: (url, method) => url.includes('/types') && method === 'GET',
        body: {
          data: [{ key: 'wiki_note', name: 'Wiki Note', properties: [] }],
        },
      },
      {
        match: (url) => url.includes('/properties'),
        body: allPropertiesBody(),
      },
    ]);
    const result = (await run(deps, 'setup', 'wiki_setup', {})) as {
      space_id: string;
      created: string[];
    };
    expect(result.space_id).toBe('64xiwe');
    expect(result.created).toEqual([]);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('wiki_setup 首次运行：一次 POST /types 带全字段表（basic 布局 + status 选项）', async () => {
    // 属性盘点：首次为空（触发字段表铸造），bootstrap 后的重新盘点返回全量。
    let propertyCalls = 0;
    const { deps, calls } = makeDeps([
      {
        match: (url, method) => url.includes('/types') && method === 'POST',
        body: (parsed: unknown) => parsed,
      },
      {
        match: (url, method) => url.includes('/types') && method === 'GET',
        body: { data: [] },
      },
      {
        match: (url) => url.includes('/properties'),
        body: () => {
          propertyCalls += 1;
          return propertyCalls === 1 ? { data: [] } : allPropertiesBody();
        },
      },
    ]);
    await run(deps, 'setup', 'wiki_setup', {});
    const postType = calls.find(
      (c) => c.method === 'POST' && c.url.includes('/types'),
    );
    expect(postType).toBeDefined();
    const body = postType?.body as {
      api_key: string;
      layout: string;
      property_definitions: Array<{
        name: string;
        format?: string;
        options?: Array<{ name: string }>;
      }>;
    };
    expect(body.api_key).toBe('wiki_note');
    expect(body.layout).toBe('basic');
    const statusDef = body.property_definitions.find(
      (d) => d.name === 'Wiki status',
    );
    expect(statusDef?.format).toBe('select');
    expect(statusDef?.options?.map((o) => o.name)).toEqual([
      'draft',
      'approved',
      'archived',
    ]);
    // 步骤 3 的重新盘点已齐全 → 不应有独立的属性铸造 POST
    expect(
      calls.filter((c) => c.method === 'POST' && c.url.includes('/properties')),
    ).toHaveLength(0);
  });

  it('wiki_write 新建：默认 draft 态 + source 溯源 + 时间戳', async () => {
    const { deps, calls } = makeDeps([
      {
        match: (url) => url.includes('/search'),
        body: { data: [], total: 0, has_more: false },
      },
      {
        match: (url) => url.includes('/properties'),
        body: allPropertiesBody(),
      },
      {
        match: (url, method) => url.includes('/objects') && method === 'POST',
        body: (parsed: unknown) => parsed,
      },
    ]);
    const result = (await run(deps, 'write', 'wiki_write', {
      title: 'Test Note',
      body: '# Hello',
      source: 'conversation 2026-10-30',
      tags: ['demo'],
    })) as { created: boolean; object_id: string; status: string };
    expect(result.created).toBe(true);
    expect(result.status).toBe('draft');
    const post = calls.find(
      (c) => c.method === 'POST' && c.url.includes('/objects'),
    );
    expect(post).toBeDefined();
    const body = post?.body as {
      type: string;
      name: string;
      markdown?: string;
      properties: Record<string, unknown>;
    };
    expect(body.type).toBe('wiki_note');
    expect(body.name).toBe('Test Note');
    expect(body.markdown).toBe('# Hello');
    expect(body.properties.wiki_status).toEqual(['draft']);
    expect(body.properties.wiki_source).toBe('conversation 2026-10-30');
    expect(typeof body.properties.wiki_created_at).toBe('string');
    expect(body.properties.tag).toEqual(['demo']);
    // 查重先行：写之前发生过一次 search
    expect(
      calls.some((c) => c.method === 'POST' && c.url.includes('/search')),
    ).toBe(true);
  });

  it('wiki_write 更新：标题命中即 PATCH 原页，不产生重复页；正文替换回 draft 且带 If-Match', async () => {
    const { deps, calls } = makeDeps([
      {
        match: (url) => url.includes('/search'),
        body: {
          data: [
            {
              id: 'obj1',
              name: 'Test Note',
              type: 'wiki_note',
              properties: {},
            },
          ],
          total: 1,
          has_more: false,
        },
      },
      {
        match: (url) => url.includes('/properties'),
        body: allPropertiesBody(),
      },
      {
        match: (url, method) =>
          url.includes('/objects/obj1') && method === 'GET',
        body: {
          id: 'obj1',
          etag: 'etag-u1',
          properties: { name: 'Test Note' },
          blocks: [{ id: 'b1', type: 'paragraph', text: 'old' }],
        },
      },
      {
        match: (url, method) =>
          url.includes('/objects/obj1') && method === 'PATCH',
        body: (parsed: unknown) => parsed,
      },
    ]);
    const result = (await run(deps, 'write', 'wiki_write', {
      title: 'Test Note',
      body: '# Replaced',
      source: 'updated source',
    })) as {
      created: boolean;
      object_id: string;
      status_reset_to_draft: boolean;
    };
    expect(result.created).toBe(false);
    expect(result.object_id).toBe('obj1');
    expect(result.status_reset_to_draft).toBe(true);
    // 无 POST objects → 没有产生重复页
    expect(
      calls.filter((c) => c.method === 'POST' && c.url.includes('/objects')),
    ).toHaveLength(0);
    const patch = calls.find(
      (c) => c.method === 'PATCH' && c.url.includes('/objects/obj1'),
    );
    expect(patch).toBeDefined();
    expect(patch?.headers['If-Match']).toBe('etag-u1');
    const ops = (patch?.body as { ops: Array<Record<string, unknown>> }).ops;
    expect(ops.filter((o) => o.op === 'delete_block')).toEqual([
      { op: 'delete_block', id: 'b1', recursive: true },
    ]);
    const insert = ops.find((o) => o.op === 'insert_blocks');
    expect((insert as { markdown: string }).markdown).toBe('# Replaced');
    const setOp = ops.find((o) => o.op === 'set_properties');
    const set = (setOp as { set: Record<string, unknown> }).set;
    expect(set.wiki_status).toEqual(['draft']);
    expect(set.wiki_source).toBe('updated source');
  });

  it('wiki_write 仅元数据更新：不改审核态（不重置 draft）', async () => {
    const { deps, calls } = makeDeps([
      {
        match: (url) => url.includes('/search'),
        body: {
          data: [{ id: 'obj1', name: 'T', type: 'wiki_note', properties: {} }],
          total: 1,
          has_more: false,
        },
      },
      {
        match: (url) => url.includes('/properties'),
        body: allPropertiesBody(),
      },
      {
        match: (url, method) =>
          url.includes('/objects/obj1') && method === 'GET',
        body: { id: 'obj1', etag: 'etag-m1', properties: {}, blocks: [] },
      },
      {
        match: (url, method) =>
          url.includes('/objects/obj1') && method === 'PATCH',
        body: (parsed: unknown) => parsed,
      },
    ]);
    const result = (await run(deps, 'write', 'wiki_write', {
      title: 'T',
      source: 'new source',
    })) as { status_reset_to_draft: boolean };
    expect(result.status_reset_to_draft).toBe(false);
    const patch = calls.find((c) => c.method === 'PATCH');
    const ops = (patch?.body as { ops: Array<Record<string, unknown>> }).ops;
    expect(ops.filter((o) => o.op === 'delete_block')).toHaveLength(0);
    const set = (
      ops.find((o) => o.op === 'set_properties') as {
        set: Record<string, unknown>;
      }
    ).set;
    expect(set.wiki_status).toBeUndefined();
  });

  it('wiki_review 裁决：expected_etags 透传 If-Match，approve 写回 approved + 审计字段', async () => {
    const { deps, calls } = makeDeps([
      {
        match: (url) => url.includes('/properties'),
        body: allPropertiesBody(),
      },
      {
        match: (url, method) =>
          url.includes('/objects/a1') && method === 'PATCH',
        body: (parsed: unknown) => parsed,
      },
    ]);
    const result = (await run(deps, 'review', 'wiki_review', {
      decision: 'approve',
      object_ids: ['a1'],
      expected_etags: { a1: 'etag-1' },
      actor: 'tester',
    })) as {
      action: string;
      applied: number;
      failed: number;
      status: string;
    };
    expect(result.action).toBe('reviewed');
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.status).toBe('approved');
    const patch = calls.find(
      (c) => c.method === 'PATCH' && c.url.includes('/objects/a1'),
    );
    expect(patch).toBeDefined();
    expect(patch?.headers['If-Match']).toBe('etag-1');
    const set = (
      (
        patch?.body as {
          ops: Array<{ op: string; set?: Record<string, unknown> }>;
        }
      ).ops[0] as { set: Record<string, unknown> }
    ).set;
    expect(set.wiki_status).toEqual(['approved']);
    expect(set.wiki_reviewed_by).toBe('tester');
    expect(typeof set.wiki_reviewed_at).toBe('string');
  });

  it('wiki_review 无 etag 时自行读回 etag 再写（仍是 If-Match 保护）', async () => {
    const { deps, calls } = makeDeps([
      {
        match: (url) => url.includes('/properties'),
        body: allPropertiesBody(),
      },
      {
        match: (url, method) => url.includes('/objects/a2') && method === 'GET',
        body: { id: 'a2', etag: 'etag-a2', properties: {}, blocks: [] },
      },
      {
        match: (url, method) =>
          url.includes('/objects/a2') && method === 'PATCH',
        body: (parsed: unknown) => parsed,
      },
    ]);
    await run(deps, 'review', 'wiki_review', {
      decision: 'archive',
      object_ids: ['a2'],
    });
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.headers['If-Match']).toBe('etag-a2');
  });

  it('wiki_review 并发冲突（409）单条上报，不中断其余条目', async () => {
    const { deps, calls } = makeDeps([
      {
        match: (url) => url.includes('/properties'),
        body: allPropertiesBody(),
      },
      {
        match: (url, method) =>
          url.includes('/objects/conflicted') && method === 'PATCH',
        status: 409,
        body: { message: 'conflict' },
      },
      {
        match: (url, method) =>
          url.includes('/objects/fine') && method === 'PATCH',
        body: (parsed: unknown) => parsed,
      },
    ]);
    const result = (await run(deps, 'review', 'wiki_review', {
      decision: 'reject',
      object_ids: ['conflicted', 'fine'],
      expected_etags: { conflicted: 'stale-etag', fine: 'etag-ok' },
    })) as {
      applied: number;
      failed: number;
      results: Array<{ object_id: string; ok: boolean; error?: unknown }>;
    };
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results[0]?.object_id).toBe('conflicted');
    expect(result.results[0]?.ok).toBe(false);
    expect(String(result.results[0]?.error)).toContain('409');
    expect(result.results[1]).toEqual({
      object_id: 'fine',
      ok: true,
      status: 'archived',
    });
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2);
  });

  it('wiki_review 无 object_ids 时列出待审清单（draft）', async () => {
    const { deps, calls } = makeDeps([
      {
        match: (url) => url.includes('/properties'),
        body: allPropertiesBody(),
      },
      {
        match: (url) => url.includes('/search'),
        body: {
          data: [
            {
              id: 'd1',
              name: 'Draft note',
              type: 'wiki_note',
              properties: {
                wiki_status: ['draft'],
                wiki_source: 'src',
              },
            },
          ],
          total: 1,
          has_more: false,
        },
      },
    ]);
    const result = (await run(deps, 'review', 'wiki_review', {})) as {
      action: string;
      pending: Array<{ object_id: string; status: string }>;
    };
    expect(result.action).toBe('listed');
    expect(result.pending[0]?.object_id).toBe('d1');
    expect(result.pending[0]?.status).toBe('draft');
    const search = calls.find(
      (c) => c.method === 'POST' && c.url.includes('/search'),
    );
    expect((search?.body as { filter?: string }).filter).toContain(
      'wiki_status IN ("draft")',
    );
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('wiki_get 只读：返回 markdown + 审核元数据 + etag，不产生任何写请求', async () => {
    const { deps, calls } = makeDeps([
      {
        match: (url) => url.includes('/properties'),
        body: allPropertiesBody(),
      },
      {
        match: (url, method) =>
          url.includes('/objects/n1') &&
          method === 'GET' &&
          !url.includes('format=md'),
        body: {
          id: 'n1',
          etag: 'etag-n1',
          properties: {
            name: 'Note',
            wiki_status: ['draft'],
            wiki_source: 'src',
          },
          blocks: [],
        },
      },
      {
        match: (url) =>
          url.includes('/objects/n1') && url.includes('format=md'),
        body: { markdown: '# Body' },
      },
    ]);
    const result = (await run(deps, 'read', 'wiki_get', {
      object_id: 'n1',
    })) as {
      object_id: string;
      etag: string;
      markdown: string;
      status: string;
      source: string;
    };
    expect(result.object_id).toBe('n1');
    expect(result.etag).toBe('etag-n1');
    expect(result.markdown).toBe('# Body');
    expect(result.status).toBe('draft');
    expect(result.source).toBe('src');
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('wiki_list 只读：默认过滤 draft+approved，不产生任何写请求', async () => {
    const { deps, calls } = makeDeps([
      {
        match: (url) => url.includes('/properties'),
        body: allPropertiesBody(),
      },
      {
        match: (url) => url.includes('/search'),
        body: {
          data: [
            {
              id: 'n1',
              name: 'A',
              type: 'wiki_note',
              properties: { wiki_status: ['approved'], tag: ['t'] },
            },
          ],
          total: 1,
          has_more: false,
        },
      },
    ]);
    const result = (await run(deps, 'read', 'wiki_list', {})) as {
      items: Array<{ object_id: string; status: string; tags: string[] }>;
    };
    expect(result.items[0]?.object_id).toBe('n1');
    expect(result.items[0]?.status).toBe('approved');
    expect(result.items[0]?.tags).toEqual(['t']);
    const search = calls.find((c) => c.url.includes('/search'));
    expect((search?.body as { filter?: string }).filter).toContain(
      'wiki_status IN ("draft", "approved")',
    );
    expect(calls.every((c) => c.method === 'GET' || c.method === 'POST')).toBe(
      true,
    );
  });

  it('wiki_lint 失效链接：出链目标不在未归档集合 → 报告；孤立页：backlinks 为空 → 报告', async () => {
    const { deps, calls } = makeDeps([
      {
        match: (url) => url.includes('/properties'),
        body: allPropertiesBody(),
      },
      {
        match: (url) => url.includes('/search'),
        body: {
          data: [
            {
              id: 'n1',
              name: 'A',
              type: 'wiki_note',
              properties: {
                wiki_status: ['draft'],
                links: ['n2', 'dead-target'],
                backlinks: ['n3'],
              },
            },
            {
              id: 'n2',
              name: 'B',
              type: 'wiki_note',
              properties: { wiki_status: ['draft'], links: [], backlinks: [] },
            },
            {
              id: 'n3',
              name: 'C',
              type: 'wiki_note',
              properties: {
                wiki_status: ['approved'],
                links: ['n1'],
                backlinks: ['n1'],
              },
            },
            {
              // 全空间扫描会带上非 wiki 对象 → 行内过滤必须剔除
              id: 'other',
              name: '非 wiki 对象',
              type: 'page',
              properties: { links: ['dead-target'], backlinks: [] },
            },
          ],
          total: 4,
          has_more: false,
        },
      },
    ]);
    const result = (await run(deps, 'lint', 'wiki_lint', {})) as {
      checked: number;
      scanned_objects: number;
      counts: { broken_links: number; orphan_pages: number };
      broken_links: Array<{ from_id: string; target_id: string }>;
      orphan_pages: Array<{ object_id: string }>;
    };
    expect(result.checked).toBe(3);
    expect(result.scanned_objects).toBe(4);
    expect(result.counts).toEqual({ broken_links: 1, orphan_pages: 1 });
    expect(result.broken_links[0]).toEqual({
      from_id: 'n1',
      from_name: 'A',
      target_id: 'dead-target',
    });
    expect(result.orphan_pages[0]?.object_id).toBe('n2');
    // 只读巡检：不出现任何写请求（POST /search 是读）
    expect(calls.every((c) => c.method === 'GET' || c.method === 'POST')).toBe(
      true,
    );
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('wiki_lint 分页：has_more 驱动翻页，直到收尽或触顶', async () => {
    let page = 0;
    const { deps } = makeDeps([
      {
        match: (url) => url.includes('/properties'),
        body: allPropertiesBody(),
      },
      {
        match: (url) => url.includes('/search'),
        body: () => {
          page += 1;
          return {
            data:
              page === 1
                ? [
                    {
                      id: 'p1a',
                      name: 'page1',
                      type: 'wiki_note',
                      properties: { links: [], backlinks: ['x'] },
                    },
                  ]
                : [
                    {
                      id: 'p2a',
                      name: 'page2',
                      type: 'wiki_note',
                      properties: { links: [], backlinks: [] },
                    },
                  ],
            total: 2,
            has_more: page < 2,
          };
        },
      },
    ]);
    const result = (await run(deps, 'lint', 'wiki_lint', {})) as {
      checked: number;
      scanned_pages: number;
    };
    expect(page).toBe(2);
    expect(result.checked).toBe(2);
    expect(result.scanned_pages).toBe(2);
  });
});
