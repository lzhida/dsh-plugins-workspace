/**
 * dsh-llm-fallback 插件入口。
 *
 * 职责:
 * - 导出 loader 依赖的 name / apply / inject / Config;
 * - apply() 内:
 *   1. 打印 `[dsh-llm-fallback] plugin loaded`(e2e 契约);
 *   2. 解析 config(loader 已把 settings 投影成普通值,直接读取);
 *   3. 注册 system-prompt section(对 agent 的协议说明);
 *   4. 监听 `agent/request` waterfall(**只读**,0.6.0 起):每次 loop 准备发
 *      请求时——尚未切换(index<0)则经 `payload.agent.model.current()` 把
 *      会话页面指定的模型捕获为 pageModel(事实主模型,配置链不含主模型);
 *      时间窗预填冷却表(见 4b)。**绝不改写返回值**——宿主 0.2.2-rc.1 的
 *      prepareRequest 会校验 waterfall 输出的 provider/model 必须等于 step
 *      选定 selection,改写即抛错;step 内换模型在新宿主已不可能。
 *   5. 监听 `agent/request-error` waterfall:每次 LLM 请求失败,若在 retryable
 *      失败码白名单内,按"每候选重试预算"(retriesBeforeSwitch × provider
 *      retryPolicy 合成,见 state.ts resolveCandidateRetryPlan)三分支决策:
 *      - 预算内 + 官方 dsh-llm-retry 有 retry 决策 → 透传(官方执行同候选重试);
 *      - 预算内 + 官方无决策(未装官方插件/无策略)→ 本插件代执行同候选重试
 *        (写轨迹(llm/retry)+ backoff + 返回 retry,不推进 index);
 *      - 预算耗尽 → 写轨迹(llm/retry)+ backoff + 经 `payload.agent.model
 *        .select()` 持久化切换到下一候选(保留当前 reasoningEffort;宿主自动
 *        插入 `[model changed: ...]` user message)+ 返回 retry;
 *      预算耗尽(切换或链耗尽)时把失败方记入冷却表(见 4b);
 *      否则(白名单外/链耗尽)透传上游决策(让同 provider 内重试或抛错)。
 *   6. effect 卸载时一次性清理(disposeSection + disposeListeners)。
 *
 * 4b. 失败候选冷却(cooldown,跨 step):白名单失败耗尽每候选重试预算并
 *     切换(或链耗尽)后,失败方(provider+model)记入冷却表,cooldownMs
 *     (默认 5 分钟)内不再作为推进目标——error 路径推进链时(nextCandidate)
 *     跳过冷却中的候选;窗口期满该模型自动恢复优先级,下次推进不再跳过它,
 *     按正常顺序重新验证是否恢复(恢复则继续作为候选,未恢复则再次冷却)。
 *     冷却只是效率优化:剩余候选全部在冷却中时退回原顺序,绝不让冷却吞掉
 *     全部候选;非白名单失败与预算内的同候选重试不记冷却;
 *     cooldownEnabled=false 时表保持为空,行为与旧版完全一致。
 *     0.6.0 语义变化:切换经 model.select 持久化,**下一 step 生效**(本 step
 *     的 selection 已在 preStep 快照,loop 将用旧模型重发一次;该次失败后
 *     透传上游,turn 以错误结束——selection 已持久化且 [model changed] 提示
 *     已入会话,用户重发即从新候选继续)。
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
 * 扩展点选择(0.6.0 修订):
 * - `agent/request-error`(loop-level)决策恢复;切换走官方
 *   `agent.model.select()`——宿主唯一跨 step 换模型 API(写持久
 *   `model/selection` 事件 + 自动插 `[model changed]` user message);
 * - `agent/request` waterfall 0.2.2-rc.1 起被宿主校验锁定(proposedConfig
 *   必须等于 step selection,改写即抛"use agent.model.select() before step
 *   preparation"),本插件只读使用(pageModel 捕获/预填);
 * - `llm/stream` waterfall(stream-level)只允许在适配器流上叠加监听,不允许
 *   换 options(provider/model);不适合做"换 model 重试"。
 *
 * 类型增强:
 * - 0.6.0 起事件与模型类型全部来自官方 `@deepseek-ai/dsh-agent`(其
 *   runtime-types.d.ts 自带 Context.Events 增强与 Agent 模型面);插件旧
 *   ambient 增强(src/cordis.d.ts)已清空为注释壳,避免与官方声明重复冲突。
 *
 * 局限性:
 * - **切换时序(新宿主架构约束)**:selection 在 preStep 快照,step 内重试
 *   恒用同一模型;model.select 的效果自**下一 step** 起。切换决定当 step
 *   最多再支付一次旧模型调用(retry 重发),随后透传上游——官方预算已耗尽
 *   时 turn 以错误结束,用户重发即从新候选续跑。"对话不中断"的承诺相应
 *   调整为"切换无缝生效于下一轮";
 * - 不实现 provider/* 通配条目、role/specificity 分派链;
 * - 不实现"跨回合切回会话指定模型"(回退状态以 `<会话id>:<turn>:<step>`
 *   为 key——会话隔离,多会话同号 turn 互不串扰;payload 缺会话标识时
 *   降级共享键位——新 step 天然从会话指定模型重新开始;同一 step 内链耗尽
 *   后不再回头);冷却跳过在此之上做跨 step 优化:冷却中的模型被跳过、
 *   窗口期满自动恢复优先级,不改变"新 step 从会话指定模型重新开始"的
 *   基准语义;配额感知自适应冷却(src/quota.ts)再按失败内容延长配额型
 *   失败(订阅制用量窗口耗尽)的冷却时长——报错带重置时间直接采用,
 *   否则配额档(quotaCooldownMs,默认 5 小时),普通失败固定档不变;
 * - 冷却表存于插件进程内存:宿主重启 / 插件重载后清零(重启后首轮请求会
 *   重新验证全部模型);
 * - backoff 是简单指数退避 + 抖动 ±10%;
 * - 轨迹复用官方 `llm/retry` / `llm/retry-started` 事件类型(policyKey='llm-fallback'
 *   可辨识):`Session.append` 无法写 `ignorable` 标记,自创事件类型会在会话日志
 *   恢复时被 format v4 读侧拒绝,官方已知类型是插件唯一的持久化安全通道。
 */

