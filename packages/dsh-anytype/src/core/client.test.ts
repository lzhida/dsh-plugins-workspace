/**
 * client.ts 行为测试：全部 HTTP 语义（头/查询/错误归一/取消/超时/截断）
 * 用注入的 fetch 假体验证，绝不触网。
 */

import { describe, expect, it } from 'vitest';

import {
  AnytypeClient,
  AnytypeError,
  buildUrl,
  toToolValue,
  type FetchLike,
} from './client.ts';

/** 记录请求的 fetch 假体工厂：返回可编程响应并收集调用。 */
function captureFetch(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetchImpl: FetchLike; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  return { fetchImpl, calls };
}

/** 构造固定选项的客户端。 */
function clientWith(
  fetchImpl: FetchLike,
  overrides?: Partial<{ apiKey: string; timeoutMs: number }>,
): AnytypeClient {
  return new AnytypeClient(
    () => ({
      baseUrl: 'http://127.0.0.1:31009',
      apiKey: overrides?.apiKey ?? 'test-key',
      apiVersion: '2025-11-08',
      timeoutMs: overrides?.timeoutMs ?? 5000,
    }),
    fetchImpl,
  );
}

/** 空信号（模拟 registry 提供的 exec.signal）。 */
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

  describe('request 头部与请求体', () => {
    it('带 Authorization/Anytype-Version，有 body 时才补 Content-Type', async () => {
      const { fetchImpl, calls } = captureFetch(
        () =>
          new Response(JSON.stringify({ data: [1] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const client = clientWith(fetchImpl);
      const result = await client.request('POST', '/v2/search', {
        body: { query: 'x' },
        signal: noSignal,
      });

      expect(result.status).toBe(200);
      expect(result.data).toEqual({ data: [1] });
      expect(calls[0]?.url).toBe('http://127.0.0.1:31009/v2/search');
      const headers = calls[0]?.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-key');
      expect(headers['Anytype-Version']).toBe('2025-11-08');
      expect(headers['Content-Type']).toBe('application/json');
      expect(calls[0]?.init.body).toBe(JSON.stringify({ query: 'x' }));
    });

    it('expectedEtag 映射为 If-Match 头，响应 etag 进入结果', async () => {
      const { fetchImpl, calls } = captureFetch(
        () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json', etag: '"v7"' },
          }),
      );
      const client = clientWith(fetchImpl);
      const result = await client.request('PATCH', '/v2/spaces/abc', {
        body: { name: 'n' },
        expectedEtag: '"v6"',
        signal: noSignal,
      });

      const headers = calls[0]?.init.headers as Record<string, string>;
      expect(headers['If-Match']).toBe('"v6"');
      expect(result.etag).toBe('"v7"');
    });

    it('idempotencyKey 映射为 Idempotency-Key 头（防重键注入）', async () => {
      const { fetchImpl, calls } = captureFetch(
        () =>
          new Response(JSON.stringify({ id: 'o1' }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const client = clientWith(fetchImpl);
      await client.request('POST', '/v2/spaces/s1/objects', {
        body: { type: 'page' },
        idempotencyKey: 'key-abc-123',
        signal: noSignal,
      });

      const headers = calls[0]?.init.headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toBe('key-abc-123');
    });

    it('未给 idempotencyKey（或空串）时不发 Idempotency-Key 头', async () => {
      const { fetchImpl, calls } = captureFetch(
        () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const client = clientWith(fetchImpl);

      await client.request('POST', '/v2/spaces/s1/objects', {
        body: { type: 'page' },
        signal: noSignal,
      });
      await client.request('POST', '/v2/spaces/s1/objects', {
        body: { type: 'page' },
        idempotencyKey: '',
        signal: noSignal,
      });

      for (const call of calls) {
        const headers = call.init.headers as Record<string, string>;
        expect(headers['Idempotency-Key']).toBeUndefined();
      }
    });

    it('dry_run 走 query 序列化（预演不落库）', async () => {
      const { fetchImpl, calls } = captureFetch(
        () =>
          new Response(JSON.stringify({ dry_run: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const client = clientWith(fetchImpl);
      await client.request('POST', '/v2/spaces/s1/objects', {
        body: { type: 'page' },
        query: { dry_run: true },
        signal: noSignal,
      });

      expect(calls[0]?.url).toBe(
        'http://127.0.0.1:31009/v2/spaces/s1/objects?dry_run=true',
      );
    });
  });

  describe('错误归一', () => {
    it('未配置 apiKey 时报 CONFIG_MISSING_KEY（不发请求）', async () => {
      const { fetchImpl, calls } = captureFetch(
        () => new Response('{}', { status: 200 }),
      );
      const client = clientWith(fetchImpl, { apiKey: '' });
      await expect(
        client.request('GET', '/v2/spaces', { signal: noSignal }),
      ).rejects.toThrow(/apiKey is not configured/);
      expect(calls).toHaveLength(0);
    });

    it('非 2xx 响应归一为 AnytypeError（status + code/message/hints）', async () => {
      const { fetchImpl } = captureFetch(
        () =>
          new Response(
            JSON.stringify({
              code: 'UNAUTHORIZED',
              message: 'bad key',
              hints: ['create a key in Anytype'],
            }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          ),
      );
      const client = clientWith(fetchImpl);
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

    it('连接失败给出「Anytype 应用未运行」可操作提示', async () => {
      const { fetchImpl } = captureFetch(() => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:31009');
      });
      const client = clientWith(fetchImpl);
      const err = await client
        .request('GET', '/v2/auth/whoami', { signal: noSignal })
        .catch((e: unknown) => e as AnytypeError);

      expect((err as AnytypeError).status).toBe(0);
      expect((err as AnytypeError).body.code).toBe('NETWORK');
      expect((err as Error).message).toContain(
        'Is the Anytype desktop app running',
      );
    });

    it('请求超时归一为 TIMEOUT', async () => {
      // 假体遵守 init.signal（与真实 fetch 一致）：组合信号中止即以
      // signal.reason（AbortSignal.timeout → TimeoutError）拒绝。
      const { fetchImpl } = captureFetch(
        (_url, init) =>
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
      );
      const client = clientWith(fetchImpl, { timeoutMs: 20 });
      const err = await client
        .request('GET', '/v2/spaces', { signal: noSignal })
        .catch((e: unknown) => e as AnytypeError);

      expect((err as AnytypeError).body.code).toBe('TIMEOUT');
      expect((err as Error).message).toContain('timed out');
    }, 5000);

    it('调用方取消归一为 ABORTED（优先于超时分支）', async () => {
      const controller = new AbortController();
      const { fetchImpl } = captureFetch(
        (_url, init) =>
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
      );
      const client = clientWith(fetchImpl, { timeoutMs: 60_000 });
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
      const { fetchImpl } = captureFetch(
        () => new Response(null, { status: 204 }),
      );
      const client = clientWith(fetchImpl);
      const r1 = await client.request('DELETE', '/v2/spaces/x/objects/y', {
        signal: noSignal,
      });
      expect(r1.data).toBeNull();

      const { fetchImpl: fetch2 } = captureFetch(
        () =>
          new Response('{"weird":"no content type"}', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          }),
      );
      const r2 = await clientWith(fetch2).request('GET', '/v2/anything', {
        signal: noSignal,
      });
      expect(r2.data).toEqual({ weird: 'no content type' });
    });

    it('非法 JSON 回退为纯文本（不抛解析错误）', async () => {
      const { fetchImpl } = captureFetch(
        () =>
          new Response('{"broken"', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const result = await clientWith(fetchImpl).request('GET', '/v2/x', {
        signal: noSignal,
      });
      expect(result.data).toBe('{"broken"');
    });
  });

  describe('toToolValue 截断', () => {
    it('未超限原样透传 data/etag', () => {
      const value = toToolValue(
        { status: 200, data: { a: 1 }, etag: '"e"' },
        10_000,
      );
      expect(value).toEqual({ status: 200, data: { a: 1 }, etag: '"e"' });
    });

    it('无 etag 时整键省略（registry 无损 JSON 校验拒绝 undefined 属性）', () => {
      const value = toToolValue({ status: 200, data: { ok: true } }, 10_000);
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
      const value = toToolValue({ status: 200, data: big }, 1000);
      expect(value.truncated).toBe(true);
      expect(value.data).toBeUndefined();
      expect(value.data_preview).toBeDefined();
      expect(value.data_preview?.length).toBeLessThanOrEqual(1100);
      expect(() => JSON.parse(JSON.stringify(value))).not.toThrow();
      // 无 etag 的截断值同样不得携带 etag 键
      const noEtag = toToolValue({ status: 200, data: big }, 1000);
      expect(Object.keys(noEtag)).not.toContain('etag');
    });
  });
});
