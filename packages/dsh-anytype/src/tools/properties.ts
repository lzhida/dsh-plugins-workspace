/**
 * 属性组：anytype_list_properties / anytype_list_property_options。
 *
 * 属性（property）是空间级字段定义；创建通常随对象/类型隐式发生
 * （create_object 的 properties、create_type 的 property_definitions），
 * 重命名走属性 PATCH、增删走 anytype_request（组内工具以读为主，
 * 面板保持轻量）。
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
  ];
}
