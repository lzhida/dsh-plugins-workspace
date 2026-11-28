import { describe, expect, it } from 'vitest';

import {
  DECIDE_DESCRIPTION,
  DECIDE_OUTPUT,
  DECIDE_TOOL,
  aggregateAnswers,
  buildDecideState,
  computeAgreement,
  createDecideTool,
  estimateDecidePromptTokens,
  mapAnswerToDecideAnswer,
  planDecide,
  type DecidePlan,
  type DecideQuestionPlan,
} from './decide.ts';
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
import type { SystemOneParsedAnswer } from '../systemone/types.ts';

const EXEC = { signal: new AbortController().signal } as never;

function baseConfig(
  overrides: Record<string, unknown> = {},
): ResolvedToolsConfig {
  return resolveToolsConfig({
    systemoneBaseUrl: 'https://decision.example.internal',
    systemoneApiKey: 'key-test',
    systemoneModel: 'model-test',
    toolsDecideEnabled: true,
    toolsGateEnabled: true,
    ledgerEnabled: true,
    ...overrides,
  });
}

function stubFetch(payloads: Array<{ status?: number; body: unknown }>): {
  fetchImpl: FetchLike;
  calls: () => number;
  bodies: () => string[];
} {
  let index = 0;
  const sent: string[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const spec = payloads[Math.min(index, payloads.length - 1)];
    index += 1;
    sent.push(init.body);
    // 让 latencyMs 可测（真实 fetch 不会瞬时返回）。
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
  return { fetchImpl, calls: () => index, bodies: () => sent };
}

/** 单题 noul 的成功响应信封。 */
function noulEnv(pYes: number, confidence: number | null = 0.9): unknown {
  return {
    answers: { q1: { type: 'noul', noul: pYes, confidence } },
    usage: { input_tokens: 10, output_tokens: 5 },
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
  const config = options.config ?? baseConfig();
  const ledger = options.ledger ?? createMemoryLedger(100);
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

function planOf(args: unknown): DecidePlan {
  const result = planDecide(args);
  if (!result.ok) throw new Error(`expected valid plan: ${result.error.code}`);
  return result.plan;
}

const NOUL_ARGS = {
  state: 'the release is ready',
  questions: { q1: { type: 'noul', instructions: 'ship it now?' } },
};

const CHOICE_ARGS = {
  state: 'pick a plan',
  questions: {
    q1: {
      type: 'choice',
      instructions: 'which plan?',
      criteria: { A: '安全方案', B: '激进方案' },
    },
  },
};

const SCORE_ARGS = {
  state: 'rate quality',
  questions: {
    q1: {
      type: 'score',
      instructions: 'score the output quality',
      criteria: ['差', '中', '好'],
    },
  },
};

describe('决策工具 decide 入参校验（planDecide）', () => {
  it('三题型都能构造出合法计划（choice 带候选集、score 带档位数）', () => {
    const noul = planOf(NOUL_ARGS);
    expect(noul.questions[0].type).toBe('noul');
    expect(noul.n).toBe(1);

    const choice = planOf(CHOICE_ARGS);
    expect(choice.questions[0].options).toEqual(['A', 'B']);

    const score = planOf(SCORE_ARGS);
    expect(score.questions[0].levels).toBe(3);
  });

  it('题量、n、instructions、criteria 越界都返回 invalid-arguments 不抛错', () => {
    const bad = (args: unknown) => {
      const r = planDecide(args);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid-arguments');
    };

    bad({});
    bad({
      state: '  ',
      questions: { q1: { type: 'noul', instructions: 'x' } },
    });
    bad({ state: 's', questions: {} });
    bad({
      state: 's',
      questions: { q1: { type: 'bogus', instructions: 'x' } },
    });
    bad({ state: 's', questions: { q1: { type: 'noul', instructions: '' } } });
    bad({
      state: 's',
      questions: { q1: { type: 'noul', instructions: 'x' } },
      n: 2,
    });
    bad({
      state: 's',
      questions: { q1: { type: 'noul', instructions: 'x' } },
      n: 6,
    });
    bad({
      state: 's',
      questions: {
        q1: { type: 'choice', instructions: 'x', criteria: { A: 'a' } },
      },
    });
    bad({
      state: 's',
      questions: {
        q1: {
          type: 'score',
          instructions: 'x',
          criteria: Array.from({ length: 11 }, (_, i) => `L${i}`),
        },
      },
    });
  });

  it('n 允许 1 与 3–5', () => {
    for (const n of [1, 3, 4, 5]) {
      const r = planDecide({ ...NOUL_ARGS, n });
      expect(r.ok).toBe(true);
    }
  });
});

describe('决策工具 decide 提示词与出参结构', () => {
  it('buildDecideState 把约束放在动作之前、state 原文只落 DETAIL 一次', () => {
    const stateText = 'STATE-ORIGINAL-TEXT-77';
    const plan = planOf({
      state: stateText,
      questions: { q1: { type: 'noul', instructions: 'is it?' } },
    });
    const payload = buildDecideState(plan) as { message: string };
    const message = payload.message;
    expect(message.indexOf('CONSTRAINTS:')).toBeGreaterThanOrEqual(0);
    expect(message.indexOf('ACTIONS:')).toBeGreaterThan(
      message.indexOf('CONSTRAINTS:'),
    );
    expect(message.indexOf('DETAIL:')).toBeGreaterThan(
      message.indexOf('ACTIONS:'),
    );
    expect(message.split(stateText).length - 1).toBe(1);
  });

  it('estimateDecidePromptTokens 返回正数且与 JSON 长度一致', () => {
    const plan = planOf(NOUL_ARGS);
    const tokens = estimateDecidePromptTokens(plan);
    const jsonLen = JSON.stringify(buildDecideState(plan)).length;
    expect(tokens).toBe(Math.ceil(jsonLen / 4));
    expect(tokens).toBeGreaterThan(0);
  });

  it('DECIDE_DESCRIPTION 写明「不回散文/输出有界」等 D 系列纪律', () => {
    expect(DECIDE_DESCRIPTION).toContain(
      'Never return free-form reasoning text',
    );
    expect(DECIDE_DESCRIPTION).toContain('never echo the input state');
    expect(DECIDE_DESCRIPTION).toContain('Output is bounded');
  });

  it('DECIDE_OUTPUT.schema 只有结构化字段、没有任何散文自由文本字段', () => {
    const schema = DECIDE_OUTPUT.schema as unknown as {
      additionalProperties: boolean;
      properties: Record<string, { type?: string }>;
    };
    expect(schema.additionalProperties).toBe(true);
    expect(Object.keys(schema.properties).sort()).toEqual([
      'answers',
      'decisionIds',
      'error',
      'fallback',
      'ok',
      'selfConsistency',
      'source',
      'usage',
    ]);
    for (const key of Object.keys(schema.properties)) {
      expect(key).not.toMatch(/explain|reason|text|message|prose/i);
    }
    expect(schema.properties.answers.type).toBe('object');
  });
});

function expectNonNull<T>(value: T | null): T {
  expect(value).not.toBeNull();
  return value as T;
}

describe('决策工具 decide 答案映射与聚合（纯函数）', () => {
  const noulQ: DecideQuestionPlan = {
    id: 'q1',
    type: 'noul',
    instructions: 'x',
    criteria: undefined,
    options: [],
    levels: 0,
  };
  const choiceQ: DecideQuestionPlan = {
    id: 'q1',
    type: 'choice',
    instructions: 'x',
    criteria: { A: 'a', B: 'b' },
    options: ['A', 'B'],
    levels: 0,
  };

  const noulAnswer = (
    p: number,
    confidence: number | null = 0.9,
  ): SystemOneParsedAnswer => ({
    kind: 'noul',
    pYes: p,
    confidence,
    probabilities: null,
  });

  it('noul 映射为 {value=pYes, distribution={yes,no}}，legend 为 null', () => {
    const mapped = mapAnswerToDecideAnswer(noulQ, noulAnswer(0.85));
    expect(mapped.value).toBe(0.85);
    expect(mapped.distribution).toEqual({ yes: 0.85, no: 0.15 });
    expect(mapped.legend).toBeNull();
    expect(mapped.status).toBe('ok');
  });

  it('choice 单选不在候选集内一律 dropped（fail-closed 不夹取）', () => {
    const ok = mapAnswerToDecideAnswer(choiceQ, {
      kind: 'choice',
      choice: 'A',
      confidence: 0.7,
      probabilities: { A: 0.7, B: 0.3 },
    });
    expect(ok.value).toBe('A');
    expect(ok.status).toBe('ok');

    const dropped = mapAnswerToDecideAnswer(choiceQ, {
      kind: 'choice',
      choice: 'Z',
      confidence: 0.7,
      probabilities: null,
    });
    expect(dropped.status).toBe('dropped');
    expect(dropped.value).toBeNull();
  });

  it('题型不匹配或缺答案一律 dropped', () => {
    expect(mapAnswerToDecideAnswer(noulQ, undefined).status).toBe('dropped');
    expect(mapAnswerToDecideAnswer(choiceQ, noulAnswer(0.5)).status).toBe(
      'dropped',
    );
  });

  it('choice 聚合按计票归一，众数为 value，modalVoteRatio=众数占比', () => {
    const aggregated = expectNonNull(
      aggregateAnswers(choiceQ, [
        { kind: 'choice', choice: 'A', confidence: 0.9, probabilities: null },
        { kind: 'choice', choice: 'A', confidence: 0.6, probabilities: null },
        { kind: 'choice', choice: 'B', confidence: 0.8, probabilities: null },
      ]),
    );
    expect(aggregated.value).toBe('A');
    expect(aggregated.modalVoteRatio).toBe(0.6667);
    expect(aggregated.samples).toBe(3);
  });

  it('noul 聚合取 P(yes) 平均、score 聚合取期望分平均', () => {
    const noul = expectNonNull(
      aggregateAnswers(noulQ, [noulAnswer(0.9), noulAnswer(0.7)]),
    );
    expect(noul.value).toBe(0.8);
    expect(noul.distribution).toEqual({ yes: 0.8, no: 0.2 });

    const scoreQ: DecideQuestionPlan = {
      id: 'q1',
      type: 'score',
      instructions: 'x',
      criteria: ['low', 'mid', 'high'],
      options: [],
      levels: 3,
    };
    const score = expectNonNull(
      aggregateAnswers(scoreQ, [
        {
          kind: 'score',
          score: 6,
          legend: ['low', 'mid', 'high'],
          confidence: 0.5,
          probabilities: [0.1, 0.3, 0.6],
        },
        {
          kind: 'score',
          score: 8,
          legend: ['low', 'mid', 'high'],
          confidence: 0.5,
          probabilities: [0.1, 0.1, 0.8],
        },
      ]),
    );
    expect(score.value).toBe(7);
    expect(score.distribution).toEqual([0.1, 0.2, 0.7]);
  });

  it('noul / score 聚合的 modalVoteRatio 恒为 null（投票语义只属 choice）', () => {
    const noul = expectNonNull(
      aggregateAnswers(noulQ, [noulAnswer(0.9), noulAnswer(0.7)]),
    );
    expect(noul.modalVoteRatio).toBeNull();
    const scoreQ: DecideQuestionPlan = {
      id: 'q1',
      type: 'score',
      instructions: 'x',
      criteria: ['low', 'mid', 'high'],
      options: [],
      levels: 3,
    };
    const score = expectNonNull(
      aggregateAnswers(scoreQ, [
        {
          kind: 'score',
          score: 6,
          legend: ['low', 'mid', 'high'],
          confidence: 0.5,
          probabilities: [0.1, 0.3, 0.6],
        },
      ]),
    );
    expect(score.modalVoteRatio).toBeNull();
  });

  it('score 分布只按「有 probabilities 的样本」归一，全缺概率时 distribution=null', () => {
    const scoreQ: DecideQuestionPlan = {
      id: 'q1',
      type: 'score',
      instructions: 'x',
      criteria: ['low', 'mid', 'high'],
      options: [],
      levels: 3,
    };
    const mixed = expectNonNull(
      aggregateAnswers(scoreQ, [
        {
          kind: 'score',
          score: 6,
          legend: ['low', 'mid', 'high'],
          confidence: 0.5,
          probabilities: [0.2, 0.4, 0.4],
        },
        {
          kind: 'score',
          score: 8,
          legend: ['low', 'mid', 'high'],
          confidence: 0.5,
          probabilities: null,
        },
      ]),
    );
    // 只有 1 个样本提供概率 → 分布等于该样本本身（不是除以 2 后 0.1/0.2/0.2）。
    expect(mixed.distribution).toEqual([0.2, 0.4, 0.4]);

    // 样本概率数组长度不齐时也必须归一（短数组缺的档位补 0）。
    const uneven = expectNonNull(
      aggregateAnswers(scoreQ, [
        {
          kind: 'score',
          score: 6,
          legend: ['low', 'mid', 'high'],
          confidence: 0.5,
          probabilities: [0.5, 0.5],
        },
        {
          kind: 'score',
          score: 8,
          legend: ['low', 'mid', 'high'],
          confidence: 0.5,
          probabilities: [0.3, 0.3, 0.4],
        },
      ]),
    );
    const sum = (uneven.distribution as number[]).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 3);

    const noProbs = expectNonNull(
      aggregateAnswers(scoreQ, [
        {
          kind: 'score',
          score: 7,
          legend: ['low', 'mid', 'high'],
          confidence: 0.5,
          probabilities: null,
        },
      ]),
    );
    expect(noProbs.distribution).toBeNull();
    expect(noProbs.agreement).toBeNull();
  });

  it('computeAgreement：均匀分布为 0、单点为 1', () => {
    expect(computeAgreement([0.5, 0.5])).toBe(0);
    expect(computeAgreement([1])).toBe(1);
    const half = computeAgreement([0.9, 0.1]);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(1);
  });
});

describe('决策工具 decide 全链路（经统一调用层）', () => {
  it('单次判定返回概率分布、decisionId 合法、来源为决策模型、账本落一条', async () => {
    const fetch = stubFetch([{ body: noulEnv(0.85) }]);
    const { deps, ledger } = harness(fetch.fetchImpl);
    const tool = createDecideTool(deps);

    const out = (await tool.execute(NOUL_ARGS, EXEC)) as {
      ok: boolean;
      answers: Record<string, Record<string, unknown>>;
      decisionIds: Record<string, string>;
      source: string;
      usage: Record<string, unknown>;
    };

    expect(out.ok).toBe(true);
    expect(out.answers.q1).toEqual({
      type: 'noul',
      value: 0.85,
      confidence: 0.9,
      distribution: { yes: 0.85, no: 0.15 },
      legend: null,
      status: 'ok',
    });
    expect(out.decisionIds.q1).toMatch(/^dec_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(out.source).toBe('decision-model');
    expect(out.usage.calls).toBe(1);

    expect(ledger.size()).toBe(1);
    const entry = ledger.list()[0];
    expect(entry.tool).toBe('decision_decide');
    expect(entry.status).toBe('ok');
    expect(entry.payload.value).toBe(0.85);
  });

  it('n=5 自一致性：聚合均值 + 每题 5 条采样账 + 1 条汇总账', async () => {
    const fetch = stubFetch([
      { body: noulEnv(0.9) },
      { body: noulEnv(0.8) },
      { body: noulEnv(0.7) },
      { body: noulEnv(0.9) },
      { body: noulEnv(0.9) },
    ]);
    const { deps, ledger } = harness(fetch.fetchImpl);
    const tool = createDecideTool(deps);

    const out = (await tool.execute({ ...NOUL_ARGS, n: 5 }, EXEC)) as {
      ok: boolean;
      answers: Record<string, { value: number }>;
      selfConsistency: {
        requested: number;
        samples: number;
        degraded: boolean;
        agreement: number | null;
      };
    };

    expect(out.ok).toBe(true);
    expect(out.answers.q1.value).toBe(0.84);
    expect(out.selfConsistency.requested).toBe(5);
    expect(out.selfConsistency.samples).toBe(5);
    expect(out.selfConsistency.degraded).toBe(false);
    expect(fetch.calls()).toBe(5);

    // 5 条采样条目 + 1 条 aggregated=true 汇总条目
    expect(ledger.size()).toBe(6);
    const aggregated = ledger
      .list()
      .filter((e) => e.payload.aggregated === true);
    expect(aggregated).toHaveLength(1);
    // 汇总条目只承载聚合 payload，不再重复记用量与延迟（§3.1 usage 归属）。
    expect(aggregated[0].usage.calls).toBe(0);
    expect(aggregated[0].latencyMs).toBe(0);
    // S2：每次采样条目标注 selfConsistencySample=0..4，汇总条目不标。
    const sampleIndexes = ledger
      .list()
      .filter((e) => e.payload.aggregated !== true)
      .map((e) => e.payload.selfConsistencySample)
      .sort((a, b) => (a ?? -1) - (b ?? -1));
    expect(sampleIndexes).toEqual([0, 1, 2, 3, 4]);
    // B-1：n>1 时 answers[qid] 仍只有契约 6 字段，统计量只在顶层 selfConsistency。
    expect(Object.keys(out.answers.q1).sort()).toEqual(
      [
        'confidence',
        'distribution',
        'legend',
        'status',
        'type',
        'value',
      ].sort(),
    );
    // 单题时每题一次调用，5 次采样的真实用量合计 calls=5；usage 汇总即真实值，不放大。
    const totalCalls = ledger
      .list()
      .reduce((sum, entry) => sum + entry.usage.calls, 0);
    expect(totalCalls).toBe(5);
    const totalInput = ledger
      .list()
      .reduce((sum, entry) => sum + (entry.usage.inputTokens ?? 0), 0);
    expect(totalInput).toBe(50); // 5 次 × 10 input tokens，未被题数放大
  });

  it('n=5 部分分片失败：degraded=true 且 samples=成功数，失败分片不当 0 票', async () => {
    const fetch = stubFetch([
      { body: noulEnv(0.9) },
      { body: noulEnv(0.9) },
      { body: noulEnv(0.6) },
      { status: 500, body: { error: 'boom' } },
    ]);
    const { deps } = harness(fetch.fetchImpl);
    const tool = createDecideTool(deps);

    const out = (await tool.execute({ ...NOUL_ARGS, n: 5 }, EXEC)) as {
      ok: boolean;
      selfConsistency: { samples: number; degraded: boolean };
      answers: Record<string, { value: number }>;
    };

    expect(out.ok).toBe(true);
    expect(out.selfConsistency.samples).toBe(3);
    expect(out.selfConsistency.degraded).toBe(true);
    expect(out.answers.q1.value).toBe(0.8);
  });

  it('readConfig 意外抛错：统一调用层返回 stage=read-config 错误信封，不向外 reject', async () => {
    const { deps } = harness(stubFetch([]).fetchImpl);
    deps.readConfig = () => {
      throw new Error('boom from config');
    };
    const tool = createDecideTool(deps);
    const out = (await tool.execute(NOUL_ARGS, EXEC)) as {
      ok: boolean;
      error: { code: string; details?: { stage?: string } };
    };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('model-call-failed');
    expect(out.error.details?.stage).toBe('read-config');
  });

  it('execute 外层兜底：账本 append 抛错 → model-call-failed + details.stage=unexpected，不向外 reject', async () => {
    const { deps, ledger } = harness(
      stubFetch([{ body: noulEnv(0.9) }]).fetchImpl,
    );
    ledger.append = () => {
      throw new Error('boom from ledger');
    };
    const tool = createDecideTool(deps);
    const out = (await tool.execute(NOUL_ARGS, EXEC)) as {
      ok: boolean;
      error: { code: string; details?: { stage?: string } };
    };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('model-call-failed');
    expect(out.error.details?.stage).toBe('unexpected');
  });

  it('全部采样失败：返回 model-call-failed 错误信封（不臆造判定）', async () => {
    const fetch = stubFetch([{ status: 500, body: { error: 'boom' } }]);
    const { deps } = harness(fetch.fetchImpl);
    const tool = createDecideTool(deps);

    const out = (await tool.execute(NOUL_ARGS, EXEC)) as {
      ok: boolean;
      error: { code: string };
    };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('model-call-failed');
  });

  it('choice 返回候选集外的值：整体 model-invalid-response，details 列出 droppedQuestionIds', async () => {
    const fetch = stubFetch([
      {
        body: {
          answers: { q1: { type: 'choice', choice: 'Z', confidence: 0.9 } },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ]);
    const { deps } = harness(fetch.fetchImpl);
    const tool = createDecideTool(deps);

    const out = (await tool.execute(CHOICE_ARGS, EXEC)) as {
      ok: boolean;
      error: { code: string; details: { droppedQuestionIds: string[] } };
    };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('model-invalid-response');
    expect(out.error.details.droppedQuestionIds).toEqual(['q1']);
  });

  it('开关关闭 → tool-disabled 且不出网', async () => {
    const fetch = stubFetch([{ body: noulEnv(0.9) }]);
    const { deps } = harness(fetch.fetchImpl, {
      config: baseConfig({ toolsDecideEnabled: false }),
    });
    const tool = createDecideTool(deps);

    const out = (await tool.execute(NOUL_ARGS, EXEC)) as {
      ok: boolean;
      error: { code: string };
    };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('tool-disabled');
    expect(fetch.calls()).toBe(0);
  });

  it('未配置模型 → model-not-configured 且不出网', async () => {
    const fetch = stubFetch([{ body: noulEnv(0.9) }]);
    const { deps } = harness(fetch.fetchImpl, {
      config: baseConfig({ systemoneApiKey: '' }),
    });
    const tool = createDecideTool(deps);

    const out = (await tool.execute(NOUL_ARGS, EXEC)) as {
      ok: boolean;
      error: { code: string };
    };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('model-not-configured');
    expect(fetch.calls()).toBe(0);
  });

  it('未验证（无验证快照）→ model-verify-failed 且不出网', async () => {
    const fetch = stubFetch([{ body: noulEnv(0.9) }]);
    const { deps } = harness(fetch.fetchImpl, { verified: false });
    const tool = createDecideTool(deps);

    const out = (await tool.execute(NOUL_ARGS, EXEC)) as {
      ok: boolean;
      error: { code: string };
    };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('model-verify-failed');
    expect(fetch.calls()).toBe(0);
  });

  it('预算触顶 → budget-exceeded，只落一条 blocked 记录、不出网', async () => {
    const blocked: Array<[string, string]> = [];
    const denyBudget: BudgetGate = {
      check: () => budgetExceeded('calls'),
      recordBlocked: (tool, dimension) => {
        blocked.push([tool, dimension]);
      },
    };
    const fetch = stubFetch([{ body: noulEnv(0.9) }]);
    const { deps, ledger } = harness(fetch.fetchImpl, { budget: denyBudget });
    const tool = createDecideTool(deps);

    const out = (await tool.execute(NOUL_ARGS, EXEC)) as {
      ok: boolean;
      error: { code: string };
    };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('budget-exceeded');
    expect(fetch.calls()).toBe(0);
    expect(blocked).toEqual([['decision_decide', 'calls']]);
    expect(ledger.size()).toBe(1);
    const entry = ledger.list()[0];
    expect(entry.status).toBe('blocked');
    expect(entry.questionId).toBeNull();
    expect(entry.usage.calls).toBe(0);
  });

  it('多题（Q=2）时用量不被题数放大：账本合计 calls=1、token 只记一次', async () => {
    const twoQ = {
      state: 's',
      questions: {
        q1: { type: 'noul', instructions: '同意？' },
        q2: { type: 'noul', instructions: '是否继续？' },
      },
    };
    const env = {
      answers: {
        q1: { type: 'noul', noul: 0.9, confidence: 0.8 },
        q2: { type: 'noul', noul: 0.3, confidence: 0.7 },
      },
      usage: { input_tokens: 40, output_tokens: 6 },
    };
    const fetch = stubFetch([{ body: env }]);
    const { deps, ledger } = harness(fetch.fetchImpl);
    const tool = createDecideTool(deps);

    const out = (await tool.execute(twoQ, EXEC)) as {
      ok: boolean;
      usage: { calls: number; inputTokens: number | null };
    };
    expect(out.ok).toBe(true);
    expect(out.usage.calls).toBe(1);
    expect(out.usage.inputTokens).toBe(40);
    expect(fetch.calls()).toBe(1);
    expect(ledger.size()).toBe(2);
    const totalCalls = ledger.list().reduce((s, e) => s + e.usage.calls, 0);
    const totalInput = ledger
      .list()
      .reduce((s, e) => s + (e.usage.inputTokens ?? 0), 0);
    expect(totalCalls).toBe(1); // 一次调用，不被 2 题放大成 2
    expect(totalInput).toBe(40); // token 只记一次
    // B-2：延迟同样只记一次，其余题级条目 latencyMs=0。
    const latencies = ledger.list().map((e) => e.latencyMs);
    expect(latencies.filter((v) => v > 0)).toHaveLength(1);
    expect(latencies.filter((v) => v === 0)).toHaveLength(1);
  });

  it('state 可以是对象（oneOf string|object 端到端可用）', async () => {
    const fetch = stubFetch([{ body: noulEnv(0.8) }]);
    const { deps } = harness(fetch.fetchImpl);
    const tool = createDecideTool(deps);
    const out = (await tool.execute(
      {
        state: { message: '结构化状态', risk: 'low' },
        questions: { q1: { type: 'noul', instructions: '通过？' } },
      },
      EXEC,
    )) as { ok: boolean };
    expect(out.ok).toBe(true);

    const body = JSON.parse(fetch.bodies()[0]) as {
      state: { message: string };
    };
    // state 被组装成 { message: <提示词> }，对象原文落在 DETAIL 段内。
    expect(typeof body.state.message).toBe('string');
    expect(body.state.message).toContain('DETAIL:');
    expect(body.state.message).toContain('结构化状态');
  });

  it('工具名与开关映射一致（decision_decide）', () => {
    const tool = createDecideTool(
      harness(stubFetch([{ body: noulEnv(0.5) }]).fetchImpl).deps,
    );
    expect(tool.name).toBe(DECIDE_TOOL);
    expect(DECIDE_TOOL).toBe('decision_decide');
  });

  it('卡 9/11 实测形状：score 的 legend/probabilities 为档位索引对象映射、noul 无 confidence', async () => {
    // 真实决策服务（local-decision-model）返回的形状：
    //   noul   → { type:'noul', noul:0.5559 }（无 confidence、无 probabilities）
    //   score  → { type:'score', score:1.1092,
    //               legend:{"0":"negligible",...},
    //               probabilities:{"0":0.3577,...} }（档位索引对象映射，非数组）
    const env = {
      answers: {
        ready: { type: 'noul', noul: 0.5559 },
        severity: {
          type: 'score',
          score: 1.1092,
          legend: {
            '0': 'negligible',
            '1': 'minor',
            '2': 'major',
            '3': 'critical',
          },
          probabilities: { '0': 0.3577, '1': 0.2644, '2': 0.2281, '3': 0.1498 },
          confidence: 0,
        },
      },
      usage: { input_tokens: 37, output_tokens: 0 },
    };
    const fetch = stubFetch([{ body: env }]);
    const { deps } = harness(fetch.fetchImpl);
    const tool = createDecideTool(deps);

    const out = (await tool.execute(
      {
        state: { message: 'Ship the release?' },
        questions: {
          ready: { type: 'noul', instructions: 'Is the release ready?' },
          severity: {
            type: 'score',
            instructions: 'How severe?',
            criteria: ['negligible', 'minor', 'major', 'critical'],
          },
        },
      },
      EXEC,
    )) as {
      ok: boolean;
      answers: Record<
        string,
        {
          value: unknown;
          confidence: number | null;
          distribution: unknown;
          legend: string[] | null;
          status: string;
        }
      >;
    };

    expect(out.ok).toBe(true);
    // noul：上游没给 confidence 就记 null（不臆造），分布按 yes/no 归一。
    expect(out.answers.ready.confidence).toBeNull();
    expect(out.answers.ready.status).toBe('ok');
    expect(out.answers.ready.distribution).toEqual({ yes: 0.5559, no: 0.4441 });
    // score：对象映射的 legend/probabilities 归一为数组，顺序按档位索引升序。
    expect(out.answers.severity.legend).toEqual([
      'negligible',
      'minor',
      'major',
      'critical',
    ]);
    expect(Array.isArray(out.answers.severity.distribution)).toBe(true);
    const dist = out.answers.severity.distribution as number[];
    expect(dist).toHaveLength(4);
    expect(dist.reduce((sum, v) => sum + v, 0)).toBeCloseTo(1, 5);
    expect(out.answers.severity.value).toBeCloseTo(1.1092, 4);
  });
});
