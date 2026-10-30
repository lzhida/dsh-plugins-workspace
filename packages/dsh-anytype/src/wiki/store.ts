/**
 * 笔记存储层：把「笔记语义」映射到 Anytype v2 REST 的具体操作。
 *
 * 本层是 wiki 域**唯一**直接拼 Anytype 端点的地方；工具层只表达意图。
 * 与 memory 域（已归档）的 store 同构，但语义收窄为「AI 写笔记、人看」：
 * 没有 embedding/recall/生命周期，只有 schema bootstrap、按标题查重的
 * 写入、审核裁决与只读检索。
 *
 * ## 关键语义（活体实测 2026-10-23 / 2026-10-30）
 *
 * - **属性必须挂进类型字段表**，否则按类型过滤时该键被拒——bootstrap 负责
 *   `add_property` 挂表。
 * - **显示名带 `Wiki ` 前缀**：空间内置属性约 127 个（含 `status`/`source`/
 *   `origin`/`tag`/`links`/`backlinks`），同名不同格式会 400
 *   `property format conflict`。唯一例外是 `tag`——直接复用内置
 *   `tag(multi_select)`。
 * - **值形状**：列表型键（select/multi_select/objects/files）取数组，标量
 *   型键取标量。
 * - **查重键 = 标题**：结构性过滤 `name = "<标题>"`（**单等号**，`==` 会
 *   parse error）不走全文索引、写后立即可查，不受 Anytype 全文索引 3~6s
 *   最终一致影响。
 * - **链接图**：对象文档的 GET 响应**不含** `links`/`backlinks`（计算属性），
 *   只能经 `POST /search` 的 `fields` 投影拿到；`links` = 出链目标 id 数组，
 *   `backlinks` = 入链来源 id 数组。删除即归档，归档对象被 search 排除、
 *   但仍留在别人的 `links[]` 里——失效链接判定见 lint 工具。
 * - **乐观锁**：写操作带 `expectedEtag` → If-Match；同一 etag 只能写一次
 *   （第二次 409）。正文与属性放**同一个原子 PATCH**（ops 任一被拒整批
 *   不生效），不消耗两次 etag。
 */

import type { AnytypeClient, JsonValue } from '../core/index.ts';

import {
  WIKI_PROPERTIES,
  WIKI_PROPERTY_KEY,
  WIKI_TYPE_KEY,
  WIKI_TYPE_SPEC,
  planWikiBootstrap,
  resolveWikiPropertyKeys,
  type PropertyFormat,
  type PropertySpec,
  type WikiStatus,
} from './schema.ts';

/** 列表型属性格式（值取数组）。 */
const LIST_FORMATS = new Set<PropertyFormat>([
  'select',
  'multi_select',
  'objects',
  'files',
]);

/** 单个原子 PATCH 的 ops 上限（服务端规范 1..512，留余量）。 */
const MAX_PATCH_OPS = 500;

/** Anytype 属性摘要（读属性清单时用）。 */
export interface PropertySummary {
  key: string;
  name: string;
  format: string;
}

/** Anytype 类型摘要（读类型清单时用）。 */
export interface TypeSummary {
  key: string;
  name: string;
  propertyKeys: string[];
}

/**
 * 搜索结果行（紧凑：id/name/type + 投影属性）。
 *
 * 用 `type` 而非 `interface`：TS 只给**类型别名**隐式索引签名，interface
 * 没有——而工具输出 schema 是开放对象（`Record<string, JsonValue>`），
 * interface 会因此无法赋值。
 */
export type SearchRow = {
  id: string;
  name: string;
  type: string;
  properties?: Record<string, JsonValue>;
};

/** 笔记写入输入（创建路径）。 */
export interface WikiNoteWriteInput {
  /** 笔记标题（查重键，唯一）。 */
  title: string;
  /** 正文（markdown，可空——只落属性也合法）。 */
  body?: string;
  /** 溯源：依据什么写成（自由文本）。 */
  source?: string;
  /** 主题标签。 */
  tags?: string[];
  /** 初始审核态（默认 draft）。 */
  status?: WikiStatus;
  /** 服务端幂等键。 */
  idempotencyKey?: string;
}

