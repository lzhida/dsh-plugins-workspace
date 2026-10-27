/**
 * 时间窗切换/错峰优先(时段计划 v2,「时间窗=预填冷却表」)行为契约测试。
 *
 * 覆盖(验收清单 DoD 2):
 * - 窗口边界切换:半开区间 [start,end)——起点生效、终点即失效;
 * - 跨夜区间:start > end 回绕(晚间段与凌晨段都生效),次日窗口外恢复;
 * - 惰性过期恢复:预填冷却到期 = 窗口结束,过期后 seed 不再被改写
 *   (复用既有惰性过期,无定时器);
 * - 全候选在窗外/被窗口覆盖时的降级:全部候选被预填冷却 → 降级回原顺序
 *   放行(时间窗绝不吞掉全部候选);全部候选都匹配 prefer 规则 → 无人被
 *   冷却,seed 原样;
 * - 纯函数面:parseHHmm / matchProviderPattern / windowActiveAt /
 *   minutesUntilWindowEnd / resolveTimeWindowCooldowns / resolveTimeWindow
 *   (非法配置抛错,last-good 保留);
 * - apply 集成:窗口内 block 改写切走 / prefer 链内优先 DeepSeek /
 *   cooldownEnabled=false 时时间窗整体不生效(预填依赖冷却通道)。
 *
 * 时间控制:vi.useFakeTimers()(vitest 默认同时 mock Date)+
 * vi.setSystemTime 固化本地时区墙钟——窗口判定与测试时间同为宿主本地
 * 时区,任何机器上行为一致(D3:窗口按宿主本地时区解释)。
 */

import type { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apply } from './index.ts';
import {
  DEFAULT_TIME_WINDOW_RULES,
  type TimeWindow,
  matchProviderPattern,
  minutesUntilWindowEnd,
  parseHHmm,
  resolveTimeWindow,
  resolveTimeWindowCooldowns,
  windowActiveAt,
} from './schedule.ts';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── 测试工具(沿用 cooldown.test.ts 的 stubCtx 模式)────────────────

/** cordis Context 最小假体:effect 立即执行,on 记录 listener。 */
function stubCtx(): {
  ctx: Context;
  listeners: Array<{ event: string; listener: unknown }>;
} {
  const listeners: Array<{ event: string; listener: unknown }> = [];
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
  } as unknown as Context;
  return { ctx, listeners };
}

/** apply() 装载 + 取出 agent/request listener(时间窗只在起点预填改写)。 */
function setupReq(config: Record<string, unknown> = {}): unknown {
  const { ctx, listeners } = stubCtx();
  apply(ctx, {
    fallbackChains: ['openai/a', 'anthropic/b'],
    baseDelayMs: 0,
    maxDelayMs: 0,
    ...config,
  });
  return listeners.find((l) => l.event === 'agent/request')?.listener;
}

async function callRequest(
  listener: unknown,
  turn: number,
  step: number,
  seed: { provider: string; model: string },
): Promise<unknown> {
  return (
    listener as (p: unknown, n: () => Promise<unknown>) => Promise<unknown>
  )({ turn, step, signal: new AbortController().signal }, async () => ({
    ...seed,
  }));
}

/** 固定本地时区墙钟(月/日/时/分;Date 构造即本地时区,与窗口判定同侧)。 */
function setLocalTime(
  month: number,
  day: number,
  hour: number,
  minute: number,
): void {
  vi.setSystemTime(new Date(2026, month - 1, day, hour, minute, 0));
}

const ALL_DAY_WINDOW: TimeWindow = { start: '00:00', end: '00:00' }; // 相等 = 全天

// ── 1. parseHHmm / matchProviderPattern ─────────────────────────────

describe('parseHHmm', () => {
  it('严格解析 HH:mm 为当日分钟数(00:00-23:59)', () => {
    expect(parseHHmm('00:00')).toBe(0);
    expect(parseHHmm('08:30')).toBe(510);
    expect(parseHHmm('23:59')).toBe(1439);
  });

  it('非 string / 格式不符 → null(7:30、24:00、12:60、空串、数字等)', () => {
    expect(parseHHmm('7:30')).toBeNull();
    expect(parseHHmm('24:00')).toBeNull();
    expect(parseHHmm('12:60')).toBeNull();
    expect(parseHHmm('')).toBeNull();
    expect(parseHHmm('ab:cd')).toBeNull();
    expect(parseHHmm(530)).toBeNull();
    expect(parseHHmm(null)).toBeNull();
    expect(parseHHmm(undefined)).toBeNull();
  });
});

