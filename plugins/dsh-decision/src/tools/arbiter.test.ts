/**
 * decision_arbiter 单测（决策工具系列 10/11）。
 *
 * 覆盖卡 10 清单：
 * - 第 5 项：复用 7/11 裁判通道入口（不重写裁判逻辑）+ 防递归 + 预算闸；
 * - 第 6 项：返回 verdict / confidence / disagreement / source=llm-judge，
 *   级联记账区分 explicit-arbiter 与 auto-fallback；
 * - 第 7 项：受配置开关控制（关闭 → tool-disabled）。
 */

import { describe, expect, it } from 'vitest';

import {
  ARBITER_TOOL,
  buildArbiterQuestionFromEntry,
  computeArbiterDisagreement,
  createArbiterTool,
  mapArbiterVerdict,
  planArbiter,
  runArbiter,
  type ArbiterDeps,
} from './arbiter.ts';
import {
  resolveToolsConfig,
  type ResolvedToolsConfig,
} from '../config/decision-tools.ts';
import {
  budgetExceeded,
  createPassthroughBudgetGate,
  type BudgetGate,
} from '../runtime/budget.ts';
import {
  type LedgerEntry,
  type LedgerSink,
  createMemoryLedger,
} from '../runtime/ledger.ts';
import type { DecisionLlmLike } from '../core/decision.ts';
import type { JsonValue } from '../systemone/types.ts';

const EXEC = { signal: new AbortController().signal } as never;
const ORIGIN_ID = 'dec_0123456789ABCDEFGHJKMNPQRS';

function config(overrides: Record<string, unknown> = {}): ResolvedToolsConfig {
  return resolveToolsConfig({
    systemoneBaseUrl: 'http://127.0.0.1:3425',
    systemoneApiKey: 'key-test',
    systemoneModel: 'model-test',
    toolsArbiterEnabled: true,
    ledgerEnabled: true,
    fallbackEnabled: true,
    fallbackMode: 'explicit-arbiter',
    fallbackProvider: 'judge-provider',
    fallbackModel: 'judge-model',
    ...overrides,
  });
}

