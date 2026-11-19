import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from './index.ts';
import {
  type UsageStats,
  KEEP_DAYS,
  MAX_RECENT,
  buildUsageSnapshot,
  bumpAttempt,
  bumpCooldownMark,
  bumpFailure,
  bumpSwitch,
  dayKeyOf,
  emptyUsage,
  loadUsageFile,
  persistUsageFile,
  pruneUsage,
} from './observability.ts';

describe('observability(切换可观测性)', () => {
  describe('dayKeyOf(本地日期键)', () => {
    it('格式化为 YYYY-MM-DD 且月份/日期补零', () => {
      expect(dayKeyOf(new Date(2026, 0, 5))).toBe('2026-01-05');
      expect(dayKeyOf(new Date(2026, 10, 19))).toBe('2026-11-19');
    });
  });

  describe('bump 系列(按天×候选累加)', () => {
    it('同一候选同日累加,不同候选/日期互不串扰', () => {
      const stats = emptyUsage();
      bumpAttempt(stats, '2026-11-19', 'a/x');
      bumpAttempt(stats, '2026-11-19', 'a/x');
      bumpFailure(stats, '2026-11-19', 'a/x');
      bumpSwitch(stats, '2026-11-19', 'b/y');
      bumpCooldownMark(stats, '2026-11-18', 'a/x');
      expect(stats.days['2026-11-19']?.['a/x']).toEqual({
        attempts: 2,
        failures: 1,
        cooldownMarks: 0,
        switches: 0,
      });
      expect(stats.days['2026-11-19']?.['b/y']?.switches).toBe(1);
      expect(stats.days['2026-11-18']?.['a/x']?.cooldownMarks).toBe(1);
    });

    it('磁盘上的损坏桶(字段缺失)在累加时重置为零值桶', () => {
      const stats: UsageStats = {
        version: 1,
        days: {
          '2026-11-19': {
            'a/x': { attempts: 'oops' } as unknown as never,
          },
        },
      };
      bumpAttempt(stats, '2026-11-19', 'a/x');
      expect(stats.days['2026-11-19']?.['a/x']).toEqual({
        attempts: 1,
        failures: 0,
        cooldownMarks: 0,
        switches: 0,
      });
    });
  });

  describe('pruneUsage(保留窗口)', () => {
    it('删除窗口外的日期,窗口内与当天保留,并报告是否发生删除', () => {
      const stats = emptyUsage();
      stats.days['2026-11-01'] = {};
      stats.days['2026-11-05'] = {};
      stats.days['2026-11-06'] = {};
      stats.days['2026-11-19'] = {};
      // 今天 11-19,保留 14 天 → 窗口起点 11-06(含当天共 14 个自然日),
      // 11-01 / 11-05 应删,11-06 边界日与 11-19 应保留。
      expect(pruneUsage(stats, '2026-11-19')).toBe(true);
      expect(stats.days['2026-11-01']).toBeUndefined();
      expect(stats.days['2026-11-05']).toBeUndefined();
      expect(stats.days['2026-11-06']).toBeDefined();
      expect(stats.days['2026-11-19']).toBeDefined();
      // 再跑一遍:无事可删。
      expect(pruneUsage(stats, '2026-11-19')).toBe(false);
    });

    it('非法日期键直接返回 false 不动数据', () => {
      const stats = emptyUsage();
      stats.days['2026-11-19'] = {};
      expect(pruneUsage(stats, 'not-a-date')).toBe(false);
      expect(stats.days['2026-11-19']).toBeDefined();
    });

    it('默认保留窗口为 14 天', () => {
      expect(KEEP_DAYS).toBe(14);
    });
  });

  describe('loadUsageFile / persistUsageFile(落盘往返)', () => {
    let dir: string;
    let file: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'llmfb-obs-'));
      file = join(dir, 'usage.json');
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('persist 后 load 原样恢复', () => {
      const stats = emptyUsage();
      bumpSwitch(stats, '2026-11-19', 'a/x');
      bumpAttempt(stats, '2026-11-19', 'a/x');
      persistUsageFile(file, stats);
      const loaded = loadUsageFile(file);
      expect(loaded.version).toBe(1);
      expect(loaded.days['2026-11-19']?.['a/x']).toEqual({
        attempts: 1,
        failures: 0,
        cooldownMarks: 0,
        switches: 1,
      });
    });

    it('缺文件/坏 JSON/版本不对/缺 days 都回落空表,绝不抛', () => {
      expect(loadUsageFile(join(dir, 'missing.json'))).toEqual(emptyUsage());
      writeFileSync(file, '{ not json');
      expect(loadUsageFile(file)).toEqual(emptyUsage());
      writeFileSync(file, JSON.stringify({ version: 2, days: {} }));
      expect(loadUsageFile(file)).toEqual(emptyUsage());
      writeFileSync(file, JSON.stringify({ version: 1 }));
      expect(loadUsageFile(file)).toEqual(emptyUsage());
    });

    it('persist 在不存在的目录下自动建目录', () => {
      const nested = join(dir, 'deep', 'dir', 'usage.json');
      persistUsageFile(nested, emptyUsage());
      expect(loadUsageFile(nested)).toEqual(emptyUsage());
    });
  });

  describe('buildUsageSnapshot(面板快照)', () => {
    it('候选按 switches+failures 降序,totals 为合计,零活动候选不出现', () => {
      const stats = emptyUsage();
      bumpSwitch(stats, '2026-11-19', 'quiet/a');
      bumpSwitch(stats, '2026-11-19', 'busy/b');
      bumpFailure(stats, '2026-11-19', 'busy/b');
      bumpFailure(stats, '2026-11-19', 'busy/b');
      bumpSwitch(stats, '2026-11-19', 'busy/b');
      bumpSwitch(stats, '2026-11-19', 'mid/c');
      bumpFailure(stats, '2026-11-19', 'mid/c');
      const snap = buildUsageSnapshot(stats, '2026-11-19', [], 0);
      expect(snap.day).toBe('2026-11-19');
      expect(snap.candidates.map((c) => c.route)).toEqual([
        'busy/b',
        'mid/c',
        'quiet/a',
      ]);
      expect(snap.totals).toEqual({
        attempts: 0,
        failures: 3,
        cooldownMarks: 0,
        switches: 4,
      });
      expect(snap.incidents).toBe(0);
    });

    it('空表给出零值快照;recent 按传入顺序截断到 MAX_RECENT', () => {
      const snap = buildUsageSnapshot(emptyUsage(), '2026-11-19', [], 2);
      expect(snap.totals).toEqual({
        attempts: 0,
        failures: 0,
        cooldownMarks: 0,
        switches: 0,
      });
      expect(snap.candidates).toEqual([]);
      expect(snap.incidents).toBe(2);
      const recent = Array.from({ length: MAX_RECENT + 5 }, (_, i) => ({
        at: i,
        from: 'a',
        to: 'b',
        reason: 'RATE_LIMIT',
      }));
      expect(
        buildUsageSnapshot(emptyUsage(), '2026-11-19', recent, 0).recent,
      ).toHaveLength(MAX_RECENT);
    });
  });
});

