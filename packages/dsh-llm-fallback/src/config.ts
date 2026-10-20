/**
 * dsh-llm-fallback 配置 schema。
 *
 * 命名/默认值对齐 oh-my-pi 的 `retry.*` 子树:
 * - `enabled`: 总开关
 * - `fallbackChains`:纯回退候选队列(**不含主模型**——会话页面指定的
 *     provider/model 就是事实主模型,失败后按队列顺序切换);数组项可为
 *     - `string`(旧 0.2.x 形态,`'provider/model'`,自动归一化为对象)或
 *     - `object`(`{provider, model, displayName?, description?}`,可在 dsh 设置
 *       面板里展示为可读条目;若 dsh 前端支持 `modelList` role 则渲染为模型
 *       复选框 + 拖拽排序的 picker)
 * - `retriesBeforeSwitch`:每候选重试次数——当前候选(含会话指定模型)在切换到
 *   下一候选前允许的同 provider 重试次数(0.5.0 起取代旧 fallbackWhen 两档):
 *   - `0`(默认)= 自动跟随官方 `dsh-llm-retry` 预算(provider retryPolicy 的
 *     `maxRetries`,宿主默认 5);预算内透传官方决策,耗尽后切换。无预算信息
 *     (policy 缺失)时视为 0——首失败即切,与旧 afterRetry 在未装官方插件时
 *     的语义一致;
 *   - `N > 0` = **以插件配置为准**:重试 N 次后才切,不再被 provider 预算封顶。
 *     N 大于官方预算时,预算内由官方 `dsh-llm-retry` 执行重试(本插件透传其
 *     决策),超出的部分由本插件代执行(自带退避 + 官方 `llm/retry` 轨迹事件),
 *     直到 N 用满才切下一候选。provider retryPolicy 本身可编辑(llm-deepseek
 *     顶层 volatile 字段 / llm-pi-ai 的 providers.<id>.retryPolicy,保存即经
 *     loader/volatile-update 热更新),自动档因此天然跟随 provider 侧调整;
 *   - `always` 模式策略(无限重试、无 maxRetries):自动档整体透传官方决策
 *     (永不提前切),自定义档按 N 切(超出 N 后覆盖官方 retry)。
 * - `maxRetries`:单次请求最多**切换候选**次数(不含同候选重试);
 *   `0` = 链长(会话模型失败后可依次切完整个队列才报错)
 * - `baseDelayMs` / `maxDelayMs`:指数退避的初值与上界;`0` = 禁用退避(失败后立即重试/切换)
 * - `cooldownEnabled` / `cooldownMs`:失败候选冷却跳过(默认开,300000ms = 5 分钟)——
 *   白名单失败耗尽每候选重试预算并切换后,失败方(provider+model)进入冷却窗:
 *   窗口内后续 step 不再从它开始(`agent/request` 直接改写为链上第一个可用候选,
 *   即"从下一个回退模型或此前验证可用的候选开始"),窗口期满自动恢复优先级并
 *   重新验证是否恢复;剩余候选全部在冷却中时退回原语义(冷却绝不吞掉全部候选);
 *   非白名单失败与预算内的同候选重试不记冷却
 * - `retryableCodes`:视为可重试的失败码(白名单;默认对齐 dsh 宿主官方重试码
 *   `dsh-llm` 的 DEFAULT_RETRYABLE_CODES,并保留配额/上下文类超集)
 * - `perTurn`:同一 step(`turn:step`)内是否允许多次切换;`false` = 至多切换一次(one-shot)
 *
 * 主模型语义(0.5.0 起):插件配置里没有"主模型"——dsh 会话页面指定的模型
 * 就是事实主模型。回退推进时自动跳过与会话模型相同的队列项(用户把会话模型
 * 也勾进队列的防呆),旧"首项=主模型"的存量配置因此零迁移、行为不劣化。
 *
 * 设计简化(本期不做):
 * - 不区分 role/specificity 的多链(`retry.fallbackChains.<role>`);本期就是"按 provider/model 串行"
 * - 不实现 `fallbackRevertPolicy`(同一 step 链耗尽后切回会话指定模型);回退状态
 *   以 `turn:step` 为 key,新 step 天然从会话指定模型重新开始
 * - 不实现 provider/* 通配条目;链中每项就是字面 `provider/model`
 *
 * 渲染设置表单:loader 用 schemastery 把本 schema 投影成 GUI(插件导出
 * `Config` 契约);`fallbackChains` 挂 `role('modelList', ...)` 给 dsh
 * 前端 `SettingsValueField` 提供 picker 渲染提示(若前端不识别此 role,降级为
 * 默认对象数组输入框,功能不受影响)。
 *
 * 国际化(0.3.3):所有字段的 `meta.description` 均为 schemastery i18n 映射
 * `{ '': 英文默认, zh: 中文, en: 英文 }`——与 schemastery 内置 `Schema.i18n()`
 * /`mergeDesc` 的形态一致(`''` 键 = 不认识 i18n 映射的旧渲染端回退文案)。
 * 宿主 `@deepseek-ai/dsh-settings` 的 `describe()` 以 `form.toJSON()` 原样下发
 * 该映射,前端按当前激活语言(dsh 语言配置:Host 偏好 settings 命名空间
 * `locale` 字段 `preference` → 浏览器语言 → en,与 dsh-client-locale 内置语言
 * 目录 LOCALE_IDS `['zh','en']` 对齐)解析显示;语言键不与服务端绑定,换语言
 * 无需重载插件。
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

/** `retriesBeforeSwitch` 的默认值:0 = 自动跟随官方重试预算(见文件头语义说明)。 */
export const DEFAULT_RETRIES_BEFORE_SWITCH = 0;

