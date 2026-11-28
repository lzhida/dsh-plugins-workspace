/**
 * decision_history：决策历史查询（决策工具系列 8/11）。
 *
 * 契约来源：docs/decision-tools-contract.md §3.7（入参/出参/定稿口径）、
 * §5.1（账本条目结构与硬约束）、§1.3（纯本地工具豁免）。
 *
 * 纯本地查询：不发起任何模型调用——LOCAL_ONLY_TOOLS 成员之一，
 * 模型未配置时 history 照常可用（与 recheck 的关键区别）。
 *
 * 输出有界：每条只回 decisionId / ts / tool / questionId / 摘要 /
 * 判定值 / confidence / source / mode，绝不回灌 state 原文、题目全文
 * 或任何上下文（契约 §1.1「输出有界」+ §3.7）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { InferValue, ToolDefinition } from '@deepseek-ai/dsh-tools';

import {
  DECISION_TOOL_NAMES,
  type DecisionToolName,
  type ResolvedToolsConfig,
} from '../config/index.ts';
import { checkToolEnabled, type LedgerSink } from '../runtime/index.ts';
import {
  decisionError,
  type DecisionErrorEnvelope,
} from '../systemone/errors.ts';
import type { JsonValue } from '../systemone/types.ts';

export const HISTORY_TOOL = 'decision_history' as const;

/** limit 闭集（契约 §3.7）：1..200，缺省 50。 */
export const HISTORY_LIMIT_MIN = 1;
export const HISTORY_LIMIT_MAX = 200;
export const HISTORY_DEFAULT_LIMIT = 50;

export const HISTORY_DESCRIPTION = [
  'Purpose: list past decision-model judgements from the local ledger so a caller can trace what was decided.',
  'Constraints: purely local query over the ledger; never calls the decision model; output is bounded by limit and never echoes input state or context.',
  'Actions: filter by tool, ISO-8601 time window and minimum confidence; return newest first with total/truncated/nextOffset.',
  'Output is bounded: { ok, entries[], total, truncated, nextOffset } where each entry holds { decisionId, ts, tool, questionId, questionSummary, value, confidence, source, mode }; no free-form text is returned.',
].join(' ');

export const HISTORY_PARAMETERS = {
  tool: {
    type: 'string' as const,
    description: `按工具过滤（${DECISION_TOOL_NAMES.join(' / ')}）；缺省不过滤。`,
  },
  from: {
    type: 'string' as const,
    description: '起始时间（ISO-8601，含端点）；缺省不限。',
  },
  to: {
    type: 'string' as const,
    description: '结束时间（ISO-8601，含端点）；缺省不限。',
  },
  minConfidence: {
    type: 'number' as const,
    description: '最低置信度（0..1）；缺省不过滤。',
  },
  limit: {
    type: 'integer' as const,
    description: `返回条数上限（${HISTORY_LIMIT_MIN}..${HISTORY_LIMIT_MAX}，缺省 ${HISTORY_DEFAULT_LIMIT}）。`,
  },
} as const;

export const HISTORY_OUTPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: true as const,
  properties: {
    ok: { type: 'boolean' as const, required: true as const },
    entries: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          decisionId: { type: 'string' as const, required: true as const },
          ts: { type: 'string' as const, required: true as const },
          tool: { type: 'string' as const, required: true as const },
          questionId: {
            oneOf: [
              { type: 'string' as const },
              { type: 'null' as const },
            ] as const,
          },
          questionSummary: {
            oneOf: [
              { type: 'string' as const },
              { type: 'null' as const },
            ] as const,
            description:
              '问题摘要（≤120 字符，账本里已截断；不含 state 原文）。',
          },
          value: { type: 'json' as const, description: '判定值。' },
          confidence: {
            oneOf: [
              { type: 'number' as const },
              { type: 'null' as const },
            ] as const,
          },
          source: { type: 'string' as const, required: true as const },
          mode: { type: 'string' as const, required: true as const },
        },
      },
    },
    total: {
      type: 'integer' as const,
      description: '过滤后总条数（不受 limit 影响）。',
    },
    truncated: { type: 'boolean' as const },
    nextOffset: {
      oneOf: [{ type: 'integer' as const }, { type: 'null' as const }] as const,
      description: '被截断时给出下一页起始偏移；未截断为 null。',
    },
    error: {
      type: 'object' as const,
      additionalProperties: true as const,
    },
  },
} as const;

