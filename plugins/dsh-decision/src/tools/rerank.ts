/**
 * decision_rerank 工具（决策工具系列 4/11）。
 *
 * 契约来源：docs/decision-tools-contract.md §3.3（rerank）、§2（systemone 形状）、
 * §1.1（返回信封）、§11（Tool 设计纪律 D1–D6）。
 *
 * 硬纪律：综合分由本包纯函数计算（score = fitWeight×fit − riskWeight×risk），
 * 绝不交给模型自由发挥；非法 fit/risk 进 invalid 并从排序剔除，不夹取不猜；
 * 一切失败走 { ok:false, error }（fail-closed）。
 *
 * 题量边界：每候选两道 choice 题（fit 与 risk）。systemone 单请求上限 16 题，
 * 故拆成两批调用（fit 批 / risk 批），每批 ≤8 题（RERANK_BATCH_SIZE=8），
 * 均经统一调用层记账。
 */

import {
  defineTool,
  type InferValue,
  type ToolDefinition,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools';

import {
  decisionError,
  type DecisionErrorEnvelope,
} from '../systemone/errors.ts';
import type {
  JsonValue,
  SystemOneParsedAnswer,
  SystemOneQuestion,
} from '../systemone/types.ts';
import { runDecisionCall, type DecisionCallDeps } from '../runtime/call.ts';
import { newDecisionId } from '../runtime/id.ts';
import type { ResolvedToolsConfig } from '../config/decision-tools.ts';
import { buildJudgementPrompt, type JudgementPromptParts } from './prompt.ts';

// ── 常量与 schema ───────────────────────────────────────────────────

export const RERANK_TOOL = 'decision_rerank';

export const RERANK_CANDIDATES_MIN = 2;
export const RERANK_CANDIDATES_MAX = 10;
export const RERANK_VALUE_MIN = 0;
export const RERANK_VALUE_MAX = 3;
export const RERANK_WEIGHT_MAX = 10;

export const DEFAULT_FIT_WEIGHT = 2;
export const DEFAULT_RISK_WEIGHT = 1;

/** 单请求最多 16 题；每候选两题拆成两批（fit/risk），每批 ≤8 候选。 */
export const RERANK_BATCH_SIZE = 8;

export const RERANK_DESCRIPTION = [
  'Rank 2..10 candidate options by fit and risk, return a recomputable composite score and a single recommended id (never prose).',
  'Never let the model invent a score: composite score is computed here, and out-of-range fit/risk are excluded from ranking, never clamped.',
  'Actions: 1) validate candidate count and optional fit/risk priors; 2) ask the model for integer fit (0..3) and risk (0..3) per candidate; 3) compute scores and rank deterministically.',
  'Constraints: 2..10 candidates; fit and risk are integers in 0..3; default score = 2*fit - risk; ties break by higher fit then input order.',
  'Output is bounded: per candidate id/fit/risk/score/rationale plus the recommended id and an invalid list. Failure returns { ok:false, error } and never guesses.',
].join(' ');

export const RERANK_PARAMETERS = {
  candidates: {
    type: 'array' as const,
    required: true as const,
    description:
      'Candidate options to rank, 2..10 items. Each: { id, title, description, fit?, risk? } with optional integer fit/risk priors in 0..3.',
    items: {
      type: 'object' as const,
      additionalProperties: true as const,
      properties: {
        id: { type: 'string' as const, required: true as const },
        title: { type: 'string' as const, required: true as const },
        description: { type: 'string' as const },
        fit: { type: 'integer' as const },
        risk: { type: 'integer' as const },
      },
    },
  },
  goal: {
    type: 'string' as const,
    description: 'Optional selection goal that scoring is relative to.',
  },
  weights: {
    type: 'object' as const,
    additionalProperties: true as const,
    properties: {
      fit: { type: 'integer' as const },
      risk: { type: 'integer' as const },
    },
    description:
      'Optional composite weights { fit, risk }, integers 0..10. Defaults: fit=2, risk=1.',
  },
};

const RERANK_OUTPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: true as const,
  properties: {
    ok: { type: 'boolean' as const, required: true as const },
    ranked: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: true as const,
        properties: {
          id: { type: 'string' as const, required: true as const },
          fit: { type: 'integer' as const, required: true as const },
          risk: { type: 'integer' as const, required: true as const },
          score: { type: 'integer' as const, required: true as const },
          rationale: { type: 'string' as const, required: true as const },
        },
      },
    },
    recommendation: {
      oneOf: [{ type: 'string' as const }, { type: 'null' as const }] as const,
    },
    invalid: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: true as const,
        properties: {
          id: { type: 'string' as const, required: true as const },
          reason: { type: 'string' as const, required: true as const },
        },
      },
    },
    decisionId: { type: 'string' as const },
    source: {
      type: 'string' as const,
      enum: ['decision-model', 'llm-fallback-judge'],
    },
    error: {
      type: 'object' as const,
      additionalProperties: true as const,
      properties: {
        code: { type: 'string' as const, required: true as const },
        message: { type: 'string' as const, required: true as const },
        retryable: { type: 'boolean' as const, required: true as const },
        details: {
          type: 'object' as const,
          additionalProperties: true as const,
          properties: {},
        },
      },
    },
  },
};

