import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  isAtLeast,
  isBelow,
  parseVersion,
} from './cli-version.ts';

describe('dsh-victauri cli 版本比较', () => {
  it('parseVersion 从文本提取三元组,无版本返回 null', () => {
    expect(parseVersion('victauri 0.8.8')).toEqual({
      major: 0,
      minor: 8,
      patch: 8,
    });
    expect(parseVersion('0.10.2')).toEqual({ major: 0, minor: 10, patch: 2 });
    expect(parseVersion('victauri 0.8.8-beta.1')).toEqual({
      major: 0,
      minor: 8,
      patch: 8,
    });
    expect(parseVersion('no version here')).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
  });

  it('compareVersions 按数值段比较:0.10.0 高于 0.8.8(字符串比较会反)', () => {
    expect(compareVersions('0.10.0', '0.8.8')).toBe(1);
    expect(compareVersions('0.8.8', '0.10.0')).toBe(-1);
    expect(compareVersions('0.8.8', '0.8.8')).toBe(0);
    expect(compareVersions('0.8.8', '0.8.10')).toBe(-1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('0.8.8', '0.9.0')).toBe(-1);
  });

  it('compareVersions 遇到不可解析版本返回 null(未知即不比较)', () => {
    expect(compareVersions('unknown', '0.8.8')).toBeNull();
    expect(compareVersions('0.8.8', null)).toBeNull();
    expect(compareVersions(null, undefined)).toBeNull();
  });

  it('isAtLeast / isBelow:版本未知一律 false(保守不外推)', () => {
    expect(isAtLeast('0.10.0', '0.10.0')).toBe(true);
    expect(isAtLeast('0.10.3', '0.10.0')).toBe(true);
    expect(isAtLeast('0.9.9', '0.10.0')).toBe(false);
    expect(isAtLeast('0.8.8', '0.10.0')).toBe(false);
    expect(isAtLeast(null, '0.10.0')).toBe(false);
    expect(isAtLeast(undefined, '0.10.0')).toBe(false);

    expect(isBelow('0.8.8', '0.10.0')).toBe(true);
    expect(isBelow('0.9.9', '0.10.0')).toBe(true);
    expect(isBelow('0.10.0', '0.10.0')).toBe(false);
    expect(isBelow('0.10.1', '0.10.0')).toBe(false);
    expect(isBelow(null, '0.10.0')).toBe(false);
  });
});
