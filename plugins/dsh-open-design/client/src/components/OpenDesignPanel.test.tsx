// @vitest-environment jsdom
/**
 * OpenDesignPanel 渲染冒烟：真实 React 渲染（jsdom + createRoot）——
 * 证明三节只读视图（连接状态 / 当前焦点 / 项目列表）、各节独立降级、
 * 未安装引导横幅、重新检测与手动刷新（系列 3/6）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { DICT } from '../dict.ts';
import type { TFn } from '../types.ts';
import { OpenDesignPanel } from './OpenDesignPanel.tsx';

const t: TFn = (key) => DICT.zh[key] ?? key;

/** /status 载荷（src/diag-tools.ts 的 DiagnosticReport 形状，已安装态）。 */
const STATUS_INSTALLED = {
  autoDetect: true,
  serverName: 'open-design',
  source: 'custom',
  command: 'E:\\Programs\\Open Design\\Open Design.exe',
  args: [],
  env: { OD_DATA_DIR: 'C:\\od\\data' },
  cwd: '',
  startupTimeoutMs: 120000,
  toolCallTimeoutMs: 60000,
  detectionMethod: 'pipe',
  installed: true,
  stamp: {
    channel: 'stable',
    namespace: 'release-stable-win',
    source: 'packaged',
    mode: 'runtime',
    app: 'daemon',
  },
  endpoint: '\\\\.\\pipe\\open-design-sidecar-abc',
  installDir: 'E:\\Programs\\Open Design',
  dataDir: 'C:\\od\\data',
  daemonCliPath: 'E:\\daemon-cli.mjs',
  connectionState: 'connected',
  failedAttempts: 0,
  maxAttempts: 10,
  lastError: null,
  upstreamToolCount: 22,
  upstreamSkippedTools: [],
  diagnosticToolCount: 2,
  configFile: 'C:\\Users\\k\\.dsh\\plugins\\dsh-open-design\\config.json',
};

/** /projects 载荷。 */
const PROJECTS_PAYLOAD = {
  projects: [
    {
      id: 'p1',
      name: '演示项目',
      status: { value: 'active' },
      updatedAt: '2026-11-20T00:00:00.000Z',
    },
  ],
};

/** /focus 载荷（空闲态）。 */
const FOCUS_IDLE = { active: false, hint: 'OpenDesign has no active project' };

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

/** fetch 替身：按路径分发载荷（未命中路径抛错模拟网络失败）。 */
function stubFetch(routes: Record<string, unknown>): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string | URL | RequestInfo) => {
    const path = String(url);
    if (!(path in routes)) {
      return {
        ok: false,
        status: 502,
        json: async () => ({ error: `no mock for ${path}` }),
      };
    }
    return { ok: true, json: async () => routes[path] };
  });
}

