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
 * - apply 集成(agent/request + agent/request-error 真实链路;0.6.0 起
 *   request 监听器只读(捕获 pageModel、绝不改写返回值),冷却的效果一律
 *   经 error 推进链时的冷却感知扫描(nextCandidate)体现,切换经官方
 *   agent.model.select 持久化):
 *   - 主模型失败切换后,新 step 请求只读放行 seed,该 step 首个失败仍直接
 *     切到链上第一候选(model.select 断言);
 *   - 多候选先后失败后,新 step 首个失败跳到首个未冷却候选;
 *   - 冷却期满(时间推进)自动恢复优先级,推进不再跳过到期候选;
 *   - 全链冷却:新 step 保持 seed 原样,失败后 nextCandidate 降级切链首;
 *   - cooldownEnabled=false:行为与旧版完全一致;
 *   - 预算内同候选重试不切换(无 select),预算耗尽才切换并 select;
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
  type BreakerEntry,
  type Candidate,
  type FallbackState,
  advanceBreaker,
  breakerFailures,
  cooldownKey,
  currentEffectiveCandidate,
  firstAvailableCandidateIndex,
  isCoolingDown,
  markCooldown,
  nextCandidate,
  purgeExpiredBreakers,
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

/**
 * agent 假体(带官方 model 面):0.6.0 起切换经 agent.model.select 持久化。
 * current 返回当前 selection(缺省为种子模型 deepseek/x);select 记录
 * 调用参数进 selections 并同步更新 current(模拟宿主持久化行为)。
 * current 缺省不带 reasoningEffort → select 参数恰为 {provider, model}
 * 两键,断言可直接 toEqual 完整对象。
 */
