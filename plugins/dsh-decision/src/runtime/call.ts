/**
 * 统一调用层（决策工具系列 2/11）。
 *
 * 契约来源：docs/decision-tools-contract.md §8（统一调用层）与 §10（兜底挂点）。
 *
 * 层次（§8.1）：tools/*.ts → runtime/call.ts（本文件）→ systemone/client.ts。
 * 调用顺序（§8.3）：守卫（开关→模型）→ 预算闸（先于出网）→ HTTP。
 * 记账义务（§8.2）：每次实际发起的调用按题写条目（含失败条目与
 * budget blocked 条目）；兜底裁判调用独立记账，source 可区分。
 *
 * 卡 2 交付面：预算闸与兜底挂点是**空实现挂点**（直通/noop），
 * 5/11、7/11 各自替换注入，本层调用位置已固定，工具层无感。
 */

import {
  type DecisionToolName,
  type ResolvedToolsConfig,
} from '../config/decision-tools.ts';
import { decisionError, type DecisionErrorCode } from '../systemone/errors.ts';
import { callSystemOne, type FetchLike } from '../systemone/client.ts';
import type {
  SystemOneAsset,
  SystemOneCallResult,
  SystemOneNormalizedUsage,
  SystemOneParsedAnswer,
  SystemOneQuestion,
} from '../systemone/types.ts';

import { budgetExceeded, type BudgetGate } from './budget.ts';
import {
  checkModelReady,
  checkToolEnabled,
  requiresModel,
  type VerifySnapshot,
} from './guard.ts';
import { newDecisionId } from './id.ts';
import {
  estimateCostUsd,
  truncateSummary,
  type LedgerEntry,
  type LedgerMode,
  type LedgerSink,
  type LedgerSource,
} from './ledger.ts';

// ── 兜底挂点（§10；7/11 替换实现）────────────────────────────────────

export type FallbackTriggerKind =
  | 'model-not-configured'
  | 'model-verify-failed'
  | 'model-call-failed'
  | 'model-timeout'
  | 'model-invalid-response'
  | 'low-confidence';

export interface FallbackTrigger {
  kind: FallbackTriggerKind;
  tool: DecisionToolName;
  state: unknown;
  questions: Record<string, SystemOneQuestion>;
  /** 原始失败（T1/T2）。 */
  originalError?: ReturnType<typeof decisionError>;
  /** 最低置信（T3）。 */
  lowestConfidence?: number | null;
  /** 自一致性一致性（T3；null 表示本次未做多采样）。 */
  agreement?: number | null;
  /** 会话当前模型（T3 由工具层解析后传入，裁判路由优先用显式配置）。 */
  sessionModel?: { provider: string; model: string } | null;
}

/** 兜底元信息（工具出参 meta 块，契约 §10.3）。 */
export interface FallbackMeta {
  /**
   * true = 本次判定来自兜底裁判（source 已是 llm-fallback-judge）；
   * false = 兜底尝试过但失败，**维持首判结果**，error 里带裁判失败原因。
   */
  triggered: boolean;
  /** 触发路径（T1/T2/T3）。 */
  trigger: FallbackTriggerKind;
  /** 裁判实际使用的模型路由（不含凭据）；未能解析路由时 null。 */
  route: { provider: string; model: string; origin: string } | null;
  /** 首判来源（未兜底前）。 */
  originalSource: LedgerSource;
  /** 首判置信度（首判失败或未产生置信度时 null）。 */
  originalConfidence: number | null;
  /** 兜底失败时的错误码与原因（triggered=false 时有值）。 */
  error?: { code: DecisionErrorCode; message: string };
}

/** 兜底裁判成功后的判定（带路由与触发原因）。 */
export interface FallbackJudgement {
  ok: true;
  result: Extract<SystemOneCallResult, { ok: true }>;
  route: { provider: string; model: string; origin: string } | null;
  trigger: FallbackTriggerKind;
  originalConfidence: number | null;
}

