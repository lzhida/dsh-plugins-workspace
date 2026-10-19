/**
 * 类型与模板组：anytype_list_types / anytype_get_type / anytype_create_type /
 * anytype_update_type / anytype_delete_type / anytype_list_templates。
 *
 * - create/update 暴露扁平字段的常用子集（icon 走 anytype_request 逃生舱）；
 * - update 支持两种互斥形态：扁平字段（整体替换 property_definitions 语义见
 *   API 描述）或 ops 信封（add_property 等，op schema 走 anytype_get_op_schema）；
 * - create 的完整请求体（含 AnyBlock document 形态）同样可经 anytype_request。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import {
  enc,
  outputSpec,
  pickPatchBody,
  runRequest,
  type ToolDeps,
} from './shared.ts';

/** 构建类型与模板组工具。 */
export function buildTypeTools(deps: ToolDeps) {
  return [
    defineTool({
      name: 'anytype_list_types',
      description:
        'List object types defined in a space (type key, name, layout, properties). The type key is what anytype_create_object expects.',
      parameters: {
        space_id: { type: 'string', required: true, description: 'Space id.' },
        limit: { type: 'integer', description: 'Page size (API default 25).' },
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
          `/v2/spaces/${enc(args.space_id)}/types`,
          {
            query: { limit: args.limit, offset: args.offset },
          },
        );
      },
    }),
    defineTool({
      name: 'anytype_get_type',
      description:
        'Read one object type by key (or id): full property definitions and layout.',
      parameters: {
        space_id: { type: 'string', required: true, description: 'Space id.' },
        type: {
          type: 'string',
          required: true,
          description: 'Type key (e.g. page) or id.',
        },
      },
      output: outputSpec(),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return runRequest(
          deps,
          exec,
          'GET',
          `/v2/spaces/${enc(args.space_id)}/types/${enc(args.type)}`,
        );
      },
    }),
    defineTool({
      name: 'anytype_create_type',
      description:
        'Create an object type in a space. name is required; api_key derives from it when omitted ([a-zA-Z0-9_]). property_definitions lists the field set — unknown names mint properties (create_missing_options=true adds missing select options).',
      parameters: {
        space_id: {
          type: 'string',
          required: true,
          description: 'Target space id.',
        },
        name: {
          type: 'string',
          required: true,
          description: 'Singular display name.',
        },
        api_key: {
          type: 'string',
          description:
            'Explicit type key ([a-zA-Z0-9_]); derived from name when omitted.',
        },
        plural_name: { type: 'string', description: 'Plural display name.' },
        layout: {
          type: 'string',
          enum: [
            'basic',
            'note',
            'todo',
            'profile',
            'bookmark',
            'set',
            'collection',
          ],
          description: 'Layout for instances (API default basic).',
        },
        default_view: {
          type: 'string',
          enum: ['table', 'list', 'gallery', 'kanban', 'calendar', 'graph'],
          description: 'How sets/collections of this type open.',
        },
        default_template: {
          type: 'string',
          description:
            'Template id new objects start from (empty string clears).',
        },
        property_definitions: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description:
            "The type's whole field list; see anytype_get_schema (kind type) for item shape.",
        },
        create_missing_options: {
          type: 'boolean',
          description:
            'true = create missing select/multi_select options instead of refusing.',
        },
      },
      output: outputSpec(),
      async execute(args, exec) {
        const body: Record<string, unknown> = { name: args.name };
        if (args.api_key !== undefined) body.api_key = args.api_key;
        if (args.plural_name !== undefined) body.plural_name = args.plural_name;
        if (args.layout !== undefined) body.layout = args.layout;
        if (args.default_view !== undefined)
          body.default_view = args.default_view;
        if (args.default_template !== undefined) {
          body.default_template = args.default_template;
        }
        if (args.property_definitions !== undefined) {
          body.property_definitions = args.property_definitions;
        }
        return runRequest(
          deps,
          exec,
          'POST',
          `/v2/spaces/${enc(args.space_id)}/types`,
          {
            body,
            query: { create_missing_options: args.create_missing_options },
          },
        );
      },
    }),
    defineTool({
      name: 'anytype_update_type',
      description:
        'Update an object type. EITHER send flat fields (name renames; property_definitions REPLACES the whole field list) OR send ops for incremental property/view edits (op schemas via anytype_get_op_schema) — the two forms are mutually exclusive.',
      parameters: {
        space_id: { type: 'string', required: true, description: 'Space id.' },
        type: {
          type: 'string',
          required: true,
          description: 'Type key (or id).',
        },
        name: { type: 'string', description: 'New display name.' },
        plural_name: { type: 'string', description: 'New plural name.' },
        layout: {
          type: 'string',
          enum: [
            'basic',
            'note',
            'todo',
            'profile',
            'bookmark',
            'set',
            'collection',
          ],
          description: 'New layout.',
        },
        default_view: {
          type: 'string',
          enum: ['table', 'list', 'gallery', 'kanban', 'calendar', 'graph'],
          description: 'New default view.',
        },
        default_template: {
          type: 'string',
          description: 'New default template id (empty string clears).',
        },
        property_definitions: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description:
            'REPLACES the whole field list — to change one field use ops instead.',
        },
        ops: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description:
            'Ops envelope (e.g. add_property); mutually exclusive with flat fields.',
        },
        expected_etag: {
          type: 'string',
          description: 'ETag from a previous read; sent as If-Match.',
        },
        create_missing_options: {
          type: 'boolean',
          description:
            'true = create missing select options instead of refusing.',
        },
      },
      output: outputSpec(),
      async execute(args, exec) {
        const flat: Record<string, unknown> = {};
        if (args.name !== undefined) flat.name = args.name;
        if (args.plural_name !== undefined) flat.plural_name = args.plural_name;
        if (args.layout !== undefined) flat.layout = args.layout;
        if (args.default_view !== undefined)
          flat.default_view = args.default_view;
        if (args.default_template !== undefined) {
          flat.default_template = args.default_template;
        }
        if (args.property_definitions !== undefined) {
          flat.property_definitions = args.property_definitions;
        }
        const body = pickPatchBody(flat, args.ops);
        return runRequest(
          deps,
          exec,
          'PATCH',
          `/v2/spaces/${enc(args.space_id)}/types/${enc(args.type)}`,
          {
            body,
            expectedEtag: args.expected_etag,
            query: { create_missing_options: args.create_missing_options },
          },
        );
      },
    }),
    defineTool({
      name: 'anytype_delete_type',
      description:
        'Delete an object type by key. Existing objects keep their data but lose the type. Use dry_run=true to preview.',
      parameters: {
        space_id: { type: 'string', required: true, description: 'Space id.' },
        type: {
          type: 'string',
          required: true,
          description: 'Type key (or id).',
        },
        dry_run: {
          type: 'boolean',
          description: 'true = validate without deleting.',
        },
      },
      output: outputSpec(),
      async execute(args, exec) {
        return runRequest(
          deps,
          exec,
          'DELETE',
          `/v2/spaces/${enc(args.space_id)}/types/${enc(args.type)}`,
          { query: { dry_run: args.dry_run } },
        );
      },
    }),
    defineTool({
      name: 'anytype_list_templates',
      description:
        'List templates in a space, optionally filtered by type key. Template ids feed anytype_create_object template and anytype_create_type default_template.',
      parameters: {
        space_id: { type: 'string', required: true, description: 'Space id.' },
        type: { type: 'string', description: 'Filter by type key.' },
        limit: { type: 'integer', description: 'Page size (API default 25).' },
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
          `/v2/spaces/${enc(args.space_id)}/templates`,
          {
            query: { type: args.type, limit: args.limit, offset: args.offset },
          },
        );
      },
    }),
  ];
}
