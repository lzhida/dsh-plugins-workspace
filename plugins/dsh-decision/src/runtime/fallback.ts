/**
 * 级联兜底挂点实现（决策工具系列 7/11）。
 *
 * 契约来源：docs/decision-tools-contract.md §10.1（auto-fallback 只对
 * decision_decide / decision_gate 生效、不可递归、失败不掩盖原错误码）、
 * §10.2（judgeOnce 是唯一裁判入口）。
 *
 * 与统一调用层的关系：
 * - 挂点只负责「决定要不要兜底」+「把裁判答案转换成 systemone 形状」；
 *   记账由统一调用层 finalizeOk 代记（避免同一份用量被记两次），
 *   裁判**失败**时本模块自己落一条 error 条目，保证兜底失败也可追溯。
 * - 裁判本身走 `judgeOnce`（防递归 + 预算闸 + 记账都在那一层）。
 */

import type { DecisionLlmLike } from '../core/decision.ts';
import type { ResolvedToolsConfig } from '../config/decision-tools.ts';
import type {
  SystemOneCallResult,
  SystemOneParsedAnswer,
} from '../systemone/types.ts';
import type { BudgetGate } from './budget.ts';
import type { LedgerSink } from './ledger.ts';
import { newDecisionId } from './id.ts';
import { judgeOnce, type JudgeAnswer, type JudgeRoute } from './judge.ts';
import type {
  FallbackHook,
  FallbackJudgement,
  FallbackOutcome,
  FallbackTrigger,
} from './call.ts';

/** auto-fallback 只允许这两个工具触发（§10.1）。 */
export const AUTO_FALLBACK_TOOLS = [
  'decision_decide',
  'decision_gate',
] as const;

export interface AutoFallbackDeps {
  readConfig(): ResolvedToolsConfig;
  /** 宿主 ctx.llm（软取，缺失时裁判报 arbiter-unavailable）。 */
  llm?: DecisionLlmLike | undefined;
  /** 预算闸（裁判与主判定共用；judge=true 走独立配额）。 */
  budget?: BudgetGate;
  /** 账本 sink：仅用于「裁判失败」时落一条 error 条目。 */
  ledger?: LedgerSink;
  /** 会话当前模型解析器（宿主内部投影，best-effort）。 */
  resolveSessionModel?: (
    exec?: unknown,
  ) => { provider: string; model: string } | null | undefined;
}

/** 裁判答案 → systemone 解析形状（工具层据此再映射成契约出参）。 */
export function judgeAnswerToParsed(
  answer: JudgeAnswer,
): SystemOneParsedAnswer {
  if (answer.type === 'noul') {
    const pYes = typeof answer.value === 'number' ? answer.value : 0;
    return {
      kind: 'noul',
      pYes,
      confidence: answer.confidence,
      probabilities:
        answer.distribution &&
        typeof answer.distribution === 'object' &&
        !Array.isArray(answer.distribution)
          ? (answer.distribution as Record<string, number>)
          : { yes: pYes, no: Number((1 - pYes).toFixed(4)) },
    };
  }
  if (answer.type === 'choice') {
    return {
      kind: 'choice',
      choice: typeof answer.value === 'string' ? answer.value : '',
      confidence: answer.confidence,
      probabilities:
        answer.distribution &&
        typeof answer.distribution === 'object' &&
        !Array.isArray(answer.distribution)
          ? (answer.distribution as Record<string, number>)
          : null,
    };
  }
  return {
    kind: 'score',
    score: typeof answer.value === 'number' ? answer.value : 0,
    legend: answer.legend ?? [],
    confidence: answer.confidence,
    probabilities: Array.isArray(answer.distribution)
      ? (answer.distribution as number[])
      : null,
  };
}

/**
 * 级联兜底挂点。
 *
 * 触发条件（全部满足才兜底）：
 * 1. 配置里 fallbackEnabled=true；
 * 2. fallbackMode 含 auto-fallback（'auto-fallback' | 'both'）；
 * 3. 触发工具是 decision_decide / decision_gate（§10.1）；
 * 4. 裁判本身可用（路由能解析 + 宿主 llm 通道存在）。
 *
 * 不满足时返回 null —— 调用方维持原失败/原结果（绝不 fail-open）。
 */