/**
 * 兜底挂点结果：
 * - `null` = 不兜底（维持原失败/原结果）；
 * - `ok:true` = 用裁判答案（带 meta）；
 * - `ok:false` = 兜底也失败了（结构化错误码，调用方按路径决定是否覆盖原错误）。
 */
export type FallbackOutcome =
  | FallbackJudgement
  | {
      ok: false;
      error: {
        code: DecisionErrorCode;
        message: string;
        retryable: boolean;
        details: Record<string, import('../systemone/types.ts').JsonValue>;
      };
      latencyMs: number;
    };

export interface FallbackHook {
  /**
   * 返回 null = 不兜底（维持原失败/原结果）；返回 ok 结果 = 用裁判答案。
   * 卡 2 的 noop 实现恒返 null；7/11 起由 runtime/fallback.ts 实现级联兜底。
   */
  maybeFallback(trigger: FallbackTrigger): Promise<FallbackOutcome | null>;
}

export function createNoopFallbackHook(): FallbackHook {
  return {
    async maybeFallback(): Promise<FallbackOutcome | null> {
      return null;
    },
  };
}

// ── 请求与依赖 ───────────────────────────────────────────────────────

export interface DecisionCallRequest {
  tool: DecisionToolName;
  /** 默认 primary；arbiter/recheck 卡各传自己的 mode。 */
  mode?: LedgerMode;
  /** 默认 decision-model；裁判条目传 llm-fallback-judge。 */
  source?: LedgerSource;
  state: unknown;
  questions: Record<string, SystemOneQuestion>;
  assets?: Record<string, SystemOneAsset>;
  /** qid → 人读摘要（≤120 字符截断后入账）。缺省用 qid 本身。 */
  questionSummaries?: Record<string, string>;
  /** 自一致性采样序号（0 起）；仅 decide 的 n>1 路径传入，写入 payload.selfConsistencySample。 */
  sampleIndex?: number;
  /**
   * 仅记录进账本的上下文（gate 的 riskLevel/policyId，契约 §3.2「仅记录」）。
   * 不参与判定，不写入 state，也不影响任何工具出参。
   */
  contextExtras?: { riskLevel?: string | null; policyId?: string | null };
  /**
   * recheck 关联：本次判定是某条原判定的复检时，指向原条目 id
   * （契约 §5.2「recheck 新条目用 recheckOf 指向原条目」）。
   */
  recheckOf?: string;
  /**
   * 会话当前模型（工具层解析后传入，裁判路由在没有显式配置时用它）。
   * 宿主没有「当前会话模型」公开 API，这里是 best-effort 的 duck-type 结果，
   * 取不到就不传——裁判会回 arbiter-unavailable，绝不猜模型。
   */
  sessionModel?: { provider: string; model: string } | null;
  signal?: AbortSignal;
}

export interface DecisionCallDeps {
  readConfig(): ResolvedToolsConfig;
  getVerifySnapshot(): VerifySnapshot | undefined;
  /** 记账 sink（缺省不记账——仅测试用；生产入口必须提供）。 */
  ledger?: LedgerSink;
  budget?: BudgetGate;
  fallback?: FallbackHook;
  fetchImpl?: FetchLike;
  /**
   * 解析「会话当前模型」；由入口层用宿主内部投影实现（best-effort）。
   * 传入工具执行上下文（exec），返回 {provider,model} 或 null/undefined。
   */
  resolveSessionModel?: (
    exec: unknown,
  ) => { provider: string; model: string } | null | undefined;
}

export type DecisionCallOk = Extract<SystemOneCallResult, { ok: true }> & {
  /** 每题一个稳定 decisionId（账本锚点，recheck/history 按它解析）。 */
  decisionIds: Record<string, string>;
  /** 本次判定的来源与模式（兜底裁判时 source=llm-fallback-judge，供工具层回报）。 */
  source: LedgerSource;
  mode: LedgerMode;
  /** 兜底元信息；未发生兜底时为 null。 */
  fallback?: FallbackMeta | null;
};

