import type { Context } from '@deepseek-ai/cordis';
import type { GuidedGoalConfig } from './index.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply, inject, name } from './index.ts';
import { buildClarifyMessage, userText } from './protocol.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

interface CommandHandlerInput {
  agent: { steer(message: unknown): void };
  rawInput: string;
  signal?: AbortSignal;
}

interface RecordedCommand {
  name: string;
  description?: string;
  input?: { hint?: string };
  handler(input: CommandHandlerInput): { kind: string; text?: string };
}

interface RegisterRecord {
  def: RecordedCommand;
  dispose: ReturnType<typeof vi.fn>;
}

interface StubState {
  registered: RegisterRecord[];
  cleanups: Array<() => void>;
  settingsNs: string | null;
  notify(next: GuidedGoalConfig): void;
}

function stubCtx(
  initial: GuidedGoalConfig,
  localePreference?: 'zh' | 'en',
): StubState & {
  emitLocaleUpdate(preference: 'zh' | 'en' | undefined): void;
  localeWatchers: Array<(ns: string) => void>;
} {
  const registered: RegisterRecord[] = [];
  const cleanups: Array<() => void> = [];
  let settingsNs: string | null = null;
  let watcher: ((next: GuidedGoalConfig) => void) | null = null;
  let current = initial;
  let currentPreference: string | undefined = localePreference;
  const localeWatchers: Array<(ns: string) => void> = [];
  const ctx = {
    effect(fn: () => (() => void) | void): void {
      const cleanup = fn();
      if (cleanup) cleanups.push(cleanup);
    },
    commands: {
      register(def: RecordedCommand): () => void {
        const dispose = vi.fn();
        registered.push({ def, dispose });
        return () => dispose();
      },
    },
    settings: {
      register(ns: string): {
        get(): GuidedGoalConfig;
        watch(cb: (next: GuidedGoalConfig) => void): () => void;
      } {
        settingsNs = ns;
        return {
          get: () => current,
          watch: (cb) => {
            watcher = cb;
            return () => {
              watcher = null;
            };
          },
        };
      },
      get(ns: string): { preference?: string } | undefined {
        return ns === 'locale' ? { preference: currentPreference } : undefined;
      },
    },
    on(event: string, cb: (ns: string) => void): () => void {
      if (event === 'settings/updated') localeWatchers.push(cb);
      return () => {};
    },
  } as unknown as Context;
  apply(ctx);
  const state: StubState & {
    emitLocaleUpdate(preference: 'zh' | 'en' | undefined): void;
    localeWatchers: Array<(ns: string) => void>;
  } = {
    registered,
    cleanups,
    settingsNs,
    localeWatchers,
    notify(next: GuidedGoalConfig) {
      current = next;
      watcher?.(next);
    },
    emitLocaleUpdate(pref: 'zh' | 'en' | undefined) {
      currentPreference = pref;
      for (const cb of localeWatchers) cb('locale');
    },
  };
  return state;
}

