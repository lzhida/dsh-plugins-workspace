/**
 * decision-tools 行内服务层（决策工具系列 2/11）。
 *
 * 职责：把「配置现读 + 验证快照 + 统一调用层依赖」组装成一个可注入
 * runtime 对象，供 3/11–10/11 的工具注册代码与 6/11 设置页消费。
 * 决策点特有映射（ask-gate 的 services/ask-gate.ts 对应物）从本文件起家。
 *
 * 验证语义（契约 §6.2）：验证成功只在**进程内**记录
 * {fingerprint, verifiedAt}——baseUrl/apiKey/model 任一变更指纹失配即
 * 过期；重启进程后视为未验证（fail-closed，重新点一次验证即可）。
 * 配置字段 systemoneVerifiedAt / systemoneVerifyError 是展示态，
 * 由 6/11 设置页在验证成功/失败时回写。
 */

import type { ResolvedToolsConfig } from '../config/index.ts';
import {
  callSystemOne,
  verifySystemOne,
  type FetchLike,
  type VerifyResult,
} from '../systemone/index.ts';
import { decisionError } from '../systemone/errors.ts';
import type { DecisionLlmLike } from '../core/decision.ts';
import {
  createAutoFallbackHook,
  createPassthroughBudgetGate,
  fingerprintOf,
  runDecisionCall,
  type BudgetGate,
  type DecisionCallDeps,
  type DecisionCallRequest,
  type DecisionCallResult,
  type FallbackHook,
  type JudgeDeps,
} from '../runtime/index.ts';
import type { VerifySnapshot } from '../runtime/index.ts';

export interface DecisionToolsRuntime {
  /** 统一调用层依赖包（工具层 runDecisionCall(deps, req) 用）。 */
  deps: DecisionCallDeps;
  /**
   * 裁判通道依赖包（10/11 的 decision_arbiter 显式裁判用）。
   * 与自动兜底共用同一裁判入口，但 mode 走 explicit-arbiter，
   * 且**自带账本**（仲裁条目由裁判层记，mode 与 auto-fallback 可区分）。
   */
  judge: JudgeDeps;
  /** 当前验证快照（undefined = 未验证/已过期）。 */
  getVerifySnapshot(): VerifySnapshot | undefined;
  /**
   * 触发一次验证探测：成功则更新快照并返回 {ok:true,...}；
   * 失败返回归一化错误（供设置页展示 systemoneVerifyError）。
   */
  verifyNow(signal?: AbortSignal): Promise<VerifyResult>;
  /** 直接把当前已保存配置标记为「已验证」（验证路由在草稿==保存值时调用）。 */
  markVerified: () => void;
  /**
   * 回填判定真值（契约 §7.2 主通道，5/11 落地）：下游拿 decisionId 回报
   * confirmed/rejected/revised，10/11 calibrate 消费 outcome。
   * 返回 false = decisionId 不存在（含滚动淘汰，契约 §5.4）。
   */
  writeOutcome(
    decisionId: string,
    outcome: {
      state: 'confirmed' | 'rejected' | 'revised';
      value?: unknown;
      source?: 'downstream' | 'user';
    },
  ): boolean;
}

export interface CreateRuntimeOptions {
  /** 5/11 起注入文件持久化账本；缺省无账本（不记账）。 */
  ledger?: DecisionCallDeps['ledger'];
  /** 5/11 替换真实预算闸；缺省直通挂点。 */
  budget?: BudgetGate;
  /** 7/11 替换裁判兜底；缺省 noop 挂点。 */
  fallback?: FallbackHook;
  /** 测试注入 stub fetch。 */
  fetchImpl?: FetchLike;
  /**
   * 7/11 起注入宿主 ctx.llm（裁判走宿主大模型通道）。
   * 软取：宿主没装 llm 服务时为 undefined，裁判会回 arbiter-unavailable。
   */
  llm?: DecisionLlmLike | undefined;
  /**
   * 7/11 起注入「会话当前模型」解析器（宿主内部投影，best-effort）。
   * 解析不到时裁判回 arbiter-unavailable，绝不猜模型。
   */
  resolveSessionModel?: (
    exec: unknown,
  ) => { provider: string; model: string } | null | undefined;
}

