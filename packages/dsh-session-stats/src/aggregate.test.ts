import { describe, expect, it } from 'vitest';
import { buildDashboard, normalizeRange, usageOfSession } from './aggregate.ts';
import { localDateKey } from './extract.ts';
import { emptyUsage } from './types.ts';
import type { LedgerRow, SessionRecord, TokenUsage } from './types.ts';

const DAY = 24 * 60 * 60 * 1000;

function usage(input: number, output: number, cacheRead = 0): TokenUsage {
  const u = emptyUsage();
  u.inputTokens = input;
  u.outputTokens = output;
  u.cacheReadTokens = cacheRead;
  u.totalTokens = input + output + cacheRead;
  u.calls = 1;
  return u;
}

let seq = 0;

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  seq += 1;
  const now = Date.now();
  return {
    id: `session-${seq}`,
    project: 'demo',
    cwd: 'E:\\demo',
    title: null,
    agentPreset: 'standard',
    createdAt: now - DAY,
    lastActiveAt: now - 3_600_000,
    activeMs: DAY - 3_600_000,
    turns: 2,
    steps: 5,
    userMessages: 3,
    assistantMessages: 4,
    toolCalls: 6,
    toolErrors: 1,
    tools: { pwsh: { calls: 6, totalDurationMs: 1_200, errors: 1 } },
    models: { 'prov-a|model-x': usage(100, 40, 60) },
    primaryModel: 'prov-a|model-x',
    daily: { '2026-09-28': usage(100, 40, 60) },
    hourly: new Array<number>(24).fill(0) as number[],
    retries: { RATE_LIMIT: 2 },
    sourceFile: `C:\\s\\session-${seq}`,
    fileBytes: 1,
    fileMtimeMs: 1,
    ...overrides,
  };
}

describe('dsh-session-stats 仪表盘聚合', () => {
  it('range 归一化与范围过滤', () => {
    expect(normalizeRange(undefined)).toBe('30d');
    expect(normalizeRange('bogus')).toBe('30d');
    expect(normalizeRange('7d')).toBe('7d');

    const old = makeSession({ lastActiveAt: Date.now() - 90 * DAY });
    const recent = makeSession();
    const dash = buildDashboard([old, recent], { range: '7d', ledgerRows: [] });
    expect(dash.overview.sessions).toBe(1);
    expect(dash.rangeFrom).not.toBeNull();
  });

  it('range=all 覆盖全部会话并汇总 overview', () => {
    const a = makeSession();
    const b = makeSession({ cwd: 'E:\\other', project: 'other' });
    const dash = buildDashboard([a, b], { range: 'all', ledgerRows: [] });
    expect(dash.overview.sessions).toBe(2);
    expect(dash.overview.projects).toBe(2);
    expect(dash.overview.messages).toBe(14);
    expect(dash.overview.toolCalls).toBe(12);
    expect(dash.overview.toolErrors).toBe(2);
    expect(dash.overview.usage.totalTokens).toBe(400);
    expect(dash.overview.retryCount).toBe(4);
    expect(dash.overview.topTool).toBe('pwsh');
  });

  it('每日曲线按 max 对账：账本覆盖归档缺口，会话数据保留精确值', () => {
    const session = makeSession(); // daily: 2026-09-28, total=200
    const ledger: LedgerRow[] = [
      // 账本该日记录更大（其余会话已归档）→ 用账本
      { date: '2026-09-28', provider: 'p', model: 'm', usage: usage(999, 999) },
      // 会话没有该日 → 纯账本补齐
      { date: '2026-09-20', provider: 'p', model: 'm', usage: usage(500, 500) },
      // 会话数据更大 → 保留会话精确值
      { date: '2026-09-27', provider: 'p', model: 'm', usage: usage(1, 1) },
    ];
    session.daily['2026-09-27'] = usage(100, 100);
    const dash = buildDashboard([session], {
      range: 'all',
      ledgerRows: ledger,
    });
    const day28 = dash.daily.find((d) => d.date === '2026-09-28');
    const day20 = dash.daily.find((d) => d.date === '2026-09-20');
    const day27 = dash.daily.find((d) => d.date === '2026-09-27');
    expect(day28?.source).toBe('ledger');
    expect(day28?.totalTokens).toBe(1998);
    expect(day28?.sessions).toBe(1);
    expect(day20?.source).toBe('ledger');
    expect(day20?.totalTokens).toBe(1000);
    expect(day27?.source).toBe('sessions');
    expect(day27?.totalTokens).toBe(200);
    // overview 与每日曲线口径一致
    expect(dash.overview.usage.totalTokens).toBe(1998 + 1000 + 200);
  });

  it('模型与 provider 行按用量排序并统计会话数', () => {
    const a = makeSession({
      models: {
        'prov-a|big': usage(1000, 0, 0),
        'prov-b|small': usage(10, 0, 0),
      },
      daily: { '2026-09-28': usage(1010, 0, 0) },
    });
    const dash = buildDashboard([a], { range: 'all', ledgerRows: [] });
    expect(dash.models[0]?.model).toBe('big');
    expect(dash.models[0]?.sessions).toBe(1);
    expect(dash.providers[0]?.provider).toBe('prov-a');
  });

  it('范围外的账本与会话日期不进入每日曲线', () => {
    const today = localDateKey(Date.now());
    const monthAgo = localDateKey(Date.now() - 30 * DAY);
    const session = makeSession({ lastActiveAt: Date.now() }); // 会话本身在范围内
    session.daily = {
      [monthAgo]: usage(10, 10),
      [today]: usage(20, 20),
    };
    const ledger: LedgerRow[] = [
      { date: monthAgo, provider: 'p', model: 'm', usage: usage(500, 500) },
      { date: today, provider: 'p', model: 'm', usage: usage(5, 5) },
    ];
    const dash = buildDashboard([session], { range: '7d', ledgerRows: ledger });
    expect(dash.daily.map((d) => d.date)).toEqual([today]);
    // 对账：会话 40 > 账本 10 → 会话胜出
    expect(dash.daily[0]?.source).toBe('sessions');
    expect(dash.daily[0]?.totalTokens).toBe(40);
    expect(dash.overview.activeDays).toBe(1);
  });

  it('usageOfSession 汇总 daily 桶', () => {
    const session = makeSession({
      daily: { d1: usage(10, 5), d2: usage(20, 5, 100) },
    });
    const total = usageOfSession(session);
    expect(total.inputTokens).toBe(30);
    expect(total.outputTokens).toBe(10);
    expect(total.cacheReadTokens).toBe(100);
    expect(total.totalTokens).toBe(140);
  });
});
