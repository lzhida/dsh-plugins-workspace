/**
 * 兜底裁判入口（决策工具系列 7/11）。
 *
 * 契约来源：docs/decision-tools-contract.md §10.2（JudgeRequest / JudgeResult /
 * judgeOnce）与 §10.1（三条触发路径、不可递归、预算闸）。
 *
 * 设计要点（与 §10.2 一一对应）：
 * - **可复用模块**：10/11 的 `decision_arbiter` 显式裁判也走本入口，
 *   因此「防递归 + 预算闸 + 记账」三件事集中在本封装层生效。
 * - **不可递归**：本入口只调宿主 `ctx.llm`，**绝不**回调 `runDecisionCall`
 *   （那条链才带兜底挂点），所以裁判失败不会再触发第二次裁判。
 * - **裁判模型路由**：优先配置里的 `fallbackProvider` + `fallbackModel`；
 *   否则用会话当前模型（由调用方以 `sessionModel` 或 `resolveSessionModel()`
 *   传入）；两者都拿不到 → `arbiter-unavailable`（绝不猜模型）。
 * - **失败不抛异常**：一律返回 `{ ok:false, error }` 信封（契约 §1.1）。
 */

import {
  runDecisionCall as runHostDecisionCall,
  type DecisionLlmLike,
} from '../core/decision.ts';
import {
  decisionError,
  type DecisionErrorEnvelope,
} from '../systemone/errors.ts';
import type { JsonValue, SystemOneQuestion } from '../systemone/types.ts';
import type {
  DecisionToolName,
  ResolvedToolsConfig,
} from '../config/decision-tools.ts';
import type { BudgetGate } from './budget.ts';
import { newDecisionId } from './id.ts';
import { estimateCostUsd, truncateSummary, type LedgerSink } from './ledger.ts';

// ── 类型 ───────────────────────────────────────────────────────────────

/** 裁判模式：auto-fallback=级联兜底；explicit-arbiter=显式仲裁（10/11）。 */
export type JudgeMode = 'auto-fallback' | 'explicit-arbiter';

/** 裁判路由来源：explicit-config=配置显式指定；session-model=会话当前模型。 */
export type JudgeRouteOrigin = 'explicit-config' | 'session-model';

/** 裁判实际使用的模型路由。 */
export interface JudgeRoute {
  provider: string;
  model: string;
  origin: JudgeRouteOrigin;
}

/** 裁判可用题型（契约 §10.2：noul / choice / score）。 */
export type JudgeQuestionType = 'noul' | 'choice' | 'score';

export interface JudgeRequest {
  /** 裁判模式；与配置里的 fallbackMode 不匹配 → fallback-disabled。 */
  mode: JudgeMode;
  /** 记账归属工具；缺省 decision_arbiter。 */
  tool?: DecisionToolName;
  /** 判定上下文（与决策模型同一份 state）。 */
  state: unknown;
  /** 待判题目；题型只能是 noul / choice / score。 */
  questions: Record<string, SystemOneQuestion>;
  /** 单次裁判超时（毫秒）。 */
  timeoutMs: number;
  /** 上游取消信号。 */
  signal?: AbortSignal;
  /** 会话当前模型（由调用方解析后传入；优先于 resolveSessionModel）。 */
  sessionModel?: { provider: string; model: string } | null;
  /** qid → 人读摘要（≤120 字符截断后入账）。 */
  questionSummaries?: Record<string, string>;
}

/** 单题裁判答案。value 语义随题型：noul=P(yes)∈[0,1]、choice=候选标签、score=分数。 */
export interface JudgeAnswer {
  type: JudgeQuestionType;
  value: string | number | null;
  confidence: number | null;
  distribution: JsonValue | null;
  legend: string[] | null;
}

export interface JudgeUsage {
  calls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}

/** 裁判成功结果（契约 §10.2）。 */
export interface JudgeResult {
  answers: Record<string, JudgeAnswer>;
  source: 'llm-fallback-judge';
  mode: JudgeMode;
  route: JudgeRoute;
  usage: JudgeUsage;
  decisionIds: Record<string, string>;
}

