import { describe, expect, it } from 'vitest';

import {
  BATCH_CONCURRENCY,
  BATCH_DESCRIPTION,
  BATCH_OUTPUT,
  BATCH_TOOL,
  createBatchTool,
  mapBounded,
  planBatch,
  planBatchQuestion,
  runBatch,
} from './batch.ts';
import {
  type ResolvedToolsConfig,
  resolveToolsConfig,
} from '../config/decision-tools.ts';
import {
  type BudgetGate,
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
    toolsDecideEnabled: true,
    toolsBatchEnabled: true,
    ledgerEnabled: true,
    ...overrides,
  });
}

/**
 * 逐行返回 noul 判定；可指定某个答案下标返回失败状态，验证失败行原样上报。
 */
function noulFetch(
  options: {
    statusByIndex?: Record<number, number>;
    pYesByIndex?: number[];
  } = {},
): {
  fetchImpl: FetchLike;
  calls: () => number;
  bodies: () => string[];
} {
  let index = 0;
  const sent: string[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const current = index;
    index += 1;
    sent.push(init.body);
    const status = options.statusByIndex?.[current] ?? 200;
    if (status !== 200) {
      return {
        ok: false,
        status,
        text: async () => JSON.stringify({ error: 'boom' }),
      };
    }
    const qids = Object.keys(
      (JSON.parse(init.body) as { questions: Record<string, unknown> })
        .questions,
    );
    const pYes = options.pYesByIndex?.[current] ?? 0.7;
    const answers: Record<string, unknown> = {};
    for (const qid of qids) {
      answers[qid] = { type: 'noul', noul: pYes, confidence: 0.9 };
    }
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
  return { fetchImpl, calls: () => index, bodies: () => sent };
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
  const ledger = options.ledger ?? createMemoryLedger(500);
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

const ONE_GROUP = [
  {
    questionId: 'spam',
    question: { type: 'noul', instructions: 'is this spam?' },
    texts: ['buy now', 'hello world', 'free money'],
  },
];

const TWO_GROUPS = [
  ...ONE_GROUP,
  {
    questionId: 'sentiment',
    question: { type: 'noul', instructions: 'is this positive?' },
    texts: ['great', 'bad'],
  },
];

describe('decision_batch（决策工具系列 4/11）', () => {
  it('工具名固定为 decision_batch', () => {
    expect(BATCH_TOOL).toBe('decision_batch');
    expect(BATCH_CONCURRENCY).toBe(5);
  });

  it('description 含 D1/D2/D4/D5 纪律文案', () => {
    expect(BATCH_DESCRIPTION).toContain('1..20');
    expect(BATCH_DESCRIPTION).toContain('max 5 concurrent');
    expect(BATCH_DESCRIPTION).toContain('Never guess');
    expect(BATCH_DESCRIPTION).toContain('equal-length');
  });

  it('OUTPUT schema 属性含 results/concurrency/degraded', () => {
    const props = (
      BATCH_OUTPUT.schema as { properties: Record<string, unknown> }
    ).properties;
    expect(Object.keys(props).sort()).toEqual(
      ['degraded', 'error', 'ok', 'results', 'concurrency'].sort(),
    );
  });

  it('组数 1–5 越界被拒', () => {
    expect(planBatch({ groups: [] }).ok).toBe(false);
    const six = Array.from({ length: 6 }, () => ({
      question: { type: 'noul', instructions: 'x' },
      texts: ['a'],
    }));
    expect(planBatch({ groups: six }).ok).toBe(false);
  });

  it('每组文本 1–20 条越界被拒', () => {
    expect(
      planBatch({
        groups: [{ question: { type: 'noul', instructions: 'x' }, texts: [] }],
      }).ok,
    ).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => `t${i}`);
    expect(
      planBatch({
        groups: [
          { question: { type: 'noul', instructions: 'x' }, texts: many },
        ],
      }).ok,
    ).toBe(false);
  });

  it('planBatchQuestion 三题型均校验通过', () => {
    expect(
      planBatchQuestion({ type: 'noul', instructions: 'yes?' }, 'q').ok,
    ).toBe(true);
    expect(
      planBatchQuestion(
        {
          type: 'choice',
          instructions: 'which?',
          criteria: { A: 'a', B: 'b' },
        },
        'q',
      ).ok,
    ).toBe(true);
    expect(
      planBatchQuestion(
        {
          type: 'score',
          instructions: 'rate?',
          criteria: ['low', 'mid', 'high'],
        },
        'q',
      ).ok,
    ).toBe(true);
  });

  it('mapBounded 并发上限真实生效（max<=5），结果等长同序', async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const results = await mapBounded(items, 5, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return value * 2;
    });
    expect(peak).toBeLessThanOrEqual(5);
    expect(results).toEqual(items.map((i) => i * 2));
  });

  it('全链路：结果等长同序 + 每行独立账本条目', async () => {
    const { fetchImpl, calls } = noulFetch({ pYesByIndex: [0.9, 0.1, 0.5] });
    const { deps, ledger } = harness(fetchImpl);
    const out = (await runBatch({ groups: ONE_GROUP }, EXEC, deps)) as {
      ok: boolean;
      degraded: boolean;
      results: Array<{
        groupIndex: number;
        questionId: string;
        rows: Array<{ index: number; text: string; status: string }>;
      }>;
    };
    expect(out.ok).toBe(true);
    expect(out.degraded).toBe(false);
    expect(calls()).toBe(3);
    expect(out.results).toHaveLength(1);
    expect(out.results[0].rows.map((r) => r.text)).toEqual(ONE_GROUP[0].texts);
    expect(out.results[0].rows.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(out.results[0].rows.every((r) => r.status === 'ok')).toBe(true);
    expect(ledger.size()).toBe(3); // 每行独立一条
    // 账本 questionId 依次为 {组questionId}#{行号}（契约 §8.2）；list 最新在前。
    expect(
      ledger
        .list()
        .map((e) => e.questionId)
        .sort(),
    ).toEqual(['spam#0', 'spam#1', 'spam#2']);
  });

  it('组缺省 questionId 时按序号生成 g0/g1（契约 §3.4）', async () => {
    const { fetchImpl } = noulFetch();
    const { deps } = harness(fetchImpl);
    const out = (await runBatch(
      {
        groups: TWO_GROUPS.map((group) => ({
          question: group.question,
          texts: group.texts,
        })),
      },
      EXEC,
      deps,
    )) as { ok: boolean; results: Array<{ questionId: string }> };
    expect(out.ok).toBe(true);
    expect(out.results.map((r) => r.questionId)).toEqual(['g0', 'g1']);
  });

  it('失败行原样上报 text + 原始错误码，不改写不猜，整批 ok=true', async () => {
    // 第 1 行（index=1）返回 500
    const { fetchImpl } = noulFetch({ statusByIndex: { 1: 500 } });
    const { deps, ledger } = harness(fetchImpl);
    const out = (await runBatch({ groups: ONE_GROUP }, EXEC, deps)) as {
      ok: boolean;
      degraded: boolean;
      results: Array<{
        rows: Array<{
          index: number;
          text: string;
          status: string;
          error: { code: string } | null;
          answer: unknown;
        }>;
      }>;
    };
    expect(out.ok).toBe(true);
    expect(out.degraded).toBe(true);
    const rows = out.results[0].rows;
    expect(rows[1].text).toBe('hello world'); // 原文未改
    expect(rows[1].status).toBe('error');
    expect(rows[1].error?.code).toBe('model-call-failed');
    expect(rows[1].answer).toBeNull(); // 不猜
    expect(rows[0].status).toBe('ok');
    expect(ledger.size()).toBe(3); // 失败也记账
  });

  it('多组：questionId 透传，组与行对齐', async () => {
    const { fetchImpl, calls } = noulFetch();
    const { deps } = harness(fetchImpl);
    const out = (await runBatch({ groups: TWO_GROUPS }, EXEC, deps)) as {
      ok: boolean;
      results: Array<{
        groupIndex: number;
        questionId: string;
        rows: unknown[];
      }>;
    };
    expect(out.ok).toBe(true);
    expect(calls()).toBe(5);
    expect(out.results.map((r) => r.questionId)).toEqual(['spam', 'sentiment']);
    expect(out.results[0].rows).toHaveLength(3);
    expect(out.results[1].rows).toHaveLength(2);
  });

  it('开关关闭 → tool-disabled 且不出网', async () => {
    const { fetchImpl, calls } = noulFetch();
    const { deps } = harness(fetchImpl, {
      config: baseConfig({ toolsBatchEnabled: false }),
    });
    const out = (await runBatch({ groups: ONE_GROUP }, EXEC, deps)) as {
      ok: boolean;
      error: { code: string };
    };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('tool-disabled');
    expect(calls()).toBe(0);
  });

  it('未配置模型 → model-not-configured 不出网', async () => {
    const { fetchImpl, calls } = noulFetch();
    const { deps } = harness(fetchImpl, {
      config: baseConfig({ systemoneApiKey: '', systemoneModel: '' }),
    });
    const out = (await runBatch({ groups: ONE_GROUP }, EXEC, deps)) as {
      ok: boolean;
      error: { code: string };
    };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('model-not-configured');
    expect(calls()).toBe(0);
  });

  it('未验证 → model-verify-failed 不出网', async () => {
    const { fetchImpl, calls } = noulFetch();
    const { deps } = harness(fetchImpl, { verified: false });
    const out = (await runBatch({ groups: ONE_GROUP }, EXEC, deps)) as {
      ok: boolean;
      error: { code: string };
    };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('model-verify-failed');
    expect(calls()).toBe(0);
  });

  it('createBatchTool 产出可注册工具定义（name 锚定）', () => {
    const { fetchImpl } = noulFetch();
    const { deps } = harness(fetchImpl);
    const tool = createBatchTool(deps) as { name: string };
    expect(tool.name).toBe(BATCH_TOOL);
  });
});