/**
 * `cooldownMs` 的默认值:失败候选的冷却窗口,5 分钟。
 * 窗口内后续 step 不再从该模型开始(直接用下一个可用候选),窗口期满
 * 自动恢复其优先级并重新验证是否恢复——额度按时间周期重置的套餐
 * (如每 5 小时重置)通常在分钟级内不会恢复,5 分钟兼顾效率与优先级。
 */
export const DEFAULT_COOLDOWN_MS = 300_000;

/**
 * schemastery `meta.description` 的 i18n 映射形态。
 * `''` 键 = 默认文案(英文;旧渲染端不识别映射时原样显示),其余键为
 * BCP 47 语言 id(`zh` / `en` 与 dsh 客户端内置语言目录对齐)。
 */
export type SchemaDescription = { '': string } & Partial<
  Record<string, string>
>;

/**
 * 构造设置表单字段描述的 i18n 映射。
 *
 * - `en` 同时写入 `''` 与 `en` 键:`''` 是 schemastery `mergeDesc` 语义下的
 *   默认回退文案,保证不识别映射的渲染端(旧宿主 / 纯文本投影)看到的仍是
 *   改造前的英文描述,行为零回归;
 * - `zh` 是中文文案,由前端 locale 服务按激活语言解析;
 * - dsh 客户端当前内置语言只有 `zh` / `en`(dsh-client-locale 的
 *   LOCALE_IDS),新增语言时宿主回退链会落到 `en`,无需本插件参与。
 *
 * @param en - 英文描述(默认文案)。
 * @param zh - 中文描述。
 * @returns 可 JSON 序列化的描述映射(经 settings.describe 的 toJSON 下发)。
 */
export function desc(en: string, zh: string): SchemaDescription {
  return { '': en, en, zh };
}

