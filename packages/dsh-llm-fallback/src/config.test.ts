/**
 * dsh-llm-fallback 行为契约测试。
 *
 * 覆盖:
 * - 插件契约(name / inject / 装载日志);
 * - resolveConfig:默认值 / 链项解析 / retriesBeforeSwitch / 错误码识别(含宿主失败码
 *   对齐与旧码别名)/ maxRetries=0(链长上限);
 * - resolveCandidateRetryPlan:每候选重试预算合成(自定义档以插件为准不封顶 /
 *   自动档跟随官方预算 / always 与缺失策略的降级);
 * - state 模块:nextCandidate 推进与边界 / backoffDelayMs 退避曲线;
 * - protocol section:无 {{var}} + 命令名一致 + order;
 * - apply 路径:
 *   - disabled / 空链 → 不挂监听器;
 *   - agent/request 不改写 seed(首次);
 *   - agent/request-error 按每候选重试预算三分支:
 *     - 预算内 + 官方 retry 决策 → 透传不切换;
 *     - 预算内 + 官方无决策 → 本插件代执行同候选重试(不推进 index);
 *     - 预算耗尽 → 切换(即使上游仍想重试也覆盖);切换后候选预算清零;
 *   - 链耗尽 / 失败码不在白名单 → 透传 upstream;
 *   - 轨迹记录:切换/代重试时依次写官方 llm/retry + llm/retry-started(字段完整、
 *     retryId 同链复用);agent 缺失不崩;append 抛错不阻断回退;abort 只写
 *     scheduled;不切换时不写;
 *   - effect 卸载时 dispose 被收集。
 *
 * 风格采用 stubCtx + spyOn(console.log);用
 * `as unknown as Context` 强制把 stub 对象窄化为 cordis Context 类型,
 * 满足 `@typescript-eslint/no-explicit-any` 约束。
 */

import type { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apply, inject, name } from './index.ts';
import {
  resolveConfig,
  resolveRetriesBeforeSwitch,
  normalizeChainEntry,
  isVolatileLike,
  unwrapVolatile,
  volatileField,
  desc,
  DEFAULT_RETRYABLE_CODES,
  DEFAULT_COOLDOWN_MS,
  Config,
} from './config.ts';
import { Config as ConfigFromIndex } from './index.ts';
import {
  type FallbackState,
  type RetryPolicyLike,
  backoffDelayMs,
  isFailureRetryable,
  nextCandidate,
  resolveCandidateRetryPlan,
  stateFor,
} from './state.ts';
import {
  PROTOCOL_SECTION_NAME,
  PROTOCOL_SECTION_ORDER,
  modelFallbackSection,
} from './protocol.ts';

// ── 测试工具 ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** cordis Context 最小假体:effect 立即执行,section/on 记录。 */
function stubCtx(): {
  ctx: Context;
  sections: Array<{ name: string; order: number; text: string }>;
  listeners: Array<{ event: string; listener: unknown }>;
  cleanups: Array<() => void>;
} {
  const sections: Array<{ name: string; order: number; text: string }> = [];
  const listeners: Array<{ event: string; listener: unknown }> = [];
  const cleanups: Array<() => void> = [];
  const ctx = {
    effect(fn: () => unknown): void {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup as () => void);
    },
    systemPrompt: {
      section(s: { name: string; order: number; text: string }): () => void {
        sections.push(s);
        return () => {};
      },
    },
    on(event: string, listener: unknown): () => boolean {
      listeners.push({ event, listener });
      return () => true;
    },
  } as unknown as Context;
  return { ctx, sections, listeners, cleanups };
}

/** 构造失败 fixture(只覆盖 LlmFailure 的最小字段;status 可选)。 */
function stubFailure(
  code: string,
  message = 'fake failure',
  status?: number,
): { code: string; message: string; status?: number } {
  return status === undefined ? { code, message } : { code, message, status };
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

// ── 1. 插件契约 ─────────────────────────────────────────────────────

describe('dsh-llm-fallback plugin contract', () => {
  it('name 与 cordis id 约定一致', () => {
    expect(name).toBe('dsh-llm-fallback');
  });

  it('inject 声明 systemPrompt 依赖(register section 需 ctx.systemPrompt 就绪)', () => {
    // agent/request 与 agent/request-error 走全局 waterfall,无需注入;
    // 但 apply() 内调用 ctx.systemPrompt.section(...) 注册协议,需要让
    // cordis 等到 systemPrompt service 就绪后再调 apply,否则触发
    // "cannot get property \"systemPrompt\" without inject"。
    // (设置面板的模型目录由自带 client 经 remote.session.modelCatalog 获取,
    //  不经过宿主侧本插件,故无需注入 llm。)
    expect(inject).toEqual(['systemPrompt']);
  });

  it('apply 打印 `[dsh-llm-fallback] plugin loaded` 装载日志(e2e 契约)', () => {
    const { ctx } = stubCtx();
    apply(ctx);
    expect(console.log).toHaveBeenCalledWith(
      '[dsh-llm-fallback] plugin loaded',
    );
  });

  it('apply 注册 system-prompt section,order=2970', () => {
    const { ctx, sections } = stubCtx();
    apply(ctx, { fallbackChains: ['deepseek/deepseek-chat'] });
    expect(sections.length).toBeGreaterThan(0);
    expect(sections[0]?.name).toBe(PROTOCOL_SECTION_NAME);
    expect(sections[0]?.order).toBe(PROTOCOL_SECTION_ORDER);
    expect(sections[0]?.order).toBe(2970);
  });

  it('apply 注册 agent/request 与 agent/request-error 两个 listener', () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['deepseek/deepseek-chat', 'openai/gpt-4o'],
    });
    const events = listeners.map((l) => l.event);
    expect(events).toContain('agent/request');
    expect(events).toContain('agent/request-error');
  });

  it('apply 在 disabled 或空链时不挂监听器(但仍注册 section)', () => {
    {
      const { ctx, listeners, sections } = stubCtx();
      apply(ctx, {
        enabled: false,
        fallbackChains: ['deepseek/deepseek-chat'],
      });
      expect(listeners).toHaveLength(0);
      expect(sections.length).toBeGreaterThan(0); // section 仍注册
    }
    {
      const { ctx, listeners } = stubCtx();
      apply(ctx, { fallbackChains: [] });
      expect(listeners).toHaveLength(0);
    }
  });

  it('apply 在非法配置时不抛(只 console.error + 不挂监听器)', () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, { fallbackChains: ['bogus-no-slash'] });
    expect(console.error).toHaveBeenCalled();
    expect(listeners).toHaveLength(0);
  });

  it('apply 无第二参数(undefined 配置)不抛,仍注册 section,不挂 listener', () => {
    // 全新 profile + 用户尚未填任何配置 = loader 传 undefined;应走全 default 路径
    // (enabled=true, chain=[]) 而非 console.error 路径——index.ts:101 的契约。
    const { ctx, listeners, sections } = stubCtx();
    expect(() => apply(ctx)).not.toThrow();
    // section 仍注册(协议说明)
    expect(sections.length).toBeGreaterThan(0);
    expect(sections[0]?.name).toBe(PROTOCOL_SECTION_NAME);
    // 空 chain → 短路,不挂监听器
    expect(listeners).toHaveLength(0);
  });

  it('effect 卸载时 dispose 被收集', () => {
    const { ctx, cleanups } = stubCtx();
    apply(ctx, {
      fallbackChains: ['deepseek/deepseek-chat', 'openai/gpt-4o'],
    });
    // 至少 3 个 cleanup:section + agent/request + agent/request-error
    expect(cleanups.length).toBeGreaterThanOrEqual(3);
  });
});

// ── 2. resolveConfig ────────────────────────────────────────────────

