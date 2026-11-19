/**
 * 配额感知的自适应冷却时长(纯函数,可单测)。
 *
 * 背景:订阅制提供商(GLM Coding Plan / MiniMax Token Plan 等)有 5 小时/
 * 每周/每月用量窗口,窗口耗尽后的 429 在默认 5 分钟冷却期内反复重试毫无
 * 意义。本模块在「失败候选记冷却」时按失败内容决策冷却时长:
 *
 * 1. **报错携带具体重置时间** → 直接采用(GLM 1308/1310 的
 *    「您的限额将在 ${next_flush_time} 重置」、MiniMax 2056 的
 *    「resets at 2026-05-15T15:00:00Z」);
 * 2. **识别为配额型但无重置时间** → 用配额冷却档 `quotaCooldownMs`
 *    (默认 5 小时,对齐 GLM/MiniMax 的窗口周期);
 * 3. **普通失败(瞬时限流/服务器错误等)** → 维持既有 `cooldownMs`
 *    (默认 5 分钟)档,行为与旧版完全一致。
 *
 * 设计约定(与 state.ts isFailureRetryable 的「route on code, never parse
 * message」边界的关系):**失败判定主链路不读 message**——是否可重试/切换
 * 仍完全由 code 白名单决定;message 解析只发生在「已判定可重试且切换、
 * 正在记冷却」之后,只影响冷却时长,且解析失败时优雅降级到固定档,绝不
 * 影响切换主流程。理由:宿主的配额分类(`isQuotaExceededError`)只认英文
 * 措辞,中文网关文案(「已达到 Token Plan 用量上限」)落到 RATE_LIMIT——
 * 重置时间与业务码只存在于 message 里,这是被动解析报错的唯一信息来源。
 *
 * 样本依据(2026-10 调研,可实测提供商仅 GLM 与 MiniMax 官方):
 * - GLM(bigmodel 错误码文档):429 业务码 1308「已达到 ${number} ${unit}
 *   的使用上限。您的限额将在 ${next_flush_time} 重置」、1310「您已达到
 *   每周/每月使用上限,您的限额将在 ${next_flush_time} 重置」;1302/1305
 *   为瞬时限流(并发/过载,无重置时间);
 * - MiniMax(官方错误码文档 + 真实报文):2056「usage limit exceeded,
 *   5-hour usage limit reached for Token Plan Starter (0/0 used),
 *   resets at 2026-05-15T15:00:00Z (2056)」;
 * - 本地轨迹真实样本:antirion 网关中文形态「429 已达到 Token Plan 用量
 *   上限 (2056)」(网关包装,无重置时间,带业务码尾巴)。
 * 其他订阅制提供商(Claude/Codex 等)的报错格式未实测,靠通用模式兜底
 * (英文 resets at / ISO 时间),提取失败一律降级固定档,零风险。
 */

import type { LlmFailure } from '@deepseek-ai/dsh-llm';

// ── 冷却时长决策 ────────────────────────────────────────────────────

/** 冷却时长决策结果。 */
export interface CooldownDuration {
  /** 冷却时长(毫秒),> 0,已按 cap 封顶。 */
  durationMs: number;
  /**
   * 决策来源:`default` = 普通失败档(固定 cooldownMs);`quota-window` =
   * 配额型但报错无重置时间(固定 quotaCooldownMs);`reported-reset` =
   * 报错携带的重置时间(直接采用,经 cap 封顶);`retry-after` = 服务端
   * 结构化 retry-after 要求(限流对齐,优先于熔断/固定档,配额型除外);
   * `breaker` = 连续失败熔断递增档(cooldownMs × 2^failures,经
   * breakerCapMs 封顶)。
   */
  source:
    'default' | 'quota-window' | 'reported-reset' | 'retry-after' | 'breaker';
  /** 冷却到期绝对时间戳(= 决策时刻 now + durationMs;供轨迹事件展示)。 */
  untilMs: number;
}

