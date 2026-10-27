/**
 * dsh-anytype 配置 schema 与解析。
 *
 * 设计对齐本仓库 dsh-llm-fallback 的成熟模式：
 * - 每个可编辑字段经 `volatileField()` 包裹 → 宿主 `dsh-settings.describe()`
 *   才会把它投影成设置面板表单（无 volatile 字段的插件条目会被整个丢弃）；
 * - 运行时收到的 volatile 字段是 `Volatile` 引用而非普通值，`resolveConfig`
 *   先深度解包再做语义归一化；index.ts 里每次工具执行前都重新 `resolveConfig`，
 *   让设置面板的改动即时生效（无需重载插件）；
 * - 字段描述经 `desc(en, zh)` 携带 i18n 映射（`''` 键 = 旧渲染端回退文案）。
 *
 * 字段语义：
 * - `enabled`：总开关；false 时插件不注册任何工具（systemPrompt section 照常
 *   注册，向 agent 说明工具当前停用）。
 * - `baseUrl`：Anytype 本地 API 地址（官方 anytype-mcp 同款默认 31009 端口）。
 * - `apiKey`：Anytype 设置 → API Keys 创建的 Bearer 密钥；工具执行时实时读取，
 *   缺失时报可操作错误而非静默失败。
 * - `apiVersion`：`Anytype-Version` 请求头（官方当前值 2025-11-08）。
 * - `disabledGroups`：按组停用工具（connection/search/space/object/collection/
 *   type/property/member/schema/generic），控制工具面板体积。
 * - `requestTimeoutMs`：单请求超时（与调用方取消信号组合生效）。
 * - `maxResponseChars`：工具结果文本截断上限——超限时 `data` 键被移除，
 *   改以 `truncated: true` + `data_preview` 携带预览文本，保护模型上下文。
 */

import {
  desc,
  isVolatileLike,
  setDescription,
  unwrapVolatile,
  volatileField,
  type SchemaDescription,
} from '../core/index.ts';
import Schema from '@deepseek-ai/schemastery';

// ── volatile 支持（实现在 dsh-anytype-core；此处转出以保持公开 API 面） ──

export { desc, isVolatileLike, setDescription, unwrapVolatile, volatileField };
export type { SchemaDescription };

// ── 常量与类型 ───────────────────────────────────────────────────────

/** Anytype 桌面端本地 API 默认地址（官方 anytype-mcp 同款）。 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:31009';

/** `Anytype-Version` 请求头默认值（当前官方推荐值）。 */
export const DEFAULT_API_VERSION = '2025-11-08';

/** 单请求超时默认值（毫秒）。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** 工具结果文本截断上限默认值（字符数）。 */
export const DEFAULT_MAX_RESPONSE_CHARS = 20_000;

/** 工具组标识：disabledGroups 的合法取值。 */
export const TOOL_GROUPS = [
  'connection',
  'search',
  'space',
  'object',
  'collection',
  'type',
  'property',
  'member',
  'schema',
  'generic',
] as const;

/** 工具组标识类型。 */
export type ToolGroup = (typeof TOOL_GROUPS)[number];

/** resolveConfig 产出的运行时配置（已解包 volatile 并归一化）。 */
export interface ResolvedConfig {
  /** 总开关；false = 不注册任何工具。 */
  enabled: boolean;
  /** Anytype 本地 API 地址（无尾斜杠）。 */
  baseUrl: string;
  /** Bearer 密钥（已 trim；空串 = 未配置）。 */
  apiKey: string;
  /** `Anytype-Version` 头。 */
  apiVersion: string;
  /** 被停用的工具组。 */
  disabledGroups: ReadonlySet<ToolGroup>;
  /** 单请求超时（毫秒）。 */
  requestTimeoutMs: number;
  /** 工具结果文本截断上限（字符数）。 */
  maxResponseChars: number;
}

