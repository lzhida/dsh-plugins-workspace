/**
 * 时间窗策略窄模块（时段计划 v2：「时间窗 = 预填冷却表」）。
 *
 * 与 0.6.0 曾实装后整体 revert 的 v1（ee533db/d4aef59）的关键差异：
 * v1 在 state 扫描层加 `extraBlocked` 独立谓词（冷却与日程两套判定并行）；
 * v2 收敛为「窗口即预置冷却」——窗口内把命中候选经既有 `markCooldown`
 * 通道预填进冷却表（到期 = 窗口结束），窗口结束由既有惰性过期自动恢复
 * 优先级。此后冷却跳过扫描（`firstAvailableCandidateIndex` / `nextCandidate`）
 * 无感知地统一处理两种来源，不新增任何扫描路径、不引入定时器。
 *
 * 语义（2026-10-21 用户确认的 D2–D5 决策）：
 * - D2 高峰行为 = 改写切换：窗口内命中候选在 `agent/request` 起点被冷却
 *   跳过改写为链上下一个可用候选，对话不中断（复用冷却起点改写语义）；
 * - D3 默认窗口 = 预置官方错峰默认（高峰 08:30–00:30 / 错峰 00:30–08:30
 *   半价），窗口一律按宿主机本地时区判定（本机即北京时间，行为等价）；
 *   窗口为 `HH:mm` 半开区间 [start, end)：起点 > 终点 = 跨夜回绕；
 *   起点 == 终点 = 全天（沿用 v1 已验证语义）；
 * - D4 配置形态 = 全局窗口 + provider 匹配规则（薄配置：规则 =
 *   provider 匹配模式 + 动作 + 窗口列表，不做每候选 schedule 字段）；
 * - D5 错峰反向 = 支持：`prefer` 规则在窗口内把**不匹配**的候选预填冷却
 *   （同一机制反向使用），错峰时段自动优先 DeepSeek；批量任务错峰排程
 *   不做（第三档任务分型）。
 *
 * 全部候选都被窗口预填冷却时，既有冷却降级语义兜底：扫描层发现无可用
 * 候选 → 退回原顺序放行（冷却/时间窗绝不吞掉全部候选）。
 *
 * 纯函数设计：所有判定以 `now: Date` 注入（本地时区取值经
 * getHours/getMinutes/getDay），测试可用 fake timers 固化边界。
 */

/** 单条时间窗：`HH:mm` 半开区间 [start, end)；start > end = 跨夜；start == end = 全天。 */
export interface TimeWindow {
  start: string;
  end: string;
}

/** 规则动作：`block` = 窗口内冷却命中候选（高峰避让）；`prefer` = 窗口内冷却不匹配候选（错峰反向优先）。 */
export type TimeWindowAction = 'block' | 'prefer';

/** 单条时间窗规则：provider 匹配模式 + 动作 + 窗口列表。 */
export interface TimeWindowRule {
  /**
   * provider 匹配模式：精确 id（`deepseek-account`）、前缀通配
   * （`deepseek-*`，含未来新增的 deepseek 系 provider）或 `*`（全部）。
   * 只匹配 provider 维度（D4：provider 匹配规则，不细到 model）。
   */
  match: string;
  action: TimeWindowAction;
  windows: ReadonlyArray<TimeWindow>;
}

/** 时间窗策略的规整形态（ResolvedConfig.timeWindow）。 */
export interface ResolvedTimeWindow {
  /**
   * 总开关，默认 `false`（存量用户零行为变化；配置未写过该键时不预置
   * 规则——预置官方默认只存在于 schema 默认值与配置卡模板，见
   * DEFAULT_TIME_WINDOW_RULES）。
   */
  enabled: boolean;
  rules: ReadonlyArray<TimeWindowRule>;
}

/**
 * 官方错峰预置模板（D3，2026-10-21 用户确认）：
 * - 高峰 `08:30–00:30`：`deepseek-*` 候选被预填冷却，自动切走；
 * - 错峰 `00:30–08:30`（官方半价时段）：非 `deepseek-*` 候选被预填冷却，
 *   反向优先 DeepSeek。
 * 供 schema 默认值与配置卡「填入官方模板」共用；按宿主本地时区判定
 * （本机 = Asia/Shanghai 时与北京时间语义一致）。
 */
export const DEFAULT_TIME_WINDOW_RULES: ReadonlyArray<TimeWindowRule> = [
  {
    match: 'deepseek-*',
    action: 'block',
    windows: [{ start: '08:30', end: '00:30' }],
  },
  {
    match: 'deepseek-*',
    action: 'prefer',
    windows: [{ start: '00:30', end: '08:30' }],
  },
];

/**
 * 严格解析 `HH:mm` 为当日分钟数（00:00–23:59）。
 * 非 string / 格式不符（`7:30`、`24:00`、`12:60`、空串等）→ null。
 */
export function parseHHmm(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * provider 匹配模式判定：`*` = 全部；尾部 `*` = 前缀匹配（`deepseek-*`
 * 命中 `deepseek-account` / `deepseek-official`）；其余 = 精确相等。
 * 空模式不匹配任何 provider（resolveTimeWindow 已在解析期拒绝）。
 */
export function matchProviderPattern(
  pattern: string,
  provider: string,
): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) {
    return provider.startsWith(pattern.slice(0, -1));
  }
  return pattern === provider;
}

/** 窗口在 `nowMinutes`（当日分钟数）是否生效：半开 [start,end)，跨夜回绕，相等 = 全天。 */
export function windowActiveAt(
  window: TimeWindow,
  nowMinutes: number,
): boolean {
  const start = parseHHmm(window.start);
  const end = parseHHmm(window.end);
  if (start === null || end === null) return false;
  if (start === end) return true; // 全天
  if (start < end) return nowMinutes >= start && nowMinutes < end;
  return nowMinutes >= start || nowMinutes < end; // 跨夜回绕
}

