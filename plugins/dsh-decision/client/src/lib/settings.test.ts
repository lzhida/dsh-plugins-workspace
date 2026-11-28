/**
 * decision-tools 客户端设置纯函数单测（决策工具系列 6/11）。
 *
 * 覆盖：归一化（缺省回落 schema 默认 / volatile 原始值透传 / ledgerEnabled
 * 仅显式 false 才关）、草稿叠加与脏检查、保存 ops 构造、输入宽容解析、
 * 十开关字段映射。
 *
 * @module dsh-decision/client/lib/settings.test
 */

import { describe, expect, it } from 'vitest';

import {
  beginDraft,
  buildMutations,
  clampSettings,
  FALLBACK_MODES,
  isDirty,
  parseCountInput,
  parseFloatInput,
  readSavedSettings,
  resolveView,
  TOOL_SWITCH_FIELDS,
  type Settings,
} from './settings.ts';

const BASE: Settings = {
  systemoneBaseUrl: 'https://decision.example.internal',
  systemoneApiKey: 'key-test',
  systemoneModel: 'model-test',
  systemoneTimeoutMs: 30_000,
  systemoneVerifiedAt: '',
  systemoneVerifyError: '',
  toolsDecideEnabled: false,
  toolsGateEnabled: false,
  toolsRerankEnabled: false,
  toolsBatchEnabled: false,
  toolsLocateEnabled: false,
  toolsUsageEnabled: false,
  toolsHistoryEnabled: false,
  toolsRecheckEnabled: false,
  toolsCalibrateEnabled: false,
  toolsArbiterEnabled: false,
  budgetEnabled: true,
  budgetMaxCallsPerDay: 200,
  budgetMaxTokensPerDay: 200_000,
  budgetMaxCostUsdPerDay: 0,
  budgetResetHourUtc: 0,
  costInputPer1kTokens: 0,
  costOutputPer1kTokens: 0,
  fallbackEnabled: false,
  fallbackProvider: '',
  fallbackModel: '',
  fallbackMinConfidence: 0.7,
  fallbackMode: 'auto-fallback',
  fallbackTimeoutMs: 60_000,
  fallbackMaxCallsPerDay: 50,
  ledgerEnabled: true,
  ledgerMaxEntries: 1000,
  gateAllowThreshold: 0.8,
};

describe('readSavedSettings', () => {
  it('null 快照回落 schema 默认值', () => {
    const saved = readSavedSettings(null, 7);
    expect(saved.revision).toBe(7);
    expect(saved.systemoneBaseUrl).toBe('');
    expect(saved.systemoneTimeoutMs).toBe(30_000);
    expect(saved.budgetMaxCallsPerDay).toBe(200);
    expect(saved.budgetMaxTokensPerDay).toBe(200_000);
    expect(saved.budgetMaxCostUsdPerDay).toBe(0);
    expect(saved.budgetResetHourUtc).toBe(0);
    expect(saved.fallbackMinConfidence).toBe(0.7);
    expect(saved.fallbackMode).toBe('auto-fallback');
    expect(saved.fallbackTimeoutMs).toBe(60_000);
    expect(saved.fallbackMaxCallsPerDay).toBe(50);
    expect(saved.ledgerEnabled).toBe(true);
    expect(saved.ledgerMaxEntries).toBe(1000);
    expect(saved.gateAllowThreshold).toBe(0.8);
  });

  it('保存值透传且不引用快照内部对象', () => {
    const raw = { ...BASE, toolsDecideEnabled: true };
    const saved = readSavedSettings(raw as Record<string, unknown>, 3);
    expect(saved.toolsDecideEnabled).toBe(true);
    expect(saved).not.toBe(raw);
  });

  it('ledgerEnabled 仅显式 false 才关闭（缺省/undefined 均开启）', () => {
    expect(readSavedSettings({}, 1).ledgerEnabled).toBe(true);
    expect(readSavedSettings({ ledgerEnabled: false }, 1).ledgerEnabled).toBe(
      false,
    );
    expect(readSavedSettings({ ledgerEnabled: 'false' }, 1).ledgerEnabled).toBe(
      true,
    );
  });

  it('fallbackMode 越界回落闭集默认', () => {
    expect(readSavedSettings({ fallbackMode: 'both' }, 1).fallbackMode).toBe(
      'both',
    );
    expect(readSavedSettings({ fallbackMode: 'yolo' }, 1).fallbackMode).toBe(
      'auto-fallback',
    );
    expect(FALLBACK_MODES).toEqual([
      'auto-fallback',
      'explicit-arbiter',
      'both',
    ]);
  });

  it('非有限数值回落默认（timeout/cost/threshold）', () => {
    const saved = readSavedSettings(
      {
        systemoneTimeoutMs: 'soon',
        budgetMaxCostUsdPerDay: Number.NaN,
        gateAllowThreshold: null,
      },
      1,
    );
    expect(saved.systemoneTimeoutMs).toBe(30_000);
    expect(saved.budgetMaxCostUsdPerDay).toBe(0);
    expect(saved.gateAllowThreshold).toBe(0.8);
  });
});

