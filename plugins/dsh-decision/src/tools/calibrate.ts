/**
 * decision_calibrate（决策工具系列 10/11）——纯本地校准审计。
 *
 * 统计口径以契约书 §9 为准（docs/decision-tools-contract.md）：
 * - **仅 noul 参与**；choice / score 的真值语义不支持（§7.2 outcome 只支持
 *   confirmed / rejected / revised）→ 计入 `excluded.nonBinary`。
 * - **样本单位** = 一条账本条目 = 一次判定（一个 qid）。
 * - **真值**：confirmed → o=1；rejected → o=0；revised → 不参与（计
 *   `excluded.nonBinary`）；unknown → 不参与（计 `excluded.notBackfilled`）。
 * - **Brier**：`BS = (1/N) Σ (p_i − o_i)²`，`p_i` = 该 noul 判定的 P(yes)，
 *   `o_i ∈ {0,1}`，范围 [0,1]，越小越好。
 * - **分桶**：固定 10 桶，桶 i 覆盖 `[i/10, (i+1)/10)`，标签 `"0.7–0.8"`；
 *   每桶记 `n` 与 `hitRate`（桶内 o 的均值）；桶内 `n < 5` → `insufficient = true`
 *   且 `hitRate = null`。
 * - **样本不足**：`N < 20` → `insufficientSample = true`、`brier = null`、
 *   `overconfidence.meanGap = null`（不硬算）；桶级仍返回并各自带 `insufficient`。
 * - **过自信**：`meanGap = (1/N) Σ (p_i − o_i)`（正 = 高估）；`rate` = 样本中
 *   `(p_i − o_i) > 0.1` 的比例；`significant = (N ≥ 20) && (meanGap ≥ 0.1)`。
 * - **窗口**：默认 `30d`；`tool` 过滤同 `history`。
 *
 * 本工具**纯本地**：只读账本，不发起模型调用，不产生成本（契约 §3.9 / §9）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { InferValue, ToolDefinition } from '@deepseek-ai/dsh-tools';
import {
  DECISION_TOOL_NAMES,
  type DecisionToolName,
  type ResolvedToolsConfig,
} from '../config/index.ts';
import {
  checkToolEnabled,
  type LedgerEntry,
  type LedgerSink,
} from '../runtime/index.ts';
import {
  decisionError,
  type DecisionErrorEnvelope,
} from '../systemone/errors.ts';
import type { JsonValue } from '../systemone/types.ts';

export const CALIBRATE_TOOL = 'decision_calibrate' as const;

/** 样本不足阈值（契约 §9）：N < 20 → 不硬算 brier / meanGap。 */
export const CALIBRATE_MIN_SAMPLES = 20;
/** 分桶数（契约 §9）：固定 10 桶。 */
export const CALIBRATE_BUCKET_COUNT = 10;
/** 桶级样本不足阈值（契约 §9）：桶内 n < 5 → insufficient。 */
export const CALIBRATE_BUCKET_MIN_SAMPLES = 5;
/** 过自信判定阈值（契约 §9）：(p − o) > 0.1 记为过自信样本。 */
export const CALIBRATE_OVERCONFIDENCE_GAP = 0.1;
/** 窗口可选值（契约 §3.9）。 */
export const CALIBRATE_WINDOWS = ['7d', '30d', 'all'] as const;
export type CalibrateWindow = (typeof CALIBRATE_WINDOWS)[number];
export const CALIBRATE_DEFAULT_WINDOW: CalibrateWindow = '30d';

const WINDOW_MS: Record<Exclude<CalibrateWindow, 'all'>, number> = {
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};

export const CALIBRATE_DESCRIPTION = [
  'Purpose: audit how well the decision model calibrated itself against backfilled outcomes.',
  'Constraints: purely local — never calls the decision model, never spends tokens, and only noul judgments with a confirmed/rejected outcome participate in the score.',
  'Actions: read the local ledger, filter by window and tool, then report the Brier score, per-bucket hit rates and the overconfidence metrics; samples below the threshold are reported as insufficient instead of being hard-computed.',
  'Output is bounded: { ok, sampleSize, insufficientSample, brier, buckets, overconfidence, excluded } — numbers and counts only, never the original statements.',
].join(' ');