describe('matchProviderPattern', () => {
  const providers = ['deepseek-account', 'deepseek-official', 'openai', 'glm'];

  it('精确 id 只匹配自身', () => {
    expect(matchProviderPattern('deepseek-account', 'deepseek-account')).toBe(
      true,
    );
    expect(matchProviderPattern('deepseek-account', 'deepseek-official')).toBe(
      false,
    );
  });

  it('前缀通配 prefix-* 命中同前缀全部 provider(含未来新增)', () => {
    expect(matchProviderPattern('deepseek-*', 'deepseek-account')).toBe(true);
    expect(matchProviderPattern('deepseek-*', 'deepseek-official')).toBe(true);
    expect(matchProviderPattern('deepseek-*', 'deepseek-anything-new')).toBe(
      true,
    );
    expect(matchProviderPattern('deepseek-*', 'openai')).toBe(false);
    expect(matchProviderPattern('deepseek-*', 'deepseek')).toBe(false);
  });

  it('* 匹配全部;空模式不匹配任何 provider', () => {
    for (const p of providers) {
      expect(matchProviderPattern('*', p)).toBe(true);
      expect(matchProviderPattern('', p)).toBe(false);
    }
  });
});

// ── 2. 窗口谓词:边界 / 跨夜 / 全天 ──────────────────────────────────

describe('windowActiveAt(半开区间与跨夜回绕)', () => {
  it('同时窗:起点生效、终点即失效(边界切换)', () => {
    const w: TimeWindow = { start: '08:30', end: '12:00' };
    expect(windowActiveAt(w, 480)).toBe(false); // 08:00 未到起点
    expect(windowActiveAt(w, 510)).toBe(true); // 08:30 起点(含)
    expect(windowActiveAt(w, 719)).toBe(true); // 11:59
    expect(windowActiveAt(w, 720)).toBe(false); // 12:00 终点(不含)
  });

  it('跨夜窗:晚间段与凌晨段都生效,日间失效', () => {
    const peak: TimeWindow = { start: '08:30', end: '00:30' };
    expect(windowActiveAt(peak, 510)).toBe(true); // 08:30
    expect(windowActiveAt(peak, 1439)).toBe(true); // 23:59
    expect(windowActiveAt(peak, 0)).toBe(true); // 00:00
    expect(windowActiveAt(peak, 29)).toBe(true); // 00:29
    expect(windowActiveAt(peak, 30)).toBe(false); // 00:30(半开终点)
    expect(windowActiveAt(peak, 509)).toBe(false); // 08:29
  });

  it('start == end = 全天(沿用 v1 已验证语义)', () => {
    for (const now of [0, 359, 720, 1439]) {
      expect(windowActiveAt(ALL_DAY_WINDOW, now)).toBe(true);
    }
  });

  it('非法时间串的窗口永不生效', () => {
    expect(windowActiveAt({ start: '24:00', end: '08:00' }, 600)).toBe(false);
    expect(windowActiveAt({ start: '08:00', end: '' }, 600)).toBe(false);
  });
});

