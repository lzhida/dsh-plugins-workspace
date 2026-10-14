/**
 * dsh-llm-fallback 插件入口。
 *
 * 职责:
 * - 导出 loader 依赖的 name / apply / inject / Config;
 * - apply() 内:
 *   1. 打印 `[dsh-llm-fallback] plugin loaded`(e2e 契约);
 *   2. 解析 config(loader 已把 settings 投影成普通值,直接读取);
 *   3. 注册 system-prompt section(对 agent 的协议说明);
 *   4. 监听 `agent/request` waterfall:每次 loop 准备发请求时——尚未切换
 *      (index<0)则把会话页面指定的模型捕获为 pageModel(事实主模型,配置
 *      链不含主模型),已切换(index>=0)则改写 proposedConfig 为链上候选;
 *   5. 监听 `agent/request-error` waterfall:每次 LLM 请求失败,若在 retryable
 *      失败码白名单内,按"每候选重试预算"(retriesBeforeSwitch × provider
 *      retryPolicy 合成,见 state.ts resolveCandidateRetryPlan)三分支决策:
 *      - 预算内 + 官方 dsh-llm-retry 有 retry 决策 → 透传(官方执行同候选重试);
 *      - 预算内 + 官方无决策(未装官方插件/无策略)→ 本插件代执行同候选重试
 *        (写轨迹(llm/retry)+ backoff + 返回 retry,不推进 index);
 *      - 预算耗尽 → 写轨迹(llm/retry)+ backoff + 切下一候选
 *        + 写轨迹(llm/retry-started)+ 返回 retry(即使上游仍想重试也覆盖);
 *      否则(白名单外/链耗尽)透传上游决策(让同 provider 内重试或抛错)。
 *   6. effect 卸载时一次性清理(disposeSection + disposeListeners)。
 *
 * 主模型语义(0.5.0 起):会话页面指定的模型就是事实主模型;配置的
 * fallbackChains 是纯回退候选队列,会话模型失败后按队列顺序切换(首失败
 * → chain[0]),推进时自动跳过与 pageModel 相同的候选(用户把会话模型
 * 也配进队列的防呆,同时让旧"首项=主模型"配置零迁移)。
 *
 * 每候选重试次数(retriesBeforeSwitch,0.5.0 起取代旧 fallbackWhen 两档):
 * - `0`(默认)= 自动跟随 provider retryPolicy 的 `maxRetries`(宿主默认 5):
 *   预算内透传官方 retry,耗尽后切换——正是旧 afterRetry 语义;policy 缺失时
 *   预算 0,首失败即切;
 * - `N > 0` = **以插件配置为准**:当前候选重试 N 次后才切,不被 provider
 *   预算封顶。N 大于官方预算时,预算内由官方 `dsh-llm-retry` 执行重试(透传
 *   其决策),超出的部分由本插件代执行(自带退避 + 轨迹事件),直到 N 用满。
 *   (provider retryPolicy 本身可编辑:llm-deepseek 顶层 volatile 字段 /
 *   llm-pi-ai 的 providers.<id>.retryPolicy,保存即经 loader/volatile-update
 *   热更新;自动档因此天然跟随用户在 provider 侧的调整。)
 * - `always` 模式策略:自动档整体透传官方无限重试;自定义档按 N 覆盖切换。
 * - 同一 step 内逐候选计数:candidateFailures 随切换清零,每个候选(含会话
 *   指定模型)都获得完整预算。
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
 * - 不实现"跨回合切回会话指定模型"(回退状态以 turn:step 为 key,新 step
 *   天然从会话指定模型重新开始;同一 step 内链耗尽后不再回头);
 * - backoff 是简单指数退避 + 抖动 ±10%;
 * - 轨迹复用官方 `llm/retry` / `llm/retry-started` 事件类型(policyKey='llm-fallback'
 *   可辨识):`Session.append` 无法写 `ignorable` 标记,自创事件类型会在会话日志
 *   恢复时被 format v4 读侧拒绝,官方已知类型是插件唯一的持久化安全通道。
 */

import { randomUUID } from 'node:crypto';

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
  ourRetryChain,
  resolveCandidateRetryPlan,
  stateFor,
} from './state.ts';
import {
  type TrajectoryAgent,
  FALLBACK_RETRY_POLICY_KEY,
  effectiveMaxSwitches,
  recordFallbackScheduled,
  recordFallbackStarted,
} from './trajectory.ts';

/** Cordis 插件名(loader 依赖);与 cordis.patch.yml 的 id 对齐。 */
export const name = 'dsh-llm-fallback';

