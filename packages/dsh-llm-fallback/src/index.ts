/**
 * dsh-llm-fallback 插件入口。
 *
 * 职责:
 * - 导出 loader 依赖的 name / apply / inject / Config;
 * - apply() 内:
 *   1. 打印 `[dsh-llm-fallback] plugin loaded`(e2e 契约);
 *   2. 解析 config(loader 已把 settings 投影成普通值,直接读取);
 *   3. 注册 system-prompt section(对 agent 的协议说明);
 *   4. 监听 `agent/request` waterfall:每次 loop 准备发请求时,如果 state 要求
 *      换 model,则改写 proposedConfig 的 provider/model;
 *   5. 监听 `agent/request-error` waterfall:每次 LLM 请求失败,若在 retryable
 *      失败码白名单内且还有下一候选 → backoff + 切下一候选 + 返回 retry;
 *      否则透传上游决策(让同 provider 内重试或抛错);
 *   6. effect 卸载时一次性清理(disposeSection + disposeListeners)。
 *
 * 回退时机(fallbackWhen):
 * - `afterRetry`(默认):先 `await next()` 观察上游决策。官方 `dsh-llm-retry`
 *   执行器(normal mode 预算内,或 always mode)返回 `{kind:'retry'}` 时透传之,
 *   **不在本次失败上切换候选**;只有上游无决策(预算耗尽 / 委派下游 / 未装载
 *   官方插件)时才切换——这正是官方行为"重试之后直接中断"的位置,本插件在那里
 *   接手,把中断变成跨 provider 的继续运行。
 * - `immediately`:白名单命中即切,不等上游(兼容 dsh-llm-fallback 0.1.x 语义)。
 *
 * 扩展点选择:
 * - `llm/stream` waterfall(stream-level)只允许在适配器流上叠加监听,不允许
 *   换 options(provider/model);不适合做"换 model 重试";
 * - `agent/request` + `agent/request-error`(loop-level)允许监听器改写
 *   `proposedConfig.provider/model`,且官方 dsh-llm-retry 已经用这条路径做
 *   provider 内重试——两者正交、可叠加。
 *
 * 类型增强:
 * - `@deepseek-ai/dsh-agent-loop` 公开两个 waterfall 事件(`agent/request` /
 *   `agent/request-error`),但其 .d.ts 未对 cordis `Context.Events` 做
 *   declare module 增强。由 src/cordis.d.ts(package.json `types` 字段指向)
 *   提供 ambient augmentation。
 *
 * 局限性:
 * - 不实现 provider/* 通配条目、role/specificity 分派链;
 * - 不实现"跨回合切回主 model"(本期仅在请求内回退);
 * - backoff 是简单指数退避 + 抖动 ±10%。
 */

import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type { LlmFailure } from '@deepseek-ai/dsh-llm';

import { type ResolvedConfig, resolveConfig } from './config.ts';
import { modelFallbackSection } from './protocol.ts';
import {
  type FallbackState,
  type StepKey,
  backoffDelayMs,
  isFailureRetryable,
  nextCandidate,
  stateFor,
} from './state.ts';

/** Cordis 插件名(loader 依赖);与 cordis.patch.yml 的 id 对齐。 */
export const name = 'dsh-llm-fallback';

/** 依赖注入:注册 system-prompt section 需要等待 ctx.systemPrompt 就绪;
 * `agent/request` 与 `agent/request-error` 走全局 waterfall,无需注入。 */
export const inject: string[] = ['systemPrompt'];

/** 插件配置(原样入参;loader 投影成 GUI)。 */
export type FallbackConfigInput = unknown;

/**
 * agent/request waterfall 的"proposedConfig"最小形状(loop 投影后)。
 * 我们只读/写 `provider` 与 `model`,其他字段保留。
 */
interface RequestConfig {
  provider: string;
  model: string;
  reasoningEffort?: unknown;
  maxTokens?: number;
}

/** agent/request-error waterfall 的"action"返回类型(loop 期望 `{kind: 'retry'}`)。 */
interface RequestErrorAction {
  kind: 'retry';
}

/** upstream 决策是否为"重试"(由官方 dsh-llm-retry 等恢复器返回)。 */
function isRetryAction(
  action: RequestErrorAction | undefined | void,
): action is RequestErrorAction {
  return (
    typeof action === 'object' &&
    action !== null &&
    (action as { kind?: unknown }).kind === 'retry'
  );
}

// ── 插件入口 ────────────────────────────────────────────────────────

/**
 * 插件入口。
 *
 * @param ctx - cordis 上下文
 * @param configInput - loader 投影后的用户配置;未配置时为 undefined → 全 default。
 */
