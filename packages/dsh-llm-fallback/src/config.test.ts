/**
 * dsh-llm-fallback 行为契约测试。
 *
 * 覆盖:
 * - 插件契约(name / inject / 装载日志);
 * - resolveConfig:默认值 / 链项解析 / fallbackWhen / 错误码识别 / maxRetries=0(链长上限);
 * - state 模块:nextCandidate 推进与边界 / backoffDelayMs 退避曲线;
 * - protocol section:无 {{var}} + 命令名一致 + order;
 * - apply 路径:
 *   - disabled / 空链 → 不挂监听器;
 *   - agent/request 不改写 seed(首次);
 *   - agent/request-error 的 fallbackWhen 两种时机:
 *     - afterRetry(默认):upstream={retry} → 透传不切换;upstream 无决策 → 切换;
 *     - immediately:白名单命中即切,忽略 upstream;
 *   - 链耗尽 / 失败码不在白名单 → 透传 upstream;
 *   - effect 卸载时 dispose 被收集。
 *
 * 风格沿用 dsh-obsidian 的 stubCtx + spyOn(console.log);用
 * `as unknown as Context` 强制把 stub 对象窄化为 cordis Context 类型,
 * 满足 `@typescript-eslint/no-explicit-any` 约束。
 */

import type { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apply, inject, name } from './index.ts';
import {
  resolveConfig,
  resolveFallbackWhen,
  normalizeChainEntry,
  isVolatileLike,
  unwrapVolatile,
  volatileField,
  DEFAULT_RETRYABLE_CODES,
  Config,
} from './config.ts';
import { Config as ConfigFromIndex } from './index.ts';
import {
  type FallbackState,
  backoffDelayMs,
  isFailureRetryable,
  nextCandidate,
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
  it('默认值:enabled=true / chain=[] / fallbackWhen=afterRetry / maxRetries=1 / 默认失败码', () => {
    const c = resolveConfig({});
    expect(c.enabled).toBe(true);
    expect(c.chain).toEqual([]);
    expect(c.fallbackWhen).toBe('afterRetry');
    expect(c.maxRetries).toBe(1); // 链空时 maxRetries 强制 ≥1
    expect(c.retryableCodes).toEqual(new Set(DEFAULT_RETRYABLE_CODES));
    expect(c.baseDelayMs).toBe(500);
    expect(c.maxDelayMs).toBe(30000);
    expect(c.perTurn).toBe(true);
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
    expect(cUndef.fallbackWhen).toBe('afterRetry');
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

  it('fallbackWhen:显式 immediately 生效;非法值宽容回落 afterRetry', () => {
    expect(resolveConfig({ fallbackWhen: 'immediately' }).fallbackWhen).toBe(
      'immediately',
    );
    expect(resolveConfig({ fallbackWhen: 'afterRetry' }).fallbackWhen).toBe(
      'afterRetry',
    );
    expect(resolveConfig({ fallbackWhen: 'bogus' }).fallbackWhen).toBe(
      'afterRetry',
    );
    expect(resolveConfig({ fallbackWhen: 42 }).fallbackWhen).toBe('afterRetry');
  });

  it('resolveFallbackWhen 独立导出行为一致', () => {
    expect(resolveFallbackWhen(undefined)).toBe('afterRetry');
    expect(resolveFallbackWhen(null)).toBe('afterRetry');
    expect(resolveFallbackWhen('immediately')).toBe('immediately');
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
});

// ── 3. state 模块 ────────────────────────────────────────────────────

describe('nextCandidate', () => {
  function init(
    chain: ReadonlyArray<{ provider: string; model: string }>,
  ): FallbackState {
    return { chain, index: 0, retries: 0, exhausted: false };
  }

  it('从 index=0 推进到 index=1', () => {
    const s = init([
      { provider: 'a', model: 'x' },
      { provider: 'b', model: 'y' },
    ]);
    expect(nextCandidate(s, 10)).toEqual({ index: 1, retries: 1 });
  });

  it('最后一跳返回 null', () => {
    const s = init([
      { provider: 'a', model: 'x' },
      { provider: 'b', model: 'y' },
    ]);
    s.index = 1;
    expect(nextCandidate(s, 10)).toBeNull();
  });

  it('retries 达 maxRetries 上限返回 null', () => {
    const s = init([
      { provider: 'a', model: 'x' },
      { provider: 'b', model: 'y' },
      { provider: 'c', model: 'z' },
    ]);
    s.retries = 2;
    expect(nextCandidate(s, 2)).toBeNull();
  });

  it('exhausted=true 时直接 null', () => {
    const s = init([
      { provider: 'a', model: 'x' },
      { provider: 'b', model: 'y' },
    ]);
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
});

describe('stateFor', () => {
  it('首次创建并惰性初始化', () => {
    const map = new Map<string, FallbackState>();
    const s = stateFor(map, '1:1', [{ provider: 'a', model: 'x' }]);
    expect(s.index).toBe(0);
    expect(s.retries).toBe(0);
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
  });

  it('文本说明默认回退时机为官方 retry 耗尽后(afterRetry)', () => {
    const s = modelFallbackSection();
    expect(s.text).toContain('dsh-llm-retry');
    expect(s.text).toContain('exhausted its budget');
  });
});

// ── 5. agent/request 与 agent/request-error 行为 ─────────────────────

describe('agent/request listener', () => {
  it('首次进入(state 未创建)不动 seedConfig', async () => {
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

  it('state.index=1 时改写 seedConfig 为下一候选', async () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['deepseek/deepseek-chat', 'openai/gpt-4o'],
    });
    const listener = findListener(listeners, 'agent/request');
    const errListener = findListener(listeners, 'agent/request-error');
    // 模拟先来一次 request-error,切到 openai/gpt-4o
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
    // 现在 agent/request 进来,seed 还是 deepseek → 改写为 openai
    const seed = { provider: 'deepseek', model: 'deepseek-chat' };
    const result = await callListener(
      listener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => seed,
    );
    expect(result).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('seed 已被外部 listener 改成期望值时不动(seed === expected)', async () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['deepseek/deepseek-chat', 'openai/gpt-4o'],
    });
    const listener = findListener(listeners, 'agent/request');
    const errListener = findListener(listeners, 'agent/request-error');
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
  it('可重试失败码 + 还有下一候选 + upstream 无决策 → backoff + 返回 {kind: "retry"}', async () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['deepseek/deepseek-chat', 'openai/gpt-4o'],
      maxRetries: 2,
      baseDelayMs: 100,
      maxDelayMs: 500,
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

  it('afterRetry(默认)+ upstream={retry}(官方 retry 预算内)→ 透传 upstream,不切换', async () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['deepseek/deepseek-chat', 'openai/gpt-4o'],
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    const errListener = findListener(listeners, 'agent/request-error');
    const upstreamRetry = { kind: 'retry' as const };
    const result = await callListener(
      errListener,
      {
        turn: 1,
        step: 1,
        provider: 'deepseek',
        failure: stubFailure('RATE_LIMIT'),
        signal: new AbortController().signal,
      },
      async () => upstreamRetry,
    );
    // 决策权交还官方 dsh-llm-retry(同 provider 内重试)
    expect(result).toBe(upstreamRetry);

    // 状态未推进:下一个请求进来,seed 仍不被改写
    const reqListener = findListener(listeners, 'agent/request');
    const seed = { provider: 'deepseek', model: 'deepseek-chat' };
    const nextSeed = await callListener(
      reqListener,
      { turn: 1, step: 1, signal: new AbortController().signal },
      async () => seed,
    );
    expect(nextSeed).toEqual(seed);
  });

  it('immediately + upstream={retry} → 仍立即切换并返回 {kind: "retry"}', async () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['deepseek/deepseek-chat', 'openai/gpt-4o'],
      fallbackWhen: 'immediately',
      baseDelayMs: 100,
      maxDelayMs: 500,
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
      async () => ({ kind: 'retry' as const }),
    );
    expect(result).toEqual({ kind: 'retry' });

    // 状态已推进:seed 被改写为下一候选
    const reqListener = findListener(listeners, 'agent/request');
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

  it('链耗尽 → 透传 upstream(undefined)并标记 exhausted', async () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['a/x'], // 单项链 → 失败一次即耗尽
    });
    const errListener = findListener(listeners, 'agent/request-error');
    const result = await callListener(
      errListener,
      {
        turn: 1,
        step: 1,
        provider: 'a',
        failure: stubFailure('RATE_LIMIT'),
        signal: new AbortController().signal,
      },
      async () => undefined,
    );
    expect(result).toBeUndefined();
  });

  it('afterRetry 连续失败按链顺序切:deepseek → openai → anthropic', async () => {
    const { ctx, listeners } = stubCtx();
    apply(ctx, {
      fallbackChains: ['deepseek/x', 'openai/y', 'anthropic/z'],
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    const errListener = findListener(listeners, 'agent/request-error');
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
        failure: stubFailure('SERVER_ERROR'),
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
      'fallbackWhen',
      'maxRetries',
      'baseDelayMs',
      'maxDelayMs',
      'retryableCodes',
      'perTurn',
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
      fallbackWhen: wrap('immediately'),
    });
    expect(resolved.enabled).toBe(true);
    expect(resolved.chain).toEqual([
      { provider: 'deepseek', model: 'deepseek-chat' },
      { provider: 'openai', model: 'gpt-4o' },
    ]);
    expect(resolved.maxRetries).toBe(2);
    expect(resolved.fallbackWhen).toBe('immediately');
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
