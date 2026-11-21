/**
 * dsh-open-design volatile 配置摊平单测（配置持久化系列 2/6）。
 */
import { describe, expect, it } from 'vitest';

import {
  isVolatileLike,
  unwrapVolatile,
  unwrapVolatileAs,
} from './volatile.ts';

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

function makeVolatile<T>(value: T): T {
  const holder = { [VOLATILE_WRITE]: true, get: () => value };
  return holder as unknown as T;
}

describe('dsh-open-design volatile', () => {
  it('识别带 cosmokit volatile 标记的对象', () => {
    expect(isVolatileLike(makeVolatile('x'))).toBe(true);
    expect(isVolatileLike({ get: () => 'x' })).toBe(false);
    expect(isVolatileLike(null)).toBe(false);
  });

  it('摊平嵌套的 volatile 引用', () => {
    const value = unwrapVolatile({
      command: makeVolatile('E:\\od.exe'),
      args: [makeVolatile('--mcp')],
      env: { ELECTRON_RUN_AS_NODE: makeVolatile('1') },
    });
    expect(value).toEqual({
      command: 'E:\\od.exe',
      args: ['--mcp'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
  });

  it('原样返回非 volatile 值', () => {
    expect(unwrapVolatile('plain')).toBe('plain');
    expect(unwrapVolatile(42)).toBe(42);
    expect(unwrapVolatile(null)).toBeNull();
  });

  it('保留调用方声明的类型', () => {
    const value = unwrapVolatileAs<{ command: string }>(
      makeVolatile({ command: 'x' }),
    );
    expect(value.command).toBe('x');
  });
});