/** resolveCooldownDuration 的输入配置(resolveConfig 产物的相关切片)。 */
export interface CooldownDurationOptions {
  /** 普通失败档冷却时长(毫秒)。 */
  cooldownMs: number;
  /** 配额延长总开关(quotaCooldownEnabled)。 */
  quotaEnabled: boolean;
  /** 配额冷却档时长(毫秒);0 = 关闭延长(配额型同普通失败档)。 */
  quotaCooldownMs: number;
  /** 冷却时长硬上限(毫秒);> 0 时所有延长结果被 clamp 到它。 */
  cooldownCapMs: number;
  /** 决策时刻(毫秒时间戳,测试可注入)。 */
  now: number;
  /**
   * 服务端要求的等待时长(毫秒;`LlmFailure.providerRetryAfterMs`,> 0
   * 生效)——限流对齐档:它是服务端**明确要求**的等待时长,权威于本地
   * 猜测档(熔断递增/固定档);仍受 cooldownCapMs 封顶(总上限是用户显式
   * 配置,守护所有来源)。**优先级在配额族之后**:配额型失败已由配额档
   * 接管,短 retry-after 不得把数小时的配额保护压成秒级。
   */
  retryAfterMs?: number;
  /**
   * 熔断递增:该候选**已发生**的连续失败次数(state.ts advanceBreaker
   * 维护,观察期已满则读为 0)。`> 0` 时本次窗口 = cooldownMs ×
   * 2^failures(已失败 1 次 → 2 倍,2 次 → 4 倍);从无失败(0)起算的
   * 第一次失败仍走固定档(1 倍,零回归)。
   */
  breakerFailures?: number;
  /**
   * 熔断递增总开关(cooldownBreakerEnabled);`false` 跳过递增档。
   * 缺省为开启(与配置层默认一致),只有显式 false 才关闭。
   */
  breakerEnabled?: boolean;
  /**
   * 熔断递增结果独立封顶(毫秒);非法(非有限/≤ 0)→ 不封顶。
   * 注:配置层(resolveConfig)已把非法值归一到默认 30 分钟,故线上不会
   * 出现"无封顶";此处的不封顶仅为纯函数层的兜底口径。封顶不生效于
   * 低于固定档的值——递增只会让冷却变长,绝不缩短。
   */
  breakerCapMs?: number;
}

/**
 * 直接命中的配额类失败码(宿主已按英文措辞分类完成,无需读 message):
 * - `QUOTA`——deepseek 路由 isQuotaExceededError 命中 / status 402;
 *   pi-ai 路由 isQuotaExceededError 命中;
 * - `ACCOUNT_QUOTA`——宿主账户配额类(本插件白名单既有码)。
 */
const QUOTA_CODES: ReadonlySet<string> = new Set(['QUOTA', 'ACCOUNT_QUOTA']);

/**
 * 限流族失败码:仅当 code 命中它时才启用 message 关键词识别——避免把
 * 普通 429 之外的失败误判成配额。宿主两套路由的 429 都产出 RATE_LIMIT
 * (pi-ai:`/\b429\b|rate.?limit/i`;deepseek:`status===429`)。
 */
const RATE_LIMIT_CODES: ReadonlySet<string> = new Set(['RATE_LIMIT']);

/**
 * message 里的配额强信号(仅在 code 为 RATE_LIMIT 时作为兜底识别):
 * - `(2056)`——MiniMax Token Plan 用量上限业务码(网关形态常带括号尾巴);
 * - `1308` / `1310` / `1309`——GLM 用量上限 / 周·月上限 / 套餐到期业务码;
 * - `usage limit`——MiniMax 英文原文措辞;
 * - `用量上限` / `使用上限`——两家中文文案的共同措辞;
 * - `5-hour`——MiniMax 5 小时窗口措辞;
 * - `quota`——英文配额措辞兜底(宿主分类已覆盖主流英文形态,此处只兜
 *   网关包装形态)。
 * 误判后果可控:即使瞬时 429 被误延长,冷却到期自动恢复优先级,且全链
 * 冷却时既有降级语义保证绝不吞掉全部候选。
 */
