/**
 * tools/* 行为测试：经 buildGroupedTools 取真实工具定义，
 * 用捕获式 fetch 假体断言「参数 → HTTP 请求」的映射与安全策略。
 */

import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { describe, expect, it } from 'vitest';

import { AnytypeClient } from './client.ts';
import type { ClientConfig } from './client.ts';
import { resolveConfig } from './config.ts';
import type { CliLauncher, CliRuntimeStatus } from './launcher.ts';
import { assertAllowedPath } from './tools/generic.ts';
import { buildGroupedTools } from './tools/index.ts';
import type { ToolDeps } from './tools/shared.ts';

interface CapturedCall {
  url: string;
  init: RequestInit;
}

/** CLI 服务管理器假体（authStatus 返回机读解析样例）。 */
function stubLauncher(overrides?: Partial<CliRuntimeStatus>): CliLauncher {
  const auth: CliRuntimeStatus = {
    parsed: true,
    state: 'unavailable',
    cliVersion: 'v0.5.0',
    authenticated: false,
    apiReady: false,
    serviceManager: 'unsupported',
    serviceInstalled: false,
    serviceRunning: false,
    serviceHealth: 'not_running',
    workPath: 'C:\\x\\anytype',
    errorCode: 'rpc_unavailable',
    detail: '',
    ...overrides,
  };
  return {
    authStatus: () => Promise.resolve(auth),
    cliServiceStatus: () =>
      Promise.resolve({
        binFound: false,
        state: 'not-installed',
        detail: 'not installed',
      }),
    startCliService: () => Promise.resolve('not-installed'),
    login: () =>
      Promise.resolve({ ok: true, state: 'ready', detail: '', account: {} }),
    create: () =>
      Promise.resolve({ ok: true, state: 'ready', detail: '', account: {} }),
    serveStart: () => Promise.resolve('started'),
  } as unknown as CliLauncher;
}

/** 组装带捕获 fetch 的 deps（desktop 命中）。 */
function makeDeps(): { deps: ToolDeps; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const clientCfg: ClientConfig = {
    apiVersion: '2025-11-08',
    timeoutMs: 5000,
    backendMode: 'auto',
    desktop: { url: 'http://127.0.0.1:31009', key: 'test-key' },
    cli: { url: 'http://127.0.0.1:31012', key: '' },
  };
  const deps: ToolDeps = {
    client: new AnytypeClient(
      () => clientCfg,
      async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ echoed: true }), {
          status: 200,
          headers: { 'content-type': 'application/json', etag: '"etag-1"' },
        });
      },
    ),
    config: () => resolveConfig(undefined),
    launcher: stubLauncher(),
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
  it('按组注册 29 个工具（组缺失即清单漂移）', () => {
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
      property: 2,
      member: 2,
      schema: 2,
      generic: 1,
      'cli-auth': 2,
    });
    expect(flatTools(deps)).toHaveLength(29);
  });

  it('anytype_status：组装双后端探测 + CLI 机读状态 + 生效后端', async () => {
    const { deps } = makeDeps();
    const value = (await toolByName(deps, 'anytype_status').execute(
      {},
      stubExec(),
    )) as { status: number; data: Record<string, unknown> };
    expect(value.status).toBe(200);
    expect(value.data.backend_mode).toBe('auto');
    // 桌面端假 fetch 返回 200 → 生效后端 desktop
    expect(value.data.effective_backend).toBe('desktop');
    const desktop = value.data.desktop as Record<string, unknown>;
    expect(desktop.configured).toBe(true);
    expect(desktop.reachable).toBe(true);
    expect(desktop.note).toContain('detection-only');
    const cli = value.data.cli as Record<string, unknown>;
    expect(cli.configured).toBe(false);
    // 机读解析：serviceInstalled=false → not-installed；富字段来自 authStatus
    expect(cli.service_state).toBe('not-installed');
    expect(cli.cli_version).toBe('v0.5.0');
    expect(cli.cli_authenticated).toBe(false);
    expect(cli.service_manager).toBe('unsupported');
    expect(cli.work_path).toBe('C:\\x\\anytype');
  });

  it('anytype_cli_login/create：无参数执行并透传 launcher 结果', async () => {
    const { deps } = makeDeps();
    const login = (await toolByName(deps, 'anytype_cli_login').execute(
      {},
      stubExec(),
    )) as { status: number; data: Record<string, unknown> };
    expect(login.status).toBe(200);
    expect(login.data.ok).toBe(true);
    expect(login.data.state).toBe('ready');

    const create = (await toolByName(deps, 'anytype_cli_create').execute(
      {},
      stubExec(),
    )) as { status: number; data: Record<string, unknown> };
    expect(create.status).toBe(200);
    expect(create.data.ok).toBe(true);
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
      'anytype_request',
    ]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.isConcurrencySafe).toBeUndefined();
    }
  });
});