describe('draft / dirty / mutations', () => {
  it('beginDraft 克隆已保存值并携带 revision', () => {
    const saved = readSavedSettings(BASE as Record<string, unknown>, 5);
    const draft = beginDraft(saved);
    expect(draft.revision).toBe(5);
    expect(draft.values).toEqual(BASE);
    expect(draft.values).not.toBe(saved);
  });

  it('resolveView 用草稿覆盖已保存值', () => {
    const saved = readSavedSettings(BASE as Record<string, unknown>, 5);
    const draft = beginDraft(saved);
    draft.values.toolsDecideEnabled = true;
    const view = resolveView(saved, draft);
    expect(view.toolsDecideEnabled).toBe(true);
    expect(view.systemoneModel).toBe('model-test');
    expect(view).not.toHaveProperty('revision');
    expect(resolveView(saved, null)).toEqual(saved);
  });

  it('isDirty 只对差异字段为真，revision 不参与', () => {
    const saved = readSavedSettings(BASE as Record<string, unknown>, 5);
    const draft = beginDraft(saved);
    expect(isDirty(resolveView(saved, draft), saved)).toBe(false);
    draft.values.toolsGateEnabled = true;
    expect(isDirty(resolveView(saved, draft), saved)).toBe(true);
  });

  it('buildMutations 逐字段产出 set op（path 为单元素数组）', () => {
    const saved = readSavedSettings(BASE as Record<string, unknown>, 5);
    const draft = beginDraft(saved);
    draft.values.toolsRerankEnabled = true;
    const ops = buildMutations(draft.values);
    expect(ops).toHaveLength(Object.keys(BASE).length);
    const rerank = ops.find((op) => op.path[0] === 'toolsRerankEnabled');
    expect(rerank).toEqual({
      op: 'set',
      path: ['toolsRerankEnabled'],
      value: true,
    });
    expect(ops.every((op) => op.op === 'set' && op.path.length === 1)).toBe(
      true,
    );
  });
});

describe('ten tool switch fields', () => {
  it('十开关字段名与契约配置面一致且无重复', () => {
    expect(TOOL_SWITCH_FIELDS).toEqual([
      'toolsDecideEnabled',
      'toolsGateEnabled',
      'toolsRerankEnabled',
      'toolsBatchEnabled',
      'toolsLocateEnabled',
      'toolsUsageEnabled',
      'toolsHistoryEnabled',
      'toolsRecheckEnabled',
      'toolsCalibrateEnabled',
      'toolsArbiterEnabled',
    ]);
    expect(new Set(TOOL_SWITCH_FIELDS).size).toBe(10);
  });
});

describe('input parsing', () => {
  it('parseCountInput 非法/负数归 0，其余取整', () => {
    expect(parseCountInput('42')).toBe(42);
    expect(parseCountInput('abc')).toBe(0);
    expect(parseCountInput('-3')).toBe(0);
    expect(parseCountInput('7.9')).toBe(7);
  });

  it('parseFloatInput 非法/负数归 0，保留小数', () => {
    expect(parseFloatInput('0.85')).toBe(0.85);
    expect(parseFloatInput('abc')).toBe(0);
    expect(parseFloatInput('-1')).toBe(0);
  });
});

describe('clampSettings（读回域归一）', () => {
  it('越界数值夹进合法域而不是回落默认（区间镜像宿主 schema）', () => {
    const clamped = clampSettings({
      ...BASE,
      systemoneTimeoutMs: 999_999,
      budgetMaxCallsPerDay: 999_999,
      budgetMaxTokensPerDay: -1,
      budgetMaxCostUsdPerDay: -2,
      budgetResetHourUtc: 99,
      costInputPer1kTokens: 500,
      fallbackMinConfidence: 5,
      fallbackTimeoutMs: 1,
      fallbackMaxCallsPerDay: 99_999,
      ledgerMaxEntries: -7,
      gateAllowThreshold: 4,
    });
    expect(clamped.systemoneTimeoutMs).toBe(300_000);
    expect(clamped.budgetMaxCallsPerDay).toBe(100_000);
    expect(clamped.budgetMaxTokensPerDay).toBe(0);
    expect(clamped.budgetMaxCostUsdPerDay).toBe(0);
    expect(clamped.budgetResetHourUtc).toBe(23);
    expect(clamped.costInputPer1kTokens).toBe(100);
    expect(clamped.fallbackMinConfidence).toBe(1);
    expect(clamped.fallbackTimeoutMs).toBe(1_000);
    expect(clamped.fallbackMaxCallsPerDay).toBe(10_000);
    expect(clamped.ledgerMaxEntries).toBe(100);
    expect(clamped.gateAllowThreshold).toBe(1);
  });

  it('readSavedSettings 读回时即完成域归一', () => {
    const saved = readSavedSettings(
      { ...BASE, systemoneTimeoutMs: 999_999, gateAllowThreshold: -1 },
      3,
    );
    expect(saved.systemoneTimeoutMs).toBe(300_000);
    expect(saved.gateAllowThreshold).toBe(0.05);
    expect(saved.revision).toBe(3);
  });
});