export function createAutoFallbackHook(deps: AutoFallbackDeps): FallbackHook {
  return {
    async maybeFallback(
      trigger: FallbackTrigger,
    ): Promise<FallbackOutcome | null> {
      let config: ResolvedToolsConfig;
      try {
        config = deps.readConfig();
      } catch {
        return null;
      }
      if (!config.fallbackEnabled) return null;
      if (
        config.fallbackMode !== 'auto-fallback' &&
        config.fallbackMode !== 'both'
      ) {
        return null;
      }
      if (
        !AUTO_FALLBACK_TOOLS.includes(
          trigger.tool as (typeof AUTO_FALLBACK_TOOLS)[number],
        )
      ) {
        return null;
      }
      // T3 门槛复核：置信度或一致性低于阈值才兜底（§10.1）。
      // 工具层已判过一次，这里再判一次是防止其它调用方误触发。
      if (trigger.kind === 'low-confidence') {
        const threshold = config.fallbackMinConfidence;
        const lowest = trigger.lowestConfidence;
        const agreement = trigger.agreement ?? null;
        const below =
          (typeof lowest === 'number' &&
            Number.isFinite(lowest) &&
            lowest < threshold) ||
          (typeof agreement === 'number' &&
            Number.isFinite(agreement) &&
            agreement < threshold);
        if (!below) return null;
      }

      const outcome = await judgeOnce(
        {
          readConfig: deps.readConfig,
          llm: deps.llm,
          budget: deps.budget,
          resolveSessionModel: deps.resolveSessionModel,
          // 记账不在这里做：成功路径由统一调用层 finalizeOk 代记（避免双记）。
          ledger: undefined,
        },
        {
          mode: 'auto-fallback',
          tool: trigger.tool,
          state: trigger.state,
          questions: trigger.questions,
          timeoutMs: config.fallbackTimeoutMs,
          ...(trigger.sessionModel === undefined
            ? {}
            : { sessionModel: trigger.sessionModel }),
        },
      );

      if (!outcome.ok) {
        // 兜底也失败了：落一条 error 条目（source=llm-fallback-judge），
        // 让「兜底失败」在账本里可追溯；原错误码由调用方保留。
        if (deps.ledger) {
          deps.ledger.append({
            decisionId: newDecisionId(),
            ts: new Date().toISOString(),
            tool: trigger.tool,
            mode: 'auto-fallback',
            source: 'llm-fallback-judge',
            questionId: null,
            questionType: null,
            questionSummary: null,
            status: 'error',
            payload: {
              value: null,
              confidence: null,
              distribution: null,
              legend: null,
              errorCode: outcome.error.code,
            },
            outcome: {
              state: 'unknown',
              value: null,
              source: null,
              updatedAt: null,
            },
            usage: { inputTokens: null, outputTokens: null, calls: 0 },
            latencyMs: outcome.latencyMs,
            costUsd: null,
            costEstimated: false,
          });
        }
        return {
          ok: false,
          error: outcome.error,
          latencyMs: outcome.latencyMs,
        };
      }

      const answers: Record<string, SystemOneParsedAnswer> = {};
      for (const [qid, answer] of Object.entries(outcome.result.answers)) {
        answers[qid] = judgeAnswerToParsed(answer);
      }
      const judged: Extract<SystemOneCallResult, { ok: true }> = {
        ok: true,
        model: outcome.result.route.model,
        answers,
        droppedQuestionIds: [],
        invalidAnswers: [],
        usage: {
          inputTokens: outcome.result.usage.inputTokens,
          outputTokens: outcome.result.usage.outputTokens,
        },
        latencyMs: outcome.result.usage.latencyMs,
      };
      const judgement: FallbackJudgement = {
        ok: true,
        result: judged,
        route: outcome.result.route,
        trigger: trigger.kind,
        originalConfidence:
          trigger.lowestConfidence === undefined
            ? null
            : trigger.lowestConfidence,
      };
      return judgement;
    },
  };
}

/** 路由摘要（工具出参 meta 用；不含任何凭据）。 */
export function judgeRouteSummary(
  route: JudgeRoute | null,
): { provider: string; model: string; origin: string } | null {
  if (!route) return null;
  return {
    provider: route.provider,
    model: route.model,
    origin: route.origin,
  };
}