export type JudgeOutcome =
  | { ok: true; result: JudgeResult }
  | { ok: false; error: DecisionErrorEnvelope; latencyMs: number };

/** 裁判入口依赖。 */
export interface JudgeDeps {
  readConfig(): ResolvedToolsConfig;
  /** 账本 sink；传入即由本入口记账（arbiter 路径）。级联路径传 undefined，由统一调用层代记。 */
  ledger?: LedgerSink;
  /** 预算闸（裁判受同一预算约束；judge=true 走 fallbackMaxCallsPerDay 独立配额）。 */
  budget?: BudgetGate;
  /** 宿主 ctx.llm（duck type，不引宿主类型）。 */
  llm?: DecisionLlmLike | undefined;
  /** 会话当前模型解析器（宿主内部投影，best-effort）。 */
  resolveSessionModel?: (
    exec?: unknown,
  ) => { provider: string; model: string } | null | undefined;
}

// ── 模式闸与路由解析 ───────────────────────────────────────────────────

/** 该模式在当前配置的 fallbackMode 下是否允许（§10.1）。 */
export function judgeModeAllowed(
  config: ResolvedToolsConfig,
  mode: JudgeMode,
): boolean {
  if (mode === 'auto-fallback') {
    return (
      config.fallbackMode === 'auto-fallback' || config.fallbackMode === 'both'
    );
  }
  return (
    config.fallbackMode === 'explicit-arbiter' || config.fallbackMode === 'both'
  );
}

/**
 * 解析裁判路由：显式配置优先，其次会话当前模型。
 * 两者都拿不到返回 null（调用方映射为 arbiter-unavailable）。
 */
export function resolveJudgeRoute(
  config: ResolvedToolsConfig,
  request: JudgeRequest,
  deps: Pick<JudgeDeps, 'resolveSessionModel'>,
): JudgeRoute | null {
  const provider = config.fallbackProvider.trim();
  const model = config.fallbackModel.trim();
  if (provider !== '' && model !== '') {
    return { provider, model, origin: 'explicit-config' };
  }
  const session = request.sessionModel ?? deps.resolveSessionModel?.() ?? null;
  if (
    session &&
    session.provider.trim() !== '' &&
    session.model.trim() !== ''
  ) {
    return {
      provider: session.provider.trim(),
      model: session.model.trim(),
      origin: 'session-model',
    };
  }
  return null;
}

// ── 提示词组装（D1 最小上下文 + D2 关键约束前置）────────────────────────

function stringifyDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail) ?? '';
  } catch {
    return '';
  }
}

function criteriaLines(question: SystemOneQuestion): string[] {
  const criteria = question.criteria;
  if (criteria === undefined || criteria === null) return [];
  if (Array.isArray(criteria)) {
    return criteria.map((level, index) => `  level ${index}: ${String(level)}`);
  }
  if (typeof criteria === 'object') {
    return Object.entries(criteria).map(
      ([label, description]) => `  ${label}: ${String(description)}`,
    );
  }
  return [];
}

/**
 * 组装裁判提示词。顺序固定：PURPOSE → CONSTRAINTS → ACTIONS → DETAIL →
 * QUESTIONS（关键约束写在动作前，契约 §11 D2）。
 */
export function buildJudgePrompt(request: JudgeRequest): string {
  const lines: string[] = [];
  lines.push('PURPOSE:');
  lines.push(
    'You are the fallback judge for a decision model call that failed or returned an unsure judgement. Answer every question with the most defensible answer.',
  );
  lines.push('CONSTRAINTS:');
  lines.push(
    '- Reply with ONE JSON object and nothing else: no prose, no markdown fence, no explanation.',
  );
  lines.push(
    '- Shape: {"answers":{"<questionId>":{"value":<answer>,"confidence":<0..1>}}}',
  );
  lines.push(
    '- noul: value is a number in [0,1] (probability that the answer is yes).',
  );
  lines.push(
    '- choice: value MUST be one of the candidate labels listed for that question.',
  );
  lines.push(
    '- score: value MUST be a number inside the listed scale range (0..levels-1).',
  );
  lines.push(
    '- confidence is optional; omit it when unsure (it is recorded as null, never guessed).',
  );
  lines.push(
    '- Never invent a label that is not listed. Never skip a question you can judge.',
  );
  lines.push('ACTIONS:');
  lines.push('- Judge each question independently against the detail below.');
  lines.push('- Emit the JSON object only.');
  lines.push('DETAIL:');
  lines.push(stringifyDetail(request.state));
  lines.push('QUESTIONS:');
  for (const [qid, question] of Object.entries(request.questions)) {
    lines.push(`- ${qid} (${question.type}): ${question.instructions}`);
    const extra = criteriaLines(question);
    if (extra.length > 0) {
      lines.push(...extra);
    }
  }
  return lines.join('\n');
}