/** 写入回执。 */
export interface WikiWriteReceipt {
  /** 对象 id。 */
  objectId: string;
  /** 是否新建（false = 命中幂等重放）。 */
  created: boolean;
}

/** 笔记更新输入（更新路径）。 */
export interface WikiNoteUpdateInput {
  /** 新正文（提供则整篇替换，且状态重置回 draft 待重审）。 */
  body?: string;
  /** 新溯源。 */
  source?: string;
  /** 新标签（整体覆盖）。 */
  tags?: string[];
  /** 乐观锁 etag（缺省时存储层自行读回）。 */
  expectedEtag?: string;
}

/** 更新回执。 */
export interface WikiNoteUpdateReceipt {
  /** 正文被替换且状态已重置回 draft。 */
  statusResetToDraft: boolean;
  /** 是否发生了写入（无变化的更新不落 PATCH）。 */
  wrote: boolean;
}

/** 审核裁决写入输入。 */
export interface WikiReviewInput {
  /** 目标状态。 */
  status: WikiStatus;
  /** 裁决者（审计字段）。 */
  reviewedBy: string;
  /** 裁决时间（ISO 8601）。 */
  reviewedAt: string;
  /** 乐观锁 etag（缺省时存储层自行读回）。 */
  expectedEtag?: string;
}

/** 搜索参数。 */
export interface WikiSearchParams {
  /** 空间 id。 */
  spaceId: string;
  /** 全文查询词。 */
  query?: string;
  /** 结构化过滤（紧凑 filter 字符串）。 */
  filter?: string;
  /** 排序。 */
  sorts?: Array<{ property: string; direction: 'asc' | 'desc' }>;
  /** 投影属性（真实 key）。 */
  fields?: string[];
  /** 条数上限。 */
  limit?: number;
  /** 偏移。 */
  offset?: number;
  /** 类型 key（默认 wiki_note）。 */
  type?: string;
  /** 取消信号。 */
  signal?: AbortSignal;
}

/** 搜索结果。 */
export interface WikiSearchResult {
  rows: SearchRow[];
  /** 总数。 */
  total?: number;
  /** 是否还有更多。 */
  hasMore?: boolean;
  /** 服务端告警。 */
  warnings?: unknown[];
}

/** bootstrap 结果。 */
export interface SchemaSetupResult {
  /** 目标空间 id。 */
  spaceId: string;
  /** 新建的类型。 */
  createdTypes: string[];
  /** 补挂/新建的属性。 */
  addedProperties: string[];
  /** 已存在的类型。 */
  existingTypes: string[];
  /** 真实属性 key 映射（期望 key → 实际 key）。 */
  keys: Record<string, string>;
  /** 警告。 */
  warnings: string[];
}

/** 笔记存储：把语义映射到 Anytype 端点。 */
export class WikiStore {
  /**
   * HTTP 客户端（连接配置现读，由 anytype 服务行提供）。
   *
   * 公开可见：工具层（如 lint 报告连接目标）从这里读，避免复制 baseUrl。
   */
  readonly client: AnytypeClient;
  /** 属性 key 解析缓存（进程内存）。 */
  private readonly keyCache = new Map<string, Record<string, string>>();
  /** 空间名 → 空间 id 缓存（进程内存）。 */
  private readonly spaceCache = new Map<string, string>();

  /**
   * @param client - Anytype 客户端。
   */
  constructor(client: AnytypeClient) {
    this.client = client;
  }

  // ── 空间 ────────────────────────────────────────────────────────────

