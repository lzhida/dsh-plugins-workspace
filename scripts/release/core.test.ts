import { describe, expect, it } from 'vitest';
import {
  parseSemver,
  resolvePackageName,
  shortNameOf,
  tagFor,
} from './core.ts';
import type { WorkspacePackage } from './core.ts';

function pkg(name: string, version: string): WorkspacePackage {
  const shortName = shortNameOf(name);
  return {
    name,
    shortName,
    version,
    isPrivate: true,
    dir: `packages/${shortName}`,
  };
}

describe('release core', () => {
  describe('parseSemver 版本解析', () => {
    it('解析正式版本与预发布/build 段', () => {
      expect(parseSemver('1.2.3', 'TAG_EXISTS', '')).toEqual({
        major: 1,
        minor: 2,
        patch: 3,
      });
      expect(parseSemver('0.4.0-rc.1', 'TAG_EXISTS', '')).toEqual({
        major: 0,
        minor: 4,
        patch: 0,
        prerelease: 'rc.1',
      });
      expect(parseSemver('1.0.0+build.5', 'TAG_EXISTS', '')).toEqual({
        major: 1,
        minor: 0,
        patch: 0,
      });
    });

    it('非法版本按调用方指定的错误码抛 ReleaseError', () => {
      expect(() =>
        parseSemver('v0.1', 'INVALID_CURRENT_VERSION', '前缀'),
      ).toThrowError(
        expect.objectContaining({ code: 'INVALID_CURRENT_VERSION' }),
      );
      expect(() =>
        parseSemver('01.2.3', 'INVALID_CURRENT_VERSION', '前缀'),
      ).toThrowError(
        expect.objectContaining({ code: 'INVALID_CURRENT_VERSION' }),
      );
    });
  });

  describe('tagFor tag 名生成', () => {
    it('生成 {短包名}-v{版本} 形式,区分不同插件', () => {
      expect(tagFor('dsh-taskboard', '0.2.0')).toBe('dsh-taskboard-v0.2.0');
      expect(tagFor('dsh-llm-fallback', '0.3.2')).toBe(
        'dsh-llm-fallback-v0.3.2',
      );
    });
  });

  describe('shortNameOf 包名拆解', () => {
    it('scoped 包取最后一段,无 scope 原样返回', () => {
      expect(shortNameOf('@zhidal/dsh-taskboard')).toBe('dsh-taskboard');
      expect(shortNameOf('dsh-taskboard')).toBe('dsh-taskboard');
    });
  });

  describe('resolvePackageName 包名解析', () => {
    const packages = [
      pkg('@acme/dsh-alpha', '0.1.0'),
      pkg('@acme/dsh-beta', '1.2.3'),
      pkg('@zhidal/dsh-alpha', '0.0.1'),
    ];

    it('完整包名精确命中(优先于短名)', () => {
      expect(resolvePackageName('@zhidal/dsh-alpha', packages).name).toBe(
        '@zhidal/dsh-alpha',
      );
      expect(resolvePackageName('@acme/dsh-alpha', packages).name).toBe(
        '@acme/dsh-alpha',
      );
    });

    it('短名唯一命中', () => {
      expect(resolvePackageName('dsh-beta', packages).name).toBe(
        '@acme/dsh-beta',
      );
    });

    it('短名命中多个包时抛 PKG_AMBIGUOUS', () => {
      expect(() => resolvePackageName('dsh-alpha', packages)).toThrowError(
        expect.objectContaining({ code: 'PKG_AMBIGUOUS' }),
      );
    });

    it('未命中抛 PKG_NOT_FOUND 且列出可用包', () => {
      expect(() => resolvePackageName('dsh-none', packages)).toThrowError(
        expect.objectContaining({ code: 'PKG_NOT_FOUND' }),
      );
    });
  });
});
