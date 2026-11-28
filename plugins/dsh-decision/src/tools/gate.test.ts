import { describe, expect, it } from 'vitest';

import {
  GATE_DESCRIPTION,
  GATE_OUTPUT,
  GATE_QUESTION_IDS,
  GATE_TOOL,
  buildGateQuestions,
  buildGateState,
  createGateTool,
  decideVerdict,
  planGate,
  type GatePlan,
} from './gate.ts';
import {
  type ResolvedToolsConfig,
  resolveToolsConfig,
} from '../config/decision-tools.ts';
import { createPassthroughBudgetGate } from '../runtime/budget.ts';
import type { DecisionCallDeps } from '../runtime/call.ts';
import { createAutoFallbackHook } from '../runtime/fallback.ts';
import { fingerprintOf } from '../runtime/guard.ts';
import { type LedgerSink, createMemoryLedger } from '../runtime/ledger.ts';
import type { DecisionLlmLike } from '../core/decision.ts';
import type { FetchLike } from '../systemone/client.ts';

const EXEC = { signal: new AbortController().signal } as never;

function baseConfig(
  overrides: Record<string, unknown> = {},
): ResolvedToolsConfig {
  return resolveToolsConfig({
    systemoneBaseUrl: 'http://127.0.0.1:3425',
    systemoneApiKey: 'key-test',
    systemoneModel: 'model-test',
    toolsGateEnabled: true,
    ledgerEnabled: true,
    ...overrides,
  });
}

