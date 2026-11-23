import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  KANBAN_TOOL_NAMES,
  registerKanbanTools,
  type KanbanToolsContext,
} from './register.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dsh-kanban-mode tools：注册入口', () => {
  it('KANBAN_TOOL_NAMES 与四个工具一一对应', () => {
    expect([...KANBAN_TOOL_NAMES]).toEqual([
      'kanban_ready_cards',
      'kanban_plan_check',
      'kanban_schedule_run',
      'taskboard_harvest',
    ]);
  });

  it('tools 服务缺失时 warn 后跳过全部工具注册', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    registerKanbanTools({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('tools 服务不可用');
    expect(
      log.mock.calls.some((call) => String(call[0]).includes('registered')),
    ).toBe(false);
  });

  it('四个工具逐个注册到宿主 tools 注册表并打固定成功日志', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const register = vi.fn();
    registerKanbanTools({ tools: { register } });
    expect(register).toHaveBeenCalledTimes(4);
    const names = register.mock.calls.map(
      (call) => (call[0] as { name: string }).name,
    );
    expect(names).toEqual([...KANBAN_TOOL_NAMES]);
    expect(
      log.mock.calls.some((call) =>
        String(call[0]).includes('[dsh-kanban-mode] registered 4 kanban tools'),
      ),
    ).toBe(true);
  });

  it('每个工具定义形状对齐 vendored sdk 契约（name/description/parameters/output/execute）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const register = vi.fn();
    registerKanbanTools({ tools: { register } });
    for (const call of register.mock.calls) {
      const tool = call[0] as {
        name: string;
        description: string;
        parameters: unknown;
        output: { schema: unknown; render: unknown };
        execute: unknown;
      };
      expect(typeof tool.name).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toMatchObject({ type: 'object' });
      expect(tool.output).toHaveProperty('schema');
      expect(typeof tool.output.render).toBe('function');
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('单个工具注册失败只 warn 该工具，其余照常注册', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const register = vi.fn((tool: { name: string }) => {
      if (tool.name === 'kanban_plan_check') {
        throw new Error('duplicate tool');
      }
    });
    registerKanbanTools({ tools: { register } });
    expect(
      warn.mock.calls.some((call) =>
        String(call[0]).includes('kanban_plan_check'),
      ),
    ).toBe(true);
    expect(String(warn.mock.calls[0]![0])).toContain('duplicate tool');
    expect(
      log.mock.calls.some((call) =>
        String(call[0]).includes('[dsh-kanban-mode] registered 3 kanban tools'),
      ),
    ).toBe(true);
  });

  it('注册上下文的 ctx.get 面随工具闭包传递（execute 可软读取板服务）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const register = vi.fn();
    const ctx: KanbanToolsContext = {
      tools: { register },
      get: () => undefined,
    };
    registerKanbanTools(ctx);
    const readyCards = register.mock.calls[0]![0] as {
      execute: (args: unknown, exec: unknown) => Promise<unknown>;
    };
    // ctx.get 返回 undefined → 板服务缺失的可操作错误（证明软读取面已传入）。
    await expect(readyCards.execute({}, undefined)).rejects.toThrowError(
      'dsh-taskboard 服务不可用',
    );
  });
});
