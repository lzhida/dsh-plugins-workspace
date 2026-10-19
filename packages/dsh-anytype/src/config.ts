/**
 * dsh-anytype 配置 schema 与解析。
 *
 * 设计对齐本仓库 dsh-llm-fallback 的成熟模式：
 * - 每个可编辑字段经 `volatileField()` 包裹 → 宿主 `dsh-settings.describe()`
 *   才会把它投影成设置面板表单（无 volatile 字段的插件条目会被整个丢弃）；
 * - 运行时收到的 volatile 字段是 `Volatile` 引用而非普通值，`resolveConfig`
 *   先深度解包再做语义归一化；index.ts 里每次工具执行前都重新 `resolveConfig`，
 *   让设置面板的改动即时生效（无需重载插件）；
 * - 字段描述经 `desc(en, zh)` 携带 i18n 映射（`''` 键 = 旧渲染端回退文案）。
 *
 * 字段语义：
 * - `enabled`：总开关；false 时插件不注册任何工具（systemPrompt section 照常
 *   注册，向 agent 说明工具当前停用）。
 * - 双后端模型：桌面端（`baseUrl`/`apiKey`，端口 31009，主账户实时库）与
 *   anytype-cli（`cliUrl`/`cliKey`，端口 31012，独立 bot 账户数据面——CLI
 *   不支持 mnemonic 登录，只能访问被邀请加入的 space）。两者 key 互不通用。
 * - `backend`：auto（默认，桌面端优先，仅网络层不可达且 CLI 已配置时切换）/
 *   desktop / cli。
 * - 桌面端**纯检测**：不可达时切 CLI 或报错，不尝试启动桌面应用（实测从
 *   其他进程上下文启动 Anytype.exe 会立即退出，拉起不可靠已移除）。
 * - `cliPath` + `cliAutoStart`：CLI 可执行文件与服务拉起许可（仅对已安装
 *   服务执行 `service start`，绝不代装/代建户；CLI 需一次性 bot 初始化：
 *   auth create → space join → apikey create → 填 cliKey）。
 * - `requestTimeoutMs`：单请求超时（与调用方取消信号组合生效）。
 * - `maxResponseChars`：工具结果文本截断上限——超限时 `data` 被替换为
 *   `_truncated` 预览，保护模型上下文。
 */

import Schema from '@deepseek-ai/schemastery';

// ── volatile 支持（照抄 dsh-llm-fallback/config.ts 的成熟实现） ──────────
//
// dsh 设置面板只投影 `.volatile()` 标记的字段；运行时拿到的是 Volatile 引用。
// `Symbol.for('cosmokit.volatile.write')` 是跨模块副本稳定的全局符号
// （cosmokit 的 isVolatile 即 `write in value`），本地复刻不引入额外依赖。

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/** 是否为 cosmokit volatile 配置引用（可 get() 取当前值）。 */
export function isVolatileLike(
  value: unknown,
): value is { get: () => unknown } {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value;
}

/** 深度解包 volatile 引用，得到普通值（数组/对象逐层递归）。 */
export function unwrapVolatile(value: unknown): unknown {
  if (isVolatileLike(value)) return unwrapVolatile(value.get());
  if (Array.isArray(value)) return value.map((item) => unwrapVolatile(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, unwrapVolatile(child)]),
    );
  }
  return value;
}

/** 若字段支持 volatile 则标记之，否则原样返回（兼容未增强实现）。 */
export function volatileField<T extends { volatile?: unknown }>(field: T): T {
  const volatile = field.volatile;
  return typeof volatile === 'function'
    ? (volatile as () => T).call(field)
    : field;
}

// ── i18n 字段描述 ────────────────────────────────────────────────────

/** schemastery `meta.description` 的 i18n 映射形态（`''` = 回退文案）。 */
export type SchemaDescription = { '': string } & Partial<
  Record<string, string>
>;

/** 构造设置表单字段描述的 i18n 映射（`en` 同时写入 `''`/`en` 键，`zh` 中文）。 */
export function desc(en: string, zh: string): SchemaDescription {
  return { '': en, en, zh };
}

/** 把 i18n 映射写入字段描述（收窄 schemastery 链式声明的滞后）。 */
function setDescription<F extends { description(text: string): F }>(
  field: F,
  text: SchemaDescription,
): F {
  return field.description(text as unknown as string);
}

// ── 常量与类型 ───────────────────────────────────────────────────────

