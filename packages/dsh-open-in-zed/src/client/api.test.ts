import { afterEach, describe, expect, it, vi } from 'vitest';
import { openInZed, OPEN_ROUTE } from './api.ts';
import type { ApiFail } from './api.ts';

/** Install a fetch stub answering with the given status/body. */
function stubFetch(impl: () => { status: number; body: string }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const { status, body } = impl();
      return new Response(body, {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

describe('dsh-open-in-zed client/api', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POST 目标路由并回传 value（含 newWindow 透传）', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        path: 'C:\\w',
        newWindow: true,
      });
      return new Response(
        JSON.stringify({
          ok: true,
          value: {
            workspace: { id: 'ws-1', title: 'alpha' },
            path: 'C:\\w',
            command: ['zed', 'C:\\w'],
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const value = await openInZed('C:\\w', { newWindow: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(OPEN_ROUTE);
    expect(value.workspace.title).toBe('alpha');
  });

  it('信封失败抛出带 code 与 message 的错误', async () => {
    stubFetch(() => ({
      status: 500,
      body: JSON.stringify({
        ok: false,
        error: { code: 'zed-not-found', message: '未找到 Zed' },
      } satisfies ApiFail),
    }));
    await expect(openInZed('C:\\w')).rejects.toThrow(
      /zed-not-found.*未找到 Zed/,
    );
  });

  it('空响应、非 JSON、非法结构都抛可读错误', async () => {
    stubFetch(() => ({ status: 200, body: '' }));
    await expect(openInZed('C:\\w')).rejects.toThrow(/空响应/);
    stubFetch(() => ({ status: 200, body: '<html>' }));
    await expect(openInZed('C:\\w')).rejects.toThrow(/非 JSON/);
    stubFetch(() => ({ status: 200, body: '{"hello":1}' }));
    await expect(openInZed('C:\\w')).rejects.toThrow(/非法响应结构/);
  });

  it('网络失败转译为可读错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('connection refused');
      }),
    );
    await expect(openInZed('C:\\w')).rejects.toThrow(/网络请求失败/);
  });
});
