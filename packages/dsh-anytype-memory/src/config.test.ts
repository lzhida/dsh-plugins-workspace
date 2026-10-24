/**
 * config.ts 测试：默认值、volatile 解包、地址归一化、组过滤与数值回退。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RESPONSE_CHARS,
  DEFAULT_MEMORY_STATUS,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_REQUEST_TIMEOUT_MS,
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
    expect(cfg.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(cfg.apiKey).toBe('');
    expect(cfg.spaceName).toBe(DEFAULT_SPACE_NAME);
    expect(cfg.spaceId).toBe('');
    expect(cfg.disabledGroups.size).toBe(0);
    expect(cfg.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(cfg.maxResponseChars).toBe(DEFAULT_MAX_RESPONSE_CHARS);
    expect(cfg.recallLimit).toBe(DEFAULT_RECALL_LIMIT);
    expect(cfg.defaultStatus).toBe(DEFAULT_MEMORY_STATUS);
  });

  it('volatile 引用被解包成普通值', () => {
    const cfg = resolveConfig({
      apiKey: fakeVolatile('vk'),
      recallLimit: fakeVolatile(50),
    });
    expect(cfg.apiKey).toBe('vk');
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

  it('baseUrl 去尾斜杠；非法值回落默认', () => {
    expect(resolveConfig({ baseUrl: 'http://127.0.0.1:31009/' }).baseUrl).toBe(
      'http://127.0.0.1:31009',
    );
    expect(resolveConfig({ baseUrl: 'ftp://x' }).baseUrl).toBe(
      DEFAULT_BASE_URL,
    );
    expect(resolveConfig({ baseUrl: 'not a url' }).baseUrl).toBe(
      DEFAULT_BASE_URL,
    );
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
});