export function apply(ctx: Context, configInput?: FallbackConfigInput): void {
  // e2e 契约:装载日志 `[name] ` 前缀格式,e2e 运行器按此结构化匹配。
  console.log(`[${name}] plugin loaded`);

  // 1. 解析配置;非法输入 → 报错但不抛(插件不阻塞宿主)。
  let resolved: ResolvedConfig;
  try {
    resolved = resolveConfig(configInput);
  } catch (err) {
    console.error(`[${name}] invalid config:`, err);
    return;
  }

  // 2. 注册 system-prompt section(总是注册;即便 disabled,section 仍告知 agent 协议存在)
  ctx.effect(() => {
    const disposeSection = ctx.systemPrompt.section(modelFallbackSection());
    return () => disposeSection();
  }, 'dsh-llm-fallback: protocol section');

  // 3. disabled 或空链 → 不挂监听器(只装 section)
  if (!resolved.enabled || resolved.chain.length === 0) {
    return;
  }

  // 4. per-step 回退状态:`turn:step` 当 key
  const states = new Map<StepKey, FallbackState>();

  /** 取出或惰性初始化该 step 的回退状态(从 seed chain 开始)。 */
  const getState = (key: StepKey): FallbackState =>
    stateFor(states, key, resolved.chain);

  // 5. 监听 agent/request:每次 loop 准备发请求时,若 state 要求换 model,
  //    则改写 proposedConfig 的 provider/model。
  ctx.effect(() => {
    const dispose = ctx.on(
      'agent/request',
      async (
        payload: { turn: number; step: number; signal: AbortSignal },
        next: () => Promise<RequestConfig>,
      ): Promise<RequestConfig> => {
        const seed = await next();
        const key: StepKey = `${payload.turn}:${payload.step}`;
        const state = states.get(key);
        // 没有 state = 首次进入,或从未失败过 → 不动 seed
        if (!state || state.index === 0) return seed;
        const expected = state.chain[state.index];
        if (!expected) return seed;
        // 若 seed 已是 state 期望值(其他 listener 也已切),不动
        if (
          seed.provider === expected.provider &&
          seed.model === expected.model
        ) {
          return seed;
        }
        // 否则改写为 state 期望的候选
        return { ...seed, provider: expected.provider, model: expected.model };
      },
    );
    return () => dispose();
  }, 'dsh-llm-fallback: agent/request listener');

  // 6. 监听 agent/request-error:失败时按 fallbackWhen 决定是否切下一候选
  ctx.effect(() => {
    const dispose = ctx.on(
      'agent/request-error',
      async (
        payload: {
          turn: number;
          step: number;
          provider: string;
          failure: LlmFailure;
          retryPolicy?: unknown;
          signal: AbortSignal;
        },
        next: () => Promise<RequestErrorAction | undefined | void>,
      ): Promise<RequestErrorAction | undefined | void> => {
        const { turn, step, failure, signal } = payload;
        const key: StepKey = `${turn}:${step}`;

        // 观察上游决策(dsh-llm-retry 若装载,其 retry 决策从这里返回)
        const upstream = await next();
        // 不可重试的失败码 → 透传上游决策(可能 throw)
        if (!isFailureRetryable(failure, resolved.retryableCodes)) {
          return upstream;
        }
        // afterRetry(默认):上游仍在预算内决定同 provider 重试 → 透传,
        // 不在本次失败上切换;等上游耗尽(无决策)才由本插件接手。
        if (resolved.fallbackWhen === 'afterRetry' && isRetryAction(upstream)) {
          return upstream;
        }
        const state = getState(key);
        // 链耗尽 → 透传上游决策(上游的 retry 也到此为止)
        const advance = nextCandidate(state, resolved.maxRetries);
        if (!advance) {
          state.exhausted = true;
          return upstream;
        }
        // backoff(按当前 attempt 数)+ 切下一候选
        const delay = backoffDelayMs(
          state.retries,
          resolved.baseDelayMs,
          resolved.maxDelayMs,
        );
        if (delay > 0) {
          await sleep(delay);
        }
        if (signal.aborted) return upstream;
        state.index = advance.index;
        state.retries = advance.retries;
        // 返回 retry → loop 会重进 prepareRequest → 我们在 agent/request 里改写 provider/model
        return { kind: 'retry' };
      },
    );
    return () => dispose();
  }, 'dsh-llm-fallback: agent/request-error listener');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// re-export 供测试使用
export { resolveConfig } from './config.ts';
export type { FallbackState, StepKey } from './state.ts';
export {
  backoffDelayMs,
  isFailureRetryable,
  nextCandidate,
  stateFor,
} from './state.ts';
