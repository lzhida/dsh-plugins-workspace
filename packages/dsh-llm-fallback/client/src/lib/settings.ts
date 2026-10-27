/**
 * 设置读写纯函数：快照归一、草稿覆盖、脏检查、保存 ops 构造。
 *
 * 从旧版手写 Card 内散落的推导逻辑抽出（行为逐行等价）：
 * - readSavedSettings 把 configForms 快照的原始 value 归一为带 schema 缺省
 *   值的已保存视图（enabled/cooldownEnabled 缺省 true、cooldownMs 缺省
 *   300000 = schema 默认，存储里未写过该键时显示默认而非 0，避免误导为
 *   "已禁用"）；
 * - resolveView 叠加草稿（未进入草稿的字段透传已保存值）得到当前 UI 值；
 * - isDirty 与 buildMutations 是保存闸与写入载荷的单一来源。
 *
 * @module dsh-llm-fallback/client/lib/settings
 */

import type { MutationOp } from '../types.ts';
import { routeKey, sameQueue, type Route } from './catalog.ts';

/** 冷却窗口的 schema 默认值（300000ms = 5 分钟）。 */
export const DEFAULT_COOLDOWN_MS = 300000;

// ── 时间窗切换/错峰优先（时段计划 v2：时间窗 = 预填冷却表）──────────

/** 单条时间窗：`HH:mm` 半开区间 [start, end)；起点>终点 = 跨夜；相等 = 全天。 */
export interface TimeWindowInput {
  start: string;
  end: string;
}

/** 单条时间窗规则：provider 匹配模式 + 动作 + 窗口列表（宿主 schema 同形）。 */
export interface TimeWindowRuleInput {
  /** provider 匹配模式：精确 id / 前缀通配 `deepseek-*` / `*`（全部）。 */
  match: string;
  /** `block` = 窗口内冷却命中的 provider；`prefer` = 冷却未命中的 provider。 */
  action: 'block' | 'prefer';
  windows: TimeWindowInput[];
}

/**
 * 官方错峰预置模板（与宿主 src/schedule.ts 的 DEFAULT_TIME_WINDOW_RULES
 * 镜像；client 打包不引入宿主侧源码，此处为有意的受控复制，两端都有
 * 测试锚定同一值）：高峰避让 deepseek-*（08:30–00:30）、错峰半价优先
 * deepseek-*（00:30–08:30）。
 */
export const DEFAULT_TIME_WINDOW_RULES: ReadonlyArray<TimeWindowRuleInput> = [
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

/** `HH:mm` 窗口边界合法性（宿主 parseHHmm 同一规则）。 */
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 已保存配置的归一视图（含 schema 缺省值与 revision）。 */
export interface SavedSettings {
  enabled: boolean;
  queue: Route[];
  maxRetries: number;
  retriesBeforeSwitch: number;
  cooldownEnabled: boolean;
  cooldownMs: number;
  timeWindowEnabled: boolean;
  timeWindowRules: TimeWindowRuleInput[];
  revision: number;
}

/**
 * 草稿：用户未保存的编辑（null DraftState = 无未保存编辑；旧版 8 个
 * useState 平铺的收敛）。字段进入草稿即全量初始化（beginDraft 以已保存
 * 视图为基线克隆），故字段本身非空。
 */
export interface DraftState {
  enabled: boolean;
  queue: Route[];
  maxRetries: number;
  retriesBeforeSwitch: number;
  cooldownEnabled: boolean;
  cooldownMs: number;
  timeWindowEnabled: boolean;
  timeWindowRules: TimeWindowRuleInput[];
  /** 进入草稿时的快照 revision（保存闸：与当前 revision 不一致 = 冲突）。 */
  revision: number;
}

/**
 * 时间窗规则宽容归一：宿主 schema 校验非法规则会拒绝写入，但快照里可能
 * 存在旧版本/手写的近似形态——展示层尽力归一（match 非字符串回退空串、
 * action 非法回退 block、窗口非法回退 00:00），合法性判定交给
 * rulesValid（保存闸用它阻止无效载荷写出）。
 */
function normalizeRules(input: unknown): TimeWindowRuleInput[] {
  if (!Array.isArray(input)) return [];
  const rules: TimeWindowRuleInput[] = [];
  for (const raw of input as Array<Record<string, unknown>>) {
    if (typeof raw !== 'object' || raw === null) continue;
    const windowsRaw = Array.isArray(raw.windows) ? raw.windows : [];
    rules.push({
      match: typeof raw.match === 'string' ? raw.match : '',
      action: raw.action === 'prefer' ? 'prefer' : 'block',
      windows: windowsRaw.map((w) => {
        const win = (w ?? {}) as Record<string, unknown>;
        return {
          start: typeof win.start === 'string' ? win.start : '00:00',
          end: typeof win.end === 'string' ? win.end : '00:00',
        };
      }),
    });
  }
  return rules;
}

/** 深拷贝规则数组（草稿克隆 / 预置模板落草稿都用，切断引用共享）。 */
export function cloneRules(
  rules: ReadonlyArray<TimeWindowRuleInput>,
): TimeWindowRuleInput[] {
  return rules.map((rule) => ({
    match: rule.match,
    action: rule.action,
    windows: rule.windows.map((w) => ({ start: w.start, end: w.end })),
  }));
}

/** 保存闸：规则是否可写出（match 非空 + 至少一个合法 HH:mm 窗口）。 */
export function rulesValid(rules: ReadonlyArray<TimeWindowRuleInput>): boolean {
  return rules.every(
    (rule) =>
      rule.match.trim().length > 0 &&
      rule.windows.length > 0 &&
      rule.windows.every((w) => TIME_RE.test(w.start) && TIME_RE.test(w.end)),
  );
}

/** 从配置快照原始 value 构造已保存视图（clone 输出，不引用快照内部对象）。 */
export function readSavedSettings(
  value: Record<string, unknown> | null,
  revision: number,
): SavedSettings {
  const v = value ?? {};
  const rawCooldownMs = v.cooldownMs;
  let cooldownMs =
    rawCooldownMs === undefined || rawCooldownMs === null
      ? DEFAULT_COOLDOWN_MS
      : Number(rawCooldownMs);
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
    cooldownMs = DEFAULT_COOLDOWN_MS;
  }
  return {
    enabled: v.enabled !== false,
    queue: ((v.fallbackChains ?? []) as Array<Partial<Route>>).map((entry) => ({
      provider: String(entry.provider ?? ''),
      model: String(entry.model ?? ''),
    })),
    maxRetries: Number(v.maxRetries ?? 0) || 0,
    retriesBeforeSwitch: Number(v.retriesBeforeSwitch ?? 0) || 0,
    cooldownEnabled: v.cooldownEnabled !== false,
    cooldownMs,
    timeWindowEnabled: v.timeWindowEnabled === true,
    timeWindowRules: normalizeRules(v.timeWindowRules),
    revision,
  };
}

