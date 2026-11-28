/**
 * 兜底级联单测（决策工具系列 7/11）。
 *
 * 覆盖卡 7 清单：
 * - 第 1 项：三条触发路径 T1（未配置）/ T2（调用失败）/ T3（低置信）全链路；
 * - 第 3 项：兜底关闭回归（未启用 / 模式不含 auto-fallback 时维持原结果）；
 * - 第 5 项：级联次数与差异记账（裁判条目 source/mode 可区分）；
 * - 第 6 项：meta 标注来源与置信度；
 * - 第 7 项：兜底失败不产无来源结论（维持首判 + 记录失败原因）；
 * - 第 8 项：兜底失败不掩盖原错误码。
 */

import { describe, expect, it } from 'vitest';

import { createDecideTool } from '../tools/decide.ts';
import {
  resolveToolsConfig,
  type ResolvedToolsConfig,
} from '../config/decision-tools.ts';
import { createPassthroughBudgetGate, type BudgetGate } from './budget.ts';
import type { DecisionCallDeps } from './call.ts';
import { createAutoFallbackHook } from './fallback.ts';
import { fingerprintOf } from './guard.ts';
import { createMemoryLedger, type LedgerSink } from './ledger.ts';
import type { DecisionLlmLike } from '../core/decision.ts';
import type { FetchLike } from '../systemone/client.ts';

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
    fallbackEnabled: true,
    fallbackMode: 'auto-fallback',
    fallbackProvider: 'judge-provider',
    fallbackModel: 'judge-model',
    fallbackMinConfidence: 0.7,
    ...overrides,
  });
}

/** 假宿主大模型通道（裁判用）：按顺序吐文本分片。 */
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

