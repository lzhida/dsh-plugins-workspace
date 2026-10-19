/**
 * client.ts 行为测试：全部 HTTP 语义（头/查询/错误归一/取消/超时/截断）
 * 与双后端解析（auto 回退、鉴权不回退、干预钩子、探测），用注入的按端口
 * 路由的 fetch 假体验证，绝不触网。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  AnytypeClient,
  AnytypeError,
  buildUrl,
  toToolValue,
  type ClientConfig,
  type FetchLike,
} from './client.ts';

/** 桌面端/CLI 假地址（按端口路由 mock 响应）。 */
const DESKTOP_URL = 'http://127.0.0.1:31009';
const CLI_URL = 'http://127.0.0.1:31012';

/** 组装客户端配置：默认 auto + 仅 desktop 配置 key（等价旧行为）。 */
function makeConfig(overrides?: {
  mode?: ClientConfig['backendMode'];
  desktopKey?: string;
  cliKey?: string;
}): ClientConfig {
  return {
    apiVersion: '2025-11-08',
    timeoutMs: 5000,
    backendMode: overrides?.mode ?? 'auto',
    desktop: { url: DESKTOP_URL, key: overrides?.desktopKey ?? 'test-key' },
    cli: { url: CLI_URL, key: overrides?.cliKey ?? '' },
  };
}

/** 按端口路由的捕获式 fetch 假体工厂。 */
function routedFetch(responder: {
  desktop: (url: string, init: RequestInit) => Response | Promise<Response>;
  cli?: (url: string, init: RequestInit) => Response | Promise<Response>;
}): {
  fetchImpl: FetchLike;
  desktopCalls: Array<{ url: string; init: RequestInit }>;
  cliCalls: Array<{ url: string; init: RequestInit }>;
} {
  const desktopCalls: Array<{ url: string; init: RequestInit }> = [];
  const cliCalls: Array<{ url: string; init: RequestInit }> = [];
  const fallbackThrow = (): never => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:31012');
  };
  const fetchImpl: FetchLike = async (url, init) => {
    const isDesktop = url.includes(':31009');
    const target = isDesktop ? desktopCalls : cliCalls;
    target.push({ url, init });
    const handler = isDesktop
      ? responder.desktop
      : (responder.cli ?? fallbackThrow);
    return handler(url, init);
  };
  return { fetchImpl, desktopCalls, cliCalls };
}

/** 200 JSON 响应。 */
function ok(body: unknown, etag?: string): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (etag !== undefined) headers.etag = etag;
  return new Response(JSON.stringify(body), { status: 200, headers });
}

const noSignal = new AbortController().signal;

