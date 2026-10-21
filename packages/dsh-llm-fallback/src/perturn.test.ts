/**
 * perTurn 单次切换档 + step 状态表生命周期行为契约测试。
 *
 * 覆盖(需求:perTurn 半成品字段收口实装 + 每 step 状态表过期清理
 * + 状态键会话隔离):
 * - purgeStaleTurnStates / stateFor / stepStateKey 纯函数:新 turn 首次建态
 *   清掉同会话其他 turn 全部旧 step 键;同 turn 旧 step 键保留;跨会话键位
 *   (含同号 turn)保留;已存在键的常规读取不触发清理;无 ':' 键安全降级
 *   不误删;新键 switched=false(one-shot 未消耗)且不跨键泄漏;
 * - 会话隔离(apply 集成):同号 turn:step 两会话键位互不串扰;跨会话新
 *   turn 建态清理不误删他会在途状态;会话标识缺失降级共享键位(旧行为);
 * - perTurn=false(apply 集成,真实链路):
 *   - 同 turn:step 至多切换一次:首次预算耗尽切换后,同 step 再次预算耗尽
 *     不再切换、透传上游;
 *   - 官方 retry 透传(预算内)不消耗名额:透传后预算耗尽仍能完成该次切换;
 *     切换后同候选代执行重试照常,预算再耗尽也不得二次切换;
 *   - 新 step 天然重置:同 turn 下一 step 恢复完整切换名额;
 *   - 新 turn 天然重置 + 冷却表跨 turn 语义不受状态清理影响:冷却起点改写
 *     不算切换,新 turn 首个 step 仍能完成一次切换;
 * - perTurn=true 默认回归:同一 step 可连切多个候选(行为与旧版一致)。
 *
 * 时间控制:退避清零(baseDelayMs/maxDelayMs=0),无需假定时器。
 */

import type { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apply } from './index.ts';
import {
  type Candidate,
  type FallbackState,
  type StepKey,
  purgeStaleTurnStates,
  stateFor,
  stepStateKey,
} from './state.ts';

// ── 测试工具(沿用 config.test.ts / cooldown.test.ts 的 stubCtx 模式)──

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
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

/** apply() 装载 + 取出两个 listener(退避清零,聚焦 one-shot 逻辑)。 */
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
  failure: { code, message: 'fake failure' },
  signal: sig(),
});

/** 带 agent 的载荷(会话标识注入;session=undefined 即降级无 agent)。 */
const stepReqAs = (
  session: string | undefined,
  turn: number,
  step: number,
): Record<string, unknown> => ({
  turn,
  step,
  signal: sig(),
  ...(session === undefined
    ? {}
    : { agent: { session: { id: session, append: () => {} } } }),
});
const stepErrAs = (
  session: string | undefined,
  turn: number,
  step: number,
  provider: string,
  code = 'RATE_LIMIT',
): Record<string, unknown> => ({
  turn,
  step,
  provider,
  failure: { code, message: 'fake failure' },
  signal: sig(),
  ...(session === undefined
    ? {}
    : { agent: { session: { id: session, append: () => {} } } }),
});

/** 最小 FallbackState 假体(手工 seed 用,绕开 stateFor 的创建即清理)。 */
const fake = (): FallbackState => ({
  chain: chain3,
  index: -1,
  retries: 0,
  exhausted: false,
  candidateFailures: 0,
  switched: false,
});

const chain3: ReadonlyArray<Candidate> = [
  { provider: 'a', model: 'x' },
  { provider: 'b', model: 'y' },
  { provider: 'c', model: 'z' },
];

// ── 1. step 状态表清理(纯函数)────────────────────────────────────────