export interface DecisionCallFailure {
  ok: false;
  error: {
    code: DecisionErrorCode;
    message: string;
    retryable: boolean;
    details: Record<string, import('../systemone/types.ts').JsonValue>;
  };
  latencyMs: number;
  /** 分配过的 id（守卫失败阶段可能为 null）。 */
  decisionIds: Record<string, string> | null;
}

export type DecisionCallResult = DecisionCallOk | DecisionCallFailure;

// ── 记账辅助 ─────────────────────────────────────────────────────────

function answerToPayload(answer: SystemOneParsedAnswer): {
  value: import('../systemone/types.ts').JsonValue;
  confidence: number | null;
  distribution: import('../systemone/types.ts').JsonValue | null;
  legend: string[] | null;
} {
  switch (answer.kind) {
    case 'noul':
      return {
        value: answer.pYes,
        confidence: answer.confidence,
        distribution: answer.probabilities,
        legend: null,
      };
    case 'choice':
      return {
        value: answer.choice,
        confidence: answer.confidence,
        distribution: answer.probabilities,
        legend: null,
      };
    case 'score':
      return {
        value: answer.score,
        confidence: answer.confidence,
        distribution: answer.probabilities,
        legend: answer.legend,
      };
    case 'box':
      return {
        value: {
          top: answer.box.top,
          bottom: answer.box.bottom,
          left: answer.box.left,
          right: answer.box.right,
        },
        confidence: answer.confidence,
        distribution: null,
        legend: null,
      };
  }
}

function appendEntry(
  ledger: LedgerSink,
  config: ResolvedToolsConfig,
  entry: Omit<LedgerEntry, 'ts' | 'costUsd' | 'costEstimated' | 'outcome'> & {
    outcome?: LedgerEntry['outcome'];
  },
): void {
  const estimate = estimateCostUsd(entry.usage, config);
  ledger.append({
    ...entry,
    ts: new Date().toISOString(),
    outcome: entry.outcome ?? {
      state: 'unknown',
      value: null,
      source: null,
      updatedAt: null,
    },
    costUsd: estimate.costUsd,
    costEstimated: estimate.costEstimated,
  });
}

/**
 * 一次真实 HTTP 调用只产生一份用量。账本按题各落一条（payload 需要每题
 * 一个条目），因此把整次调用的 usage 记在**第一条**题级条目上，其余条目
 * `calls=0`、token 为 null——usage 汇总（5/11）按条目 usage 直接求和即为
 * 真实值，绝不多题重复计数（契约 §5.1 / §8.2）。
 */
function callUsageFor(
  index: number,
  usage: SystemOneNormalizedUsage | null,
): { inputTokens: number | null; outputTokens: number | null; calls: number } {
  if (index > 0) {
    return { inputTokens: null, outputTokens: null, calls: 0 };
  }
  return {
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    calls: 1,
  };
}

/**
 * 一次真实调用的延迟同样只记一次：镜像 usage 归属规则，只在第一条题级条目
 * 写真实 latencyMs，其余写 0——否则 P50/P95（5/11）会按题数放大 Q 倍。
 */
function callLatencyFor(index: number, latencyMs: number): number {
  return index === 0 ? latencyMs : 0;
}

/** 仅记录型上下文（gate 的 riskLevel/policyId）；未提供时返回空对象。 */
function contextPayloadExtras(request: DecisionCallRequest): {
  riskLevel?: string | null;
  policyId?: string | null;
} {
  if (!request.contextExtras) return {};
  const { riskLevel, policyId } = request.contextExtras;
  const extras: { riskLevel?: string | null; policyId?: string | null } = {};
  if (riskLevel !== undefined && riskLevel !== null)
    extras.riskLevel = riskLevel;
  if (policyId !== undefined && policyId !== null) extras.policyId = policyId;
  return extras;
}

