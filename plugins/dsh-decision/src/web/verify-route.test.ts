/**
 * 宿主半区同源验证路由契约测试（决策工具系列 6/11）。
 *
 * 覆盖安全栅栏（content-type 415 / Origin 同源 403 / 跨主机不继承 apiKey）、
 * 请求体边界（>64KB → 413、非 JSON → 400）、配置归一（尾斜杠 → 归一后才
 * markVerified）、错误信封不回显 apiKey，以及 mergeDraftConfig / isSameOrigin
 * 纯函数口径。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it } from 'vitest';

import { resolveToolsConfig } from '../config/decision-tools.ts';
import {
  createVerifyRouteHandler,
  isSameOrigin,
  mergeDraftConfig,
  VERIFY_ROUTE_PATH,
  verifyResponseOf,
} from './verify-route.ts';

interface FakeResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  writeHead(status: number, headers: Record<string, string>): FakeResponse;
  end(text: string): void;
}

function createResponse(): FakeResponse {
  const response: FakeResponse = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      response.statusCode = status;
      response.headers = headers;
      return response;
    },
    end(text) {
      response.body = text;
    },
  };
  return response;
}

function createRequest(
  options: {
    method?: string;
    body?: string;
    contentType?: string | null;
    origin?: string | undefined;
    host?: string | undefined;
  } = {},
): IncomingMessage {
  const req = {
    method: options.method ?? 'POST',
    headers: {
      ...(options.contentType === undefined
        ? { 'content-type': 'application/json' }
        : options.contentType === null
          ? {}
          : { 'content-type': options.contentType }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.host === undefined ? {} : { host: options.host }),
    },
  } as Record<string, unknown>;
  const body = options.body ?? '{}';
  const encoded = Buffer.from(body, 'utf8');
  Object.defineProperty(req, Symbol.asyncIterator, {
    value: async function* () {
      yield encoded;
    },
  });
  return req as unknown as IncomingMessage;
}

function savedConfig(overrides: Record<string, unknown> = {}) {
  return resolveToolsConfig({
    systemoneBaseUrl: 'https://decision.example.internal',
    systemoneApiKey: 'key-test',
    systemoneModel: 'model-test',
    ...overrides,
  });
}

interface Harness {
  marked: number;
  calls: Array<{ url: string; headers: Record<string, string>; body: string }>;
  handler: ReturnType<typeof createVerifyRouteHandler>;
}

function harness(
  options: {
    saved?: ReturnType<typeof savedConfig>;
    status?: number;
    payload?: unknown;
  } = {},
): Harness {
  const state: Harness = {
    marked: 0,
    calls: [],
    handler: undefined as never,
  };
  const fetchImpl = async (
    url: string,
    init: { headers: Record<string, string>; body: string },
  ) => {
    state.calls.push({ url, headers: init.headers, body: init.body });
    const status = options.status ?? 200;
    const payload =
      options.payload ??
      ({
        answers: {
          probe: { type: 'noul', noul: 0.9, confidence: 0.9 },
        },
        usage: { input_tokens: 12, output_tokens: 4 },
      } as unknown);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload),
    };
  };
  state.handler = createVerifyRouteHandler({
    readConfig: () => options.saved ?? savedConfig(),
    markVerified: () => {
      state.marked += 1;
    },
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return state;
}

async function call(
  state: Harness,
  request: IncomingMessage,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const response = createResponse();
  await state.handler(request, response as unknown as ServerResponse);
  return {
    status: response.statusCode,
    payload: JSON.parse(response.body) as Record<string, unknown>,
  };
}

describe('decision-tools verify route', () => {
  it('路由路径固定为 /dsh-decision/verify', () => {
    expect(VERIFY_ROUTE_PATH).toBe('/dsh-decision/verify');
  });

  it('非 POST 返回 405', async () => {
    const state = harness();
    const result = await call(
      state,
      createRequest({ method: 'GET', contentType: null }),
    );
    expect(result.status).toBe(405);
    expect(state.calls).toHaveLength(0);
  });

  it('content-type 非 application/json 返回 415（CSRF 栅栏，不出网）', async () => {
    const state = harness();
    const result = await call(
      state,
      createRequest({ contentType: 'text/plain' }),
    );
    expect(result.status).toBe(415);
    expect(state.calls).toHaveLength(0);
  });

  it('跨源 Origin 返回 403（不出网）', async () => {
    const state = harness();
    const result = await call(
      state,
      createRequest({
        origin: 'http://evil.example',
        host: '127.0.0.1:3080',
      }),
    );
    expect(result.status).toBe(403);
    expect(state.calls).toHaveLength(0);
  });

  it('同源 Origin 放行', async () => {
    const state = harness();
    const result = await call(
      state,
      createRequest({
        origin: 'http://127.0.0.1:3080',
        host: '127.0.0.1:3080',
      }),
    );
    expect(result.status).toBe(200);
    expect(state.calls).toHaveLength(1);
  });

  it('请求体超过 64KB 返回 413', async () => {
    const state = harness();
    const result = await call(
      state,
      createRequest({ body: 'x'.repeat(64 * 1024 + 10) }),
    );
    expect(result.status).toBe(413);
    expect(state.calls).toHaveLength(0);
  });

  it('非 JSON 请求体返回 400', async () => {
    const state = harness();
    const result = await call(state, createRequest({ body: 'not-json' }));
    expect(result.status).toBe(400);
    expect(state.calls).toHaveLength(0);
  });

  it('三元组未配置时返回 model-not-configured（不出网）', async () => {
    const state = harness({
      saved: savedConfig({ systemoneApiKey: '' }),
    });
    const result = await call(state, createRequest());
    expect(result.status).toBe(200);
    expect(result.payload.ok).toBe(false);
    expect(String(result.payload.reason)).toContain('model-not-configured');
    expect(state.calls).toHaveLength(0);
  });

  it('草稿 baseUrl 非法时返回 invalid-arguments（不出网）', async () => {
    const state = harness();
    const result = await call(
      state,
      createRequest({ body: JSON.stringify({ baseUrl: 'ftp://nope' }) }),
    );
    expect(result.status).toBe(200);
    expect(result.payload.ok).toBe(false);
    expect(String(result.payload.reason)).toContain('invalid-arguments');
    expect(state.calls).toHaveLength(0);
  });

  it('跨主机 baseUrl 不继承已保存 apiKey（不出网，避免凭据外泄）', async () => {
    const state = harness();
    const result = await call(
      state,
      createRequest({
        body: JSON.stringify({ baseUrl: 'http://attacker.example' }),
      }),
    );
    expect(result.status).toBe(200);
    expect(result.payload.ok).toBe(false);
    expect(String(result.payload.reason)).toContain('model-not-configured');
    expect(state.calls).toHaveLength(0);
  });

  it('baseUrl 带尾斜杠时归一后才刷新验证快照', async () => {
    const state = harness();
    const result = await call(
      state,
      createRequest({
        body: JSON.stringify({ baseUrl: 'https://decision.example.internal/' }),
      }),
    );
    expect(result.status).toBe(200);
    expect(result.payload.ok).toBe(true);
    expect(state.marked).toBe(1);
  });

  it('验证失败时错误信封含原因且不回显 apiKey', async () => {
    const saved = savedConfig();
    const state = harness({ saved, status: 401 });
    const result = await call(state, createRequest());
    expect(result.status).toBe(200);
    expect(result.payload.ok).toBe(false);
    expect(result.payload).toEqual({
      ok: false,
      model: null,
      latencyMs: expect.any(Number),
      reason: expect.stringContaining('model-verify-failed'),
    });
    // 断言对象指向被保存的真实 key 值（savedConfig 里的哑值），非字段名。
    expect(JSON.stringify(result.payload)).not.toContain(saved.systemoneApiKey);
    expect(state.marked).toBe(0);
  });

  it('草稿显式给出的 key 与 model 覆盖已保存值', async () => {
    const state = harness();
    await call(
      state,
      createRequest({
        body: JSON.stringify({
          baseUrl: 'http://127.0.0.1:9999',
          apiKey: 'draft-key',
          model: 'draft-model',
        }),
      }),
    );
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.headers.Authorization).toBe('Bearer draft-key');
    expect(state.calls[0]?.body).toContain('draft-model');
  });

  it('mergeDraftConfig 归一尾斜杠与空白，超时越界回落保存值', () => {
    const saved = savedConfig({ systemoneTimeoutMs: 30_000 });
    const merged = mergeDraftConfig(saved, {
      baseUrl: '  https://decision.example.internal/  ',
      model: '  model-x  ',
      timeoutMs: 99_999_999,
    });
    expect(merged.invalidBaseUrl).toBe(false);
    expect(merged.config.systemoneBaseUrl).toBe(
      'https://decision.example.internal',
    );
    expect(merged.config.systemoneModel).toBe('model-x');
    expect(merged.config.systemoneTimeoutMs).toBe(30_000);
  });

  it('mergeDraftConfig 跨主机时清空继承的 apiKey', () => {
    const saved = savedConfig();
    const merged = mergeDraftConfig(saved, {
      baseUrl: 'http://other-host:8080',
    });
    expect(merged.crossHost).toBe(true);
    expect(merged.config.systemoneApiKey).toBe('');
  });

  it('isSameOrigin：无 Origin 视为同源，跨主机判否', () => {
    expect(isSameOrigin(undefined, '127.0.0.1:3080')).toBe(true);
    expect(isSameOrigin('http://127.0.0.1:3080', '127.0.0.1:3080')).toBe(true);
    expect(isSameOrigin('http://evil.example', '127.0.0.1:3080')).toBe(false);
    expect(isSameOrigin('null', '127.0.0.1:3080')).toBe(false);
  });

  it('verifyResponseOf 只回显 model/latency/reason', () => {
    const ok = verifyResponseOf({
      ok: true,
      model: 'model-x',
      latencyMs: 12,
    });
    expect(ok).toEqual({ ok: true, model: 'model-x', latencyMs: 12 });
    const failed = verifyResponseOf({
      ok: false,
      error: {
        code: 'model-verify-failed',
        message: 'boom',
        retryable: true,
        details: {},
      },
      latencyMs: 3,
    });
    expect(failed.ok).toBe(false);
    expect(failed.reason).toBe('model-verify-failed: boom');
    // 精确形状断言：信封只允许 ok/model/latencyMs/reason 四个字段，
    // 天然排除 apiKey（比字段名级弱断言更强）。
    expect(failed).toEqual({
      ok: false,
      model: null,
      latencyMs: 3,
      reason: 'model-verify-failed: boom',
    });
  });
});
