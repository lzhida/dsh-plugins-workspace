/**
 * tools/* 行为测试：经 buildGroupedTools 取真实工具定义，
 * 用捕获式 fetch 假体断言「参数 → HTTP 请求」的映射与安全策略。
 */

import { AnytypeClient, type ToolDeps } from '../core/index.ts';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { describe, expect, it } from 'vitest';

import { resolveConfig } from './config.ts';
import { assertAllowedPath } from './tools/generic.ts';
import { buildGroupedTools } from './tools/index.ts';

interface CapturedCall {
  url: string;
  init: RequestInit;
}

/** 组装带捕获 fetch 的 deps。 */
function makeDeps(): { deps: ToolDeps; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const deps: ToolDeps = {
    client: new AnytypeClient(
      () => ({
        baseUrl: 'http://127.0.0.1:31009',
        apiKey: 'test-key',
        apiVersion: '2025-11-08',
        timeoutMs: 5000,
      }),
      async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ echoed: true }), {
          status: 200,
          headers: { 'content-type': 'application/json', etag: '"etag-1"' },
        });
      },
    ),
    config: () => resolveConfig(undefined),
  };
  return { deps, calls };
}

/** 全组工具的扁平视图。 */
function flatTools(deps: ToolDeps): ToolDefinition[] {
  return [...buildGroupedTools(deps).values()].flat();
}

