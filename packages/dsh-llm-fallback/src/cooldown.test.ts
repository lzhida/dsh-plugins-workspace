/**
 * 失败候选冷却(cooldown)行为契约测试。
 *
 * 覆盖(需求:优先级与效率的平衡——失败模型短窗内跳过,窗口期满重新验证):
 * - 冷却表纯函数:cooldownKey 键形态与跨 provider 无歧义 / isCoolingDown 窗口
 *   判定 / markCooldown 写入与过期惰性清理 / purgeExpiredCooldowns;
 * - currentEffectiveCandidate:失败方识别(index>=0 → 链候选,-1 → pageModel);
 * - firstAvailableCandidateIndex:step 起点跳过(首个未冷却且非 pageModel 的
 *   候选;全冷却 → -1 不吞链);
 * - nextCandidate 冷却感知扫描:跳过冷却候选 / 剩余全冷却降级回原顺序 /
 *   到期恢复 / 不传表时与旧版行为一致(向后兼容);
 * - apply 集成(agent/request + agent/request-error 真实链路):
 *   - 主模型失败切换后,新 step 首个请求直接改写为链上第一候选(无需失败);
 *   - 多候选先后失败后,新 step 跳到首个未冷却候选;
 *   - 冷却期满(时间推进)自动恢复优先级,seed 不再被改写;
 *   - 全链冷却:新 step 保持 seed 原样,失败后 nextCandidate 降级切链首;
 *   - cooldownEnabled=false:行为与旧版完全一致;
 *   - 预算内同候选重试不记冷却,预算耗尽切换才记;
 *   - 链耗尽路径同样标记失败方;
 *   - 冷却跳过不消耗本 step 的切换预算(跳过后失败仍能继续切换);
 * - protocol section 文本说明冷却语义。
 *
 * 时间控制:vi.useFakeTimers()(vitest 默认同时 mock Date) +
 * vi.setSystemTime 推进冷却窗口。
 */

import type { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apply } from './index.ts';
import {
  type Candidate,
  type FallbackState,
  cooldownKey,
  currentEffectiveCandidate,
  firstAvailableCandidateIndex,
  isCoolingDown,
  markCooldown,
  nextCandidate,
  purgeExpiredCooldowns,
} from './state.ts';
import { modelFallbackSection } from './protocol.ts';

// ── 测试工具(沿用 config.test.ts 的 stubCtx 模式)────────────────────

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

/** 构造失败 fixture(只覆盖 LlmFailure 的最小字段)。 */
function stubFailure(
  code: string,
  message = 'fake failure',
): { code: string; message: string } {
  return { code, message };
}

/** 找到首个指定事件的 listener。 */
function findListener(
  listeners: Array<{ event: string; listener: unknown }>,
  event: string,
): unknown {
  return listeners.find((l) => l.event === event)?.listener;
}

/** Listener 调用包装:消除 `as any` 重复样板。 */
async function callListener(
  listener: unknown,
  payload: unknown,
  next: () => Promise<unknown>,
): Promise<unknown> {
  return (
    listener as (p: unknown, n: () => Promise<unknown>) => Promise<unknown>
  )(payload, next);
}

/** apply() 装载 + 取出两个 listener(退避清零,聚焦冷却逻辑)。 */
function setup(config: Record<string, unknown> = {}): {
  req: unknown;
  err: unknown;
} {
  const { ctx, listeners } = stubCtx();
  apply(ctx, {
    fallbackChains: ['openai/a', 'anthropic/b'],
    baseDelayMs: 0,
    maxDelayMs: 0,
    ...config,
  });
  return {
    req: findListener(listeners, 'agent/request'),
    err: findListener(listeners, 'agent/request-error'),
  };
}

const sig = (): AbortSignal => new AbortController().signal;
const stepReq = (
  turn: number,
  step: number,
): { turn: number; step: number; signal: AbortSignal } => ({
  turn,
  step,
  signal: sig(),
});
const stepErr = (
  turn: number,
  step: number,
  provider: string,
  code = 'RATE_LIMIT',
): Record<string, unknown> => ({
  turn,
  step,
  provider,
  failure: stubFailure(code),
  signal: sig(),
});

