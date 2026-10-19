/**
 * 成员组：anytype_list_members / anytype_get_member_me。
 *
 * 成员是空间级协作者视图（id/name/identity/permissions）；
 * 「分配给我」类任务用 get_member_me 拿当前成员身份。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { enc, outputSpec, runRequest, type ToolDeps } from './shared.ts';

/** 构建成员组工具。 */
export function buildMemberTools(deps: ToolDeps) {
  return [
    defineTool({
      name: 'anytype_list_members',
      description: 'List members of a space (id, name, role/permissions).',
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
          `/v2/spaces/${enc(args.space_id)}/members`,
          { query: { limit: args.limit, offset: args.offset } },
        );
      },
    }),
    defineTool({
      name: 'anytype_get_member_me',
      description:
        'Get the current member (your own identity/permissions) in a space — use it to resolve "assign to me".',
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
          `/v2/spaces/${enc(args.space_id)}/members/me`,
        );
      },
    }),
  ];
}
