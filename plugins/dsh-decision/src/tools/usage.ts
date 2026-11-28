/**
 * decision_usage：用量账本查询 + 燃尽率（决策工具系列 5/11）。
 *
 * 契约来源：docs/decision-tools-contract.md §3.6（入参/出参/口径）、
 * §8.3（燃尽率：ratio / projectedRatio / 瓶颈维度）、§6（预算字段）。
 *
 * 纯本地聚合：不发起任何模型调用；数据来自统一调用层写入的账本
 * （真实记账，不是构造数字）。LOCAL_ONLY_TOOLS 成员——不走模型守卫。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { InferValue, ToolDefinition } from '@deepseek-ai/dsh-tools';

import type { DecisionToolName, ResolvedToolsConfig } from '../config/index.ts';
import {
  budgetWindow,
  checkToolEnabled,
  sumWindowUsage,
  type LedgerSink,
} from '../runtime/index.ts';
import {
  decisionError,
  type DecisionErrorEnvelope,
} from '../systemone/errors.ts';
import type { JsonValue } from '../systemone/types.ts';
import { USAGE_WINDOW_VALUES, type UsageWindow } from './usage-windows.ts';

export const USAGE_TOOL = 'decision_usage' as const;

export const USAGE_DEFAULT_WINDOW: UsageWindow = '24h';

/** 延迟分位数的最小样本数：低于该值 p95 记 null（契约 §3.6）。 */
export const USAGE_P95_MIN_SAMPLES = 20;

export const USAGE_DESCRIPTION = [
  'Purpose: report local decision-model usage (calls, tokens, estimated cost, latency percentiles) and today budget burn-down.',
  'Constraints: purely local aggregation over the ledger; never calls the decision model; cost is an estimate, not a bill.',
  'Actions: aggregate ledger entries within the requested window; compute p50/p95 latency and budget burn rate; optionally return budget status only.',
  'Output is bounded: { ok, window, calls, inputTokens, outputTokens, costUsd, costEstimated, latencyP50Ms, latencyP95Ms, samples, burnRate, budget } or { ok:false, error }.',
].join(' ');

export const USAGE_PARAMETERS = {
  window: {
    type: 'string' as const,
    description: `统计窗口：${USAGE_WINDOW_VALUES.join(' | ')}，缺省 ${USAGE_DEFAULT_WINDOW}。`,
  },
  tool: {
    type: 'string' as const,
    description:
      '按工具过滤（decision_decide / decision_gate / …，十工具闭集之一）。',
  },
  budgetCheckOnly: {
    type: 'boolean' as const,
    description:
      'true 时只回预算状态与燃尽率，不回用量指标（指标字段为 null）。',
  },
} as const;

const USAGE_OUTPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: true as const,
  properties: {
    ok: { type: 'boolean' as const, required: true as const },
    window: { type: 'string' as const },
    calls: {
      oneOf: [{ type: 'integer' as const }, { type: 'null' as const }] as const,
      description:
        '窗口内真实调用次数（账本 usage.calls 求和；budgetCheckOnly 时 null）。',
    },
    inputTokens: {
      oneOf: [{ type: 'integer' as const }, { type: 'null' as const }] as const,
    },
    outputTokens: {
      oneOf: [{ type: 'integer' as const }, { type: 'null' as const }] as const,
    },
    costUsd: {
      oneOf: [{ type: 'number' as const }, { type: 'null' as const }] as const,
      description: '估算成本合计（费率 0 时为 0 且 costEstimated=false）。',
    },
    costEstimated: { type: 'boolean' as const },
    latencyP50Ms: {
      oneOf: [{ type: 'integer' as const }, { type: 'null' as const }] as const,
    },
    latencyP95Ms: {
      oneOf: [{ type: 'integer' as const }, { type: 'null' as const }] as const,
      description: '成功调用延迟 95 分位；样本 < 20 时为 null（不硬算）。',
    },
    samples: {
      oneOf: [{ type: 'integer' as const }, { type: 'null' as const }] as const,
      description: '参与延迟统计的成功调用样本数。',
    },
    burnRate: {
      oneOf: [
        {
          type: 'object' as const,
          additionalProperties: false as const,
          properties: {
            dimension: {
              type: 'string' as const,
              required: true as const,
              description: '当前瓶颈维度 calls | tokens | cost。',
            },
            used: { type: 'number' as const, required: true as const },
            budget: { type: 'number' as const, required: true as const },
            ratio: { type: 'number' as const, required: true as const },
            projectedRatio: {
              type: 'number' as const,
              required: true as const,
            },
            periodStart: { type: 'string' as const, required: true as const },
            periodEnd: { type: 'string' as const, required: true as const },
          },
        },
        { type: 'null' as const },
      ] as const,
      description: '燃尽率（预算关闭或额度全部不设限时为 null）。',
    },
    budget: {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: {
        enabled: { type: 'boolean' as const, required: true as const },
        hardLimit: { type: 'boolean' as const, required: true as const },
        exceeded: { type: 'boolean' as const, required: true as const },
      },
    },
    error: {
      type: 'object' as const,
      additionalProperties: true as const,
      description: '失败信封 { code, message, retryable, details }。',
      properties: {},
    },
  },
} as const;

