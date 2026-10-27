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

/**
 * step 标识:`<sessionId>:<turn>:<step>`(会话隔离)或降级形态
 * `turn:step`(payload 无 agent/session.id 时),由 stepStateKey 统一构造。
 */
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
   * 当前候选(或尚未切换时的会话指定模型)已观察到的白名单内失败次数。
   * 每次白名单命中的失败 +1;切换候选后清零。用于每候选重试预算判定:
   * `candidateFailures - 1`(首次失败不算重试)达到预算上限即切换。
   */
  candidateFailures: number;
  /**
   * 本 step 是否已发生过一次切换(one-shot 标志,perTurn=false 单次切换档消费)。
   * 只在切换动作真正生效处置位(index.ts agent/request-error 切换提交点)——
   * 官方 `dsh-llm-retry` 透传与预算内代执行重试不消耗名额;agent/request 的
   * 冷却起点改写(无候选失败,纯效率优化)同样不算切换。perTurn=false 时本
   * 标志置位后同 step 不再切换;新 step 由 stateFor 重建状态天然重置。
   */
  switched: boolean;
  /**
   * 会话页面指定的模型(事实主模型)。由 index.ts 的 agent/request 监听器在
   * 尚未切换(index<0)时从 proposedConfig 捕获——agent/request-error 的
   * payload 只带 provider 不带 model,LlmFailure 亦然,故只能在此记录。
   * nextCandidate 推进时跳过与它相同的候选:会话模型刚失败过,永不切回。
   * 缺省(极端时序下 error 先于 request)时不跳过,优雅降级。
   */
  pageModel?: Candidate;
  /**
   * 本 step 内按 provider 维护的轨迹链(官方 `llm/retry` format v4 读侧要求:
   * 同一 (turn, step, provider, policyKey) 内 `retry` 必须从 1 起严格连续,
   * `retryId` 链内恒定,且 `(retryId, retry)` 对全局唯一)——因此轨迹事件
   * 不能共用"每 step 一个 retryId + 切换序号"的旧编号(旧编号在跨 provider
   * 的多跳切换与代执行/切换交错时会写出非法序列,导致会话日志恢复被拒)。
   * key = 失败 provider;value = 该 provider 链的 retryId 与已写事件数。
   * retryId 惰性生成(index.ts 注入 randomUUID),state.ts 保持可单测。
   */
  ourChains?: Map<string, ProviderRetryChain>;
}

/** 单个 provider 的本插件轨迹链(见 FallbackState.ourChains)。 */
export interface ProviderRetryChain {
  retryId: string;
  /** 该 provider 链上已写入的本插件事件数(llm/retry 的 retry 序号,1 起)。 */
  attempt: number;
}

/**
 * 取出或惰性创建该 provider 的轨迹链,并返回本次事件应使用的
 * `{ retryId, retry }`(attempt 先自增,首个事件即 1)。
 * 同一 provider 在同一步内跨候选延续同一链(如链 [a/x, a/y] 两项同
 * provider:切到 a/y 后的失败仍是 provider a 的续事件,序号接续)。
 */
export function ourRetryChain(
  state: FallbackState,
  provider: string,
  makeId: () => string,
): ProviderRetryChain {
  state.ourChains ??= new Map<string, ProviderRetryChain>();
  let chain = state.ourChains.get(provider);
  if (!chain) {
    chain = { retryId: makeId(), attempt: 0 };
    state.ourChains.set(provider, chain);
  }
  chain.attempt += 1;
  return chain;
}

/** 从 agent/request 的 proposedConfig 中提取 (provider, model)。 */
export function deriveCandidateFromOptions(opts: {
  provider: string;
  model: string;
}): Candidate {
  return { provider: opts.provider, model: opts.model };
}

/**
 * 网关 408 请求超时对应的 HTTP 状态码。
 * 单独具名:该值是白名单之外唯一按结构化字段放行的判定,边界必须醒目。
 */
