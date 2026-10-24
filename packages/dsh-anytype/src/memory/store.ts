/**
 * 记忆存储层：把「记忆语义」映射到 Anytype v2 REST 的具体操作。
 *
 * 本层是**唯一**直接拼 Anytype 端点的地方；工具层只表达意图。
 *
 * ## 关键语义（活体实测 2026-10-23）
 *
 * - **属性必须挂进类型的字段表**：不在类型字段表里的属性「会被存储并随对象
 *   返回，但按类型过滤/查询时该键被拒绝」——所以 bootstrap 必须把属性
 *   `add_property` 进类型，否则 `filter: memory_kind = "fact"` 这类收窄直接
 *   失效。
 * - **同名不同格式会 400**：空间里已有 `origin(number)` / `source(url)` /
 *   `status(select)` 等内置属性，插件若用同名显示名铸属性会撞上
 *   `property format conflict`。故插件属性一律 `Memory ` 前缀，且
 *   bootstrap 遇到**已存在**的属性会省略 `format`（沿用既有定义）并告警。
 * - **属性值形状**：列表型键（select/multi_select/objects/files）取**数组**
 *   （选项名或对象 id），标量型键（text/number/date/checkbox）取标量；
 *   `set_properties` 的 `set` 成员同此语义，`add`/`remove` 仅对列表型键有效。
 * - **未知属性键 → 400**（并列出已知键），不会静默铸造——拼错的键立刻暴露。
 * - **未知 select 选项名 → 400**（除非请求带 `create_missing_options=true`）。
 *   本插件据此区分两种词表：受控词表（kind/status/origin/source_channel）
 *   **不**开该参数（拼错即报错），开放词表（tag）**开**（允许新标签）。
 * - **relation 无目标类型**：v2 的 `create_type`/`create_property` 都没有
 *   「relation 指向哪个类型」的字段，故「边只连记忆对象」由插件层校验。
 * - **删除受限**：`DELETE` 只对本 API key 创建的对象有效，故删除一律走
 *   `status=archived`。
 * - **限速 sustained 1 req/s**：空间解析结果在进程内缓存，避免每次调用都
 *   先打一次 `GET /v2/spaces`（缓存只在内存，不落盘）。
 */

import type { AnytypeClient, JsonValue } from '../core/index.ts';

import {
  EDGE_PROPERTY_KEY,
  MEMORY_PROPERTIES,
  MEMORY_PROPERTY_KEY,
  MEMORY_TYPE_KEY,
  MEMORY_TYPE_SPEC,
  SCOPE_PROPERTIES,
  SCOPE_TYPE_KEY,
  SCOPE_TYPE_SPEC,
  planBootstrap,
  resolvePropertyKeys,
  type EdgeRelation,
  type MemoryKind,
  type PropertyFormat,
  type PropertySpec,
} from './schema.ts';

/** 列表型属性格式（值取数组）。 */
const LIST_FORMATS = new Set<PropertyFormat>([
  'select',
  'multi_select',
  'objects',
  'files',
]);

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

/** 记忆写入输入。 */
export interface MemoryWriteInput {
  /** 记忆种类。 */
  kind: MemoryKind;
  /** 一行事实（对象 name）。 */
  name: string;
  /** 正文（markdown）。 */
  body?: string;
  /** 标签（多值）。 */
  tags?: string[];
  /** 作用域对象 id。 */
  scopeId?: string;
  /** 来源对象 id。 */
  sourceId?: string;
  /** 来源通道。 */
  sourceChannel?: string;
  /** 置信度 1-10。 */
  confidence?: number;
  /** 重要度 1-10。 */
  importance?: number;
  /** 佐证计数。 */
  proofCount?: number;
  /** 状态（默认取配置）。 */
  status?: string;
  /** 有效期起点。 */
  validFrom?: string;
  /** 观测时间。 */
  observedAt?: string;
  /** 内容哈希（幂等键）。 */
  contentHash: string;
  /** 防重键。 */
  idempotencyKey?: string;
  /** 产出方标识（provenance）。 */
  extractor?: string;
  /** 会话/批次标识（provenance）。 */
  runId?: string;
  /** 关联边（relation → 目标 id 列表）。 */
  edges?: Partial<Record<EdgeRelation, string[]>>;
  /** 取代的目标（旧记忆 id 列表）——只写关系边，不改旧条状态。 */
  supersedes?: string[];
}

