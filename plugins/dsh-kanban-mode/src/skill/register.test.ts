import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildKanbanTaskCreateSkillSpec,
  describeError,
  registerKanbanTaskCreateSkill,
  SKILL_CONTENT,
  SKILL_DESCRIPTION,
  SKILL_NAME,
} from './register.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dsh-kanban-mode 内嵌 skill 注册', () => {
  it('spec 的 name/source/content/invocation 符合内嵌 skill 契约', async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    await registerKanbanTaskCreateSkill({ skills: { register } });
    expect(register).toHaveBeenCalledTimes(1);
    const spec = register.mock.calls[0]![0] as Record<string, unknown>;
    expect(spec['name']).toBe(SKILL_NAME);
    expect(spec['name']).toBe('kanban-task-create');
    expect(spec['description']).toBe(SKILL_DESCRIPTION);
    expect(spec['source']).toBe('bundled');
    expect(spec['content']).toBe(SKILL_CONTENT);
    expect(spec['invocation']).toEqual({
      modelInvocable: true,
      userInvocable: true,
    });
  });

  it('skills 服务缺失时只告警不注册', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const register = vi.fn();
    await expect(registerKanbanTaskCreateSkill({})).resolves.toBeUndefined();
    expect(register).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('skills');
  });

  it('register 返回的 Promise 被拒时只告警不抛出', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const register = vi.fn().mockRejectedValue(new Error('duplicate skill'));
    await expect(
      registerKanbanTaskCreateSkill({ skills: { register } }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('duplicate skill');
  });

  it('register 同步抛错时也只告警不抛出', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const register = vi.fn(() => {
      throw new Error('sync boom');
    });
    await expect(
      registerKanbanTaskCreateSkill({ skills: { register } }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('sync boom');
  });

  it('buildKanbanTaskCreateSkillSpec 每次返回新对象', () => {
    const first = buildKanbanTaskCreateSkillSpec();
    const second = buildKanbanTaskCreateSkillSpec();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  it('describeError 兼容 Error 与非 Error', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError('plain')).toBe('plain');
  });
});
