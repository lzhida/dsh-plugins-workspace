/**
 * JSON 可序列化值类型。
 *
 * 与宿主 `@deepseek-ai/dsh-util-values` 的 `JsonValue` 结构一致，
 * 但本地声明以免为一个纯类型引入额外的宿主依赖（结构相同故可互相赋值）。
 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** 把任意对象转成「无 undefined」的 JSON 记录（undefined 一律降级为 null）。 */
export function toJsonRecord(
  source: Record<string, unknown>,
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(source)) {
    result[key] = toJsonValue(value);
  }
  return result;
}

/** 把任意值转成 JSON 值（undefined → null，函数/符号 → null）。 */
export function toJsonValue(value: unknown): JsonValue {
  if (value === undefined || value === null) return null;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item));
  if (typeof value === 'object') {
    return toJsonRecord(value as Record<string, unknown>);
  }
  return null;
}
