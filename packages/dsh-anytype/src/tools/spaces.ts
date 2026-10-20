/**
 * 空间组：anytype_list_spaces / anytype_get_space / anytype_create_space /
 * anytype_update_space。
 *
 * 对应 `GET|POST /v2/spaces` 与 `GET|PATCH /v2/spaces/{space_id}`。
 * 乐观锁例外：Anytype v2 spec 的 spaces PATCH 参数区没有 `If-Match`，space
 * 读也不返回 etag；实测（2026-10-20，活体）带过期 `If-Match` 的 PATCH 仍
 * 200——服务端静默忽略。因此 `anytype_update_space` 不提供 `expected_etag`
 * （object/type 组的 If-Match 乐观锁经活体验证有效，不受影响）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { enc, outputSpec, runRequest, type ToolDeps } from './shared.ts';

/** 构建空间组工具。 */
export function buildSpaceTools(deps: ToolDeps) {
  return [
    defineTool({
      name: 'anytype_list_spaces',
      description:
        'List all granted spaces (id, name, icon). Grab a space_id here before calling space-scoped tools.',
      parameters: {
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
        return runRequest(deps, exec, 'GET', '/v2/spaces', {
          query: { limit: args.limit, offset: args.offset },
        });
      },
    }),
    defineTool({
      name: 'anytype_get_space',
      description:
        'Get one space by id (name, description, icon, network status).',
      parameters: {
        space_id: { type: 'string', required: true, description: 'Space id.' },
      },
      output: outputSpec(),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return runRequest(
          deps,
          exec,
          'GET',
          `/v2/spaces/${enc(args.space_id)}`,
        );
      },
    }),
    defineTool({
      name: 'anytype_create_space',
      description:
        'Create a new space. The API key must have space creation rights (see anytype_whoami grant).',
      parameters: {
        name: {
          type: 'string',
          required: true,
          description: 'New space name.',
        },
        description: {
          type: 'string',
          description: 'Optional space description.',
        },
      },
      output: outputSpec(),
      async execute(args, exec) {
        const body: Record<string, unknown> = { name: args.name };
        if (args.description !== undefined) body.description = args.description;
        return runRequest(deps, exec, 'POST', '/v2/spaces', { body });
      },
    }),
    defineTool({
      name: 'anytype_update_space',
      description:
        'Rename a space and/or change its description. No optimistic locking: the Anytype v2 spaces PATCH spec has no If-Match and space reads return no ETag (the server silently ignores an If-Match header), so concurrent edits are not guarded server-side.',
      parameters: {
        space_id: { type: 'string', required: true, description: 'Space id.' },
        name: { type: 'string', description: 'New space name.' },
        description: { type: 'string', description: 'New space description.' },
      },
      output: outputSpec(),
      async execute(args, exec) {
        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body.name = args.name;
        if (args.description !== undefined) body.description = args.description;
        if (Object.keys(body).length === 0) {
          throw new Error(
            'Nothing to update: provide name and/or description.',
          );
        }
        return runRequest(
          deps,
          exec,
          'PATCH',
          `/v2/spaces/${enc(args.space_id)}`,
          {
            body,
          },
        );
      },
    }),
  ];
}
