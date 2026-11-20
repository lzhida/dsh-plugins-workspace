/**
 * dsh-patent 配置 schema 与解析。
 *
 * 模式对齐仓库内 dsh-anytype / dsh-llm-fallback：可编辑字段经 volatileField()
 * 包裹才会被宿主设置面板投影；运行时 resolveConfig 深度解包 volatile 引用。
 *
 * 字段：
 * - `enabled`：总开关；false 时工具与 skill 均不注册，prompt section 照常注册
 *   并告知 agent「功能停用」。
 * - `disclosureDefaults`：公司信息默认值（申请人/联系人/电话/邮箱/内部案号）。
 *   模型交付交底书时作为头部字段缺省值；用户显式提供的值优先。全部缺省时
 *   产出占位并提醒用户自行修改。
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

/** 公司信息默认值（交底书头部字段的缺省来源）。 */
export interface DisclosureDefaults {
  /** 申请人（公司/单位名称）。 */
  applicant: string;
  /** 技术问题联系人。 */
  contactName: string;
  /** 联系人电话。 */
  contactPhone: string;
  /** 联系人邮箱。 */
  contactEmail: string;
  /** 内部案号。 */
  internalNo: string;
}

/** resolveConfig 产出的运行时配置（已解包 volatile）。 */
export interface ResolvedConfig {
  /** 总开关；false = 不注册工具与 skill。 */
  enabled: boolean;
  /** 公司信息默认值。 */
  disclosureDefaults: DisclosureDefaults;
}

/** 空串兜底。 */
function str(value: unknown): string {
  const text =
    typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  return text;
}

/**
 * 解析并归一化插件配置。
 *
 * @param input - loader 传入的配置（volatile 引用嵌套或普通值，或 undefined）。
 */
export function resolveConfig(input: unknown): ResolvedConfig {
  const raw = (unwrapVolatile(input) ?? {}) as {
    enabled?: unknown;
    disclosureDefaults?: unknown;
  };
  const defaults = (raw.disclosureDefaults ?? {}) as Record<string, unknown>;
  return {
    enabled: raw.enabled !== false,
    disclosureDefaults: {
      applicant: str(defaults.applicant),
      contactName: str(defaults.contactName),
      contactPhone: str(defaults.contactPhone),
      contactEmail: str(defaults.contactEmail),
      internalNo: str(defaults.internalNo),
    },
  };
}

/** 公司信息默认值字段（volatile + i18n 描述的 string 字段）。 */
function defaultField(en: string, zh: string) {
  return volatileField(
    setDescription(Schema.string().default(''), desc(en, zh)),
  );
}

/**
 * schemastery schema；导出名沿用 `Config` 契约（loader 读取并投影成设置
 * 面板表单；index.ts 必须 re-export）。
 */
export const Config = Schema.object({
  enabled: volatileField(
    setDescription(
      Schema.boolean().default(true),
      desc(
        'Register the patent disclosure tools and skill (off = guidance sections only)',
        '是否注册交底书工具与 skill（关闭后仅保留指引 section）',
      ),
    ),
  ),
  disclosureDefaults: Schema.object({
    applicant: defaultField(
      'Default applicant (company name) for disclosure headers',
      '交底书头部默认申请人（公司名称）',
    ),
    contactName: defaultField(
      'Default technical contact name',
      '默认技术问题联系人',
    ),
    contactPhone: defaultField('Default contact phone', '默认联系人电话'),
    contactEmail: defaultField('Default contact email', '默认联系人邮箱'),
    internalNo: defaultField('Default internal case number', '默认内部案号'),
  }),
});