// ── apply 集成:守卫(旧装配)两分支 + 状态路由 ─────────────────────────

/** 集成用 agent 假体(带官方 model 面,select 同步更新 current)。 */
function obsAgent(
  initial: { provider: string; model: string } = {
    provider: 'deepseek',
    model: 'x',
  },
): {
  agent: {
    session: {
      id: string;
      append: (type: string, data: Record<string, unknown>) => void;
    };
    model: {
      current: () => { provider: string; model: string } | undefined;
      select: (sel: { provider: string; model: string }) => void;
    };
  };
  selections: Array<{ provider: string; model: string }>;
} {
  const selections: Array<{ provider: string; model: string }> = [];
  let currentSelection: { provider: string; model: string } | undefined =
    initial;
  const agent = {
    session: {
      id: 'sess-obs',
      append: (): void => {},
    },
    model: {
      current: (): { provider: string; model: string } | undefined =>
        currentSelection,
      select(sel: { provider: string; model: string }): void {
        selections.push({ ...sel });
        currentSelection = { provider: sel.provider, model: sel.model };
      },
    },
  };
  return { agent, selections };
}

describe('observability apply 集成(守卫 + 状态路由)', () => {
  let homeDir: string;
  const realHome = process.env.DSH_HOME;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    homeDir = mkdtempSync(join(tmpdir(), 'llmfb-obs-home-'));
    // 统计落盘隔离:绝不写真实 ~/.dsh。
    process.env.DSH_HOME = homeDir;
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = realHome;
    rmSync(homeDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** 带可注入 webServer 的 ctx 假体;register 记录路由并返回 dispose。 */
  function setupObs(config: Record<string, unknown> = {}): {
    req: unknown;
    err: unknown;
    routes: Array<{
      path: string;
      handler: (
        req: { url?: string },
        res: {
          writeHead: (status: number, headers: Record<string, string>) => void;
          end: (body?: string) => void;
        },
      ) => Promise<void>;
    }>;
  } {
    const listeners: Array<{ event: string; listener: unknown }> = [];
    const routes: Array<{
      path: string;
      handler: (
        req: { url?: string },
        res: {
          writeHead: (status: number, headers: Record<string, string>) => void;
          end: (body?: string) => void;
        },
      ) => Promise<void>;
    }> = [];
    const ctx = {
      effect(fn: () => unknown): void {
        fn();
      },
      systemPrompt: {
        section(): () => void {
          return () => {};
        },
      },
      on(event: string, listener: unknown): () => boolean {
        listeners.push({ event, listener });
        return () => true;
      },
      inject(names: readonly string[], cb: (sub: unknown) => void): void {
        if (!names.includes('webServer')) return;
        cb({
          webServer: {
            register(route: {
              path: string;
              handler: (typeof routes)[number]['handler'];
            }): () => void {
              routes.push(route);
              return () => {};
            },
          },
        });
      },
    } as unknown as Context;
    apply(ctx, {
      fallbackChains: ['openai/a', 'anthropic/b'],
      baseDelayMs: 0,
      maxDelayMs: 0,
      ...config,
    });
    return {
      req: listeners.find((l) => l.event === 'agent/request')?.listener,
      err: listeners.find((l) => l.event === 'agent/request-error')?.listener,
      routes,
    };
  }

  const sig = (): AbortSignal => new AbortController().signal;
  const stepReq = (turn: number, step: number): Record<string, unknown> => ({
    turn,
    step,
    signal: sig(),
  });
  const stepErr = (turn: number, step: number): Record<string, unknown> => ({
    turn,
    step,
    provider: 'deepseek',
    failure: { code: 'RATE_LIMIT', message: 'rate limited' },
    signal: sig(),
  });
  const call = (
    listener: unknown,
    payload: unknown,
    seed: { provider: string; model: string } = {
      provider: 'deepseek',
      model: 'x',
    },
  ): Promise<unknown> =>
    (listener as (p: unknown, n: () => Promise<unknown>) => Promise<unknown>)(
      payload,
      async () => ({ ...seed }),
    );

  it('守卫生效分支:切换后下一 step selection 已更新 → 不告警', async () => {
    vi.useFakeTimers();
    const { req, err, routes } = setupObs();
    const { agent, selections } = obsAgent();
    await call(req, { ...stepReq(1, 1), agent });
    await call(err, { ...stepErr(1, 1), agent });
    // 正向断言:切换确实发生(经 agent.model.select 写入一次)。
    expect(selections).toEqual([{ provider: 'openai', model: 'a' }]);
    // 官方 select 已持久化新候选(current=openai/a),下一 step seed 一致。
    await call(
      req,
      { ...stepReq(2, 1), agent },
      { provider: 'openai', model: 'a' },
    );
    const warn = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(warn.some((line) => line.includes('guard:'))).toBe(false);
    // 事故计数保持 0(经状态路由确认)。
    const calls: { status?: number; body?: string } = {};
    await routes[0].handler(
      { url: '/dsh-llm-fallback/status' },
      {
        writeHead(s: number) {
          calls.status = s;
        },
        end(b?: string) {
          calls.body = b;
        },
      },
    );
    const payload = JSON.parse(calls.body ?? '{}') as {
      value: { incidents: number };
    };
    expect(payload.value.incidents).toBe(0);
  });

  it('同 step 官方 retry 重入不消费守卫期望:不告警且期望保留到新 step', async () => {
    vi.useFakeTimers();
    const { req, err, routes } = setupObs();
    const { agent } = obsAgent();
    await call(req, { ...stepReq(1, 1), agent });
    await call(err, { ...stepErr(1, 1), agent });
    // 宿主 loop 同 step retry:重发请求再次触发 agent/request(turn/step
    // 不变,state 还是切换当 step 的旧快照)——此刻绝不能消费期望。
    await call(
      req,
      { ...stepReq(1, 1), agent },
      { provider: 'deepseek', model: 'x' },
    );
    const warnAfterRetry = vi
      .mocked(console.warn)
      .mock.calls.map((c) => String(c[0]));
    expect(warnAfterRetry.some((line) => line.includes('guard:'))).toBe(false);
    // 期望仍在(未被同 step 重入消费)。
    const calls: { status?: number; body?: string } = {};
    const readStatus = async (): Promise<{
      incidents: number;
      guardExpectedCount: number;
    }> => {
      await routes[0].handler(
        { url: '/dsh-llm-fallback/status' },
        {
          writeHead(s: number) {
            calls.status = s;
          },
          end(b?: string) {
            calls.body = b;
          },
        },
      );
      return (
        JSON.parse(calls.body ?? '{}') as {
          value: { incidents: number; guardExpectedCount: number };
        }
      ).value;
    };
    expect((await readStatus()).guardExpectedCount).toBe(1);
    // 新 step 首请求才消费:selection 已是切换目标 → 校验通过,期望清空。
    await call(
      req,
      { ...stepReq(2, 1), agent },
      { provider: 'openai', model: 'a' },
    );
    const value = await readStatus();
    expect(value.guardExpectedCount).toBe(0);
    expect(value.incidents).toBe(0);
  });

  it('守卫未生效分支:切换后下一 step selection 仍旧 → 告警并计入事故', async () => {
    vi.useFakeTimers();
    const { req, err, routes } = setupObs();
    const { agent } = obsAgent();
    await call(req, { ...stepReq(1, 1), agent });
    await call(err, { ...stepErr(1, 1), agent });
    // 模拟旧装配/持久化失败:下一 step selection 被打回旧模型。
    agent.model.select({ provider: 'deepseek', model: 'x' });
    await call(
      req,
      { ...stepReq(2, 1), agent },
      { provider: 'deepseek', model: 'x' },
    );
    const warn = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(warn.some((line) => line.includes('guard:'))).toBe(true);
    // 状态路由把事故计数暴露出来。
    const status = routes[0];
    expect(status.path).toBe('/dsh-llm-fallback');
    const calls: { status?: number; body?: string } = {};
    await status.handler(
      { url: '/dsh-llm-fallback/status' },
      {
        writeHead(s: number) {
          calls.status = s;
        },
        end(b?: string) {
          calls.body = b;
        },
      },
    );
    const payload = JSON.parse(calls.body ?? '{}') as {
      ok: boolean;
      value: {
        incidents: number;
        guardExpectedCount: number;
        sessions: unknown[];
      };
    };
    expect(calls.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.value.incidents).toBe(1);
    // 守卫期望是 one-shot:下一 step 比对后即消费删除,路由里应为空。
    expect(payload.value.guardExpectedCount).toBe(0);
    expect(Array.isArray(payload.value.sessions)).toBe(true);
  });

  it('状态路由:非 /status 路径返回 404 envelope', async () => {
    const { routes } = setupObs();
    const calls: { status?: number; body?: string } = {};
    await routes[0].handler(
      { url: '/dsh-llm-fallback/nope' },
      {
        writeHead(s: number) {
          calls.status = s;
        },
        end(b?: string) {
          calls.body = b;
        },
      },
    );
    expect(calls.status).toBe(404);
    const payload = JSON.parse(calls.body ?? '{}') as {
      ok: boolean;
      error: { code: string };
    };
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('NOT_FOUND');
  });
});