export type UsageOutput = InferValue<typeof USAGE_OUTPUT_SCHEMA>;

export const USAGE_OUTPUT = {
  schema: USAGE_OUTPUT_SCHEMA,
  render: (_args: unknown, value: unknown) => [
    { type: 'text' as const, text: JSON.stringify(value) },
  ],
};

// ── 纯函数（可单测）─────────────────────────────────────────────────

const WINDOW_MS: Record<Exclude<UsageWindow, 'all'>, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};

export interface UsageMetrics {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costEstimated: boolean;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  samples: number;
}

/** 最近邻秩分位数（升序数组，p∈(0,100]）。 */
export function percentileNearestRank(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

export function aggregateUsage(
  entries: readonly {
    status: string;
    usage: {
      inputTokens: number | null;
      outputTokens: number | null;
      calls: number;
    };
    costUsd: number | null;
    costEstimated: boolean;
    latencyMs: number;
  }[],
): UsageMetrics {
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let costEstimated = false;
  const latencies: number[] = [];
  for (const entry of entries) {
    calls += entry.usage.calls;
    inputTokens += entry.usage.inputTokens ?? 0;
    outputTokens += entry.usage.outputTokens ?? 0;
    costUsd += entry.costUsd ?? 0;
    if (entry.costEstimated === true) costEstimated = true;
    if (
      entry.status === 'ok' &&
      Number.isFinite(entry.latencyMs) &&
      entry.latencyMs > 0
    ) {
      latencies.push(entry.latencyMs);
    }
  }
  latencies.sort((a, b) => a - b);
  const samples = latencies.length;
  return {
    calls,
    inputTokens,
    outputTokens,
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    costEstimated,
    latencyP50Ms: samples === 0 ? null : percentileNearestRank(latencies, 50),
    latencyP95Ms:
      samples < USAGE_P95_MIN_SAMPLES
        ? null
        : percentileNearestRank(latencies, 95),
    samples,
  };
}

export interface BurnRateInfo {
  dimension: 'calls' | 'tokens' | 'cost';
  used: number;
  budget: number;
  ratio: number;
  projectedRatio: number;
  periodStart: string;
  periodEnd: string;
}

/**
 * 燃尽率（契约 §8.3）：瓶颈维度 = 三维额度比值最大者；
 * projectedRatio = 按当前速率线性外推到周期末的比例。
 * 预算关闭或三维额度全部 ≤0（不设限）→ null。
 */
export function computeBurnRate(
  config: ResolvedToolsConfig,
  ledger: LedgerSink | undefined,
  now: Date,
): BurnRateInfo | null {
  if (!config.budgetEnabled) return null;
  const window = budgetWindow(now, config.budgetResetHourUtc);
  const usage = ledger
    ? sumWindowUsage(ledger.list(), window)
    : { calls: 0, tokens: 0, costUsd: 0 };
  const candidates: Array<{
    dimension: 'calls' | 'tokens' | 'cost';
    quota: number;
    used: number;
  }> = [
    {
      dimension: 'calls',
      quota: config.budgetMaxCallsPerDay,
      used: usage.calls,
    },
    {
      dimension: 'tokens',
      quota: config.budgetMaxTokensPerDay,
      used: usage.tokens,
    },
    {
      dimension: 'cost',
      quota: config.budgetMaxCostUsdPerDay,
      used: usage.costUsd,
    },
  ];
  let worst: {
    dimension: 'calls' | 'tokens' | 'cost';
    quota: number;
    used: number;
  } | null = null;
  let worstRatio = -1;
  for (const item of candidates) {
    if (item.quota <= 0) continue; // ≤0 = 该维度不设限
    const ratio = item.used / item.quota;
    if (ratio > worstRatio) {
      worst = item;
      worstRatio = ratio;
    }
  }
  if (worst === null) return null;
  const elapsedMs = now.getTime() - window.start.getTime();
  const periodMs = window.end.getTime() - window.start.getTime();
  const projected =
    elapsedMs > 0
      ? worst.used + (worst.used / elapsedMs) * (periodMs - elapsedMs)
      : worst.used;
  const round4 = (value: number): number => Math.round(value * 10000) / 10000;
  return {
    dimension: worst.dimension,
    used: round4(worst.used),
    budget: worst.quota,
    ratio: round4(worstRatio),
    projectedRatio: round4(Math.max(0, projected / worst.quota)),
    periodStart: window.start.toISOString(),
    periodEnd: window.end.toISOString(),
  };
}

// ── 主流程 ──────────────────────────────────────────────────────────

function errorBody(error: DecisionErrorEnvelope): Record<string, JsonValue> {
  return { ok: false, error: error as unknown as JsonValue };
}

export interface UsageDeps {
  readConfig: () => ResolvedToolsConfig;
  ledger?: LedgerSink;
}

export interface UsageExec {
  signal?: AbortSignal;
}

export interface UsagePlan {
  window: UsageWindow;
  tool: DecisionToolName | null;
  budgetCheckOnly: boolean;
}

export function planUsage(
  args: unknown,
): { ok: true; plan: UsagePlan } | { ok: false; error: DecisionErrorEnvelope } {
  if (typeof args !== 'object' || args === null) {
    return {
      ok: false,
      error: decisionError('invalid-arguments', 'usage 入参必须是对象'),
    };
  }
  const raw = args as {
    window?: unknown;
    tool?: unknown;
    budgetCheckOnly?: unknown;
  };
  const window =
    typeof raw.window === 'string' &&
    (USAGE_WINDOW_VALUES as readonly string[]).includes(raw.window)
      ? (raw.window as UsageWindow)
      : USAGE_DEFAULT_WINDOW;
  if (
    typeof raw.window === 'string' &&
    !(USAGE_WINDOW_VALUES as readonly string[]).includes(raw.window)
  ) {
    return {
      ok: false,
      error: decisionError(
        'invalid-arguments',
        `window 仅接受 ${USAGE_WINDOW_VALUES.join(' / ')}`,
      ),
    };
  }
  let tool: DecisionToolName | null = null;
  if (typeof raw.tool === 'string' && raw.tool.trim() !== '') {
    tool = raw.tool as DecisionToolName;
  }
  const budgetCheckOnly = raw.budgetCheckOnly === true;
  return { ok: true, plan: { window, tool, budgetCheckOnly } };
}

export function runUsage(
  args: unknown,
  deps: UsageDeps,
  now: Date = new Date(),
): Record<string, JsonValue> {
  const config = deps.readConfig();
  const disabled = checkToolEnabled(config, USAGE_TOOL);
  if (disabled !== null) return errorBody(disabled);

  const planned = planUsage(args);
  if (!planned.ok) return errorBody(planned.error);
  const plan = planned.plan;

  const entries = deps.ledger?.list() ?? [];
  const windowStartMs =
    plan.window === 'all' ? null : now.getTime() - WINDOW_MS[plan.window];
  const filtered = entries.filter((entry) => {
    if (plan.tool !== null && entry.tool !== plan.tool) return false;
    if (windowStartMs === null) return true;
    const ts = Date.parse(entry.ts);
    return Number.isFinite(ts) && ts >= windowStartMs && ts <= now.getTime();
  });
  const metrics = aggregateUsage(filtered);
  const burnRate = computeBurnRate(config, deps.ledger, now);
  const exceeded = burnRate !== null && burnRate.ratio >= 1;

  const budget = {
    enabled: config.budgetEnabled,
    // 硬预算在闸门启用时才有约束力（关闭时 quota 不参与拦截）。
    hardLimit: config.budgetEnabled,
    exceeded,
  };

  if (plan.budgetCheckOnly) {
    return {
      ok: true,
      window: plan.window,
      calls: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      costEstimated: metrics.costEstimated,
      latencyP50Ms: null,
      latencyP95Ms: null,
      samples: null,
      burnRate: (burnRate ?? null) as unknown as JsonValue,
      budget,
    } as Record<string, JsonValue>;
  }

  return {
    ok: true,
    window: plan.window,
    calls: metrics.calls,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    costUsd: metrics.costUsd,
    costEstimated: metrics.costEstimated,
    latencyP50Ms: metrics.latencyP50Ms,
    latencyP95Ms: metrics.latencyP95Ms,
    samples: metrics.samples,
    burnRate: (burnRate ?? null) as unknown as JsonValue,
    budget,
  } as Record<string, JsonValue>;
}

/** 创建 decision_usage 工具定义（deps 由插件入口注入）。 */
export function createUsageTool(deps: UsageDeps): ToolDefinition {
  return defineTool({
    name: USAGE_TOOL,
    description: USAGE_DESCRIPTION,
    parameters: USAGE_PARAMETERS,
    output: USAGE_OUTPUT,
    async execute(args: unknown): Promise<UsageOutput> {
      // 纯本地聚合：不调模型、不做异步 IO，直接同步计算。
      const result = runUsage(args, deps);
      return result as unknown as UsageOutput;
    },
  }) as ToolDefinition;
}
