import { describe, expect, it } from 'vitest';

import { resolveToolsConfig } from '../config/index.ts';
import { createMemoryLedger, type LedgerEntry } from '../runtime/ledger.ts';
import {
  aggregateUsage,
  computeBurnRate,
  createUsageTool,
  percentileNearestRank,
  planUsage,
  runUsage,
  USAGE_P95_MIN_SAMPLES,
  USAGE_TOOL,
} from './usage.ts';

const baseConfig = (overrides: Record<string, unknown> = {}) =>
  resolveToolsConfig({
    systemoneBaseUrl: 'https://decision.example.internal',
    systemoneApiKey: 'key-test',
    systemoneModel: 'model-test',
    toolsUsageEnabled: true,
    ledgerEnabled: true,
    budgetEnabled: true,
    budgetMaxCallsPerDay: 100,
    budgetMaxTokensPerDay: 100000,
    budgetMaxCostUsdPerDay: 0,
    budgetResetHourUtc: 0,
    ...overrides,
  });

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
  latencyMs: 100,
  costUsd: 0,
  costEstimated: false,
  ...overrides,
});

describe('dsh-decision usage 工具', () => {
  const now = new Date('2026-03-15T12:00:00.000Z');

  it('工具名遵循 decision_ 前缀', () => {
    expect(USAGE_TOOL).toBe('decision_usage');
  });

  it('planUsage 缺省 24h 并校验窗口闭集', () => {
    const ok = planUsage({});
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.plan.window).toBe('24h');
    const bad = planUsage({ window: '2h' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('invalid-arguments');
    const filtered = planUsage({
      window: '7d',
      tool: 'decision_gate',
      budgetCheckOnly: true,
    });
    if (!filtered.ok) throw new Error('expected ok');
    expect(filtered.plan).toEqual({
      window: '7d',
      tool: 'decision_gate',
      budgetCheckOnly: true,
    });
  });

  it('percentileNearestRank 采用最近邻秩', () => {
    expect(percentileNearestRank([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(percentileNearestRank([10, 20, 30, 40, 50], 95)).toBe(50);
    expect(percentileNearestRank([], 95)).toBe(0);
  });

  it('aggregateUsage 汇总调用、token、成本与样本', () => {
    const metrics = aggregateUsage([
      mkEntry({
        usage: { inputTokens: 100, outputTokens: 50, calls: 1 },
        latencyMs: 100,
      }),
      mkEntry({
        usage: { inputTokens: 200, outputTokens: 100, calls: 2 },
        latencyMs: 300,
        costUsd: 0.001,
        costEstimated: true,
      }),
      mkEntry({
        status: 'error',
        usage: { inputTokens: null, outputTokens: null, calls: 1 },
        latencyMs: 0,
      }),
    ]);
    expect(metrics.calls).toBe(4);
    expect(metrics.inputTokens).toBe(300);
    expect(metrics.outputTokens).toBe(150);
    expect(metrics.samples).toBe(2);
    expect(metrics.costEstimated).toBe(true);
  });

  it('延迟样本不足阈值时 p95 为 null 但 p50 可用', () => {
    const entries = Array.from(
      { length: USAGE_P95_MIN_SAMPLES - 1 },
      (_unused, index) =>
        mkEntry({
          decisionId: `dec_${String(index).padStart(26, '0')}`,
          latencyMs: 10 * (index + 1),
        }),
    );
    const metrics = aggregateUsage(entries);
    expect(metrics.samples).toBe(USAGE_P95_MIN_SAMPLES - 1);
    expect(metrics.latencyP95Ms).toBeNull();
    expect(metrics.latencyP50Ms).not.toBeNull();
  });

  it('延迟样本达到阈值时 p95 有值', () => {
    const entries = Array.from(
      { length: USAGE_P95_MIN_SAMPLES },
      (_unused, index) =>
        mkEntry({
          decisionId: `dec_${String(index).padStart(26, '0')}`,
          latencyMs: 10 * (index + 1),
        }),
    );
    const metrics = aggregateUsage(entries);
    // nearest-rank：ceil(0.95 × 20) - 1 = 18 → 第 19 个样本 190ms
    expect(metrics.latencyP95Ms).toBe(190);
  });

  it('computeBurnRate 在预算关闭时为 null', () => {
    const ledger = createMemoryLedger(10);
    expect(
      computeBurnRate(baseConfig({ budgetEnabled: false }), ledger, now),
    ).toBeNull();
  });

  it('computeBurnRate 取瓶颈维度并给出周期与投影比', () => {
    const ledger = createMemoryLedger(10);
    ledger.append(
      mkEntry({
        ts: '2026-03-15T01:00:00.000Z',
        usage: { inputTokens: 1, outputTokens: 1, calls: 50 },
      }),
    );
    const burnRate = computeBurnRate(baseConfig(), ledger, now);
    expect(burnRate).not.toBeNull();
    if (!burnRate) throw new Error('expected burnRate');
    expect(burnRate.dimension).toBe('calls');
    expect(burnRate.used).toBe(50);
    expect(burnRate.budget).toBe(100);
    expect(burnRate.ratio).toBe(0.5);
    expect(burnRate.projectedRatio).toBeGreaterThan(burnRate.ratio);
    expect(burnRate.periodStart).toBe('2026-03-15T00:00:00.000Z');
    expect(burnRate.periodEnd).toBe('2026-03-16T00:00:00.000Z');
  });

  it('computeBurnRate 三维额度全部不设限时为 null', () => {
    const ledger = createMemoryLedger(10);
    ledger.append(mkEntry());
    const burnRate = computeBurnRate(
      baseConfig({
        budgetMaxCallsPerDay: 0,
        budgetMaxTokensPerDay: 0,
        budgetMaxCostUsdPerDay: 0,
      }),
      ledger,
      now,
    );
    expect(burnRate).toBeNull();
  });

  it('runUsage 汇总窗口内账本并返回契约出参', () => {
    const ledger = createMemoryLedger(10);
    ledger.append(mkEntry({ ts: '2026-03-15T09:00:00.000Z' }));
    const result = runUsage(
      { window: '24h' },
      { readConfig: () => baseConfig(), ledger },
      now,
    );
    expect(result.ok).toBe(true);
    expect(result.window).toBe('24h');
    expect(result.calls).toBe(1);
    expect(result.inputTokens).toBe(100);
    expect(result.samples).toBe(1);
    expect(result.budget).toEqual({
      enabled: true,
      hardLimit: true,
      exceeded: false,
    });
  });

  it('预算关闭时 budget.enabled=false 且 hardLimit=false', () => {
    const ledger = createMemoryLedger(10);
    ledger.append(mkEntry({ ts: '2026-03-15T09:00:00.000Z' }));
    const result = runUsage(
      { window: '24h' },
      { readConfig: () => baseConfig({ budgetEnabled: false }), ledger },
      now,
    );
    expect(result.ok).toBe(true);
    expect(result.budget).toEqual({
      enabled: false,
      hardLimit: false,
      exceeded: false,
    });
  });

  it('runUsage 按工具过滤并排除窗口外条目', () => {
    const ledger = createMemoryLedger(10);
    ledger.append(
      mkEntry({ ts: '2026-03-15T09:00:00.000Z', tool: 'decision_decide' }),
    );
    ledger.append(
      mkEntry({ ts: '2026-03-14T09:00:00.000Z', tool: 'decision_gate' }),
    );
    const result = runUsage(
      { window: '1h', tool: 'decision_gate' },
      { readConfig: () => baseConfig(), ledger },
      now,
    );
    expect(result.ok).toBe(true);
    expect(result.calls).toBe(0);
  });

  it('budgetCheckOnly 时用量指标为 null 但保留燃尽率', () => {
    const ledger = createMemoryLedger(10);
    ledger.append(mkEntry({ ts: '2026-03-15T09:00:00.000Z' }));
    const result = runUsage(
      { budgetCheckOnly: true },
      { readConfig: () => baseConfig(), ledger },
      now,
    );
    expect(result.calls).toBeNull();
    expect(result.samples).toBeNull();
    expect(result.burnRate).not.toBeNull();
    expect(result.budget).toEqual({
      enabled: true,
      hardLimit: true,
      exceeded: false,
    });
  });

  it('窗口内用量超过预算时 budget.exceeded 为 true', () => {
    const ledger = createMemoryLedger(10);
    ledger.append(
      mkEntry({
        ts: '2026-03-15T01:00:00.000Z',
        usage: { inputTokens: 1, outputTokens: 1, calls: 150 },
      }),
    );
    const result = runUsage(
      {},
      { readConfig: () => baseConfig(), ledger },
      now,
    );
    expect(result.budget).toEqual({
      enabled: true,
      hardLimit: true,
      exceeded: true,
    });
  });

  it('开关关闭 → tool-disabled', async () => {
    const config = baseConfig({ toolsUsageEnabled: false });
    const result = runUsage(
      {},
      { readConfig: () => config, ledger: createMemoryLedger(5) },
      now,
    );
    expect(result.ok).toBe(false);
    expect((result.error as { code: string }).code).toBe('tool-disabled');
    const viaTool = (await createUsageTool({
      readConfig: () => config,
    }).execute?.({}, {} as never)) as Record<string, unknown>;
    expect((viaTool.error as { code: string }).code).toBe('tool-disabled');
  });

  it('零条目时返回全 0 值而不是 null', () => {
    const config = baseConfig({
      budgetEnabled: true,
      budgetMaxCallsPerDay: 100,
    });
    const result = runUsage({}, { readConfig: () => config }, now);
    expect(result.ok).toBe(true);
    expect(result.calls).toBe(0);
    expect(result.costUsd).toBe(0);
    expect(result.costEstimated).toBe(false);
    expect(result.samples).toBe(0);
    expect(result.latencyP95Ms).toBeNull();
    // 预算开启且配额 >0 时，零用量也必须返回 burnRate（ratio=0），
    // 不能因为「比值都不是正数」而误判为 null。
    const burn = result.burnRate as {
      dimension: string;
      used: number;
      budget: number;
      ratio: number;
    } | null;
    expect(burn).not.toBeNull();
    expect(burn?.dimension).toBe('calls');
    expect(burn?.used).toBe(0);
    expect(burn?.budget).toBe(100);
    expect(burn?.ratio).toBe(0);
  });
});
