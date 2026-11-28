/**
 * decision_calibrate 单测（决策工具系列 10/11）。
 *
 * 覆盖卡 10 清单：
 * - 第 2 项：只读账本不调模型（未配置模型仍可用）；
 * - 第 3 项：Brier / 分桶 / 过自信口径合契约且可复算；
 * - 第 4 项：只统计已回填 outcome，未回填计数可见，样本不足桶显式标记。
 */

import { describe, expect, it } from 'vitest';

import {
  CALIBRATE_TOOL,
  buildCalibrateBuckets,
  calibrateBucketIndex,
  calibrateBucketLabel,
  collectCalibrateEntries,
  computeCalibrateMetrics,
  createCalibrateTool,
  planCalibrate,
  runCalibrate,
} from './calibrate.ts';
import {
  resolveToolsConfig,
  type ResolvedToolsConfig,
} from '../config/decision-tools.ts';
import {
  type LedgerEntry,
  type LedgerSink,
  createMemoryLedger,
} from '../runtime/ledger.ts';
import type { JsonValue } from '../systemone/types.ts';

const NOW = Date.parse('2026-03-01T00:00:00.000Z');

function config(overrides: Record<string, unknown> = {}): ResolvedToolsConfig {
  return resolveToolsConfig({
    // 故意不给 baseUrl / apiKey / model：calibrate 是纯本地工具，
    // 未配置模型也必须可用（清单第 2 项）。
    toolsCalibrateEnabled: true,
    ledgerEnabled: true,
    ...overrides,
  });
}

interface EntryInput {
  decisionId?: string;
  ts?: string;
  tool?: string;
  questionType?: 'noul' | 'choice' | 'score' | 'box' | null;
  status?: 'ok' | 'error' | 'blocked';
  value?: JsonValue;
  confidence?: number | null;
  distribution?: JsonValue;
  aggregated?: boolean;
  outcomeState?: 'unknown' | 'confirmed' | 'rejected' | 'revised';
}

function mkEntry(input: EntryInput = {}): LedgerEntry {
  const state = input.outcomeState ?? 'confirmed';
  return {
    decisionId: input.decisionId ?? 'dec_0123456789ABCDEFGHJKMNPQRS',
    ts: input.ts ?? new Date(NOW - 1000).toISOString(),
    tool: input.tool ?? 'decision_decide',
    mode: 'primary',
    source: 'decision-model',
    questionId: 'q1',
    questionType:
      input.questionType === undefined ? 'noul' : input.questionType,
    questionSummary: '原判定摘要',
    status: input.status ?? 'ok',
    payload: {
      value: input.value === undefined ? 0.9 : input.value,
      confidence: input.confidence === undefined ? 0.9 : input.confidence,
      distribution:
        input.distribution === undefined ? null : input.distribution,
      legend: null,
      ...(input.aggregated === undefined
        ? {}
        : { aggregated: input.aggregated }),
    },
    outcome: {
      state,
      value: state === 'unknown' ? null : state === 'confirmed' ? 1 : 0,
      source: state === 'unknown' ? null : 'downstream',
      updatedAt: state === 'unknown' ? null : new Date(NOW).toISOString(),
    },
    usage: { inputTokens: 10, outputTokens: 5, calls: 1 },
    latencyMs: 12,
    costUsd: null,
    costEstimated: false,
  };
}

function harness(
  entries: LedgerEntry[] = [],
  overrides: Record<string, unknown> = {},
): {
  deps: { readConfig(): ResolvedToolsConfig; ledger?: LedgerSink };
  ledger: LedgerSink;
} {
  const conf = config(overrides);
  const ledger = createMemoryLedger(1000);
  for (const entry of entries) ledger.append(entry);
  return {
    deps: { readConfig: () => conf, ledger },
    ledger,
  };
}