function stubAgent(
  initial: { provider: string; model: string } = {
    provider: 'deepseek',
    model: 'x',
  },
  header?: {
    origin?: string;
    delegationDepth?: number;
    agentPreset?: string;
  },
): {
  agent: {
    session: {
      id: string;
      append: (type: string, data: Record<string, unknown>) => void;
      header?: {
        origin?: string;
        delegationDepth?: number;
        agentPreset?: string;
      };
    };
    model: {
      current: () => { provider: string; model: string } | undefined;
      select: (sel: {
        provider: string;
        model: string;
        reasoningEffort?: unknown;
      }) => void;
    };
  };
  selections: Array<{
    provider: string;
    model: string;
    reasoningEffort?: unknown;
  }>;
  /** 轨迹事件(官方 llm/retry / llm/retry-started)的写入记录。 */
  appends: Array<{ type: string; data: Record<string, unknown> }>;
} {
  const selections: Array<{
    provider: string;
    model: string;
    reasoningEffort?: unknown;
  }> = [];
  const appends: Array<{ type: string; data: Record<string, unknown> }> = [];
  let currentSelection: { provider: string; model: string } | undefined =
    initial;
  const agent = {
    session: {
      id: 'sess-cd',
      append: (type: string, data: Record<string, unknown>): void => {
        appends.push({ type, data });
      },
      ...(header ? { header } : {}),
    },
    model: {
      current: (): { provider: string; model: string } | undefined =>
        currentSelection,
      select(sel: {
        provider: string;
        model: string;
        reasoningEffort?: unknown;
      }): void {
        selections.push({ ...sel });
        currentSelection = { provider: sel.provider, model: sel.model };
      },
    },
  };
  return { agent, selections, appends };
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
    switched: false,
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

  it('稳定观察期候选降为低优先级,先选后续未冷却候选;没有其它候选时仍可半开试探', () => {
    const s = initState(chain, page);
    const probationary = new Set([cooldownKey(chain[0]!)]);
    expect(nextCandidate(s, 10, new Map(), 1000, probationary)).toEqual({
      index: 1,
      retries: 1,
    });
    const onlyProbe = new Set(chain.map(cooldownKey));
    expect(nextCandidate(s, 10, new Map(), 1000, onlyProbe)).toEqual({
      index: 0,
      retries: 1,
    });
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

// ── 4. apply 集成(request 只读放行 + error 冷却感知推进)─────────────

describe('失败冷却(apply 集成)', () => {
  it('主模型失败切换后,新 step 请求只读放行 seed,首个失败仍直接切到链上第一候选', async () => {
    const { req, err } = setup();
    const seed = { provider: 'deepseek', model: 'x' };
    const { agent, selections } = stubAgent();
    // step (1,1):主模型失败 → 切到 openai/a(select 持久化),主模型记入冷却
    await callListener(req, { ...stepReq(1, 1), agent }, async () => ({
      ...seed,
    }));
    expect(
      await callListener(
        err,
        { ...stepErr(1, 1, 'deepseek'), agent },
        async () => undefined,
      ),
    ).toEqual({ kind: 'retry' });
    expect(selections).toEqual([{ provider: 'openai', model: 'a' }]);
    // 新 step (2,1):request 只读——seed 原样放行(0.6.0 起不再改写)。
    // 用全新会话的 agent(select 会持久化,current 已是切换后候选,跨 step
    // 复用会把新 step 的 pageModel 串成 openai/a),保持"从主模型起步"
    const second = stubAgent();
    expect(
      await callListener(
        req,
        { ...stepReq(2, 1), agent: second.agent },
        async () => ({ ...seed }),
      ),
    ).toEqual({ ...seed });
    // 该 step 首个失败即直接切到链上第一候选(冷却标记不阻断推进)
    expect(
      await callListener(
        err,
        { ...stepErr(2, 1, 'deepseek'), agent: second.agent },
        async () => undefined,
      ),
    ).toEqual({ kind: 'retry' });
    expect(second.selections).toEqual([{ provider: 'openai', model: 'a' }]);
  });

  it('多个候选先后失败后,新 step 首个失败直接跳到首个未冷却的候选', async () => {
    const { req, err } = setup({
      fallbackChains: ['openai/a', 'anthropic/b'],
    });
    const seed = { provider: 'deepseek', model: 'x' };
    const { agent, selections } = stubAgent();
    await callListener(req, { ...stepReq(1, 1), agent }, async () => ({
      ...seed,
    }));
    await callListener(
      err,
      { ...stepErr(1, 1, 'deepseek'), agent },
      async () => undefined,
    );
    await callListener(
      err,
      { ...stepErr(1, 1, 'openai'), agent },
      async () => undefined,
    );
    expect(selections).toEqual([
      { provider: 'openai', model: 'a' },
      { provider: 'anthropic', model: 'b' },
    ]);
    // deepseek 与 openai 均冷却中 → 新 step(全新会话 agent,保持主模型
    // 起步)请求只读放行 seed,首个失败经冷却感知扫描直接切到 anthropic/b
    // (跳过冷却中的 openai/a)
    const next = stubAgent();
    expect(
      await callListener(
        req,
        { ...stepReq(1, 2), agent: next.agent },
        async () => ({ ...seed }),
      ),
    ).toEqual({ ...seed });
    expect(
      await callListener(
        err,
        { ...stepErr(1, 2, 'deepseek'), agent: next.agent },
        async () => undefined,
      ),
    ).toEqual({ kind: 'retry' });
    expect(next.selections).toEqual([{ provider: 'anthropic', model: 'b' }]);
  });

  it('冷却期满后观察期候选降为低优先级,观察期结束后恢复原优先级', async () => {
    vi.useFakeTimers();
    const { req, err } = setup();
    const seed = { provider: 'deepseek', model: 'x' };
    const { agent } = stubAgent();
    // 链首 openai/a 失败进入冷却;anthropic/b 尚未失败、未被冷却
    await callListener(req, { ...stepReq(1, 1), agent }, async () => ({
      ...seed,
    }));
    await callListener(
      err,
      { ...stepErr(1, 1, 'deepseek'), agent },
      async () => undefined,
    );
    await callListener(
      err,
      { ...stepErr(1, 1, 'openai'), agent },
      async () => undefined,
    );
    // 窗口内:openai/a 冷却中 → 推进直接跳过它切 anthropic/b
    // (全新会话 agent,避免上一 step 的 select 把 pageModel 串成新候选)
    const second = stubAgent();
    expect(
      await callListener(
        err,
        { ...stepErr(1, 2, 'deepseek'), agent: second.agent },
        async () => undefined,
      ),
    ).toEqual({ kind: 'retry' });
    expect(second.selections).toEqual([{ provider: 'anthropic', model: 'b' }]);
    // 冷却窗到期后进入观察期:openai/a 仍可半开试探,但低于未观察的
    // anthropic/b;此时优先推进 anthropic/b。
    vi.setSystemTime(Date.now() + 300_000 + 1);
    const third = stubAgent();
    expect(
      await callListener(
        err,
        { ...stepErr(1, 3, 'deepseek'), agent: third.agent },
        async () => undefined,
      ),
    ).toEqual({ kind: 'retry' });
    expect(third.selections).toEqual([{ provider: 'anthropic', model: 'b' }]);
    // 再越过 10 分钟稳定观察期后,openai/a 恢复普通优先级。
    vi.setSystemTime(Date.now() + 600_000 + 1);
    const fourth = stubAgent();
    expect(
      await callListener(
        err,
        { ...stepErr(1, 4, 'deepseek'), agent: fourth.agent },
        async () => undefined,
      ),
    ).toEqual({ kind: 'retry' });
    expect(fourth.selections).toEqual([{ provider: 'openai', model: 'a' }]);
  });

  it('剩余候选全部在冷却中:新 step 保持 seed 原样,失败后降级按原顺序切换', async () => {
    const { req, err } = setup();
    const seed = { provider: 'deepseek', model: 'x' };
    const { agent, selections } = stubAgent();
    await callListener(req, { ...stepReq(1, 1), agent }, async () => ({
      ...seed,
    }));
    await callListener(
      err,
      { ...stepErr(1, 1, 'deepseek'), agent },
      async () => undefined,
    );
    await callListener(
      err,
      { ...stepErr(1, 1, 'openai'), agent },
      async () => undefined,
    );
    // 第 3 次失败:链耗尽 → 透传,但失败方 anthropic/b 同样记入冷却
    expect(
      await callListener(
        err,
        { ...stepErr(1, 1, 'anthropic', 'SERVER'), agent },
        async () => undefined,
      ),
    ).toBeUndefined();
    // 全部冷却:新 step 首个请求保持 seed 原样(冷却不吞链,request 只读)
    expect(
      await callListener(req, { ...stepReq(1, 2), agent }, async () => ({
        ...seed,
      })),
    ).toEqual({ ...seed });
    // 该 step 内主模型再失败:冷却扫描发现剩余候选全冷却 → 降级切链首
    expect(
      await callListener(
        err,
        { ...stepErr(1, 2, 'deepseek'), agent },
        async () => undefined,
      ),
    ).toEqual({ kind: 'retry' });
    expect(selections).toEqual([
      { provider: 'openai', model: 'a' },
      { provider: 'anthropic', model: 'b' },
      { provider: 'openai', model: 'a' },
    ]);
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

  it('冷却只标记已真正切换过的候选:预算内透传不切换也不记冷却,耗尽才切换并持久化', async () => {
    const { req, err } = setup({
      fallbackChains: ['openai/a'],
    });
    const seed = { provider: 'deepseek', model: 'x' };
    const { agent, selections } = stubAgent();
    // 同一 step 内:首失败 → 官方预算内透传(不切换不记冷却)。
    // 预算来自 payload 携带的 provider retryPolicy(normal(5))
    await callListener(req, { ...stepReq(1, 1), agent }, async () => ({
      ...seed,
    }));
    expect(
      await callListener(
        err,
        {
          ...stepErr(1, 1, 'deepseek'),
          agent,
          retryPolicy: { mode: 'normal', maxRetries: 5 },
        },
        async () => ({ kind: 'retry' }),
      ),
    ).toEqual({ kind: 'retry' });
    expect(selections).toEqual([]);
    // 此时主模型尚未冷却:另一个新 step 仍从会话模型开始(request 只读,seed 原样)
    expect(
      await callListener(req, { ...stepReq(1, 2), agent }, async () => ({
        ...seed,
      })),
    ).toEqual({ ...seed });
    // 回到原 step 继续失败:官方无决策(undefined,预算已尽)→ 切换(经 model.select 持久化并记冷却)
    expect(
      await callListener(
        err,
        { ...stepErr(1, 1, 'deepseek'), agent },
        async () => undefined,
      ),
    ).toEqual({ kind: 'retry' });
    expect(selections).toEqual([{ provider: 'openai', model: 'a' }]);
    // 新 step 请求同样只读放行 seed:切换生效由 model.select 持久化承担,
    // 宿主下一 step 即从新 selection 发起请求
    expect(
      await callListener(req, { ...stepReq(1, 3), agent }, async () => ({
        ...seed,
      })),
    ).toEqual({ ...seed });
  });

  it('冷却跳过不消耗本 step 的切换预算:跳过直达目标后失败仍能继续切换', async () => {
    const { req, err } = setup({
      fallbackChains: ['openai/a', 'anthropic/b', 'google/c'],
    });
    const seed = { provider: 'deepseek', model: 'x' };
    const { agent, selections } = stubAgent();
    await callListener(req, { ...stepReq(1, 1), agent }, async () => ({
      ...seed,
    }));
    await callListener(
      err,
      { ...stepErr(1, 1, 'deepseek'), agent },
      async () => undefined,
    );
    await callListener(
      err,
      { ...stepErr(1, 1, 'openai'), agent },
      async () => undefined,
    );
    // 新 step(全新会话 agent,保持主模型起步):请求只读放行 seed;首个
    // 失败经冷却感知扫描跳过冷却中的 openai/a → 直达 anthropic/b
    const next = stubAgent();
    expect(
      await callListener(
        req,
        { ...stepReq(1, 2), agent: next.agent },
        async () => ({ ...seed }),
      ),
    ).toEqual({ ...seed });
    expect(
      await callListener(
        err,
        { ...stepErr(1, 2, 'deepseek'), agent: next.agent },
        async () => undefined,
      ),
    ).toEqual({ kind: 'retry' });
    // anthropic 失败 → 仍能切到 google/c(冷却跳过未消耗 maxRetries)
    expect(
      await callListener(
        err,
        { ...stepErr(1, 2, 'anthropic'), agent: next.agent },
        async () => undefined,
      ),
    ).toEqual({ kind: 'retry' });
    expect(selections).toEqual([
      { provider: 'openai', model: 'a' },
      { provider: 'anthropic', model: 'b' },
    ]);
    expect(next.selections).toEqual([
      { provider: 'anthropic', model: 'b' },
      { provider: 'google', model: 'c' },
    ]);
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

// ── 6. 连续失败熔断(breaker):纯函数 + apply 集成 ────────────────────

describe('熔断状态(breaker)纯函数', () => {
  const CAND: Candidate = { provider: 'openai', model: 'a' };

  it('首次失败:连败计数为 1,观察期自本次冷却到期起算', () => {
    const breakers = new Map<string, BreakerEntry>();
    advanceBreaker(breakers, CAND, 1_000, 61_000, 600_000);
    expect(breakers.get('openai/a')).toEqual({
      failures: 1,
      probationUntil: 661_000,
    });
  });

  it('观察期内再失败:连败计数 +1(窗口继续翻倍)', () => {
    const breakers = new Map<string, BreakerEntry>();
    advanceBreaker(breakers, CAND, 1_000, 61_000, 600_000);
    advanceBreaker(breakers, CAND, 30_000, 90_000, 600_000);
    expect(breakers.get('openai/a')).toEqual({
      failures: 2,
      probationUntil: 690_000,
    });
  });

  it('观察期已满再失败:连败计数重开为 1(视为已恢复)', () => {
    const breakers = new Map<string, BreakerEntry>();
    advanceBreaker(breakers, CAND, 1_000, 61_000, 600_000);
    advanceBreaker(breakers, CAND, 700_000, 760_000, 600_000);
    expect(breakers.get('openai/a')?.failures).toBe(1);
  });

  it('breakerFailures:观察期内返回计数,观察期满归零,无记录为 0', () => {
    const breakers = new Map<string, BreakerEntry>();
    expect(breakerFailures(breakers, CAND, 1_000)).toBe(0);
    advanceBreaker(breakers, CAND, 1_000, 61_000, 600_000);
    expect(breakerFailures(breakers, CAND, 30_000)).toBe(1);
    expect(breakerFailures(breakers, CAND, 700_000)).toBe(0);
  });

  it('观察期时长为 0:冷却窗内的直接重试仍算连败,冷却到期后立即清零', () => {
    const breakers = new Map<string, BreakerEntry>();
    advanceBreaker(breakers, CAND, 1_000, 61_000, 0);
    expect(breakerFailures(breakers, CAND, 30_000)).toBe(1);
    // 会话指定模型不受候选冷却跳过约束,若冷却窗内又失败仍可递增。
    advanceBreaker(breakers, CAND, 30_000, 90_000, 0);
    expect(breakers.get('openai/a')?.failures).toBe(2);
    // 冷却窗届满即恢复(无额外观察期),下一次失败重新从 1 起算。
    expect(breakerFailures(breakers, CAND, 90_000)).toBe(0);
    advanceBreaker(breakers, CAND, 90_000, 150_000, 0);
    expect(breakers.get('openai/a')?.failures).toBe(1);
  });

  it('purgeExpiredBreakers 只删观察期已满的条目', () => {
    const breakers = new Map<string, BreakerEntry>();
    advanceBreaker(breakers, CAND, 1_000, 61_000, 600_000);
    advanceBreaker(breakers, { provider: 'b', model: 'x' }, 1_000, 900_000, 0);
    purgeExpiredBreakers(breakers, 700_000);
    expect(breakers.has('openai/a')).toBe(false);
    expect(breakers.has('b/x')).toBe(true);
  });
});

describe('熔断递增(apply 集成)', () => {
  const T0 = Date.UTC(2026, 4, 15, 12, 0, 0);
  const seed = { provider: 'deepseek', model: 'x' };

  /** 冷却来源日志(apply 只在 source !== 'default' 时打印)。 */
  function cooldownLogs(): string[] {
    return vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
  }

  /** 推进到指定时刻并让主模型再失败一次(新 step + 全新会话 agent)。 */
  async function failAgain(
    req: unknown,
    err: unknown,
    turn: number,
    step: number,
    at: number,
  ): Promise<void> {
    vi.setSystemTime(at);
    const agent = stubAgent();
    await callListener(
      req,
      { ...stepReq(turn, step), agent: agent.agent },
      async () => ({
        ...seed,
      }),
    );
    await callListener(
      err,
      { ...stepErr(turn, step, 'deepseek'), agent: agent.agent },
      async () => undefined,
    );
  }

  it('同一候选连续失败:冷却窗口按 2^失败次数 指数递增', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { req, err } = setup({
      cooldownMs: 1000,
      cooldownStabilizationMs: 10_000,
    });
    const agent = stubAgent();
    await callListener(
      req,
      { ...stepReq(1, 1), agent: agent.agent },
      async () => ({
        ...seed,
      }),
    );
    await callListener(
      err,
      { ...stepErr(1, 1, 'deepseek'), agent: agent.agent },
      async () => undefined,
    );
    // 首次失败仍是普通冷却档(零回归,不产生 breaker 日志)
    expect(cooldownLogs().some((l) => l.includes('(breaker'))).toBe(false);
    // 冷却窗已到期但仍在观察期内 → 第 2 次失败窗口翻倍(2×)
    await failAgain(req, err, 1, 2, T0 + 1500);
    expect(
      cooldownLogs().some(
        (l) => l.includes('(breaker') && l.includes('2000ms'),
      ),
    ).toBe(true);
    // 观察期内第 3 次失败 → 窗口 4×
    await failAgain(req, err, 1, 3, T0 + 2000);
    expect(cooldownLogs().some((l) => l.includes('4000ms'))).toBe(true);
  });

  it('熔断窗口按 cooldownBreakerCapMs 独立封顶', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { req, err } = setup({
      cooldownMs: 1000,
      cooldownStabilizationMs: 10_000,
      cooldownBreakerCapMs: 1500,
    });
    const agent = stubAgent();
    await callListener(
      req,
      { ...stepReq(1, 1), agent: agent.agent },
      async () => ({
        ...seed,
      }),
    );
    await callListener(
      err,
      { ...stepErr(1, 1, 'deepseek'), agent: agent.agent },
      async () => undefined,
    );
    // 2 倍窗口(2000ms)被封到 1500ms
    await failAgain(req, err, 1, 2, T0 + 1500);
    expect(
      cooldownLogs().some(
        (l) => l.includes('(breaker') && l.includes('1500ms'),
      ),
    ).toBe(true);
  });

  it('观察期安静度过视为恢复:下一次失败回落固定窗口', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { req, err } = setup({
      cooldownMs: 1000,
      cooldownStabilizationMs: 10_000,
    });
    const agent = stubAgent();
    await callListener(
      req,
      { ...stepReq(1, 1), agent: agent.agent },
      async () => ({
        ...seed,
      }),
    );
    await callListener(
      err,
      { ...stepErr(1, 1, 'deepseek'), agent: agent.agent },
      async () => undefined,
    );
    // 越过观察期(冷却到期 + 10s)再失败 → 连败计数已清零,回落固定档
    await failAgain(req, err, 1, 2, T0 + 20_000);
    expect(cooldownLogs().some((l) => l.includes('(breaker'))).toBe(false);
  });

  it('熔断总开关关闭时窗口恒为固定档(行为与旧版一致)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { req, err } = setup({
      cooldownMs: 1000,
      cooldownStabilizationMs: 10_000,
      cooldownBreakerEnabled: false,
    });
    const agent = stubAgent();
    await callListener(
      req,
      { ...stepReq(1, 1), agent: agent.agent },
      async () => ({
        ...seed,
      }),
    );
    await callListener(
      err,
      { ...stepErr(1, 1, 'deepseek'), agent: agent.agent },
      async () => undefined,
    );
    await failAgain(req, err, 1, 2, T0 + 1500);
    expect(cooldownLogs().some((l) => l.includes('(breaker'))).toBe(false);
  });

  it('限流对齐:provider 报告 retry-after 时冷却对齐服务端要求', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { req, err } = setup({ cooldownMs: 1000 });
    const agent = stubAgent();
    await callListener(
      req,
      { ...stepReq(1, 1), agent: agent.agent },
      async () => ({
        ...seed,
      }),
    );
    await callListener(
      err,
      {
        ...stepErr(1, 1, 'deepseek'),
        failure: { ...stubFailure('RATE_LIMIT'), providerRetryAfterMs: 45_000 },
        agent: agent.agent,
      },
      async () => undefined,
    );
    expect(
      cooldownLogs().some(
        (l) => l.includes('(retry-after') && l.includes('45000ms'),
      ),
    ).toBe(true);
  });

  // ── 轨迹断言(不只断言日志字符串:冷却决策直接进轨迹事件)────────────

  /** 取轨迹里最后一条 llm/retry 事件的冷却字段。 */
  function lastCooldown(
    appends: Array<{ type: string; data: Record<string, unknown> }>,
  ): { source?: unknown; untilMs?: unknown } {
    const events = appends.filter((a) => a.type === 'llm/retry');
    const last = events[events.length - 1];
    return {
      source: last?.data.cooldownSource,
      untilMs: last?.data.cooldownUntilMs,
    };
  }

  it('轨迹事件携带熔断档来源与到期时间(断言实际冷却时长)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { req, err } = setup({
      cooldownMs: 1000,
      cooldownStabilizationMs: 10_000,
    });
    const first = stubAgent();
    await callListener(
      req,
      { ...stepReq(1, 1), agent: first.agent },
      async () => ({ ...seed }),
    );
    await callListener(
      err,
      { ...stepErr(1, 1, 'deepseek'), agent: first.agent },
      async () => undefined,
    );
    // 首次失败:固定档(source=default),到期 = 失败时刻 + 1000ms
    expect(lastCooldown(first.appends)).toEqual({
      source: 'default',
      untilMs: T0 + 1000,
    });

    // 观察期内再失败:熔断档 2 倍(2000ms),到期 = 失败时刻 + 2000ms
    const at = T0 + 1500;
    vi.setSystemTime(at);
    const second = stubAgent();
    await callListener(
      req,
      { ...stepReq(1, 2), agent: second.agent },
      async () => ({ ...seed }),
    );
    await callListener(
      err,
      { ...stepErr(1, 2, 'deepseek'), agent: second.agent },
      async () => undefined,
    );
    expect(lastCooldown(second.appends)).toEqual({
      source: 'breaker',
      untilMs: at + 2000,
    });
  });

  it('熔断档不受 cooldownCapMs 总上限截断(轨迹到期时间为递增档时长)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { req, err } = setup({
      cooldownMs: 1000,
      cooldownCapMs: 100, // 故意配得极小:固定档会被截到 100ms
      cooldownStabilizationMs: 10_000,
    });
    const first = stubAgent();
    await callListener(
      req,
      { ...stepReq(1, 1), agent: first.agent },
      async () => ({ ...seed }),
    );
    await callListener(
      err,
      { ...stepErr(1, 1, 'deepseek'), agent: first.agent },
      async () => undefined,
    );
    // 固定档受总上限截断 → 100ms
    expect(lastCooldown(first.appends)).toEqual({
      source: 'default',
      untilMs: T0 + 100,
    });

    const at = T0 + 1500;
    vi.setSystemTime(at);
    const second = stubAgent();
    await callListener(
      req,
      { ...stepReq(1, 2), agent: second.agent },
      async () => ({ ...seed }),
    );
    await callListener(
      err,
      { ...stepErr(1, 2, 'deepseek'), agent: second.agent },
      async () => undefined,
    );
    // 熔断档只受自己的 breakerCapMs 约束 → 2000ms(不被 100ms 截断)
    expect(lastCooldown(second.appends)).toEqual({
      source: 'breaker',
      untilMs: at + 2000,
    });
  });

  it('retry-after 压过熔断档(轨迹来源为 retry-after)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { req, err } = setup({
      cooldownMs: 1000,
      cooldownStabilizationMs: 10_000,
    });
    const first = stubAgent();
    await callListener(
      req,
      { ...stepReq(1, 1), agent: first.agent },
      async () => ({ ...seed }),
    );
    await callListener(
      err,
      { ...stepErr(1, 1, 'deepseek'), agent: first.agent },
      async () => undefined,
    );
    const at = T0 + 1500;
    vi.setSystemTime(at);
    const second = stubAgent();
    await callListener(
      req,
      { ...stepReq(1, 2), agent: second.agent },
      async () => ({ ...seed }),
    );
    await callListener(
      err,
      {
        ...stepErr(1, 2, 'deepseek'),
        failure: { ...stubFailure('RATE_LIMIT'), providerRetryAfterMs: 45_000 },
        agent: second.agent,
      },
      async () => undefined,
    );
    expect(lastCooldown(second.appends)).toEqual({
      source: 'retry-after',
      untilMs: at + 45_000,
    });
  });

  it('配额型失败走配额档(轨迹来源为 quota-window,不落熔断档)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { req, err } = setup({
      cooldownMs: 1000,
      cooldownStabilizationMs: 10_000,
    });
    const agent = stubAgent();
    await callListener(
      req,
      { ...stepReq(1, 1), agent: agent.agent },
      async () => ({ ...seed }),
    );
    await callListener(
      err,
      {
        ...stepErr(1, 1, 'deepseek'),
        failure: stubFailure('QUOTA', 'usage limit exceeded'),
        agent: agent.agent,
      },
      async () => undefined,
    );
    expect(lastCooldown(agent.appends)).toEqual({
      source: 'quota-window',
      untilMs: T0 + 18_000_000,
    });
  });

  it('冷却关闭时轨迹不携带冷却字段(与旧版一致)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { req, err } = setup({ cooldownEnabled: false });
    const agent = stubAgent();
    await callListener(
      req,
      { ...stepReq(1, 1), agent: agent.agent },
      async () => ({ ...seed }),
    );
    await callListener(
      err,
      { ...stepErr(1, 1, 'deepseek'), agent: agent.agent },
      async () => undefined,
    );
    expect(lastCooldown(agent.appends)).toEqual({
      source: undefined,
      untilMs: undefined,
    });
  });

  it('配额延长关闭时配额型失败落熔断档(不再走配额档)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { req, err } = setup({
      cooldownMs: 1000,
      quotaCooldownEnabled: false,
      cooldownStabilizationMs: 10_000,
    });
    const agent = stubAgent();
    await callListener(
      req,
      { ...stepReq(1, 1), agent: agent.agent },
      async () => ({ ...seed }),
    );
    await callListener(
      err,
      {
        ...stepErr(1, 1, 'deepseek'),
        failure: stubFailure('QUOTA', 'usage limit exceeded'),
        agent: agent.agent,
      },
      async () => undefined,
    );
    // 配额延长关闭 → 配额型不再走配额档;首次失败落固定档
    expect(lastCooldown(agent.appends)).toEqual({
      source: 'default',
      untilMs: T0 + 1000,
    });
  });
});

