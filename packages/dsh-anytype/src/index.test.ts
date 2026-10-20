/**
 * index.ts 装载契约测试：e2e 日志格式、注册面（enabled/disabledGroups）、
 * systemPrompt section 与清理链。ctx 用最小假体（effect 立即执行，
 * 与 dsh-llm-fallback 测试同一模式）。
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { apply, name, SECTION_NAME } from './index.ts';

/** apply 的最小 ctx 假体：effect 立即执行，注册面全量记录。 */
function stubCtx(): {
  ctx: Parameters<typeof apply>[0];
  registered: Array<{ name: string; dispose: () => void }>;
  sections: Array<{ name: string; order: number; text: string }>;
  cleanups: Array<() => void>;
} {
  const registered: Array<{ name: string; dispose: () => void }> = [];
  const sections: Array<{ name: string; order: number; text: string }> = [];
  const cleanups: Array<() => void> = [];
  const ctx = {
    effect(fn: () => unknown): void {
      const dispose = fn();
      if (typeof dispose === 'function') cleanups.push(dispose as () => void);
    },
    tools: {
      register(definition: { name: string }): () => void {
        const dispose = () => undefined;
        registered.push({ name: definition.name, dispose });
        return dispose;
      },
    },
    systemPrompt: {
      section(section: {
        name: string;
        order: number;
        text: string;
      }): () => void {
        sections.push(section);
        return () => undefined;
      },
    },
  };
  return {
    ctx: ctx as unknown as Parameters<typeof apply>[0],
    registered,
    sections,
    cleanups,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dsh-anytype', () => {
  it('apply 打印 [dsh-anytype] plugin loaded（e2e 装载契约）', () => {
    const { ctx } = stubCtx();
    apply(ctx, undefined);
    expect(console.log).toHaveBeenCalledWith(`[${name}] plugin loaded`);
  });

  it('默认配置注册 30 个工具 + 1 个指引 section，且 effect 清理链完整', () => {
    const { ctx, registered, sections, cleanups } = stubCtx();
    apply(ctx, undefined);
    expect(registered).toHaveLength(30);
    const names = registered.map((r) => r.name);
    expect(names).toContain('anytype_whoami');
    expect(names).toContain('anytype_status');
    expect(names).toContain('anytype_search');
    expect(names).toContain('anytype_create_property');
    expect(names).toContain('anytype_update_property');
    expect(names).toContain('anytype_delete_property');
    expect(names).toContain('anytype_request');
    // effect 数 = section 1（register 的 disposer 不走 effect）
    expect(sections).toHaveLength(1);
    expect(sections[0]?.name).toBe(SECTION_NAME);
    expect(sections[0]?.text).toContain('anytype_get_op_schema');
    expect(sections[0]?.text).toContain('anytype_status');
    // 卸载语义：cleanups 可重复调用且不抛
    expect(() => cleanups.forEach((d) => d())).not.toThrow();
  });

  it('enabled=false 不注册任何工具，但指引 section 照常注册并告知停用', () => {
    const { ctx, registered, sections } = stubCtx();
    apply(ctx, { enabled: false });
    expect(registered).toHaveLength(0);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.text).toContain('disabled');
    expect(console.log).toHaveBeenCalledWith(
      '[dsh-anytype] disabled by config; no tools registered',
    );
  });

  it('disabledGroups 过滤对应组的工具（search 组 2 个 + space 组 4 个）', () => {
    const { ctx, registered } = stubCtx();
    apply(ctx, { disabledGroups: ['search', 'space'] });
    expect(registered).toHaveLength(30 - 2 - 4);
    const names = registered.map((r) => r.name);
    expect(names).not.toContain('anytype_search');
    expect(names).not.toContain('anytype_list_objects');
    expect(names).not.toContain('anytype_list_spaces');
    expect(names).toContain('anytype_whoami');
  });

  it('非法配置不抛出（降级为默认并继续注册）', () => {
    const { ctx, registered } = stubCtx();
    // resolveConfig 从不抛；此用例锁定「坏输入不炸宿主」的行为面
    expect(() =>
      apply(ctx, { requestTimeoutMs: 'not-a-number' }),
    ).not.toThrow();
    expect(registered).toHaveLength(30);
  });

  it('Config schema 已导出（loader 投影设置面板的契约）', async () => {
    const mod = await import('./index.ts');
    expect(mod.Config).toBeDefined();
    expect(typeof mod.resolveConfig).toBe('function');
  });
});