// ── 入参规划 ─────────────────────────────────────────────────────────

/** history 出参类型（由 schema 推断，工具 execute 需精确匹配）。 */
export type HistoryOutput = InferValue<typeof HISTORY_OUTPUT_SCHEMA>;

export interface HistoryPlan {
  tool: DecisionToolName | null;
  fromMs: number | null;
  toMs: number | null;
  minConfidence: number | null;
  limit: number;
}

export function planHistory(
  args: unknown,
):
  | { ok: true; plan: HistoryPlan }
  | { ok: false; error: DecisionErrorEnvelope } {
  if (typeof args !== 'object' || args === null) {
    return {
      ok: false,
      error: decisionError('invalid-arguments', 'history 入参必须是对象'),
    };
  }
  const raw = args as {
    tool?: unknown;
    from?: unknown;
    to?: unknown;
    minConfidence?: unknown;
    limit?: unknown;
  };

  let tool: DecisionToolName | null = null;
  if (raw.tool !== undefined && raw.tool !== null) {
    if (typeof raw.tool !== 'string' || raw.tool.trim() === '') {
      return {
        ok: false,
        error: decisionError('invalid-arguments', 'tool 必须是非空字符串'),
      };
    }
    if (!(DECISION_TOOL_NAMES as readonly string[]).includes(raw.tool)) {
      return {
        ok: false,
        error: decisionError(
          'invalid-arguments',
          `tool 仅接受十工具闭集之一（${DECISION_TOOL_NAMES.join(' / ')}）`,
        ),
      };
    }
    tool = raw.tool as DecisionToolName;
  }

  const parseTime = (
    value: unknown,
    label: string,
  ):
    | { ok: true; value: number | null }
    | { ok: false; error: DecisionErrorEnvelope } => {
    if (value === undefined || value === null) return { ok: true, value: null };
    if (typeof value !== 'string' || value.trim() === '') {
      return {
        ok: false,
        error: decisionError(
          'invalid-arguments',
          `${label} 必须是非空 ISO-8601 时间串`,
        ),
      };
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      return {
        ok: false,
        error: decisionError(
          'invalid-arguments',
          `${label} 不是可解析的 ISO-8601 时间（${value}）`,
        ),
      };
    }
    return { ok: true, value: parsed };
  };

  const from = parseTime(raw.from, 'from');
  if (!from.ok) return { ok: false, error: from.error };
  const to = parseTime(raw.to, 'to');
  if (!to.ok) return { ok: false, error: to.error };
  const fromMs = from.value;
  const toMs = to.value;
  if (fromMs !== null && toMs !== null && fromMs > toMs) {
    return {
      ok: false,
      error: decisionError('invalid-arguments', 'from 不得晚于 to'),
    };
  }

  let minConfidence: number | null = null;
  if (raw.minConfidence !== undefined && raw.minConfidence !== null) {
    if (
      typeof raw.minConfidence !== 'number' ||
      !Number.isFinite(raw.minConfidence) ||
      raw.minConfidence < 0 ||
      raw.minConfidence > 1
    ) {
      return {
        ok: false,
        error: decisionError(
          'invalid-arguments',
          'minConfidence 必须是 0..1 的数',
        ),
      };
    }
    minConfidence = raw.minConfidence;
  }

  let limit = HISTORY_DEFAULT_LIMIT;
  if (raw.limit !== undefined && raw.limit !== null) {
    if (
      typeof raw.limit !== 'number' ||
      !Number.isInteger(raw.limit) ||
      raw.limit < HISTORY_LIMIT_MIN ||
      raw.limit > HISTORY_LIMIT_MAX
    ) {
      return {
        ok: false,
        error: decisionError(
          'invalid-arguments',
          `limit 必须是 ${HISTORY_LIMIT_MIN}..${HISTORY_LIMIT_MAX} 的整数`,
        ),
      };
    }
    limit = raw.limit;
  }

  return {
    ok: true,
    plan: { tool, fromMs, toMs, minConfidence, limit },
  };
}

// ── 主流程 ───────────────────────────────────────────────────────────

function errorBody(error: DecisionErrorEnvelope): Record<string, JsonValue> {
  return { ok: false, error: error as unknown as JsonValue };
}