/** 写入回执。 */
export interface MemoryWriteReceipt {
  /** 新建对象 id。 */
  objectId: string;
  /** 是否新建（false = 命中幂等）。 */
  created: boolean;
}

/** 搜索参数。 */
export interface MemorySearchParams {
  /** 空间 id。 */
  spaceId: string;
  /** 全文查询词。 */
  query?: string;
  /** 结构化过滤（紧凑 filter 字符串）。 */
  filter?: string;
  /** 排序。 */
  sorts?: Array<{ property: string; direction: 'asc' | 'desc' }>;
  /** 投影属性。 */
  fields?: string[];
  /** 条数上限。 */
  limit?: number;
  /** 偏移。 */
  offset?: number;
  /** 类型 key（默认 memory）。 */
  type?: string;
  /** 取消信号。 */
  signal?: AbortSignal;
}

/** 搜索结果。 */
export interface MemorySearchResult {
  rows: SearchRow[];
  /** 总数（全文检索时是下界）。 */
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

/** 记忆存储：把语义映射到 Anytype 端点。 */
export class MemoryStore {
  /**
   * HTTP 客户端（配置现读）。
   *
   * 公开可见：记忆插件行不再持有自己的连接配置，「打给谁看」（如
   * memory_doctor 报告连接目标与 API 版本）从这里读，避免再复制一份
   * baseUrl/apiVersion。
   */
  readonly client: AnytypeClient;
  /** 属性 key 解析缓存（进程内存，非本地文件）。 */
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
   * 解析记忆工作空间：优先用配置里的 `spaceId`，否则按 `spaceName` 找。
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
        `No Anytype space named "${spaceName}" is visible to this API key. Run memory_setup (create_space=true) to create it, or pin a space id in Settings → Plugins → dsh-anytype-memory.`,
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
   * 活体实测：类型文档（`GET /v2/spaces/{id}/types/{key}`）的第一个块是
   * `dataview`，它的 `properties[]` 就是该类型的字段表——**属性不在其中，
   * 按类型过滤/查询就会拒绝该键**。紧凑列表接口（`GET /types`）只给类型
   * 自身的属性，读不到字段表，故必须逐个读类型文档。
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
   * 幂等 bootstrap：确保记忆类型、作用域类型与属性字典就位。
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
    const plan = planBootstrap(
      types.map((t) => t.key),
      properties.map((p) => p.key),
    );

    const createdTypes: string[] = [];
    const addedProperties: string[] = [];
    const warnings: string[] = [];

    // 既有属性按显示名索引：同名即「已存在」，铸属性时省略 format 以沿用既有
    // 定义（服务端提示如此），并记录格式差异。
    const existingByName = new Map(
      properties.map((p) => [p.name.toLowerCase(), p] as const),
    );

