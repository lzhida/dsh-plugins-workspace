import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { apply, inject, name, resolveLanguage } from './index.ts';
import { createPlanGoalGuard } from './guard.ts';
import { buildPlanGoalMessage, userText } from './protocol.ts';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface CommandHandlerInput {
  agent: { steer(message: unknown): void };
  rawInput: string;
}

interface RecordedCommand {
  name: string;
  description?: string;
  input?: { hint?: string };
  handler(input: CommandHandlerInput): { kind: string; text?: string };
}

type RecordedGuard = (execution: {
  name: string;
  agent?: unknown;
}) => string | undefined;

/** settings 服务的最小假体:只有 describe 一条读路径。 */
interface SettingsStub {
  describe(): Array<{ value?: unknown }>;
}

/** planMode 服务的最小假体:get 可编程,set 记录调用序。 */
interface PlanModeStub {
  get(agent: unknown): { active: boolean; pending?: boolean };
  set(agent: unknown, active: boolean): string;
}

/** 最小 cordis Context 假体:effect 立即执行,register/guard 记录并返回 disposer。 */
function stubCtx(
  options: {
    settings?: SettingsStub;
    planMode?: PlanModeStub;
  } = {},
): {
  ctx: Context;
  registered: RecordedCommand[];
  guards: RecordedGuard[];
  cleanups: Array<() => void>;
} {
  const registered: RecordedCommand[] = [];
  const guards: RecordedGuard[] = [];
  const cleanups: Array<() => void> = [];
  const ctx = {
    effect(fn: () => (() => void) | void): void {
      const cleanup = fn();
      if (cleanup) cleanups.push(cleanup);
    },
    commands: {
      register(def: RecordedCommand): () => void {
        registered.push(def);
        return () => {};
      },
    },
    tools: {
      guard(guard: RecordedGuard): () => void {
        guards.push(guard);
        return () => {};
      },
    },
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.planMode === undefined ? {} : { planMode: options.planMode }),
  } as unknown as Context;
  return { ctx, registered, guards, cleanups };
}

describe('dsh-plan-goal 契约', () => {
  it('导出插件名(loader 依赖)', () => {
    expect(name).toBe('dsh-plan-goal');
  });

  it('inject 声明依赖 commands 与 tools(planMode 不注入,使用时探测)', () => {
    expect(inject).toEqual(['commands', 'tools']);
  });

  it('装载时输出 [dsh-plan-goal] plugin loaded(e2e 契约)', () => {
    const logSpy = vi.mocked(console.log);
    const { ctx } = stubCtx();
    apply(ctx);
    expect(logSpy).toHaveBeenCalledWith(`[${name}] plugin loaded`);
  });

  it('默认配置注册 plan-goal 命令与 create_goal 守卫各一个', () => {
    const { ctx, registered, guards } = stubCtx();
    apply(ctx);
    expect(registered.map((r) => r.name)).toEqual(['plan-goal']);
    expect(guards).toHaveLength(1);
  });

  it('guard 为 false 时不注册守卫,命令保留', () => {
    const { ctx, registered, guards } = stubCtx();
    apply(ctx, { guard: false });
    expect(registered).toHaveLength(1);
    expect(guards).toHaveLength(0);
  });

  it('enabled 为 false 时不注册命令,守卫保留', () => {
    const { ctx, registered, guards } = stubCtx();
    apply(ctx, { enabled: false });
    expect(registered).toHaveLength(0);
    expect(guards).toHaveLength(1);
  });

  it('命令 hint 为语法性占位符,不随语言翻译', () => {
    const { ctx, registered } = stubCtx();
    apply(ctx, { language: 'zh' });
    expect(registered[0].input?.hint).toBe('[<draft>]');
  });

  it('resolveLanguage 配置非 auto 时短路采用配置值', () => {
    const throwing = stubCtx({
      settings: {
        describe: () => {
          throw new Error('must not be called');
        },
      },
    });
    expect(resolveLanguage(throwing.ctx, 'zh')).toBe('zh');
    expect(resolveLanguage(throwing.ctx, 'en')).toBe('en');
    expect(resolveLanguage(throwing.ctx, 'auto')).toBe('auto');
  });

  it('settings 缺失或 describe 抛错时文案回退双语', () => {
    const missing = stubCtx();
    apply(missing.ctx);
    expect(missing.registered[0]?.description).toContain('·');

    const throwing = stubCtx({
      settings: {
        describe: () => {
          throw new Error('describe unavailable');
        },
      },
    });
    apply(throwing.ctx);
    expect(throwing.registered[0]?.description).toContain('·');
  });
});

