/**
 * usage 账本（决策工具系列 2/11）。
 *
 * 契约来源：docs/decision-tools-contract.md §5（账本结构）与 §8.2（记账规则）。
 *
 * 卡 2 交付面：
 * - 条目结构与滚动淘汰语义在此定型（字段位含 decisionId / payload /
 *   outcome，供 8/11、10/11 消费）。
 * - 落地 sink：内存环形账本（测试友好、零 IO）；文件持久化
 *   `<DSH_HOME>/plugins/dsh-decision/ledger.jsonl` 由 5/11 接上
 *   （契约 §5.4），届时只需实现同一个 `LedgerSink` 接口替换注入，
 *   调用方不动。
 *
 * 硬约束（契约 §5.1）：账本不保存 state 原文、apiKey、图像 base64。
 * payload 只存判定结果与分布；questionSummary 截到 ≤120 字符。
 */

import type { DecisionErrorCode } from '../systemone/errors.ts';
import type { JsonValue, SystemOneQuestionType } from '../systemone/types.ts';

// ── 条目结构（契约 §5.1，字段名逐字对齐）────────────────────────────

export type LedgerMode =
  'primary' | 'auto-fallback' | 'explicit-arbiter' | 'recheck';

export type LedgerSource = 'decision-model' | 'llm-fallback-judge';

export type LedgerEntryStatus = 'ok' | 'error' | 'blocked';

export interface LedgerOutcome {
  state: 'unknown' | 'confirmed' | 'rejected' | 'revised';
  value: JsonValue | null;
  source: 'downstream' | 'user' | null;
  updatedAt: string | null;
}

export interface LedgerPayload {
  /** 判定值：P(yes) / 选项名 / 加权分 / 坐标框；失败条目为 null。 */
  value: JsonValue | null;
  confidence: number | null;
  /** 概率分布（choice/noul 的 map，score 的数组）；无则 null。 */
  distribution: JsonValue | null;
  legend: string[] | null;
  /** 失败/拦截条目记错误码（契约 §8.2，闭集见 errors.ts DECISION_ERROR_CODES）。 */
  errorCode?: DecisionErrorCode;
  /** self-consistency 样本序号（契约 §5.2）。 */
  selfConsistencySample?: number;
  /** 聚合汇总条目标记（契约 §5.2）。 */
  aggregated?: boolean;
  /** 调用方声明的风险等级（gate，仅记录，不改判定；契约 §3.2）。 */
  riskLevel?: string | null;
  /** 调用方传入的外部策略标识（gate，仅记录；契约 §3.2）。 */
  policyId?: string | null;
}

export interface LedgerUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  calls: number;
}

export interface LedgerEntry {
  decisionId: string;
  ts: string;
  tool: string;
  mode: LedgerMode;
  source: LedgerSource;
  questionId: string | null;
  questionType: SystemOneQuestionType | null;
  /** ≤120 字符的问题摘要（不含 state 全文）。 */
  questionSummary: string | null;
  status: LedgerEntryStatus;
  payload: LedgerPayload;
  outcome: LedgerOutcome;
  usage: LedgerUsage;
  latencyMs: number;
  costUsd: number | null;
  /** true = 估算值，不是账单（契约 §5.3）。 */
  costEstimated: boolean;
  /** recheck 新条目指向原条目（契约 §5.2）。 */
  recheckOf?: string;
}

// ── sink 抽象 ────────────────────────────────────────────────────────

export interface LedgerSink {
  /** 追加一条；超上限时淘汰最旧条目。 */
  append(entry: LedgerEntry): void;
  /** 读取（最新在前）；10/11 calibrate 与 8/11 history 消费。 */
  list(): readonly LedgerEntry[];
  /** 按decisionId 查找；不存在返回 undefined（recheck 报 decision-not-found）。 */
  findById(decisionId: string): LedgerEntry | undefined;
  /** 回填 outcome（契约 §7.2 主通道，5/11 落地写盘）。 */
  updateOutcome(
    decisionId: string,
    outcome: {
      state: 'confirmed' | 'rejected' | 'revised';
      value?: JsonValue | null;
      source?: 'downstream' | 'user';
    },
  ): boolean;
  size(): number;
}

/** 内存环形账本：超过 maxEntries 时淘汰最旧（契约 §5.4 语义）。 */
export function createMemoryLedger(maxEntries: number): LedgerSink {
  const entries: LedgerEntry[] = [];
  const cap = Math.max(1, Math.floor(maxEntries));
  return {
    append(entry: LedgerEntry) {
      entries.push(entry);
      if (entries.length > cap) entries.splice(0, entries.length - cap);
    },
    list() {
      // 最新在前（history 的 ts 倒序，契约 §3.7）。
      return [...entries].reverse();
    },
    findById(decisionId: string) {
      return entries.find((entry) => entry.decisionId === decisionId);
    },
    updateOutcome(decisionId, outcome) {
      const found = entries.find((entry) => entry.decisionId === decisionId);
      if (!found) return false;
      found.outcome = {
        state: outcome.state,
        value: outcome.value ?? null,
        source: outcome.source ?? 'downstream',
        updatedAt: new Date().toISOString(),
      };
      return true;
    },
    size() {
      return entries.length;
    },
  };
}

// ── 成本换算（契约 §5.3，估算口径）────────────────────────────────────

export interface CostRates {
  costInputPer1kTokens: number;
  costOutputPer1kTokens: number;
}

export interface CostEstimate {
  costUsd: number | null;
  costEstimated: boolean;
}

/**
 * 成本估算：
 * - usage 缺失 → { null, false }（无数据可估，不是 0）。
 * - 双费率为 0（本地/自建模型）→ { 0, false }。
 * - 费率非 0 → 计算值 + { costEstimated: true }。
 */
export function estimateCostUsd(
  usage: LedgerUsage,
  rates: CostRates,
): CostEstimate {
  if (usage.inputTokens === null || usage.outputTokens === null) {
    return { costUsd: null, costEstimated: false };
  }
  if (rates.costInputPer1kTokens === 0 && rates.costOutputPer1kTokens === 0) {
    return { costUsd: 0, costEstimated: false };
  }
  const costUsd =
    (usage.inputTokens / 1000) * rates.costInputPer1kTokens +
    (usage.outputTokens / 1000) * rates.costOutputPer1kTokens;
  return { costUsd, costEstimated: true };
}

/**
 * 问题摘要截断（≤120 字符，契约 §5.1 questionSummary 口径）。
 * 入参为 null 时原样返回 null——摘要缺省就是 null，不拿 questionId 冒充摘要。
 */
export function truncateSummary(text: string | null, max = 120): string | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