describe('step 状态表清理(purgeStaleTurnStates / stateFor)', () => {
  it('新 turn 首次建态:清掉其他 turn 的全部旧 step 键', () => {
    const states = new Map<StepKey, FallbackState>();
    states.set('1:0', fake());
    states.set('1:1', fake());
    states.set('2:0', fake());
    expect(states.size).toBe(3);
    stateFor(states, '3:0', chain3);
    expect([...states.keys()]).toEqual(['3:0']);
  });

  it('同 turn 旧 step 键保留:清理只针对其他 turn', () => {
    const states = new Map<StepKey, FallbackState>();
    states.set('5:0', fake());
    states.set('5:1', fake());
    states.set('6:0', fake());
    stateFor(states, '5:2', chain3);
    expect([...states.keys()].sort()).toEqual(['5:0', '5:1', '5:2']);
  });

  it('已存在键的常规读取不触发清理(只在创建分支扫描)', () => {
    const states = new Map<StepKey, FallbackState>();
    const existing = stateFor(states, '1:0', chain3);
    states.set('9:9', fake()); // 手工注入异 turn 键(模拟被外部写入的状态)
    // 读已存在键:返回同一对象,异 turn 键原样保留(读取路径零扫描)
    expect(stateFor(states, '1:0', chain3)).toBe(existing);
    expect(states.has('9:9')).toBe(true);
    // 创建路径才清理:新建 '1:1' 清掉异 turn 键
    stateFor(states, '1:1', chain3);
    expect(states.has('9:9')).toBe(false);
  });

  it('key 无 ":"(非 turn:step 形态)时安全降级,不误删任何键', () => {
    const states = new Map<StepKey, FallbackState>();
    stateFor(states, 'a', chain3);
    stateFor(states, 'b', chain3);
    purgeStaleTurnStates(states, 'no-colon');
    expect([...states.keys()].sort()).toEqual(['a', 'b']);
  });

  it('stateFor 新键 switched=false(one-shot 未消耗);置 true 不跨键泄漏,同键幂等', () => {
    const states = new Map<StepKey, FallbackState>();
    const s1 = stateFor(states, '1:0', chain3);
    expect(s1.switched).toBe(false);
    s1.switched = true; // 模拟一次切换已消耗名额
    // 新 step 重建状态:one-shot 天然重置
    const s2 = stateFor(states, '1:1', chain3);
    expect(s2.switched).toBe(false);
    // 同键重复读取返回同一对象,不重置已消耗的名额
    expect(stateFor(states, '1:0', chain3)).toBe(s1);
    expect(stateFor(states, '1:0', chain3).switched).toBe(true);
  });
});

// ── 1b. step 状态键会话隔离(stepStateKey / purge / apply 集成)────────

describe('step 状态键会话隔离(纯函数)', () => {
  it('stepStateKey:有会话 id 前缀会话段,缺省降级为 turn:step 形态', () => {
    expect(stepStateKey('sess-1', 3, 0)).toBe('sess-1:3:0');
    expect(stepStateKey(undefined, 3, 0)).toBe('3:0');
    expect(stepStateKey('', 3, 0)).toBe('3:0');
  });

  it('purge 会话隔离:A 新 turn 建态只清 A 旧 turn,B 会话与无会话段键保留', () => {
    const states = new Map<StepKey, FallbackState>();
    for (const k of ['sA:1:0', 'sA:1:1', 'sA:2:0', 'sB:1:0', 'sB:9:0', '1:0']) {
      states.set(k, fake());
    }
    stateFor(states, 'sA:3:0', chain3);
    expect([...states.keys()].sort()).toEqual([
      '1:0',
      'sA:3:0',
      'sB:1:0',
      'sB:9:0',
    ]);
  });

  it('降级共享桶:无会话段键只清同桶异 turn,不波及会话键', () => {
    const states = new Map<StepKey, FallbackState>();
    for (const k of ['1:0', '2:0', 'sA:1:0']) states.set(k, fake());
    stateFor(states, '3:0', chain3);
    expect([...states.keys()].sort()).toEqual(['3:0', 'sA:1:0']);
  });

  it('同号 turn 跨会话交错:B 会话同号 turn 建态不误清 A 的在途状态', () => {
    const states = new Map<StepKey, FallbackState>();
    states.set('sA:3:0', fake()); // A 会话 turn3 在途
    stateFor(states, 'sB:3:1', chain3); // B 会话同号 turn 新 step 建态
    expect([...states.keys()].sort()).toEqual(['sA:3:0', 'sB:3:1']);
  });
});

