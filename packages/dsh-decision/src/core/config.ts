/**
 * dsh-decision 决策域配置面。
 *
 * 本卡（决策门控系列 1/4）只落**基础配置字段**：
 * - `enabled`：门控总开关，**默认关闭**＝行为完全等同出厂 ask_user_question
 *   （空壳阶段 execute 直通原版提问通道，不做任何拦截）；
 * - `decisionProvider` / `decisionModel`：决策模型定位（供 2/4、3/4 使用，
 *   1/4 只落字段与设置面板可见性，不发起任何模型调用）。
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
}

export function resolveConfig(input: unknown): ResolvedConfig {
  const raw = (unwrapVolatile(input) ?? {}) as {
    enabled?: unknown;
    decisionProvider?: unknown;
    decisionModel?: unknown;
  };
  const enabled = raw.enabled === true;
  const decisionProvider =
    typeof raw.decisionProvider === 'string' ? raw.decisionProvider.trim() : '';
  const decisionModel =
    typeof raw.decisionModel === 'string' ? raw.decisionModel.trim() : '';
  return { enabled, decisionProvider, decisionModel };
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
});