function stubFetch(payloads: Array<{ status?: number; body: unknown }>): {
  fetchImpl: FetchLike;
  calls: () => number;
} {
  let index = 0;
  const fetchImpl: FetchLike = async () => {
    const spec = payloads[Math.min(index, payloads.length - 1)];
    index += 1;
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
  return { fetchImpl, calls: () => index };
}

function gateEnv(allow: number, human: number, revise: number): unknown {
  return {
    answers: {
      [GATE_QUESTION_IDS.allow]: { type: 'noul', noul: allow, confidence: 0.9 },
      [GATE_QUESTION_IDS.human]: { type: 'noul', noul: human, confidence: 0.9 },
      [GATE_QUESTION_IDS.revise]: {
        type: 'noul',
        noul: revise,
        confidence: 0.9,
      },
    },
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function harness(
  fetchImpl: FetchLike,
  options: {
    config?: ResolvedToolsConfig;
    ledger?: LedgerSink;
    verified?: boolean;
  } = {},
): { deps: DecisionCallDeps; ledger: LedgerSink } {
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
    budget: createPassthroughBudgetGate(),
    fetchImpl,
  };
  return { deps, ledger };
}

function planOf(args: unknown): GatePlan {
  const result = planGate(args);
  if (!result.ok) throw new Error(`expected valid plan: ${result.error.code}`);
  return result.plan;
}

const GATE_ARGS = { action: 'rm -rf /data/cache', context: 'staging host' };

describe('决策工具 gate 入参校验（planGate）', () => {
  it('合法入参：riskLevel 缺省 medium、policyId 缺省 null', () => {
    const plan = planOf(GATE_ARGS);
    expect(plan.action).toBe('rm -rf /data/cache');
    expect(plan.riskLevel).toBe('medium');
    expect(plan.policyId).toBeNull();
    expect(plan.context).toBe('staging host');
  });

  it('action 缺失/空/超 500 字符、riskLevel 非法都返回 invalid-arguments', () => {
    const bad = (args: unknown) => {
      const r = planGate(args);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid-arguments');
    };
    bad({});
    bad({ action: '   ' });
    bad({ action: 'x'.repeat(501) });
    bad({ action: 'ok', riskLevel: 'extreme' });
  });
});

describe('决策工具 gate 题目与提示词', () => {
  it('固定三道 noul 题（allow/human/revise）且都带 criteria', () => {
    const questions = buildGateQuestions(planOf(GATE_ARGS));
    expect(Object.keys(questions).sort()).toEqual([
      GATE_QUESTION_IDS.allow,
      GATE_QUESTION_IDS.human,
      GATE_QUESTION_IDS.revise,
    ]);
    for (const q of Object.values(questions)) {
      expect(q.type).toBe('noul');
      expect(q.criteria).toBeDefined();
    }
  });

  it('buildGateState 的 DETAIL 含 ACTION 与 RISK LEVEL，但绝不把 policyId 送进 state', () => {
    const payload = buildGateState(
      planOf({
        ...GATE_ARGS,
        riskLevel: 'high',
        policyId: 'policy-7',
      }),
    ) as {
      message: string;
    };
    expect(payload.message).toContain('ACTION: rm -rf /data/cache');
    expect(payload.message).toContain('RISK LEVEL: high');
    expect(payload.message).toContain('CONTEXT: staging host');
    // 契约 §3.2：policyId 仅记录进账本，不进 state、不影响判定。
    expect(payload.message).not.toContain('POLICY:');
    expect(payload.message).not.toContain('policy-7');
  });

  it('GATE_DESCRIPTION 明确「拿不准升级、绝不 fail-open」', () => {
    expect(GATE_DESCRIPTION).toContain('Never fail open');
    expect(GATE_DESCRIPTION).toContain('escalate instead of allow');
  });

  it('GATE_OUTPUT.schema 的 verdict 是四值枚举（schema 侧锚定）', () => {
    const schema = GATE_OUTPUT.schema as unknown as {
      properties: { verdict: { enum?: string[] }; reasons: { type?: string } };
    };
    expect(schema.properties.verdict.enum).toEqual([
      'allow',
      'revise',
      'block',
      'escalate',
    ]);
    expect(schema.properties.reasons.type).toBe('array');
  });
});

describe('决策工具 gate verdict 映射（decideVerdict，四值各一例）', () => {
  const threshold = 0.8;

  it('allow：放行达标且无需人工/修改', () => {
    const d = decideVerdict({ allow: 0.9, human: 0.1, revise: 0.1 }, threshold);
    expect(d.verdict).toBe('allow');
    expect(d.confidence).toBe(0.9);
  });

  it('block：放行概率低于 20% 硬下限', () => {
    const d = decideVerdict({ allow: 0.1, human: 0.1, revise: 0.1 }, threshold);
    expect(d.verdict).toBe('block');
    expect(d.confidence).toBe(0.9);
  });

  it('escalate：人工介入概率达 50%', () => {
    const d = decideVerdict({ allow: 0.9, human: 0.6, revise: 0.1 }, threshold);
    expect(d.verdict).toBe('escalate');
    expect(d.confidence).toBe(0.6);
  });

  it('escalate：放行概率落在灰区（低于阈值但不至于阻断）', () => {
    const d = decideVerdict({ allow: 0.5, human: 0.1, revise: 0.1 }, threshold);
    expect(d.verdict).toBe('escalate');
    expect(d.confidence).toBe(0.5);
  });

  it('escalate 的 confidence = max(P(human), 1−P(allow))（灰区且 1−allow > human）', () => {
    const d = decideVerdict({ allow: 0.3, human: 0.2, revise: 0.1 }, threshold);
    expect(d.verdict).toBe('escalate');
    expect(d.confidence).toBeCloseTo(0.7, 5);
    // 人工分支同样取两者最大值
    const d2 = decideVerdict(
      { allow: 0.3, human: 0.9, revise: 0.1 },
      threshold,
    );
    expect(d2.verdict).toBe('escalate');
    expect(d2.confidence).toBeCloseTo(0.9, 5);
  });

  it('revise：达标但必改概率达 50%', () => {
    const d = decideVerdict({ allow: 0.9, human: 0.1, revise: 0.6 }, threshold);
    expect(d.verdict).toBe('revise');
    expect(d.confidence).toBe(0.6);
  });

  it('reasons ≤5 条、每条 ≤120 字符，rationale ≤200 字符', () => {
    for (const probs of [
      { allow: 0.9, human: 0.1, revise: 0.1 },
      { allow: 0.1, human: 0.9, revise: 0.9 },
      { allow: 0.5, human: 0.5, revise: 0.5 },
    ]) {
      const d = decideVerdict(probs, threshold);
      expect(d.reasons.length).toBeGreaterThan(0);
      expect(d.reasons.length).toBeLessThanOrEqual(5);
      for (const reason of d.reasons)
        expect(reason.length).toBeLessThanOrEqual(120);
      expect(d.rationale.length).toBeLessThanOrEqual(200);
    }
  });
});

describe('决策工具 gate 全链路（经统一调用层）', () => {
  it('allow 路径：verdict allow、decisionId 合法、三题各落一条账', async () => {
    const fetch = stubFetch([{ body: gateEnv(0.9, 0.1, 0.1) }]);
    const { deps, ledger } = harness(fetch.fetchImpl);
    const tool = createGateTool(deps);

    const out = (await tool.execute(GATE_ARGS, EXEC)) as {
      ok: boolean;
      verdict: string;
      confidence: number | null;
      decisionId: string;
      reasons: string[];
      source: string;
    };
    expect(out.ok).toBe(true);
    expect(out.verdict).toBe('allow');
    expect(out.confidence).toBe(0.9);
    expect(out.decisionId).toMatch(/^dec_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(out.reasons.length).toBeGreaterThan(0);
    expect(out.source).toBe('decision-model');
    expect(ledger.size()).toBe(3);
    expect(ledger.list().every((e) => e.tool === 'decision_gate')).toBe(true);
    // 三题一次调用：用量合计 calls=1，不被 3 题放大（§3.1 usage 归属）。
    const totalCalls = ledger
      .list()
      .reduce((sum, entry) => sum + entry.usage.calls, 0);
    expect(totalCalls).toBe(1);
  });

  it('模型漏答任一题 → verdict escalate、confidence null（绝不 fail-open）', async () => {
    const fetch = stubFetch([
      {
        body: {
          answers: {
            [GATE_QUESTION_IDS.allow]: {
              type: 'noul',
              noul: 0.95,
              confidence: 0.9,
            },
            // 故意缺 gate.human / gate.revise
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ]);
    const { deps } = harness(fetch.fetchImpl);
    const tool = createGateTool(deps);

    const out = (await tool.execute(GATE_ARGS, EXEC)) as {
      ok: boolean;
      verdict: string;
      confidence: number | null;
    };
    expect(out.ok).toBe(true);
    expect(out.verdict).toBe('escalate');
    expect(out.confidence).toBeNull();
  });

  it('gate.allow 题本身被丢弃 → verdict escalate，账本该题记为 error', async () => {
    const fetch = stubFetch([
      {
        body: {
          answers: {
            [GATE_QUESTION_IDS.human]: {
              type: 'noul',
              noul: 0.2,
              confidence: 0.9,
            },
            [GATE_QUESTION_IDS.revise]: {
              type: 'noul',
              noul: 0.1,
              confidence: 0.9,
            },
            // 故意缺 gate.allow
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ]);
    const { deps, ledger } = harness(fetch.fetchImpl);
    const tool = createGateTool(deps);

    const out = (await tool.execute(GATE_ARGS, EXEC)) as {
      verdict: string;
      decisionId: string | null;
    };
    expect(out.verdict).toBe('escalate');
    // decisionId 由调用层按请求题为每道题预先分配，因此仍存在；关键是该题账本记为 error。
    const allowEntry = ledger
      .list()
      .find((e) => e.questionId === GATE_QUESTION_IDS.allow);
    expect(allowEntry?.status).toBe('error');
    expect(allowEntry?.payload.errorCode).toBe('model-invalid-response');
  });

  it('riskLevel / policyId 只记录进账本 payload（契约 §3.2，不参与判定）', async () => {
    const fetch = stubFetch([{ body: gateEnv(0.9, 0.1, 0.1) }]);
    const { deps, ledger } = harness(fetch.fetchImpl);
    const tool = createGateTool(deps);

    const out = (await tool.execute(
      {
        action: 'DELETE /api/users/42',
        context: { blastRadius: 'one user' },
        riskLevel: 'high',
        policyId: 'policy-7',
      },
      EXEC,
    )) as { verdict: string };
    expect(out.verdict).toBe('allow');
    const entries = ledger.list();
    expect(entries.length).toBe(3);
    for (const entry of entries) {
      expect(entry.payload.riskLevel).toBe('high');
      expect(entry.payload.policyId).toBe('policy-7');
    }
    // 三题一次调用：用量与延迟都只记一次（§5.1 / B-2）
    expect(entries.reduce((s, e) => s + e.usage.calls, 0)).toBe(1);
    expect(entries.filter((e) => e.latencyMs > 0)).toHaveLength(1);
  });

  it('调用失败 → model-call-failed 错误信封', async () => {
    const fetch = stubFetch([{ status: 500, body: { error: 'boom' } }]);
    const { deps } = harness(fetch.fetchImpl);
    const tool = createGateTool(deps);

    const out = (await tool.execute(GATE_ARGS, EXEC)) as {
      ok: boolean;
      error: { code: string };
    };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('model-call-failed');
  });

  it('开关关闭 → tool-disabled 且不出网', async () => {
    const fetch = stubFetch([{ body: gateEnv(0.9, 0.1, 0.1) }]);
    const { deps } = harness(fetch.fetchImpl, {
      config: baseConfig({ toolsGateEnabled: false }),
    });
    const tool = createGateTool(deps);

    const out = (await tool.execute(GATE_ARGS, EXEC)) as {
      ok: boolean;
      error: { code: string };
    };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('tool-disabled');
    expect(fetch.calls()).toBe(0);
  });

  it('未验证 → model-verify-failed 且不出网', async () => {
    const fetch = stubFetch([{ body: gateEnv(0.9, 0.1, 0.1) }]);
    const { deps } = harness(fetch.fetchImpl, { verified: false });
    const tool = createGateTool(deps);

    const out = (await tool.execute(GATE_ARGS, EXEC)) as {
      ok: boolean;
      error: { code: string };
    };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('model-verify-failed');
    expect(fetch.calls()).toBe(0);
  });

  it('工具名与开关映射一致（decision_gate）', () => {
    const tool = createGateTool(
      harness(stubFetch([{ body: gateEnv(1, 0, 0) }]).fetchImpl).deps,
    );
    expect(tool.name).toBe(GATE_TOOL);
    expect(GATE_TOOL).toBe('decision_gate');
  });
});

/**
 * gate 侧兜底链路（7/11 V2 必修 3：gate 工具层兜底此前零测试）。
 *
 * 覆盖三条分支：缺题 → 裁判接管改判；缺题 + 裁判失败 → escalate + 兜底失败标注；
 * 缺题 + 兜底未触发（skipped）→ 出参整体省略 fallback 块。
 */

/** 假宿主大模型通道（裁判用）：按顺序吐文本分片。 */
function fakeJudgeLlm(texts: string[]): {
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

const JUDGE_GATE_OK = JSON.stringify({
  answers: {
    [GATE_QUESTION_IDS.allow]: { value: 0.92, confidence: 0.9 },
    [GATE_QUESTION_IDS.human]: { value: 0.05, confidence: 0.9 },
    [GATE_QUESTION_IDS.revise]: { value: 0.05, confidence: 0.9 },
  },
});

/** 只有 gate.allow 一题的残缺响应 → 触发 model-invalid-response 兜底路径。 */
const GATE_PARTIAL = {
  answers: {
    [GATE_QUESTION_IDS.allow]: { type: 'noul', noul: 0.9, confidence: 0.9 },
  },
  usage: { input_tokens: 10, output_tokens: 5 },
};

function gateFallbackHarness(options: {
  config?: ResolvedToolsConfig;
  llm?: DecisionLlmLike;
  fetchImpl: FetchLike;
}): { deps: DecisionCallDeps; ledger: LedgerSink } {
  const config =
    options.config ??
    baseConfig({
      fallbackEnabled: true,
      fallbackMode: 'auto-fallback',
      fallbackProvider: 'judge-provider',
      fallbackModel: 'judge-model',
    });
  const ledger = createMemoryLedger(100);
  const deps: DecisionCallDeps = {
    readConfig: () => config,
    getVerifySnapshot: () => ({
      fingerprint: fingerprintOf(config),
      verifiedAt: new Date().toISOString(),
    }),
    ledger,
    budget: createPassthroughBudgetGate(),
    fallback: createAutoFallbackHook({
      readConfig: () => config,
      ...(options.llm ? { llm: options.llm } : {}),
      ledger,
    }),
    fetchImpl: options.fetchImpl,
  };
  return { deps, ledger };
}

describe('决策工具 gate 兜底链路（7/11）', () => {
  it('内部题缺答 → 裁判接管改判，source=llm-fallback-judge 且 meta 标注触发原因', async () => {
    const judge = fakeJudgeLlm([JUDGE_GATE_OK]);
    const fetch = stubFetch([{ body: GATE_PARTIAL }]);
    const { deps } = gateFallbackHarness({
      llm: judge.llm,
      fetchImpl: fetch.fetchImpl,
    });
    const tool = createGateTool(deps);

    const out = (await tool.execute(GATE_ARGS, EXEC)) as {
      ok: boolean;
      verdict: string;
      source?: string;
      fallback?: { triggered?: boolean; trigger?: string; route?: unknown };
    };
    expect(out.ok).toBe(true);
    expect(out.source).toBe('llm-fallback-judge');
    expect(out.verdict).toBe('allow');
    expect(out.fallback?.triggered).toBe(true);
    expect(out.fallback?.trigger).toBe('model-invalid-response');
    expect(out.fallback?.route).toMatchObject({
      provider: 'judge-provider',
      model: 'judge-model',
      origin: 'explicit-config',
    });
    expect(judge.calls()).toBe(1);
  });

  it('内部题缺答且裁判解析失败 → 维持 escalate 并标注兜底失败（原错误码不被掩盖）', async () => {
    const judge = fakeJudgeLlm(['not-json-at-all']);
    const fetch = stubFetch([{ body: GATE_PARTIAL }]);
    const { deps } = gateFallbackHarness({
      llm: judge.llm,
      fetchImpl: fetch.fetchImpl,
    });
    const tool = createGateTool(deps);

    const out = (await tool.execute(GATE_ARGS, EXEC)) as {
      ok: boolean;
      verdict: string;
      source?: string;
      fallback?: {
        triggered?: boolean;
        trigger?: string;
        error?: { code?: string };
      };
    };
    expect(out.ok).toBe(true);
    expect(out.verdict).toBe('escalate');
    expect(out.source).toBe('decision-model');
    expect(out.fallback?.triggered).toBe(false);
    expect(out.fallback?.trigger).toBe('model-invalid-response');
    expect(out.fallback?.error?.code).toBe('model-invalid-response');
  });

  it('兜底未触发（开关关闭）→ 出参整体省略 fallback 块（契约 §10.3）', async () => {
    const judge = fakeJudgeLlm([JUDGE_GATE_OK]);
    const fetch = stubFetch([{ body: GATE_PARTIAL }]);
    const { deps } = gateFallbackHarness({
      config: baseConfig({ fallbackEnabled: false }),
      llm: judge.llm,
      fetchImpl: fetch.fetchImpl,
    });
    const tool = createGateTool(deps);

    const out = (await tool.execute(GATE_ARGS, EXEC)) as {
      ok: boolean;
      verdict: string;
      source?: string;
      fallback?: unknown;
    };
    expect(out.ok).toBe(true);
    expect(out.verdict).toBe('escalate');
    expect(out.source).toBe('decision-model');
    expect(out.fallback).toBeUndefined();
    expect(judge.calls()).toBe(0);
  });
});