/** recheck 关联字段（契约 §5.2）；未提供时返回空对象。 */
function recheckOfField(request: DecisionCallRequest): { recheckOf?: string } {
  if (request.recheckOf === undefined) return {};
  return { recheckOf: request.recheckOf };
}

// ── 主入口 ───────────────────────────────────────────────────────────

/**
 * 统一决策调用。工具层（3/11 起）只调本函数，不直接摸 HTTP。
 * 失败不抛异常——返回 { ok:false, error } 信封（契约 §1.1）。
 */
/**
 * 验证快照读取：读取异常等价于「没有验证记录」→ model-verify-failed，
 * 绝不把异常抛给调用方（契约 §1.1 不抛异常）。
 */
function readVerifySnapshot(
  deps: DecisionCallDeps,
): VerifySnapshot | undefined {
  try {
    return deps.getVerifySnapshot();
  } catch {
    return undefined;
  }
}

export async function runDecisionCall(
  deps: DecisionCallDeps,
  request: DecisionCallRequest,
): Promise<DecisionCallResult> {
  // 配置读取失败也不抛异常（契约 §1.1）：映射到闭集内的 model-call-failed，
  // details.stage 标明是读配置阶段，便于定位。
  let config: ResolvedToolsConfig;
  try {
    config = deps.readConfig();
  } catch {
    return {
      ok: false,
      error: {
        code: 'model-call-failed',
        message: '读取决策工具配置失败（内部错误），请检查插件配置后重试',
        retryable: false,
        details: { stage: 'read-config' },
      },
      latencyMs: 0,
      decisionIds: null,
    };
  }
  const mode: LedgerMode = request.mode ?? 'primary';
  const source: LedgerSource = request.source ?? 'decision-model';
  const questionIds = Object.keys(request.questions);

  // ① 开关守卫（优先于模型检查，§1.3）。
  const disabled = checkToolEnabled(config, request.tool);
  if (disabled) {
    return { ok: false, error: disabled, latencyMs: 0, decisionIds: null };
  }

  // ② 纯本地工具豁免（契约 §1.3）：usage / history / calibrate 只读本地
  //    账本，不发模型调用——误入统一调用层直接 invalid-arguments，
  //    绝不偷偷去调模型，也不被 model-not-configured 误伤。
  if (!requiresModel(request.tool)) {
    return {
      ok: false,
      error: decisionError(
        'invalid-arguments',
        `工具 ${request.tool} 是纯本地工具，不应走决策模型调用层（契约 §1.3）`,
        { details: { tool: request.tool } },
      ),
      latencyMs: 0,
      decisionIds: null,
    };
  }

  // ③ 模型守卫（fail-closed：未配置 → model-not-configured，未验证 → model-verify-failed）。
  const notReady = checkModelReady(config, readVerifySnapshot(deps));
  if (notReady) {
    // 兜底挂点 T1/T2：未配置 / 验证失败可触发裁判（卡 2 noop → 原样报错）。
    const hook = deps.fallback;
    if (config.fallbackEnabled && hook) {
      const triggerKind: FallbackTriggerKind =
        notReady.code === 'model-not-configured'
          ? 'model-not-configured'
          : 'model-verify-failed';
      const judged = await hook.maybeFallback({
        kind: triggerKind,
        tool: request.tool,
        state: request.state,
        questions: request.questions,
        originalError: notReady,
        ...(request.sessionModel === undefined
          ? {}
          : { sessionModel: request.sessionModel }),
      });
      if (judged && judged.ok) {
        return finalizeOk(
          judged.result,
          questionIds,
          config,
          deps,
          request,
          mode,
          source,
          {
            triggered: true,
            trigger: judged.trigger,
            route: judged.route,
            originalSource: source,
            originalConfidence: judged.originalConfidence,
          },
        );
      }
      if (judged && !judged.ok) {
        // 兜底也失败：**原错误码不掩盖**（model-not-configured 仍是根因），
        // 裁判失败原因放进 details.judgeError（契约 §10.1）。
        return {
          ok: false,
          error: {
            code: notReady.code,
            message: notReady.message,
            retryable: notReady.retryable,
            details: {
              ...notReady.details,
              judgeError: {
                code: judged.error.code,
                message: judged.error.message,
              },
            },
          },
          latencyMs: judged.latencyMs,
          decisionIds: null,
        };
      }
    }
    return { ok: false, error: notReady, latencyMs: 0, decisionIds: null };
  }

  // ④ 预算闸（先于出网；blocked 只落拒绝记录，不发起调用，§8.3）。
  const budget = deps.budget;
  if (budget) {
    const verdict = budget.check({
      tool: request.tool,
      judge: source === 'llm-fallback-judge',
    });
    if (!verdict.ok) {
      budget.recordBlocked(request.tool, verdict.dimension);
      if (deps.ledger) {
        // 契约 §8.3：预算拒绝只落**一条** status=blocked 记录（不按题重复落）。
        appendEntry(deps.ledger, config, {
          decisionId: newDecisionId(),
          tool: request.tool,
          mode,
          source,
          ...recheckOfField(request),
          questionId: null,
          questionType: null,
          questionSummary: null,
          status: 'blocked',
          payload: {
            value: null,
            confidence: null,
            distribution: null,
            legend: null,
            errorCode: 'budget-exceeded',
            ...contextPayloadExtras(request),
          },
          usage: { inputTokens: null, outputTokens: null, calls: 0 },
          latencyMs: 0,
        });
      }
      const blocked = budgetExceeded(verdict.dimension);
      return {
        ok: false,
        error: blocked.error,
        latencyMs: 0,
        decisionIds: null,
      };
    }
  }

  // ⑤ 分配稳定 decisionId（失败条目也带 id，契约 §5.2「每次判定分配一个稳定 id」）。
  const decisionIds: Record<string, string> = {};
  for (const qid of questionIds) decisionIds[qid] = newDecisionId();

  // ⑥ 出网。
  const result = await callSystemOne({
    http: {
      baseUrl: config.systemoneBaseUrl,
      apiKey: config.systemoneApiKey,
      model: config.systemoneModel,
      timeoutMs: config.systemoneTimeoutMs,
    },
    body: {
      state: request.state,
      questions: request.questions,
      ...(request.assets ? { assets: request.assets } : {}),
    },
    signal: request.signal,
    fetchImpl: deps.fetchImpl,
  });

  // ⑦ 失败：按题记失败条目；兜底挂点 T2（调用失败类错误可触发裁判）。
  if (!result.ok) {
    if (deps.ledger) {
      for (const [index, qid] of questionIds.entries()) {
        appendEntry(deps.ledger, config, {
          decisionId: decisionIds[qid],
          tool: request.tool,
          mode,
          source,
          ...recheckOfField(request),
          questionId: qid,
          questionType: request.questions[qid]?.type ?? null,
          questionSummary: truncateSummary(
            request.questionSummaries?.[qid] ?? null,
          ),
          status: 'error',
          payload: {
            value: null,
            confidence: null,
            distribution: null,
            legend: null,
            errorCode: result.error.code,
            ...(request.sampleIndex === undefined
              ? {}
              : { selfConsistencySample: request.sampleIndex }),
            ...contextPayloadExtras(request),
          },
          // 一次调用只落一份真实用量：记在第一条题级条目上，其余记 0（§5.1）。
          usage: callUsageFor(index, null),
          latencyMs: callLatencyFor(index, result.latencyMs),
        });
      }
    }
    const retriableKinds: FallbackTriggerKind[] = [
      'model-call-failed',
      'model-timeout',
      'model-invalid-response',
    ];
    const hook = deps.fallback;
    // 调用方主动取消不是模型故障——不得触发兜底裁判（否则用户点取消还在烧裁判配额）。
    const callerAborted = result.error.details?.aborted === true;
    if (
      config.fallbackEnabled &&
      hook &&
      !callerAborted &&
      retriableKinds.includes(result.error.code as FallbackTriggerKind)
    ) {
      const judged = await hook.maybeFallback({
        kind: result.error.code as FallbackTriggerKind,
        tool: request.tool,
        state: request.state,
        questions: request.questions,
        originalError: {
          code: result.error.code,
          message: result.error.message,
          retryable: result.error.retryable,
          details: result.error.details,
        },
        ...(request.sessionModel === undefined
          ? {}
          : { sessionModel: request.sessionModel }),
      });
      if (judged && judged.ok) {
        return finalizeOk(
          judged.result,
          questionIds,
          config,
          deps,
          request,
          mode,
          source,
          {
            triggered: true,
            trigger: judged.trigger,
            route: judged.route,
            originalSource: source,
            originalConfidence: judged.originalConfidence,
          },
        );
      }
      if (judged && !judged.ok) {
        // 兜底失败：**保留原错误码**（model-call-failed / model-timeout /
        // model-invalid-response），裁判失败原因写进 details.judgeError——
        // 兜底不掩盖首判失败的真实原因（契约 §10.1、卡 7 清单第 8 项）。
        return {
          ok: false,
          error: {
            code: result.error.code,
            message: result.error.message,
            retryable: result.error.retryable,
            details: {
              ...result.error.details,
              judgeError: {
                code: judged.error.code,
                message: judged.error.message,
              },
            },
          },
          latencyMs: result.latencyMs,
          decisionIds,
        };
      }
    }
    return {
      ok: false,
      error: result.error,
      latencyMs: result.latencyMs,
      decisionIds,
    };
  }

  // ⑧ 成功：按题记条目（dropped/invalid 也记，契约 §8.2）。
  if (deps.ledger) {
    for (const [index, qid] of questionIds.entries()) {
      const answer = result.answers[qid];
      const common = {
        decisionId: decisionIds[qid],
        tool: request.tool,
        mode,
        source,
        ...recheckOfField(request),
        questionId: qid,
        questionType: request.questions[qid]?.type ?? null,
        questionSummary: truncateSummary(
          request.questionSummaries?.[qid] ?? null,
        ),
        // 一次调用只落一份真实用量：记在第一条题级条目上，其余记 0（§5.1）。
        usage: callUsageFor(index, result.usage),
        latencyMs: callLatencyFor(index, result.latencyMs),
      };
      if (!answer) {
        appendEntry(deps.ledger, config, {
          ...common,
          status: 'error',
          payload: {
            value: null,
            confidence: null,
            distribution: null,
            legend: null,
            errorCode: 'model-invalid-response',
            ...(request.sampleIndex === undefined
              ? {}
              : { selfConsistencySample: request.sampleIndex }),
            ...contextPayloadExtras(request),
          },
        });
        continue;
      }
      const payloadFields = answerToPayload(answer);
      appendEntry(deps.ledger, config, {
        ...common,
        status: 'ok',
        payload: {
          ...payloadFields,
          ...(request.sampleIndex === undefined
            ? {}
            : { selfConsistencySample: request.sampleIndex }),
          ...contextPayloadExtras(request),
        },
      });
    }
  }

  // 兜底挂点 T3（低置信）：7/11 实现裁判逻辑；卡 2 只留挂点语义注释。
  // T3 的置信度判定需要工具层语义（agreement 等），由 7/11 在本层之上扩展。

  return { ...result, decisionIds, source, mode };
}