export const RERANK_OUTPUT = {
  schema: RERANK_OUTPUT_SCHEMA,
  render: (_args: unknown, value: unknown) => [
    { type: 'text' as const, text: JSON.stringify(value) },
  ],
};

export type RerankOutput = InferValue<typeof RERANK_OUTPUT_SCHEMA>;

// ── 入参校验（纯函数，可单测） ───────────────────────────────────────

export interface RerankCandidate {
  id: string;
  title: string;
  description: string | null;
  fitPrior: number | null;
  riskPrior: number | null;
}

export interface RerankPlan {
  candidates: RerankCandidate[];
  goal: string | null;
  fitWeight: number;
  riskWeight: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRangeInt(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/** 校验 rerank 入参；任何不合规返回 invalid-arguments，不抛错。 */
export function planRerank(
  args: unknown,
):
  { ok: true; plan: RerankPlan } | { ok: false; error: DecisionErrorEnvelope } {
  if (!isPlainObject(args)) {
    return {
      ok: false,
      error: decisionError('invalid-arguments', 'rerank 入参必须是对象'),
    };
  }
  const rawCandidates = args.candidates;
  if (
    !Array.isArray(rawCandidates) ||
    rawCandidates.length < RERANK_CANDIDATES_MIN ||
    rawCandidates.length > RERANK_CANDIDATES_MAX
  ) {
    return {
      ok: false,
      error: decisionError(
        'invalid-arguments',
        `candidates 必须包含 ${RERANK_CANDIDATES_MIN}–${RERANK_CANDIDATES_MAX} 个候选（当前 ${
          Array.isArray(rawCandidates) ? rawCandidates.length : '非数组'
        }）`,
      ),
    };
  }
  const candidates: RerankCandidate[] = [];
  const seenIds = new Set<string>();
  for (const raw of rawCandidates) {
    if (!isPlainObject(raw)) {
      return {
        ok: false,
        error: decisionError('invalid-arguments', '每个候选必须是对象'),
      };
    }
    const { id, title, description, fit, risk } = raw;
    if (typeof id !== 'string' || id.trim() === '' || seenIds.has(id)) {
      return {
        ok: false,
        error: decisionError(
          'invalid-arguments',
          '候选 id 必须是非空且互不相同的字符串',
        ),
      };
    }
    seenIds.add(id);
    if (typeof title !== 'string' || title.trim() === '') {
      return {
        ok: false,
        error: decisionError('invalid-arguments', `候选 ${id} 缺少 title`),
      };
    }
    for (const [key, value] of [
      ['fit', fit],
      ['risk', risk],
    ] as const) {
      // null 与 weights 同口径：显式传 null 一律非法（0..3 整数或省略）。
      if (
        value !== undefined &&
        !isRangeInt(value, RERANK_VALUE_MIN, RERANK_VALUE_MAX)
      ) {
        return {
          ok: false,
          error: decisionError(
            'invalid-arguments',
            `候选 ${id} 的 ${key} 先验必须是 0..3 整数`,
          ),
        };
      }
    }
    candidates.push({
      id,
      title,
      description: typeof description === 'string' ? description : null,
      fitPrior: typeof fit === 'number' ? fit : null,
      riskPrior: typeof risk === 'number' ? risk : null,
    });
  }

  const goal = typeof args.goal === 'string' ? args.goal : null;
  let fitWeight = DEFAULT_FIT_WEIGHT;
  let riskWeight = DEFAULT_RISK_WEIGHT;
  if (args.weights !== undefined && args.weights !== null) {
    if (!isPlainObject(args.weights)) {
      return {
        ok: false,
        error: decisionError('invalid-arguments', 'weights 必须是对象'),
      };
    }
    if (args.weights.fit !== undefined) {
      if (!isRangeInt(args.weights.fit, 0, RERANK_WEIGHT_MAX)) {
        return {
          ok: false,
          error: decisionError(
            'invalid-arguments',
            `weights.fit 必须是 0..${RERANK_WEIGHT_MAX} 整数`,
          ),
        };
      }
      fitWeight = args.weights.fit;
    }
    if (args.weights.risk !== undefined) {
      if (!isRangeInt(args.weights.risk, 0, RERANK_WEIGHT_MAX)) {
        return {
          ok: false,
          error: decisionError(
            'invalid-arguments',
            `weights.risk 必须是 0..${RERANK_WEIGHT_MAX} 整数`,
          ),
        };
      }
      riskWeight = args.weights.risk;
    }
  }

  return {
    ok: true,
    plan: { candidates, goal, fitWeight, riskWeight },
  };
}

// ── 综合分（纯函数，契约 §3.3） ──────────────────────────────────────

export interface RankedCandidate {
  id: string;
  fit: number;
  risk: number;
  score: number;
  rationale: string;
  /** 输入顺序（并列打破用；不写入出参）。 */
  order: number;
}

export function compositeScore(
  fit: number,
  risk: number,
  fitWeight: number,
  riskWeight: number,
): number {
  return fitWeight * fit - riskWeight * risk;
}

/** 按 score 降序 → fit 大者 → 输入顺序靠前（契约 §3.3）。 */
export function rankCandidates(
  rows: Array<{ id: string; fit: number; risk: number; order: number }>,
  fitWeight: number,
  riskWeight: number,
): RankedCandidate[] {
  const ranked = rows.map((row) => {
    const score = compositeScore(row.fit, row.risk, fitWeight, riskWeight);
    return {
      id: row.id,
      fit: row.fit,
      risk: row.risk,
      score,
      rationale: `fit=${row.fit}, risk=${row.risk}, score=${fitWeight}×${row.fit}-${riskWeight}×${row.risk}=${score}`,
      order: row.order,
    };
  });
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.fit !== a.fit) return b.fit - a.fit;
    return a.order - b.order;
  });
  return ranked;
}

