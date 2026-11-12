/**
 * 真实 workspace 可枚举性回归测试。
 *
 * `scripts/release/*.test.ts` 全部用 mkdtemp 临时 fixture(packages/dsh-alpha
 * 等),从不针对真实仓库;一旦真实 workspace 的包目录或发布约定漂移
 * (例如包目录名与包名短名不一致、tag 前缀不再匹配 release.yml 的触发形态、
 * 新包漏了 npm scope),这些单测仍全绿,而 `pnpm release list/tag/publish`
 * 会在真实仓库上失败。此测试用真实仓库根兜住这一层。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolvePackageName, tagFor } from '../scripts/release/core.ts';
import { listWorkspacePackages } from '../scripts/release/workspace.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const packages = listWorkspacePackages(repoRoot);

/** release.yml 的 tag 触发形态:`*-v*`。 */
const TAG_TRIGGER = /^[^*]+-v\d+\.\d+\.\d+/;

describe('release-workspace(真实仓库)', () => {
  it('真实 workspace 可被发布工具枚举出全部子包', () => {
    // 仓库内至少四个子包(llm-fallback / patent / victauri / anytype)。
    expect(packages.length).toBeGreaterThanOrEqual(4);
    for (const pkg of packages) {
      expect(existsSync(join(repoRoot, pkg.dir, 'package.json'))).toBe(true);
    }
  });

  it('每个子包的短名与其目录名一致(tag 前缀即目录名)', () => {
    for (const pkg of packages) {
      const dirName = pkg.dir.split('/').pop();
      expect(pkg.shortName).toBe(dirName);
      expect(tagFor(pkg.shortName, pkg.version)).toBe(
        `${dirName}-v${pkg.version}`,
      );
    }
  });

  it('公开包统一走 @zhidal/ scope(npm 包名与 tag 前缀不漂移)', () => {
    for (const pkg of packages) {
      expect(pkg.name.startsWith('@zhidal/')).toBe(true);
    }
  });

  it('各子包 tag 名唯一(不会两包抢同一个 tag)', () => {
    const tags = packages.map((pkg) => tagFor(pkg.shortName, pkg.version));
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('每个公开包的 tag 名都命中 release.yml 的 `*-v*` 触发形态', () => {
    const publicTags = packages
      .filter((pkg) => !pkg.isPrivate)
      .map((pkg) => tagFor(pkg.shortName, pkg.version));
    expect(publicTags.length).toBeGreaterThan(0);
    for (const tag of publicTags) {
      expect(tag).toMatch(TAG_TRIGGER);
    }
  });

  it('dsh-victauri 已入 workspace 且为公开包(版本不写死,随发布推进)', () => {
    const victauri = resolvePackageName('dsh-victauri', packages);
    expect(victauri.name).toBe('@zhidal/dsh-victauri');
    expect(victauri.dir).toBe('packages/dsh-victauri');
    expect(victauri.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(victauri.isPrivate).toBe(false);
    expect(tagFor(victauri.shortName, victauri.version)).toBe(
      `dsh-victauri-v${victauri.version}`,
    );
  });

  it('按短名与全名解析 dsh-victauri 都唯一命中', () => {
    expect(resolvePackageName('dsh-victauri', packages).dir).toBe(
      'packages/dsh-victauri',
    );
    expect(resolvePackageName('@zhidal/dsh-victauri', packages).dir).toBe(
      'packages/dsh-victauri',
    );
  });
});