export interface HistoryDeps {
  readConfig: () => ResolvedToolsConfig;
  ledger?: LedgerSink;
}

export interface HistoryEntryView {
  decisionId: string;
  ts: string;
  tool: string;
  questionId: string | null;
  questionSummary: string | null;
  value: JsonValue;
  confidence: number | null;
  source: string;
  mode: string;
}

/**
 * 过滤 + 排序（ts 倒序，最新在前，契约 §3.7）。
 * 只保留 status='ok' 的判定条目：错误/拦截条目不是「判定」，不进历史。
 */
export function filterHistoryEntries(
  entries: readonly {
    decisionId: string;
    ts: string;
    tool: string;
    questionId: string | null;
    questionSummary: string | null;
    status: string;
    payload: {
      value: JsonValue | null;
      confidence: number | null;
    };
    source: string;
    mode: string;
  }[],
  plan: HistoryPlan,
): HistoryEntryView[] {
  const filtered = entries.filter((entry) => {
    if (entry.status !== 'ok') return false;
    if (plan.tool !== null && entry.tool !== plan.tool) return false;
    if (plan.fromMs !== null || plan.toMs !== null) {
      const ts = Date.parse(entry.ts);
      if (!Number.isFinite(ts)) return false;
      if (plan.fromMs !== null && ts < plan.fromMs) return false;
      if (plan.toMs !== null && ts > plan.toMs) return false;
    }
    if (plan.minConfidence !== null) {
      const confidence = entry.payload.confidence;
      if (confidence === null) return false;
      if (confidence < plan.minConfidence) return false;
    }
    return true;
  });
  return filtered
    .slice()
    .sort((a, b) => {
      const left = Date.parse(a.ts);
      const right = Date.parse(b.ts);
      if (Number.isFinite(left) && Number.isFinite(right) && left !== right) {
        return right - left;
      }
      return a.decisionId < b.decisionId
        ? 1
        : a.decisionId > b.decisionId
          ? -1
          : 0;
    })
    .map((entry) => ({
      decisionId: entry.decisionId,
      ts: entry.ts,
      tool: entry.tool,
      questionId: entry.questionId,
      questionSummary: entry.questionSummary,
      value: entry.payload.value,
      confidence: entry.payload.confidence,
      source: entry.source,
      mode: entry.mode,
    }));
}

export function runHistory(
  args: unknown,
  deps: HistoryDeps,
): Record<string, JsonValue> {
  let config: ResolvedToolsConfig;
  try {
    config = deps.readConfig();
  } catch {
    return errorBody(
      decisionError('model-call-failed', '读取决策工具配置失败（内部错误）', {
        details: { stage: 'read-config' },
      }),
    );
  }
  const disabled = checkToolEnabled(config, HISTORY_TOOL);
  if (disabled !== null) return errorBody(disabled);

  const planned = planHistory(args);
  if (!planned.ok) return errorBody(planned.error);
  const plan = planned.plan;

  const entries = deps.ledger?.list() ?? [];
  const matched = filterHistoryEntries(entries, plan);
  const page = matched.slice(0, plan.limit);
  const truncated = matched.length > page.length;

  return {
    ok: true,
    entries: page as unknown as JsonValue,
    total: matched.length,
    truncated,
    nextOffset: truncated ? page.length : null,
  };
}

export function createHistoryTool(deps: HistoryDeps): ToolDefinition {
  return defineTool({
    name: HISTORY_TOOL,
    description: HISTORY_DESCRIPTION,
    parameters: HISTORY_PARAMETERS,
    output: {
      schema: HISTORY_OUTPUT_SCHEMA,
      render: (_args, value) => [
        { type: 'text' as const, text: JSON.stringify(value) },
      ],
    },
    async execute(args: unknown): Promise<HistoryOutput> {
      try {
        return runHistory(args, deps) as unknown as HistoryOutput;
      } catch (thrown) {
        const message =
          thrown instanceof Error ? thrown.message : String(thrown);
        return {
          ok: false,
          error: {
            code: 'model-call-failed',
            message: `工具内部异常：${message}`,
            retryable: false,
            details: { stage: 'unexpected' },
          },
        } as unknown as HistoryOutput;
      }
    },
  }) as ToolDefinition;
}