/** 依赖注入:
 * - `systemPrompt`:注册协议 section 需要等待 ctx.systemPrompt 就绪,否则
 *   cordis proxy 抛 "cannot get property systemPrompt without inject"。
 * `agent/request` 与 `agent/request-error` 走全局 waterfall,无需注入。
 * (设置面板的模型目录由自带 client 经 `remote.session.modelCatalog()` 获取,
 * 不经过宿主侧本插件,故无需注入 `llm`。) */
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

  // 1a. Config 字段均为 volatile(设置面板可编辑,applies: 'live'),运行时
  //     收到的是 Volatile 引用。每次使用时重新解包+解析,让设置面板里的改动
  //     立即生效(无需重载插件);解析失败(用户在 UI 里存了非法值)时保留
  //     上一次成功值,绝不让监听器抛错。
  const current = (): ResolvedConfig => {
    try {
      resolved = resolveConfig(configInput);
    } catch {
      // 保留 last good
    }
    return resolved;
  };

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

  /** 取出或惰性初始化该 step 的回退状态(从当前 chain 开始)。 */
  const getState = (key: StepKey): FallbackState =>
    stateFor(states, key, current().chain);

  // 5. 监听 agent/request:每次 loop 准备发请求时——
  //    - 尚未切换(index<0):当前就是会话页面指定的模型(事实主模型),
  //      捕获为 pageModel(回退时永不切向它),不改写 seed;
  //    - 已切换(index>=0):改写 proposedConfig 为链上当前候选。
  ctx.effect(() => {
    const dispose = ctx.on(
      'agent/request',
      async (
        payload: { turn: number; step: number; signal: AbortSignal },
        next: () => Promise<RequestConfig>,
      ): Promise<RequestConfig> => {
        const seed = await next();
        const key: StepKey = `${payload.turn}:${payload.step}`;
        // 惰性创建/取出该 step 的状态(此前仅在失败时创建;现在请求阶段就建,
        // 以便在首次失败前捕获会话指定模型——error payload 不带 model)
        const state = stateFor(states, key, current().chain);
        if (state.index < 0) {
          if (!state.pageModel) {
            state.pageModel = {
              provider: seed.provider,
              model: seed.model,
            };
          }
          return seed;
        }
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

  // 6. 监听 agent/request-error:失败时按每候选重试预算决定
  //    "再试当前候选"(透传官方 / 代执行)还是"切下一候选"
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
          /** fused dispatcher 注入的主体 agent;session 用于写轨迹(可选,防御旧宿主)。 */
          agent?: TrajectoryAgent;
        },
        next: () => Promise<RequestErrorAction | undefined | void>,
      ): Promise<RequestErrorAction | undefined | void> => {
        const { turn, step, failure, signal } = payload;
        const key: StepKey = `${turn}:${step}`;
        // 读取当前(可能已被设置面板改过的)配置
        const cfg = current();

        // 观察上游决策(dsh-llm-retry 若装载,其 retry 决策从这里返回)
        const upstream = await next();
        // 不可重试的失败码 → 透传上游决策(可能 throw);不计入候选失败数
        if (!isFailureRetryable(failure, cfg.retryableCodes)) {
          return upstream;
        }
        const state = getState(key);
        // 每候选重试预算 = 用户 retriesBeforeSwitch(>0 时为准;=0 自动跟随
        // provider retryPolicy)。防御:payload.retryPolicy 形态异常时按缺失处理,
        // 见 resolveCandidateRetryPlan。
        const plan = resolveCandidateRetryPlan(
          cfg.retriesBeforeSwitch,
          payload.retryPolicy as Parameters<
            typeof resolveCandidateRetryPlan
          >[1],
        );
        state.candidateFailures += 1;
        // 首次失败不算重试:已重试次数 = 失败数 - 1
        const candidateRetries = state.candidateFailures - 1;

        // 预算内:让当前候选继续重试,不切换
        if (candidateRetries < plan.maxRetries) {
          // 官方 retry 有决策 → 透传(它执行同候选重试,预算由它记)
          if (isRetryAction(upstream)) return upstream;
          // 官方无决策(未装官方插件/provider 无策略,或自定义 N 已超出官方
          // 预算)且计划允许 → 本插件代执行同候选重试:不推进 index,loop
          // 重发时 agent/request 不改写候选
          if (plan.selfRetry) {
            // 官方 format v4 读侧按 (turn, step, provider, policyKey) 校验
            // retry 序列从 1 起严格连续、retryId 链内恒定——故轨迹链按
            // provider 维护(见 state.ts ourRetryChain),代执行与该 provider
            // 上的切换事件共用同一链、序号接续。
            const chain = ourRetryChain(state, payload.provider, randomUUID);
            const target =
              state.index >= 0 ? state.chain[state.index] : state.pageModel;
            const delay = backoffDelayMs(
              candidateRetries,
              cfg.baseDelayMs,
              cfg.maxDelayMs,
            );
            // 轨迹透明化:同候选代重试也写官方 `llm/retry` 形态事件——retry 记
            // provider 链内序号(1 起连续),maxRetries 记有效预算,target 是
            // 被重试的候选自身(轨迹里"同一模型第 N 次重试"直接可见)。
            // durable 先于退避等待。
            recordFallbackScheduled(payload.agent?.session, {
              retryId: chain.retryId,
              turn,
              step,
              provider: payload.provider,
              mode: 'normal',
              policyKey: FALLBACK_RETRY_POLICY_KEY,
              retry: chain.attempt,
              maxRetries: Math.min(plan.maxRetries, Number.MAX_SAFE_INTEGER),
              delayMs: delay,
              failure,
              targetProvider: target?.provider,
              targetModel: target?.model,
            });
            if (delay > 0) {
              const completed = await sleep(delay, signal);
              // 退避等待被取消(turn 中止)→ 透传上游,不写 started、不重试
              if (!completed) return upstream;
            }
            if (signal.aborted) return upstream;
            recordFallbackStarted(payload.agent?.session, {
              retryId: chain.retryId,
              turn,
              step,
              retry: chain.attempt,
            });
            return { kind: 'retry' };
          }
          // always 策略(无预算可比)但官方无决策:没有可依赖的同候选执行器,
          // 落到切换分支(等价旧 afterRetry 在未装官方插件时的语义)。
        }

        // 预算耗尽 → 切下一候选(即使上游仍想重试也按配置覆盖)
        const advance = nextCandidate(state, cfg.maxRetries);
        if (!advance) {
          state.exhausted = true;
          return upstream;
        }
        // backoff(按当前切换次数)+ 切下一候选
        const delay = backoffDelayMs(
          state.retries,
          cfg.baseDelayMs,
          cfg.maxDelayMs,
        );
        // 轨迹透明化:向会话日志写入官方 `llm/retry` 事件(normal 形态)——
        // 宿主轨迹 UI 把它渲染为请求节点的重试状态(错误消息 + code +
        // retry N/maxRetries + delayMs);targetProvider/targetModel(本插件
        // 追加字段,读侧透传安全)让"切到哪个模型继续跑"在轨迹里直接可见,
        // 与宿主 loop 自动记录的 request/header+context 数据层互补。
        // durable 先于退避等待,与官方 dsh-llm-retry 的写入时机一致。
        // retry 记 provider 链内序号(format v4 校验:同一 (turn, step,
        // provider, policyKey) 内从 1 起严格连续)——与该 provider 上的代执行
        // 事件共链接续,不再是"step 内切换序号"(旧编号跨 provider 多跳时
        // 会写出非法序列,导致会话日志恢复被拒)。
        const chain = ourRetryChain(state, payload.provider, randomUUID);
        const target = state.chain[advance.index];
        recordFallbackScheduled(payload.agent?.session, {
          retryId: chain.retryId,
          turn,
          step,
          provider: payload.provider,
          mode: 'normal',
          policyKey: FALLBACK_RETRY_POLICY_KEY,
          retry: chain.attempt,
          maxRetries: effectiveMaxSwitches(state.chain.length, cfg.maxRetries),
          delayMs: delay,
          failure,
          targetProvider: target?.provider,
          targetModel: target?.model,
        });
        if (delay > 0) {
          const completed = await sleep(delay, signal);
          // 退避等待被取消(turn 中止)→ 透传上游,不写 started、不切换
          if (!completed) return upstream;
        }
        if (signal.aborted) return upstream;
        // 轨迹:退避完成,切换即将生效(loop 将用新候选重发请求)
        recordFallbackStarted(payload.agent?.session, {
          retryId: chain.retryId,
          turn,
          step,
          retry: chain.attempt,
        });
        state.index = advance.index;
        state.retries = advance.retries;
        // 新候选获得完整预算:候选失败计数清零
        state.candidateFailures = 0;
        // 返回 retry → loop 会重进 prepareRequest → 我们在 agent/request 里改写 provider/model
        return { kind: 'retry' };
      },
    );
    return () => dispose();
  }, 'dsh-llm-fallback: agent/request-error listener');
}

