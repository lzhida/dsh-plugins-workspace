/**
 * dsh-anytype 插件入口（bundle 内的第一个插件行）。
 *
 * ## 它在包里的角色
 *
 * `@lzhida/dsh-anytype` 是一个 **bundle 包**：包内可以放多个插件入口，
 * 每个入口是一个独立插件行（各自的 `name` / `apply` / `Config`），由包的
 * `cordis.patch.yml` 一次性声明并激活（见 `docs/bundle-architecture.md`）。
 *
 * - 本文件 = **插件行①**：通用 Anytype 工具（30 个 `anytype_*`）。
 * - `entries/memory.ts` = **插件行②**：持久记忆（16 个 `memory_*`）。
 * - `entries/wiki.ts` = **留位**：将来的 LLM Wiki 知识编译管道。
 *
 * ## 它对外提供的东西
 *
 * 1. **工具**：`anytype_*` 工具族；
 * 2. **连接服务**：以 cordis `Service` 形式注册名为 `anytype` 的具名服务，
 *    持有**配置现读**的客户端。插件行②（记忆）通过 `inject: ['anytype']`
 *    等待它就绪后复用同一把钥匙——**连接配置只填一次**。
 *
 * 依赖注入：`tools`（注册工具）+ `systemPrompt`（注册指引 section）。
 * 二者都由 dsh web/base bundle 提供；缺失时插件停在 PENDING（cordis 语义）。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';

import { resolveConfig } from '../anytype/config.ts';
import { buildTools } from '../anytype/tools/index.ts';
import {
  provideAnytypeService,
  type AnytypeConnection,
} from '../services/anytype.ts';

/** Cordis 插件名（loader 依赖）；与包名 kebab 段一致。 */
export const name = 'dsh-anytype';

/** 依赖注入：工具注册表 + system-prompt。 */
export const inject: string[] = ['tools', 'systemPrompt'];

/**
 * 本插件行提供的服务名（cordis `Plugin.Base.provide`）。
 *
 * 声明它，loader 与插件注册表才知道「`dsh-anytype-memory` 注入的
 * `anytype` 由本插件行提供」，依赖图才连得起来。
 */
export const provide: string | string[] = 'anytype';

/** 指引 section 名（包名空间防撞）。 */
export const SECTION_NAME = 'tool:dsh-anytype';

/** section order：工具使用指引档位（PLUGIN 类，2960，与宿主各 section 同档）。 */
export const SECTION_ORDER = 2960;

/** 构造 agent 使用指引 section（纯函数，测试直连）。 */
export function anytypeGuidanceSection(enabled: boolean): PromptSection {
  const text = enabled
    ? `Anytype tools (anytype_*) are available: they talk to the local Anytype desktop app (v2 API) with the key configured in Settings → Plugins → dsh-anytype.

## How to use them

- **Start with discovery**: anytype_whoami verifies the key; anytype_status diagnoses the desktop backend (reachability/authentication) — use it FIRST when any anytype_* tool fails with a connection error; anytype_list_spaces gives the space_id every space-scoped tool needs; anytype_search finds objects across spaces; anytype_list_types lists type keys for anytype_create_object.
- **Read before write**: anytype_get_object returns the current content and its ETag; pass that ETag as expected_etag on update calls to fail instead of overwriting concurrent edits.
- **Edits are ops**: anytype_update_object applies an ordered ops array atomically. ALWAYS fetch the op's member schema with anytype_get_op_schema(op) first (set_properties, insert_blocks, add_items, replace_text, ...) — do not guess op fields.
- **Write calls are safe to retry**: pass idempotency_key on any write when a retry is plausible — the server binds the key to the request body, so the same key with the same body replays the stored response instead of creating a duplicate, while the same key with a different body is a 409 conflict. Generate a fresh key per distinct request and reuse it verbatim when retrying that same request. Pass dry_run=true to validate a write without committing it (a previewed create returns 200 where a real create returns 201).
- **Schemas are runtime truth**: for full AnyBlock documents, template/type documents, or exotic request bodies, fetch anytype_get_schema(kind) first; anytype_request is the generic passthrough for endpoints without a dedicated tool (chats, files, widgets, queries — /v2/ only, /v2/auth/* blocked).
- **Large responses truncate**: results beyond the configured character budget come back as a data_preview — narrow with limit/offset and page instead of retrying blindly. anytype_search rows are minimal by default (id/name/type only); pass fields to project specific properties back (e.g. ["name","due_date"]) and filter for a compact filter string (max 4096 bytes, grammar via anytype_get_schema kind=filters) to cut the result set. filter and filters are mutually exclusive — send one.
- **Errors are actionable**: AnytypeError messages carry status + code + hints; connection-refused usually means the Anytype desktop app is not running.`
    : `The dsh-anytype plugin is installed but tool registration is disabled (enabled=false in its settings) or all groups are excluded. No anytype_* tools exist in this session. The user can enable them in Settings → Plugins → dsh-anytype (plugin reload required).`;
  return {
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text,
  };
}