/** Anytype 桌面端本地 API 默认地址（官方 anytype-mcp 同款）。 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:31009';

/** anytype-cli 本地 API 默认地址（CLI 端口段 31010-31012，API 为 31012）。 */
export const DEFAULT_CLI_URL = 'http://127.0.0.1:31012';

/** anytype-cli 可执行文件的默认名称（PATH 查找）。 */
export const DEFAULT_CLI_BIN = 'anytype';

/** CLI JSON API 默认监听地址（login/create/serve 共用）。 */
export const DEFAULT_CLI_LISTEN_ADDRESS = '127.0.0.1:31012';

/** `Anytype-Version` 请求头默认值（当前官方推荐值）。 */
export const DEFAULT_API_VERSION = '2025-11-08';

/** 单请求超时默认值（毫秒）。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** 工具结果文本截断上限默认值（字符数）。 */
export const DEFAULT_MAX_RESPONSE_CHARS = 20_000;

/** 工具组标识：disabledGroups 的合法取值。 */
export const TOOL_GROUPS = [
  'connection',
  'search',
  'space',
  'object',
  'collection',
  'type',
  'property',
  'member',
  'schema',
  'generic',
  'cli-auth',
] as const;

/** 工具组标识类型。 */
export type ToolGroup = (typeof TOOL_GROUPS)[number];

/** 后端选择模式：auto = desktop 优先、网络不可达且已配置时切 cli。 */
export type BackendMode = 'auto' | 'desktop' | 'cli';

/** 桌面端后端运行时设置（纯检测：桌面端不可达时由 auto 语义切 CLI 或报错）。 */
export interface DesktopBackendSettings {
  /** 本地 API 地址（无尾斜杠）。 */
  url: string;
  /** Bearer 密钥（已 trim；空串 = 未配置，auto 模式跳过该后端）。 */
  key: string;
}

/** CLI 后端运行时设置（唯一支持自动拉起的后端）。 */
export interface CliBackendSettings {
  /** 本地 API 地址（无尾斜杠）。 */
  url: string;
  /** Bearer 密钥（已 trim；空串 = 未配置，auto 模式跳过该后端）。 */
  key: string;
  /** 网络不可达时允许插件对已安装服务执行 `service start`（失败/不支持时 serve 回退）。 */
  autoStart: boolean;
  /** CLI 可执行文件名或绝对路径。 */
  binPath: string;
  /** bot 账户 key（`auth login --key-stdin` 用；经 stdin 传入，不进命令行）。 */
  accountKey: string;
  /** `auth create` 的账户名（空 = create 工具报可操作错误）。 */
  accountName: string;
  /** 自建网络配置 YAML 路径（login/create 的 `--network-config`）。 */
  networkConfig: string;
  /**
   * 账户数据根路径。仅 CLI 交互模式的 `--root-path`/`--path` 支持；
   * 机读模式（插件固定使用）无此 flag，字段保留、执行时忽略。
   */
  rootPath: string;
  /** JSON API 监听地址（login/create/serve 共用 `--listen-address`）。 */
  listenAddress: string;
}

/** resolveConfig 产出的运行时配置（已解包 volatile 并归一化）。 */
export interface ResolvedConfig {
  /** 总开关；false = 不注册任何工具。 */
  enabled: boolean;
  /** 后端选择模式。 */
  backendMode: BackendMode;
  /** 桌面端后端（原 baseUrl/apiKey 配置项；纯检测，无拉起）。 */
  desktop: DesktopBackendSettings;
  /** CLI 后端（anytype-cli，独立 bot 账户数据面）。 */
  cli: CliBackendSettings;
  /** `Anytype-Version` 头。 */
  apiVersion: string;
  /** 被停用的工具组。 */
  disabledGroups: ReadonlySet<ToolGroup>;
  /** 单请求超时（毫秒）。 */
  requestTimeoutMs: number;
  /** 工具结果文本截断上限（字符数）。 */
  maxResponseChars: number;
}

