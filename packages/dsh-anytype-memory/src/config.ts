/**
 * dsh-anytype-memory 配置 schema 与解析。
 *
 * 与 `dsh-anytype` 同构的成熟模式：
 * - 每个可编辑字段经 `volatileField()` 包裹 → 宿主 `dsh-settings.describe()`
 *   才会把它投影成设置面板表单（无 volatile 字段的插件条目会被整个丢弃）；
 * - 运行时收到的 volatile 字段是 `Volatile` 引用而非普通值，`resolveConfig`
 *   先深度解包再做语义归一化；index.ts 里每次工具执行前都重新
 *   `resolveConfig`，让设置面板的改动即时生效（无需重载插件）；
 * - 字段描述经 `desc(en, zh)` 携带 i18n 映射（`''` 键 = 旧渲染端回退文案）。
 *
 * 字段语义：
 * - `enabled`：总开关；false 时不注册任何工具（systemPrompt section 照常
 *   注册，向 agent 说明工具当前停用）。
 * - `baseUrl` / `apiKey` / `apiVersion`：Anytype 本地 API 连接三件套，
 *   执行时实时读取。
 * - `spaceName` / `spaceId`：**记忆工作环境**——插件把记忆写进哪个 space。
 *   `spaceId` 非空时直接钉住该空间；为空时按 `spaceName` 解析（找不到时
 *   由 `memory_setup` 按需创建）。
 * - `defaultStatus`：AI 写入记忆的默认审核态（默认 `draft`，即人类未审）。
 * - `recallLimit` / `recallMaxTokens`：召回默认条数与 token 预算上限。
 * - `embeddingBatchSize`：向量投影的单批条数（限速 1rps 下的往返预算）。
 * - `disabledGroups`：按组停用工具，控制工具面板体积。
 */

import {
  desc,
  setDescription,
  unwrapVolatile,
  volatileField,
} from '@lzhida/dsh-anytype-core';
import Schema from '@deepseek-ai/schemastery';

export { desc, setDescription, unwrapVolatile, volatileField };

// ── 常量 ──────────────────────────────────────────────────────────────

/** Anytype 桌面端本地 API 默认地址（官方 anytype-mcp 同款）。 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:31009';

/** `Anytype-Version` 请求头默认值（官方当前推荐值）。 */
export const DEFAULT_API_VERSION = '2025-11-08';

/** 单请求超时默认值（毫秒）。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** 工具结果文本截断上限默认值（字符数）。 */
export const DEFAULT_MAX_RESPONSE_CHARS = 20_000;

/** 默认记忆空间名（未显式指定 `spaceId` 时按此名解析/创建）。 */
export const DEFAULT_SPACE_NAME = 'Agent Memory';

/** 召回默认条数。 */
export const DEFAULT_RECALL_LIMIT = 20;

/** 召回默认 token 预算（只计正文，元数据免费）。 */
export const DEFAULT_RECALL_MAX_TOKENS = 4096;

/** 向量投影单批条数（20 条 × 4KB ≈ 80KB，控制在截断阈值内）。 */
export const DEFAULT_EMBEDDING_BATCH_SIZE = 20;

/** AI 写入记忆的默认审核态。 */
export const DEFAULT_MEMORY_STATUS = 'draft';

/** 工具组标识：disabledGroups 的合法取值。 */
export const TOOL_GROUPS = ['setup', 'write', 'read', 'agent', 'diag'] as const;

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
  /** 记忆空间名（`spaceId` 为空时按此名解析）。 */
  spaceName: string;
  /** 记忆空间 id（空串 = 按名解析）。 */
  spaceId: string;
  /** 被停用的工具组。 */
  disabledGroups: ReadonlySet<ToolGroup>;
  /** 单请求超时（毫秒）。 */
  requestTimeoutMs: number;
  /** 工具结果文本截断上限（字符数）。 */
  maxResponseChars: number;
  /** 召回默认条数。 */
  recallLimit: number;
  /** 召回默认 token 预算。 */
  recallMaxTokens: number;
  /** 向量投影单批条数。 */
  embeddingBatchSize: number;
  /** AI 写入记忆的默认审核态。 */
  defaultStatus: string;
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

/** 归一化正整数配置；非法回落默认。 */
function resolvePositiveInt(input: unknown, fallback: number): number {
  const raw = Number(input);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.floor(raw);
}

/** 归一化非空字符串；空串回落默认。 */
function resolveNonEmpty(input: unknown, fallback: string): string {
  const raw = String(input ?? '').trim();
  return raw.length > 0 ? raw : fallback;
}