/**
 * 把 i18n 映射写入字段描述(schemastery 官方 Meta 类型允许
 * `description?: string | Dict<string>`,见其类型声明 Schemastery.Meta;
 * 但链式方法 `description(text: string)` 的参数声明滞后——方法体只是把值
 * 原样写入 meta.description,运行时与宿主前端的 mergeDesc/resolveText 均
 * 按映射处理)。全仓唯一断言点,收窄该声明滞后。
 *
 * @param field - 待描述的 schema 节点(链式构造中的当前值)。
 * @param text - desc() 产出的 i18n 映射。
 * @returns 同一 schema 节点(保持链式语义,meta.description 已写入映射)。
 */
function setDescription<F extends { description(text: string): F }>(
  field: F,
  text: SchemaDescription,
): F {
  return field.description(text as unknown as string);
}

/** 退避延迟的下限语义:0 = 禁用退避;负数/非有限数在 resolveConfig 中回落默认值。 */

/**
 * 默认视为可重试的稳定失败码。
 *
 * 码表对齐 dsh 宿主的失败分类(宿主 0.2.0-rc.2 实装代码):
 * - `SERVER`——5xx 服务器错误(deepseek 适配器与 pi-ai 适配器的 `classifyPiAiError` 均产出);
 * - `TRANSPORT`——连接类传输失败(openai / @anthropic-ai/sdk 的 `APIConnectionError`,
 *   即 "Connection error.",以及 socket / fetch / 网络中断),宿主官方
 *   `dsh-llm/lib/types/retry-policy.js` 的默认重试码含 `SERVER` 与 `TRANSPORT`;
 * - 相比宿主官方默认(EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT)
 *   额外保留 QUOTA / ACCOUNT_QUOTA / CONTEXT_WINDOW_EXCEEDED——切模型是配额类
 *   失败的本职出路,属本插件的有意超集;
 * - `UNSUPPORTED_REASONING_EFFORT`——deepseek Messages 与 pi-ai 适配器在请求
 *   构建期(网络 I/O 之前)校验 reasoning effort,模型不支持时抛出(消息形如
 *   `provider "X" model "Y" does not support reasoning effort "Z"`)。该失败
 *   对同一模型是确定性的——同 provider 重试必然复现(宿主官方重试码表因此
 *   不含它),切到可能支持该 effort 的下一候选是唯一有意义的恢复路径。
 * - `UNKNOWN_MODEL`——pi-ai 适配器对配置中不存在的模型在请求构建期抛出
 *   (`pi-ai provider "X" has no configured model "Y"`):用户在 dsh 侧删除
 *   模型或改其 id 后,回退队列残留的失效候选必然命中此码。与
 *   UNSUPPORTED_REASONING_EFFORT 同理是确定性失败——同候选重试必然复现,
 *   切到下一候选是唯一有意义的恢复路径;不加它则链推进透传上游,整链在
 *   失效候选上中断。注意边界:网关侧(非本地配置)的模型不存在按 HTTP
 *   状态/消息分类为 INVALID_REQUEST(400)或 PI_AI_ERROR(404),不在此
 *   白名单——INVALID_REQUEST 太宽泛(真 400 参数错误会被无意义切换),
 *   该场景由客户端失效标记 + 显式保存剔除兜底。
 *
 * 历史:0.3.1 及之前默认含 omp 系码 `NETWORK` / `SERVER_ERROR`,宿主两套适配器
 * 均不产出这两个码,导致 "Connection error."(`TRANSPORT`)与 5xx(`SERVER`)
 * 不触发切换;0.3.2 起修正,并对存量用户配置做旧码→新码的并集别名
 * (见 RETRYABLE_CODE_ALIASES)。0.4.1 补入 `UNSUPPORTED_REASONING_EFFORT`。
 * 0.6.0 补入 `UNKNOWN_MODEL`(失效候选兜底)。
 */
export const DEFAULT_RETRYABLE_CODES: readonly string[] = [
  'RATE_LIMIT',
  'QUOTA',
  'ACCOUNT_QUOTA',
  'CONTEXT_WINDOW_EXCEEDED',
  'EMPTY_RESPONSE',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'UNSUPPORTED_REASONING_EFFORT',
  'UNKNOWN_MODEL',
] as const;

