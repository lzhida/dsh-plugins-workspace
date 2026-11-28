/**
 * 预算闸挂点（决策工具系列 2/11 落接口，5/11 接真实窗口闸）。
 *
 * 契约来源：docs/decision-tools-contract.md §8.3 与 §6（预算字段）。
 *
 * 语义（契约 §8.3，5/11 起真实生效）：
 * - 「先查预算 → 再出网」，超限 `budget-exceeded`、不发起调用；
 *   调用方（call.ts）只落一条 status=blocked 记录。
 * - calls / tokens / cost 三维取最先触顶者（check 返回 dimension）。
 * - 窗口 = 以 budgetResetHourUtc（UTC 0..23）为边界的自然日。
 * - 额度 ≤ 0 视为该维度不设限（0 不是「零配额」而是「未配置」）。
 * - budgetEnabled=false 时闸整体直通（保留 usage 的燃尽率展示）。
 */

import {
  decisionError,
  type DecisionErrorEnvelope,
} from '../systemone/errors.ts';
import type { LedgerEntry, LedgerSink } from './ledger.ts';

export interface BudgetCheckRequest {
  tool: string;
  /** 预估 token 消耗（pre-flight 估算；当前调用层恒不传）。 */
  estimatedTokens?: number;
  /** 是否兜底裁判调用（独立配额 fallbackMaxCallsPerDay，7/11 起消费）。 */
  judge?: boolean;
}

export type BudgetCheckResult =
  | { ok: true }
  | {
      ok: false;
      error: DecisionErrorEnvelope;
      /** 触顶维度（契约 §8.3 burnRate.dimension 口径）。 */
      dimension: 'calls' | 'tokens' | 'cost';
    };

export interface BudgetGate {
  check(request: BudgetCheckRequest): BudgetCheckResult;
  /**
   * 超限被拒时记录一条 blocked 台账（供 usage 燃尽率可见）。
   * 真实闸下 call.ts 已自行落 blocked 条目，这里保持 noop 防双写。
   */
  recordBlocked(tool: string, dimension: 'calls' | 'tokens' | 'cost'): void;
}

/** 卡 2 版本：直通挂点（单测与未接账本场景仍可用）。 */
export function createPassthroughBudgetGate(): BudgetGate {
  return {
    check(): BudgetCheckResult {
      return { ok: true };
    },
    recordBlocked(): void {
      // 直通实现下不会触顶；接口保留给真实闸的调用方约定。
    },
  };
}

export interface BudgetWindow {
  /** 窗口起点（含），ISO-8601 UTC。 */
  start: Date;
  /** 窗口终点（不含），ISO-8601 UTC。 */
  end: Date;
}

/**
 * 当前预算窗口：以 resetHourUtc（UTC 0..23）为边界的自然日。
 * 例：resetHourUtc=8、now=03-15T10:00Z → 窗口 [03-15T08:00Z, 03-16T08:00Z)。
 */
export function budgetWindow(now: Date, resetHourUtc: number): BudgetWindow {
  const hour = Number.isFinite(resetHourUtc)
    ? Math.min(23, Math.max(0, Math.floor(resetHourUtc)))
    : 0;
  const start = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hour,
      0,
      0,
      0,
    ),
  );
  if (now.getTime() < start.getTime()) {
    start.setUTCDate(start.getUTCDate() - 1);
  }
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

interface WindowUsage {
  calls: number;
  tokens: number;
  costUsd: number;
}

/** 窗口内账本用量聚合（契约 §8.3 判定与 usage 燃尽率共用口径）。 */
export function sumWindowUsage(
  entries: readonly LedgerEntry[],
  window: BudgetWindow,
): WindowUsage {
  let calls = 0;
  let tokens = 0;
  let costUsd = 0;
  const startMs = window.start.getTime();
  const endMs = window.end.getTime();
  for (const entry of entries) {
    const ts = Date.parse(entry.ts);
    if (!Number.isFinite(ts) || ts < startMs || ts >= endMs) continue;
    calls += entry.usage.calls;
    tokens += (entry.usage.inputTokens ?? 0) + (entry.usage.outputTokens ?? 0);
    costUsd += entry.costUsd ?? 0;
  }
  return { calls, tokens, costUsd };
}

