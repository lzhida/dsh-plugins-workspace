/**
 * 笔记工具层公共设施（参数、空间解析、过滤构造、值提取）。
 *
 * 与 memory 域的 tools/shared.ts 同构但更薄：这里不封装 HTTP（HTTP 语义
 * 都在 `src/store.ts`），只提供「笔记语义 → 参数/过滤」这一层的共用件。
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

import type { ResolvedConfig } from '../config.ts';
import {
  REVIEW_DECISIONS,
  WIKI_PROPERTY_KEY,
  WIKI_STATUSES,
  type ReviewDecision,
  type WikiStatus,
} from '../schema.ts';
import type { WikiStore } from '../store.ts';

/**
 * 语义名 → 真实属性 key。
 *
 * @param keys - bootstrap 读回的真实 key 映射（期望 key → 实际 key）。
 * @param semantic - 语义名（WIKI_PROPERTY_KEY 的键，或直接给期望 key）。
 * @returns 服务端实际使用的属性 key。
 */
export function propertyKey(
  keys: Record<string, string>,
  semantic: string,
): string {
  const camel = semantic.replace(/_([a-z])/g, (_m, c: string) =>
    c.toUpperCase(),
  );
  const expected =
    (WIKI_PROPERTY_KEY as Record<string, string>)[semantic] ??
    (WIKI_PROPERTY_KEY as Record<string, string>)[camel] ??
    semantic;
  return keys[expected] ?? expected;
}

/** 工具构建依赖。 */
export interface WikiToolDeps {
  /** 笔记存储（Anytype 操作）。 */
  store: WikiStore;
  /** volatile 配置现读入口。 */
  config: () => ResolvedConfig;
}

/**
 * 作用域参数（所有笔记工具共用）。
 *
 * 注意：参数规格里 `required` 只接受字面量 `true`（可选参数应直接省略该
 * 字段），否则整组参数的类型推断会退化成 JsonValue。
 */
export const SPACE_PARAM = {
  type: 'string',
  description:
    'Anytype space id to work in. Omit to use the configured wiki space (Settings → Plugins → dsh-anytype-wiki → spaceName/spaceId).',
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
 * 配置里钉了 `spaceId` 时零请求；否则按 `spaceName` 解析（进程内缓存）。
 * 非 setup 工具一律 `allowCreate=false`——空间缺失时报可操作错误（提示跑
 * wiki_setup），绝不静默建空间。
 *
 * @param deps - 工具依赖。
 * @param spaceIdArg - 工具入参里的 space_id（可空）。
 * @returns 空间 id。
 */
export async function resolveSpaceId(
  deps: WikiToolDeps,
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

/** 校验审核态词表。 */
export function isWikiStatus(value: unknown): value is WikiStatus {
  return (
    typeof value === 'string' &&
    (WIKI_STATUSES as readonly string[]).includes(value)
  );
}

/** 校验审核裁决词表。 */
export function isReviewDecision(value: unknown): value is ReviewDecision {
  return (
    typeof value === 'string' &&
    (REVIEW_DECISIONS as readonly string[]).includes(value)
  );
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
 * 从任意值里取字符串数组（links/backlinks/tag 一类列表属性）。
 *
 * @param value - 属性值。
 * @returns 字符串数组（标量包装成单元素数组）。
 */
export function listOf(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }
  return typeof value === 'string' ? [value] : [];
}

/** 笔记工具集合类型。 */
export type WikiToolDefinitions = ToolDefinition[];