describe('resolveConfig', () => {
  it('默认值:enabled=true / chain=[] / retriesBeforeSwitch=0(自动跟随官方预算) / maxRetries=1 / 默认失败码', () => {
    const c = resolveConfig({});
    expect(c.enabled).toBe(true);
    expect(c.chain).toEqual([]);
    expect(c.retriesBeforeSwitch).toBe(0);
    expect(c.maxRetries).toBe(1); // 链空时 maxRetries 强制 ≥1
    expect(c.retryableCodes).toEqual(new Set(DEFAULT_RETRYABLE_CODES));
    expect(c.baseDelayMs).toBe(500);
    expect(c.maxDelayMs).toBe(30000);
    expect(c.perTurn).toBe(true);
  });

  it('perTurn=false 解析为单次切换档;仅字面 false 生效,其余形态宽容为 true(默认)', () => {
    expect(resolveConfig({ perTurn: false }).perTurn).toBe(false);
    expect(resolveConfig({ perTurn: true }).perTurn).toBe(true);
    expect(resolveConfig({}).perTurn).toBe(true);
    // 宽容解析(与 !== false 守卫一致):字符串 'false' / 数字 0 均不生效
    expect(resolveConfig({ perTurn: 'false' }).perTurn).toBe(true);
    expect(resolveConfig({ perTurn: 0 }).perTurn).toBe(true);
  });

  it('undefined / null 输入视为空对象,默认值与 resolveConfig({}) 一致', () => {
    // 回归:loader 在全新 profile / 用户未填任何配置时传入 undefined,
    // 不应让 raw.enabled 在 config.ts:103 处抛 TypeError。
    const cEmpty = resolveConfig({});
    const cUndef = resolveConfig(undefined);
    const cNull = resolveConfig(null);
    expect(cUndef).toEqual(cEmpty);
    expect(cNull).toEqual(cEmpty);
    expect(cUndef.enabled).toBe(true);
    expect(cUndef.chain).toEqual([]);
    expect(cUndef.retriesBeforeSwitch).toBe(0);
    expect(cUndef.maxRetries).toBe(1);
  });

  it('链项解析为 {provider, model}', () => {
    const c = resolveConfig({
      fallbackChains: ['deepseek/deepseek-chat', 'openai/gpt-4o'],
    });
    expect(c.chain).toEqual([
      { provider: 'deepseek', model: 'deepseek-chat' },
      { provider: 'openai', model: 'gpt-4o' },
    ]);
    expect(c.maxRetries).toBe(2); // 链长=2,maxRetries=0 默认 → 取链长
  });

  it('非法链项抛错', () => {
    expect(() => resolveConfig({ fallbackChains: ['bogus-no-slash'] })).toThrow(
      /not in "provider\/model"/,
    );
    expect(() =>
      resolveConfig({ fallbackChains: ['/missing-provider'] }),
    ).toThrow(/not in "provider\/model"/);
    expect(() => resolveConfig({ fallbackChains: ['missing-model/'] })).toThrow(
      /not in "provider\/model"/,
    );
  });

  it('retriesBeforeSwitch:正整数生效;0/负数/非有限数/字符串数字回落 0(自动档)', () => {
    expect(resolveConfig({ retriesBeforeSwitch: 2 }).retriesBeforeSwitch).toBe(
      2,
    );
    expect(resolveConfig({ retriesBeforeSwitch: 0 }).retriesBeforeSwitch).toBe(
      0,
    );
    expect(resolveConfig({ retriesBeforeSwitch: -1 }).retriesBeforeSwitch).toBe(
      0,
    );
    expect(
      resolveConfig({ retriesBeforeSwitch: Number.NaN }).retriesBeforeSwitch,
    ).toBe(0);
    expect(
      resolveConfig({ retriesBeforeSwitch: Number.POSITIVE_INFINITY })
        .retriesBeforeSwitch,
    ).toBe(0);
    expect(
      resolveConfig({ retriesBeforeSwitch: 2.9 }).retriesBeforeSwitch,
    ).toBe(2); // 向下取整
    expect(
      resolveConfig({ retriesBeforeSwitch: '3' }).retriesBeforeSwitch,
    ).toBe(3); // Number('3') = 3:宽容数字字符串
    expect(
      resolveConfig({ retriesBeforeSwitch: 'bogus' }).retriesBeforeSwitch,
    ).toBe(0); // Number('bogus') = NaN → 回落
  });

  it('resolveRetriesBeforeSwitch 独立导出行为一致(undefined 视为 0)', () => {
    expect(resolveRetriesBeforeSwitch(undefined)).toBe(0);
    expect(resolveRetriesBeforeSwitch(null)).toBe(0);
    expect(resolveRetriesBeforeSwitch(5)).toBe(5);
    expect(resolveRetriesBeforeSwitch(-2)).toBe(0);
  });

  it('冷却配置:cooldownEnabled 默认 true;cooldownMs 默认 300000,负数/非有限回落默认,0 合法(立即过期)', () => {
    const d = resolveConfig({});
    expect(d.cooldownEnabled).toBe(true);
    expect(d.cooldownMs).toBe(DEFAULT_COOLDOWN_MS);
    expect(d.cooldownMs).toBe(300_000);
    expect(resolveConfig({ cooldownEnabled: false }).cooldownEnabled).toBe(
      false,
    );
    expect(resolveConfig({ cooldownMs: 1000 }).cooldownMs).toBe(1000);
    expect(resolveConfig({ cooldownMs: 0 }).cooldownMs).toBe(0);
    expect(resolveConfig({ cooldownMs: 2.9 }).cooldownMs).toBe(2); // 向下取整
    expect(resolveConfig({ cooldownMs: '1500' }).cooldownMs).toBe(1500);
    expect(resolveConfig({ cooldownMs: -5 }).cooldownMs).toBe(
      DEFAULT_COOLDOWN_MS,
    );
    expect(resolveConfig({ cooldownMs: Number.NaN }).cooldownMs).toBe(
      DEFAULT_COOLDOWN_MS,
    );
    expect(
      resolveConfig({ cooldownMs: Number.POSITIVE_INFINITY }).cooldownMs,
    ).toBe(DEFAULT_COOLDOWN_MS);
  });

  // ── 0.2.x → 0.3.0 schema 迁移(向后兼容) ─────────────────────────

  it('旧 string[] 输入("provider/model")自动归一为 object entries', () => {
    // 0.2.x 形态的旧配置不应破坏;displayName 回填 "provider/model",description 空。
    const c = resolveConfig({
      fallbackChains: ['deepseek/deepseek-chat', 'openai/gpt-4o'],
    });
    expect(c.entries).toEqual([
      {
        provider: 'deepseek',
        model: 'deepseek-chat',
        displayName: 'deepseek/deepseek-chat',
        description: '',
      },
      {
        provider: 'openai',
        model: 'gpt-4o',
        displayName: 'openai/gpt-4o',
        description: '',
      },
    ]);
    // chain 字段保持旧的 (provider, model) 形态(下游 state.ts / 监听器不变)
    expect(c.chain).toEqual([
      { provider: 'deepseek', model: 'deepseek-chat' },
      { provider: 'openai', model: 'gpt-4o' },
    ]);
  });

  it('新 object[] 输入保留 displayName / description(显式给值)', () => {
    const c = resolveConfig({
      fallbackChains: [
        {
          provider: 'deepseek',
          model: 'deepseek-chat',
          displayName: 'DeepSeek Chat (primary)',
          description: 'cheapest default',
        },
      ],
    });
    expect(c.entries[0]).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
      displayName: 'DeepSeek Chat (primary)',
      description: 'cheapest default',
    });
  });

  it('混形态输入(部分 string、部分 object)逐项归一', () => {
    const c = resolveConfig({
      fallbackChains: [
        'deepseek/deepseek-chat',
        {
          provider: 'openai',
          model: 'gpt-4o',
          displayName: 'GPT-4o',
        },
        'anthropic/claude-sonnet-4',
      ],
    });
    expect(c.entries.map((e) => e.displayName)).toEqual([
      'deepseek/deepseek-chat', // string → 回填 "provider/model"
      'GPT-4o', // object → 显式保留
      'anthropic/claude-sonnet-4',
    ]);
    expect(c.chain).toHaveLength(3);
  });

  it('object 形态缺省 displayName / description 时回填', () => {
    const c = resolveConfig({
      fallbackChains: [{ provider: 'openai', model: 'gpt-4o' }],
    });
    expect(c.entries[0]).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      displayName: 'openai/gpt-4o',
      description: '',
    });
  });

  it('非法形态(null / number / object 缺字段)抛错', () => {
    expect(() =>
      resolveConfig({ fallbackChains: [null as unknown as string] }),
    ).toThrow(/must be a string or object/);
    expect(() =>
      resolveConfig({
        fallbackChains: [42 as unknown as string],
      }),
    ).toThrow(/must be a string or object/);
    expect(() =>
      resolveConfig({
        fallbackChains: [{ provider: 'openai' } as unknown as string],
      }),
    ).toThrow(/non-empty "provider" and "model"/);
    expect(() =>
      resolveConfig({
        fallbackChains: [
          { provider: 'openai', model: '' } as unknown as string,
        ],
      }),
    ).toThrow(/non-empty "provider" and "model"/);
  });

  it('normalizeChainEntry 独立导出对单条归一', () => {
    expect(normalizeChainEntry('a/x', 0)).toEqual({
      provider: 'a',
      model: 'x',
      displayName: 'a/x',
      description: '',
    });
    expect(normalizeChainEntry({ provider: 'b', model: 'y' }, 0)).toEqual({
      provider: 'b',
      model: 'y',
      displayName: 'b/y',
      description: '',
    });
    expect(
      'error' in normalizeChainEntry({ provider: '', model: 'x' }, 0),
    ).toBe(true);
  });

  it('maxRetries=0 时退化为链长', () => {
    const c = resolveConfig({
      fallbackChains: ['a/x', 'b/y', 'c/z'],
      maxRetries: 0,
    });
    expect(c.maxRetries).toBe(3);
  });

  it('maxRetries 显式 > 链长时仍按原值', () => {
    const c = resolveConfig({
      fallbackChains: ['a/x'],
      maxRetries: 5,
    });
    expect(c.maxRetries).toBe(5);
  });

  it('retryableCodes 自定义白名单', () => {
    const c = resolveConfig({
      fallbackChains: ['a/x'],
      retryableCodes: ['RATE_LIMIT', 'CUSTOM_CODE'],
    });
    expect(c.retryableCodes).toEqual(new Set(['RATE_LIMIT', 'CUSTOM_CODE']));
  });

  it('默认白名单对齐宿主失败码:含 SERVER / TRANSPORT,不含 omp 系旧码', () => {
    // 回归:0.3.1 及之前默认含 omp 系码 NETWORK / SERVER_ERROR——宿主两套
    // 适配器(deepseek / pi-ai)均不产出这两个码,导致 "Connection error."
    // (宿主归类为 TRANSPORT)与 5xx(SERVER)不触发切换。
    const c = resolveConfig({});
    // 宿主实际产出且官方 dsh-llm-retry 默认重试的码
    expect(c.retryableCodes.has('SERVER')).toBe(true);
    expect(c.retryableCodes.has('TRANSPORT')).toBe(true);
    expect(c.retryableCodes.has('RATE_LIMIT')).toBe(true);
    expect(c.retryableCodes.has('TIMEOUT')).toBe(true);
    expect(c.retryableCodes.has('EMPTY_RESPONSE')).toBe(true);
    // 本插件有意超集:配额 / 上下文类(切模型是这些失败的本职出路)
    expect(c.retryableCodes.has('QUOTA')).toBe(true);
    expect(c.retryableCodes.has('ACCOUNT_QUOTA')).toBe(true);
    expect(c.retryableCodes.has('CONTEXT_WINDOW_EXCEEDED')).toBe(true);
    // 本插件有意超集:reasoning effort 不被当前模型支持(请求构建期确定性
    // 失败,同 provider 重试必复现)——切下一候选是唯一有意义的恢复路径
    expect(c.retryableCodes.has('UNSUPPORTED_REASONING_EFFORT')).toBe(true);
    // 旧错码不应再出现在默认白名单
    expect(c.retryableCodes.has('NETWORK')).toBe(false);
    expect(c.retryableCodes.has('SERVER_ERROR')).toBe(false);
    // 防过切:换模型也无解的失败码保持白名单外
    expect(c.retryableCodes.has('AUTH')).toBe(false);
    expect(c.retryableCodes.has('INVALID_REQUEST')).toBe(false);
    expect(c.retryableCodes.has('INVALID_CREDENTIAL')).toBe(false);
  });

  it('旧码别名:自定义白名单含 NETWORK / SERVER_ERROR 时并集补入 TRANSPORT / SERVER', () => {
    // 存量配置兼容:升级前保存过的自定义白名单里可能是旧码,
    // resolveConfig 按并集补入宿主实际码,旧码保留无害(宿主不产出)。
    const c = resolveConfig({
      fallbackChains: ['a/x'],
      retryableCodes: ['RATE_LIMIT', 'NETWORK', 'SERVER_ERROR'],
    });
    expect(c.retryableCodes).toEqual(
      new Set(['RATE_LIMIT', 'NETWORK', 'SERVER_ERROR', 'TRANSPORT', 'SERVER']),
    );
  });

  it('新码自定义白名单原样保留,不做别名变换', () => {
    const c = resolveConfig({
      fallbackChains: ['a/x'],
      retryableCodes: ['TRANSPORT', 'SERVER'],
    });
    expect(c.retryableCodes).toEqual(new Set(['TRANSPORT', 'SERVER']));
  });
});

// ── 2b. 每候选重试预算合成(resolveCandidateRetryPlan)──────────────

