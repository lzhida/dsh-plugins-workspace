import { describe, expect, it } from 'vitest';
import { extractSession, localDateKey } from './extract.ts';

const META = {
  sourceFile: 'C:\\sessions\\proj\\session-x\\session.v4.jsonl.zstd',
  fileBytes: 100,
  fileMtimeMs: 1_700_000_000_000,
};

function ev(type: string, time: number, data: unknown): string {
  return JSON.stringify({ type, seq: 0, time, data });
}

function sessionLines(): string[] {
  const t0 = new Date('2026-09-28T10:00:00+08:00').getTime();
  const lines = [
    JSON.stringify({
      type: 'session',
      version: 4,
      id: 'session-abc',
      createdAt: t0,
      cwd: 'E:\\workspace\\demo-project',
      agentPreset: 'standard',
    }),
    ev('turn/start', t0 + 10, { turn: 1 }),
    ev('step/start', t0 + 20, { turn: 1, step: 1 }),
    ev('request/context', t0 + 30, {
      provider: 'glm-coding-plan-max',
      model: 'glm-5.3-flash',
      contextWindow: 1_000_000,
    }),
    ev('user/message', t0 + 40, { content: [] }),
    ev('assistant/message', t0 + 1_000, {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [] },
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900 },
    }),
    ev('tool/call', t0 + 1_100, {
      turn: 1,
      step: 1,
      callId: 'call-1',
      name: 'pwsh',
    }),
    ev('tool/result', t0 + 1_600, {
      turn: 1,
      step: 1,
      callId: 'call-1',
      message: {},
    }),
    ev('tool/call', t0 + 1_700, {
      turn: 1,
      step: 1,
      callId: 'call-2',
      name: 'pwsh',
    }),
    ev('tool/result', t0 + 1_800, {
      turn: 1,
      step: 1,
      callId: 'call-2',
      isError: true,
    }),
    ev('assistant/message', t0 + 2_000, {
      turn: 1,
      step: 2,
      message: { role: 'assistant', content: [] },
      usage: { inputTokens: 200, outputTokens: 80 },
    }),
    ev('step/end', t0 + 2_100, { turn: 1, step: 1 }),
    ev('turn/end', t0 + 2_200, { turn: 1, reason: { kind: 'completed' } }),
    ev('llm/retry', t0 + 2_300, {
      failure: { code: 'RATE_LIMIT', message: '429' },
    }),
    ev('session/title', t0 + 2_400, {
      title: '修复统计面板',
      source: { kind: 'fallback' },
    }),
  ];
  return lines;
}

describe('dsh-session-stats 会话事件提取', () => {
  it('从事件流聚合出会话、用量、工具、标题与重试统计', () => {
    const record = extractSession(sessionLines(), META);
    expect(record).not.toBeNull();
    expect(record?.id).toBe('session-abc');
    expect(record?.project).toBe('demo-project');
    expect(record?.title).toBe('修复统计面板');
    expect(record?.turns).toBe(1);
    expect(record?.steps).toBe(1);
    expect(record?.userMessages).toBe(1);
    expect(record?.assistantMessages).toBe(2);
    expect(record?.toolCalls).toBe(2);
    expect(record?.toolErrors).toBe(1);
    expect(record?.primaryModel).toBe('glm-coding-plan-max|glm-5.3-flash');
    expect(record?.models['glm-coding-plan-max|glm-5.3-flash']?.calls).toBe(2);
    expect(
      record?.models['glm-coding-plan-max|glm-5.3-flash']?.inputTokens,
    ).toBe(300);
    expect(
      record?.models['glm-coding-plan-max|glm-5.3-flash']?.outputTokens,
    ).toBe(130);
    expect(
      record?.models['glm-coding-plan-max|glm-5.3-flash']?.cacheReadTokens,
    ).toBe(900);
    // total = input + output + cacheRead
    expect(
      record?.models['glm-coding-plan-max|glm-5.3-flash']?.totalTokens,
    ).toBe(1330);
    expect(record?.tools['pwsh']?.calls).toBe(2);
    expect(record?.tools['pwsh']?.errors).toBe(1);
    // call-1 耗时 500ms；call-2 耗时 100ms
    expect(record?.tools['pwsh']?.totalDurationMs).toBe(600);
    expect(record?.retries['RATE_LIMIT']).toBe(1);
  });

  it('把用量落到本地日期与小时桶', () => {
    const record = extractSession(sessionLines(), META);
    expect(record).not.toBeNull();
    const dateKeys = Object.keys(record?.daily ?? {});
    expect(dateKeys).toEqual([
      localDateKey(new Date('2026-09-28T10:00:00+08:00').getTime() + 1_000),
    ]);
    const usage = record?.daily[dateKeys[0]];
    expect(usage?.calls).toBe(2);
    expect(usage?.totalTokens).toBe(1330);
    const hour = new Date(
      new Date('2026-09-28T10:00:00+08:00').getTime() + 1_000,
    ).getHours();
    expect(record?.hourly[hour]).toBe(2);
  });

  it('缺 session 头时返回 null', () => {
    expect(extractSession([ev('turn/start', 1, {})], META)).toBeNull();
  });

  it('容忍损坏的 JSONL 行', () => {
    const record = extractSession(['{broken json', ...sessionLines()], META);
    expect(record?.id).toBe('session-abc');
  });
});
