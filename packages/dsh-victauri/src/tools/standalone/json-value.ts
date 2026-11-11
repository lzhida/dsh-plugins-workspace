/**
 * 任意 JSON 值参数：schema 助手 + 入参 JSON 化守卫。
 *
 * 背景（服务端源码佐证，0.8.8 与 0.10.2 一致）：
 * - `assert_semantic.expected`：`serde_json::Value`（other_params.rs）
 * - `wait_for.expected`：`Option<serde_json::Value>`（other_params.rs）
 * - `storage.value`：`Option<serde_json::Value>`，注释「Will be JSON-serialized
 *   if not a string」（compound_params.rs）
 *
 * 插件侧原先把这三处参数声明为 STR，模型断言「数值相等」必须手工预序列化
 * （`expected: "42"`），与服务端实际能力不匹配。
 *
 * - `JSON_VALUE()`：`type: 'json'` 的 schema 节点。dsh-tools 把该节点编译为
 *   **无类型约束**的 JSON Schema 节点（annotation-only），故字符串/数值/布尔/
 *   null/数组/对象一律通过参数校验。
 * - `toJsonArgs()`：复用 `src/json.ts` 的 `isJsonValue` 守卫把入参收敛为纯
 *   JSON 值（丢弃 undefined 与非 JSON 值），保证透传体是合法 JSON。
 */
import { isJsonValue, type JsonValue } from '../../json.ts';

/** 任意 JSON 值参数（字符串/数值/布尔/null/数组/对象皆可）。 */
export const JSON_VALUE = (description: string) => ({
  type: 'json' as const,
  description,
});

/**
 * 把工具入参收敛为纯 JSON 值。
 *
 * 丢弃 `undefined` 与非 JSON 值（函数/符号等）；保留 null、false、0、空数组、
 * 空对象等「falsy 但合法」的 JSON 值——它们是有意义的显式取值。
 */
export function toJsonArgs(
  args: Record<string, unknown>,
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(args)) {
    if (isJsonValue(value)) out[key] = value;
  }
  return out;
}