const QUOTA_MESSAGE_SIGNALS: readonly RegExp[] = [
  /\b2056\b/,
  /\b130[89]\b/,
  /\b1310\b/,
  /usage\s*limit/i,
  /用量上限/,
  /使用上限/,
  /5-hour/i,
  /\bquota\b/i,
];

/** 该失败是否为配额型(用量窗口耗尽类)。 */
export function isQuotaLikeFailure(failure: LlmFailure): boolean {
  const code = failure.code;
  if (QUOTA_CODES.has(code)) return true;
  if (!RATE_LIMIT_CODES.has(code)) return false;
  const message = failure.message;
  if (typeof message !== 'string' || message.length === 0) return false;
  return QUOTA_MESSAGE_SIGNALS.some((pattern) => pattern.test(message));
}

// ── 重置时间提取(parseResetTimeMs)─────────────────────────────────

/**
 * 重置关键词:报错中声明「重置/reset」的字样。**仅绝对日期时间提取**
 * 要求报错含它——防止把套餐到期日、注册日期等无关日期误当重置时间;
 * 相对时长分支不走此门(其锚定措辞 retry after / N 单位后重试本身已
 * 自证语义,且英文「retry after 25 minutes」不含 reset 字样)。
 */
const RESET_KEYWORD = /重置|resets?\s+(?:at|on|in)|reset\s+at|will\s+reset/i;

/**
 * 绝对日期时间(Markdown 转义后逐段拼接,避免 factory 形态):
 * `2026-05-15T15:00:00Z` / `2026-05-15 15:00:00+08:00` /
 * `2026-05-15 15:00`(naive,按宿主本地时区解析——GLM 为中国服务,报错
 * 时间与其文档示例一致按本地时区理解,与宿主部署时区一致的假设成立)。
 */
const ABSOLUTE_DATETIME =
  /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?/;

/**
 * 相对时长(锚定到明确的「之后重试/重置」措辞,防止把「5-hour usage
 * limit」这类窗口名误读为 5 小时时长):
 * - 英文 `retry after/in 25 minutes`(要求 retry/try again 前导);
 * - 中文 `25 分钟后重置 / 2 小时后重试`(要求「后」+ 动词)。
 */
const RELATIVE_DURATION =
  /(?:retry|try\s+again)\s+(?:after|in)\s+(\d+)\s*(s\b|sec\b|secs\b|seconds?\b|m\b|min\b|mins\b|minutes?\b|h\b|hr\b|hours?\b)|(\d+)\s*(秒|分钟|小时)\s*后\s*(?:重置|再试|重试)/i;

/** 相对时长单位 → 毫秒。 */
const RELATIVE_UNIT_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  秒: 1_000,
  分钟: 60_000,
  小时: 3_600_000,
};

/** 时区偏移串(`Z` / `+08:00` / `-0530`)→ 分钟数;无时区返回 0。 */
function timezoneOffsetMinutes(tz: string | undefined): number | null {
  if (!tz) return null; // naive → 由调用方按本地时区解析
  if (tz === 'Z' || tz === 'z') return 0;
  const sign = tz[0] === '-' ? -1 : 1;
  const digits = tz.slice(1).replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2, 4));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return sign * (hours * 60 + minutes);
}

/**
 * 从报错 message 提取重置时间(毫秒时间戳)。
 *
 * 提取顺序:相对时长(锚定措辞自证语义,无前置门)> 绝对日期时间
 * (要求报错含重置关键词)。防御:
 * - 解析结果必须 > now(过去的时间是过期信息,视为未提取——回落固定档);
 * - 不认得的格式一律返回 null,由调用方降级 `quotaCooldownMs` 固定档。
 *
 * 已知缺口:GLM `next_flush_time` 的实际渲染格式官方文档未给出(只有
 * 占位符),本函数按 `YYYY-MM-DD HH:mm(:ss)` 通用形态覆盖;实测若为其他
 * 形态(如 `MM-DD HH:mm`),补充正则即可——提取失败时的降级档仍比默认
 * 5 分钟强(见 resolveCooldownDuration)。
 *
 * @param message - 失败原文(LlmFailure.message,provider/网关透传)。
 * @param now - 当前毫秒时间戳(过去时刻防御)。
 * @returns 重置时间戳;无法提取返回 null。
 */
