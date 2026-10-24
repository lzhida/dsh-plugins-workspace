/**
 * 记忆插件行（`src/entries/memory.ts`）契约测试：loader 三符号、装载期
 * 注册面、指引 section 文案、以及「依赖连接服务」这一 service 组合契约。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { describe, expect, it, vi } from 'vitest';

import { apply, inject, memoryGuidanceSection, name } from './memory.ts';
import { AnytypeService } from '../services/anytype.ts';

/** 最小 cordis 上下文假体：effect 立即执行，清理函数收集。 */
function stubCtx(options: { withService?: boolean } = {}): {
  ctx: Context;
  sections: PromptSection[];
  tools: ToolDefinition[];
  disposers: Array<() => void>;
} {
  const sections: PromptSection[] = [];
  const tools: ToolDefinition[] = [];
  const disposers: Array<() => void> = [];
  const ctx = {
    effect: (fn: () => (() => void) | void) => {
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
    },
    get: (key: string) =>
      key === 'anytype' && options.withService !== false
        ? new AnytypeService(() => ({
            baseUrl: 'http://127.0.0.1:31009',
            apiKey: '',
            apiVersion: '2025-11-08',
            requestTimeoutMs: 30_000,
            maxResponseChars: 20_000,
          }))
        : undefined,
    systemPrompt: {
      section: (section: PromptSection) => {
        sections.push(section);
        return () => {};
      },
    },
    tools: {
      register: (tool: ToolDefinition) => {
        tools.push(tool);
      },
    },
  } as unknown as Context;
  return { ctx, sections, tools, disposers };
}

describe('dsh-anytype-memory 插件行', () => {
  it('导出 loader 依赖的三符号', () => {
    expect(name).toBe('dsh-anytype-memory');
    expect(inject).toEqual(['tools', 'systemPrompt', 'anytype']);
    expect(typeof apply).toBe('function');
  });

  it('装载后注册 16 个工具并打印装载日志', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { ctx, tools } = stubCtx();
    apply(ctx);
    expect(tools).toHaveLength(16);
    expect(
      log.mock.calls.some((call) =>
        String(call[0]).includes('[dsh-anytype-memory] plugin loaded'),
      ),
    ).toBe(true);
    log.mockRestore();
  });

  it('总是注册指引 section，且文案点名关键契约', () => {
    const { ctx, sections } = stubCtx();
    apply(ctx);
    expect(sections).toHaveLength(1);
    const text = sections[0].text;
    expect(text).toContain('memory_setup');
    expect(text).toContain('memory_write');
    expect(text).toContain('memory_recall');
    expect(text).toContain('memory_set_embedding');
    expect(text).toContain('never');
  });

  it('enabled=false 时不注册工具但仍注册指引 section', () => {
    const { ctx, sections, tools } = stubCtx();
    apply(ctx, { enabled: false });
    expect(tools).toHaveLength(0);
    expect(sections).toHaveLength(1);
    expect(sections[0].text).toContain('disabled');
  });

  it('按 disabledGroups 过滤工具注册面', () => {
    const { ctx, tools } = stubCtx();
    apply(ctx, { disabledGroups: ['write', 'agent'] });
    expect(tools).toHaveLength(16 - 6 - 3);
    expect(tools.some((t) => t.name === 'memory_write')).toBe(false);
    expect(tools.some((t) => t.name === 'memory_recall')).toBe(true);
  });

  it('非法配置降级为默认而不是抛错', () => {
    const { ctx, tools } = stubCtx();
    expect(() => apply(ctx, { enabled: 'yes' })).not.toThrow();
    expect(tools.length).toBeGreaterThan(0);
  });

  it('连接服务缺失时抛出可操作的错误（不静默失败）', () => {
    const { ctx } = stubCtx({ withService: false });
    expect(() => apply(ctx)).toThrow(/anytype/);
  });

  it('卸载时 effect 注册的清理函数被调用', () => {
    const { ctx, disposers } = stubCtx();
    apply(ctx);
    expect(disposers.length).toBeGreaterThan(0);
    for (const dispose of disposers) expect(() => dispose()).not.toThrow();
  });

  it('指引 section 纯函数可单独调用', () => {
    const enabled = memoryGuidanceSection(true);
    const disabled = memoryGuidanceSection(false);
    expect(enabled.order).toBeGreaterThan(0);
    expect(enabled.text).not.toBe(disabled.text);
  });
});
