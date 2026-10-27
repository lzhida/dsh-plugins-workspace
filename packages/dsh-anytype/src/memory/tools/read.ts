/**
 * read 组：记忆的召回与查阅。
 *
 * - `memory_recall`：**三臂召回**的主入口。
 *   - 词法臂：Anytype `search`（query + filter + sorts + fields）；
 *   - 向量臂：外部 agent 提供的查询向量 × 记忆对象上的 `embedding` 属性，
 *     本地算余弦（**插件不生成向量**）；
 *   - 关系臂：受控边属性（relates_to/derived_from/...）反查邻居。
 *   融合用 RRF(k=60)（只用名次，不用分数——Anytype 不返回相关度分数），
 *   再乘 recency/confidence/proof 的旁证权重，最后按 token 预算截断。
 * - `memory_get`：单条记忆全文 + 出入边 + provenance。
 * - `memory_list`：按 kind/status/tags 浏览（走 filter，不走全文）。
 * - `memory_search`：Anytype 全文搜索直通（最低层逃生口）。
 * - `memory_stats`：记忆库健康度（分布、陈旧率、未裁决冲突、最活跃条目）。
 *
 * ## 往返预算
 *
 * Anytype 本地 API 限速 sustained 1 req/s、burst 60，故一次召回**最多
 * 3 次 HTTP 往返**（词法 1 + 向量 1 + 关系 1）。禁止「搜到 id 再逐个
 * GET」的循环——需要正文时由 agent 显式调 `memory_get`。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '../../core/index.ts';

import { cosineSimilarity, decodeVector } from '../embedding.ts';
import {
  applyTokenBudget,
  fuseCandidates,
  type RecallArm,
  type RecallCandidate,
} from '../recall.ts';
import { EDGE_RELATIONS, MEMORY_KINDS, MEMORY_STATUSES } from '../schema.ts';
import {
  andFilter,
  excerpt,
  inFilter,
  numberOf,
  outputSpec,
  propertyKey,
  resolveSpaceId,
  SCOPE_PARAM,
  textOf,
  type MemoryToolDeps,
} from './shared.ts';

/**
 * 召回时投影的属性（语义名；真实 key 运行时解析）。
 *
 * `name` 是 Anytype 对象的标题属性（原生键），其余是插件自有属性——
 * 它们的真实 key 由 bootstrap 读回后映射（见 `propertyKey`）。
 */
const RECALL_FIELD_SEMANTICS = [
  'name',
  'kind',
  'status',
  'origin',
  'confidence',
  'importance',
  'proof_count',
  'salience',
  'access_count',
  'created_at',
  'valid_from',
  'scope',
  'source',
  'content_hash',
  // Anytype 内置的出入链关系（原生双向）——关系臂的兜底来源。
  'links',
  'backlinks',
] as const;

/** 向量臂额外投影的属性（向量原文只在插件内部参与计算，不进返回值）。 */
const VECTOR_FIELD_SEMANTICS = [
  'embedding',
  'embedding_model',
  'embedding_dim',
] as const;

/** 把语义名投影成真实属性 key 列表。 */
function recallFields(
  keys: Record<string, string>,
  extra: readonly string[] = [],
): string[] {
  return [
    ...RECALL_FIELD_SEMANTICS.map((s) => propertyKey(keys, s)),
    ...extra.map((s) => propertyKey(keys, s)),
  ];
}

