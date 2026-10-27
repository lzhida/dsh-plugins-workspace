import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ReleaseError, shortNameOf } from './core.ts';
import type { WorkspacePackage } from './core.ts';
import {
  decidePublish,
  isStableVersion,
  parseReleaseTag,
  publishArgsFor,
  publishForTag,
} from './publish.ts';
import type { PublishRunner } from './publish.ts';

// 临时 git 仓库端到端在本机 Windows 上单次 git 子进程调用可达数秒(杀毒
// 扫描),与本目录 workflow.test.ts 同样放宽超时。
vi.setConfig({ testTimeout: 60_000 });

/** 收集本套件创建的临时目录,套件结束后统一清理。 */
const fixtures: string[] = [];

afterAll(() => {
  for (const dir of fixtures) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function pkg(
  name: string,
  version: string,
  isPrivate = false,
): WorkspacePackage {
  const shortName = shortNameOf(name);
  return {
    name,
    shortName,
    version,
    isPrivate,
    dir: `packages/${shortName}`,
  };
}

function git(args: readonly string[], cwd: string): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败: ${result.stderr ?? ''}`);
  }
}

function gitOut(args: readonly string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败: ${result.stderr ?? ''}`);
  }
  return (result.stdout ?? '').trim();
}

function writePackage(
  rootDir: string,
  shortName: string,
  manifest: Record<string, unknown>,
): void {
  const pkgDir = join(rootDir, 'packages', shortName);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

/** 最小 workspace fixture(不要求 git):私有 alpha 0.1.0、公开 beta 1.2.3、公开 gamma 2.0.0-rc.1。 */
function makePlainFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-publish-test-'));
  fixtures.push(dir);
  writeFileSync(
    join(dir, 'pnpm-workspace.yaml'),
    "packages:\n  - 'packages/*'\n",
    'utf8',
  );
  writePackage(dir, 'dsh-alpha', {
    name: '@zhidal/dsh-alpha',
    version: '0.1.0',
    private: true,
  });
  writePackage(dir, 'dsh-beta', {
    name: '@zhidal/dsh-beta',
    version: '1.2.3',
  });
  writePackage(dir, 'dsh-gamma', {
    name: '@zhidal/dsh-gamma',
    version: '2.0.0-rc.1',
  });
  return dir;
}

/**
 * 在 plain fixture 基础上补 git 仓库与初始提交,用于 publish 路径(脏树门禁)。
 * 发布线守护要求 publish 决策的 tag 存在且可从 main 到达,故在 main HEAD
 * 预打 `dsh-beta-v1.2.3` tag;需要 tag 在发布线之外的用例自行调整分支。
 */
function makeGitFixture(): string {
  const dir = makePlainFixture();
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.name', 'test'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['add', '.'], dir);
  git(['commit', '-m', 'init'], dir);
  git(['tag', 'dsh-beta-v1.2.3'], dir);
  return dir;
}

/** git fixture 基础上把 tag 打到 main 之外的 dev 提交上,并切回 main。 */
function makeGitFixtureWithTagOffMain(): string {
  const dir = makeGitFixture();
  git(['switch', '-c', 'dev'], dir);
  writeFileSync(join(dir, 'dev-only.txt'), 'dev work', 'utf8');
  git(['add', '.'], dir);
  git(['commit', '-m', 'dev work'], dir);
  git(['tag', '-f', 'dsh-beta-v1.2.3'], dir);
  git(['switch', 'main'], dir);
  return dir;
}

/** 记录调用的发布执行器替身。 */
function recorder(): {
  calls: { cwd: string; command: string; args: string[] }[];
  exec: PublishRunner;
} {
  const calls: { cwd: string; command: string; args: string[] }[] = [];
  return {
    calls,
    exec: (input) => {
      calls.push({
        cwd: input.cwd,
        command: input.command,
        args: [...input.args],
      });
    },
  };
}