/** 归一化 baseUrl：trim、去尾斜杠；非法（非 http(s)）返回 undefined。 */
export function normalizeBaseUrl(input: unknown): string | undefined {
  const raw = String(input ?? '').trim();
  if (raw.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return raw.replace(/\/+$/, '');
}

/** 归一化正整数配置（超时/截断上限）；非法回落默认。 */
function resolvePositiveInt(input: unknown, fallback: number): number {
  const raw = Number(input);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.floor(raw);
}

/**
 * 解析并归一化插件配置。
 *
 * @param input - loader 传入的配置（volatile 引用嵌套或普通值，或 undefined）。
 * @returns 运行时配置；baseUrl 非法时回落默认地址（不抛错，插件不阻塞宿主）。
 */
export function resolveConfig(input: unknown): ResolvedConfig {
  const raw = (unwrapVolatile(input) ?? {}) as {
    enabled?: unknown;
    baseUrl?: unknown;
    apiKey?: unknown;
    apiVersion?: unknown;
    disabledGroups?: unknown;
    requestTimeoutMs?: unknown;
    maxResponseChars?: unknown;
  };

  const enabled = raw.enabled !== false;
  const baseUrl = normalizeBaseUrl(raw.baseUrl) ?? DEFAULT_BASE_URL;
  const apiKey =
    typeof raw.apiKey === 'string'
      ? raw.apiKey.trim()
      : String(raw.apiKey ?? '').trim();
  const apiVersionRaw = String(raw.apiVersion ?? '').trim();
  const apiVersion =
    apiVersionRaw.length > 0 ? apiVersionRaw : DEFAULT_API_VERSION;

  const disabledGroups = new Set<ToolGroup>();
  if (Array.isArray(raw.disabledGroups)) {
    for (const item of raw.disabledGroups) {
      const g = String(item);
      if ((TOOL_GROUPS as readonly string[]).includes(g)) {
        disabledGroups.add(g as ToolGroup);
      }
    }
  }

  return {
    enabled,
    baseUrl,
    apiKey,
    apiVersion,
    disabledGroups,
    requestTimeoutMs: resolvePositiveInt(
      raw.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    maxResponseChars: resolvePositiveInt(
      raw.maxResponseChars,
      DEFAULT_MAX_RESPONSE_CHARS,
    ),
  };
}

/**
 * schemastery schema；导出名沿用 dsh 0.2.0 的 `Config` 契约
 * （loader 读取并投影成设置面板表单；index.ts 必须 re-export）。
 */
export const Config = Schema.object({
  enabled: volatileField(
    setDescription(
      Schema.boolean().default(true),
      desc(
        'Register the Anytype tools (off = no tools, the guidance section stays)',
        '是否注册 Anytype 工具（关闭后不注册任何工具，仅保留指引 section）',
      ),
    ),
  ),
  baseUrl: volatileField(
    setDescription(
      Schema.string().default(DEFAULT_BASE_URL),
      desc(
        'Anytype local API base URL (desktop app default port 31009)',
        'Anytype 本地 API 地址（桌面应用默认端口 31009）',
      ),
    ),
  ),
  apiKey: volatileField(
    setDescription(
      Schema.string().default(''),
      desc(
        'Anytype API key (App Settings → API Keys → Create new)',
        'Anytype API 密钥（Anytype 应用设置 → API Keys → 创建）',
      ),
    ),
  ),
  apiVersion: volatileField(
    setDescription(
      Schema.string().default(DEFAULT_API_VERSION),
      desc(
        'Anytype-Version request header value',
        'Anytype-Version 请求头取值',
      ),
    ),
  ),
  disabledGroups: volatileField(
    setDescription(
      Schema.array(Schema.string()).default([]),
      desc(
        'Tool groups to exclude: connection, search, space, object, collection, type, property, member, schema, generic',
        '要停用的工具组：connection、search、space、object、collection、type、property、member、schema、generic',
      ),
    ),
  ),
  requestTimeoutMs: volatileField(
    setDescription(
      Schema.number().default(DEFAULT_REQUEST_TIMEOUT_MS),
      desc('Per-request timeout in milliseconds', '单个请求的超时时间（毫秒）'),
    ),
  ),
  maxResponseChars: volatileField(
    setDescription(
      Schema.number().default(DEFAULT_MAX_RESPONSE_CHARS),
      desc(
        'Truncate tool result text beyond this many characters (protects model context)',
        '工具结果超过该字符数即截断（保护模型上下文）',
      ),
    ),
  ),
});
