/**
 * review 组：wiki_review——待审列表 + 裁决写回。
 *
 * 两种形态：
 * - 不带 `object_ids` → 列出待审笔记（draft 态），供人（或 AI 代人拉清单）
 *   决定裁决对象；
 * - 带 `object_ids` + `decision` → 逐个写回 `wiki_status` + 审计字段
 *   （reviewed_by / reviewed_at）。approve→approved、reject/archive→archived
 *   （Anytype 删除即归档，无独立 tombstone；区别记录在审计字段）。
 *
 * **并发保护**：写入带 If-Match。调用方可传 `expected_etags`（id→etag，
 * 通常来自 wiki_get）；缺省时存储层读回当前 etag 再写。并发冲突（409）
 * 单条报告、不中断其余条目。
 */

import { DRY_RUN_PARAM } from '../../core/index.ts';
import type { JsonValue } from '../../core/index.ts';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { REVIEW_DECISION_TO_STATUS } from '../schema.ts';
import {
  inFilter,
  isReviewDecision,
  outputSpec,
  propertyKey,
  resolveSpaceId,
  textOf,
  type WikiToolDeps,
} from './shared.ts';

/** 构建 review 组工具。 */
export function buildReviewTools(deps: WikiToolDeps) {
  return [
    defineTool({
      name: 'wiki_review',
      description:
        'Review queue for the AI-written wiki: without object_ids, list notes awaiting review (status=draft); with object_ids and a decision, adjudicate them — approve → approved, reject/archive → archived (audit fields reviewed_by/reviewed_at are stamped). Pass expected_etags (object id → etag, e.g. from wiki_get) for optimistic concurrency; a concurrent-modification conflict is reported per note without failing the rest. Human decision, executed by the AI — never adjudicate on your own initiative.',
      parameters: {
        decision: {
          type: 'string',
          enum: ['approve', 'reject', 'archive'],
          description:
            'Adjudication to apply to object_ids. Required when object_ids is given; omit to just list the queue.',
        },
        object_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Note object ids to adjudicate. Omit (or empty) to list pending notes instead.',
        },
        expected_etags: {
          type: 'object',
          additionalProperties: true,
          description:
            'Optimistic-lock map: object id → etag from wiki_get. Notes missing from the map are written with a freshly read etag.',
        },
        actor: {
          type: 'string',
          description:
            'Who made the decision (stamped into reviewed_by). Default "user".',
        },
        limit: {
          type: 'number',
          description: 'Queue listing page size (default 20, max 100).',
        },
        offset: {
          type: 'number',
          description: 'Queue listing offset.',
        },
        dry_run: DRY_RUN_PARAM,
        space_id: {
          type: 'string',
          description:
            'Anytype space id. Omit to use the configured wiki space.',
        },
      },
      output: outputSpec(),
      async execute(args, exec): Promise<Record<string, JsonValue>> {
        const spaceId = await resolveSpaceId(deps, String(args.space_id ?? ''));
        const dryRun = args.dry_run === true;
        const objectIds = Array.isArray(args.object_ids)
          ? args.object_ids.map((v) => String(v)).filter((v) => v.length > 0)
          : [];

        // ── 形态一：待审列表 ────────────────────────────────────────
        if (objectIds.length === 0) {
          const keys = await deps.store.resolveKeys(spaceId, exec?.signal);
          const statusKey = propertyKey(keys, 'status');
          const limit = Math.min(
            Math.max(Number(args.limit ?? 20) || 20, 1),
            100,
          );
          const offset = Math.max(Number(args.offset ?? 0) || 0, 0);
          const result = await deps.store.search({
            spaceId,
            query: '',
            filter: inFilter(statusKey, ['draft']),
            fields: [
              statusKey,
              propertyKey(keys, 'source'),
              propertyKey(keys, 'createdAt'),
              propertyKey(keys, 'updatedAt'),
            ],
            sorts: [
              { property: propertyKey(keys, 'updatedAt'), direction: 'desc' },
            ],
            limit,
            offset,
            signal: exec?.signal,
          });
          const pending: Array<Record<string, JsonValue>> = result.rows.map(
            (row) => ({
              object_id: row.id,
              name: row.name,
              status: textOf(row.properties?.[statusKey]) || 'draft',
              source: textOf(row.properties?.[propertyKey(keys, 'source')]),
              created_at: textOf(
                row.properties?.[propertyKey(keys, 'createdAt')],
              ),
              updated_at: textOf(
                row.properties?.[propertyKey(keys, 'updatedAt')],
              ),
            }),
          );
          return {
            action: 'listed',
            space_id: spaceId,
            total: (result.total ?? null) as JsonValue,
            has_more: (result.hasMore ?? null) as JsonValue,
            offset,
            limit,
            pending: pending as JsonValue,
          };
        }

        // ── 形态二：裁决写回 ────────────────────────────────────────
        if (!isReviewDecision(args.decision)) {
          throw new Error(
            `wiki_review: decision must be one of approve | reject | archive when object_ids is given (got ${JSON.stringify(args.decision)}).`,
          );
        }
        const decision = args.decision;
        const status = REVIEW_DECISION_TO_STATUS[decision];
        const actor =
          String(args.actor ?? '').trim().length > 0
            ? String(args.actor).trim()
            : 'user';
        const reviewedAt = new Date().toISOString();
        const etagMap =
          args.expected_etags !== null &&
          typeof args.expected_etags === 'object'
            ? (args.expected_etags as Record<string, unknown>)
            : {};

        const results: Array<Record<string, JsonValue>> = [];
        let approved = 0;
        let failed = 0;
        for (const objectId of objectIds) {
          const raw = etagMap[objectId];
          const expectedEtag =
            typeof raw === 'string' && raw.length > 0 ? raw : undefined;
          try {
            await deps.store.reviewNote(
              spaceId,
              objectId,
              { status, reviewedBy: actor, reviewedAt, expectedEtag },
              dryRun,
              exec?.signal,
            );
            results.push({ object_id: objectId, ok: true, status });
            approved += 1;
          } catch (err) {
            results.push({
              object_id: objectId,
              ok: false,
              error: (err as Error).message,
            });
            failed += 1;
          }
        }
        return {
          action: 'reviewed',
          space_id: spaceId,
          decision,
          status,
          reviewed_by: actor,
          reviewed_at: reviewedAt,
          applied: approved,
          failed,
          results: results as JsonValue,
        };
      },
    }),
  ];
}
