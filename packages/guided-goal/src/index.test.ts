import type { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply, inject, name } from './index.ts';
import {
  buildClarifyMessage,
  buildQuickCreateMessage,
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

describe('guided-goal 契约', () => {
  it('导出插件名(loader 依赖)', () => {
    expect(name).toBe('guided-goal');
  });

  it('inject 只声明 commands(纯会话命令插件)', () => {
    expect(inject).toEqual(['commands']);
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
});

function stubCtx(): {
  recorded: RecordedCommand[];
  cleanups: Array<() => void>;
  ctx: Context;
} {
  const recorded: RecordedCommand[] = [];
  const cleanups: Array<() => void> = [];
  const ctx = {
    effect(fn: () => (() => void) | void): void {
      const cleanup = fn();
      if (cleanup) cleanups.push(cleanup);
    },
    commands: {
      register(def: RecordedCommand): () => void {
        recorded.push(def);
        return () => {};
      },
    },
  } as unknown as Context;
  apply(ctx);
  return { recorded, cleanups, ctx };
}

describe('/guided-goal 命令', () => {
  it('注册 guided-goal 与 quick-goal 两条命令,副作用进 effect 清理', () => {
    const { recorded, cleanups } = stubCtx();
    expect(recorded).toHaveLength(2);
    expect(recorded[0].name).toBe('guided-goal');
    expect(recorded[0].input?.hint).toBe('<草稿目标>');
    expect(recorded[1].name).toBe('quick-goal');
    expect(recorded[1].input?.hint).toBe('<一句话目标>');
    expect(cleanups).toHaveLength(2);
  });

  it('带草稿时 steer 一条含协议与草稿的 user 消息并返回 success', () => {
    const { recorded } = stubCtx();
    const steerCalls: unknown[] = [];
    const result = recorded[0].handler({
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
    const { recorded } = stubCtx();
    const steerCalls: unknown[] = [];
    const result = recorded[0].handler({
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
  it('buildQuickCreateMessage 携带零提问/自填/标注假设/create_goal 约束与草稿', () => {
    const message = buildQuickCreateMessage(' 给仓库补 README ');
    const text = (message.content[0] as { text: string }).text;
    expect(text).toContain('不进行任何访谈');
    expect(text).toContain('自行推断五个字段');
    expect(text).toContain('假设');
    expect(text).toContain('create_goal');
    expect(text).toContain('max_goal_rounds');
    expect(text).toContain('无法安全推断');
    expect(text.endsWith('给仓库补 README')).toBe(true);
  });

  it('带草稿时 steer quick 协议消息并返回 success', () => {
    const { recorded } = stubCtx();
    const steerCalls: unknown[] = [];
    const result = recorded[1].handler({
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

  it('空草稿返回 error 且不 steer', () => {
    const { recorded } = stubCtx();
    const steerCalls: unknown[] = [];
    const result = recorded[1].handler({
      agent: {
        steer(message: unknown): void {
          steerCalls.push(message);
        },
      },
      rawInput: '',
    });

    expect(result.kind).toBe('error');
    expect(result.text).toContain('用法');
    expect(steerCalls).toHaveLength(0);
  });
});
