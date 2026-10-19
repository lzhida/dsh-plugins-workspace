/**
 * 工具组装：按组构建全部工具定义，并给出「组 → 工具」映射供注册层
 * 按 `disabledGroups` 过滤。
 *
 * 组与工具清单（26 个）：
 * - connection: anytype_whoami
 * - search:     anytype_search, anytype_list_objects
 * - space:      anytype_list_spaces, anytype_get_space, anytype_create_space,
 *               anytype_update_space
 * - object:     anytype_get_object, anytype_create_object, anytype_update_object,
 *               anytype_delete_object
 * - collection: anytype_create_collection, anytype_list_collection_objects
 * - type:       anytype_list_types, anytype_get_type, anytype_create_type,
 *               anytype_update_type, anytype_delete_type, anytype_list_templates
 * - property:   anytype_list_properties, anytype_list_property_options
 * - member:     anytype_list_members, anytype_get_member_me
 * - schema:     anytype_get_schema, anytype_get_op_schema
 * - generic:    anytype_request
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

import { AnytypeClient } from '../client.ts';
import type { ResolvedConfig, ToolGroup } from '../config.ts';
import { buildCollectionTools } from './collections.ts';
import { buildConnectionTools } from './connection.ts';
import { buildGenericTools } from './generic.ts';
import { buildMemberTools } from './members.ts';
import { buildObjectTools } from './objects.ts';
import { buildPropertyTools } from './properties.ts';
import { buildSchemaTools } from './schemas.ts';
import { buildSearchTools } from './search.ts';
import type { ToolDeps } from './shared.ts';
import { buildSpaceTools } from './spaces.ts';
import { buildTypeTools } from './types.ts';

/** 全部工具按组组装（注册层按 disabledGroups 过滤后逐个 register）。 */
export function buildGroupedTools(
  deps: ToolDeps,
): Map<ToolGroup, ToolDefinition[]> {
  return new Map<ToolGroup, ToolDefinition[]>([
    ['connection', buildConnectionTools(deps)],
    ['search', buildSearchTools(deps)],
    ['space', buildSpaceTools(deps)],
    ['object', buildObjectTools(deps)],
    ['collection', buildCollectionTools(deps)],
    ['type', buildTypeTools(deps)],
    ['property', buildPropertyTools(deps)],
    ['member', buildMemberTools(deps)],
    ['schema', buildSchemaTools(deps)],
    ['generic', buildGenericTools(deps)],
  ]);
}

/**
 * 组装客户端与工具（index.ts 的唯一装配入口）。
 *
 * @param config - volatile 配置现读入口（client 每次请求前调用）。
 * @returns 组标识 → 工具定义列表。
 */
export function buildTools(
  config: () => ResolvedConfig,
): Map<ToolGroup, ToolDefinition[]> {
  const deps: ToolDeps = {
    client: new AnytypeClient(() => {
      const cfg = config();
      return {
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        apiVersion: cfg.apiVersion,
        timeoutMs: cfg.requestTimeoutMs,
      };
    }),
    config,
  };
  return buildGroupedTools(deps);
}
