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
   * 报错携带的重置时间(直接采用,经 cap 封顶)。
   */
  source: 'default' | 'quota-window' | 'reported-reset';
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
 * - 非配额型(或配额延长关闭/配额档为 0)→ `cooldownMs` 固定档(default,
 *   与旧版行为完全一致);
 * - 配额型 + 报错带重置时间 → `resetAt - now`(reported-reset);
 * - 配额型无重置时间 → `quotaCooldownMs` 固定档(quota-window);
 * - 所有结果 clamp:`> 0` 且 `≤ cooldownCapMs`(cap > 0 时)——防解析
 *   异常把候选冻死;cap 内的周/月级重置时间被截断到 cap,冷却到期后
 *   重新验证语义自然衔接(未恢复则再次冷却)。
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
  const durationMs = clamp(opts.cooldownMs);
  return { durationMs, source: 'default', untilMs: now + durationMs };
}
