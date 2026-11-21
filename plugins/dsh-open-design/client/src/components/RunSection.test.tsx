// @vitest-environment jsdom
/**
 * 生成运行节（系列 4/6）契约测试。
 *
 * 覆盖：表单渲染、发起生成（参数透传）、轮询到成功/失败、取消语义
 * （已请求取消）、离开面板后重进的 runId 恢复。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { DICT } from '../dict.ts';
import type { PanelApi, StartRunInput } from '../api.ts';
import type { TFn } from '../types.ts';

import {
  LAST_RUN_ID_KEY,
  RunSection,
  type RunBackfill,
} from './RunSection.tsx';

const t: TFn = (key) => DICT.zh[key] ?? key;

const STATUS = {
  autoDetect: true,
  serverName: 'open-design',
  source: 'custom',
  command: 'cmd',
  args: [],
  env: {},
  cwd: '',
  startupTimeoutMs: 120000,
  toolCallTimeoutMs: 60000,
  detectionMethod: 'pipe' as const,
  installed: true,
  stamp: null,
  endpoint: 'pipe-endpoint',
  installDir: 'E:\\Programs\\Open Design',
  dataDir: 'C:\\od',
  daemonCliPath: 'C:\\od\\daemon-cli.mjs',
  connectionState: 'connected',
  failedAttempts: 0,
  maxAttempts: 10,
  lastError: null,
  upstreamToolCount: 22,
  upstreamSkippedTools: [],
  diagnosticToolCount: 2,
  configFile: 'C:\\config.json',
};

const PROJECTS = [
  { id: 'p1', name: '演示项目', status: { value: 'active' }, updatedAt: null },
];

/** 轮询间隔（测试用小值，避免真等 1.5s）。 */
const POLL_MS = 20;

function createApi(overrides: Partial<PanelApi> = {}): PanelApi {
  return {
    status: async () => STATUS,
    projects: async () => ({ projects: PROJECTS }),
    focus: async () => ({ active: false, hint: 'idle' }),
    redetect: async () => STATUS,
    run: async () => ({ status: 'queued' }),
    startRun: async () => ({ runId: 'run-1' }),
    cancelRun: async () => ({ runId: 'run-1' }),
    agents: async () => ({ agents: [{ id: 'a1', name: 'Codex' }] }),
    skills: async () => ({
      total: 1,
      matched: 1,
      returned: 1,
      truncated: false,
      nextOffset: null,
      items: [
        { id: 's1', name: 'Landing', description: '落地页', triggers: [] },
      ],
    }),
    plugins: async () => ({
      total: 0,
      returned: 0,
      truncated: false,
      items: [],
    }),
    ...overrides,
  };
}

async function waitFor(probe: () => boolean): Promise<void> {
  for (let round = 0; round < 300; round++) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('waitFor: condition never became true');
}

function mount(props: { api: PanelApi; backfill?: RunBackfill | null }): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    <RunSection
      t={t}
      api={props.api}
      projects={PROJECTS}
      pollIntervalMs={POLL_MS}
      backfill={props.backfill}
    />,
  );
  return { container, root };
}