describe('多会话交错(apply 集成)', () => {
  it('同号 turn:step 两会话互不串扰:B 首请求不被 A 的已切状态劫持', async () => {
    // 冷却关闭:冷却表跨会话共享属既定语义,关闭以聚焦键位隔离本身
    const { req, err } = setup({ cooldownEnabled: false });
    const seed = { provider: 'deepseek', model: 'x' };
    // 会话 A (1,1):失败耗尽预算 → 切 openai/a
    await callListener(req, stepReqAs('sess-A', 1, 1), async () => ({
      ...seed,
    }));
    expect(
      await callListener(
        err,
        stepErrAs('sess-A', 1, 1, 'deepseek'),
        async () => undefined,
      ),
    ).toEqual({ kind: 'retry' });
    // 会话 B 同号 (1,1) 首请求:B 无回退状态 → seed 原样返回
    // (旧实现共享键位:会命中 A 的已切状态被劫持为 openai/a)
    expect(
      await callListener(req, stepReqAs('sess-B', 1, 1), async () => ({
        ...seed,
      })),
    ).toEqual({ ...seed });
    // B 自己失败 → 独立完成切换
    expect(
      await callListener(
        err,
        stepErrAs('sess-B', 1, 1, 'deepseek'),
        async () => undefined,
      ),
    ).toEqual({ kind: 'retry' });
    expect(
      await callListener(req, stepReqAs('sess-B', 1, 1), async () => ({
        ...seed,
      })),
    ).toEqual({ provider: 'openai', model: 'a' });
    // A 的状态不受 B 影响:仍改写 openai/a
    expect(
      await callListener(req, stepReqAs('sess-A', 1, 1), async () => ({
        ...seed,
      })),
    ).toEqual({ provider: 'openai', model: 'a' });
  });

  it('跨会话新 turn 建态清理不误删他会在途状态:B 开新 turn 后 A 的切换仍生效', async () => {
    const { req, err } = setup({ cooldownEnabled: false });
    const seed = { provider: 'deepseek', model: 'x' };
    // A (1,1) 切到 openai/a(状态 sA:1:1,index=0)
    await callListener(req, stepReqAs('sess-A', 1, 1), async () => ({
      ...seed,
    }));
    expect(
      await callListener(
        err,
        stepErrAs('sess-A', 1, 1, 'deepseek'),
        async () => undefined,
      ),
    ).toEqual({ kind: 'retry' });
    // B 开新 turn (2,1):建态触发清理——旧实现按 turn 前缀清理会删掉
    // A 的在途状态(风险②原始场景),新实现跨会话保留
    await callListener(req, stepReqAs('sess-B', 2, 1), async () => ({
      ...seed,
    }));
    // A 再次请求:状态未被删除 → 仍改写 openai/a(旧实现会重置回会话模型)
    expect(
      await callListener(req, stepReqAs('sess-A', 1, 1), async () => ({
        ...seed,
      })),
    ).toEqual({ provider: 'openai', model: 'a' });
  });

  it('会话标识缺失降级:无 agent 的 payload 共享 turn:step 键位(旧行为)', async () => {
    const { req, err } = setup({ cooldownEnabled: false });
    const seed = { provider: 'deepseek', model: 'x' };
    // 无 agent 载荷:降级键位无会话段(现状语义)
    await callListener(req, stepReq(1, 1), async () => ({ ...seed }));
    expect(
      await callListener(err, stepErr(1, 1, 'deepseek'), async () => undefined),
    ).toEqual({ kind: 'retry' });
    // 同号键位命中同一状态:请求被改写为已切候选(共享键位即旧行为)
    expect(
      await callListener(req, stepReq(1, 1), async () => ({ ...seed })),
    ).toEqual({ provider: 'openai', model: 'a' });
  });
});

// ── 2. perTurn=false 单次切换档(apply 集成)──────────────────────────

