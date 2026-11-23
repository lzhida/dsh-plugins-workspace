import { afterEach, describe, expect, it, vi } from 'vitest';

import { apply, name, SECTION_NAME, SECTION_ORDER } from './board-context.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dsh-kanban-mode 看板上下文入口', () => {
  it('注册 order=185 的系统提示段落', () => {
    const section = vi.fn().mockReturnValue(() => {});
    apply({ systemPrompt: { section } });
    expect(section).toHaveBeenCalledTimes(1);
    const definition = section.mock.calls[0]![0] as {
      name: string;
      order: number;
      text: () => string;
    };
    expect(definition.name).toBe(SECTION_NAME);
    expect(definition.name).toBe('kanban-mode:context');
    expect(definition.order).toBe(SECTION_ORDER);
    expect(definition.order).toBe(185);
    expect(definition.text()).toContain('【看板模式工作法】');
  });

  it('systemPrompt 服务缺失时只告警不抛错', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => apply({})).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('systemPrompt');
  });

  it('存在 effect 时用 effect 注销段落', () => {
    const section = vi.fn().mockReturnValue(() => {});
    const effect = vi.fn();
    apply({ systemPrompt: { section }, effect });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(typeof effect.mock.calls[0]![0]).toBe('function');
  });

  it('插件名符合宿主 loader 约定', () => {
    expect(name).toBe('kanban-board-context');
  });
});