/** 填写 prompt 并点击发起按钮。 */
async function submit(container: HTMLElement): Promise<void> {
  const textarea = container.querySelector('textarea');
  expect(textarea).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  setter?.call(textarea, '做一张落地页');
  textarea?.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => {
    const button = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === t('run.start'),
    );
    return button !== undefined && !(button as HTMLButtonElement).disabled;
  });
  const button = Array.from(container.querySelectorAll('button')).find(
    (node) => node.textContent === t('run.start'),
  );
  button?.click();
}

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('RunSection', () => {
  it('渲染发起表单：项目下拉含候选项目、agent 下拉、技能搜索与 prompt 输入', async () => {
    const api = createApi();
    const { container, root } = mount({ api });
    await waitFor(
      () => container.textContent?.includes(t('run.title')) ?? false,
    );

    const selects = container.querySelectorAll('select');
    const options = Array.from(
      selects[0]?.querySelectorAll('option') ?? [],
    ).map((node) => node.textContent ?? '');
    expect(options).toContain('演示项目');
    expect(container.querySelector('textarea')).not.toBeNull();
    expect(container.textContent).toContain(t('run.start'));

    root.unmount();
  });

  it('prompt 为空时发起按钮禁用', async () => {
    const api = createApi();
    const { container, root } = mount({ api });
    await waitFor(
      () => container.textContent?.includes(t('run.start')) ?? false,
    );

    const button = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === t('run.start'),
    ) as HTMLButtonElement | undefined;
    expect(button?.disabled).toBe(true);

    root.unmount();
  });

  it('发起生成：透传 prompt 并展示运行卡', async () => {
    const startRun = vi.fn(async (input: StartRunInput) => {
      void input;
      return { runId: 'run-42' };
    });
    const api = createApi({ startRun });
    const { container, root } = mount({ api });
    await waitFor(
      () => container.textContent?.includes(t('run.start')) ?? false,
    );

    await submit(container);

    await waitFor(() => startRun.mock.calls.length === 1);
    expect(startRun.mock.calls[0][0].prompt).toBe('做一张落地页');
    await waitFor(() => container.textContent?.includes('run-42') ?? false);
    expect(container.textContent).toContain('run-42');

    root.unmount();
  });

  it('轮询到成功态展示预览链接（target=_blank rel=noopener）', async () => {
    const run = vi.fn(async () => ({
      status: 'succeeded',
      previewUrl: 'https://example.invalid/preview/1',
    }));
    const api = createApi({ run });
    const { container, root } = mount({ api });
    await waitFor(
      () => container.textContent?.includes(t('run.start')) ?? false,
    );

    await submit(container);
    await waitFor(
      () => container.textContent?.includes(t('run.status.succeeded')) ?? false,
    );

    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe(
      'https://example.invalid/preview/1',
    );
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toContain('noopener');

    root.unmount();
  });

  it('轮询到失败态展示上游错误文本', async () => {
    const run = vi.fn(async () => ({
      status: 'failed',
      error: 'agent 不可用',
    }));
    const api = createApi({ run });
    const { container, root } = mount({ api });
    await waitFor(
      () => container.textContent?.includes(t('run.start')) ?? false,
    );

    await submit(container);
    await waitFor(
      () => container.textContent?.includes('agent 不可用') ?? false,
    );
    expect(container.textContent).toContain(t('run.status.failed'));

    root.unmount();
  });

  it('取消语义如实呈现「已请求取消」', async () => {
    const cancelRun = vi.fn(async (runId: string) => {
      void runId;
      return { runId: 'run-42' };
    });
    const api = createApi({
      cancelRun,
      startRun: async (input: StartRunInput) => {
        void input;
        return { runId: 'run-42' };
      },
      run: async () => ({ status: 'queued' }),
    });
    const { container, root } = mount({ api });
    await waitFor(
      () => container.textContent?.includes(t('run.start')) ?? false,
    );

    await submit(container);
    await waitFor(
      () => container.textContent?.includes(t('run.cancel')) ?? false,
    );

    const cancel = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === t('run.cancel'),
    );
    cancel?.click();

    await waitFor(() => cancelRun.mock.calls.length === 1);
    expect(cancelRun.mock.calls[0][0]).toBe('run-42');
    await waitFor(
      () => container.textContent?.includes(t('run.cancelRequested')) ?? false,
    );

    root.unmount();
  });

  it('重进面板按 sessionStorage 中的 runId 恢复运行卡', async () => {
    window.sessionStorage.setItem(LAST_RUN_ID_KEY, 'run-99');
    const api = createApi();
    const { container, root } = mount({ api });

    await waitFor(() => container.textContent?.includes('run-99') ?? false);

    root.unmount();
  });

  it('技能检索失败时显示降级提示且不阻塞表单', async () => {
    const api = createApi({
      skills: async () => {
        throw new Error('skills 端点 502');
      },
    });
    const { container, root } = mount({ api });

    await waitFor(
      () => container.textContent?.includes('skills 端点 502') ?? false,
    );
    expect(container.querySelector('textarea')).not.toBeNull();

    root.unmount();
  });

  it('目录回填：skill/plugin/agent 一次性写入对应表单控件', async () => {
    const startRun = vi.fn(async (input: StartRunInput) => {
      void input;
      return { runId: 'run-bf' };
    });
    const api = createApi({ startRun });
    const backfill: RunBackfill = {
      skill: 'motion-design',
      plugin: 'brand-kit',
      agent: 'codex-cli',
      nonce: 1,
    };
    const { container, root } = mount({ api, backfill });

    await waitFor(() => {
      const inputs = Array.from(container.querySelectorAll('input'));
      return inputs.some(
        (node) => (node as HTMLInputElement).value === 'motion-design',
      );
    });
    const inputs = Array.from(
      container.querySelectorAll('input'),
    ) as HTMLInputElement[];
    expect(inputs.some((node) => node.value === 'motion-design')).toBe(true);
    expect(inputs.some((node) => node.value === 'brand-kit')).toBe(true);
    const agentSelect = container.querySelector('select');
    expect(agentSelect).not.toBeNull();

    await submit(container);
    await waitFor(() => (startRun.mock.calls.length > 0 ? true : false));
    expect(startRun.mock.calls[0]?.[0]).toMatchObject({
      prompt: '做一张落地页',
      skill: 'motion-design',
      plugin: 'brand-kit',
      agent: 'codex-cli',
    });

    root.unmount();
  });

  it('目录回填为空时不改写表单', async () => {
    const api = createApi();
    const { container, root } = mount({ api, backfill: null });
    const inputs = Array.from(
      container.querySelectorAll('input'),
    ) as HTMLInputElement[];
    expect(inputs.every((node) => node.value === '')).toBe(true);
    root.unmount();
  });
});
