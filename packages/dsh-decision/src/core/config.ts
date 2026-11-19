/**
 * dsh-decision 决策域配置面。
 *
 * 落**基础配置字段**：
 * - `enabled`：门控总开关，**默认关闭**＝行为完全等同出厂 ask_user_question
 *   （关闭时 execute 直接放行真实提问，不做任何拦截，也不落账 meta）；
 * - `decisionProvider` / `decisionModel`：决策模型定位（3/4 起 ask-gate
 *   真的会发起决策调用；未配置时按 fail-open 放行真实提问）；
 * - `confidenceThreshold`：自动作答的置信度阈值（默认 0.8，≥ 阈值自动
 *   作答，< 阈值放行）；
 * - `decisionTimeoutMs`：单次决策调用的超时上限（默认 30s，超时按
 *   fail-open 放行）。
 *
 * 配置面写法与 packages/dsh-llm-fallback/src/config.ts 同款：
 * schemastery Schema + volatileField + setDescription + desc(en, zh)，
 * 入口必须 re-export `Config`（否则宿主设置面板不渲染该插件）。
 */

import Schema from '@deepseek-ai/schemastery';

// ── volatile 支持 ──────────────────────────────────────────────────────
// 设置面板用 volatileForm(schema) 过滤条目：没有 volatile 标记的字段会被
// 整个丢弃（写入还抛 "Plugin entry X has no volatile fields"），所以每个
// 可编辑字段都必须包一层 volatileField()。

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

export function isVolatileLike(
  value: unknown,
): value is { get: () => unknown } {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value;
}

export function unwrapVolatile(value: unknown): unknown {
  if (isVolatileLike(value)) return unwrapVolatile(value.get());
  if (Array.isArray(value)) return value.map((item) => unwrapVolatile(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, unwrapVolatile(child)]),
    );
  }
  return value;
}

export function volatileField<T extends { volatile?: unknown }>(field: T): T {
  const volatile = field.volatile;
  return typeof volatile === 'function'
    ? (volatile as () => T).call(field)
    : field;
}

// ── i18n 描述 ─────────────────────────────────────────────────────────

export type SchemaDescription = { '': string } & Partial<
  Record<string, string>
>;

export function desc(en: string, zh: string): SchemaDescription {
  return { '': en, en, zh };
}

export function setDescription<F extends { description(text: string): F }>(
  field: F,
  text: SchemaDescription,
): F {
  return field.description(text as unknown as string);
}

// ── 运行时形态 ─────────────────────────────────────────────────────────

export interface ResolvedConfig {
  /** 门控总开关：false（默认）＝不接管、不拦截，行为等同出厂实现。 */
  enabled: boolean;
  /** 决策模型 provider；空串＝未配置（后续门控逻辑据此回退直通）。 */
  decisionProvider: string;
  /** 决策模型模型名；空串＝未配置。 */
  decisionModel: string;
  /** 置信度阈值：≥ 阈值自动作答、< 阈值放行真实提问（0~1）。 */
  confidenceThreshold: number;
  /** 单次决策评估超时（毫秒），超时按降级放行处理。 */
  decisionTimeoutMs: number;
}

/** 置信度阈值默认值。 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;
/** 决策评估超时默认值（毫秒）。 */
export const DEFAULT_DECISION_TIMEOUT_MS = 30_000;

export function resolveConfig(input: unknown): ResolvedConfig {
  const raw = (unwrapVolatile(input) ?? {}) as {
    enabled?: unknown;
    decisionProvider?: unknown;
    decisionModel?: unknown;
    confidenceThreshold?: unknown;
    decisionTimeoutMs?: unknown;
  };
  const enabled = raw.enabled === true;
  const decisionProvider =
    typeof raw.decisionProvider === 'string' ? raw.decisionProvider.trim() : '';
  const decisionModel =
    typeof raw.decisionModel === 'string' ? raw.decisionModel.trim() : '';
  // 非法（非有限数 / 越界）一律回落默认——阈值判定纯函数对非法 threshold
  // 会 fail-open 放行，这里回落默认让配置面保存的合法值始终可用。
  const rawThreshold = raw.confidenceThreshold;
  const confidenceThreshold =
    typeof rawThreshold === 'number' &&
    Number.isFinite(rawThreshold) &&
    rawThreshold > 0 &&
    rawThreshold <= 1
      ? rawThreshold
      : DEFAULT_CONFIDENCE_THRESHOLD;
  const rawTimeout = raw.decisionTimeoutMs;
  const decisionTimeoutMs =
    typeof rawTimeout === 'number' &&
    Number.isFinite(rawTimeout) &&
    rawTimeout > 0
      ? rawTimeout
      : DEFAULT_DECISION_TIMEOUT_MS;
  return {
    enabled,
    decisionProvider,
    decisionModel,
    confidenceThreshold,
    decisionTimeoutMs,
  };
}

// ── 设置面板 schema ────────────────────────────────────────────────────

export const Config = Schema.object({
  enabled: volatileField(
    setDescription(
      Schema.boolean().default(false),
      desc(
        'Enable the decision gate (off by default: questions pass straight through to the built-in ask_user_question)',
        '是否启用决策门控（默认关闭：提问直接走内置 ask_user_question 原版通道）',
      ),
    ),
  ),
  decisionProvider: volatileField(
    setDescription(
      Schema.string().default(''),
      desc(
        'Provider of the decision model used by the gate (empty = not configured)',
        '决策门控所用决策模型的 provider（留空＝未配置）',
      ),
    ),
  ),
  decisionModel: volatileField(
    setDescription(
      Schema.string().default(''),
      desc(
        'Model of the decision model used by the gate (empty = not configured)',
        '决策门控所用决策模型的模型名（留空＝未配置）',
      ),
    ),
  ),
  confidenceThreshold: volatileField(
    setDescription(
      Schema.number()
        .min(0.05)
        .max(1)
        .step(0.05)
        .default(DEFAULT_CONFIDENCE_THRESHOLD),
      desc(
        'Confidence threshold: >= threshold auto-answers with the decision model, < threshold passes through to a real question',
        '置信度阈值：≥ 阈值由决策模型自动作答，< 阈值放行真实提问（0~1，默认 0.8）',
      ),
    ),
  ),
  decisionTimeoutMs: volatileField(
    setDescription(
      Schema.number()
        .min(1_000)
        .max(120_000)
        .step(1_000)
        .default(DEFAULT_DECISION_TIMEOUT_MS),
      desc(
        'Timeout for one decision evaluation in ms; on timeout the question passes through',
        '单次决策评估超时（毫秒，默认 30000）；超时按放行真实提问处理',
      ),
    ),
  ),
});