/** 归一化 baseUrl：trim、去尾斜杠；非法（非 http(s)）返回 undefined。 */
export function normalizeBaseUrl(input: unknown): string | undefined {
  const raw = String(input ?? '').trim();
  if (raw.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return raw.replace(/\/+$/, '');
}

/** 归一化正整数配置（超时/截断上限）；非法回落默认。 */
function resolvePositiveInt(input: unknown, fallback: number): number {
  const raw = Number(input);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.floor(raw);
}

/** 归一化字符串配置（trim）；非字符串安全转字符串。 */
function resolveText(input: unknown): string {
  return typeof input === 'string' ? input.trim() : String(input ?? '').trim();
}

/** 归一化布尔配置：仅字面 true 视为 true（设置面板/手工 YAML 都安全）。 */
function resolveFlag(input: unknown): boolean {
  return input === true;
}

/**
 * 解析并归一化插件配置。
 *
 * @param input - loader 传入的配置（volatile 引用嵌套或普通值，或 undefined）。
 * @returns 运行时配置；URL 非法时回落默认地址（不抛错，插件不阻塞宿主）。
 */
export function resolveConfig(input: unknown): ResolvedConfig {
  const raw = (unwrapVolatile(input) ?? {}) as {
    enabled?: unknown;
    backend?: unknown;
    baseUrl?: unknown;
    apiKey?: unknown;
    cliUrl?: unknown;
    cliKey?: unknown;
    cliPath?: unknown;
    cliAutoStart?: unknown;
    cliAccountKey?: unknown;
    cliAccountName?: unknown;
    cliNetworkConfig?: unknown;
    cliRootPath?: unknown;
    cliListenAddress?: unknown;
    apiVersion?: unknown;
    disabledGroups?: unknown;
    requestTimeoutMs?: unknown;
    maxResponseChars?: unknown;
  };

  const enabled = raw.enabled !== false;
  const backendRaw = String(raw.backend ?? 'auto');
  const backendMode: BackendMode =
    backendRaw === 'desktop' || backendRaw === 'cli' ? backendRaw : 'auto';

  const desktop: DesktopBackendSettings = {
    url: normalizeBaseUrl(raw.baseUrl) ?? DEFAULT_BASE_URL,
    key: resolveText(raw.apiKey),
  };
  const cli: CliBackendSettings = {
    url: normalizeBaseUrl(raw.cliUrl) ?? DEFAULT_CLI_URL,
    key: resolveText(raw.cliKey),
    autoStart: resolveFlag(raw.cliAutoStart),
    binPath: resolveText(raw.cliPath) || DEFAULT_CLI_BIN,
    accountKey: resolveText(raw.cliAccountKey),
    accountName: resolveText(raw.cliAccountName),
    networkConfig: resolveText(raw.cliNetworkConfig),
    rootPath: resolveText(raw.cliRootPath),
    listenAddress:
      resolveText(raw.cliListenAddress) || DEFAULT_CLI_LISTEN_ADDRESS,
  };
  const apiVersionRaw = resolveText(raw.apiVersion);
  const apiVersion =
    apiVersionRaw.length > 0 ? apiVersionRaw : DEFAULT_API_VERSION;

  const disabledGroups = new Set<ToolGroup>();
  if (Array.isArray(raw.disabledGroups)) {
    for (const item of raw.disabledGroups) {
      const g = String(item);
      if ((TOOL_GROUPS as readonly string[]).includes(g)) {
        disabledGroups.add(g as ToolGroup);
      }
    }
  }

  return {
    enabled,
    backendMode,
    desktop,
    cli,
    apiVersion,
    disabledGroups,
    requestTimeoutMs: resolvePositiveInt(
      raw.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    maxResponseChars: resolvePositiveInt(
      raw.maxResponseChars,
      DEFAULT_MAX_RESPONSE_CHARS,
    ),
  };
}

/**
 * schemastery schema；导出名沿用 dsh 0.2.0 的 `Config` 契约
 * （loader 读取并投影成设置面板表单；index.ts 必须 re-export）。
 */
export const Config = Schema.object({
  enabled: volatileField(
    setDescription(
      Schema.boolean().default(true),
      desc(
        'Register the Anytype tools (off = no tools, the guidance section stays)',
        '是否注册 Anytype 工具（关闭后不注册任何工具，仅保留指引 section）',
      ),
    ),
  ),
  baseUrl: volatileField(
    setDescription(
      Schema.string().default(DEFAULT_BASE_URL),
      desc(
        'Desktop backend: Anytype desktop app local API base URL (default port 31009). Detection only — start the app yourself',
        '桌面端后端：Anytype 桌面应用本地 API 地址（默认端口 31009）。仅检测——桌面应用请自行启动',
      ),
    ),
  ),
  apiKey: volatileField(
    setDescription(
      Schema.string().default(''),
      desc(
        'Desktop backend: Anytype API key (App Settings → API Keys → Create new)',
        '桌面端后端：Anytype API 密钥（Anytype 应用设置 → API Keys → 创建）',
      ),
    ),
  ),
  backend: volatileField(
    setDescription(
      Schema.string().default('auto'),
      desc(
        'Backend selection: auto (desktop first, fall back to CLI on connection failure when cliKey is set), desktop, or cli',
        '后端选择：auto（桌面端优先，连接失败且已配置 cliKey 时切换到 CLI）、desktop、cli',
      ),
    ),
  ),
  cliUrl: volatileField(
    setDescription(
      Schema.string().default(DEFAULT_CLI_URL),
      desc(
        'CLI backend: anytype-cli local API base URL (default port 31012, separate bot-account data plane)',
        'CLI 后端：anytype-cli 本地 API 地址（默认端口 31012，独立 bot 账户数据面）',
      ),
    ),
  ),
  cliKey: volatileField(
    setDescription(
      Schema.string().default(''),
      desc(
        'CLI backend: bot API key (anytype auth apikey create); empty = CLI backend not configured',
        'CLI 后端：bot API 密钥（anytype auth apikey create）；留空 = CLI 后端未配置',
      ),
    ),
  ),
  cliPath: volatileField(
    setDescription(
      Schema.string().default(DEFAULT_CLI_BIN),
      desc(
        'anytype-cli executable name or absolute path',
        'anytype-cli 可执行文件名或绝对路径',
      ),
    ),
  ),
  cliAutoStart: volatileField(
    setDescription(
      Schema.boolean().default(false),
      desc(
        'When the CLI backend is the active candidate but unreachable: run `anytype service start`, falling back to a detached `anytype serve` when the service manager is unsupported (never installs or creates accounts; requires one-time bot setup)',
        '当 CLI 后端成为活跃候选但不可达时：执行 `anytype service start`，服务管理器不支持时回退为 detached `anytype serve`（绝不代装/代建户；需一次性 bot 初始化）',
      ),
    ),
  ),
  cliAccountKey: volatileField(
    setDescription(
      Schema.string().default(''),
      desc(
        'Bot account key for `anytype auth login` (fed via stdin, never in the command line)',
        '`anytype auth login` 用的 bot 账户 key（经 stdin 传入，不进命令行）',
      ),
    ),
  ),
  cliAccountName: volatileField(
    setDescription(
      Schema.string().default(''),
      desc(
        'Account name for `anytype auth create` (empty = the create tool reports an actionable error)',
        '`anytype auth create` 的账户名（空 = create 工具报可操作错误）',
      ),
    ),
  ),
  cliNetworkConfig: volatileField(
    setDescription(
      Schema.string().default(''),
      desc(
        'Path to custom network configuration YAML for self-hosted networks (auth login/create --network-config)',
        '自建网络的网络配置 YAML 路径（auth login/create 的 --network-config）',
      ),
    ),
  ),
  cliRootPath: volatileField(
    setDescription(
      Schema.string().default(''),
      desc(
        'Root path for account data. Only the CLI interactive mode supports it (--root-path/--path); the machine mode used by this plugin has no such flag, so it is kept for future CLI versions',
        '账户数据根路径。仅 CLI 交互模式支持（--root-path/--path）；插件使用的机读模式无此 flag，字段保留待 CLI 后续版本',
      ),
    ),
  ),
  cliListenAddress: volatileField(
    setDescription(
      Schema.string().default(DEFAULT_CLI_LISTEN_ADDRESS),
      desc(
        'JSON API listen address for auth login/create and serve (host:port)',
        'auth login/create 与 serve 的 JSON API 监听地址（host:port）',
      ),
    ),
  ),
  apiVersion: volatileField(
    setDescription(
      Schema.string().default(DEFAULT_API_VERSION),
      desc(
        'Anytype-Version request header value',
        'Anytype-Version 请求头取值',
      ),
    ),
  ),
  disabledGroups: volatileField(
    setDescription(
      Schema.array(Schema.string()).default([]),
      desc(
        'Tool groups to exclude: connection, search, space, object, collection, type, property, member, schema, generic',
        '要停用的工具组：connection、search、space、object、collection、type、property、member、schema、generic',
      ),
    ),
  ),
  requestTimeoutMs: volatileField(
    setDescription(
      Schema.number().default(DEFAULT_REQUEST_TIMEOUT_MS),
      desc('Per-request timeout in milliseconds', '单个请求的超时时间（毫秒）'),
    ),
  ),
  maxResponseChars: volatileField(
    setDescription(
      Schema.number().default(DEFAULT_MAX_RESPONSE_CHARS),
      desc(
        'Truncate tool result text beyond this many characters (protects model context)',
        '工具结果超过该字符数即截断（保护模型上下文）',
      ),
    ),
  ),
});