    // 1) 缺类型 → 一次性带 property_definitions 建类型（少往返，避开限速）。
    for (const spec of plan.createTypes) {
      const defs = (plan.typePropertyDefinitions[spec.key] ?? []).map((def) => {
        const name = String(def.name ?? '');
        const existing = existingByName.get(name.toLowerCase());
        if (!existing) return def;
        if (existing.format !== def.format) {
          warnings.push(
            `property "${name}" already exists with format "${existing.format}" (the plugin expects "${String(def.format)}") — reused as-is; adjust the property in Anytype if the semantics differ.`,
          );
        }
        return { name };
      });
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

    // 2) 已有类型 → 先修布局，再把缺失属性 add_property 进类型字段表。
    //    （不在字段表里的属性无法按类型过滤，必须挂上。）
    for (const spec of [MEMORY_TYPE_SPEC, SCOPE_TYPE_SPEC]) {
      if (plan.createTypes.some((t) => t.key === spec.key)) continue;

      // 2a) 布局修复：`note` 布局会把对象的 name 吞成正文块（活体实测），
      //     记忆条目的标题会消失。统一校正为规格里的布局。
      try {
        await this.client.request(
          'PATCH',
          `/v2/spaces/${encodeURIComponent(spaceId)}/types/${encodeURIComponent(spec.key)}`,
          { body: { layout: spec.layout }, query: { dry_run: dryRun }, signal },
        );
      } catch (err) {
        warnings.push(
          `could not set layout "${spec.layout}" on type "${spec.key}": ${(err as Error).message}`,
        );
      }

      // 2b) 字段表 = 类型文档里 dataview 块的 property 列表。
      const known = new Set(
        await this.getTypeFields(spaceId, spec.key, signal),
      );
      const missing = spec.properties.filter((p) => !known.has(p.key));
      if (missing.length === 0) continue;
      const ops = missing.map((p) => {
        const existing = existingByName.get(p.name.toLowerCase());
        if (existing) {
          // 空间里已有同名属性 → 按它的真实 key 挂上（不改格式）。
          if (existing.format !== p.format) {
            warnings.push(
              `property "${p.name}" already exists with format "${existing.format}" (the plugin expects "${p.format}") — attached as-is.`,
            );
          }
          return { op: 'add_property', property: existing.key };
        }
        // 空间里还没有 → 由 add_property 按 key 铸造（op 只认 `property`）。
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
        `/v2/spaces/${encodeURIComponent(spaceId)}/types/${encodeURIComponent(spec.key)}`,
        {
          body: { ops },
          query: { create_missing_options: true, dry_run: dryRun },
          signal,
        },
      );
      addedProperties.push(...missing.map((p) => p.key));
    }

    // 3) 空间里还缺属性 → 显式带 key 铸造（规范允许显式 key，避免显示名派生规则）。
    //    **必须重新盘点**：上一步的类型创建已经把它的字段铸成了空间属性，
    //    继续按启动时的清单建会撞 `property key already exists`（活体实测）。
    const fresh = dryRun
      ? properties
      : await this.listProperties(spaceId, signal);
    const freshKeys = new Set(fresh.map((p) => p.key));
    const stillMissing = [...MEMORY_PROPERTIES, ...SCOPE_PROPERTIES].filter(
      (p) => !freshKeys.has(p.key),
    );
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
    const keys = resolvePropertyKeys(after, [
      ...MEMORY_PROPERTIES,
      ...SCOPE_PROPERTIES,
    ]);
    for (const [expected, actual] of Object.entries(keys)) {
      if (expected !== actual) {
        warnings.push(
          `property key drift: expected "${expected}", Anytype serves it as "${actual}" — the plugin uses the served key.`,
        );
      }
    }
    warnings.push(
      'relation properties (objects format) cannot declare a target type in API v2; the plugin validates edge targets itself.',
    );
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
   * 解析记忆属性真实 key（带进程内缓存）。
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
    const keys = resolvePropertyKeys(properties, [
      ...MEMORY_PROPERTIES,
      ...SCOPE_PROPERTIES,
    ]);
    this.keyCache.set(spaceId, keys);
    return keys;
  }

  /** 丢弃属性 key 缓存（bootstrap 后调用）。 */
  invalidateKeys(spaceId: string): void {
    this.keyCache.delete(spaceId);
  }

  // ── 对象读写 ────────────────────────────────────────────────────────

  /**
   * 写入一条记忆。
   *
   * @param spaceId - 空间 id。
   * @param input - 记忆内容。
   * @param dryRun - 只预演。
   * @param signal - 取消信号。
   * @returns 写入回执。
   */
  async createMemory(
    spaceId: string,
    input: MemoryWriteInput,
    dryRun: boolean,
    signal?: AbortSignal,
  ): Promise<MemoryWriteReceipt> {
    const keys = await this.resolveKeys(spaceId, signal);
    const properties: Record<string, unknown> = {};
    const set = (
      expectedKey: string,
      value: string | number | boolean | string[] | undefined,
    ): void => {
      if (value === undefined) return;
      const key = keys[expectedKey] ?? expectedKey;
      properties[key] = Array.isArray(value)
        ? value
        : LIST_FORMATS.has(this.formatOf(expectedKey))
          ? [value]
          : value;
    };

    set(MEMORY_PROPERTY_KEY.kind, input.kind);
    set(MEMORY_PROPERTY_KEY.status, input.status);
    set(MEMORY_PROPERTY_KEY.origin, 'agent');
    set(MEMORY_PROPERTY_KEY.sourceChannel, input.sourceChannel);
    set(MEMORY_PROPERTY_KEY.scope, input.scopeId);
    set(MEMORY_PROPERTY_KEY.source, input.sourceId);
    set(MEMORY_PROPERTY_KEY.validFrom, input.validFrom);
    set(
      MEMORY_PROPERTY_KEY.observedAt,
      input.observedAt ?? new Date().toISOString(),
    );
    set(MEMORY_PROPERTY_KEY.createdAt, new Date().toISOString());
    set(MEMORY_PROPERTY_KEY.confidence, input.confidence);
    set(MEMORY_PROPERTY_KEY.importance, input.importance);
    set(MEMORY_PROPERTY_KEY.proofCount, input.proofCount);
    set(MEMORY_PROPERTY_KEY.salience, 1);
    set(MEMORY_PROPERTY_KEY.accessCount, 0);
    set(MEMORY_PROPERTY_KEY.tag, input.tags);
    set(MEMORY_PROPERTY_KEY.contentHash, input.contentHash);
    set(MEMORY_PROPERTY_KEY.idempotencyKey, input.idempotencyKey);
    set(MEMORY_PROPERTY_KEY.extractor, input.extractor);
    set(MEMORY_PROPERTY_KEY.runId, input.runId);
    for (const [rel, targets] of Object.entries(input.edges ?? {})) {
      if (!targets || targets.length === 0) continue;
      set(EDGE_PROPERTY_KEY[rel as EdgeRelation], targets);
    }
    if (input.supersedes && input.supersedes.length > 0) {
      set(EDGE_PROPERTY_KEY.supersedes, input.supersedes);
    }

    const result = await this.client.request(
      'POST',
      `/v2/spaces/${encodeURIComponent(spaceId)}/objects`,
      {
        body: {
          type: MEMORY_TYPE_KEY,
          name: input.name,
          ...(input.body ? { markdown: input.body } : {}),
          properties,
        },
        query: {
          dry_run: dryRun,
          // 受控词表不开该参数（拼错即报错）；开放词表（tag）允许自动建选项。
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
   * 更新对象属性（走 set_properties op）。
   *
   * @param spaceId - 空间 id。
   * @param objectId - 对象 id。
   * @param set - 属性键（真实 key）→ 值。
   * @param expectedEtag - 乐观锁 etag。
   * @param dryRun - 只预演。
   * @param signal - 取消信号。
   */
  async setProperties(
    spaceId: string,
    objectId: string,
    set: Record<string, unknown>,
    expectedEtag: string | undefined,
    dryRun: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.client.request(
      'PATCH',
      `/v2/spaces/${encodeURIComponent(spaceId)}/objects/${encodeURIComponent(objectId)}`,
      {
        body: { ops: [{ op: 'set_properties', set }] },
        expectedEtag,
        query: {
          dry_run: dryRun,
          create_missing_options: this.hasOpenVocabulary(set),
        },
        signal,
      },
    );
  }

  /**
   * 对对象施加一批通用编辑 op（原子：任一 op 被拒则整批不生效）。
   *
   * @param spaceId - 空间 id。
   * @param objectId - 对象 id。
   * @param ops - op 数组（set_properties / replace_text / insert_blocks / ...）。
   * @param expectedEtag - 乐观锁 etag。
   * @param dryRun - 只预演。
   * @param signal - 取消信号。
   */
  async patchObject(
    spaceId: string,
    objectId: string,
    ops: Array<Record<string, unknown>>,
    expectedEtag: string | undefined,
    dryRun: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.client.request(
      'PATCH',
      `/v2/spaces/${encodeURIComponent(spaceId)}/objects/${encodeURIComponent(objectId)}`,
      {
        body: { ops },
        expectedEtag,
        query: { dry_run: dryRun },
        signal,
      },
    );
  }

  /**
   * 读一个对象（含属性与正文）。
   *
   * @param spaceId - 空间 id。
   * @param objectId - 对象 id。
   * @param signal - 取消信号。
   * @param format - 正文渲染格式：'md'（只读 markdown）或 'anyblock'（块树）。
   * @returns 对象文档。
   */
  async getObject(
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
   * 读一个对象并带回 etag（写前乐观锁用）。
   *
   * @param spaceId - 空间 id。
   * @param objectId - 对象 id。
   * @param signal - 取消信号。
   * @returns 对象文档与 etag。
   */
  async getObjectWithEtag(
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
   * 搜索对象。
   *
   * @param params - 搜索参数。
   * @returns 搜索结果。
   */
  async search(params: MemorySearchParams): Promise<MemorySearchResult> {
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

  /**
   * 改记忆状态（走 set_properties）。
   *
   * @param spaceId - 空间 id。
   * @param objectId - 对象 id。
   * @param status - 目标状态。
   * @param expectedEtag - 乐观锁 etag。
   * @param dryRun - 只预演。
   * @param signal - 取消信号。
   */
  async setStatus(
    spaceId: string,
    objectId: string,
    status: string,
    expectedEtag: string | undefined,
    dryRun: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const keys = await this.resolveKeys(spaceId, signal);
    const expected = MEMORY_PROPERTY_KEY.status;
    const statusKey = keys[expected] ?? expected;
    await this.setProperties(
      spaceId,
      objectId,
      { [statusKey]: [status] },
      expectedEtag,
      dryRun,
      signal,
    );
  }

  /**
   * 追加受控边（relation 属性）。
   *
   * @param spaceId - 空间 id。
   * @param objectId - 对象 id。
   * @param relation - 受控边。
   * @param targetIds - 目标对象 id 列表。
   * @param expectedEtag - 乐观锁 etag。
   * @param dryRun - 只预演。
   * @param signal - 取消信号。
   */
  async addEdge(
    spaceId: string,
    objectId: string,
    relation: EdgeRelation,
    targetIds: string[],
    expectedEtag: string | undefined,
    dryRun: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const keys = await this.resolveKeys(spaceId, signal);
    const expected = EDGE_PROPERTY_KEY[relation];
    const key = keys[expected] ?? expected;
    await this.client.request(
      'PATCH',
      `/v2/spaces/${encodeURIComponent(spaceId)}/objects/${encodeURIComponent(objectId)}`,
      {
        body: {
          ops: [{ op: 'set_properties', add: { [key]: targetIds } }],
        },
        expectedEtag,
        query: { dry_run: dryRun },
        signal,
      },
    );
  }

  /**
   * 归档对象（Anytype DELETE）——仅用于插件自建的探针对象。
   *
   * @param spaceId - 空间 id。
   * @param objectId - 对象 id。
   * @param dryRun - 只预演。
   * @param signal - 取消信号。
   */
  async deleteObject(
    spaceId: string,
    objectId: string,
    dryRun: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.client.request(
      'DELETE',
      `/v2/spaces/${encodeURIComponent(spaceId)}/objects/${encodeURIComponent(objectId)}`,
      { query: { dry_run: dryRun }, signal },
    );
  }

  /** 属性格式表（供值形状判断）。 */
  private formatOf(expectedKey: string): PropertyFormat {
    const spec: PropertySpec | undefined = [
      ...MEMORY_PROPERTIES,
      ...SCOPE_PROPERTIES,
    ].find((p) => p.key === expectedKey);
    return spec?.format ?? 'text';
  }

  /** 是否含开放词表（tag）——决定是否允许服务端自动创建选项。 */
  private hasOpenVocabulary(values: Record<string, unknown>): boolean {
    return Object.keys(values).some(
      (k) => k === MEMORY_PROPERTY_KEY.tag || k === 'tags',
    );
  }

  /** 记忆类型 key（导出给工具层）。 */
  static memoryTypeKey(): string {
    return MEMORY_TYPE_KEY;
  }

  /** 作用域类型 key（导出给工具层）。 */
  static scopeTypeKey(): string {
    return SCOPE_TYPE_KEY;
  }
}
