/**
 * config.ts 测试：默认值、volatile 解包、语义类字段归一化、组过滤与数值回退。
 *
 * 注意：**连接类字段（baseUrl/apiKey/apiVersion/超时/截断）不在本文件**——
 * 它们归插件行①（`dsh-anytype`）的具名服务所有，记忆插件行只持有语义类
 * 配置（空间/预算/状态/组开关）。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EMBEDDING_BATCH_SIZE,
  DEFAULT_MEMORY_STATUS,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_RECALL_MAX_TOKENS,
  DEFAULT_SPACE_NAME,
  resolveConfig,
  unwrapVolatile,
} from './config.ts';

/** 构造 cosmokit volatile 引用假体（Symbol.for 跨副本稳定）。 */
function fakeVolatile(value: unknown): { get: () => unknown } {
  return {
    [Symbol.for('cosmokit.volatile.write')]: true,
    get: () => value,
  } as { get: () => unknown };
}

describe('dsh-anytype-memory config', () => {
  it('undefined 输入回落全默认', () => {
    const cfg = resolveConfig(undefined);
    expect(cfg.enabled).toBe(true);
    expect(cfg.spaceName).toBe(DEFAULT_SPACE_NAME);
    expect(cfg.spaceId).toBe('');
    expect(cfg.disabledGroups.size).toBe(0);
    expect(cfg.recallLimit).toBe(DEFAULT_RECALL_LIMIT);
    expect(cfg.recallMaxTokens).toBe(DEFAULT_RECALL_MAX_TOKENS);
    expect(cfg.embeddingBatchSize).toBe(DEFAULT_EMBEDDING_BATCH_SIZE);
    expect(cfg.defaultStatus).toBe(DEFAULT_MEMORY_STATUS);
  });

  it('不含连接类字段（钥匙归插件行①的具名服务）', () => {
    const cfg = resolveConfig({
      apiKey: 'x',
      baseUrl: 'http://y',
    }) as unknown as Record<string, unknown>;
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.baseUrl).toBeUndefined();
  });

  it('volatile 引用被解包成普通值', () => {
    const cfg = resolveConfig({
      spaceName: fakeVolatile('Notes'),
      recallLimit: fakeVolatile(50),
    });
    expect(cfg.spaceName).toBe('Notes');
    expect(cfg.recallLimit).toBe(50);
  });

  it('嵌套 volatile 也被解包', () => {
    expect(
      unwrapVolatile({ a: fakeVolatile(1), b: [fakeVolatile(2)] }),
    ).toEqual({
      a: 1,
      b: [2],
    });
  });

  it('只保留合法工具组', () => {
    const cfg = resolveConfig({ disabledGroups: ['read', 'bogus', 'write'] });
    expect(cfg.disabledGroups.has('read')).toBe(true);
    expect(cfg.disabledGroups.has('write')).toBe(true);
    expect([...cfg.disabledGroups]).not.toContain('bogus');
  });

  it('非法数值回落默认，合法数值取整', () => {
    expect(resolveConfig({ recallLimit: -3 }).recallLimit).toBe(
      DEFAULT_RECALL_LIMIT,
    );
    expect(resolveConfig({ recallLimit: 'x' }).recallLimit).toBe(
      DEFAULT_RECALL_LIMIT,
    );
    expect(resolveConfig({ recallLimit: 12.7 }).recallLimit).toBe(12);
  });

  it('enabled=false 时总开关关闭', () => {
    expect(resolveConfig({ enabled: false }).enabled).toBe(false);
  });

  it('空间名与空间 id 各自独立', () => {
    const cfg = resolveConfig({ spaceName: 'Notes', spaceId: '64xiwe' });
    expect(cfg.spaceName).toBe('Notes');
    expect(cfg.spaceId).toBe('64xiwe');
  });

  it('空白空间名回落默认，空串空间 id 表示按名解析', () => {
    expect(resolveConfig({ spaceName: '   ' }).spaceName).toBe(
      DEFAULT_SPACE_NAME,
    );
    expect(resolveConfig({ spaceId: '  ' }).spaceId).toBe('');
  });
});