export function parseResetTimeMs(message: string, now: number): number | null {
  if (typeof message !== 'string' || message.length === 0) return null;

  // 1) 相对时长:锚定措辞自证语义(retry after / N 单位后重试),无需
  //    重置关键词前置门——锚定本身已排除窗口名(5-hour usage limit)噪声
  const relative = RELATIVE_DURATION.exec(message);
  if (relative) {
    const englishValue = relative[1];
    const englishUnit = relative[2];
    const chineseValue = relative[3];
    const chineseUnit = relative[4];
    const value = Number(englishValue ?? chineseValue);
    const unitMs = englishUnit
      ? RELATIVE_UNIT_MS[englishUnit.toLowerCase()]
      : RELATIVE_UNIT_MS[chineseUnit ?? ''];
    if (Number.isFinite(value) && unitMs !== undefined && value > 0) {
      const resetAt = now + value * unitMs;
      if (resetAt > now) return resetAt;
    }
  }

  // 2) 绝对日期时间:要求报错含重置关键词(防套餐到期日等无关日期),
  //    取第一个可解析的未来时刻
  if (!RESET_KEYWORD.test(message)) return null;
  const absolute = ABSOLUTE_DATETIME.exec(message);
  if (absolute) {
    const [, y, mo, d, h, mi, s, tz] = absolute;
    const offsetMinutes = timezoneOffsetMinutes(tz);
    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    const hour = Number(h);
    const minute = Number(mi);
    const second = Number(s ?? '0');
    let resetAt: number;
    if (offsetMinutes === null) {
      // naive:按宿主本地时区构造(GLM 为中国服务,与部署时区一致)
      resetAt = new Date(year, month - 1, day, hour, minute, second).getTime();
    } else {
      // 带时区:按 UTC 分量构造再减偏移(Z → UTC;±HH:mm → 该时区)
      const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
      resetAt = asUtc - offsetMinutes * 60_000;
    }
    if (Number.isFinite(resetAt) && resetAt > now) return resetAt;
  }

  return null;
}

// ── 决策入口 ────────────────────────────────────────────────────────

/**
 * 按失败内容决策一次冷却的时长(记冷却前的唯一决策点)。
 *
 * 决策优先级(前者覆盖后者):
 * 1. **配额型失败** → 报错带重置时间则采用(resetAt - now,reported-reset);
 *    否则用 `quotaCooldownMs` 固定档(quota-window)。配额保护优先于
 *    retry-after 对齐:配额窗口动辄数小时,短 retry-after 压过它会让
 *    冷却骤降到秒级,等于绕过配额保护反复重试已耗尽的机器。
 * 2. **服务端 retry-after**(`retryAfterMs` > 0)→ 直接采用(retry-after):
 *    服务端明确要求的等待时长,权威于本地猜测档;仅受 cooldownCapMs
 *    总上限封顶。仅对非配额型失败生效。
 * 3. **熔断递增**(开关开且已发生连败次数 > 0)→ `cooldownMs × 2^failures`
 *    (breaker),经 `breakerCapMs` 独立封顶(封顶不低于固定档,递增只会
 *    让冷却变长);连败次数为 0(首次失败 / 观察期已满视为恢复)时不走
 *    此档——窗口与固定档同值,零回归。
 * 4. **普通失败** → `cooldownMs` 固定档(default,与旧版行为完全一致)。
 *
 * 配额派生与 retry-after 结果 clamp:`> 0` 且 `≤ cooldownCapMs`(cap > 0 时);熔断档使用独立 breakerCapMs(有效封顶不低于固定档)——防解析异常把
 * 候选冻死;cap 内的周/月级重置时间被截断到 cap,冷却到期后重新验证
 * 语义自然衔接(未恢复则再次冷却)。
 */
