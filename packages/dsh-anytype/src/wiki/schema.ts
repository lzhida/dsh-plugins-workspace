/**
 * Anytype 侧的「笔记 schema」定义与幂等 bootstrap 计划。
 *
 * 本文件是**纯数据 + 纯函数**，不含任何 HTTP 调用：
 * - 词表（笔记审核态 / 审核裁决）；
 * - 属性字典（每个属性的 key、显示名、format、选项、语义）；
 * - bootstrap 计划（给定「已存在的类型与属性」，算出还缺什么）。
 *
 * ## dsh-anytype-wiki 的定位（看板卡 t-mvuclosk-ho441r）
 *
 * AI 写笔记、人类查看审核的**笔记知识库**——不是记忆系统：不做 agent 自动
 * 召回、不自动注入上下文、无向量/Index 层、无记忆生命周期（supersede/
 * 衰减/embedding 不引入）；agent 持久记忆由 hindsight/mnemon 承担。
 *
 * ## 为什么显示名带 `Wiki ` 前缀
 *
 * Anytype 空间里已有一批**内置属性**（实测 127 个，含 `origin`、`source`、
 * `status`、`tag`、`links`、`backlinks` 等）。插件若用 `Status` / `Source`
 * 这类朴素显示名铸属性，会与既有属性**同名不同格式** → 服务端 400
 * `property format conflict`。故插件自有属性一律带 `Wiki ` 前缀（key 派生
 * 为 `wiki_*`），避开冲突且自成一族。`tag` 是唯一例外——直接复用内置的
 * `tag(multi_select)`（与 memory 行同款决策）。
 *
 * ## 查重键
 *
 * 笔记以**标题唯一**：`wiki_write` 用结构性过滤 `name = "<标题>"`（单等号，
 * 活体实测 2026-10-30）查重后走创建或更新，不产生重复页。结构性过滤不走
 * 全文索引（写后立即可查），不受 Anytype 全文索引 3~6s 延迟影响。
 */

/** 笔记对象类型的 key。 */
export const WIKI_TYPE_KEY = 'wiki_note';

// ── 词表 ──────────────────────────────────────────────────────────────

/** 笔记审核态词表。 */
export const WIKI_STATUSES = ['draft', 'approved', 'archived'] as const;

/** 笔记审核态类型。 */
export type WikiStatus = (typeof WIKI_STATUSES)[number];

/** 审核裁决词表（`wiki_review` 的 decision）。 */
export const REVIEW_DECISIONS = ['approve', 'reject', 'archive'] as const;

/** 审核裁决类型。 */
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/**
 * 裁决 → 目标状态映射。
 *
 * `reject`（审核不通过）与 `archive`（下架已批准内容）语义不同，但落库
 * 都是 `archived`（Anytype 删除即归档，无独立 tombstone 态）；区别记录在
 * `wiki_reviewed_by` / `wiki_reviewed_at` 审计字段里。
 */
export const REVIEW_DECISION_TO_STATUS: Record<ReviewDecision, WikiStatus> = {
  approve: 'approved',
  reject: 'archived',
  archive: 'archived',
};

// ── 属性字典 ──────────────────────────────────────────────────────────

/** Anytype 属性 format 枚举（与 v2 规范一致）。 */
export type PropertyFormat =
  | 'text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'date'
  | 'files'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'phone'
  | 'objects';

/** 单个属性的规格定义。 */
export interface PropertySpec {
  /** 期望的 key（真实 key 以 bootstrap 读回为准）。 */
  key: string;
  /** 显示名（Anytype 面向用户的名字；key 由它派生）。 */
  name: string;
  /** 属性格式。 */
  format: PropertyFormat;
  /** select / multi_select 的选项词表。 */
  options?: readonly string[];
  /** 语义说明（写入工具描述与文档共用）。 */
  description: string;
}

/** `wiki_note` 类型的属性字典（显示名带 `Wiki ` 前缀，避开空间既有词汇）。 */
export const WIKI_PROPERTIES: readonly PropertySpec[] = [
  {
    key: 'wiki_status',
    name: 'Wiki status',
    format: 'select',
    options: WIKI_STATUSES,
    description:
      '审核态：draft（AI 写入默认）/ approved（人已批准）/ archived（已下架）。',
  },
  {
    key: 'wiki_source',
    name: 'Wiki source',
    format: 'text',
    description:
      '溯源：这条笔记依据什么写成（会话/网页/文件等来源的自由文本描述）。',
  },
  {
    key: 'wiki_created_at',
    name: 'Wiki created at',
    format: 'date',
    description: '首次写入时间。',
  },
  {
    key: 'wiki_updated_at',
    name: 'Wiki updated at',
    format: 'date',
    description: '最近一次写入时间（列表默认按它倒序）。',
  },
  {
    key: 'wiki_reviewed_by',
    name: 'Wiki reviewed by',
    format: 'text',
    description: '审核裁决者（审计字段）。',
  },
  {
    key: 'wiki_reviewed_at',
    name: 'Wiki reviewed at',
    format: 'date',
    description: '审核裁决时间（审计字段）。',
  },
  {
    key: 'tag',
    name: 'Tag',
    format: 'multi_select',
    description: '主题标签——复用 Anytype 内置的 tag(multi_select) 属性。',
  },
];

