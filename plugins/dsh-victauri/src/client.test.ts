import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { VictauriClient, DEFAULT_TIMEOUT_MS, connectAuto } from './client.ts';
import {
  VictauriError,
  VictauriHttpError,
  VictauriTimeoutError,
} from './errors.ts';

const GOOD_TOKEN = 'tok-good';

/** 可编程 mock victauri 服务:按 (method, path) 分派响应。 */
async function startServer(
  routes: Record<
    string,
    { status?: number; body: string; delayMs?: number; needAuth?: boolean }
  >,
): Promise<{ server: Server; url: string }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const key = `${req.method} ${req.url ?? ''}`;
    const route = routes[key];
    void Promise.resolve().then(async () => {
      if (!route) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found', key }));
        return;
      }
      if (route.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, route.delayMs));
      }
      if (route.needAuth === true) {
        const auth = req.headers['authorization'];
        if (auth !== `Bearer ${GOOD_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
      }
      res.writeHead(route.status ?? 200, {
        'Content-Type': 'application/json',
      });
      res.end(route.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${String(addr.port)}` };
}

describe('dsh-victauri client', () => {
  it('health 探活无认证:200→true,连接失败→false', async () => {
    const { server, url } = await startServer({
      'GET /health': { body: '{"status":"ok"}' },
    });
    const client = new VictauriClient({ baseUrl: url, token: 'any' });
    expect(await client.health()).toBe(true);
    const dead = new VictauriClient({
      baseUrl: 'http://127.0.0.1:1',
      token: 'any',
      timeoutMs: 500,
    });
    expect(await dead.health()).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('info 带认证探活:配对 token 200,错 token 抛 http-error 401', async () => {
    const { server, url } = await startServer({
      'GET /info': {
        needAuth: true,
        body: '{"name":"victauri","port":7373,"version":"0.10.2"}',
      },
    });
    const good = new VictauriClient({ baseUrl: url, token: GOOD_TOKEN });
    const info = await good.info();
    expect(info['name']).toBe('victauri');
    expect(info['version']).toBe('0.10.2');
    const bad = new VictauriClient({ baseUrl: url, token: 'tok-wrong' });
    try {
      await bad.info();
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(VictauriHttpError);
      expect((err as VictauriHttpError).status).toBe(401);
      // M-1(backlog-A):401 按 status 细分为 auth
      expect((err as VictauriHttpError).kind).toBe('auth');
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('info 响应是 JSON 但不是对象时抛 tool-error（探活口径：/info 必须是 JSON 对象）', async () => {
    // 这是 /apps 探活判「死」的关键分支：端口可达、token 配对，但响应体
    // 不是 JSON 对象（数组/标量）→ 不能当作活体。
    const { server, url } = await startServer({
      'GET /info': { needAuth: true, body: '[]' },
    });
    const client = new VictauriClient({ baseUrl: url, token: GOOD_TOKEN });
    await expect(client.info()).rejects.toMatchObject({
      kind: 'tool-error',
      message: expect.stringContaining('info: expected JSON object'),
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('listTools 解析工具数组;非数组响应抛 tool-error', async () => {
    const { server, url } = await startServer({
      'GET /api/tools': {
        needAuth: true,
        body: '[{"name":"eval_js","description":"run js"},{"name":"css","description":"css tool"}]',
      },
    });
    const client = new VictauriClient({ baseUrl: url, token: GOOD_TOKEN });
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['eval_js', 'css']);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const { server: s2, url: url2 } = await startServer({
      'GET /api/tools': { body: '{"unexpected":"object"}' },
    });
    const client2 = new VictauriClient({ baseUrl: url2, token: GOOD_TOKEN });
    await expect(client2.listTools()).rejects.toMatchObject({
      kind: 'tool-error',
    });
    await new Promise<void>((resolve) => s2.close(() => resolve()));
  });

  it('callTool 解包 {result} 包裹;无包裹响应原样返回', async () => {
    const { server, url } = await startServer({
      'POST /api/tools/get_plugin_info': {
        needAuth: true,
        body: '{"result":{"bridge_version":"0.10.2","port":7373}}',
      },
      'POST /api/tools/bare': { needAuth: true, body: '{"direct":true}' },
    });
    const client = new VictauriClient({ baseUrl: url, token: GOOD_TOKEN });
    const unwrapped = await client.callTool('get_plugin_info');
    expect(unwrapped).toEqual({ bridge_version: '0.10.2', port: 7373 });
    const bare = await client.callTool('bare');
    expect(bare).toEqual({ direct: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('backlog-A M-1:VictauriHttpError 按 status 机械细分 kind(400/401/403/404/429/5xx)', () => {
    expect(new VictauriHttpError(400, 'bad', 'ctx').kind).toBe(
      'invalid-params',
    );
    expect(new VictauriHttpError(401, 'unauth', 'ctx').kind).toBe('auth');
    expect(new VictauriHttpError(403, 'forbidden', 'ctx').kind).toBe('auth');
    expect(new VictauriHttpError(404, 'nope', 'ctx').kind).toBe('not-found');
    expect(new VictauriHttpError(429, 'slow down', 'ctx').kind).toBe(
      'rate-limited',
    );
    expect(new VictauriHttpError(500, 'boom', 'ctx').kind).toBe('http-error');
    expect(new VictauriHttpError(503, 'unavailable', 'ctx').kind).toBe(
      'http-error',
    );
    expect(new VictauriHttpError(405, 'method', 'ctx').kind).toBe('http-error');
  });

  it('backlog-A S-1:HTTP 200 顶层 {"error"} 归一为 tool-error 结构化错误,不再当数据透出', async () => {
    const { server, url } = await startServer({
      'POST /api/tools/eval_js': {
        needAuth: true,
        body: '{"error":"eval timed out after 30s"}',
      },
      'POST /api/tools/objerr': {
        needAuth: true,
        body: '{"error":{"code":42}}',
      },
      'POST /api/tools/multi': {
        needAuth: true,
        body: '{"result":[{"type":"text","text":"x"}]}',
      },
    });
    const client = new VictauriClient({ baseUrl: url, token: GOOD_TOKEN });
    // string error → 摘要原样进 message
    try {
      await client.callTool('eval_js');
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(VictauriError);
      expect((err as VictauriError).kind).toBe('tool-error');
      expect((err as Error).message).toContain(
        'callTool(eval_js): upstream tool-level failure: eval timed out after 30s',
      );
    }
    // 非 string error → JSON 摘要
    try {
      await client.callTool('objerr');
      expect.unreachable('should throw');
    } catch (err) {
      expect((err as VictauriError).kind).toBe('tool-error');
      expect((err as Error).message).toContain('{"code":42}');
    }
    // 正常 {result} 信封与多内容块不受影响
    expect(await client.callTool('multi')).toEqual([
      { type: 'text', text: 'x' },
    ]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('callTool 入参以 JSON body 透传,服务端 500 时抛带 status/bodyPreview 的 http-error', async () => {
    let seenBody = '';
    const { server, url } = await startServer({});
    // 自定义 handler 检查请求体:startServer 的 route 表做不到,直接监听
    server.removeAllListeners('request');
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      let chunks = '';
      req.on('data', (chunk: Buffer) => {
        chunks += chunk.toString('utf8');
      });
      req.on('end', () => {
        if (req.url === '/api/tools/eval_js') {
          seenBody = chunks;
          const auth = req.headers['authorization'];
          if (auth !== `Bearer ${GOOD_TOKEN}`) {
            res.writeHead(401);
            res.end('{}');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"result":"TITLE"}');
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end('{"error":"boom"}');
        }
      });
    });
    const client = new VictauriClient({ baseUrl: url, token: GOOD_TOKEN });
    const value = await client.callTool('eval_js', { code: 'document.title' });
    expect(value).toBe('TITLE');
    expect(seenBody).toBe('{"code":"document.title"}');
    await expect(client.callTool('other_tool')).rejects.toMatchObject({
      status: 500,
      bodyPreview: '{"error":"boom"}',
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('响应超时抛 VictauriTimeoutError', async () => {
    const { server, url } = await startServer({
      'POST /api/tools/slow': { body: '{"result":1}', delayMs: 400 },
    });
    const client = new VictauriClient({
      baseUrl: url,
      token: GOOD_TOKEN,
      timeoutMs: 80,
    });
    try {
      await client.callTool('slow');
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(VictauriTimeoutError);
      expect((err as VictauriTimeoutError).timeoutMs).toBe(80);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('connectAuto 按 started_at 降序探活并选中配对实例', async () => {
    const { server } = await startServer({
      'GET /info': {
        needAuth: true,
        body: '{"name":"victauri","version":"0.10.2"}',
      },
    });
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } =
      await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'victauri-connect-'));
    const port = (server.address() as AddressInfo).port;
    const writeInstance = (
      pid: number,
      token: string,
      startedAt: string,
    ): void => {
      const dir = join(root, String(pid));
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'metadata.json'),
        JSON.stringify({
          identifier: 'com.example.app',
          pid,
          port,
          product_name: 'demo',
          started_at: startedAt,
          version: '0.10.2',
        }),
        'utf8',
      );
      writeFileSync(join(dir, 'port'), String(port), 'utf8');
      writeFileSync(join(dir, 'token'), token, 'utf8');
    };
    // stale 目录(错误 token,时间戳最新)+ 活目录(正确 token)
    writeInstance(900, 'tok-stale', '2026-11-02T10:00:00.000Z');
    writeInstance(901, GOOD_TOKEN, '2026-11-02T09:00:00.000Z');
    const { instance } = await connectAuto({
      rootDir: root,
      timeoutMs: 1000,
    });
    expect(instance.pid).toBe(901);
    expect(instance.token).toBe(GOOD_TOKEN);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  it('connectAuto:无候选抛 no-instance,全部探活失败抛 no-live-instance', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } =
      await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'victauri-connect2-'));
    try {
      await connectAuto({ rootDir: root });
      expect.unreachable('should throw');
    } catch (err) {
      expect((err as VictauriError).kind).toBe('no-instance');
    }
    // 一个候选但指向死端口
    const dir = join(root, '700');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'metadata.json'),
      JSON.stringify({
        identifier: 'com.example.app',
        pid: 700,
        port: 1,
        product_name: 'demo',
        started_at: '2026-11-02T08:00:00.000Z',
        version: '0.10.2',
      }),
      'utf8',
    );
    writeFileSync(join(dir, 'port'), '1', 'utf8');
    writeFileSync(join(dir, 'token'), 'tok-x', 'utf8');
    try {
      await connectAuto({ rootDir: root, timeoutMs: 300 });
      expect.unreachable('should throw');
    } catch (err) {
      expect((err as VictauriError).kind).toBe('no-live-instance');
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('DEFAULT_TIMEOUT_MS 为 30 秒量级', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
  });

  it('VictauriClient.forPort 按「端口 + token」显式构造独立实例', async () => {
    const { server, url } = await startServer({
      'GET /health': { body: '{"status":"ok"}' },
      'GET /info': { needAuth: true, body: '{"name":"victauri"}' },
    });
    const port = Number.parseInt(new URL(url).port, 10);
    const client = VictauriClient.forPort(port, GOOD_TOKEN, {
      timeoutMs: 1_000,
    });
    expect(client.port).toBe(port);
    expect(await client.health()).toBe(true);
    expect((await client.info())['name']).toBe('victauri');

    // 多实例并存：各自持有自己的 token，互不影响
    const other = VictauriClient.forPort(port, 'tok-other');
    expect(other.port).toBe(port);
    await expect(other.info()).rejects.toMatchObject({ status: 401 });
    expect(await client.health()).toBe(true);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('fromInstance 继承实例端口；直接 new 时 port 为 null', async () => {
    const { server, url } = await startServer({
      'GET /health': { body: '{"status":"ok"}' },
    });
    const port = Number.parseInt(new URL(url).port, 10);
    const fromInstance = VictauriClient.fromInstance({
      pid: 4242,
      port,
      token: GOOD_TOKEN,
      identifier: 'com.example.demo',
      productName: 'demo',
      startedAt: '2026-11-02T10:00:00.000Z',
      version: '0.10.2',
      dir: '/tmp/victauri/4242',
    });
    expect(fromInstance.port).toBe(port);
    expect(await fromInstance.health()).toBe(true);

    const plain = new VictauriClient({ baseUrl: url, token: GOOD_TOKEN });
    expect(plain.port).toBeNull();

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
