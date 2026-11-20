/**
 * volatile（易失）配置支持。
 *
 * dsh 设置面板只投影标了 `.volatile()` 的字段；运行时拿到的是 Volatile
 * 引用而非普通值。`Symbol.for('cosmokit.volatile.write')` 是跨模块副本
 * 稳定的全局符号（cosmokit 的 isVolatile 即 `write in value`），本地
 * 复刻不引入额外依赖。
 *
 * 本文件不含任何插件的设置 schema——那属于各插件自身；这里只放
 * 「把 volatile 引用摊平成普通值」与「字段描述的 i18n 映射」两件通用事。
 */

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/** 是否为 cosmokit volatile 配置引用（可 get() 取当前值）。 */
export function isVolatileLike(
  value: unknown,
): value is { get: () => unknown } {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value;
}

/** 深度解包 volatile 引用，得到普通值（数组/对象逐层递归）。 */
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

/** 若字段支持 volatile 则标记之，否则原样返回（兼容未增强实现）。 */
export function volatileField<T extends { volatile?: unknown }>(field: T): T {
  const volatile = field.volatile;
  return typeof volatile === 'function'
    ? (volatile as () => T).call(field)
    : field;
}

/** schemastery `meta.description` 的 i18n 映射形态（`''` = 回退文案）。 */
export type SchemaDescription = { '': string } & Partial<
  Record<string, string>
>;

/** 构造设置表单字段描述的 i18n 映射（`en` 同时写入 `''`/`en` 键，`zh` 中文）。 */
export function desc(en: string, zh: string): SchemaDescription {
  return { '': en, en, zh };
}

/** 把 i18n 映射写入字段描述（收窄 schemastery 链式声明的滞后）。 */
export function setDescription<F extends { description(text: string): F }>(
  field: F,
  text: SchemaDescription,
): F {
  return field.description(text as unknown as string);
}
