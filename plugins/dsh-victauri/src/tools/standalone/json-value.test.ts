/**
 * 任意 JSON 值参数（expected / storage.value）测试。
 *
 * 覆盖：① 三处参数的 schema 放开（数值/对象/布尔/null/string 均通过参数校验）；
 * ② JSON 值透传不被字符串化（桥级：mock client 捕获入参断言原样）；
 * ③ 入参 JSON 化守卫（isJsonValue）。
 */
import { describe, expect, it } from 'vitest';
import { validateArgs } from '@deepseek-ai/dsh-tools';

import type { VictauriClient } from '../../client.ts';
import { REST_TOOL_SPECS } from './catalog.ts';
import { COMPOUND_TOOL_SPECS } from '../compound/catalog.ts';
import { createRestBridgeTool } from './bridge.ts';
import { JSON_VALUE, toJsonArgs } from './json-value.ts';

/** 取 standalone 规格（找不到即视为目录漂移，测试直接失败）。 */
const specOf = (name: string) =>
  REST_TOOL_SPECS.find((spec) => spec.name === name)!;

/** 取 compound 规格。 */
const compoundSpecOf = (name: string) =>
  COMPOUND_TOOL_SPECS.find((spec) => spec.name === name)!;

/** 最小 mock client：只实现 callTool，记录调用入参。 */
function mockClient(): {
  client: VictauriClient;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    callTool: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { ok: true };
    },
  } as unknown as VictauriClient;
  return { client, calls };
}

describe('dsh-victauri 任意 JSON 值参数', () => {
  it('assert_semantic.expected 放开为任意 JSON 值（数值/对象/布尔/null/string）', () => {
    const parameters = specOf('assert_semantic').parameters;
    const base = { expression: '1+1', condition: 'equals' };
    for (const expected of [
      42,
      { count: 2, ok: true },
      [1, 2, 3],
      true,
      false,
      null,
      '42',
    ]) {
      expect(
        validateArgs(parameters, { ...base, expected }),
        `expected=${JSON.stringify(expected)}`,
      ).toEqual([]);
    }
  });

  it('wait_for.expected 同步放开为任意 JSON 值', () => {
    const parameters = specOf('wait_for').parameters;
    const base = { condition: 'expression', value: 'window.ready' };
    for (const expected of [42, { a: 1 }, [1], true, null, 'ready']) {
      expect(
        validateArgs(parameters, { ...base, expected }),
        `expected=${JSON.stringify(expected)}`,
      ).toEqual([]);
    }
  });

  it('compound storage.value 同步放开为任意 JSON 值', () => {
    const parameters = compoundSpecOf('storage').parameters;
    const base = { action: 'set', key: 'k' };
    for (const value of [42, { a: 1 }, [1], true, null, 'text']) {
      expect(
        validateArgs(parameters, { ...base, value }),
        `value=${JSON.stringify(value)}`,
      ).toEqual([]);
    }
  });

  it('三处参数声明为 type:json（schema 节点契约锁定）', () => {
    const nodes = [
      (
        specOf('assert_semantic').parameters as Record<
          string,
          { type?: string }
        >
      )['expected'],
      (specOf('wait_for').parameters as Record<string, { type?: string }>)[
        'expected'
      ],
      (
        compoundSpecOf('storage').parameters as Record<
          string,
          { type?: string }
        >
      )['value'],
    ];
    for (const node of nodes) {
      expect(node?.type).toBe('json');
    }
    // 助手本身也产出 type:'json'
    expect(JSON_VALUE('desc')).toEqual({ type: 'json', description: 'desc' });
  });

  it('JSON 值透传不被字符串化（数值/对象/数组/null 原样送达服务端）', async () => {
    const { client, calls } = mockClient();
    const tool = createRestBridgeTool(specOf('assert_semantic'), {
      getClient: async () => client,
    });
    await tool.execute(
      { expression: '1+1', condition: 'equals', expected: 42 },
      {} as never,
    );
    await tool.execute(
      { expression: 'obj', condition: 'equals', expected: { count: 2 } },
      {} as never,
    );
    await tool.execute(
      { expression: 'arr', condition: 'equals', expected: [1, 2] },
      {} as never,
    );
    await tool.execute(
      { expression: 'nil', condition: 'equals', expected: null },
      {} as never,
    );

    const first = calls[0]?.args['expected'];
    expect(typeof first).toBe('number');
    expect(first).toBe(42);
    expect(calls[1]?.args['expected']).toEqual({ count: 2 });
    expect(typeof calls[1]?.args['expected']).toBe('object');
    expect(calls[2]?.args['expected']).toEqual([1, 2]);
    expect(Array.isArray(calls[2]?.args['expected'])).toBe(true);
    // 显式 null 原样透传（服务端 assert_semantic 把 undefined 视为 null，
    // `equals null` 可通过；此处口径=显式 null 送达，不被丢弃也不被转成字符串）
    expect(calls[3]?.args).toHaveProperty('expected', null);
    expect(calls[3]?.args['expected']).toBeNull();
    // 透传体整体是 JSON 值（可被 JSON.stringify 序列化，无 undefined 残留）
    expect(JSON.parse(JSON.stringify(calls[3]?.args))).toEqual({
      expression: 'nil',
      condition: 'equals',
      expected: null,
    });
  });

  it('compound storage.value 的 JSON 值同样原样透传', async () => {
    const { client, calls } = mockClient();
    const tool = createRestBridgeTool(compoundSpecOf('storage'), {
      getClient: async () => client,
    });
    await tool.execute(
      { action: 'set', key: 'k', value: { a: 1 } },
      {} as never,
    );
    expect(calls[0]?.args['value']).toEqual({ a: 1 });
    expect(typeof calls[0]?.args['value']).toBe('object');
  });

  it('入参 JSON 化守卫：丢弃 undefined 与非 JSON 值，保留 falsy 的合法 JSON 值', () => {
    const out = toJsonArgs({
      keep_zero: 0,
      keep_false: false,
      keep_empty_string: '',
      keep_null: null,
      keep_empty_array: [],
      keep_empty_object: {},
      drop_undefined: undefined,
      drop_function: () => 1,
    });
    expect(out).toEqual({
      keep_zero: 0,
      keep_false: false,
      keep_empty_string: '',
      keep_null: null,
      keep_empty_array: [],
      keep_empty_object: {},
    });
    expect('drop_undefined' in out).toBe(false);
    expect('drop_function' in out).toBe(false);
  });

  it('结构化错误口径不变：参数非法时由 defineTool 校验拦截', async () => {
    const { client, calls } = mockClient();
    const tool = createRestBridgeTool(specOf('assert_semantic'), {
      getClient: async () => client,
    });
    // 必填参数缺失 → ToolArgsError（execute 抛错，不进入桥）
    await expect(tool.execute({}, {} as never)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
