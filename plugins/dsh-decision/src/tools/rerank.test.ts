import { describe, expect, it } from 'vitest';

import {
  RERANK_DESCRIPTION,
  RERANK_OUTPUT,
  RERANK_TOOL,
  compositeScore,
  createRerankTool,
  planRerank,
  rankCandidates,
  runRerank,
} from './rerank.ts';
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
import { type LedgerSink, createMemoryLedger } from '../runtime/ledger.ts';
import type { FetchLike } from '../systemone/client.ts';

const EXEC = { signal: new AbortController().signal } as never;

function baseConfig(
  overrides: Record<string, unknown> = {},
): ResolvedToolsConfig {
  return resolveToolsConfig({
    systemoneBaseUrl: 'http://127.0.0.1:3425',
    systemoneApiKey: 'key-test',
    systemoneModel: 'model-test',
    toolsRerankEnabled: true,
    toolsBatchEnabled: true,
    ledgerEnabled: true,
    ...overrides,
  });
}

/**
 * 按题目被问到的顺序逐个消费 values（fit 批 2 题 + risk 批 2 题），
 * 返回每题一个 choice 响应，便于断言 fit/risk 的独立取值。
 */
function choiceFetch(values: string[]): {
  fetchImpl: FetchLike;
  calls: () => number;
} {
  let index = 0;
  let cursor = 0;
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body) as {
      questions: Record<string, { type: string }>;
    };
    const qids = Object.keys(body.questions);
    const answers: Record<string, unknown> = {};
    for (const qid of qids) {
      const value = values[Math.min(cursor, values.length - 1)];
      cursor += 1;
      answers[qid] = {
        type: 'choice',
        choice: value,
        confidence: 0.9,
        probabilities: { '0': 0.1, '1': 0.2, '2': 0.3, '3': 0.4 },
      };
    }
    index += 1;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          answers,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
    };
  };
  return { fetchImpl, calls: () => index };
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
  const config = options.config ?? baseConfig();
  const ledger = options.ledger ?? createMemoryLedger(200);
  const deps: DecisionCallDeps = {
    readConfig: () => config,
    getVerifySnapshot: () =>
      options.verified === false
        ? undefined
        : {
            fingerprint: fingerprintOf(config),
            verifiedAt: new Date().toISOString(),
          },
    ledger,
    budget: options.budget ?? createPassthroughBudgetGate(),
    fetchImpl,
  };
  return { deps, ledger };
}

const CANDIDATES = [
  { id: 'a', title: '方案 A', description: '稳妥' },
  { id: 'b', title: '方案 B', description: '快速' },
];

