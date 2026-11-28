import { describe, expect, it } from 'vitest';

import {
  budgetWindow,
  budgetExceeded,
  createPassthroughBudgetGate,
  createWindowedBudgetGate,
  sumWindowUsage,
} from './budget.ts';
import { createMemoryLedger, type LedgerEntry } from './ledger.ts';

describe('dsh-decision 预算闸', () => {
  const mkEntry = (overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
    decisionId: 'dec_0123456789ABCDEFGHJKMNPQRS',
    ts: '2026-03-15T09:00:00.000Z',
    tool: 'decision_decide',
    mode: 'primary',
    source: 'decision-model',
    questionId: 'q1',
    questionType: 'noul',
    questionSummary: null,
    status: 'ok',
    payload: { value: 0.9, confidence: 0.9, distribution: null, legend: null },
    outcome: { state: 'unknown', value: null, source: null, updatedAt: null },
    usage: { inputTokens: 100, outputTokens: 50, calls: 1 },
    latencyMs: 20,
    costUsd: 0,
    costEstimated: false,
    ...overrides,
  });

  it('budgetWindow 以 resetHourUtc 为界切自然日窗口', () => {
    const now = new Date('2026-03-15T10:00:00.000Z');
    const window = budgetWindow(now, 8);
    expect(window.start.toISOString()).toBe('2026-03-15T08:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-03-16T08:00:00.000Z');
  });

  it('当前时刻早于当日重置点时窗口回退一天', () => {
    const now = new Date('2026-03-15T07:00:00.000Z');
    const window = budgetWindow(now, 8);
    expect(window.start.toISOString()).toBe('2026-03-14T08:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-03-15T08:00:00.000Z');
  });

  it('resetHourUtc 越界与非法值回落到 0..23 界内', () => {
    expect(
      budgetWindow(
        new Date('2026-03-15T10:00:00.000Z'),
        25,
      ).start.getUTCHours(),
    ).toBe(23);
    expect(
      budgetWindow(
        new Date('2026-03-15T10:00:00.000Z'),
        -1,
      ).start.getUTCHours(),
    ).toBe(0);
    expect(
      budgetWindow(
        new Date('2026-03-15T10:00:00.000Z'),
        Number.NaN,
      ).start.getUTCHours(),
    ).toBe(0);
  });

  it('sumWindowUsage 只聚合窗口内条目且容忍缺失字段', () => {
    const window = budgetWindow(new Date('2026-03-15T10:00:00.000Z'), 8);
    const usage = sumWindowUsage(
      [
        mkEntry({ usage: { inputTokens: 100, outputTokens: 50, calls: 2 } }),
        mkEntry({
          ts: '2026-03-14T01:00:00.000Z',
          usage: { inputTokens: 999, outputTokens: 999, calls: 99 },
        }),
        mkEntry({
          usage: { inputTokens: null, outputTokens: null, calls: 1 },
          costUsd: null,
        }),
      ],
      window,
    );
    expect(usage.calls).toBe(3);
    expect(usage.tokens).toBe(150);
    expect(usage.costUsd).toBe(0);
  });

  it('windowed 闸在预算关闭时直通', () => {
    const gate = createWindowedBudgetGate({
      readConfig: () => ({
        budgetEnabled: false,
        budgetMaxCallsPerDay: 0,
        budgetMaxTokensPerDay: 0,
        budgetMaxCostUsdPerDay: 0,
        budgetResetHourUtc: 0,
        fallbackMaxCallsPerDay: 0,
      }),
      ledger: createMemoryLedger(10),
    });
    expect(gate.check({ tool: 'decision_decide' })).toEqual({ ok: true });
  });

  it('窗口内调用数达到上限即按 calls 维度拒绝', () => {
    const ledger = createMemoryLedger(10);
    ledger.append(
      mkEntry({ usage: { inputTokens: 1, outputTokens: 1, calls: 5 } }),
    );
    const gate = createWindowedBudgetGate({
      readConfig: () => ({
        budgetEnabled: true,
        budgetMaxCallsPerDay: 5,
        budgetMaxTokensPerDay: 0,
        budgetMaxCostUsdPerDay: 0,
        budgetResetHourUtc: 8,
        fallbackMaxCallsPerDay: 0,
      }),
      ledger,
      now: () => new Date('2026-03-15T10:00:00.000Z'),
    });
    const result = gate.check({ tool: 'decision_decide' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('budget-exceeded');
      expect(result.dimension).toBe('calls');
    }
  });

  it('三维并存时取比值最高者为触顶维度', () => {
    const ledger = createMemoryLedger(10);
    ledger.append(
      mkEntry({
        usage: { inputTokens: 900, outputTokens: 100, calls: 2 },
        costUsd: 0.5,
      }),
    );
    const gate = createWindowedBudgetGate({
      readConfig: () => ({
        budgetEnabled: true,
        budgetMaxCallsPerDay: 100,
        budgetMaxTokensPerDay: 1000,
        budgetMaxCostUsdPerDay: 100,
        budgetResetHourUtc: 8,
        fallbackMaxCallsPerDay: 0,
      }),
      ledger,
      now: () => new Date('2026-03-15T10:00:00.000Z'),
    });
    const result = gate.check({ tool: 'decision_gate' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.dimension).toBe('tokens');
  });

  it('额度小于等于 0 视为该维度不设限而非零配额', () => {
    const ledger = createMemoryLedger(10);
    ledger.append(
      mkEntry({ usage: { inputTokens: 5, outputTokens: 5, calls: 9 } }),
    );
    const gate = createWindowedBudgetGate({
      readConfig: () => ({
        budgetEnabled: true,
        budgetMaxCallsPerDay: 0,
        budgetMaxTokensPerDay: 0,
        budgetMaxCostUsdPerDay: 0,
        budgetResetHourUtc: 8,
        fallbackMaxCallsPerDay: 0,
      }),
      ledger,
      now: () => new Date('2026-03-15T10:00:00.000Z'),
    });
    expect(gate.check({ tool: 'decision_decide' })).toEqual({ ok: true });
  });

  it('裁判调用走独立配额且只数兜底来源条目', () => {
    const ledger = createMemoryLedger(10);
    ledger.append(
      mkEntry({ usage: { inputTokens: 1, outputTokens: 1, calls: 3 } }),
    );
    ledger.append(
      mkEntry({
        source: 'llm-fallback-judge',
        usage: { inputTokens: 1, outputTokens: 1, calls: 2 },
      }),
    );
    const base = {
      budgetEnabled: true,
      budgetMaxCallsPerDay: 0,
      budgetMaxTokensPerDay: 0,
      budgetMaxCostUsdPerDay: 0,
      budgetResetHourUtc: 8,
    };
    const gate = (fallbackMaxCallsPerDay: number) =>
      createWindowedBudgetGate({
        readConfig: () => ({ ...base, fallbackMaxCallsPerDay }),
        ledger,
        now: () => new Date('2026-03-15T10:00:00.000Z'),
      });
    expect(
      gate(2).check({ tool: 'decision_decide', judge: true }),
    ).toMatchObject({ ok: false });
    expect(gate(5).check({ tool: 'decision_decide', judge: true })).toEqual({
      ok: true,
    });
    expect(gate(0).check({ tool: 'decision_decide', judge: true })).toEqual({
      ok: true,
    });
  });

  it('真实闸的 recordBlocked 保持 noop（call.ts 已落 blocked 条目防双写）', () => {
    const gate = createWindowedBudgetGate({
      readConfig: () => ({
        budgetEnabled: false,
        budgetMaxCallsPerDay: 0,
        budgetMaxTokensPerDay: 0,
        budgetMaxCostUsdPerDay: 0,
        budgetResetHourUtc: 0,
        fallbackMaxCallsPerDay: 0,
      }),
      ledger: createMemoryLedger(10),
    });
    expect(() => gate.recordBlocked('decision_decide', 'calls')).not.toThrow();
  });

  it('budgetExceeded 产出契约口径的超限失败结果', () => {
    const result = budgetExceeded('cost');
    expect(result.ok).toBe(false);
    expect(result.dimension).toBe('cost');
    expect(result.error.code).toBe('budget-exceeded');
    expect(result.error.retryable).toBe(false);
  });

  it('直通闸保持卡 2 行为（永远放行）', () => {
    const gate = createPassthroughBudgetGate();
    expect(gate.check({ tool: 'decision_decide' })).toEqual({ ok: true });
  });
});