describe('decision 工具族 calibrate：校准审计（10/11）', () => {
  it('工具名符合契约', () => {
    expect(CALIBRATE_TOOL).toBe('decision_calibrate');
  });

  it('纯本地：未配置模型也能出统计（不出网、不产生成本）', () => {
    const { deps } = harness([mkEntry()]);
    const result = runCalibrate({}, deps, NOW);
    expect(result.ok).toBe(true);
    const out = result as unknown as {
      sampleSize: number;
      brier: number | null;
      insufficientSample: boolean;
    };
    expect(out.sampleSize).toBe(1);
    expect(out.brier).toBeNull();
    expect(out.insufficientSample).toBe(true);
  });

  it('空账本 → sampleSize=0、brier=null、桶级全部 insufficient', () => {
    const { deps } = harness([]);
    const result = runCalibrate({}, deps, NOW) as unknown as {
      ok: boolean;
      sampleSize: number;
      brier: number | null;
      buckets: Array<{
        n: number;
        hitRate: number | null;
        insufficient: boolean;
      }>;
      overconfidence: {
        meanGap: number | null;
        rate: number | null;
        significant: boolean;
      };
      excluded: { notBackfilled: number; nonBinary: number };
    };
    expect(result.ok).toBe(true);
    expect(result.sampleSize).toBe(0);
    expect(result.brier).toBeNull();
    expect(result.buckets).toHaveLength(10);
    expect(result.buckets.every((bucket) => bucket.insufficient)).toBe(true);
    expect(result.buckets.every((bucket) => bucket.hitRate === null)).toBe(
      true,
    );
    expect(result.overconfidence).toEqual({
      meanGap: null,
      rate: null,
      significant: false,
    });
  });

  it('Brier 分数可复算：BS=(1/N)Σ(p−o)²', () => {
    const samples = [
      { p: 0.9, o: 1 as const },
      { p: 0.2, o: 0 as const },
    ];
    const metrics = computeCalibrateMetrics(samples, {
      notBackfilled: 0,
      nonBinary: 0,
    });
    expect(metrics.sampleSize).toBe(2);
    // (0.9−1)² + (0.2−0)² = 0.01 + 0.04 = 0.05；/2 = 0.025
    expect(metrics.brier).toBeNull(); // N<20 → 不硬算
    const big = Array.from({ length: 20 }, () => ({ p: 0.9, o: 1 as const }));
    const bigMetrics = computeCalibrateMetrics(big, {
      notBackfilled: 0,
      nonBinary: 0,
    });
    expect(bigMetrics.insufficientSample).toBe(false);
    expect(bigMetrics.brier).toBe(0.01);
  });

  it('分桶：固定 10 桶、边界 [i/10,(i+1)/10)、标签形如 0.7–0.8', () => {
    expect(calibrateBucketLabel(7)).toBe('0.7–0.8');
    expect(calibrateBucketLabel(9)).toBe('0.9–1.0');
    expect(calibrateBucketIndex(0.72)).toBe(7);
    expect(calibrateBucketIndex(1)).toBe(9);
    expect(calibrateBucketIndex(0)).toBe(0);
  });

  it('桶内样本不足（n<5）→ insufficient=true 且 hitRate=null', () => {
    const buckets = buildCalibrateBuckets([
      { p: 0.75, o: 1 },
      { p: 0.76, o: 0 },
      { p: 0.77, o: 1 },
      { p: 0.78, o: 1 },
    ]);
    const bucket = buckets[7];
    expect(bucket.n).toBe(4);
    expect(bucket.insufficient).toBe(true);
    expect(bucket.hitRate).toBeNull();
  });

  it('桶内样本充足 → hitRate = 桶内 o 的均值', () => {
    const buckets = buildCalibrateBuckets([
      { p: 0.72, o: 1 },
      { p: 0.73, o: 1 },
      { p: 0.74, o: 0 },
      { p: 0.75, o: 1 },
      { p: 0.76, o: 0 },
    ]);
    expect(buckets[7].n).toBe(5);
    expect(buckets[7].insufficient).toBe(false);
    expect(buckets[7].hitRate).toBe(0.6);
  });

  it('只统计已回填 outcome：unknown 计 notBackfilled、revised 与 choice/score 计 nonBinary', () => {
    const { samples, excluded } = collectCalibrateEntries([
      mkEntry({ outcomeState: 'confirmed', value: 0.8 }),
      mkEntry({ outcomeState: 'rejected', value: 0.3 }),
      mkEntry({ outcomeState: 'unknown' }),
      mkEntry({ outcomeState: 'revised' }),
      mkEntry({ questionType: 'choice', outcomeState: 'confirmed' }),
      mkEntry({ questionType: 'score', outcomeState: 'confirmed' }),
    ]);
    expect(samples).toHaveLength(2);
    expect(samples[0]).toEqual({ p: 0.8, o: 1 });
    expect(samples[1]).toEqual({ p: 0.3, o: 0 });
    expect(excluded.notBackfilled).toBe(1);
    expect(excluded.nonBinary).toBe(3);
  });

  it('失败条目与 self-consistency 汇总副本不计入样本（避免重复计数）', () => {
    const { samples, excluded } = collectCalibrateEntries([
      mkEntry({ status: 'error', outcomeState: 'unknown' }),
      mkEntry({ status: 'blocked', outcomeState: 'unknown' }),
      mkEntry({ aggregated: true, outcomeState: 'confirmed' }),
      mkEntry({ outcomeState: 'confirmed' }),
    ]);
    expect(samples).toHaveLength(1);
    expect(excluded.notBackfilled).toBe(0);
    expect(excluded.nonBinary).toBe(0);
  });

  it('过自信指标：meanGap 正=高估、rate 为 (p−o)>0.1 的比例、significant 需 N≥20', () => {
    const twenty = Array.from({ length: 19 }, () => ({
      p: 0.9,
      o: 1 as const,
    }));
    const metrics = computeCalibrateMetrics([...twenty, { p: 0.5, o: 0 }], {
      notBackfilled: 0,
      nonBinary: 0,
    });
    expect(metrics.sampleSize).toBe(20);
    expect(metrics.insufficientSample).toBe(false);
    // meanGap = (19×(0.9−1) + (0.5−0)) / 20 = (−1.9 + 0.5)/20 = −0.07
    expect(metrics.overconfidence.meanGap).toBe(-0.07);
    // 过自信样本：p−o = 0.5 > 0.1 的那 1 条 → rate = 1/20 = 0.05
    expect(metrics.overconfidence.rate).toBe(0.05);
    expect(metrics.overconfidence.significant).toBe(false);
  });

  it('过自信：meanGap ≥ 0.1 且样本充足 → significant=true', () => {
    const samples = Array.from({ length: 20 }, () => ({
      p: 0.8,
      o: 0 as const,
    }));
    const metrics = computeCalibrateMetrics(samples, {
      notBackfilled: 0,
      nonBinary: 0,
    });
    // meanGap = 0.8（正 = 高估）；rate = 1（全部样本 p−o=0.8 > 0.1）
    expect(metrics.overconfidence.meanGap).toBe(0.8);
    expect(metrics.overconfidence.rate).toBe(1);
    expect(metrics.overconfidence.significant).toBe(true);
  });

  it('样本不足：brier 与 meanGap 置 null，桶级仍返回', () => {
    const metrics = computeCalibrateMetrics([{ p: 0.9, o: 1 }], {
      notBackfilled: 3,
      nonBinary: 1,
    });
    expect(metrics.insufficientSample).toBe(true);
    expect(metrics.brier).toBeNull();
    expect(metrics.overconfidence.meanGap).toBeNull();
    expect(metrics.overconfidence.significant).toBe(false);
    expect(metrics.buckets).toHaveLength(10);
    expect(metrics.excluded).toEqual({ notBackfilled: 3, nonBinary: 1 });
  });

  it('入参校验：window 闭集、tool 可选', () => {
    const ok = planCalibrate({ window: '7d', tool: 'decision_decide' });
    expect(ok.ok).toBe(true);
    const bad = planCalibrate({ window: '3d' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('invalid-arguments');
    const empty = planCalibrate({});
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.plan.window).toBe('30d');
  });

  it('入参校验：tool 必须落在十工具闭集（拼错不静默返回空统计）', () => {
    const unknown = planCalibrate({ tool: 'decision_decid' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('invalid-arguments');
    const blank = planCalibrate({ tool: '  ' });
    expect(blank.ok).toBe(false);
    const legal = planCalibrate({ tool: 'decision_gate' });
    expect(legal.ok).toBe(true);
  });

  it('readConfig 抛异常 → model-call-failed（不抛异常）', () => {
    const result = runCalibrate(
      {},
      {
        readConfig: () => {
          throw new Error('配置读取炸了');
        },
      },
      NOW,
    ) as unknown as { ok: boolean; error: { code: string; details: unknown } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('model-call-failed');
    expect(result.error.details).toEqual({ stage: 'read-config' });
  });

  it('账本读失败（list 抛异常）→ 返回错误信封而非抛出（B1 回归）', async () => {
    const tool = createCalibrateTool({
      readConfig: () => config(),
      ledger: {
        append: () => {},
        list: () => {
          throw new Error('账本读炸了');
        },
        findById: () => undefined,
        updateOutcome: () => false,
        size: () => 0,
      },
    });
    const result = (await tool.execute({ window: 'all' }, {
      signal: new AbortController().signal,
    } as never)) as unknown as {
      ok: boolean;
      error: { code: string; details: unknown };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('model-call-failed');
    expect(result.error.details).toEqual({ stage: 'unexpected' });
  });

  it('窗口过滤：只统计窗口内的条目', () => {
    const old = mkEntry({
      decisionId: 'dec_0123456789ABCDEFGHJKMNPQRA',
      ts: new Date(NOW - 40 * 86_400_000).toISOString(),
    });
    const fresh = mkEntry({
      decisionId: 'dec_0123456789ABCDEFGHJKMNPQRB',
      ts: new Date(NOW - 1000).toISOString(),
    });
    const { deps } = harness([old, fresh]);
    const result = runCalibrate({ window: '30d' }, deps, NOW) as unknown as {
      sampleSize: number;
    };
    expect(result.sampleSize).toBe(1);
    const all = runCalibrate({ window: 'all' }, deps, NOW) as unknown as {
      sampleSize: number;
    };
    expect(all.sampleSize).toBe(2);
  });

  it('tool 过滤：只统计指定工具的条目', () => {
    const decide = mkEntry({
      decisionId: 'dec_0123456789ABCDEFGHJKMNPQRA',
      tool: 'decision_decide',
    });
    const gate = mkEntry({
      decisionId: 'dec_0123456789ABCDEFGHJKMNPQRB',
      tool: 'decision_gate',
    });
    const { deps } = harness([decide, gate]);
    const result = runCalibrate(
      { tool: 'decision_gate' },
      deps,
      NOW,
    ) as unknown as {
      sampleSize: number;
    };
    expect(result.sampleSize).toBe(1);
  });

  it('开关关闭 → tool-disabled', () => {
    const { deps } = harness([mkEntry()], { toolsCalibrateEnabled: false });
    const result = runCalibrate({}, deps, NOW) as unknown as {
      ok: boolean;
      error: { code: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('tool-disabled');
  });

  it('工厂工具名与可执行性', async () => {
    const { deps } = harness([mkEntry()]);
    const tool = createCalibrateTool(deps);
    expect(tool.name).toBe('decision_calibrate');
    const result = (await tool.execute({ window: 'all' }, {
      signal: new AbortController().signal,
    } as never)) as unknown as { ok: boolean; sampleSize: number };
    expect(result.ok).toBe(true);
    expect(result.sampleSize).toBe(1);
  });
});