// ── 答案解析与校验 ─────────────────────────────────────────────────────

/** 从模型文本里抽出第一个 JSON 对象（容忍 ```json 包裹与前后缀说明）。 */
export function extractJudgeJson(text: string): string | null {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return trimmed.slice(start, end + 1);
}

function candidateLabels(question: SystemOneQuestion): string[] {
  const criteria = question.criteria;
  if (criteria && typeof criteria === 'object' && !Array.isArray(criteria)) {
    return Object.keys(criteria as Record<string, JsonValue>);
  }
  return [];
}

function scaleLevels(question: SystemOneQuestion): number | null {
  const criteria = question.criteria;
  if (Array.isArray(criteria)) return criteria.length;
  return null;
}

function toPYes(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > 1) return null;
    return value;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'yes' || lowered === 'true') return 1;
    if (lowered === 'no' || lowered === 'false') return 0;
  }
  return null;
}

function toConfidence(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

/**
 * 解析并校验裁判答案。任一题缺失或非法 → 整个裁判失败
 * （绝不产出「无来源结论」，契约 §10.1 / 卡 7 清单第 7 项）。
 */
export function parseJudgeAnswers(
  text: string,
  questions: Record<string, SystemOneQuestion>,
): { answers: Record<string, JudgeAnswer> } | { error: DecisionErrorEnvelope } {
  const json = extractJudgeJson(text);
  if (json === null) {
    return {
      error: decisionError(
        'model-invalid-response',
        '裁判返回的内容不是 JSON，无法解析出结构化答案',
        { details: { stage: 'judge-parse' } },
      ),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {
      error: decisionError(
        'model-invalid-response',
        '裁判返回的 JSON 无法解析（可能是截断或非法转义）',
        { details: { stage: 'judge-parse' } },
      ),
    };
  }
  const container = parsed as { answers?: unknown } | null;
  const rawAnswers = container?.answers;
  if (
    !rawAnswers ||
    typeof rawAnswers !== 'object' ||
    Array.isArray(rawAnswers)
  ) {
    return {
      error: decisionError(
        'model-invalid-response',
        '裁判返回的 JSON 缺少 answers 字段',
        { details: { stage: 'judge-parse' } },
      ),
    };
  }
  const answers: Record<string, JudgeAnswer> = {};
  for (const [qid, question] of Object.entries(questions)) {
    const entry = (rawAnswers as Record<string, unknown>)[qid];
    if (!entry || typeof entry !== 'object') {
      return {
        error: decisionError(
          'model-invalid-response',
          `裁判未回答题目 ${qid}`,
          { details: { stage: 'judge-validate', questionId: qid } },
        ),
      };
    }
    const { value, confidence } = entry as {
      value?: unknown;
      confidence?: unknown;
      distribution?: unknown;
      legend?: unknown;
    };
    const confidenceOut = toConfidence(confidence);
    if (question.type === 'noul') {
      const pYes = toPYes(value);
      if (pYes === null) {
        return {
          error: decisionError(
            'model-invalid-response',
            `裁判对题目 ${qid} 给出的 noul 取值不在 [0,1]`,
            { details: { stage: 'judge-validate', questionId: qid } },
          ),
        };
      }
      answers[qid] = {
        type: 'noul',
        value: pYes,
        confidence: confidenceOut,
        distribution: { yes: pYes, no: Number((1 - pYes).toFixed(4)) },
        legend: null,
      };
      continue;
    }
    if (question.type === 'choice') {
      const labels = candidateLabels(question);
      if (typeof value !== 'string' || !labels.includes(value)) {
        return {
          error: decisionError(
            'model-invalid-response',
            `裁判对题目 ${qid} 给出的选项不在候选集内`,
            { details: { stage: 'judge-validate', questionId: qid } },
          ),
        };
      }
      answers[qid] = {
        type: 'choice',
        value,
        confidence: confidenceOut,
        distribution: null,
        legend: null,
      };
      continue;
    }
    // score
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return {
        error: decisionError(
          'model-invalid-response',
          `裁判对题目 ${qid} 给出的分数不是数字`,
          { details: { stage: 'judge-validate', questionId: qid } },
        ),
      };
    }
    const levels = scaleLevels(question);
    if (levels !== null && (value < 0 || value > levels - 1)) {
      return {
        error: decisionError(
          'model-invalid-response',
          `裁判对题目 ${qid} 给出的分数超出量表范围`,
          { details: { stage: 'judge-validate', questionId: qid } },
        ),
      };
    }
    answers[qid] = {
      type: 'score',
      value,
      confidence: confidenceOut,
      distribution: null,
      legend: Array.isArray(question.criteria)
        ? question.criteria.map((level) => String(level))
        : null,
    };
  }
  return { answers };
}

// ── 裁判主入口 ─────────────────────────────────────────────────────────

/**
 * 跑一次裁判。这是**唯一**的裁判入口（级联兜底与显式仲裁共用）。
 *
 * 内部顺序：读配置 → 模式闸 → 路由解析 → 预算闸 → 调宿主 llm → 解析校验 →
 * 记账。任一步失败都返回结构化错误信封，绝不抛异常、绝不 fail-open。
 */
export async function judgeOnce(
  deps: JudgeDeps,
  request: JudgeRequest,
): Promise<JudgeOutcome> {
  let config: ResolvedToolsConfig;
  try {
    config = deps.readConfig();
  } catch {
    return {
      ok: false,
      error: decisionError(
        'model-call-failed',
        '读取裁判配置失败（内部错误），请检查插件配置后重试',
        { details: { stage: 'read-config' } },
      ),
      latencyMs: 0,
    };
  }

  // 模式闸：兜底未启用或模式不覆盖 → fallback-disabled（结构化，非 fail-open）。
  if (!config.fallbackEnabled) {
    return {
      ok: false,
      error: decisionError(
        'fallback-disabled',
        '兜底裁判未启用：请在插件设置里开启「启用兜底级联」',
        { details: { mode: request.mode } },
      ),
      latencyMs: 0,
    };
  }
  if (!judgeModeAllowed(config, request.mode)) {
    return {
      ok: false,
      error: decisionError(
        'fallback-disabled',
        `兜底模式（${config.fallbackMode}）不允许 ${request.mode} 裁判`,
        { details: { mode: request.mode, fallbackMode: config.fallbackMode } },
      ),
      latencyMs: 0,
    };
  }

  // 路由解析：显式配置 → 会话当前模型；都没有 → arbiter-unavailable。
  const route = resolveJudgeRoute(config, request, deps);
  if (route === null) {
    return {
      ok: false,
      error: decisionError(
        'arbiter-unavailable',
        '没有可用的裁判模型：请在插件设置里配置兜底 provider/model，或使用带模型的会话',
        { details: { mode: request.mode } },
      ),
      latencyMs: 0,
    };
  }

  // 预算闸：裁判与主判定共用预算；judge=true 走 fallbackMaxCallsPerDay 独立配额。
  if (deps.budget) {
    const verdict = deps.budget.check({
      tool: request.tool ?? 'decision_arbiter',
      judge: true,
    });
    if (!verdict.ok) {
      return {
        ok: false,
        error: verdict.error,
        latencyMs: 0,
      };
    }
  }

  const questionIds = Object.keys(request.questions);
  if (questionIds.length === 0) {
    return {
      ok: false,
      error: decisionError('invalid-arguments', '裁判请求没有任何题目'),
      latencyMs: 0,
    };
  }
  for (const qid of questionIds) {
    const type = request.questions[qid]?.type;
    if (type !== 'noul' && type !== 'choice' && type !== 'score') {
      return {
        ok: false,
        error: decisionError(
          'invalid-arguments',
          `裁判只支持 noul / choice / score 题型，题目 ${qid} 不是`,
          { details: { questionId: qid, type: type ?? null } },
        ),
        latencyMs: 0,
      };
    }
  }

  const prompt = buildJudgePrompt(request);
  const startedAt = Date.now();
  const outcome = await runHostDecisionCall(
    deps.llm,
    {
      prompt,
      system:
        'You are a careful fallback judge. You answer with a single JSON object and never with prose.',
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    },
    {
      provider: route.provider,
      model: route.model,
      timeoutMs: request.timeoutMs > 0 ? request.timeoutMs : 60_000,
      maxTokens: 1024,
    },
  );

  if (outcome.kind === 'timeout') {
    return {
      ok: false,
      error: decisionError('model-timeout', '裁判模型调用超时', {
        details: { stage: 'judge-call', route: route.origin },
      }),
      latencyMs: request.timeoutMs,
    };
  }
  if (outcome.kind === 'aborted') {
    return {
      ok: false,
      error: decisionError('model-call-failed', '裁判调用已被调用方取消', {
        details: { stage: 'judge-call', aborted: true },
      }),
      latencyMs: 0,
    };
  }
  if (outcome.kind === 'model-error') {
    return {
      ok: false,
      error: decisionError('model-call-failed', '裁判模型调用失败', {
        details: { stage: 'judge-call', route: route.origin },
      }),
      latencyMs: 0,
    };
  }
  if (outcome.kind === 'llm-unavailable' || outcome.kind === 'route-invalid') {
    return {
      ok: false,
      error: decisionError(
        'arbiter-unavailable',
        '宿主大模型通道不可用，无法启用兜底裁判',
        { details: { stage: 'judge-call', route: route.origin } },
      ),
      latencyMs: 0,
    };
  }

  const parsed = parseJudgeAnswers(outcome.text, request.questions);
  if ('error' in parsed)
    return { ok: false, error: parsed.error, latencyMs: 0 };

  const latencyMs = Math.max(0, Date.now() - startedAt);
  const decisionIds: Record<string, string> = {};
  for (const qid of questionIds) decisionIds[qid] = newDecisionId();

  // 记账：一次裁判调用只落一份真实用量（记在第一条题级条目上，其余 0）。
  if (deps.ledger) {
    const estimate = estimateCostUsd(
      { inputTokens: null, outputTokens: null, calls: 1 },
      config,
    );
    for (const [index, qid] of questionIds.entries()) {
      const answer = parsed.answers[qid];
      deps.ledger.append({
        decisionId: decisionIds[qid],
        ts: new Date().toISOString(),
        tool: request.tool ?? 'decision_arbiter',
        mode: request.mode,
        source: 'llm-fallback-judge',
        questionId: qid,
        questionType: request.questions[qid]?.type ?? null,
        questionSummary: truncateSummary(
          request.questionSummaries?.[qid] ?? null,
        ),
        status: 'ok',
        payload: {
          value: answer.value,
          confidence: answer.confidence,
          distribution: answer.distribution,
          legend: answer.legend,
        },
        outcome: {
          state: 'unknown',
          value: null,
          source: null,
          updatedAt: null,
        },
        usage:
          index === 0
            ? { inputTokens: null, outputTokens: null, calls: 1 }
            : { inputTokens: null, outputTokens: null, calls: 0 },
        latencyMs: index === 0 ? latencyMs : 0,
        costUsd: index === 0 ? estimate.costUsd : 0,
        costEstimated: index === 0 ? estimate.costEstimated : false,
      });
    }
  }

  return {
    ok: true,
    result: {
      answers: parsed.answers,
      source: 'llm-fallback-judge',
      mode: request.mode,
      route,
      usage: {
        calls: 1,
        inputTokens: null,
        outputTokens: null,
        latencyMs,
      },
      decisionIds,
    },
  };
}
