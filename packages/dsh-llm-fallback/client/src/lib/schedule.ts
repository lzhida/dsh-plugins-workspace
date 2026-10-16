/**
 * 时段计划（schedule）规则的纯函数：克隆、比较、校验、占位剥离。
 *
 * 与宿主侧 src/schedule.ts 的解析语义保持一致：resolveScheduleRules 对
 * 占位规则（targets/windows 双空）宽容跳过、半配置/非法规则整体拒绝——
 * client 侧保存闸保持同一判定，避免把会导致宿主拒收配置的值写出去。
 *
 * @module dsh-llm-fallback/client/lib/schedule
 */

/** 单条时段窗口（HH:mm 起止 + 生效星期 1-7；起点>终点 = 跨夜，相等 = 全天）。 */
export interface ScheduleWindow {
  start: string;
  end: string;
  days: number[];
}

/** 单条时段计划规则（阻塞目标 `provider/model` 或 `provider/*` + 窗口数组）。 */
export interface ScheduleRule {
  targets: string[];
  windows: ScheduleWindow[];
}

/** 窗口时间格式（HH:mm，00:00-23:59）。 */
export const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** 深拷贝规则数组（draft 不可变更新的基线；days 缺失归一为空数组）。 */
export function cloneRules(rules: unknown): ScheduleRule[] {
  return ((rules ?? []) as Array<Partial<ScheduleRule>>).map((rule) => ({
    targets: (rule.targets ?? []).slice(),
    windows: (rule.windows ?? []).map((w) => ({
      start: String(w.start === undefined || w.start === null ? '' : w.start),
      end: String(w.end === undefined || w.end === null ? '' : w.end),
      days: (w.days ?? []).slice(),
    })),
  }));
}

/** 深拷贝单条规则。 */
export function cloneRule(rule: ScheduleRule): ScheduleRule {
  return cloneRules([rule])[0];
}

/** 规则列表是否结构一致（顺序敏感；days 空数组与缺失等同）。 */
export function sameRules(
  a: Array<Partial<ScheduleRule>>,
  b: Array<Partial<ScheduleRule>>,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const ra = a[i];
    const rb = b[i];
    const ta = ra.targets ?? [];
    const tb = rb.targets ?? [];
    if (ta.length !== tb.length) return false;
    for (let t = 0; t < ta.length; t += 1) {
      if (ta[t] !== tb[t]) return false;
    }
    const wa = ra.windows ?? [];
    const wb = rb.windows ?? [];
    if (wa.length !== wb.length) return false;
    for (let w = 0; w < wa.length; w += 1) {
      if (wa[w].start !== wb[w].start) return false;
      if (wa[w].end !== wb[w].end) return false;
      const da = wa[w].days ?? [];
      const db = wb[w].days ?? [];
      if (da.length !== db.length) return false;
      for (let d = 0; d < da.length; d += 1) {
        if (da[d] !== db[d]) return false;
      }
    }
  }
  return true;
}

/** 规则的宽松输入形状（存储回读 / 测试可直接传缺字段对象）。 */
export type RuleLike = {
  targets?: string[];
  windows?: Array<Partial<ScheduleWindow>>;
};

/**
 * 规则是否可保存：至少一个目标与一条窗口，且窗口时间均为合法 HH:mm。
 * 宿主侧 resolveScheduleRules 对占位规则宽容跳过、半配置/非法规则整体
 * 拒绝——client 侧保存闸保持同一判定（调用方先放行双空占位规则）。
 */
export function ruleValid(rule: RuleLike | null): boolean {
  if (
    !rule ||
    (rule.targets ?? []).length === 0 ||
    (rule.windows ?? []).length === 0
  ) {
    return false;
  }
  for (const w of rule.windows ?? []) {
    if (!TIME_RE.test(String(w.start ?? ''))) return false;
    if (!TIME_RE.test(String(w.end ?? ''))) return false;
  }
  return true;
}

/** 保存前丢弃新建未填的占位规则（targets 与 windows 双空）。 */
export function stripPlaceholderRules<T extends Partial<ScheduleRule>>(
  rules: T[],
): T[] {
  return rules.filter(
    (rule) =>
      (rule.targets ?? []).length > 0 || (rule.windows ?? []).length > 0,
  );
}
