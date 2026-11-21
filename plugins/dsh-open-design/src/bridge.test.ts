/**
 * dsh-open-design 工具桥单测：公开工具名、契约透传、两阶段换装与错误传播。
 *
 * 全部用假对象驱动，不拉起任何真实子进程。
 */
import { describe, expect, it, vi } from 'vitest';

import type { Mock } from 'vitest';

import { buildToolDefinition, createBridge, publicToolName } from './bridge.ts';
import type { BridgeTarget, UpstreamTool } from './bridge.ts';

/** 上游工具样例：一个带必填参数的普通工具。 */
const UPSTREAM_TOOL: UpstreamTool = {
  name: 'create_file',
  description: '在 Open Design 中创建文件',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
};

/** 构造一个记录注册与注销的假宿主。 */
function createMockTarget(): {
  target: BridgeTarget;
  register: Mock<(definition: unknown) => () => void>;
  disposers: Mock<() => void>[];
  definitions: unknown[];
} {
  const disposers: Mock<() => void>[] = [];
  const definitions: unknown[] = [];
  const register = vi.fn((definition: unknown) => {
    definitions.push(definition);
    const disposer = vi.fn<() => void>();
    disposers.push(disposer);
    return disposer;
  });
  return { target: { register }, register, disposers, definitions };
}

/** 造一个只返回指定内容的执行器。 */
function createExecutor(
  result: unknown,
): Mock<(name: string, args: Record<string, unknown>) => Promise<unknown>> {
  return vi.fn(async () => result);
}