describe('release publish(tag 解析与版本判定纯函数)', () => {
  describe('parseReleaseTag 解析 {短包名}-v{semver} tag', () => {
    it('解析正式版、prerelease 与 build 元数据,短名可含连字符', () => {
      expect(parseReleaseTag('dsh-taskboard-v0.2.0')).toEqual({
        shortName: 'dsh-taskboard',
        version: '0.2.0',
      });
      expect(parseReleaseTag('dsh-llm-fallback-v0.4.0-rc.1')).toEqual({
        shortName: 'dsh-llm-fallback',
        version: '0.4.0-rc.1',
      });
      expect(parseReleaseTag('dsh-x-v1.0.0+build.5')).toEqual({
        shortName: 'dsh-x',
        version: '1.0.0+build.5',
      });
    });

    it('非约定 tag 返回 null:缺 -v、版本非法 semver', () => {
      expect(parseReleaseTag('v1.2.3')).toBeNull();
      expect(parseReleaseTag('1.2.3')).toBeNull();
      expect(parseReleaseTag('foo-v1.2')).toBeNull();
      expect(parseReleaseTag('release-2026')).toBeNull();
      expect(parseReleaseTag('')).toBeNull();
    });
  });

  describe('isStableVersion 正式版本判定', () => {
    it('无 prerelease 段为正式版(build 元数据不影响),带 prerelease 段为预发布', () => {
      expect(isStableVersion('1.2.3')).toBe(true);
      expect(isStableVersion('0.0.0')).toBe(true);
      expect(isStableVersion('1.0.0+build.5')).toBe(true);
      expect(isStableVersion('0.4.0-rc.1')).toBe(false);
      expect(isStableVersion('1.0.0-beta')).toBe(false);
    });

    it('非法版本抛 INVALID_CURRENT_VERSION', () => {
      expect(() => isStableVersion('not-a-semver')).toThrowError(
        expect.objectContaining({ code: 'INVALID_CURRENT_VERSION' }),
      );
    });
  });

  describe('publishArgsFor 发布参数组装', () => {
    const scoped = pkg('@zhidal/dsh-beta', '1.2.3');
    const unscoped = pkg('dsh-plain', '1.0.0');

    it('pnpm 客户端带 --no-git-checks,npm 系客户端不带', () => {
      expect(publishArgsFor('pnpm', scoped)).toEqual([
        'publish',
        '--no-git-checks',
        '--access',
        'public',
      ]);
      expect(publishArgsFor('npm', scoped)).toEqual([
        'publish',
        '--access',
        'public',
      ]);
    });

    it('npm-stage 客户端走 stage publish 子命令(暂存队列,人工放行)', () => {
      expect(publishArgsFor('npm-stage', scoped)).toEqual([
        'stage',
        'publish',
        '--access',
        'public',
      ]);
    });

    it('非 scoped 包不带 --access', () => {
      expect(publishArgsFor('pnpm', unscoped)).toEqual([
        'publish',
        '--no-git-checks',
      ]);
      expect(publishArgsFor('npm', unscoped)).toEqual(['publish']);
      expect(publishArgsFor('npm-stage', unscoped)).toEqual([
        'stage',
        'publish',
      ]);
    });
  });

  describe('decidePublish 三态发布决策(纯函数矩阵)', () => {
    const packages = [
      pkg('@zhidal/dsh-alpha', '0.1.0', true),
      pkg('@zhidal/dsh-beta', '1.2.3'),
      pkg('@zhidal/dsh-gamma', '2.0.0-rc.1'),
    ];

    it('公开包正式版本且版本一致 → publish', () => {
      expect(decidePublish({ tag: 'dsh-beta-v1.2.3', packages })).toMatchObject(
        {
          action: 'publish',
          version: '1.2.3',
          pkg: { name: '@zhidal/dsh-beta' },
        },
      );
    });

    it('prerelease 版本 → skip(PRERELEASE_VERSION),不发布 npm', () => {
      expect(
        decidePublish({ tag: 'dsh-gamma-v2.0.0-rc.1', packages }),
      ).toMatchObject({ action: 'skip', reason: 'PRERELEASE_VERSION' });
    });

    it('私有包正式版本 → skip(PRIVATE_PACKAGE)', () => {
      expect(
        decidePublish({ tag: 'dsh-alpha-v0.1.0', packages }),
      ).toMatchObject({ action: 'skip', reason: 'PRIVATE_PACKAGE' });
    });

    it('非约定 tag → skip(NOT_RELEASE_TAG)', () => {
      expect(decidePublish({ tag: 'release-2026', packages })).toMatchObject({
        action: 'skip',
        reason: 'NOT_RELEASE_TAG',
      });
    });

    it('短名无对应包 → fail(PKG_NOT_FOUND)', () => {
      expect(decidePublish({ tag: 'dsh-none-v1.0.0', packages })).toMatchObject(
        { action: 'fail', reason: 'PKG_NOT_FOUND' },
      );
    });

    it('tag 版本与清单版本不一致 → fail(TAG_VERSION_MISMATCH)', () => {
      expect(decidePublish({ tag: 'dsh-beta-v9.9.9', packages })).toMatchObject(
        { action: 'fail', reason: 'TAG_VERSION_MISMATCH' },
      );
    });

    it('短名命中多个 scope 包 → fail(PKG_AMBIGUOUS)', () => {
      const ambiguous = [...packages, pkg('@other/dsh-beta', '3.0.0')];
      expect(
        decidePublish({ tag: 'dsh-beta-v1.2.3', packages: ambiguous }),
      ).toMatchObject({ action: 'fail', reason: 'PKG_AMBIGUOUS' });
    });
  });
});

