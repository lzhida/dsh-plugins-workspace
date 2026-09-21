import type { Context } from '@deepseek-ai/cordis';
import type { GuidedGoalConfig } from './index.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply, inject, name } from './index.ts';
import {
  buildClarifyMessage,
  buildQuickCreateMessage,
  parseQuickInput,
  userText,
} from './protocol.ts';

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

function stubCtx(initial: GuidedGoalConfig): StubState {
  const registered: RegisterRecord[] = [];
  const cleanups: Array<() => void> = [];
  let settingsNs: string | null = null;
  let watcher: ((next: GuidedGoalConfig) => void) | null = null;
  let current = initial;
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
    },
  } as unknown as Context;
  apply(ctx);
  return {
    registered,
    cleanups,
    settingsNs,
    notify(next: GuidedGoalConfig) {
      current = next;
      watcher?.(next);
    },
  };
}

describe('guided-goal 契约', () => {
  it('导出插件名(loader 依赖)', () => {
    expect(name).toBe('guided-goal');
  });

  it('inject 声明 commands 与 settings', () => {
    expect(inject).toEqual(['commands', 'settings']);
  });

  it('settings namespace 以插件名注册', () => {
    const state = stubCtx({ enabled: true, language: 'auto' });
    expect(state.settingsNs).toBe('guided-goal');
  });

  it('enabled=true 时注册两条命令,副作用进 effect 清理', () => {
    const state = stubCtx({ enabled: true, language: 'auto' });
    expect(state.registered.map((r) => r.def.name)).toEqual([
      'guided-goal',
      'quick-goal',
    ]);
    expect(state.cleanups).toHaveLength(1);
  });

  it('enabled=false 时不注册任何命令', () => {
    const state = stubCtx({ enabled: false, language: 'auto' });
    expect(state.registered).toHaveLength(0);
  });

  it('watch 到 enabled=false 时注销全部命令,恢复 true 时重注册', () => {
    const state = stubCtx({ enabled: true, language: 'auto' });
    expect(state.registered).toHaveLength(2);
    state.notify({ enabled: false, language: 'auto' });
    expect(
      state.registered.every((r) => r.dispose.mock.calls.length === 1),
    ).toBe(true);
    state.notify({ enabled: true, language: 'zh' });
    expect(state.registered).toHaveLength(4);
    expect(
      state.registered.slice(2).every((r) => r.dispose.mock.calls.length === 0),
    ).toBe(true);
  });

  it('language=zh 时命令描述为纯中文,auto 时为双语', () => {
    const zhState = stubCtx({ enabled: true, language: 'zh' });
    const zhDesc = zhState.registered[0].def.description ?? '';
    expect(zhDesc).toContain('引导式创建');
    expect(zhDesc).not.toContain('Guided goal creation');

    const autoState = stubCtx({ enabled: true, language: 'auto' });
    const autoDesc = autoState.registered[0].def.description ?? '';
    expect(autoDesc).toContain('Guided goal creation');
    expect(autoDesc).toContain('引导式创建');
  });

  it('命令 hint 全英文(语法性占位符不翻译)', () => {
    const state = stubCtx({ enabled: true, language: 'zh' });
    for (const r of state.registered) {
      expect(r.def.input?.hint).not.toMatch(/[\u4e00-\u9fff]/);
    }
    expect(state.registered[0].def.input?.hint).toBe('<draft>');
    expect(state.registered[1].def.input?.hint).toBe(
      '<[N | unlimited |] one-line goal>',
    );
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
    expect(text).toContain('一次只问一个');
    expect(text).toContain('重构鉴权模块');
    expect(text.endsWith('重构鉴权模块')).toBe(true);
  });

  it('buildQuickCreateMessage 携带零提问/自填/标注假设/create_goal 约束与草稿', () => {
    const message = buildQuickCreateMessage('给仓库补 README', {
      kind: 'estimate',
    });
    const text = (message.content[0] as { text: string }).text;
    expect(text).toContain('不进行任何访谈');
    expect(text).toContain('自行推断五个字段');
    expect(text).toContain('假设');
    expect(text).toContain('create_goal');
    expect(text).toContain('max_goal_rounds');
    expect(text).toContain('无法安全推断');
    expect(text.endsWith('给仓库补 README')).toBe(true);
  });

  it('parseQuickInput 解析三种输入形态', () => {
    expect(parseQuickInput('8 | 给 X 加功能')).toEqual({
      rounds: { kind: 'fixed', rounds: 8 },
      draft: '给 X 加功能',
    });
    expect(parseQuickInput('不限 | 给 X 加功能')).toEqual({
      rounds: { kind: 'unlimited' },
      draft: '给 X 加功能',
    });
    expect(parseQuickInput('Unlimited | 给 X 加功能')).toEqual({
      rounds: { kind: 'unlimited' },
      draft: '给 X 加功能',
    });
    expect(parseQuickInput(' 给 X 加功能 ')).toEqual({
      rounds: { kind: 'estimate' },
      draft: '给 X 加功能',
    });
  });

  it('parseQuickInput 非数字前缀视为草稿的一部分', () => {
    expect(parseQuickInput('重构 | 分隔符左侧没有轮次数字')).toEqual({
      rounds: { kind: 'estimate' },
      draft: '重构 | 分隔符左侧没有轮次数字',
    });
    expect(parseQuickInput('0 | 草稿')).toEqual({
      rounds: { kind: 'estimate' },
      draft: '0 | 草稿',
    });
  });

  it('三种轮次来源注入对应的协议约束', () => {
    const fixed = (
      buildQuickCreateMessage('草稿', { kind: 'fixed', rounds: 8 })
        .content[0] as { text: string }
    ).text;
    expect(fixed).toContain('用户显式指定,优先采用');
    const unlimited = (
      buildQuickCreateMessage('草稿', { kind: 'unlimited' }).content[0] as {
        text: string;
      }
    ).text;
    expect(unlimited).toContain('仅在用户明确要求时允许');
    const estimate = (
      buildQuickCreateMessage('草稿', { kind: 'estimate' }).content[0] as {
        text: string;
      }
    ).text;
    expect(estimate).toContain('禁止选择"不限轮次"');
    expect(estimate).toContain('小型改动(文案/单文件小修)2-3 轮');
    expect(estimate).toContain('大型(跨模块/架构性)8-10 轮');
  });
});