  /**
   * 列出可见空间。
   *
   * @param signal - 取消信号。
   * @returns 空间摘要数组。
   */
  async listSpaces(
    signal?: AbortSignal,
  ): Promise<Array<{ id: string; name: string }>> {
    const result = await this.client.request('GET', '/v2/spaces', { signal });
    const data = result.data as { data?: Array<{ id: string; name: string }> };
    return data?.data ?? [];
  }

  /**
   * 创建空间。
   *
   * @param name - 空间名。
   * @param signal - 取消信号。
   * @returns 新空间 id。
   */
  async createSpace(name: string, signal?: AbortSignal): Promise<string> {
    const result = await this.client.request('POST', '/v2/spaces', {
      body: { name },
      signal,
    });
    const data = result.data as { id?: string; space?: { id?: string } };
    const id = data?.id ?? data?.space?.id;
    if (!id) {
      throw new Error(
        `Anytype space creation returned no id (space "${name}"). Check the response body.`,
      );
    }
    return id;
  }

  /**
   * 解析笔记工作空间：优先用配置里的 `spaceId`，否则按 `spaceName` 找。
   *
   * 注意：新建空间后 Anytype 的授权是异步的（紧随其后的空间级请求可能
   * 403 `space_not_granted`，稍候重试即可）。
   *
   * @param spaceId - 钉住的空间 id（可空）。
   * @param spaceName - 空间名（可空）。
   * @param allowCreate - 找不到时是否创建。
   * @param signal - 取消信号。
   * @returns 空间 id 与是否新建。
   */
  async resolveSpace(
    spaceId: string,
    spaceName: string,
    allowCreate: boolean,
    signal?: AbortSignal,
  ): Promise<{ spaceId: string; created: boolean }> {
    if (spaceId.length > 0) return { spaceId, created: false };
    const cached = this.spaceCache.get(spaceName);
    if (cached) return { spaceId: cached, created: false };
    const spaces = await this.listSpaces(signal);
    const hit = spaces.find((s) => s.name === spaceName);
    if (hit) {
      this.spaceCache.set(spaceName, hit.id);
      return { spaceId: hit.id, created: false };
    }
    if (!allowCreate) {
      throw new Error(
        `No Anytype space named "${spaceName}" is visible to this API key. Run wiki_setup (create_space=true) to create it, or pin a space id in Settings → Plugins → dsh-anytype-wiki.`,
      );
    }
    const created = await this.createSpace(spaceName, signal);
    this.spaceCache.set(spaceName, created);
    return { spaceId: created, created: true };
  }

  // ── schema ──────────────────────────────────────────────────────────

  /**
   * 列出空间里的类型。
   *
   * @param spaceId - 空间 id。
   * @param signal - 取消信号。
   * @returns 类型摘要。
   */
  async listTypes(
    spaceId: string,
    signal?: AbortSignal,
  ): Promise<TypeSummary[]> {
    const result = await this.client.request(
      'GET',
      `/v2/spaces/${encodeURIComponent(spaceId)}/types`,
      { query: { limit: 1000 }, signal },
    );
    const data = result.data as {
      data?: Array<{
        key?: string;
        api_key?: string;
        name?: string;
        properties?: Array<{ key?: string } | string>;
      }>;
    };
    return (data?.data ?? []).map((t) => ({
      key: t.key ?? t.api_key ?? '',
      name: t.name ?? '',
      propertyKeys: (t.properties ?? [])
        .map((p) => (typeof p === 'string' ? p : (p?.key ?? '')))
        .filter((k) => k.length > 0),
    }));
  }

  /**
   * 列出空间里的属性。
   *
   * @param spaceId - 空间 id。
   * @param signal - 取消信号。
   * @returns 属性摘要。
   */
  async listProperties(
    spaceId: string,
    signal?: AbortSignal,
  ): Promise<PropertySummary[]> {
    const result = await this.client.request(
      'GET',
      `/v2/spaces/${encodeURIComponent(spaceId)}/properties`,
      { query: { limit: 1000 }, signal },
    );
    const data = result.data as {
      data?: Array<{ key?: string; name?: string; format?: string }>;
    };
    return (data?.data ?? []).map((p) => ({
      key: p.key ?? '',
      name: p.name ?? '',
      format: p.format ?? 'text',
    }));
  }

