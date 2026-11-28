/**
 * decision_recheck：判定复检与漂移报告（决策工具系列 8/11）。
 *
 * 契约来源：docs/decision-tools-contract.md §3.8（入参/出参/漂移口径定稿）、
 * §5.2（decisionId 与 recheckOf 关联）、§8（统一调用层：记账/预算闸/兜底挂点）。
 *
 * 复检本身是一次**新的**模型判定，因此走统一调用层：预算闸先于出网、
 * 记账落新条目（tool=decision_recheck、mode=recheck、recheckOf=原 id）、
 * 兜底挂点同样生效（契约 §3.8/§5.2）。
 *
 * 输出有界：只回 { old, new, drift }——不回灌原 state 原文、题目全文或
 * 任何上下文（契约 §1.1）。原条目找不到一律 decision-not-found，绝不猜。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type {
  InferValue,
  ToolDefinition,
  ToolRunContext,
} from '@deepseek-ai/dsh-tools';

import type { ResolvedToolsConfig } from '../config/index.ts';
import {
  DECISION_ID_PATTERN,
  checkToolEnabled,
  runDecisionCall,
  type DecisionCallDeps,
  type LedgerEntry,
} from '../runtime/index.ts';
import {
  decisionError,
  type DecisionErrorEnvelope,
} from '../systemone/errors.ts';
import type { JsonValue, SystemOneQuestion } from '../systemone/types.ts';

export const RECHECK_TOOL = 'decision_recheck' as const;

/** 漂移阈值（契约 §3.8 定稿表）。 */
export const RECHECK_VALUE_THRESHOLD = 0.1;
export const RECHECK_CONFIDENCE_THRESHOLD = 0.05;

export const RECHECK_DESCRIPTION = [
  'Purpose: re-run one past decision judgement against a (possibly new) state and report how far the judgement drifted.',
  'Constraints: the decisionId must exist in the ledger (never guessed, never matched approximately); the drift table covers noul, choice and score only; output is bounded to { decisionId, old, new, drift } with no state or context echo.',
  'Actions: locate the original ledger entry; re-ask the same question shape; compare value and confidence against the recorded judgement; the recheck itself is recorded as a new ledger entry linked to the original.',
  'Output is bounded: { ok, decisionId, old{value,confidence,ts,questionType,questionSummary}, new{value,confidence,ts}, drift{changed,kind,magnitude} } or { ok:false, error }.',
].join(' ');

export const RECHECK_PARAMETERS = {
  decisionId: {
    type: 'string' as const,
    required: true as const,
    description:
      '要复检的原判定 id（dec_ + 26 位 Crockford Base32）；账本中不存在时返回 decision-not-found。',
  },
  state: {
    oneOf: [
      { type: 'string' as const },
      { type: 'object' as const, additionalProperties: true as const },
    ] as const,
    description:
      '复检用的新状态（字符串或对象）；缺省时用原判定的摘要重建状态（原 state 原文不入账本，见契约 §5.1）。',
  },
} as const;

export const RECHECK_OUTPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: true as const,
  properties: {
    ok: { type: 'boolean' as const, required: true as const },
    decisionId: {
      type: 'string' as const,
      description: '本次复检产生的新条目 id（账本中 recheckOf 指向原条目）。',
    },
    old: {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: {
        value: { type: 'json' as const },
        confidence: {
          oneOf: [
            { type: 'number' as const },
            { type: 'null' as const },
          ] as const,
        },
        ts: { type: 'string' as const, required: true as const },
        questionType: {
          oneOf: [
            { type: 'string' as const },
            { type: 'null' as const },
          ] as const,
        },
        questionSummary: {
          oneOf: [
            { type: 'string' as const },
            { type: 'null' as const },
          ] as const,
        },
      },
    },
    new: {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: {
        value: { type: 'json' as const },
        confidence: {
          oneOf: [
            { type: 'number' as const },
            { type: 'null' as const },
          ] as const,
        },
        ts: { type: 'string' as const, required: true as const },
      },
    },
    drift: {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: {
        changed: { type: 'boolean' as const, required: true as const },
        kind: {
          type: 'string' as const,
          required: true as const,
          description:
            'none | value | confidence | both（value 优先于 confidence）。',
        },
        magnitude: { type: 'number' as const, required: true as const },
      },
    },
    error: {
      type: 'object' as const,
      additionalProperties: true as const,
    },
  },
} as const;

