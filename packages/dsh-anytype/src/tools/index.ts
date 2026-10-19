/**
 * 工具组装：按组构建全部工具定义，并给出「组 → 工具」映射供注册层
 * 按 `disabledGroups` 过滤。
 *
 * 组与工具清单（27 个）：
 * - connection: anytype_whoami, anytype_status
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

import type { ClientConfig, UnreachableHook } from '../client.ts';
import { AnytypeClient } from '../client.ts';
import type { ResolvedConfig, ToolGroup } from '../config.ts';
import { CliLauncher, cliAutoStartHint } from '../launcher.ts';
import { buildCliAuthTools } from './cli-auth.ts';
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

/** 插件日志前缀（与 index.ts 的 name 一致；避免循环 import 用字面量）。 */
const LOG_PREFIX = '[dsh-anytype]';

/** ResolvedConfig → 客户端配置（同形映射）。 */
export function toClientConfig(cfg: ResolvedConfig): ClientConfig {
  return {
    apiVersion: cfg.apiVersion,
    timeoutMs: cfg.requestTimeoutMs,
    backendMode: cfg.backendMode,
    desktop: { url: cfg.desktop.url, key: cfg.desktop.key },
    cli: { url: cfg.cli.url, key: cfg.cli.key },
  };
}

/**
 * autoStart 拉起接线：仅 CLI 后端（桌面端纯检测，无拉起）。
 * 拉起顺序：`service start` 优先；服务管理器不支持/失败时回退为
 * detached `anytype serve`。失败打印可操作指引。
 */
export function createUnreachableHook(
  config: () => ResolvedConfig,
  launcher: CliLauncher,
): UnreachableHook {
  return async (backend) => {
    if (backend !== 'cli') return false;
    const cfg = config();
    if (!cfg.cli.autoStart) return false;
    const viaService = await launcher.startCliService();
    if (viaService === 'started' || viaService === 'already-running') {
      return true;
    }
    // service 不可用（未安装/管理器不支持/失败）→ serve 回退
    console.error(
      `${LOG_PREFIX} service start unavailable (${viaService}); falling back to \`anytype serve\``,
    );
    const viaServe = await launcher.serveStart();
    if (viaServe === 'started' || viaServe === 'already-running') {
      return true;
    }
    console.error(`${LOG_PREFIX} ${cliAutoStartHint(viaService)}`);
    return false;
  };
}

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
    ['cli-auth', buildCliAuthTools(deps)],
  ]);
}

/**
 * 组装客户端、拉起器与工具（index.ts 的唯一装配入口）。
 *
 * @param config - volatile 配置现读入口（client 每次请求前调用）。
 * @returns 组标识 → 工具定义列表。
 */
export function buildTools(
  config: () => ResolvedConfig,
): Map<ToolGroup, ToolDefinition[]> {
  const launcher = new CliLauncher(config);
  const deps: ToolDeps = {
    client: new AnytypeClient(
      () => toClientConfig(config()),
      undefined,
      createUnreachableHook(config, launcher),
    ),
    config,
    launcher,
  };
  return buildGroupedTools(deps);
}