// ── state 组装与题目 ────────────────────────────────────────────────

function candidateLine(candidate: RerankCandidate): string {
  const prior =
    candidate.fitPrior === null && candidate.riskPrior === null
      ? ''
      : ` (priors: fit=${candidate.fitPrior ?? '?'}, risk=${candidate.riskPrior ?? '?'})`;
  return `- ${candidate.id}: ${candidate.title}${prior}${
    candidate.description === null ? '' : ` — ${candidate.description}`
  }`;
}

function buildRerankState(plan: RerankPlan, kind: 'fit' | 'risk'): JsonValue {
  const parts: JudgementPromptParts = {
    purpose: `Assign an integer ${kind} in 0..3 to each candidate below.`,
    constraints: [
      'Answer every listed candidate id exactly once; never add or drop an id.',
      'Return only an integer from 0 to 3 for each candidate; never explain or invent a value outside 0..3.',
    ],
    actions: plan.candidates.map(
      (c) => `${c.id}: pick an integer ${kind} level`,
    ),
    detail: [
      ...(plan.goal === null ? [] : [`GOAL: ${plan.goal}`]),
      'CANDIDATES:',
      ...plan.candidates.map(candidateLine),
    ].join('\n'),
  };
  return { message: buildJudgementPrompt(parts) } as JsonValue;
}

/** 每候选一道 choice 题（0..3 档），稳定 qid = `fit.<id>` / `risk.<id>`。 */
function buildRerankQuestions(
  plan: RerankPlan,
  kind: 'fit' | 'risk',
): Record<string, SystemOneQuestion> {
  const criteria =
    kind === 'fit'
      ? {
          '0': 'no fit',
          '1': 'slight fit',
          '2': 'good fit',
          '3': 'excellent fit',
        }
      : {
          '0': 'no risk',
          '1': 'low risk',
          '2': 'medium risk',
          '3': 'high risk',
        };
  const out: Record<string, SystemOneQuestion> = {};
  for (const candidate of plan.candidates) {
    out[`${kind}.${candidate.id}`] = {
      type: 'choice',
      instructions:
        kind === 'fit'
          ? `Rate how well candidate ${candidate.id} fits the goal on a 0..3 scale.`
          : `Rate the risk of candidate ${candidate.id} on a 0..3 scale.`,
      criteria,
    };
  }
  return out;
}

function questionId(kind: 'fit' | 'risk', id: string): string {
  return `${kind}.${id}`;
}

