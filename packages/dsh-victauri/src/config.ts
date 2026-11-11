/**
 * dsh-victauri 配置 schema 与解析。
 *
 * 模式对齐 monorepo 内 dsh-patent / dsh-llm-fallback：可编辑字段经
 * volatileField() 包裹才会被宿主设置面板投影；运行时 resolveConfig 深度
 * 解包 volatile 引用（本地自包含复刻 cosmokit 全局符号语义）。
 *
 * 字段（五项）：
 * - `appIdentifier`：按 Tauri app bundle id（discovery metadata.identifier）
 *   过滤实例，对应 victauri bridge 的 `--app` 语义；空 = 自动选最新实例。
 * - `portOverride`：固定端口（discovery 中 port 匹配的实例）；空 = 自动。
 * - `cliPath`：victauri CLI 可执行文件路径（`victauri_cli` 工具用）；
 *   空 = 平台默认（win32 `victauri.exe`，其余 `victauri`）。
 * - `requestTimeoutMs`：REST 请求超时毫秒（默认 30000）。
 * - `disabledTools`：不注册的工具全名列表（`victauri_` 前缀全名）。
 */

import Schema from '@deepseek-ai/schemastery';

// ── volatile 支持（本地自包含复刻，与 cosmokit 的全局符号语义一致） ──

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

/** schemastery `meta.description` 的 i18n 映射形态（`''` = 回退文案）。 */
export type SchemaDescription = { '': string } & Partial<
  Record<string, string>
>;

/** 构造设置表单字段描述的 i18n 映射。 */
export function desc(en: string, zh: string): SchemaDescription {
  return { '': en, en, zh };
}

/** 把 i18n 映射写入字段描述（收窄 schemastery 链式声明的滞后）。 */
export function setDescription<F extends { description(text: string): F }>(
  field: F,
  text: SchemaDescription,
): F {
  return field.description(text as unknown as string);
}

// ── 类型 ─────────────────────────────────────────────────────────────

/** resolveConfig 产出的运行时配置（已解包 volatile）。 */
export interface ResolvedVictauriConfig {
  /** 按 bundle id 过滤实例；null = 自动选最新。 */
  appIdentifier: string | null;
  /** 固定端口；null = discovery 自动。 */
  portOverride: number | null;
  /** victauri CLI 路径；null = 平台默认。 */
  cliPath: string | null;
  /** REST 请求超时毫秒。 */
  requestTimeoutMs: number;
  /** 不注册的工具全名（victauri_ 前缀）。 */
  disabledTools: string[];
}

/** 空串兜底。 */
function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text;
}

/** 正整数兜底（非法/缺省回 null）。 */
function posInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  return null;
}

/**
 * 解析并归一化插件配置；非法输入降级为默认（不抛错、不阻塞宿主）。
 *
 * @param input - loader 传入的配置（volatile 引用嵌套或普通值，或 undefined）。
 */
export function resolveConfig(input: unknown): ResolvedVictauriConfig {
  const raw = (unwrapVolatile(input) ?? {}) as Record<string, unknown>;
  const disabled = Array.isArray(raw.disabledTools)
    ? raw.disabledTools.filter(
        (name): name is string => typeof name === 'string' && name !== '',
      )
    : [];
  return {
    appIdentifier: str(raw.appIdentifier),
    portOverride: posInt(raw.portOverride),
    cliPath: str(raw.cliPath),
    requestTimeoutMs: posInt(raw.requestTimeoutMs) ?? 30_000,
    disabledTools: disabled,
  };
}

/** 可空 string 字段（volatile + i18n 描述）。 */
function optionalField(en: string, zh: string) {
  return volatileField(
    setDescription(Schema.string().default(''), desc(en, zh)),
  );
}

/**
 * schemastery schema；导出名沿用 `Config` 契约（loader 读取并投影成设置
 * 面板表单；index.ts 必须 re-export）。
 */
export const Config = Schema.object({
  appIdentifier: optionalField(
    'Filter instances by Tauri app bundle id (victauri bridge --app semantics); empty = pick latest',
    '按 Tauri app bundle id 过滤实例（对应 victauri bridge 的 --app 语义）；留空 = 自动选最新',
  ),
  portOverride: volatileField(
    setDescription(
      Schema.number(),
      desc(
        'Pin the victauri service port (must appear in discovery); empty = auto',
        '固定 victauri 服务端口（须出现在 discovery 中）；留空 = 自动发现',
      ),
    ),
  ),
  cliPath: optionalField(
    'Path to the victauri CLI executable; empty = platform default',
    'victauri CLI 可执行文件路径；留空 = 平台默认（win32 为 victauri.exe）',
  ),
  requestTimeoutMs: volatileField(
    setDescription(
      Schema.number().default(30_000),
      desc(
        'REST request timeout in milliseconds (default 30000)',
        'REST 请求超时毫秒（默认 30000）',
      ),
    ),
  ),
  disabledTools: volatileField(
    setDescription(
      Schema.array(Schema.string()).default([]),
      desc(
        'Tool full names (victauri_ prefix) to skip at registration',
        '不注册的工具全名列表（victauri_ 前缀全名）',
      ),
    ),
  ),
});