/**
 * 距窗口结束还剩多少分钟（活性窗口内调用）：同时窗为 `end - now`；
 * 跨夜窗在起点后为「到午夜 + end」、在终点前为 `end - now`；
 * 全天窗（start == end）返回 1440（次日同一时刻重新评估，结果不变）。
 * 窗口未生效 / 时间串非法 → null。
 */
export function minutesUntilWindowEnd(
  window: TimeWindow,
  nowMinutes: number,
): number | null {
  const start = parseHHmm(window.start);
  const end = parseHHmm(window.end);
  if (start === null || end === null) return null;
  if (!windowActiveAt(window, nowMinutes)) return null;
  if (start === end) return 1440;
  if (start < end) return end - nowMinutes;
  return nowMinutes >= start ? 1440 - nowMinutes + end : end - nowMinutes;
}

/** 单个候选的时间窗预填结果：冷却到期毫秒时间戳（绝对值，供 markCooldown 换算）。 */
export interface TimeWindowCooldown {
  provider: string;
  model: string;
  until: number;
}

/**
 * 计算时间窗预填冷却表：对每个候选找出「适用且生效」的窗口集合，取
 * **最晚**的窗口结束作为冷却到期（多条规则/重叠窗口不互相缩短）。
 *
 * 适用性（动作语义）：
 * - `block`（高峰避让）：候选 provider **命中**规则模式 → 冷却；
 * - `prefer`（错峰反向）：候选 provider **不命中**规则模式 → 冷却
 *   （把非 DeepSeek 候选先冷却，错峰时段自动优先 DeepSeek）。
 *
 * 纯函数：`now` 注入，本地时区经 Date 取值；候选冷却是「窗口结束前」
 * 的临时状态，窗口结束由既有惰性过期恢复（不在此处理恢复）。
 */
export function resolveTimeWindowCooldowns(
  rules: ReadonlyArray<TimeWindowRule>,
  candidates: ReadonlyArray<{ provider: string; model: string }>,
  now: Date,
): ReadonlyArray<TimeWindowCooldown> {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const result = new Map<string, TimeWindowCooldown>();
  for (const candidate of candidates) {
    let until = 0;
    for (const rule of rules) {
      const matched = matchProviderPattern(rule.match, candidate.provider);
      const applicable = rule.action === 'block' ? matched : !matched;
      if (!applicable) continue;
      for (const window of rule.windows) {
        const minutes = minutesUntilWindowEnd(window, nowMinutes);
        if (minutes === null) continue;
        const candidateUntil = now.getTime() + minutes * 60_000;
        if (candidateUntil > until) until = candidateUntil;
      }
    }
    if (until > 0) {
      result.set(`${candidate.provider}/${candidate.model}`, {
        provider: candidate.provider,
        model: candidate.model,
        until,
      });
    }
  }
  return [...result.values()];
}

/**
 * 解析时间窗策略配置：返回规整后的 `ResolvedTimeWindow`；非法输入抛错
 * （resolveConfig 整体失败 → 监听器保留上一次成功配置，与链项错误同风格）。
 * `enabled` 默认 false（仅显式 `true` 开启）；规则缺省 → 空数组（预置
 * 官方模板由 schema 默认值/配置卡提供，运行时未被写入即不启用任何规则）。
 */
export function resolveTimeWindow(
  enabledInput: unknown,
  rulesInput: unknown,
): ResolvedTimeWindow {
  const enabled = enabledInput === true;
  if (rulesInput === undefined || rulesInput === null) {
    return { enabled, rules: [] };
  }
  if (!Array.isArray(rulesInput)) {
    throw new Error(
      'Invalid dsh-llm-fallback config: timeWindowRules must be an array',
    );
  }
  const rules: TimeWindowRule[] = [];
  for (let i = 0; i < rulesInput.length; i++) {
    const raw = rulesInput[i] as {
      match?: unknown;
      action?: unknown;
      windows?: unknown;
    } | null;
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(
        `Invalid dsh-llm-fallback config: timeWindowRules[${i}] must be an object`,
      );
    }
    if (typeof raw.match !== 'string' || raw.match.length === 0) {
      throw new Error(
        `Invalid dsh-llm-fallback config: timeWindowRules[${i}].match must be a non-empty provider pattern`,
      );
    }
    const action =
      raw.action === undefined || raw.action === null ? 'block' : raw.action;
    if (action !== 'block' && action !== 'prefer') {
      throw new Error(
        `Invalid dsh-llm-fallback config: timeWindowRules[${i}].action must be "block" or "prefer"`,
      );
    }
    if (!Array.isArray(raw.windows)) {
      throw new Error(
        `Invalid dsh-llm-fallback config: timeWindowRules[${i}].windows must be an array`,
      );
    }
    const windows: TimeWindow[] = [];
    for (let w = 0; w < raw.windows.length; w++) {
      const window = raw.windows[w] as {
        start?: unknown;
        end?: unknown;
      } | null;
      if (typeof window !== 'object' || window === null) {
        throw new Error(
          `Invalid dsh-llm-fallback config: timeWindowRules[${i}].windows[${w}] must be an object`,
        );
      }
      if (parseHHmm(window.start) === null || parseHHmm(window.end) === null) {
        throw new Error(
          `Invalid dsh-llm-fallback config: timeWindowRules[${i}].windows[${w}] must have "HH:mm" start/end (00:00-23:59)`,
        );
      }
      windows.push({
        start: String(window.start),
        end: String(window.end),
      });
    }
    rules.push({ match: raw.match, action, windows });
  }
  return { enabled, rules };
}
