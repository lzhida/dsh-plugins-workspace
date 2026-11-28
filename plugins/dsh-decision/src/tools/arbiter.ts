/**
 * decision_arbiter（决策工具系列 10/11）——显式大模型裁判。
 *
 * 与 7/11 的自动兜底（`auto-fallback`）的边界（契约 §10.1）：
 * - `auto-fallback` = **自动**触发：置信度门控 / 调用失败时由统一调用层接管；
 * - `explicit-arbiter` = **显式**触发：只有本工具被 agent 主动调用时才发生。
 *
 * 本工具**复用 7/11 的裁判通道入口 `judgeOnce`**（不重写裁判逻辑），因此：
 * - 路由优先级、预算闸（judge 独立配额）、严格 JSON 解析、题型校验、记账
 *   全部沿用同一封装层；
 * - **防递归**：裁判调用只走宿主大模型通道，不会回调统一调用层，
 *   裁判自身不再触发兜底；
 * - **记账可区分**：`judgeOnce` 以 `mode = 'explicit-arbiter'` 落条目，
 *   与自动兜底的 `mode = 'auto-fallback'` 在账本/轨迹里可区分
 *   （契约 §10.1「兜底不改变账本分类」）。
 *
 * 口径以契约 §3.10 为准：
 * - `verdict` 语义随题型：`noul` → `yes` / `no`；`choice` → 选项名；
 *   `gate` 类问题 → `allow` / `revise` / `block` / `escalate`。
 * - `disagreement`：noul → `|P(yes)_judge − P(yes)_original| > 0.10`；
 *   choice → 选项不同即 true；无原判定（只给 question）→ false。
 *   **disagreement 只表示两次判定不一致，不代表谁对**——返回体里不给倾向性结论。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { InferValue, ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { ResolvedToolsConfig } from '../config/index.ts';
import { DEFAULT_GATE_ALLOW_THRESHOLD } from '../config/decision-tools.ts';
import {
  checkToolEnabled,
  gateAllowThresholdOf,
  isValidDecisionId,
  judgeOnce,
  type JudgeAnswer,
  type JudgeDeps,
  type JudgeOutcome,
  type JudgeResult,
} from '../runtime/index.ts';
import {
  decisionError,
  type DecisionErrorEnvelope,
} from '../systemone/errors.ts';
import type { JsonValue, SystemOneQuestion } from '../systemone/types.ts';
import {
  buildGateQuestions,
  decideVerdict,
  GATE_QUESTION_IDS,
  type GatePlan,
} from './gate.ts';

export const ARBITER_TOOL = 'decision_arbiter' as const;

/** 仲裁问题在裁判通道里的题号（单题形态）。 */
export const ARBITER_QUESTION_ID = 'arbiter';
/** 判定不一致阈值（契约 §3.10）：noul |ΔP(yes)| > 0.10 即视为不一致。 */
export const ARBITER_DISAGREEMENT_THRESHOLD = 0.1;
/** noul 判定 yes/no 的分界（实现口径：P(yes) ≥ 0.5 记 yes）。 */
export const ARBITER_NO_THRESHOLD = 0.5;
/** detail 字符上限（契约 §3.10）。 */
export const ARBITER_DETAIL_MAX = 200;

export const ARBITER_DESCRIPTION = [
  'Purpose: ask the fallback judge for an explicit second opinion on a decision, either about a recorded decision id or about a fresh question.',
  'Constraints: purely a judge call — never the decision model; the judge answers with structured JSON only; a disagreement flag only reports that two judgements differ, never which one is right.',
  'Actions: this is the agent-requested arbitration path, unlike the automatic fallback that fires on its own when a confidence gate trips or a call fails; rebuild the question from the ledger entry (noul or choice) or take a fresh question (noul / choice / gate), hand it to the shared judge channel with mode explicit-arbiter, then map the judge answer to a verdict and compare it with the original judgement.',
  'Output is bounded: { ok, verdict, confidence, disagreement, detail, source, mode, original } — one verdict, one confidence and a short reason, never the model prose.',
].join(' ');

