/**
 * write 组：wiki_write——按标题查重，创建或更新一篇笔记。
 *
 * **查重键 = 标题**：先结构性过滤 `name = "<标题>"`（单等号，写后立即可
 * 查），命中即更新已有页，绝不产生重复页。新建一律 `draft` 态；更新带
 * 正文时状态重置回 `draft`（内容变了需人工重审）。`wiki_source` 承担溯源。
 */

import { DRY_RUN_PARAM, IDEMPOTENCY_KEY_PARAM } from '../../core/index.ts';
import type { JsonValue } from '../../core/index.ts';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { resolveSpaceId, outputSpec, type WikiToolDeps } from './shared.ts';

/** 构建 write 组工具。 */
export function buildWriteTools(deps: WikiToolDeps) {
  return [
    defineTool({
      name: 'wiki_write',
      description:
        'Create a wiki note, or update the existing note with the same title (title is the dedup key — no duplicate pages are ever created). New notes start in the "draft" status awaiting human review; updating the body of an existing note resets it back to "draft" for re-review. Always fill source with where the content came from (conversation, webpage, file...). Notes are NOT memory: nothing is auto-recalled into context — the human reads and reviews them in Anytype.',
      parameters: {
        title: {
          type: 'string',
          description:
            'Note title. Unique per wiki space; reuse an existing title to update that note.',
          required: true,
        },
        body: {
          type: 'string',
          description:
            'Markdown body. On create it becomes the note content; on update it REPLACES the whole body (and resets the note to draft for re-review). Omit to update metadata only.',
        },
        source: {
          type: 'string',
          description:
            'Provenance: where this content came from (e.g. "conversation 2026-10-30: user asked to summarize X", "https://example.com/post").',
          required: true,
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Topic tags (Anytype tag property, new options are created on demand).',
        },
        expected_etag: {
          type: 'string',
          description:
            'Optimistic-lock etag from a previous wiki_get of the same note (If-Match). Omit to let the plugin read it.',
        },
        idempotency_key: IDEMPOTENCY_KEY_PARAM,
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
        const title = String(args.title ?? '').trim();
        const body = args.body === undefined ? undefined : String(args.body);
        const source = String(args.source ?? '').trim();
        const tags = Array.isArray(args.tags)
          ? args.tags.map((t) => String(t)).filter((t) => t.length > 0)
          : undefined;
        const expectedEtag =
          typeof args.expected_etag === 'string' &&
          args.expected_etag.length > 0
            ? args.expected_etag
            : undefined;
        const idempotencyKey =
          typeof args.idempotency_key === 'string' &&
          args.idempotency_key.length > 0
            ? args.idempotency_key
            : undefined;
        const dryRun = args.dry_run === true;

        const existing = await deps.store.findByTitle(
          spaceId,
          title,
          exec?.signal,
        );

        if (existing.length === 0) {
          const receipt = await deps.store.createNote(
            spaceId,
            { title, body, source, tags, status: 'draft', idempotencyKey },
            dryRun,
            exec?.signal,
          );
          return {
            object_id: receipt.objectId,
            created: true,
            title,
            status: 'draft',
            note: 'new note — starts in draft, awaiting human review',
            warnings: [] as JsonValue,
          };
        }

        const objectId = existing[0].id;
        const warnings: string[] = [];
        if (existing.length > 1) {
          warnings.push(
            `found ${existing.length} notes titled "${title}"; updated the first (${objectId}) — dedupe the rest manually or via wiki_review archive.`,
          );
        }
        const receipt = await deps.store.updateNote(
          spaceId,
          objectId,
          {
            body,
            source: source.length > 0 ? source : undefined,
            tags,
            expectedEtag,
          },
          dryRun,
          exec?.signal,
        );
        return {
          object_id: objectId,
          created: false,
          title,
          status: (receipt.statusResetToDraft ? 'draft' : null) as JsonValue,
          status_reset_to_draft: receipt.statusResetToDraft,
          wrote: receipt.wrote,
          note: receipt.statusResetToDraft
            ? 'body replaced — status reset to draft for re-review'
            : 'metadata updated — review status preserved',
          warnings: warnings as JsonValue,
        };
      },
    }),
  ];
}
