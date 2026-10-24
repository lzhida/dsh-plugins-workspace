/**
 * 对象组：anytype_get_object / anytype_create_object / anytype_update_object /
 * anytype_delete_object。
 *
 * - create 走 v2 shortcut body：`{type, name?, markdown?, properties?, template?}`
 *   （markdown 由服务端解析成块；properties 是「属性名 → 值」的扁平对象）；
 * - update 走 ops 信封：`{ops: [...]}`，共 15 种 op——每个 op 的成员 schema 用
 *   `anytype_get_op_schema(op)` 运行时发现（v2 自描述编辑协议）；
 * - delete 是归档语义（可恢复）；
 * - 三个写工具统一带 `dry_run`（预演不落库）与 `idempotency_key`（防重复
 *   创建）——服务端按「key + 请求体」绑定，同 key 同 body 重试重放已存响应。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import {
  DRY_RUN_PARAM,
  enc,
  IDEMPOTENCY_KEY_PARAM,
  outputSpec,
  runRequest,
  type ToolDeps,
} from '../../core/index.ts';

/** 构建对象组工具。 */
export function buildObjectTools(deps: ToolDeps) {
  return [
    defineTool({
      name: 'anytype_get_object',
      description:
        'Read one object: name, type, properties, and body blocks (layout/markdown per format). The response ETag feeds anytype_update_object expected_etag.',
      parameters: {
        space_id: { type: 'string', required: true, description: 'Space id.' },
        object_id: {
          type: 'string',
          required: true,
          description: 'Object id.',
        },
        format: {
          type: 'string',
          enum: ['md', 'anyblock'],
          description:
            'Body rendering: "md" (markdown text) or "anyblock" (block tree). Omit for the API default; any other value is refused with 400.',
        },
        include: {
          type: 'string',
          description:
            'Optional comma-separated extras (API-defined, e.g. related lists).',
        },
        outline: {
          type: 'boolean',
          description:
            'true = return only the heading outline instead of full blocks.',
        },
      },
      output: outputSpec(),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return runRequest(
          deps,
          exec,
          'GET',
          `/v2/spaces/${enc(args.space_id)}/objects/${enc(args.object_id)}`,
          {
            query: {
              format: args.format,
              include: args.include,
              outline: args.outline,
            },
          },
        );
      },
    }),
    defineTool({
      name: 'anytype_create_object',
      description:
        'Create an object in a space. Required: type key (anytype_list_types to find one; "page" always exists) plus optionally name, markdown body (parsed server-side, max 2048 blocks), flat properties map {property: value}, and template id ("none" to skip the type default). Returns the created object receipt with its id. Pass dry_run=true to validate the payload without creating anything, and idempotency_key to make a retry of the same request safe (same key + same body replays the stored response instead of creating a duplicate).',
      parameters: {
        space_id: {
          type: 'string',
          required: true,
          description: 'Target space id.',
        },
        type: {
          type: 'string',
          required: true,
          description: 'Type key, e.g. page or task (see anytype_list_types).',
        },
        name: {
          type: 'string',
          description: 'Display name shown above the body.',
        },
        markdown: {
          type: 'string',
          description:
            'Markdown body parsed server-side. Start at the first section: a leading heading repeating the name is dropped; with no name a leading # heading becomes the name.',
        },
        properties: {
          type: 'object',
          additionalProperties: true,
          description:
            'Flat map of property name/key to value (see anytype_list_properties).',
        },
        template: {
          type: 'string',
          description:
            'Template id to start from ("none" = empty). Omit to apply the type default_template when present.',
        },
        dry_run: DRY_RUN_PARAM,
        idempotency_key: IDEMPOTENCY_KEY_PARAM,
      },
      output: outputSpec(),
      async execute(args, exec) {
        const body: Record<string, unknown> = { type: args.type };
        if (args.name !== undefined) body.name = args.name;
        if (args.markdown !== undefined) body.markdown = args.markdown;
        if (args.properties !== undefined) body.properties = args.properties;
        if (args.template !== undefined) body.template = args.template;
        return runRequest(
          deps,
          exec,
          'POST',
          `/v2/spaces/${enc(args.space_id)}/objects`,
          {
            body,
            query: { dry_run: args.dry_run },
            idempotencyKey: args.idempotency_key,
          },
        );
      },
    }),
    defineTool({
      name: 'anytype_update_object',
      description:
        "Edit one object as an ordered list of ops applied atomically (any refused op cancels all). Ops: set_properties, set_type, update_block, replace_subtree, insert_blocks, move_block, delete_block, replace_text, set_cell, update_view, insert_view, move_view, delete_view, add_items, remove_items — fetch each op's members with anytype_get_op_schema(op) BEFORE building it. Pass expected_etag (from anytype_get_object) to fail on concurrent edits. Pass dry_run=true to validate the ops without applying them.",
      parameters: {
        space_id: { type: 'string', required: true, description: 'Space id.' },
        object_id: {
          type: 'string',
          required: true,
          description: 'Object id.',
        },
        ops: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          required: true,
          description:
            'Ordered edit operations, e.g. [{"op":"insert_blocks", ...}]. Schema per op from anytype_get_op_schema.',
        },
        expected_etag: {
          type: 'string',
          description: 'ETag from a previous read; sent as If-Match.',
        },
        dry_run: DRY_RUN_PARAM,
        idempotency_key: IDEMPOTENCY_KEY_PARAM,
      },
      output: outputSpec(),
      async execute(args, exec) {
        return runRequest(
          deps,
          exec,
          'PATCH',
          `/v2/spaces/${enc(args.space_id)}/objects/${enc(args.object_id)}`,
          {
            body: { ops: args.ops },
            expectedEtag: args.expected_etag,
            query: { dry_run: args.dry_run },
            idempotencyKey: args.idempotency_key,
          },
        );
      },
    }),
    defineTool({
      name: 'anytype_delete_object',
      description:
        'Archive (soft-delete) one object — restorable in Anytype. Use dry_run=true to preview. Note: only objects this API key created can be deleted.',
      parameters: {
        space_id: { type: 'string', required: true, description: 'Space id.' },
        object_id: {
          type: 'string',
          required: true,
          description: 'Object id.',
        },
        dry_run: DRY_RUN_PARAM,
        idempotency_key: IDEMPOTENCY_KEY_PARAM,
      },
      output: outputSpec(),
      async execute(args, exec) {
        return runRequest(
          deps,
          exec,
          'DELETE',
          `/v2/spaces/${enc(args.space_id)}/objects/${enc(args.object_id)}`,
          {
            query: { dry_run: args.dry_run },
            idempotencyKey: args.idempotency_key,
          },
        );
      },
    }),
  ];
}
