/**
 * 兜底裁判入口单测（决策工具系列 7/11）。
 *
 * 覆盖卡 7 清单：
 * - 第 2 项：裁判路由解析（显式配置优先 → 会话当前模型 → arbiter-unavailable）；
 * - 第 7 项：兜底失败不产无来源结论（裁判答案非法/缺题 → 整体失败）；
 * - 第 10 项：裁判入口可复用模块 + 防递归 + 预算闸 + 记账（mode/source 可区分）。
 */

import { describe, expect, it } from 'vitest';

import {
  buildJudgePrompt,
  extractJudgeJson,
  judgeModeAllowed,
  judgeOnce,
  parseJudgeAnswers,
  resolveJudgeRoute,
  type JudgeRequest,
} from './judge.ts';
import {
  resolveToolsConfig,
  type ResolvedToolsConfig,
} from '../config/decision-tools.ts';
import { budgetExceeded, type BudgetGate } from './budget.ts';
import { createMemoryLedger, type LedgerSink } from './ledger.ts';
import type { DecisionLlmLike } from '../core/decision.ts';
import type { SystemOneQuestion } from '../systemone/types.ts';

function baseConfig(
  overrides: Record<string, unknown> = {},
): ResolvedToolsConfig {
  return resolveToolsConfig({
    systemoneBaseUrl: 'http://127.0.0.1:3425',
    systemoneApiKey: 'key-test',
    systemoneModel: 'model-test',
    toolsDecideEnabled: true,
    toolsGateEnabled: true,
    ledgerEnabled: true,
    fallbackEnabled: true,
    fallbackMode: 'auto-fallback',
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

const NOUL_QUESTION: Record<string, SystemOneQuestion> = {
  q1: { type: 'noul', instructions: 'ship it now?' },
};

const CHOICE_QUESTION: Record<string, SystemOneQuestion> = {
  q1: {
    type: 'choice',
    instructions: 'which plan?',
    criteria: { A: '安全方案', B: '激进方案' },
  },
};

function judgeRequest(overrides: Partial<JudgeRequest> = {}): JudgeRequest {
  return {
    mode: 'auto-fallback',
    tool: 'decision_decide',
    state: 'the release is ready',
    questions: NOUL_QUESTION,
    timeoutMs: 5_000,
    ...overrides,
  };
}

describe('决策工具 兜底裁判路由解析', () => {
  it('显式配置优先（origin=explicit-config）', () => {
    const config = baseConfig();
    const route = resolveJudgeRoute(config, judgeRequest(), {});
    expect(route).toEqual({
      provider: 'judge-provider',
      model: 'judge-model',
      origin: 'explicit-config',
    });
  });

  it('显式未配置 → 用请求里的会话模型（origin=session-model）', () => {
    const config = baseConfig({ fallbackProvider: '', fallbackModel: '' });
    const route = resolveJudgeRoute(
      config,
      judgeRequest({ sessionModel: { provider: 'sess-p', model: 'sess-m' } }),
      {},
    );
    expect(route).toEqual({
      provider: 'sess-p',
      model: 'sess-m',
      origin: 'session-model',
    });
  });

  it('请求没带会话模型 → 用解析器（resolveSessionModel）', () => {
    const config = baseConfig({ fallbackProvider: '', fallbackModel: '' });
    const route = resolveJudgeRoute(config, judgeRequest(), {
      resolveSessionModel: () => ({ provider: 'p2', model: 'm2' }),
    });
    expect(route?.origin).toBe('session-model');
    expect(route?.provider).toBe('p2');
  });

  it('显式与会话都拿不到 → route=null（调用方映射 arbiter-unavailable）', () => {
    const config = baseConfig({ fallbackProvider: '', fallbackModel: '' });
    expect(resolveJudgeRoute(config, judgeRequest(), {})).toBeNull();
  });

  it('模式闸：auto-fallback 只认 auto-fallback/both，explicit-arbiter 只认 explicit-arbiter/both', () => {
    expect(judgeModeAllowed(baseConfig(), 'auto-fallback')).toBe(true);
    expect(judgeModeAllowed(baseConfig(), 'explicit-arbiter')).toBe(false);
    expect(
      judgeModeAllowed(
        baseConfig({ fallbackMode: 'explicit-arbiter' }),
        'explicit-arbiter',
      ),
    ).toBe(true);
    expect(
      judgeModeAllowed(
        baseConfig({ fallbackMode: 'both' }),
        'explicit-arbiter',
      ),
    ).toBe(true);
  });
});

describe('决策工具 兜底裁判入口 judgeOnce', () => {
  it('兜底未启用 → fallback-disabled（结构化错误，不抛异常）', async () => {
    const outcome = await judgeOnce(
      { readConfig: () => baseConfig({ fallbackEnabled: false }) },
      judgeRequest(),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('fallback-disabled');
  });

  it('模式不匹配 → fallback-disabled', async () => {
    const outcome = await judgeOnce(
      { readConfig: () => baseConfig({ fallbackMode: 'auto-fallback' }) },
      judgeRequest({ mode: 'explicit-arbiter' }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('fallback-disabled');
  });

  it('没有可用裁判模型 → arbiter-unavailable（绝不猜模型）', async () => {
    const outcome = await judgeOnce(
      {
        readConfig: () =>
          baseConfig({ fallbackProvider: '', fallbackModel: '' }),
      },
      judgeRequest(),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('arbiter-unavailable');
  });

  it('宿主大模型通道缺失 → arbiter-unavailable', async () => {
    const outcome = await judgeOnce(
      { readConfig: () => baseConfig() },
      judgeRequest(),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('arbiter-unavailable');
  });

  it('预算闸超限 → budget-exceeded（裁判不发起调用）', async () => {
    const { llm, calls } = fakeLlm(['{"answers":{"q1":{"value":0.9}}}']);
    const budget: BudgetGate = {
      check: () => budgetExceeded('calls'),
      recordBlocked: () => undefined,
    };
    const outcome = await judgeOnce(
      { readConfig: () => baseConfig(), llm, budget },
      judgeRequest(),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('budget-exceeded');
    expect(calls()).toBe(0);
  });

  it('裁判成功 → 结构化答案 + 路由 + usage.calls=1', async () => {
    const { llm } = fakeLlm([
      '{"answers":{"q1":{"value":0.86,"confidence":0.71}}}',
    ]);
    const outcome = await judgeOnce(
      { readConfig: () => baseConfig(), llm },
      judgeRequest(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.source).toBe('llm-fallback-judge');
    expect(outcome.result.mode).toBe('auto-fallback');
    expect(outcome.result.route.origin).toBe('explicit-config');
    expect(outcome.result.usage.calls).toBe(1);
    expect(outcome.result.answers.q1.value).toBe(0.86);
    expect(outcome.result.answers.q1.confidence).toBe(0.71);
    expect(outcome.result.decisionIds.q1).toMatch(
      /^dec_[0-9A-HJKMNP-TV-Z]{26}$/,
    );
  });

  it('confidence 缺失 → 记 null（绝不臆造）', async () => {
    const { llm } = fakeLlm(['{"answers":{"q1":{"value":0.5}}}']);
    const outcome = await judgeOnce(
      { readConfig: () => baseConfig(), llm },
      judgeRequest(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.answers.q1.confidence).toBeNull();
  });

  it('choice 答案不在候选集 → model-invalid-response（不产半份答案）', async () => {
    const { llm } = fakeLlm(['{"answers":{"q1":{"value":"C"}}}']);
    const outcome = await judgeOnce(
      { readConfig: () => baseConfig(), llm },
      judgeRequest({ questions: CHOICE_QUESTION }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('model-invalid-response');
  });

  it('裁判返回非 JSON → model-invalid-response', async () => {
    const { llm } = fakeLlm(['我认为应该放行。']);
    const outcome = await judgeOnce(
      { readConfig: () => baseConfig(), llm },
      judgeRequest(),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('model-invalid-response');
  });

  it('裁判漏答一题 → model-invalid-response', async () => {
    const { llm } = fakeLlm(['{"answers":{}}']);
    const outcome = await judgeOnce(
      { readConfig: () => baseConfig(), llm },
      judgeRequest(),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('model-invalid-response');
  });

  it('题型不支持（box）→ invalid-arguments', async () => {
    const outcome = await judgeOnce(
      { readConfig: () => baseConfig() },
      judgeRequest({
        questions: {
          q1: {
            type: 'box',
            instructions: 'where?',
          } as unknown as SystemOneQuestion,
        },
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('invalid-arguments');
  });

  it('空题目 → invalid-arguments', async () => {
    const outcome = await judgeOnce(
      { readConfig: () => baseConfig() },
      judgeRequest({ questions: {} }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('invalid-arguments');
  });

  it('记账：按题落条目，usage 只记首条，mode/source 可区分', async () => {
    const ledger: LedgerSink = createMemoryLedger(50);
    const { llm } = fakeLlm([
      '{"answers":{"q1":{"value":0.9},"q2":{"value":0.8}}}',
    ]);
    const outcome = await judgeOnce(
      { readConfig: () => baseConfig(), llm, ledger },
      judgeRequest({
        questions: {
          q1: { type: 'noul', instructions: 'a?' },
          q2: { type: 'noul', instructions: 'b?' },
        },
      }),
    );
    expect(outcome.ok).toBe(true);
    const entries = ledger.list();
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.source === 'llm-fallback-judge')).toBe(true);
    expect(entries.every((e) => e.mode === 'auto-fallback')).toBe(true);
    const totalCalls = entries.reduce((sum, e) => sum + e.usage.calls, 0);
    expect(totalCalls).toBe(1);
  });

  it('explicit-arbiter 模式的记账 mode 与 auto-fallback 可区分', async () => {
    const ledger: LedgerSink = createMemoryLedger(50);
    const { llm } = fakeLlm(['{"answers":{"q1":{"value":0.9}}}']);
    const outcome = await judgeOnce(
      {
        readConfig: () => baseConfig({ fallbackMode: 'both' }),
        llm,
        ledger,
      },
      judgeRequest({ mode: 'explicit-arbiter' }),
    );
    expect(outcome.ok).toBe(true);
    expect(ledger.list()[0]?.mode).toBe('explicit-arbiter');
  });

  it('防递归：裁判自身失败不会再次触发裁判（宿主通道只被调一次）', async () => {
    const { llm, calls } = fakeLlm(['not json at all']);
    const outcome = await judgeOnce(
      { readConfig: () => baseConfig(), llm },
      judgeRequest(),
    );
    expect(outcome.ok).toBe(false);
    expect(calls()).toBe(1);
  });
});

describe('决策工具 裁判提示词与解析纯函数', () => {
  it('buildJudgePrompt 顺序固定 PURPOSE→CONSTRAINTS→ACTIONS→DETAIL→QUESTIONS', () => {
    const prompt = buildJudgePrompt(judgeRequest());
    const order = [
      'PURPOSE:',
      'CONSTRAINTS:',
      'ACTIONS:',
      'DETAIL:',
      'QUESTIONS:',
    ];
    let cursor = -1;
    for (const marker of order) {
      const index = prompt.indexOf(marker);
      expect(index).toBeGreaterThan(cursor);
      cursor = index;
    }
    expect(prompt).toContain('the release is ready');
    expect(prompt).toContain('q1 (noul): ship it now?');
  });

  it('extractJudgeJson 容忍 ```json 围栏与前后缀说明', () => {
    expect(extractJudgeJson('```json\n{"answers":{}}\n```')).toBe(
      '{"answers":{}}',
    );
    expect(extractJudgeJson('好的，结果如下：{"answers":{}} 完毕')).toBe(
      '{"answers":{}}',
    );
    expect(extractJudgeJson('没有 JSON')).toBeNull();
  });

  it('parseJudgeAnswers：noul / choice / score 三题型都能解析', () => {
    const noul = parseJudgeAnswers(
      '{"answers":{"q1":{"value":0.9,"confidence":0.8}}}',
      NOUL_QUESTION,
    );
    expect('answers' in noul).toBe(true);
    if ('answers' in noul) {
      expect(noul.answers.q1.value).toBe(0.9);
      expect(noul.answers.q1.type).toBe('noul');
    }

    const choice = parseJudgeAnswers(
      '{"answers":{"q1":{"value":"B"}}}',
      CHOICE_QUESTION,
    );
    expect('answers' in choice).toBe(true);
    if ('answers' in choice) {
      expect(choice.answers.q1.value).toBe('B');
      expect(choice.answers.q1.confidence).toBeNull();
    }

    const score = parseJudgeAnswers('{"answers":{"q1":{"value":2}}}', {
      q1: {
        type: 'score',
        instructions: '打几分',
        criteria: ['low', 'mid', 'high'],
      },
    });
    expect('answers' in score).toBe(true);
    if ('answers' in score) {
      expect(score.answers.q1.value).toBe(2);
      expect(score.answers.q1.legend).toEqual(['low', 'mid', 'high']);
    }
  });

  it('parseJudgeAnswers：score 超出量表 → model-invalid-response', () => {
    const parsed = parseJudgeAnswers('{"answers":{"q1":{"value":9}}}', {
      q1: {
        type: 'score',
        instructions: '打几分',
        criteria: ['low', 'mid', 'high'],
      },
    });
    expect('error' in parsed).toBe(true);
    if ('error' in parsed) {
      expect(parsed.error.code).toBe('model-invalid-response');
    }
  });
});
