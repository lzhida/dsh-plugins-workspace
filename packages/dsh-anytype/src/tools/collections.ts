/**
 * 集合组：anytype_create_collection / anytype_list_collection_objects。
 *
 * 集合（collection）是有序对象列表；创建后条目的增删走
 * `anytype_update_object` 的 `add_items` / `remove_items` op。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { enc, outputSpec, runRequest, type ToolDeps } from './shared.ts';

/** 构建集合组工具。 */
export function buildCollectionTools(deps: ToolDeps) {
  return [
    defineTool({
      name: 'anytype_create_collection',
      description:
        'Create a collection (ordered object list) in a space, optionally seeding it with member object ids. Add/remove members later via anytype_update_object with add_items/remove_items ops.',
      parameters: {
        space_id: {
          type: 'string',
          required: true,
          description: 'Target space id.',
        },
        name: {
          type: 'string',
          required: true,
          description: 'Collection name.',
        },
        items: {
          type: 'array',
          items: { type: 'string' },
          description: 'Initial member object ids (max 1000).',
        },
      },
      output: outputSpec(),
      async execute(args, exec) {
        const body: Record<string, unknown> = { name: args.name };
        if (args.items !== undefined) body.items = args.items;
        return runRequest(
          deps,
          exec,
          'POST',
          `/v2/spaces/${enc(args.space_id)}/collections`,
          { body },
        );
      },
    }),
    defineTool({
      name: 'anytype_list_collection_objects',
      description:
        'List the objects inside a collection with pagination, optionally through a named view.',
      parameters: {
        space_id: { type: 'string', required: true, description: 'Space id.' },
        collection_id: {
          type: 'string',
          required: true,
          description: 'Collection id.',
        },
        view: {
          type: 'string',
          description: 'Optional view id to read through.',
        },
        fields: {
          type: 'string',
          description:
            'Optional comma-separated field list to trim the response.',
        },
        limit: {
          type: 'integer',
          description: 'Page size (API default 25, max 1000).',
        },
        offset: {
          type: 'integer',
          description: 'Pagination offset (API default 0).',
        },
      },
      output: outputSpec(),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return runRequest(
          deps,
          exec,
          'GET',
          `/v2/spaces/${enc(args.space_id)}/collections/${enc(args.collection_id)}/objects`,
          {
            query: {
              view: args.view,
              fields: args.fields,
              limit: args.limit,
              offset: args.offset,
            },
          },
        );
      },
    }),
  ];
}