/** 构造未切换态(index=-1)的回退状态。 */
function initState(
  chain: ReadonlyArray<Candidate>,
  pageModel?: Candidate,
): FallbackState {
  return {
    chain,
    index: -1,
    retries: 0,
    exhausted: false,
    candidateFailures: 0,
    pageModel,
  };
}

// ── 1. 冷却表纯函数 ──────────────────────────────────────────────────

describe('冷却表(cooldown table)纯函数', () => {
  it('cooldownKey 为 provider/model 形态;model 含 / 时跨 provider 无歧义', () => {
    expect(cooldownKey({ provider: 'a', model: 'x' })).toBe('a/x');
    // provider 段不含 /(parseChainEntry 以首个 / 分割),拼接可逆无歧义
    expect(cooldownKey({ provider: 'b', model: 'x' })).toBe('b/x');
    expect(cooldownKey({ provider: 'a', model: 'org/sub/model' })).toBe(
      'a/org/sub/model',
    );
  });

  it('isCoolingDown:窗口内 true,过期 false,无记录 false', () => {
    const table = new Map<string, number>([['a/x', 1000]]);
    expect(isCoolingDown(table, { provider: 'a', model: 'x' }, 999)).toBe(true);
    expect(isCoolingDown(table, { provider: 'a', model: 'x' }, 1000)).toBe(
      false,
    ); // until > now 才算冷却:到期即恢复
    expect(isCoolingDown(table, { provider: 'a', model: 'y' }, 0)).toBe(false);
  });

  it('markCooldown 写入 now + cooldownMs,并顺带惰性清理过期条目', () => {
    const table = new Map<string, number>([['old/x', 100]]);
    markCooldown(table, { provider: 'a', model: 'x' }, 1000, 60_000);
    expect(table.get('a/x')).toBe(61_000);
    expect(table.has('old/x')).toBe(false); // 过期条目被顺带清理
    expect(table.size).toBe(1);
  });

  it('markCooldown cooldownMs<=0 → 立即过期(等效不冷却)', () => {
    const table = new Map<string, number>();
    markCooldown(table, { provider: 'a', model: 'x' }, 1000, 0);
    expect(isCoolingDown(table, { provider: 'a', model: 'x' }, 1000)).toBe(
      false,
    );
    markCooldown(table, { provider: 'a', model: 'x' }, 1000, -5);
    expect(isCoolingDown(table, { provider: 'a', model: 'x' }, 1000)).toBe(
      false,
    );
  });

  it('冷却按 provider+model 区分:同 model 名不同 provider 互不影响', () => {
    const table = new Map<string, number>();
    markCooldown(table, { provider: 'a', model: 'x' }, 1000, 60_000);
    expect(isCoolingDown(table, { provider: 'b', model: 'x' }, 1001)).toBe(
      false,
    );
    expect(isCoolingDown(table, { provider: 'a', model: 'x' }, 1001)).toBe(
      true,
    );
  });

  it('purgeExpiredCooldowns 只删过期条目,未冷却的保留', () => {
    const table = new Map<string, number>([
      ['gone/a', 100],
      ['stay/b', 5000],
    ]);
    purgeExpiredCooldowns(table, 1000);
    expect(table.has('gone/a')).toBe(false);
    expect(table.has('stay/b')).toBe(true);
  });

  it('currentEffectiveCandidate:index>=0 → 链候选;-1 → pageModel;缺失 → undefined', () => {
    const chain: ReadonlyArray<Candidate> = [
      { provider: 'a', model: 'x' },
      { provider: 'b', model: 'y' },
    ];
    const switched = initState(chain, { provider: 'p', model: 'm' });
    switched.index = 1;
    expect(currentEffectiveCandidate(switched)).toEqual({
      provider: 'b',
      model: 'y',
    });
    const fresh = initState(chain, { provider: 'p', model: 'm' });
    expect(currentEffectiveCandidate(fresh)).toEqual({
      provider: 'p',
      model: 'm',
    });
    const noPage = initState(chain);
    expect(currentEffectiveCandidate(noPage)).toBeUndefined();
  });
});

