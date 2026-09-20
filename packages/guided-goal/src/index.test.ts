import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply, name } from './index.ts';
import { composeObjective, GOAL_FIELD_DEFS, userText } from './protocol.ts';
import {
  mountRoutes,
  validateFields,
  MUTATION_HEADER,
  ROUTE_SESSIONS,
  ROUTE_CREATE,
  type AgentRegistryLike,
} from './router.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('guided-goal 契约', () => {
  it('导出插件名(loader 依赖)', () => {
    expect(name).toBe('guided-goal');
    expect(apply).toBeTypeOf('function');
  });

  it('composeObjective 产出五段固定结构,缺省字段写未指定', () => {
    const text = composeObjective({
      objective: '发布 v1',
      successCriteria: '测试全绿',
    });
    expect(text).toContain('## Objective\n发布 v1');
    expect(text).toContain('## Success criteria\n测试全绿');
    expect(text).toContain('## Verification\n未指定');
    expect(text).toContain('## Boundaries\n未指定');
    expect(text).toContain('## Stop conditions\n未指定');
  });

  it('GOAL_FIELD_DEFS 前两个字段必填(表单与校验共用同一契约)', () => {
    expect(GOAL_FIELD_DEFS.filter((f) => f.required).map((f) => f.key)).toEqual(
      ['objective', 'successCriteria'],
    );
  });

  it('userText 构造 user 角色、user 来源的文本消息', () => {
    const message = userText('hello');
    expect(message.role).toBe('user');
    expect(message.source.kind).toBe('user');
    expect(message.content).toHaveLength(1);
    expect(message.content[0]).toMatchObject({ type: 'text', text: 'hello' });
    expect(message.id).toBeTypeOf('string');
  });
});

describe('/guided-goal 命令', () => {
  interface CommandHandlerInput {
    agent: { steer(message: unknown): void };
    rawInput: string;
  }
  interface RecordedCommand {
    name: string;
    handler(input: CommandHandlerInput): { kind: string; text?: string };
  }

  function stubCtx(): {
    recorded: RecordedCommand[];
    routes: unknown[];
    cleanups: Array<() => void>;
  } {
    const recorded: RecordedCommand[] = [];
    const routes: unknown[] = [];
    const cleanups: Array<() => void> = [];
    const ctx = {
      effect(fn: () => (() => void) | void): void {
        const cleanup = fn();
        if (cleanup) cleanups.push(cleanup);
      },
      commands: {
        register(def: RecordedCommand): () => void {
          recorded.push(def);
          return () => {};
        },
      },
      webServer: {
        register(route: unknown): () => void {
          routes.push(route);
          return () => {};
        },
      },
      agents: {
        get: () => undefined,
        list: () => [],
      },
    } as unknown as Context;
    apply(ctx);
    return { recorded, routes, cleanups };
  }

  it('注册 guided-goal 命令与两条路由,副作用均进 effect 清理', () => {
    const { recorded, routes, cleanups } = stubCtx();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].name).toBe('guided-goal');
    expect(routes).toHaveLength(2);
    expect(cleanups).toHaveLength(2);
  });

  it('带草稿时 steer 一条含协议与草稿的 user 消息并返回 success', () => {
    const { recorded } = stubCtx();
    const steerCalls: unknown[] = [];
    const result = recorded[0].handler({
      agent: {
        steer(message: unknown): void {
          steerCalls.push(message);
        },
      },
      rawInput: ' 重构鉴权模块 ',
    });

    expect(result.kind).toBe('success');
    expect(steerCalls).toHaveLength(1);
    const message = steerCalls[0] as {
      role: string;
      source: { kind: string };
      content: Array<{ text?: string }>;
    };
    expect(message.role).toBe('user');
    expect(message.source.kind).toBe('user');
    expect(message.content[0]?.text).toContain('引导方式创建');
    expect(message.content[0]?.text).toContain('重构鉴权模块');
  });

  it('空草稿返回 error 且不 steer', () => {
    const { recorded } = stubCtx();
    const steerCalls: unknown[] = [];
    const result = recorded[0].handler({
      agent: {
        steer(message: unknown): void {
          steerCalls.push(message);
        },
      },
      rawInput: '   ',
    });

    expect(result.kind).toBe('error');
    expect(steerCalls).toHaveLength(0);
  });
});

describe('validateFields', () => {
  it('接受完整字段并裁剪空白', () => {
    expect(
      validateFields({
        objective: ' 发布 v1 ',
        successCriteria: '测试全绿',
        verification: 'pnpm test',
        boundaries: '仅 src/',
        stopConditions: '3 轮未过即停',
        maxGoalRounds: '5',
      }),
    ).toEqual({
      fields: {
        objective: '发布 v1',
        successCriteria: '测试全绿',
        verification: 'pnpm test',
        boundaries: '仅 src/',
        stopConditions: '3 轮未过即停',
        maxGoalRounds: '5',
      },
    });
  });

  it('缺必填字段与非整数轮次分别报错', () => {
    expect(validateFields({ successCriteria: 'x' })).toEqual({
      error: 'objective 必填',
    });
    expect(validateFields({ objective: 'x' })).toEqual({
      error: 'successCriteria 必填',
    });
    expect(
      validateFields({
        objective: 'x',
        successCriteria: 'y',
        maxGoalRounds: 'abc',
      }),
    ).toEqual({
      error: 'maxGoalRounds 必须是正整数',
    });
    expect(validateFields(null)).toEqual({ error: 'fields is required' });
  });
});

