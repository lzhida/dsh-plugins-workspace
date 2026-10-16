/**
 * 时段计划(schedule)策略纯函数:窗口解析、目标匹配与阻塞判定。
 *
 * 设计目标(与 state.ts 一致):决策全部下沉到本模块,便于单元测试覆盖;
 * index.ts 的 listener 只做"事件分发 + 改写"。本模块无任何 I/O 与时钟依赖——
 * `now` 毫秒时间戳由调用方注入,窗口按 **宿主机本地时区** 的墙钟语义求值
 * (桌面端即用户机器时区;DST 由本地时间的 getHours/getMinutes 自然处理)。
 *
 * 语义(roadmap §5 D2-D4 决策):
 * - 目标匹配:规则 `targets` 每项为 `provider/model`(精确)或 `provider/*`
 *   (通配 = 覆盖该 provider 全部模型,含未来新增;picker 产出精确项,
 *   通配供手改配置使用);
 * - 窗口:`HH:mm` 半开区间 `[start, end)`;`start > end` = 跨夜回绕
 *   (如 22:00-06:00);`start == end` = 全天(对齐 LiteLLM off-peak 约定);
 *   `days` 为 ISO 星期(1=周一 … 7=周日),缺省 = 每天;
 * - 判定 = 「任一规则的 targets 命中候选 × 该规则任一窗口命中当前时刻」;
 * - 阻塞是路由建议而非硬拒绝:全部候选被阻塞时调用方必须降级放行
 *   (对齐冷却哲学「绝不吞掉全部候选」),本模块只回答"是否被阻塞"。
 */

import type { Candidate } from './state.ts';

/** 单条时段规则的用户配置形态(未经校验)。 */
export interface ScheduleRuleInput {
  targets?: unknown;
  windows?: unknown;
}

/** 单条窗口的用户配置形态(未经校验)。 */
export interface ScheduleWindowInput {
  start?: unknown;
  end?: unknown;
  days?: unknown;
}

/** 规整后的窗口:分钟数与派生标记,匹配时零解析开销。 */
export interface ResolvedWindow {
  /** 起点距 00:00 的分钟数(0-1439,含)。 */
  readonly startMinutes: number;
  /** 终点距 00:00 的分钟数(0-1439,不含——半开区间)。 */
  readonly endMinutes: number;
  /** start > end:窗口跨午夜(如 22:00-06:00)。 */
  readonly wraps: boolean;
  /** start == end:全天阻塞。 */
  readonly allDay: boolean;
  /** 生效星期集合(ISO 1-7);null = 每天。 */
  readonly days: ReadonlySet<number> | null;
}

/** 规整后的规则:目标串(原样保留供匹配)+ 解析后的窗口。 */
export interface ScheduleRule {
  readonly targets: ReadonlyArray<string>;
  readonly windows: ReadonlyArray<ResolvedWindow>;
}

/** 时段计划的最终规整形态。 */
export interface ResolvedSchedule {
  readonly enabled: boolean;
  readonly rules: ReadonlyArray<ScheduleRule>;
}