describe('/guided-goal 命令', () => {
  it('带草稿时 steer 一条含协议与草稿的 user 消息并返回 success', () => {
    const state = stubCtx({ enabled: true, language: 'en' });
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
    const state = stubCtx({ enabled: true, language: 'zh' });
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

describe('/quick-goal 命令', () => {
  it('带草稿时 steer quick 协议消息并返回 success', () => {
    const state = stubCtx({ enabled: true, language: 'auto' });
    const steerCalls: unknown[] = [];
    const result = state.registered[1].def.handler({
      agent: {
        steer(message: unknown): void {
          steerCalls.push(message);
        },
      },
      rawInput: ' 优化构建缓存 ',
    });

    expect(result.kind).toBe('success');
    expect(result.text).toContain('快速模式');
    expect(steerCalls).toHaveLength(1);
    const message = steerCalls[0] as {
      role: string;
      source: { kind: string };
      content: Array<{ text?: string }>;
    };
    expect(message.role).toBe('user');
    expect(message.source.kind).toBe('user');
    expect(message.content[0]?.text).toContain('不进行任何访谈');
    expect(message.content[0]?.text).toContain('优化构建缓存');
  });

  it('显式轮次前缀被剥离后注入且草稿干净', () => {
    const state = stubCtx({ enabled: true, language: 'auto' });
    const steerCalls: unknown[] = [];
    state.registered[1].def.handler({
      agent: {
        steer(message: unknown): void {
          steerCalls.push(message);
        },
      },
      rawInput: '3 | 修复登录超时',
    });
    const message = steerCalls[0] as { content: Array<{ text?: string }> };
    const text = message.content[0]?.text ?? '';
    expect(text).toContain('用户显式指定,优先采用');
    expect(text.endsWith('修复登录超时')).toBe(true);
    expect(text).not.toContain('3 |');
  });

  it('空草稿返回 error 且不 steer', () => {
    const state = stubCtx({ enabled: true, language: 'auto' });
    const steerCalls: unknown[] = [];
    const result = state.registered[1].def.handler({
      agent: {
        steer(message: unknown): void {
          steerCalls.push(message);
        },
      },
      rawInput: '',
    });

    expect(result.kind).toBe('error');
    expect(result.text).toContain('Usage');
    expect(steerCalls).toHaveLength(0);
  });

  it('只有前缀没有草稿返回 error 且不 steer', () => {
    const state = stubCtx({ enabled: true, language: 'auto' });
    const steerCalls: unknown[] = [];
    const result = state.registered[1].def.handler({
      agent: {
        steer(message: unknown): void {
          steerCalls.push(message);
        },
      },
      rawInput: '8 |   ',
    });

    expect(result.kind).toBe('error');
    expect(steerCalls).toHaveLength(0);
  });
});