/** 按名取工具（缺失即测试失败）。 */
function toolByName(deps: ToolDeps, name: string): ToolDefinition {
  const tool = flatTools(deps).find((t) => t.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool;
}

/** 空执行上下文（测试只关心 signal 透传）。 */
function stubExec(): ToolRunContext {
  return {
    signal: new AbortController().signal,
  } as unknown as ToolRunContext;
}

/** 断言一次调用的 method/url/body 并返回工具值。 */
async function run(
  deps: ToolDeps,
  calls: CapturedCall[],
  name: string,
  args: unknown,
): Promise<unknown> {
  const before = calls.length;
  const value = (await toolByName(deps, name).execute(args, stubExec())) as {
    status: number;
  };
  expect(value.status).toBe(200);
  expect(calls.length).toBe(before + 1);
  return value;
}

describe('dsh-anytype tools', () => {
  it('按组注册 30 个工具（组缺失即清单漂移）', () => {
    const { deps } = makeDeps();
    const grouped = buildGroupedTools(deps);
    const counts = Object.fromEntries(
      [...grouped.entries()].map(([g, list]) => [g, list.length]),
    );
    expect(counts).toEqual({
      connection: 2,
      search: 2,
      space: 4,
      object: 4,
      collection: 2,
      type: 6,
      property: 5,
      member: 2,
      schema: 2,
      generic: 1,
    });
    expect(flatTools(deps)).toHaveLength(30);
  });

  it('anytype_status：桌面端探测结果组装', async () => {
    const { deps } = makeDeps();
    const value = (await toolByName(deps, 'anytype_status').execute(
      {},
      stubExec(),
    )) as { status: number; data: Record<string, unknown> };
    expect(value.status).toBe(200);
    // 桌面端假 fetch 返回 200 → 可达且已认证
    expect(value.data.url).toBe('http://127.0.0.1:31009');
    expect(value.data.configured).toBe(true);
    expect(value.data.reachable).toBe(true);
    expect(value.data.authenticated).toBe(true);
    expect(value.data.error).toBeNull();
    expect(value.data.note).toContain('detection-only');
  });

  it('anytype_search：无 space_id 走全局 /v2/search，有则走空间内路径', async () => {
    const { deps, calls } = makeDeps();
    await run(deps, calls, 'anytype_search', { query: 'llm' });
    expect(calls.at(-1)?.url).toBe('http://127.0.0.1:31009/v2/search');
    expect(calls.at(-1)?.init.method).toBe('POST');

    await run(deps, calls, 'anytype_search', {
      query: 'llm',
      space_id: '64xi we',
      limit: 5,
      type: 'task',
    });
    expect(calls.at(-1)?.url).toBe(
      `http://127.0.0.1:31009/v2/spaces/${encodeURIComponent('64xi we')}/search?limit=5`,
    );
    expect(JSON.parse(calls.at(-1)?.init.body as string)).toEqual({
      query: 'llm',
      type: 'task',
    });
  });

  it('anytype_search：fields 进 POST body（属性投影）', async () => {
    const { deps, calls } = makeDeps();
    await run(deps, calls, 'anytype_search', {
      query: 'llm',
      fields: ['name', 'due_date'],
    });
    expect(calls.at(-1)?.init.method).toBe('POST');
    // fields 属于请求体（不是 query）——服务端据此把列出的属性投影回每行
    expect(JSON.parse(calls.at(-1)?.init.body as string)).toEqual({
      query: 'llm',
      fields: ['name', 'due_date'],
    });
    // 不传 fields 时不发送该键（活体语义：此时行只有 id/name/type 骨架）
    await run(deps, calls, 'anytype_search', { query: 'llm' });
    expect(JSON.parse(calls.at(-1)?.init.body as string)).toEqual({
      query: 'llm',
    });
  });

  it('anytype_search：filter 进 POST body（紧凑过滤语法）', async () => {
    const { deps, calls } = makeDeps();
    await run(deps, calls, 'anytype_search', {
      query: 'llm',
      filter: 'done = false AND due_date < currentWeek()',
    });
    expect(JSON.parse(calls.at(-1)?.init.body as string)).toEqual({
      query: 'llm',
      filter: 'done = false AND due_date < currentWeek()',
    });
  });

  it('anytype_search：filter 与 filters 互斥——同传报错且不发请求', async () => {
    const { deps, calls } = makeDeps();
    const before = calls.length;
    await expect(
      toolByName(deps, 'anytype_search').execute(
        {
          query: 'llm',
          filter: 'done = false',
          filters: [{ property: 'done', condition: 'equal', value: false }],
        },
        stubExec(),
      ),
    ).rejects.toThrow(/mutually exclusive/);
    // 工具层提前拦截，不浪费一次往返
    expect(calls.length).toBe(before);

    // 单独给 filters 仍走结构化通道
    await run(deps, calls, 'anytype_search', {
      query: 'llm',
      filters: [{ property: 'done', condition: 'equal', value: false }],
    });
    expect(JSON.parse(calls.at(-1)?.init.body as string)).toEqual({
      query: 'llm',
      filters: [{ property: 'done', condition: 'equal', value: false }],
    });
  });

  it('anytype_search：空过滤值视作未提供（不发无效负载）', async () => {
    const { deps, calls } = makeDeps();
    // 服务端对 filter:"" 忽略，但对 filters:null / filters:[] 会 400
    await run(deps, calls, 'anytype_search', {
      query: 'llm',
      filter: '',
      filters: [],
    });
    expect(JSON.parse(calls.at(-1)?.init.body as string)).toEqual({
      query: 'llm',
    });
  });

  it('anytype_search：fields + filter 与 limit/offset 各归其位', async () => {
    const { deps, calls } = makeDeps();
    await run(deps, calls, 'anytype_search', {
      query: 'llm',
      space_id: 's1',
      fields: ['name', 'due_date'],
      filter: 'done = false',
      limit: 5,
      offset: 10,
    });
    // 分页仍走 query
    expect(calls.at(-1)?.url).toBe(
      'http://127.0.0.1:31009/v2/spaces/s1/search?limit=5&offset=10',
    );
    // 裁剪与过滤走 body
    expect(JSON.parse(calls.at(-1)?.init.body as string)).toEqual({
      query: 'llm',
      fields: ['name', 'due_date'],
      filter: 'done = false',
    });
  });

  it('anytype_search：参数描述声明裁剪能力与 filter 语法来源（提示词契约）', () => {
    const { deps } = makeDeps();
    const paramDesc = (name: string, param: string): string => {
      const tool = flatTools(deps).find((t) => t.name === name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      // defineTool 把 parameters 编译成 JSON Schema（properties 子树）
      const schema = tool.parameters as unknown as {
        properties?: Record<string, { description?: string }>;
      };
      const spec = schema.properties?.[param];
      if (!spec) throw new Error(`param not declared: ${name}.${param}`);
      return spec.description ?? '';
    };
    const desc = (name: string): string => {
      const tool = flatTools(deps).find((t) => t.name === name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      return tool.description ?? '';
    };

    // filter：字节上限 + 语法来源（anytype_get_schema kind=filters）+ 互斥
    expect(paramDesc('anytype_search', 'filter')).toMatch(/4096/);
    expect(paramDesc('anytype_search', 'filter')).toMatch(/kind filters/);
    expect(paramDesc('anytype_search', 'filter')).toMatch(
      /Mutually exclusive with filters/,
    );
    // fields：属性投影语义（不是裁剪）+ 上限 + 键约束
    expect(paramDesc('anytype_search', 'fields')).toMatch(/project/);
    expect(paramDesc('anytype_search', 'fields')).toMatch(/max 25/);
    expect(paramDesc('anytype_search', 'fields')).toMatch(
      /ADDS properties to the response/,
    );
    // filters 侧也声明互斥
    expect(paramDesc('anytype_search', 'filters')).toMatch(
      /Mutually exclusive with filter/,
    );
    // 工具描述层面点名两个新参数
    expect(desc('anytype_search')).toMatch(/fields/);
    expect(desc('anytype_search')).toMatch(/filter/);
    expect(desc('anytype_search')).toMatch(/4096/);
    expect(desc('anytype_search')).toMatch(/kind=filters/);
  });

  it('anytype_list_objects：GET 路径带分页与 fields 查询', async () => {
    const { deps, calls } = makeDeps();
    await run(deps, calls, 'anytype_list_objects', {
      space_id: 's1',
      limit: 10,
      offset: 20,
      fields: 'id,name',
    });
    expect(calls.at(-1)?.init.method).toBe('GET');
    expect(calls.at(-1)?.url).toBe(
      'http://127.0.0.1:31009/v2/spaces/s1/objects?limit=10&offset=20&fields=id%2Cname',
    );
  });

  it('anytype_create_object：shortcut body 只带已提供的字段', async () => {
    const { deps, calls } = makeDeps();
    await run(deps, calls, 'anytype_create_object', {
      space_id: 's1',
      type: 'task',
      name: 'T1',
      properties: { due: '2026-10-20' },
    });
    expect(calls.at(-1)?.init.method).toBe('POST');
    expect(calls.at(-1)?.url).toBe(
      'http://127.0.0.1:31009/v2/spaces/s1/objects',
    );
    expect(JSON.parse(calls.at(-1)?.init.body as string)).toEqual({
      type: 'task',
      name: 'T1',
      properties: { due: '2026-10-20' },
    });
  });

  it('写工具的 dry_run 走 query 透传（预演不落库）', async () => {
    const { deps, calls } = makeDeps();
    // create_object：预演 query
    await run(deps, calls, 'anytype_create_object', {
      space_id: 's1',
      type: 'task',
      dry_run: true,
    });
    expect(calls.at(-1)?.url).toBe(
      'http://127.0.0.1:31009/v2/spaces/s1/objects?dry_run=true',
    );

    // update_object：预演 query
    await run(deps, calls, 'anytype_update_object', {
      space_id: 's1',
      object_id: 'o1',
      ops: [{ op: 'set_properties', set: { due: 'x' } }],
      dry_run: true,
    });
    expect(calls.at(-1)?.url).toBe(
      'http://127.0.0.1:31009/v2/spaces/s1/objects/o1?dry_run=true',
    );

    // create_space：预演 query
    await run(deps, calls, 'anytype_create_space', {
      name: 'S',
      dry_run: true,
    });
    expect(calls.at(-1)?.url).toBe(
      'http://127.0.0.1:31009/v2/spaces?dry_run=true',
    );

    // create_type：预演与既有 create_missing_options 共存
    await run(deps, calls, 'anytype_create_type', {
      space_id: 's1',
      name: 'T',
      create_missing_options: true,
      dry_run: true,
    });
    expect(calls.at(-1)?.url).toBe(
      'http://127.0.0.1:31009/v2/spaces/s1/types?create_missing_options=true&dry_run=true',
    );

    // create_collection / create_property：预演 query
    await run(deps, calls, 'anytype_create_collection', {
      space_id: 's1',
      name: 'C',
      dry_run: true,
    });
    expect(calls.at(-1)?.url).toBe(
      'http://127.0.0.1:31009/v2/spaces/s1/collections?dry_run=true',
    );
    await run(deps, calls, 'anytype_create_property', {
      space_id: 's1',
      name: 'P',
      format: 'text',
      dry_run: true,
    });
    expect(calls.at(-1)?.url).toBe(
      'http://127.0.0.1:31009/v2/spaces/s1/properties?dry_run=true',
    );
  });

  it('写工具的 idempotency_key 注入 Idempotency-Key 头（防重）', async () => {
    const { deps, calls } = makeDeps();
    const writes: Array<[string, Record<string, unknown>]> = [
      ['anytype_create_object', { space_id: 's1', type: 'task' }],
      ['anytype_update_object', { space_id: 's1', object_id: 'o1', ops: [] }],
      ['anytype_delete_object', { space_id: 's1', object_id: 'o1' }],
      ['anytype_create_space', { name: 'S' }],
      ['anytype_update_space', { space_id: 's1', name: 'S2' }],
      ['anytype_create_type', { space_id: 's1', name: 'T' }],
      ['anytype_update_type', { space_id: 's1', type: 'task', name: 'T2' }],
      ['anytype_delete_type', { space_id: 's1', type: 'task' }],
      ['anytype_create_collection', { space_id: 's1', name: 'C' }],
      [
        'anytype_create_property',
        { space_id: 's1', name: 'P', format: 'text' },
      ],
      ['anytype_update_property', { space_id: 's1', key: 'p', name: 'P2' }],
      ['anytype_delete_property', { space_id: 's1', key: 'p' }],
    ];
    for (const [name, args] of writes) {
      await run(deps, calls, name, { ...args, idempotency_key: 'idem-1' });
      const headers = calls.at(-1)?.init.headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toBe('idem-1');
    }
  });

  it('不传 idempotency_key 时写工具不发 Idempotency-Key 头', async () => {
    const { deps, calls } = makeDeps();
    await run(deps, calls, 'anytype_create_object', {
      space_id: 's1',
      type: 'task',
    });
    const headers = calls.at(-1)?.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeUndefined();
  });

  it('写工具描述声明 dry_run 预演语义与 idempotency_key 防重语义（提示词契约）', () => {
    const { deps } = makeDeps();
    const desc = (name: string): string => {
      const tool = flatTools(deps).find((t) => t.name === name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      return tool.description ?? '';
    };
    const paramDesc = (name: string, param: string): string => {
      const tool = flatTools(deps).find((t) => t.name === name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      // defineTool 把 parameters 编译成 JSON Schema（properties 子树）
      const schema = tool.parameters as unknown as {
        properties?: Record<string, { description?: string }>;
      };
      const spec = schema.properties?.[param];
      if (!spec) throw new Error(`param not declared: ${name}.${param}`);
      return spec.description ?? '';
    };

    // dry_run 预演语义：校验但不提交 + 200 vs 201
    expect(paramDesc('anytype_create_object', 'dry_run')).toMatch(
      /NOT committed/,
    );
    expect(paramDesc('anytype_create_object', 'dry_run')).toMatch(
      /200 where a real create returns 201/,
    );
    // idempotency_key 防重语义：同 key 同 body 重放、换 body 409
    expect(paramDesc('anytype_create_object', 'idempotency_key')).toMatch(
      /replays the stored response/,
    );
    expect(paramDesc('anytype_create_object', 'idempotency_key')).toMatch(
      /409 idempotency_conflict/,
    );
    expect(paramDesc('anytype_create_object', 'idempotency_key')).toMatch(
      /reuse it verbatim when retrying/,
    );
    // 写工具描述里点名两个参数
    expect(desc('anytype_create_object')).toMatch(/dry_run=true/);
    expect(desc('anytype_create_object')).toMatch(/idempotency_key/);
    expect(desc('anytype_update_object')).toMatch(/dry_run=true/);
    expect(desc('anytype_create_space')).toMatch(/dry_run=true/);
    expect(desc('anytype_create_space')).toMatch(/idempotency_key/);
    expect(desc('anytype_create_collection')).toMatch(/idempotency_key/);
    expect(desc('anytype_create_type')).toMatch(/dry_run=true/);
    expect(desc('anytype_delete_type')).toMatch(/dry_run=true/);
  });

  it('anytype_update_object：ops 信封 + expected_etag 映射 If-Match', async () => {
    const { deps, calls } = makeDeps();
    await run(deps, calls, 'anytype_update_object', {
      space_id: 's1',
      object_id: 'o1',
      ops: [{ op: 'set_properties', properties: {} }],
      expected_etag: '"e0"',
    });
    expect(calls.at(-1)?.init.method).toBe('PATCH');
    expect(JSON.parse(calls.at(-1)?.init.body as string)).toEqual({
      ops: [{ op: 'set_properties', properties: {} }],
    });
    const headers = calls.at(-1)?.init.headers as Record<string, string>;
    expect(headers['If-Match']).toBe('"e0"');
  });

  it('anytype_update_space：PATCH 改名/描述，无 expected_etag 参数且不发送 If-Match', async () => {
    const { deps, calls } = makeDeps();
    const tool = toolByName(deps, 'anytype_update_space');
    // 实测（2026-10-20，Anytype 活体）：spaces PATCH 参数区无 If-Match，
    // space 读不返回 etag，带过期 If-Match 也被服务端忽略仍 200 ——
    // 工具面不得承诺乐观锁（详见 README「space 无乐观锁」段）。
    expect(Object.keys(tool.parameters ?? {})).not.toContain('expected_etag');
    await run(deps, calls, 'anytype_update_space', {
      space_id: 's1',
      name: 'Renamed',
    });
    expect(calls.at(-1)?.init.method).toBe('PATCH');
    expect(calls.at(-1)?.url).toBe('http://127.0.0.1:31009/v2/spaces/s1');
    expect(JSON.parse(calls.at(-1)?.init.body as string)).toEqual({
      name: 'Renamed',
    });
    const headers = calls.at(-1)?.init.headers as Record<string, string>;
    expect(headers['If-Match']).toBeUndefined();
  });

  it('anytype_delete_object：DELETE + dry_run 查询', async () => {
    const { deps, calls } = makeDeps();
    await run(deps, calls, 'anytype_delete_object', {
      space_id: 's1',
      object_id: 'o1',
      dry_run: true,
    });
    expect(calls.at(-1)?.init.method).toBe('DELETE');
    expect(calls.at(-1)?.url).toBe(
      'http://127.0.0.1:31009/v2/spaces/s1/objects/o1?dry_run=true',
    );
  });

  it('anytype_create_property：body 收 name/format，key/options 仅在提供时携带', async () => {
    const { deps, calls } = makeDeps();
    await run(deps, calls, 'anytype_create_property', {
      space_id: 's1',
      name: 'Priority',
      format: 'select',
      key: 'priority',
      options: [{ name: 'P0', color: 'red' }],
    });
    expect(calls.at(-1)?.init.method).toBe('POST');
    expect(calls.at(-1)?.url).toBe(
      'http://127.0.0.1:31009/v2/spaces/s1/properties',
    );
    expect(JSON.parse(calls.at(-1)?.init.body as string)).toEqual({
      name: 'Priority',
      format: 'select',
      key: 'priority',
      options: [{ name: 'P0', color: 'red' }],
    });

    // key/options 省略时不发送 undefined 键（registry 对成功值要求无损 JSON）
    await run(deps, calls, 'anytype_create_property', {
      space_id: 's1',
      name: 'Due date',
      format: 'date',
    });
    expect(JSON.parse(calls.at(-1)?.init.body as string)).toEqual({
      name: 'Due date',
      format: 'date',
    });
  });

  it('anytype_update_property：PATCH 仅发 name（key 冻结不变）', async () => {
    const { deps, calls } = makeDeps();
    await run(deps, calls, 'anytype_update_property', {
      space_id: 's1',
      key: 'priority',
      name: 'Urgency',
    });
    expect(calls.at(-1)?.init.method).toBe('PATCH');
    expect(calls.at(-1)?.url).toBe(
      'http://127.0.0.1:31009/v2/spaces/s1/properties/priority',
    );
    expect(JSON.parse(calls.at(-1)?.init.body as string)).toEqual({
      name: 'Urgency',
    });
  });

  it('anytype_delete_property：DELETE + dry_run 查询', async () => {
    const { deps, calls } = makeDeps();
    await run(deps, calls, 'anytype_delete_property', {
      space_id: 's1',
      key: 'priority',
      dry_run: true,
    });
    expect(calls.at(-1)?.init.method).toBe('DELETE');
    expect(calls.at(-1)?.url).toBe(
      'http://127.0.0.1:31009/v2/spaces/s1/properties/priority?dry_run=true',
    );
  });

  it('属性写工具描述声明 v2 能力边界（提示词契约，防回归删除）', () => {
    const { deps } = makeDeps();
    const desc = (name: string): string => {
      const tool = flatTools(deps).find((t) => t.name === name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      return tool.description ?? '';
    };
    // PATCH 只收 name：key 是身份、format 不可变、无选项改名/删色
    expect(desc('anytype_update_property')).toMatch(
      /ONLY change the display name/,
    );
    expect(desc('anytype_update_property')).toMatch(/does not change/);
    expect(desc('anytype_update_property')).toMatch(/no rename\/recolor/);
    // create：内联 options + 选项铸造边界（create_missing_options）+ 选项只读
    expect(desc('anytype_create_property')).toMatch(
      /create_missing_options=true/,
    );
    expect(desc('anytype_create_property')).toMatch(/read-only after creation/);
    // delete：归档进 Bin 可恢复
    expect(desc('anytype_delete_property')).toMatch(/archived into the Bin/);
  });

  it('anytype_update_type：扁平字段与 ops 互斥，两者皆缺报可操作错误', async () => {
    const { deps, calls } = makeDeps();
    await run(deps, calls, 'anytype_update_type', {
      space_id: 's1',
      type: 'task',
      name: 'Renamed',
    });
    expect(JSON.parse(calls.at(-1)?.init.body as string)).toEqual({
      name: 'Renamed',
    });

    await run(deps, calls, 'anytype_update_type', {
      space_id: 's1',
      type: 'task',
      ops: [{ op: 'add_property' }],
    });
    expect(JSON.parse(calls.at(-1)?.init.body as string)).toEqual({
      ops: [{ op: 'add_property' }],
    });

    await expect(
      toolByName(deps, 'anytype_update_type').execute(
        { space_id: 's1', type: 'task' },
        stubExec(),
      ),
    ).rejects.toThrow(/Nothing to update/);

    // ops 为空数组时视为「无 ops」，扁平字段生效
    await run(deps, calls, 'anytype_update_type', {
      space_id: 's1',
      type: 'task',
      name: 'a',
      ops: [],
    });
    expect(JSON.parse(calls.at(-1)?.init.body as string)).toEqual({
      name: 'a',
    });

    await expect(
      toolByName(deps, 'anytype_update_type').execute(
        { space_id: 's1', type: 'task', name: 'a', ops: [{ op: 'x' }] },
        stubExec(),
      ),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it('anytype_get_op_schema：op 走路径参数', async () => {
    const { deps, calls } = makeDeps();
    await run(deps, calls, 'anytype_get_op_schema', { op: 'insert_blocks' });
    expect(calls.at(-1)?.url).toBe(
      'http://127.0.0.1:31009/v2/schemas/ops/insert_blocks',
    );
  });

  it('anytype_request：放行合法 /v2/ 路径并透传 query', async () => {
    const { deps, calls } = makeDeps();
    await run(deps, calls, 'anytype_request', {
      method: 'GET',
      path: '/v2/spaces/s1/widgets',
      query: { limit: 3 },
    });
    expect(calls.at(-1)?.url).toBe(
      'http://127.0.0.1:31009/v2/spaces/s1/widgets?limit=3',
    );
  });

  it('anytype_request：dry_run 与 idempotency_key 透传（逃生舱写路径）', async () => {
    const { deps, calls } = makeDeps();
    await run(deps, calls, 'anytype_request', {
      method: 'POST',
      path: '/v2/spaces/s1/widgets',
      body: { name: 'W' },
      dry_run: true,
      idempotency_key: 'idem-escape',
    });
    expect(calls.at(-1)?.url).toBe(
      'http://127.0.0.1:31009/v2/spaces/s1/widgets?dry_run=true',
    );
    const headers = calls.at(-1)?.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('idem-escape');
  });

  it('anytype_request：不传 dry_run 时 query 保持原样（不多加键）', async () => {
    const { deps, calls } = makeDeps();
    await run(deps, calls, 'anytype_request', {
      method: 'GET',
      path: '/v2/spaces/s1/widgets',
    });
    expect(calls.at(-1)?.url).toBe(
      'http://127.0.0.1:31009/v2/spaces/s1/widgets',
    );
  });

  it('anytype_request 白名单：非 /v2/ 与 /v2/auth/ 一律拒绝', () => {
    expect(() => assertAllowedPath('/v1/docs/openapi.json')).toThrow(
      /only forwards \/v2\//,
    );
    expect(() => assertAllowedPath('v2/spaces')).toThrow();
    expect(() => assertAllowedPath('/v2/auth/challenges')).toThrow(/auth/);
    expect(() => assertAllowedPath('/v2/auth/api_keys')).toThrow(/auth/);
    expect(() => assertAllowedPath('/v2/auth/whoami')).toThrow(/auth/);
    // 合法路径不抛
    expect(() => assertAllowedPath('/v2/validate')).not.toThrow();
  });

  it('读类工具标记 isConcurrencySafe（入参须合法——defineTool 校验失败时判 false），写类不标记', () => {
    const { deps } = makeDeps();
    const tools = flatTools(deps);
    // 各读工具的最小合法入参（defineTool 的并发分类器对非法 args 返回 false）
    const readArgs: Record<string, Record<string, unknown>> = {
      anytype_whoami: {},
      anytype_status: {},
      anytype_search: { query: 'x' },
      anytype_list_objects: { space_id: 's' },
      anytype_list_spaces: {},
      anytype_get_object: { space_id: 's', object_id: 'o' },
      anytype_get_schema: { kind: 'object' },
      anytype_get_op_schema: { op: 'set_properties' },
    };
    for (const [name, args] of Object.entries(readArgs)) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.isConcurrencySafe?.(args)).toBe(true);
    }
    for (const name of [
      'anytype_create_object',
      'anytype_update_object',
      'anytype_delete_object',
      'anytype_create_property',
      'anytype_update_property',
      'anytype_delete_property',
      'anytype_request',
    ]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.isConcurrencySafe).toBeUndefined();
    }
  });
});
