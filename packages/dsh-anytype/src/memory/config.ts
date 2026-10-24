/**
 * dsh-anytype-memory 的**语义类**配置（bundle 内第二个插件行的设置面板字段）。
 *
 * ## 为什么这里没有 apiKey / baseUrl
 *
 * 连接类配置由插件行①（`dsh-anytype`）注册的 `AnytypeService` 持有，本
 * 插件行通过 `inject: ['anytype']` 复用同一个客户端——**钥匙只填一次**，
 * 两个插件行也不会出现「改了一处漏了另一处」的漂移。详见
 * `docs/bundle-architecture.md`。
 *
 * 本文件只描述**记忆语义**：记忆空间、新记忆的默认审核态、召回预算、
 * 向量投影批大小、工具组开关。
 *
 * 字段全部是 volatile（设置面板可编辑、保存即生效）：
 * - `enabled` / `disabledGroups` 影响「注册哪些工具」，属装载期决策，改动后
 *   需重载插件；
 * - 其余字段在每次工具调用时现读，改完下一次调用即生效。
 */

import {
  desc,
  setDescription,
  unwrapVolatile,
  volatileField,
} from '../core/index.ts';
import Schema from '@deepseek-ai/schemastery';

export { desc, setDescription, unwrapVolatile, volatileField };

// ── 常量 ──────────────────────────────────────────────────────────────

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
  /** 记忆空间名（`spaceId` 为空时按此名解析）。 */
  spaceName: string;
  /** 记忆空间 id（空串 = 按名解析）。 */
  spaceId: string;
  /** 被停用的工具组。 */
  disabledGroups: ReadonlySet<ToolGroup>;
  /** 召回默认条数。 */
  recallLimit: number;
  /** 召回默认 token 预算。 */
  recallMaxTokens: number;
  /** 向量投影单批条数。 */
  embeddingBatchSize: number;
  /** AI 写入记忆的默认审核态。 */
  defaultStatus: string;
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
    spaceName?: unknown;
    spaceId?: unknown;
    disabledGroups?: unknown;
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
    spaceName: resolveNonEmpty(raw.spaceName, DEFAULT_SPACE_NAME),
    spaceId: String(raw.spaceId ?? '').trim(),
    disabledGroups,
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
 * （loader 读取并投影成设置面板表单；入口必须 re-export）。
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
