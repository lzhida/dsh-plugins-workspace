/**
 * dsh-anytype 插件入口。
 *
 * 职责：
 * - 导出 loader 依赖的 name / apply / inject 与设置面板契约 Config；
 * - apply() 内：
 *   1. 打印 `[dsh-anytype] plugin loaded`（e2e 装载契约）；
 *   2. 注册 system-prompt 使用指引 section（工具正确组合的说明书：
 *      先拿 space_id、编辑前先查 op schema、写后读校验）；
 *   3. 按 `enabled` 与 `disabledGroups` 经 `ctx.tools.register` 注册工具，
 *      disposer 自动随插件卸载注销。
 *
 * 配置全部是 volatile 字段（设置面板可编辑、保存即生效）：
 * - apiKey/baseUrl/超时/截断等由 client 在每次请求前现读——面板里改完
 *   key 无需重载插件，下一次工具调用即用新值；
 * - `enabled` / `disabledGroups` 影响的是「注册哪些工具」，属于装载期
 *   决策，改动后需重载插件（宿主 HMR / 重启）才生效——section 文案里
 *   已向用户说明这一差异。
 *
 * 依赖注入：`tools`（注册工具）+ `systemPrompt`（注册指引 section）。
 * 二者都由 dsh web/base bundle 提供；缺失时插件停在 PENDING（cordis 语义）。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';

import { resolveConfig } from './config.ts';
import { buildTools } from './tools/index.ts';

/** Cordis 插件名（loader 依赖）；与包名 kebab 段一致。 */
export const name = 'dsh-anytype';

/** 依赖注入：工具注册表 + system-prompt。 */
export const inject: string[] = ['tools', 'systemPrompt'];

/** 指引 section 名（包名空间防撞）。 */
export const SECTION_NAME = 'tool:dsh-anytype';

/** section order：工具使用指引档位（PLUGIN 类，2960，与宿主各 section 同档）。 */
export const SECTION_ORDER = 2960;

/** 构造 agent 使用指引 section（纯函数，测试直连）。 */
export function anytypeGuidanceSection(enabled: boolean): PromptSection {
  const text = enabled
    ? `Anytype tools (anytype_*) are available: they talk to local Anytype servers (v2 API) with the keys configured in Settings → Plugins → dsh-anytype.

## Two backends, one data-plane warning

- **desktop** = the Anytype desktop app (port 31009) — the user's main account, live local vault.
- **cli** = anytype-cli (port 31012) — a SEPARATE bot account with its own synced data; it only sees spaces the bot joined. Keys are NOT interchangeable between backends.
- Mode \`auto\` prefers desktop and only switches to cli on a connection failure (never on auth errors). Every tool result carries a \`backend\` field — check it before claiming things about "the user's notes".
- Start with \`anytype_status\`: it reports reachability/authentication of both backends, CLI install & service state (via the CLI's machine-readable interface), and the effective backend. Use it FIRST when any anytype_* tool fails with a connection error.
- **CLI account tools** (\`anytype_cli_login\` / \`anytype_cli_create\`) operate on the local CLI bot account with parameters from the plugin settings (account key fed via stdin). They touch ONLY the CLI data plane — never the desktop vault.

## How to use the tools

- **Start with discovery**: anytype_whoami verifies the key; anytype_list_spaces gives the space_id every space-scoped tool needs; anytype_search finds objects across spaces; anytype_list_types lists type keys for anytype_create_object.
- **Read before write**: anytype_get_object returns the current content and its ETag; pass that ETag as expected_etag on update calls to fail instead of overwriting concurrent edits.
- **Edits are ops**: anytype_update_object applies an ordered ops array atomically. ALWAYS fetch the op's member schema with anytype_get_op_schema(op) first (set_properties, insert_blocks, add_items, replace_text, ...) — do not guess op fields.
- **Schemas are runtime truth**: for full AnyBlock documents, template/type documents, or exotic request bodies, fetch anytype_get_schema(kind) first; anytype_request is the generic passthrough for endpoints without a dedicated tool (chats, files, widgets, queries — /v2/ only, /v2/auth/* blocked).
- **Large responses truncate**: results beyond the configured character budget come back as a data_preview — narrow with limit/offset/fields and page instead of retrying blindly.
- **Errors are actionable**: AnytypeError messages carry status + code + hints; connection-refused usually means no backend is running (desktop app closed AND CLI service stopped).`
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

  // 3. enabled=false → 不注册任何工具
  if (!resolved.enabled) {
    console.log(`[${name}] disabled by config; no tools registered`);
    return;
  }

  // 4. 按组注册工具（disposer 自动附着插件，卸载即注销）。
  const grouped = buildTools(() => {
    // 每次执行现读 volatile 配置（baseUrl/apiKey/超时/截断热生效）。
    let current = resolved;
    try {
      current = resolveConfig(configInput);
    } catch {
      // 保留 last good
    }
    return current;
  });
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
export { resolveConfig, Config } from './config.ts';
export type {
  BackendMode,
  CliBackendSettings,
  DesktopBackendSettings,
  ResolvedConfig,
  ToolGroup,
} from './config.ts';
export {
  DEFAULT_API_VERSION,
  DEFAULT_BASE_URL,
  DEFAULT_CLI_BIN,
  DEFAULT_CLI_URL,
  DEFAULT_MAX_RESPONSE_CHARS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  TOOL_GROUPS,
} from './config.ts';
export { AnytypeClient, AnytypeError } from './client.ts';
export type {
  AnytypeResult,
  AnytypeToolValue,
  BackendEndpoint,
  BackendProbeResult,
  ClientConfig,
  UnreachableHook,
} from './client.ts';
export { cliAutoStartHint, CliLauncher } from './launcher.ts';
export type {
  CliAuthResult,
  CliJsonEnvelope,
  CliRuntimeStatus,
  CliServiceStatus,
  CliStartResult,
  LauncherConfig,
} from './launcher.ts';
export {
  buildTools,
  buildGroupedTools,
  createUnreachableHook,
  toClientConfig,
} from './tools/index.ts';