describe('resolveCandidateRetryPlan', () => {
  const normal = (maxRetries: number): RetryPolicyLike => ({
    mode: 'normal',
    maxRetries,
  });
  const always: RetryPolicyLike = { mode: 'always' };

  it('自动档(0)+ normal 策略 → 预算 = policy.maxRetries(与旧 afterRetry 等价)', () => {
    expect(resolveCandidateRetryPlan(0, normal(5))).toEqual({
      maxRetries: 5,
      selfRetry: true,
    });
    expect(resolveCandidateRetryPlan(0, normal(0))).toEqual({
      maxRetries: 0,
      selfRetry: true,
    });
  });

  it('自动档(0)+ policy 缺失 → 预算 0(首失败即切,等价旧 afterRetry 未装官方插件)', () => {
    expect(resolveCandidateRetryPlan(0, undefined)).toEqual({
      maxRetries: 0,
      selfRetry: true,
    });
  });

  it('自动档(0)+ always 策略 → 无上限且不代执行(整体透传官方无限重试)', () => {
    expect(resolveCandidateRetryPlan(0, always)).toEqual({
      maxRetries: Number.POSITIVE_INFINITY,
      selfRetry: false,
    });
  });

  it('自定义档:N 为准,超过官方预算也不封顶(超出部分由插件代执行)', () => {
    // 核心需求(验收反馈):插件的重试次数非 0 时以插件配置为准;=0 才跟随 provider。
    expect(resolveCandidateRetryPlan(2, normal(5))).toEqual({
      maxRetries: 2,
      selfRetry: true,
    });
    expect(resolveCandidateRetryPlan(8, normal(5))).toEqual({
      maxRetries: 8,
      selfRetry: true,
    });
    expect(resolveCandidateRetryPlan(5, normal(5))).toEqual({
      maxRetries: 5,
      selfRetry: true,
    });
  });

  it('自定义档 + policy 缺失/always(无预算可比)→ 按自定义值执行', () => {
    expect(resolveCandidateRetryPlan(3, undefined)).toEqual({
      maxRetries: 3,
      selfRetry: true,
    });
    expect(resolveCandidateRetryPlan(3, always)).toEqual({
      maxRetries: 3,
      selfRetry: true,
    });
  });

  it('防御:policy 形态异常(mode 未知 / maxRetries 非法)视同缺失或降级', () => {
    expect(
      resolveCandidateRetryPlan(0, { mode: 'bogus', maxRetries: 5 }),
    ).toEqual(resolveCandidateRetryPlan(0, always));
    expect(
      resolveCandidateRetryPlan(2, { mode: 'normal', maxRetries: 'bogus' }),
    ).toEqual({ maxRetries: 2, selfRetry: true });
    expect(
      resolveCandidateRetryPlan(0, { mode: 'normal', maxRetries: -1 }),
    ).toEqual({ maxRetries: 0, selfRetry: true });
    expect(
      resolveCandidateRetryPlan(2, { mode: 'normal', maxRetries: 2.9 }),
    ).toEqual({ maxRetries: 2, selfRetry: true });
  });

  it('configured 非法(负数/NaN/非有限)视同 0 → 自动档', () => {
    expect(resolveCandidateRetryPlan(-1, normal(5))).toEqual(
      resolveCandidateRetryPlan(0, normal(5)),
    );
    expect(resolveCandidateRetryPlan(Number.NaN, undefined)).toEqual({
      maxRetries: 0,
      selfRetry: true,
    });
  });
});

// ── 3. state 模块 ────────────────────────────────────────────────────

describe('nextCandidate', () => {
  /** 未切换态(index=-1:仍在会话指定模型上)。 */
  function init(
    chain: ReadonlyArray<{ provider: string; model: string }>,
    pageModel?: { provider: string; model: string },
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

  it('未切换态(index=-1)推进到 index=0:会话模型失败后切到队列第 1 项', () => {
    const s = init(
      [
        { provider: 'a', model: 'x' },
        { provider: 'b', model: 'y' },
      ],
      { provider: 'deepseek', model: 'deepseek-chat' },
    );
    expect(nextCandidate(s, 10)).toEqual({ index: 0, retries: 1 });
  });

  it('单项队列也有一次切换机会(会话模型失败 → 切到唯一候选)', () => {
    // 旧语义(首项=主模型)下单项链无备选、失败即透传;新语义下队列
    // 是纯回退候选,会话模型失败后切到它就是有意义的重试。
    const s = init([{ provider: 'a', model: 'x' }], {
      provider: 'deepseek',
      model: 'deepseek-chat',
    });
    expect(nextCandidate(s, 10)).toEqual({ index: 0, retries: 1 });
    // 已在唯一候选上再失败 → 耗尽
    s.index = 0;
    expect(nextCandidate(s, 10)).toBeNull();
  });

  it('沿队列逐项推进:-1 → 0 → 1', () => {
    const s = init(
      [
        { provider: 'a', model: 'x' },
        { provider: 'b', model: 'y' },
      ],
      { provider: 'deepseek', model: 'deepseek-chat' },
    );
    const first = nextCandidate(s, 10);
    expect(first).toEqual({ index: 0, retries: 1 });
    s.index = first!.index;
    s.retries = first!.retries;
    expect(nextCandidate(s, 10)).toEqual({ index: 1, retries: 2 });
  });

  it('跳过与会话指定模型(pageModel)相同的候选(永不切回刚失败的模型)', () => {
    // 旧"首项=主模型"配置的兼容路径:队列里也勾了会话模型时,推进时跳过之。
    const s = init(
      [
        { provider: 'deepseek', model: 'x' },
        { provider: 'openai', model: 'y' },
        { provider: 'deepseek', model: 'x' },
        { provider: 'anthropic', model: 'z' },
      ],
      { provider: 'deepseek', model: 'x' },
    );
    // 从 -1 出发:chain[0] 是 pageModel → 跳过,落到 chain[1]
    expect(nextCandidate(s, 10)).toEqual({ index: 1, retries: 1 });
    s.index = 1;
    s.retries = 1;
    // 从 1 出发:chain[2] 也是 pageModel → 跳过,落到 chain[3]
    expect(nextCandidate(s, 10)).toEqual({ index: 3, retries: 2 });
  });

  it('全部候选都等于 pageModel → null(耗尽)', () => {
    const s = init([{ provider: 'a', model: 'x' }], {
      provider: 'a',
      model: 'x',
    });
    expect(nextCandidate(s, 10)).toBeNull();
  });

  it('pageModel 缺省(极端时序 error 先于 request)→ 不跳过,优雅降级', () => {
    const s = init([{ provider: 'a', model: 'x' }]);
    expect(nextCandidate(s, 10)).toEqual({ index: 0, retries: 1 });
  });

  it('最后一项之后返回 null(队列耗尽)', () => {
    const s = init(
      [
        { provider: 'a', model: 'x' },
        { provider: 'b', model: 'y' },
      ],
      { provider: 'deepseek', model: 'deepseek-chat' },
    );
    s.index = 1;
    expect(nextCandidate(s, 10)).toBeNull();
  });

  it('retries 达 maxRetries 上限返回 null', () => {
    const s = init(
      [
        { provider: 'a', model: 'x' },
        { provider: 'b', model: 'y' },
        { provider: 'c', model: 'z' },
      ],
      { provider: 'deepseek', model: 'deepseek-chat' },
    );
    s.retries = 2;
    expect(nextCandidate(s, 2)).toBeNull();
  });

  it('exhausted=true 时直接 null', () => {
    const s = init(
      [
        { provider: 'a', model: 'x' },
        { provider: 'b', model: 'y' },
      ],
      { provider: 'deepseek', model: 'deepseek-chat' },
    );
    s.exhausted = true;
    expect(nextCandidate(s, 10)).toBeNull();
  });
});

describe('backoffDelayMs', () => {
  it('random=0.5 时无抖动,呈指数倍增', () => {
    // jitterRatio * (2*0.5 - 1) = 0 → 无 jitter
    expect(backoffDelayMs(0, 500, 30000, () => 0.5)).toBe(500);
    expect(backoffDelayMs(1, 500, 30000, () => 0.5)).toBe(1000);
    expect(backoffDelayMs(2, 500, 30000, () => 0.5)).toBe(2000);
    expect(backoffDelayMs(3, 500, 30000, () => 0.5)).toBe(4000);
  });

  it('达到 maxDelayMs 时封顶', () => {
    // 2^10 = 1024,500 * 1024 = 512000 → 封到 30000
    expect(backoffDelayMs(10, 500, 30000, () => 0.5)).toBe(30000);
  });

  it('jitter=0 时取下限', () => {
    expect(backoffDelayMs(0, 500, 30000, () => 0)).toBe(450); // -10%
  });

  it('jitter=1 时取上限', () => {
    expect(backoffDelayMs(0, 500, 30000, () => 1)).toBe(550); // +10%
  });

  it('负数 attempt 视作 0', () => {
    expect(backoffDelayMs(-1, 500, 30000, () => 0.5)).toBe(500);
  });
});

describe('isFailureRetryable', () => {
  it('在白名单内 → true', () => {
    expect(
      isFailureRetryable(
        stubFailure('RATE_LIMIT'),
        new Set(['RATE_LIMIT', 'QUOTA']),
      ),
    ).toBe(true);
  });

  it('不在白名单 → false', () => {
    expect(
      isFailureRetryable(
        stubFailure('INVALID_CREDENTIAL'),
        new Set(['RATE_LIMIT']),
      ),
    ).toBe(false);
  });

  it('默认码表命中 UNSUPPORTED_REASONING_EFFORT(真实失败消息)', () => {
    // 回归:宿主 pi-ai / deepseek 适配器对不支持 reasoning effort 的模型
    // 抛此码(请求构建期、网络 I/O 之前),须按默认白名单切换候选。
    expect(
      isFailureRetryable(
        stubFailure(
          'UNSUPPORTED_REASONING_EFFORT',
          'provider "e2e-broken" model "broken-model" does not support reasoning effort "high"',
        ),
        new Set(DEFAULT_RETRYABLE_CODES),
      ),
    ).toBe(true);
  });

  it('默认码表命中 UNKNOWN_MODEL(失效候选:模型被删除/id 变更)', () => {
    // 回归:pi-ai 适配器对配置中不存在的模型在请求构建期抛此码
    // (`pi-ai provider "X" has no configured model "Y"`)——用户在 dsh 侧
    // 删除模型或改其 id 后,队列残留的失效候选必然命中。默认白名单不含
    // 它时链推进透传上游,整链在失效候选上中断。
    expect(
      isFailureRetryable(
        stubFailure(
          'UNKNOWN_MODEL',
          'pi-ai provider "my-gw" has no configured model "old-model"',
        ),
        new Set(DEFAULT_RETRYABLE_CODES),
      ),
    ).toBe(true);
  });

  it('status=408 + code=INVALID_REQUEST → 可切换(网关透传 invalid_request_error type 的 408)', () => {
    // 用户实测 antirion-gateway 场景:OpenAI 兼容网关返回 408,响应体
    // {"code":"request_timeout","type":"invalid_request_error"}。deepseek
    // 路由 providerError 命中 type 分支 → INVALID_REQUEST(白名单外),
    // 但 failure 带 status=408——HTTP 408 语义是请求超时(临时性失败),
    // 按 isFailureRetryable 的结构化 status 判定放行,绝不解析 message。
    expect(
      isFailureRetryable(
        stubFailure(
          'INVALID_REQUEST',
          'gateway answered 408 with invalid_request_error',
          408,
        ),
        new Set(DEFAULT_RETRYABLE_CODES),
      ),
    ).toBe(true);
    // 自定义白名单(未列 HTTP_408、未列 INVALID_REQUEST)同样放行:
    // status 判定先于白名单,存量自定义白名单零迁移即获得此行为。
    expect(
      isFailureRetryable(
        stubFailure('INVALID_REQUEST', 'gateway 408', 408),
        new Set(['RATE_LIMIT']),
      ),
    ).toBe(true);
  });

  it('status=408 + code=HTTP_408 → 可切换(双通道:status 判定与默认白名单均命中)', () => {
    // deepseek 路由 408 且响应体无已知 type → HTTP_408 + status=408。
    expect(
      isFailureRetryable(
        stubFailure('HTTP_408', 'DeepSeek Messages request failed (408)', 408),
        new Set(DEFAULT_RETRYABLE_CODES),
      ),
    ).toBe(true);
  });

  it('无 status 的 INVALID_REQUEST → 不可切换(pi-ai 路由退化形态,零回归)', () => {
    // pi-ai 路由 classifyPiAiError 纯文本分类、不产出 status 字段——网关
    // 408 在那条路上退化为无 status 的 INVALID_REQUEST/PI_AI_ERROR。
    // 该形态不可判超时(408 与真 400 构造错误无法区分),保持白名单外
    // 原样透传——这是默认行为零回归的关键断言。
    expect(
      isFailureRetryable(
        stubFailure(
          'INVALID_REQUEST',
          'gateway answered 408 with invalid_request_error',
        ),
        new Set(DEFAULT_RETRYABLE_CODES),
      ),
    ).toBe(false);
    expect(
      isFailureRetryable(
        stubFailure('PI_AI_ERROR', 'pi-ai stream error'),
        new Set(DEFAULT_RETRYABLE_CODES),
      ),
    ).toBe(false);
  });

  it('HTTP_408 已入默认白名单(存量子集断言)', () => {
    expect(DEFAULT_RETRYABLE_CODES).toContain('HTTP_408');
  });

  it('status 非 408 时行为不变(400 构造错误 / 500 服务器错误按 code 路由)', () => {
    // status 结构化判定只对 408 生效:真 400 构造错误(status=400)依旧
    // 白名单外不切换;HTTP_502 不在默认白名单,依旧透传——零回归。
    expect(
      isFailureRetryable(
        stubFailure('INVALID_REQUEST', 'bad parameter', 400),
        new Set(DEFAULT_RETRYABLE_CODES),
      ),
    ).toBe(false);
    expect(
      isFailureRetryable(
        stubFailure('HTTP_502', 'bad gateway', 502),
        new Set(DEFAULT_RETRYABLE_CODES),
      ),
    ).toBe(false);
  });
});

describe('stateFor', () => {
  it('首次创建并惰性初始化(index=-1:尚未切换,在会话指定模型上)', () => {
    const map = new Map<string, FallbackState>();
    const s = stateFor(map, '1:1', [{ provider: 'a', model: 'x' }]);
    expect(s.index).toBe(-1);
    expect(s.retries).toBe(0);
    expect(s.exhausted).toBe(false);
    expect(s.candidateFailures).toBe(0);
    expect(s.pageModel).toBeUndefined();
    expect(s.chain).toEqual([{ provider: 'a', model: 'x' }]);
  });

  it('已有则返回同一引用(不重置 index/retries)', () => {
    const map = new Map<string, FallbackState>();
    const first = stateFor(map, '1:1', [{ provider: 'a', model: 'x' }]);
    first.index = 1;
    first.retries = 1;
    const second = stateFor(map, '1:1', []);
    expect(second).toBe(first);
    expect(second.index).toBe(1);
  });
});

// ── 4. protocol section ────────────────────────────────────────────

describe('modelFallbackSection', () => {
  it('name 与 order 与常量一致', () => {
    const s = modelFallbackSection();
    expect(s.name).toBe(PROTOCOL_SECTION_NAME);
    expect(s.order).toBe(PROTOCOL_SECTION_ORDER);
    expect(s.order).toBe(2970);
  });

  it('文本不含 {{var}} 占位符(dsh rc.2 renderPrompt 严格校验)', () => {
    const s = modelFallbackSection();
    expect(s.text).not.toMatch(/\{\{[a-zA-Z]/);
  });

  it('文本提到关键失败码 RATE_LIMIT / QUOTA / CONTEXT_WINDOW_EXCEEDED', () => {
    const s = modelFallbackSection();
    expect(s.text).toContain('RATE_LIMIT');
    expect(s.text).toContain('QUOTA');
    expect(s.text).toContain('CONTEXT_WINDOW_EXCEEDED');
    expect(s.text).toContain('UNSUPPORTED_REASONING_EFFORT');
  });

  it('文本说明每候选重试次数语义(默认跟随官方 dsh-llm-retry 预算)', () => {
    const s = modelFallbackSection();
    expect(s.text).toContain('dsh-llm-retry');
    expect(s.text).toContain('retriesBeforeSwitch');
    expect(s.text).toContain('budget');
  });
});

// ── 5. agent/request 与 agent/request-error 行为 ─────────────────────

describe('agent/request listener', () => {
  it('首次请求(尚未切换)不动 seedConfig', async () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['deepseek/deepseek-chat', 'openai/gpt-4o'],
    });
    const listener = findListener(listeners, 'agent/request');
    const seed = {
      provider: 'deepseek',
      model: 'deepseek-chat',
      maxTokens: 100,
    };
    const result = await callListener(
      listener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => seed,
    );
    expect(result).toEqual(seed);
  });

  it('失败切换后(state.index=0)改写 seedConfig 为链上候选', async () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['openai/gpt-4o', 'anthropic/claude-sonnet-4'],
    });
    const listener = findListener(listeners, 'agent/request');
    const errListener = findListener(listeners, 'agent/request-error');
    // 真实流程:先 request(捕获会话指定模型 pageModel = deepseek/deepseek-chat)
    await callListener(
      listener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    // 会话模型失败 → 切到队列第 1 项 openai/gpt-4o
    await callListener(
      errListener,
      {
        turn: 1,
        step: 1,
        provider: 'deepseek',
        failure: stubFailure('RATE_LIMIT'),
        signal: new AbortController().signal,
      },
      async () => undefined,
    );
    // loop 重进 request:seed 仍是 deepseek → 改写为 openai/gpt-4o
    const result = await callListener(
      listener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    expect(result).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('seed 已被外部 listener 改成期望值时不动(seed === expected)', async () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['openai/gpt-4o', 'anthropic/claude-sonnet-4'],
    });
    const listener = findListener(listeners, 'agent/request');
    const errListener = findListener(listeners, 'agent/request-error');
    await callListener(
      listener,
      { turn: 1, step: 2, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    await callListener(
      errListener,
      {
        turn: 1,
        step: 2,
        provider: 'deepseek',
        failure: stubFailure('RATE_LIMIT'),
        signal: new AbortController().signal,
      },
      async () => undefined,
    );
    // seed 已经是 openai/gpt-4o(由别的 listener 改了)→ 不应再次改写
    const seed = { provider: 'openai', model: 'gpt-4o' };
    const result = await callListener(
      listener,
      { turn: 1, step: 2, signal: new AbortController().signal },
      async () => seed,
    );
    expect(result).toEqual(seed);
  });
});

