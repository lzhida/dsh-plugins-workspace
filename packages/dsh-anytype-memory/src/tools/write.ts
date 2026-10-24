/**
 * write 组：记忆的写入与状态流转。
 *
 * - `memory_write`：批量写记忆。**写前必读**——先查同内容哈希（幂等）、
 *   再查近邻（冲突候选），冲突**只上报不裁决**（裁决权归 agent）。
 * - `memory_update`：按 op 编辑（replace_text / insert_blocks / set_properties）。
 * - `memory_link`：受控边（5 种词表之一），**校验目标是记忆对象**。
 * - `memory_supersede`：旧条转 superseded + valid_to + 建 supersedes 边；
 *   `origin=user` 的旧条**拒绝自动作废**。
 * - `memory_archive`：转 archived（不删除——DELETE 受创建者权限限制）。
 * - `memory_review`：审核裁决（approve/reject/dispute），写审计字段。
 *
 * 统一约定：写路径一律带 `dry_run` 与 `idempotency_key`；状态流转**不
 * 改写正文与 content_hash**（记忆的正文一旦落库就是事实，改写只走
 * `memory_update` 的显式 op）。
 */

import {
  DRY_RUN_PARAM,
  IDEMPOTENCY_KEY_PARAM,
  type JsonValue,
} from '@lzhida/dsh-anytype-core';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { contentHash } from '../dedup.ts';
import {
  EDGE_RELATIONS,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  type EdgeRelation,
  type MemoryKind,
} from '../schema.ts';
import {
  andFilter,
  excerpt,
  inFilter,
  isMemoryKind,
  numberOf,
  outputSpec,
  propertyKey,
  resolveSpaceId,
  SCOPE_PARAM,
  textOf,
  type MemoryToolDeps,
} from './shared.ts';

/** 冲突候选的最小形态（用类型别名：工具输出需要隐式索引签名）。 */
type ConflictRow = {
  objectId: string;
  kind: string;
  status: string;
  validFrom?: string;
  excerpt: string;
};

/** 从搜索行里取属性（Anytype 返回 `properties` 映射）。 */
function prop(
  row: { properties?: Record<string, unknown> },
  key: string,
): unknown {
  return row.properties?.[key];
}

