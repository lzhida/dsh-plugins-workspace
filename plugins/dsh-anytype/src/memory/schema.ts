/**
 * Anytype 侧的「记忆 schema」定义与幂等 bootstrap 计划。
 *
 * 本文件是**纯数据 + 纯函数**，不含任何 HTTP 调用：
 * - 词表（记忆 kind / 状态 / 受控边 / 来源通道）；
 * - 属性字典（每个属性的 key、显示名、format、选项、语义）；
 * - bootstrap 计划（给定「已存在的类型与属性」，算出还缺什么）。
 *
 * ## 为什么用「属性字典 + 运行时解析真实 key」
 *
 * Anytype v2 的 `POST /v2/spaces/{id}/types` 支持一次带
 * `property_definitions` 铸造整份字段表（避免逐个建属性的 N 次往返——
 * 本地 API 限速 sustained 1 req/s）。但**属性 key 由显示名派生**，规范
 * 未承诺派生规则；而 `POST /v2/spaces/{id}/properties` 允许显式传 `key`。
 * 因此 bootstrap 的策略是：
 *
 * 1. 建类型时用**显示名**铸造属性；
 * 2. 建成后 `GET /v2/spaces/{id}/properties` 读回真实 key（按显示名匹配，
 *    兜底用期望 key）；
 * 3. 之后所有读写一律用**读回的真实 key**，不假设派生规则。
 *
 * ## 为什么显示名带 `Memory ` 前缀
 *
 * Anytype 空间里已有一批**内置属性**（实测 `origin(number)`、
 * `source(url)`、`status(select)`、`tag(multi_select)`、`links`/`backlinks`
 * 等共 41 个）。插件若用 `Origin` / `Source` / `Status` 这类朴素显示名去
 * 铸属性，会与既有属性**同名不同格式** → 服务端 400
 * `property format conflict`（活体实测 2026-10-23）。
 *
 * 故插件自有属性一律带 `Memory ` 前缀（key 派生为 `memory_*`），既避开
 * 冲突，又在用户的空间里自成一族、清晰可辨。**唯一例外是 `tag`**——
 * 直接复用内置的 `tag(multi_select)`：它本来就是 Anytype 的标签概念，
 * 复用比另造一个 `memory_tag` 更符合用户直觉（且不污染词表）。
 *
 * ## relation 的硬约束
 *
 * v2 的 `create_type` / `create_property` **都没有「relation 目标类型」字段**
 * ——`objects` 格式属性可存任意对象 id，但无法在 schema 层限定目标类型。
 * 故「边只指向 memory 对象」这条不变量由**插件层校验**（写入前查目标对象的
 * type），不依赖 Anytype 的类型系统兜底。
 */

/** 记忆对象类型的 key。 */
export const MEMORY_TYPE_KEY = 'memory';

/** 作用域对象类型的 key。 */
export const SCOPE_TYPE_KEY = 'memory_scope';

// ── 词表 ──────────────────────────────────────────────────────────────

/** 记忆种类词表（写入时按此校验）。 */
export const MEMORY_KINDS = [
  'fact',
  'decision',
  'preference',
  'lesson',
  'procedure',
  'episode',
  'summary',
  'entity',
] as const;

/** 记忆种类类型。 */
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** 记忆状态词表。 */
export const MEMORY_STATUSES = [
  'draft',
  'approved',
  'disputed',
  'superseded',
  'archived',
] as const;

/** 记忆状态类型。 */
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** 受控边词表——每条边一个 relation 属性，禁止自由链接语义。 */
export const EDGE_RELATIONS = [
  'relates_to',
  'derived_from',
  'contradicts',
  'supersedes',
  'mentions',
] as const;

/** 受控边类型。 */
export type EdgeRelation = (typeof EDGE_RELATIONS)[number];

/** 来源通道词表（投毒防御的通道标记）。 */
export const SOURCE_CHANNELS = ['user', 'tool', 'web', 'agent'] as const;

