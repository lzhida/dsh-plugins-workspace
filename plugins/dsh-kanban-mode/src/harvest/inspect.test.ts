import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 真实 git 仓(init + 多次提交 + diff)在 Windows 上单用例可接近 vitest 默认
// 5s 上限,统一放宽到 30s,避免慢盘环境下的假失败。
vi.setConfig({ testTimeout: 60_000 });

import { createGitRunner, versionAtLeast } from './git-runner.ts';
import type { GitRunner } from './git-runner.ts';
import {
  MIN_MERGE_TREE_VERSION,
  createGitInspector,
  probeConflictsByMergeFallback,
  probeConflictsByMergeTree,
} from './inspect.ts';

/** 一次性临时目录(建在 os.tmpdir(),Windows 上严禁硬编码 /tmp/);调用方负责 finally 清理。 */
async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** 在临时目录初始化确定性仓库:主分支固定叫 main(显式 -b,不依赖 init.defaultBranch)。 */
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

/** 写文件并提交(自动建父目录);返回提交短哈希。 */
async function commitFile(
  runner: GitRunner,
  cwd: string,
  relPath: string,
  content: string,
  message: string,
): Promise<string> {
  const abs = path.join(cwd, relPath);
  const parent = path.dirname(abs);
  if (parent !== cwd) {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(parent, { recursive: true });
  }
  await writeFile(abs, content, 'utf8');
  await runner.captureOrThrow(['add', '-A'], { cwd });
  await runner.captureOrThrow(['commit', '-m', message], { cwd });
  const hash = await runner.captureOrThrow(['rev-parse', '--short', 'HEAD'], {
    cwd,
  });
  return hash.stdout.trim();
}

/** 搭一个 main/task 在同一文件同一行各自修改的冲突仓(当前检出 main)。 */
async function makeConflictRepo(): Promise<{ dir: string; runner: GitRunner }> {
  const dir = await makeTempDir('dsh-kanban-harvest-inspect-conflict-');
  const runner = createGitRunner();
  await initRepo(runner, dir);
  await commitFile(
    runner,
    dir,
    'a.txt',
    'line1\nline2\nline3\n',
    'chore: 基线',
  );
  await runner.captureOrThrow(['checkout', '-b', 'task'], { cwd: dir });
  await commitFile(
    runner,
    dir,
    'a.txt',
    'task-line1\nline2\nline3\n',
    'feat: task 改首行',
  );
  await runner.captureOrThrow(['checkout', 'main'], { cwd: dir });
  await commitFile(
    runner,
    dir,
    'a.txt',
    'main-line1\nline2\nline3\n',
    'feat: main 改首行',
  );
  return { dir, runner };
}

/** 搭一个互不冲突的仓:task 只加新文件 b.txt,main 只改 a.txt(当前检出 main)。 */
async function makeCleanMergeRepo(): Promise<{
  dir: string;
  runner: GitRunner;
}> {
  const dir = await makeTempDir('dsh-kanban-harvest-inspect-clean-');
  const runner = createGitRunner();
  await initRepo(runner, dir);
  await commitFile(
    runner,
    dir,
    'a.txt',
    'line1\nline2\nline3\n',
    'chore: 基线',
  );
  await runner.captureOrThrow(['checkout', '-b', 'task'], { cwd: dir });
  await commitFile(runner, dir, 'b.txt', 'task 新文件\n', 'feat: task 加 b');
  await runner.captureOrThrow(['checkout', 'main'], { cwd: dir });
  await commitFile(
    runner,
    dir,
    'a.txt',
    'main-line1\nline2\nline3\n',
    'feat: main 改 a',
  );
  return { dir, runner };
}

/** 搭一个用于五项审查的双分支仓:main 前进一次,task 独有两个提交(含中文目录文件)。 */
async function makeReviewRepo(): Promise<{
  dir: string;
  runner: GitRunner;
  baseHash: string;
}> {
  const dir = await makeTempDir('dsh-kanban-harvest-inspect-review-');
  const runner = createGitRunner();
  await initRepo(runner, dir);
  const baseHash = await commitFile(
    runner,
    dir,
    'a.txt',
    'line1\nline2\nline3\n',
    'chore: 基线',
  );
  await runner.captureOrThrow(['checkout', '-b', 'task'], { cwd: dir });
  await commitFile(runner, dir, 'b.txt', 'task 新文件\n', 'feat: task 加 b');
  await commitFile(
    runner,
    dir,
    '内 目录/中文 文件.txt',
    '中文内容\n',
    'feat: task 加中文文件',
  );
  await runner.captureOrThrow(['checkout', 'main'], { cwd: dir });
  await commitFile(runner, dir, 'd.txt', 'main 新文件\n', 'feat: main 加 d');
  return { dir, runner, baseHash };
}