// ── 入参规划 ─────────────────────────────────────────────────────────

/** recheck 出参类型（由 schema 推断，工具 execute 需精确匹配）。 */
export type RecheckOutput = InferValue<typeof RECHECK_OUTPUT_SCHEMA>;

export interface RecheckPlan {
  decisionId: string;
  state: string | Record<string, unknown> | null;
}

export function planRecheck(
  args: unknown,
):
  | { ok: true; plan: RecheckPlan }
  | { ok: false; error: DecisionErrorEnvelope } {
  if (typeof args !== 'object' || args === null) {
    return {
      ok: false,
      error: decisionError('invalid-arguments', 'recheck 入参必须是对象'),
    };
  }
  const raw = args as { decisionId?: unknown; state?: unknown };
  if (typeof raw.decisionId !== 'string' || raw.decisionId.trim() === '') {
    return {
      ok: false,
      error: decisionError(
        'invalid-arguments',
        'decisionId 必填且必须是非空字符串',
      ),
    };
  }
  const decisionId = raw.decisionId.trim();
  if (!DECISION_ID_PATTERN.test(decisionId)) {
    return {
      ok: false,
      error: decisionError(
        'decision-id-invalid',
        'decisionId 格式非法（dec_ + 26 位 Crockford Base32）',
        { details: { decisionId } },
      ),
    };
  }
  let state: string | Record<string, unknown> | null = null;
  if (raw.state !== undefined && raw.state !== null) {
    if (typeof raw.state === 'string') {
      state = raw.state;
    } else if (typeof raw.state === 'object' && !Array.isArray(raw.state)) {
      state = raw.state as Record<string, unknown>;
    } else {
      return {
        ok: false,
        error: decisionError(
          'invalid-arguments',
          'state 只接受字符串或对象（数组/数字等一律拒绝）',
        ),
      };
    }
  }
  return { ok: true, plan: { decisionId, state } };
}

// ── 复检题目重建 ─────────────────────────────────────────────────────

export interface RecheckQuestionPlan {
  qid: string;
  question: SystemOneQuestion;
  summary: string | null;
}

/**
 * 从账本条目重建复检题目。
 *
 * 账本按契约 §5.1 **不保存 state 原文与题目全文**，因此复检题目只能由
 * 条目里已有的信息重建：题型（questionType）+ 问题摘要（questionSummary）
 * + 判定分布（distribution / legend）。
 * - noul：二元判定，criteria 固定 true/false。
 * - choice：候选集取自 distribution 的键（原判定的选项集合）。
 * - score：档位取自 legend（缺失时按 distribution 长度兜底）。
 */
export function buildRecheckQuestion(
  entry: LedgerEntry,
):
  | { ok: true; plan: RecheckQuestionPlan }
  | { ok: false; error: DecisionErrorEnvelope } {
  const qid = entry.questionId ?? 'recheck';
  const summary = entry.questionSummary ?? null;
  const instructions = `复检以下原判定：${summary ?? '（原判定无摘要）'}`;
  const questionType = entry.questionType;
  if (questionType === 'noul') {
    return {
      ok: true,
      plan: {
        qid,
        summary,
        question: {
          type: 'noul',
          instructions,
          criteria: {
            true: '复检结论与原判定一致（判定为真）',
            false: '复检结论与原判定不一致（判定为假）',
          },
        },
      },
    };
  }
  if (questionType === 'choice') {
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
          { details: { decisionId: entry.decisionId } },
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
        qid,
        summary,
        question: { type: 'choice', instructions, criteria },
      },
    };
  }
  if (questionType === 'score') {
    const legend = entry.payload.legend;
    const levels =
      legend !== null && legend.length > 0
        ? legend
        : Array.isArray(entry.payload.distribution)
          ? entry.payload.distribution.map((_item, index) => `档位 ${index}`)
          : [];
    if (levels.length === 0) {
      return {
        ok: false,
        error: decisionError(
          'invalid-arguments',
          '原条目没有可重建的评分档位（legend 与 distribution 均缺失）',
          { details: { decisionId: entry.decisionId } },
        ),
      };
    }
    return {
      ok: true,
      plan: {
        qid,
        summary,
        question: { type: 'score', instructions, criteria: levels },
      },
    };
  }
  return {
    ok: false,
    error: decisionError(
      'invalid-arguments',
      `原判定题型为 ${questionType ?? 'null'}，漂移口径只覆盖 noul / choice / score（契约 §3.8）`,
      { details: { questionType: questionType ?? null } },
    ),
  };
}

