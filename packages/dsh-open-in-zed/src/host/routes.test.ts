import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import {
  registryFace,
  registerOpenInZedRoutes,
  resolveOpenTarget,
  ROUTE_PREFIX,
  type OpenRequestBody,
  type WorkspaceRegistryFace,
  type WorkspaceRow,
} from './routes.ts';

/** A scripted workspace registry. */
function fakeRegistry(
  rows: WorkspaceRow[],
): WorkspaceRegistryFace & { resolveByPathCalls: string[] } {
  const calls: string[] = [];
  return {
    resolveByPathCalls: calls,
    get: (id) => rows.find((row) => row.id === id),
    list: () => [...rows],
    resolveByPath: async (path: string) => {
      calls.push(path);
      return rows.find((row) => row.path === path);
    },
  };
}

/** Collect the routes a mock webServer received. */
function captureRoutes() {
  const routes = new Map<
    string,
    (req: IncomingMessage, res: ServerResponse) => void
  >();
  const ctx = {
    webServer: {
      register: (route: {
        kind: string;
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => void;
      }) => {
        routes.set(`${route.kind} ${route.path}`, route.handler);
        return () => routes.delete(`${route.kind} ${route.path}`);
      },
    },
  };
  return { ctx, routes };
}

/** Minimal request stub with an async-iterable body. */
class MockReq extends EventEmitter {
  method: string;
  readonly chunks: Buffer[];
  private sent = false;