/**
 * 存量配置兼容:旧默认白名单码(omp 系命名)→ 宿主实际失败码。
 * resolveConfig 解析用户自定义 retryableCodes 时按并集补入别名码
 * (旧码保留无害——宿主适配器从不产出它们)。
 */
export const RETRYABLE_CODE_ALIASES: Readonly<Record<string, string>> = {
  NETWORK: 'TRANSPORT',
  SERVER_ERROR: 'SERVER',
};

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
  /** 纯回退候选队列(不含主模型——会话页面指定的模型即事实主模型);空链=插件不做事。 */
  chain: ReadonlyArray<{ provider: string; model: string }>;
  /** 链中每项的规整形态(含 displayName / description);state 不直接用,留作未来扩展。 */
  entries: ReadonlyArray<ChainEntry>;
  /**
   * 每候选重试次数(切换前允许的同 provider 重试数);`0` = 自动跟随官方
   * dsh-llm-retry 预算;`>0` 以插件配置为准。运行时与 provider retryPolicy
   * 的合成(谁执行/代执行判定)见 state.ts 的 resolveCandidateRetryPlan。
   */
  retriesBeforeSwitch: number;
  /** 单次请求最多切换候选次数;0 = 链长(默认行为) */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /**
   * 失败候选冷却跳过总开关(默认开):白名单失败耗尽每候选重试预算并
   * 切换后,失败方在 cooldownMs 内不再作为后续 step 的起点或推进目标,
   * 直接从下一个可用候选开始;窗口期满自动恢复优先级(重新验证)。
   * 关闭后行为与旧版完全一致(每 step 都从会话指定模型重新开始)。
   */
  cooldownEnabled: boolean;
  /** 冷却窗口时长(毫秒);`0` = 立即过期(等效禁用)。 */
  cooldownMs: number;
  retryableCodes: ReadonlySet<string>;
  perTurn: boolean;
}

/**
 * 规整 retriesBeforeSwitch:仅接受非负有限数(向下取整);负数/非有限数/NaN
 * 一律回落 0(自动跟随官方预算)。运行时预算的执行者/代执行判定见 state.ts
 * 的 resolveCandidateRetryPlan(N>0 时以本值为准),此处只做输入防御。
 */
export function resolveRetriesBeforeSwitch(input: unknown): number {
  const raw = Number(input ?? DEFAULT_RETRIES_BEFORE_SWITCH);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_RETRIES_BEFORE_SWITCH;
  return Math.floor(raw);
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
    retriesBeforeSwitch?: unknown;
    maxRetries?: unknown;
    baseDelayMs?: unknown;
    maxDelayMs?: unknown;
    cooldownEnabled?: unknown;
    cooldownMs?: unknown;
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
  const retriesBeforeSwitch = resolveRetriesBeforeSwitch(
    raw.retriesBeforeSwitch,
  );
  const maxRetriesRaw = Number(raw.maxRetries ?? 0);
  const maxRetries = maxRetriesRaw > 0 ? Math.floor(maxRetriesRaw) : chainLen;
  // 0 = 禁用退避(失败后立即切换),与文件头文档一致;非法/负值回落默认。
  const baseDelayMsRaw = Number(raw.baseDelayMs ?? 500);
  const baseDelayMs =
    Number.isFinite(baseDelayMsRaw) && baseDelayMsRaw >= 0
      ? Math.floor(baseDelayMsRaw)
      : 500;
  const maxDelayMsRaw = Number(raw.maxDelayMs ?? 30000);
  const maxDelayMs =
    Number.isFinite(maxDelayMsRaw) && maxDelayMsRaw >= 0
      ? Math.floor(maxDelayMsRaw)
      : 30000;
  // 冷却跳过:默认启用;时长非法(负数/非有限)回落默认,0 = 立即过期
  // (等效禁用,合法值——用户显式选择"每次都重新验证")。
  const cooldownEnabled = raw.cooldownEnabled !== false; // 默认 true
  const cooldownMsRaw = Number(raw.cooldownMs ?? DEFAULT_COOLDOWN_MS);
  const cooldownMs =
    Number.isFinite(cooldownMsRaw) && cooldownMsRaw >= 0
      ? Math.floor(cooldownMsRaw)
      : DEFAULT_COOLDOWN_MS;
  const codesRaw = Array.isArray(raw.retryableCodes)
    ? (raw.retryableCodes as unknown[]).map((c) => String(c))
    : [...DEFAULT_RETRYABLE_CODES];
  const retryableCodes = new Set(codesRaw);
  // 存量配置兼容:旧默认码(NETWORK / SERVER_ERROR)按并集补入宿主实际码
  // (TRANSPORT / SERVER),让升级前保存过自定义白名单的用户无需手动改配置。
  for (const code of codesRaw) {
    const alias = RETRYABLE_CODE_ALIASES[code];
    if (alias !== undefined) retryableCodes.add(alias);
  }
  const perTurn = raw.perTurn !== false; // 默认 true

  return {
    enabled,
    chain,
    entries,
    retriesBeforeSwitch,
    maxRetries: Math.max(maxRetries, 1), // 至少 1(否则什么都做不了)
    baseDelayMs,
    maxDelayMs,
    cooldownEnabled,
    cooldownMs,
    retryableCodes,
    perTurn,
  };
}