/** 复检 state：给了就用新的；没给就用原摘要重建（原 state 原文不在账本里）。 */
export function buildRecheckState(
  plan: RecheckPlan,
  entry: LedgerEntry,
): string {
  if (plan.state !== null) {
    return typeof plan.state === 'string'
      ? plan.state
      : JSON.stringify(plan.state);
  }
  const summary = entry.questionSummary ?? '（原判定无摘要）';
  return `复检原判定 ${plan.decisionId}：${summary}`;
}

// ── 漂移计算 ─────────────────────────────────────────────────────────

export type DriftKind = 'none' | 'value' | 'confidence' | 'both';

export interface DriftResult {
  changed: boolean;
  kind: DriftKind;
  magnitude: number;
}

const round4 = (value: number): number => Math.round(value * 10000) / 10000;

export function computeDrift(
  questionType: 'noul' | 'choice' | 'score',
  oldValue: JsonValue | null,
  newValue: JsonValue | null,
  oldConfidence: number | null,
  newConfidence: number | null,
): DriftResult {
  let valueChanged = false;
  let magnitude = 0;
  if (questionType === 'choice') {
    const oldText = oldValue === null ? null : String(oldValue);
    const newText = newValue === null ? null : String(newValue);
    valueChanged = oldText !== null && newText !== null && oldText !== newText;
    magnitude = valueChanged ? 1 : 0;
  } else {
    const oldNumber = typeof oldValue === 'number' ? oldValue : null;
    const newNumber = typeof newValue === 'number' ? newValue : null;
    if (oldNumber !== null && newNumber !== null) {
      const delta = Math.abs(newNumber - oldNumber);
      valueChanged = delta > RECHECK_VALUE_THRESHOLD;
      magnitude = valueChanged ? round4(delta) : 0;
    }
  }
  let confidenceChanged = false;
  let confidenceDelta = 0;
  if (oldConfidence !== null && newConfidence !== null) {
    confidenceDelta = Math.abs(newConfidence - oldConfidence);
    confidenceChanged = confidenceDelta > RECHECK_CONFIDENCE_THRESHOLD;
  }
  const kind: DriftKind = valueChanged
    ? confidenceChanged
      ? 'both'
      : 'value'
    : confidenceChanged
      ? 'confidence'
      : 'none';
  return {
    changed: kind !== 'none',
    kind,
    magnitude: valueChanged
      ? magnitude
      : confidenceChanged
        ? round4(confidenceDelta)
        : 0,
  };
}

// ── 主流程 ───────────────────────────────────────────────────────────

function errorBody(error: DecisionErrorEnvelope): Record<string, JsonValue> {
  return { ok: false, error: error as unknown as JsonValue };
}

export interface RecheckDeps extends DecisionCallDeps {
  readConfig(): ResolvedToolsConfig;
}