const GATEWAY_REQUEST_TIMEOUT_STATUS = 408;

/**
 * 该 failure 是否可触发重试/切换?
 *
 * 判定分两层,均为结构化字段判定(宿主约定:route on code, never parse
 * message——本函数同样绝不读 failure.message):
 *
 * 1. **网关 408 结构化判定**:`failure.status === 408` 直接视为可重试。
 *    数据面依据(宿主 0.2.1-rc.2 实码):`LlmFailure.status` 仅由 deepseek
 *    路由的 `providerError` 填充(响应头/响应行的 HTTP status);pi-ai 路由
 *    的 `classifyPiAiError` 纯文本分类、不产出 status。deepseek 路由下 408
 *    有两种形态——响应体无已知 type → `HTTP_408`(默认白名单已含),网关
 *    透传 `type: "invalid_request_error"` → `INVALID_REQUEST`(白名单外)。
 *    后者若只看 code 会被当成"请求构造错误"而放弃,但 HTTP 408 的语义是
 *    请求超时(临时性失败,与 429 同类):同候选重试与切换都有意义,故对
 *    status=408 无条件放行。该判定先于白名单——存量自定义白名单(未列
 *    `HTTP_408`)的用户无需任何配置迁移即获得此行为;无 status 的失败
 *    (含 pi-ai 路由退化为纯 code 的 408)完全不受影响,零回归。
 * 2. **失败码白名单**:code 命中用户白名单(默认 `DEFAULT_RETRYABLE_CODES`)
 *    → 可重试;未命中 → 透传上游,行为与旧版完全一致。
 */
export function isFailureRetryable(
  failure: LlmFailure,
  retryableCodes: ReadonlySet<string>,
): boolean {
  if (failure.status === GATEWAY_REQUEST_TIMEOUT_STATUS) return true;
  return retryableCodes.has(failure.code);
}

// ── 每候选重试预算(retriesBeforeSwitch × provider retryPolicy 合成) ──

/**
 * 官方 `agent/request-error` payload 中 `retryPolicy` 的最小结构面。
 * 运行时即 `@deepseek-ai/dsh-llm` 的 `ResolvedRetryPolicy`——provider 适配器
 * 注册时解析冻结的策略(normal 模式带 `maxRetries`,宿主默认 5;always 模式
 * 无上限);官方 `dsh-llm-retry` 插件按它在同 provider 内执行重试。
 */
export interface RetryPolicyLike {
  mode?: unknown;
  maxRetries?: unknown;
}

/** 每候选重试计划:切换前允许的同候选重试上限 + 预算内无官方决策时是否代执行。 */
export interface CandidateRetryPlan {
  /**
   * 当前候选切换前允许的同候选重试次数(首次失败不计);
   * `Infinity` = 无上限(自动档遇 always 策略:整体跟随官方无限重试)。
   */
  maxRetries: number;
  /**
   * 预算内上游无决策(未装官方 retry 插件 / provider 无策略)时,
   * 本插件是否代执行同候选重试(自带退避 + 轨迹事件)。
   */
  selfRetry: boolean;
}

/**
 * 合成"每候选重试预算"。
 *
 * 语义(0.5.0 起,取代旧 fallbackWhen 两档):
 * - 自定义 `configured > 0`:**以插件配置为准**——预算 = N,不再被 provider
 *   重试策略封顶。N 大于官方预算时,预算内由官方 `dsh-llm-retry` 执行重试
 *   (本插件透传其决策),超出的部分由本插件代执行(selfRetry,自带退避与
 *   轨迹事件),直到 N 用满才切下一候选。
 * - 自动档 `configured === 0`:跟随 provider retryPolicy——
 *   - normal 策略 → 预算 = `policyMax`(官方默认 5)——与旧 afterRetry 等价;
 *   - policy 缺失 → 预算 0(首失败即切)——与旧 afterRetry 未装官方插件时等价;
 *   - always 策略(无限重试)→ 预算 Infinity 且不代执行(整体透传官方决策,
 *     永不提前切);官方缺席时上游无决策 → 由调用方直接走切换。
 *
 * 防御:policy 形态异常(非 normal/always、maxRetries 非有限非负数)视同缺失;
 * configured 非法(负数/NaN/非有限)视同 0。
 */
