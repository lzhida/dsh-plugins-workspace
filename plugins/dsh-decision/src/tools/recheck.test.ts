import { describe, expect, it } from 'vitest';

import {
  RECHECK_TOOL,
  buildRecheckQuestion,
  computeDrift,
  createRecheckTool,
  planRecheck,
  runRecheck,
} from './recheck.ts';
import {
  type ResolvedToolsConfig,
  resolveToolsConfig,
} from '../config/decision-tools.ts';
import {
  type BudgetGate,
  budgetExceeded,
  createPassthroughBudgetGate,
} from '../runtime/budget.ts';
import type { DecisionCallDeps } from '../runtime/call.ts';
import { fingerprintOf } from '../runtime/guard.ts';
import {
  type LedgerEntry,
  type LedgerSink,
  createMemoryLedger,
} from '../runtime/ledger.ts';
import type { FetchLike } from '../systemone/client.ts';
import type { JsonValue } from '../systemone/types.ts';

const EXEC = { signal: new AbortController().signal } as never;

const ORIGIN_ID = 'dec_0123456789ABCDEFGHJKMNPQRS';

function config(overrides: Record<string, unknown> = {}): ResolvedToolsConfig {
  return resolveToolsConfig({
    systemoneBaseUrl: 'http://127.0.0.1:3425',
    systemoneApiKey: 'key-test',
    systemoneModel: 'model-test',
    toolsRecheckEnabled: true,
    ledgerEnabled: true,
    ...overrides,
  });
}

interface EntryInput {
  decisionId?: string;
  questionId?: string | null;
  questionType?: 'noul' | 'choice' | 'score' | 'box' | null;
  questionSummary?: string | null;
  status?: 'ok' | 'error' | 'blocked';
  value?: JsonValue;
  confidence?: number | null;
  distribution?: JsonValue;
  legend?: string[] | null;
}

function mkEntry(input: EntryInput = {}): LedgerEntry {
  return {
    decisionId: input.decisionId ?? ORIGIN_ID,
    ts: '2026-01-01T00:00:00.000Z',
    tool: 'decision_decide',
    mode: 'primary',
    source: 'decision-model',
    questionId: input.questionId === undefined ? 'q1' : input.questionId,
    questionType:
      input.questionType === undefined ? 'noul' : input.questionType,
    questionSummary:
      input.questionSummary === undefined
        ? '原判定摘要'
        : input.questionSummary,
    status: input.status ?? 'ok',
    payload: {
      value: input.value === undefined ? 0.82 : input.value,
      confidence: input.confidence === undefined ? 0.9 : input.confidence,
      distribution:
        input.distribution === undefined ? null : input.distribution,
      legend: input.legend === undefined ? null : input.legend,
    },
    outcome: {
      state: 'unknown',
      value: null,
      source: null,
      updatedAt: null,
    },
    usage: { inputTokens: 10, outputTokens: 5, calls: 1 },
    latencyMs: 12,
    costUsd: null,
    costEstimated: false,
  };
}

function stubFetch(payloads: Array<{ status?: number; body: unknown }>): {
  fetchImpl: FetchLike;
  calls: () => number;
} {
  let index = 0;
  const fetchImpl: FetchLike = async () => {
    const spec = payloads[Math.min(index, payloads.length - 1)];
    index += 1;
    await new Promise((resolve) => setTimeout(resolve, 3));
    const status = spec.status ?? 200;
    const text =
      typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    };
  };
  return { fetchImpl, calls: () => index };
}

function noulBody(pYes: number, confidence: number | null = 0.9): unknown {
  return {
    answers: { q1: { type: 'noul', noul: pYes, confidence } },
    usage: { input_tokens: 8, output_tokens: 4 },
  };
}

interface Harness {
  deps: DecisionCallDeps;
  ledger: LedgerSink;
}

function harness(
  fetchImpl: FetchLike,
  options: {
    config?: ResolvedToolsConfig;
    ledger?: LedgerSink;
    budget?: BudgetGate;
    verified?: boolean;
  } = {},
): Harness {
  const conf = options.config ?? config();
  const ledger = options.ledger ?? createMemoryLedger(100);
  const deps: DecisionCallDeps = {
    readConfig: () => conf,
    getVerifySnapshot: () =>
      options.verified === false
        ? undefined
        : {
            fingerprint: fingerprintOf(conf),
            verifiedAt: new Date().toISOString(),
          },
    ledger,
    budget: options.budget ?? createPassthroughBudgetGate(),
    fetchImpl,
  };
  return { deps, ledger };
}