describe('dsh-anytype client', () => {
  describe('buildUrl', () => {
    it('拼接 baseUrl/path 并序列化 query（跳过 undefined/null）', () => {
      const url = buildUrl('http://127.0.0.1:31009', '/v2/spaces', {
        limit: 25,
        offset: 0,
        fields: 'id,name',
        skip: undefined,
        empty: null,
      });
      expect(url).toBe(
        'http://127.0.0.1:31009/v2/spaces?limit=25&offset=0&fields=id%2Cname',
      );
    });

    it('path 不以 / 开头时抛 AnytypeError', () => {
      expect(() => buildUrl('http://x', 'v2/spaces')).toThrow(AnytypeError);
    });
  });

  describe('request 头部与请求体（desktop 单后端）', () => {
    it('带 Authorization/Anytype-Version，有 body 时才补 Content-Type，结果带 backend', async () => {
      const { fetchImpl, desktopCalls } = routedFetch({
        desktop: () => ok({ data: [1] }),
      });
      const client = new AnytypeClient(() => makeConfig(), fetchImpl);
      const result = await client.request('POST', '/v2/search', {
        body: { query: 'x' },
        signal: noSignal,
      });

      expect(result.status).toBe(200);
      expect(result.backend).toBe('desktop');
      expect(result.data).toEqual({ data: [1] });
      expect(desktopCalls[0]?.url).toBe(`${DESKTOP_URL}/v2/search`);
      const headers = desktopCalls[0]?.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-key');
      expect(headers['Anytype-Version']).toBe('2025-11-08');
      expect(headers['Content-Type']).toBe('application/json');
      expect(desktopCalls[0]?.init.body).toBe(JSON.stringify({ query: 'x' }));
    });

    it('expectedEtag 映射为 If-Match 头，响应 etag 进入结果', async () => {
      const { fetchImpl, desktopCalls } = routedFetch({
        desktop: () => ok({ ok: true }, '"v7"'),
      });
      const client = new AnytypeClient(() => makeConfig(), fetchImpl);
      const result = await client.request('PATCH', '/v2/spaces/abc', {
        body: { name: 'n' },
        expectedEtag: '"v6"',
        signal: noSignal,
      });

      const headers = desktopCalls[0]?.init.headers as Record<string, string>;
      expect(headers['If-Match']).toBe('"v6"');
      expect(result.etag).toBe('"v7"');
    });
  });

  describe('双后端解析', () => {
    it('auto：desktop 网络失败且 CLI 已配置 → 切换 CLI 成功（backend=cli）', async () => {
      const { fetchImpl, desktopCalls, cliCalls } = routedFetch({
        desktop: () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:31009');
        },
        cli: () => ok({ spaces: 1 }),
      });
      const client = new AnytypeClient(
        () => makeConfig({ cliKey: 'bot-key' }),
        fetchImpl,
      );
      const result = await client.request('GET', '/v2/spaces', {
        signal: noSignal,
      });

      expect(result.backend).toBe('cli');
      expect(result.data).toEqual({ spaces: 1 });
      expect(desktopCalls).toHaveLength(1);
      const headers = cliCalls[0]?.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer bot-key');
      expect(cliCalls[0]?.url).toBe(`${CLI_URL}/v2/spaces`);
    });

    it('auto：desktop 鉴权失败（401）不切换后端，原样上抛', async () => {
      const { fetchImpl, cliCalls } = routedFetch({
        desktop: () =>
          new Response(JSON.stringify({ code: 'UNAUTHORIZED' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
        cli: () => ok({ should: 'not-here' }),
      });
      const client = new AnytypeClient(
        () => makeConfig({ cliKey: 'bot-key' }),
        fetchImpl,
      );
      const err = await client
        .request('GET', '/v2/spaces', { signal: noSignal })
        .catch((e: unknown) => e as AnytypeError);

      expect(err).toBeInstanceOf(AnytypeError);
      expect((err as AnytypeError).status).toBe(401);
      expect(cliCalls).toHaveLength(0);
    });

    it('auto：两后端都不可达 → 聚合 NETWORK 错误（含 CLI 启动指引）', async () => {
      const { fetchImpl } = routedFetch({
        desktop: () => {
          throw new Error('ECONNREFUSED');
        },
        cli: () => {
          throw new Error('ECONNREFUSED');
        },
      });
      const client = new AnytypeClient(
        () => makeConfig({ cliKey: 'bot-key' }),
        fetchImpl,
      );
      const err = await client
        .request('GET', '/v2/spaces', { signal: noSignal })
        .catch((e: unknown) => e as AnytypeError);

      expect((err as AnytypeError).body.code).toBe('NETWORK');
      expect((err as Error).message).toContain('anytype service start');
    });

    it('auto：CLI 未配置（cliKey 空）→ 不探测 CLI，desktop 失败即报错', async () => {
      const { fetchImpl, cliCalls } = routedFetch({
        desktop: () => {
          throw new Error('ECONNREFUSED');
        },
      });
      const client = new AnytypeClient(() => makeConfig(), fetchImpl);
      const err = await client
        .request('GET', '/v2/spaces', { signal: noSignal })
        .catch((e: unknown) => e as AnytypeError);

      expect((err as AnytypeError).body.code).toBe('NETWORK');
      expect(cliCalls).toHaveLength(0);
    });

    it('显式 desktop/cli 模式只打各自后端', async () => {
      const { fetchImpl, desktopCalls, cliCalls } = routedFetch({
        desktop: () => ok({ from: 'desktop' }),
        cli: () => ok({ from: 'cli' }),
      });
      const desktopOnly = new AnytypeClient(
        () => makeConfig({ mode: 'desktop', cliKey: 'bot' }),
        fetchImpl,
      );
      const r1 = await desktopOnly.request('GET', '/v2/who', {
        signal: noSignal,
      });
      expect(r1.backend).toBe('desktop');
      expect(cliCalls).toHaveLength(0);

      const cliOnly = new AnytypeClient(
        () => makeConfig({ mode: 'cli', cliKey: 'bot' }),
        fetchImpl,
      );
      const r2 = await cliOnly.request('GET', '/v2/who', { signal: noSignal });
      expect(r2.backend).toBe('cli');
      expect(r2.data).toEqual({ from: 'cli' });
      expect(desktopCalls).toHaveLength(1);
    });

    it('auto：双 key 均未配置 → CONFIG_MISSING_KEY（不发请求）', async () => {
      const { fetchImpl, desktopCalls } = routedFetch({
        desktop: () => ok({}),
      });
      const client = new AnytypeClient(
        () => makeConfig({ desktopKey: '', cliKey: '' }),
        fetchImpl,
      );
      await expect(
        client.request('GET', '/v2/spaces', { signal: noSignal }),
      ).rejects.toThrow(/no backend API key is configured/);
      expect(desktopCalls).toHaveLength(0);
    });

    it('干预钩子：desktop 网络失败触发一次，冷却期内不重复触发；恢复后重试成功', async () => {
      let desktopUp = false;
      const hook = vi.fn((): Promise<boolean> => {
        desktopUp = true;
        return Promise.resolve(true);
      });
      const { fetchImpl, desktopCalls } = routedFetch({
        desktop: () => {
          if (desktopUp) return ok({ recovered: true });
          throw new Error('ECONNREFUSED');
        },
      });
      const client = new AnytypeClient(() => makeConfig(), fetchImpl, hook);

      const first = await client.request('GET', '/v2/spaces', {
        signal: noSignal,
      });
      expect(first.backend).toBe('desktop');
      expect(first.data).toEqual({ recovered: true });
      expect(hook).toHaveBeenCalledTimes(1);
      expect(desktopCalls).toHaveLength(2);

      // 冷却期内第二次失败不再触发钩子
      desktopUp = false;
      const err = await client
        .request('GET', '/v2/spaces', { signal: noSignal })
        .catch((e: unknown) => e as AnytypeError);
      expect((err as AnytypeError).body.code).toBe('NETWORK');
      expect(hook).toHaveBeenCalledTimes(1);
    });
  });

  describe('错误归一', () => {
    it('候选 key 为空时（显式 desktop 模式）报 CONFIG_MISSING_KEY（不发请求）', async () => {
      const { fetchImpl, desktopCalls } = routedFetch({
        desktop: () => ok({}),
      });
      const client = new AnytypeClient(
        () => makeConfig({ mode: 'desktop', desktopKey: '' }),
        fetchImpl,
      );
      await expect(
        client.request('GET', '/v2/spaces', { signal: noSignal }),
      ).rejects.toThrow(/no API key configured/);
      expect(desktopCalls).toHaveLength(0);
    });

    it('非 2xx 响应归一为 AnytypeError（status + code/message/hints）', async () => {
      const { fetchImpl } = routedFetch({
        desktop: () =>
          new Response(
            JSON.stringify({
              code: 'UNAUTHORIZED',
              message: 'bad key',
              hints: ['create a key in Anytype'],
            }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          ),
      });
      const client = new AnytypeClient(() => makeConfig(), fetchImpl);
      const err = await client
        .request('GET', '/v2/spaces', { signal: noSignal })
        .catch((e: unknown) => e as AnytypeError);

      expect(err).toBeInstanceOf(AnytypeError);
      expect((err as AnytypeError).status).toBe(401);
      expect((err as AnytypeError).body.code).toBe('UNAUTHORIZED');
      expect((err as Error).message).toContain('Anytype API 401 UNAUTHORIZED');
      expect((err as Error).message).toContain('bad key');
      expect((err as Error).message).toContain('create a key in Anytype');
    });

    it('连接失败给出双后端可操作提示', async () => {
      const { fetchImpl } = routedFetch({
        desktop: () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:31009');
        },
      });
      const client = new AnytypeClient(() => makeConfig(), fetchImpl);
      const err = await client
        .request('GET', '/v2/auth/whoami', { signal: noSignal })
        .catch((e: unknown) => e as AnytypeError);

      expect((err as AnytypeError).status).toBe(0);
      expect((err as AnytypeError).body.code).toBe('NETWORK');
      expect((err as Error).message).toContain('desktop app');
      expect((err as Error).message).toContain('anytype service start');
    });

    it('请求超时归一为 TIMEOUT', async () => {
      // 假体遵守 init.signal（与真实 fetch 一致）：组合信号中止即以
      // signal.reason（AbortSignal.timeout → TimeoutError）拒绝。
      const { fetchImpl } = routedFetch({
        desktop: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init.signal as AbortSignal;
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          }),
      });
      const client = new AnytypeClient(
        () => ({ ...makeConfig(), timeoutMs: 20 }),
        fetchImpl,
      );
      const err = await client
        .request('GET', '/v2/spaces', { signal: noSignal })
        .catch((e: unknown) => e as AnytypeError);

      expect((err as AnytypeError).body.code).toBe('TIMEOUT');
      expect((err as Error).message).toContain('timed out');
    }, 5000);

    it('调用方取消归一为 ABORTED（优先于超时分支）', async () => {
      const controller = new AbortController();
      const { fetchImpl } = routedFetch({
        desktop: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init.signal as AbortSignal;
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          }),
      });
      const client = new AnytypeClient(
        () => ({ ...makeConfig(), timeoutMs: 60_000 }),
        fetchImpl,
      );
      const pending = client.request('GET', '/v2/spaces', {
        signal: controller.signal,
      });
      controller.abort();
      const err = await pending.catch((e: unknown) => e as AnytypeError);
      expect((err as AnytypeError).body.code).toBe('ABORTED');
    });
  });

  describe('响应体解析', () => {
    it('204 返回 null；非 JSON content-type 的 JSON 形文本仍解析', async () => {
      const { fetchImpl } = routedFetch({
        desktop: () => new Response(null, { status: 204 }),
      });
      const client = new AnytypeClient(() => makeConfig(), fetchImpl);
      const r1 = await client.request('DELETE', '/v2/spaces/x/objects/y', {
        signal: noSignal,
      });
      expect(r1.data).toBeNull();

      const { fetchImpl: fetch2 } = routedFetch({
        desktop: () =>
          new Response('{"weird":"no content type"}', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          }),
      });
      const r2 = await new AnytypeClient(() => makeConfig(), fetch2).request(
        'GET',
        '/v2/anything',
        { signal: noSignal },
      );
      expect(r2.data).toEqual({ weird: 'no content type' });
    });

    it('非法 JSON 回退为纯文本（不抛解析错误）', async () => {
      const { fetchImpl } = routedFetch({
        desktop: () =>
          new Response('{"broken"', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      });
      const result = await new AnytypeClient(
        () => makeConfig(),
        fetchImpl,
      ).request('GET', '/v2/x', { signal: noSignal });
      expect(result.data).toBe('{"broken"');
    });
  });

  describe('toToolValue 截断', () => {
    it('未超限原样透传 data/etag/backend', () => {
      const value = toToolValue(
        { status: 200, data: { a: 1 }, etag: '"e"', backend: 'desktop' },
        10_000,
      );
      expect(value).toEqual({
        status: 200,
        data: { a: 1 },
        etag: '"e"',
        backend: 'desktop',
      });
    });

    it('无 etag 时整键省略（registry 无损 JSON 校验拒绝 undefined 属性）', () => {
      const value = toToolValue(
        { status: 200, data: { ok: true }, backend: 'cli' },
        10_000,
      );
      expect(Object.keys(value)).not.toContain('etag');
      // 无损 JSON 安全：键集在 JSON 往返后保持一致
      const round = JSON.parse(JSON.stringify(value)) as Record<
        string,
        unknown
      >;
      expect(Object.keys(round).sort()).toEqual(Object.keys(value).sort());
    });

    it('超限替换为 data_preview 并带 truncated 标记（保持合法 JSON）', () => {
      const big = { data: 'x'.repeat(50_000) };
      const value = toToolValue(
        { status: 200, data: big, backend: 'desktop' },
        1000,
      );
      expect(value.truncated).toBe(true);
      expect(value.data).toBeUndefined();
      expect(value.data_preview).toBeDefined();
      expect(value.data_preview?.length).toBeLessThanOrEqual(1100);
      expect(() => JSON.parse(JSON.stringify(value))).not.toThrow();
      // 无 etag 的截断值同样不得携带 etag 键
      const noEtag = toToolValue(
        { status: 200, data: big, backend: 'desktop' },
        1000,
      );
      expect(Object.keys(noEtag)).not.toContain('etag');
    });
  });

  describe('probeAll（anytype_status 数据源）', () => {
    it('desktop 可达且鉴权、CLI 未配置 → effective=desktop', async () => {
      const { fetchImpl } = routedFetch({
        desktop: () => ok({ key: {} }),
      });
      const client = new AnytypeClient(() => makeConfig(), fetchImpl);
      const probes = await client.probeAll();

      expect(probes.desktop.configured).toBe(true);
      expect(probes.desktop.reachable).toBe(true);
      expect(probes.desktop.authenticated).toBe(true);
      expect(probes.cli.configured).toBe(false);
      expect(probes.effective).toBe('desktop');
    });

    it('desktop 不可达、CLI 可达 → effective=cli', async () => {
      const { fetchImpl } = routedFetch({
        desktop: () => {
          throw new Error('ECONNREFUSED');
        },
        cli: () => ok({ key: {} }),
      });
      const client = new AnytypeClient(
        () => makeConfig({ cliKey: 'bot' }),
        fetchImpl,
      );
      const probes = await client.probeAll();

      expect(probes.desktop.reachable).toBe(false);
      expect(probes.cli.reachable).toBe(true);
      expect(probes.effective).toBe('cli');
    });

    it('探测请求带各自 key 且打到 whoami', async () => {
      const { fetchImpl, cliCalls } = routedFetch({
        desktop: () => ok({}),
        cli: () => ok({}),
      });
      const client = new AnytypeClient(
        () => makeConfig({ cliKey: 'bot' }),
        fetchImpl,
      );
      await client.probeAll();
      const headers = cliCalls[0]?.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer bot');
      expect(cliCalls[0]?.url).toBe(`${CLI_URL}/v2/auth/whoami`);
    });
  });
});
