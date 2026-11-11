/**
 * `victauri_tools_list` 单测。
 *
 * 覆盖验收口径：
 * - 服务端工具名清单与条数（去重）；
 * - 服务端清单 vs 插件静态暴露面的双向差异告警（not_exposed / missing_on_server）；
 * - include_descriptions 开关与描述截断；
 * - listTools 失败 → 结构化错误（不抛栈、不吞错）。
 */
import { describe, expect, it } from 'vitest';

import type { VictauriClient } from '../client.ts';
import { VictauriError } from '../errors.ts';
import {
  TOOL_DESCRIPTION_MAX_CHARS,
  TOOLS_LIST_TOOL_NAME,
  createToolsListTool,
  diffToolNames,
  exposedServerToolNames,
  type ToolsListResult,
} from './tools-list.ts';

/** 工具 execute 返回 unknown：断言时收敛为结果类型。 */
type Exec = (args: Record<string, unknown>) => Promise<ToolsListResult>;

/** 构造只实现 listTools 的 mock client。 */
function depsWith(tools: readonly { name: string; description?: string }[]): {
  getClient: () => Promise<VictauriClient>;
} {
  return {
    getClient: async () =>
      ({
        listTools: async () =>
          tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? '',
          })),
      }) as unknown as VictauriClient,
  };
}

/** 构造 listTools 抛错的 mock client。 */
function depsFailing(err: unknown): {
  getClient: () => Promise<VictauriClient>;
} {
  return {
    getClient: async () =>
      ({
        listTools: async () => {
          throw err;
        },
      }) as unknown as VictauriClient,
  };
}

describe('dsh-victauri victauri_tools_list', () => {
  it('返回服务端工具名清单与条数:与插件暴露面一致时 in_sync=true、无告警', async () => {
    const exposed = exposedServerToolNames();
    const tool = createToolsListTool(
      depsWith(exposed.map((name) => ({ name }))),
    );
    const execute = tool.execute as unknown as Exec;
    const result = await execute({});
    expect(result.tools).toEqual(exposed);
    expect(result.server_count).toBe(exposed.length);
    expect(result.exposed_count).toBe(exposed.length);
    expect(result.in_sync).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.error).toBeNull();
  });

  it('服务端多出的工具记 not_exposed 告警;插件暴露但服务端缺失记 missing_on_server 告警', async () => {
    const exposed = exposedServerToolNames();
    const server = [...exposed.slice(0, -1), 'brand_new_tool'];
    const tool = createToolsListTool(
      depsWith(server.map((name) => ({ name }))),
    );
    const execute = tool.execute as unknown as Exec;
    const result = await execute({});
    expect(result.in_sync).toBe(false);
    const notExposed = result.warnings.filter((w) => w.kind === 'not_exposed');
    const missing = result.warnings.filter(
      (w) => w.kind === 'missing_on_server',
    );
    expect(notExposed.map((w) => w.name)).toEqual(['brand_new_tool']);
    expect(missing.map((w) => w.name)).toEqual([exposed[exposed.length - 1]]);
    expect(result.warnings[0]?.message).toContain('brand_new_tool');
  });

  it('include_descriptions=true 附带截断描述;默认不含描述字段', async () => {
    const long = 'x'.repeat(TOOL_DESCRIPTION_MAX_CHARS + 50);
    const tool = createToolsListTool(
      depsWith([{ name: 'app_info', description: long }]),
    );
    const execute = tool.execute as unknown as Exec;
    const without = await execute({});
    expect(without.descriptions).toBeUndefined();
    const withDesc = await execute({ include_descriptions: true });
    expect(withDesc.descriptions?.['app_info']).toHaveLength(
      TOOL_DESCRIPTION_MAX_CHARS,
    );
  });

  it('服务端返回重复工具名时去重', async () => {
    const tool = createToolsListTool(
      depsWith([{ name: 'app_info' }, { name: 'app_info' }]),
    );
    const execute = tool.execute as unknown as Exec;
    const result = await execute({});
    expect(result.tools).toEqual(['app_info']);
    expect(result.server_count).toBe(1);
  });

  it('listTools 失败:返回结构化 error(kind/hint)不抛栈', async () => {
    const tool = createToolsListTool(
      depsFailing(new VictauriError('no-live-instance', 'no live instance')),
    );
    const execute = tool.execute as unknown as Exec;
    const result = await execute({});
    expect(result.error?.kind).toBe('no-live-instance');
    expect(result.error?.hint).toContain('victauri check');
    expect(result.tools).toEqual([]);
    expect(result.in_sync).toBe(false);
  });

  it('diffToolNames 纯函数:双向差异方向正确', () => {
    expect(diffToolNames(['a', 'b'], ['a'])).toEqual([
      {
        kind: 'not_exposed',
        name: 'b',
        message: expect.stringContaining("'b'"),
      },
    ]);
    expect(diffToolNames(['a'], ['a', 'c'])).toEqual([
      {
        kind: 'missing_on_server',
        name: 'c',
        message: expect.stringContaining("'c'"),
      },
    ]);
    expect(diffToolNames([], [])).toEqual([]);
  });

  it('工具名与暴露面口径:工具名为 victauri_tools_list,不在服务端暴露面内', () => {
    expect(TOOLS_LIST_TOOL_NAME).toBe('victauri_tools_list');
    const exposed = exposedServerToolNames();
    expect(exposed).toHaveLength(35);
    expect(exposed).not.toContain('tools_list');
  });
});
