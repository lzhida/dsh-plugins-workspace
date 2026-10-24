/**
 * config.ts 测试：默认值、volatile 解包、baseUrl 归一化、组过滤与数值回退。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_API_VERSION,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RESPONSE_CHARS,
  DEFAULT_REQUEST_TIMEOUT_MS,
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

describe('dsh-anytype config', () => {
  it('undefined 输入回落全默认（enabled、默认地址、无停用组）', () => {
    const cfg = resolveConfig(undefined);
    expect(cfg.enabled).toBe(true);
    expect(cfg.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(cfg.apiKey).toBe('');
    expect(cfg.apiVersion).toBe(DEFAULT_API_VERSION);
    expect(cfg.disabledGroups.size).toBe(0);
    expect(cfg.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(cfg.maxResponseChars).toBe(DEFAULT_MAX_RESPONSE_CHARS);
  });

  it('volatile 引用被深度解包（嵌套字段可读）', () => {
    const cfg = resolveConfig({
      enabled: fakeVolatile(true),
      apiKey: fakeVolatile(' vk '),
      disabledGroups: fakeVolatile(['search']),
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.apiKey).toBe('vk');
    expect(cfg.disabledGroups.has('search')).toBe(true);
  });

  it('unwrapVolatile 直接解包普通值原样返回', () => {
    expect(
      unwrapVolatile({ a: fakeVolatile(1), b: [fakeVolatile('x')] }),
    ).toEqual({
      a: 1,
      b: ['x'],
    });
    expect(unwrapVolatile(42)).toBe(42);
  });

  it('baseUrl 归一化：去尾斜杠；非法值回落默认地址', () => {
    expect(resolveConfig({ baseUrl: 'http://localhost:31009/' }).baseUrl).toBe(
      'http://localhost:31009',
    );
    expect(resolveConfig({ baseUrl: 'ftp://x' }).baseUrl).toBe(
      DEFAULT_BASE_URL,
    );
    expect(resolveConfig({ baseUrl: 'not a url' }).baseUrl).toBe(
      DEFAULT_BASE_URL,
    );
    expect(resolveConfig({ baseUrl: '' }).baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it('apiKey/apiVersion trim；空 apiVersion 回落默认', () => {
    const cfg = resolveConfig({ apiKey: '  k  ', apiVersion: '  ' });
    expect(cfg.apiKey).toBe('k');
    expect(cfg.apiVersion).toBe(DEFAULT_API_VERSION);
  });

  it('disabledGroups 过滤未知组名，只保留合法组', () => {
    const cfg = resolveConfig({
      disabledGroups: ['search', 'bogus', 'generic'],
    });
    const groups: ReadonlySet<string> = cfg.disabledGroups;
    expect(groups.has('search')).toBe(true);
    expect(groups.has('generic')).toBe(true);
    expect(groups.has('bogus')).toBe(false);
    expect(cfg.disabledGroups.size).toBe(2);
  });

  it('非数组 disabledGroups 安全回退为空集', () => {
    expect(
      resolveConfig({ disabledGroups: 'search' }).disabledGroups.size,
    ).toBe(0);
  });

  it('超时/截断上限：非正数与非有限数回落默认', () => {
    expect(resolveConfig({ requestTimeoutMs: -5 }).requestTimeoutMs).toBe(
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    expect(resolveConfig({ requestTimeoutMs: 1500 }).requestTimeoutMs).toBe(
      1500,
    );
    expect(
      resolveConfig({ maxResponseChars: Number.NaN }).maxResponseChars,
    ).toBe(DEFAULT_MAX_RESPONSE_CHARS);
  });
});