describe('agent/request-error listener', () => {
  it('会话模型失败 + upstream 无决策 → 切到队列第 1 项并返回 {kind: "retry"}', async () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['openai/gpt-4o', 'anthropic/claude-sonnet-4'],
      maxRetries: 2,
      baseDelayMs: 100,
      maxDelayMs: 500,
    });
    const reqListener = findListener(listeners, 'agent/request');
    const errListener = findListener(listeners, 'agent/request-error');
    // 真实流程:先 request(捕获 pageModel = deepseek/deepseek-chat)
    await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    const result = await callListener(
      errListener,
      {
        turn: 1,
        step: 1,
        provider: 'deepseek',
        failure: stubFailure('RATE_LIMIT'),
        signal: new AbortController().signal,
      },
      async () => undefined,
    );
    expect(result).toEqual({ kind: 'retry' });
    // 切换目标 = 队列第 1 项(而非旧语义的"跳过首项")
    const nextSeed = await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    expect(nextSeed).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('队列里也勾了会话模型 → 推进时跳过它(兼容旧"首项=主模型"配置)', async () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['deepseek/deepseek-chat', 'openai/gpt-4o'],
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    const reqListener = findListener(listeners, 'agent/request');
    const errListener = findListener(listeners, 'agent/request-error');
    await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    await callListener(
      errListener,
      {
        turn: 1,
        step: 1,
        provider: 'deepseek',
        failure: stubFailure('RATE_LIMIT'),
        signal: new AbortController().signal,
      },
      async () => undefined,
    );
    // chain[0] === 会话模型被跳过,直接切到 chain[1]
    const nextSeed = await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    expect(nextSeed).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('单项队列(候选 ≠ 会话模型)→ 会话模型失败切到唯一候选', async () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, { fallbackChains: ['openai/gpt-4o'] });
    const reqListener = findListener(listeners, 'agent/request');
    const errListener = findListener(listeners, 'agent/request-error');
    await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    const result = await callListener(
      errListener,
      {
        turn: 1,
        step: 1,
        provider: 'deepseek',
        failure: stubFailure('RATE_LIMIT'),
        signal: new AbortController().signal,
      },
      async () => undefined,
    );
    expect(result).toEqual({ kind: 'retry' });
    const nextSeed = await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    expect(nextSeed).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('预算内 + upstream={retry}(官方 retry 预算内)→ 透传 upstream,不切换', async () => {
    // provider retryPolicy normal(1):预算 1 次重试。第 1 次失败透传官方
    // retry 决策(它执行同 provider 重试),第 2 次失败预算耗尽 → 覆盖切换。
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['openai/gpt-4o', 'anthropic/claude-sonnet-4'],
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    const reqListener = findListener(listeners, 'agent/request');
    const errListener = findListener(listeners, 'agent/request-error');
    await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    const upstreamRetry = { kind: 'retry' as const };
    const policy = { mode: 'normal', maxRetries: 1 };
    const passThrough = await callListener(
      errListener,
      {
        turn: 1,
        step: 1,
        provider: 'deepseek',
        failure: stubFailure('RATE_LIMIT'),
        retryPolicy: policy,
        signal: new AbortController().signal,
      },
      async () => upstreamRetry,
    );
    // 预算内:决策权交还官方 dsh-llm-retry(同 provider 内重试)
    expect(passThrough).toBe(upstreamRetry);

    // 状态未推进:下一个请求进来,seed 仍不被改写
    const seedStillPage = await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    expect(seedStillPage).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
    });

    // 第 2 次失败:候选内已重试 1 次 = 预算 → 即使上游仍想重试也覆盖切换
    const switched = await callListener(
      errListener,
      {
        turn: 1,
        step: 1,
        provider: 'deepseek',
        failure: stubFailure('RATE_LIMIT'),
        retryPolicy: policy,
        signal: new AbortController().signal,
      },
      async () => upstreamRetry,
    );
    expect(switched).toEqual({ kind: 'retry' });
    const nextSeed = await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    expect(nextSeed).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('自定义 retriesBeforeSwitch 小于官方预算 → 重试 N 次后覆盖官方决策提前切换', async () => {
    // 核心需求:自定义次数 N=2,官方预算 5——前 2 次失败透传官方 retry,
    // 第 3 次失败时 N 已用满,即使官方仍在预算内也切下一候选。
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['openai/gpt-4o', 'anthropic/claude-sonnet-4'],
      retriesBeforeSwitch: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    const reqListener = findListener(listeners, 'agent/request');
    const errListener = findListener(listeners, 'agent/request-error');
    await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    const upstreamRetry = { kind: 'retry' as const };
    const payload = {
      turn: 1,
      step: 1,
      provider: 'deepseek',
      failure: stubFailure('RATE_LIMIT'),
      retryPolicy: { mode: 'normal', maxRetries: 5 },
      signal: new AbortController().signal,
    };
    // 前 2 次失败:预算内 → 透传官方 retry
    expect(
      await callListener(errListener, payload, async () => upstreamRetry),
    ).toBe(upstreamRetry);
    expect(
      await callListener(errListener, payload, async () => upstreamRetry),
    ).toBe(upstreamRetry);
    // 第 3 次失败:candidateRetries=2 >= N=2 → 覆盖官方决策,切换
    expect(
      await callListener(errListener, payload, async () => upstreamRetry),
    ).toEqual({ kind: 'retry' });
    const nextSeed = await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    expect(nextSeed).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('自定义 retriesBeforeSwitch 大于官方预算 → 预算内透传官方,耗尽后插件代执行剩余,直到 N 用满才切', async () => {
    // N=3、provider 策略 maxRetries=1:第 1 次失败透传官方 retry(预算内);
    // 第 2、3 次失败官方已耗尽 → 插件代执行;第 4 次失败 N 用满 → 切换。
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['openai/gpt-4o'],
      retriesBeforeSwitch: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    const reqListener = findListener(listeners, 'agent/request');
    const errListener = findListener(listeners, 'agent/request-error');
    await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    const upstreamRetry = { kind: 'retry' as const };
    const payload = {
      turn: 1,
      step: 1,
      provider: 'deepseek',
      failure: stubFailure('RATE_LIMIT'),
      retryPolicy: { mode: 'normal', maxRetries: 1 },
      signal: new AbortController().signal,
    };
    // 第 1 次失败:官方预算内 → 透传官方 retry
    expect(
      await callListener(errListener, payload, async () => upstreamRetry),
    ).toBe(upstreamRetry);
    // 第 2、3 次失败:官方预算耗尽(upstream=undefined)→ 插件代执行,N 未满不切换
    expect(
      await callListener(errListener, payload, async () => undefined),
    ).toEqual({ kind: 'retry' });
    expect(
      await callListener(errListener, payload, async () => undefined),
    ).toEqual({ kind: 'retry' });
    const seedStillPage = await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    expect(seedStillPage).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
    });
    // 第 4 次失败:candidateRetries=3 >= N=3 → 切换
    expect(
      await callListener(errListener, payload, async () => undefined),
    ).toEqual({ kind: 'retry' });
    const nextSeed = await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    expect(nextSeed).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('预算内 + 官方无决策(未装官方插件)→ 本插件代执行同候选重试,不推进 index', async () => {
    // provider retryPolicy normal(5)但官方 retry 插件未装载:upstream 恒为
    // undefined。自动档预算 = 5 → 本插件代执行同候选重试 5 次(带退避),
    // 第 6 次失败才切换。
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['openai/gpt-4o'],
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    const reqListener = findListener(listeners, 'agent/request');
    const errListener = findListener(listeners, 'agent/request-error');
    await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    const payload = {
      turn: 1,
      step: 1,
      provider: 'deepseek',
      failure: stubFailure('RATE_LIMIT'),
      retryPolicy: { mode: 'normal', maxRetries: 5 },
      signal: new AbortController().signal,
    };
    const selfRetry = { kind: 'retry' as const };
    // 前 5 次失败:代执行同候选重试
    for (let i = 0; i < 5; i++) {
      expect(
        await callListener(errListener, payload, async () => undefined),
      ).toEqual(selfRetry);
      // 同候选重试不改写 seed(index 仍 -1,pageModel 不动)
      const seed = await callListener(
        reqListener,
        { turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
      );
      expect(seed).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
    }
    // 第 6 次失败:预算耗尽 → 切到队列第 1 项
    expect(
      await callListener(errListener, payload, async () => undefined),
    ).toEqual({ kind: 'retry' });
    const nextSeed = await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    expect(nextSeed).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('自动档 + always 策略:上游有 retry 决策则整体透传,无决策则首失败即切', async () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['openai/gpt-4o'],
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    const reqListener = findListener(listeners, 'agent/request');
    const errListener = findListener(listeners, 'agent/request-error');
    const payloadBase = {
      turn: 1,
      step: 1,
      provider: 'deepseek',
      failure: stubFailure('RATE_LIMIT'),
      retryPolicy: { mode: 'always' },
      signal: new AbortController().signal,
    };
    await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    // always 模式自动档:官方决定无限重试 → 整体跟随,不切换
    const upstreamRetry = { kind: 'retry' as const };
    expect(
      await callListener(errListener, payloadBase, async () => upstreamRetry),
    ).toBe(upstreamRetry);
    // 官方无决策(always 未装载)→ 预算 0 → 首失败即切
    const switched = await callListener(
      errListener,
      { ...payloadBase, turn: 1, step: 2 },
      async () => undefined,
    );
    expect(switched).toEqual({ kind: 'retry' });
    const nextSeed = await callListener(
      reqListener,
      { turn: 1, step: 2, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    expect(nextSeed).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('切换后新候选获得完整预算(candidateFailures 清零)', async () => {
    // N=1 且无 provider 策略(预算=1):会话模型失败 2 次(第 1 次代重试、
    // 第 2 次切换)到候选 A;候选 A 同样失败 2 次才切到候选 B——证明计数
    // 按候选独立、切换后清零。
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['openai/a', 'anthropic/b'],
      retriesBeforeSwitch: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    const reqListener = findListener(listeners, 'agent/request');
    const errListener = findListener(listeners, 'agent/request-error');
    await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    const payloadOf = (provider: string) => ({
      turn: 1,
      step: 1,
      provider,
      failure: stubFailure('RATE_LIMIT'),
      signal: new AbortController().signal,
    });
    // 会话模型第 1 次失败:预算内(candidates=0 < 1)无官方决策 → 代重试(不切换)
    expect(
      await callListener(
        errListener,
        payloadOf('deepseek'),
        async () => undefined,
      ),
    ).toEqual({ kind: 'retry' });
    const seedStillPage = await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    expect(seedStillPage).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
    });
    // 会话模型第 2 次失败:预算耗尽 → 切到候选 A
    expect(
      await callListener(
        errListener,
        payloadOf('deepseek'),
        async () => undefined,
      ),
    ).toEqual({ kind: 'retry' });
    const seedOnA = await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    expect(seedOnA).toEqual({ provider: 'openai', model: 'a' });
    // 候选 A 第 1 次失败:新候选预算 1,candidateRetries=0 < 1 → 代重试(不切换)
    expect(
      await callListener(
        errListener,
        payloadOf('openai'),
        async () => undefined,
      ),
    ).toEqual({ kind: 'retry' });
    const seedStillA = await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'openai', model: 'a' }),
    );
    expect(seedStillA).toEqual({ provider: 'openai', model: 'a' }); // 仍是 A
    // 候选 A 第 2 次失败:预算耗尽 → 切到候选 B
    expect(
      await callListener(
        errListener,
        payloadOf('openai'),
        async () => undefined,
      ),
    ).toEqual({ kind: 'retry' });
    const seedOnB = await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'openai', model: 'a' }),
    );
    expect(seedOnB).toEqual({ provider: 'anthropic', model: 'b' });
  });

  it('默认(自动档,无策略预算 0)+ TRANSPORT("Connection error.")→ 切下一候选', async () => {
    // 核心回归:宿主把连接类失败(openai / Anthropic SDK 的
    // APIConnectionError,消息 "Connection error.")归类为 TRANSPORT,
    // 官方 dsh-llm-retry 默认重试它;本插件默认白名单须同样命中,
    // 否则官方重试耗尽后不切换,对话以 "Connection error." 终态中断。
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['openai/gpt-4o', 'anthropic/claude-sonnet-4'],
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    const reqListener = findListener(listeners, 'agent/request');
    const errListener = findListener(listeners, 'agent/request-error');
    await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    // upstream=undefined:官方 retry 预算耗尽(或未装载)→ 决策权落到本插件
    const result = await callListener(
      errListener,
      {
        turn: 1,
        step: 1,
        provider: 'deepseek',
        failure: stubFailure('TRANSPORT', 'Connection error.'),
        signal: new AbortController().signal,
      },
      async () => undefined,
    );
    expect(result).toEqual({ kind: 'retry' });

    // 状态已推进:下一请求的 seed 被改写为队列第 1 项
    const nextSeed = await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    expect(nextSeed).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('默认(自动档,无策略预算 0)+ SERVER(5xx)→ 切下一候选', async () => {
    // 与 TRANSPORT 同源的回归:宿主把 5xx 归类为 SERVER(非 omp 系 SERVER_ERROR)
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['openai/gpt-4o', 'anthropic/claude-sonnet-4'],
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    const reqListener = findListener(listeners, 'agent/request');
    const errListener = findListener(listeners, 'agent/request-error');
    await callListener(
      reqListener,
      { turn: 2, step: 3, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    const result = await callListener(
      errListener,
      {
        turn: 2,
        step: 3,
        provider: 'deepseek',
        failure: stubFailure('SERVER', 'Internal Server Error'),
        signal: new AbortController().signal,
      },
      async () => undefined,
    );
    expect(result).toEqual({ kind: 'retry' });
    const nextSeed = await callListener(
      reqListener,
      { turn: 2, step: 3, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    expect(nextSeed).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('默认(自动档,无策略预算 0)+ UNSUPPORTED_REASONING_EFFORT(模型不支持 reasoning effort)→ 切下一候选', async () => {
    // 核心回归:宿主两套适配器(deepseek Messages / pi-ai)在请求构建期(
    // pre-network)校验 reasoning effort,模型不支持时抛
    // LlmError(`provider "X" model "Y" does not support reasoning effort "Z"`,
    // 'UNSUPPORTED_REASONING_EFFORT')。该失败对同一模型是确定性的——同 provider
    // 重试毫无意义(宿主官方重试码表也不含它),唯一出路就是切下一个候选;
    // 默认白名单若不含此码,error payload 原样上抛,对话以此终态中断。
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['openai/gpt-4o', 'anthropic/claude-sonnet-4'],
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    const reqListener = findListener(listeners, 'agent/request');
    const errListener = findListener(listeners, 'agent/request-error');
    await callListener(
      reqListener,
      { turn: 3, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'e2e-broken', model: 'broken-model' }),
    );
    // upstream=undefined:官方 dsh-llm-retry 不重试此码,决策权落到本插件
    const result = await callListener(
      errListener,
      {
        turn: 3,
        step: 1,
        provider: 'e2e-broken',
        failure: stubFailure(
          'UNSUPPORTED_REASONING_EFFORT',
          'provider "e2e-broken" model "broken-model" does not support reasoning effort "high"',
        ),
        signal: new AbortController().signal,
      },
      async () => undefined,
    );
    expect(result).toEqual({ kind: 'retry' });

    // 状态已推进:下一请求的 seed 被改写为队列第 1 项
    const nextSeed = await callListener(
      reqListener,
      { turn: 3, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'e2e-broken', model: 'broken-model' }),
    );
    expect(nextSeed).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('默认 + UNKNOWN_MODEL(失效候选:模型已从 provider 删除)→ 跳到下一候选并写 llm/retry 轨迹,整链不中断', async () => {
    // 失效候选兜底回归:pi-ai 适配器对配置中不存在的模型在请求构建期抛
    // LlmError(`pi-ai provider "X" has no configured model "Y"`,
    // 'UNKNOWN_MODEL')——用户在 dsh 侧删除模型/改 id 后,队列残留候选必然
    // 命中。该失败确定性复现,同候选重试无意义;默认白名单不含此码时
    // isFailureRetryable=false → 透传上游,整链在失效候选上中断(旧缺陷)。
    // 修复后:失效候选首失败即按预算跳下一候选,且切换留 llm/retry(+started)
    // 轨迹。场景:会话模型失败切到队列里的失效候选(my-gw/old-model)→
    // UNKNOWN_MODEL → 再跳到 openai/gpt-4o。
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['my-gw/old-model', 'openai/gpt-4o'],
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    const reqListener = findListener(listeners, 'agent/request');
    const errListener = findListener(listeners, 'agent/request-error');
    const { agent, appends } = stubAgent();
    // 1) request:捕获会话指定模型 pageModel = deepseek/deepseek-chat
    await callListener(
      reqListener,
      { turn: 7, step: 2, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    // 2) 会话模型首失败 → 切到队列第 1 项(失效候选)
    await callListener(
      errListener,
      {
        turn: 7,
        step: 2,
        provider: 'deepseek',
        failure: stubFailure('RATE_LIMIT'),
        signal: new AbortController().signal,
      },
      async () => undefined,
    );
    let seed = await callListener(
      reqListener,
      { turn: 7, step: 2, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    expect(seed).toEqual({ provider: 'my-gw', model: 'old-model' });
    // 3) 失效候选失败:UNKNOWN_MODEL(白名单命中)→ 跳下一候选并留轨迹
    const failure = stubFailure(
      'UNKNOWN_MODEL',
      'pi-ai provider "my-gw" has no configured model "old-model"',
    );
    const result = await callListener(
      errListener,
      {
        turn: 7,
        step: 2,
        provider: 'my-gw',
        failure,
        signal: new AbortController().signal,
        agent,
      },
      async () => undefined,
    );
    // 失效候选被跳过:返回 retry(loop 将以队列下一候选重发)
    expect(result).toEqual({ kind: 'retry' });

    // 轨迹:切换留官方 llm/retry + llm/retry-started 事件,target=新候选
    expect(appends.map((a) => a.type)).toEqual([
      'llm/retry',
      'llm/retry-started',
    ]);
    expect(appends[0]?.data).toMatchObject({
      turn: 7,
      step: 2,
      provider: 'my-gw',
      policyKey: 'llm-fallback',
      failure,
      targetProvider: 'openai',
      targetModel: 'gpt-4o',
    });

    // 状态已推进:下一请求的 seed 被改写为队列第 2 项(整链未中断)
    seed = await callListener(
      reqListener,
      { turn: 7, step: 2, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    expect(seed).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('默认(自动档,无策略预算 0)+ upstream={retry} → 首失败即覆盖切换(不再有 immediately 档)', async () => {
    // payload 不带 retryPolicy(provider 未注册策略/旧宿主)→ 自动档预算 0,
    // 首次白名单失败即切换;官方 retry 在无策略时本就不会决策,这里同时
    // 验证"上游偶有 retry 决策也被预算 0 覆盖"的防御路径。
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['openai/gpt-4o', 'anthropic/claude-sonnet-4'],
      baseDelayMs: 100,
      maxDelayMs: 500,
    });
    const reqListener = findListener(listeners, 'agent/request');
    const errListener = findListener(listeners, 'agent/request-error');
    await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    const result = await callListener(
      errListener,
      {
        turn: 1,
        step: 1,
        provider: 'deepseek',
        failure: stubFailure('RATE_LIMIT'),
        signal: new AbortController().signal,
      },
      async () => ({ kind: 'retry' as const }),
    );
    expect(result).toEqual({ kind: 'retry' });

    // 状态已推进:seed 被改写为队列第 1 项
    const nextSeed = await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    expect(nextSeed).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('失败码不在白名单 → 透传 upstream(undefined)', async () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['deepseek/deepseek-chat', 'openai/gpt-4o'],
    });
    const errListener = findListener(listeners, 'agent/request-error');
    const result = await callListener(
      errListener,
      {
        turn: 1,
        step: 1,
        provider: 'deepseek',
        failure: stubFailure('INVALID_CREDENTIAL'),
        signal: new AbortController().signal,
      },
      async () => undefined,
    );
    expect(result).toBeUndefined();
  });

  it('单项队列且队列项=会话模型(无备选)→ 耗尽透传', async () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, { fallbackChains: ['deepseek/deepseek-chat'] });
    const reqListener = findListener(listeners, 'agent/request');
    const errListener = findListener(listeners, 'agent/request-error');
    await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    // 唯一候选即会话模型 → 推进时被跳过 → 无候选可切,透传
    const result = await callListener(
      errListener,
      {
        turn: 1,
        step: 1,
        provider: 'deepseek',
        failure: stubFailure('RATE_LIMIT'),
        signal: new AbortController().signal,
      },
      async () => undefined,
    );
    expect(result).toBeUndefined();
  });

  it('默认(自动档,无策略预算 0)连续失败按队列顺序切:会话模型 → openai → anthropic → 耗尽', async () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['deepseek/x', 'openai/y', 'anthropic/z'],
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    const reqListener = findListener(listeners, 'agent/request');
    const errListener = findListener(listeners, 'agent/request-error');
    await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'x' }),
    );
    // 三次失败:第 1、2 次切候选,第 3 次透传
    const r1 = await callListener(
      errListener,
      {
        turn: 1,
        step: 1,
        provider: 'deepseek',
        failure: stubFailure('RATE_LIMIT'),
        signal: new AbortController().signal,
      },
      async () => undefined,
    );
    expect(r1).toEqual({ kind: 'retry' });
    const r2 = await callListener(
      errListener,
      {
        turn: 1,
        step: 1,
        provider: 'openai',
        failure: stubFailure('QUOTA'),
        signal: new AbortController().signal,
      },
      async () => undefined,
    );
    expect(r2).toEqual({ kind: 'retry' });
    const r3 = await callListener(
      errListener,
      {
        turn: 1,
        step: 1,
        provider: 'anthropic',
        failure: stubFailure('SERVER'), // 宿主 5xx 实际码;此处链已耗尽 → 透传
        signal: new AbortController().signal,
      },
      async () => undefined,
    );
    expect(r3).toBeUndefined();
  });

  it('失败时 signal 已 aborted → 透传 upstream', async () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['deepseek/x', 'openai/y'],
    });
    const errListener = findListener(listeners, 'agent/request-error');
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await callListener(
      errListener,
      {
        turn: 1,
        step: 1,
        provider: 'deepseek',
        failure: stubFailure('RATE_LIMIT'),
        signal: ctrl.signal,
      },
      async () => undefined,
    );
    expect(result).toBeUndefined();
  });
});

// ── 5b. 轨迹记录(官方 llm/retry / llm/retry-started 事件) ─────────────

/** 轨迹写入的最小 agent 假体:append 收集调用供断言。 */
function stubAgent(): {
  agent: { session: { append: ReturnType<typeof vi.fn> } };
  appends: Array<{ type: string; data: Record<string, unknown> }>;
} {
  const appends: Array<{ type: string; data: Record<string, unknown> }> = [];
  const agent = {
    session: {
      append: vi.fn((type: string, data: Record<string, unknown>) => {
        appends.push({ type, data });
        return undefined;
      }),
    },
  };
  return { agent, appends };
}

describe('轨迹记录(llm/retry 事件)', () => {
  it('切换候选时依次写入 llm/retry 与 llm/retry-started,字段完整', async () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['deepseek/x', 'openai/y', 'anthropic/z'],
      maxRetries: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    const reqListener = findListener(listeners, 'agent/request');
    const errListener = findListener(listeners, 'agent/request-error');
    const { agent, appends } = stubAgent();
    // 先 request:捕获会话指定模型 pageModel = deepseek/x
    await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'x' }),
    );
    const failure = stubFailure('RATE_LIMIT');
    const result = await callListener(
      errListener,
      {
        turn: 1,
        step: 1,
        provider: 'deepseek',
        failure,
        signal: new AbortController().signal,
        agent,
      },
      async () => undefined,
    );
    expect(result).toEqual({ kind: 'retry' });
    // 两个事件,类型与顺序正确
    expect(appends.map((a) => a.type)).toEqual([
      'llm/retry',
      'llm/retry-started',
    ]);
    const scheduled = appends[0]?.data;
    const started = appends[1]?.data;
    // scheduled(normal 形态):官方 payload shape 全字段 + 本插件追加的切换目标
    expect(scheduled).toMatchObject({
      turn: 1,
      step: 1,
      provider: 'deepseek', // 失败起点,非切换目标
      mode: 'normal',
      policyKey: 'llm-fallback',
      retry: 1,
      maxRetries: 2, // min(maxRetries=2, 队列长 3)
      delayMs: 0,
      failure,
      targetProvider: 'openai', // 切换目标:轨迹里直接可见"切到哪个模型继续跑"
      targetModel: 'y',
    });
    expect(typeof scheduled?.retryId).toBe('string');
    expect((scheduled?.retryId as string).length).toBeGreaterThan(0);
    // started:同链复用同一 retryId
    expect(started).toEqual({
      retryId: scheduled?.retryId,
      turn: 1,
      step: 1,
      retry: 1,
    });
  });

  it('同 step 二次切换(跨 provider):每 provider 独立链,retry 各自从 1 起', async () => {
    // format v4 读侧按 (turn, step, provider, policyKey) 校验 retry 序列必须
    // 从 1 起连续——旧"step 内切换序号"编号在跨 provider 多跳时写出非法序列
    // (第二跳 retry=2 但 provider 变了,读侧视为跳号,会话日志恢复被拒)。
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['deepseek/x', 'openai/y', 'anthropic/z'],
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    const reqListener = findListener(listeners, 'agent/request');
    const errListener = findListener(listeners, 'agent/request-error');
    const { agent, appends } = stubAgent();
    await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'x' }),
    );
    await callListener(
      errListener,
      {
        turn: 1,
        step: 1,
        provider: 'deepseek',
        failure: stubFailure('RATE_LIMIT'),
        signal: new AbortController().signal,
        agent,
      },
      async () => undefined,
    );
    await callListener(
      errListener,
      {
        turn: 1,
        step: 1,
        provider: 'openai',
        failure: stubFailure('QUOTA'),
        signal: new AbortController().signal,
        agent,
      },
      async () => undefined,
    );
    const scheduledList = appends.filter((a) => a.type === 'llm/retry');
    expect(scheduledList).toHaveLength(2);
    const first = scheduledList[0]?.data;
    const second = scheduledList[1]?.data;
    // 各 provider 独立链:第二跳 retry 从 1 重新起,retryId 不同链不同 id
    expect(first).toMatchObject({ provider: 'deepseek', retry: 1 });
    expect(second).toMatchObject({ provider: 'openai', retry: 1 });
    expect(second?.retryId).not.toBe(first?.retryId);
    expect(second?.failure).toMatchObject({ code: 'QUOTA' });
    // 第二跳目标 = 队列第三项(候选逐跳推进,目标随之更新)
    expect(second?.targetProvider).toBe('anthropic');
    expect(second?.targetModel).toBe('z');
  });

  it('同 provider 连续候选:链延续,retry 接续递增且 retryId 恒定', async () => {
    // 链 [a/x, a/y] 两项同 provider:切到 a/y 后的失败仍是 provider a 的
    // 事件——format v4 要求该链 retryId 恒定、retry 接续(1,2,3…),不得重启。
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['a/x', 'a/y'],
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    const reqListener = findListener(listeners, 'agent/request');
    const errListener = findListener(listeners, 'agent/request-error');
    const { agent, appends } = stubAgent();
    await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'other', model: 'm' }),
    );
    const failOn = () => ({
      turn: 1,
      step: 1,
      provider: 'a',
      failure: stubFailure('RATE_LIMIT'),
      signal: new AbortController().signal,
      agent,
    });
    await callListener(errListener, failOn(), async () => undefined); // 切到 a/x
    await callListener(errListener, failOn(), async () => undefined); // 切到 a/y
    await callListener(errListener, failOn(), async () => undefined); // 耗尽透传
    const scheduledList = appends.filter((a) => a.type === 'llm/retry');
    expect(scheduledList).toHaveLength(2); // 第三次失败链耗尽,不写事件
    const first = scheduledList[0]?.data;
    const second = scheduledList[1]?.data;
    expect(first).toMatchObject({
      provider: 'a',
      retry: 1,
      targetModel: 'x',
    });
    expect(second).toMatchObject({
      provider: 'a',
      retry: 2,
      targetModel: 'y',
    });
    // 同 provider 链:retryId 恒定(format v4 "one retryId per policy chain")
    expect(second?.retryId).toBe(first?.retryId);
  });

  it('代执行同候选重试:llm/retry 记候选内序号,maxRetries=有效预算,target=被重试的候选自身', async () => {
    // 自动档 + provider 策略 normal(2)、官方 retry 未装:前 2 次失败由本
    // 插件代执行同候选重试(第 3 次才切换)。轨迹应体现"同一模型第 N 次重试"。
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['openai/y'],
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    const reqListener = findListener(listeners, 'agent/request');
    const errListener = findListener(listeners, 'agent/request-error');
    const { agent, appends } = stubAgent();
    await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'x' }),
    );
    const payload = {
      turn: 1,
      step: 1,
      provider: 'deepseek',
      failure: stubFailure('RATE_LIMIT'),
      retryPolicy: { mode: 'normal', maxRetries: 2 },
      signal: new AbortController().signal,
      agent,
    };
    // 第 1、2 次失败:代重试,各写一对事件
    await callListener(errListener, payload, async () => undefined);
    await callListener(errListener, payload, async () => undefined);
    // 第 3 次失败:预算耗尽 → 切换
    await callListener(errListener, payload, async () => undefined);
    expect(appends.map((a) => a.type)).toEqual([
      'llm/retry',
      'llm/retry-started',
      'llm/retry',
      'llm/retry-started',
      'llm/retry',
      'llm/retry-started',
    ]);
    const [first, , second, , switchEvent] = appends.map((a) => a.data);
    // 代重试事件:retry = provider 链内序号(1 起连续),maxRetries = 有效
    // 预算(2),target = 被重试的会话模型自身(provider 不变)
    expect(first).toMatchObject({
      provider: 'deepseek',
      retry: 1,
      maxRetries: 2,
      targetProvider: 'deepseek',
      targetModel: 'x',
      policyKey: 'llm-fallback',
    });
    expect(second).toMatchObject({ retry: 2, maxRetries: 2 });
    // 切换事件:同一 provider 链上序号接续(2 → 3),maxRetries 换成链长
    // 上限,target 变候选
    expect(switchEvent).toMatchObject({
      retry: 3,
      maxRetries: 1,
      targetProvider: 'openai',
      targetModel: 'y',
    });
    // 同 provider 链:全部事件复用同一 retryId(format v4 校验要求)
    expect(new Set(appends.map((a) => a.data.retryId)).size).toBe(1);
  });

  it('payload 无 agent(旧宿主)→ 不写轨迹且回退不受影响', async () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['deepseek/x', 'openai/y'],
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    const errListener = findListener(listeners, 'agent/request-error');
    const result = await callListener(
      errListener,
      {
        turn: 1,
        step: 1,
        provider: 'deepseek',
        failure: stubFailure('RATE_LIMIT'),
        signal: new AbortController().signal,
      },
      async () => undefined,
    );
    expect(result).toEqual({ kind: 'retry' });
  });

  it('session.append 抛错 → 轨迹写入被吞掉,回退照常返回 retry', async () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['deepseek/x', 'openai/y'],
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    const errListener = findListener(listeners, 'agent/request-error');
    const agent = {
      session: {
        append: vi.fn(() => {
          throw new Error('session closed');
        }),
      },
    };
    const result = await callListener(
      errListener,
      {
        turn: 1,
        step: 1,
        provider: 'deepseek',
        failure: stubFailure('RATE_LIMIT'),
        signal: new AbortController().signal,
        agent,
      },
      async () => undefined,
    );
    expect(result).toEqual({ kind: 'retry' });
    // scheduled 与 started 都尝试写、都被吞 → 共调用 2 次
    expect(agent.session.append).toHaveBeenCalledTimes(2);
  });

  it('退避期间被 abort → 只写 llm/retry(已调度),不写 llm/retry-started', async () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['deepseek/x', 'openai/y'],
      baseDelayMs: 60_000,
      maxDelayMs: 60_000,
    });
    const errListener = findListener(listeners, 'agent/request-error');
    const { agent, appends } = stubAgent();
    const ctrl = new AbortController();
    const result = await callListener(
      errListener,
      {
        turn: 1,
        step: 1,
        provider: 'deepseek',
        failure: stubFailure('RATE_LIMIT'),
        signal: ctrl.signal,
        agent,
      },
      async () => {
        // 模拟退避等待期间 turn 被取消
        ctrl.abort();
        return undefined;
      },
    );
    expect(result).toBeUndefined(); // 透传 upstream,不切换
    expect(appends.map((a) => a.type)).toEqual(['llm/retry']);
    expect(appends[0]?.data.delayMs).toBeGreaterThan(0);
  });

  it('白名单未命中(不切换)→ 不写任何轨迹事件', async () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['deepseek/x', 'openai/y'],
    });
    const errListener = findListener(listeners, 'agent/request-error');
    const { agent, appends } = stubAgent();
    const result = await callListener(
      errListener,
      {
        turn: 1,
        step: 1,
        provider: 'deepseek',
        failure: stubFailure('INVALID_CREDENTIAL'),
        signal: new AbortController().signal,
        agent,
      },
      async () => undefined,
    );
    expect(result).toBeUndefined();
    expect(appends).toEqual([]);
  });
});

