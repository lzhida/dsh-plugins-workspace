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
): {
  agent: {
    session: { id: string; append: () => void };
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
} {
  const selections: Array<{
    provider: string;
    model: string;
    reasoningEffort?: unknown;
  }> = [];
  let currentSelection: { provider: string; model: string } | undefined =
    initial;
  const agent = {
    session: { id: 'sess-cd', append: (): void => {} },
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
  return { agent, selections };
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

  it('冷却期满后模型自动恢复优先级:失败推进不再跳过到期候选', async () => {
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
    // 窗口期满(默认 300000ms):到期候选恢复优先级——推进回到链首 openai/a
    vi.setSystemTime(Date.now() + 300_000 + 1);
    const third = stubAgent();
    expect(
      await callListener(
        err,
        { ...stepErr(1, 3, 'deepseek'), agent: third.agent },
        async () => undefined,
      ),
    ).toEqual({ kind: 'retry' });
    expect(third.selections).toEqual([{ provider: 'openai', model: 'a' }]);
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

  it('预算内的同候选重试不切换(无 select),预算耗尽才切换并持久化', async () => {
    const { req, err } = setup({
      fallbackChains: ['openai/a'],
      retriesBeforeSwitch: 1,
    });
    const seed = { provider: 'deepseek', model: 'x' };
    const { agent, selections } = stubAgent();
    // 同一 step 内:首失败 → 代重试(预算内,不切换不记冷却)
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
    expect(selections).toEqual([]);
    // 此时主模型尚未冷却:另一个新 step 仍从会话模型开始(request 只读,seed 原样)
    expect(
      await callListener(req, { ...stepReq(1, 2), agent }, async () => ({
        ...seed,
      })),
    ).toEqual({ ...seed });
    // 回到原 step 继续失败:预算耗尽 → 切换(经 model.select 持久化并记冷却)
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