describe('dsh-plan-goal 命令 handler', () => {
  it('空草稿返回 error 用法提示且不 set/不 steer', () => {
    const calls: string[] = [];
    const { ctx, registered } = stubCtx({
      planMode: {
        get: () => ({ active: false }),
        set: () => {
          calls.push('set');
          return 'queued';
        },
      },
    });
    apply(ctx);
    const steer = vi.fn((message: unknown) => {
      calls.push('steer');
      return message;
    });
    const result = registered[0].handler({ agent: { steer }, rawInput: '   ' });
    expect(result.kind).toBe('error');
    expect(result.text).toContain('用法');
    expect(calls).toEqual([]);
  });

  it('planMode 缺失返回 error 提示且不 set/不 steer(不绑架宿主)', () => {
    const { ctx, registered } = stubCtx();
    apply(ctx);
    const steer = vi.fn();
    const result = registered[0].handler({
      agent: { steer },
      rawInput: '重构鉴权模块',
    });
    expect(result.kind).toBe('error');
    expect(result.text).toContain('@deepseek-ai/dsh-plan-mode');
    expect(steer).not.toHaveBeenCalled();
  });

  it('非空草稿先 set(true) 再 steer 协议消息并返回 success', () => {
    const calls: string[] = [];
    const { ctx, registered } = stubCtx({
      planMode: {
        get: () => ({ active: false }),
        set: () => {
          calls.push('set');
          return 'queued';
        },
      },
    });
    apply(ctx);
    const steer = vi.fn((message: unknown) => {
      calls.push('steer');
      return message;
    });
    const result = registered[0].handler({
      agent: { steer },
      rawInput: ' 重构鉴权模块 ',
    });
    expect(result.kind).toBe('success');
    expect(result.text).toContain('exit_plan_mode');
    expect(calls).toEqual(['set', 'steer']);
    expect(steer).toHaveBeenCalledTimes(1);
    const message = steer.mock.calls[0][0] as {
      role: string;
      source: { kind: string; form: string };
      content: Array<{ text?: string }>;
    };
    expect(message.role).toBe('user');
    expect(message.source).toEqual({
      kind: 'plan-goal',
      form: 'instructions',
    });
    expect(message.content[0]?.text).toContain('## Objective');
    expect(message.content[0]?.text).toContain('exit_plan_mode');
    expect(message.content[0]?.text).toContain('create_goal');
    expect(message.content[0]?.text).toContain('Keep planning');
    expect(message.content[0]?.text).toContain('重构鉴权模块');
  });
});

