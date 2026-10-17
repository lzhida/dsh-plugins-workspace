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

/** 已保存配置的归一视图（含 schema 缺省值与 revision）。 */
export interface SavedSettings {
  enabled: boolean;
  queue: Route[];
  maxRetries: number;
  retriesBeforeSwitch: number;
  cooldownEnabled: boolean;
  cooldownMs: number;
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
  /** 进入草稿时的快照 revision（保存闸：与当前 revision 不一致 = 冲突）。 */
  revision: number;
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
    revision: saved.revision,
  };
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
    view.cooldownMs !== saved.cooldownMs
  );
}

/** 构造保存载荷：6 个 set op。 */
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