/** 假宿主大模型通道：按顺序吐文本分片。 */
function fakeLlm(texts: string[]): {
  llm: DecisionLlmLike;
  calls: () => number;
} {
  let index = 0;
  const llm: DecisionLlmLike = {
    prepareCall: async () => ({
      config: { provider: 'judge-provider', model: 'judge-model' },
      stream: async function* stream() {
        const text = texts[Math.min(index, texts.length - 1)] ?? '';
        index += 1;
        yield { type: 'text-delta', text };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    }),
  };
  return { llm, calls: () => index };
}

interface EntryInput {
  questionType?: 'noul' | 'choice' | 'score' | 'box' | null;
  value?: JsonValue;
  confidence?: number | null;
  distribution?: JsonValue;
  status?: 'ok' | 'error' | 'blocked';
}

function mkEntry(input: EntryInput = {}): LedgerEntry {
  return {
    decisionId: ORIGIN_ID,
    ts: '2026-01-01T00:00:00.000Z',
    tool: 'decision_decide',
    mode: 'primary',
    source: 'decision-model',
    questionId: 'q1',
    questionType:
      input.questionType === undefined ? 'noul' : input.questionType,
    questionSummary: '原判定摘要',
    status: input.status ?? 'ok',
    payload: {
      value: input.value === undefined ? 0.82 : input.value,
      confidence: input.confidence === undefined ? 0.9 : input.confidence,
      distribution:
        input.distribution === undefined ? null : input.distribution,
      legend: null,
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

interface Harness {
  deps: ArbiterDeps;
  ledger: LedgerSink;
  calls: () => number;
}

function harness(
  texts: string[],
  options: {
    config?: ResolvedToolsConfig;
    ledger?: LedgerSink;
    budget?: BudgetGate;
    entries?: LedgerEntry[];
    llm?: DecisionLlmLike;
  } = {},
): Harness {
  const conf = options.config ?? config();
  const ledger = options.ledger ?? createMemoryLedger(100);
  for (const entry of options.entries ?? []) ledger.append(entry);
  const fake = options.llm
    ? { llm: options.llm, calls: () => 0 }
    : fakeLlm(texts);
  const deps: ArbiterDeps = {
    readConfig: () => conf,
    ledger,
    budget: options.budget ?? createPassthroughBudgetGate(),
    llm: fake.llm,
  };
  return { deps, ledger, calls: fake.calls };
}

function noulJudge(pYes: number, confidence?: number): string {
  return JSON.stringify({
    answers: {
      arbiter: {
        value: pYes,
        ...(confidence === undefined ? {} : { confidence }),
      },
    },
  });
}

describe('decision 工具族 arbiter：显式裁判（10/11）', () => {
  it('工具名符合契约', () => {
    expect(ARBITER_TOOL).toBe('decision_arbiter');
  });

  it('按 decisionId 仲裁：返回 verdict / confidence / disagreement / source=llm-judge', async () => {
    const { deps, calls } = harness([noulJudge(0.3, 0.7)], {
      entries: [mkEntry()],
    });
    const out = await runArbiter({ decisionId: ORIGIN_ID }, EXEC, deps);
    expect(out.ok).toBe(true);
    expect(calls()).toBe(1);
    const result = out as unknown as {
      verdict: string;
      confidence: number | null;
      disagreement: boolean;
      detail: string;
      source: string;
      mode: string;
      original: { value: JsonValue; confidence: number | null };
    };
    // P(yes)=0.3 < 0.5 → no；与原判定 0.82 的差 0.52 > 0.10 → 不一致
    expect(result.verdict).toBe('no');
    expect(result.confidence).toBe(0.7);
    expect(result.disagreement).toBe(true);
    expect(result.source).toBe('llm-judge');
    expect(result.mode).toBe('explicit-arbiter');
    expect(result.original.value).toBe(0.82);
    expect(result.original.confidence).toBe(0.9);
    expect(result.detail.length).toBeLessThanOrEqual(200);
  });

  it('级联记账区分 explicit-arbiter 与 auto-fallback（账本条目 mode 正确）', async () => {
    const { deps, ledger } = harness([noulJudge(0.3)], {
      entries: [mkEntry()],
    });
    await runArbiter({ decisionId: ORIGIN_ID }, EXEC, deps);
    const entries = ledger.list();
    const judged = entries.find((entry) => entry.tool === 'decision_arbiter');
    expect(judged).toBeDefined();
    expect(judged?.mode).toBe('explicit-arbiter');
    expect(judged?.source).toBe('llm-fallback-judge');
  });

  it('防递归：裁判调用只走宿主大模型，不触发决策模型与自动兜底', async () => {
    const { deps, calls } = harness([noulJudge(0.9)], {
      entries: [mkEntry()],
    });
    const out = await runArbiter({ decisionId: ORIGIN_ID }, EXEC, deps);
    expect(out.ok).toBe(true);
    // 只调了一次宿主大模型：没有二次裁判、没有回调统一调用层
    expect(calls()).toBe(1);
  });

  it('只给 question（无原判定）→ disagreement=false 且不带 original', async () => {
    const { deps } = harness([
      JSON.stringify({ answers: { arbiter: { value: 0.8, confidence: 0.6 } } }),
    ]);
    const out = await runArbiter(
      {
        question: { type: 'noul', instructions: '现在可以发布吗？' },
        state: '发布窗口已开启',
      },
      EXEC,
      deps,
    );
    expect(out.ok).toBe(true);
    const result = out as unknown as {
      verdict: string;
      disagreement: boolean;
      original?: unknown;
    };
    expect(result.verdict).toBe('yes');
    expect(result.disagreement).toBe(false);
    expect(result.original).toBeUndefined();
  });

  it('choice 题型：verdict = 选项名，选项不同 → disagreement=true', async () => {
    const { deps } = harness(
      [
        JSON.stringify({
          answers: { arbiter: { value: 'B', confidence: 0.5 } },
        }),
      ],
      {
        entries: [
          mkEntry({
            questionType: 'choice',
            value: 'A',
            distribution: { A: 0.6, B: 0.4 },
          }),
        ],
      },
    );
    const out = await runArbiter({ decisionId: ORIGIN_ID }, EXEC, deps);
    expect(out.ok).toBe(true);
    const result = out as unknown as { verdict: string; disagreement: boolean };
    expect(result.verdict).toBe('B');
    expect(result.disagreement).toBe(true);
  });

  it('gate 题型：verdict 落在 allow/revise/block/escalate 四值内', async () => {
    const gateAnswers = JSON.stringify({
      answers: {
        'gate.allow': { value: 0.95 },
        'gate.human': { value: 0.1 },
        'gate.revise': { value: 0.05 },
      },
    });
    const { deps } = harness([gateAnswers]);
    const out = await runArbiter(
      { question: { type: 'gate', action: '发布到生产环境' } },
      EXEC,
      deps,
    );
    expect(out.ok).toBe(true);
    const result = out as unknown as { verdict: string };
    expect(['allow', 'revise', 'block', 'escalate']).toContain(result.verdict);
    expect(result.verdict).toBe('allow');
  });

  it('gate 路径的放行阈值跟随配置 gateAllowThreshold（与 decision_gate 同源）', async () => {
    // allow=0.5：默认阈值 0.8 → escalate；把阈值降到 0.4 → allow
    const gateAnswers = JSON.stringify({
      answers: {
        'gate.allow': { value: 0.5 },
        'gate.human': { value: 0.1 },
        'gate.revise': { value: 0.05 },
      },
    });
    const strict = harness([gateAnswers]);
    const strictOut = await runArbiter(
      { question: { type: 'gate', action: '发布到生产环境' } },
      EXEC,
      strict.deps,
    );
    expect((strictOut as unknown as { verdict: string }).verdict).toBe(
      'escalate',
    );

    const loose = harness([gateAnswers], {
      config: config({ gateAllowThreshold: 0.4 }),
    });
    const looseOut = await runArbiter(
      { question: { type: 'gate', action: '发布到生产环境' } },
      EXEC,
      loose.deps,
    );
    expect((looseOut as unknown as { verdict: string }).verdict).toBe('allow');
  });

  it('decisionId 不存在 → decision-not-found（不猜、不近似匹配）', async () => {
    const { deps, calls } = harness([noulJudge(0.9)]);
    const out = await runArbiter(
      { decisionId: 'dec_0123456789ABCDEFGHJKMNPQRT' },
      EXEC,
      deps,
    );
    expect(out.ok).toBe(false);
    const result = out as unknown as { error: { code: string } };
    expect(result.error.code).toBe('decision-not-found');
    expect(calls()).toBe(0);
  });

  it('原条目不是成功判定 → decision-not-found', async () => {
    const { deps, calls } = harness([noulJudge(0.9)], {
      entries: [mkEntry({ status: 'error' })],
    });
    const out = await runArbiter({ decisionId: ORIGIN_ID }, EXEC, deps);
    expect(out.ok).toBe(false);
    const result = out as unknown as { error: { code: string } };
    expect(result.error.code).toBe('decision-not-found');
    expect(calls()).toBe(0);
  });

  it('decisionId 格式非法 → decision-id-invalid', async () => {
    const { deps } = harness([noulJudge(0.9)]);
    const out = await runArbiter({ decisionId: 'not-an-id' }, EXEC, deps);
    expect(out.ok).toBe(false);
    const result = out as unknown as { error: { code: string } };
    expect(result.error.code).toBe('decision-id-invalid');
  });

  it('裁判失败（非法 JSON）→ model-invalid-response（不产无来源结论）', async () => {
    const { deps } = harness(['not-json-at-all']);
    const out = await runArbiter(
      { question: { type: 'noul', instructions: '可以发布吗？' } },
      EXEC,
      deps,
    );
    expect(out.ok).toBe(false);
    const result = out as unknown as {
      error: { code: string; message: string };
    };
    expect(result.error.code).toBe('model-invalid-response');
  });

  it('兜底未启用 → fallback-disabled（模式闸）', async () => {
    const { deps, calls } = harness([noulJudge(0.9)], {
      config: config({ fallbackEnabled: false }),
    });
    const out = await runArbiter(
      { question: { type: 'noul', instructions: '可以发布吗？' } },
      EXEC,
      deps,
    );
    expect(out.ok).toBe(false);
    const result = out as unknown as { error: { code: string } };
    expect(result.error.code).toBe('fallback-disabled');
    expect(calls()).toBe(0);
  });

  it('预算触顶 → budget-exceeded（裁判同样受预算闸约束）', async () => {
    const { deps, calls } = harness([noulJudge(0.9)], {
      budget: { check: () => budgetExceeded('calls'), recordBlocked: () => {} },
    });
    const out = await runArbiter(
      { question: { type: 'noul', instructions: '可以发布吗？' } },
      EXEC,
      deps,
    );
    expect(out.ok).toBe(false);
    const result = out as unknown as { error: { code: string } };
    expect(result.error.code).toBe('budget-exceeded');
    expect(calls()).toBe(0);
  });

  it('开关关闭 → tool-disabled', async () => {
    const { deps, calls } = harness([noulJudge(0.9)], {
      config: config({ toolsArbiterEnabled: false }),
    });
    const out = await runArbiter(
      { question: { type: 'noul', instructions: '可以发布吗？' } },
      EXEC,
      deps,
    );
    expect(out.ok).toBe(false);
    const result = out as unknown as { error: { code: string } };
    expect(result.error.code).toBe('tool-disabled');
    expect(calls()).toBe(0);
  });

  it('入参校验：decisionId 与 question 至少给一个', () => {
    const empty = planArbiter({});
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe('invalid-arguments');
    const ok = planArbiter({ question: { type: 'noul', instructions: 'x' } });
    expect(ok.ok).toBe(true);
    const badType = planArbiter({ question: { type: 'score' } });
    expect(badType.ok).toBe(false);
    const missingCriteria = planArbiter({
      question: { type: 'choice', instructions: 'x' },
    });
    expect(missingCriteria.ok).toBe(false);
  });

  it('state 必须是字符串或对象（数组/数字被拒）', () => {
    const arrayState = planArbiter({
      question: { type: 'noul', instructions: 'x' },
      state: [1, 2],
    });
    expect(arrayState.ok).toBe(false);
    if (!arrayState.ok) expect(arrayState.error.code).toBe('invalid-arguments');
    const objectState = planArbiter({
      question: { type: 'noul', instructions: 'x' },
      state: { note: 'ok' },
    });
    expect(objectState.ok).toBe(true);
  });

  it('未启用账本 + 给了 decisionId → invalid-arguments（不静默走 question）', async () => {
    const { deps, calls } = harness([noulJudge(0.9)]);
    const out = await runArbiter({ decisionId: ORIGIN_ID }, EXEC, {
      ...deps,
      ledger: undefined,
    });
    expect(out.ok).toBe(false);
    const result = out as unknown as { error: { code: string } };
    expect(result.error.code).toBe('invalid-arguments');
    expect(calls()).toBe(0);
  });

  it('detail 超长被截断到 200 字符', async () => {
    const longSummary = '样'.repeat(400);
    const { deps } = harness([noulJudge(0.3)], {
      entries: [mkEntry()],
    });
    const out = await runArbiter(
      { decisionId: ORIGIN_ID, state: longSummary },
      EXEC,
      deps,
    );
    expect(out.ok).toBe(true);
    const result = out as unknown as { detail: string };
    expect(result.detail.length).toBeLessThanOrEqual(200);
    expect(longSummary.length).toBeGreaterThan(200);
  });

  it('裁判层错误码透传：arbiter-unavailable（无模型路由）', async () => {
    const { deps, calls } = harness([noulJudge(0.9)], {
      config: config({
        fallbackProvider: '',
        fallbackModel: '',
        fallbackEnabled: true,
        fallbackMode: 'explicit-arbiter',
      }),
    });
    const out = await runArbiter(
      { question: { type: 'noul', instructions: '可以发布吗？' } },
      EXEC,
      { ...deps, resolveSessionModel: () => undefined },
    );
    expect(out.ok).toBe(false);
    const result = out as unknown as { error: { code: string } };
    expect(result.error.code).toBe('arbiter-unavailable');
    expect(calls()).toBe(0);
  });

  it('账本写失败（append 抛异常）→ 返回错误信封而非抛出（B1 回归）', async () => {
    const { deps } = harness([noulJudge(0.3)], { entries: [mkEntry()] });
    const brokenLedger = {
      append: () => {
        throw new Error('账本写炸了');
      },
      list: () => [],
      findById: () => mkEntry(),
      updateOutcome: () => false,
      size: () => 0,
    };
    const tool = createArbiterTool({ ...deps, ledger: brokenLedger });
    const result = (await tool.execute({ decisionId: ORIGIN_ID }, {
      signal: new AbortController().signal,
    } as never)) as unknown as {
      ok: boolean;
      error: { code: string; details: unknown };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('model-call-failed');
    expect(result.error.details).toEqual({ stage: 'unexpected' });
  });

  it('纯函数：题目重建与 disagreement 比较', () => {
    const rebuilt = buildArbiterQuestionFromEntry(mkEntry());
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.plan.type).toBe('noul');
    expect(rebuilt.plan.original?.value).toBe(0.82);
    const scoreCase = buildArbiterQuestionFromEntry(
      mkEntry({ questionType: 'score' }),
    );
    expect(scoreCase.ok).toBe(false);
    if (!scoreCase.ok) {
      expect(scoreCase.error.code).toBe('invalid-arguments');
    }
  });

  it('纯函数：verdict 映射与 disagreement 计算', () => {
    const plan = buildArbiterQuestionFromEntry(mkEntry());
    if (!plan.ok) throw new Error('题目重建失败');
    const result = {
      answers: {
        arbiter: {
          type: 'noul' as const,
          value: 0.75,
          confidence: 0.6,
          distribution: null,
          legend: null,
        },
      },
      source: 'llm-fallback-judge' as const,
      mode: 'explicit-arbiter' as const,
      route: { provider: 'p', model: 'm', origin: 'explicit-config' as const },
      usage: { calls: 1, inputTokens: 1, outputTokens: 1, latencyMs: 1 },
      decisionIds: {},
    };
    expect(mapArbiterVerdict(plan.plan, result).verdict).toBe('yes');
    expect(computeArbiterDisagreement(plan.plan, result)).toBe(false);
  });

  it('工厂工具名与可执行性', async () => {
    const { deps } = harness([noulJudge(0.9)], { entries: [mkEntry()] });
    const tool = createArbiterTool(deps);
    expect(tool.name).toBe('decision_arbiter');
    const result = (await tool.execute({ decisionId: ORIGIN_ID }, {
      signal: new AbortController().signal,
    } as never)) as unknown as { ok: boolean; source: string; mode: string };
    expect(result.ok).toBe(true);
    expect(result.source).toBe('llm-judge');
    expect(result.mode).toBe('explicit-arbiter');
  });
});
