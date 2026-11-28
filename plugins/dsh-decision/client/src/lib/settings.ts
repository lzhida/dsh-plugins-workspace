/**
 * decision-tools client 设置纯函数（决策工具系列 6/11）。
 *
 * 形状照抄 plugins/dsh-llm-fallback/client/src/lib/settings.ts 范式：
 * 读快照归一（缺省回落 schema 默认）→ 全量草稿克隆 → 草稿叠加 → 脏检查
 * → 保存 MutationOp 构造。默认值镜像 src/config/decision-tools.ts。
 *
 * @module dsh-decision/client/lib/settings
 */

import type { MutationOp } from '../types.ts';

/* ---- 默认值（镜像 src/config/decision-tools.ts DEFAULT_*） ---- */

export const DEFAULT_SETTINGS = {
  systemoneBaseUrl: '',
  systemoneApiKey: '',
  systemoneModel: '',
  systemoneTimeoutMs: 30_000,
  systemoneVerifiedAt: '',
  systemoneVerifyError: '',
  toolsDecideEnabled: false,
  toolsGateEnabled: false,
  toolsRerankEnabled: false,
  toolsBatchEnabled: false,
  toolsLocateEnabled: false,
  toolsUsageEnabled: false,
  toolsHistoryEnabled: false,
  toolsRecheckEnabled: false,
  toolsCalibrateEnabled: false,
  toolsArbiterEnabled: false,
  budgetEnabled: false,
  budgetMaxCallsPerDay: 200,
  budgetMaxTokensPerDay: 200_000,
  budgetMaxCostUsdPerDay: 0,
  budgetResetHourUtc: 0,
  costInputPer1kTokens: 0,
  costOutputPer1kTokens: 0,
  fallbackEnabled: false,
  fallbackProvider: '',
  fallbackModel: '',
  fallbackMinConfidence: 0.7,
  fallbackMode: 'auto-fallback',
  fallbackTimeoutMs: 60_000,
  fallbackMaxCallsPerDay: 50,
  ledgerEnabled: true,
  ledgerMaxEntries: 1000,
  gateAllowThreshold: 0.8,
} as const;

/** 把 `as const` 的字面量类型放宽为基类型（配置值可被用户改成任意合法值）。 */
type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T;

export type Settings = {
  -readonly [K in keyof typeof DEFAULT_SETTINGS]: Widen<
    (typeof DEFAULT_SETTINGS)[K]
  >;
};

/** 十个工具开关字段（与 constants.TOOL_SWITCH_FIELDS 一致，纯函数侧复用）。 */
export const TOOL_SWITCH_FIELDS = [
  'toolsDecideEnabled',
  'toolsGateEnabled',
  'toolsRerankEnabled',
  'toolsBatchEnabled',
  'toolsLocateEnabled',
  'toolsUsageEnabled',
  'toolsHistoryEnabled',
  'toolsRecheckEnabled',
  'toolsCalibrateEnabled',
  'toolsArbiterEnabled',
] as const;

export type ToolSwitchField = (typeof TOOL_SWITCH_FIELDS)[number];

/** 兜底模式闭集（与 src/config FALLBACK_MODES 一致）。 */
export const FALLBACK_MODES = [
  'auto-fallback',
  'explicit-arbiter',
  'both',
] as const;

export type FallbackMode = (typeof FALLBACK_MODES)[number];

/** 已保存设置（带读取时的快照 revision）。 */
export interface SavedSettings extends Settings {
  revision: number;
}

/** 草稿状态（revision = 进入草稿时快照 revision，保存闸据此判冲突）。 */
export interface DraftState {
  values: Settings;
  revision: number;
}

function toStr(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toBool(value: unknown): boolean {
  return value === true;
}

function toInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  return fallback;
}