// ── 5. 角色级回退链(apply 集成,0.8.0)─────────────────────────────────

describe('角色级回退链(apply 集成,0.8.0)', () => {
  const T0 = Date.UTC(2026, 4, 15, 12, 0, 0);
  const seed = { provider: 'deepseek', model: 'x' };

  it('子代理角色使用角色专属链;无 header 的主会话回落全局链', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { req, err } = setup({
      fallbackChains: ['anthropic/b', 'openai/a'],
      roleChains: { subagent: ['openai/a'] },
    });
    // 主会话(无 session.header)→ 角色 default → 全局链,首候选 anthropic/b
    const main = stubAgent();
    await callListener(
      req,
      { ...stepReq(1, 1), agent: main.agent },
      async () => ({ ...seed }),
    );
    await callListener(
      err,
      { ...stepErr(1, 1, 'deepseek'), agent: main.agent },
      async () => undefined,
    );
    expect(main.selections).toEqual([{ provider: 'anthropic', model: 'b' }]);
    // 子代理(header.origin='subagent')→ 角色 subagent → 专属链,首候选 openai/a
    const sub = stubAgent(undefined, {
      origin: 'subagent',
      delegationDepth: 1,
    });
    await callListener(
      req,
      { ...stepReq(2, 1), agent: sub.agent },
      async () => ({ ...seed }),
    );
    await callListener(
      err,
      { ...stepErr(2, 1, 'deepseek'), agent: sub.agent },
      async () => undefined,
    );
    expect(sub.selections).toEqual([{ provider: 'openai', model: 'a' }]);
  });

  it('配置了 agentPreset 顶层会话按 preset 取角色;该角色未配置链时回落全局链', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { req, err } = setup({
      fallbackChains: ['anthropic/b', 'openai/a'],
      roleChains: { subagent: ['openai/a'] },
    });
    // researcher 角色未配置 roleChains → roleChain 回落全局链,首候选 anthropic/b
    const preset = stubAgent(undefined, { agentPreset: 'researcher' });
    await callListener(
      req,
      { ...stepReq(1, 1), agent: preset.agent },
      async () => ({ ...seed }),
    );
    await callListener(
      err,
      { ...stepErr(1, 1, 'deepseek'), agent: preset.agent },
      async () => undefined,
    );
    expect(preset.selections).toEqual([{ provider: 'anthropic', model: 'b' }]);
  });

  it('冷却跨角色共享:同一候选在一角色链被冷却,另一角色链同样跳过', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { req, err } = setup({
      fallbackChains: ['openai/a', 'anthropic/b'],
      roleChains: { subagent: ['openai/a', 'anthropic/b'] },
    });
    // 主会话:deepseek 失败切 openai/a;openai 再失败 → 冷却 openai/a,
    // 切到 anthropic/b。此时 openai/a 已进入冷却表。
    const main = stubAgent();
    await callListener(
      req,
      { ...stepReq(1, 1), agent: main.agent },
      async () => ({ ...seed }),
    );
    await callListener(
      err,
      { ...stepErr(1, 1, 'deepseek'), agent: main.agent },
      async () => undefined,
    );
    expect(main.selections).toEqual([{ provider: 'openai', model: 'a' }]);
    await callListener(
      err,
      { ...stepErr(1, 1, 'openai'), agent: main.agent },
      async () => undefined,
    );
    expect(main.selections).toEqual([
      { provider: 'openai', model: 'a' },
      { provider: 'anthropic', model: 'b' },
    ]);
    // 子代理角色:专属链同含 openai/a;同一时点 openai/a 仍冷却中
    // → 失败后跳过它,直接切到 anthropic/b(冷却共享决策)
    const sub = stubAgent(undefined, {
      origin: 'subagent',
      delegationDepth: 1,
    });
    await callListener(
      req,
      { ...stepReq(2, 1), agent: sub.agent },
      async () => ({ ...seed }),
    );
    await callListener(
      err,
      { ...stepErr(2, 1, 'deepseek'), agent: sub.agent },
      async () => undefined,
    );
    expect(sub.selections).toEqual([{ provider: 'anthropic', model: 'b' }]);
  });

  it('agentPreset 命中专属链:researcher 角色配置了链时走角色候选', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { req, err } = setup({
      fallbackChains: ['anthropic/b', 'openai/a'],
      roleChains: { researcher: ['openai/a'] },
    });
    const preset = stubAgent(undefined, { agentPreset: 'researcher' });
    await callListener(
      req,
      { ...stepReq(1, 1), agent: preset.agent },
      async () => ({ ...seed }),
    );
    await callListener(
      err,
      { ...stepErr(1, 1, 'deepseek'), agent: preset.agent },
      async () => undefined,
    );
    // preset 角色命中专属链,首候选 openai/a(而非全局链首候选 anthropic/b)
    expect(preset.selections).toEqual([{ provider: 'openai', model: 'a' }]);
  });

  it('只配 roleChains(全局链留空)同样激活:主会话空链耗尽透传,子代理走专属链', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { req, err } = setup({
      fallbackChains: [],
      roleChains: { subagent: ['openai/a'] },
    });
    // 主会话(角色 default,无全局链)→ 空链,失败推进立即耗尽,透传不误切
    const main = stubAgent();
    await callListener(
      req,
      { ...stepReq(1, 1), agent: main.agent },
      async () => ({ ...seed }),
    );
    await callListener(
      err,
      { ...stepErr(1, 1, 'deepseek'), agent: main.agent },
      async () => undefined,
    );
    expect(main.selections).toEqual([]);
    // 子代理角色 → 专属链激活,正常切换
    const sub = stubAgent(undefined, {
      origin: 'subagent',
      delegationDepth: 1,
    });
    await callListener(
      req,
      { ...stepReq(2, 1), agent: sub.agent },
      async () => ({ ...seed }),
    );
    await callListener(
      err,
      { ...stepErr(2, 1, 'deepseek'), agent: sub.agent },
      async () => undefined,
    );
    expect(sub.selections).toEqual([{ provider: 'openai', model: 'a' }]);
  });

  it('候选级覆盖:角色链条目带覆盖时角色级优先;不带覆盖时不遮蔽全局覆盖', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    // 场景 A:角色链条目带 maxTokens → 角色级覆盖生效(优先于全局)
    const a = setup({
      fallbackChains: ['anthropic/b'],
      roleChains: {
        subagent: [{ provider: 'openai', model: 'a', maxTokens: 4096 }],
      },
    });
    const agentA = stubAgent(undefined, {
      origin: 'subagent',
      delegationDepth: 1,
    });
    const outA = await callListener(
      a.req,
      { ...stepReq(1, 1), agent: agentA.agent },
      async () => ({ provider: 'openai', model: 'a' }),
    );
    expect(outA).toEqual({ provider: 'openai', model: 'a', maxTokens: 4096 });

    // 场景 B:角色链条目不带覆盖(string 形态)→ 不遮蔽,回落全局链覆盖
    const b = setup({
      fallbackChains: [{ provider: 'openai', model: 'a', maxTokens: 2048 }],
      roleChains: { subagent: ['openai/a'] },
    });
    const agentB = stubAgent(undefined, {
      origin: 'subagent',
      delegationDepth: 1,
    });
    const outB = await callListener(
      b.req,
      { ...stepReq(1, 1), agent: agentB.agent },
      async () => ({ provider: 'openai', model: 'a' }),
    );
    expect(outB).toEqual({ provider: 'openai', model: 'a', maxTokens: 2048 });
  });
});
