/**
 * 回退状态机 + 纯函数工具。
 *
 * 设计目标:让 index.ts 里的 listener 只做"事件分发 + 副作用(sleep)";
 * 决策(是否可重试、是否还有下一候选、如何推进 index、backoff 多少 ms)
 * 全下沉到此处,便于单元测试覆盖。
 */

import type { LlmFailure } from '@deepseek-ai/dsh-llm';

/** 一条可执行的候选(provider, model)。 */
export interface Candidate {
  provider: string;
  model: string;
}

/** step 标识:`turn:step`,来自 agent/request 与 agent/request-error 的 payload。 */
export type StepKey = string;

/** 单 step 的回退状态。 */
export interface FallbackState {
  /** 候选链(不可变引用)。 */
  readonly chain: ReadonlyArray<Candidate>;
  /** 当前候选在 chain 中的索引。 */
  index: number;
  /** 已 retry 次数(用于 backoff 计数)。 */
  retries: number;
  /** 链耗尽后置 true(下次 request-error 时直接透传上游)。 */
  exhausted: boolean;
}

/** 从 agent/request 的 proposedConfig 中提取 (provider, model)。 */
export function deriveCandidateFromOptions(opts: {
  provider: string;
  model: string;
}): Candidate {
  return { provider: opts.provider, model: opts.model };
}

/** 该 failure 是否在白名单内? */
export function isFailureRetryable(
  failure: LlmFailure,
  retryableCodes: ReadonlySet<string>,
): boolean {
  return retryableCodes.has(failure.code);
}

/**
 * 推进到下一候选。
 * - 若 state.index 已是最后一项 → 返回 null(链耗尽);
 * - 若 state.retries >= maxRetries → 返回 null(达到上限);
 * - 否则返回新 { index, retries }。
 */
export function nextCandidate(
  state: FallbackState,
  maxRetries: number,
): { index: number; retries: number } | null {
  if (state.exhausted) return null;
  if (state.retries >= maxRetries) return null;
  if (state.index >= state.chain.length - 1) return null;
  return {
    index: state.index + 1,
    retries: state.retries + 1,
  };
}

/**
 * 计算指数退避延迟(对称抖动 ±10%);attempt = 已 retry 次数。
 * 测试可注入 random 控制抖动;否则用 Math.random。
 */
export function backoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const exponential = baseDelayMs * 2 ** Math.max(0, attempt);
  const capped = Math.min(exponential, maxDelayMs);
  const jitterRatio = 0.1;
  const jitter = (random() * 2 - 1) * jitterRatio;
  return Math.max(0, Math.floor(capped * (1 + jitter)));
}

/** 取出或惰性初始化该 step 的回退状态(从 seed chain 开始)。 */
export function stateFor(
  states: Map<StepKey, FallbackState>,
  key: StepKey,
  chain: ReadonlyArray<Candidate>,
): FallbackState {
  let s = states.get(key);
  if (!s) {
    s = {
      chain,
      index: 0,
      retries: 0,
      exhausted: false,
    };
    states.set(key, s);
  }
  return s;
}
