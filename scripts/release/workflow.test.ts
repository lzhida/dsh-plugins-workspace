import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ReleaseError } from './core.ts';
import { tagAllPackages, tagPackage } from './workflow.ts';
import { listWorkspacePackages } from './workspace.ts';

// 临时 git 仓库端到端在本机 Windows 上单次 git 子进程调用可达数秒(杀软扫描),
// 放宽本文件测试超时,避免环境波动造成误报。
vi.setConfig({ testTimeout: 60_000 });

/** 收集本套件创建的临时仓库,套件结束后统一清理。 */
const fixtures: string[] = [];

afterAll(() => {
  for (const dir of fixtures) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
  changelog?: string,
): void {
  const pkgDir = join(rootDir, 'packages', shortName);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  if (changelog !== undefined) {
    writeFileSync(join(pkgDir, 'CHANGELOG.md'), changelog, 'utf8');
  }
}

/** 构建最小 monorepo fixture:两个子包(dsh-alpha private、dsh-beta public)+ 初始提交。 */
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-release-test-'));
  fixtures.push(dir);
  git(['init', '-b', 'main'], dir);
  // 仓库级身份:annotated tag 的 committer 需要身份,而 CI runner 没有全局
  // git 配置(本地复现:GIT_CONFIG_GLOBAL/SYSTEM 指向空文件即 5 个 tag 用例
  // 全红),只靠初始 commit 的 -c 一次性身份覆盖不到后续 git tag -a。
  git(['config', 'user.name', 'test'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  writeFileSync(
    join(dir, 'pnpm-workspace.yaml'),
    "packages:\n  - 'packages/*'\n",
    'utf8',
  );
  writePackage(dir, 'dsh-alpha', {
    name: '@lzhida/dsh-alpha',
    version: '0.1.0',
    private: true,
  });
  writePackage(dir, 'dsh-beta', {
    name: '@zhidal/dsh-beta',
    version: '1.2.3',
  });
  git(['add', '.'], dir);
  // git 身份配置合并进 commit(-c),减少一次子进程调用
  git(
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'init',
    ],
    dir,
  );
  return dir;
}

function tagPointsAtHead(rootDir: string, tag: string): boolean {
  const result = spawnSync('git', ['rev-parse', `${tag}^{commit}`, 'HEAD'], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  if (result.status !== 0) return false;
  const lines = (result.stdout ?? '').trim().split(/\r?\n/);
  return lines.length === 2 && lines[0] === lines[1];
}

describe('release workflow(临时 git 仓库端到端)', () => {
  it('listWorkspacePackages 发现全部子包并携带完整字段', () => {
    const root = makeFixture();
    const packages = listWorkspacePackages(root);
    expect(packages.map((pkg) => pkg.name)).toEqual([
      '@lzhida/dsh-alpha',
      '@zhidal/dsh-beta',
    ]);
    expect(packages[0]).toMatchObject({
      shortName: 'dsh-alpha',
      version: '0.1.0',
      isPrivate: true,
      dir: 'packages/dsh-alpha',
    });
    expect(packages[1]).toMatchObject({
      isPrivate: false,
      dir: 'packages/dsh-beta',
    });
  });

  it('tagPackage 为已提交的当前版本打 annotated tag,指向 HEAD 且消息含完整包名', () => {
    const root = makeFixture();
    const outcome = tagPackage({ rootDir: root, query: '@zhidal/dsh-beta' });
    expect(outcome).toMatchObject({
      pkg: { name: '@zhidal/dsh-beta' },
      version: '1.2.3',
      tag: 'dsh-beta-v1.2.3',
      branch: 'main',
      dryRun: false,
    });
    expect(tagPointsAtHead(root, 'dsh-beta-v1.2.3')).toBe(true);
    expect(gitOut(['tag', '--list'], root)).toBe('dsh-beta-v1.2.3');
    const message = gitOut(['tag', '--list', '--format=%(contents)'], root);
    expect(message).toContain('@zhidal/dsh-beta v1.2.3');
  });

  it('tagPackage 包带 CHANGELOG 时,tag message 为 subject + 空行 + 该版本段落', () => {
    const root = makeFixture();
    // makeFixture 之后补写:给 dsh-beta 加 CHANGELOG(仍纳入工作树会弄脏 →
    // 直接提交后再打 tag,保证 clean 检查通过)
    writeFileSync(
      join(root, 'packages', 'dsh-beta', 'CHANGELOG.md'),
      '# @zhidal/dsh-beta\n\n## 1.2.3\n\n### Minor Changes\n\n- abc1234: 新增演示功能\n',
      'utf8',
    );
    git(['add', '.'], root);
    git(
      [
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'docs: changelog',
      ],
      root,
    );
    const outcome = tagPackage({ rootDir: root, query: '@zhidal/dsh-beta' });
    // outcome.message = subject + 空行 + 版本段
    expect(outcome.message).toBe(
      '@zhidal/dsh-beta v1.2.3\n\n### Minor Changes\n\n- abc1234: 新增演示功能',
    );
    const message = gitOut(['tag', '--list', '--format=%(contents)'], root);
    expect(message).toContain('@zhidal/dsh-beta v1.2.3');
    expect(message).toContain('新增演示功能');
  });

  it('tagPackage 包 CHANGELOG 无该版本段落时降级为纯 subject', () => {
    const root = makeFixture();
    writeFileSync(
      join(root, 'packages', 'dsh-beta', 'CHANGELOG.md'),
      '# @zhidal/dsh-beta\n\n## 0.0.1\n\n- 旧版本内容\n',
      'utf8',
    );
    git(['add', '.'], root);
    git(
      [
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'docs: changelog',
      ],
      root,
    );
    const outcome = tagPackage({ rootDir: root, query: '@zhidal/dsh-beta' });
    expect(outcome.message).toBe('@zhidal/dsh-beta v1.2.3');
  });

  it('tagPackage dry-run 完整预览但不打 tag', () => {
    const root = makeFixture();
    const preview = tagPackage({
      rootDir: root,
      query: 'dsh-beta',
      dryRun: true,
    });
    expect(preview).toMatchObject({
      tag: 'dsh-beta-v1.2.3',
      branch: 'main',
      dryRun: true,
    });
    // 无 CHANGELOG:预览 message 为纯 subject(降级路径在 dry-run 同样可见)
    expect(preview.message).toBe('@zhidal/dsh-beta v1.2.3');
    expect(gitOut(['tag', '--list'], root)).toBe('');
  });

  it('tagPackage 当前版本 tag 已存在时抛 TAG_EXISTS', () => {
    const root = makeFixture();
    git(['tag', '-a', 'dsh-beta-v1.2.3', '-m', 'exist'], root);
    expect(() => tagPackage({ rootDir: root, query: 'dsh-beta' })).toThrowError(
      expect.objectContaining({ code: 'TAG_EXISTS' }),
    );
  });

  it('tagPackage 工作树不干净时默认拒绝,--allow-dirty 放行', () => {
    const root = makeFixture();
    writeFileSync(join(root, 'stray.txt'), 'uncommitted', 'utf8');
    expect(() =>
      tagPackage({ rootDir: root, query: 'dsh-alpha' }),
    ).toThrowError(expect.objectContaining({ code: 'DIRTY_WORKTREE' }));
    const outcome = tagPackage({
      rootDir: root,
      query: 'dsh-alpha',
      allowDirty: true,
    });
    expect(outcome.tag).toBe('dsh-alpha-v0.1.0');
    // 无关脏文件不被卷入,仍保持未提交状态
    expect(gitOut(['status', '--porcelain'], root)).toContain('stray.txt');
  });

  it('tagPackage 包名不存在时抛 PKG_NOT_FOUND', () => {
    const root = makeFixture();
    expect(() => tagPackage({ rootDir: root, query: 'dsh-none' })).toThrowError(
      expect.objectContaining({ code: 'PKG_NOT_FOUND' }),
    );
  });

  it('tagPackage 清单版本非法时抛 INVALID_CURRENT_VERSION,不产生 tag', () => {
    const root = makeFixture();
    writePackage(root, 'dsh-beta', {
      name: '@zhidal/dsh-beta',
      version: 'not-a-semver',
    });
    expect(() => tagPackage({ rootDir: root, query: 'dsh-beta' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_CURRENT_VERSION' }),
    );
    expect(gitOut(['tag', '--list'], root)).toBe('');
  });

  it('tagAllPackages 为全部子包批量打 tag', () => {
    const root = makeFixture();
    const outcome = tagAllPackages({ rootDir: root });
    expect(outcome.dryRun).toBe(false);
    expect(outcome.created.map((item) => item.tag)).toEqual([
      'dsh-alpha-v0.1.0',
      'dsh-beta-v1.2.3',
    ]);
    expect(outcome.skipped).toEqual([]);
    expect(tagPointsAtHead(root, 'dsh-alpha-v0.1.0')).toBe(true);
    expect(tagPointsAtHead(root, 'dsh-beta-v1.2.3')).toBe(true);
  });

  it('tagAllPackages 幂等:已存在的 tag 跳过,其余照常创建', () => {
    const root = makeFixture();
    tagPackage({ rootDir: root, query: 'dsh-alpha' });
    const outcome = tagAllPackages({ rootDir: root });
    expect(outcome.created.map((item) => item.tag)).toEqual([
      'dsh-beta-v1.2.3',
    ]);
    expect(outcome.skipped.map((item) => item.tag)).toEqual([
      'dsh-alpha-v0.1.0',
    ]);
    // 幂等:重复执行不再新建任何 tag
    const again = tagAllPackages({ rootDir: root });
    expect(again.created).toEqual([]);
    expect(again.skipped).toHaveLength(2);
  });

  it('tagAllPackages dry-run 只预览,不创建任何 tag', () => {
    const root = makeFixture();
    const preview = tagAllPackages({ rootDir: root, dryRun: true });
    expect(preview.created).toHaveLength(2);
    expect(preview.created.every((item) => item.dryRun)).toBe(true);
    expect(gitOut(['tag', '--list'], root)).toBe('');
  });

  it('tagAllPackages 脏工作树时在打第一个 tag 之前整体拒绝', () => {
    const root = makeFixture();
    writeFileSync(join(root, 'stray.txt'), 'uncommitted', 'utf8');
    expect(() => tagAllPackages({ rootDir: root })).toThrowError(
      expect.objectContaining({ code: 'DIRTY_WORKTREE' }),
    );
    expect(gitOut(['tag', '--list'], root)).toBe('');
  });

  it('非 git 目录抛 NOT_A_GIT_REPO', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-release-nogit-'));
    fixtures.push(dir);
    writeFileSync(
      join(dir, 'pnpm-workspace.yaml'),
      "packages:\n  - 'packages/*'\n",
      'utf8',
    );
    writePackage(dir, 'dsh-alpha', {
      name: '@lzhida/dsh-alpha',
      version: '0.1.0',
    });
    expect(() => tagAllPackages({ rootDir: dir })).toThrowError(
      expect.objectContaining({ code: 'NOT_A_GIT_REPO' }),
    );
  });

  it('缺少 version 字段的包抛 PKG_VERSION_MISSING', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-release-nover-'));
    fixtures.push(dir);
    writeFileSync(
      join(dir, 'pnpm-workspace.yaml'),
      "packages:\n  - 'packages/*'\n",
      'utf8',
    );
    writePackage(dir, 'dsh-nover', { name: '@lzhida/dsh-nover' });
    expect(() => listWorkspacePackages(dir)).toThrowError(
      expect.objectContaining({ code: 'PKG_VERSION_MISSING' }),
    );
  });
});

describe('release workflow 错误类型', () => {
  it('ReleaseError 携带 code 且经 instanceof 可与普通错误区分', () => {
    const error = new ReleaseError('TAG_EXISTS', 'tag 已存在');
    expect(error).toBeInstanceOf(ReleaseError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('TAG_EXISTS');
  });
});
