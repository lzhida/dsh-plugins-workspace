import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ReleaseError, shortNameOf } from './core.ts';
import type { WorkspacePackage } from './core.ts';
import {
  createNpmVersionExists,
  decidePublish,
  isStableVersion,
  parseReleaseTag,
  parseVersionProbeResult,
  publishArgsFor,
  publishForTag,
} from './publish.ts';
import type { PublishOutcome, PublishRunner, VersionProbe } from './publish.ts';

// 临时 git 仓库端到端在本机 Windows 上单次 git 子进程调用可达数秒(杀毒
// 扫描),与本目录 workflow.test.ts 同样放宽超时。
vi.setConfig({ testTimeout: 60_000 });

/**
 * 禁触网 tripwire:任何 `npm` 子进程调用都被拦下(抛错,不真正执行),并记录
 * 到 npmSpawnAttempts。单测必须显式注入 versionExists 替身;若将来新增
 * 用例漏注入,默认探测器会被这里拦下(不会真访问 registry),且 afterAll
 * 的断言会让该套件变红。
 */
const { npmSpawnAttempts } = vi.hoisted(() => ({
  npmSpawnAttempts: [] as { command: string; args: string[] }[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: (
      command: string,
      args: readonly string[] = [],
      options?: unknown,
    ): unknown => {
      if (String(command).toLowerCase().includes('npm')) {
        npmSpawnAttempts.push({ command, args: [...args] });
        throw new Error('单测禁止触网:npm 调用必须走注入的 versionExists 替身');
      }
      return Reflect.apply(actual.spawnSync, actual, [command, args, options]);
    },
  };
});

/** 收集本套件创建的临时目录,套件结束后统一清理。 */
const fixtures: string[] = [];

afterAll(() => {
  expect(npmSpawnAttempts).toEqual([]);
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
  // 固化签名与模板开关:开发者本机的全局 commit.gpgsign / tag.gpgSign /
  // init.templateDir 会让 fixture 的 commit/tag 偶发失败(CI 容器无此配置)。
  git(['config', 'commit.gpgsign', 'false'], dir);
  git(['config', 'tag.gpgSign', 'false'], dir);
  git(['config', 'core.hooksPath', join(dir, '.git', 'no-hooks')], dir);
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

/**
 * 测试里统一注入的版本探测替身:恒为「未发布」。
 * publishForTag 默认走 npm view 真实触网,测试必须显式注入,否则单测会
 * 依赖 registry 状态(既慢又不确定)。
 */
const notPublished: VersionProbe = () => 'missing';

/**
 * 包一层 publishForTag:统一注入「未发布」探测替身,避免真实触网。
 * 需要验证幂等守卫本身的用例直接调 publishForTag 并显式注入探测器。
 */
function publishInFixture(
  input: Omit<Parameters<typeof publishForTag>[0], 'versionExists'>,
): PublishOutcome {
  return publishForTag(
    Object.assign({}, input, { versionExists: notPublished }),
  );
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

  describe('parseVersionProbeResult registry 版本探测结果解析', () => {
    it('退出码 0 且 stdout 非空 → exists(版本已发布)', () => {
      expect(
        parseVersionProbeResult({
          status: 0,
          stdout: '"1.2.3"\n',
          stderr: '',
        }),
      ).toBe('exists');
    });

    it('退出码 0 但 stdout 为空 → missing(查无此版本)', () => {
      expect(
        parseVersionProbeResult({ status: 0, stdout: '  \n', stderr: '' }),
      ).toBe('missing');
    });

    it('退出码非 0 且 stderr 命中 E404 → missing(包或版本不存在)', () => {
      expect(
        parseVersionProbeResult({
          status: 1,
          stdout: '',
          stderr: 'npm error code E404\nnpm error 404 Not Found',
        }),
      ).toBe('missing');
    });

    it('其余失败形态 → unknown(无法判定,fail-open 按未发布处理)', () => {
      expect(
        parseVersionProbeResult({
          status: 1,
          stdout: '',
          stderr: 'npm error code E401 Unauthorized',
        }),
      ).toBe('unknown');
      expect(
        parseVersionProbeResult({ status: null, stdout: '', stderr: '' }),
      ).toBe('unknown');
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
    const outcome = publishInFixture({
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
    const outcome = publishInFixture({
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
      publishInFixture({ rootDir: root, tag: 'dsh-beta-v9.9.9', exec }),
    ).toThrowError(expect.objectContaining({ code: 'TAG_VERSION_MISMATCH' }));
    expect(calls).toEqual([]);
  });

  it('dry-run 完整预览 publish 命令但不执行(scoped 包自动带 --access public)', () => {
    const root = makeGitFixture();
    const { calls, exec } = recorder();
    const outcome = publishInFixture({
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
    const outcome = publishInFixture({
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
    const outcome = publishInFixture({
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
    const outcome = publishInFixture({
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
      publishInFixture({ rootDir: root, tag: 'dsh-beta-v1.2.3', exec }),
    ).toThrowError(expect.objectContaining({ code: 'DIRTY_WORKTREE' }));
    expect(calls).toEqual([]);
    // dry-run 只预览,不受脏树限制
    const preview = publishInFixture({
      rootDir: root,
      tag: 'dsh-beta-v1.2.3',
      dryRun: true,
      exec,
    });
    expect(preview.decision.action).toBe('publish');
    // 显式 --allow-dirty 是逃生门
    const forced = publishInFixture({
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
      publishInFixture({
        rootDir: root,
        tag: 'dsh-beta-v1.2.3',
        exec: failing,
      }),
    ).toThrowError(expect.objectContaining({ code: 'PUBLISH_FAILED' }));
  });
});

describe('release publish(发布线守护)', () => {
  it('tag 打在 main 之外的 dev 提交上 → TAG_NOT_ON_MAIN,实发与 dry-run 都拒绝', () => {
    const root = makeGitFixtureWithTagOffMain();
    const { calls, exec } = recorder();
    expect(() =>
      publishInFixture({ rootDir: root, tag: 'dsh-beta-v1.2.3', exec }),
    ).toThrowError(expect.objectContaining({ code: 'TAG_NOT_ON_MAIN' }));
    expect(() =>
      publishInFixture({
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
    const outcome = publishInFixture({
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
    const outcome = publishInFixture({
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
      publishInFixture({
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
      publishInFixture({ rootDir: root, tag: 'dsh-beta-v9.9.9', exec }),
    ).toThrowError(expect.objectContaining({ code: 'TAG_NOT_FOUND' }));
    expect(() =>
      publishInFixture({
        rootDir: root,
        tag: 'dsh-beta-v9.9.9',
        dryRun: true,
        exec,
      }),
    ).toThrowError(expect.objectContaining({ code: 'TAG_NOT_FOUND' }));
    expect(calls).toEqual([]);
  });
});

describe('release publish(registry 幂等守卫)', () => {
  it('版本已存在于 registry → 不执行发布命令,标记 alreadyPublished/skipped', () => {
    const root = makeGitFixture();
    const { calls, exec } = recorder();
    const probes: { pkgName: string; version: string }[] = [];
    const outcome = publishForTag({
      rootDir: root,
      tag: 'dsh-beta-v1.2.3',
      exec,
      versionExists: (input) => {
        probes.push({ pkgName: input.pkgName, version: input.version });
        return 'exists';
      },
    });
    expect(outcome.published).toBe(true);
    expect(outcome.alreadyPublished).toBe(true);
    expect(outcome.skipped).toBe('already-published');
    expect(outcome.probe).toBe('exists');
    expect(outcome.command).toBe(
      'pnpm publish --no-git-checks --access public(cwd: packages/dsh-beta)',
    );
    expect(calls).toEqual([]);
    expect(probes).toEqual([{ pkgName: '@zhidal/dsh-beta', version: '1.2.3' }]);
  });

  it('版本未发布 → 照旧执行发布命令(不标 alreadyPublished)', () => {
    const root = makeGitFixture();
    const { calls, exec } = recorder();
    let probeCalls = 0;
    const outcome = publishForTag({
      rootDir: root,
      tag: 'dsh-beta-v1.2.3',
      exec,
      versionExists: () => {
        probeCalls += 1;
        return 'missing';
      },
    });
    expect(outcome.published).toBe(true);
    expect(outcome.alreadyPublished).toBeUndefined();
    expect(outcome.skipped).toBeUndefined();
    expect(outcome.probe).toBe('missing');
    expect(probeCalls).toBe(1);
    expect(calls).toEqual([
      {
        cwd: join(root, 'packages', 'dsh-beta'),
        command: 'pnpm',
        args: ['publish', '--no-git-checks', '--access', 'public'],
      },
    ]);
  });

  it('探测器抛异常 → fail-open:仍按未发布继续执行发布,不中断流水线', () => {
    const root = makeGitFixture();
    const { calls, exec } = recorder();
    const outcome = publishForTag({
      rootDir: root,
      tag: 'dsh-beta-v1.2.3',
      exec,
      versionExists: () => {
        throw new Error('probe boom');
      },
    });
    expect(outcome.probe).toBe('unknown');
    expect(outcome.skipped).toBeUndefined();
    expect(outcome.alreadyPublished).toBeUndefined();
    expect(outcome.published).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('探测失败(unknown)按 fail-open 继续发布,probe 结论透出', () => {
    const root = makeGitFixture();
    const { calls, exec } = recorder();
    const outcome = publishForTag({
      rootDir: root,
      tag: 'dsh-beta-v1.2.3',
      exec,
      versionExists: () => 'unknown',
    });
    expect(outcome.probe).toBe('unknown');
    expect(outcome.skipped).toBeUndefined();
    expect(outcome.published).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('版本已存在时不因脏工作树被拦(本次本就不发布)', () => {
    const root = makeGitFixture();
    writeFileSync(join(root, 'dirty.txt'), 'dirty', 'utf8');
    const { calls, exec } = recorder();
    const outcome = publishForTag({
      rootDir: root,
      tag: 'dsh-beta-v1.2.3',
      exec,
      versionExists: () => 'exists',
    });
    expect(outcome.skipped).toBe('already-published');
    expect(calls).toEqual([]);
  });

  it('dry-run 不做版本探测(全程不触网)', () => {
    const root = makeGitFixture();
    const { calls, exec } = recorder();
    let probed = false;
    const outcome = publishForTag({
      rootDir: root,
      tag: 'dsh-beta-v1.2.3',
      dryRun: true,
      exec,
      versionExists: () => {
        probed = true;
        return 'exists';
      },
    });
    expect(outcome.dryRun).toBe(true);
    expect(probed).toBe(false);
    expect(calls).toEqual([]);
  });

  it('skip 决策(私有包/预发布)不触发版本探测', () => {
    const root = makePlainFixture();
    const { calls, exec } = recorder();
    let probed = false;
    const outcome = publishForTag({
      rootDir: root,
      tag: 'dsh-alpha-v0.1.0',
      exec,
      versionExists: () => {
        probed = true;
        return 'exists';
      },
    });
    expect(outcome.decision).toMatchObject({
      action: 'skip',
      reason: 'PRIVATE_PACKAGE',
    });
    expect(probed).toBe(false);
    expect(calls).toEqual([]);
  });

  it('fail 决策(版本不一致)不触发版本探测,直接抛错', () => {
    const root = makePlainFixture();
    const { calls, exec } = recorder();
    let probed = false;
    expect(() =>
      publishForTag({
        rootDir: root,
        tag: 'dsh-beta-v9.9.9',
        exec,
        versionExists: () => {
          probed = true;
          return 'exists';
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'TAG_VERSION_MISMATCH' }));
    expect(probed).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('release publish(默认 npm 探测器的可测性)', () => {
  it('createNpmVersionExists 走 npm view <pkg>@<版本> version --json', () => {
    const seen: { command: string; args: readonly string[] }[] = [];
    const probe = createNpmVersionExists((command, args) => {
      seen.push({ command, args: [...args] });
      return { status: 0, stdout: '"1.2.3"\n', stderr: '' };
    });
    expect(probe({ pkgName: '@zhidal/dsh-beta', version: '1.2.3' })).toBe(
      'exists',
    );
    expect(seen).toEqual([
      {
        command: 'npm',
        args: ['view', '@zhidal/dsh-beta@1.2.3', 'version', '--json'],
      },
    ]);
  });

  it('退出码 0 但 stdout 为空 → missing;E404 → missing;其余 → unknown', () => {
    const empty = createNpmVersionExists(() => ({
      status: 0,
      stdout: '',
      stderr: '',
    }));
    expect(empty({ pkgName: 'x', version: '1.0.0' })).toBe('missing');
    const notFound = createNpmVersionExists(() => ({
      status: 1,
      stdout: '',
      stderr: 'npm error code E404',
    }));
    expect(notFound({ pkgName: 'x', version: '1.0.0' })).toBe('missing');
    const broken = createNpmVersionExists(() => ({
      status: 1,
      stdout: '',
      stderr: 'npm error code E401 Unauthorized',
    }));
    expect(broken({ pkgName: 'x', version: '1.0.0' })).toBe('unknown');
  });
});