/**
 * 可取消的退避等待:signal 中止时立即 resolve(false)(不再傻等剩余延迟,
 * loop 的 waterfall 不被已取消的 turn 拖住);正常到期 resolve(true)。
 */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// re-export 供测试使用
// 注意:`Config` 必须 re-export 出来——dsh 加载器通过 `plugin.Config` 读 schemastery schema
// 生成 settings UI 的 settings 表单(`dsh-app-boot` 的 `collectConfigSchemas`)。
// 不 re-export 会让 status 变成 "absent" / configRef = "#/$defs/unknownConfig",设置面板不渲染字段。
export { resolveConfig, Config } from './config.ts';
export type { FallbackState, StepKey } from './state.ts';
export {
  backoffDelayMs,
  isFailureRetryable,
  nextCandidate,
  ourRetryChain,
  resolveCandidateRetryPlan,
  stateFor,
} from './state.ts';
export type {
  CandidateRetryPlan,
  ProviderRetryChain,
  RetryPolicyLike,
} from './state.ts';
export type {
  LlmRetryEventData,
  LlmRetryStartedEventData,
  TrajectoryAgent,
  TrajectorySession,
} from './trajectory.ts';
export {
  FALLBACK_RETRY_POLICY_KEY,
  effectiveMaxSwitches,
  recordFallbackScheduled,
  recordFallbackStarted,
} from './trajectory.ts';
