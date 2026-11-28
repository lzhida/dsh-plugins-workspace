import { describe, expect, it } from 'vitest';

import {
  HISTORY_DEFAULT_LIMIT,
  HISTORY_LIMIT_MAX,
  HISTORY_TOOL,
  createHistoryTool,
  planHistory,
  runHistory,
} from './history.ts';
import {
  type ResolvedToolsConfig,
  resolveToolsConfig,
} from '../config/decision-tools.ts';
import { type LedgerEntry, createMemoryLedger } from '../runtime/ledger.ts';
import type { FetchLike } from '../systemone/client.ts';
import type { JsonValue } from '../systemone/types.ts';

const ID_A = 'dec_0123456789ABCDEFGHJKMNPQRS';
const ID_B = 'dec_ABCDEFGHJKMNPQRS0123456789';

function config(overrides: Record<string, unknown> = {}): ResolvedToolsConfig {
  return resolveToolsConfig({
    toolsHistoryEnabled: true,
    ledgerEnabled: true,
    ...overrides,
  });
}

interface EntryInput {
  decisionId?: string;
  ts?: string;
  tool?: string;
  questionId?: string | null;
  questionType?: 'noul' | 'choice' | 'score' | 'box' | null;
  questionSummary?: string | null;
  status?: 'ok' | 'error' | 'blocked';
  value?: JsonValue;
  confidence?: number | null;
  distribution?: JsonValue;
  legend?: string[] | null;
}

function mkEntry(input: EntryInput = {}): LedgerEntry {
  return {
    decisionId: input.decisionId ?? ID_A,
    ts: input.ts ?? '2026-01-01T00:00:00.000Z',
    tool: input.tool ?? 'decision_decide',
    mode: 'primary',
    source: 'decision-model',
    questionId: input.questionId === undefined ? 'q1' : input.questionId,
    questionType:
      input.questionType === undefined ? 'noul' : input.questionType,
    questionSummary:
      input.questionSummary === undefined
        ? '原判定摘要'
        : input.questionSummary,
    status: input.status ?? 'ok',
    payload: {
      value: input.value === undefined ? 0.82 : input.value,
      confidence: input.confidence === undefined ? 0.9 : input.confidence,
      distribution:
        input.distribution === undefined ? null : input.distribution,
      legend: input.legend === undefined ? null : input.legend,
    },
    outcome: {
      state: 'unknown',
      value: null,
      source: null,
      updatedAt: null,
    },
    usage: { inputTokens: 10, outputTokens: 5, calls: 1 },
    latencyMs: 12,
    costUsd: null,
    costEstimated: false,
  };
}

function ledgerWith(entries: LedgerEntry[]) {
  const ledger = createMemoryLedger(100);
  for (const entry of entries) ledger.append(entry);
  return ledger;
}

/** 任何模型调用都会让计数 +1；纯本地查询必须保持 0。 */
function countingFetch(): { fetchImpl: FetchLike; calls: () => number } {
  let count = 0;
  const fetchImpl: FetchLike = async () => {
    count += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ answers: {} }),
    };
  };
  return { fetchImpl, calls: () => count };
}