/** 兜底裁判成功时：条目按裁判身份记账（source/mode 可区分，§8.2）。 */
function finalizeOk(
  judged: Extract<SystemOneCallResult, { ok: true }>,
  questionIds: string[],
  config: ResolvedToolsConfig,
  deps: DecisionCallDeps,
  request: DecisionCallRequest,
  mode: LedgerMode,
  source: LedgerSource,
  meta: FallbackMeta,
): DecisionCallOk {
  const judgeMode: LedgerMode = mode === 'primary' ? 'auto-fallback' : mode;
  const judgeSource: LedgerSource =
    source === 'decision-model' ? 'llm-fallback-judge' : source;
  const decisionIds: Record<string, string> = {};
  for (const qid of questionIds) decisionIds[qid] = newDecisionId();
  if (deps.ledger) {
    for (const [index, qid] of questionIds.entries()) {
      const answer = judged.answers[qid];
      const common = {
        decisionId: decisionIds[qid],
        tool: request.tool,
        mode: judgeMode,
        source: judgeSource,
        questionId: qid,
        questionType: request.questions[qid]?.type ?? null,
        questionSummary: truncateSummary(
          request.questionSummaries?.[qid] ?? null,
        ),
        // 一次裁判调用只落一份真实用量：记在第一条题级条目上，其余记 0（§5.1）。
        usage: callUsageFor(index, judged.usage),
        latencyMs: callLatencyFor(index, judged.latencyMs),
        // 兜底条目同样保留 recheckOf 关联（当前自动兜底只对 decide/gate，recheck 不可达，
        // 写入是为将来把复检纳入兜底范围时不丢关联）。
        ...recheckOfField(request),
      };
      if (!answer) {
        appendEntry(deps.ledger, config, {
          ...common,
          status: 'error',
          payload: {
            value: null,
            confidence: null,
            distribution: null,
            legend: null,
            errorCode: 'model-invalid-response',
            ...(request.sampleIndex === undefined
              ? {}
              : { selfConsistencySample: request.sampleIndex }),
            ...contextPayloadExtras(request),
          },
        });
        continue;
      }
      appendEntry(deps.ledger, config, {
        ...common,
        status: 'ok',
        payload: {
          ...answerToPayload(answer),
          ...(request.sampleIndex === undefined
            ? {}
            : { selfConsistencySample: request.sampleIndex }),
          ...contextPayloadExtras(request),
        },
      });
    }
  }
  return {
    ...judged,
    decisionIds,
    source: judgeSource,
    mode: judgeMode,
    fallback: meta,
  };
}

