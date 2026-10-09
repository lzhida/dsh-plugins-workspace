/**
 * dsh-llm-fallback 配置 schema。
 *
 * 命名/默认值对齐 oh-my-pi 的 `retry.*` 子树:
 * - `enabled`: 总开关
 * - `fallbackChains`:候选列表(首项=主模型);数组项可为
 *     - `string`(旧 0.2.x 形态,`'provider/model'`,自动归一化为对象)或
 *     - `object`(`{provider, model, displayName?, description?}`,可在 dsh 设置
 *       面板里展示为可读条目;若 dsh 前端支持 `modelList` role 则渲染为模型
 *       复选框 + 拖拽排序的 picker)
 * - `fallbackWhen`:回退时机——`afterRetry`(默认)= 官方 dsh-llm-retry 等上游
 *   恢复器仍在预算内决定同 provider 重试时透传其决策,耗尽/委派后才切下一候选;
 *   `immediately` = 一次失败立即切换,不等上游
 * - `maxRetries`:单次请求最多**切换**次数(链上换候选的次数,不含同 provider 重试);
 *   `0` = 等于链长(全跑完才报错,与 omp 默认行为一致)
 * - `baseDelayMs` / `maxDelayMs`:指数退避的初值与上界;`0` = 禁用退避(失败后立即切换)
 * - `retryableCodes`:视为可重试的失败码(白名单;默认包含 omp 视为可重试的几个稳定码)
 * - `perTurn`:同一 step(`turn:step`)内是否允许多次切换;`false` = 至多切换一次(one-shot)
 *
 * 设计简化(本期不做):
 * - 不区分 role/specificity 的多链(`retry.fallbackChains.<role>`);本期就是"按 provider/model 串行"
 * - 不实现 `fallbackRevertPolicy`(跨回合切回主模型);本期仅在请求内回退
 * - 不实现 provider/* 通配条目;链中每项就是字面 `provider/model`
 *
 * 渲染设置表单:loader 用 schemastery 把本 schema 投影成 GUI(参见 dsh-guided-goal
 * 的 `Config` 导出契约);`fallbackChains` 挂 `role('modelList', ...)` 给 dsh
 * 前端 `SettingsValueField` 提供 picker 渲染提示(若前端不识别此 role,降级为
 * 默认对象数组输入框,功能不受影响)。
 */

import Schema from '@deepseek-ai/schemastery';

// ── volatile(设置面板可编辑字段)支持 ────────────────────────────────
//
// dsh 的设置面板只投影 **`.volatile()` 标记**的字段:
// `@deepseek-ai/dsh-settings` 的 `describe()` 用 `volatileForm(schema)` 过滤,
// 没有 volatile 字段的条目会被整个丢弃(设置面板不出现该插件,写入还会拒绝
// "Plugin entry X has no volatile fields")。因此本插件的可编辑字段都用
// `.volatile()` 包裹——代价是运行时拿到的是 `Volatile` 引用而非普通值,
// 读取前必须解包(见 unwrapVolatile)。
//
// 判定协议:`Symbol.for('cosmokit.volatile.write')` 是跨模块副本稳定的全局符号
// (cosmokit 的 isVolatile 即 `write in value`),故本地复刻不引入额外依赖。

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/** 是否为 cosmokit volatile 配置引用(可 get() 取当前值)。 */
export function isVolatileLike(
  value: unknown,
): value is { get: () => unknown } {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value;
}

/** 深度解包 volatile 引用,得到普通值(数组/对象逐层递归)。 */
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

/**
 * 若字段支持 volatile 则标记之,否则原样返回。
 * 守卫写法与社区插件(dsh-context)一致,兼容未被 schemastery 增强的实现。
 */
export function volatileField<T extends { volatile?: unknown }>(field: T): T {
  const volatile = field.volatile;
  return typeof volatile === 'function'
    ? (volatile as () => T).call(field)
    : field;
}

/** `fallbackWhen` 的合法取值。 */
export const FALLBACK_WHEN_VALUES = ['afterRetry', 'immediately'] as const;

/** 回退时机:afterRetry = 官方重试耗尽后才切;immediately = 一次失败即切。 */
export type FallbackWhen = (typeof FALLBACK_WHEN_VALUES)[number];

/** 退避延迟的下限语义:0 = 禁用退避;负数/非有限数在 resolveConfig 中回落默认值。 */

/** 默认视为可重试的稳定失败码。 */
export const DEFAULT_RETRYABLE_CODES: readonly string[] = [
  'RATE_LIMIT',
  'QUOTA',
  'ACCOUNT_QUOTA',
  'CONTEXT_WINDOW_EXCEEDED',
  'EMPTY_RESPONSE',
  'SERVER_ERROR',
  'TIMEOUT',
  'NETWORK',
] as const;

