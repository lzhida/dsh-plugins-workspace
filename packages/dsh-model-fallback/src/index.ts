/**
 * dsh-model-fallback 插件入口。
 *
 * 职责:
 * - 导出 loader 依赖的 name / apply / inject / Config;
 * - apply() 内:
 *   1. 打印 `[dsh-model-fallback] plugin loaded`(e2e 契约,见 dsh-plugin-dev skill);
 *   2. 解析 config(loader 已把 settings 投影成普通值,直接读取);
 *   3. 注册 system-prompt section(对 agent 的协议说明);
 *   4. 监听 `agent/request` waterfall:每次 loop 准备发请求时,如果 state 要求
 *      换 model,则改写 proposedConfig 的 provider/model;
 *   5. 监听 `agent/request-error` waterfall:每次 LLM 请求失败,若在 retryable
 *      失败码白名单 + 还有下一候选 → backoff + 切下一候选 + 返回 retry;
 *      否则透传 dsh-llm-retry 的决策(让同 provider 内重试或抛错);
 *   6. effect 卸载时一次性清理(disposeSection + disposeListeners)。
 *
 * 扩展点选择:
 * - `llm/stream` waterfall(stream-level)只允许在适配器流上叠加监听,不允许
 *   换 options(provider/model);不适合做"换 model 重试";
 * - `agent/request` + `agent/request-error`(loop-level)允许监听器改写
 *   `proposedConfig.provider/model`,且 dsh-llm-retry 已经用这条路径做
 *   provider 内重试——两者正交、可叠加。
 *
 * 类型增强:
 * - `@deepseek-ai/dsh-agent-loop` 公开两个 waterfall 事件(`agent/request` /
 *   `agent/request-error`),但其 .d.ts 未对 cordis `Context.Events` 做
 *   declare module 增强。本文件 `import type {} from '@deepseek-ai/cordis'`
 *   + 文件作用域 `declare module '@deepseek-ai/cordis'` 补全两条事件的签名;
 *   dsh loader 用 tsx 转译时,import type 占位形式被识别,augmentation 生效。
 *
 * 局限性:
 * - 不实现 provider/* 通配条目、role/specificity 分派链;
 * - 不实现"跨回合切回主 model"(本期仅在请求内回退);
 * - backoff 是简单指数退避 + 抖动 ±10%。
 */

import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type { LlmFailure } from '@deepseek-ai/dsh-llm';

// 显式激活 cordis Events 模块增强 —— 让 dsh-agent-loop 暴露的 waterfall
// 事件名在 TS 编译期可见。loader 用 tsx 转译 .ts 源码时,如果 augmentation
// 仅作为 declare module 块存在而不被"激活",增强不生效,`ctx.on('agent/request', ...)`
// 会因 Events 上没这个键而编译失败 → "failed to import"。
// `import type {}` 是 TS 标准的 augmentation 激活形式。
declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/request'(
      payload: { turn: number; step: number; signal: AbortSignal },
      next: () => Promise<RequestConfig>,
    ): Promise<RequestConfig>;
    'agent/request-error'(
      payload: {
        turn: number;
        step: number;
        provider: string;
        failure: LlmFailure;
        retryPolicy?: unknown;
        signal: AbortSignal;
      },
      next: () => Promise<RequestErrorAction | undefined | void>,
    ): Promise<RequestErrorAction | undefined | void>;
  }
}

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
export const name = 'dsh-model-fallback';

/** 依赖注入:无依赖——`agent/request` 与 `agent/request-error` 走全局 waterfall。 */
export const inject: string[] = [];

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

// ── 类型增强说明(本文件作用域的 declare module 不可跨包生效,见下)────
//
// 我们监听 `agent/request` 与 `agent/request-error` 两个 dsh-agent-loop 暴露的
// waterfall 事件,但 `@deepseek-ai/dsh-agent-loop` 的 .d.ts 没对 cordis 的
// `Context.Events` 做 declare module augmentation。在本文件作用域里直接
// `declare module '@deepseek-ai/cordis'` 是无效的:cordis 是第三方包,augmentation
// 必须由该包自身的 .d.ts "看到"才能在跨包编译时生效(host 的 tsconfig 只能看到
// 本仓库的 .ts 源码,看不到此处的 declaration merging),所以 TS 编译会拒绝
// `ctx.on('agent/request', listener)` 的字符串字面量(因为 Events 上没这个键)。
//
// 处理:监听器事件名用 `as never` 断言(等价于 dsh-llm-retry 的处理方式),
// 保持文件内 listener 的强类型签名。

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
  }, 'dsh-model-fallback: protocol section');

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
      // 'agent/request' 由本文件 declare module '@deepseek-ai/cordis' 增强
      // 加入 Context.Events,这里直接用字面量。
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
  }, 'dsh-model-fallback: agent/request listener');

  // 6. 监听 agent/request-error:失败时切下一候选(若还有)
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

        // 让 dsh-llm-retry 先跑(若装载了)——它的结果决定 retry 与否
        const upstream = await next();
        // 不可重试的失败码 → 透传上游决策(可能 throw)
        if (!isFailureRetryable(failure, resolved.retryableCodes)) {
          return upstream;
        }
        const state = getState(key);
        // 链耗尽 → 透传上游决策(dsh-llm-retry 的 retry 也会到这里)
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
  }, 'dsh-model-fallback: agent/request-error listener');
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
