/**
 * decision_decide 工具（决策工具系列 3/11）。
 *
 * 契约来源：docs/decision-tools-contract.md §3.1（decide）、§2（systemone 请求
 * 与响应形状）、§1.1（返回信封）、§11（Tool 设计纪律 D1–D6）。
 *
 * 硬纪律（写在动作前，见 description）：
 * - 只回结构化判定（id / 取值 / 置信度 / 概率分布），不回灌 state 原文与模型散文；
 * - 一切失败走 `{ ok:false, error }`（fail-closed），绝不把原始文本当判定；
 * - 所有模型调用经统一调用层（记账 / 预算闸 / 兜底挂点），本文件不碰 HTTP。
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
  SystemOneNormalizedUsage,
  SystemOneParsedAnswer,
  SystemOneQuestion,
} from '../systemone/types.ts';
import {
  runDecisionCall,
  runFallbackJudge,
  runLowConfidenceFallback,
  type DecisionCallDeps,
  type DecisionCallOk,
  type DecisionCallRequest,
  type DecisionCallResult,
  type FallbackMeta,
} from '../runtime/call.ts';
import { newDecisionId } from '../runtime/id.ts';
import {
  estimateCostUsd,
  truncateSummary,
  type LedgerMode,
  type LedgerSink,
} from '../runtime/ledger.ts';
import type { ResolvedToolsConfig } from '../config/decision-tools.ts';
import {
  buildJudgementPrompt,
  estimatePromptTokens,
  stringifyDetail,
  type JudgementPromptParts,
} from './prompt.ts';

// ── 常量与 schema ───────────────────────────────────────────────────

export const DECIDE_TOOL = 'decision_decide';

export const DECIDE_QUESTIONS_MIN = 1;
export const DECIDE_QUESTIONS_MAX = 16;
export const DECIDE_N_MIN = 3;
export const DECIDE_N_MAX = 5;
export const DECIDE_INSTRUCTIONS_MAX = 2_000;
export const DECIDE_CHOICE_MIN = 2;
export const DECIDE_CHOICE_MAX = 255;
export const DECIDE_SCORE_LEVELS_MIN = 2;
export const DECIDE_SCORE_LEVELS_MAX = 10;

/**
 * 工具描述（D1/D2/D4/D5）。
 *
 * D2：开头即「做什么 + 绝不能做什么」；D1：purpose/actions/constraints 在前，
 * 细节后置；D5：每条事实只说一次（约束不重复陈述）。
 */
export const DECIDE_DESCRIPTION = [
  'Judge typed questions against a given state and return structured decisions (probability distributions, never prose).',
  'Never return free-form reasoning text, never echo the input state, never invent a value outside a question candidate set.',
  'Actions: 1) validate every question (type/instructions/criteria); 2) send one bounded decision call; 3) with n=3..5 repeat independently and aggregate.',
  'Constraints: at most 16 questions per call; choice needs 2..255 named options; score needs an ordered 2..10 level list; n is 1 (single) or 3..5 (self-consistency, costs n calls).',
  'Output is bounded: per question id → value, confidence, distribution, status; plus decision ids and aggregate agreement. Failure returns { ok:false, error } and never guesses.',
].join(' ');

/** 工具入参 schema（参数规则写在参数上，D4）。 */
export const DECIDE_PARAMETERS = {
  state: {
    oneOf: [
      { type: 'string' as const },
      { type: 'object' as const, additionalProperties: true as const },
    ] as const,
    required: true as const,
    description:
      'Decision state the questions are judged against. Plain text or a JSON object.',
  },
  questions: {
    type: 'object' as const,
    required: true as const,
    additionalProperties: true as const,
    properties: {},
    description:
      'Map of question id → { type: "noul" | "choice" | "score", instructions, criteria? }. 1..16 questions per call.',
  },
  n: {
    type: 'integer' as const,
    description:
      'Self-consistency sample count: omit or 1 = single judgement; 3..5 = independent repeats aggregated with agreement. Costs n model calls.',
  },
};

