import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  GitRunnerError,
  classifyGitFailure,
  createGitRunner,
  parseGitVersion,
  toPosixPath,
  versionAtLeast,
} from './git-runner.ts';
import type { GitVersion } from './git-runner.ts';

/** 一次性临时目录(建在 os.tmpdir(),Windows 上严禁硬编码 /tmp/);调用方负责 finally 清理。 */
async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** 在临时目录里初始化一个最小 git 仓(配好提交身份,避免依赖全局配置)。 */
async function initTempRepo(dir: string): Promise<void> {
  const runner = createGitRunner();
  await runner.captureOrThrow(['init'], { cwd: dir });
  await runner.captureOrThrow(
    ['config', 'user.email', 'harvest-test@example.com'],
    { cwd: dir },
  );
  await runner.captureOrThrow(['config', 'user.name', 'harvest-test'], {
    cwd: dir,
  });
  await runner.captureOrThrow(['config', 'commit.gpgsign', 'false'], {
    cwd: dir,
  });
}

describe('dsh-kanban-mode harvest:git-runner 纯函数', () => {
  it('解析 git --version 输出为结构化版本号', () => {
    expect(parseGitVersion('git version 2.56.1.windows.1')).toEqual({
      major: 2,
      minor: 56,
      patch: 1,
      raw: '2.56.1',
    });
    expect(parseGitVersion('git version 2.38')).toEqual({
      major: 2,
      minor: 38,
      patch: 0,
      raw: '2.38.0',
    });
    expect(parseGitVersion('git version 2.39.0')).toEqual({
      major: 2,
      minor: 39,
      patch: 0,
      raw: '2.39.0',
    });
  });

  it('解析不了版本输出时返回 undefined', () => {
    expect(parseGitVersion('不是 git')).toBeUndefined();
    expect(parseGitVersion('')).toBeUndefined();
  });

  it('版本比较支持大于等于判定(含边界)', () => {
    const v = (major: number, minor: number, patch: number): GitVersion => ({
      major,
      minor,
      patch,
      raw: `${major}.${minor}.${patch}`,
    });
    expect(versionAtLeast(v(2, 38, 0), v(2, 38, 0))).toBe(true);
    expect(versionAtLeast(v(2, 37, 9), v(2, 38, 0))).toBe(false);
    expect(versionAtLeast(v(2, 56, 1), v(2, 38, 0))).toBe(true);
    expect(versionAtLeast(v(3, 0, 0), v(2, 38, 0))).toBe(true);
    expect(versionAtLeast(v(1, 9, 9), v(2, 38, 0))).toBe(false);
  });

  it('路径分隔符归一为 POSIX 斜杠', () => {
    expect(toPosixPath('src\\harvest\\git-runner.ts')).toBe(
      'src/harvest/git-runner.ts',
    );
    expect(toPosixPath('src/harvest/git-runner.ts')).toBe(
      'src/harvest/git-runner.ts',
    );
    expect(toPosixPath('plain.txt')).toBe('plain.txt');
  });

  it('失败信息按三类与超时正确归类', () => {
    // 超时归 command-failed(可操作文案由 failureToError 生成)。
    expect(
      classifyGitFailure({ exitCode: null, timedOut: true, stderr: '' }),
    ).toBe('command-failed');
    // spawn ENOENT = git 缺失。
    expect(
      classifyGitFailure({
        exitCode: null,
        timedOut: false,
        stderr: 'spawn git failed (ENOENT): spawn git ENOENT',
      }),
    ).toBe('git-missing');
    // spawn 失败但非 ENOENT(如权限)= 命令失败类。
    expect(
      classifyGitFailure({
        exitCode: null,
        timedOut: false,
        stderr: 'spawn git failed (EACCES)',
      }),
    ).toBe('command-failed');
    // 非 git 目录。
    expect(
      classifyGitFailure({
        exitCode: 128,
        timedOut: false,
        stderr:
          'fatal: not a git repository (or any of the parent directories): .git',
      }),
    ).toBe('not-a-repo');
    // 其余非零退出 = 命令失败。
    expect(
      classifyGitFailure({
        exitCode: 1,
        timedOut: false,
        stderr: 'fatal: xyz',
      }),
    ).toBe('command-failed');
  });
});