// ── 2. step 起点跳过(firstAvailableCandidateIndex)──────────────────

describe('firstAvailableCandidateIndex', () => {
  const chain: ReadonlyArray<Candidate> = [
    { provider: 'a', model: 'x' },
    { provider: 'b', model: 'y' },
    { provider: 'c', model: 'z' },
  ];

  it('返回首个未冷却且非 pageModel 的候选下标', () => {
    const table = new Map<string, number>([
      [cooldownKey({ provider: 'a', model: 'x' }), 5000],
    ]);
    expect(
      firstAvailableCandidateIndex(chain, table, {
        pageModel: { provider: 'p', model: 'm' },
        now: 1000,
      }),
    ).toBe(1);
  });

  it('全部候选都在冷却中 → -1(冷却绝不吞掉全部候选)', () => {
    const table = new Map<string, number>(
      chain.map((c) => [cooldownKey(c), 5000]),
    );
    expect(
      firstAvailableCandidateIndex(chain, table, {
        pageModel: { provider: 'p', model: 'm' },
        now: 1000,
      }),
    ).toBe(-1);
  });

  it('冷却已到期 → 不跳过(到期即恢复优先级)', () => {
    const table = new Map<string, number>([
      [cooldownKey({ provider: 'a', model: 'x' }), 1000],
    ]);
    expect(
      firstAvailableCandidateIndex(chain, table, {
        pageModel: { provider: 'p', model: 'm' },
        now: 1000,
      }),
    ).toBe(0);
  });

  it('空链 → -1', () => {
    expect(
      firstAvailableCandidateIndex([], new Map(), {
        pageModel: { provider: 'p', model: 'm' },
        now: 0,
      }),
    ).toBe(-1);
  });

  it('与 pageModel 相同的队列项照旧跳过(防呆与冷却正交)', () => {
    // 链首 = pageModel(旧"首项=主模型"配置),即便未冷却也不得作为起点
    const table = new Map<string, number>();
    expect(
      firstAvailableCandidateIndex(
        [
          { provider: 'p', model: 'm' },
          { provider: 'a', model: 'x' },
        ],
        table,
        { pageModel: { provider: 'p', model: 'm' }, now: 0 },
      ),
    ).toBe(1);
  });
});

// ── 3. nextCandidate 冷却感知扫描 ────────────────────────────────────

describe('nextCandidate 冷却感知扫描', () => {
  const chain: ReadonlyArray<Candidate> = [
    { provider: 'a', model: 'x' },
    { provider: 'b', model: 'y' },
    { provider: 'c', model: 'z' },
  ];
  const page: Candidate = { provider: 'p', model: 'm' };

  it('跳过仍在冷却中的候选,推进到首个可用候选', () => {
    const s = initState(chain, page);
    const table = new Map<string, number>([
      [cooldownKey({ provider: 'a', model: 'x' }), 5000],
    ]);
    expect(nextCandidate(s, 10, table, 1000)).toEqual({ index: 1, retries: 1 });
  });

  it('剩余候选全部在冷却中 → 降级返回首个非 pageModel 候选(冷却不吞链)', () => {
    const s = initState(chain, page);
    const table = new Map<string, number>(
      chain.map((c) => [cooldownKey(c), 5000]),
    );
    expect(nextCandidate(s, 10, table, 1000)).toEqual({ index: 0, retries: 1 });
  });

  it('冷却已到期 → 不跳过(到期即恢复)', () => {
    const s = initState(chain, page);
    const table = new Map<string, number>([
      [cooldownKey({ provider: 'a', model: 'x' }), 1000],
    ]);
    expect(nextCandidate(s, 10, table, 1000)).toEqual({ index: 0, retries: 1 });
  });

  it('不传冷却表时行为与旧版完全一致(向后兼容)', () => {
    const s = initState(chain, page);
    expect(nextCandidate(s, 10)).toEqual({ index: 0, retries: 1 });
    // 传 undefined 等价于不传
    expect(nextCandidate(s, 10, undefined, 1000)).toEqual({
      index: 0,
      retries: 1,
    });
  });

  it('exhausted / maxRetries 上限判定不受冷却参数影响', () => {
    const s = initState(chain, page);
    s.exhausted = true;
    expect(nextCandidate(s, 10, new Map(), 0)).toBeNull();
    const s2 = initState(chain, page);
    s2.retries = 2;
    expect(nextCandidate(s2, 2, new Map(), 0)).toBeNull();
  });
});

