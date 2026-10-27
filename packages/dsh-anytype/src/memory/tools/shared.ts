/**
 * 记忆工具层公共设施（参数、作用域解析、过滤构造、文本工具）。
 *
 * 与 `dsh-anytype` 的 tools/shared.ts 同构但更薄：这里不封装 HTTP
 * （HTTP 语义都在 `@zhidal/dsh-anytype-core` 与 `src/store.ts`），只提供
 * 「记忆语义 → 参数/过滤」这一层的共用件。
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

import type { ResolvedConfig } from '../config.ts';
import {
  EDGE_PROPERTY_KEY,
  MEMORY_KINDS,
  MEMORY_PROPERTY_KEY,
  MEMORY_STATUSES,
  type MemoryKind,
} from '../schema.ts';
import type { MemoryStore } from '../store.ts';

/**
 * 语义名 → 真实属性 key。
 *
 * 工具层用**语义名**（'kind' / 'status' / 'content_hash'…）指代属性，
 * 由本函数映射到「期望 key（`memory_*`）」再映射到「服务端实际 key」。
 * 这样工具层不必知道前缀规则，也不必担心字符串漂移。
 *
 * @param keys - bootstrap 读回的真实 key 映射（期望 key → 实际 key）。
 * @param semantic - 语义名（MEMORY_PROPERTY_KEY 的键，或直接给期望 key）。
 * @returns 服务端实际使用的属性 key。
 */
export function propertyKey(
  keys: Record<string, string>,
  semantic: string,
): string {
  // 语义名可能写成 snake_case（'proof_count'）或 camelCase（'proofCount'），
  // 两种都映射到同一个属性。
  const camel = semantic.replace(/_([a-z])/g, (_m, c: string) =>
    c.toUpperCase(),
  );
  const expected =
    (MEMORY_PROPERTY_KEY as Record<string, string>)[semantic] ??
    (MEMORY_PROPERTY_KEY as Record<string, string>)[camel] ??
    (EDGE_PROPERTY_KEY as Record<string, string>)[semantic] ??
    semantic;
  return keys[expected] ?? expected;
}

/** 工具构建依赖。 */
export interface MemoryToolDeps {
  /** 记忆存储（Anytype 操作）。 */
  store: MemoryStore;
  /** volatile 配置现读入口。 */
  config: () => ResolvedConfig;
}

/**
 * 作用域参数（所有记忆工具共用）。
 *
 * 注意：参数规格里 `required` 只接受字面量 `true`（可选参数应直接省略该
 * 字段），否则整组参数的类型推断会退化成 JsonValue。
 */
export const SCOPE_PARAM = {
  type: 'string',
  description:
    'Anytype space id to work in. Omit to use the configured memory space (Settings → Plugins → dsh-anytype-memory → spaceName/spaceId).',
} as const;

/** 统一输出声明：开放 object schema + 纯 JSON 文本渲染（可回放）。 */
export function outputSpec(): {
  schema: { type: 'object'; additionalProperties: true };
  render: (
    args: unknown,
    value: unknown,
  ) => Array<{ type: 'text'; text: string }>;
} {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [
      { type: 'text', text: JSON.stringify(value, null, 2) },
    ],
  };
}

/**
 * 解析目标空间。
 *
 * 配置里钉了 `spaceId` 时零请求；否则按 `spaceName` 解析（进程内缓存，
 * 首次之后不再请求）。
 *
 * @param deps - 工具依赖。
 * @param spaceIdArg - 工具入参里的 space_id（可空）。
 * @returns 空间 id。
 */
export async function resolveSpaceId(
  deps: MemoryToolDeps,
  spaceIdArg?: string,
): Promise<string> {
  const cfg = deps.config();
  const explicit = (spaceIdArg ?? '').trim();
  const { spaceId } = await deps.store.resolveSpace(
    explicit.length > 0 ? explicit : cfg.spaceId,
    cfg.spaceName,
    false,
  );
  return spaceId;
}

/**
 * 构造 filter 的 AND 组合。
 *
 * @param parts - 片段数组（空片段会被跳过）。
 * @returns 组合后的 filter 字符串；无片段时返回空串。
 */
export function andFilter(parts: Array<string | undefined>): string {
  return parts
    .map((p) => (p ?? '').trim())
    .filter((p) => p.length > 0)
    .join(' AND ');
}

/**
 * 构造 `key IN ("a","b")` 片段。
 *
 * @param key - 属性 key。
 * @param values - 值列表。
 * @returns filter 片段；空列表返回空串。
 */
export function inFilter(key: string, values: readonly string[]): string {
  if (values.length === 0) return '';
  const list = values.map((v) => `"${v.replace(/"/g, '\\"')}"`).join(', ');
  return `${key} IN (${list})`;
}

/** 校验记忆种类。 */
export function isMemoryKind(value: unknown): value is MemoryKind {
  return (
    typeof value === 'string' &&
    (MEMORY_KINDS as readonly string[]).includes(value)
  );
}

/** 校验记忆状态。 */
export function isMemoryStatus(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (MEMORY_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * 截取正文摘要。
 *
 * @param text - 正文。
 * @param max - 最大字符数。
 * @returns 摘要。
 */
export function excerpt(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * 从任意值里取文本（Anytype 属性值可能是数组或标量）。
 *
 * @param value - 属性值。
 * @returns 文本（取首个字符串元素或字符串化）。
 */
export function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === 'string');
    return typeof first === 'string' ? first : '';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

/**
 * 从任意值里取数值。
 *
 * @param value - 属性值。
 * @returns 数值；不可解析时返回 undefined。
 */
export function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === 'number');
    return typeof first === 'number' ? first : undefined;
  }
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** 读取工具集合（统一声明并发安全）。 */
export type MemoryToolDefinitions = ToolDefinition[];