export async function runRecheck(
  args: unknown,
  exec: ToolRunContext,
  deps: RecheckDeps,
): Promise<Record<string, JsonValue>> {
  // 契约 §1.3：开关优先于一切（模型未配置 / 参数校验）。开关关闭时直接 tool-disabled，
  // 不做参数校验与账本查找——避免「开关关 + id 非法」时先报 decision-id-invalid。
  let config: ResolvedToolsConfig;
  try {
    config = deps.readConfig();
  } catch (thrown) {
    return errorBody(
      decisionError('model-call-failed', '读取配置失败', {
        retryable: false,
        details: {
          stage: 'read-config',
          message: thrown instanceof Error ? thrown.message : String(thrown),
        },
      }),
    );
  }
  const disabled = checkToolEnabled(config, RECHECK_TOOL);
  if (disabled) return errorBody(disabled);

  const planned = planRecheck(args);
  if (!planned.ok) return errorBody(planned.error);
  const plan = planned.plan;

  const original = deps.ledger?.findById(plan.decisionId);
  if (!original) {
    return errorBody(
      decisionError(
        'decision-not-found',
        '账本中找不到该 decisionId（可能已被滚动淘汰）',
        { details: { decisionId: plan.decisionId } },
      ),
    );
  }
  if (original.status !== 'ok') {
    return errorBody(
      decisionError(
        'decision-not-found',
        `账本中的该条目不是成功判定（status=${original.status}），无可复检的判定值`,
        { details: { decisionId: plan.decisionId, status: original.status } },
      ),
    );
  }

  const built = buildRecheckQuestion(original);
  if (!built.ok) return errorBody(built.error);
  const questionPlan = built.plan;

  const call = await runDecisionCall(deps, {
    tool: RECHECK_TOOL,
    mode: 'recheck',
    state: buildRecheckState(plan, original),
    questions: { [questionPlan.qid]: questionPlan.question },
    questionSummaries: questionPlan.summary
      ? { [questionPlan.qid]: questionPlan.summary }
      : undefined,
    recheckOf: plan.decisionId,
    signal: exec.signal,
  });
  if (!call.ok) {
    return errorBody(call.error as unknown as DecisionErrorEnvelope);
  }

  // 契约 §2.4：上游丢题或返回形状非法 → 该题没有判定，绝不拿旧值充数。
  const dropped = call.droppedQuestionIds.includes(questionPlan.qid);
  const invalid = call.invalidAnswers.some(
    (item) => item.questionId === questionPlan.qid,
  );
  if (dropped || invalid) {
    return errorBody(
      decisionError(
        'model-invalid-response',
        dropped
          ? '复检调用未返回该题的判定（上游丢题）'
          : '复检调用返回的判定不符合题型口径',
        {
          retryable: true,
          details: { questionId: questionPlan.qid, dropped },
        },
      ),
    );
  }

  const newDecisionId = call.decisionIds[questionPlan.qid];
  if (!newDecisionId) {
    // 统一调用层成功即必分配新 id；这里不允许退回原 id 冒充新判定（契约 §3.8：出参 decisionId 是新条目 id）。
    return errorBody(
      decisionError(
        'model-invalid-response',
        '复检调用未返回新判定的 decisionId（内部状态异常）',
        { retryable: false, details: { questionId: questionPlan.qid } },
      ),
    );
  }
  const fresh = deps.ledger?.findById(newDecisionId);
  const newValue = fresh ? fresh.payload.value : null;
  const newConfidence = fresh ? fresh.payload.confidence : null;
  const newTs = fresh ? fresh.ts : new Date().toISOString();

  const questionType =
    original.questionType === 'noul' ||
    original.questionType === 'choice' ||
    original.questionType === 'score'
      ? original.questionType
      : 'noul';
  const drift = computeDrift(
    questionType,
    original.payload.value,
    newValue,
    original.payload.confidence,
    newConfidence,
  );

  return {
    ok: true,
    decisionId: newDecisionId,
    old: {
      value: original.payload.value,
      confidence: original.payload.confidence,
      ts: original.ts,
      questionType: original.questionType,
      questionSummary: original.questionSummary,
    },
    new: {
      value: newValue,
      confidence: newConfidence,
      ts: newTs,
    },
    drift: {
      changed: drift.changed,
      kind: drift.kind,
      magnitude: drift.magnitude,
    },
  };
}

export function createRecheckTool(deps: RecheckDeps): ToolDefinition {
  return defineTool({
    name: RECHECK_TOOL,
    description: RECHECK_DESCRIPTION,
    parameters: RECHECK_PARAMETERS,
    output: {
      schema: RECHECK_OUTPUT_SCHEMA,
      render: (_args, value) => [
        { type: 'text' as const, text: JSON.stringify(value) },
      ],
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<RecheckOutput> {
      try {
        return (await runRecheck(args, exec, deps)) as unknown as RecheckOutput;
      } catch (thrown) {
        const message =
          thrown instanceof Error ? thrown.message : String(thrown);
        return {
          ok: false,
          error: {
            code: 'model-call-failed',
            message: `工具内部异常：${message}`,
            retryable: false,
            details: { stage: 'unexpected' },
          },
        } as unknown as RecheckOutput;
      }
    },
  }) as ToolDefinition;
}
