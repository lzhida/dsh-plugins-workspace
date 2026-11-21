/**
 * client 半区接线契约（与 dsh-anytype 的同款守卫）：
 * - PKG_NAME 与 package.json name 逐字同步（module loader 注册 id，
 *   漂移会让宿主 boot graph 抛 "loaded without registering"）；
 * - exports['./client'] 指向构建产物路径、dsh.client 声明完整；
 * - scripts 构建链与 client 骨架文件就位。
 *
 * @module dsh-open-design/client-bundle.test
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface ClientManifest {
  name: string;
  exports: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
  dsh: {
    client?: {
      platform: string;
      immediately: boolean;
      inject: string[];
    };
  };
}

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as ClientManifest;

const constantsSource = readFileSync(
  new URL('../client/src/constants.ts', import.meta.url),
  'utf8',
);

describe('dsh-open-design client 半区接线', () => {
  it('PKG_NAME 与 package.json name 逐字一致', () => {
    const match = /export const PKG_NAME = '([^']+)';/.exec(constantsSource);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(pkg.name);
  });

  it('exports 的 ./client 指向构建产物路径', () => {
    expect(pkg.exports['./client']).toBe('./client/index.js');
  });

  it('dsh.client 声明 platform/immediately/inject', () => {
    expect(pkg.dsh.client?.platform).toBe('web');
    expect(pkg.dsh.client?.immediately).toBe(true);
    expect(pkg.dsh.client?.inject).toContain('@deepseek-ai/dsh-client-locale');
    expect(pkg.dsh.client?.inject).toContain(
      '@deepseek-ai/dsh-client-ui-slots',
    );
  });

  it('files 收录 client、scripts 注册构建链', () => {
    expect(pkg.files).toContain('client');
    expect(pkg.scripts['build:client']).toBe('node scripts/build-client.ts');
    expect(pkg.scripts.prepare).toBe('node scripts/build-client.ts');
    expect(pkg.scripts.build).toBe('node scripts/build-client.ts');
  });

  it('构建脚本与 client 骨架文件就位', () => {
    expect(() =>
      readFileSync(new URL('../scripts/build-client.ts', import.meta.url)),
    ).not.toThrow();
    expect(() =>
      readFileSync(new URL('../client/src/main.tsx', import.meta.url)),
    ).not.toThrow();
    expect(() =>
      readFileSync(new URL('../client/src/plugin.tsx', import.meta.url)),
    ).not.toThrow();
    expect(() =>
      readFileSync(new URL('../client/src/theme.ts', import.meta.url)),
    ).not.toThrow();
    expect(() =>
      readFileSync(new URL('../client/src/theme.css', import.meta.url)),
    ).not.toThrow();
  });
});