/** 单条链项的 schemastery schema(供 Config 与未来 re-use)。 */
const ChainEntrySchema = Schema.object({
  provider: setDescription(
    Schema.string().required(),
    desc(
      'Provider route key (e.g. "deepseek", "openai", "anthropic")',
      'Provider 路由键(如 "deepseek"、"openai"、"anthropic")',
    ),
  ),
  model: setDescription(
    Schema.string().required(),
    desc(
      'Model id within the provider (e.g. "deepseek-chat", "gpt-4o")',
      'provider 内的模型 id(如 "deepseek-chat"、"gpt-4o")',
    ),
  ),
  displayName: setDescription(
    Schema.string(),
    desc(
      'Display label shown in the settings UI; defaults to "provider/model" if omitted',
      '设置界面里显示的名称;缺省回填 "provider/model"',
    ),
  ),
  description: setDescription(
    Schema.string(),
    desc(
      'Optional note shown as a subtitle or tooltip in the settings UI',
      '可选备注,设置界面里作为副标题或提示展示',
    ),
  ),
});

/**
 * schemastery schema;导出名沿用 dsh 0.2.0 的 `Config` 契约(loader 把其投影为设置表单)。
 *
 * 每个字段都经 `volatileField()` 包裹 → 宿主 `dsh-settings.describe()` 才认它
 * 是"可在设置面板里编辑的即时配置"(无 volatile 字段的条目会被整个丢弃)。
 * 运行时因此收到 `Volatile` 引用,`resolveConfig` 负责解包。
 * 字段描述经 `setDescription(..., desc(en, zh))` 携带 i18n 映射(见文件头
 * "国际化"注释),前端按 dsh 语言配置解析。
 */
