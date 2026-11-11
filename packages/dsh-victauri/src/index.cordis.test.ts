/**
 * 真实 cordis 语义下的装载行为验证。
 *
 * 与 src/index.test.ts（桩 ctx）互补：这里用**真 cordis Context** 装载本插件，
 * 验证关键行为——
 *
 * 1. 宿主提供 tools/skills 时插件正常装载，39 个工具与 skill 照常注册；
 * 2. 回归护栏：webServer 绝不能回到 export const inject（cordis 的 inject 是硬依赖，
 *    宿主没提供该服务时 fiber 进入 INACTIVE、apply 根本不执行 → 全套工具消失）。
 *
 * 桩 ctx 只能验证「我们调用了什么」，这里验证的是 cordis 自己的装载语义。
 */

import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apply, inject, name } from './index.js';

describe('真实 cordis 下的装载行为', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('宿主提供 tools/skills 时插件装载，39 个工具与 skill 照常注册', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const ctx = new Context();
    const tools: string[] = [];
    const skills: string[] = [];
    ctx.provide('tools', {
      register: (tool: { name: string }) => {
        tools.push(tool.name);
        return () => {};
      },
    });
    ctx.provide('skills', {
      register: (skill: { name: string }) => {
        skills.push(skill.name);
        return () => {};
      },
    });

    await ctx.plugin({ name: `${name}-test`, inject, apply });

    expect(tools).toHaveLength(39);
    expect(skills).toEqual(['victauri-fullstack-debug']);
    expect(tools).toContain('victauri_doctor');
    // 关键回归护栏：webServer 绝不能回到 export const inject（硬依赖会让整块插件不装载）。
    expect(inject).not.toContain('webServer');
  });

  it('回归护栏：把 webServer 写回 inject 会让整块插件不装载（cordis 硬依赖语义）', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const ctx = new Context();
    const tools: string[] = [];
    ctx.provide('tools', {
      register: (tool: { name: string }) => {
        tools.push(tool.name);
        return () => {};
      },
    });
    ctx.provide('skills', { register: () => () => {} });

    // 故意用改前的写法（webServer 进 inject）：宿主没提供该服务时
    // cordis 把 fiber 置为 INACTIVE → apply 根本不执行 → 39 个工具一起消失。
    await ctx.plugin({
      name: `${name}-test-hard-dep`,
      inject: ['tools', 'skills', 'webServer'],
      apply,
    });

    expect(tools).toHaveLength(0);
  });

  it('反向护栏：宿主提供 webServer 时插件仍然不注册任何路由', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const ctx = new Context();
    const tools: string[] = [];
    const routes: string[] = [];
    ctx.provide('tools', {
      register: (tool: { name: string }) => {
        tools.push(tool.name);
        return () => {};
      },
    });
    ctx.provide('skills', { register: () => () => {} });
    ctx.provide('webServer', {
      register: (route: { path?: string }) => {
        routes.push(route.path ?? '(unknown)');
        return () => {};
      },
    });

    await ctx.plugin({ name: `${name}-test-no-route`, inject, apply });

    // 插件已无 web 面：即便宿主提供了 webServer 服务，也不应有任何路由注册。
    expect(routes).toEqual([]);
    expect(tools).toHaveLength(39);
  });
});
