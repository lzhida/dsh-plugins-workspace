/**
 * 属性组：anytype_list_properties / anytype_list_property_options /
 * anytype_create_property / anytype_update_property / anytype_delete_property。
 *
 * 属性（property）是空间级字段定义。v2 能力边界（详见各工具描述）：
 * - create：POST body 收 name/format/key/options（select|multi_select 可内联选项）；
 * - update：PATCH 仅收 name（改名）——key 是属性身份不变，format 创建后不可变；
 * - delete：归档进 Bin 可恢复，支持 dry_run 预检；
 * - 选项词汇创建后只读：v2 没有 v1 tags 的选项改名/删色端点，也无独立
 *   options CRUD——新选项靠 create_type/create_object 内联属性名 +
 *   create_missing_options=true 铸造，经 anytype_list_property_options 读回。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { enc, outputSpec, runRequest, type ToolDeps } from './shared.ts';

/** 构建属性组工具。 */
export function buildPropertyTools(deps: ToolDeps) {
  return [
    defineTool({
      name: 'anytype_list_properties',
      description:
        'List property definitions in a space (key, name, format). Property keys feed create_object properties and get_op_schema set_properties.',
      parameters: {
        space_id: { type: 'string', required: true, description: 'Space id.' },
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
          `/v2/spaces/${enc(args.space_id)}/properties`,
          { query: { limit: args.limit, offset: args.offset } },
        );
      },
    }),
    defineTool({
      name: 'anytype_list_property_options',
      description:
        'List the options (tags) of a select/multi_select property, optionally filtered by prefix.',
      parameters: {
        space_id: { type: 'string', required: true, description: 'Space id.' },
        key: {
          type: 'string',
          required: true,
          description: 'Property key (from anytype_list_properties).',
        },
        prefix: {
          type: 'string',
          description: 'Filter options whose name starts with this prefix.',
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
          `/v2/spaces/${enc(args.space_id)}/properties/${enc(args.key)}/options`,
          {
            query: {
              prefix: args.prefix,
              limit: args.limit,
              offset: args.offset,
            },
          },
        );
      },
    }),
    defineTool({
      name: 'anytype_create_property',
      description:
        'Create a property (typed field definition) in a space. Required: name + format. The key ([a-zA-Z0-9_]) derives from the name; pass it explicitly to create a second property under a display name the space already has — names are not identities, a duplicate visible name without a key is refused. select/multi_select accept an inline options vocabulary ([{name, color?}], max 100). v2 scope: the option vocabulary is read-only after creation — there is no option rename/recolor endpoint (the v1 tags API is gone); mint further options by naming them on create_type/create_object with create_missing_options=true, and read the vocabulary with anytype_list_property_options.',
      parameters: {
        space_id: {
          type: 'string',
          required: true,
          description: 'Target space id.',
        },
        name: {
          type: 'string',
          required: true,
          description: 'Display name (e.g. "Due date").',
        },
        format: {
          type: 'string',
          required: true,
          enum: [
            'text',
            'number',
            'select',
            'multi_select',
            'date',
            'files',
            'checkbox',
            'url',
            'email',
            'phone',
            'objects',
          ],
          description:
            "Value format; fixed for the property's lifetime once created.",
        },
        key: {
          type: 'string',
          description:
            'Explicit property key ([a-zA-Z0-9_]); derived from name when omitted. Required to create another property under a display name the space already has.',
        },
        options: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description:
            'select/multi_select only: option vocabulary to create inline, [{name, color?}], max 100 items.',
        },
      },
      output: outputSpec(),
      async execute(args, exec) {
        const body: Record<string, unknown> = {
          name: args.name,
          format: args.format,
        };
        if (args.key !== undefined) body.key = args.key;
        if (args.options !== undefined) body.options = args.options;
        return runRequest(
          deps,
          exec,
          'POST',
          `/v2/spaces/${enc(args.space_id)}/properties`,
          { body },
        );
      },
    }),
    defineTool({
      name: 'anytype_update_property',
      description:
        "Rename a property. v2 can ONLY change the display name (the PATCH body takes name and nothing else): the key is the property's identity and does not change, and the format is fixed once it exists. The option vocabulary is read-only — no rename/recolor (see anytype_create_property).",
      parameters: {
        space_id: { type: 'string', required: true, description: 'Space id.' },
        key: {
          type: 'string',
          required: true,
          description:
            'Property key (from anytype_list_properties); the identity, unchanged by this call.',
        },
        name: {
          type: 'string',
          required: true,
          description: 'New display name.',
        },
      },
      output: outputSpec(),
      async execute(args, exec) {
        return runRequest(
          deps,
          exec,
          'PATCH',
          `/v2/spaces/${enc(args.space_id)}/properties/${enc(args.key)}`,
          { body: { name: args.name } },
        );
      },
    }),
    defineTool({
      name: 'anytype_delete_property',
      description:
        'Delete a property by key. The property is archived into the Bin and can be restored from there. Use dry_run=true to validate without deleting.',
      parameters: {
        space_id: { type: 'string', required: true, description: 'Space id.' },
        key: {
          type: 'string',
          required: true,
          description: 'Property key (from anytype_list_properties).',
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
          `/v2/spaces/${enc(args.space_id)}/properties/${enc(args.key)}`,
          { query: { dry_run: args.dry_run } },
        );
      },
    }),
  ];
}