export const ARBITER_PARAMETERS = {
  decisionId: {
    type: 'string' as const,
    description:
      '可选：要仲裁的账本条目 id（dec_…）。与 question 至少给一个；给了它就会带上原判定用于比较。',
  },
  question: {
    type: 'object' as const,
    additionalProperties: true as const,
    description:
      '可选：直接给一道新问题。type ∈ noul / choice / gate；noul 需 instructions，choice 需 criteria（选项名 → 描述），gate 需 action。',
    properties: {
      type: {
        type: 'string' as const,
        required: true as const,
        enum: ['noul', 'choice', 'gate'],
        description:
          '题型：noul（是/否）、choice（选一个候选）、gate（放行四值判定）。',
      },
      instructions: {
        type: 'string' as const,
        description: 'noul / choice 的题干（≤2000 字符）。',
      },
      criteria: {
        type: 'object' as const,
        additionalProperties: true as const,
        description: 'choice 的候选集（选项名 → 描述）。',
      },
      action: {
        type: 'string' as const,
        description: 'gate 题型的待放行动作（≤500 字符）。',
      },
      context: {
        type: 'string' as const,
        description: 'gate 题型的上下文（可选）。',
      },
    },
  },
  state: {
    oneOf: [
      { type: 'string' as const },
      { type: 'object' as const, additionalProperties: true as const },
    ] as const,
    description: '可选：给裁判的判定上下文；缺省用题干/原摘要重建。',
  },
} as const;

export const ARBITER_OUTPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: true as const,
  properties: {
    ok: { type: 'boolean' as const, required: true as const },
    verdict: {
      type: 'string' as const,
      required: true as const,
      description:
        'allow / revise / block / escalate / yes / no / 选项名（语义随题型）。',
    },
    confidence: {
      oneOf: [{ type: 'number' as const }, { type: 'null' as const }] as const,
      required: true as const,
    },
    disagreement: {
      type: 'boolean' as const,
      required: true as const,
      description: '与原判定是否不一致（只表示不一致，不代表谁对）。',
    },
    detail: { type: 'string' as const, required: true as const },
    source: { type: 'string' as const, required: true as const },
    mode: { type: 'string' as const, required: true as const },
    original: {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: {
        value: { type: 'json' as const, required: true as const },
        confidence: {
          oneOf: [
            { type: 'number' as const },
            { type: 'null' as const },
          ] as const,
          required: true as const,
        },
      },
    },
    error: {
      type: 'object' as const,
      additionalProperties: true as const,
      description: '失败信封 { code, message, retryable, details }。',
      properties: {},
    },
  },
} as const;

export type ArbiterOutput = InferValue<typeof ARBITER_OUTPUT_SCHEMA>;

export const ARBITER_OUTPUT = {
  schema: ARBITER_OUTPUT_SCHEMA,
  render: (_args: unknown, value: unknown) => [
    { type: 'text' as const, text: JSON.stringify(value) },
  ],
};

// ── 入参规划 ────────────────────────────────────────────────────────

export type ArbiterQuestionType = 'noul' | 'choice' | 'gate';

