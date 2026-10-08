import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { apply, inject, name, resolveLanguage } from './index.ts';
import { buildClarifyMessage, userText } from './protocol.ts';

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

/** settings 服务的最小假体:只有 describe 一条读路径。 */
interface SettingsStub {
  describe(): Array<{ value?: unknown }>;
}

/** 最小 cordis Context 假体:effect 立即执行,register 记录命令并返回 disposer。 */
function stubCtx(options: { settings?: SettingsStub } = {}): {
  ctx: Context;
  registered: RecordedCommand[];
  cleanups: Array<() => void>;
} {
  const registered: RecordedCommand[] = [];
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
    ...(options.settings === undefined ? {} : { settings: options.settings }),
  } as unknown as Context;
  return { ctx, registered, cleanups };
}

describe('dsh-guided-goal 契约', () => {
  it('导出插件名(loader 依赖)', () => {
    expect(name).toBe('dsh-guided-goal');
  });

  it('inject 声明仅依赖 commands(settings 服务不再需要)', () => {
    expect(inject).toEqual(['commands']);
  });

  it('装载时输出 [dsh-guided-goal] plugin loaded(e2e 契约)', () => {
    const logSpy = vi.mocked(console.log);
    const { ctx } = stubCtx();
    apply(ctx);
    expect(logSpy).toHaveBeenCalledWith(`[${name}] plugin loaded`);
  });

  it('默认配置注册 guided-goal 命令且文案为双语兜底', () => {
    const { ctx, registered } = stubCtx();
    apply(ctx);
    expect(registered.map((r) => r.name)).toEqual(['guided-goal']);
    const desc = registered[0].description ?? '';
    expect(desc).toContain('Guided goal creation');
    expect(desc).toContain('引导式创建');
    expect(desc).toContain('·');
  });

  it('enabled 为 false 时不注册任何命令', () => {
    const { ctx, registered } = stubCtx();
    apply(ctx, { enabled: false });
    expect(registered).toHaveLength(0);
  });

  it('language 为 zh 时命令描述为中文单语言', () => {
    const { ctx, registered } = stubCtx();
    apply(ctx, { language: 'zh' });
    const desc = registered[0].description ?? '';
    expect(desc).toContain('引导式创建');
    expect(desc).not.toContain('Guided goal creation');
    expect(desc).not.toContain('·');
  });

  it('language 为 auto 时跟随 settings describe 返回的 en 偏好', () => {
    const { ctx, registered } = stubCtx({
      settings: { describe: () => [{ value: { preference: 'en' } }] },
    });
    apply(ctx, { language: 'auto' });
    const desc = registered[0].description ?? '';
    expect(desc).toContain('Guided goal creation');
    expect(desc).not.toContain('引导式创建');
  });

  it('language 为 auto 时扫描到任一 descriptor 的 zh 偏好同样生效', () => {
    const { ctx, registered } = stubCtx({
      settings: {
        describe: () => [
          { value: { unrelated: true } },
          { value: { preference: 'zh' } },
        ],
      },
    });
    apply(ctx);
    expect(registered[0].description).toContain('引导式创建');
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

  it('命令 hint 为语法性占位符,不随语言翻译', () => {
    const { ctx, registered } = stubCtx();
    apply(ctx, { language: 'zh' });
    expect(registered[0].input?.hint).toBe('[<draft>]');
  });
});

describe('dsh-guided-goal 命令 handler', () => {
  it('空草稿返回 error 用法提示且不 steer', () => {
    const { ctx, registered } = stubCtx();
    apply(ctx);
    const steer = vi.fn();
    const result = registered[0].handler({ agent: { steer }, rawInput: '   ' });
    expect(result.kind).toBe('error');
    expect(result.text).toContain('用法');
    expect(steer).not.toHaveBeenCalled();
  });

  it('非空草稿 steer 协议消息并返回 success', () => {
    const { ctx, registered } = stubCtx();
    apply(ctx);
    const steer = vi.fn();
    const result = registered[0].handler({
      agent: { steer },
      rawInput: ' 重构鉴权模块 ',
    });
    expect(result.kind).toBe('success');
    expect(steer).toHaveBeenCalledTimes(1);
    const message = steer.mock.calls[0][0] as {
      role: string;
      source: { kind: string; form: string };
      content: Array<{ text?: string }>;
    };
    expect(message.role).toBe('user');
    expect(message.source).toEqual({
      kind: 'guided-goal',
      form: 'instructions',
    });
    expect(message.content[0]?.text).toContain('引导方式创建');
    expect(message.content[0]?.text).toContain('重构鉴权模块');
  });

  it('en 固定语言下协议消息为英文且不含中文协议正文', () => {
    const { ctx, registered } = stubCtx();
    apply(ctx, { language: 'en' });
    const steer = vi.fn();
    registered[0].handler({ agent: { steer }, rawInput: 'refactor auth' });
    const text =
      (steer.mock.calls[0][0] as { content: Array<{ text?: string }> })
        .content[0]?.text ?? '';
    expect(text).toContain('Follow this protocol strictly');
    expect(text).toContain('Clarify five fields in order');
    expect(text).not.toContain('请严格按以下协议执行');
    expect(text).toContain('refactor auth');
  });
});

describe('dsh-guided-goal 协议消息', () => {
  it('userText 构造 user 角色、guided-goal 来源的文本消息', () => {
    const message = userText('内容');
    expect(message.role).toBe('user');
    expect(message.source).toEqual({
      kind: 'guided-goal',
      form: 'instructions',
    });
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
    expect(text.endsWith('重构鉴权模块')).toBe(true);
  });
});