const DECIDE_OUTPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: true as const,
  properties: {
    ok: { type: 'boolean' as const, required: true as const },
    answers: {
      type: 'object' as const,
      additionalProperties: true as const,
      properties: {},
    },
    decisionIds: {
      type: 'object' as const,
      additionalProperties: true as const,
      properties: {},
    },
    selfConsistency: {
      type: 'object' as const,
      additionalProperties: true as const,
      properties: {
        requested: { type: 'integer' as const, required: true as const },
        samples: { type: 'integer' as const, required: true as const },
        degraded: { type: 'boolean' as const, required: true as const },
        agreement: {
          oneOf: [
            { type: 'number' as const },
            { type: 'null' as const },
          ] as const,
        },
        modalVoteRatio: {
          oneOf: [
            { type: 'number' as const },
            { type: 'null' as const },
          ] as const,
        },
      },
    },
    source: {
      type: 'string' as const,
      enum: ['decision-model', 'llm-fallback-judge'],
    },
    fallback: {
      type: 'object' as const,
      additionalProperties: true as const,
      properties: {
        triggered: { type: 'boolean' as const, required: true as const },
        trigger: {
          type: 'string' as const,
          required: true as const,
          enum: [
            'model-not-configured',
            'model-verify-failed',
            'model-call-failed',
            'model-timeout',
            'model-invalid-response',
            'low-confidence',
          ],
        },
        route: {
          oneOf: [
            {
              type: 'object' as const,
              additionalProperties: true as const,
              properties: {
                provider: { type: 'string' as const, required: true as const },
                model: { type: 'string' as const, required: true as const },
                origin: { type: 'string' as const, required: true as const },
              },
            },
            { type: 'null' as const },
          ] as const,
        },
        originalSource: {
          type: 'string' as const,
          required: true as const,
          enum: ['decision-model', 'llm-fallback-judge'],
        },
        originalConfidence: {
          oneOf: [
            { type: 'number' as const },
            { type: 'null' as const },
          ] as const,
        },
        error: {
          type: 'object' as const,
          additionalProperties: true as const,
          properties: {
            code: { type: 'string' as const, required: true as const },
            message: { type: 'string' as const, required: true as const },
          },
        },
      },
    },
    usage: {
      type: 'object' as const,
      additionalProperties: true as const,
      properties: {
        calls: { type: 'integer' as const, required: true as const },
        latencyMs: { type: 'integer' as const, required: true as const },
        inputTokens: {
          oneOf: [
            { type: 'integer' as const },
            { type: 'null' as const },
          ] as const,
        },
        outputTokens: {
          oneOf: [
            { type: 'integer' as const },
            { type: 'null' as const },
          ] as const,
        },
      },
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

export const DECIDE_OUTPUT = {
  schema: DECIDE_OUTPUT_SCHEMA,
  render: (_args: unknown, value: unknown) => [
    { type: 'text' as const, text: JSON.stringify(value) },
  ],
};

export type DecideOutput = InferValue<typeof DECIDE_OUTPUT_SCHEMA>;

// ── 入参校验（纯函数，可单测） ───────────────────────────────────────

export type DecideQuestionType = 'noul' | 'choice' | 'score';

export interface DecideQuestionPlan {
  id: string;
  type: DecideQuestionType;
  instructions: string;
  criteria: JsonValue | undefined;
  /** choice 题候选集（有序，来自 criteria 的键）。 */
  options: string[];
  /** score 题档位数（其余为 0）。 */
  levels: number;
}

export interface DecidePlan {
  state: string | JsonValue;
  questions: DecideQuestionPlan[];
  /** 1 = 单次判定；3..5 = 自一致性。 */
  n: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验 decide 入参；任何不合规都返回 invalid-arguments 而不是抛错。 */
export function planDecide(
  args: unknown,
):
  { ok: true; plan: DecidePlan } | { ok: false; error: DecisionErrorEnvelope } {
  if (!isPlainObject(args)) {
    return {
      ok: false,
      error: decisionError(
        'invalid-arguments',
        'decide 入参必须是对象（state + questions）',
      ),
    };
  }
  const state = args.state;
  if (typeof state !== 'string' && !isPlainObject(state)) {
    return {
      ok: false,
      error: decisionError('invalid-arguments', 'state 必须是字符串或对象'),
    };
  }
  if (typeof state === 'string' && state.trim() === '') {
    return {
      ok: false,
      error: decisionError('invalid-arguments', 'state 不能是空字符串'),
    };
  }
  const rawQuestions = args.questions;
  if (!isPlainObject(rawQuestions)) {
    return {
      ok: false,
      error: decisionError(
        'invalid-arguments',
        'questions 必须是按问题 id 索引的对象',
      ),
    };
  }
  const ids = Object.keys(rawQuestions);
  if (ids.length < DECIDE_QUESTIONS_MIN || ids.length > DECIDE_QUESTIONS_MAX) {
    return {
      ok: false,
      error: decisionError(
        'invalid-arguments',
        `questions 题量必须在 ${DECIDE_QUESTIONS_MIN}–${DECIDE_QUESTIONS_MAX} 之间（当前 ${ids.length}）`,
      ),
    };
  }

  const questions: DecideQuestionPlan[] = [];
  for (const id of ids) {
    const raw = rawQuestions[id];
    if (!isPlainObject(raw)) {
      return {
        ok: false,
        error: decisionError('invalid-arguments', `问题 ${id} 必须是对象`),
      };
    }
    const type = raw.type;
    if (type !== 'noul' && type !== 'choice' && type !== 'score') {
      return {
        ok: false,
        error: decisionError(
          'invalid-arguments',
          `问题 ${id} 的 type 必须是 noul / choice / score`,
        ),
      };
    }
    const instructions = raw.instructions;
    if (typeof instructions !== 'string' || instructions.trim() === '') {
      return {
        ok: false,
        error: decisionError(
          'invalid-arguments',
          `问题 ${id} 缺少 instructions`,
        ),
      };
    }
    if (instructions.length > DECIDE_INSTRUCTIONS_MAX) {
      return {
        ok: false,
        error: decisionError(
          'invalid-arguments',
          `问题 ${id} 的 instructions 超过 ${DECIDE_INSTRUCTIONS_MAX} 字符上限`,
        ),
      };
    }
    const criteria = raw.criteria;

    if (type === 'choice') {
      if (!isPlainObject(criteria)) {
        return {
          ok: false,
          error: decisionError(
            'invalid-arguments',
            `问题 ${id} 是 choice 题，必须给 criteria 选项映射（选项名 → 描述）`,
          ),
        };
      }
      const options = Object.keys(criteria);
      if (
        options.length < DECIDE_CHOICE_MIN ||
        options.length > DECIDE_CHOICE_MAX
      ) {
        return {
          ok: false,
          error: decisionError(
            'invalid-arguments',
            `问题 ${id} 的候选取值必须在 ${DECIDE_CHOICE_MIN}–${DECIDE_CHOICE_MAX} 个之间（当前 ${options.length}）`,
          ),
        };
      }
      for (const option of options) {
        if (option.trim() === '' || typeof criteria[option] !== 'string') {
          return {
            ok: false,
            error: decisionError(
              'invalid-arguments',
              `问题 ${id} 的候选取值必须是「非空选项名 → 文字描述」`,
            ),
          };
        }
      }
      questions.push({
        id,
        type,
        instructions,
        criteria: criteria as JsonValue,
        options,
        levels: 0,
      });
      continue;
    }

    if (type === 'score') {
      if (
        !Array.isArray(criteria) ||
        criteria.length < DECIDE_SCORE_LEVELS_MIN ||
        criteria.length > DECIDE_SCORE_LEVELS_MAX
      ) {
        return {
          ok: false,
          error: decisionError(
            'invalid-arguments',
            `问题 ${id} 是 score 题，必须给 ${DECIDE_SCORE_LEVELS_MIN}–${DECIDE_SCORE_LEVELS_MAX} 档有序 criteria 数组`,
          ),
        };
      }
      for (const level of criteria) {
        if (typeof level !== 'string' || level.trim() === '') {
          return {
            ok: false,
            error: decisionError(
              'invalid-arguments',
              `问题 ${id} 的 score 档位必须是非空文字`,
            ),
          };
        }
      }
      questions.push({
        id,
        type,
        instructions,
        criteria: criteria as JsonValue,
        options: [],
        levels: criteria.length,
      });
      continue;
    }

    // noul：criteria 可选（{ true: 依据, false: 依据 }）。
    if (criteria !== undefined) {
      if (!isPlainObject(criteria)) {
        return {
          ok: false,
          error: decisionError(
            'invalid-arguments',
            `问题 ${id} 的 noul criteria 必须是对象（{ true: 依据, false: 依据 }）`,
          ),
        };
      }
      for (const key of Object.keys(criteria)) {
        if (typeof criteria[key] !== 'string') {
          return {
            ok: false,
            error: decisionError(
              'invalid-arguments',
              `问题 ${id} 的 noul criteria 取值必须是文字`,
            ),
          };
        }
      }
    }
    questions.push({
      id,
      type,
      instructions,
      criteria: criteria as JsonValue | undefined,
      options: [],
      levels: 0,
    });
  }

  const rawN = args.n;
  let n = 1;
  if (rawN !== undefined && rawN !== null) {
    if (typeof rawN !== 'number' || !Number.isInteger(rawN)) {
      return {
        ok: false,
        error: decisionError('invalid-arguments', 'n 必须是整数（1 或 3–5）'),
      };
    }
    if (rawN !== 1 && (rawN < DECIDE_N_MIN || rawN > DECIDE_N_MAX)) {
      return {
        ok: false,
        error: decisionError(
          'invalid-arguments',
          `n 只接受 3–5（自一致性）或 1（单次判定），当前 ${rawN}`,
        ),
      };
    }
    n = rawN;
  }

  return {
    ok: true,
    plan: { state: state as string | JsonValue, questions, n },
  };
}

// ── state 组装（D1/D2/D5）─────────────────────────────────────────

/** 把 decide 计划组装成 `{ message }` 形状的 state（与本地真实服务同构）。 */
export function buildDecideState(plan: DecidePlan): JsonValue {
  const actions = plan.questions.map((q) => {
    if (q.type === 'choice') {
      return `${q.id}: choose exactly one candidate from [${q.options.join(' | ')}]`;
    }
    if (q.type === 'score') {
      return `${q.id}: score on an ordered ${q.levels}-level scale (lowest first)`;
    }
    return `${q.id}: yes/no (noul) judgement`;
  });
  const parts: JudgementPromptParts = {
    purpose:
      'Judge the typed questions below against DETAIL and return one structured value per question.',
    constraints: [
      'Answer every listed question id; never add or drop a question id.',
      'Choose values only from each question own candidate set; never invent a value.',
      'Judge only from DETAIL; do not assume facts that are not stated.',
    ],
    actions,
    detail: stringifyDetail(plan.state),
  };
  return { message: buildJudgementPrompt(parts) } as JsonValue;
}

/** 暴露给测试与评论的 prompt token 估算（D6）。 */
export function estimateDecidePromptTokens(plan: DecidePlan): number {
  return estimatePromptTokens(JSON.stringify(buildDecideState(plan)));
}

// ── 答案映射与聚合（纯函数，可单测） ────────────────────────────────

export interface DecideAnswer {
  type: DecideQuestionType;
  value: JsonValue;
  confidence: number | null;
  distribution: JsonValue | null;
  legend: string[] | null;
  status: 'ok' | 'dropped';
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** 把指标夹到 [0,1]（未归一分布可能让熵公式越界）。 */
function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 香农熵（自然对数）。 */
export function entropy(distribution: number[]): number {
  let h = 0;
  for (const p of distribution) {
    if (p > 0) h -= p * Math.log(p);
  }
  return h;
}

/** 分布集中度 1 - H(p)/ln(K)；K≤1 时按 1.0（契约 §3.1）。 */
export function computeAgreement(distribution: number[]): number {
  const positive = distribution.filter((p) => p > 0);
  const k = positive.length;
  if (k <= 1) return 1;
  return round4(clamp01(1 - entropy(positive) / Math.log(k)));
}

/** 单题答案（模型内部形态）→ 工具出参答案。 */
export function mapAnswerToDecideAnswer(
  question: DecideQuestionPlan,
  answer: SystemOneParsedAnswer | undefined,
): DecideAnswer {
  if (!answer || answer.kind !== question.type) {
    return {
      type: question.type,
      value: null,
      confidence: null,
      distribution: null,
      legend: null,
      status: 'dropped',
    };
  }
  switch (answer.kind) {
    case 'noul': {
      const pYes = answer.pYes;
      return {
        type: 'noul',
        value: round4(pYes),
        confidence: answer.confidence,
        distribution: { yes: round4(pYes), no: round4(1 - pYes) },
        legend: null,
        status: 'ok',
      };
    }
    case 'choice': {
      // 候选集外的取值一律判为丢弃（fail-closed，不夹取）。
      if (!question.options.includes(answer.choice)) {
        return {
          type: 'choice',
          value: null,
          confidence: null,
          distribution: null,
          legend: null,
          status: 'dropped',
        };
      }
      return {
        type: 'choice',
        value: answer.choice,
        confidence: answer.confidence,
        distribution: answer.probabilities,
        legend: null,
        status: 'ok',
      };
    }
    case 'score': {
      return {
        type: 'score',
        value: round4(answer.score),
        confidence: answer.confidence,
        distribution: answer.probabilities,
        legend: answer.legend,
        status: 'ok',
      };
    }
  }
}

export interface AggregatedAnswer extends DecideAnswer {
  agreement: number | null;
  modalVoteRatio: number | null;
  /** 参与聚合的有效样本数。 */
  samples: number;
}

/**
 * 多选题答案聚合（契约 §3.1 self-consistency）：
 * - choice：计票归一，众数即 value；平票取单次 confidence 最高者，仍平票按选项名字典序。
 * - noul：平均 P(yes)。
 * - score：平均期望分；档位分布按元素平均。
 */
export function aggregateAnswers(
  question: DecideQuestionPlan,
  answers: SystemOneParsedAnswer[],
): AggregatedAnswer | null {
  const valid = answers.filter((a) => {
    if (a.kind !== question.type) return false;
    if (a.kind === 'choice') return question.options.includes(a.choice);
    return true;
  });
  if (valid.length === 0) return null;

  if (question.type === 'choice') {
    const votes = new Map<string, number>();
    const confidenceByChoice = new Map<string, number>();
    for (const answer of valid) {
      if (answer.kind !== 'choice') continue;
      votes.set(answer.choice, (votes.get(answer.choice) ?? 0) + 1);
      const prev = confidenceByChoice.get(answer.choice);
      const conf = answer.confidence;
      if (conf !== null && (prev === undefined || conf > prev)) {
        confidenceByChoice.set(answer.choice, conf);
      }
    }
    const total = valid.length;
    const distribution: Record<string, number> = {};
    for (const option of question.options) {
      distribution[option] = round4((votes.get(option) ?? 0) / total);
    }
    const ranked = [...question.options].sort((a, b) => {
      const voteGap = (votes.get(b) ?? 0) - (votes.get(a) ?? 0);
      if (voteGap !== 0) return voteGap;
      const confGap =
        (confidenceByChoice.get(b) ?? -1) - (confidenceByChoice.get(a) ?? -1);
      if (confGap !== 0) return confGap;
      // 平票兜底用 UTF-16 码元字典序而非 localeCompare：默认 locale 随环境变化，
      // 中文选项名在 CI 与本机会得到不同的 tie-break（跨平台确定序）。
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const value = ranked[0];
    const maxVotes = votes.get(value) ?? 0;
    const confidences = valid
      .map((answer) => answer.confidence)
      .filter((value): value is number => value !== null);
    return {
      type: 'choice',
      value,
      confidence:
        confidences.length === 0
          ? null
          : round4(
              confidences.reduce((sum, v) => sum + v, 0) / confidences.length,
            ),
      distribution,
      legend: null,
      status: 'ok',
      agreement: computeAgreement(Object.values(distribution)),
      modalVoteRatio: round4(maxVotes / total),
      samples: total,
    };
  }

  if (question.type === 'noul') {
    let sum = 0;
    let count = 0;
    const confidences: number[] = [];
    for (const answer of valid) {
      if (answer.kind !== 'noul') continue;
      sum += answer.pYes;
      count += 1;
      if (answer.confidence !== null) confidences.push(answer.confidence);
    }
    const pYes = sum / count;
    const distribution = [round4(pYes), round4(1 - pYes)];
    return {
      type: 'noul',
      value: distribution[0],
      confidence:
        confidences.length === 0
          ? null
          : round4(confidences.reduce((a, b) => a + b, 0) / confidences.length),
      distribution: { yes: distribution[0], no: distribution[1] },
      legend: null,
      status: 'ok',
      agreement: computeAgreement(distribution),
      // 众数票占比只对 choice 有定义；noul/score 用平均概率，投票语义不成立。
      modalVoteRatio: null,
      samples: count,
    };
  }

  // score
  let scoreSum = 0;
  let count = 0;
  const confidences: number[] = [];
  const probabilitySums: number[] = [];
  const probabilityCounts: number[] = [];
  let probCount = 0;
  for (const answer of valid) {
    if (answer.kind !== 'score') continue;
    scoreSum += answer.score;
    count += 1;
    if (answer.confidence !== null) confidences.push(answer.confidence);
    const probs = answer.probabilities;
    if (Array.isArray(probs)) {
      probCount += 1;
      for (let i = 0; i < probs.length; i += 1) {
        probabilitySums[i] = (probabilitySums[i] ?? 0) + probs[i];
        probabilityCounts[i] = (probabilityCounts[i] ?? 0) + 1;
      }
    }
  }
  const legend = Array.isArray(question.criteria)
    ? (question.criteria as string[])
    : null;
  // 只按「真正提供了 probabilities 的样本数」求均值；先逐档位取样本均值，
  // 再按总和归一——样本数组长度不齐时也能保证 distribution 总和为 1（§2.3）。
  const rawDistribution =
    probCount > 0
      ? probabilitySums.map(
          (sum, i) => sum / (probabilityCounts[i] ?? probCount),
        )
      : null;
  const rawTotal = rawDistribution
    ? rawDistribution.reduce((a, b) => a + b, 0)
    : 0;
  const distribution =
    rawDistribution && rawTotal > 0
      ? rawDistribution.map((value) => round4(value / rawTotal))
      : null;
  const agreement = distribution ? computeAgreement(distribution) : null;
  return {
    type: 'score',
    value: round4(scoreSum / count),
    confidence:
      confidences.length === 0
        ? null
        : round4(confidences.reduce((a, b) => a + b, 0) / confidences.length),
    distribution,
    legend,
    status: 'ok',
    agreement,
    modalVoteRatio: null,
    samples: count,
  };
}

// ── 记账（汇总条目） ────────────────────────────────────────────────

interface AggregateLedgerInput {
  config: ResolvedToolsConfig;
  question: DecideQuestionPlan;
  answer: AggregatedAnswer;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    calls: number;
  };
  latencyMs: number;
  source: 'decision-model' | 'llm-fallback-judge';
  mode: LedgerMode;
}

function appendAggregateEntry(
  ledger: LedgerSink | undefined,
  input: AggregateLedgerInput,
): string {
  const decisionId = newDecisionId();
  if (!ledger) return decisionId;
  const estimate = estimateCostUsd(input.usage, input.config);
  ledger.append({
    decisionId,
    ts: new Date().toISOString(),
    tool: DECIDE_TOOL,
    mode: input.mode,
    source: input.source,
    questionId: input.question.id,
    questionType: input.question.type,
    questionSummary: truncateSummary(input.question.instructions),
    status: 'ok',
    payload: {
      value: input.answer.value,
      confidence: input.answer.confidence,
      distribution: input.answer.distribution,
      legend: input.answer.legend,
      aggregated: true,
    },
    outcome: { state: 'unknown', value: null, source: null, updatedAt: null },
    usage: input.usage,
    latencyMs: input.latencyMs,
    costUsd: estimate.costUsd,
    costEstimated: estimate.costEstimated,
  });
  return decisionId;
}

// ── 主流程 ──────────────────────────────────────────────────────────

interface SampleSet {
  answers: Record<string, SystemOneParsedAnswer>;
  usage: SystemOneNormalizedUsage | null;
  latencyMs: number;
  decisionIds: Record<string, string>;
  source: 'decision-model' | 'llm-fallback-judge';
  mode: LedgerMode;
  /** T1/T2 由统一调用层内部兜底时携带的 meta（透传给工具出参，契约 §10.3）。 */
  fallback?: FallbackMeta | null;
}

function toSystemOneQuestions(
  plan: DecidePlan,
): Record<string, SystemOneQuestion> {
  const out: Record<string, SystemOneQuestion> = {};
  for (const question of plan.questions) {
    out[question.id] = {
      type: question.type,
      instructions: question.instructions,
      ...(question.criteria === undefined
        ? {}
        : { criteria: question.criteria }),
    };
  }
  return out;
}

function errorBody(error: DecisionErrorEnvelope): Record<string, JsonValue> {
  return { ok: false, error: error as unknown as JsonValue };
}

/** 内部异常兜底：契约 §1.1 要求工具绝不向调用方 reject。 */
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

/** decide 主流程：校验 → 单次或 N 次调用 → 聚合 → 出参。 */
export async function runDecide(
  args: unknown,
  exec: ToolRunContext,
  deps: DecisionCallDeps,
): Promise<Record<string, JsonValue>> {
  const planned = planDecide(args);
  if (!planned.ok) return errorBody(planned.error);
  const { plan } = planned;

  const configResult = readConfigOrError(deps);
  if (!configResult.ok) return errorBody(configResult.error);
  const config = configResult.config;

  const state = buildDecideState(plan);
  const questions = toSystemOneQuestions(plan);
  const questionSummaries: Record<string, string> = {};
  for (const question of plan.questions) {
    questionSummaries[question.id] = question.instructions;
  }

  const sampleCount = plan.n;
  const samples: SampleSet[] = [];
  let lastFailure: DecisionCallResult | null = null;

  // 会话当前模型（best-effort；宿主没有公开 API，取不到就不传）。
  const sessionModel = deps.resolveSessionModel?.(exec) ?? undefined;
  const baseRequest: DecisionCallRequest = {
    tool: DECIDE_TOOL,
    state,
    questions,
    questionSummaries,
    ...(sessionModel === undefined ? {} : { sessionModel }),
    ...(exec.signal === undefined ? {} : { signal: exec.signal }),
  };

  for (let index = 0; index < sampleCount; index += 1) {
    const result = await runDecisionCall(deps, {
      ...baseRequest,
      ...(sampleCount > 1 ? { sampleIndex: index } : {}),
    });
    if (!result.ok) {
      // 调用方主动取消：直接透传取消错误，不把取消当成「采到一半降级成功」。
      if (result.error.details?.aborted === true)
        return errorBody(result.error);
      lastFailure = result;
      continue;
    }
    samples.push({
      answers: result.answers,
      usage: result.usage,
      latencyMs: result.latencyMs,
      decisionIds: result.decisionIds,
      source: result.source,
      mode: result.mode,
      fallback: result.fallback ?? null,
    });
  }

  if (samples.length === 0) {
    const failure = lastFailure as Extract<
      DecisionCallResult,
      { ok: false }
    > | null;
    if (failure) return errorBody(failure.error);
    return errorBody(
      decisionError('model-call-failed', '决策调用未产生任何结果'),
    );
  }

  const degraded = samples.length < sampleCount;
  const answersOut: Record<string, JsonValue> = {};
  const decisionIdsOut: Record<string, JsonValue> = {};
  const droppedQuestionIds: string[] = [];
  const invalidAnswers: { questionId: string; reason: string }[] = [];
  let agreement: number | null = null;
  let modalVoteRatio: number | null = null;

  for (const question of plan.questions) {
    const questionAnswers = samples
      .map((sample) => sample.answers[question.id])
      .filter(
        (answer): answer is SystemOneParsedAnswer => answer !== undefined,
      );

    if (sampleCount === 1) {
      const sample = samples[0];
      const answer = mapAnswerToDecideAnswer(
        question,
        sample.answers[question.id],
      );
      answersOut[question.id] = answer as unknown as JsonValue;
      if (answer.status !== 'ok') {
        droppedQuestionIds.push(question.id);
        invalidAnswers.push({
          questionId: question.id,
          reason:
            sample.answers[question.id] === undefined
              ? '上游未返回该题（dropped）'
              : '取值不在候选集内或题型不符',
        });
      } else {
        decisionIdsOut[question.id] = sample.decisionIds[question.id];
      }
      continue;
    }

    const aggregated = aggregateAnswers(question, questionAnswers);
    if (aggregated === null) {
      answersOut[question.id] = {
        type: question.type,
        value: null,
        confidence: null,
        distribution: null,
        legend: null,
        status: 'dropped',
      } as unknown as JsonValue;
      droppedQuestionIds.push(question.id);
      invalidAnswers.push({
        questionId: question.id,
        reason: '自一致性采样中该题没有任何有效样本',
      });
      continue;
    }
    // 契约 §3.1：answers[qid] 只能是 6 个字段；agreement/modalVoteRatio/samples
    // 只出现在顶层 selfConsistency，绝不能随聚合对象一起泄漏（否则读方会误以为
    // 每题都有独立统计，且违反「出参有界」D3）。
    answersOut[question.id] = {
      type: aggregated.type,
      value: aggregated.value,
      confidence: aggregated.confidence,
      distribution: aggregated.distribution,
      legend: aggregated.legend,
      status: aggregated.status,
    } as unknown as JsonValue;
    // agreement / modalVoteRatio 只汇总「非 null」的题，避免一题缺概率就抹掉全局值。
    if (aggregated.agreement !== null) {
      agreement =
        agreement === null
          ? aggregated.agreement
          : Math.min(agreement, aggregated.agreement);
    }
    if (aggregated.modalVoteRatio !== null) {
      modalVoteRatio =
        modalVoteRatio === null
          ? aggregated.modalVoteRatio
          : Math.min(modalVoteRatio, aggregated.modalVoteRatio);
    }
    // 汇总条目只承载聚合 payload；真实 usage 已记在每次采样的第一条题级条目上（§5.1），
    // 这里再写一份会按题数重复计数。
    const decisionId = appendAggregateEntry(deps.ledger, {
      config,
      question,
      answer: aggregated,
      usage: { inputTokens: null, outputTokens: null, calls: 0 },
      // 汇总条目不重复累计延迟（真实 usage/latency 已在各采样首条题级条目上）。
      latencyMs: 0,
      source: samples[0].source,
      mode: samples[0].mode,
    });
    decisionIdsOut[question.id] = decisionId;
  }

  // usage 以「每次真实调用」为单位累加（与题数无关）：N 次采样 = N 次调用。
  let totalInput = 0;
  let sawInput = false;
  let totalOutput = 0;
  let sawOutput = false;
  let totalLatency = 0;
  for (const sample of samples) {
    if (
      sample.usage?.inputTokens !== null &&
      sample.usage?.inputTokens !== undefined
    ) {
      totalInput += sample.usage.inputTokens;
      sawInput = true;
    }
    if (
      sample.usage?.outputTokens !== null &&
      sample.usage?.outputTokens !== undefined
    ) {
      totalOutput += sample.usage.outputTokens;
      sawOutput = true;
    }
    totalLatency += sample.latencyMs;
  }

  if (sampleCount > 1) {
    agreement = agreement === null ? null : round4(clamp01(agreement));
    modalVoteRatio =
      modalVoteRatio === null ? null : round4(clamp01(modalVoteRatio));
  }

  if (droppedQuestionIds.length > 0 || invalidAnswers.length > 0) {
    const invalidError = decisionError(
      'model-invalid-response',
      `有 ${droppedQuestionIds.length} 道题未能得到合法判定`,
      {
        details: {
          droppedQuestionIds,
          invalidAnswers,
          answers: answersOut as unknown as JsonValue,
        },
      },
    );
    // T2（工具层）：调用成功但结果不可用 → 走兜底裁判。
    // 裁判失败时**保留原错误码** model-invalid-response，裁判原因进 details.judgeError。
    const judged = await runFallbackJudge(deps, baseRequest, {
      kind: 'model-invalid-response',
      originalError: invalidError,
    });
    if (judged.kind === 'judged') {
      return buildDecideOutputFromCall(plan, judged.result, sampleCount);
    }
    if (judged.kind === 'failed') {
      return errorBody({
        ...invalidError,
        details: {
          ...invalidError.details,
          judgeError: judged.error,
        },
      });
    }
    return errorBody(invalidError);
  }

  const usage =
    sampleCount === 1
      ? {
          calls: 1,
          latencyMs: samples[0].latencyMs,
          inputTokens: samples[0].usage?.inputTokens ?? null,
          outputTokens: samples[0].usage?.outputTokens ?? null,
        }
      : {
          calls: samples.length,
          latencyMs: totalLatency,
          inputTokens: sawInput ? totalInput : null,
          outputTokens: sawOutput ? totalOutput : null,
        };

  const output: Record<string, JsonValue> = {
    ok: true,
    answers: answersOut,
    decisionIds: decisionIdsOut,
    source: samples[0].source,
    usage: usage as unknown as JsonValue,
  };

  // T1/T2 由统一调用层内部兜底时，兜底 meta 挂在这次调用结果上（契约 §10.3）：
  // 这里透传给工具出参，调用方能看到「这次结论来自裁判、触发原因是什么」。
  if (samples[0].fallback) {
    output.fallback = samples[0].fallback as unknown as JsonValue;
  }

  if (sampleCount > 1) {
    output.selfConsistency = {
      requested: sampleCount,
      samples: samples.length,
      agreement,
      modalVoteRatio,
      degraded,
    } as unknown as JsonValue;
  }

  // T3（低置信兜底）：置信度或自一致性低于阈值 → 走裁判（契约 §10.1）。
  // 首判本身已经是裁判产出（T1/T2 兜底接管）时不再二判——裁判产出不回灌兜底，
  // 避免配额双烧与自相矛盾 meta（契约 §10.3「触发即标注 triggered 恒为 true」）。
  const judgedByFallback = samples[0]?.source === 'llm-fallback-judge';
  let lowestConfidence: number | null = null;
  if (!judgedByFallback) {
    for (const value of Object.values(answersOut)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const confidence = (value as { confidence?: unknown }).confidence;
        if (typeof confidence === 'number' && Number.isFinite(confidence)) {
          lowestConfidence =
            lowestConfidence === null
              ? confidence
              : Math.min(lowestConfidence, confidence);
        }
      }
    }
  }
  const fallbackOutcome = judgedByFallback
    ? null
    : await runLowConfidenceFallback(deps, baseRequest, {
        lowestConfidence,
        ...(agreement === null ? {} : { agreement }),
      });
  if (fallbackOutcome?.kind === 'judged') {
    return buildDecideOutputFromCall(plan, fallbackOutcome.result, sampleCount);
  }
  if (fallbackOutcome?.kind === 'failed') {
    // 兜底失败：维持首判结果，并如实标注「兜底失败」（不产无来源结论）。
    output.fallback = {
      triggered: false,
      trigger: 'low-confidence',
      route: null,
      originalSource: 'decision-model',
      originalConfidence: lowestConfidence,
      error: fallbackOutcome.error,
    } as unknown as JsonValue;
  }

  return output;
}

/**
 * 由（可能是兜底裁判的）判定结果组装 decide 出参。
 *
 * 兜底裁判只跑一次，因此 n>1 时 selfConsistency 记 samples=1、agreement=null、
 * degraded=true——**绝不伪造多采样统计**（契约 §3.1）。
 */
function buildDecideOutputFromCall(
  plan: DecidePlan,
  call: DecisionCallOk,
  sampleCount: number,
): Record<string, JsonValue> {
  const answersOut: Record<string, JsonValue> = {};
  const decisionIdsOut: Record<string, JsonValue> = {};
  for (const question of plan.questions) {
    const answer = mapAnswerToDecideAnswer(question, call.answers[question.id]);
    answersOut[question.id] = answer as unknown as JsonValue;
    if (answer.status === 'ok') {
      decisionIdsOut[question.id] = call.decisionIds[question.id];
    }
  }
  const output: Record<string, JsonValue> = {
    ok: true,
    answers: answersOut,
    decisionIds: decisionIdsOut,
    source: call.source,
    usage: {
      calls: 1,
      latencyMs: call.latencyMs,
      inputTokens: call.usage?.inputTokens ?? null,
      outputTokens: call.usage?.outputTokens ?? null,
    } as unknown as JsonValue,
  };
  if (sampleCount > 1) {
    output.selfConsistency = {
      requested: sampleCount,
      samples: 1,
      agreement: null,
      modalVoteRatio: null,
      degraded: true,
    } as unknown as JsonValue;
  }
  if (call.fallback) output.fallback = call.fallback as unknown as JsonValue;
  return output;
}

// ── 工具定义工厂 ────────────────────────────────────────────────────

/** 创建 decision_decide 工具定义（deps 由插件入口注入）。 */
export function createDecideTool(deps: DecisionCallDeps): ToolDefinition {
  return defineTool({
    name: DECIDE_TOOL,
    description: DECIDE_DESCRIPTION,
    parameters: DECIDE_PARAMETERS,
    output: DECIDE_OUTPUT,
    async execute(args: unknown, exec: ToolRunContext): Promise<DecideOutput> {
      try {
        const result = await runDecide(args, exec, deps);
        return result as unknown as DecideOutput;
      } catch (thrown) {
        return unexpectedErrorBody(thrown) as unknown as DecideOutput;
      }
    },
  }) as ToolDefinition;
}