export function resolveCandidateRetryPlan(
  configured: number,
  policy: RetryPolicyLike | undefined,
): CandidateRetryPlan {
  const custom =
    Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 0;
  if (custom > 0) {
    // 自定义档:插件配置说了算;provider 预算只决定"谁执行"——预算内官方
    // 重试(透传),超出部分由本插件代执行,直到 N 用满。
    return { maxRetries: custom, selfRetry: true };
  }
  if (policy !== undefined && policy.mode !== 'normal') {
    // always(或形态异常的非 normal 策略):无重试次数可比,整体跟随官方。
    return { maxRetries: Number.POSITIVE_INFINITY, selfRetry: false };
  }
  const policyMax =
    policy !== undefined &&
    typeof policy.maxRetries === 'number' &&
    Number.isFinite(policy.maxRetries) &&
    policy.maxRetries >= 0
      ? Math.floor(policy.maxRetries)
      : undefined;
  return { maxRetries: policyMax ?? 0, selfRetry: true };
}

/**
 * 推进到下一候选。
 *
 * 起点 = `state.index + 1`(-1 时即链首):会话指定模型失败后直接切到
 * 队列第 1 项,再失败切第 2 项,依此推进。扫描时跳过与 `state.pageModel`
 * (会话指定模型)相同的候选——它刚失败过,切回去没有意义(用户把会话
 * 模型也配进队列时的防呆)。
 * 传入 `cooldowns` 时(失败冷却启用)再跳过仍在冷却窗内的候选——它们
 * 在此前的 step 里失败过且尚未到期,先试排在后面的可用候选效率更高;
 * 若冷却吞掉了全部剩余候选,降级回原语义(忽略冷却只跳 pageModel):
 * 冷却只是效率优化,绝不能让链失去全部候选而提前报错。
 * - 扫完无候选(或已达最后一项)→ 返回 null(链耗尽);
 * - 若 state.retries >= maxRetries → 返回 null(达到上限);
 * - 否则返回新 { index, retries }。
 */
export function nextCandidate(
  state: FallbackState,
  maxRetries: number,
  cooldowns?: ReadonlyMap<string, number>,
  now: number = 0,
): { index: number; retries: number } | null {
  if (state.exhausted) return null;
  if (state.retries >= maxRetries) return null;
  const page = state.pageModel;
  const sameAsPage = (candidate: Candidate): boolean =>
    page !== undefined &&
    candidate.provider === page.provider &&
    candidate.model === page.model;
  let skippedCooling = false;
  for (let i = state.index + 1; i < state.chain.length; i++) {
    const candidate = state.chain[i];
    if (!candidate) return null;
    if (sameAsPage(candidate)) continue;
    if (cooldowns !== undefined && isCoolingDown(cooldowns, candidate, now)) {
      skippedCooling = true;
      continue;
    }
    return { index: i, retries: state.retries + 1 };
  }
  if (skippedCooling) {
    // 降级扫描:剩余候选全部在冷却中 → 忽略冷却,回到只跳 pageModel 的
    // 原语义。被跳过的候选仍值得再试(总比报错中断对话好),到期与否由
    // 下次 step 起点的冷却判定重新评估。
    for (let i = state.index + 1; i < state.chain.length; i++) {
      const candidate = state.chain[i];
      if (!candidate) return null;
      if (sameAsPage(candidate)) continue;
      return { index: i, retries: state.retries + 1 };
    }
  }
  return null;
}