describe('minutesUntilWindowEnd', () => {
  it('同时窗:end - now(半开边界内恒正;终点即失效)', () => {
    const offPeak: TimeWindow = { start: '00:30', end: '08:30' };
    expect(minutesUntilWindowEnd(offPeak, 30)).toBe(480); // 起点 00:30
    expect(minutesUntilWindowEnd(offPeak, 190)).toBe(320); // 03:10
    expect(minutesUntilWindowEnd(offPeak, 420)).toBe(90); // 07:00
    expect(minutesUntilWindowEnd(offPeak, 830)).toBeNull(); // 08:30 已出窗(半开终点)
  });

  it('跨夜窗:起点后 = 到午夜 + end;终点前 = end - now', () => {
    const peak: TimeWindow = { start: '08:30', end: '00:30' };
    expect(minutesUntilWindowEnd(peak, 510)).toBe(960); // 08:30 → 午夜前 930 + 凌晨段 30
    expect(minutesUntilWindowEnd(peak, 1380)).toBe(90); // 23:00 → 60 + 30
    expect(minutesUntilWindowEnd(peak, 0)).toBe(30); // 00:00
    expect(minutesUntilWindowEnd(peak, 29)).toBe(1); // 00:29
  });

  it('全天窗返回 1440(次日同刻重新评估,结果不变)', () => {
    expect(minutesUntilWindowEnd(ALL_DAY_WINDOW, 0)).toBe(1440);
    expect(minutesUntilWindowEnd(ALL_DAY_WINDOW, 1000)).toBe(1440);
  });

  it('窗口未生效 / 非法时间串 → null', () => {
    expect(
      minutesUntilWindowEnd({ start: '08:30', end: '12:00' }, 720),
    ).toBeNull();
    expect(minutesUntilWindowEnd({ start: 'x', end: '12:00' }, 600)).toBeNull();
  });
});

// ── 3. resolveTimeWindowCooldowns(预填计算)─────────────────────────

describe('resolveTimeWindowCooldowns', () => {
  const candidates = [
    { provider: 'deepseek-account', model: 'ds-chat' },
    { provider: 'openai', model: 'a' },
  ];

  it('block 高峰避让:只冷却命中的 provider,到期 = 窗口结束', () => {
    // 12:00,高峰窗 [08:30,00:30) 生效,至 00:30 还剩 750 分钟
    const now = new Date(2026, 9, 21, 12, 0);
    const rules = [
      {
        match: 'deepseek-*',
        action: 'block' as const,
        windows: [{ start: '08:30', end: '00:30' }],
      },
    ];
    const result = resolveTimeWindowCooldowns(rules, candidates, now);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      provider: 'deepseek-account',
      model: 'ds-chat',
    });
    expect(result[0]?.until).toBe(now.getTime() + 750 * 60_000);
  });

  it('prefer 错峰反向:只冷却未命中的 provider(错峰自动优先 DeepSeek)', () => {
    // 02:00,半价窗 [00:30,08:30) 生效,至 08:30 还剩 390 分钟
    const now = new Date(2026, 9, 21, 2, 0);
    const rules = [
      {
        match: 'deepseek-*',
        action: 'prefer' as const,
        windows: [{ start: '00:30', end: '08:30' }],
      },
    ];
    const result = resolveTimeWindowCooldowns(rules, candidates, now);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ provider: 'openai', model: 'a' });
    expect(result[0]?.until).toBe(now.getTime() + 390 * 60_000);
  });

  it('多条生效窗口取最晚结束(重叠窗口不互相缩短)', () => {
    const now = new Date(2026, 9, 21, 1, 30);
    const rules = [
      {
        match: 'openai',
        action: 'block' as const,
        windows: [
          { start: '00:00', end: '23:00' },
          { start: '01:00', end: '02:00' },
        ],
      },
    ];
    const result = resolveTimeWindowCooldowns(rules, [candidates[1]!], now);
    expect(result[0]?.until).toBe(now.getTime() + (23 * 60 - 90) * 60_000);
  });

  it('全部窗口未生效 → 返回空(无预填)', () => {
    const now = new Date(2026, 9, 21, 12, 0); // 日间:错峰窗不生效
    const rules = [
      {
        match: 'deepseek-*',
        action: 'prefer' as const,
        windows: [{ start: '00:30', end: '08:30' }],
      },
    ];
    expect(resolveTimeWindowCooldowns(rules, candidates, now)).toEqual([]);
  });

  it('prefer 匹配全部(*)时无人被冷却(全员命中 → !match 恒 false)', () => {
    const now = new Date(2026, 9, 21, 2, 0);
    const rules = [
      {
        match: '*',
        action: 'prefer' as const,
        windows: [ALL_DAY_WINDOW],
      },
    ];
    expect(resolveTimeWindowCooldowns(rules, candidates, now)).toEqual([]);
  });

  it('官方预置模板(D3):高峰 block deepseek-*、错峰 prefer deepseek-*', () => {
    expect(DEFAULT_TIME_WINDOW_RULES).toEqual([
      {
        match: 'deepseek-*',
        action: 'block',
        windows: [{ start: '08:30', end: '00:30' }],
      },
      {
        match: 'deepseek-*',
        action: 'prefer',
        windows: [{ start: '00:30', end: '08:30' }],
      },
    ]);
  });
});