/** 无副作用地取整批值（非法者由调用方进 invalid）。 */
function valueFromChoice(
  answer: SystemOneParsedAnswer | undefined,
): number | null {
  if (!answer || answer.kind !== 'choice') return null;
  const parsed = Number(answer.choice);
  return isRangeInt(parsed, RERANK_VALUE_MIN, RERANK_VALUE_MAX) ? parsed : null;
}

function errorBody(error: DecisionErrorEnvelope): Record<string, JsonValue> {
  return { ok: false, error: error as unknown as JsonValue };
}

function unexpectedErrorBody(thrown: unknown): Record<string, JsonValue> {
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return errorBody(
    decisionError('model-call-failed', `工具内部异常：${message}`, {
      details: { stage: 'unexpected' },
    }),
  );
}

function readConfigOrError(
  deps: DecisionCallDeps,
):
  | { ok: true; config: ResolvedToolsConfig }
  | { ok: false; error: DecisionErrorEnvelope } {
  try {
    return { ok: true, config: deps.readConfig() };
  } catch {
    return {
      ok: false,
      error: decisionError('model-call-failed', '读取决策配置失败', {
        details: { stage: 'read-config' },
      }),
    };
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

// ── 主流程 ──────────────────────────────────────────────────────────

export async function runRerank(
  args: unknown,
  exec: { signal?: AbortSignal },
  deps: DecisionCallDeps,
): Promise<Record<string, JsonValue>> {
  const planned = planRerank(args);
  if (!planned.ok) return errorBody(planned.error);
  const { plan } = planned;

  const configResult = readConfigOrError(deps);
  if (!configResult.ok) return errorBody(configResult.error);

  const fitValues = new Map<string, number>();
  const riskValues = new Map<string, number>();
  const invalid: Array<{ id: string; reason: string }> = [];
  let source: 'decision-model' | 'llm-fallback-judge' = 'decision-model';
  let firstDecisionId: string | null = null;

  for (const kind of ['fit', 'risk'] as const) {
    for (const part of chunk(plan.candidates, RERANK_BATCH_SIZE)) {
      const subPlan: RerankPlan = { ...plan, candidates: part };
      const result = await runDecisionCall(deps, {
        tool: RERANK_TOOL,
        state: buildRerankState(subPlan, kind),
        questions: buildRerankQuestions(subPlan, kind),
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      });
      if (!result.ok) return errorBody(result.error);
      source = result.source;
      for (const candidate of part) {
        const qid = questionId(kind, candidate.id);
        const value = valueFromChoice(result.answers[qid]);
        const out = kind === 'fit' ? fitValues : riskValues;
        if (value === null) {
          invalid.push({
            id: candidate.id,
            reason:
              result.answers[qid] === undefined
                ? `${kind} 题被上游丢弃`
                : `${kind} 非 0..3 整数`,
          });
        } else {
          out.set(candidate.id, value);
        }
        if (firstDecisionId === null)
          firstDecisionId = result.decisionIds[qid] ?? null;
      }
    }
  }

  const rows: Array<{
    id: string;
    fit: number;
    risk: number;
    order: number;
  }> = [];
  for (let order = 0; order < plan.candidates.length; order += 1) {
    const candidate = plan.candidates[order];
    const fit = fitValues.get(candidate.id);
    const risk = riskValues.get(candidate.id);
    if (fit === undefined || risk === undefined) continue;
    rows.push({ id: candidate.id, fit, risk, order });
  }
  const ranked = rankCandidates(rows, plan.fitWeight, plan.riskWeight);
  const recommendation = ranked.length === 0 ? null : ranked[0].id;

  return {
    ok: true,
    ranked: ranked.map(({ id, fit, risk, score, rationale }) => ({
      id,
      fit,
      risk,
      score,
      rationale,
    })) as unknown as JsonValue,
    recommendation: recommendation as JsonValue,
    invalid: invalid as unknown as JsonValue,
    decisionId: (firstDecisionId ?? newDecisionId()) as JsonValue,
    source,
  };
}

/** 创建 decision_rerank 工具定义（deps 由插件入口注入）。 */
export function createRerankTool(deps: DecisionCallDeps): ToolDefinition {
  return defineTool({
    name: RERANK_TOOL,
    description: RERANK_DESCRIPTION,
    parameters: RERANK_PARAMETERS,
    output: RERANK_OUTPUT,
    async execute(args: unknown, exec: ToolRunContext): Promise<RerankOutput> {
      try {
        return (await runRerank(
          args,
          { signal: exec.signal },
          deps,
        )) as unknown as RerankOutput;
      } catch (thrown) {
        return unexpectedErrorBody(thrown) as unknown as RerankOutput;
      }
    },
  }) as ToolDefinition;
}