export const CALIBRATE_PARAMETERS = {
  window: {
    type: 'string' as const,
    description: `统计窗口，可选 ${CALIBRATE_WINDOWS.join(' / ')}，缺省 ${CALIBRATE_DEFAULT_WINDOW}。`,
  },
  tool: {
    type: 'string' as const,
    description:
      '可选：只统计某个工具产生的判定（如 decision_decide）；缺省统计全部工具。',
  },
} as const;

export const CALIBRATE_OUTPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: true as const,
  properties: {
    ok: { type: 'boolean' as const, required: true as const },
    sampleSize: { type: 'number' as const },
    insufficientSample: { type: 'boolean' as const },
    brier: {
      oneOf: [{ type: 'number' as const }, { type: 'null' as const }] as const,
      description: 'Brier 分数；样本不足时为 null（不硬算）。',
    },
    buckets: {
      type: 'array' as const,
      description: '固定 10 桶的命中率；桶内样本不足时 hitRate 为 null。',
      items: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          range: { type: 'string' as const, required: true as const },
          n: { type: 'number' as const, required: true as const },
          hitRate: {
            oneOf: [
              { type: 'number' as const },
              { type: 'null' as const },
            ] as const,
            required: true as const,
          },
          insufficient: { type: 'boolean' as const, required: true as const },
        },
      },
    },
    overconfidence: {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: {
        meanGap: {
          oneOf: [
            { type: 'number' as const },
            { type: 'null' as const },
          ] as const,
          required: true as const,
        },
        rate: {
          oneOf: [
            { type: 'number' as const },
            { type: 'null' as const },
          ] as const,
          required: true as const,
        },
        significant: { type: 'boolean' as const, required: true as const },
      },
    },
    excluded: {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: {
        notBackfilled: { type: 'number' as const, required: true as const },
        nonBinary: { type: 'number' as const, required: true as const },
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

export type CalibrateOutput = InferValue<typeof CALIBRATE_OUTPUT_SCHEMA>;

export const CALIBRATE_OUTPUT = {
  schema: CALIBRATE_OUTPUT_SCHEMA,
  render: (_args: unknown, value: unknown) => [
    { type: 'text' as const, text: JSON.stringify(value) },
  ],
};

// ── 纯函数（可单测）─────────────────────────────────────────────────

export interface CalibrateSample {
  /** 该 noul 判定的 P(yes)。 */
  p: number;
  /** 真值：confirmed → 1，rejected → 0。 */
  o: 0 | 1;
}

export interface CalibrateBucket {
  range: string;
  n: number;
  hitRate: number | null;
  insufficient: boolean;
}

export interface CalibrateOverconfidence {
  meanGap: number | null;
  rate: number | null;
  significant: boolean;
}

export interface CalibrateExcluded {
  notBackfilled: number;
  nonBinary: number;
}

export interface CalibrateMetrics {
  sampleSize: number;
  insufficientSample: boolean;
  brier: number | null;
  buckets: CalibrateBucket[];
  overconfidence: CalibrateOverconfidence;
  excluded: CalibrateExcluded;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** 桶标签：桶 i 覆盖 [i/10, (i+1)/10)，标签形如 "0.7–0.8"。 */
export function calibrateBucketLabel(index: number): string {
  const low = (index / CALIBRATE_BUCKET_COUNT).toFixed(1);
  const high = ((index + 1) / CALIBRATE_BUCKET_COUNT).toFixed(1);
  return `${low}–${high}`;
}

/** P(yes) → 桶下标（固定 10 桶；p=1.0 归入最后一桶）。 */
export function calibrateBucketIndex(p: number): number {
  const raw = Math.floor(p * CALIBRATE_BUCKET_COUNT);
  return Math.min(CALIBRATE_BUCKET_COUNT - 1, Math.max(0, raw));
}

/**
 * 从账本条目里挑出可参与统计的样本，并统计被排除的条目。
 *
 * 口径（契约 §9）：
 * - `status ≠ 'ok'` 的条目不是一次判定（失败 / 被拦截）→ 不计入任何桶；
 * - `payload.aggregated === true` 的条目是 self-consistency 的汇总副本
 *   （与分片条目重复）→ 跳过，避免重复计数；
 * - `questionType ≠ 'noul'` → `excluded.nonBinary`；
 * - noul + `outcome.state = 'revised'` → `excluded.nonBinary`；
 * - noul + `outcome.state = 'unknown'` → `excluded.notBackfilled`；
 * - noul + `outcome.state ∈ {confirmed, rejected}` 且 P(yes) 可用 → 样本。
 */
export function collectCalibrateEntries(entries: readonly LedgerEntry[]): {
  samples: CalibrateSample[];
  excluded: CalibrateExcluded;
} {
  const samples: CalibrateSample[] = [];
  let notBackfilled = 0;
  let nonBinary = 0;
  for (const entry of entries) {
    if (entry.status !== 'ok') continue;
    if (entry.payload.aggregated === true) continue;
    if (entry.questionType !== 'noul') {
      nonBinary += 1;
      continue;
    }
    const state = entry.outcome.state;
    if (state === 'revised') {
      nonBinary += 1;
      continue;
    }
    if (state !== 'confirmed' && state !== 'rejected') {
      notBackfilled += 1;
      continue;
    }
    const p = entry.payload.value;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
      notBackfilled += 1;
      continue;
    }
    samples.push({ p, o: state === 'confirmed' ? 1 : 0 });
  }
  return { samples, excluded: { notBackfilled, nonBinary } };
}

/** 桶级命中率（桶内 o 的均值）；桶内样本不足 → hitRate = null。 */
export function buildCalibrateBuckets(
  samples: readonly CalibrateSample[],
): CalibrateBucket[] {
  const counts = new Array<number>(CALIBRATE_BUCKET_COUNT).fill(0);
  const hits = new Array<number>(CALIBRATE_BUCKET_COUNT).fill(0);
  for (const sample of samples) {
    const index = calibrateBucketIndex(sample.p);
    counts[index] += 1;
    hits[index] += sample.o;
  }
  return counts.map((n, index) => {
    const insufficient = n < CALIBRATE_BUCKET_MIN_SAMPLES;
    return {
      range: calibrateBucketLabel(index),
      n,
      hitRate: insufficient || n === 0 ? null : round4(hits[index] / n),
      insufficient,
    };
  });
}

/**
 * Brier 分数与过自信指标（契约 §9）。
 *
 * `N < 20` → `insufficientSample = true`、`brier = null`、
 * `overconfidence.meanGap = null`（不硬算）；`rate` 仍是样本比例（N=0 时为 null），
 * `significant` 在样本不足时恒为 false。
 */
export function computeCalibrateMetrics(
  samples: readonly CalibrateSample[],
  excluded: CalibrateExcluded,
): CalibrateMetrics {
  const n = samples.length;
  const insufficientSample = n < CALIBRATE_MIN_SAMPLES;
  const buckets = buildCalibrateBuckets(samples);
  if (n === 0) {
    return {
      sampleSize: 0,
      insufficientSample: true,
      brier: null,
      buckets,
      overconfidence: { meanGap: null, rate: null, significant: false },
      excluded,
    };
  }
  let squaredError = 0;
  let gapSum = 0;
  let overconfident = 0;
  for (const sample of samples) {
    const gap = sample.p - sample.o;
    squaredError += gap * gap;
    gapSum += gap;
    if (gap > CALIBRATE_OVERCONFIDENCE_GAP) overconfident += 1;
  }
  const meanGap = round4(gapSum / n);
  return {
    sampleSize: n,
    insufficientSample,
    brier: insufficientSample ? null : round4(squaredError / n),
    buckets,
    overconfidence: {
      meanGap: insufficientSample ? null : meanGap,
      rate: round4(overconfident / n),
      significant: insufficientSample
        ? false
        : meanGap >= CALIBRATE_OVERCONFIDENCE_GAP,
    },
    excluded,
  };
}

// ── 运行入口 ────────────────────────────────────────────────────────

export interface CalibrateDeps {
  readConfig(): ResolvedToolsConfig;
  /** 账本；缺省无账本（无样本）。 */
  ledger?: LedgerSink;
}

export interface CalibratePlan {
  window: CalibrateWindow;
  tool: DecisionToolName | null;
}

export type CalibratePlanResult =
  | { ok: true; plan: CalibratePlan }
  | { ok: false; error: DecisionErrorEnvelope };

/** 入参校验：window 闭集；tool 缺省或属于十工具闭集。 */
export function planCalibrate(args: unknown): CalibratePlanResult {
  const raw = (args ?? {}) as Record<string, unknown>;
  const rawWindow = raw.window;
  let window: CalibrateWindow = CALIBRATE_DEFAULT_WINDOW;
  if (rawWindow !== undefined && rawWindow !== null) {
    if (
      typeof rawWindow !== 'string' ||
      !(CALIBRATE_WINDOWS as readonly string[]).includes(rawWindow)
    ) {
      return {
        ok: false,
        error: decisionError(
          'invalid-arguments',
          `window 仅接受 ${CALIBRATE_WINDOWS.join(' / ')}，收到 ${JSON.stringify(rawWindow)}`,
          { details: { window: rawWindow as JsonValue } },
        ),
      };
    }
    window = rawWindow as CalibrateWindow;
  }
  let tool: DecisionToolName | null = null;
  const rawTool = raw.tool;
  if (rawTool !== undefined && rawTool !== null) {
    if (typeof rawTool !== 'string' || rawTool.trim() === '') {
      return {
        ok: false,
        error: decisionError('invalid-arguments', 'tool 必须是非空字符串', {
          details: { tool: rawTool as JsonValue },
        }),
      };
    }
    // 与 history 的 tool 过滤同一闭集口径：拼错工具名直接报错，
    // 不静默返回空统计（否则「样本少」会被误读成「没有该工具的判定」）。
    if (!(DECISION_TOOL_NAMES as readonly string[]).includes(rawTool)) {
      return {
        ok: false,
        error: decisionError(
          'invalid-arguments',
          `tool 仅接受十工具闭集之一（${DECISION_TOOL_NAMES.join(' / ')}）`,
          { details: { tool: rawTool } },
        ),
      };
    }
    tool = rawTool as DecisionToolName;
  }
  return { ok: true, plan: { window, tool } };
}

/** 窗口起点（毫秒时间戳）；`all` 返回 null（不过滤时间）。 */
export function calibrateWindowStart(
  window: CalibrateWindow,
  now: number,
): number | null {
  if (window === 'all') return null;
  return now - WINDOW_MS[window];
}

export function errorBody(error: DecisionErrorEnvelope): {
  ok: false;
  error: JsonValue;
} {
  return { ok: false, error: error as unknown as JsonValue };
}

/** 校准主流程：只读账本 → 过滤 → 统计。 */
export function runCalibrate(
  args: unknown,
  deps: CalibrateDeps,
  now: number = Date.now(),
): ({ ok: true } & CalibrateMetrics) | { ok: false; error: JsonValue } {
  let config: ResolvedToolsConfig;
  try {
    config = deps.readConfig();
  } catch {
    return errorBody(
      decisionError('model-call-failed', '读取配置失败', {
        details: { stage: 'read-config' },
      }),
    );
  }
  const disabled = checkToolEnabled(config, CALIBRATE_TOOL);
  if (disabled) return errorBody(disabled);
  const planned = planCalibrate(args);
  if (!planned.ok) return errorBody(planned.error);
  const { window, tool } = planned.plan;
  const all = deps.ledger?.list() ?? [];
  const start = calibrateWindowStart(window, now);
  const filtered = all.filter((entry) => {
    if (tool !== null && entry.tool !== tool) return false;
    if (start === null) return true;
    const ts = Date.parse(entry.ts);
    return Number.isFinite(ts) && ts >= start && ts <= now;
  });
  const { samples, excluded } = collectCalibrateEntries(filtered);
  const metrics = computeCalibrateMetrics(samples, excluded);
  return { ok: true, ...metrics };
}

export function createCalibrateTool(deps: CalibrateDeps): ToolDefinition {
  return defineTool({
    name: CALIBRATE_TOOL,
    description: CALIBRATE_DESCRIPTION,
    parameters: CALIBRATE_PARAMETERS,
    output: CALIBRATE_OUTPUT,
    async execute(args: unknown): Promise<CalibrateOutput> {
      try {
        const result = runCalibrate(args, deps);
        return result as unknown as CalibrateOutput;
      } catch (thrown) {
        // 契约 §1.1：工具失败一律返回错误信封，绝不把异常抛给宿主。
        const message =
          thrown instanceof Error ? thrown.message : String(thrown);
        return {
          ok: false,
          error: {
            code: 'model-call-failed',
            message: `工具内部异常：${message}`.slice(0, 200),
            retryable: false,
            details: { stage: 'unexpected' },
          },
        } as unknown as CalibrateOutput;
      }
    },
  }) as ToolDefinition;
}
