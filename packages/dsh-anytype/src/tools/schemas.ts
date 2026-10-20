/**
 * Schema 发现组：anytype_get_schema / anytype_get_op_schema。
 *
 * Anytype v2 是自描述编辑协议——AnyBlock 文档与 15 种编辑 op 的成员结构
 * 不固定在插件里，而是运行时从 `/v2/schemas` 取。这两个工具是
 * `anytype_create_object`（document 形态）、`anytype_update_object`（ops）、
 * `anytype_update_type`（ops）的正确使用前提。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { enc, outputSpec, runRequest, type ToolDeps } from './shared.ts';

/** patch_object 支持的全部编辑 op（来自 OpenAPI op enum）。 */
const EDIT_OPS = [
  'set_properties',
  'set_type',
  'update_block',
  'replace_subtree',
  'insert_blocks',
  'move_block',
  'delete_block',
  'replace_text',
  'set_cell',
  'update_view',
  'insert_view',
  'move_view',
  'delete_view',
  'add_items',
  'remove_items',
] as const;

/** 构建schema 发现组工具。 */
export function buildSchemaTools(deps: ToolDeps) {
  return [
    defineTool({
      name: 'anytype_get_schema',
      description:
        'Fetch the JSON schema of an Anytype v2 resource kind — use it to build a full document (kind document/object), an object_type document, a template, or to learn request shapes (e.g. search_request). Read this BEFORE hand-crafting AnyBlock documents or exotic request bodies.',
      parameters: {
        kind: {
          type: 'string',
          required: true,
          description:
            'Schema kind, e.g. object, type_document, template, document, search_request (API lists valid kinds in its error output).',
        },
      },
      output: outputSpec(),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return runRequest(deps, exec, 'GET', `/v2/schemas/${enc(args.kind)}`);
      },
    }),
    defineTool({
      name: 'anytype_get_op_schema',
      description:
        'Fetch the members schema (and worked example) of one edit operation — REQUIRED before building anytype_update_object / anytype_update_type ops arrays.',
      parameters: {
        op: {
          type: 'string',
          required: true,
          enum: [...EDIT_OPS],
          description: 'Edit operation name (the full list).',
        },
      },
      output: outputSpec(),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return runRequest(deps, exec, 'GET', `/v2/schemas/ops/${enc(args.op)}`);
      },
    }),
  ];
}