  /**
   * 读一个类型的**字段表**。
   *
   * 字段表在类型文档（`GET /types/{key}`）的 dataview 块 `properties[]` 里，
   * 紧凑列表接口读不到；不在字段表里的属性无法按类型过滤。
   *
   * @param spaceId - 空间 id。
   * @param typeKey - 类型 key。
   * @param signal - 取消信号。
   * @returns 字段表的属性 key 列表。
   */
  async getTypeFields(
    spaceId: string,
    typeKey: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const result = await this.client.request(
      'GET',
      `/v2/spaces/${encodeURIComponent(spaceId)}/types/${encodeURIComponent(typeKey)}`,
      { signal },
    );
    const doc = (result.data ?? {}) as {
      blocks?: Array<{
        type?: string;
        properties?: Array<{ property?: string }>;
      }>;
    };
    const dataview = (doc.blocks ?? []).find((b) => b.type === 'dataview');
    return (dataview?.properties ?? [])
      .map((p) => p.property ?? '')
      .filter((k) => k.length > 0);
  }

  /**
   * 幂等 bootstrap：确保笔记类型与属性字典就位（重复执行不重复创建）。
   *
   * @param spaceId - 空间 id。
   * @param dryRun - 只预演不落库。
   * @param signal - 取消信号。
   * @returns bootstrap 结果。
   */
  async setupSchema(
    spaceId: string,
    dryRun: boolean,
    signal?: AbortSignal,
  ): Promise<SchemaSetupResult> {
    const [types, properties] = await Promise.all([
      this.listTypes(spaceId, signal),
      this.listProperties(spaceId, signal),
    ]);
    const plan = planWikiBootstrap(
      types.map((t) => t.key),
      properties.map((p) => p.key),
    );

    const createdTypes: string[] = [];
    const addedProperties: string[] = [];
    const warnings: string[] = [];

    // 既有属性按显示名索引：同名即「已存在」，沿用既有定义并记录格式差异。
    const existingByName = new Map(
      properties.map((p) => [p.name.toLowerCase(), p] as const),
    );

    // 1) 缺类型 → 一次性带 property_definitions 建类型（少往返）。
    for (const spec of plan.createTypes) {
      const defs = (plan.typePropertyDefinitions[spec.key] ?? []).map(
        (def: Record<string, unknown>) => {
          const name = String(def.name ?? '');
          const existing = existingByName.get(name.toLowerCase());
          if (!existing) return def;
          if (existing.format !== String(def.format ?? '')) {
            warnings.push(
              `property "${name}" already exists with format "${existing.format}" (the plugin expects "${String(def.format)}") — reused as-is; adjust the property in Anytype if the semantics differ.`,
            );
          }
          return { name };
        },
      );
      await this.client.request(
        'POST',
        `/v2/spaces/${encodeURIComponent(spaceId)}/types`,
        {
          body: {
            name: spec.name,
            api_key: spec.key,
            plural_name: spec.pluralName,
            layout: spec.layout,
            property_definitions: defs,
          },
          query: { create_missing_options: true, dry_run: dryRun },
          signal,
        },
      );
      createdTypes.push(spec.key);
    }

    // 2) 已有类型 → 先修布局（note 布局会吞标题），再把缺失属性挂进字段表。
    if (!plan.createTypes.some((t) => t.key === WIKI_TYPE_SPEC.key)) {
      // 2a) 布局校正为 basic（活体实测：note 布局会把 name 吞成正文块）。
      try {
        await this.client.request(
          'PATCH',
          `/v2/spaces/${encodeURIComponent(spaceId)}/types/${encodeURIComponent(WIKI_TYPE_SPEC.key)}`,
          {
            body: { layout: WIKI_TYPE_SPEC.layout },
            query: { dry_run: dryRun },
            signal,
          },
        );
      } catch (err) {
        warnings.push(
          `could not set layout "${WIKI_TYPE_SPEC.layout}" on type "${WIKI_TYPE_SPEC.key}": ${(err as Error).message}`,
        );
      }

      // 2b) 字段表比对，缺的属性 add_property 挂上。
      const known = new Set(
        await this.getTypeFields(spaceId, WIKI_TYPE_SPEC.key, signal),
      );
      const missing = WIKI_TYPE_SPEC.properties.filter(
        (p) => !known.has(p.key),
      );
      if (missing.length > 0) {
        const ops = missing.map((p) => {
          const existing = existingByName.get(p.name.toLowerCase());
          if (existing) {
            if (existing.format !== p.format) {
              warnings.push(
                `property "${p.name}" already exists with format "${existing.format}" (the plugin expects "${p.format}") — attached as-is.`,
              );
            }
            return { op: 'add_property', property: existing.key };
          }
          return {
            op: 'add_property',
            property: p.key,
            format: p.format,
            ...(p.options
              ? { options: p.options.map((name) => ({ name })) }
              : {}),
          };
        });
        await this.client.request(
          'PATCH',
          `/v2/spaces/${encodeURIComponent(spaceId)}/types/${encodeURIComponent(WIKI_TYPE_SPEC.key)}`,
          {
            body: { ops },
            query: { create_missing_options: true, dry_run: dryRun },
            signal,
          },
        );
        addedProperties.push(...missing.map((p) => p.key));
      }
    }

    // 3) 空间里还缺属性 → 显式带 key 铸造。**必须重新盘点**：步骤 1 的类型
    //    创建已把字段铸成空间属性，按启动时清单建会撞 property key already
    //    exists（活体实测）。
    const fresh = dryRun
      ? properties
      : await this.listProperties(spaceId, signal);
    const freshKeys = new Set(fresh.map((p) => p.key));
    const stillMissing = WIKI_PROPERTIES.filter((p) => !freshKeys.has(p.key));
    for (const spec of stillMissing) {
      await this.client.request(
        'POST',
        `/v2/spaces/${encodeURIComponent(spaceId)}/properties`,
        {
          body: {
            name: spec.name,
            key: spec.key,
            format: spec.format,
            ...(spec.options
              ? { options: spec.options.map((name) => ({ name })) }
              : {}),
          },
          query: { dry_run: dryRun },
          signal,
        },
      );
      addedProperties.push(spec.key);
    }

    // 4) 读回真实 key（显示名 → key），后续读写一律用真实 key。
    const after = dryRun
      ? properties
      : await this.listProperties(spaceId, signal);
    const keys = resolveWikiPropertyKeys(after, WIKI_PROPERTIES);
    for (const [expected, actual] of Object.entries(keys)) {
      if (expected !== actual) {
        warnings.push(
          `property key drift: expected "${expected}", Anytype serves it as "${actual}" — the plugin uses the served key.`,
        );
      }
    }
    this.keyCache.set(spaceId, keys);

    return {
      spaceId,
      createdTypes,
      addedProperties,
      existingTypes: plan.existingTypes,
      keys,
      warnings,
    };
  }

