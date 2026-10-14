import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { githubReleaseForTag, runGhCommand } from './github-release.ts';
import type { GhRunner } from './github-release.ts';

const CHANGELOG = `# @zhidal/dsh-demo

## 1.0.0

### Minor Changes

- abc1234: 新增演示功能
`;

/** 收集临时目录统一清理。 */
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface FixtureOptions {
  readonly version?: string;
  readonly private?: boolean;
  readonly changelog?: string;
}

/** 最小 workspace fixture:单包 dsh-demo;decidePublish 为纯函数,无需 git。 */
function makeFixture(options: FixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gh-release-test-'));
  dirs.push(root);
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    "packages:\n  - 'packages/*'\n",
    'utf8',
  );
  const pkgDir = join(root, 'packages', 'dsh-demo');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    `${JSON.stringify(
      {
        name: '@zhidal/dsh-demo',
        version: options.version ?? '1.0.0',
        ...(options.private === true ? { private: true } : {}),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  if (options.changelog !== undefined) {
    writeFileSync(join(pkgDir, 'CHANGELOG.md'), options.changelog, 'utf8');
  }
  return root;
}

/** 记录 gh 调用的注入执行器。 */
function recordingRunner(): {
  calls: Array<{ cwd: string; command: string; args: readonly string[] }>;
  runner: GhRunner;
} {
  const calls: Array<{
    cwd: string;
    command: string;
    args: readonly string[];
  }> = [];
  const runner: GhRunner = (input) => {
    calls.push(input);
    return {};
  };
  return { calls, runner };
}

describe('githubReleaseForTag', () => {
  it('publish 决策:执行 gh release create,title/notes 取包 CHANGELOG 版本段', () => {
    const root = makeFixture({ changelog: CHANGELOG });
    const { calls, runner } = recordingRunner();
    const outcome = githubReleaseForTag({
      rootDir: root,
      tag: 'dsh-demo-v1.0.0',
      exec: runner,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('gh');
    expect(calls[0]?.cwd).toBe(root);
    expect(calls[0]?.args[0]).toBe('release');
    expect(calls[0]?.args[1]).toBe('create');
    expect(calls[0]?.args[2]).toBe('dsh-demo-v1.0.0');
    const args = calls[0]!.args;
    expect(args).toContain('--title');
    expect(args[args.indexOf('--title') + 1]).toBe('@zhidal/dsh-demo v1.0.0');
    expect(args).toContain('--notes');
    expect(args[args.indexOf('--notes') + 1]).toContain('新增演示功能');
    expect(args).toContain('--verify-tag');
    expect(outcome.created).toBe(true);
    expect(outcome.alreadyExists).toBe(false);
    expect(outcome.notes).toContain('新增演示功能');
  });

  it('CHANGELOG 缺失:notes 走兜底文案,创建不被阻塞', () => {
    const root = makeFixture();
    const { calls, runner } = recordingRunner();
    const outcome = githubReleaseForTag({
      rootDir: root,
      tag: 'dsh-demo-v1.0.0',
      exec: runner,
    });
    expect(calls).toHaveLength(1);
    expect(outcome.notes).toContain('@zhidal/dsh-demo v1.0.0');
    expect(outcome.notes).toContain('1.0.0 的更新段落');
    expect(outcome.created).toBe(true);
  });

  it('非发布 tag → skip:不调用 gh,notes 为 null', () => {
    const root = makeFixture({ changelog: CHANGELOG });
    const { calls, runner } = recordingRunner();
    const outcome = githubReleaseForTag({
      rootDir: root,
      tag: 'not-a-release-tag',
      exec: runner,
    });
    expect(calls).toHaveLength(0);
    expect(outcome.created).toBe(false);
    expect(outcome.notes).toBeNull();
  });

  it('prerelease 版本 → skip:不调用 gh(与 npm 发布决策一致)', () => {
    const root = makeFixture({ version: '1.0.0-rc.1' });
    const { calls, runner } = recordingRunner();
    const outcome = githubReleaseForTag({
      rootDir: root,
      tag: 'dsh-demo-v1.0.0-rc.1',
      exec: runner,
    });
    expect(calls).toHaveLength(0);
    expect(outcome.created).toBe(false);
  });

  it('私有包 → skip:不调用 gh', () => {
    const root = makeFixture({ private: true, changelog: CHANGELOG });
    const { calls, runner } = recordingRunner();
    const outcome = githubReleaseForTag({
      rootDir: root,
      tag: 'dsh-demo-v1.0.0',
      exec: runner,
    });
    expect(calls).toHaveLength(0);
    expect(outcome.created).toBe(false);
  });

  it('tag 版本与清单不一致 → 抛 TAG_VERSION_MISMATCH(fail 决策透传)', () => {
    const root = makeFixture({ changelog: CHANGELOG });
    const { calls, runner } = recordingRunner();
    expect(() =>
      githubReleaseForTag({
        rootDir: root,
        tag: 'dsh-demo-v9.9.9',
        exec: runner,
      }),
    ).toThrowError(expect.objectContaining({ code: 'TAG_VERSION_MISMATCH' }));
    expect(calls).toHaveLength(0);
  });

  it('幂等:执行器报告 release 已存在 → 按成功处理,不重复创建', () => {
    const root = makeFixture({ changelog: CHANGELOG });
    const outcome = githubReleaseForTag({
      rootDir: root,
      tag: 'dsh-demo-v1.0.0',
      exec: () => ({ alreadyExists: true }),
    });
    expect(outcome.alreadyExists).toBe(true);
    expect(outcome.created).toBe(false);
    expect(outcome.notes).toContain('新增演示功能');
  });

  it('dry-run:不调用 gh,返回将执行的命令与 notes 预览', () => {
    const root = makeFixture({ changelog: CHANGELOG });
    const { calls, runner } = recordingRunner();
    const outcome = githubReleaseForTag({
      rootDir: root,
      tag: 'dsh-demo-v1.0.0',
      dryRun: true,
      exec: runner,
    });
    expect(calls).toHaveLength(0);
    expect(outcome.dryRun).toBe(true);
    expect(outcome.created).toBe(false);
    expect(outcome.command).toContain('gh release create dsh-demo-v1.0.0');
    expect(outcome.command).toContain('--verify-tag');
    expect(outcome.notes).toContain('新增演示功能');
  });
});

describe('runGhCommand(默认执行器)', () => {
  it('release 已存在(stderr 命中)→ 返回 alreadyExists,不抛错', () => {
    // 真实子进程:node 退出 1 并向 stderr 写 already exists 形态消息
    const result = runGhCommand({
      cwd: tmpdir(),
      command: process.execPath,
      args: ['-e', 'console.error("release already exists");process.exit(1)'],
    });
    expect(result?.alreadyExists).toBe(true);
  });

  it('其他非零退出 → 抛 PUBLISH_FAILED 并携带 stderr', () => {
    expect(() =>
      runGhCommand({
        cwd: tmpdir(),
        command: process.execPath,
        args: ['-e', 'console.error("boom");process.exit(1)'],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'PUBLISH_FAILED',
        message: expect.stringContaining('boom'),
      }),
    );
  });

  it('命令不存在 → 抛 PUBLISH_FAILED(ENOENT 降级为可读文案)', () => {
    expect(() =>
      runGhCommand({
        cwd: tmpdir(),
        command: 'dsh-nonexistent-cli-for-test',
        args: [],
      }),
    ).toThrowError(expect.objectContaining({ code: 'PUBLISH_FAILED' }));
  });

  it('零退出 → 返回空结果', () => {
    const result = runGhCommand({
      cwd: tmpdir(),
      command: process.execPath,
      args: ['-e', ''],
    });
    expect(result).toEqual({});
  });
});