export function resolveCooldownDuration(
  failure: LlmFailure,
  opts: CooldownDurationOptions,
): CooldownDuration {
  const now = opts.now;
  const capMs =
    Number.isFinite(opts.cooldownCapMs) && opts.cooldownCapMs > 0
      ? Math.floor(opts.cooldownCapMs)
      : Number.POSITIVE_INFINITY;
  const clamp = (ms: number): number =>
    Math.min(Math.max(0, Math.floor(ms)), capMs);

  // 1) 配额族:配额型失败(QUOTA/ACCOUNT_QUOTA 码,或 RATE_LIMIT + 配额
  //    措辞)优先走配额档——配额保护优先于 retry-after 对齐:配额窗口
  //    动辄数小时,若让一个短 retry-after 压过它,冷却会从 5 小时骤降到
  //    秒级,等于绕过配额保护反复重试一台已耗尽的机器。
  const quotaLike =
    opts.quotaEnabled &&
    opts.quotaCooldownMs > 0 &&
    isQuotaLikeFailure(failure);
  if (quotaLike) {
    const resetAt = parseResetTimeMs(failure.message, now);
    if (resetAt !== null) {
      const durationMs = clamp(resetAt - now);
      if (durationMs > 0) {
        return {
          durationMs,
          source: 'reported-reset',
          untilMs: now + durationMs,
        };
      }
    }
    const fallback = clamp(opts.quotaCooldownMs);
    if (fallback > 0) {
      return {
        durationMs: fallback,
        source: 'quota-window',
        untilMs: now + fallback,
      };
    }
  }

  // 2) 限流对齐:服务端结构化 retry-after 对齐服务端给出的等待时间,
  //    优先于本地猜测档(熔断/固定)。仅在非配额型失败上生效(配额型已
  //    被上一档接管),避免绕过配额保护。
  const retryAfterMs = opts.retryAfterMs;
  if (
    typeof retryAfterMs === 'number' &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs > 0
  ) {
    const durationMs = clamp(retryAfterMs);
    if (durationMs > 0) {
      return {
        durationMs,
        source: 'retry-after',
        untilMs: now + durationMs,
      };
    }
  }

  // 3) 熔断递增:同候选连续失败 → 冷却窗口指数递增(2^failures,failures
  //    = 已发生的连续失败次数),由 breakerCapMs 独立封顶(与配额档的
  //    cooldownCapMs 分离:熔断是本地故障放大,不需要配额级的周/月
  //    上限)。已失败次数为 0(首次失败/观察期已恢复)时不走此分支——
  //    窗口与固定档相同,保持 default 来源(零回归)。
  const failures =
    typeof opts.breakerFailures === 'number' &&
    Number.isFinite(opts.breakerFailures)
      ? Math.floor(opts.breakerFailures)
      : 0;
  if (opts.breakerEnabled !== false && failures > 0) {
    const base = Math.max(0, Math.floor(opts.cooldownMs));
    const breakerCapMs =
      typeof opts.breakerCapMs === 'number' &&
      Number.isFinite(opts.breakerCapMs) &&
      opts.breakerCapMs > 0
        ? Math.floor(opts.breakerCapMs)
        : Number.POSITIVE_INFINITY;
    // 封顶不得低于固定档:用户把 cooldownMs 配得比 breakerCapMs 还长
    // 时(如 1h vs 30min),递增结果若被封到 30min 反而比固定档更短——
    // 递增只会让冷却变长、绝不缩短,故有效封顶取两者较大值。
    const effectiveCap = Math.max(breakerCapMs, base);
    const escalated = base * 2 ** failures;
    const durationMs = Math.min(
      Math.max(0, Math.floor(escalated)),
      effectiveCap,
    );
    if (durationMs > 0) {
      return {
        durationMs,
        source: 'breaker',
        untilMs: now + durationMs,
      };
    }
  }

  const durationMs = clamp(opts.cooldownMs);
  return { durationMs, source: 'default', untilMs: now + durationMs };
}