/**
 * 插件入口。
 *
 * @param ctx - cordis 上下文（tools / systemPrompt 已由 inject 保证就绪）。
 * @param configInput - loader 投影的用户配置（volatile 引用嵌套，可 undefined）。
 */
export function apply(ctx: Context, configInput?: unknown): void {
  // e2e 契约：装载日志 `[name] ` 前缀格式，e2e 运行器按此结构化匹配。
  console.log(`[${name}] plugin loaded`);

  // 1. 解析配置；非法输入降级为默认（不抛错、不阻塞宿主）。
  //    enabled/disabledGroups 决定装载期注册面；其余字段每次执行现读。
  let resolved;
  try {
    resolved = resolveConfig(configInput);
  } catch (err) {
    console.error(`[${name}] invalid config:`, err);
    resolved = resolveConfig(undefined);
  }

  // 2. system-prompt 使用指引 section：始终注册——enabled=false 时它告知
  //    agent「工具存在但停用」，避免模型面对用户请求凭空造工具。
  ctx.effect(() => {
    const dispose = ctx.systemPrompt.section(
      anytypeGuidanceSection(resolved.enabled),
    );
    return () => dispose();
  }, 'dsh-anytype: guidance section');

  // 3. 注册连接服务（具名 `anytype`）：持配置现读的客户端，供本插件行与
  //    插件行②（dsh-anytype-memory）共用——**连接配置只填一次**。
  //    ctx.provide 返回的注销函数随插件卸载执行。
  const readConnection = (): AnytypeConnection => {
    const current = resolveConfig(configInput);
    return {
      baseUrl: current.baseUrl,
      apiKey: current.apiKey,
      apiVersion: current.apiVersion,
      requestTimeoutMs: current.requestTimeoutMs,
      maxResponseChars: current.maxResponseChars,
    };
  };
  const { service, dispose } = provideAnytypeService(ctx, readConnection);
  ctx.effect(() => dispose, 'dsh-anytype: connection service');

  // 4. enabled=false → 不注册任何工具（服务仍在：它是连接能力的提供者）
  if (!resolved.enabled) {
    console.log(`[${name}] disabled by config; no tools registered`);
    return;
  }

  // 5. 按组注册工具（disposer 自动附着插件，卸载即注销）。
  const grouped = buildTools(() => {
    // 每次执行现读 volatile 配置（baseUrl/apiKey/超时/截断热生效）。
    let current = resolved;
    try {
      current = resolveConfig(configInput);
    } catch {
      // 保留 last good
    }
    return current;
  }, service.client);
  let registeredCount = 0;
  for (const [group, definitions] of grouped) {
    if (resolved.disabledGroups.has(group)) continue;
    for (const definition of definitions) {
      ctx.tools.register(definition);
      registeredCount += 1;
    }
  }
  console.log(`[${name}] registered ${registeredCount} Anytype tools`);
}

// re-export：loader 通过 `plugin.Config` 读 schemastery schema 生成设置面板
// （collectConfigSchemas）；不 re-export 会让设置面板不渲染本插件字段。
export { resolveConfig, Config } from '../anytype/config.ts';
export type { ResolvedConfig, ToolGroup } from '../anytype/config.ts';
export {
  DEFAULT_API_VERSION,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RESPONSE_CHARS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  TOOL_GROUPS,
} from '../anytype/config.ts';
export { AnytypeClient, AnytypeError } from '../core/index.ts';
export type {
  AnytypeClientOptions,
  AnytypeResult,
  AnytypeToolValue,
} from '../core/index.ts';
export { buildTools, buildGroupedTools } from '../anytype/tools/index.ts';