// ── T3 低置信兜底（§10.1）─────────────────────────────────────────────

/** 低置信判定所需的评估量（工具层提供）。 */
export interface LowConfidenceEvaluation {
  /** 本次判定里最低的置信度（null = 上游没给置信度）。 */
  lowestConfidence: number | null;
  /** decide 自一致性一致性（null = 未做多采样）。 */
  agreement?: number | null;
}

/** 兜底尝试的统一结果（工具层消费）。 */
export type FallbackAttemptResult =
  | { kind: 'skipped' }
  | { kind: 'judged'; result: DecisionCallOk }
  | {
      kind: 'failed';
      error: { code: DecisionErrorCode; message: string };
    };

/**
 * 触发一次兜底裁判（工具层用；T1/T2 在本层内部已处理，这里供工具层处理
 * 「调用成功但结果不可用」与「低置信」两类场景）。
 *
 * 返回：
 * - `skipped` = 不兜底（未启用 / 模式不允许 / 挂点不存在）；
 * - `judged` = 兜底成功（结果已按裁判身份记账，含 fallback meta）；
 * - `failed` = 兜底失败（**原错误码不被掩盖**，失败原因由调用方并入 details）。
 */
export async function runFallbackJudge(
  deps: DecisionCallDeps,
  request: DecisionCallRequest,
  trigger: {
    kind: FallbackTriggerKind;
    originalError?: ReturnType<typeof decisionError>;
    lowestConfidence?: number | null;
    agreement?: number | null;
  },
): Promise<FallbackAttemptResult> {
  let config: ResolvedToolsConfig;
  try {
    config = deps.readConfig();
  } catch {
    return { kind: 'skipped' };
  }
  if (!config.fallbackEnabled) return { kind: 'skipped' };
  if (
    config.fallbackMode !== 'auto-fallback' &&
    config.fallbackMode !== 'both'
  ) {
    return { kind: 'skipped' };
  }
  const hook = deps.fallback;
  if (!hook) return { kind: 'skipped' };
  const outcome = await hook.maybeFallback({
    kind: trigger.kind,
    tool: request.tool,
    state: request.state,
    questions: request.questions,
    ...(trigger.originalError === undefined
      ? {}
      : { originalError: trigger.originalError }),
    ...(trigger.lowestConfidence === undefined
      ? {}
      : { lowestConfidence: trigger.lowestConfidence }),
    ...(trigger.agreement === undefined
      ? {}
      : { agreement: trigger.agreement }),
    ...(request.sessionModel === undefined
      ? {}
      : { sessionModel: request.sessionModel }),
  });
  if (!outcome) return { kind: 'skipped' };
  if (!outcome.ok) {
    return {
      kind: 'failed',
      error: { code: outcome.error.code, message: outcome.error.message },
    };
  }
  return {
    kind: 'judged',
    result: finalizeOk(
      outcome.result,
      Object.keys(request.questions),
      config,
      deps,
      request,
      'auto-fallback',
      'llm-fallback-judge',
      {
        triggered: true,
        trigger: outcome.trigger,
        route: outcome.route,
        originalSource: 'decision-model',
        originalConfidence:
          trigger.lowestConfidence === undefined
            ? null
            : trigger.lowestConfidence,
      },
    ),
  };
}

