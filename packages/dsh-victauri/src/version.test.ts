import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PLUGIN_VERSION } from './version.ts';

/** 读取仓库 package.json 的版本号（避免把版本写死在两处）。 */
function packageVersion(): string {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

describe('插件版本号', () => {
  it('PLUGIN_VERSION 与 package.json version 一致', () => {
    expect(PLUGIN_VERSION).toBe(packageVersion());
  });

  it('PLUGIN_VERSION 为合法 semver(运行期从 package.json 读出,不是残留常量)', () => {
    expect(PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});