describe('decision 工具族 recheck：判定复检（8/11）', () => {
  it('工具名符合契约', () => {
    expect(RECHECK_TOOL).toBe('decision_recheck');
  });

  it('正常复检返回 old / new / drift', async () => {
    const { fetchImpl, calls } = stubFetch([{ body: noulBody(0.5, 0.8) }]);
    const ledger = createMemoryLedger(100);
    ledger.append(mkEntry());
    const { deps } = harness(fetchImpl, { ledger });
    const out = await runRecheck({ decisionId: ORIGIN_ID }, EXEC, deps);
    expect(out.ok).toBe(true);
    expect(calls()).toBe(1);
    const old = out.old as Record<string, unknown>;
    const next = out.new as Record<string, unknown>;
    const drift = out.drift as {
      changed: boolean;
      kind: string;
      magnitude: number;
    };
    expect(old.value).toBe(0.82);
    expect(old.confidence).toBe(0.9);
    expect(old.questionType).toBe('noul');
    expect(next.value).toBe(0.5);
    expect(next.confidence).toBe(0.8);
    expect(drift.kind).toBe('both');
    expect(drift.changed).toBe(true);
    expect(drift.magnitude).toBeCloseTo(0.32, 4);
  });

  it('复检本身进账本：新条目 tool=decision_recheck、mode=recheck、recheckOf 指向原条目', async () => {
    const { fetchImpl } = stubFetch([{ body: noulBody(0.5) }]);
    const ledger = createMemoryLedger(100);
    ledger.append(mkEntry());
    const { deps } = harness(fetchImpl, { ledger });
    await runRecheck({ decisionId: ORIGIN_ID }, EXEC, deps);
    const entries = ledger.list();
    expect(entries.length).toBe(2);
    const fresh = entries[0];
    expect(fresh.tool).toBe('decision_recheck');
    expect(fresh.mode).toBe('recheck');
    expect(fresh.recheckOf).toBe(ORIGIN_ID);
    expect(fresh.decisionId).not.toBe(ORIGIN_ID);
  });

  it('判定值未变且置信度未变 → drift.kind=none', async () => {
    const { fetchImpl } = stubFetch([{ body: noulBody(0.82, 0.9) }]);
    const ledger = createMemoryLedger(100);
    ledger.append(mkEntry());
    const { deps } = harness(fetchImpl, { ledger });
    const out = await runRecheck({ decisionId: ORIGIN_ID }, EXEC, deps);
    const drift = out.drift as {
      changed: boolean;
      kind: string;
      magnitude: number;
    };
    expect(drift.kind).toBe('none');
    expect(drift.changed).toBe(false);
    expect(drift.magnitude).toBe(0);
  });

  it('choice 题：选项不同即算值变化（magnitude=1）', async () => {
    const { fetchImpl } = stubFetch([
      {
        body: {
          answers: {
            q1: {
              type: 'choice',
              choice: 'B',
              confidence: 0.8,
              probabilities: { A: 0.3, B: 0.7 },
            },
          },
          usage: { input_tokens: 8, output_tokens: 4 },
        },
      },
    ]);
    const ledger = createMemoryLedger(100);
    ledger.append(
      mkEntry({
        questionType: 'choice',
        value: 'A',
        confidence: 0.8,
        distribution: { A: 0.7, B: 0.3 },
      }),
    );
    const { deps } = harness(fetchImpl, { ledger });
    const out = await runRecheck({ decisionId: ORIGIN_ID }, EXEC, deps);
    const drift = out.drift as { kind: string; magnitude: number };
    expect(drift.kind).toBe('value');
    expect(drift.magnitude).toBe(1);
  });

  it('score 题：|Δscore| > 0.10 算值变化', async () => {
    const { fetchImpl } = stubFetch([
      {
        body: {
          answers: {
            q1: {
              type: 'score',
              score: 7,
              legend: ['低', '中', '高'],
              confidence: 0.8,
              probabilities: [0.1, 0.2, 0.7],
            },
          },
          usage: { input_tokens: 8, output_tokens: 4 },
        },
      },
    ]);
    const ledger = createMemoryLedger(100);
    ledger.append(
      mkEntry({
        questionType: 'score',
        value: 5,
        confidence: 0.8,
        legend: ['低', '中', '高'],
      }),
    );
    const { deps } = harness(fetchImpl, { ledger });
    const out = await runRecheck({ decisionId: ORIGIN_ID }, EXEC, deps);
    const drift = out.drift as { kind: string; magnitude: number };
    expect(drift.kind).toBe('value');
    expect(drift.magnitude).toBeCloseTo(2, 4);
  });

  it('只有置信度变化时 kind=confidence', () => {
    const drift = computeDrift('noul', 0.82, 0.82, 0.9, 0.7);
    expect(drift.kind).toBe('confidence');
    expect(drift.changed).toBe(true);
    expect(drift.magnitude).toBeCloseTo(0.2, 4);
  });

  it('漂移阈值：值变化与置信度变化都有下限', () => {
    expect(computeDrift('noul', 0.82, 0.9, 0.9, 0.9).kind).toBe('none');
    expect(computeDrift('noul', 0.82, 0.95, 0.9, 0.9).kind).toBe('value');
    expect(computeDrift('noul', 0.82, 0.82, 0.9, 0.86).kind).toBe('none');
  });

  it('漂移阈值是严格大于：|Δ| 恰等于 0.10 / 0.05 不算变化', () => {
    // 契约 §3.8：|ΔP|>0.10 才算值变化，|Δconfidence|>0.05 才算置信度变化。
    // 用 0 为基准，避免二进制浮点的表示误差把边界值推到阈值另一侧。
    expect(computeDrift('noul', 0, 0.1, 0, 0).kind).toBe('none');
    expect(computeDrift('noul', 0, 0.2, 0, 0).kind).toBe('value');
    expect(computeDrift('noul', 0, 0, 0, 0.05).kind).toBe('none');
    expect(computeDrift('noul', 0, 0, 0, 0.06).kind).toBe('confidence');
  });

  it('decisionId 不存在（含滚动淘汰）→ decision-not-found，绝不猜', async () => {
    const { fetchImpl, calls } = stubFetch([{ body: noulBody(0.5) }]);
    const { deps } = harness(fetchImpl);
    const out = await runRecheck(
      { decisionId: 'dec_ABCDEFGHJKMNPQRS0123456789' },
      EXEC,
      deps,
    );
    expect(out.ok).toBe(false);
    const error = out.error as { code: string };
    expect(error.code).toBe('decision-not-found');
    expect(calls()).toBe(0);
  });

  it('decisionId 格式非法 → decision-id-invalid', async () => {
    const { fetchImpl, calls } = stubFetch([{ body: noulBody(0.5) }]);
    const { deps } = harness(fetchImpl);
    const out = await runRecheck({ decisionId: 'not-an-id' }, EXEC, deps);
    expect(out.ok).toBe(false);
    expect((out.error as { code: string }).code).toBe('decision-id-invalid');
    expect(calls()).toBe(0);
  });

  it('原条目不是成功判定（error/blocked）→ decision-not-found', async () => {
    const { fetchImpl, calls } = stubFetch([{ body: noulBody(0.5) }]);
    const ledger = createMemoryLedger(100);
    ledger.append(mkEntry({ status: 'error' }));
    const { deps } = harness(fetchImpl, { ledger });
    const out = await runRecheck({ decisionId: ORIGIN_ID }, EXEC, deps);
    expect(out.ok).toBe(false);
    expect((out.error as { code: string }).code).toBe('decision-not-found');
    expect(calls()).toBe(0);
  });

  it('预算不足被拒是正常路径 → budget-exceeded 且不发起调用', async () => {
    const { fetchImpl, calls } = stubFetch([{ body: noulBody(0.5) }]);
    const ledger = createMemoryLedger(100);
    ledger.append(mkEntry());
    const budget: BudgetGate = {
      check: () => budgetExceeded('calls'),
      recordBlocked: () => {},
    };
    const { deps } = harness(fetchImpl, { ledger, budget });
    const out = await runRecheck({ decisionId: ORIGIN_ID }, EXEC, deps);
    expect(out.ok).toBe(false);
    expect((out.error as { code: string }).code).toBe('budget-exceeded');
    expect(calls()).toBe(0);
    // blocked 记录也带 recheckOf（契约 §8.2 三条记账路径）。
    const blocked = ledger.list().find((entry) => entry.status === 'blocked');
    expect(blocked?.recheckOf).toBe(ORIGIN_ID);
  });

  it('上游失败 → 账本落 error 条目且带 recheckOf', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 500, body: 'boom' }]);
    const ledger = createMemoryLedger(100);
    ledger.append(mkEntry());
    const { deps } = harness(fetchImpl, { ledger });
    const out = await runRecheck({ decisionId: ORIGIN_ID }, EXEC, deps);
    expect(out.ok).toBe(false);
    expect((out.error as { code: string }).code).toBe('model-call-failed');
    expect(calls()).toBe(1);
    const failed = ledger
      .list()
      .find((entry) => entry.status === 'error' && entry.tool === RECHECK_TOOL);
    expect(failed?.recheckOf).toBe(ORIGIN_ID);
  });

  it('开关关闭 → tool-disabled', async () => {
    const { fetchImpl, calls } = stubFetch([{ body: noulBody(0.5) }]);
    const ledger = createMemoryLedger(100);
    ledger.append(mkEntry());
    const { deps } = harness(fetchImpl, {
      ledger,
      config: config({ toolsRecheckEnabled: false }),
    });
    const out = await runRecheck({ decisionId: ORIGIN_ID }, EXEC, deps);
    expect(out.ok).toBe(false);
    expect((out.error as { code: string }).code).toBe('tool-disabled');
    expect(calls()).toBe(0);
  });

  it('模型未验证 → model-verify-failed（fail-closed）', async () => {
    const { fetchImpl, calls } = stubFetch([{ body: noulBody(0.5) }]);
    const ledger = createMemoryLedger(100);
    ledger.append(mkEntry());
    const { deps } = harness(fetchImpl, { ledger, verified: false });
    const out = await runRecheck({ decisionId: ORIGIN_ID }, EXEC, deps);
    expect(out.ok).toBe(false);
    expect((out.error as { code: string }).code).toBe('model-verify-failed');
    expect(calls()).toBe(0);
  });

  it('模型畸形返回（缺题）→ 结构化错误 model-invalid-response', async () => {
    const { fetchImpl } = stubFetch([
      { body: { answers: {}, usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    const ledger = createMemoryLedger(100);
    ledger.append(mkEntry());
    const { deps } = harness(fetchImpl, { ledger });
    const out = await runRecheck({ decisionId: ORIGIN_ID }, EXEC, deps);
    expect(out.ok).toBe(false);
    expect((out.error as { code: string }).code).toBe('model-invalid-response');
  });

  it('入参校验：缺 decisionId / state 非法 → invalid-arguments', () => {
    const missing = planRecheck({});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('invalid-arguments');
    const badState = planRecheck({
      decisionId: ORIGIN_ID,
      state: [1, 2, 3],
    });
    expect(badState.ok).toBe(false);
    if (!badState.ok) expect(badState.error.code).toBe('invalid-arguments');
  });

  it('复检题目按题型重建（noul/choice/score），box 题型拒绝', () => {
    const noul = buildRecheckQuestion(mkEntry({ questionType: 'noul' }));
    expect(noul.ok).toBe(true);
    if (noul.ok) {
      expect(noul.plan.question.type).toBe('noul');
      expect(noul.plan.question.criteria).toBeTypeOf('object');
    }
    const choice = buildRecheckQuestion(
      mkEntry({
        questionType: 'choice',
        value: 'A',
        distribution: { A: 0.7, B: 0.3 },
      }),
    );
    expect(choice.ok).toBe(true);
    if (choice.ok) {
      expect(choice.plan.question.type).toBe('choice');
      expect(Object.keys(choice.plan.question.criteria ?? {})).toEqual([
        'A',
        'B',
      ]);
    }
    const score = buildRecheckQuestion(
      mkEntry({
        questionType: 'score',
        value: 5,
        legend: ['低', '中', '高'],
      }),
    );
    expect(score.ok).toBe(true);
    if (score.ok) {
      expect(score.plan.question.type).toBe('score');
      expect(Array.isArray(score.plan.question.criteria)).toBe(true);
    }
    const box = buildRecheckQuestion(mkEntry({ questionType: 'box' }));
    expect(box.ok).toBe(false);
    if (!box.ok) expect(box.error.code).toBe('invalid-arguments');
  });

  it('工具工厂产出的工具名正确且可执行', async () => {
    const { fetchImpl } = stubFetch([{ body: noulBody(0.82, 0.9) }]);
    const ledger = createMemoryLedger(100);
    ledger.append(mkEntry());
    const { deps } = harness(fetchImpl, { ledger });
    const tool = createRecheckTool(deps);
    expect(tool.name).toBe(RECHECK_TOOL);
    const result = (await tool.execute({ decisionId: ORIGIN_ID }, {
      signal: new AbortController().signal,
    } as never)) as { ok: boolean };
    expect(result.ok).toBe(true);
  });
});