/** 构建 read 组工具。 */
export function buildReadTools(deps: MemoryToolDeps) {
  return [
    defineTool({
      name: 'memory_recall',
      description:
        'Recall memories from the Anytype memory space. Three arms are fused: lexical (Anytype full-text), vector (cosine over embeddings YOU computed and stored via memory_set_embedding — pass query_vector), and relations (controlled edges such as relates_to/derived_from). Fusion is RRF over arm ranks plus recency/confidence/proof weighting; the result is truncated to a token budget and never contains raw embeddings. Draft memories are visible but flagged; superseded and archived memories are excluded by default. Narrow with kinds/status and raise limit for a wider sweep.',
      parameters: {
        query: {
          type: 'string',
          description:
            'Free-text query for the lexical arm. Omit to recall by scope only.',
        },
        space_id: SCOPE_PARAM,
        kinds: {
          type: 'array',
          description: `Restrict to these memory kinds: ${MEMORY_KINDS.join(', ')}.`,
          items: { type: 'string' },
        },
        status: {
          type: 'array',
          description: `Restrict to these statuses: ${MEMORY_STATUSES.join(', ')}.`,
          items: { type: 'string' },
        },
        arms: {
          type: 'array',
          description:
            'Which arms to use: lexical | vector | links (default: all that have data).',
          items: { type: 'string' },
        },
        query_vector: {
          type: 'array',
          description:
            'Query embedding computed by your own embedding tool. Enables the vector arm; pass embedding_model too when the space stores several models.',
          items: { type: 'number' },
        },
        embedding_model: {
          type: 'string',
          description:
            'Embedding model id of query_vector. Memories stored with a different model are excluded (never mix vector spaces).',
        },
        limit: {
          type: 'integer',
          description:
            'How many memories to consider per arm (default from settings).',
        },
        max_tokens: {
          type: 'integer',
          description:
            'Token budget for the returned bodies (default from settings; metadata is free).',
        },
        include_source: {
          type: 'boolean',
          description: 'Include the source object id of each memory.',
        },
        bump_access_count: {
          type: 'boolean',
          description:
            'true = bump access_count on the returned memories (a write per item, capped at 5 writes per call). Default false to respect the API rate limit.',
        },
      },
      output: outputSpec(),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const cfg = deps.config();
        const spaceId = await resolveSpaceId(deps, args.space_id);
        const keys = await deps.store.resolveKeys(spaceId, exec.signal);
        const key = (semantic: string): string => propertyKey(keys, semantic);

        const limit =
          typeof args.limit === 'number' && args.limit > 0
            ? args.limit
            : cfg.recallLimit;
        const maxTokens =
          typeof args.max_tokens === 'number' && args.max_tokens > 0
            ? args.max_tokens
            : cfg.recallMaxTokens;

        const kinds = (args.kinds ?? []).map((k) => String(k));
        const statuses = (args.status ?? []).map((s) => String(s));
        const arms = (args.arms ?? []).map((a) => String(a)) as RecallArm[];
        const warnings: string[] = [];

        const filter = andFilter([
          inFilter(key('kind'), kinds),
          inFilter(key('status'), statuses),
        ]);

        const candidates = new Map<string, RecallCandidate>();
        const touch = (row: {
          id: string;
          name: string;
          properties?: Record<string, unknown>;
        }): RecallCandidate => {
          const props = row.properties ?? {};
          const existing = candidates.get(row.id);
          const candidate: RecallCandidate = existing ?? {
            objectId: row.id,
            name: row.name ?? '',
            excerpt: excerpt(row.name ?? ''),
            kind: textOf(props[key('kind')]) || 'fact',
            status: textOf(props[key('status')]) || 'draft',
            origin: textOf(props[key('origin')]) || 'agent',
            confidence: numberOf(props[key('confidence')]),
            importance: numberOf(props[key('importance')]),
            proofCount: numberOf(props[key('proof_count')]),
            accessCount: numberOf(props[key('access_count')]),
            createdAt: textOf(props[key('created_at')]) || undefined,
            validFrom: textOf(props[key('valid_from')]) || undefined,
            scopeId: textOf(props[key('scope')]) || undefined,
            sourceId: textOf(props[key('source')]) || undefined,
            contentHash: textOf(props[key('content_hash')]) || undefined,
            updatedAt: textOf(props[key('created_at')]) || undefined,
            ranks: {},
          };
          candidates.set(row.id, candidate);
          return candidate;
        };

        // ── 词法臂 ───────────────────────────────────────────────────
        const useLexical = arms.length === 0 || arms.includes('lexical');
        let lexicalRows: Array<{
          id: string;
          name: string;
          properties?: Record<string, unknown>;
        }> = [];
        if (useLexical) {
          const result = await deps.store.search({
            spaceId,
            query: args.query === undefined ? '' : String(args.query),
            filter,
            sorts: [{ property: key('created_at'), direction: 'desc' }],
            fields: recallFields(keys),
            limit,
            signal: exec.signal,
          });
          lexicalRows = result.rows;
          lexicalRows.forEach((row, index) => {
            const candidate = touch(row);
            candidate.ranks = { ...candidate.ranks, lexical: index + 1 };
          });
          if (result.warnings && result.warnings.length > 0) {
            warnings.push('Anytype returned warnings during the lexical arm.');
          }
        }

        // ── 向量臂 ───────────────────────────────────────────────────
        const queryVector = args.query_vector;
        const useVector =
          (arms.length === 0 || arms.includes('vector')) &&
          Array.isArray(queryVector) &&
          queryVector.length > 0;
        if (useVector) {
          const result = await deps.store.search({
            spaceId,
            query: '',
            filter,
            sorts: [{ property: key('created_at'), direction: 'desc' }],
            fields: [...recallFields(keys, VECTOR_FIELD_SEMANTICS)],
            limit,
            signal: exec.signal,
          });
          let scored = 0;
          let dropped = 0;
          result.rows.forEach((row, index) => {
            const props = row.properties ?? {};
            const stored = decodeVector(props[key('embedding')]);
            if (!stored) {
              dropped += 1;
              return;
            }
            if (stored.length !== queryVector.length) {
              dropped += 1;
              return;
            }
            const model = textOf(props[key('embedding_model')]);
            if (
              args.embedding_model !== undefined &&
              model.length > 0 &&
              model !== String(args.embedding_model)
            ) {
              dropped += 1;
              return;
            }
            const candidate = touch(row);
            candidate.ranks = { ...candidate.ranks, vector: index + 1 };
            candidate.vectorScore = cosineSimilarity(stored, queryVector);
            scored += 1;
          });
          if (dropped > 0) {
            warnings.push(
              `${dropped} candidate(s) skipped by the vector arm (missing, mismatched-dimension or mismatched-model embedding).`,
            );
          }
          if (scored === 0) {
            warnings.push(
              'vector arm produced no usable candidate — recalled lexically only.',
            );
          }
        }

        // ── 关系臂 ───────────────────────────────────────────────────
        // 首选：按受控边属性过滤出邻居（部分服务端支持）。
        // 兜底：用 Anytype **原生**的 links/backlinks 投影取邻居 id
        //（活体实测：服务端接受 relation 过滤但匹配不到行，故必须兜底）。
        const useLinks = arms.length === 0 || arms.includes('links');
        const relatedIds: string[] = [];
        if (useLinks && lexicalRows.length > 0) {
          const seeds = lexicalRows.slice(0, 5).map((r) => r.id);
          const edgeFilters = EDGE_RELATIONS.map((rel) =>
            inFilter(key(rel), seeds),
          ).filter((f) => f.length > 0);
          if (edgeFilters.length > 0) {
            const result = await deps.store.search({
              spaceId,
              query: '',
              filter: edgeFilters.join(' OR '),
              fields: recallFields(keys),
              limit,
              signal: exec.signal,
            });
            if (result.rows.length > 0) {
              result.rows.forEach((row, index) => {
                const candidate = touch(row);
                candidate.ranks = { ...candidate.ranks, links: index + 1 };
              });
            } else {
              // 兜底：出链 + 入链（Anytype 原生双向关系）
              for (const row of lexicalRows) {
                const props = row.properties ?? {};
                for (const raw of [
                  ...(Array.isArray(props['links']) ? props['links'] : []),
                  ...(Array.isArray(props['backlinks'])
                    ? props['backlinks']
                    : []),
                ]) {
                  const id = String(raw);
                  if (id.length > 0 && !seeds.includes(id)) relatedIds.push(id);
                }
              }
              warnings.push(
                relatedIds.length > 0
                  ? `relation filtering by object id is not effective on this build — ${relatedIds.length} neighbour id(s) were taken from the native links/backlinks projection instead.`
                  : 'relation arm returned nothing — API v2 cannot filter relations by object id on this build; the lexical and vector arms still apply.',
              );
            }
          }
        }

        // ── 融合 + 预算 ─────────────────────────────────────────────
        const fused = fuseCandidates([...candidates.values()], {
          arms: arms.length > 0 ? arms : undefined,
        });
        const budgeted = applyTokenBudget(fused, maxTokens);

        const items = budgeted.items.map((item) => ({
          object_id: item.objectId,
          name: item.name,
          excerpt: item.excerpt,
          score: Number(item.score.toFixed(6)),
          arms_hit: item.armsHit,
          kind: item.kind,
          status: item.status,
          origin: item.origin,
          confidence: item.confidence ?? null,
          scope_id: item.scopeId ?? null,
          content_hash: item.contentHash ?? null,
          updated_at: item.updatedAt ?? null,
          ...(args.include_source === true
            ? { source_id: item.sourceId ?? null }
            : {}),
        }));

        // access_count 自度量（可选；每次一条写，受限速约束故封顶 5 条）。
        let bumped = 0;
        if (args.bump_access_count === true) {
          const accessKey = key('access_count');
          for (const item of budgeted.items.slice(0, 5)) {
            const candidate = candidates.get(item.objectId);
            const current = candidate?.accessCount ?? 0;
            await deps.store.setProperties(
              spaceId,
              item.objectId,
              { [accessKey]: current + 1 },
              undefined,
              false,
              exec.signal,
            );
            bumped += 1;
          }
          if (budgeted.items.length > 5) {
            warnings.push(
              'access_count bumped for the first 5 results only (API rate limit guard).',
            );
          }
        }

        return {
          items,
          truncated: budgeted.truncated,
          omitted_count: budgeted.omittedCount,
          arms_used: [
            ...(useLexical ? (['lexical'] as RecallArm[]) : []),
            ...(useVector ? (['vector'] as RecallArm[]) : []),
            ...(useLinks ? (['links'] as RecallArm[]) : []),
          ],
          candidate_count: candidates.size,
          related_ids: relatedIds.slice(0, 20),
          access_count_bumped: bumped,
          warnings,
        };
      },
    }),

    defineTool({
      name: 'memory_get',
      description:
        'Read one memory in full: title, typed properties, body, incoming/outgoing edges and provenance. Use it to open a memory returned by memory_recall — recall returns excerpts and ids, never the whole library.',
      parameters: {
        object_id: {
          type: 'string',
          required: true,
          description: 'Memory object id.',
        },
        space_id: SCOPE_PARAM,
        include_source: {
          type: 'boolean',
          description: 'Include the source object id.',
        },
      },
      output: outputSpec(),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const spaceId = await resolveSpaceId(deps, args.space_id);
        const objectId = String(args.object_id);
        const { doc } = await deps.store.getObjectWithEtag(
          spaceId,
          objectId,
          exec.signal,
        );
        const markdown = await deps.store.getObject(
          spaceId,
          objectId,
          exec.signal,
          'md',
        );
        const properties = (doc.properties ?? {}) as Record<string, unknown>;
        const links = (properties['links'] ?? []) as unknown[];
        const backlinks = (properties['backlinks'] ?? []) as unknown[];
        const keys = await deps.store.resolveKeys(spaceId, exec.signal);
        return {
          object_id: objectId,
          // 标题在 properties.name（对象文档没有顶层 name 字段）。
          name: String(properties['name'] ?? doc.name ?? ''),
          type: String(doc.type ?? ''),
          properties: properties as Record<string, JsonValue>,
          body: (markdown.blocks ?? null) as JsonValue,
          markdown: (markdown.markdown ?? null) as JsonValue,
          links: links as JsonValue[],
          backlinks: backlinks as JsonValue[],
          etag: (doc.etag ?? null) as JsonValue,
          ...(args.include_source === true
            ? {
                source_id:
                  textOf(properties[propertyKey(keys, 'source')]) || null,
              }
            : {}),
        };
      },
    }),

    defineTool({
      name: 'memory_list',
      description:
        'Browse memories by structure (kind, status, tags) instead of full-text. Cheap, paginated, and it does not depend on text matching.',
      parameters: {
        space_id: SCOPE_PARAM,
        kinds: {
          type: 'array',
          description: `Restrict to these kinds: ${MEMORY_KINDS.join(', ')}.`,
          items: { type: 'string' },
        },
        status: {
          type: 'array',
          description: `Restrict to these statuses: ${MEMORY_STATUSES.join(', ')}.`,
          items: { type: 'string' },
        },
        tags: {
          type: 'array',
          description: 'Restrict to memories carrying all of these tags.',
          items: { type: 'string' },
        },
        limit: {
          type: 'integer',
          description: 'Page size (API default 25, max 1000).',
        },
        offset: { type: 'integer', description: 'Pagination offset.' },
      },
      output: outputSpec(),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const spaceId = await resolveSpaceId(deps, args.space_id);
        const keys = await deps.store.resolveKeys(spaceId, exec.signal);
        const key = (semantic: string): string => propertyKey(keys, semantic);
        const tags = (args.tags ?? []).map((t) => String(t));
        const filter = andFilter([
          inFilter(
            key('kind'),
            (args.kinds ?? []).map((k) => String(k)),
          ),
          inFilter(
            key('status'),
            (args.status ?? []).map((s) => String(s)),
          ),
          tags.length > 0
            ? `${key('tag')} HAS ALL (${tags.map((t) => `"${t}"`).join(', ')})`
            : '',
        ]);
        const result = await deps.store.search({
          spaceId,
          query: '',
          filter,
          sorts: [{ property: key('created_at'), direction: 'desc' }],
          fields: recallFields(keys),
          limit: typeof args.limit === 'number' ? args.limit : 25,
          offset: typeof args.offset === 'number' ? args.offset : 0,
          signal: exec.signal,
        });
        return {
          items: result.rows.map((row) => ({
            object_id: row.id,
            name: row.name,
            kind: textOf(row.properties?.[key('kind')]),
            status: textOf(row.properties?.[key('status')]),
            created_at: textOf(row.properties?.[key('created_at')]),
          })),
          total: result.total ?? null,
          has_more: result.hasMore ?? false,
        };
      },
    }),

    defineTool({
      name: 'memory_search',
      description:
        'Raw Anytype full-text search inside the memory space, with the filter syntax and field projection under your control. Use memory_recall for ranked recall; use this when you need full control over the query or want to search beyond the memory type.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'Full-text query.',
        },
        space_id: SCOPE_PARAM,
        filter: {
          type: 'string',
          description:
            'Compact Anytype filter string (max 4096 bytes), e.g. \'kind IN ("fact") AND confidence >= 7\'.',
        },
        fields: {
          type: 'array',
          description:
            'Property keys to project per row (e.g. ["name","kind","status"]).',
          items: { type: 'string' },
        },
        limit: {
          type: 'integer',
          description: 'Page size (API default 25, max 1000).',
        },
        offset: { type: 'integer', description: 'Pagination offset.' },
      },
      output: outputSpec(),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const spaceId = await resolveSpaceId(deps, args.space_id);
        const result = await deps.store.search({
          spaceId,
          query: String(args.query),
          filter: args.filter === undefined ? undefined : String(args.filter),
          fields: Array.isArray(args.fields)
            ? (args.fields as unknown[]).map((f) => String(f))
            : undefined,
          limit: typeof args.limit === 'number' ? args.limit : 25,
          offset: typeof args.offset === 'number' ? args.offset : 0,
          signal: exec.signal,
        });
        return {
          items: result.rows,
          total: result.total ?? null,
          has_more: result.hasMore ?? false,
          warnings: (result.warnings ?? []) as JsonValue[],
        };
      },
    }),

    defineTool({
      name: 'memory_stats',
      description:
        'Health of the memory space: counts by kind and status, staleness (superseded vs live), unresolved contradictions, most-accessed memories and recent writes. One request, no text matching.',
      parameters: {
        space_id: SCOPE_PARAM,
      },
      output: outputSpec(),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const spaceId = await resolveSpaceId(deps, args.space_id);
        const keys = await deps.store.resolveKeys(spaceId, exec.signal);
        const key = (semantic: string): string => propertyKey(keys, semantic);
        const result = await deps.store.search({
          spaceId,
          query: '',
          fields: [
            key('kind'),
            key('status'),
            key('origin'),
            key('created_at'),
            key('access_count'),
            key('proof_count'),
            key('contradicts'),
          ],
          limit: 1000,
          signal: exec.signal,
        });
        const byKind: Record<string, number> = {};
        const byStatus: Record<string, number> = {};
        let live = 0;
        let superseded = 0;
        let disputes = 0;
        const accessed: Array<{ id: string; name: string; count: number }> = [];
        const recent: Array<{ id: string; name: string; created_at: string }> =
          [];
        for (const row of result.rows) {
          const props = row.properties ?? {};
          const kind = textOf(props[key('kind')]) || 'unknown';
          const status = textOf(props[key('status')]) || 'unknown';
          byKind[kind] = (byKind[kind] ?? 0) + 1;
          byStatus[status] = (byStatus[status] ?? 0) + 1;
          if (status === 'superseded') superseded += 1;
          else live += 1;
          if (status === 'disputed') disputes += 1;
          const count = numberOf(props[key('access_count')]) ?? 0;
          if (count > 0) accessed.push({ id: row.id, name: row.name, count });
          recent.push({
            id: row.id,
            name: row.name,
            created_at: textOf(props[key('created_at')]),
          });
        }
        accessed.sort((a, b) => b.count - a.count);
        recent.sort((a, b) => b.created_at.localeCompare(a.created_at));
        const total = result.rows.length;
        return {
          counts: { by_kind: byKind, by_status: byStatus, total },
          live,
          superseded,
          stale_ratio: total > 0 ? Number((superseded / total).toFixed(4)) : 0,
          unresolved_conflicts: disputes,
          access_top: accessed.slice(0, 10),
          recent_writes: recent.slice(0, 10),
          has_more: result.hasMore ?? false,
          warnings:
            result.hasMore === true
              ? ['more memories exist than were counted (limit 1000)']
              : [],
        };
      },
    }),
  ];
}
