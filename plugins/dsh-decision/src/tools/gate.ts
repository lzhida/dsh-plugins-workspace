/**
 * decision_gate 闸门工具（决策工具系列 3/11）。
 *
 * 契约来源：docs/decision-tools-contract.md §3.2（gate）、§2（systemone 形状）、
 * §1.1（返回信封）、§11（D1–D6）。
 *
 * 硬纪律（写在动作前）：
 * - 危险动作执行前强制过一道；输出只有 allow / revise / block / escalate 四值；
 * - **绝不 fail-open**：模型拿不准、题被丢弃、阈值落在灰区，一律 escalate；
 * - 不返回模型散文，reasons/rationale 由内部固定口径派生。
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
import {
  runDecisionCall,
  runFallbackJudge,
  runLowConfidenceFallback,
  type DecisionCallDeps,
  type DecisionCallOk,
  type DecisionCallRequest,
} from '../runtime/call.ts';
import { gateAllowThresholdOf } from '../runtime/guard.ts';
import type { ResolvedToolsConfig } from '../config/decision-tools.ts';
import {
  buildJudgementPrompt,
  stringifyDetail,
  type JudgementPromptParts,
} from './prompt.ts';

// ── 常量与 schema ───────────────────────────────────────────────────

export const GATE_TOOL = 'decision_gate';
export const GATE_ACTION_MAX = 500;

/** 内部三题（题 id 稳定，便于记账与定位）。 */
export const GATE_QUESTION_IDS = {
  allow: 'gate.allow',
  human: 'gate.human',
  revise: 'gate.revise',
} as const;

export type GateVerdict = 'allow' | 'revise' | 'block' | 'escalate';

export const GATE_DESCRIPTION = [
  'Gate a risky action before it runs: judge it and return exactly one verdict — allow, revise, block, or escalate.',
  'Never fail open: if the judgement is uncertain, a question is unanswered, or the probability sits in the grey zone, return escalate instead of allow.',
  'Actions: 1) validate the action text; 2) ask three internal yes/no questions (may run? needs human? must revise first?); 3) map probabilities to one verdict.',
  'Constraints: action text up to 500 characters; context optional; riskLevel is advisory only; output is a bounded verdict plus up to 5 short reasons — never model prose.',
  'Verdicts: block when P(allow) < 0.2; escalate when human intervention is likely or P(allow) is below the configured threshold; revise when allow is likely but a change is required; allow only when allow is likely and no intervention or revision is indicated.',
].join(' ');

export const GATE_PARAMETERS = {
  action: {
    type: 'string' as const,
    required: true as const,
    description:
      'The action about to be taken, described in one sentence (max 500 characters).',
  },
  context: {
    oneOf: [
      { type: 'string' as const },
      { type: 'object' as const, additionalProperties: true as const },
    ] as const,
    description:
      'Optional risk-relevant context (what is affected, blast radius, reversibility); plain text or a JSON object.',
  },
  riskLevel: {
    type: 'string' as const,
    enum: ['low', 'medium', 'high'],
    description:
      'Advisory risk level: low | medium | high (default medium). Recorded, does not change the mapping.',
  },
  policyId: {
    type: 'string' as const,
    description:
      'Optional external policy id, recorded with the decision only (never affects the verdict).',
  },
};

