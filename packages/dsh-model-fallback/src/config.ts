/**
 * dsh-model-fallback 配置 schema。
 *
 * 命名/默认值对齐 oh-my-pi 的 `retry.*` 子树:
 * - `enabled`: 总开关
 * - `fallbackChains`:候选列表(首项=主模型);用字符串 `provider/model`
 * - `maxRetries`:最多尝试次数;`0` = 等于链长(全跑完才报错,与 omp 默认行为一致)
 * - `baseDelayMs` / `maxDelayMs`:指数退避的初值与上界
 * - `retryableCodes`:视为可重试的失败码(白名单;默认包含 omp 视为可重试的几个稳定码)
 * - `perTurn`:同一次 `llm/stream` 调用内允许的回退次数(`true` = 不限,等价于链长上限)
 *
 * 设计简化(本期不做):
 * - 不区分 role/specificity 的多链(`retry.fallbackChains.<role>`);本期就是"按 provider/model 串行"
 * - 不实现 `fallbackRevertPolicy`(跨回合切回主模型);本期仅在请求内回退
 * - 不实现 provider/* 通配条目;链中每项就是字面 `provider/model`
 *
 * 渲染设置表单:loader 用 schemastery 把本 schema 投影成 GUI(参见 dsh-guided-goal
 * 的 `Config` 导出契约);加载未配置时走 default。
 */

import Schema from '@deepseek-ai/schemastery';

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
  const model = raw.slice(slash + 1);
  if (provider.length === 0 || model.length === 0) {
    return {
      error: `fallbackChains[${index}] = ${JSON.stringify(raw)} has empty provider or model`,
    };
  }
  return { provider, model };
}

/** 解析用户配置:返回最终规整后的可执行结构;非法输入 → 抛出 schema 错误。 */
export interface ResolvedConfig {
  enabled: boolean;
  /** 链中每项的 (provider, model)。首项为主模型;空链=插件不做事。 */
  chain: ReadonlyArray<{ provider: string; model: string }>;
  /** 最大尝试次数;0 = 链长(默认行为) */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableCodes: ReadonlySet<string>;
  perTurn: boolean;
}

export function resolveConfig(input: unknown): ResolvedConfig {
  // schemastery 已校验过类型/默认值;此处做语义校验并派生 retryableCodes Set。
  const raw = input as {
    enabled?: unknown;
    fallbackChains?: unknown;
    maxRetries?: unknown;
    baseDelayMs?: unknown;
    maxDelayMs?: unknown;
    retryableCodes?: unknown;
    perTurn?: unknown;
  };
  const enabled = raw.enabled !== false; // 默认 true
  const chainsInput = Array.isArray(raw.fallbackChains)
    ? (raw.fallbackChains as unknown[])
    : [];
  const chain: Array<{ provider: string; model: string }> = [];
  for (let i = 0; i < chainsInput.length; i++) {
    const entry = chainsInput[i];
    const parsed = parseChainEntry(String(entry ?? ''), i);
    if ('error' in parsed) {
      throw new Error(`Invalid dsh-model-fallback config: ${parsed.error}`);
    }
    chain.push(parsed);
  }
  const chainLen = chain.length;
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
    maxRetries: Math.max(maxRetries, 1), // 至少 1(否则什么都做不了)
    baseDelayMs,
    maxDelayMs,
    retryableCodes,
    perTurn,
  };
}

/** schemastery schema;导出名沿用 dsh 0.2.0 的 `Config` 契约(loader 把其投影为设置表单)。 */
export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description(
      'Enable / disable the fallback interceptor / 是否启用模型回退',
    ),
  fallbackChains: Schema.array(
    Schema.string()
      .required()
      .description(
        'A "provider/model" selector; first entry is the primary model',
      ),
  )
    .default([])
    .description(
      'Ordered fallback chain; first entry is the primary model; subsequent entries are tried in order when the current one fails',
    ),
  maxRetries: Schema.number()
    .default(0)
    .description(
      'Max attempts per request (0 = chain length; i.e. try every configured model before erroring)',
    ),
  baseDelayMs: Schema.number()
    .default(500)
    .description('Initial exponential-backoff delay between attempts (ms)'),
  maxDelayMs: Schema.number()
    .default(30000)
    .description(
      'Upper bound on exponential-backoff delay between attempts (ms)',
    ),
  retryableCodes: Schema.array(Schema.string())
    .default([...DEFAULT_RETRYABLE_CODES])
    .description(
      'Failure codes treated as retryable (whitelist); non-matching codes fall through unchanged',
    ),
  perTurn: Schema.boolean()
    .default(true)
    .description(
      'Within one llm/stream call, allow falling back to the next candidate; if false, fall back is one-shot per request',
    ),
});
