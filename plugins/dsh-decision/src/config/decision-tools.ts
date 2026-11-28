/**
 * decision-tools 插件行配置面（决策工具系列 2/11）。
 *
 * 契约来源：docs/decision-tools-contract.md §6（配置字段表）。
 * 与 ask-gate 的 core/config.ts 完全独立——两行字段不同、语义不同：
 * ask-gate 是 fail-open 门控，本行是 fail-closed 显式报错（契约 §0）。
 *
 * 字段盘点（33 项，全部 volatileField + desc(en, zh)）：
 * - 模型接口 4 项（§6.1）：baseUrl / apiKey / model / timeout
 * - 验证状态 2 项（§6.2）：verifiedAt / verifyError
 * - 工具开关 10 项（§6.3）：六工具 + history/recheck/calibrate/arbiter
 * - 预算与成本 7 项（§6.4）：含两条费率字段
 * - 兜底级联 7 项（§6.5）
 * - 账本 2 项（§6.6）+ gate 阈值 1 项（§6.7）
 *
 * 写法沿用 core/config.ts 的 schemastery + volatileField 范式：每个可编辑
 * 字段都必须包 volatileField()（否则宿主设置面板把整块配置丢弃），
 * 入口必须 re-export Config。
 */

import Schema from '@deepseek-ai/schemastery';

import {
  desc,
  setDescription,
  unwrapVolatile,
  volatileField,
} from '../core/config.ts';

// ── 工具名清单（契约 §1.2，全仓冲突检查结论：decision_ 前缀零冲突）────

export const DECISION_TOOL_PREFIX = 'decision_';

/** 十工具最终名（契约 §1.2 闭集；3/11–10/11 按卡注册，名字不得改）。 */
export const DECISION_TOOL_NAMES = [
  'decision_decide',
  'decision_gate',
  'decision_rerank',
  'decision_batch',
  'decision_locate',
  'decision_usage',
  'decision_history',
  'decision_recheck',
  'decision_calibrate',
  'decision_arbiter',
] as const;

export type DecisionToolName = (typeof DECISION_TOOL_NAMES)[number];

/** 纯本地三工具：不受「模型已配置且已验证」约束（契约 §1.3）。 */
export const LOCAL_ONLY_TOOLS: readonly DecisionToolName[] = [
  'decision_usage',
  'decision_history',
  'decision_calibrate',
];

// ── 默认值常量（契约 §6；readme.test 与单测锚定）───────────────────────

export const DEFAULT_SYSTEMONE_TIMEOUT_MS = 30_000;
export const DEFAULT_BUDGET_MAX_CALLS_PER_DAY = 200;
export const DEFAULT_BUDGET_MAX_TOKENS_PER_DAY = 200_000;
export const DEFAULT_BUDGET_MAX_COST_USD_PER_DAY = 0;
export const DEFAULT_BUDGET_RESET_HOUR_UTC = 0;
export const DEFAULT_COST_PER_1K_TOKENS = 0;
export const DEFAULT_FALLBACK_MIN_CONFIDENCE = 0.7;
export const DEFAULT_FALLBACK_TIMEOUT_MS = 60_000;
export const DEFAULT_FALLBACK_MAX_CALLS_PER_DAY = 50;
export const DEFAULT_LEDGER_MAX_ENTRIES = 1000;
export const DEFAULT_GATE_ALLOW_THRESHOLD = 0.8;

/** 兜底生效模式（契约 §6.5 枚举闭集）。 */
export const FALLBACK_MODES = [
  'auto-fallback',
  'explicit-arbiter',
  'both',
] as const;
export type FallbackMode = (typeof FALLBACK_MODES)[number];
export const DEFAULT_FALLBACK_MODE: FallbackMode = 'auto-fallback';

// ── 归一化辅助 ────────────────────────────────────────────────────────