const GATE_OUTPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: true as const,
  properties: {
    ok: { type: 'boolean' as const, required: true as const },
    verdict: {
      type: 'string' as const,
      enum: ['allow', 'revise', 'block', 'escalate'],
    },
    confidence: {
      oneOf: [{ type: 'number' as const }, { type: 'null' as const }] as const,
    },
    reasons: {
      type: 'array' as const,
      items: { type: 'string' as const },
    },
    rationale: { type: 'string' as const },
    decisionId: {
      oneOf: [{ type: 'string' as const }, { type: 'null' as const }] as const,
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

export const GATE_OUTPUT = {
  schema: GATE_OUTPUT_SCHEMA,
  render: (_args: unknown, value: unknown) => [
    { type: 'text' as const, text: JSON.stringify(value) },
  ],
};

export type GateOutput = InferValue<typeof GATE_OUTPUT_SCHEMA>;

// ── 入参校验 ────────────────────────────────────────────────────────

export interface GatePlan {
  action: string;
  context: string | undefined;
  riskLevel: 'low' | 'medium' | 'high';
  policyId: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function planGate(
  args: unknown,
): { ok: true; plan: GatePlan } | { ok: false; error: DecisionErrorEnvelope } {
  if (!isPlainObject(args)) {
    return {
      ok: false,
      error: decisionError('invalid-arguments', 'gate 入参必须是对象'),
    };
  }
  const action = args.action;
  if (typeof action !== 'string' || action.trim() === '') {
    return {
      ok: false,
      error: decisionError('invalid-arguments', 'action 必须是非空字符串'),
    };
  }
  if (action.length > GATE_ACTION_MAX) {
    return {
      ok: false,
      error: decisionError(
        'invalid-arguments',
        `action 超过 ${GATE_ACTION_MAX} 字符上限`,
      ),
    };
  }
  const rawContext = args.context;
  let context: string | undefined;
  if (rawContext !== undefined && rawContext !== null) {
    if (typeof rawContext === 'string') {
      context = rawContext;
    } else if (isPlainObject(rawContext)) {
      context = stringifyDetail(rawContext as JsonValue);
    } else {
      return {
        ok: false,
        error: decisionError('invalid-arguments', 'context 必须是字符串或对象'),
      };
    }
  }
  const rawRisk = args.riskLevel;
  let riskLevel: 'low' | 'medium' | 'high' = 'medium';
  if (rawRisk !== undefined && rawRisk !== null) {
    if (rawRisk !== 'low' && rawRisk !== 'medium' && rawRisk !== 'high') {
      return {
        ok: false,
        error: decisionError(
          'invalid-arguments',
          'riskLevel 只接受 low / medium / high',
        ),
      };
    }
    riskLevel = rawRisk;
  }
  const rawPolicy = args.policyId;
  let policyId: string | null = null;
  if (rawPolicy !== undefined && rawPolicy !== null) {
    if (typeof rawPolicy !== 'string') {
      return {
        ok: false,
        error: decisionError('invalid-arguments', 'policyId 必须是字符串'),
      };
    }
    policyId = rawPolicy;
  }
  return { ok: true, plan: { action, context, riskLevel, policyId } };
}

// ── 内部题干 ────────────────────────────────────────────────────────

/** 三题共用同一组 noul criteria（固定口径，不取模型散文）。 */
const GATE_CRITERIA = {
  allow: { true: '满足放行条件', false: '不满足放行条件' },
  human: { true: '需要人工介入', false: '无需人工介入' },
  revise: { true: '需要先修改再执行', false: '可直接执行' },
};

export function buildGateQuestions(
  plan: GatePlan,
): Record<string, SystemOneQuestion> {
  return {
    [GATE_QUESTION_IDS.allow]: {
      type: 'noul',
      instructions: `动作「${plan.action}」在当前上下文中是否满足放行条件？`,
      criteria: GATE_CRITERIA.allow,
    },
    [GATE_QUESTION_IDS.human]: {
      type: 'noul',
      instructions: `动作「${plan.action}」是否需要人工介入确认？`,
      criteria: GATE_CRITERIA.human,
    },
    [GATE_QUESTION_IDS.revise]: {
      type: 'noul',
      instructions: `动作「${plan.action}」是否必须先修改才能执行？`,
      criteria: GATE_CRITERIA.revise,
    },
  };
}

export function buildGateState(plan: GatePlan): JsonValue {
  const parts: JudgementPromptParts = {
    purpose:
      'Decide whether the action below may run, judging three yes/no questions independently.',
    constraints: [
      'Judge only from DETAIL; do not assume facts that are not stated.',
      'Answer each of the three fixed question ids; never add or drop one.',
      'Be conservative: when the detail is insufficient, answer in the safer direction.',
    ],
    actions: [
      `${GATE_QUESTION_IDS.allow}: may this action run?`,
      `${GATE_QUESTION_IDS.human}: does it require human confirmation?`,
      `${GATE_QUESTION_IDS.revise}: must it be revised before it runs?`,
    ],
    detail: [
      `ACTION: ${plan.action}`,
      `RISK LEVEL: ${plan.riskLevel}`,
      ...(plan.context === undefined ? [] : [`CONTEXT: ${plan.context}`]),
    ].join('\n'),
  };
  return { message: buildJudgementPrompt(parts) } as JsonValue;
}

// ── verdict 映射（纯函数，可单测） ──────────────────────────────────

export interface GateProbabilities {
  allow: number;
  human: number;
  revise: number;
}

export interface GateDecision {
  verdict: GateVerdict;
  confidence: number | null;
  reasons: string[];
  rationale: string;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function formatRate(value: number): string {
  return `${round4(value * 100)}%`;
}

/**
 * 概率 → 四值 verdict（契约 §3.2 + 本卡实现口径）。
 *
 * 优先级：block → escalate(人工) → escalate(灰区) → revise → allow；兜底 escalate。
 */
export function decideVerdict(
  probabilities: GateProbabilities,
  threshold: number,
): GateDecision {
  const { allow, human, revise } = probabilities;
  const rationaleBase = `P(allow)=${formatRate(allow)} P(human)=${formatRate(human)} P(revise)=${formatRate(revise)}，阈值 ${formatRate(threshold)}`;

  if (allow < 0.2) {
    return {
      verdict: 'block',
      confidence: round4(1 - allow),
      reasons: [
        `放行概率仅 ${formatRate(allow)}，低于 20% 硬下限`,
        '模型倾向认为该动作不满足执行条件',
      ],
      rationale: `判定阻断：${rationaleBase}`,
    };
  }
  if (human >= 0.5) {
    return {
      verdict: 'escalate',
      // 契约 §3.2：escalate 的 confidence = max(P(human), 1−P(allow))。
      confidence: round4(Math.max(human, 1 - allow)),
      reasons: [
        `人工介入概率 ${formatRate(human)} 达到升级阈值`,
        '该动作影响面需要人确认后再执行',
      ],
      rationale: `判定升级：${rationaleBase}`,
    };
  }
  if (allow < threshold) {
    return {
      verdict: 'escalate',
      confidence: round4(Math.max(human, 1 - allow)),
      reasons: [
        `放行概率 ${formatRate(allow)} 未达放行阈值 ${formatRate(threshold)}`,
        '灰区不替调用方拍板，交由人工或上层决策',
      ],
      rationale: `判定升级（灰区）：${rationaleBase}`,
    };
  }
  if (revise >= 0.5) {
    return {
      verdict: 'revise',
      confidence: round4(revise),
      reasons: [
        `必改概率 ${formatRate(revise)} 达到必改阈值`,
        '建议先按修改意见调整动作再执行',
      ],
      rationale: `判定修改：${rationaleBase}`,
    };
  }
  return {
    verdict: 'allow',
    confidence: round4(allow),
    reasons: [
      `放行概率 ${formatRate(allow)} 达到阈值 ${formatRate(threshold)}`,
      `人工介入概率 ${formatRate(human)}、必改概率 ${formatRate(revise)} 均低于 50%`,
    ],
    rationale: `判定放行：${rationaleBase}`,
  };
}

function limitReasons(reasons: string[]): string[] {
  return reasons
    .slice(0, 5)
    .map((reason) =>
      reason.length > 120 ? `${reason.slice(0, 119)}…` : reason,
    );
}

function limitRationale(rationale: string): string {
  return rationale.length > 200 ? `${rationale.slice(0, 199)}…` : rationale;
}

// ── 主流程 ──────────────────────────────────────────────────────────

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

/** gate 主流程：校验 → 一次三题调用 → 概率映射四值 →（必要时）兜底裁判。 */
export async function runGate(
  args: unknown,
  exec: ToolRunContext,
  deps: DecisionCallDeps,
): Promise<Record<string, JsonValue>> {
  const planned = planGate(args);
  if (!planned.ok) return errorBody(planned.error);
  const { plan } = planned;

  const configResult = readConfigOrError(deps);
  if (!configResult.ok) return errorBody(configResult.error);
  const config = configResult.config;
  const threshold = gateAllowThresholdOf(config);

  const state = buildGateState(plan);
  const questions = buildGateQuestions(plan);
  const questionSummaries: Record<string, string> = {};
  for (const [id, question] of Object.entries(questions)) {
    questionSummaries[id] = question.instructions;
  }

  // 会话当前模型（best-effort；宿主没有公开 API，取不到就不传）。
  const sessionModel = deps.resolveSessionModel?.(exec) ?? undefined;
  const baseRequest: DecisionCallRequest = {
    tool: GATE_TOOL,
    state,
    questions,
    questionSummaries,
    // 契约 §3.2：riskLevel 参与判定并进 state；policyId 仅记录进账本（不进 state）。
    contextExtras: { riskLevel: plan.riskLevel, policyId: plan.policyId },
    ...(sessionModel === undefined ? {} : { sessionModel }),
    ...(exec.signal === undefined ? {} : { signal: exec.signal }),
  };

  const result = await runDecisionCall(deps, baseRequest);
  if (!result.ok) return errorBody(result.error);

  const primary = mapGateAnswers(result.answers, result.decisionIds, threshold);

  // 内部题缺失/形状不符 → 先试兜底裁判；裁判不可用才 escalate（不 fail-open）。
  if (primary.missing.length > 0) {
    const judged = await runFallbackJudge(deps, baseRequest, {
      kind: 'model-invalid-response',
      originalError: decisionError(
        'model-invalid-response',
        `有 ${primary.missing.length} 道内部题未得到合法判定`,
        { details: { missing: primary.missing } },
      ),
    });
    if (judged.kind === 'judged') {
      return buildGateOutput(judged.result, threshold);
    }
    // 兜底失败 → 维持 escalate + 标注兜底失败；兜底未触发（skipped）→ 整体省略
    // fallback 块（契约 §10.3「未触发时整体省略」）。
    if (judged.kind === 'failed') {
      return {
        ...primary.output,
        source: result.source,
        fallback: {
          triggered: false,
          trigger: 'model-invalid-response',
          route: null,
          originalSource: 'decision-model',
          originalConfidence: null,
          error: judged.error,
        },
      } as unknown as Record<string, JsonValue>;
    }
    return {
      ...primary.output,
      source: result.source,
    } as unknown as Record<string, JsonValue>;
  }

  // T3：置信度低于阈值 → 兜底裁判（拿不准不替调用方放行）。
  const fallbackOutcome = await runLowConfidenceFallback(deps, baseRequest, {
    lowestConfidence: primary.decision.confidence,
  });
  if (fallbackOutcome.kind === 'judged') {
    return buildGateOutput(fallbackOutcome.result, threshold);
  }
  if (fallbackOutcome.kind === 'failed') {
    return {
      ...primary.output,
      source: result.source,
      fallback: {
        triggered: false,
        trigger: 'low-confidence',
        route: null,
        originalSource: 'decision-model',
        originalConfidence: primary.decision.confidence,
        error: fallbackOutcome.error,
      },
    } as unknown as Record<string, JsonValue>;
  }
  return {
    ...primary.output,
    source: result.source,
  } as unknown as Record<string, JsonValue>;
}

/** 三题答案 → 概率 → 四值判定；缺题时给出 escalate（不 fail-open）。 */
function mapGateAnswers(
  answers: Record<string, SystemOneParsedAnswer>,
  decisionIds: Record<string, string>,
  threshold: number,
): {
  missing: string[];
  decision: GateDecision;
  output: Record<string, JsonValue>;
} {
  const allowAnswer = answers[GATE_QUESTION_IDS.allow];
  const humanAnswer = answers[GATE_QUESTION_IDS.human];
  const reviseAnswer = answers[GATE_QUESTION_IDS.revise];
  const decisionId = decisionIds[GATE_QUESTION_IDS.allow] ?? null;

  const missing: string[] = [];
  if (!allowAnswer || allowAnswer.kind !== 'noul')
    missing.push(GATE_QUESTION_IDS.allow);
  if (!humanAnswer || humanAnswer.kind !== 'noul')
    missing.push(GATE_QUESTION_IDS.human);
  if (!reviseAnswer || reviseAnswer.kind !== 'noul')
    missing.push(GATE_QUESTION_IDS.revise);
  if (missing.length > 0) {
    return {
      missing,
      decision: {
        verdict: 'escalate',
        confidence: null,
        reasons: limitReasons([
          `有 ${missing.length} 道内部题未得到合法判定（${missing.join(', ')}）`,
          '拿不准不替调用方放行，升级人工确认',
        ]),
        rationale: limitRationale('判定升级：内部判定不完整，无法评估放行风险'),
      },
      output: {
        ok: true,
        verdict: 'escalate',
        confidence: null,
        reasons: limitReasons([
          `有 ${missing.length} 道内部题未得到合法判定（${missing.join(', ')}）`,
          '拿不准不替调用方放行，升级人工确认',
        ]),
        rationale: limitRationale('判定升级：内部判定不完整，无法评估放行风险'),
        decisionId,
      } as unknown as Record<string, JsonValue>,
    };
  }

  const probabilities: GateProbabilities = {
    allow: (allowAnswer as { pYes: number }).pYes,
    human: (humanAnswer as { pYes: number }).pYes,
    revise: (reviseAnswer as { pYes: number }).pYes,
  };
  const decision = decideVerdict(probabilities, threshold);
  return {
    missing,
    decision,
    output: {
      ok: true,
      verdict: decision.verdict,
      confidence: decision.confidence,
      reasons: limitReasons(decision.reasons),
      rationale: limitRationale(decision.rationale),
      decisionId,
    } as unknown as Record<string, JsonValue>,
  };
}

/** 由（可能是兜底裁判的）判定结果组装 gate 出参。 */
function buildGateOutput(
  call: DecisionCallOk,
  threshold: number,
): Record<string, JsonValue> {
  const mapped = mapGateAnswers(call.answers, call.decisionIds, threshold);
  return {
    ...mapped.output,
    source: call.source,
    ...(call.fallback ? { fallback: call.fallback } : {}),
  } as unknown as Record<string, JsonValue>;
}

// ── 工具定义工厂 ────────────────────────────────────────────────────

/** 创建 decision_gate 工具定义（deps 由插件入口注入）。 */
export function createGateTool(deps: DecisionCallDeps): ToolDefinition {
  return defineTool({
    name: GATE_TOOL,
    description: GATE_DESCRIPTION,
    parameters: GATE_PARAMETERS,
    output: GATE_OUTPUT,
    async execute(args: unknown, exec: ToolRunContext): Promise<GateOutput> {
      try {
        const result = await runGate(args, exec, deps);
        return result as unknown as GateOutput;
      } catch (thrown) {
        return unexpectedErrorBody(thrown) as unknown as GateOutput;
      }
    },
  }) as ToolDefinition;
}