describe('dsh-kanban-mode harvest:git-runner 真实 git 集成', () => {
  it('capture 执行真实 git 并返回退出码与输出', async () => {
    const runner = createGitRunner();
    const result = await runner.capture(['--version']);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('git version');
    expect(result.truncated).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it('captureOrThrow 成功时原样返回结果', async () => {
    const runner = createGitRunner();
    const result = await runner.captureOrThrow(['--version']);
    expect(result.ok).toBe(true);
  });

  it('git 二进制缺失时分类为 git-missing 并报可操作错误', async () => {
    const runner = createGitRunner({
      gitBinary: 'git-not-exist-for-harvest-test-9x7z',
    });
    const captured = await runner.capture(['--version']);
    expect(captured.ok).toBe(false);
    expect(captured.exitCode).toBeNull();
    try {
      await runner.captureOrThrow(['--version']);
      throw new Error('应当抛出 GitRunnerError');
    } catch (err) {
      expect(err).toBeInstanceOf(GitRunnerError);
      expect((err as GitRunnerError).kind).toBe('git-missing');
      expect((err as GitRunnerError).message).toContain('git 已安装');
    }
  });

  it('非 git 目录分类为 not-a-repo', async () => {
    const runner = createGitRunner();
    const dir = await makeTempDir('dsh-kanban-harvest-runner-norepo-');
    try {
      try {
        await runner.captureOrThrow(['status', '--porcelain'], { cwd: dir });
        throw new Error('应当抛出 GitRunnerError');
      } catch (err) {
        expect(err).toBeInstanceOf(GitRunnerError);
        expect((err as GitRunnerError).kind).toBe('not-a-repo');
        expect((err as GitRunnerError).message).toContain('不是 git 仓库');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('未知子命令分类为 command-failed', async () => {
    const runner = createGitRunner();
    try {
      await runner.captureOrThrow(['totally-not-a-git-subcommand']);
      throw new Error('应当抛出 GitRunnerError');
    } catch (err) {
      expect(err).toBeInstanceOf(GitRunnerError);
      expect((err as GitRunnerError).kind).toBe('command-failed');
    }
  });

  it('版本探测返回本机结构化版本', async () => {
    const runner = createGitRunner();
    const v = await runner.version();
    expect(v.major).toBeGreaterThanOrEqual(2);
    expect(v.raw).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('requireVersionAtLeast 版本满足时返回当前版本', async () => {
    const runner = createGitRunner();
    const current = await runner.version();
    const met = await runner.requireVersionAtLeast({
      major: 1,
      minor: 0,
      patch: 0,
      raw: '1.0.0',
    });
    expect(met).toEqual(current);
  });

  it('requireVersionAtLeast 版本过低时抛 git-too-old 可操作错误', async () => {
    const runner = createGitRunner();
    try {
      await runner.requireVersionAtLeast({
        major: 99,
        minor: 0,
        patch: 0,
        raw: '99.0.0',
      });
      throw new Error('应当抛出 GitRunnerError');
    } catch (err) {
      expect(err).toBeInstanceOf(GitRunnerError);
      expect((err as GitRunnerError).kind).toBe('git-too-old');
      expect((err as GitRunnerError).message).toContain('git 版本过低');
      expect((err as GitRunnerError).message).toContain('请升级 git');
    }
  });

  it('超大输出被截断且命令照常退出(不阻塞)', async () => {
    const runner = createGitRunner();
    const dir = await makeTempDir('dsh-kanban-harvest-runner-bigout-');
    try {
      await initTempRepo(dir);
      // 造一个约 600KB 的文件,使 git show HEAD 的 patch 输出远超收集上限。
      const big = Array.from(
        { length: 20000 },
        (_, i) => `第 ${i} 行内容`,
      ).join('\n');
      await writeFile(path.join(dir, 'big.txt'), big, 'utf8');
      await runner.captureOrThrow(['add', '-A'], { cwd: dir });
      await runner.captureOrThrow(['commit', '-m', 'test: 大文件提交'], {
        cwd: dir,
      });
      const result = await runner.capture(['show', 'HEAD'], {
        cwd: dir,
        maxOutputBytes: 4096,
      });
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.truncated).toBe(true);
      expect(result.stdout.length).toBeLessThan(big.length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