/**
 * 解析并归一化插件配置。
 *
 * @param input - loader 传入的配置（volatile 引用嵌套或普通值，或 undefined）。
 * @returns 运行时配置；非法字段一律回落默认（不抛错，不阻塞宿主）。
 */
export function resolveConfig(input: unknown): ResolvedConfig {
  const raw = (unwrapVolatile(input) ?? {}) as {
    enabled?: unknown;
    baseUrl?: unknown;
    apiKey?: unknown;
    apiVersion?: unknown;
    spaceName?: unknown;
    spaceId?: unknown;
    disabledGroups?: unknown;
    requestTimeoutMs?: unknown;
    maxResponseChars?: unknown;
    recallLimit?: unknown;
    recallMaxTokens?: unknown;
    embeddingBatchSize?: unknown;
    defaultStatus?: unknown;
  };

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
    enabled: raw.enabled !== false,
    baseUrl: normalizeBaseUrl(raw.baseUrl) ?? DEFAULT_BASE_URL,
    apiKey: String(raw.apiKey ?? '').trim(),
    apiVersion: resolveNonEmpty(raw.apiVersion, DEFAULT_API_VERSION),
    spaceName: resolveNonEmpty(raw.spaceName, DEFAULT_SPACE_NAME),
    spaceId: String(raw.spaceId ?? '').trim(),
    disabledGroups,
    requestTimeoutMs: resolvePositiveInt(
      raw.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    maxResponseChars: resolvePositiveInt(
      raw.maxResponseChars,
      DEFAULT_MAX_RESPONSE_CHARS,
    ),
    recallLimit: resolvePositiveInt(raw.recallLimit, DEFAULT_RECALL_LIMIT),
    recallMaxTokens: resolvePositiveInt(
      raw.recallMaxTokens,
      DEFAULT_RECALL_MAX_TOKENS,
    ),
    embeddingBatchSize: resolvePositiveInt(
      raw.embeddingBatchSize,
      DEFAULT_EMBEDDING_BATCH_SIZE,
    ),
    defaultStatus: resolveNonEmpty(raw.defaultStatus, DEFAULT_MEMORY_STATUS),
  };
}

/**
 * schemastery schema；导出名沿用 dsh 的 `Config` 契约
 * （loader 读取并投影成设置面板表单；index.ts 必须 re-export）。
 */
export const Config = Schema.object({
  enabled: volatileField(
    setDescription(
      Schema.boolean().default(true),
      desc(
        'Register the memory tools (off = no tools, the guidance section stays)',
        '是否注册记忆工具（关闭后不注册任何工具，仅保留指引 section）',
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
  spaceName: volatileField(
    setDescription(
      Schema.string().default(DEFAULT_SPACE_NAME),
      desc(
        'Name of the Anytype space used as the memory workspace (created on demand by memory_setup)',
        '作为记忆工作环境的 Anytype 空间名（memory_setup 会按需创建）',
      ),
    ),
  ),
  spaceId: volatileField(
    setDescription(
      Schema.string().default(''),
      desc(
        'Pin a specific space id (short reference like 64xiwe or full id). Empty = resolve by spaceName',
        '钉住指定空间 id（短引用如 64xiwe 或完整 id）。留空 = 按 spaceName 解析',
      ),
    ),
  ),
  disabledGroups: volatileField(
    setDescription(
      Schema.array(Schema.string()).default([]),
      desc(
        'Tool groups to exclude: setup, write, read, agent, diag',
        '要停用的工具组：setup、write、read、agent、diag',
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
  recallLimit: volatileField(
    setDescription(
      Schema.number().default(DEFAULT_RECALL_LIMIT),
      desc(
        'Default number of memories returned by memory_recall',
        'memory_recall 默认返回条数',
      ),
    ),
  ),
  recallMaxTokens: volatileField(
    setDescription(
      Schema.number().default(DEFAULT_RECALL_MAX_TOKENS),
      desc(
        'Default token budget for recalled memory bodies (metadata is free)',
        '召回正文的默认 token 预算（元数据不计入）',
      ),
    ),
  ),
  embeddingBatchSize: volatileField(
    setDescription(
      Schema.number().default(DEFAULT_EMBEDDING_BATCH_SIZE),
      desc(
        'How many memories to project the embedding property for per request (keep responses small)',
        '每次请求投影 embedding 属性的记忆条数（控制响应体积）',
      ),
    ),
  ),
  defaultStatus: volatileField(
    setDescription(
      Schema.string().default(DEFAULT_MEMORY_STATUS),
      desc(
        'Status for memories written by the agent: draft (awaiting human review) | approved | disputed',
        'AI 写入记忆的默认状态：draft（待人工审核）| approved | disputed',
      ),
    ),
  ),
});