describe('decision_rerank（决策工具系列 4/11）', () => {
  it('工具名固定为 decision_rerank', () => {
    expect(RERANK_TOOL).toBe('decision_rerank');
  });

  it('description 含 D1/D2/D4/D5 纪律文案', () => {
    expect(RERANK_DESCRIPTION).toContain('2..10');
    expect(RERANK_DESCRIPTION).toContain('never clamped');
    expect(RERANK_DESCRIPTION).toContain('Output is bounded');
    expect(RERANK_DESCRIPTION).toContain('{ ok:false, error }');
  });

  it('OUTPUT schema 属性含 ranked/recommendation/invalid/decisionId', () => {
    const props = (
      RERANK_OUTPUT.schema as { properties: Record<string, unknown> }
    ).properties;
    expect(Object.keys(props).sort()).toEqual(
      [
        'decisionId',
        'error',
        'invalid',
        'ok',
        'ranked',
        'recommendation',
        'source',
      ].sort(),
    );
  });

  it('候选数越界（1 或 11）被 invalid-arguments 拒绝', () => {
    expect(planRerank({ candidates: [CANDIDATES[0]] }).ok).toBe(false);
    const many = Array.from({ length: 11 }, (_, i) => ({
      id: `x${i}`,
      title: `T${i}`,
    }));
    expect(planRerank({ candidates: many }).ok).toBe(false);
  });

  it('fit/risk 先验非 0..3 整数被拒绝', () => {
    expect(
      planRerank({ candidates: [{ ...CANDIDATES[0], fit: 4 }, CANDIDATES[1]] })
        .ok,
    ).toBe(false);
    expect(
      planRerank({
        candidates: [{ ...CANDIDATES[0], risk: -1 }, CANDIDATES[1]],
      }).ok,
    ).toBe(false);
  });

  it('compositeScore 默认 2fit-risk，可自定义权重', () => {
    expect(compositeScore(3, 1, 2, 1)).toBe(5);
    expect(compositeScore(3, 1, 1, 2)).toBe(1);
  });

  it('rankCandidates 按 score 降序 → fit 大 → 输入顺序打破并列', () => {
    const ranked = rankCandidates(
      [
        { id: 'a', fit: 3, risk: 1, order: 0 },
        { id: 'b', fit: 3, risk: 1, order: 1 },
        { id: 'c', fit: 2, risk: 0, order: 2 },
      ],
      2,
      1,
    );
    expect(ranked.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(ranked[0].score).toBe(5);
  });

  it('全链路：两批 choice 调用得出排序与首推 id，记账 4 条', async () => {
    // fit 批：a=3, b=1；risk 批：a=0, b=2 → score a=6, b=0
    const { fetchImpl, calls } = choiceFetch(['3', '1', '0', '2']);
    const { deps, ledger } = harness(fetchImpl);
    const out = (await runRerank({ candidates: CANDIDATES }, EXEC, deps)) as {
      ok: boolean;
      ranked: Array<{ id: string; fit: number; risk: number; score: number }>;
      recommendation: string;
      invalid: unknown[];
    };
    expect(out.ok).toBe(true);
    expect(calls()).toBe(2); // fit 批 + risk 批，各一次
    expect(out.ranked.map((r) => r.id)).toEqual(['a', 'b']);
    expect(out.ranked[0]).toMatchObject({ fit: 3, risk: 0, score: 6 });
    expect(out.recommendation).toBe('a');
    expect(out.invalid).toEqual([]);
    expect(ledger.size()).toBe(4); // 每批两候选各一题
  });

  it('批拆分边界：8 候选两批各一请求（calls=2），9 候选拆双批（calls=4）', async () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `c${i}`, title: `C${i}` }));
    // 8 候选：fit 批 8 题=1 请求 + risk 批 8 题=1 请求。
    {
      const { fetchImpl, calls } = choiceFetch(['3']);
      const { deps } = harness(fetchImpl);
      await runRerank({ candidates: mk(8) }, EXEC, deps);
      expect(calls()).toBe(2);
    }
    // 9 候选：每批拆 8+1 → fit 2 请求 + risk 2 请求 = 4（每请求 ≤16 题硬约束）。
    {
      const { fetchImpl, calls } = choiceFetch(['3']);
      const { deps } = harness(fetchImpl);
      const out = (await runRerank({ candidates: mk(9) }, EXEC, deps)) as {
        ok: boolean;
        ranked: Array<{ id: string }>;
      };
      expect(out.ok).toBe(true);
      expect(out.ranked).toHaveLength(9);
      expect(calls()).toBe(4);
    }
  });

  it('非法 fit/risk（候选集外取值）进 invalid 并从排序剔除，不夹取', async () => {
    const { fetchImpl } = choiceFetch(['9', '1', '0', '2']); // 9 非 0..3
    const { deps } = harness(fetchImpl);
    const out = (await runRerank({ candidates: CANDIDATES }, EXEC, deps)) as {
      ok: boolean;
      ranked: Array<{ id: string }>;
      invalid: Array<{ id: string; reason: string }>;
      recommendation: string;
    };
    expect(out.ok).toBe(true);
    expect(out.ranked.map((r) => r.id)).toEqual(['b']);
    expect(out.recommendation).toBe('b');
    expect(out.invalid.length).toBe(1);
    expect(out.invalid[0].id).toBe('a');
  });

  it('全部非法时 recommendation=null 且 ok=true + invalid 非空', async () => {
    const { fetchImpl } = choiceFetch(['9', '8', '7', '6']);
    const { deps } = harness(fetchImpl);
    const out = (await runRerank({ candidates: CANDIDATES }, EXEC, deps)) as {
      ok: boolean;
      recommendation: string | null;
      invalid: unknown[];
    };
    expect(out.ok).toBe(true);
    expect(out.recommendation).toBeNull();
    expect(out.invalid.length).toBe(4);
  });

  it('开关关闭 → tool-disabled 且不出网', async () => {
    const { fetchImpl, calls } = choiceFetch(['3', '1', '0', '2']);
    const { deps } = harness(fetchImpl, {
      config: baseConfig({ toolsRerankEnabled: false }),
    });
    const out = (await runRerank({ candidates: CANDIDATES }, EXEC, deps)) as {
      ok: boolean;
      error: { code: string };
    };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('tool-disabled');
    expect(calls()).toBe(0);
  });

  it('未配置模型 → model-not-configured 不出网', async () => {
    const { fetchImpl, calls } = choiceFetch(['3']);
    const { deps } = harness(fetchImpl, {
      config: baseConfig({ systemoneApiKey: '', systemoneModel: '' }),
    });
    const out = (await runRerank({ candidates: CANDIDATES }, EXEC, deps)) as {
      ok: boolean;
      error: { code: string };
    };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('model-not-configured');
    expect(calls()).toBe(0);
  });

  it('未验证 → model-verify-failed 不出网', async () => {
    const { fetchImpl, calls } = choiceFetch(['3']);
    const { deps } = harness(fetchImpl, { verified: false });
    const out = (await runRerank({ candidates: CANDIDATES }, EXEC, deps)) as {
      ok: boolean;
      error: { code: string };
    };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('model-verify-failed');
    expect(calls()).toBe(0);
  });

  it('预算触顶 → budget-exceeded 且不出网', async () => {
    const { fetchImpl, calls } = choiceFetch(['3']);
    const budget: BudgetGate = {
      check: () => budgetExceeded('calls'),
      recordBlocked: () => {},
    };
    const { deps } = harness(fetchImpl, { budget });
    const out = (await runRerank({ candidates: CANDIDATES }, EXEC, deps)) as {
      ok: boolean;
      error: { code: string };
    };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('budget-exceeded');
    expect(calls()).toBe(0);
  });

  it('createRerankTool 产出可注册工具定义（name 锚定）', () => {
    const { fetchImpl } = choiceFetch(['3', '1', '0', '2']);
    const { deps } = harness(fetchImpl);
    const tool = createRerankTool(deps) as { name: string };
    expect(tool.name).toBe(RERANK_TOOL);
  });
});