// ── 6. Config schema(避免 loader 设置投影失败)──────────────────────

describe('Config schema', () => {
  it('导出的是 schemastery Schema 对象,有 default 链式方法', () => {
    // schemastery Schema 是链式 fluent API;.default / .description 都是方法
    // 该测试只断言 Config 是 truthy 且 schema 形态(避免 loader 把 schema 类型搞错)
    expect(Config).toBeDefined();
    expect(typeof (Config as unknown as { default: unknown }).default).toBe(
      'function',
    );
    expect(
      typeof (Config as unknown as { description: unknown }).description,
    ).toBe('function');
  });

  it('fallbackChains 挂 role("modelList", { source: "dsh-llm-runtime" })', () => {
    // role 字段给 dsh 前端 SettingsValueField 提示用 modelList 渲染器;
    // 若前端不识别,降级为对象数组输入框(功能不受影响)。
    const chains = (
      Config as unknown as {
        dict: Record<
          string,
          {
            role?: string;
            meta?: { role?: string; extra?: Record<string, unknown> };
          }
        >;
      }
    ).dict?.fallbackChains;
    expect(chains).toBeDefined();
    // schemastery 内部把 .role() 写到 meta.role;role 文本是 "modelList"。
    // 我们不强求 meta.role 一定是字符串(不同 schemastery 版本可能存为 list),
    // 但要确认 meta 中存在 role 字段,值含 "modelList"。
    const meta = chains?.meta;
    expect(meta).toBeDefined();
    const roleValue = meta?.role;
    // role 可能是字符串,也可能被包成 list(若用 .role() 链式调多次)—— 至少含 modelList
    const roleStr = Array.isArray(roleValue)
      ? roleValue.join(',')
      : String(roleValue);
    expect(roleStr).toContain('modelList');
  });

  it('fallbackChains meta.extra 包含 role 传来的 { source: "dsh-llm-runtime" }', () => {
    // schemastery 的 .role(role, extra) 把 extra 直接挂在 meta.extra;
    // 前端 modelList 渲染器读此字段决定候选模型来源(snapshot 由插件运行时填)。
    const chains = (
      Config as unknown as {
        dict: Record<string, { meta?: { role?: unknown; extra?: unknown } }>;
      }
    ).dict?.fallbackChains;
    const extra = chains?.meta?.extra;
    expect(extra).toBeDefined();
    expect((extra as { source?: string } | undefined)?.source).toBe(
      'dsh-llm-runtime',
    );
  });

  it('每个字段都标了 meta.volatile(否则设置面板整个不出现该插件)', () => {
    // 宿主 `@deepseek-ai/dsh-settings` 的 describe() 用 volatileForm(schema) 过滤,
    // 没有 volatile 字段的条目会被整个丢弃(describe 返回 [] + 写入抛
    // "Plugin entry X has no volatile fields")。故这是设置 UI 的硬前提。
    const dict = (
      Config as unknown as {
        dict: Record<string, { meta?: { volatile?: unknown } }>;
      }
    ).dict;
    const fields = [
      'enabled',
      'fallbackChains',
      'retriesBeforeSwitch',
      'maxRetries',
      'baseDelayMs',
      'maxDelayMs',
      'cooldownEnabled',
      'cooldownMs',
      'retryableCodes',
      'perTurn',
      'timeWindowEnabled',
      'timeWindowRules',
    ];
    for (const field of fields) {
      expect(dict[field], `missing field ${field}`).toBeDefined();
      expect(dict[field]?.meta?.volatile, `${field} not volatile`).toBe(true);
    }
  });

  it('maxRetries 挂 role("modelChainMeta", { kind: "retries" })', () => {
    // 给 dsh 前端提示"这是 fallback 链的元数据",可与 fallbackChains
    // 在同一 UI 区块里联排显示。
    const maxRetries = (
      Config as unknown as {
        dict: Record<string, { meta?: { role?: unknown } }>;
      }
    ).dict?.maxRetries;
    const roleValue = maxRetries?.meta?.role;
    const roleStr = Array.isArray(roleValue)
      ? roleValue.join(',')
      : String(roleValue);
    expect(roleStr).toContain('modelChainMeta');
  });
});