describe('release publish(临时 workspace 端到端)', () => {
  it('skip 决策不执行任何命令且不要求 git 仓库', () => {
    const root = makePlainFixture();
    const { calls, exec } = recorder();
    const outcome = publishForTag({
      rootDir: root,
      tag: 'dsh-alpha-v0.1.0',
      exec,
    });
    expect(outcome.decision).toMatchObject({
      action: 'skip',
      reason: 'PRIVATE_PACKAGE',
    });
    expect(outcome.published).toBe(false);
    expect(calls).toEqual([]);
  });

  it('prerelease tag 跳过发布:公开包也不走 npm', () => {
    const root = makePlainFixture();
    const { calls, exec } = recorder();
    const outcome = publishForTag({
      rootDir: root,
      tag: 'dsh-gamma-v2.0.0-rc.1',
      exec,
    });
    expect(outcome.decision).toMatchObject({
      action: 'skip',
      reason: 'PRERELEASE_VERSION',
    });
    expect(calls).toEqual([]);
  });

  it('版本不一致抛 TAG_VERSION_MISMATCH,不执行任何命令', () => {
    const root = makePlainFixture();
    const { calls, exec } = recorder();
    expect(() =>
      publishForTag({ rootDir: root, tag: 'dsh-beta-v9.9.9', exec }),
    ).toThrowError(expect.objectContaining({ code: 'TAG_VERSION_MISMATCH' }));
    expect(calls).toEqual([]);
  });

  it('dry-run 完整预览 publish 命令但不执行(scoped 包自动带 --access public)', () => {
    const root = makeGitFixture();
    const { calls, exec } = recorder();
    const outcome = publishForTag({
      rootDir: root,
      tag: 'dsh-beta-v1.2.3',
      dryRun: true,
      exec,
    });
    expect(outcome.decision).toMatchObject({
      action: 'publish',
      pkg: { name: '@zhidal/dsh-beta', version: '1.2.3' },
    });
    expect(outcome.command).toBe(
      'pnpm publish --no-git-checks --access public(cwd: packages/dsh-beta)',
    );
    expect(outcome.published).toBe(false);
    expect(calls).toEqual([]);
  });

  it('干净工作树上执行发布:注入执行器收到包目录 cwd 与 publish 参数', () => {
    const root = makeGitFixture();
    const { calls, exec } = recorder();
    const outcome = publishForTag({
      rootDir: root,
      tag: 'dsh-beta-v1.2.3',
      exec,
    });
    expect(outcome.published).toBe(true);
    expect(calls).toEqual([
      {
        cwd: join(root, 'packages', 'dsh-beta'),
        command: 'pnpm',
        args: ['publish', '--no-git-checks', '--access', 'public'],
      },
    ]);
    expect(gitOut(['status', '--porcelain'], root)).toBe('');
  });

  it('client=npm 走 npm CLI:无 --no-git-checks,适配 OIDC trusted publishing', () => {
    const root = makeGitFixture();
    const { calls, exec } = recorder();
    const outcome = publishForTag({
      rootDir: root,
      tag: 'dsh-beta-v1.2.3',
      client: 'npm',
      exec,
    });
    expect(outcome.published).toBe(true);
    expect(outcome.command).toBe(
      'npm publish --access public(cwd: packages/dsh-beta)',
    );
    expect(calls).toEqual([
      {
        cwd: join(root, 'packages', 'dsh-beta'),
        command: 'npm',
        args: ['publish', '--access', 'public'],
      },
    ]);
  });

  it('client=npm-stage 走 stage publish:版本进暂存队列,人工放行后才公开', () => {
    const root = makeGitFixture();
    const { calls, exec } = recorder();
    const outcome = publishForTag({
      rootDir: root,
      tag: 'dsh-beta-v1.2.3',
      client: 'npm-stage',
      exec,
    });
    expect(outcome.published).toBe(true);
    expect(outcome.command).toBe(
      'npm stage publish --access public(cwd: packages/dsh-beta)',
    );
    expect(calls).toEqual([
      {
        cwd: join(root, 'packages', 'dsh-beta'),
        command: 'npm',
        args: ['stage', 'publish', '--access', 'public'],
      },
    ]);
  });

  it('脏工作树默认拒绝发布(DIRTY_WORKTREE),dry-run 与 --allow-dirty 放行', () => {
    const root = makeGitFixture();
    writeFileSync(join(root, 'stray.txt'), 'uncommitted', 'utf8');
    const { calls, exec } = recorder();
    expect(() =>
      publishForTag({ rootDir: root, tag: 'dsh-beta-v1.2.3', exec }),
    ).toThrowError(expect.objectContaining({ code: 'DIRTY_WORKTREE' }));
    expect(calls).toEqual([]);
    // dry-run 只预览,不受脏树限制
    const preview = publishForTag({
      rootDir: root,
      tag: 'dsh-beta-v1.2.3',
      dryRun: true,
      exec,
    });
    expect(preview.decision.action).toBe('publish');
    // 显式 --allow-dirty 是逃生门
    const forced = publishForTag({
      rootDir: root,
      tag: 'dsh-beta-v1.2.3',
      allowDirty: true,
      exec,
    });
    expect(forced.published).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('发布执行器非零退出抛 PUBLISH_FAILED', () => {
    const root = makeGitFixture();
    const failing: PublishRunner = () => {
      throw new ReleaseError('PUBLISH_FAILED', 'pnpm publish 失败(exit 1)');
    };
    expect(() =>
      publishForTag({ rootDir: root, tag: 'dsh-beta-v1.2.3', exec: failing }),
    ).toThrowError(expect.objectContaining({ code: 'PUBLISH_FAILED' }));
  });
});

describe('release publish(发布线守护)', () => {
  it('tag 打在 main 之外的 dev 提交上 → TAG_NOT_ON_MAIN,实发与 dry-run 都拒绝', () => {
    const root = makeGitFixtureWithTagOffMain();
    const { calls, exec } = recorder();
    expect(() =>
      publishForTag({ rootDir: root, tag: 'dsh-beta-v1.2.3', exec }),
    ).toThrowError(expect.objectContaining({ code: 'TAG_NOT_ON_MAIN' }));
    expect(() =>
      publishForTag({
        rootDir: root,
        tag: 'dsh-beta-v1.2.3',
        dryRun: true,
        exec,
      }),
    ).toThrowError(expect.objectContaining({ code: 'TAG_NOT_ON_MAIN' }));
    expect(calls).toEqual([]);
  });

  it('dev 上的 tag 合入 main 后变为可达 → 守护放行并执行发布', () => {
    const root = makeGitFixtureWithTagOffMain();
    git(['merge', 'dev'], root);
    const { calls, exec } = recorder();
    const outcome = publishForTag({
      rootDir: root,
      tag: 'dsh-beta-v1.2.3',
      exec,
    });
    expect(outcome.decision.action).toBe('publish');
    expect(outcome.published).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('本地无 main 时回退 origin/main(CI tag 检出形态)→ 守护放行', () => {
    const dir = makePlainFixture();
    git(['init', '-b', 'dev'], dir);
    git(['config', 'user.name', 'test'], dir);
    git(['config', 'user.email', 'test@example.com'], dir);
    git(['add', '.'], dir);
    git(['commit', '-m', 'init'], dir);
    git(['tag', 'dsh-beta-v1.2.3'], dir);
    // 模拟 CI fetch-depth: 0 之后的远端跟踪 ref:origin/main 含该 tag
    git(['remote', 'add', 'origin', '.'], dir);
    git(['update-ref', 'refs/remotes/origin/main', 'dsh-beta-v1.2.3'], dir);
    const { calls, exec } = recorder();
    const outcome = publishForTag({
      rootDir: dir,
      tag: 'dsh-beta-v1.2.3',
      exec,
    });
    expect(outcome.published).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('本地与 origin 均无 main → RELEASE_LINE_NOT_FOUND', () => {
    const dir = makePlainFixture();
    git(['init', '-b', 'dev'], dir);
    git(['config', 'user.name', 'test'], dir);
    git(['config', 'user.email', 'test@example.com'], dir);
    git(['add', '.'], dir);
    git(['commit', '-m', 'init'], dir);
    git(['tag', 'dsh-beta-v1.2.3'], dir);
    expect(() =>
      publishForTag({
        rootDir: dir,
        tag: 'dsh-beta-v1.2.3',
        exec: recorder().exec,
      }),
    ).toThrowError(expect.objectContaining({ code: 'RELEASE_LINE_NOT_FOUND' }));
  });

  it('tag 在仓库中不存在(版本恰好与清单一致)→ TAG_NOT_FOUND,dry-run 同样拒绝', () => {
    const root = makeGitFixture();
    // 清单版本改成 9.9.9(未提交也无妨:守护先于脏树门禁),对应 tag 不存在
    writePackage(root, 'dsh-beta', {
      name: '@zhidal/dsh-beta',
      version: '9.9.9',
    });
    const { calls, exec } = recorder();
    expect(() =>
      publishForTag({ rootDir: root, tag: 'dsh-beta-v9.9.9', exec }),
    ).toThrowError(expect.objectContaining({ code: 'TAG_NOT_FOUND' }));
    expect(() =>
      publishForTag({
        rootDir: root,
        tag: 'dsh-beta-v9.9.9',
        dryRun: true,
        exec,
      }),
    ).toThrowError(expect.objectContaining({ code: 'TAG_NOT_FOUND' }));
    expect(calls).toEqual([]);
  });
});