  /**
   * 解析笔记属性真实 key（带进程内缓存）。
   *
   * @param spaceId - 空间 id。
   * @param signal - 取消信号。
   * @returns 期望 key → 实际 key 映射。
   */
  async resolveKeys(
    spaceId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, string>> {
    const cached = this.keyCache.get(spaceId);
    if (cached) return cached;
    const properties = await this.listProperties(spaceId, signal);
    const keys = resolveWikiPropertyKeys(properties, WIKI_PROPERTIES);
    this.keyCache.set(spaceId, keys);
    return keys;
  }

  /** 丢弃属性 key 缓存（bootstrap 后调用）。 */
  invalidateKeys(spaceId: string): void {
    this.keyCache.delete(spaceId);
  }

  // ── 对象读写 ────────────────────────────────────────────────────────

  /**
   * 新建一篇笔记（POST objects 快捷体）。
   *
   * @param spaceId - 空间 id。
   * @param input - 笔记内容。
   * @param dryRun - 只预演。
   * @param signal - 取消信号。
   * @returns 写入回执。
   */
  async createNote(
    spaceId: string,
    input: WikiNoteWriteInput,
    dryRun: boolean,
    signal?: AbortSignal,
  ): Promise<WikiWriteReceipt> {
    const keys = await this.resolveKeys(spaceId, signal);
    const now = new Date().toISOString();
    const properties: Record<string, unknown> = {};
    const set = (
      expectedKey: string,
      value: string | string[] | undefined,
    ): void => {
      if (value === undefined) return;
      const key = keys[expectedKey] ?? expectedKey;
      properties[key] = Array.isArray(value)
        ? value
        : LIST_FORMATS.has(this.formatOf(expectedKey))
          ? [value]
          : value;
    };

    set(WIKI_PROPERTY_KEY.status, input.status ?? 'draft');
    set(WIKI_PROPERTY_KEY.source, input.source);
    set(WIKI_PROPERTY_KEY.createdAt, now);
    set(WIKI_PROPERTY_KEY.updatedAt, now);
    set(WIKI_PROPERTY_KEY.tag, input.tags);

    const result = await this.client.request(
      'POST',
      `/v2/spaces/${encodeURIComponent(spaceId)}/objects`,
      {
        body: {
          type: WIKI_TYPE_KEY,
          name: input.title,
          ...(input.body ? { markdown: input.body } : {}),
          properties,
        },
        query: {
          dry_run: dryRun,
          // tag 是开放词表：允许服务端自动创建新选项。
          create_missing_options: this.hasOpenVocabulary(properties),
        },
        idempotencyKey: input.idempotencyKey,
        signal,
      },
    );
    const data = result.data as { id?: string; object?: { id?: string } };
    const objectId = data?.id ?? data?.object?.id ?? '';
    return { objectId, created: true };
  }

  /**
   * 更新一篇笔记（读回 etag 与块树 → 单个原子 PATCH）。
   *
   * 语义：
   * - 提供 `body` → 整篇替换正文（删旧块 + 插新 markdown），并把状态重置
   *   回 draft（内容变了，需人工重审）；
   * - 只改 `source` / `tags` → 仅更新属性，审核态保持不变；
   * - `wiki_updated_at` 一律刷新。
   *
   * @param spaceId - 空间 id。
   * @param objectId - 对象 id。
   * @param patch - 更新内容。
   * @param dryRun - 只预演。
   * @param signal - 取消信号。
   * @returns 更新回执。
   */
  async updateNote(
    spaceId: string,
    objectId: string,
    patch: WikiNoteUpdateInput,
    dryRun: boolean,
    signal?: AbortSignal,
  ): Promise<WikiNoteUpdateReceipt> {
    const keys = await this.resolveKeys(spaceId, signal);
    // 无论调用方是否带 expected_etag 都要 GET：删旧块需要块 id。
    const { doc, etag } = await this.getNoteWithEtag(spaceId, objectId, signal);
    const expectedEtag = patch.expectedEtag ?? etag;

    const ops: Array<Record<string, unknown>> = [];
    const set: Record<string, unknown> = {};

    if (patch.body !== undefined) {
      const blocks = (doc.blocks ?? []) as Array<{ id?: string }>;
      for (const block of blocks) {
        if (!block.id) continue;
        ops.push({ op: 'delete_block', id: block.id, recursive: true });
      }
      if (patch.body.length > 0) {
        ops.push({ op: 'insert_blocks', markdown: patch.body });
      }
      const statusKey =
        keys[WIKI_PROPERTY_KEY.status] ?? WIKI_PROPERTY_KEY.status;
      set[statusKey] = ['draft'];
    }
    if (patch.source !== undefined) {
      const key = keys[WIKI_PROPERTY_KEY.source] ?? WIKI_PROPERTY_KEY.source;
      set[key] = patch.source;
    }
    if (patch.tags !== undefined) {
      const key = keys[WIKI_PROPERTY_KEY.tag] ?? WIKI_PROPERTY_KEY.tag;
      set[key] = patch.tags;
    }
    const updatedAtKey =
      keys[WIKI_PROPERTY_KEY.updatedAt] ?? WIKI_PROPERTY_KEY.updatedAt;
    set[updatedAtKey] = new Date().toISOString();

    const hasPropertyChanges = Object.keys(set).length > 0;
    const hasBodyChange = ops.length > 0;
    if (!hasPropertyChanges && !hasBodyChange) {
      return { statusResetToDraft: false, wrote: false };
    }
    if (ops.length > MAX_PATCH_OPS) {
      throw new Error(
        `note "${objectId}" has too many blocks (${ops.length}) for an atomic body replacement (limit ${MAX_PATCH_OPS}). Archive it and write a fresh note instead.`,
      );
    }
    if (hasPropertyChanges) {
      ops.push({ op: 'set_properties', set });
    }
    await this.client.request(
      'PATCH',
      `/v2/spaces/${encodeURIComponent(spaceId)}/objects/${encodeURIComponent(objectId)}`,
      {
        body: { ops },
        expectedEtag,
        query: {
          dry_run: dryRun,
          create_missing_options: this.hasOpenVocabulary(set),
        },
        signal,
      },
    );
    return { statusResetToDraft: patch.body !== undefined, wrote: true };
  }

  /**
   * 读一篇笔记（含属性与正文）。
   *
   * @param spaceId - 空间 id。
   * @param objectId - 对象 id。
   * @param signal - 取消信号。
   * @param format - 正文渲染格式：'md'（只读 markdown）或 'anyblock'（块树）。
   * @returns 对象文档。
   */
  async getNote(
    spaceId: string,
    objectId: string,
    signal?: AbortSignal,
    format?: 'md' | 'anyblock',
  ): Promise<Record<string, unknown>> {
    const result = await this.client.request(
      'GET',
      `/v2/spaces/${encodeURIComponent(spaceId)}/objects/${encodeURIComponent(objectId)}`,
      { query: { format }, signal },
    );
    return (result.data ?? {}) as Record<string, unknown>;
  }

  /**
   * 读一篇笔记并带回 etag（写前乐观锁用）。
   *
   * @param spaceId - 空间 id。
   * @param objectId - 对象 id。
   * @param signal - 取消信号。
   * @returns 对象文档与 etag。
   */
  async getNoteWithEtag(
    spaceId: string,
    objectId: string,
    signal?: AbortSignal,
  ): Promise<{ doc: Record<string, unknown>; etag?: string }> {
    const result = await this.client.request(
      'GET',
      `/v2/spaces/${encodeURIComponent(spaceId)}/objects/${encodeURIComponent(objectId)}`,
      { signal },
    );
    const doc = (result.data ?? {}) as Record<string, unknown>;
    const headerEtag = result.etag;
    const bodyEtag =
      typeof doc.etag === 'string' ? (doc.etag as string) : undefined;
    return { doc, etag: headerEtag ?? bodyEtag };
  }

  /**
   * 按标题查笔记（结构性过滤，写后立即可查）。
   *
   * @param spaceId - 空间 id。
   * @param title - 笔记标题（查重键）。
   * @param signal - 取消信号。
   * @returns 命中行（0/1/多——多条说明库里已有重名，工具层应告警）。
   */
  async findByTitle(
    spaceId: string,
    title: string,
    signal?: AbortSignal,
  ): Promise<SearchRow[]> {
    const keys = await this.resolveKeys(spaceId, signal);
    const fields = [
      WIKI_PROPERTY_KEY.status,
      WIKI_PROPERTY_KEY.source,
      WIKI_PROPERTY_KEY.createdAt,
      WIKI_PROPERTY_KEY.updatedAt,
      WIKI_PROPERTY_KEY.tag,
    ].map((k) => keys[k] ?? k);
    const result = await this.search({
      spaceId,
      query: '',
      filter: `name = ${quoteFilterValue(title)}`,
      fields,
      limit: 5,
      signal,
    });
    return result.rows;
  }

  /**
   * 写入审核裁决（approve/reject/archive → status + 审计字段）。
   *
   * @param spaceId - 空间 id。
   * @param objectId - 对象 id。
   * @param input - 裁决内容。
   * @param dryRun - 只预演。
   * @param signal - 取消信号。
   */
  async reviewNote(
    spaceId: string,
    objectId: string,
    input: WikiReviewInput,
    dryRun: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const keys = await this.resolveKeys(spaceId, signal);
    let expectedEtag = input.expectedEtag;
    if (expectedEtag === undefined) {
      ({ etag: expectedEtag } = await this.getNoteWithEtag(
        spaceId,
        objectId,
        signal,
      ));
    }
    const set: Record<string, unknown> = {
      [keys[WIKI_PROPERTY_KEY.status] ?? WIKI_PROPERTY_KEY.status]: [
        input.status,
      ],
      [keys[WIKI_PROPERTY_KEY.reviewedBy] ?? WIKI_PROPERTY_KEY.reviewedBy]:
        input.reviewedBy,
      [keys[WIKI_PROPERTY_KEY.reviewedAt] ?? WIKI_PROPERTY_KEY.reviewedAt]:
        input.reviewedAt,
    };
    await this.client.request(
      'PATCH',
      `/v2/spaces/${encodeURIComponent(spaceId)}/objects/${encodeURIComponent(objectId)}`,
      {
        body: { ops: [{ op: 'set_properties', set }] },
        expectedEtag,
        query: { dry_run: dryRun },
        signal,
      },
    );
  }

  /**
   * 搜索对象。
   *
   * @param params - 搜索参数。
   * @returns 搜索结果。
   */
  async search(params: WikiSearchParams): Promise<WikiSearchResult> {
    const body: Record<string, unknown> = {};
    if (params.query !== undefined) body.query = params.query;
    if (params.filter !== undefined) body.filter = params.filter;
    if (params.sorts !== undefined) body.sorts = params.sorts;
    if (params.fields !== undefined) body.fields = params.fields;
    if (params.type !== undefined) body.type = params.type;
    const result = await this.client.request(
      'POST',
      `/v2/spaces/${encodeURIComponent(params.spaceId)}/search`,
      {
        body,
        query: { limit: params.limit, offset: params.offset },
        signal: params.signal,
      },
    );
    const data = result.data as {
      data?: Array<{
        id: string;
        name: string;
        type: string;
        properties?: Record<string, JsonValue>;
      }>;
      total?: number;
      has_more?: boolean;
      warnings?: unknown[];
    };
    return {
      rows: data?.data ?? [],
      total: data?.total,
      hasMore: data?.has_more,
      warnings: data?.warnings,
    };
  }

  /** 属性格式表（供值形状判断）。 */
  private formatOf(expectedKey: string): PropertyFormat {
    const spec: PropertySpec | undefined = WIKI_PROPERTIES.find(
      (p) => p.key === expectedKey,
    );
    return spec?.format ?? 'text';
  }

  /** 是否含开放词表（tag）——决定是否允许服务端自动创建选项。 */
  private hasOpenVocabulary(values: Record<string, unknown>): boolean {
    return Object.keys(values).some((k) => k === WIKI_PROPERTY_KEY.tag);
  }
}

/**
 * 过滤器字符串值转义：值包双引号，内部的 `\` 与 `"` 前加 `\`。
 *
 * @param value - 原始值。
 * @returns 可直接嵌入紧凑 filter 的带引号值。
 */
function quoteFilterValue(value: string): string {
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `"${escaped}"`;
}
