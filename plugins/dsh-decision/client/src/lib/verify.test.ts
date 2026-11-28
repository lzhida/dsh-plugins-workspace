/**
 * decision-tools 验证状态机单测（决策工具系列 6/11）。
 *
 * 覆盖 idle→verifying→ok/fail/route-missing 全路径、reason 截断与默认
 * 文案、requestVerify 的 fetch 契约（POST JSON / 非 2xx / 非 JSON）。
 *
 * @module dsh-decision/client/lib/verify.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyVerifyFailure,
  applyVerifyResponse,
  INITIAL_VERIFY_STATUS,
  requestVerify,
  startVerify,
} from './verify.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('verify state machine', () => {
  it('初始态为 idle，点击进入 verifying', () => {
    expect(INITIAL_VERIFY_STATUS).toEqual({ phase: 'idle' });
    expect(startVerify()).toEqual({ phase: 'verifying' });
  });

  it('ok 响应进入 ok 态并携带 model 与 latency', () => {
    const status = applyVerifyResponse({
      ok: true,
      model: 'ollama-r5/kev-4b',
      latencyMs: 412,
    });
    expect(status).toEqual({
      phase: 'ok',
      model: 'ollama-r5/kev-4b',
      latencyMs: 412,
    });
  });

  it('model 缺失记 null，非法 latency 回 0', () => {
    const status = applyVerifyResponse({ ok: true, latencyMs: Number.NaN });
    expect(status).toEqual({ phase: 'ok', model: null, latencyMs: 0 });
  });

  it('ok:false 进入 fail 态并保留 reason（截断 300 字符）', () => {
    const status = applyVerifyResponse({
      ok: false,
      reason: 'model-verify-failed: 连接被拒绝',
    });
    expect(status).toEqual({
      phase: 'fail',
      reason: 'model-verify-failed: 连接被拒绝',
      routeMissing: false,
    });
    const long = applyVerifyResponse({ ok: false, reason: 'x'.repeat(400) });
    expect(long.phase).toBe('fail');
    if (long.phase === 'fail') {
      expect(long.reason.startsWith('x'.repeat(300))).toBe(true);
      expect(long.reason.endsWith('…')).toBe(true);
    }
  });

  it('reason 缺省时给出默认失败文案', () => {
    const status = applyVerifyResponse({ ok: false });
    expect(status.phase).toBe('fail');
    if (status.phase === 'fail') {
      expect(status.reason).toContain('model-verify-failed');
    }
  });

  it('请求失败：404 / Failed to fetch 归 routeMissing', () => {
    expect(applyVerifyFailure(new Error('verify route returned 404'))).toEqual({
      phase: 'fail',
      reason: 'verify.route-missing',
      routeMissing: true,
    });
    const network = applyVerifyFailure(new Error('Failed to fetch'));
    expect(network.phase === 'fail' && network.routeMissing).toBe(true);
    const endpoint = applyVerifyFailure(new Error('boom'));
    expect(endpoint).toEqual({
      phase: 'fail',
      reason: 'boom',
      routeMissing: false,
    });
  });
});

describe('requestVerify', () => {
  it('POST JSON 到同源路径并解析响应', async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(
        String((init?.headers as Record<string, string>)['content-type']),
      ).toBe('application/json');
      expect(init?.body).toBe(
        JSON.stringify({
          baseUrl: 'http://127.0.0.1:3425',
          apiKey: 'key-test',
          model: 'm',
          timeoutMs: 30_000,
        }),
      );
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, model: 'm', latencyMs: 12 }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const response = await requestVerify('/dsh-decision/verify', {
      baseUrl: 'http://127.0.0.1:3425',
      apiKey: 'key-test',
      model: 'm',
      timeoutMs: 30_000,
    });
    expect(response).toEqual({ ok: true, model: 'm', latencyMs: 12 });
  });

  it('非 2xx 抛错（message 带 status）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({ ok: false, status: 404, json: async () => ({}) }) as Response,
      ),
    );
    await expect(requestVerify('/dsh-decision/verify', {})).rejects.toThrow(
      'verify route returned 404',
    );
  });

  it('非 JSON 响应抛错', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => {
              throw new Error('invalid json');
            },
          }) as unknown as Response,
      ),
    );
    await expect(requestVerify('/dsh-decision/verify', {})).rejects.toThrow(
      'invalid JSON',
    );
  });
});