/** 来源通道类型。 */
export type SourceChannel = (typeof SOURCE_CHANNELS)[number];

/** 作用域种类词表（`memory_scope` 对象的 kind）。 */
export const SCOPE_KINDS = ['project', 'agent', 'user'] as const;

/** 作用域种类类型。 */
export type ScopeKind = (typeof SCOPE_KINDS)[number];

/** 审核裁决词表（`memory_review` 的 decision）。 */
export const REVIEW_DECISIONS = ['approve', 'reject', 'dispute'] as const;

/** 审核裁决类型。 */
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** 裁决 → 目标状态映射。 */
export const REVIEW_DECISION_TO_STATUS: Record<ReviewDecision, MemoryStatus> = {
  approve: 'approved',
  reject: 'archived',
  dispute: 'disputed',
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

/** `memory` 类型的属性字典（显示名带 `Memory ` 前缀，避开空间既有词汇）。 */
export const MEMORY_PROPERTIES: readonly PropertySpec[] = [
  {
    key: 'memory_kind',
    name: 'Memory kind',
    format: 'select',
    options: MEMORY_KINDS,
    description:
      '记忆种类：fact/decision/preference/lesson/procedure/episode/summary/entity。',
  },
  {
    key: 'memory_status',
    name: 'Memory status',
    format: 'select',
    options: MEMORY_STATUSES,
    description:
      '生命周期与审核态：draft/approved/disputed/superseded/archived。',
  },
  {
    key: 'memory_origin',
    name: 'Memory origin',
    format: 'select',
    options: ['agent', 'user'],
    description: '谁写的。origin=user 的条目禁止被机器自动 supersede。',
  },
  {
    key: 'memory_source_channel',
    name: 'Memory source channel',
    format: 'select',
    options: SOURCE_CHANNELS,
    description: '来源通道（投毒防御的通道标记）：user/tool/web/agent。',
  },
  {
    key: 'memory_scope',
    name: 'Memory scope',
    format: 'objects',
    description: '软作用域：指向一个 memory_scope 对象（project/agent/user）。',
  },
  {
    key: 'memory_source',
    name: 'Memory source',
    format: 'objects',
    description: '来源对象：会话/文件/网页等原始素材对象。',
  },
  {
    key: 'memory_relates_to',
    name: 'Memory relates to',
    format: 'objects',
    description: '受控边：相关。',
  },
  {
    key: 'memory_derived_from',
    name: 'Memory derived from',
    format: 'objects',
    description: '受控边：派生自。',
  },
  {
    key: 'memory_contradicts',
    name: 'Memory contradicts',
    format: 'objects',
    description: '受控边：与……矛盾（尚未裁决的冲突）。',
  },
  {
    key: 'memory_supersedes',
    name: 'Memory supersedes',
    format: 'objects',
    description: '受控边：取代（新版指向旧版）。',
  },
  {
    key: 'memory_mentions',
    name: 'Memory mentions',
    format: 'objects',
    description: '受控边：提及（弱关联）。',
  },
  {
    key: 'memory_valid_from',
    name: 'Memory valid from',
    format: 'date',
    description: '世界真值起始时间（双时序之一）。',
  },
  {
    key: 'memory_valid_to',
    name: 'Memory valid to',
    format: 'date',
    description: '世界真值结束时间；被取代时写旧条，失效不删。',
  },
  {
    key: 'memory_observed_at',
    name: 'Memory observed at',
    format: 'date',
    description: '观测到该事实的时间（双时序之二）。',
  },
  {
    key: 'memory_created_at',
    name: 'Memory created at',
    format: 'date',
    description: '写入时间。',
  },
  {
    key: 'memory_confidence',
    name: 'Memory confidence',
    format: 'number',
    description: '置信度 1-10。',
  },
  {
    key: 'memory_importance',
    name: 'Memory importance',
    format: 'number',
    description: '重要度 1-10。',
  },
  {
    key: 'memory_salience',
    name: 'Memory salience',
    format: 'number',
    description: '显著度（召回乘性权重；衰减只改此值，永不删除）。',
  },
  {
    key: 'memory_proof_count',
    name: 'Memory proof count',
    format: 'number',
    description: '佐证计数（被独立证据印证过的次数）。',
  },
  {
    key: 'memory_access_count',
    name: 'Memory access count',
    format: 'number',
    description: '被召回次数（自度量：被用过的记忆才值钱）。',
  },
  {
    key: 'tag',
    name: 'Tag',
    format: 'multi_select',
    description: '主题标签——复用 Anytype 内置的 tag(multi_select) 属性。',
  },
  {
    key: 'memory_content_hash',
    name: 'Memory content hash',
    format: 'text',
    description: '归一化正文的 sha256(scope|kind|content)——原生幂等键。',
  },
  {
    key: 'memory_idempotency_key',
    name: 'Memory idempotency key',
    format: 'text',
    description:
      '写入时的防重键（与 Anytype Idempotency-Key 头同值，便于审计）。',
  },
  {
    key: 'memory_extractor',
    name: 'Memory extractor',
    format: 'text',
    description: '产出该记忆的模型/版本标识（provenance）。',
  },
  {
    key: 'memory_run_id',
    name: 'Memory run id',
    format: 'text',
    description: '产出该记忆的会话/批次标识（provenance）。',
  },
  {
    key: 'memory_embedding',
    name: 'Memory embedding',
    format: 'text',
    description:
      'base64(Float32Array) 向量——由外部 agent 计算，插件只搬运不算。',
  },
  {
    key: 'memory_embedding_model',
    name: 'Memory embedding model',
    format: 'text',
    description: '向量所属模型标识；不同模型的向量禁止混算。',
  },
  {
    key: 'memory_embedding_dim',
    name: 'Memory embedding dim',
    format: 'number',
    description: '向量维度；与查询向量维度不符即剔除该条。',
  },
  {
    key: 'memory_reviewed_by',
    name: 'Memory reviewed by',
    format: 'text',
    description: '审核裁决者（审计字段）。',
  },
  {
    key: 'memory_reviewed_at',
    name: 'Memory reviewed at',
    format: 'date',
    description: '审核裁决时间（审计字段）。',
  },
];

/**
 * 插件用到的属性 key 集中表（**期望 key**，真实 key 以 bootstrap 读回为准）。
 *
 * 集中定义是为了消除「工具层传 'kind'、存储层查 'memory_kind'」这类字符串
 * 漂移——活体调试时这类漂移表现为「filter 命中不了」而非报错。
 */
export const MEMORY_PROPERTY_KEY = {
  kind: 'memory_kind',
  status: 'memory_status',
  origin: 'memory_origin',
  sourceChannel: 'memory_source_channel',
  scope: 'memory_scope',
  source: 'memory_source',
  validFrom: 'memory_valid_from',
  validTo: 'memory_valid_to',
  observedAt: 'memory_observed_at',
  createdAt: 'memory_created_at',
  confidence: 'memory_confidence',
  importance: 'memory_importance',
  salience: 'memory_salience',
  proofCount: 'memory_proof_count',
  accessCount: 'memory_access_count',
  tag: 'tag',
  contentHash: 'memory_content_hash',
  idempotencyKey: 'memory_idempotency_key',
  extractor: 'memory_extractor',
  runId: 'memory_run_id',
  embedding: 'memory_embedding',
  embeddingModel: 'memory_embedding_model',
  embeddingDim: 'memory_embedding_dim',
  reviewedBy: 'memory_reviewed_by',
  reviewedAt: 'memory_reviewed_at',
} as const;

/** `memory_scope` 类型的属性字典。 */
export const SCOPE_PROPERTIES: readonly PropertySpec[] = [
  {
    key: 'scope_kind',
    name: 'Scope kind',
    format: 'select',
    options: SCOPE_KINDS,
    description: '作用域种类：project/agent/user。',
  },
  {
    key: 'scope_key',
    name: 'Scope key',
    format: 'text',
    description: '作用域的稳定标识（如仓库名、agent 名、用户名）。',
  },
];

/**
 * 受控边 → 属性 key。
 *
 * 边名（工具入参用的语义词）与属性 key（存储用）分开：入参仍是
 * `relates_to` 这类语义词，落库则是 `memory_relates_to`。
 */
export const EDGE_PROPERTY_KEY: Record<EdgeRelation, string> = {
  relates_to: 'memory_relates_to',
  derived_from: 'memory_derived_from',
  contradicts: 'memory_contradicts',
  supersedes: 'memory_supersedes',
  mentions: 'memory_mentions',
};

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
 * 记忆类型规格。
 *
 * **布局必须是 `basic`**：活体实测（2026-10-23）——`note` 布局下，快捷创建体
 * 的 `name` 会被当成**正文块**而不是标题（对象 `properties.name` 为空、正文
 * 多出一段），标题能力直接丢失；`basic` / `todo` / `bookmark` 布局都正常
 * 保留标题。记忆条目的「一行事实」就是它的标题，故用 `basic`。
 */
export const MEMORY_TYPE_SPEC: TypeSpec = {
  key: MEMORY_TYPE_KEY,
  name: 'Memory',
  pluralName: 'Memories',
  layout: 'basic',
  properties: MEMORY_PROPERTIES,
};

/** 作用域类型规格。 */
export const SCOPE_TYPE_SPEC: TypeSpec = {
  key: SCOPE_TYPE_KEY,
  name: 'Memory scope',
  pluralName: 'Memory scopes',
  layout: 'basic',
  properties: SCOPE_PROPERTIES,
};

/** 计划中要创建的属性项（可直接作为 create_property 的 body）。 */
export interface PropertyCreatePlan {
  key: string;
  name: string;
  format: PropertyFormat;
  options?: readonly { name: string }[];
}

/** bootstrap 计划（纯函数产物）。 */
export interface BootstrapPlan {
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
 * 计算 bootstrap 计划。
 *
 * @param existingTypeKeys - 空间里已存在的类型 key 集合。
 * @param existingPropertyKeys - 空间里已存在的属性 key 集合。
 * @returns 计划：待建类型、待建属性、以及新建类型要带的字段表。
 */
export function planBootstrap(
  existingTypeKeys: Iterable<string>,
  existingPropertyKeys: Iterable<string>,
): BootstrapPlan {
  const types = new Set(existingTypeKeys);
  const props = new Set(existingPropertyKeys);

  const createTypes: TypeSpec[] = [];
  const typePropertyDefinitions: Record<
    string,
    Array<Record<string, unknown>>
  > = {};

  for (const spec of [MEMORY_TYPE_SPEC, SCOPE_TYPE_SPEC]) {
    if (types.has(spec.key)) continue;
    createTypes.push(spec);
    typePropertyDefinitions[spec.key] = spec.properties.map((p) => {
      const def: Record<string, unknown> = { name: p.name, format: p.format };
      if (p.options && p.options.length > 0) {
        def.options = p.options.map((name) => ({ name }));
      }
      return def;
    });
  }

  // 属性缺失时补建（显式带 key，避免显示名派生规则的不确定性）。
  // 已存在的类型不会被改写其字段表——改字段表是 PATCH 整体替换语义，风险高，
  // 这里只保证「属性在空间里存在」，并在执行报告里提示可能需要人工补挂。
  const createProperties: PropertyCreatePlan[] = [];
  for (const spec of [...MEMORY_PROPERTIES, ...SCOPE_PROPERTIES]) {
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
export function resolvePropertyKeys(
  properties: ReadonlyArray<{ key?: string; name?: string }>,
  specs: readonly PropertySpec[],
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