import { randomUUID } from 'node:crypto';

import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm';

import { type ResolvedConfig, resolveConfig } from './config.ts';
import { modelFallbackSection } from './protocol.ts';
import { type CooldownDuration, resolveCooldownDuration } from './quota.ts';
import {
  type FallbackState,
  type StepKey,
  backoffDelayMs,
  cooldownKey,
  currentEffectiveCandidate,
  isFailureRetryable,
  markCooldown,
  nextCandidate,
  ourRetryChain,
  resolveCandidateRetryPlan,
  stateFor,
  stepStateKey,
} from './state.ts';
import { resolveTimeWindowCooldowns } from './schedule.ts';
import {
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

/** upstream 决策是否为"重试"(由官方 dsh-llm-retry 等恢复器返回)。 */
function isRetryAction(
  action: { kind: 'retry' } | undefined | void,
): action is { kind: 'retry' } {
  return (
    typeof action === 'object' &&
    action !== null &&
    (action as { kind?: unknown }).kind === 'retry'
  );
}

/**
 * 经官方 `agent.model.select()` 持久化一次模型切换(0.6.0 起唯一合法切换
 * 通道):写 durable `model/selection` 事件,宿主自动插 `[model changed: ...]`
 * user message。reasoningEffort 保留切换前的值(换模型不改推理力度,与旧版
 * 改写 proposedConfig 时保留 seed effort 的行为一致)。
 *
 * 失败安全:select 写 durable 会话事件,任何异常被吞掉并只打日志——辅助动作
 * 失败绝不允许炸掉 loop 的恢复链(调用方随后仍返回 retry,行为退化为
 * "本 step 继续旧模型、链耗尽照常透传",等同旧链耗尽路径)。
 */
function persistModelSwitch(
  agent: Agent,
  target: { provider: string; model: string },
): void {
  try {
    const current = agent.model.current();
    const reasoningEffort: ReasoningEffortId | undefined =
      current?.reasoningEffort;
    agent.model.select({
      provider: target.provider,
      model: target.model,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    });
  } catch (err) {
    console.error(`[${name}] model.select failed (switch degraded):`, err);
  }
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

  // 4. per-step 回退状态:`<会话id>:<turn>:<step>` 当 key(会话隔离;
  //    payload 缺 agent/session.id 时降级为无会话段的 `turn:step`)
  const states = new Map<StepKey, FallbackState>();

  // 4b. 失败候选冷却表(key = 'provider/model',value = 冷却到期毫秒时间戳)。
  //     跨 step 共享:白名单失败耗尽预算切换(或链耗尽)后,失败方在窗口内
  //     不再作为后续 step 的起点或推进目标;过期条目在标记时惰性清理。
  //     cooldownEnabled=false 时表保持为空、查询短路,行为与旧版完全一致。
  const cooldowns = new Map<string, number>();

  /** 取出或惰性初始化该 step 的回退状态(从当前 chain 开始)。 */
  const getState = (key: StepKey): FallbackState =>
    stateFor(states, key, current().chain);

  // 5. 监听 agent/request(只读,0.6.0 起):每次 loop 准备发请求时——
  //    - 尚未切换(index<0):经官方 `agent.model.current()` 把会话页面指定
  //      的模型捕获为 pageModel(事实主模型,回退时永不切向它);
  //    - 时间窗预填冷却表(时段计划 v2,纯表操作,无副作用);
  //    - **绝不改写返回值**:宿主 0.2.2-rc.1 的 prepareRequest 校验 waterfall
  //      输出必须等于 step 选定 selection,改写即抛错;step 内换模型已不可
  //      能,切换统一走 error 路径的 model.select(下一 step 生效)。
  ctx.effect(() => {
    const dispose = ctx.on('agent/request', async (payload, next) => {
      const seed = await next();
      // 键位含会话标识:多会话并发时同号 turn 的状态互不串扰(会话隔离,
      // 见 state.ts stepStateKey;缺失时降级 `turn:step` 共享键位)
      const key: StepKey = stepStateKey(
        payload.agent?.session.id,
        payload.turn,
        payload.step,
      );
      // 惰性创建/取出该 step 的状态(此前仅在失败时创建;现在请求阶段就建,
      // 以便在首次失败前捕获会话指定模型——error payload 不带 model)
      const cfg = current();
      const state = stateFor(states, key, cfg.chain);
      if (state.index < 0 && !state.pageModel) {
        // 官方 API 读当前 selection:与 seed(proposedConfig,同一 selection
        // 的投影)一致;current() 缺失时降级读 seed,双保险。
        const selection = payload.agent?.model.current();
        state.pageModel = {
          provider: selection?.provider ?? seed.provider,
          model: selection?.model ?? seed.model,
        };
      }
      // 时间窗预填冷却表(时段计划 v2,「时间窗=预填冷却表」):窗口内
      // 按规则动作(block=冷却命中 provider / prefer=冷却未命中 provider)
      // 把候选经既有 markCooldown 通道预填进冷却表(到期 = 窗口结束,
      // 宿主本地时区);error 路径推进链时(nextCandidate)跳过这些候选。
      // max-merge:已有冷却条目(失败冷却或更晚窗口)到期更晚时不缩短它。
      // 预填覆盖链候选与会话指定模型(它可能不在链上,但同样受窗口约束)。
      if (
        cfg.cooldownEnabled &&
        cfg.timeWindow.enabled &&
        cfg.timeWindow.rules.length > 0
      ) {
        const nowMs = Date.now();
        const page = state.pageModel;
        const targets =
          page &&
          !state.chain.some(
            (c) => c.provider === page.provider && c.model === page.model,
          )
            ? [page, ...state.chain]
            : [...state.chain];
        const prefill = resolveTimeWindowCooldowns(
          cfg.timeWindow.rules,
          targets,
          new Date(),
        );
        let changed = 0;
        for (const entry of prefill) {
          const existing = cooldowns.get(cooldownKey(entry));
          if (existing !== undefined && existing >= entry.until) continue;
          markCooldown(cooldowns, entry, nowMs, entry.until - nowMs);
          changed += 1;
        }
        if (changed > 0) {
          console.log(
            `[${name}] time-window: prefilled cooldown for ${changed} candidate(s) until their window end`,
          );
        }
      }
      // 冷却跳过(0.5.0 在此改写 proposedConfig)已随改写通道一并移除:
      // selection 在 preStep 快照,request 里的 select 对本 step 无效;
      // 跳过语义由 error 路径推进链时的冷却感知扫描(nextCandidate)承担。
      return seed;
    });
    return () => dispose();
  }, 'dsh-llm-fallback: agent/request listener');

  // 6. 监听 agent/request-error:失败时按每候选重试预算决定
  //    "再试当前候选"(透传官方 / 代执行)还是"切下一候选"(model.select
  //    持久化,下一 step 生效)
  ctx.effect(() => {
    const dispose = ctx.on('agent/request-error', async (payload, next) => {
      const { turn, step, failure, signal } = payload;
      // 键位与 agent/request 监听器同一构造(stepStateKey),会话段缺失
      // 时同样降级——两侧构造一致是状态能对上的前提
      const key: StepKey = stepStateKey(payload.agent?.session.id, turn, step);
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
        payload.retryPolicy as Parameters<typeof resolveCandidateRetryPlan>[1],
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

      // 预算耗尽 → 切下一候选(即使上游仍想重试也按配置覆盖)。
      // 冷却感知扫描:跳过仍在冷却窗内的候选(它们在此前 step 失败过且
      // 未到期),剩余候选全部在冷却中时降级回原顺序(见 nextCandidate)。
      const advance = nextCandidate(
        state,
        cfg.maxRetries,
        cfg.cooldownEnabled ? cooldowns : undefined,
        Date.now(),
      );
      // 冷却标记:预算耗尽即认定失败方暂时不可用(无论随后是切换成功、
      // 退避被 abort 还是链耗尽)——白名单失败是既成事实,冷却窗内不再
      // 从它开始,窗口期满自动恢复优先级重新验证。失败方未知(极端时序
      // pageModel 缺失)或冷却禁用时不标记。
      // 时长自适应(配额感知,决策逻辑见 src/quota.ts):配额型失败
      // (订阅制用量窗口耗尽,GLM 1308/1310 / MiniMax 2056 等)冷却到
      // 报错携带的重置时间,无重置时间用配额档 quotaCooldownMs;普通
      // 失败维持 cooldownMs 固定档(与旧版行为一致)。延长发生时打日志
      // (观察点),决策结果随下方切换事件写入轨迹(cooldownUntilMs /
      // cooldownSource 追加字段,读侧透传安全)。
      let cooldown: CooldownDuration | undefined;
      if (cfg.cooldownEnabled) {
        const failed = currentEffectiveCandidate(state);
        if (failed) {
          const now = Date.now();
          cooldown = resolveCooldownDuration(failure, {
            cooldownMs: cfg.cooldownMs,
            quotaEnabled: cfg.quotaCooldownEnabled,
            quotaCooldownMs: cfg.quotaCooldownMs,
            cooldownCapMs: cfg.cooldownCapMs,
            now,
          });
          markCooldown(cooldowns, failed, now, cooldown.durationMs);
          if (cooldown.source !== 'default') {
            console.log(
              `[${name}] quota-aware cooldown for ${failed}: ${cooldown.durationMs}ms (${cooldown.source}, until ${new Date(cooldown.untilMs).toISOString()})`,
            );
          }
        }
      }
      // perTurn=false(单次切换档):本 step 已切换过(one-shot 名额已消耗)
      // → 不再切换,透传上游决策(官方 retry 若仍想重试则继续同候选重试,
      // 那不是切换)。闸门挂在冷却标记之后:白名单失败耗尽预算是既成事实,
      // 与链耗尽路径一样照常记冷却。名额只在下方切换提交处置位消耗——
      // 官方重试透传与预算内代执行不经过此分支,不消耗名额。
      if (!cfg.perTurn && state.switched) {
        return upstream;
      }
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
        cooldownUntilMs: cooldown?.untilMs,
        cooldownSource: cooldown?.source,
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
      // 切换已生效:消耗 one-shot 名额(perTurn=false 时本 step 不再切换;
      // 退避被 abort 的路径在上方提前返回,不置位、不消耗名额)
      state.switched = true;
      // 0.6.0:切换经官方 agent.model.select 持久化(写 durable
      // model/selection 事件 + 自动插 [model changed] user message)。
      // **下一 step 生效**——本 step 的 selection 已在 preStep 快照,loop
      // 将用旧模型重发一次(retry);该次失败后本 step 不再推进(下方
      // perTurn/透传路径接管),turn 以错误结束,用户重发即从新候选继续。
      // 防御:官方类型 payload.agent 必有,但缺失时静默跳过(select 是
      // 辅助动作,失败不阻断回退本体——retry 照常返回)。
      if (payload.agent) persistModelSwitch(payload.agent, target);
      // 返回 retry 撑住 turn(不能不返回——那会让 loop 立即抛 LlmError,
      // 连"旧模型再试一次"的机会与轨迹收尾都没有)
      return { kind: 'retry' };
    });
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
  cooldownKey,
  currentEffectiveCandidate,
  firstAvailableCandidateIndex,
  isCoolingDown,
  isFailureRetryable,
  markCooldown,
  nextCandidate,
  ourRetryChain,
  purgeExpiredCooldowns,
  purgeStaleTurnStates,
  resolveCandidateRetryPlan,
  stateFor,
  stepStateKey,
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