function toFloat(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toMode(value: unknown): FallbackMode {
  return (FALLBACK_MODES as readonly string[]).includes(toStr(value))
    ? (toStr(value) as FallbackMode)
    : DEFAULT_SETTINGS.fallbackMode;
}

/** 深拷贝设置（输出不引用快照内部对象）。 */
export function cloneSettings(values: Settings): Settings {
  return { ...values };
}

/** 归一化原始快照值为 SavedSettings（缺省字段回落 schema 默认）。 */
export function readSavedSettings(
  value: Record<string, unknown> | null,
  revision: number,
): SavedSettings {
  const raw = value ?? {};
  const saved: Settings = {
    systemoneBaseUrl: toStr(raw.systemoneBaseUrl),
    systemoneApiKey: toStr(raw.systemoneApiKey),
    systemoneModel: toStr(raw.systemoneModel),
    systemoneTimeoutMs: toInt(
      raw.systemoneTimeoutMs,
      DEFAULT_SETTINGS.systemoneTimeoutMs,
    ),
    systemoneVerifiedAt: toStr(raw.systemoneVerifiedAt),
    systemoneVerifyError: toStr(raw.systemoneVerifyError),
    toolsDecideEnabled: toBool(raw.toolsDecideEnabled),
    toolsGateEnabled: toBool(raw.toolsGateEnabled),
    toolsRerankEnabled: toBool(raw.toolsRerankEnabled),
    toolsBatchEnabled: toBool(raw.toolsBatchEnabled),
    toolsLocateEnabled: toBool(raw.toolsLocateEnabled),
    toolsUsageEnabled: toBool(raw.toolsUsageEnabled),
    toolsHistoryEnabled: toBool(raw.toolsHistoryEnabled),
    toolsRecheckEnabled: toBool(raw.toolsRecheckEnabled),
    toolsCalibrateEnabled: toBool(raw.toolsCalibrateEnabled),
    toolsArbiterEnabled: toBool(raw.toolsArbiterEnabled),
    budgetEnabled: toBool(raw.budgetEnabled),
    budgetMaxCallsPerDay: toInt(
      raw.budgetMaxCallsPerDay,
      DEFAULT_SETTINGS.budgetMaxCallsPerDay,
    ),
    budgetMaxTokensPerDay: toInt(
      raw.budgetMaxTokensPerDay,
      DEFAULT_SETTINGS.budgetMaxTokensPerDay,
    ),
    budgetMaxCostUsdPerDay: toFloat(
      raw.budgetMaxCostUsdPerDay,
      DEFAULT_SETTINGS.budgetMaxCostUsdPerDay,
    ),
    budgetResetHourUtc: toInt(
      raw.budgetResetHourUtc,
      DEFAULT_SETTINGS.budgetResetHourUtc,
    ),
    costInputPer1kTokens: toFloat(
      raw.costInputPer1kTokens,
      DEFAULT_SETTINGS.costInputPer1kTokens,
    ),
    costOutputPer1kTokens: toFloat(
      raw.costOutputPer1kTokens,
      DEFAULT_SETTINGS.costOutputPer1kTokens,
    ),
    fallbackEnabled: toBool(raw.fallbackEnabled),
    fallbackProvider: toStr(raw.fallbackProvider),
    fallbackModel: toStr(raw.fallbackModel),
    fallbackMinConfidence: toFloat(
      raw.fallbackMinConfidence,
      DEFAULT_SETTINGS.fallbackMinConfidence,
    ),
    fallbackMode: toMode(raw.fallbackMode),
    fallbackTimeoutMs: toInt(
      raw.fallbackTimeoutMs,
      DEFAULT_SETTINGS.fallbackTimeoutMs,
    ),
    fallbackMaxCallsPerDay: toInt(
      raw.fallbackMaxCallsPerDay,
      DEFAULT_SETTINGS.fallbackMaxCallsPerDay,
    ),
    ledgerEnabled: raw.ledgerEnabled === false ? false : true,
    ledgerMaxEntries: toInt(
      raw.ledgerMaxEntries,
      DEFAULT_SETTINGS.ledgerMaxEntries,
    ),
    gateAllowThreshold: toFloat(
      raw.gateAllowThreshold,
      DEFAULT_SETTINGS.gateAllowThreshold,
    ),
  };
  return { ...clampSettings(saved), revision };
}

/**
 * 域归一（读回即夹取）：与宿主配置面 resolveToolsConfig 的「越界回落默认」
 * 口径不同——这里保留用户值但夹进合法域，避免面板显示 999999 而宿主拒收。
 * 各字段区间与宿主 schema（src/config/decision-tools.ts 的 .min/.max）逐条镜像，
 * 改任一侧必须同步另一侧。
 */
export function clampSettings(settings: Settings): Settings {
  const clamp = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), max);
  return {
    ...settings,
    systemoneTimeoutMs: clamp(settings.systemoneTimeoutMs, 1_000, 300_000),
    budgetMaxCallsPerDay: clamp(settings.budgetMaxCallsPerDay, 0, 100_000),
    budgetMaxTokensPerDay: clamp(
      settings.budgetMaxTokensPerDay,
      0,
      100_000_000,
    ),
    budgetMaxCostUsdPerDay: clamp(settings.budgetMaxCostUsdPerDay, 0, 10_000),
    budgetResetHourUtc: clamp(settings.budgetResetHourUtc, 0, 23),
    costInputPer1kTokens: clamp(settings.costInputPer1kTokens, 0, 100),
    costOutputPer1kTokens: clamp(settings.costOutputPer1kTokens, 0, 100),
    fallbackMinConfidence: clamp(settings.fallbackMinConfidence, 0.05, 1),
    fallbackTimeoutMs: clamp(settings.fallbackTimeoutMs, 1_000, 300_000),
    fallbackMaxCallsPerDay: clamp(settings.fallbackMaxCallsPerDay, 0, 10_000),
    ledgerMaxEntries: clamp(settings.ledgerMaxEntries, 100, 100_000),
    gateAllowThreshold: clamp(settings.gateAllowThreshold, 0.05, 1),
  };
}

/** 进入编辑态（全量克隆当前已保存值；values 不携带 revision）。 */
export function beginDraft(saved: SavedSettings): DraftState {
  const values = cloneSettings(saved);
  delete (values as { revision?: number }).revision;
  return { values, revision: saved.revision };
}

/** 视图值 = 草稿叠加在已保存值上。 */
export function resolveView(
  saved: SavedSettings,
  draft: DraftState | null,
): Settings {
  return draft === null ? cloneSettings(saved) : cloneSettings(draft.values);
}

/** 脏检查：视图与已保存值逐字段对比（revision 不参与）。 */
export function isDirty(view: Settings, saved: SavedSettings): boolean {
  const keys = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];
  return keys.some((key) => view[key] !== saved[key]);
}

/** 保存载荷：把视图值逐字段转成 set op（path 为单元素数组）。 */
export function buildMutations(view: Settings): MutationOp[] {
  const keys = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];
  return keys.map((key) => ({
    op: 'set' as const,
    path: [key],
    value: view[key],
  }));
}

/** 数字输入宽容解析（非法/负数归 0，保持 llm-fallback 同款语义）。 */
export function parseCountInput(text: string): number {
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.trunc(parsed);
}

/** 浮点输入宽容解析（非法/负数归 0；保留小数）。 */
export function parseFloatInput(text: string): number {
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}
