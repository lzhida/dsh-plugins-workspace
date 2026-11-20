/**
 * dsh-anytype-wiki 的**语义类**配置（bundle 内第三个插件行的设置面板字段）。
 *
 * ## 为什么这里没有 apiKey / baseUrl
 *
 * 连接类配置由插件行①（`dsh-anytype`）注册的 `AnytypeService` 持有，本
 * 插件行通过 `inject: ['anytype']` 复用同一个客户端——**钥匙只填一次**。
 * 详见 `docs/bundle-architecture.md`。
 *
 * 本文件只描述**笔记库语义**：笔记空间、工具组开关。没有召回预算/向量
 * 配置——这不是记忆系统，不做自动召回、不注入上下文。
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

/** 默认笔记空间名（未显式指定 `spaceId` 时按此名解析/创建）。 */
export const DEFAULT_SPACE_NAME = 'AI Wiki';

/** 工具组标识：disabledGroups 的合法取值。 */
export const TOOL_GROUPS = [
  'setup',
  'write',
  'review',
  'read',
  'lint',
] as const;

/** 工具组标识类型。 */
export type ToolGroup = (typeof TOOL_GROUPS)[number];

/** resolveConfig 产出的运行时配置（已解包 volatile 并归一化）。 */
export interface ResolvedConfig {
  /** 总开关；false = 不注册任何工具。 */
  enabled: boolean;
  /** 笔记空间名（`spaceId` 为空时按此名解析）。 */
  spaceName: string;
  /** 笔记空间 id（空串 = 按名解析）。 */
  spaceId: string;
  /** 被停用的工具组。 */
  disabledGroups: ReadonlySet<ToolGroup>;
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
        'Register the wiki tools (off = no tools, the guidance section stays)',
        '是否注册笔记工具（关闭后不注册任何工具，仅保留指引 section）',
      ),
    ),
  ),
  spaceName: volatileField(
    setDescription(
      Schema.string().default(DEFAULT_SPACE_NAME),
      desc(
        'Name of the Anytype space used as the note workspace (created on demand by wiki_setup)',
        '作为笔记工作环境的 Anytype 空间名（wiki_setup 会按需创建）',
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
        'Tool groups to exclude: setup, write, review, read, lint',
        '要停用的工具组：setup、write、review、read、lint',
      ),
    ),
  ),
});