// ── 失败冷却(failure cooldown)───────────────────────────────────────
//
// 跨 step 的"优先级 × 效率"平衡:白名单失败耗尽每候选重试预算并切换后,
// 失败方(provider/model)进入短冷却窗——窗口内后续 step 不再从它开始
// (agent/request 直接改写为链上第一个可用候选),避免每个 step 都重复
// 支付同一故障模型的失败成本;窗口期满自动恢复其优先级,下次请求按正常
// 顺序重新验证是否恢复(恢复则继续优先使用,未恢复则再次冷却)。
// 表结构:key = cooldownKey(candidate),value = 冷却到期毫秒时间戳。
// 存于插件进程内存(apply 闭包),跨 step/对话共享;宿主重启即清零。

/**
 * 冷却表的键:`provider/model`。
 * parseChainEntry 以首个 `/` 分割,provider 段不含 `/` 而 model 段可含
 * (如 openrouter 风格 id),故该拼接无歧义。
 */
export function cooldownKey(candidate: Candidate): string {
  return `${candidate.provider}/${candidate.model}`;
}

/** 该候选是否仍在冷却期内(到期时间戳 > now)。过期条目由写入侧惰性清理。 */
export function isCoolingDown(
  table: ReadonlyMap<string, number>,
  candidate: Candidate,
  now: number,
): boolean {
  const until = table.get(cooldownKey(candidate));
  return until !== undefined && until > now;
}

/** 清理已过期的冷却条目(惰性,防表随时间无限增长)。 */
export function purgeExpiredCooldowns(
  table: Map<string, number>,
  now: number,
): void {
  for (const [key, until] of table) {
    if (until <= now) table.delete(key);
  }
}

/**
 * 把刚失败并切换离开的候选记入冷却表:`now + cooldownMs` 前不再作为
 * step 起点或推进目标;到期后自动恢复优先级(下次请求重新验证)。
 * cooldownMs <= 0 视为立即过期(等效不冷却);写入前顺带惰性清理过期条目。
 */
export function markCooldown(
  table: Map<string, number>,
  candidate: Candidate,
  now: number,
  cooldownMs: number,
): void {
  purgeExpiredCooldowns(table, now);
  table.set(cooldownKey(candidate), now + Math.max(0, cooldownMs));
}

/**
 * 当前生效的候选(即失败方):index >= 0 → 链上候选;index = -1 →
 * 会话指定模型。agent/request-error 的 payload 只带 provider 不带 model,
 * 失败方只能由回退状态推出(发请求前 agent/request 已把 provider/model
 * 改写为该候选)。极端时序下 pageModel 缺失 → undefined(调用方跳过
 * 冷却标记,优雅降级)。
 */
export function currentEffectiveCandidate(
  state: FallbackState,
): Candidate | undefined {
  if (state.index >= 0) return state.chain[state.index];
  return state.pageModel;
}

/**
 * step 起点的冷却跳过:会话指定模型(种子)在冷却中时,从链首找出第一个
 * 「不在冷却中且 ≠ pageModel」的候选下标,让该 step 直接从它开始——
 * 即"从下一个回退模型或此前验证可用的候选开始"。
 * - 无可用候选(链空 / 剩余全部在冷却中)→ 返回 -1:调用方保持 index=-1,
 *   按原语义从会话模型开始——冷却绝不吞掉全部候选;
 * - 既有防呆保持:与 pageModel 相同的队列项照旧跳过。
 */