export const Config = Schema.object({
  enabled: volatileField(
    setDescription(
      Schema.boolean().default(true),
      desc(
        'Enable / disable the fallback interceptor',
        '是否启用模型回退(关闭后不再拦截模型失败)',
      ),
    ),
  ),
  // 设置面板里由本插件自带的 client 卡片渲染为"模型勾选 + 排序"队列
  // (候选池来自 ctx.remote.session.modelCatalog)。
  // 旧 0.2.x 的 `string[]` 形态(每项为 "provider/model")在 resolveConfig 端被兼容解析,
  // 持久化形态(写到 cordis.yml / settings)是 Object[]。
  fallbackChains: volatileField(
    setDescription(
      Schema.array(ChainEntrySchema)
        .default([])
        .role('modelList', { source: 'dsh-llm-runtime' }),
      desc(
        'Ordered fallback candidates — the model selected in the session UI is the primary and is not configured here; tried in order when the session model fails',
        '回退候选队列(不含主模型——会话页面指定的模型即事实主模型),失败后按顺序切换',
      ),
    ),
  ),
  retriesBeforeSwitch: volatileField(
    setDescription(
      Schema.number()
        .default(DEFAULT_RETRIES_BEFORE_SWITCH)
        .role('modelChainMeta', { kind: 'retries' }),
      desc(
        'Same-provider retries allowed per candidate before switching to the next: 0 (default) follows the official dsh-llm-retry budget (provider retryPolicy.maxRetries, host default 5); N > 0 is authoritative — retry the current candidate N times first, the plugin performs any retries beyond the official budget itself',
        '每个候选在切换前允许的同 provider 重试次数:0(默认)= 跟随官方 dsh-llm-retry 重试预算(provider retryPolicy.maxRetries,宿主默认 5);N>0 = 以插件配置为准,当前候选重试 N 次后才切换,超出官方预算的部分由本插件代执行重试',
      ),
    ),
  ),
  maxRetries: volatileField(
    setDescription(
      Schema.number().default(0).role('modelChainMeta', { kind: 'retries' }),
      desc(
        'Max candidate switches per request (0 = queue length; i.e. try every candidate before erroring). Bounds chain switches only — same-candidate retries are governed by retriesBeforeSwitch',
        '单次请求最多切换候选次数(0 = 队列长度,即切完所有候选才报错);只限切换次数,同候选重试次数由 retriesBeforeSwitch 控制',
      ),
    ),
  ),
  baseDelayMs: volatileField(
    setDescription(
      Schema.number().default(500),
      desc(
        'Initial exponential-backoff delay between attempts (ms)',
        '两次尝试之间指数退避的初值(毫秒)',
      ),
    ),
  ),
  maxDelayMs: volatileField(
    setDescription(
      Schema.number().default(30000),
      desc(
        'Upper bound on exponential-backoff delay between attempts (ms)',
        '两次尝试之间指数退避的上限(毫秒)',
      ),
    ),
  ),
  cooldownEnabled: volatileField(
    setDescription(
      Schema.boolean().default(true),
      desc(
        'Cooldown skip for recently failed models: after a candidate exhausts its retry budget and the chain switches away, subsequent requests skip it for a short window and start from the next healthy candidate instead; when the window expires the model automatically returns to its priority position and is re-verified (balances priority vs efficiency)',
        '失败候选冷却跳过:候选重试预算耗尽切换后,短时间内后续请求不再从它开始,直接改用链上下一个可用候选;窗口期满该模型自动恢复优先级并重新验证是否恢复(平衡优先级与效率,避免每次都从头试错拉长对话)',
      ),
    ),
  ),
  cooldownMs: volatileField(
    setDescription(
      Schema.number().default(DEFAULT_COOLDOWN_MS),
      desc(
        'Cooldown window in ms for a failed model before it is re-verified and restored to its priority position (0 = expire immediately, i.e. disabled)',
        '失败模型的冷却窗口时长(毫秒),窗口过后自动重新验证并恢复其优先级(0 = 立即过期,等效禁用)',
      ),
    ),
  ),
  retryableCodes: volatileField(
    setDescription(
      Schema.array(Schema.string()).default([...DEFAULT_RETRYABLE_CODES]),
      desc(
        'Failure codes treated as retryable (whitelist); non-matching codes fall through unchanged',
        '视为可重试的失败码白名单;未命中的失败码原样上抛',
      ),
    ),
  ),
  perTurn: volatileField(
    setDescription(
      Schema.boolean().default(true),
      desc(
        'Within one llm/stream call, allow falling back to the next candidate; if false, fall back is one-shot per request',
        '同一次 llm/stream 调用内允许多次切换;false = 每次请求至多切换一次',
      ),
    ),
  ),
});