export function createDecisionToolsRuntime(
  readConfig: () => ResolvedToolsConfig,
  options: CreateRuntimeOptions = {},
): DecisionToolsRuntime {
  let snapshot: VerifySnapshot | undefined;
  const resolveSessionModel = options.resolveSessionModel;
  // 7/11：默认装上级联兜底挂点（auto-fallback）。显式传入 fallback 时以传入为准。
  const fallback =
    options.fallback ??
    createAutoFallbackHook({
      readConfig,
      llm: options.llm,
      budget: options.budget ?? createPassthroughBudgetGate(),
      ledger: options.ledger,
      resolveSessionModel,
    });
  const deps: DecisionCallDeps = {
    readConfig,
    getVerifySnapshot: () => snapshot,
    ledger: options.ledger,
    budget: options.budget ?? createPassthroughBudgetGate(),
    fallback,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(resolveSessionModel ? { resolveSessionModel } : {}),
  };
  // 10/11：显式裁判（decision_arbiter）走同一裁判入口 judgeOnce，
  // 但自己带账本——仲裁条目由裁判层落账（mode='explicit-arbiter'），
  // 与自动兜底（mode='auto-fallback'）在账本/轨迹里可区分。
  const judge: JudgeDeps = {
    readConfig,
    ...(options.ledger ? { ledger: options.ledger } : {}),
    budget: options.budget ?? createPassthroughBudgetGate(),
    llm: options.llm,
    ...(resolveSessionModel ? { resolveSessionModel } : {}),
  };
  return {
    deps,
    judge,
    getVerifySnapshot: () => snapshot,
    async verifyNow(signal?: AbortSignal): Promise<VerifyResult> {
      const config = readConfig();
      if (
        config.systemoneBaseUrl === '' ||
        config.systemoneApiKey === '' ||
        config.systemoneModel === ''
      ) {
        return {
          ok: false,
          error: decisionError(
            'model-not-configured',
            '决策模型未配置完整（baseUrl / API key / model 任一为空），无法发起验证',
          ),
          latencyMs: 0,
        };
      }
      const result = await verifySystemOne({
        http: {
          baseUrl: config.systemoneBaseUrl,
          apiKey: config.systemoneApiKey,
          model: config.systemoneModel,
          timeoutMs: config.systemoneTimeoutMs,
        },
        signal,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      if (result.ok) {
        snapshot = {
          fingerprint: fingerprintOf(config),
          verifiedAt: new Date().toISOString(),
        };
        console.log(
          `[decision-tools] systemone verified (model=${result.model ?? config.systemoneModel}, ${result.latencyMs}ms)`,
        );
      } else {
        snapshot = undefined;
        console.warn(
          `[decision-tools] systemone verify failed (${result.error.code}): ${result.error.message}`,
        );
      }
      return result;
    },
    markVerified(): void {
      snapshot = {
        fingerprint: fingerprintOf(readConfig()),
        verifiedAt: new Date().toISOString(),
      };
    },
    writeOutcome(decisionId, outcome): boolean {
      if (!deps.ledger) return false;
      return deps.ledger.updateOutcome(decisionId, {
        state: outcome.state,
        value: (outcome.value ?? null) as never,
        ...(outcome.source === undefined ? {} : { source: outcome.source }),
      });
    },
  };
}

/** 工具层便捷重导出：decision 调用统一从这里走（3/11 起消费）。 */
export function callDecision(
  runtime: DecisionToolsRuntime,
  request: DecisionCallRequest,
): Promise<DecisionCallResult> {
  return runDecisionCall(runtime.deps, request);
}

export { callSystemOne };