function toStr(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function toBool(raw: unknown): boolean {
  return raw === true;
}

/** 非有限 / 越界一律回落默认（沿用 core/config.ts resolveConfig 纪律）。 */
function toNum(
  raw: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  return typeof raw === 'number' &&
    Number.isFinite(raw) &&
    raw >= min &&
    raw <= max
    ? raw
    : fallback;
}

/**
 * baseUrl 归一：去尾斜杠；非空但不是 http(s) URL 时视为未配置（空串）。
 * 归一后守卫层据此报 model-not-configured——「非法的 baseUrl」不作为
 * 第三种错误码（契约错误码是闭集，§4）。
 */
export function normalizeBaseUrl(raw: unknown): string {
  const value = toStr(raw).replace(/\/+$/, '');
  if (value === '') return '';
  return /^https?:\/\//i.test(value) ? value : '';
}

// ── 运行时形态 ────────────────────────────────────────────────────────

export interface ResolvedToolsConfig {
  // 模型接口（§6.1）
  systemoneBaseUrl: string;
  systemoneApiKey: string;
  systemoneModel: string;
  systemoneTimeoutMs: number;
  // 验证状态（§6.2）
  systemoneVerifiedAt: string;
  systemoneVerifyError: string;
  // 工具开关（§6.3）
  toolsDecideEnabled: boolean;
  toolsGateEnabled: boolean;
  toolsRerankEnabled: boolean;
  toolsBatchEnabled: boolean;
  toolsLocateEnabled: boolean;
  toolsUsageEnabled: boolean;
  toolsHistoryEnabled: boolean;
  toolsRecheckEnabled: boolean;
  toolsCalibrateEnabled: boolean;
  toolsArbiterEnabled: boolean;
  // 预算与成本（§6.4）
  budgetEnabled: boolean;
  budgetMaxCallsPerDay: number;
  budgetMaxTokensPerDay: number;
  budgetMaxCostUsdPerDay: number;
  budgetResetHourUtc: number;
  costInputPer1kTokens: number;
  costOutputPer1kTokens: number;
  // 兜底级联（§6.5）
  fallbackEnabled: boolean;
  fallbackProvider: string;
  fallbackModel: string;
  fallbackMinConfidence: number;
  fallbackMode: FallbackMode;
  fallbackTimeoutMs: number;
  fallbackMaxCallsPerDay: number;
  // 账本（§6.6）+ gate 阈值（§6.7）
  ledgerEnabled: boolean;
  ledgerMaxEntries: number;
  gateAllowThreshold: number;
}

/** 按工具名取开关位（字段名 ↔ 工具名的一一映射，契约 §6.3）。 */
/**
 * 十工具 → 各自的开关字段名。
 *
 * 导出供契约测试做「工具数 / 开关数四口径一致」断言：README 表格、契约书
 * 工具清单、配置字段表与本映射必须一一对应。
 */
export const TOOL_SWITCH_KEYS: Record<
  DecisionToolName,
  keyof ResolvedToolsConfig
> = {
  decision_decide: 'toolsDecideEnabled',
  decision_gate: 'toolsGateEnabled',
  decision_rerank: 'toolsRerankEnabled',
  decision_batch: 'toolsBatchEnabled',
  decision_locate: 'toolsLocateEnabled',
  decision_usage: 'toolsUsageEnabled',
  decision_history: 'toolsHistoryEnabled',
  decision_recheck: 'toolsRecheckEnabled',
  decision_calibrate: 'toolsCalibrateEnabled',
  decision_arbiter: 'toolsArbiterEnabled',
};

export function toolSwitchOf(
  config: ResolvedToolsConfig,
  tool: DecisionToolName,
): boolean {
  return config[TOOL_SWITCH_KEYS[tool]] === true;
}

export function resolveToolsConfig(input: unknown): ResolvedToolsConfig {
  // 宿主设置面板写入的是 volatile 引用（Volatile<T>），读取前必须解包，
  // 否则 baseUrl/apiKey/model 一律读成空串、十个开关一律读成 false
  // ——面板配好了功能却永远 model-not-configured / tool-disabled。
  const raw = (unwrapVolatile(input) ?? {}) as Record<string, unknown>;
  const fallbackMode = (FALLBACK_MODES as readonly string[]).includes(
    toStr(raw.fallbackMode),
  )
    ? (toStr(raw.fallbackMode) as FallbackMode)
    : DEFAULT_FALLBACK_MODE;
  return {
    systemoneBaseUrl: normalizeBaseUrl(raw.systemoneBaseUrl),
    systemoneApiKey: toStr(raw.systemoneApiKey),
    systemoneModel: toStr(raw.systemoneModel),
    systemoneTimeoutMs: toNum(
      raw.systemoneTimeoutMs,
      1_000,
      300_000,
      DEFAULT_SYSTEMONE_TIMEOUT_MS,
    ),
    systemoneVerifiedAt: toStr(raw.systemoneVerifiedAt),
    systemoneVerifyError: toStr(raw.systemoneVerifyError),
    toolsDecideEnabled: toBool(raw.toolsDecideEnabled),
    toolsGateEnabled: toBool(raw.toolsGateEnabled),
    toolsRerankEnabled: toBool(raw.toolsRerankEnabled),
    toolsBatchEnabled: toBool(raw.toolsBatchEnabled),
    toolsLocateEnabled: toBool(raw.toolsLocateEnabled),
    toolsUsageEnabled: toBool(raw.toolsUsageEnabled),
    toolsHistoryEnabled: toBool(raw.toolsHistoryEnabled),
    toolsRecheckEnabled: toBool(raw.toolsRecheckEnabled),
    toolsCalibrateEnabled: toBool(raw.toolsCalibrateEnabled),
    toolsArbiterEnabled: toBool(raw.toolsArbiterEnabled),
    budgetEnabled: toBool(raw.budgetEnabled),
    budgetMaxCallsPerDay: toNum(
      raw.budgetMaxCallsPerDay,
      0,
      100_000,
      DEFAULT_BUDGET_MAX_CALLS_PER_DAY,
    ),
    budgetMaxTokensPerDay: toNum(
      raw.budgetMaxTokensPerDay,
      0,
      100_000_000,
      DEFAULT_BUDGET_MAX_TOKENS_PER_DAY,
    ),
    budgetMaxCostUsdPerDay: toNum(
      raw.budgetMaxCostUsdPerDay,
      0,
      10_000,
      DEFAULT_BUDGET_MAX_COST_USD_PER_DAY,
    ),
    budgetResetHourUtc: toNum(
      raw.budgetResetHourUtc,
      0,
      23,
      DEFAULT_BUDGET_RESET_HOUR_UTC,
    ),
    costInputPer1kTokens: toNum(
      raw.costInputPer1kTokens,
      0,
      100,
      DEFAULT_COST_PER_1K_TOKENS,
    ),
    costOutputPer1kTokens: toNum(
      raw.costOutputPer1kTokens,
      0,
      100,
      DEFAULT_COST_PER_1K_TOKENS,
    ),
    fallbackEnabled: toBool(raw.fallbackEnabled),
    fallbackProvider: toStr(raw.fallbackProvider),
    fallbackModel: toStr(raw.fallbackModel),
    fallbackMinConfidence: toNum(
      raw.fallbackMinConfidence,
      0.05,
      1,
      DEFAULT_FALLBACK_MIN_CONFIDENCE,
    ),
    fallbackMode,
    fallbackTimeoutMs: toNum(
      raw.fallbackTimeoutMs,
      1_000,
      300_000,
      DEFAULT_FALLBACK_TIMEOUT_MS,
    ),
    fallbackMaxCallsPerDay: toNum(
      raw.fallbackMaxCallsPerDay,
      0,
      10_000,
      DEFAULT_FALLBACK_MAX_CALLS_PER_DAY,
    ),
    ledgerEnabled: raw.ledgerEnabled !== false,
    ledgerMaxEntries: toNum(
      raw.ledgerMaxEntries,
      100,
      100_000,
      DEFAULT_LEDGER_MAX_ENTRIES,
    ),
    gateAllowThreshold: toNum(
      raw.gateAllowThreshold,
      0.05,
      1,
      DEFAULT_GATE_ALLOW_THRESHOLD,
    ),
  };
}

// ── 设置面板 schema（契约 §6 逐项落位）────────────────────────────────

export const Config = Schema.object({
  // 模型接口（§6.1）
  systemoneBaseUrl: volatileField(
    setDescription(
      Schema.string().default(''),
      desc(
        'Base URL of the systemone decision endpoint; the client posts to {baseUrl}/v1/systemone (http/https, trailing slashes trimmed)',
        'systemone 决策接口的 baseUrl；client 将请求 {baseUrl}/v1/systemone（http/https，自动去尾斜杠）',
      ),
    ),
  ),
  systemoneApiKey: volatileField(
    setDescription(
      Schema.string().default(''),
      desc(
        'API key sent as Authorization: Bearer <key>; never printed to logs, ledger or error messages',
        '以 Authorization: Bearer 头携带的 API key；绝不写入日志、账本或错误信息',
      ),
    ),
  ),
  systemoneModel: volatileField(
    setDescription(
      Schema.string().default(''),
      desc(
        'Decision model name understood by the systemone endpoint (not the host session model)',
        'systemone 端点识别的决策模型名（不是宿主会话当前模型）',
      ),
    ),
  ),
  systemoneTimeoutMs: volatileField(
    setDescription(
      Schema.number()
        .min(1_000)
        .max(300_000)
        .step(1_000)
        .default(DEFAULT_SYSTEMONE_TIMEOUT_MS),
      desc(
        'Timeout for one systemone call in ms (1000-300000); on timeout the tool reports model-timeout instead of guessing',
        '单次 systemone 调用超时（毫秒，1000-300000）；超时报 model-timeout，不猜答案',
      ),
    ),
  ),
  // 验证状态（§6.2）
  systemoneVerifiedAt: volatileField(
    setDescription(
      Schema.string().default(''),
      desc(
        'ISO time of the last successful verification; empty = never verified (tools report model-verify-failed); invalidated when baseUrl/apiKey/model change',
        '最近一次验证成功时间（ISO）；留空＝未验证（工具报 model-verify-failed）；baseUrl/apiKey/model 任一变更即作废',
      ),
    ),
  ),
  systemoneVerifyError: volatileField(
    setDescription(
      Schema.string().default(''),
      desc(
        'Reason of the last failed verification (error code + hint; never contains the API key)',
        '最近一次验证失败的原因（错误码 + 建议；绝不含 API key）',
      ),
    ),
  ),
  // 工具开关（§6.3，10 项，默认关闭）
  toolsDecideEnabled: volatileField(
    setDescription(
      Schema.boolean().default(false),
      desc(
        'Enable decision_decide (typed questions with probability distributions); off = calls report tool-disabled',
        '启用 decision_decide（typed 判定，返回概率分布）；关闭＝调用报 tool-disabled',
      ),
    ),
  ),
  toolsGateEnabled: volatileField(
    setDescription(
      Schema.boolean().default(false),
      desc(
        'Enable decision_gate (allow/revise/block/escalate guard before risky actions); off = calls report tool-disabled',
        '启用 decision_gate（危险动作前的 allow/revise/block/escalate 闸门）；关闭＝调用报 tool-disabled',
      ),
    ),
  ),
  toolsRerankEnabled: volatileField(
    setDescription(
      Schema.boolean().default(false),
      desc(
        'Enable decision_rerank (2-10 candidates scored by fit/risk); off = calls report tool-disabled',
        '启用 decision_rerank（2-10 个候选按 fit/risk 综合打分）；关闭＝调用报 tool-disabled',
      ),
    ),
  ),
  toolsBatchEnabled: volatileField(
    setDescription(
      Schema.boolean().default(false),
      desc(
        'Enable decision_batch (1-5 question groups x 1-20 texts, bounded concurrency); off = calls report tool-disabled',
        '启用 decision_batch（1-5 组问题 × 1-20 条文本，并发有界）；关闭＝调用报 tool-disabled',
      ),
    ),
  ),
  toolsLocateEnabled: volatileField(
    setDescription(
      Schema.boolean().default(false),
      desc(
        'Enable decision_locate (find a target in an image, returns a normalized box); off = calls report tool-disabled',
        '启用 decision_locate（图像内找目标，返回归一化坐标框）；关闭＝调用报 tool-disabled',
      ),
    ),
  ),
  toolsUsageEnabled: volatileField(
    setDescription(
      Schema.boolean().default(false),
      desc(
        'Enable decision_usage (calls/tokens/cost/latency ledger query; local-only, works without a configured model); off = calls report tool-disabled',
        '启用 decision_usage（calls/tokens/成本/延迟账本查询；纯本地，无需配置模型）；关闭＝调用报 tool-disabled',
      ),
    ),
  ),
  toolsHistoryEnabled: volatileField(
    setDescription(
      Schema.boolean().default(false),
      desc(
        'Enable decision_history (decision history by decisionId; local-only); off = calls report tool-disabled',
        '启用 decision_history（按 decisionId 查决策历史；纯本地）；关闭＝调用报 tool-disabled',
      ),
    ),
  ),
  toolsRecheckEnabled: volatileField(
    setDescription(
      Schema.boolean().default(false),
      desc(
        'Enable decision_recheck (re-run a decision and report drift); off = calls report tool-disabled',
        '启用 decision_recheck（复检判定并报告漂移）；关闭＝调用报 tool-disabled',
      ),
    ),
  ),
  toolsCalibrateEnabled: volatileField(
    setDescription(
      Schema.boolean().default(false),
      desc(
        'Enable decision_calibrate (Brier score and confidence buckets; local-only); off = calls report tool-disabled',
        '启用 decision_calibrate（Brier 分数与置信度分桶审计；纯本地）；关闭＝调用报 tool-disabled',
      ),
    ),
  ),
  toolsArbiterEnabled: volatileField(
    setDescription(
      Schema.boolean().default(false),
      desc(
        'Enable decision_arbiter (explicit LLM judge for a decision); off = calls report tool-disabled',
        '启用 decision_arbiter（对判定显式调用大模型裁判）；关闭＝调用报 tool-disabled',
      ),
    ),
  ),
  // 预算与成本（§6.4）
  budgetEnabled: volatileField(
    setDescription(
      Schema.boolean().default(false),
      desc(
        'Enable the hard daily budget gate; when a limit is hit the call is rejected with budget-exceeded (no silent truncation)',
        '启用日硬预算闸；任一维度触顶后调用直接报 budget-exceeded（不静默截断）',
      ),
    ),
  ),
  budgetMaxCallsPerDay: volatileField(
    setDescription(
      Schema.number()
        .min(0)
        .max(100_000)
        .step(10)
        .default(DEFAULT_BUDGET_MAX_CALLS_PER_DAY),
      desc(
        'Max decision-model calls per day (0 = unlimited)',
        '每日决策模型调用上限（0 = 不限）',
      ),
    ),
  ),
  budgetMaxTokensPerDay: volatileField(
    setDescription(
      Schema.number()
        .min(0)
        .max(100_000_000)
        .step(1_000)
        .default(DEFAULT_BUDGET_MAX_TOKENS_PER_DAY),
      desc(
        'Max tokens (input+output) per day (0 = unlimited)',
        '每日 token 上限（输入+输出，0 = 不限）',
      ),
    ),
  ),
  budgetMaxCostUsdPerDay: volatileField(
    setDescription(
      Schema.number()
        .min(0)
        .max(10_000)
        .step(0.01)
        .default(DEFAULT_BUDGET_MAX_COST_USD_PER_DAY),
      desc(
        'Max estimated cost per day in USD (0 = unlimited; estimates only, not a bill)',
        '每日估算成本上限（美元，0 = 不限；数字为估算，不是账单）',
      ),
    ),
  ),
  budgetResetHourUtc: volatileField(
    setDescription(
      Schema.number()
        .min(0)
        .max(23)
        .step(1)
        .default(DEFAULT_BUDGET_RESET_HOUR_UTC),
      desc(
        'UTC hour when the daily budget window resets (0-23)',
        '日预算窗口重置时刻（UTC 小时，0-23）',
      ),
    ),
  ),
  costInputPer1kTokens: volatileField(
    setDescription(
      Schema.number()
        .min(0)
        .max(100)
        .step(0.001)
        .default(DEFAULT_COST_PER_1K_TOKENS),
      desc(
        'Estimated USD cost per 1k input tokens (0 = local/free model, cost shown as 0 and not flagged as estimated)',
        '每 1k 输入 token 的估算成本（美元，0 = 本地/免费模型，成本记 0 且不标估算）',
      ),
    ),
  ),
  costOutputPer1kTokens: volatileField(
    setDescription(
      Schema.number()
        .min(0)
        .max(100)
        .step(0.001)
        .default(DEFAULT_COST_PER_1K_TOKENS),
      desc(
        'Estimated USD cost per 1k output tokens (0 = local/free model)',
        '每 1k 输出 token 的估算成本（美元，0 = 本地/免费模型）',
      ),
    ),
  ),
  // 兜底级联（§6.5）
  fallbackEnabled: volatileField(
    setDescription(
      Schema.boolean().default(false),
      desc(
        'Enable the LLM fallback cascade (confidence-gated); the judge never recurses and shares the same budget gate',
        '启用大模型兜底级联（置信度门控）；裁判不递归，且与主调用共用预算闸',
      ),
    ),
  ),
  fallbackProvider: volatileField(
    setDescription(
      Schema.string().default(''),
      desc(
        'Provider of the fallback judge; empty = use the session current model via the host llm route',
        '兜底裁判 provider；留空 = 经宿主 llm 路由使用会话当前模型',
      ),
    ),
  ),
  fallbackModel: volatileField(
    setDescription(
      Schema.string().default(''),
      desc(
        'Model of the fallback judge; empty = use the session current model',
        '兜底裁判模型名；留空 = 使用会话当前模型',
      ),
    ),
  ),
  fallbackMinConfidence: volatileField(
    setDescription(
      Schema.number()
        .min(0.05)
        .max(1)
        .step(0.05)
        .default(DEFAULT_FALLBACK_MIN_CONFIDENCE),
      desc(
        'Confidence gate: below this the decision counts as unsure and may trigger the fallback judge',
        '置信度门控阈值：低于该值视为「拿不准」，可触发兜底裁判（默认 0.7）',
      ),
    ),
  ),
  fallbackMode: volatileField(
    setDescription(
      Schema.union([
        Schema.const('auto-fallback'),
        Schema.const('explicit-arbiter'),
        Schema.const('both'),
      ]).default(DEFAULT_FALLBACK_MODE),
      desc(
        'Where the fallback judge may run: auto-fallback (decide/gate only) | explicit-arbiter (decision_arbiter only) | both',
        '兜底裁判生效范围：auto-fallback（仅 decide/gate）| explicit-arbiter（仅 arbiter）| both',
      ),
    ),
  ),
  fallbackTimeoutMs: volatileField(
    setDescription(
      Schema.number()
        .min(1_000)
        .max(300_000)
        .step(1_000)
        .default(DEFAULT_FALLBACK_TIMEOUT_MS),
      desc(
        'Timeout for one judge call in ms (judge failures return errors, never recurse)',
        '单次裁判调用超时（毫秒）；裁判失败直接报错，不再递归兜底',
      ),
    ),
  ),
  fallbackMaxCallsPerDay: volatileField(
    setDescription(
      Schema.number()
        .min(0)
        .max(10_000)
        .step(10)
        .default(DEFAULT_FALLBACK_MAX_CALLS_PER_DAY),
      desc(
        'Max judge calls per day (independent daily cap against judge abuse)',
        '裁判日调用上限（独立配额，防裁判滥用）',
      ),
    ),
  ),
  // 账本（§6.6）
  ledgerEnabled: volatileField(
    setDescription(
      Schema.boolean().default(true),
      desc(
        'Write the usage ledger; off = usage/history/calibrate have no data',
        '写入 usage 账本；关闭 = usage/history/calibrate 无数据可查',
      ),
    ),
  ),
  ledgerMaxEntries: volatileField(
    setDescription(
      Schema.number()
        .min(100)
        .max(100_000)
        .step(100)
        .default(DEFAULT_LEDGER_MAX_ENTRIES),
      desc(
        'Rolling ledger cap; evicted decisionIds report decision-not-found on recheck',
        '账本滚动上限；被淘汰条目的 decisionId 复检时报 decision-not-found',
      ),
    ),
  ),
  // gate 阈值（§6.7）
  gateAllowThreshold: volatileField(
    setDescription(
      Schema.number()
        .min(0.05)
        .max(1)
        .step(0.05)
        .default(DEFAULT_GATE_ALLOW_THRESHOLD),
      desc(
        'decision_gate allow threshold on P(yes) of the allow-question (below it escalate, never fail-open)',
        'decision_gate 的允许阈值（允许题 P(yes) 低于阈值即 escalate，绝不 fail-open）',
      ),
    ),
  ),
});