/** 进入草稿：以已保存视图为基线克隆全量字段（旧版 beginDraft）。 */
export function beginDraft(saved: SavedSettings): DraftState {
  return {
    enabled: saved.enabled,
    queue: saved.queue.map((r) => ({ provider: r.provider, model: r.model })),
    maxRetries: saved.maxRetries,
    retriesBeforeSwitch: saved.retriesBeforeSwitch,
    cooldownEnabled: saved.cooldownEnabled,
    cooldownMs: saved.cooldownMs,
    timeWindowEnabled: saved.timeWindowEnabled,
    timeWindowRules: cloneRules(saved.timeWindowRules),
    revision: saved.revision,
  };
}

/** 规则数组等价性（脏检查用；规则规模极小，JSON 序列化比较足够）。 */
function sameRules(
  a: ReadonlyArray<TimeWindowRuleInput>,
  b: ReadonlyArray<TimeWindowRuleInput>,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 草稿叠加：草稿非空字段即当前 UI 生效值（草稿全量初始化，直接采用）。 */
export function resolveView(
  saved: SavedSettings,
  draft: DraftState | null,
): SavedSettings {
  if (draft === null) return saved;
  return {
    enabled: draft.enabled,
    queue: draft.queue,
    maxRetries: draft.maxRetries,
    retriesBeforeSwitch: draft.retriesBeforeSwitch,
    cooldownEnabled: draft.cooldownEnabled,
    cooldownMs: draft.cooldownMs,
    timeWindowEnabled: draft.timeWindowEnabled,
    timeWindowRules: draft.timeWindowRules,
    revision: draft.revision,
  };
}

/** 保存闸 1：视图与已保存值是否有差异（顺序敏感）。 */
export function isDirty(view: SavedSettings, saved: SavedSettings): boolean {
  return (
    view.enabled !== saved.enabled ||
    !sameQueue(view.queue, saved.queue) ||
    view.maxRetries !== saved.maxRetries ||
    view.retriesBeforeSwitch !== saved.retriesBeforeSwitch ||
    view.cooldownEnabled !== saved.cooldownEnabled ||
    view.cooldownMs !== saved.cooldownMs ||
    view.timeWindowEnabled !== saved.timeWindowEnabled ||
    !sameRules(view.timeWindowRules, saved.timeWindowRules)
  );
}

/** 构造保存载荷：8 个 set op（含时间窗两字段，与冷却区块同一载荷链路）。 */
export function buildMutations(view: SavedSettings): MutationOp[] {
  return [
    { op: 'set', path: ['enabled'], value: view.enabled },
    {
      op: 'set',
      path: ['fallbackChains'],
      value: view.queue.map((r) => ({
        provider: r.provider,
        model: r.model,
      })),
    },
    { op: 'set', path: ['maxRetries'], value: view.maxRetries },
    {
      op: 'set',
      path: ['retriesBeforeSwitch'],
      value: view.retriesBeforeSwitch,
    },
    { op: 'set', path: ['cooldownEnabled'], value: view.cooldownEnabled },
    { op: 'set', path: ['cooldownMs'], value: view.cooldownMs },
    { op: 'set', path: ['timeWindowEnabled'], value: view.timeWindowEnabled },
    {
      op: 'set',
      path: ['timeWindowRules'],
      value: cloneRules(view.timeWindowRules),
    },
  ];
}

/** number 输入解析：非负整数，非法/负值归 0（旧版三处内联逻辑收敛）。 */
export function parseCountInput(text: string): number {
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

/** 勾选集合构造（provider/model key → true）。 */
export function toSelectedMap(routes: Route[]): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const r of routes) map[routeKey(r)] = true;
  return map;
}
