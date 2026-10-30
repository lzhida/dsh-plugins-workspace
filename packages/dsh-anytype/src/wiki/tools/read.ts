/**
 * read 组：wiki_get / wiki_list——只读查看。
 *
 * 用途：AI 续写前的参考（读全文/读清单）与人类核对（状态/溯源/审计字段）。
 * **不做自动召回、不注入上下文**——只有 AI 明确调用才读，与记忆系统划清
 * 界限。两个工具都不写任何数据。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import type { JsonValue } from '../../core/index.ts';

import {
  isWikiStatus,
  listOf,
  outputSpec,
  propertyKey,
  resolveSpaceId,
  textOf,
  type WikiToolDeps,
} from './shared.ts';

/** 构建 read 组工具（wiki_get / wiki_list，全部只读）。 */
export function buildReadTools(deps: WikiToolDeps) {
  return [
    defineTool({
      name: 'wiki_get',
      isConcurrencySafe: () => true,
      description:
        'Read one wiki note in full: markdown body plus review metadata (status / source / created / updated / reviewed_by / reviewed_at) and the current etag (pass it as expected_etag to wiki_write or wiki_review for optimistic locking). Read-only.',
      parameters: {
        object_id: {
          type: 'string',
          description: 'Note object id (from wiki_list / wiki_write output).',
          required: true,
        },
        space_id: {
          type: 'string',
          description:
            'Anytype space id. Omit to use the configured wiki space.',
        },
      },
      output: outputSpec(),
      async execute(args, exec): Promise<Record<string, JsonValue>> {
        const spaceId = await resolveSpaceId(deps, String(args.space_id ?? ''));
        const objectId = String(args.object_id ?? '').trim();
        const { doc, etag } = await deps.store.getNoteWithEtag(
          spaceId,
          objectId,
          exec?.signal,
        );
        const mdDoc = (await deps.store.getNote(
          spaceId,
          objectId,
          exec?.signal,
          'md',
        )) as { markdown?: string };
        const properties = (doc.properties ?? {}) as Record<string, unknown>;
        const keys = await deps.store.resolveKeys(spaceId, exec?.signal);
        const status = textOf(properties[propertyKey(keys, 'status')]);
        return {
          object_id: objectId,
          etag: (etag ?? null) as JsonValue,
          name: textOf(properties.name),
          status: (status.length > 0 ? status : null) as JsonValue,
          source: textOf(properties[propertyKey(keys, 'source')]),
          created_at: textOf(properties[propertyKey(keys, 'createdAt')]),
          updated_at: textOf(properties[propertyKey(keys, 'updatedAt')]),
          reviewed_by: textOf(properties[propertyKey(keys, 'reviewedBy')]),
          reviewed_at: textOf(properties[propertyKey(keys, 'reviewedAt')]),
          tags: listOf(properties[propertyKey(keys, 'tag')]) as JsonValue,
          markdown: (mdDoc.markdown ?? '') as JsonValue,
        };
      },
    }),
    defineTool({
      name: 'wiki_list',
      isConcurrencySafe: () => true,
      description:
        'List wiki notes (read-only) with their review metadata — browse what exists before writing, or take stock of the library. Defaults to draft + approved (archived hidden); pass statuses to override. Sorted by last update, newest first.',
      parameters: {
        statuses: {
          type: 'array',
          items: { type: 'string', enum: ['draft', 'approved', 'archived'] },
          description:
            'Filter by review status. Default: ["draft", "approved"].',
        },
        query: {
          type: 'string',
          description:
            'Optional full-text search term (server-side, best-effort).',
        },
        limit: {
          type: 'number',
          description: 'Page size (default 20, max 100).',
        },
        offset: {
          type: 'number',
          description: 'Page offset.',
        },
        space_id: {
          type: 'string',
          description:
            'Anytype space id. Omit to use the configured wiki space.',
        },
      },
      output: outputSpec(),
      async execute(args, exec): Promise<Record<string, JsonValue>> {
        const spaceId = await resolveSpaceId(deps, String(args.space_id ?? ''));
        const keys = await deps.store.resolveKeys(spaceId, exec?.signal);
        const statusKey = propertyKey(keys, 'status');
        const rawStatuses = Array.isArray(args.statuses)
          ? args.statuses.map((s) => String(s))
          : undefined;
        const statuses =
          rawStatuses !== undefined && rawStatuses.length > 0
            ? rawStatuses.filter(
                (s, i, arr) => isWikiStatus(s) && arr.indexOf(s) === i,
              )
            : ['draft', 'approved'];
        const limit = Math.min(
          Math.max(Number(args.limit ?? 20) || 20, 1),
          100,
        );
        const offset = Math.max(Number(args.offset ?? 0) || 0, 0);
        const query = String(args.query ?? '').trim();

        const parts: string[] = [];
        if (statuses.length > 0) {
          const list = statuses.map((s) => `"${s}"`).join(', ');
          parts.push(`${statusKey} IN (${list})`);
        }
        const result = await deps.store.search({
          spaceId,
          query,
          filter: parts.length > 0 ? parts.join(' AND ') : undefined,
          fields: [
            statusKey,
            propertyKey(keys, 'source'),
            propertyKey(keys, 'createdAt'),
            propertyKey(keys, 'updatedAt'),
            propertyKey(keys, 'tag'),
          ],
          sorts: [
            { property: propertyKey(keys, 'updatedAt'), direction: 'desc' },
          ],
          limit,
          offset,
          signal: exec?.signal,
        });
        const items: Array<Record<string, JsonValue>> = result.rows.map(
          (row) => {
            const status = textOf(row.properties?.[statusKey]);
            return {
              object_id: row.id,
              name: row.name,
              status: (status.length > 0 ? status : null) as JsonValue,
              source: textOf(row.properties?.[propertyKey(keys, 'source')]),
              created_at: textOf(
                row.properties?.[propertyKey(keys, 'createdAt')],
              ),
              updated_at: textOf(
                row.properties?.[propertyKey(keys, 'updatedAt')],
              ),
              tags: listOf(
                row.properties?.[propertyKey(keys, 'tag')],
              ) as JsonValue,
            };
          },
        );
        return {
          space_id: spaceId,
          total: (result.total ?? null) as JsonValue,
          has_more: (result.hasMore ?? null) as JsonValue,
          offset,
          limit,
          items: items as JsonValue,
        };
      },
    }),
  ];
}