describe('decision 工具族 history：决策历史查询（8/11）', () => {
  it('工具名与描述符合契约（纯本地、输出有界）', () => {
    expect(HISTORY_TOOL).toBe('decision_history');
  });

  it('空账本返回空列表而不是错误', () => {
    const out = runHistory(
      {},
      { readConfig: () => config(), ledger: ledgerWith([]) },
    );
    expect(out.ok).toBe(true);
    expect(out.entries).toEqual([]);
    expect(out.total).toBe(0);
    expect(out.truncated).toBe(false);
    expect(out.nextOffset).toBeNull();
  });

  it('按工具过滤', () => {
    const ledger = ledgerWith([
      mkEntry({ decisionId: ID_A, tool: 'decision_decide' }),
      mkEntry({ decisionId: ID_B, tool: 'decision_gate' }),
    ]);
    const out = runHistory(
      { tool: 'decision_gate' },
      { readConfig: () => config(), ledger },
    );
    expect(out.total).toBe(1);
    const entries = out.entries as Array<{ tool: string }>;
    expect(entries[0].tool).toBe('decision_gate');
  });

  it('按时间窗过滤（from/to 含端点）', () => {
    const ledger = ledgerWith([
      mkEntry({ decisionId: ID_A, ts: '2026-01-01T00:00:00.000Z' }),
      mkEntry({ decisionId: ID_B, ts: '2026-02-01T00:00:00.000Z' }),
    ]);
    const out = runHistory(
      {
        from: '2026-01-15T00:00:00.000Z',
        to: '2026-02-15T00:00:00.000Z',
      },
      { readConfig: () => config(), ledger },
    );
    expect(out.total).toBe(1);
    const entries = out.entries as Array<{ decisionId: string }>;
    expect(entries[0].decisionId).toBe(ID_B);
  });

  it('时间窗端点等值时仍命中（from===ts 与 to===ts）', () => {
    const ledger = ledgerWith([
      mkEntry({ decisionId: ID_A, ts: '2026-01-01T00:00:00.000Z' }),
      mkEntry({ decisionId: ID_B, ts: '2026-02-01T00:00:00.000Z' }),
    ]);
    const fromEq = runHistory(
      { from: '2026-02-01T00:00:00.000Z' },
      { readConfig: () => config(), ledger },
    );
    expect(fromEq.total).toBe(1);
    expect(
      (fromEq.entries as Array<{ decisionId: string }>)[0].decisionId,
    ).toBe(ID_B);
    const toEq = runHistory(
      { to: '2026-01-01T00:00:00.000Z' },
      { readConfig: () => config(), ledger },
    );
    expect(toEq.total).toBe(1);
    expect((toEq.entries as Array<{ decisionId: string }>)[0].decisionId).toBe(
      ID_A,
    );
  });

  it('按最低置信度过滤', () => {
    const ledger = ledgerWith([
      mkEntry({ decisionId: ID_A, confidence: 0.4 }),
      mkEntry({ decisionId: ID_B, confidence: 0.95 }),
    ]);
    const out = runHistory(
      { minConfidence: 0.8 },
      { readConfig: () => config(), ledger },
    );
    expect(out.total).toBe(1);
    const entries = out.entries as Array<{ confidence: number }>;
    expect(entries[0].confidence).toBe(0.95);
  });

  it('limit 截断且 total 记全量、nextOffset 给出下一页起点', () => {
    const entries = Array.from({ length: 5 }, (_item, index) =>
      mkEntry({
        decisionId: `dec_0123456789ABCDEFGHJKMNPQR${index}`,
        ts: `2026-01-0${index + 1}T00:00:00.000Z`,
      }),
    );
    const out = runHistory(
      { limit: 2 },
      { readConfig: () => config(), ledger: ledgerWith(entries) },
    );
    expect(out.total).toBe(5);
    expect((out.entries as unknown[]).length).toBe(2);
    expect(out.truncated).toBe(true);
    expect(out.nextOffset).toBe(2);
  });

  it('按 ts 倒序返回（最新在前）', () => {
    const ledger = ledgerWith([
      mkEntry({ decisionId: ID_A, ts: '2026-01-01T00:00:00.000Z' }),
      mkEntry({ decisionId: ID_B, ts: '2026-03-01T00:00:00.000Z' }),
    ]);
    const out = runHistory({}, { readConfig: () => config(), ledger });
    const entries = out.entries as Array<{ decisionId: string }>;
    expect(entries[0].decisionId).toBe(ID_B);
    expect(entries[1].decisionId).toBe(ID_A);
  });

  it('纯本地查询：模型未配置时仍可用且不发起任何模型调用', () => {
    const { fetchImpl, calls } = countingFetch();
    const ledger = ledgerWith([mkEntry()]);
    const unconfigured = config({
      systemoneBaseUrl: '',
      systemoneApiKey: '',
      systemoneModel: '',
    });
    const out = runHistory({}, { readConfig: () => unconfigured, ledger });
    expect(out.ok).toBe(true);
    expect(out.total).toBe(1);
    expect(calls()).toBe(0);
    expect(fetchImpl).toBeDefined();
  });

  it('输出不含 state 原文与上下文回灌（只有摘要与判定字段）', () => {
    const ledger = ledgerWith([mkEntry({ questionSummary: '发布是否就绪' })]);
    const out = runHistory({}, { readConfig: () => config(), ledger });
    const text = JSON.stringify(out);
    // 视图层是白名单字段：不得出现 state / apiKey / 上下文之类键。
    expect(text).not.toContain('"state"');
    expect(text).not.toContain('apiKey');
    expect(text).not.toContain('context');
    const entries = out.entries as Array<Record<string, unknown>>;
    expect(Object.keys(entries[0]).sort()).toEqual([
      'confidence',
      'decisionId',
      'mode',
      'questionId',
      'questionSummary',
      'source',
      'tool',
      'ts',
      'value',
    ]);
  });

  it('只列成功判定条目：错误与拦截条目不是判定', () => {
    const ledger = ledgerWith([
      mkEntry({ decisionId: ID_A, status: 'ok' }),
      mkEntry({ decisionId: ID_B, status: 'error' }),
    ]);
    const out = runHistory({}, { readConfig: () => config(), ledger });
    expect(out.total).toBe(1);
  });

  it('开关关闭时返回 tool-disabled', () => {
    const out = runHistory(
      {},
      { readConfig: () => config({ toolsHistoryEnabled: false }) },
    );
    expect(out.ok).toBe(false);
    const error = out.error as { code: string };
    expect(error.code).toBe('tool-disabled');
  });

  it('入参越界一律 invalid-arguments', () => {
    const bad = [
      { limit: 0 },
      { limit: HISTORY_LIMIT_MAX + 1 },
      { limit: 1.5 },
      { minConfidence: 1.5 },
      { minConfidence: -0.1 },
      { from: 'not-a-date' },
      { tool: 'not_a_tool' },
      { from: '2026-02-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' },
    ];
    for (const args of bad) {
      const result = planHistory(args);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid-arguments');
    }
    const ok = planHistory({});
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.plan.limit).toBe(HISTORY_DEFAULT_LIMIT);
  });

  it('工具工厂产出的工具名正确且可执行', async () => {
    const tool = createHistoryTool({
      readConfig: () => config(),
      ledger: ledgerWith([mkEntry()]),
    });
    expect(tool.name).toBe(HISTORY_TOOL);
    const result = (await tool.execute({}, {
      signal: new AbortController().signal,
    } as never)) as { ok: boolean; total: number };
    expect(result.ok).toBe(true);
    expect(result.total).toBe(1);
  });
});