/** 单条回退链项的规整形态:内部统一用此形态。 */
export interface ChainEntry {
  provider: string;
  model: string;
  /** 展示名(用户在 dsh 设置面板里看到的标签);缺省回填 `${provider}/${model}`。 */
  displayName: string;
  /** 备注(可选);前端可作为副标题或 tooltip。 */
  description: string;
}

/** 校验并规范化一条链项:`provider/model` 形式,且两段均非空。 */
export function parseChainEntry(
  raw: string,
  index: number,
): { provider: string; model: string } | { error: string } {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { error: `fallbackChains[${index}] must be a non-empty string` };
  }
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) {
    return {
      error: `fallbackChains[${index}] = ${JSON.stringify(raw)} is not in "provider/model" form`,
    };
  }
  const provider = raw.slice(0, slash);
  const model = raw.slice(1 + slash);
  if (provider.length === 0 || model.length === 0) {
    return {
      error: `fallbackChains[${index}] = ${JSON.stringify(raw)} has empty provider or model`,
    };
  }
  return { provider, model };
}

/**
 * 把任一形态(string 或 object)归一为 ChainEntry。
 * 失败时返回 `{error}`,与 parseChainEntry 风格一致。
 */
export function normalizeChainEntry(
  raw: unknown,
  index: number,
): ChainEntry | { error: string } {
  if (typeof raw === 'string') {
    const parsed = parseChainEntry(raw, index);
    if ('error' in parsed) return parsed;
    return {
      provider: parsed.provider,
      model: parsed.model,
      displayName: `${parsed.provider}/${parsed.model}`,
      description: '',
    };
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as {
      provider?: unknown;
      model?: unknown;
      displayName?: unknown;
      description?: unknown;
    };
    const provider = typeof obj.provider === 'string' ? obj.provider : '';
    const model = typeof obj.model === 'string' ? obj.model : '';
    if (provider.length === 0 || model.length === 0) {
      return {
        error: `fallbackChains[${index}] object must have non-empty "provider" and "model"`,
      };
    }
    return {
      provider,
      model,
      displayName:
        typeof obj.displayName === 'string' && obj.displayName.length > 0
          ? obj.displayName
          : `${provider}/${model}`,
      description: typeof obj.description === 'string' ? obj.description : '',
    };
  }
  return {
    error: `fallbackChains[${index}] must be a string or object`,
  };
}

/** 解析用户配置:返回最终规整后的可执行结构;非法输入 → 抛出 schema 错误。 */
export interface ResolvedConfig {
  enabled: boolean;
  /** 链中每项的 (provider, model)。首项为主模型;空链=插件不做事。 */
  chain: ReadonlyArray<{ provider: string; model: string }>;
  /** 链中每项的规整形态(含 displayName / description);state 不直接用,留作未来扩展。 */
  entries: ReadonlyArray<ChainEntry>;
  /** 回退时机;默认 afterRetry(官方重试耗尽后再切)。 */
  fallbackWhen: FallbackWhen;
  /** 最大尝试次数;0 = 链长(默认行为) */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableCodes: ReadonlySet<string>;
  perTurn: boolean;
}

/** 规整 fallbackWhen:仅接受字面 'immediately',其余(含非法值)回落 afterRetry。 */
export function resolveFallbackWhen(input: unknown): FallbackWhen {
  return input === 'immediately' ? 'immediately' : 'afterRetry';
}

export function resolveConfig(input: unknown): ResolvedConfig {
  // schemastery 已校验过类型/默认值;此处做语义校验并派生 retryableCodes Set。
  // 兼容 loader 在用户尚未填过任何配置时传入 undefined / null 的场景——视为空对象,
  // 与 Config schema 的 .default() 默认值以及 src/index.ts:101 的契约保持一致。
  // 后续对 raw.X 的访问都通过 !== false / Array.isArray / ?? / String(...) 等守卫
  // 兜底,不会因为放宽入口而引入新 deref 风险。
  // 字段均为 volatile(设置面板可编辑),运行时收到的是 Volatile 引用;
  // 先深度解包成普通值再走原有语义校验/归一化。
  const raw = (unwrapVolatile(input) ?? {}) as {
    enabled?: unknown;
    fallbackChains?: unknown;
    fallbackWhen?: unknown;
    maxRetries?: unknown;
    baseDelayMs?: unknown;
    maxDelayMs?: unknown;
    retryableCodes?: unknown;
    perTurn?: unknown;
  };
  const enabled = raw.enabled !== false; // 默认 true
  // fallbackChains 接受形态:旧 string[]('provider/model')与新 Object[] 混用;
  // 内部统一归一为 ChainEntry,业务只读 chain(provider+model)。
  const chainsInput = Array.isArray(raw.fallbackChains)
    ? (raw.fallbackChains as unknown[])
    : [];
  const entries: ChainEntry[] = [];
  for (let i = 0; i < chainsInput.length; i++) {
    const item = chainsInput[i];
    const norm = normalizeChainEntry(item, i);
    if ('error' in norm) {
      throw new Error(`Invalid dsh-llm-fallback config: ${norm.error}`);
    }
    entries.push(norm);
  }
  const chain: Array<{ provider: string; model: string }> = entries.map(
    (e) => ({ provider: e.provider, model: e.model }),
  );
  const chainLen = chain.length;
  const fallbackWhen = resolveFallbackWhen(raw.fallbackWhen);
  const maxRetriesRaw = Number(raw.maxRetries ?? 0);
  const maxRetries = maxRetriesRaw > 0 ? Math.floor(maxRetriesRaw) : chainLen;
  const baseDelayMsRaw = Number(raw.baseDelayMs ?? 500);
  const baseDelayMs =
    Number.isFinite(baseDelayMsRaw) && baseDelayMsRaw > 0
      ? Math.floor(baseDelayMsRaw)
      : 500;
  const maxDelayMsRaw = Number(raw.maxDelayMs ?? 30000);
  const maxDelayMs =
    Number.isFinite(maxDelayMsRaw) && maxDelayMsRaw > 0
      ? Math.floor(maxDelayMsRaw)
      : 30000;
  const codesRaw = Array.isArray(raw.retryableCodes)
    ? (raw.retryableCodes as unknown[]).map((c) => String(c))
    : [...DEFAULT_RETRYABLE_CODES];
  const retryableCodes = new Set(codesRaw);
  const perTurn = raw.perTurn !== false; // 默认 true

  return {
    enabled,
    chain,
    entries,
    fallbackWhen,
    maxRetries: Math.max(maxRetries, 1), // 至少 1(否则什么都做不了)
    baseDelayMs,
    maxDelayMs,
    retryableCodes,
    perTurn,
  };
}