describe('dsh-open-design bridge', () => {
  it('给正常工具名加上 mcp 前缀', () => {
    expect(publicToolName('open-design', 'create_file')).toBe(
      'mcp__open-design__create_file',
    );
  });

  it('把非法字符替换成下划线并追加摘要后缀', () => {
    expect(publicToolName('open-design', 'list objects')).toBe(
      'mcp__open-design__list_objects_50092ea41729',
    );
    expect(publicToolName('open-design', 'a.b')).toBe(
      'mcp__open-design__a_b_de8ebeba209c',
    );
  });

  it('截断超长工具名并追加摘要后缀', () => {
    const name = publicToolName('open-design', 'x'.repeat(80));
    expect(name).toBe(`mcp__open-design__${'x'.repeat(33)}_b806c0a8a81b`);
    expect(name).toHaveLength(64);
  });

  it('原样透传上游 inputSchema 作为参数契约', () => {
    const definition = buildToolDefinition(
      'open-design',
      UPSTREAM_TOOL,
      createExecutor({ content: [] }),
    );
    expect(definition.parameters).toBe(UPSTREAM_TOOL.inputSchema);
    expect(definition.name).toBe('mcp__open-design__create_file');
    expect(definition.description).toBe('在 Open Design 中创建文件');
  });

  it('编译出与宿主一致的输出 schema', () => {
    const definition = buildToolDefinition(
      'open-design',
      UPSTREAM_TOOL,
      createExecutor({ content: [] }),
    );
    // 与宿主 createOutput 等价：content 数组必填、structuredContent 可选、
    // 对象封闭；content 的 items 省略（= 接受任意 JSON 项，宿主写 items:{}）。
    expect(definition.output.schema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        content: { type: 'array' },
        structuredContent: {},
      },
      required: ['content'],
    });
  });

  it('调用上游并透传内容与结构化结果', async () => {
    const executor = createExecutor({
      content: [{ type: 'text', text: '已创建' }],
      structuredContent: { files: 1 },
    });
    const definition = buildToolDefinition(
      'open-design',
      UPSTREAM_TOOL,
      executor,
    );
    const value = (await definition.execute(
      { path: 'a.txt' },
      {} as never,
    )) as {
      content: unknown[];
      structuredContent?: unknown;
    };
    expect(executor).toHaveBeenCalledWith('create_file', { path: 'a.txt' });
    expect(value.content).toEqual([{ type: 'text', text: '已创建' }]);
    expect(value.structuredContent).toEqual({ files: 1 });
  });

  it('上游没有结构化结果时只返回内容', async () => {
    const definition = buildToolDefinition(
      'open-design',
      UPSTREAM_TOOL,
      createExecutor({ content: [{ type: 'text', text: '已创建' }] }),
    );
    const value = (await definition.execute(
      { path: 'a.txt' },
      {} as never,
    )) as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(['content']);
  });

  it('上游返回 isError 时抛出错误', async () => {
    const definition = buildToolDefinition(
      'open-design',
      UPSTREAM_TOOL,
      createExecutor({
        content: [{ type: 'text', text: '目标目录不存在' }],
        isError: true,
      }),
    );
    await expect(
      definition.execute({ path: 'a.txt' }, {} as never),
    ).rejects.toThrow('目标目录不存在');
  });

  it('上游返回非法结果结构时抛出错误', async () => {
    const definition = buildToolDefinition(
      'open-design',
      UPSTREAM_TOOL,
      createExecutor({ content: '不是数组' }),
    );
    await expect(
      definition.execute({ path: 'a.txt' }, {} as never),
    ).rejects.toThrow(/returned an invalid MCP result/);
  });

  it('参数不满足上游 schema 时抛出错误', async () => {
    const definition = buildToolDefinition(
      'open-design',
      UPSTREAM_TOOL,
      createExecutor({ content: [] }),
    );
    await expect(definition.execute({}, {} as never)).rejects.toThrow(
      /received invalid arguments/,
    );
  });

  it('构建失败的工具被跳过且旧一代被换装', () => {
    const { target, register, disposers } = createMockTarget();
    const bridge = createBridge(
      target,
      'open-design',
      createExecutor({ content: [] }),
    );
    bridge.syncTools([UPSTREAM_TOOL]);
    expect(register).toHaveBeenCalledTimes(1);

    const broken: UpstreamTool = {
      name: 'broken_tool',
      inputSchema: { type: 'object', properties: { x: { type: 'bogus' } } },
    };
    const result = bridge.syncTools([broken]);
    // 构建失败的工具被跳过并记录原因，不阻断其余工具；换装后旧工具被注销。
    expect(result).toEqual({ registered: 0, skipped: ['broken_tool'] });
    expect(register).toHaveBeenCalledTimes(1);
    expect(disposers[0]).toHaveBeenCalled();
  });

  it('单个工具构建失败不影响其余工具注册', () => {
    const { target, register } = createMockTarget();
    const bridge = createBridge(
      target,
      'open-design',
      createExecutor({ content: [] }),
    );
    const broken: UpstreamTool = {
      name: 'broken_tool',
      inputSchema: { type: 'object', properties: { x: { type: 'bogus' } } },
    };
    const result = bridge.syncTools([UPSTREAM_TOOL, broken]);
    expect(result).toEqual({ registered: 1, skipped: ['broken_tool'] });
    expect(register).toHaveBeenCalledTimes(1);
    // 新一代只有健康工具：create_file。
    expect(register.mock.calls[0]?.[0]).toMatchObject({
      name: 'mcp__open-design__create_file',
    });
  });

  it('换装成功后注销旧工具并注册新工具', () => {
    const { target, register, disposers, definitions } = createMockTarget();
    const bridge = createBridge(
      target,
      'open-design',
      createExecutor({ content: [] }),
    );
    bridge.syncTools([UPSTREAM_TOOL, { ...UPSTREAM_TOOL, name: 'read_file' }]);
    expect(register).toHaveBeenCalledTimes(2);
    expect(disposers[0]).not.toHaveBeenCalled();
    expect(definitions[0]).toMatchObject({
      name: 'mcp__open-design__create_file',
    });

    bridge.syncTools([UPSTREAM_TOOL]);
    expect(disposers[0]).toHaveBeenCalledTimes(1);
    expect(disposers[1]).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(3);
  });

  it('注销工具后释放全部注册', () => {
    const { target, disposers } = createMockTarget();
    const bridge = createBridge(
      target,
      'open-design',
      createExecutor({ content: [] }),
    );
    bridge.syncTools([UPSTREAM_TOOL]);
    bridge.dispose();
    expect(disposers[0]).toHaveBeenCalledTimes(1);
  });

  it('同一上游工具名重复出现时拒绝整批换装', () => {
    const { target, register } = createMockTarget();
    const bridge = createBridge(
      target,
      'open-design',
      createExecutor({ content: [] }),
    );
    expect(() =>
      bridge.syncTools([UPSTREAM_TOOL, { ...UPSTREAM_TOOL }]),
    ).toThrow(/映射到同一公开工具名/);
    expect(register).not.toHaveBeenCalled();
  });
});
