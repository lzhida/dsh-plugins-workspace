import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply, inject, name, TOTAL_TOOL_COUNT } from './index.js';
import { SKILL_NAME } from './skill-content.ts';
import { COMPOUND_TOOL_SPECS } from './tools/compound/index.ts';
import { REST_TOOL_SPECS } from './tools/standalone/index.ts';

interface StubCtx {
  tools: { register: ReturnType<typeof vi.fn> };
  skills: { register: ReturnType<typeof vi.fn> };
  /** webServer 桩：插件若（回归）去注册路由，这里会被调用而不是意外 TypeError。 */
  webServer: { register: ReturnType<typeof vi.fn> };
  effect: ReturnType<typeof vi.fn>;
  inject: ReturnType<typeof vi.fn>;
  log: string[];
}

/** 最小模拟 cordis Context：只实现 tools/skills 的 register、effect 与日志收集。 */
function stubCtx(): StubCtx {
  const log: string[] = [];
  const ctx: StubCtx = {
    log,
    effect: vi.fn(),
    // 模拟 cordis 的 ctx.inject：声明的服务全部就绪才执行回调；缺服务则子 fiber
    // 挂起（回调不执行），父插件照常 active。
    inject: vi.fn((deps: string[], callback: (childCtx: StubCtx) => void) => {
      const missing = deps.filter((name) => !(name in ctx));
      if (missing.length > 0) {
        log.push(`inject-pending:${missing.join(',')}`);
        return;
      }
      callback(Object.assign({}, ctx, { effect: ctx.effect }));
    }),
    tools: {
      register: vi.fn((tool: { name: string }) => {
        log.push(`register:${tool.name}`);
      }),
    },
    skills: {
      register: vi.fn((skill: { name: string }) => {
        log.push(`register-skill:${skill.name}`);
      }),
    },
    webServer: {
      register: vi.fn(() => {
        log.push('register-route');
      }),
    },
  };
  return ctx;
}

describe('dsh-victauri', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('name 与插件 kebab 名一致', () => {
    expect(name).toBe('dsh-victauri');
  });

  it('inject 只声明 tools 与 skills（插件无 web 面，不依赖 webServer）', () => {
    expect(inject).toEqual(['tools', 'skills']);
    expect(inject).not.toContain('webServer');
  });

  it('TOTAL_TOOL_COUNT 与 20+15+1+1+1+1 口径一致', () => {
    expect(TOTAL_TOOL_COUNT).toBe(
      REST_TOOL_SPECS.length + COMPOUND_TOOL_SPECS.length + 4,
    );
    expect(TOTAL_TOOL_COUNT).toBe(39);
  });

  it('apply 注册全量 39 工具并打印装载日志', () => {
    const ctx = stubCtx();
    vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      ctx.log.push(msg);
    });
    apply(ctx as never);
    expect(ctx.tools.register).toHaveBeenCalledTimes(39);
    expect(
      ctx.log.some((line) => line.startsWith(`[${name}] plugin loaded`)),
    ).toBe(true);
    expect(
      ctx.log.some((line) => line.includes('registered 39 victauri tools')),
    ).toBe(true);
    const names = ctx.tools.register.mock.calls.map(
      (call) => (call[0] as { name: string }).name,
    );
    expect(new Set(names).size).toBe(39);
    expect(names).toContain('victauri_cli');
    expect(names).toContain('victauri_cli_status');
    expect(names).toContain('victauri_eval_js');
    expect(names).toContain('victauri_introspect');
  });

  it('apply 注册 victauri_doctor 桥接体检工具', () => {
    const ctx = stubCtx();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    apply(ctx as never);
    const names = ctx.tools.register.mock.calls.map(
      (call) => (call[0] as { name: string }).name,
    );
    expect(names).toContain('victauri_doctor');
  });

  it('apply 注册内嵌 skill victauri-fullstack-debug（bundled，双面可调用）', () => {
    const ctx = stubCtx();
    vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      ctx.log.push(msg);
    });
    apply(ctx as never);
    expect(ctx.skills.register).toHaveBeenCalledTimes(1);
    const skill = ctx.skills.register.mock.calls[0][0] as {
      name: string;
      description: string;
      content: string;
      source: string;
      invocation: { modelInvocable: boolean; userInvocable: boolean };
    };
    expect(skill.name).toBe(SKILL_NAME);
    expect(skill.name).toBe('victauri-fullstack-debug');
    expect(skill.source).toBe('bundled');
    expect(skill.description.length).toBeGreaterThan(20);
    expect(skill.content).toContain('后端验证三段式');
    expect(skill.content).toContain('窗口盲区排障');
    expect(skill.invocation).toEqual({
      modelInvocable: true,
      userInvocable: true,
    });
    // skill 注册日志不破坏 e2e 契约行（工具行先打，skill 行另起）。
    const toolLine = ctx.log.find((line) =>
      line.includes('registered 39 victauri tools'),
    );
    const skillLine = ctx.log.find((line) =>
      line.includes(`registered skill ${SKILL_NAME}`),
    );
    expect(toolLine).toBeDefined();
    expect(skillLine).toBeDefined();
    expect(ctx.log.indexOf(toolLine ?? '')).toBeLessThan(
      ctx.log.indexOf(skillLine ?? ''),
    );
  });

  it('disabledTools 按全名过滤注册并计入日志', () => {
    const ctx = stubCtx();
    vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      ctx.log.push(msg);
    });
    apply(ctx as never, { disabledTools: ['victauri_trace', 'victauri_cli'] });
    expect(ctx.tools.register).toHaveBeenCalledTimes(37);
    const names = ctx.tools.register.mock.calls.map(
      (call) => (call[0] as { name: string }).name,
    );
    expect(names).not.toContain('victauri_trace');
    expect(names).not.toContain('victauri_cli');
    expect(
      ctx.log.some((line) => line.includes('(2 disabled by config)')),
    ).toBe(true);
  });

  it('非法配置降级默认（工具照常注册 39）', () => {
    const ctx = stubCtx();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    apply(ctx as never, { requestTimeoutMs: 'not-a-number' });
    expect(ctx.tools.register).toHaveBeenCalledTimes(39);
    expect(logSpy).toHaveBeenCalled();
  });

  it('apply 不注册任何 HTTP 路由（插件无 web 面，不再声明 webServer 依赖）', () => {
    const ctx = stubCtx();
    vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      ctx.log.push(msg);
    });
    apply(ctx as never);
    // 强断言：插件根本不调用 ctx.inject（cordis 的延迟依赖机制），因此任何
    // 「换个参数形态再注入 webServer」的回归也会被捕获。
    expect(ctx.inject).not.toHaveBeenCalled();
    // 双保险：即便有人改成 ctx.webServer.register(...) 直注册路由，也会被抓到。
    expect(ctx.webServer.register).not.toHaveBeenCalled();
    expect(ctx.log).not.toContain('register-route');
    expect(ctx.tools.register).toHaveBeenCalledTimes(39);
    expect(ctx.skills.register).toHaveBeenCalledTimes(1);
  });
});
