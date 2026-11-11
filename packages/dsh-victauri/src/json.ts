/** 最小 JSON 值类型:工具入参/返回体的统一形状(与 dsh 工具契约对齐)。 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** 递归判定任意值是否为合法 JsonValue(未知外部数据入边界时用)。 */
export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }
  if (typeof value === 'object') {
    return Object.values(value).every((item) => isJsonValue(item));
  }
  return false;
}
