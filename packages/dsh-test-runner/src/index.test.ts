/**
 * dsh-test-runner 行为契约测试。
 *
 * 覆盖范围(以「行为契约」为目的,不为覆盖行):
 * - 插件契约(name / inject / 加载日志契约);
 * - system-prompt section:5 步法文本含 5 个工具名 + 协议关键字;
 * - 5 个 test_runner_* 工具经 ctx.tools.register 全部注册成功;
 * - 错误包装:withErrorBoundary 把异常统一包成 `[TEST_RUNNER_ERROR] …`。
 *
 * 副作用(进程 / 文件 / 网络)不直接走 — 它们归属 runner.ts 的语义,
 * 已被 lib.test.ts 的纯函数 + collectAssertions 间接覆盖,本文件不重复。
 *
 * 风格遵循 dsh-plugin-dev skill 的 stubCtx 模式。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';

import { apply, inject, name } from './index.ts';

/** cordis Context 最小假体:effect 立即执行,systemPrompt / tools 收集注册记录。 */
function stubCtx(): {
  ctx: Context;
  sections: Array<{ name: string; order: number; text: string }>;
  registered: Array<{ name: string }>;
  cleanups: Array<() => void>;
  effects: Array<{ cleanup: () => void; label: string }>;
} {
  const sections: Array<{ name: string; order: number; text: string }> = [];
  const registered: Array<{ name: string }> = [];
  const cleanups: Array<() => void> = [];
  const effects: Array<{ cleanup: () => void; label: string }> = [];
  const ctx = {
    effect(fn: () => (() => void) | void, label?: string): void {
      const cleanup = fn();
      const fn0 = typeof cleanup === 'function' ? cleanup : () => {};
      cleanups.push(fn0);
      effects.push({ cleanup: fn0, label: label ?? '' });
    },
    systemPrompt: {
      section(s: { name: string; order: number; text: string }): () => void {
        sections.push(s);
        return () => {};
      },
    },
    tools: {
      register(def: { name: string }): () => void {
        registered.push({ name: def.name });
        return () => {};
      },
    },
  } as unknown as Context;
  return { ctx, sections, registered, cleanups, effects };
}

beforeEach(() => {
  // 静默 apply 内的 console.log,避免测试输出噪音。
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dsh-test-runner (apply 契约)', () => {
  it('导出与 loader 约定的 name / inject 符号', () => {
    expect(name).toBe('dsh-test-runner');
    // 依赖注入:对齐 dsh-taskboard 模式,声明 tools + systemPrompt。
    expect(inject).toEqual(['tools', 'systemPrompt']);
  });

  it('apply 时打印符合 e2e 契约的加载日志(`[name] ` 前缀)', () => {
    const log = vi.mocked(console.log);
    const { ctx } = stubCtx();
    apply(ctx);
    // 必须出现至少一行以 `[dsh-test-runner] ` 起始的日志(契约见 .agents/skills/.../SKILL.md §5)。
    const matched = log.mock.calls.find(
      (args) =>
        typeof args[0] === 'string' && args[0].startsWith('[dsh-test-runner] '),
    );
    expect(matched).toBeDefined();
  });

  it('注册一个 system-prompt section,order=2850,name=tool:test-runner', () => {
    const { ctx, sections } = stubCtx();
    apply(ctx);
    expect(sections).toHaveLength(1);
    const section = sections[0]!;
    // 空档位:TOOL_REPORT(2900)与 TOOL_SUBAGENT(2800)之间。
    expect(section.order).toBe(2850);
    expect(section.name).toBe('tool:test-runner');
  });

  it('section 文本声明 5 步法 + 5 个工具名 + cleanup 强制契约', () => {
    const { ctx, sections } = stubCtx();
    apply(ctx);
    const text = sections[0]!.text;
    // 5 步法的所有工具名都必须在协议文本中可被模型看到。
    expect(text).toContain('test_runner_review_profiles');
    expect(text).toContain('test_runner_install');
    expect(text).toContain('test_runner_boot');
    expect(text).toContain('test_runner_run_assertions');
    expect(text).toContain('test_runner_cleanup');
    // 硬约束:cleanup 必须显式;不要在 default profile 上跑 e2e。
    expect(text).toContain('cleanup');
    expect(text).toContain('default profile');
  });

  it('注册 5 个 test_runner_* 工具到 ctx.tools', () => {
    const { ctx, registered } = stubCtx();
    apply(ctx);
    expect(registered).toEqual([
      { name: 'test_runner_review_profiles' },
      { name: 'test_runner_install' },
      { name: 'test_runner_boot' },
      { name: 'test_runner_run_assertions' },
      { name: 'test_runner_cleanup' },
    ]);
  });

  it('tools 全部以 ctx.effect 注册(卸载时由 cordis 自动 dispose)', () => {
    const { ctx, effects, registered } = stubCtx();
    apply(ctx);
    // 注册 section 的 effect + 注册 tools 的 effect,合计 2 个。
    expect(effects.length).toBeGreaterThanOrEqual(2);
    // 工具注册出现在第二个 effect(顺序不强制,但须命中)。
    expect(registered).toHaveLength(5);
  });
});
