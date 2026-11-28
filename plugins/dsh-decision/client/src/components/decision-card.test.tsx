// @vitest-environment jsdom
/**
 * decision-tools 设置卡渲染测试（决策工具系列 6/11）。
 *
 * 按用户既定偏好把「人工点验」自动化：jsdom + @testing-library 渲染
 * page 视图，覆盖——①十工具开关全部可交互且状态来自快照；②验证按钮
 * 成功/失败两态（fetch stub）；③拨动开关出现脏标 → 保存调用 mutate 且
 * 草稿清空；④只读态禁用保存。
 *
 * @module dsh-decision/client/components/decision-card.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import { DecisionCard } from './decision-card.tsx';
import { TOOL_SWITCH_FIELDS, TOOL_SWITCH_LABEL_KEYS } from '../constants.ts';
import { staticT } from '../dict.ts';
import { DEFAULT_SETTINGS } from '../lib/settings.ts';
import type { ConfigScope, MutationOp } from '../types.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const t = staticT;

function makeScope(overrides?: {
  value?: Record<string, unknown>;
  writable?: boolean;
  revision?: number;
  mutate?: ConfigScope['mutate'];
}): ConfigScope {
  const snapshot = {
    status: 'served' as const,
    value: {
      ...DEFAULT_SETTINGS,
      systemoneBaseUrl: 'https://decision.example.internal',
      systemoneApiKey: 'key-test',
      systemoneModel: 'model-test',
      budgetEnabled: true,
      ...overrides?.value,
    },
    writable: overrides?.writable ?? true,
    revision: overrides?.revision ?? 7,
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate: overrides?.mutate ?? (async () => {}),
  };
}

function toolLabel(field: (typeof TOOL_SWITCH_FIELDS)[number]): string {
  return t(TOOL_SWITCH_LABEL_KEYS[field]);
}

describe('DecisionCard page view', () => {
  it('十工具开关全部渲染且状态来自快照', () => {
    const value: Record<string, unknown> = {
      toolsDecideEnabled: true,
      toolsGateEnabled: true,
      toolsRerankEnabled: false,
      toolsBatchEnabled: false,
      toolsLocateEnabled: false,
      toolsUsageEnabled: false,
      toolsHistoryEnabled: false,
      toolsRecheckEnabled: false,
      toolsCalibrateEnabled: false,
      toolsArbiterEnabled: false,
    };
    render(<DecisionCard scope={makeScope({ value })} />);
    for (const field of TOOL_SWITCH_FIELDS) {
      const toggle = screen.getByRole('switch', { name: toolLabel(field) });
      expect(toggle.getAttribute('aria-checked')).toBe(
        value[field] === true ? 'true' : 'false',
      );
    }
  });

  it('验证成功两态：点击后显示 ok 徽标与延迟', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              model: 'model-test',
              latencyMs: 42,
            }),
          }) as Response,
      ),
    );
    render(<DecisionCard scope={makeScope()} />);
    fireEvent.click(screen.getByRole('button', { name: t('verify.button') }));
    const badge = await screen.findByText(/Latency\s+42ms/);
    expect(badge.textContent).toContain('model-test');
    expect(badge.textContent).toContain(t('verify.ok'));
  });

  it('验证失败两态：ok:false 显示失败原因徽标', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({
              ok: false,
              reason: 'model-verify-failed: 连接被拒绝',
            }),
          }) as Response,
      ),
    );
    render(<DecisionCard scope={makeScope()} />);
    fireEvent.click(screen.getByRole('button', { name: t('verify.button') }));
    const badge = await screen.findByText(/连接被拒绝/);
    expect(badge.textContent).toContain(t('verify.fail'));
  });

  it('路由缺失态：404 显示重载提示，且回写人类文案而非稳定 key', async () => {
    const mutate = vi.fn(async (ops: MutationOp[], revision: number) => {
      void ops;
      void revision;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('verify route returned 404');
      }),
    );
    render(<DecisionCard scope={makeScope({ mutate })} />);
    fireEvent.click(screen.getByRole('button', { name: t('verify.button') }));
    await screen.findByText(t('verify.route-missing'));
    await waitFor(() => {
      expect(mutate).toHaveBeenCalled();
    });
    const ops = mutate.mock.calls[0]?.[0] as Array<{
      path: string[];
      value: unknown;
    }>;
    const errorOp = ops.find((op) => op.path[0] === 'systemoneVerifyError');
    // 落配置的是人类可读文案，不是 'verify.route-missing' 这个稳定 key。
    expect(String(errorOp?.value)).toBe(t('verify.route-missing'));
    expect(String(errorOp?.value)).not.toBe('verify.route-missing');
  });

  it('拨动开关出现脏标，保存调用 mutate 并清空草稿', async () => {
    const mutate = vi.fn(async (ops: MutationOp[], revision: number) => {
      void ops;
      void revision;
    });
    render(<DecisionCard scope={makeScope({ mutate })} />);
    const decideToggle = screen.getByRole('switch', {
      name: toolLabel('toolsDecideEnabled'),
    });
    fireEvent.click(decideToggle);
    expect(screen.getByText(t('common.unsaved'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('common.save') }));
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledTimes(1);
    });
    const ops = mutate.mock.calls[0]?.[0] as Array<{
      path: string[];
      value: unknown;
    }>;
    const decideOp = ops.find((op) => op.path[0] === 'toolsDecideEnabled');
    expect(decideOp?.value).toBe(true);
    await waitFor(() => {
      expect(screen.queryByText(t('common.unsaved'))).toBeNull();
    });
    expect(screen.getByText(t('common.saved'))).toBeTruthy();
  });

  it('只读态下保存按钮禁用', () => {
    render(<DecisionCard scope={makeScope({ writable: false })} />);
    const save = screen.getByRole('button', { name: t('common.save') });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(t('common.readonly'))).toBeTruthy();
  });

  it('summary 视图只出一行说明', () => {
    render(<DecisionCard scope={makeScope()} view="summary" />);
    expect(screen.getByText(t('page.description'))).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('验证成功后回写 systemoneVerifiedAt（不回写 apiKey）', async () => {
    const mutate = vi.fn(async (ops: MutationOp[], revision: number) => {
      void ops;
      void revision;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              model: 'model-test',
              latencyMs: 42,
            }),
          }) as Response,
      ),
    );
    render(<DecisionCard scope={makeScope({ mutate })} />);
    fireEvent.click(screen.getByRole('button', { name: t('verify.button') }));
    await waitFor(() => {
      expect(mutate).toHaveBeenCalled();
    });
    const ops = mutate.mock.calls[0]?.[0] as Array<{
      path: string[];
      value: unknown;
    }>;
    const paths = ops.map((op) => op.path[0]);
    expect(paths).toContain('systemoneVerifiedAt');
    expect(paths).toContain('systemoneVerifyError');
    expect(paths).not.toContain('systemoneApiKey');
  });

  it('验证回写后草稿 revision 跟随宿主：再保存不冲突', async () => {
    // 回归测试（V2 复审 major）：persistVerifyState 会 bump 宿主 revision，
    // 打开中的草稿必须同步到新 revision，否则「先验证、再保存」必然冲突。
    let revision = 7;
    const mutations: Array<{ ops: MutationOp[]; revision: number }> = [];
    const scope: ConfigScope = {
      getSnapshot: () => ({
        status: 'served',
        value: {
          ...DEFAULT_SETTINGS,
          systemoneBaseUrl: 'https://decision.example.internal',
          systemoneModel: 'model-test',
          budgetEnabled: true,
        },
        writable: true,
        revision,
      }),
      subscribe: () => () => {},
      mutate: async (ops, rev) => {
        mutations.push({ ops, revision: rev });
        revision += 1;
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              model: 'model-test',
              latencyMs: 42,
            }),
          }) as Response,
      ),
    );
    render(<DecisionCard scope={scope} />);
    // 1) 拨开关 → 草稿打开（基于 revision 7）
    fireEvent.click(
      screen.getByRole('switch', { name: toolLabel('toolsDecideEnabled') }),
    );
    // 2) 验证成功 → 回写两条 op（7→8），草稿 revision 应同步到 8
    fireEvent.click(screen.getByRole('button', { name: t('verify.button') }));
    await waitFor(() => {
      expect(mutations.length).toBe(1);
    });
    // 3) 保存 → 必须携带宿主最新 revision（8），且不显示冲突文案
    fireEvent.click(screen.getByRole('button', { name: t('common.save') }));
    await waitFor(() => {
      expect(mutations.length).toBe(2);
    });
    expect(mutations[1]?.revision).toBe(8);
    await waitFor(() => {
      expect(screen.queryByText(t('common.unsaved'))).toBeNull();
    });
    expect(screen.queryByText(t('common.conflict'))).toBeNull();
    expect(screen.getByText(t('common.saved'))).toBeTruthy();
  });

  it('验证失败后回写 systemoneVerifyError', async () => {
    const mutate = vi.fn(async (ops: MutationOp[], revision: number) => {
      void ops;
      void revision;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({
              ok: false,
              reason: 'model-verify-failed: 连接被拒绝',
            }),
          }) as Response,
      ),
    );
    render(<DecisionCard scope={makeScope({ mutate })} />);
    fireEvent.click(screen.getByRole('button', { name: t('verify.button') }));
    await waitFor(() => {
      expect(mutate).toHaveBeenCalled();
    });
    const ops = mutate.mock.calls[0]?.[0] as Array<{
      path: string[];
      value: unknown;
    }>;
    const errorOp = ops.find((op) => op.path[0] === 'systemoneVerifyError');
    expect(String(errorOp?.value)).toContain('连接被拒绝');
  });

  it('保存冲突（SETTINGS_CONFLICT）显示冲突文案，其它错误显示错误文案', async () => {
    const conflictError = Object.assign(new Error('stale'), {
      code: 'SETTINGS_CONFLICT',
    });
    const mutate = vi.fn(async () => {
      throw conflictError;
    });
    render(<DecisionCard scope={makeScope({ mutate })} />);
    fireEvent.click(
      screen.getByRole('switch', { name: toolLabel('toolsDecideEnabled') }),
    );
    fireEvent.click(screen.getByRole('button', { name: t('common.save') }));
    await waitFor(() => {
      expect(screen.getAllByText(t('common.conflict')).length).toBeGreaterThan(
        0,
      );
    });

    cleanup();
    const plainError = vi.fn(async (ops: MutationOp[], revision: number) => {
      void ops;
      void revision;
      throw new Error('boom');
    });
    render(<DecisionCard scope={makeScope({ mutate: plainError })} />);
    fireEvent.click(
      screen.getByRole('switch', { name: toolLabel('toolsDecideEnabled') }),
    );
    fireEvent.click(screen.getByRole('button', { name: t('common.save') }));
    await waitFor(() => {
      expect(screen.getByText('boom')).toBeTruthy();
    });
  });
});
