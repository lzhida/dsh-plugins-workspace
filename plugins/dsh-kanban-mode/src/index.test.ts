import { afterEach, describe, expect, it, vi } from 'vitest';

import { apply, inject, name } from './index.ts';
import { SKILL_CONTENT, SKILL_NAME } from './skill/skill-content.ts';
import { KANBAN_TOOL_NAMES } from './tools/register.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dsh-kanban-mode 插件入口', () => {
  it('inject 数组含 agentPresets、skills 与 tools', () => {
    expect(inject).toContain('agentPresets');
    expect(inject).toContain('skills');
    expect(inject).toContain('tools');
  });

  it('装载日志符合 [name] 前缀约定', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await apply({
      agentPresets: { register: vi.fn().mockResolvedValue(undefined) },
      skills: { register: vi.fn().mockResolvedValue(undefined) },
      tools: { register: vi.fn() },
    });
    expect(
      log.mock.calls.some((call) => String(call[0]).startsWith(`[${name}] `)),
    ).toBe(true);
  });

  it('注册 id 为 kanban-mode 的预设', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const register = vi.fn().mockResolvedValue(undefined);
    await apply({
      agentPresets: { register },
      skills: { register: vi.fn().mockResolvedValue(undefined) },
      tools: { register: vi.fn() },
    });
    expect(register).toHaveBeenCalledTimes(1);
    const definition = register.mock.calls[0]![0] as {
      id: string;
      name: string;
      plugins: { id?: string; name: string }[];
    };
    expect(definition.id).toBe('kanban-mode');
    expect(definition.name).toBe('看板模式');
    expect(definition.plugins).toHaveLength(24);
  });

  it('apply 同时注册预设、内嵌 skill 与三工具', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registerPreset = vi.fn().mockResolvedValue(undefined);
    const registerSkill = vi.fn().mockResolvedValue(undefined);
    const registerTool = vi.fn();
    await apply({
      agentPresets: { register: registerPreset },
      skills: { register: registerSkill },
      tools: { register: registerTool },
    });
    expect(registerSkill).toHaveBeenCalledTimes(1);
    const spec = registerSkill.mock.calls[0]![0] as Record<string, unknown>;
    expect(spec['name']).toBe(SKILL_NAME);
    expect(spec['source']).toBe('bundled');
    expect(spec['content']).toBe(SKILL_CONTENT);
    // skill 注册发生在预设注册之后。
    expect(registerSkill.mock.invocationCallOrder[0]).toBeGreaterThan(
      registerPreset.mock.invocationCallOrder[0]!,
    );
    // 三工具全部注册，注册名与 KANBAN_TOOL_NAMES 一致，且发生在 skill 之后。
    expect(registerTool).toHaveBeenCalledTimes(3);
    const toolNames = registerTool.mock.calls.map(
      (call) => (call[0] as { name: string }).name,
    );
    expect(toolNames).toEqual([...KANBAN_TOOL_NAMES]);
    expect(registerTool.mock.invocationCallOrder[0]).toBeGreaterThan(
      registerSkill.mock.invocationCallOrder[0]!,
    );
  });

  it('三工具全部注册成功时打固定成功日志', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await apply({
      agentPresets: { register: vi.fn().mockResolvedValue(undefined) },
      skills: { register: vi.fn().mockResolvedValue(undefined) },
      tools: { register: vi.fn() },
    });
    expect(
      log.mock.calls.some((call) =>
        String(call[0]).includes('registered 3 kanban tools'),
      ),
    ).toBe(true);
  });

  it('agentPresets 服务缺失时预设跳过但 skill 与工具照常注册', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const registerSkill = vi.fn().mockResolvedValue(undefined);
    const registerTool = vi.fn();
    await expect(
      apply({
        skills: { register: registerSkill },
        tools: { register: registerTool },
      }),
    ).resolves.toBeUndefined();
    expect(String(warn.mock.calls[0]![0])).toContain('agentPresets');
    expect(registerSkill).toHaveBeenCalledTimes(1);
    expect(registerTool).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('skills 服务缺失时预设与工具照常注册、skill 只告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const registerPreset = vi.fn().mockResolvedValue(undefined);
    const registerTool = vi.fn();
    await expect(
      apply({
        agentPresets: { register: registerPreset },
        tools: { register: registerTool },
      }),
    ).resolves.toBeUndefined();
    expect(registerPreset).toHaveBeenCalledTimes(1);
    expect(registerTool).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('skills');
  });

  it('tools 服务缺失时三工具降级、预设与 skill 照常注册', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const registerPreset = vi.fn().mockResolvedValue(undefined);
    const registerSkill = vi.fn().mockResolvedValue(undefined);
    await expect(
      apply({
        agentPresets: { register: registerPreset },
        skills: { register: registerSkill },
      }),
    ).resolves.toBeUndefined();
    expect(registerPreset).toHaveBeenCalledTimes(1);
    expect(registerSkill).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('tools');
  });

  it('三个服务都缺失时只告警不抛错', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(apply({})).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0]![0])).toContain('agentPresets');
    expect(String(warn.mock.calls[1]![0])).toContain('skills');
    expect(String(warn.mock.calls[2]![0])).toContain('tools');
  });

  it('预设注册失败时只告警且 skill 与工具照常注册', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const registerPreset = vi
      .fn()
      .mockRejectedValue(new Error('Duplicate agent preset: kanban-mode'));
    const registerSkill = vi.fn().mockResolvedValue(undefined);
    const registerTool = vi.fn();
    await expect(
      apply({
        agentPresets: { register: registerPreset },
        skills: { register: registerSkill },
        tools: { register: registerTool },
      }),
    ).resolves.toBeUndefined();
    expect(
      warn.mock.calls.some((call) =>
        String(call[0]).includes('Duplicate agent preset'),
      ),
    ).toBe(true);
    expect(registerSkill).toHaveBeenCalledTimes(1);
    expect(registerTool).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