/**
 * 插件用到的属性 key 集中表（**期望 key**，真实 key 以 bootstrap 读回为准）。
 *
 * 集中定义是为了消除「工具层传 'status'、存储层查 'wiki_status'」这类
 * 字符串漂移——这类漂移表现为「filter 命中不了」而非报错。
 */
export const WIKI_PROPERTY_KEY = {
  status: 'wiki_status',
  source: 'wiki_source',
  createdAt: 'wiki_created_at',
  updatedAt: 'wiki_updated_at',
  reviewedBy: 'wiki_reviewed_by',
  reviewedAt: 'wiki_reviewed_at',
  tag: 'tag',
} as const;

// ── bootstrap 计划 ────────────────────────────────────────────────────

/** 类型规格。 */
export interface TypeSpec {
  /** 类型 key。 */
  key: string;
  /** 显示名（单数）。 */
  name: string;
  /** 显示名（复数）。 */
  pluralName: string;
  /** 实例布局。 */
  layout: 'basic' | 'note' | 'todo' | 'profile' | 'bookmark' | 'set';
  /** 字段表。 */
  properties: readonly PropertySpec[];
}

/**
 * 笔记类型规格。
 *
 * **布局必须是 `basic`**：`note` 布局会把快捷创建体的 `name` 吞成正文块
 * （活体实测 2026-10-23，memory 行同款结论），笔记标题直接丢失。
 */
export const WIKI_TYPE_SPEC: TypeSpec = {
  key: WIKI_TYPE_KEY,
  name: 'Wiki Note',
  pluralName: 'Wiki Notes',
  layout: 'basic',
  properties: WIKI_PROPERTIES,
};

/** 计划中要创建的属性项（可直接作为 create_property 的 body）。 */
export interface PropertyCreatePlan {
  key: string;
  name: string;
  format: PropertyFormat;
  options?: readonly { name: string }[];
}

/** bootstrap 计划（纯函数产物）。 */
export interface WikiBootstrapPlan {
  /** 需要创建的类型。 */
  createTypes: TypeSpec[];
  /** 已存在的类型（跳过创建）。 */
  existingTypes: string[];
  /** 需要补建的属性（key 缺失时；走 POST /properties 显式带 key）。 */
  createProperties: PropertyCreatePlan[];
  /** 已存在的属性 key（跳过）。 */
  existingProperties: string[];
  /** 计划中新建类型要带的字段表（显示名 + format + options）。 */
  typePropertyDefinitions: Record<string, Array<Record<string, unknown>>>;
}

/**
 * 计算 wiki bootstrap 计划。
 *
 * @param existingTypeKeys - 空间里已存在的类型 key 集合。
 * @param existingPropertyKeys - 空间里已存在的属性 key 集合。
 * @returns 计划：待建类型、待建属性、以及新建类型要带的字段表。
 */
export function planWikiBootstrap(
  existingTypeKeys: Iterable<string>,
  existingPropertyKeys: Iterable<string>,
): WikiBootstrapPlan {
  const types = new Set(existingTypeKeys);
  const props = new Set(existingPropertyKeys);

  const createTypes: TypeSpec[] = [];
  const typePropertyDefinitions: Record<
    string,
    Array<Record<string, unknown>>
  > = {};

  if (!types.has(WIKI_TYPE_SPEC.key)) {
    createTypes.push(WIKI_TYPE_SPEC);
    typePropertyDefinitions[WIKI_TYPE_SPEC.key] = WIKI_TYPE_SPEC.properties.map(
      (p) => {
        const def: Record<string, unknown> = { name: p.name, format: p.format };
        if (p.options && p.options.length > 0) {
          def.options = p.options.map((name) => ({ name }));
        }
        return def;
      },
    );
  }

  // 属性缺失时补建（显式带 key，避免显示名派生规则的不确定性）。
  const createProperties: PropertyCreatePlan[] = [];
  for (const spec of WIKI_PROPERTIES) {
    if (props.has(spec.key)) continue;
    createProperties.push({
      key: spec.key,
      name: spec.name,
      format: spec.format,
      options: spec.options?.map((name) => ({ name })),
    });
  }

  return {
    createTypes,
    existingTypes: [...types],
    createProperties,
    existingProperties: [...props],
    typePropertyDefinitions,
  };
}

/**
 * 按显示名在属性清单里解析真实 key。
 *
 * bootstrap 铸造属性时 key 由显示名派生，规范未承诺派生规则；故建完
 * 一律读回属性清单，按显示名匹配得到真实 key，匹配不到则退回期望 key。
 *
 * @param properties - 读回的属性清单（至少含 key 与 name/displayName）。
 * @param specs - 期望的属性字典。
 * @returns 期望 key → 真实 key 的映射。
 */
export function resolveWikiPropertyKeys(
  properties: ReadonlyArray<{ key?: string; name?: string }>,
  specs: readonly PropertySpec[] = WIKI_PROPERTIES,
): Record<string, string> {
  const byName = new Map<string, string>();
  for (const p of properties) {
    const key = p.key ?? '';
    const name = p.name ?? '';
    if (key.length > 0 && name.length > 0) byName.set(name.toLowerCase(), key);
  }
  const resolved: Record<string, string> = {};
  for (const spec of specs) {
    resolved[spec.key] = byName.get(spec.name.toLowerCase()) ?? spec.key;
  }
  return resolved;
}