export function firstAvailableCandidateIndex(
  chain: ReadonlyArray<Candidate>,
  table: ReadonlyMap<string, number>,
  options: { pageModel?: Candidate; now: number },
): number {
  const page = options.pageModel;
  for (let i = 0; i < chain.length; i++) {
    const candidate = chain[i];
    if (!candidate) break;
    if (
      page &&
      candidate.provider === page.provider &&
      candidate.model === page.model
    ) {
      continue;
    }
    if (isCoolingDown(table, candidate, options.now)) continue;
    return i;
  }
  return -1;
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

/**
 * 构造 step 状态键:`<sessionId>:<turn>:<step>`(会话隔离)。
 *
 * 旧键位 `turn:step` 不含会话标识,多会话并发时同号 turn 共享同一状态
 * (切换进度互相串扰),且新 turn 建态清理可能误清其他会话的在途状态。
 * 会话标识取自 `agent/request(-error)` payload 的 `agent.session.id`
 * (官方类型两个 payload 均带 `agent: Agent`);缺失(旧宿主 / 非 agent
 * 作用域 dispatch)时降级为无会话段的 `turn:step` 形态——与旧行为兼容,
 * 多会话退化为共享键位(优雅降级,非崩溃)。
 */
export function stepStateKey(
  sessionId: string | undefined,
  turn: number,
  step: number,
): StepKey {
  return sessionId ? `${sessionId}:${turn}:${step}` : `${turn}:${step}`;
}

/** 自右解析 step 键 → 会话段与 turn 段;非 `turn:step` 形态返回 null。 */
function parseStepKey(key: StepKey): { session: string; turn: string } | null {
  const stepColon = key.lastIndexOf(':');
  if (stepColon < 0) return null;
  const turnColon = key.lastIndexOf(':', stepColon - 1);
  return {
    session: turnColon < 0 ? '' : key.slice(0, turnColon),
    turn: key.slice(turnColon + 1, stepColon),
  };
}

/**
 * 清理与 `key` 同会话、不同 turn 的全部 step 状态(key 由 stepStateKey
 * 构造:`<sessionId>:<turn>:<step>` 或降级 `turn:step`)。
 *
 * 每 step 的回退状态在一次失败推进后就死掉,却从不清理,超长会话下按 step
 * 数无上界缓增;在 stateFor 的创建分支(新 turn 首次请求建态时)调用本函数,
 * 按「同会话异 turn」移除旧 step 键——单会话内表上界收敛为其当前 turn 的
 * step 数。**会话隔离**:其他会话的键位(含同号 turn)一律保留——跨会话
 * 互不清理,否则并发会话的新 turn 建态会误清他会在途状态;代价是每会话在
 * 其最末 turn 后遗留少量状态(上界 ≈ 会话数 × 单 turn step 数,每项小对象,
 * 宿主重启即清零)。无会话段的降级键视为空串会话,只清同桶异 turn,
 * 不波及会话键。冷却表是独立的 Map,与本函数无关,跨 step 冷却语义不受影响。
 *
 * 防御:key 缺 `:`(非 `turn:step` 形态,正常不会发生)时无法定位 turn,
 * 直接返回不删任何键;表内异常形态键解析失败时跳过——清理绝不误删。
 */
export function purgeStaleTurnStates(
  states: Map<StepKey, FallbackState>,
  key: StepKey,
): void {
  const parsed = parseStepKey(key);
  if (!parsed) return;
  for (const existing of states.keys()) {
    const other = parseStepKey(existing);
    if (!other) continue;
    if (other.session === parsed.session && other.turn !== parsed.turn) {
      states.delete(existing);
    }
  }
}

/** 取出或惰性初始化该 step 的回退状态(index=-1:尚未切换,在会话指定模型上)。 */
export function stateFor(
  states: Map<StepKey, FallbackState>,
  key: StepKey,
  chain: ReadonlyArray<Candidate>,
): FallbackState {
  let s = states.get(key);
  if (!s) {
    // 新键首次建态:清理同会话其他 turn 的旧 step 状态(会话隔离,见
    // purgeStaleTurnStates)。只在创建分支触发——已存在键的常规读取
    // 不扫描、零成本。
    purgeStaleTurnStates(states, key);
    s = {
      chain,
      index: -1,
      retries: 0,
      exhausted: false,
      candidateFailures: 0,
      switched: false,
    };
    states.set(key, s);
  }
  return s;
}