// ── 7. Config schema 国际化(desc i18n 映射)─────────────────────────

/**
 * 设置表单国际化的契约:所有字段描述都是 schemastery i18n 映射
 * `{ '': 英文默认, zh, en }`——宿主 settings.describe 以 form.toJSON() 原样
 * 下发该映射,前端按 dsh 语言配置(Host 偏好 → 浏览器 → en)解析。
 * `''` 键 = 默认文案:不识别映射的旧渲染端原样显示英文,行为零回归。
 */
describe('Config schema 国际化(desc i18n 映射)', () => {
  /** schemastery 节点里测试关心的最小形状。 */
  interface SchemaNode {
    meta?: { description?: unknown };
  }

  /** Config 顶层字段节点。 */
  function fieldOf(fieldName: string): SchemaNode | undefined {
    return (Config as unknown as { dict: Record<string, SchemaNode> }).dict?.[
      fieldName
    ];
  }

  /** fallbackChains 内层 ChainEntrySchema 的子字段表。 */
  function chainEntryFields(): Record<string, SchemaNode> {
    const chains = fieldOf('fallbackChains') as unknown as
      { inner?: { dict?: Record<string, SchemaNode> } } | undefined;
    return chains?.inner?.dict ?? {};
  }

  /** 断言一个 description 是形态完整的三键映射,且默认文案 = 英文。 */
  function expectDescMap(raw: unknown, label: string): void {
    expect(raw, `${label} 应为对象`).toBeTypeOf('object');
    const map = raw as Record<string, unknown>;
    for (const key of ['', 'en', 'zh'] as const) {
      expect(
        typeof map[key],
        `${label}.${key === '' ? '""' : key} 应为 string`,
      ).toBe('string');
      expect(
        (map[key] as string).length,
        `${label}.${key === '' ? '""' : key} 应非空`,
      ).toBeGreaterThan(0);
    }
    // '' 默认文案 = 英文:旧渲染端(只认字符串描述)回退显示英文,零回归
    expect(map[''], `${label}."" 默认文案应与 en 一致`).toBe(map.en);
  }

  it("desc() helper 产出 {'': en, en, zh} 映射(默认文案为英文)", () => {
    const map = desc('Hello world', '你好世界');
    expect(map).toEqual({
      '': 'Hello world',
      en: 'Hello world',
      zh: '你好世界',
    });
  });

  it("每个 volatile 字段的 description 都是 {'', zh, en} 映射", () => {
    const fields = [
      'enabled',
      'fallbackChains',
      'retriesBeforeSwitch',
      'maxRetries',
      'baseDelayMs',
      'maxDelayMs',
      'cooldownEnabled',
      'cooldownMs',
      'retryableCodes',
      'perTurn',
      'timeWindowEnabled',
      'timeWindowRules',
    ];
    for (const fieldName of fields) {
      const node = fieldOf(fieldName);
      expect(node, `missing field ${fieldName}`).toBeDefined();
      expectDescMap(node?.meta?.description, fieldName);
    }
  });

  it('fallbackChains 内层 ChainEntry 字段(provider/model/displayName/description)同样携带映射', () => {
    const inner = chainEntryFields();
    for (const fieldName of [
      'provider',
      'model',
      'displayName',
      'description',
    ]) {
      expect(
        inner[fieldName],
        `missing chain entry field ${fieldName}`,
      ).toBeDefined();
      expectDescMap(
        inner[fieldName]?.meta?.description,
        `fallbackChains.${fieldName}`,
      );
    }
  });

  it('中文文案覆盖关键字段语义(可读性抽查)', () => {
    const enabled = fieldOf('enabled')?.meta?.description as Record<
      string,
      string
    >;
    expect(enabled.zh).toContain('模型回退');
    const chains = fieldOf('fallbackChains')?.meta?.description as Record<
      string,
      string
    >;
    // 0.5.0 起去主模型概念:描述声明这是"纯回退候选队列"
    expect(chains.zh).toContain('回退候选队列');
    expect(chains.zh).not.toContain('首项');
    expect(chains.en).toContain('fallback candidates');
    const when = fieldOf('retriesBeforeSwitch')?.meta?.description as Record<
      string,
      string
    >;
    expect(when.zh).toContain('重试次数');
    expect(when.zh).toContain('预算');
    expect(when.zh).toContain('以插件配置为准');
    expect(when.en).toContain('retry budget');
    expect(when.en).toContain('authoritative');
    const maxSwitches = fieldOf('maxRetries')?.meta?.description as Record<
      string,
      string
    >;
    // 两个数字字段语义互斥可辨:maxRetries 限切换,retriesBeforeSwitch 限同候选重试
    expect(maxSwitches.zh).toContain('retriesBeforeSwitch');
    const cooldownOn = fieldOf('cooldownEnabled')?.meta?.description as Record<
      string,
      string
    >;
    // 冷却跳过:失败模型短窗内不再作为起点,窗口期满恢复优先级
    expect(cooldownOn.zh).toContain('冷却');
    expect(cooldownOn.zh).toContain('优先级');
    expect(cooldownOn.en.toLowerCase()).toContain('cooldown');
    const cooldownMs = fieldOf('cooldownMs')?.meta?.description as Record<
      string,
      string
    >;
    expect(cooldownMs.zh).toContain('窗口');
    expect(cooldownMs.en.toLowerCase()).toContain('window');
  });

  it('description 映射可 JSON 序列化(settings.describe 的 form.toJSON 下发路径不炸)', () => {
    // 宿主 SettingsForms.describe 用 JSON.stringify(schema.toJSON()) 计算
    // revision 并下发;描述若含函数/循环会让该路径抛错——此断言防回归。
    const serialized = JSON.stringify(Config.toJSON());
    expect(typeof serialized).toBe('string');
    expect(serialized).toContain('模型回退');
    expect(JSON.parse(serialized)).toBeTypeOf('object');
  });
});