/** 决策模型通道：按顺序返回响应。 */
function stubFetch(payloads: Array<{ status?: number; body: unknown }>): {
  fetchImpl: FetchLike;
  calls: () => number;
} {
  let index = 0;
  const fetchImpl: FetchLike = async (_url, init) => {
    void init;
    const spec = payloads[Math.min(index, payloads.length - 1)];
    index += 1;
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

const NOUL_ARGS = {
  state: 'the release is ready',
  questions: { q1: { type: 'noul', instructions: 'ship it now?' } },
};

const NOUL_ENV = (pYes: number, confidence: number) => ({
  answers: { q1: { type: 'noul', noul: pYes, confidence } },
  usage: { input_tokens: 10, output_tokens: 5 },
});

const JUDGE_OK = '{"answers":{"q1":{"value":0.95,"confidence":0.8}}}';

interface Harness {
  deps: DecisionCallDeps;
  ledger: LedgerSink;
  llmCalls: () => number;
  fetchCalls: () => number;
}

function harness(
  options: {
    config?: ResolvedToolsConfig;
    ledger?: LedgerSink;
    llm?: DecisionLlmLike;
    fetchImpl?: FetchLike;
    verified?: boolean;
    budget?: BudgetGate;
  } = {},
): Harness {
  const config = options.config ?? baseConfig();
  const ledger = options.ledger ?? createMemoryLedger(100);
  const judge = options.llm
    ? { llm: options.llm, calls: () => 0 }
    : { llm: undefined, calls: () => 0 };
  const fetch = options.fetchImpl
    ? { fetchImpl: options.fetchImpl, calls: () => 0 }
    : { fetchImpl: undefined, calls: () => 0 };
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
    fallback: createAutoFallbackHook({
      readConfig: () => config,
      ...(judge.llm ? { llm: judge.llm } : {}),
      ledger,
    }),
    ...(fetch.fetchImpl ? { fetchImpl: fetch.fetchImpl } : {}),
  };
  return {
    deps,
    ledger,
    llmCalls: judge.calls,
    fetchCalls: fetch.calls,
  };
}

describe('决策工具 兜底关闭回归', () => {
  it('兜底未启用 → 维持原错误（model-not-configured），不产无来源结论', async () => {
    const { deps } = harness({
      config: baseConfig({
        fallbackEnabled: false,
        systemoneBaseUrl: '',
        systemoneApiKey: '',
        systemoneModel: '',
      }),
      verified: false,
    });
    const tool = createDecideTool(deps);
    const out = (await tool.execute(NOUL_ARGS, EXEC)) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('model-not-configured');
  });

  it('fallbackMode 不含 auto-fallback → 维持原错误，不触发裁判', async () => {
    const judge = fakeLlm([JUDGE_OK]);
    const { deps } = harness({
      config: baseConfig({
        fallbackMode: 'explicit-arbiter',
        systemoneBaseUrl: '',
        systemoneApiKey: '',
        systemoneModel: '',
      }),
      llm: judge.llm,
      verified: false,
    });
    const tool = createDecideTool(deps);
    const out = (await tool.execute(NOUL_ARGS, EXEC)) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('model-not-configured');
    expect(judge.calls()).toBe(0);
  });
});

describe('决策工具 兜底三触发路径', () => {
  it('T1 未配置模型 → 裁判接管，source=llm-fallback-judge 且 meta 标注触发原因', async () => {
    const judge = fakeLlm([JUDGE_OK]);
    const { deps } = harness({
      config: baseConfig({
        systemoneBaseUrl: '',
        systemoneApiKey: '',
        systemoneModel: '',
      }),
      llm: judge.llm,
      verified: false,
    });
    const tool = createDecideTool(deps);
    const out = (await tool.execute(NOUL_ARGS, EXEC)) as {
      ok: boolean;
      source?: string;
      fallback?: { triggered?: boolean; trigger?: string; route?: unknown };
      answers?: Record<string, { value?: unknown }>;
    };
    expect(out.ok).toBe(true);
    expect(out.source).toBe('llm-fallback-judge');
    expect(out.fallback?.triggered).toBe(true);
    expect(out.fallback?.trigger).toBe('model-not-configured');
    expect(out.fallback?.route).toMatchObject({
      provider: 'judge-provider',
      model: 'judge-model',
      origin: 'explicit-config',
    });
  });

  it('T1 首判已是裁判且裁判置信度低于阈值 → 不再二判（裁判只被调用一次）', async () => {
    const judge = fakeLlm([
      '{"answers":{"q1":{"value":0.9,"confidence":0.5}}}',
    ]);
    const { deps } = harness({
      config: baseConfig({
        systemoneBaseUrl: '',
        systemoneApiKey: '',
        systemoneModel: '',
      }),
      llm: judge.llm,
      verified: false,
    });
    const tool = createDecideTool(deps);
    const out = (await tool.execute(NOUL_ARGS, EXEC)) as {
      ok: boolean;
      source?: string;
      fallback?: { triggered?: boolean; trigger?: string };
    };
    expect(out.ok).toBe(true);
    expect(out.source).toBe('llm-fallback-judge');
    // 首判已是裁判 → 跳过 T3 低置信判定（契约 §10.3「不再二判」）。
    expect(out.fallback?.triggered).toBe(true);
    expect(out.fallback?.trigger).toBe('model-not-configured');
    expect(judge.calls()).toBe(1);
  });

  it('T2 调用失败 → 裁判接管且不掩盖首判错误（成功时以裁判结果为准）', async () => {
    const judge = fakeLlm([JUDGE_OK]);
    const fetch = stubFetch([{ status: 500, body: { error: 'boom' } }]);
    const { deps } = harness({ llm: judge.llm, fetchImpl: fetch.fetchImpl });
    const tool = createDecideTool(deps);
    const out = (await tool.execute(NOUL_ARGS, EXEC)) as {
      ok: boolean;
      source?: string;
      fallback?: { triggered?: boolean; trigger?: string };
    };
    expect(out.ok).toBe(true);
    expect(out.source).toBe('llm-fallback-judge');
    expect(out.fallback?.triggered).toBe(true);
    expect(out.fallback?.trigger).toBe('model-call-failed');
  });

  it('T2 坏 JSON 响应 → 原错误码 model-invalid-response，裁判接管', async () => {
    const judge = fakeLlm([JUDGE_OK]);
    const fetch = stubFetch([{ status: 200, body: 'not-json' }]);
    const { deps } = harness({ llm: judge.llm, fetchImpl: fetch.fetchImpl });
    const tool = createDecideTool(deps);
    const out = (await tool.execute(NOUL_ARGS, EXEC)) as {
      ok: boolean;
      source?: string;
      fallback?: { triggered?: boolean; trigger?: string };
    };
    expect(out.ok).toBe(true);
    expect(out.source).toBe('llm-fallback-judge');
    expect(out.fallback?.triggered).toBe(true);
    expect(out.fallback?.trigger).toBe('model-invalid-response');
    expect(judge.calls()).toBe(1);
  });

  it('T2 裁判也失败 → 保留原错误码 model-call-failed（不掩盖）', async () => {
    const judge = fakeLlm(['裁判通道返回的不是 JSON']);
    const fetch = stubFetch([{ status: 500, body: { error: 'boom' } }]);
    const { deps } = harness({ llm: judge.llm, fetchImpl: fetch.fetchImpl });
    const tool = createDecideTool(deps);
    const out = (await tool.execute(NOUL_ARGS, EXEC)) as {
      ok: boolean;
      error?: { code: string; details?: { judgeError?: { code?: string } } };
    };
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('model-call-failed');
    expect(out.error?.details?.judgeError?.code).toBe('model-invalid-response');
  });

  it('T3 低置信 → 裁判接管，meta 记录首判置信度', async () => {
    const judge = fakeLlm([JUDGE_OK]);
    const fetch = stubFetch([{ body: NOUL_ENV(0.55, 0.5) }]);
    const { deps } = harness({ llm: judge.llm, fetchImpl: fetch.fetchImpl });
    const tool = createDecideTool(deps);
    const out = (await tool.execute(NOUL_ARGS, EXEC)) as {
      ok: boolean;
      source?: string;
      fallback?: {
        triggered?: boolean;
        trigger?: string;
        originalConfidence?: number | null;
        originalSource?: string;
      };
    };
    expect(out.ok).toBe(true);
    expect(out.source).toBe('llm-fallback-judge');
    expect(out.fallback?.triggered).toBe(true);
    expect(out.fallback?.trigger).toBe('low-confidence');
    expect(out.fallback?.originalConfidence).toBe(0.5);
    expect(out.fallback?.originalSource).toBe('decision-model');
  });

  it('T3 置信度达标 → 不触发兜底（维持首判来源）', async () => {
    const judge = fakeLlm([JUDGE_OK]);
    const fetch = stubFetch([{ body: NOUL_ENV(0.95, 0.9) }]);
    const { deps } = harness({ llm: judge.llm, fetchImpl: fetch.fetchImpl });
    const tool = createDecideTool(deps);
    const out = (await tool.execute(NOUL_ARGS, EXEC)) as {
      ok: boolean;
      source?: string;
    };
    expect(out.ok).toBe(true);
    expect(out.source).toBe('decision-model');
    expect(judge.calls()).toBe(0);
  });

  it('T3 裁判失败 → 维持首判结论并标注兜底失败（不产无来源结论）', async () => {
    const judge = fakeLlm(['裁判返回坏数据']);
    const fetch = stubFetch([{ body: NOUL_ENV(0.55, 0.5) }]);
    const { deps } = harness({ llm: judge.llm, fetchImpl: fetch.fetchImpl });
    const tool = createDecideTool(deps);
    const out = (await tool.execute(NOUL_ARGS, EXEC)) as {
      ok: boolean;
      source?: string;
      answers?: Record<string, { value?: unknown }>;
      fallback?: {
        triggered?: boolean;
        trigger?: string;
        error?: { code?: string };
      };
    };
    expect(out.ok).toBe(true);
    expect(out.source).toBe('decision-model');
    expect(out.answers?.q1?.value).toBe(0.55);
    expect(out.fallback?.triggered).toBe(false);
    expect(out.fallback?.trigger).toBe('low-confidence');
    expect(out.fallback?.error?.code).toBe('model-invalid-response');
  });
});

describe('决策工具 兜底记账', () => {
  it('裁判成功 → 账本条目 source=llm-fallback-judge、mode=auto-fallback', async () => {
    const judge = fakeLlm([JUDGE_OK]);
    const ledger = createMemoryLedger(50);
    const { deps } = harness({ llm: judge.llm, ledger, verified: false });
    const tool = createDecideTool(deps);
    await tool.execute(NOUL_ARGS, EXEC);
    const entries = ledger.list();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]?.source).toBe('llm-fallback-judge');
    expect(entries[0]?.mode).toBe('auto-fallback');
  });

  it('裁判失败 → 账本留一条 error 条目（兜底失败可追溯）', async () => {
    const judge = fakeLlm(['坏数据']);
    const ledger = createMemoryLedger(50);
    const fetch = stubFetch([{ status: 500, body: { error: 'boom' } }]);
    const { deps } = harness({
      llm: judge.llm,
      ledger,
      fetchImpl: fetch.fetchImpl,
    });
    const tool = createDecideTool(deps);
    await tool.execute(NOUL_ARGS, EXEC);
    const judgeEntries = ledger
      .list()
      .filter((entry) => entry.source === 'llm-fallback-judge');
    expect(judgeEntries.length).toBeGreaterThan(0);
    expect(judgeEntries[0]?.status).toBe('error');
  });
});
