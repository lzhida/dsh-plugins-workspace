import type { Context } from '@deepseek-ai/cordis';
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
    expect(recorded[1].input?.hint).toBe('<[N | 不限 |] 一句话目标>');
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

  it('显式轮次前缀被剥离后注入且草稿干净', () => {
    const { recorded } = stubCtx();
    const steerCalls: unknown[] = [];
    recorded[1].handler({
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

  it('只有前缀没有草稿返回 error 且不 steer', () => {
    const { recorded } = stubCtx();
    const steerCalls: unknown[] = [];
    const result = recorded[1].handler({
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