describe('loopback 路由', () => {
  interface RecordedRoute {
    kind: string;
    path: string;
    handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>;
  }
  interface Recording {
    code: number;
    payload: string;
  }

  function fakeRes(): { res: ServerResponse; out: Recording } {
    const out: Recording = { code: 0, payload: '' };
    const res = {
      statusCode: 0,
      writeHead(code: number): void {
        out.code = code;
      },
      end(payload?: string): void {
        out.payload = payload ?? '';
      },
    } as unknown as ServerResponse;
    return { res, out };
  }

  function fakeReq(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string,
  ): IncomingMessage {
    const request = {
      method,
      url,
      headers,
      socket: { remoteAddress: '127.0.0.1' },
    };
    if (body === undefined) return request as IncomingMessage;
    const chunk = Buffer.from(body);
    return Object.assign(request, {
      [Symbol.asyncIterator]: async function* (): AsyncGenerator<Buffer> {
        yield chunk;
      },
    }) as unknown as IncomingMessage;
  }

  function mounted(agents: AgentRegistryLike): {
    routes: RecordedRoute[];
    dispose: () => void;
  } {
    const routes: RecordedRoute[] = [];
    const dispose = mountRoutes(
      {
        register(route: RecordedRoute): () => void {
          routes.push(route);
          return () => {};
        },
      },
      agents,
    );
    return { routes, dispose };
  }

  function handlerFor(
    routes: RecordedRoute[],
    path: string,
  ): RecordedRoute['handler'] {
    const route = routes.find((r) => r.path === path);
    if (route === undefined) throw new Error(`route not mounted: ${path}`);
    return route.handler;
  }

  it('GET sessions 列出活跃会话,id 兜底标题', async () => {
    const agents = {
      get: () => undefined,
      list: (): readonly { id: string; session: unknown }[] => [
        { id: 's1', session: { title: '重构会话' } },
        { id: 's2', session: {} },
      ],
    };
    const { routes } = mounted(agents);
    const { res, out } = fakeRes();
    await handlerFor(routes, ROUTE_SESSIONS)(
      fakeReq('GET', ROUTE_SESSIONS, { host: '127.0.0.1:3080' }),
      res,
    );
    expect(out.code).toBe(200);
    expect(JSON.parse(out.payload)).toEqual({
      ok: true,
      sessions: [
        { id: 's1', title: '重构会话' },
        { id: 's2', title: 's2' },
      ],
    });
  });

  it('POST create 缺自定义头被 403 拒绝', async () => {
    const { routes } = mounted({ get: () => undefined, list: () => [] });
    const { res, out } = fakeRes();
    await handlerFor(routes, ROUTE_CREATE)(
      fakeReq(
        'POST',
        `${ROUTE_CREATE}?sessionId=s1`,
        { host: '127.0.0.1', origin: 'http://127.0.0.1:3080' },
        '{}',
      ),
      res,
    );
    expect(out.code).toBe(403);
    expect(JSON.parse(out.payload)).toMatchObject({ ok: false });
  });

  it('POST create 缺必填字段返回 400', async () => {
    const { routes } = mounted({ get: () => undefined, list: () => [] });
    const { res, out } = fakeRes();
    await handlerFor(routes, ROUTE_CREATE)(
      fakeReq(
        'POST',
        `${ROUTE_CREATE}?sessionId=s1`,
        {
          host: '127.0.0.1',
          origin: 'http://127.0.0.1:3080',
          [MUTATION_HEADER]: '1',
        },
        JSON.stringify({ fields: { objective: '' } }),
      ),
      res,
    );
    expect(out.code).toBe(400);
    expect(JSON.parse(out.payload)).toMatchObject({
      ok: false,
      error: 'objective 必填',
    });
  });

  it('POST create 对 live 会话注入直建消息,非 live 返回 404', async () => {
    const steerCalls: unknown[] = [];
    const agents = {
      get(
        id: string,
      ):
        | { id: string; session: unknown; steer(message: unknown): void }
        | undefined {
        if (id !== 's1') return undefined;
        return {
          id,
          session: { title: '重构会话' },
          steer(message: unknown): void {
            steerCalls.push(message);
          },
        };
      },
      list: () => [],
    };
    const { routes } = mounted(agents);
    const handler = handlerFor(routes, ROUTE_CREATE);
    const body = JSON.stringify({
      fields: {
        objective: '发布 v1',
        successCriteria: '测试全绿',
        maxGoalRounds: '5',
      },
    });
    const headers = {
      host: '127.0.0.1',
      origin: 'http://127.0.0.1:3080',
      [MUTATION_HEADER]: '1',
    };

    const ok = fakeRes();
    await handler(
      fakeReq('POST', `${ROUTE_CREATE}?sessionId=s1`, headers, body),
      ok.res,
    );
    expect(ok.out.code).toBe(200);
    expect(JSON.parse(ok.out.payload)).toMatchObject({ ok: true });
    expect(steerCalls).toHaveLength(1);
    const message = steerCalls[0] as { content: Array<{ text?: string }> };
    expect(message.content[0]?.text).toContain('## Objective\n发布 v1');
    expect(message.content[0]?.text).toContain('轮次上限:5');

    const missing = fakeRes();
    await handler(
      fakeReq('POST', `${ROUTE_CREATE}?sessionId=nope`, headers, body),
      missing.res,
    );
    expect(missing.out.code).toBe(404);
    expect(steerCalls).toHaveLength(1);
  });
});
