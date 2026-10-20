/**
 * 搜索组：anytype_search（全局/空间二合一）+ anytype_list_objects。
 *
 * - `POST /v2/search`（全局）与 `POST /v2/spaces/{space_id}/search`（空间内）
 *   共享同一个 SearchRequestDoc 请求体——一个工具按是否传 `space_id` 二合一，
 *   少一个面板条目；
 * - `GET /v2/spaces/{space_id}/objects` —— 按分页直接列对象（不涉全文检索）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { enc, outputSpec, runRequest, type ToolDeps } from './shared.ts';

/** 构建搜索组工具。 */
export function buildSearchTools(deps: ToolDeps) {
  return [
    defineTool({
      name: 'anytype_search',
      description:
        'Full-text search over object names and indexed content across all spaces, or inside one space when space_id is given. Returns matching objects with id/name/space — use ids with anytype_get_object for full content.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'Full-text query.',
        },
        space_id: {
          type: 'string',
          description:
            'Restrict the search to this space; omit to search all granted spaces.',
        },
        type: {
          type: 'string',
          description: 'Optional type key filter (e.g. page, task).',
        },
        limit: {
          type: 'integer',
          description: 'Page size (API default 25, max 1000).',
        },
        offset: {
          type: 'integer',
          description: 'Pagination offset (API default 0).',
        },
        sorts: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description:
            'Optional sort clauses; schema from anytype_get_schema (kind search_request).',
        },
        filters: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description:
            'Optional property filters; schema from anytype_get_schema (kind search_request).',
        },
      },
      output: outputSpec(),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const body: Record<string, unknown> = { query: args.query };
        if (args.type !== undefined) body.type = args.type;
        if (args.sorts !== undefined) body.sorts = args.sorts;
        if (args.filters !== undefined) body.filters = args.filters;
        const path =
          args.space_id === undefined
            ? '/v2/search'
            : `/v2/spaces/${enc(args.space_id)}/search`;
        return runRequest(deps, exec, 'POST', path, {
          body,
          query: { limit: args.limit, offset: args.offset },
        });
      },
    }),
    defineTool({
      name: 'anytype_list_objects',
      description:
        'List objects in one space with pagination (no full-text matching). Prefer anytype_search to find objects by content.',
      parameters: {
        space_id: {
          type: 'string',
          required: true,
          description: 'Target space id.',
        },
        limit: {
          type: 'integer',
          description: 'Page size (API default 25, max 1000).',
        },
        offset: {
          type: 'integer',
          description: 'Pagination offset (API default 0).',
        },
        fields: {
          type: 'string',
          description:
            'Optional comma-separated field list to trim the response (e.g. "id,name,snippet").',
        },
      },
      output: outputSpec(),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return runRequest(
          deps,
          exec,
          'GET',
          `/v2/spaces/${enc(args.space_id)}/objects`,
          {
            query: {
              limit: args.limit,
              offset: args.offset,
              fields: args.fields,
            },
          },
        );
      },
    }),
  ];
}