/**
 * T3 兜底结果：
 * - `skipped` = 未触发（未启用 / 未达阈值 / 无挂点）；
 * - `judged` = 兜底判定成功（含 fallback meta）；
 * - `failed` = 兜底尝试过但失败——**维持首判结果**，由工具层把失败原因
 *   写进 meta.error（保证「兜底失败不产无来源结论」，卡 7 清单第 7 项）。
 */
export type LowConfidenceFallbackResult = FallbackAttemptResult;

/**
 * T3：首判成功但置信度/一致性不足时的兜底。
 *
 * 触发条件：置信度 < fallbackMinConfidence **或** agreement < 同阈值
 * （agreement 为 null 时只看置信度，契约 §10.1）。
 *
 * 裁判失败时**不抛异常、不改首判结果**，只把失败原因带在 failed.error 里。
 */
export async function runLowConfidenceFallback(
  deps: DecisionCallDeps,
  request: DecisionCallRequest,
  evaluation: LowConfidenceEvaluation,
): Promise<LowConfidenceFallbackResult> {
  let config: ResolvedToolsConfig;
  try {
    config = deps.readConfig();
  } catch {
    return { kind: 'skipped' };
  }
  const threshold = config.fallbackMinConfidence;
  const lowest = evaluation.lowestConfidence;
  const agreement = evaluation.agreement ?? null;
  const lowConfidence =
    typeof lowest === 'number' && Number.isFinite(lowest)
      ? lowest < threshold
      : false;
  const lowAgreement =
    typeof agreement === 'number' && Number.isFinite(agreement)
      ? agreement < threshold
      : false;
  if (!lowConfidence && !lowAgreement) return { kind: 'skipped' };

  return runFallbackJudge(deps, request, {
    kind: 'low-confidence',
    lowestConfidence: lowest,
    agreement,
    originalError: decisionError(
      'model-invalid-response',
      `首判置信度或一致性低于兜底阈值（${threshold}）`,
      {
        details: {
          stage: 'low-confidence',
          lowestConfidence: lowest,
          agreement,
          threshold,
        },
      },
    ),
  });
}