  constructor(method: string, body?: unknown, rawChunks?: Buffer[]) {
    super();
    this.method = method;
    this.chunks =
      rawChunks ??
      (body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [Symbol.asyncIterator](): any {
    return {
      next: (): IteratorResult<Buffer> => {
        if (this.sent) return { done: true, value: undefined };
        this.sent = true;
        return this.chunks.length > 0
          ? { done: false, value: this.chunks[0] }
          : { done: true, value: undefined };
      },
    };
  }
}

/** Minimal response stub capturing the outcome. */
class MockRes {
  status = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;

  writeHead(status: number): unknown {
    this.status = status;
    return this;
  }

  end(body?: string): void {
    this.payload = body === undefined ? undefined : JSON.parse(body);
  }
}

/** Dispatch one request through a captured route. */
async function call(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  method: string,
  body?: unknown,
): Promise<MockRes> {
  const req = new MockReq(method, body);
  const res = new MockRes();
  handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}

const ROWS: WorkspaceRow[] = [
  { id: 'ws-1', path: 'C:\\work\\alpha', title: 'alpha' },
  { id: 'ws-2', path: '/home/u/beta', title: 'beta' },
];

describe('dsh-open-in-zed host/routes', () => {
  describe('registryFace', () => {
    it('把 registry 实体映射为自有字段行', async () => {
      const entity = {
        id: 'ws-1',
        title: 'alpha',
        path: 'C:\\work\\alpha',
      };
      const registry = {
        get: (id: string) => (id === 'ws-1' ? entity : undefined),
        list: () => [entity],
        resolveByPath: async (path: string) =>
          path === entity.path ? entity : undefined,
      } as never;
      const face = registryFace(registry);
      expect(face.get('ws-1')).toEqual({
        id: 'ws-1',
        path: 'C:\\work\\alpha',
        title: 'alpha',
      });
      expect(face.list()).toEqual([face.get('ws-1')]);
      expect(await face.resolveByPath('C:\\work\\alpha')).toEqual(
        face.get('ws-1'),
      );
      expect(await face.resolveByPath('/nope')).toBeUndefined();
    });
  });

  describe('resolveOpenTarget', () => {
    it('workspaceId 优先并命中', async () => {
      const target = await resolveOpenTarget(
        { workspaceId: 'ws-2', path: '/other' },
        fakeRegistry(ROWS),
      );
      expect(target.workspace).toEqual(ROWS[1]);
    });

    it('未知 workspaceId → 404 not_found', async () => {
      await expect(
        resolveOpenTarget({ workspaceId: 'nope' }, fakeRegistry(ROWS)),
      ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    });

    it('已注册 path 命中', async () => {
      const target = await resolveOpenTarget(
        { path: 'C:\\work\\alpha' },
        fakeRegistry(ROWS),
      );
      expect(target.workspace.id).toBe('ws-1');
    });

    it('未注册 path → 403 forbidden', async () => {
      await expect(
        resolveOpenTarget({ path: 'C:\\Windows' }, fakeRegistry(ROWS)),
      ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    });

    it('两者都缺 → 400 invalid_input', async () => {
      await expect(
        resolveOpenTarget({} as OpenRequestBody, fakeRegistry(ROWS)),
      ).rejects.toMatchObject({ status: 400, code: 'invalid_input' });
    });
  });

  describe('registerOpenInZedRoutes', () => {
    it('注册三条 exact 路由且 disposer 注销', () => {
      const { ctx, routes } = captureRoutes();
      const dispose = registerOpenInZedRoutes(ctx as never, {
        registry: fakeRegistry(ROWS),
      });
      expect([...routes.keys()].sort()).toEqual(
        [
          `exact ${ROUTE_PREFIX}/open`,
          `exact ${ROUTE_PREFIX}/status`,
          `exact ${ROUTE_PREFIX}/workspaces`,
        ].sort(),
      );
      dispose();
      expect(routes.size).toBe(0);
    });

    it('POST /open 成功回传 workspace 与 command', async () => {
      const { ctx, routes } = captureRoutes();
      const runner = async (
        _file: string,
        args: readonly string[],
      ): Promise<{ stdout: string; stderr: string }> => {
        expect(args).toEqual(['C:\\work\\alpha']);
        return { stdout: '', stderr: '' };
      };
      registerOpenInZedRoutes(ctx as never, {
        registry: fakeRegistry(ROWS),
        runner,
      });
      const res = await call(
        routes.get(`exact ${ROUTE_PREFIX}/open`)!,
        'POST',
        { path: 'C:\\work\\alpha' },
      );
      expect(res.status).toBe(200);
      expect(res.payload).toEqual({
        ok: true,
        value: {
          workspace: { id: 'ws-1', title: 'alpha' },
          path: 'C:\\work\\alpha',
          command: ['zed', 'C:\\work\\alpha'],
        },
      });
    });

    it('POST /open 未知工作区 → 404 信封', async () => {
      const { ctx, routes } = captureRoutes();
      registerOpenInZedRoutes(ctx as never, {
        registry: fakeRegistry(ROWS),
      });
      const res = await call(
        routes.get(`exact ${ROUTE_PREFIX}/open`)!,
        'POST',
        { workspaceId: 'ghost' },
      );
      expect(res.status).toBe(404);
      expect(res.payload.ok).toBe(false);
      expect(res.payload.error.code).toBe('not_found');
    });

    it('POST /open 未注册路径 → 403 forbidden', async () => {
      const { ctx, routes } = captureRoutes();
      registerOpenInZedRoutes(ctx as never, {
        registry: fakeRegistry(ROWS),
      });
      const res = await call(
        routes.get(`exact ${ROUTE_PREFIX}/open`)!,
        'POST',
        { path: 'C:\\Windows\\System32' },
      );
      expect(res.status).toBe(403);
      expect(res.payload.error.code).toBe('forbidden');
    });

    it('POST /open zed 缺失（ENOENT）→ 500 zed-not-found 且消息带指引', async () => {
      const { ctx, routes } = captureRoutes();
      const runner = async (): Promise<{ stdout: string; stderr: string }> => {
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      };
      registerOpenInZedRoutes(ctx as never, {
        registry: fakeRegistry(ROWS),
        runner,
      });
      const res = await call(
        routes.get(`exact ${ROUTE_PREFIX}/open`)!,
        'POST',
        { workspaceId: 'ws-1' },
      );
      expect(res.status).toBe(500);
      expect(res.payload.error.code).toBe('zed-not-found');
      expect(res.payload.error.message).toContain('DSH_OPEN_IN_ZED_BIN');
    });

    it('POST /open zed 超时 → 504', async () => {
      const { ctx, routes } = captureRoutes();
      const runner = async (): Promise<{ stdout: string; stderr: string }> => {
        throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
      };
      registerOpenInZedRoutes(ctx as never, {
        registry: fakeRegistry(ROWS),
        runner,
      });
      const res = await call(
        routes.get(`exact ${ROUTE_PREFIX}/open`)!,
        'POST',
        { workspaceId: 'ws-1' },
      );
      expect(res.status).toBe(504);
      expect(res.payload.error.code).toBe('zed-timeout');
    });

    it('POST /open 坏 JSON → 400', async () => {
      const { ctx, routes } = captureRoutes();
      registerOpenInZedRoutes(ctx as never, {
        registry: fakeRegistry(ROWS),
      });
      const handler = routes.get(`exact ${ROUTE_PREFIX}/open`)!;
      const res = new MockRes();
      const broken = new MockReq('POST', undefined, [
        Buffer.from('{oops', 'utf8'),
      ]);
      handler(
        broken as unknown as IncomingMessage,
        res as unknown as ServerResponse,
      );
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(res.status).toBe(400);
      expect(res.payload.error.code).toBe('invalid_input');
    });

    it('GET /status 走注入 runner 并回传可用性', async () => {
      const { ctx, routes } = captureRoutes();
      const runner = async (): Promise<{ stdout: string; stderr: string }> => ({
        stdout: 'Zed 0.170.0\n',
        stderr: '',
      });
      registerOpenInZedRoutes(ctx as never, {
        registry: fakeRegistry(ROWS),
        runner,
      });
      const res = await call(
        routes.get(`exact ${ROUTE_PREFIX}/status`)!,
        'GET',
      );
      expect(res.status).toBe(200);
      expect(res.payload).toEqual({
        ok: true,
        value: { available: true, bin: 'zed', version: 'Zed 0.170.0' },
      });
    });

    it('GET /workspaces 回传注册表行', async () => {
      const { ctx, routes } = captureRoutes();
      registerOpenInZedRoutes(ctx as never, {
        registry: fakeRegistry(ROWS),
      });
      const res = await call(
        routes.get(`exact ${ROUTE_PREFIX}/workspaces`)!,
        'GET',
      );
      expect(res.status).toBe(200);
      expect(res.payload).toEqual({ ok: true, value: ROWS });
    });

    it('方法不允许 → 405', async () => {
      const { ctx, routes } = captureRoutes();
      registerOpenInZedRoutes(ctx as never, {
        registry: fakeRegistry(ROWS),
      });
      const res = await call(routes.get(`exact ${ROUTE_PREFIX}/open`)!, 'GET');
      expect(res.status).toBe(405);
    });
  });
});