// ── 4. resolveTimeWindow(配置解析与校验)────────────────────────────

describe('resolveTimeWindow', () => {
  it('缺省关闭零迁移:enabled 默认 false,规则缺省为空', () => {
    expect(resolveTimeWindow(undefined, undefined)).toEqual({
      enabled: false,
      rules: [],
    });
    expect(resolveTimeWindow(false, undefined)).toEqual({
      enabled: false,
      rules: [],
    });
    // enabled=false 但规则存在:规则仍被解析校验(早发现配置错误)
    expect(resolveTimeWindow(false, DEFAULT_TIME_WINDOW_RULES)).toEqual({
      enabled: false,
      rules: DEFAULT_TIME_WINDOW_RULES,
    });
  });

  it('action 缺省为 block;合法规则原样规整', () => {
    expect(
      resolveTimeWindow(true, [
        { match: 'deepseek-*', windows: [ALL_DAY_WINDOW] },
      ]),
    ).toEqual({
      enabled: true,
      rules: [
        { match: 'deepseek-*', action: 'block', windows: [ALL_DAY_WINDOW] },
      ],
    });
  });

  it('非法输入抛错(→ resolveConfig 整体失败,listener 保留 last-good)', () => {
    expect(() => resolveTimeWindow(true, 'nope')).toThrow();
    expect(() => resolveTimeWindow(true, ['nope'])).toThrow();
    expect(() => resolveTimeWindow(true, [{ windows: [] }])).toThrow();
    expect(() =>
      resolveTimeWindow(true, [{ match: 'x', action: 'nope', windows: [] }]),
    ).toThrow();
    expect(() =>
      resolveTimeWindow(true, [{ match: 'x', windows: ['nope'] }]),
    ).toThrow();
    expect(() =>
      resolveTimeWindow(true, [
        { match: 'x', windows: [{ start: '24:00', end: '08:00' }] },
      ]),
    ).toThrow();
    expect(() =>
      resolveTimeWindow(true, [{ match: 'x', windows: [{ start: '08:00' }] }]),
    ).toThrow();
  });
});

// ── 5. apply 集成(agent/request 起点预填 + 改写)────────────────────

