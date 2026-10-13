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

/**
 * 单 step 的回退状态。
 *
 * 主模型语义(0.5.0 起):会话页面指定的 provider/model 就是事实主模型,
 * 配置链 fallbackChains 是**纯回退候选队列**。index 以 `-1` 表示"尚未切换、
 * 仍在会话指定模型上";`>= 0` 表示当前生效的回退候选下标。
 */
export interface FallbackState {
  /** 回退候选链(不可变引用)。 */
  readonly chain: ReadonlyArray<Candidate>;
  /**
   * 当前生效的回退候选在 chain 中的索引;`-1` = 尚未切换(仍在会话指定模型上)。
   */
  index: number;
  /** 已 retry 次数(用于 backoff 计数)。 */
  retries: number;
  /** 链耗尽后置 true(下次 request-error 时直接透传上游)。 */
  exhausted: boolean;
  /**
   * 会话页面指定的模型(事实主模型)。由 index.ts 的 agent/request 监听器在
   * 尚未切换(index<0)时从 proposedConfig 捕获——agent/request-error 的
   * payload 只带 provider 不带 model,LlmFailure 亦然,故只能在此记录。
   * nextCandidate 推进时跳过与它相同的候选:会话模型刚失败过,永不切回。
   * 缺省(极端时序下 error 先于 request)时不跳过,优雅降级。
   */
  pageModel?: Candidate;
  /**
   * 本 step 回退链的稳定轨迹标识(官方 `llm/retry.retryId` 语义:同链复用)。
   * 惰性生成——首次切换前为 undefined,由 index.ts 用 randomUUID 填充,
   * state.ts 保持纯函数(无 IO/随机)以便单测。
   */
  retryId?: string;
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
 *
 * 起点 = `state.index + 1`(-1 时即链首):会话指定模型失败后直接切到
 * 队列第 1 项,再失败切第 2 项,依此推进。扫描时跳过与 `state.pageModel`
 * (会话指定模型)相同的候选——它刚失败过,切回去没有意义(用户把会话
 * 模型也配进队列时的防呆)。
 * - 扫完无候选(或已达最后一项)→ 返回 null(链耗尽);
 * - 若 state.retries >= maxRetries → 返回 null(达到上限);
 * - 否则返回新 { index, retries }。
 */
export function nextCandidate(
  state: FallbackState,
  maxRetries: number,
): { index: number; retries: number } | null {
  if (state.exhausted) return null;
  if (state.retries >= maxRetries) return null;
  for (let i = state.index + 1; i < state.chain.length; i++) {
    const candidate = state.chain[i];
    if (!candidate) return null;
    const page = state.pageModel;
    if (
      page &&
      candidate.provider === page.provider &&
      candidate.model === page.model
    ) {
      continue; // 跳过会话指定模型:它已失败,不作为回退目标
    }
    return { index: i, retries: state.retries + 1 };
  }
  return null;
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

/** 取出或惰性初始化该 step 的回退状态(index=-1:尚未切换,在会话指定模型上)。 */
export function stateFor(
  states: Map<StepKey, FallbackState>,
  key: StepKey,
  chain: ReadonlyArray<Candidate>,
): FallbackState {
  let s = states.get(key);
  if (!s) {
    s = {
      chain,
      index: -1,
      retries: 0,
      exhausted: false,
    };
    states.set(key, s);
  }
  return s;
}
