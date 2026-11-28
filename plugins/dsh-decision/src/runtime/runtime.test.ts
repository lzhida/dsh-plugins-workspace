/**
 * 统一调用层与运行时底座测试（决策工具系列 2/11）。
 *
 * 覆盖：decisionId 生成、账本环形淘汰与成本换算、守卫三态、预算闸
 * 「先查后出网」、失败也记账、兜底挂点语义。
 *
 * 契约来源：docs/decision-tools-contract.md §1.3（错误优先级）、§5（账本）、
 * §8（统一调用层）。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  resolveToolsConfig,
  type ResolvedToolsConfig,
} from '../config/index.ts';
import { type FetchLike } from '../systemone/client.ts';
import type { SystemOneCallResult } from '../systemone/types.ts';

import {
  budgetExceeded,
  createPassthroughBudgetGate,
  type BudgetGate,
} from './budget.ts';
import {
  checkModelReady,
  checkToolEnabled,
  fingerprintOf,
  gateAllowThresholdOf,
  isModelConfigured,
} from './guard.ts';
import { DECISION_ID_PATTERN, isValidDecisionId, newDecisionId } from './id.ts';
import {
  createMemoryLedger,
  estimateCostUsd,
  truncateSummary,
  type LedgerEntry,
  type LedgerSink,
} from './ledger.ts';
import {
  createNoopFallbackHook,
  runDecisionCall,
  type FallbackHook,
  type FallbackTrigger,
} from './call.ts';

const noulQuestion = { type: 'noul' as const, instructions: 'Is it ready?' };

function configOf(
  overrides: Record<string, unknown> = {},
): ResolvedToolsConfig {
  return resolveToolsConfig({
    systemoneBaseUrl: 'https://decision.example.internal',
    systemoneApiKey: 'sk-test',
    systemoneModel: 'local-decision-model',
    toolsDecideEnabled: true,
    toolsGateEnabled: true,
    ...overrides,
  });
}

function stubFetch(body: unknown, status = 200): FetchLike {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });
}

function okAnswerBody(): unknown {
  return {
    model: 'local-decision-model',
    answers: { q1: { type: 'noul', noul: 0.82, confidence: 0.9 } },
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}

function ledgerEntryOf(ledger: LedgerSink, index = 0): LedgerEntry {
  const entry = ledger.list()[index];
  if (!entry) throw new Error(`账本第 ${index} 条不存在`);
  return entry;
}

describe('dsh-decision 运行时底座', () => {
  describe('decisionId（契约 §5.2）', () => {
    it('生成的 id 匹配契约正则且互不相同', () => {
      const first = newDecisionId();
      const second = newDecisionId();
      expect(first).toMatch(DECISION_ID_PATTERN);
      expect(second).toMatch(DECISION_ID_PATTERN);
      expect(first).not.toBe(second);
    });

    it('非法 id 被拒（含 I/L/O/U 与长度不符）', () => {
      expect(isValidDecisionId('dec_0123456789ABCDEFGHJKMNPQRS')).toBe(true);
      expect(isValidDecisionId('dec_short')).toBe(false);
      expect(isValidDecisionId('dec_0123456789ABCDEFGHJKMNPQU')).toBe(false);
      expect(isValidDecisionId('XEC_0123456789ABCDEFGHJKMNPQ')).toBe(false);
      expect(isValidDecisionId(123)).toBe(false);
    });
  });

  describe('账本（契约 §5）', () => {
    it('超出上限时淘汰最旧条目，list 最新在前', () => {
      const ledger = createMemoryLedger(2);
      const make = (id: string): LedgerEntry => ({
        decisionId: id,
        ts: '2026-01-01T00:00:00.000Z',
        tool: 'decision_decide',
        mode: 'primary',
        source: 'decision-model',
        questionId: 'q1',
        questionType: 'noul',
        questionSummary: '摘要',
        status: 'ok',
        payload: {
          value: 0.8,
          confidence: 0.9,
          distribution: null,
          legend: null,
        },
        outcome: {
          state: 'unknown',
          value: null,
          source: null,
          updatedAt: null,
        },
        usage: { inputTokens: 1, outputTokens: 1, calls: 1 },
        latencyMs: 10,
        costUsd: 0,
        costEstimated: false,
      });
      ledger.append(make('dec_1'));
      ledger.append(make('dec_2'));
      ledger.append(make('dec_3'));
      expect(ledger.size()).toBe(2);
      expect(ledger.list().map((entry) => entry.decisionId)).toEqual([
        'dec_3',
        'dec_2',
      ]);
      expect(ledger.findById('dec_1')).toBeUndefined();
      expect(ledger.findById('dec_2')?.decisionId).toBe('dec_2');
    });

    it('updateOutcome 回填真值字段，缺失 id 返回 false', () => {
      const ledger = createMemoryLedger(10);
      ledger.append({
        decisionId: 'dec_x',
        ts: '2026-01-01T00:00:00.000Z',
        tool: 'decision_decide',
        mode: 'primary',
        source: 'decision-model',
        questionId: 'q1',
        questionType: 'noul',
        questionSummary: null,
        status: 'ok',
        payload: {
          value: 0.8,
          confidence: 0.9,
          distribution: null,
          legend: null,
        },
        outcome: {
          state: 'unknown',
          value: null,
          source: null,
          updatedAt: null,
        },
        usage: { inputTokens: 1, outputTokens: 1, calls: 1 },
        latencyMs: 10,
        costUsd: 0,
        costEstimated: false,
      });
      expect(
        ledger.updateOutcome('dec_x', { state: 'confirmed', value: true }),
      ).toBe(true);
      expect(ledger.findById('dec_x')?.outcome.state).toBe('confirmed');
      expect(ledger.findById('dec_x')?.outcome.source).toBe('downstream');
      expect(ledger.updateOutcome('dec_missing', { state: 'rejected' })).toBe(
        false,
      );
    });

    it('成本换算三态：usage 缺失→null；费率 0→0 不标估算；有费率→估算值', () => {
      expect(
        estimateCostUsd(
          { inputTokens: null, outputTokens: 10, calls: 1 },
          { costInputPer1kTokens: 1, costOutputPer1kTokens: 1 },
        ),
      ).toEqual({ costUsd: null, costEstimated: false });
      expect(
        estimateCostUsd(
          { inputTokens: 1000, outputTokens: 500, calls: 1 },
          { costInputPer1kTokens: 0, costOutputPer1kTokens: 0 },
        ),
      ).toEqual({ costUsd: 0, costEstimated: false });
      expect(
        estimateCostUsd(
          { inputTokens: 1000, outputTokens: 500, calls: 1 },
          { costInputPer1kTokens: 2, costOutputPer1kTokens: 4 },
        ),
      ).toEqual({ costUsd: 4, costEstimated: true });
    });

    it('问题摘要截到 120 字符', () => {
      expect(truncateSummary('x'.repeat(200))).toHaveLength(120);
      expect(truncateSummary('  短  ')).toBe('短');
    });
  });

  describe('守卫层（契约 §1.3 fail-closed）', () => {
    it('开关关闭 → tool-disabled，且 details 带工具名', () => {
      const config = configOf({ toolsDecideEnabled: false });
      const error = checkToolEnabled(config, 'decision_decide');
      expect(error?.code).toBe('tool-disabled');
      expect(error?.details.tool).toBe('decision_decide');
    });

    it('开关开启 → 放行（返回 null）', () => {
      expect(checkToolEnabled(configOf(), 'decision_decide')).toBeNull();
    });

    it('三元组不齐 → model-not-configured', () => {
      expect(isModelConfigured(configOf({ systemoneApiKey: '' }))).toBe(false);
      const error = checkModelReady(
        configOf({ systemoneApiKey: '' }),
        undefined,
      );
      expect(error?.code).toBe('model-not-configured');
    });

    it('从未验证 / 指纹失配 → model-verify-failed', () => {
      const config = configOf();
      expect(checkModelReady(config, undefined)?.code).toBe(
        'model-verify-failed',
      );
      expect(
        checkModelReady(config, {
          fingerprint: 'stale:0',
          verifiedAt: '2026-01-01T00:00:00.000Z',
        })?.code,
      ).toBe('model-verify-failed');
    });

    it('指纹匹配 → 放行', () => {
      const config = configOf();
      const snapshot = {
        fingerprint: fingerprintOf(config),
        verifiedAt: '2026-01-01T00:00:00.000Z',
      };
      expect(checkModelReady(config, snapshot)).toBeNull();
    });

    it('gate 阈值非法时回落到契约默认 0.8', () => {
      expect(gateAllowThresholdOf(configOf({ gateAllowThreshold: 0.8 }))).toBe(
        0.8,
      );
      expect(gateAllowThresholdOf(configOf({ gateAllowThreshold: 0 }))).toBe(
        0.8,
      );
    });
  });

  describe('预算闸挂点', () => {
    it('直通实现恒放行', () => {
      const gate = createPassthroughBudgetGate();
      expect(gate.check({ tool: 'decision_decide' })).toEqual({ ok: true });
    });

    it('超限结果的错误码是 budget-exceeded 且带触顶维度', () => {
      const result = budgetExceeded('tokens');
      expect(result.ok).toBe(false);
      expect(result.dimension).toBe('tokens');
      expect(result.error.code).toBe('budget-exceeded');
      expect(result.error.retryable).toBe(false);
    });
  });

  describe('统一调用层 runDecisionCall', () => {
    it('正常路径：分配 decisionId、按题记账、返回解析后的答案', async () => {
      const ledger = createMemoryLedger(10);
      const config = configOf();
      const result = await runDecisionCall(
        {
          readConfig: () => config,
          getVerifySnapshot: () => ({
            fingerprint: fingerprintOf(config),
            verifiedAt: '2026-01-01T00:00:00.000Z',
          }),
          ledger,
          fetchImpl: stubFetch(okAnswerBody()),
        },
        {
          tool: 'decision_decide',
          state: { message: '评估' },
          questions: { q1: noulQuestion },
          questionSummaries: { q1: '就绪了吗' },
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.decisionIds.q1).toMatch(DECISION_ID_PATTERN);
      const entry = ledgerEntryOf(ledger);
      expect(entry.decisionId).toBe(result.decisionIds.q1);
      expect(entry.status).toBe('ok');
      expect(entry.payload.value).toBe(0.82);
      expect(entry.payload.confidence).toBe(0.9);
      expect(entry.usage.calls).toBe(1);
      expect(entry.usage.inputTokens).toBe(100);
      expect(entry.mode).toBe('primary');
      expect(entry.source).toBe('decision-model');
      expect(entry.outcome.state).toBe('unknown');
    });

    it('开关关闭 → tool-disabled 且不出网', async () => {
      const fetchImpl = vi.fn(stubFetch(okAnswerBody()));
      const config = configOf({ toolsDecideEnabled: false });
      const result = await runDecisionCall(
        {
          readConfig: () => config,
          getVerifySnapshot: () => ({
            fingerprint: fingerprintOf(config),
            verifiedAt: '2026-01-01T00:00:00.000Z',
          }),
          fetchImpl,
        },
        { tool: 'decision_decide', state: {}, questions: { q1: noulQuestion } },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('tool-disabled');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('未配置模型 → model-not-configured 且不出网', async () => {
      const fetchImpl = vi.fn(stubFetch(okAnswerBody()));
      const config = configOf({ systemoneBaseUrl: '' });
      const result = await runDecisionCall(
        {
          readConfig: () => config,
          getVerifySnapshot: () => undefined,
          fetchImpl,
        },
        { tool: 'decision_decide', state: {}, questions: { q1: noulQuestion } },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('model-not-configured');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('未验证 → model-verify-failed（fail-closed，不静默放行）', async () => {
      const fetchImpl = vi.fn(stubFetch(okAnswerBody()));
      const config = configOf();
      const result = await runDecisionCall(
        {
          readConfig: () => config,
          getVerifySnapshot: () => undefined,
          fetchImpl,
        },
        { tool: 'decision_decide', state: {}, questions: { q1: noulQuestion } },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('model-verify-failed');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('预算触顶 → budget-exceeded，只落 blocked 记录且不出网', async () => {
      const ledger = createMemoryLedger(10);
      const fetchImpl = vi.fn(stubFetch(okAnswerBody()));
      const budget: BudgetGate = {
        check: () => budgetExceeded('calls'),
        recordBlocked: vi.fn(),
      };
      const config = configOf();
      const result = await runDecisionCall(
        {
          readConfig: () => config,
          getVerifySnapshot: () => ({
            fingerprint: fingerprintOf(config),
            verifiedAt: '2026-01-01T00:00:00.000Z',
          }),
          ledger,
          budget,
          fetchImpl,
        },
        { tool: 'decision_decide', state: {}, questions: { q1: noulQuestion } },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('budget-exceeded');
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(budget.recordBlocked).toHaveBeenCalledWith(
        'decision_decide',
        'calls',
      );
      const entry = ledgerEntryOf(ledger);
      expect(entry.status).toBe('blocked');
      expect(entry.usage.calls).toBe(0);
      expect(entry.payload.errorCode).toBe('budget-exceeded');
    });

    it('调用失败也记账：status=error、errorCode 落账、calls=1', async () => {
      const ledger = createMemoryLedger(10);
      const config = configOf();
      const result = await runDecisionCall(
        {
          readConfig: () => config,
          getVerifySnapshot: () => ({
            fingerprint: fingerprintOf(config),
            verifiedAt: '2026-01-01T00:00:00.000Z',
          }),
          ledger,
          fetchImpl: stubFetch({ error: 'boom' }, 500),
        },
        { tool: 'decision_decide', state: {}, questions: { q1: noulQuestion } },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('model-call-failed');
      const entry = ledgerEntryOf(ledger);
      expect(entry.status).toBe('error');
      expect(entry.payload.errorCode).toBe('model-call-failed');
      expect(entry.payload.value).toBeNull();
      expect(entry.usage.calls).toBe(1);
      expect(entry.usage.inputTokens).toBeNull();
    });

    it('兜底挂点：noop 保持原错误；裁判成功则按 llm-fallback-judge 记账', async () => {
      const config = configOf({ fallbackEnabled: true });
      const snapshot = {
        fingerprint: fingerprintOf(config),
        verifiedAt: '2026-01-01T00:00:00.000Z',
      };

      const noop = createNoopFallbackHook();
      const noopResult = await runDecisionCall(
        {
          readConfig: () => config,
          getVerifySnapshot: () => snapshot,
          fallback: noop,
          fetchImpl: stubFetch({ error: 'boom' }, 500),
        },
        { tool: 'decision_decide', state: {}, questions: { q1: noulQuestion } },
      );
      expect(noopResult.ok).toBe(false);
      if (noopResult.ok) return;
      expect(noopResult.error.code).toBe('model-call-failed');

      const ledger = createMemoryLedger(10);
      const judged: SystemOneCallResult = {
        ok: true,
        model: 'session-model',
        answers: {
          q1: { kind: 'noul', pYes: 0.6, confidence: 0.6, probabilities: null },
        },
        droppedQuestionIds: [],
        invalidAnswers: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        latencyMs: 42,
      };
      const hook: FallbackHook = {
        maybeFallback: async () => ({
          ok: true,
          result: judged,
          route: {
            provider: 'session',
            model: 'session-model',
            origin: 'session-model',
          },
          trigger: 'model-call-failed',
          originalConfidence: null,
        }),
      };
      const result = await runDecisionCall(
        {
          readConfig: () => config,
          getVerifySnapshot: () => snapshot,
          ledger,
          fallback: hook,
          fetchImpl: stubFetch({ error: 'boom' }, 500),
        },
        { tool: 'decision_decide', state: {}, questions: { q1: noulQuestion } },
      );
      expect(result.ok).toBe(true);
      const entry = ledgerEntryOf(ledger);
      expect(entry.source).toBe('llm-fallback-judge');
      expect(entry.mode).toBe('auto-fallback');
    });

    it('纯本地工具误入调用层 → invalid-arguments，且不受模型配置约束', async () => {
      const fetchImpl = vi.fn(stubFetch(okAnswerBody()));
      const config = configOf({
        systemoneBaseUrl: '',
        systemoneApiKey: '',
        systemoneModel: '',
        toolsUsageEnabled: true,
      });
      const result = await runDecisionCall(
        {
          readConfig: () => config,
          getVerifySnapshot: () => undefined,
          fetchImpl,
        },
        {
          tool: 'decision_usage',
          state: {},
          questions: { q1: noulQuestion },
        },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('invalid-arguments');
      expect(result.error.details.tool).toBe('decision_usage');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('预算触顶（多题）→ 只落一条 blocked 记录（契约 §8.3）', async () => {
      const ledger = createMemoryLedger(10);
      const fetchImpl = vi.fn(stubFetch(okAnswerBody()));
      const budget: BudgetGate = {
        check: () => budgetExceeded('tokens'),
        recordBlocked: vi.fn(),
      };
      const config = configOf();
      const result = await runDecisionCall(
        {
          readConfig: () => config,
          getVerifySnapshot: () => ({
            fingerprint: fingerprintOf(config),
            verifiedAt: '2026-01-01T00:00:00.000Z',
          }),
          ledger,
          budget,
          fetchImpl,
        },
        {
          tool: 'decision_decide',
          state: {},
          questions: { q1: noulQuestion, q2: noulQuestion, q3: noulQuestion },
        },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('budget-exceeded');
      expect(ledger.size()).toBe(1);
      const entry = ledgerEntryOf(ledger);
      expect(entry.status).toBe('blocked');
      expect(entry.questionId).toBeNull();
      expect(entry.usage.calls).toBe(0);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('调用方主动取消 → 不触发兜底裁判（details.aborted）', async () => {
      const controller = new AbortController();
      controller.abort();
      const fetchImpl = vi.fn(stubFetch(okAnswerBody()));
      const maybeFallback = vi.fn(async () => null);
      const config = configOf({ fallbackEnabled: true });
      const result = await runDecisionCall(
        {
          readConfig: () => config,
          getVerifySnapshot: () => ({
            fingerprint: fingerprintOf(config),
            verifiedAt: '2026-01-01T00:00:00.000Z',
          }),
          fallback: { maybeFallback },
          fetchImpl,
        },
        {
          tool: 'decision_decide',
          state: {},
          questions: { q1: noulQuestion },
          signal: controller.signal,
        },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('model-call-failed');
      expect(result.error.details.aborted).toBe(true);
      expect(maybeFallback).not.toHaveBeenCalled();
    });

    it('readConfig 抛异常 → 返回错误信封，不抛异常（契约 §1.1）', async () => {
      const fetchImpl = vi.fn(stubFetch(okAnswerBody()));
      const result = await runDecisionCall(
        {
          readConfig: () => {
            throw new Error('config boom');
          },
          getVerifySnapshot: () => undefined,
          fetchImpl,
        },
        { tool: 'decision_decide', state: {}, questions: { q1: noulQuestion } },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('model-call-failed');
      expect(result.error.details.stage).toBe('read-config');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('兜底触发时保留真实原错误码（超时不被写成 model-call-failed）', async () => {
      vi.useFakeTimers();
      try {
        const config = configOf({ fallbackEnabled: true });
        const snapshot = {
          fingerprint: fingerprintOf(config),
          verifiedAt: '2026-01-01T00:00:00.000Z',
        };
        const seen: FallbackTrigger[] = [];
        const hook: FallbackHook = {
          maybeFallback: async (trigger) => {
            seen.push(trigger);
            return null;
          },
        };
        const hangingFetch = ((_url: string, init: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new Error('aborted')),
            );
          })) as unknown as FetchLike;
        const promise = runDecisionCall(
          {
            readConfig: () => config,
            getVerifySnapshot: () => snapshot,
            fallback: hook,
            fetchImpl: hangingFetch,
          },
          {
            tool: 'decision_decide',
            state: {},
            questions: { q1: noulQuestion },
          },
        );
        await vi.advanceTimersByTimeAsync(60_000);
        const result = await promise;
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('model-timeout');
        expect(seen).toHaveLength(1);
        expect(seen[0]?.kind).toBe('model-timeout');
        expect(seen[0]?.originalError?.code).toBe('model-timeout');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