describe('perTurn=false 单次切换档(apply 集成)', () => {
  it('同 turn:step 至多切换一次:名额消耗后同 step 再失败不再切换,透传上游', async () => {
    const { req, err } = setup({ perTurn: false });
    const seed = { provider: 'deepseek', model: 'x' };
    await callListener(req, stepReq(1, 1), async () => ({ ...seed }));
    // 首失败:预算耗尽(默认 0)→ 切到 openai/a,名额消耗
    expect(
      await callListener(err, stepErr(1, 1, 'deepseek'), async () => undefined),
    ).toEqual({ kind: 'retry' });
    // 同 step 二次预算耗尽:one-shot 已消耗 → 不再切换,透传上游(无决策 → undefined)
    expect(
      await callListener(err, stepErr(1, 1, 'openai'), async () => undefined),
    ).toBeUndefined();
    // index 未推进:请求仍改写为 openai/a,而非 anthropic/b
    expect(
      await callListener(req, stepReq(1, 1), async () => ({ ...seed })),
    ).toEqual({ provider: 'openai', model: 'a' });
  });

  it('官方 retry 透传(预算内)不消耗名额;切换后同候选代执行照常,预算再耗尽也不得二次切换', async () => {
    const { req, err } = setup({ perTurn: false, retriesBeforeSwitch: 1 });
    const seed = { provider: 'deepseek', model: 'x' };
    await callListener(req, stepReq(1, 1), async () => ({ ...seed }));
    // 预算内官方 retry 决策 → 原样透传,不消耗 one-shot 名额
    const official = { kind: 'retry' } as const;
    expect(
      await callListener(err, stepErr(1, 1, 'deepseek'), async () => official),
    ).toBe(official);
    // 二次失败预算耗尽 → 仍能完成本 step 的那次切换
    expect(
      await callListener(err, stepErr(1, 1, 'deepseek'), async () => undefined),
    ).toEqual({ kind: 'retry' });
    expect(
      await callListener(req, stepReq(1, 1), async () => ({ ...seed })),
    ).toEqual({ provider: 'openai', model: 'a' });
    // 切换后 openai 预算内代执行重试照常(不经过 one-shot 闸门)
    expect(
      await callListener(err, stepErr(1, 1, 'openai'), async () => undefined),
    ).toEqual({ kind: 'retry' });
    // 代执行重试不是切换:index 仍在 openai
    expect(
      await callListener(req, stepReq(1, 1), async () => ({ ...seed })),
    ).toEqual({ provider: 'openai', model: 'a' });
    // openai 预算再耗尽:名额已消耗 → 不二次切换,透传上游
    expect(
      await callListener(err, stepErr(1, 1, 'openai'), async () => undefined),
    ).toBeUndefined();
    expect(
      await callListener(req, stepReq(1, 1), async () => ({ ...seed })),
    ).toEqual({ provider: 'openai', model: 'a' });
  });

  it('新 step 天然重置:同 turn 下一 step 恢复完整切换名额', async () => {
    const { req, err } = setup({ perTurn: false, cooldownEnabled: false });
    const seed = { provider: 'deepseek', model: 'x' };
    // step (1,1):切换一次后名额耗尽,二次失败不再切换
    await callListener(req, stepReq(1, 1), async () => ({ ...seed }));
    expect(
      await callListener(err, stepErr(1, 1, 'deepseek'), async () => undefined),
    ).toEqual({ kind: 'retry' });
    expect(
      await callListener(err, stepErr(1, 1, 'openai'), async () => undefined),
    ).toBeUndefined();
    // step (1,2):新 step 新状态 → 首失败照常切换
    await callListener(req, stepReq(1, 2), async () => ({ ...seed }));
    expect(
      await callListener(err, stepErr(1, 2, 'deepseek'), async () => undefined),
    ).toEqual({ kind: 'retry' });
    expect(
      await callListener(req, stepReq(1, 2), async () => ({ ...seed })),
    ).toEqual({ provider: 'openai', model: 'a' });
  });

  it('新 turn 天然重置:冷却起点改写不算切换、旧冷却不受状态清理影响,名额完整恢复', async () => {
    const { req, err } = setup({ perTurn: false });
    const seed = { provider: 'deepseek', model: 'x' };
    // turn 1 step 1:主模型失败 → 切到 openai(名额消耗),deepseek 记入冷却
    await callListener(req, stepReq(1, 1), async () => ({ ...seed }));
    expect(
      await callListener(err, stepErr(1, 1, 'deepseek'), async () => undefined),
    ).toEqual({ kind: 'retry' });
    // turn 2 step 1:新 turn 建态清掉 turn 1 的键,但冷却表独立——
    // deepseek 仍在冷却 → 首个请求直接改写为 openai(起点改写,不算切换)
    expect(
      await callListener(req, stepReq(2, 1), async () => ({ ...seed })),
    ).toEqual({ provider: 'openai', model: 'a' });
    // openai 失败:新 turn 名额完整 → 照常切换到 anthropic
    expect(
      await callListener(err, stepErr(2, 1, 'openai'), async () => undefined),
    ).toEqual({ kind: 'retry' });
    expect(
      await callListener(req, stepReq(2, 1), async () => ({ ...seed })),
    ).toEqual({ provider: 'anthropic', model: 'b' });
  });
});

// ── 3. perTurn=true 默认回归 ─────────────────────────────────────────

describe('perTurn=true 默认行为(回归)', () => {
  it('同一 step 可连切多个候选(行为与旧版一致)', async () => {
    const { req, err } = setup({ cooldownEnabled: false });
    const seed = { provider: 'deepseek', model: 'x' };
    await callListener(req, stepReq(1, 1), async () => ({ ...seed }));
    expect(
      await callListener(err, stepErr(1, 1, 'deepseek'), async () => undefined),
    ).toEqual({ kind: 'retry' });
    expect(
      await callListener(err, stepErr(1, 1, 'openai'), async () => undefined),
    ).toEqual({ kind: 'retry' });
    expect(
      await callListener(req, stepReq(1, 1), async () => ({ ...seed })),
    ).toEqual({ provider: 'anthropic', model: 'b' });
    // 链耗尽 → 透传上游
    expect(
      await callListener(
        err,
        stepErr(1, 1, 'anthropic'),
        async () => undefined,
      ),
    ).toBeUndefined();
  });
});