export interface WindowedBudgetGateDeps {
  readConfig: () => {
    budgetEnabled: boolean;
    budgetMaxCallsPerDay: number;
    budgetMaxTokensPerDay: number;
    budgetMaxCostUsdPerDay: number;
    budgetResetHourUtc: number;
    fallbackMaxCallsPerDay: number;
  };
  ledger: LedgerSink;
  /** 测试注入时钟；生产缺省真实时间。 */
  now?: () => Date;
}

/**
 * 5/11 真实预算闸：账本日窗口聚合 + 三维取最先触顶（契约 §8.3）。
 *
 * judge=true 的裁判调用走独立配额 fallbackMaxCallsPerDay（0 = 不设限），
 * 只数窗口内 source='llm-fallback-judge' 的条目。
 */
export function createWindowedBudgetGate(
  deps: WindowedBudgetGateDeps,
): BudgetGate {
  const nowFn = deps.now ?? (() => new Date());
  return {
    check(request: BudgetCheckRequest): BudgetCheckResult {
      const config = deps.readConfig();
      if (!config.budgetEnabled) return { ok: true };
      const window = budgetWindow(nowFn(), config.budgetResetHourUtc);
      const usage = sumWindowUsage(deps.ledger.list(), window);
      if (request.judge === true) {
        const quota = config.fallbackMaxCallsPerDay;
        if (quota > 0) {
          const judgeCalls = deps.ledger
            .list()
            .filter(
              (entry) =>
                entry.source === 'llm-fallback-judge' &&
                Date.parse(entry.ts) >= window.start.getTime() &&
                Date.parse(entry.ts) < window.end.getTime(),
            )
            .reduce((sum, entry) => sum + entry.usage.calls, 0);
          if (judgeCalls >= quota) return budgetExceeded('calls');
        }
        return { ok: true };
      }
      // 三维取最先触顶：并列超限时取比值最高者（错误信息最贴切）。
      const ratios: Array<{
        dimension: 'calls' | 'tokens' | 'cost';
        ratio: number;
      }> = [];
      if (config.budgetMaxCallsPerDay > 0) {
        ratios.push({
          dimension: 'calls',
          ratio: usage.calls / config.budgetMaxCallsPerDay,
        });
      }
      if (config.budgetMaxTokensPerDay > 0) {
        ratios.push({
          dimension: 'tokens',
          ratio: usage.tokens / config.budgetMaxTokensPerDay,
        });
      }
      if (config.budgetMaxCostUsdPerDay > 0) {
        ratios.push({
          dimension: 'cost',
          ratio: usage.costUsd / config.budgetMaxCostUsdPerDay,
        });
      }
      let worst: {
        dimension: 'calls' | 'tokens' | 'cost';
        ratio: number;
      } | null = null;
      for (const item of ratios) {
        if (item.ratio >= 1 && (worst === null || item.ratio > worst.ratio)) {
          worst = item;
        }
      }
      return worst === null ? { ok: true } : budgetExceeded(worst.dimension);
    },
    recordBlocked(): void {
      // call.ts 已落 blocked 条目；真实闸不再双写（契约 §8.3 单条口径）。
    },
  };
}

/** 超限失败结果的标准构造（5/11 与单测共用，保证 message 口径一致）。 */
export function budgetExceeded(dimension: 'calls' | 'tokens' | 'cost'): {
  ok: false;
  error: DecisionErrorEnvelope;
  dimension: 'calls' | 'tokens' | 'cost';
} {
  const label =
    dimension === 'calls'
      ? '调用次数'
      : dimension === 'tokens'
        ? 'token 用量'
        : '估算成本';
  return {
    ok: false,
    dimension,
    error: decisionError(
      'budget-exceeded',
      `今日${label}已达本地硬预算上限，调用被拒绝；可在设置页调整预算或等待次日重置`,
    ),
  };
}