/** `HH:mm` 解析为距 00:00 的分钟数;非法返回 null。接受 `H:mm`/`HH:mm`。 */
export function parseTimeToMinutes(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * 校验并规整单条窗口。非法输入(start/end 非法、days 越界)返回 `{error}`,
 * 错误消息不含规则路径前缀——由 resolveScheduleRules 聚合时补全
 * `scheduleRules[i].windows[w].` 前缀(与 normalizeChainEntry 的错误风格一致)。。
 */
export function resolveWindow(
  raw: ScheduleWindowInput,
): ResolvedWindow | { error: string } {
  const start = parseTimeToMinutes(raw.start);
  if (start === null) {
    return { error: 'start must be "HH:mm" (00:00-23:59)' };
  }
  const end = parseTimeToMinutes(raw.end);
  if (end === null) {
    return { error: 'end must be "HH:mm" (00:00-23:59)' };
  }
  let days: ReadonlySet<number> | null = null;
  if (Array.isArray(raw.days) && raw.days.length > 0) {
    const set = new Set<number>();
    for (const item of raw.days) {
      const day = Number(item);
      if (!Number.isInteger(day) || day < 1 || day > 7) {
        return {
          error: 'days must contain ISO weekdays 1-7 (1=Monday)',
        };
      }
      set.add(day);
    }
    if (set.size > 0) days = set;
  }
  return {
    startMinutes: start,
    endMinutes: end,
    wraps: start > end,
    allDay: start === end,
    days,
  };
}

/**
 * 校验并规整规则列表。逐条校验 targets(非空字符串数组,每项含 `/`)与
 * windows(至少一条);任何一条非法即返回 `{error}`(整体拒绝,保留 last-good)。
 * 宽容例外:targets 与 windows **双双为空**的规则视为「新建未填」静默跳过
 * (schema 默认值会产生这种占位规则,硬失败会让整份配置无法解析);
 * 只填一半(其一为空)仍视为非法。空数组是合法输入(= 无规则,时段计划空转)。
 */
export function resolveScheduleRules(
  raw: unknown,
): ReadonlyArray<ScheduleRule> | { error: string } {
  if (!Array.isArray(raw)) return [];
  const rules: ScheduleRule[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (item === null || typeof item !== 'object') {
      return { error: `scheduleRules[${i}] must be an object` };
    }
    const rule = item as ScheduleRuleInput;
    const targets = Array.isArray(rule.targets)
      ? rule.targets.map((t) => String(t))
      : [];
    const windowsRaw = Array.isArray(rule.windows)
      ? (rule.windows as ScheduleWindowInput[])
      : [];
    // 新建未填的占位规则(targets/windows 双空):跳过,不参与判定。
    if (targets.length === 0 && windowsRaw.length === 0) continue;
    if (targets.length === 0) {
      return {
        error: `scheduleRules[${i}].targets must be a non-empty array of "provider/model" or "provider/*"`,
      };
    }
    for (const target of targets) {
      if (!target.includes('/')) {
        return {
          error: `scheduleRules[${i}].targets entry ${JSON.stringify(target)} must be "provider/model" or "provider/*"`,
        };
      }
    }
    if (windowsRaw.length === 0) {
      return {
        error: `scheduleRules[${i}].windows must contain at least one window`,
      };
    }
    const windows: ResolvedWindow[] = [];
    for (let w = 0; w < windowsRaw.length; w++) {
      const resolved = resolveWindow(windowsRaw[w] ?? {});
      if ('error' in resolved) {
        return {
          error: `scheduleRules[${i}].windows[${w}].${resolved.error}`,
        };
      }
      windows.push(resolved);
    }
    rules.push({ targets, windows });
  }
  return rules;
}

/**
 * 规整时段计划配置。与主开关相反,**enabled 默认关闭**(`=== true` 才开启;
 * schema 默认 false,undefined/非法形态一律视为关闭——存量用户零行为变化);
 * 规则非法时抛 Error(与链项错误同风格,调用方保留 last-good)。
 */
export function resolveSchedule(
  enabledInput: unknown,
  rulesInput: unknown,
): ResolvedSchedule {
  const enabled = enabledInput === true;
  const rules = resolveScheduleRules(rulesInput);
  if ('error' in rules) {
    throw new Error(`Invalid dsh-llm-fallback config: ${rules.error}`);
  }
  return { enabled, rules };
}

/** 窗口是否命中给定本地时间(分钟数 + ISO 星期)。 */
export function windowMatches(
  window: ResolvedWindow,
  minutesOfDay: number,
  isoWeekday: number,
): boolean {
  if (window.days !== null && !window.days.has(isoWeekday)) return false;
  if (window.allDay) return true;
  if (window.wraps) {
    // 跨夜(如 22:00-06:00):起点之后或终点之前都算命中。
    return (
      minutesOfDay >= window.startMinutes || minutesOfDay < window.endMinutes
    );
  }
  return (
    minutesOfDay >= window.startMinutes && minutesOfDay < window.endMinutes
  );
}

/**
 * 目标是否命中候选:精确 `provider/model` 或通配 `provider/*`。
 * 通配只看 provider 段(首个 `/` 之前),覆盖该 provider 的全部模型。
 */
export function targetMatches(target: string, candidate: Candidate): boolean {
  const slash = target.indexOf('/');
  if (slash <= 0) return false;
  const provider = target.slice(0, slash);
  const model = target.slice(slash + 1);
  if (provider !== candidate.provider) return false;
  return model === '*' || model === candidate.model;
}

/**
 * 候选当前是否被时段计划阻塞:
 * 任一规则的 targets 命中 × 该规则任一窗口命中当前本地时刻。
 */
export function isScheduleBlocked(
  schedule: ResolvedSchedule,
  candidate: Candidate,
  now: number,
): boolean {
  if (!schedule.enabled || schedule.rules.length === 0) return false;
  const date = new Date(now);
  const minutesOfDay = date.getHours() * 60 + date.getMinutes();
  const isoWeekday = date.getDay() === 0 ? 7 : date.getDay();
  return schedule.rules.some(
    (rule) =>
      rule.targets.some((target) => targetMatches(target, candidate)) &&
      rule.windows.some((window) =>
        windowMatches(window, minutesOfDay, isoWeekday),
      ),
  );
}