/** 单条链项的 schemastery schema(供 Config 与未来 re-use)。 */
const ChainEntrySchema = Schema.object({
  provider: Schema.string()
    .required()
    .description('Provider route key (e.g. "deepseek", "openai", "anthropic")'),
  model: Schema.string()
    .required()
    .description(
      'Model id within the provider (e.g. "deepseek-chat", "gpt-4o")',
    ),
  displayName: Schema.string().description(
    'Display label shown in the settings UI; defaults to "provider/model" if omitted',
  ),
  description: Schema.string().description(
    'Optional note shown as a subtitle or tooltip in the settings UI',
  ),
});

/**
 * schemastery schema;导出名沿用 dsh 0.2.0 的 `Config` 契约(loader 把其投影为设置表单)。
 *
 * 每个字段都经 `volatileField()` 包裹 → 宿主 `dsh-settings.describe()` 才认它
 * 是"可在设置面板里编辑的即时配置"(无 volatile 字段的条目会被整个丢弃)。
 * 运行时因此收到 `Volatile` 引用,`resolveConfig` 负责解包。
 */
export const Config = Schema.object({
  enabled: volatileField(
    Schema.boolean()
      .default(true)
      .description(
        'Enable / disable the fallback interceptor / 是否启用模型回退',
      ),
  ),
  // 设置面板里由本插件自带的 client 卡片渲染为"模型勾选 + 排序"队列
  // (候选池来自 ctx.remote.session.modelCatalog)。
  // 旧 0.2.x 的 `string[]` 形态(每项为 "provider/model")在 resolveConfig 端被兼容解析,
  // 持久化形态(写到 cordis.yml / settings)是 Object[]。
  fallbackChains: volatileField(
    Schema.array(ChainEntrySchema)
      .default([])
      .role('modelList', { source: 'dsh-llm-runtime' })
      .description(
        'Ordered fallback chain; first entry is the primary model; subsequent entries are tried in order when the current one fails',
      ),
  ),
  fallbackWhen: volatileField(
    Schema.union([...FALLBACK_WHEN_VALUES])
      .default('afterRetry')
      .description(
        'When to switch to the next candidate: "afterRetry" (default) only falls back after the official dsh-llm-retry executor exhausts its budget; "immediately" switches on the first retryable failure',
      ),
  ),
  maxRetries: volatileField(
    Schema.number()
      .default(0)
      .role('modelChainMeta', { kind: 'retries' })
      .description(
        'Max attempts per request (0 = chain length; i.e. try every configured model before erroring)',
      ),
  ),
  baseDelayMs: volatileField(
    Schema.number()
      .default(500)
      .description('Initial exponential-backoff delay between attempts (ms)'),
  ),
  maxDelayMs: volatileField(
    Schema.number()
      .default(30000)
      .description(
        'Upper bound on exponential-backoff delay between attempts (ms)',
      ),
  ),
  retryableCodes: volatileField(
    Schema.array(Schema.string())
      .default([...DEFAULT_RETRYABLE_CODES])
      .description(
        'Failure codes treated as retryable (whitelist); non-matching codes fall through unchanged',
      ),
  ),
  perTurn: volatileField(
    Schema.boolean()
      .default(true)
      .description(
        'Within one llm/stream call, allow falling back to the next candidate; if false, fall back is one-shot per request',
      ),
  ),
});
