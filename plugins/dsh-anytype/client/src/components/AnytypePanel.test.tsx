// @vitest-environment jsdom
/**
 * AnytypePanel 渲染冒烟：真实 React 渲染（jsdom + createRoot）——证明四节
 * 只读视图（连接状态 / 待审队列 / 空间 / 最近笔记）、**密钥只写**语义、
 * 30s 轮询、手动刷新，以及端点不可达时的降级提示。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DICT } from '../dict.ts';
import type { TFn } from '../types.ts';
import {
  AnytypePanel,
  POLL_INTERVAL_MS,
  QUEUE_ENDPOINT,
  STATUS_ENDPOINT,
} from './AnytypePanel.tsx';

const t: TFn = (key) => DICT.zh[key] ?? key;

/** status 端点载荷（宿主 panel/routes.ts 的形状）。 */
const STATUS_PAYLOAD = {
  connection: {
    apiKeyConfigured: true,
    baseUrl: 'http://127.0.0.1:31009',
    reachable: true,
    authenticated: true,
    latencyMs: 12,
    error: null,
  },
  spaces: [{ id: 'space-1', name: '研发空间' }],
  recentNotes: [
    {
      id: 'note-1',
      name: '最近一条笔记',
      status: 'approved',
      source: 'agent',
      updatedAt: '2026-11-20T00:00:00.000Z',
    },
  ],
  checkedAt: '2026-11-20T00:00:00.000Z',
  warning: null,
};

/** queue 端点载荷。 */
const QUEUE_PAYLOAD = {
  spaceId: 'space-1',
  pending: [
    {
      id: 'note-2',
      name: '待审记忆',
      status: 'draft',
      source: null,
      updatedAt: null,
    },
  ],
  total: 1,
  hasMore: false,
  checkedAt: '2026-11-20T00:00:00.000Z',
  warning: null,
};

/**
 * Wait until the probe passes (React 19 render is concurrent).
 *
 * 预算 300 轮 × 20ms ≈ 6s：探针快速通过时多出的间隔相对秒级测试时长可忽略。
 */
async function waitFor(probe: () => boolean): Promise<void> {
  for (let round = 0; round < 300; round++) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('waitFor: condition never became true');
}

/** 挂载组件并返回容器与卸载器。 */
function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(<AnytypePanel t={t} />);
  return { container, root };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('AnytypePanel', () => {
  it('渲染四节只读视图：连接状态、待审队列、空间与最近笔记', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        json: async () => ({
          ok: true,
          value: url.includes('queue') ? QUEUE_PAYLOAD : STATUS_PAYLOAD,
        }),
      })),
    );

    const { container, root } = mount();
    await waitFor(() => container.textContent?.includes('研发空间') ?? false);

    const text = container.textContent ?? '';
    expect(text).toContain(t('panel.connection'));
    expect(text).toContain(t('panel.queue'));
    expect(text).toContain(t('panel.spaces'));
    expect(text).toContain(t('panel.recent'));
    expect(text).toContain('研发空间');
    expect(text).toContain('待审记忆');
    expect(text).toContain('最近一条笔记');

    root.unmount();
  });

  it('只显示密钥是否配置，绝不回显密钥值', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        json: async () => ({
          ok: true,
          value: url.includes('queue')
            ? QUEUE_PAYLOAD
            : {
                ...STATUS_PAYLOAD,
                connection: {
                  ...STATUS_PAYLOAD.connection,
                  apiKey: 'super-secret-key',
                },
              },
        }),
      })),
    );

    const { container, root } = mount();
    await waitFor(
      () => container.textContent?.includes(t('panel.apiKey')) ?? false,
    );

    const text = container.textContent ?? '';
    expect(text).toContain(t('panel.apiKeyConfigured'));
    // 载荷里被注入的密钥值绝不出现在面板文本中（断言值 = 注入值）。
    expect(text).not.toContain('super-secret-key');

    root.unmount();
  });

  it('载荷缺 connection 时面板不崩，且队列端点失败只影响队列一节', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        json: async () =>
          url.includes('queue')
            ? { ok: false, error: { message: 'queue boom' } }
            : { ok: true, value: { ...STATUS_PAYLOAD, connection: undefined } },
      })),
    );

    const { container, root } = mount();
    await waitFor(() => container.textContent?.includes('queue boom') ?? false);

    const text = container.textContent ?? '';
    // 队列端点失败：只显示该节不可用提示。
    expect(text).toContain('queue boom');
    // status 端点正常（仅缺 connection）：空间一节照常渲染，不崩。
    expect(text).toContain(t('panel.spaces'));
    expect(text).toContain(t('panel.recent'));

    root.unmount();
  });

  it('按 30s 轮询两个只读端点，并支持手动刷新', async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      json: async () => ({
        ok: true,
        value: url.includes('queue') ? QUEUE_PAYLOAD : STATUS_PAYLOAD,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');

    const { container, root } = mount();
    await waitFor(() => fetchMock.mock.calls.length >= 2);

    expect(intervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      POLL_INTERVAL_MS,
    );
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain(STATUS_ENDPOINT);
    expect(urls).toContain(QUEUE_ENDPOINT);

    const before = fetchMock.mock.calls.length;
    const refresh = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === t('panel.refresh'),
    );
    expect(refresh).toBeDefined();
    refresh?.click();
    await waitFor(() => fetchMock.mock.calls.length > before);

    root.unmount();
  });

  it('端点不可达时降级为不可用提示，不抛错', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom');
      }),
    );

    const { container, root } = mount();
    await waitFor(
      () => container.textContent?.includes(t('panel.unavailable')) ?? false,
    );

    expect(container.textContent).toContain('boom');

    root.unmount();
  });
});