export interface ArbiterPlan {
  decisionId: string | null;
  question: {
    type: ArbiterQuestionType;
    instructions: string | null;
    criteria: Record<string, string> | null;
    action: string | null;
    context: string | undefined;
  } | null;
  state: string | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type ArbiterPlanResult =
  { ok: true; plan: ArbiterPlan } | { ok: false; error: DecisionErrorEnvelope };

/** 入参校验：decisionId 与 question 至少给一个。 */
export function planArbiter(args: unknown): ArbiterPlanResult {
  if (!isPlainObject(args)) {
    return {
      ok: false,
      error: decisionError('invalid-arguments', 'arbiter 入参必须是对象'),
    };
  }
  let decisionId: string | null = null;
  const rawDecisionId = args.decisionId;
  if (rawDecisionId !== undefined && rawDecisionId !== null) {
    if (typeof rawDecisionId !== 'string' || rawDecisionId.trim() === '') {
      return {
        ok: false,
        error: decisionError(
          'invalid-arguments',
          'decisionId 必须是非空字符串',
        ),
      };
    }
    if (!isValidDecisionId(rawDecisionId)) {
      return {
        ok: false,
        error: decisionError(
          'decision-id-invalid',
          `decisionId 格式不合法（期望 dec_ + 26 位 Crockford Base32），收到 ${rawDecisionId}`,
          { details: { decisionId: rawDecisionId } },
        ),
      };
    }
    decisionId = rawDecisionId;
  }
  let question: ArbiterPlan['question'] = null;
  const rawQuestion = args.question;
  if (rawQuestion !== undefined && rawQuestion !== null) {
    if (!isPlainObject(rawQuestion)) {
      return {
        ok: false,
        error: decisionError('invalid-arguments', 'question 必须是对象'),
      };
    }
    const rawType = rawQuestion.type;
    if (rawType !== 'noul' && rawType !== 'choice' && rawType !== 'gate') {
      return {
        ok: false,
        error: decisionError(
          'invalid-arguments',
          'question.type 只接受 noul / choice / gate',
          { details: { type: String(rawType) } },
        ),
      };
    }
    let instructions: string | null = null;
    const rawInstructions = rawQuestion.instructions;
    if (rawInstructions !== undefined && rawInstructions !== null) {
      if (
        typeof rawInstructions !== 'string' ||
        rawInstructions.trim() === ''
      ) {
        return {
          ok: false,
          error: decisionError(
            'invalid-arguments',
            'question.instructions 必须是非空字符串',
          ),
        };
      }
      instructions = rawInstructions;
    }
    let criteria: Record<string, string> | null = null;
    const rawCriteria = rawQuestion.criteria;
    if (rawCriteria !== undefined && rawCriteria !== null) {
      if (!isPlainObject(rawCriteria)) {
        return {
          ok: false,
          error: decisionError(
            'invalid-arguments',
            'question.criteria 必须是「选项名 → 描述」对象',
          ),
        };
      }
      criteria = {};
      for (const [label, description] of Object.entries(rawCriteria)) {
        criteria[label] = String(description);
      }
    }
    let action: string | null = null;
    const rawAction = rawQuestion.action;
    if (rawAction !== undefined && rawAction !== null) {
      if (typeof rawAction !== 'string' || rawAction.trim() === '') {
        return {
          ok: false,
          error: decisionError(
            'invalid-arguments',
            'question.action 必须是非空字符串',
          ),
        };
      }
      action = rawAction;
    }
    let context: string | undefined;
    const rawContext = rawQuestion.context;
    if (rawContext !== undefined && rawContext !== null) {
      if (typeof rawContext !== 'string') {
        return {
          ok: false,
          error: decisionError(
            'invalid-arguments',
            'question.context 必须是字符串',
          ),
        };
      }
      context = rawContext;
    }
    if (rawType === 'noul' && instructions === null) {
      return {
        ok: false,
        error: decisionError(
          'invalid-arguments',
          'noul 题型必须给 question.instructions',
        ),
      };
    }
    if (rawType === 'choice') {
      if (instructions === null) {
        return {
          ok: false,
          error: decisionError(
            'invalid-arguments',
            'choice 题型必须给 question.instructions',
          ),
        };
      }
      if (criteria === null || Object.keys(criteria).length === 0) {
        return {
          ok: false,
          error: decisionError(
            'invalid-arguments',
            'choice 题型必须给 question.criteria（至少一个候选）',
          ),
        };
      }
    }
    if (rawType === 'gate' && action === null) {
      return {
        ok: false,
        error: decisionError(
          'invalid-arguments',
          'gate 题型必须给 question.action',
        ),
      };
    }
    question = { type: rawType, instructions, criteria, action, context };
  }
  if (decisionId === null && question === null) {
    return {
      ok: false,
      error: decisionError(
        'invalid-arguments',
        'decisionId 与 question 至少给一个',
      ),
    };
  }
  let state: string | undefined;
  const rawState = args.state;
  if (rawState !== undefined && rawState !== null) {
    if (typeof rawState === 'string') {
      state = rawState;
    } else if (isPlainObject(rawState)) {
      state = JSON.stringify(rawState);
    } else {
      return {
        ok: false,
        error: decisionError('invalid-arguments', 'state 必须是字符串或对象'),
      };
    }
  }
  return { ok: true, plan: { decisionId, question, state } };
}

// ── 题目重建 ────────────────────────────────────────────────────────

export interface ArbiterOriginal {
  value: JsonValue;
  confidence: number | null;
}

export interface ArbiterQuestionPlan {
  questions: Record<string, SystemOneQuestion>;
  /** 原始判定（只有给了 decisionId 才有）。 */
  original: ArbiterOriginal | null;
  /** 参与比较的题型：noul / choice / gate。 */
  type: ArbiterQuestionType;
  /** 原题摘要（重建题干与 detail 时用）。 */
  summary: string | null;
}

export type ArbiterQuestionResult =
  | { ok: true; plan: ArbiterQuestionPlan }
  | { ok: false; error: DecisionErrorEnvelope };

/**
 * 从账本条目重建仲裁题目。
 *
 * 账本按契约 §5.1 **不保存 state 原文与题目全文**，所以仲裁题目只能由
 * 条目里已有的信息重建（题型 + 摘要 + 判定分布），与复检同一口径：
 * - noul：二元判定（true/false criteria）；
 * - choice：候选集取自 distribution 的键，缺失回退原判定值；
 * - score / box：不在仲裁口径内 → invalid-arguments。
 */
export function buildArbiterQuestionFromEntry(entry: {
  questionType: string | null;
  questionSummary: string | null;
  payload: {
    value: JsonValue;
    confidence: number | null;
    distribution: JsonValue | null;
  };
}): ArbiterQuestionResult {
  const summary = entry.questionSummary ?? null;
  const instructions = `重新判定以下原判定：${summary ?? '（原判定无摘要）'}`;
  if (entry.questionType === 'noul') {
    return {
      ok: true,
      plan: {
        questions: {
          [ARBITER_QUESTION_ID]: {
            type: 'noul',
            instructions,
            criteria: { true: '原判定成立', false: '原判定不成立' },
          },
        },
        original: {
          value: entry.payload.value,
          confidence: entry.payload.confidence,
        },
        type: 'noul',
        summary,
      },
    };
  }
  if (entry.questionType === 'choice') {
    const distribution = entry.payload.distribution;
    const options =
      distribution !== null &&
      typeof distribution === 'object' &&
      !Array.isArray(distribution)
        ? Object.keys(distribution as Record<string, unknown>)
        : [];
    const fallback =
      typeof entry.payload.value === 'string' && entry.payload.value !== ''
        ? [entry.payload.value]
        : [];
    const candidates = options.length > 0 ? options : fallback;
    if (candidates.length === 0) {
      return {
        ok: false,
        error: decisionError(
          'invalid-arguments',
          '原条目没有可重建的候选集（distribution 与 value 均缺失）',
        ),
      };
    }
    const criteria: Record<string, string> = {};
    for (const option of candidates) {
      criteria[option] = `候选方案「${option}」`;
    }
    return {
      ok: true,
      plan: {
        questions: {
          [ARBITER_QUESTION_ID]: {
            type: 'choice',
            instructions,
            criteria,
          },
        },
        original: {
          value: entry.payload.value,
          confidence: entry.payload.confidence,
        },
        type: 'choice',
        summary,
      },
    };
  }
  return {
    ok: false,
    error: decisionError(
      'invalid-arguments',
      `原判定题型为 ${entry.questionType ?? 'null'}，仲裁口径只覆盖 noul / choice（契约 §3.10）`,
      { details: { questionType: entry.questionType ?? null } },
    ),
  };
}

/** 直接给 question 时的题目计划（无原判定 → disagreement = false）。 */
export function buildArbiterQuestionFromPlan(
  plan: NonNullable<ArbiterPlan['question']>,
): ArbiterQuestionPlan {
  if (plan.type === 'gate') {
    const gatePlan: GatePlan = {
      action: plan.action ?? '',
      context: plan.context,
      riskLevel: 'medium',
      policyId: null,
    };
    return {
      questions: buildGateQuestions(gatePlan),
      original: null,
      type: 'gate',
      summary: plan.action,
    };
  }
  if (plan.type === 'choice') {
    return {
      questions: {
        [ARBITER_QUESTION_ID]: {
          type: 'choice',
          instructions: plan.instructions ?? '',
          criteria: plan.criteria ?? {},
        },
      },
      original: null,
      type: 'choice',
      summary: plan.instructions,
    };
  }
  return {
    questions: {
      [ARBITER_QUESTION_ID]: {
        type: 'noul',
        instructions: plan.instructions ?? '',
      },
    },
    original: null,
    type: 'noul',
    summary: plan.instructions,
  };
}

// ── verdict 映射与比较 ──────────────────────────────────────────────

export interface ArbiterVerdict {
  verdict: string;
  confidence: number | null;
  detail: string;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function truncateDetail(text: string): string {
  return text.length <= ARBITER_DETAIL_MAX
    ? text
    : `${text.slice(0, ARBITER_DETAIL_MAX - 1)}…`;
}

function answerNumber(answer: JudgeAnswer | undefined): number | null {
  if (!answer) return null;
  return typeof answer.value === 'number' && Number.isFinite(answer.value)
    ? answer.value
    : null;
}

/**
 * 裁判答案 → verdict（契约 §3.10）。
 *
 * - noul：`P(yes) ≥ 0.5` → `yes`，否则 `no`；
 * - choice：裁判给出的候选标签；
 * - gate：复用 gate 的三题口径（allow / human / revise）→
 *   `allow` / `revise` / `block` / `escalate`。
 */
export function mapArbiterVerdict(
  plan: ArbiterQuestionPlan,
  result: JudgeResult,
  gateThreshold: number = DEFAULT_GATE_ALLOW_THRESHOLD,
): ArbiterVerdict {
  if (plan.type === 'gate') {
    const allow = answerNumber(result.answers[GATE_QUESTION_IDS.allow]) ?? 0;
    const human = answerNumber(result.answers[GATE_QUESTION_IDS.human]) ?? 0;
    const revise = answerNumber(result.answers[GATE_QUESTION_IDS.revise]) ?? 0;
    const decision = decideVerdict({ allow, human, revise }, gateThreshold);
    return {
      verdict: decision.verdict,
      confidence: decision.confidence,
      detail: truncateDetail(
        `裁判三问判定 ${decision.verdict}：allow=${round4(allow)} human=${round4(human)} revise=${round4(revise)}`,
      ),
    };
  }
  const answer = result.answers[ARBITER_QUESTION_ID];
  if (plan.type === 'noul') {
    const pYes = answerNumber(answer) ?? 0;
    const verdict = pYes >= ARBITER_NO_THRESHOLD ? 'yes' : 'no';
    return {
      verdict,
      confidence: answer?.confidence ?? null,
      detail: truncateDetail(
        `裁判重新判定 P(yes)=${round4(pYes)}，结论 ${verdict}`,
      ),
    };
  }
  const label = typeof answer?.value === 'string' ? answer.value : '';
  return {
    verdict: label,
    confidence: answer?.confidence ?? null,
    detail: truncateDetail(`裁判选择「${label}」`),
  };
}

/**
 * 与原判定比较（契约 §3.10）。
 *
 * - noul：`|P(yes)_judge − P(yes)_original| > 0.10` → 不一致；
 * - choice：选项不同 → 不一致；
 * - 无原判定 → false。
 *
 * **只表示两次判定不一致，不代表谁对**——这里只产出布尔值，不给倾向性结论。
 */
export function computeArbiterDisagreement(
  plan: ArbiterQuestionPlan,
  result: JudgeResult,
): boolean {
  const original = plan.original;
  if (original === null) return false;
  if (plan.type === 'noul') {
    const judgeP = answerNumber(result.answers[ARBITER_QUESTION_ID]);
    const originalP =
      typeof original.value === 'number' && Number.isFinite(original.value)
        ? original.value
        : null;
    if (judgeP === null || originalP === null) return false;
    return Math.abs(judgeP - originalP) > ARBITER_DISAGREEMENT_THRESHOLD;
  }
  if (plan.type === 'choice') {
    const judgeLabel = result.answers[ARBITER_QUESTION_ID]?.value;
    if (typeof judgeLabel !== 'string') return false;
    const originalLabel =
      typeof original.value === 'string' ? original.value : null;
    if (originalLabel === null) return false;
    return judgeLabel !== originalLabel;
  }
  return false;
}

// ── 运行入口 ────────────────────────────────────────────────────────

export interface ArbiterDeps extends JudgeDeps {
  readConfig(): ResolvedToolsConfig;
}

export function errorBody(error: DecisionErrorEnvelope): {
  ok: false;
  error: JsonValue;
} {
  return { ok: false, error: error as unknown as JsonValue };
}

/** 仲裁主流程：重建题目 → 走裁判通道 → 映射 verdict 与 disagreement。 */
export async function runArbiter(
  args: unknown,
  exec: { signal?: AbortSignal } | undefined,
  deps: ArbiterDeps,
): Promise<
  ({ ok: true } & Record<string, unknown>) | { ok: false; error: JsonValue }
> {
  let config: ResolvedToolsConfig;
  try {
    config = deps.readConfig();
  } catch {
    return errorBody(
      decisionError('model-call-failed', '读取配置失败', {
        details: { stage: 'read-config' },
      }),
    );
  }
  const disabled = checkToolEnabled(config, ARBITER_TOOL);
  if (disabled) return errorBody(disabled);
  const planned = planArbiter(args);
  if (!planned.ok) return errorBody(planned.error);
  const { decisionId, question, state } = planned.plan;

  let questionPlan: ArbiterQuestionPlan;
  if (decisionId !== null) {
    const ledger = deps.ledger;
    if (!ledger) {
      return errorBody(
        decisionError(
          'invalid-arguments',
          '未启用账本（ledgerEnabled=false），无法按 decisionId 仲裁；请改用 question 形态',
          { details: { decisionId } },
        ),
      );
    }
    const entry = ledger.findById(decisionId);
    if (!entry || entry.status !== 'ok') {
      return errorBody(
        decisionError(
          'decision-not-found',
          '账本里没有这条可仲裁的判定（不存在、已滚动淘汰或不是成功判定）',
          { details: { decisionId } },
        ),
      );
    }
    const rebuilt = buildArbiterQuestionFromEntry(entry);
    if (!rebuilt.ok) return errorBody(rebuilt.error);
    questionPlan = rebuilt.plan;
  } else {
    questionPlan = buildArbiterQuestionFromPlan(
      question as NonNullable<ArbiterPlan['question']>,
    );
  }

  const detailState =
    state ??
    (decisionId
      ? `原判定 ${decisionId}：${questionPlan.summary ?? '（无摘要）'}`
      : `仲裁问题：${questionPlan.summary ?? '（无摘要）'}`);
  const outcome: JudgeOutcome = await judgeOnce(deps, {
    mode: 'explicit-arbiter',
    tool: ARBITER_TOOL,
    state: detailState,
    questions: questionPlan.questions,
    timeoutMs: config.fallbackTimeoutMs,
    ...(exec?.signal ? { signal: exec.signal } : {}),
    questionSummaries: {
      [ARBITER_QUESTION_ID]: questionPlan.summary ?? '仲裁问题',
    },
  });
  if (!outcome.ok) return errorBody(outcome.error);
  const result = outcome.result;
  // gate 路径的放行阈值跟 gate 工具读同一处配置（gateAllowThreshold），
  // 否则同一动作在 decision_gate 与 decision_arbiter 下可能得到不同 verdict。
  const mapped = mapArbiterVerdict(
    questionPlan,
    result,
    gateAllowThresholdOf(config),
  );
  const disagreement = computeArbiterDisagreement(questionPlan, result);
  return {
    ok: true,
    verdict: mapped.verdict,
    confidence: mapped.confidence,
    disagreement,
    detail: mapped.detail,
    source: 'llm-judge',
    mode: 'explicit-arbiter',
    ...(questionPlan.original === null
      ? {}
      : {
          original: {
            value: questionPlan.original.value,
            confidence: questionPlan.original.confidence,
          },
        }),
  };
}

export function createArbiterTool(deps: ArbiterDeps): ToolDefinition {
  return defineTool({
    name: ARBITER_TOOL,
    description: ARBITER_DESCRIPTION,
    parameters: ARBITER_PARAMETERS,
    output: ARBITER_OUTPUT,
    async execute(
      args: unknown,
      exec: { signal?: AbortSignal },
    ): Promise<ArbiterOutput> {
      try {
        const result = await runArbiter(args, exec, deps);
        return result as unknown as ArbiterOutput;
      } catch (thrown) {
        // 契约 §1.1：工具失败一律返回错误信封，绝不把异常抛给宿主
        // （抛出去会被宿主包装成通用错误、丢掉错误码）。
        const message =
          thrown instanceof Error ? thrown.message : String(thrown);
        return {
          ok: false,
          error: {
            code: 'model-call-failed',
            message: `工具内部异常：${message}`.slice(0, 200),
            retryable: false,
            details: { stage: 'unexpected' },
          },
        } as unknown as ArbiterOutput;
      }
    },
  }) as ToolDefinition;
}