describe('dsh-kanban-mode harvest:inspect 五项只读审查', () => {
  it('diffStat 返回差异摘要且无差异时返回 undefined', async () => {
    const { dir, runner } = await makeReviewRepo();
    try {
      const inspector = createGitInspector(runner);
      // 三点:任务分支自 merge-base 以来的全部改动(b + 中文文件)。
      const stat = await inspector.diffStat(dir, 'main...task');
      expect(stat).toBeDefined();
      expect(stat).toContain('2 files changed');
      // 同一范围无差异时(undefined,不报错)。
      const none = await inspector.diffStat(dir, 'main...main');
      expect(none).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('log 返回提交清单并在超上限时截断并报总数', async () => {
    const { dir, runner } = await makeReviewRepo();
    try {
      const inspector = createGitInspector(runner);
      // 两点:task 独有提交(2 条)。
      const full = await inspector.log(dir, 'main..task');
      expect(full.total).toBe(2);
      expect(full.entries.map((e) => e.subject)).toEqual([
        'feat: task 加中文文件',
        'feat: task 加 b',
      ]);
      expect(full.entries.every((e) => /^[0-9a-f]+$/.test(e.hash))).toBe(true);
      // 上限截断:entries 只留 1 条,total 仍是 2。
      const capped = await inspector.log(dir, 'main..task', 1);
      expect(capped.entries).toHaveLength(1);
      expect(capped.total).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('changedFiles 返回 POSIX 归一的文件清单(含中文名)', async () => {
    const { dir, runner } = await makeReviewRepo();
    try {
      const inspector = createGitInspector(runner);
      const files = await inspector.changedFiles(dir, 'main...task');
      expect(files).toEqual(['b.txt', '内 目录/中文 文件.txt']);
      // Windows 上也必须是正斜杠(不允许反斜杠混入)。
      expect(files.every((f) => !f.includes('\\'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('baseAdvanced 区分祖先/历史重写/坏引用三种情况', async () => {
    const { dir, runner, baseHash } = await makeReviewRepo();
    try {
      const inspector = createGitInspector(runner);
      // 线性前进:base 仍是 main 祖先 → true(收割口径:无需变基)。
      expect(await inspector.baseAdvanced(dir, baseHash, 'main')).toBe(true);
      // 历史重写:造一个与 main 无共同祖先的孤儿提交 → false(需变基)。
      await runner.captureOrThrow(['checkout', '--orphan', 'stray'], {
        cwd: dir,
      });
      await runner.captureOrThrow(['rm', '-rf', '--quiet', '.'], { cwd: dir });
      const orphanHash = await commitFile(
        runner,
        dir,
        'x.txt',
        '孤立根\n',
        'stray: 独立根提交',
      );
      await runner.captureOrThrow(['checkout', 'main'], { cwd: dir });
      expect(await inspector.baseAdvanced(dir, orphanHash, 'main')).toBe(false);
      // 坏引用:无法判定 → 抛 command-failed。
      await expect(
        inspector.baseAdvanced(dir, 'nonexistent-hash-abc', 'main'),
      ).rejects.toMatchObject({ kind: 'command-failed' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('conflictFiles 按本机版本自动选路并检出冲突文件', async () => {
    const { dir, runner } = await makeConflictRepo();
    try {
      const inspector = createGitInspector(runner);
      const caps = await inspector.capabilities();
      const probe = await inspector.conflictFiles(dir, 'main', 'task');
      expect(probe.hasConflicts).toBe(true);
      expect(probe.files).toContain('a.txt');
      expect(probe.method).toBe(
        caps.mergeTree ? 'merge-tree' : 'merge-fallback',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('capabilities 如实自报本机 git 版本与 merge-tree 可用性', async () => {
    const runner = createGitRunner();
    const inspector = createGitInspector(runner);
    const caps = await inspector.capabilities();
    expect(caps.gitVersion.raw).toMatch(/^\d+\.\d+\.\d+$/);
    expect(caps.mergeTree).toBe(
      versionAtLeast(caps.gitVersion, MIN_MERGE_TREE_VERSION),
    );
  });
});

describe('dsh-kanban-mode harvest:inspect 冲突预检两条路径', () => {
  it('merge-tree 路径区分冲突文件与干净合并', async () => {
    const conflict = await makeConflictRepo();
    try {
      const probe = await probeConflictsByMergeTree(
        conflict.runner,
        conflict.dir,
        'main',
        'task',
      );
      expect(probe.method).toBe('merge-tree');
      expect(probe.hasConflicts).toBe(true);
      expect(probe.files).toEqual(['a.txt']);
    } finally {
      await rm(conflict.dir, { recursive: true, force: true });
    }
    const clean = await makeCleanMergeRepo();
    try {
      const probe = await probeConflictsByMergeTree(
        clean.runner,
        clean.dir,
        'main',
        'task',
      );
      expect(probe.hasConflicts).toBe(false);
      expect(probe.files).toEqual([]);
    } finally {
      await rm(clean.dir, { recursive: true, force: true });
    }
  });

  it('merge-tree 遇坏引用抛 command-failed', async () => {
    const clean = await makeCleanMergeRepo();
    try {
      await expect(
        probeConflictsByMergeTree(
          clean.runner,
          clean.dir,
          'main',
          'no-such-ref-xyz',
        ),
      ).rejects.toMatchObject({ kind: 'command-failed' });
    } finally {
      await rm(clean.dir, { recursive: true, force: true });
    }
  });

  it('降级路径在干净工作区检出冲突并以 merge --abort 还原现场', async () => {
    const { dir, runner } = await makeConflictRepo();
    try {
      // 显式测降级路径:不让它依赖本机 git 版本。
      const probe = await probeConflictsByMergeFallback(
        runner,
        dir,
        'main',
        'task',
      );
      expect(probe.method).toBe('merge-fallback');
      expect(probe.hasConflicts).toBe(true);
      expect(probe.files).toEqual(['a.txt']);
      expect(probe.notes.join('\n')).toContain('还原');
      // 还原验证:工作区回到干净,且 a.txt 保持 main 版本(未被试合并污染)。
      const status = await runner.captureOrThrow(['status', '--porcelain'], {
        cwd: dir,
      });
      expect(status.stdout.trim()).toBe('');
      const content = await runner.captureOrThrow(['show', 'main:a.txt'], {
        cwd: dir,
      });
      expect(content.stdout).toContain('main-line1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('降级路径拒绝脏工作区且不吞用户改动', async () => {
    const clean = await makeCleanMergeRepo();
    try {
      // 造一处未提交改动。
      const dirtyAbs = path.join(clean.dir, 'a.txt');
      await writeFile(dirtyAbs, '未提交的脏行\n', 'utf8');
      await expect(
        probeConflictsByMergeFallback(clean.runner, clean.dir, 'main', 'task'),
      ).rejects.toMatchObject({
        kind: 'command-failed',
        message: expect.stringContaining('降级试合并要求工作区干净'),
      });
      // 脏改动原样保留(拒绝发生在任何 git 破坏性动作之前)。
      const status = await clean.runner.captureOrThrow(
        ['status', '--porcelain'],
        {
          cwd: clean.dir,
        },
      );
      expect(status.stdout).toContain('M');
    } finally {
      await rm(clean.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('ref 注入防御拒绝空与 - 开头的引用名(两条路径共用校验)', async () => {
    const clean = await makeCleanMergeRepo();
    try {
      await expect(
        probeConflictsByMergeTree(clean.runner, clean.dir, '-evil', 'main'),
      ).rejects.toMatchObject({ kind: 'command-failed' });
      await expect(
        probeConflictsByMergeTree(clean.runner, clean.dir, '', 'main'),
      ).rejects.toMatchObject({ kind: 'command-failed' });
      await expect(
        probeConflictsByMergeFallback(clean.runner, clean.dir, 'main', '-evil'),
      ).rejects.toMatchObject({ kind: 'command-failed' });
    } finally {
      await rm(clean.dir, { recursive: true, force: true });
    }
  });
});