describe('volatile 解包', () => {
  it('isVolatileLike 按 cosmokit 协议识别(全局 Symbol)', () => {
    const write = Symbol.for('cosmokit.volatile.write');
    const ref = { get: () => 1, [write]: () => {} };
    expect(isVolatileLike(ref)).toBe(true);
    expect(isVolatileLike({ get: () => 1 })).toBe(false);
    expect(isVolatileLike(null)).toBe(false);
    expect(isVolatileLike(42)).toBe(false);
  });

  it('unwrapVolatile 深度解包对象/数组里的引用', () => {
    const write = Symbol.for('cosmokit.volatile.write');
    const wrap = (value: unknown): unknown => ({
      get: () => value,
      [write]: () => {},
    });
    const input = {
      enabled: wrap(false),
      fallbackChains: wrap([
        wrap({ provider: 'a', model: 'x' }),
        { provider: 'b', model: 'y' },
      ]),
      maxRetries: wrap(3),
    };
    expect(unwrapVolatile(input)).toEqual({
      enabled: false,
      fallbackChains: [
        { provider: 'a', model: 'x' },
        { provider: 'b', model: 'y' },
      ],
      maxRetries: 3,
    });
  });

  it('resolveConfig 接受 volatile 引用形态的配置(设置面板写入路径)', () => {
    const write = Symbol.for('cosmokit.volatile.write');
    const wrap = (value: unknown): unknown => ({
      get: () => value,
      [write]: () => {},
    });
    // 模拟 loader 把 volatile 字段投影给 apply() 的形态
    const resolved = resolveConfig({
      enabled: wrap(true),
      fallbackChains: wrap([
        wrap({ provider: 'deepseek', model: 'deepseek-chat' }),
        wrap('openai/gpt-4o'),
      ]),
      maxRetries: wrap(2),
      retriesBeforeSwitch: wrap(3),
    });
    expect(resolved.enabled).toBe(true);
    expect(resolved.chain).toEqual([
      { provider: 'deepseek', model: 'deepseek-chat' },
      { provider: 'openai', model: 'gpt-4o' },
    ]);
    expect(resolved.maxRetries).toBe(2);
    expect(resolved.retriesBeforeSwitch).toBe(3);
  });

  it('volatileField 无 volatile 方法时原样返回(守卫)', () => {
    const plain = { tag: 'plain' } as { tag: string; volatile?: unknown };
    expect(volatileField(plain)).toBe(plain);
  });
});

// ── 8. index.ts re-exports Config(避免 dsh settings UI 不渲染字段)──

describe('Config re-export from index.ts', () => {
  it('index.ts 显式 re-export Config(否则 dsh loader 读不到 schema)', () => {
    // 回归:`Config` 定义在 config.ts,但 dsh 加载器 import 的是
    // package.json `main` 指向的 src/index.ts。若 index.ts 不 re-export,
    // dsh-app-boot 的 collectConfigSchemas 拿不到 schema,configRef
    // 会变成 "#/$defs/unknownConfig",settings 面板不渲染本插件字段。
    expect(ConfigFromIndex).toBeDefined();
    expect(ConfigFromIndex).toBe(Config); // 与 config.ts 同一对象引用
  });
});