describe('时间窗预填(apply 集成)', () => {
  const blockPreset = [
    {
      match: 'deepseek-*',
      action: 'block',
      windows: [{ start: '08:30', end: '09:00' }],
    },
  ];
  const seed = { provider: 'deepseek-account', model: 'x' };

  it('窗口内:block 命中候选在起点被改写切走,并留下 time-window 日志', async () => {
    vi.useFakeTimers();
    setLocalTime(10, 21, 8, 45); // 窗口 [08:30,09:00) 内
    const req = setupReq({
      timeWindowEnabled: true,
      timeWindowRules: blockPreset,
    });
    const result = await callRequest(req, 1, 1, seed);
    expect(result).toEqual({ provider: 'openai', model: 'a' });
    // 轨迹/日志证据:预填走冷却通道且可辨识
    const logged = vi
      .mocked(console.log)
      .mock.calls.some((args) =>
        String(args[0]).includes('[dsh-llm-fallback] time-window:'),
      );
    expect(logged).toBe(true);
  });

  it('窗口结束:预填条目惰性过期,seed 恢复原优先级(无定时器)', async () => {
    vi.useFakeTimers();
    setLocalTime(10, 21, 8, 45);
    const req = setupReq({
      timeWindowEnabled: true,
      timeWindowRules: blockPreset,
    });
    expect(await callRequest(req, 1, 1, seed)).toEqual({
      provider: 'openai',
      model: 'a',
    });
    // 推进到窗口终点(半开区间,09:00 已出窗):预填到期(=09:00)惰性过期
    setLocalTime(10, 21, 9, 0);
    expect(await callRequest(req, 1, 2, seed)).toEqual({ ...seed });
    // 再推进:无新预填,持续恢复
    setLocalTime(10, 21, 9, 30);
    expect(await callRequest(req, 1, 3, seed)).toEqual({ ...seed });
  });

  it('跨夜区间 [22:00,06:00):深夜与凌晨都改写,日间窗口外恢复', async () => {
    vi.useFakeTimers();
    const req = setupReq({
      timeWindowEnabled: true,
      timeWindowRules: [
        {
          match: 'deepseek-*',
          action: 'block',
          windows: [{ start: '22:00', end: '06:00' }],
        },
      ],
    });
    setLocalTime(10, 21, 23, 0); // 深夜段
    expect(await callRequest(req, 1, 1, seed)).toEqual({
      provider: 'openai',
      model: 'a',
    });
    setLocalTime(10, 22, 5, 59); // 次日凌晨段(跨夜回绕仍生效)
    expect(await callRequest(req, 1, 2, seed)).toEqual({
      provider: 'openai',
      model: 'a',
    });
    setLocalTime(10, 22, 12, 0); // 日间:窗口外
    expect(await callRequest(req, 1, 3, seed)).toEqual({ ...seed });
  });

  it('prefer 错峰反向:非 DeepSeek 会话模型与候选被预填冷却,请求改写为链内 DeepSeek 候选', async () => {
    vi.useFakeTimers();
    setLocalTime(10, 21, 2, 0); // 半价窗 [00:30,08:30) 内
    const req = setupReq({
      fallbackChains: ['anthropic/c', 'deepseek-account/z'],
      timeWindowEnabled: true,
      timeWindowRules: [
        {
          match: 'deepseek-*',
          action: 'prefer',
          windows: [{ start: '00:30', end: '08:30' }],
        },
      ],
    });
    // 会话模型 openai/x 与链首 anthropic/c 都被冷却 → 改写为链内 deepseek-account/z
    expect(
      await callRequest(req, 1, 1, { provider: 'openai', model: 'x' }),
    ).toEqual({ provider: 'deepseek-account', model: 'z' });
  });

  it('prefer 错峰反向:会话模型已是 DeepSeek 时起点不改写(起点即优先目标)', async () => {
    vi.useFakeTimers();
    setLocalTime(10, 21, 2, 0);
    const req = setupReq({
      fallbackChains: ['openai/a'],
      timeWindowEnabled: true,
      timeWindowRules: [
        {
          match: 'deepseek-*',
          action: 'prefer',
          windows: [{ start: '00:30', end: '08:30' }],
        },
      ],
    });
    // 会话模型(deepseek-account)未被冷却 → 起点 seed 原样;被冷却的 openai/a
    // 不影响起点,若失败由失败推进的冷却感知扫描跳过(nextCandidate)
    expect(await callRequest(req, 1, 1, seed)).toEqual({ ...seed });
  });

  it('全候选都被 block 窗口覆盖 → 降级回原顺序放行(时间窗绝不吞掉全部候选)', async () => {
    vi.useFakeTimers();
    setLocalTime(10, 21, 8, 45);
    const req = setupReq({
      timeWindowEnabled: true,
      timeWindowRules: [
        { match: '*', action: 'block', windows: [ALL_DAY_WINDOW] },
      ],
    });
    // 全链 + 会话模型都冷却中 → 保持 seed 原样(既有全冷降级语义兜底)
    expect(await callRequest(req, 1, 1, seed)).toEqual({ ...seed });
  });

  it('cooldownEnabled=false 时时间窗整体不生效(预填依赖冷却通道)', async () => {
    vi.useFakeTimers();
    setLocalTime(10, 21, 8, 45);
    const req = setupReq({
      cooldownEnabled: false,
      timeWindowEnabled: true,
      timeWindowRules: blockPreset,
    });
    expect(await callRequest(req, 1, 1, seed)).toEqual({ ...seed });
  });

  it('timeWindowEnabled=false(默认):行为与旧版完全一致', async () => {
    vi.useFakeTimers();
    setLocalTime(10, 21, 8, 45);
    const req = setupReq({
      timeWindowRules: blockPreset,
    });
    expect(await callRequest(req, 1, 1, seed)).toEqual({ ...seed });
  });
});