describe('dsh-guided-goal 契约', () => {
  it('导出插件名(loader 依赖)', () => {
    expect(name).toBe('dsh-guided-goal');
  });

  it('inject 声明 commands 与 settings', () => {
    expect(inject).toEqual(['commands', 'settings']);
  });

  it('settings namespace 保持 guided-goal(用户面不变)', () => {
    const state = stubCtx({ enabled: true });
    expect(state.settingsNs).toBe('guided-goal');
  });

  it('启用时注册 guided-goal 命令,副作用进 effect 清理', () => {
    const state = stubCtx({ enabled: true });
    expect(state.registered.map((r) => r.def.name)).toEqual(['guided-goal']);
    expect(state.cleanups).toHaveLength(1);
  });

  it('关闭时不注册任何命令', () => {
    const state = stubCtx({ enabled: false });
    expect(state.registered).toHaveLength(0);
  });

  it('旧字段缺失(剥离后 undefined)时默认启用', () => {
    const state = stubCtx({} as GuidedGoalConfig);
    expect(state.registered.map((r) => r.def.name)).toEqual(['guided-goal']);
  });

  it('watch 到开关变化时注销并重注册命令', () => {
    const state = stubCtx({ enabled: true });
    expect(state.registered).toHaveLength(1);
    state.notify({ enabled: false });
    expect(state.registered).toHaveLength(1); // 1 旧(已注销) + 0 新
    expect(state.registered[0].dispose.mock.calls.length).toBe(1);
    state.notify({ enabled: true });
    expect(state.registered).toHaveLength(2); // 1 旧(首次 notify 已注销) + 1 新
    expect(state.registered[0].dispose.mock.calls.length).toBe(1);
    expect(state.registered[1].dispose.mock.calls.length).toBe(0);
  });

  it('命令 hint 全英文(语法性占位符不翻译)', () => {
    const state = stubCtx({ enabled: true });
    for (const r of state.registered) {
      expect(r.def.input?.hint).not.toMatch(/[\u4e00-\u9fff]/);
    }
    expect(state.registered[0].def.input?.hint).toBe('[<draft>]');
  });

  it('en 语言态下协议消息为英文且不含中文协议正文', () => {
    const state = stubCtx({ enabled: true }, 'en');
    const handler = state.registered[0].def.handler;
    const steer = vi.fn();
    handler({
      agent: { steer },
      rawInput: '重构鉴权模块',
    } as unknown as Parameters<typeof handler>[0]);
    const text = (steer.mock.calls[0][0].content[0] as { text: string }).text;
    expect(text).toContain('Follow this protocol strictly');
    expect(text).toContain('Clarify five fields in order');
    expect(text).not.toContain('请严格按以下协议执行');
    expect(text).toContain('重构鉴权模块'); // 草稿原文保留
  });

  it('跟随官方语言配置:locale preference 驱动命令文案语言', () => {
    const zh = stubCtx({ enabled: true }, 'zh');
    const zhDesc = zh.registered[0].def.description ?? '';
    expect(zhDesc).toContain('引导式创建');
    expect(zhDesc).not.toContain('Guided goal creation');

    const en = stubCtx({ enabled: true }, 'en');
    const enDesc = en.registered[0].def.description ?? '';
    expect(enDesc).toContain('Guided goal creation');
    expect(enDesc).not.toContain('引导式创建');

    const auto = stubCtx({ enabled: true });
    const autoDesc = auto.registered[0].def.description ?? '';
    expect(autoDesc).toContain('Guided goal creation');
    expect(autoDesc).toContain('引导式创建');
  });

  it('settings/updated(locale) 时运行时切换命令文案', () => {
    const state = stubCtx({ enabled: true });
    const before = state.registered[0].def.description ?? '';
    expect(before).toContain('·'); // 双语兜底

    state.emitLocaleUpdate('zh');
    expect(state.registered).toHaveLength(2); // dispose + re-register ×1
    const after = state.registered[1].def.description ?? '';
    expect(after).toContain('引导式创建');
    expect(after).not.toContain('Guided goal creation');
  });

  it('userText 构造 user 角色、user 来源的文本消息', () => {
    const message = userText('内容');
    expect(message.role).toBe('user');
    expect(message.source).toEqual({ kind: 'user' });
    expect(message.content).toHaveLength(1);
  });

  it('buildClarifyMessage 携带协议关键约束与用户草稿', () => {
    const message = buildClarifyMessage(' 重构鉴权模块 ');
    const text = (message.content[0] as { text: string }).text;
    expect(text).toContain('create_goal');
    expect(text).toContain('本回合立即结束');
    expect(text).toContain('完成后输出总结');
    expect(text).toContain('修改文件清单');
    expect(text).toContain('一次只问一个');
    expect(text).toContain('唯一可跳过访谈的情形');
    expect(text).toContain('重构鉴权模块');
    expect(text.endsWith('重构鉴权模块')).toBe(true);
  });
});

describe('/guided-goal 命令', () => {
  it('带草稿时 steer 一条含协议与草稿的 user 消息并返回 success', () => {
    const state = stubCtx({ enabled: true });
    const steerCalls: unknown[] = [];
    const result = state.registered[0].def.handler({
      agent: {
        steer(message: unknown): void {
          steerCalls.push(message);
        },
      },
      rawInput: ' 重构鉴权模块 ',
    });

    expect(result.kind).toBe('success');
    expect(steerCalls).toHaveLength(1);
    const message = steerCalls[0] as {
      role: string;
      source: { kind: string };
      content: Array<{ text?: string }>;
    };
    expect(message.role).toBe('user');
    expect(message.source.kind).toBe('user');
    expect(message.content[0]?.text).toContain('引导方式创建');
    expect(message.content[0]?.text).toContain('重构鉴权模块');
  });

  it('空草稿返回 error 且不 steer', () => {
    const state = stubCtx({ enabled: true });
    const steerCalls: unknown[] = [];
    const result = state.registered[0].def.handler({
      agent: {
        steer(message: unknown): void {
          steerCalls.push(message);
        },
      },
      rawInput: '   ',
    });

    expect(result.kind).toBe('error');
    expect(result.text).toContain('用法');
    expect(steerCalls).toHaveLength(0);
  });
});