// ── 4. apply 集成(request 起点跳过 + error 失败标记)─────────────────

describe('失败冷却(apply 集成)', () => {
  it('主模型失败切换后,新 step 首个请求直接改写为链上第一候选(无需再失败)', async () => {
    const { req, err } = setup();
    const seed = { provider: 'deepseek', model: 'x' };
    // step (1,1):主模型失败 → 切到 openai/a,主模型记入冷却
    await callListener(req, stepReq(1, 1), async () => ({ ...seed }));
    expect(
      await callListener(err, stepErr(1, 1, 'deepseek'), async () => undefined),
    ).toEqual({ kind: 'retry' });
    // 新 step (2,1):主模型冷却中 → 首个请求直接改写(此 step 零失败)
    expect(
      await callListener(req, stepReq(2, 1), async () => ({ ...seed })),
    ).toEqual({ provider: 'openai', model: 'a' });
  });

  it('多个候选先后失败后,新 step 直接跳到首个未冷却的候选', async () => {
    const { req, err } = setup({
      fallbackChains: ['openai/a', 'anthropic/b'],
    });
    const seed = { provider: 'deepseek', model: 'x' };
    await callListener(req, stepReq(1, 1), async () => ({ ...seed }));
    await callListener(err, stepErr(1, 1, 'deepseek'), async () => undefined);
    await callListener(err, stepErr(1, 1, 'openai'), async () => undefined);
    // deepseek 与 openai 均冷却中 → 直接从 anthropic/b 开始
    expect(
      await callListener(req, stepReq(1, 2), async () => ({ ...seed })),
    ).toEqual({ provider: 'anthropic', model: 'b' });
  });

  it('冷却期满后模型自动恢复优先级:新 step 首个请求不再改写 seed', async () => {
    vi.useFakeTimers();
    const { req, err } = setup({ fallbackChains: ['openai/a'] });
    const seed = { provider: 'deepseek', model: 'x' };
    await callListener(req, stepReq(1, 1), async () => ({ ...seed }));
    await callListener(err, stepErr(1, 1, 'deepseek'), async () => undefined);
    // 窗口内:跳过
    expect(
      await callListener(req, stepReq(1, 2), async () => ({ ...seed })),
    ).toEqual({ provider: 'openai', model: 'a' });
    // 窗口期满(默认 300000ms):重新验证——恢复原优先级,seed 原样
    vi.setSystemTime(Date.now() + 300_000 + 1);
    expect(
      await callListener(req, stepReq(1, 3), async () => ({ ...seed })),
    ).toEqual({ ...seed });
  });

  it('剩余候选全部在冷却中:新 step 保持 seed 原样,失败后降级按原顺序切换', async () => {
    const { req, err } = setup();
    const seed = { provider: 'deepseek', model: 'x' };
    await callListener(req, stepReq(1, 1), async () => ({ ...seed }));
    await callListener(err, stepErr(1, 1, 'deepseek'), async () => undefined);
    await callListener(err, stepErr(1, 1, 'openai'), async () => undefined);
    // 第 3 次失败:链耗尽 → 透传,但失败方 anthropic/b 同样记入冷却
    expect(
      await callListener(
        err,
        stepErr(1, 1, 'anthropic', 'SERVER'),
        async () => undefined,
      ),
    ).toBeUndefined();
    // 全部冷却:新 step 首个请求保持 seed 原样(冷却不吞链)
    expect(
      await callListener(req, stepReq(1, 2), async () => ({ ...seed })),
    ).toEqual({ ...seed });
    // 该 step 内主模型再失败:冷却扫描发现剩余候选全冷却 → 降级切链首
    expect(
      await callListener(err, stepErr(1, 2, 'deepseek'), async () => undefined),
    ).toEqual({ kind: 'retry' });
    expect(
      await callListener(req, stepReq(1, 2), async () => ({ ...seed })),
    ).toEqual({ provider: 'openai', model: 'a' });
  });

  it('cooldownEnabled=false:切换后新 step 不做冷却跳过(行为与旧版一致)', async () => {
    const { req, err } = setup({ cooldownEnabled: false });
    const seed = { provider: 'deepseek', model: 'x' };
    await callListener(req, stepReq(1, 1), async () => ({ ...seed }));
    await callListener(err, stepErr(1, 1, 'deepseek'), async () => undefined);
    expect(
      await callListener(req, stepReq(1, 2), async () => ({ ...seed })),
    ).toEqual({ ...seed });
  });

  it('预算内的同候选重试不记冷却,预算耗尽切换才记', async () => {
    const { req, err } = setup({
      fallbackChains: ['openai/a'],
      retriesBeforeSwitch: 1,
    });
    const seed = { provider: 'deepseek', model: 'x' };
    // 同一 step 内:首失败 → 代重试(预算内,不切换不记冷却)
    await callListener(req, stepReq(1, 1), async () => ({ ...seed }));
    expect(
      await callListener(err, stepErr(1, 1, 'deepseek'), async () => undefined),
    ).toEqual({ kind: 'retry' });
    // 此时主模型尚未冷却:另一个新 step 仍从会话模型开始
    expect(
      await callListener(req, stepReq(1, 2), async () => ({ ...seed })),
    ).toEqual({ ...seed });
    // 回到原 step 继续失败:预算耗尽 → 切换并记冷却
    expect(
      await callListener(err, stepErr(1, 1, 'deepseek'), async () => undefined),
    ).toEqual({ kind: 'retry' });
    // 新 step:主模型已冷却 → 跳过
    expect(
      await callListener(req, stepReq(1, 3), async () => ({ ...seed })),
    ).toEqual({ provider: 'openai', model: 'a' });
  });

  it('冷却跳过不消耗本 step 的切换预算:跳过后失败仍能继续切换', async () => {
    const { req, err } = setup();
    const seed = { provider: 'deepseek', model: 'x' };
    await callListener(req, stepReq(1, 1), async () => ({ ...seed }));
    await callListener(err, stepErr(1, 1, 'deepseek'), async () => undefined);
    // 新 step:冷却跳过到 openai/a
    expect(
      await callListener(req, stepReq(1, 2), async () => ({ ...seed })),
    ).toEqual({ provider: 'openai', model: 'a' });
    // openai 失败 → 仍能切到 anthropic(冷却跳过未消耗 maxRetries)
    expect(
      await callListener(err, stepErr(1, 2, 'openai'), async () => undefined),
    ).toEqual({ kind: 'retry' });
    expect(
      await callListener(req, stepReq(1, 2), async () => ({ ...seed })),
    ).toEqual({ provider: 'anthropic', model: 'b' });
  });

  it('非白名单失败不触发切换也不记冷却', async () => {
    const { req, err } = setup();
    const seed = { provider: 'deepseek', model: 'x' };
    await callListener(req, stepReq(1, 1), async () => ({ ...seed }));
    expect(
      await callListener(
        err,
        stepErr(1, 1, 'deepseek', 'INVALID_CREDENTIAL'),
        async () => undefined,
      ),
    ).toBeUndefined();
    // 新 step:无冷却标记,seed 原样(与旧版一致)
    expect(
      await callListener(req, stepReq(1, 2), async () => ({ ...seed })),
    ).toEqual({ ...seed });
  });
});

// ── 5. protocol section 冷却语义 ─────────────────────────────────────

describe('protocol section 冷却说明', () => {
  it('协议文本说明冷却跳过与到期重新验证语义', () => {
    const s = modelFallbackSection();
    expect(s.text).toContain('cooldown');
    expect(s.text).toContain('re-verified');
    expect(s.text).toContain('efficiency');
  });
});
