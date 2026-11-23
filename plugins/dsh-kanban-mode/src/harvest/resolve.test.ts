/**
 * resolve.ts 测试:进行中 rebase/merge 的存在性探测与续跑/中止动作表。
 *
 * 真实 git 临时仓集成:merge 冲突与 rebase 冲突各造一个现场,验证探测结果、
 * 动作表映射与 abort 后归零;纯函数断言动作表为静态映射。
 *
 * @module dsh-kanban-mode/harvest/resolve.test
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 真实 git 仓在 Windows 上单用例可接近 vitest 默认 5s 上限,统一放宽到 30s。
vi.setConfig({ testTimeout: 30_000 });

import { createGitRunner } from './git-runner.ts';
import type { GitRunner } from './git-runner.ts';
import {
  abortActionFor,
  detectInProgressState,
  resumeActionFor,
} from './resolve.ts';
import { GitRunnerError } from './git-runner.ts';

/** 一次性临时目录(建在 os.tmpdir(),Windows 上严禁硬编码 /tmp/);调用方负责 finally 清理。 */
async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** 在临时目录初始化确定性仓库:主分支固定叫 main,独立提交身份,不碰全局配置。 */
async function initRepo(runner: GitRunner, dir: string): Promise<void> {
  await runner.captureOrThrow(['init', '-b', 'main'], { cwd: dir });
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

/** 写文件并提交;返回提交短哈希。 */
async function commitFile(
  runner: GitRunner,
  cwd: string,
  relPath: string,
  content: string,
  message: string,
): Promise<string> {
  await writeFile(path.join(cwd, relPath), content, 'utf8');
  await runner.captureOrThrow(['add', '-A'], { cwd });
  await runner.captureOrThrow(['commit', '-m', message], { cwd });
  const hash = await runner.captureOrThrow(['rev-parse', '--short', 'HEAD'], {
    cwd,
  });
  return hash.stdout.trim();
}

describe('dsh-kanban-mode harvest:resolve 动作表纯函数', () => {
  it('resumeActionFor 按状态映射续跑命令', () => {
    expect(resumeActionFor('rebase')).toEqual(['rebase', '--continue']);
    expect(resumeActionFor('merge')).toEqual(['commit', '--no-edit']);
    expect(resumeActionFor('none')).toEqual([]);
  });

  it('abortActionFor 按状态映射中止命令', () => {
    expect(abortActionFor('rebase')).toEqual(['rebase', '--abort']);
    expect(abortActionFor('merge')).toEqual(['merge', '--abort']);
    expect(abortActionFor('none')).toEqual([]);
  });
});

describe('dsh-kanban-mode harvest:resolve 真实 git 探测', () => {
  it('干净仓库探测为 none', async () => {
    const runner = createGitRunner();
    const dir = await makeTempDir('dsh-kanban-harvest-resolve-clean-');
    try {
      await initRepo(runner, dir);
      await commitFile(runner, dir, 'a.txt', 'hello\n', 'chore: 基线');
      const state = await detectInProgressState(runner, dir);
      expect(state.inProgress).toBe(false);
      expect(state.kind).toBe('none');
      expect(state.markers).toEqual([]);
      expect(state.gitDir.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('merge 冲突现场探测为 merge,abort 后归零', async () => {
    const runner = createGitRunner();
    const dir = await makeTempDir('dsh-kanban-harvest-resolve-merge-');
    try {
      await initRepo(runner, dir);
      await commitFile(runner, dir, 'a.txt', 'line1\nline2\n', 'chore: 基线');
      await runner.captureOrThrow(['checkout', '-b', 'task'], { cwd: dir });
      await commitFile(
        runner,
        dir,
        'a.txt',
        'task-line1\nline2\n',
        'feat: task 改首行',
      );
      await runner.captureOrThrow(['checkout', 'main'], { cwd: dir });
      await commitFile(
        runner,
        dir,
        'a.txt',
        'main-line1\nline2\n',
        'feat: main 改首行',
      );
      // 制造真实 merge 冲突现场(main 上合并 task,同文件同行)。
      const merge = await runner.capture(['merge', '--no-ff', 'task'], {
        cwd: dir,
      });
      expect(merge.ok).toBe(false);

      const state = await detectInProgressState(runner, dir);
      expect(state.inProgress).toBe(true);
      expect(state.kind).toBe('merge');
      expect(state.markers).toContain('MERGE_HEAD');

      // abort 之后探测归零。
      await runner.captureOrThrow(['merge', '--abort'], { cwd: dir });
      const after = await detectInProgressState(runner, dir);
      expect(after.inProgress).toBe(false);
      expect(after.kind).toBe('none');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rebase 冲突现场探测为 rebase(rebase-merge 优先),abort 后归零', async () => {
    const runner = createGitRunner();
    const dir = await makeTempDir('dsh-kanban-harvest-resolve-rebase-');
    try {
      await initRepo(runner, dir);
      await commitFile(runner, dir, 'a.txt', 'line1\nline2\n', 'chore: 基线');
      // task 从基线分叉,两边改同一行;在 task 检出内 rebase main 制造冲突现场。
      await runner.captureOrThrow(['checkout', '-b', 'task'], { cwd: dir });
      await commitFile(
        runner,
        dir,
        'a.txt',
        'task-line1\nline2\n',
        'feat: task 改首行',
      );
      await runner.captureOrThrow(['checkout', 'main'], { cwd: dir });
      await commitFile(
        runner,
        dir,
        'a.txt',
        'main-line1\nline2\n',
        'feat: main 改首行',
      );
      await runner.captureOrThrow(['checkout', 'task'], { cwd: dir });
      const rebase = await runner.capture(['rebase', 'main'], { cwd: dir });
      expect(rebase.ok).toBe(false);

      const state = await detectInProgressState(runner, dir);
      expect(state.inProgress).toBe(true);
      expect(state.kind).toBe('rebase');
      expect(state.markers.some((m) => m.startsWith('rebase-'))).toBe(true);

      // abort 之后探测归零。
      await runner.captureOrThrow(['rebase', '--abort'], { cwd: dir });
      const after = await detectInProgressState(runner, dir);
      expect(after.inProgress).toBe(false);
      expect(after.kind).toBe('none');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('非 git 目录抛 not-a-repo 分类错误', async () => {
    const runner = createGitRunner();
    const dir = await makeTempDir('dsh-kanban-harvest-resolve-norepo-');
    try {
      try {
        await detectInProgressState(runner, dir);
        throw new Error('应当抛出 GitRunnerError');
      } catch (err) {
        expect(err).toBeInstanceOf(GitRunnerError);
        expect((err as GitRunnerError).kind).toBe('not-a-repo');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