/** 挂载组件并返回容器与卸载器。 */
function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(<OpenDesignPanel t={t} />);
  return { container, root };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('OpenDesignPanel', () => {
  it('渲染三节只读视图：连接状态、当前焦点与项目列表', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch({
        '/dsh-open-design/status': STATUS_INSTALLED,
        '/dsh-open-design/projects': PROJECTS_PAYLOAD,
        '/dsh-open-design/focus': FOCUS_IDLE,
      }),
    );

    const { container, root } = mount();
    await waitFor(() => container.textContent?.includes('演示项目') ?? false);

    const text = container.textContent ?? '';
    expect(text).toContain(t('status.title'));
    expect(text).toContain(t('connection.connected'));
    expect(text).toContain('22');
    expect(text).toContain(t('focus.title'));
    expect(text).toContain('OpenDesign has no active project');
    expect(text).toContain(t('projects.title'));
    expect(text).toContain('演示项目');

    root.unmount();
  });

  it('端点失败时该节独立降级为错误提示 + 重试按钮，其余节正常', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch({
        '/dsh-open-design/status': STATUS_INSTALLED,
        '/dsh-open-design/focus': FOCUS_IDLE,
        // projects 无 mock → 502
      }),
    );

    const { container, root } = mount();
    await waitFor(
      () => container.textContent?.includes('no mock for') ?? false,
    );

    const text = container.textContent ?? '';
    expect(text).toContain(t('panel.unavailable'));
    expect(text).toContain(t('panel.retry'));
    // status 节照常渲染，不因 projects 失败拖垮。
    expect(text).toContain(t('connection.connected'));

    root.unmount();
  });

  it('active=true 时逐键展示焦点对象', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch({
        '/dsh-open-design/status': STATUS_INSTALLED,
        '/dsh-open-design/projects': PROJECTS_PAYLOAD,
        '/dsh-open-design/focus': { active: true, project: 'demo-x' },
      }),
    );

    const { container, root } = mount();
    await waitFor(() => container.textContent?.includes('demo-x') ?? false);

    const text = container.textContent ?? '';
    expect(text).toContain('project');

    root.unmount();
  });

  it('未安装时面板仍渲染并显示安装指引横幅', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch({
        '/dsh-open-design/status': {
          ...STATUS_INSTALLED,
          installed: false,
          detectionMethod: 'none',
          endpoint: '',
          installDir: '',
          connectionState: 'failed',
        },
        '/dsh-open-design/projects': {},
        '/dsh-open-design/focus': FOCUS_IDLE,
      }),
    );

    const { container, root } = mount();
    await waitFor(
      () => container.textContent?.includes(t('panel.notInstalled')) ?? false,
    );

    const text = container.textContent ?? '';
    expect(text).toContain(t('panel.notInstalledHint'));
    // 面板不消失：状态节照常渲染（连接失败态）。
    expect(text).toContain(t('status.title'));
    expect(text).toContain(t('connection.failed'));

    root.unmount();
  });

  it('重新检测按钮调用 POST /redetect 并刷新数据', async () => {
    const fetchMock = vi.fn(async (url: string | URL | RequestInfo) => {
      const path = String(url);
      if (path === '/dsh-open-design/redetect') {
        return { ok: true, json: async () => STATUS_INSTALLED };
      }
      if (!(path in { '/dsh-open-design/status': 1 })) {
        // status/projects/focus 走默认载荷
      }
      return {
        ok: true,
        json: async () =>
          path === '/dsh-open-design/status'
            ? STATUS_INSTALLED
            : path === '/dsh-open-design/projects'
              ? PROJECTS_PAYLOAD
              : FOCUS_IDLE,
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { container, root } = mount();
    await waitFor(() => container.textContent?.includes('演示项目') ?? false);

    const before = fetchMock.mock.calls.filter(
      ([url]) => String(url) === '/dsh-open-design/redetect',
    ).length;
    expect(before).toBe(0);

    const button = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === t('panel.redetect'),
    );
    expect(button).toBeDefined();
    button?.click();

    await waitFor(
      () =>
        fetchMock.mock.calls.filter(
          ([url]) => String(url) === '/dsh-open-design/redetect',
        ).length > 0,
    );

    root.unmount();
  });

  it('刷新按钮重新拉取三个端点', async () => {
    const fetchMock = vi.fn(async (url: string | URL | RequestInfo) => {
      const path = String(url);
      return {
        ok: true,
        json: async () =>
          path === '/dsh-open-design/status'
            ? STATUS_INSTALLED
            : path === '/dsh-open-design/projects'
              ? PROJECTS_PAYLOAD
              : FOCUS_IDLE,
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { container, root } = mount();
    await waitFor(() => container.textContent?.includes('演示项目') ?? false);
    const afterLoad = fetchMock.mock.calls.length;

    const refresh = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === t('panel.refresh'),
    );
    refresh?.click();

    await waitFor(() => fetchMock.mock.calls.length >= afterLoad + 3);

    root.unmount();
  });
});