describe('dsh-plan-goal create_goal 守卫', () => {
  /** 构造最小 ToolExecution 形状:守卫只读 name 与 agent。 */
  function execOf(name: string, agent?: unknown): ToolExecution {
    return { name, agent } as unknown as ToolExecution;
  }

  it('非 create_goal 调用一律放行(含 plan-active 下的 update_goal)', () => {
    const { ctx } = stubCtx();
    apply(ctx);
    const guard = createPlanGoalGuard(ctx, '拒绝');
    expect(guard(execOf('update_goal', { session: {} }))).toBeUndefined();
    expect(guard(execOf('exit_plan_mode', { session: {} }))).toBeUndefined();
  });

  it('无调用 agent 时放行(无会话上下文可读)', () => {
    const { ctx } = stubCtx();
    apply(ctx);
    const guard = createPlanGoalGuard(ctx, '拒绝');
    expect(guard(execOf('create_goal'))).toBeUndefined();
  });

  it('planMode 服务缺失时放行(fail-open,不绑架宿主)', () => {
    const { ctx } = stubCtx();
    apply(ctx);
    const guard = createPlanGoalGuard(ctx, '拒绝');
    expect(guard(execOf('create_goal', { session: {} }))).toBeUndefined();
  });

  it('plan-active 期间拒绝 create_goal 并返回可执行理由', () => {
    const { ctx } = stubCtx({
      planMode: {
        get: () => ({ active: true }),
        set: () => 'noop',
      },
    });
    const guard = createPlanGoalGuard(ctx, '拒绝');
    expect(guard(execOf('create_goal', { session: {} }))).toBe('拒绝');
  });

  it('切换 pending(未落盘)期间同样拒绝 create_goal', () => {
    const { ctx } = stubCtx({
      planMode: {
        get: () => ({ active: false, pending: true }),
        set: () => 'queued',
      },
    });
    const guard = createPlanGoalGuard(ctx, '拒绝');
    expect(guard(execOf('create_goal', { session: {} }))).toBe('拒绝');
  });

  it('计划非激活且无 pending 时放行(批准后同轮 create_goal 可通过)', () => {
    const { ctx } = stubCtx({
      planMode: {
        get: () => ({ active: false }),
        set: () => 'noop',
      },
    });
    const guard = createPlanGoalGuard(ctx, '拒绝');
    expect(guard(execOf('create_goal', { session: {} }))).toBeUndefined();
  });

  it('planMode.get 抛错时放行(fail-open,guard 是保险丝非主防御)', () => {
    const { ctx } = stubCtx({
      planMode: {
        get: () => {
          throw new Error('projection not ready');
        },
        set: () => 'noop',
      },
    });
    const guard = createPlanGoalGuard(ctx, '拒绝');
    expect(guard(execOf('create_goal', { session: {} }))).toBeUndefined();
  });

  it('apply 注册的守卫拦截 plan-active 下的 create_goal', () => {
    const { ctx, guards } = stubCtx({
      planMode: {
        get: () => ({ active: true }),
        set: () => 'queued',
      },
    });
    apply(ctx);
    expect(guards).toHaveLength(1);
    expect(guards[0](execOf('create_goal', { session: {} }))).toContain(
      'create_goal',
    );
  });
});

describe('dsh-plan-goal 协议消息', () => {
  it('userText 构造 user 角色、plan-goal 来源的文本消息', () => {
    const message = userText('内容');
    expect(message.role).toBe('user');
    expect(message.source).toEqual({
      kind: 'plan-goal',
      form: 'instructions',
    });
    expect(message.content).toHaveLength(1);
  });

  it('buildPlanGoalMessage 携带五字段块、审阅流程与用户草稿', () => {
    const message = buildPlanGoalMessage(' 重构鉴权模块 ');
    const text = (message.content[0] as { text: string }).text;
    expect(text).toContain('## Objective');
    expect(text).toContain('## Success criteria');
    expect(text).toContain('## Verification');
    expect(text).toContain('## Boundaries');
    expect(text).toContain('## Stop conditions');
    expect(text).toContain('exit_plan_mode');
    expect(text).toContain('Keep planning');
    expect(text).toContain('create_goal');
    expect(text).toContain('max_goal_rounds');
    expect(text.endsWith('重构鉴权模块')).toBe(true);
  });

  it('en 固定语言下协议消息为英文且不含中文协议正文', () => {
    const message = buildPlanGoalMessage('refactor auth', 'en');
    const text = (message.content[0] as { text: string }).text;
    expect(text).toContain('Follow this protocol strictly');
    expect(text).toContain('## Objective');
    expect(text).toContain('User draft intent:');
    expect(text).not.toContain('请严格按以下协议执行');
    expect(text.endsWith('refactor auth')).toBe(true);
  });
});