/** 构建 write 组工具。 */
export function buildWriteTools(deps: MemoryToolDeps) {
  return [
    defineTool({
      name: 'memory_write',
      description:
        'Write memories into the Anytype memory space. Each memory needs kind + content (one line of fact); body adds detail, tags/scope_id/source/confidence/importance add structure. Idempotent: identical content (same scope and kind) is detected by a content hash and returns the existing object instead of creating a duplicate. Before writing, nearby memories are searched and returned as conflicts[] — YOU decide whether to merge, supersede or create; the plugin never overwrites stored text or lowers confidence. Writes land as draft for human review. Pass dry_run=true to preview.',
      parameters: {
        memories: {
          type: 'array',
          required: true,
          description:
            'Memories to write (1..50). Each item: {kind, content, name?, body?, tags?, scope_id?, source_object_id?, source_channel?, confidence?, importance?, supersedes?}. kind ∈ fact|decision|preference|lesson|procedure|episode|summary|entity.',
          items: { type: 'object', additionalProperties: true },
        },
        space_id: SCOPE_PARAM,
        idempotency_key: IDEMPOTENCY_KEY_PARAM,
        dry_run: DRY_RUN_PARAM,
      },
      output: outputSpec(),
      async execute(args, exec) {
        const spaceId = await resolveSpaceId(deps, args.space_id);
        const cfg = deps.config();
        const keys = await deps.store.resolveKeys(spaceId, exec.signal);
        const hashKey = propertyKey(keys, 'contentHash');
        const kindKey = propertyKey(keys, 'kind');
        const statusKey = propertyKey(keys, 'status');
        const scopeKey = propertyKey(keys, 'scope');

        const raw = (args.memories ?? []) as Array<Record<string, unknown>>;
        if (raw.length === 0) {
          throw new Error(
            'memories is empty — provide at least one {kind, content} item.',
          );
        }

        // 归一化 + 哈希（幂等键的输入）。
        const prepared = raw.map((m) => {
          const kind = String(m.kind ?? 'fact');
          if (!isMemoryKind(kind)) {
            throw new Error(
              `kind "${kind}" is not a known memory kind. Use one of: ${MEMORY_KINDS.join(', ')}.`,
            );
          }
          const content = String(m.content ?? '').trim();
          if (content.length === 0) {
            throw new Error('content is required for every memory item.');
          }
          const scopeId = m.scope_id === undefined ? '' : String(m.scope_id);
          const scopeKeyValue = `${spaceId}#${scopeId}`;
          return {
            item: m,
            kind: kind as MemoryKind,
            content,
            scopeId,
            hash: contentHash(scopeKeyValue, kind, content),
          };
        });

        // 批量幂等查：一条 filter 覆盖整批哈希。
        const dedup = new Map<string, string>();
        const hashList = prepared.map((p) => p.hash);
        const dedupFilter = andFilter([
          inFilter(hashKey, hashList),
          inFilter(kindKey, [...new Set(prepared.map((p) => p.kind))]),
        ]);
        if (hashList.length > 0) {
          const found = await deps.store.search({
            spaceId,
            query: '',
            filter: dedupFilter,
            fields: [hashKey, kindKey, statusKey],
            limit: 100,
            signal: exec.signal,
          });
          for (const row of found.rows) {
            const h = textOf(prop(row, hashKey));
            if (h.length > 0) dedup.set(h, row.id);
          }
        }

        const written: Array<Record<string, JsonValue>> = [];
        const deduped: Array<Record<string, JsonValue>> = [];
        const conflicts: Array<Record<string, JsonValue>> = [];

        for (const p of prepared) {
          const existing = dedup.get(p.hash);
          if (existing) {
            deduped.push({
              object_id: existing,
              content_hash: p.hash,
              kind: p.kind,
              reason: 'identical content already stored in this scope',
            });
            continue;
          }

          // 写前读：同 scope 内的近邻 → 冲突候选（只上报，不裁决）。
          const neighbours = await deps.store.search({
            spaceId,
            query: p.content.slice(0, 80),
            filter: andFilter([inFilter(kindKey, [p.kind])]),
            fields: [kindKey, statusKey, scopeKey, 'name'],
            limit: 5,
            signal: exec.signal,
          });
          const candidates: ConflictRow[] = neighbours.rows
            .filter((row) => row.id !== existing)
            .map((row) => ({
              objectId: row.id,
              kind: textOf(prop(row, kindKey)) || p.kind,
              status: textOf(prop(row, statusKey)) || 'draft',
              excerpt: excerpt(textOf(prop(row, 'name'))),
            }))
            .filter(
              (c) => c.status !== 'archived' && c.status !== 'superseded',
            );

          const receipt = await deps.store.createMemory(
            spaceId,
            {
              kind: p.kind,
              name: String(p.item.name ?? p.content).slice(0, 200),
              body: p.item.body === undefined ? undefined : String(p.item.body),
              tags: Array.isArray(p.item.tags)
                ? (p.item.tags as unknown[]).map((t) => String(t))
                : undefined,
              scopeId: p.scopeId.length > 0 ? p.scopeId : undefined,
              sourceId:
                p.item.source_object_id === undefined
                  ? undefined
                  : String(p.item.source_object_id),
              sourceChannel:
                p.item.source_channel === undefined
                  ? undefined
                  : String(p.item.source_channel),
              confidence: numberOf(p.item.confidence),
              importance: numberOf(p.item.importance),
              status: cfg.defaultStatus,
              contentHash: p.hash,
              idempotencyKey: args.idempotency_key as string | undefined,
              supersedes: Array.isArray(p.item.supersedes)
                ? (p.item.supersedes as unknown[]).map((s) => String(s))
                : undefined,
            },
            args.dry_run === true,
            exec.signal,
          );

          written.push({
            object_id: receipt.objectId,
            created: receipt.created,
            content_hash: p.hash,
            kind: p.kind,
            status: cfg.defaultStatus,
          });
          for (const c of candidates) {
            conflicts.push({
              object_id: c.objectId,
              kind: c.kind,
              status: c.status,
              excerpt: c.excerpt,
              against: receipt.objectId,
              action: 'decide: merge / supersede / keep both',
            });
          }
        }

        return {
          written,
          deduped,
          conflicts,
          warnings:
            written.length === 0 && deduped.length > 0
              ? [
                  'every memory in this batch already existed — nothing was written',
                ]
              : [],
        };
      },
    }),

    defineTool({
      name: 'memory_update',
      description:
        'Edit one memory object as an ordered list of Anytype edit ops (set_properties / replace_text / insert_blocks / delete_block / ...). Pass expected_etag from a prior read to fail instead of overwriting concurrent edits, or if_content_hash to assert the stored content hash still matches. Updates never change the stored text silently — the ops are explicit.',
      parameters: {
        object_id: {
          type: 'string',
          required: true,
          description: 'Memory object id.',
        },
        ops: {
          type: 'array',
          required: true,
          description:
            'Ordered Anytype edit ops, e.g. [{"op":"set_properties","set":{"confidence":[8]}}]. Fetch the op schema with anytype_get_op_schema if unsure.',
          items: { type: 'object', additionalProperties: true },
        },
        expected_etag: {
          type: 'string',
          description:
            'ETag from a prior read; sent as If-Match so a concurrent edit fails instead of being overwritten.',
        },
        if_content_hash: {
          type: 'string',
          description:
            'Assert the stored content hash still equals this value before applying the ops (read-before-write guard).',
        },
        space_id: SCOPE_PARAM,
        dry_run: DRY_RUN_PARAM,
      },
      output: outputSpec(),
      async execute(args, exec) {
        const spaceId = await resolveSpaceId(deps, args.space_id);
        const objectId = String(args.object_id);
        let etag = args.expected_etag as string | undefined;

        if (args.if_content_hash !== undefined) {
          const { doc, etag: current } = await deps.store.getObjectWithEtag(
            spaceId,
            objectId,
            exec.signal,
          );
          const keys = await deps.store.resolveKeys(spaceId, exec.signal);
          const hashKey = propertyKey(keys, 'contentHash');
          const properties = (doc.properties ?? {}) as Record<string, unknown>;
          const actual = textOf(properties[hashKey]);
          if (actual !== String(args.if_content_hash)) {
            throw new Error(
              `content hash mismatch: the stored memory now has hash "${actual}" (expected "${String(args.if_content_hash)}"). Read it with memory_get and decide again.`,
            );
          }
          etag = etag ?? current;
        }

        const ops = (args.ops ?? []) as Array<Record<string, unknown>>;
        if (ops.length === 0) {
          throw new Error(
            'ops is empty — provide at least one edit operation.',
          );
        }
        await deps.store.patchObject(
          spaceId,
          objectId,
          ops,
          etag,
          args.dry_run === true,
          exec.signal,
        );
        return { object_id: objectId, updated: true, ops: ops.length };
      },
    }),

    defineTool({
      name: 'memory_link',
      description:
        'Link two memories with a controlled edge: relates_to | derived_from | contradicts | supersedes | mentions. Free-form links are not supported — the edge vocabulary is fixed so the memory graph stays machine-readable. The target must be a memory object (validated here, because API v2 relations cannot declare a target type).',
      parameters: {
        from_id: {
          type: 'string',
          required: true,
          description: 'Source memory object id.',
        },
        to_id: {
          type: 'string',
          required: true,
          description: 'Target memory object id.',
        },
        rel: {
          type: 'string',
          required: true,
          enum: [...EDGE_RELATIONS],
          description: 'Controlled edge type.',
        },
        space_id: SCOPE_PARAM,
        expected_etag: {
          type: 'string',
          description: 'ETag from a prior read; sent as If-Match.',
        },
        idempotency_key: IDEMPOTENCY_KEY_PARAM,
        dry_run: DRY_RUN_PARAM,
      },
      output: outputSpec(),
      async execute(args, exec) {
        const spaceId = await resolveSpaceId(deps, args.space_id);
        const rel = String(args.rel) as EdgeRelation;
        if (!(EDGE_RELATIONS as readonly string[]).includes(rel)) {
          throw new Error(
            `rel "${rel}" is not a controlled edge. Use one of: ${EDGE_RELATIONS.join(', ')}.`,
          );
        }
        const targetId = String(args.to_id);
        const target = await deps.store.getObject(
          spaceId,
          targetId,
          exec.signal,
        );
        const targetType = String(target.type ?? '');
        if (targetType !== 'memory') {
          throw new Error(
            `link target "${targetId}" is of type "${targetType}", not "memory" — edges may only connect memories.`,
          );
        }
        await deps.store.addEdge(
          spaceId,
          String(args.from_id),
          rel,
          [targetId],
          args.expected_etag as string | undefined,
          args.dry_run === true,
          exec.signal,
        );
        return {
          ok: true,
          rel,
          from_id: String(args.from_id),
          to_id: targetId,
        };
      },
    }),

    defineTool({
      name: 'memory_supersede',
      description:
        'Invalidate an old memory when a newer one replaces it: set the old object status=superseded, stamp valid_to, and add the supersedes edge from the new memory to the old one. Refuses to invalidate a memory whose origin=user (human-authored) — report that conflict to the user instead. Never deletes anything.',
      parameters: {
        old_id: {
          type: 'string',
          required: true,
          description: 'Memory being superseded.',
        },
        new_id: {
          type: 'string',
          required: true,
          description: 'Memory that supersedes it.',
        },
        valid_to: {
          type: 'string',
          description:
            'When the old fact stopped being true (ISO 8601). Default: now.',
        },
        space_id: SCOPE_PARAM,
        dry_run: DRY_RUN_PARAM,
      },
      output: outputSpec(),
      async execute(args, exec) {
        const spaceId = await resolveSpaceId(deps, args.space_id);
        const oldId = String(args.old_id);
        const newId = String(args.new_id);
        const { doc, etag } = await deps.store.getObjectWithEtag(
          spaceId,
          oldId,
          exec.signal,
        );
        const keys = await deps.store.resolveKeys(spaceId, exec.signal);
        const originKey = propertyKey(keys, 'origin');
        const properties = (doc.properties ?? {}) as Record<string, unknown>;
        const origin = textOf(properties[originKey]);
        if (origin === 'user') {
          throw new Error(
            `memory "${oldId}" was written by a human (origin=user) — the plugin will not invalidate it automatically. Report the contradiction to the user, or let them decide in Anytype.`,
          );
        }
        const validTo =
          (args.valid_to as string | undefined) ?? new Date().toISOString();
        const validToKey = propertyKey(keys, 'validTo');
        const statusKey = propertyKey(keys, 'status');
        // 一次原子 op 同时写 valid_to 与 status——分两次写会各自消耗一次
        // etag，第二次必然 409（活体实测）。
        await deps.store.setProperties(
          spaceId,
          oldId,
          { [validToKey]: validTo, [statusKey]: ['superseded'] },
          etag,
          args.dry_run === true,
          exec.signal,
        );
        await deps.store.addEdge(
          spaceId,
          newId,
          'supersedes',
          [oldId],
          undefined,
          args.dry_run === true,
          exec.signal,
        );
        return {
          old_id: oldId,
          new_id: newId,
          old_status: 'superseded',
          valid_to: validTo,
        };
      },
    }),

    defineTool({
      name: 'memory_archive',
      description:
        'Archive a memory (status=archived). The object is kept — Anytype DELETE is limited to objects created by the same API key and is irreversible, so archiving is the safe forget operation. Archived memories are filtered out of recall by default.',
      parameters: {
        object_id: {
          type: 'string',
          required: true,
          description: 'Memory object id.',
        },
        reason: {
          type: 'string',
          description:
            'Why it is archived (returned to you; not written into the memory body).',
        },
        expected_etag: {
          type: 'string',
          description: 'ETag from a prior read; sent as If-Match.',
        },
        space_id: SCOPE_PARAM,
        dry_run: DRY_RUN_PARAM,
      },
      output: outputSpec(),
      async execute(args, exec) {
        const spaceId = await resolveSpaceId(deps, args.space_id);
        const objectId = String(args.object_id);
        await deps.store.setStatus(
          spaceId,
          objectId,
          'archived',
          args.expected_etag as string | undefined,
          args.dry_run === true,
          exec.signal,
        );
        return {
          object_id: objectId,
          status: 'archived',
          reason: args.reason ?? null,
        };
      },
    }),

    defineTool({
      name: 'memory_review',
      description:
        'Record a human review decision on memories: approve (status=approved), reject (status=archived), dispute (status=disputed). Use it only when the user explicitly asked for it — it records reviewed_by/reviewed_at so the decision is auditable. Draft memories stay visible in recall but are not treated as settled.',
      parameters: {
        object_ids: {
          type: 'array',
          required: true,
          description: 'Memory object ids to review.',
          items: { type: 'string' },
        },
        decision: {
          type: 'string',
          required: true,
          enum: ['approve', 'reject', 'dispute'],
          description: 'Review outcome.',
        },
        note: {
          type: 'string',
          description:
            'Review note (returned to you; not written into the memory body).',
        },
        actor: {
          type: 'string',
          description: 'Who made the decision (default: "user").',
        },
        space_id: SCOPE_PARAM,
        dry_run: DRY_RUN_PARAM,
      },
      output: outputSpec(),
      async execute(args, exec) {
        const spaceId = await resolveSpaceId(deps, args.space_id);
        const decision = String(args.decision);
        const target =
          decision === 'approve'
            ? 'approved'
            : decision === 'reject'
              ? 'archived'
              : 'disputed';
        const ids = (args.object_ids ?? []).map((id) => String(id));
        if (ids.length === 0) {
          throw new Error('object_ids is empty — provide at least one id.');
        }
        const keys = await deps.store.resolveKeys(spaceId, exec.signal);
        const reviewedByKey = propertyKey(keys, 'reviewedBy');
        const reviewedAtKey = propertyKey(keys, 'reviewedAt');
        const actor = String(args.actor ?? 'user');
        const reviewedAt = new Date().toISOString();

        const updated: string[] = [];
        for (const id of ids) {
          await deps.store.setStatus(
            spaceId,
            id,
            target,
            undefined,
            args.dry_run === true,
            exec.signal,
          );
          await deps.store.setProperties(
            spaceId,
            id,
            {
              [reviewedByKey]: actor,
              [reviewedAtKey]: reviewedAt,
            },
            undefined,
            args.dry_run === true,
            exec.signal,
          );
          updated.push(id);
        }
        return {
          updated,
          status: target,
          reviewed_by: actor,
          reviewed_at: reviewedAt,
          note: args.note ?? null,
        };
      },
    }),
  ];
}

/** 记忆状态词表（导出给读组做参数校验）。 */
export const WRITE_STATUSES = MEMORY_STATUSES;
