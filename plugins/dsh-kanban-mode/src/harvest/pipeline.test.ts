/**
 * pipeline.ts 测试:收割管线(plan/apply/冲突续跑/discard)与仓库级互斥。
 *
 * 全部用真实 git 临时仓(os.tmpdir() 下 mkdtemp + try/finally 清理),不碰真实
 * 仓库与家目录;覆盖四场景(变基成功收尾 / merge 冲突→conflict→续跑→完成 /
 * 脏主区拒绝 / 已推送分支拒绝变基降级合并)+ 五 result 分支 + discard 四步与
 * 幂等 + 仓库级串行互斥。
 *
 * @module dsh-kanban-mode/harvest/pipeline.test
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 真实 git 仓(init + worktree + rebase + merge)在 Windows 上单用例可能接近
// vitest 默认 5s 上限,统一放宽到 60s(全仓并行负载下 30s 会假失败),避免慢盘环境下的假失败。
vi.setConfig({ testTimeout: 60_000 });

import { createGitRunner, toPosixPath, versionAtLeast } from './git-runner.ts';
import type {
  GitCaptureOptions,
  GitCaptureResult,
  GitRunner,
} from './git-runner.ts';
import { createGitInspector, MIN_MERGE_TREE_VERSION } from './inspect.ts';
import { createHarvestPipeline, officialWorktreePath } from './pipeline.ts';
import { detectInProgressState } from './resolve.ts';

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

/** 路径是否存在。 */
async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** 分支是否仍存在。 */
async function branchListHas(
  runner: GitRunner,
  cwd: string,
  branch: string,
): Promise<boolean> {
  const result = await runner.captureOrThrow(['branch', '--list', branch], {
    cwd,
  });
  return result.stdout.trim().length > 0;
}

/** 读取 ref 的短哈希。 */
async function shortHash(
  runner: GitRunner,
  cwd: string,
  ref: string,
): Promise<string> {
  const result = await runner.captureOrThrow(['rev-parse', '--short', ref], {
    cwd,
  });
  return result.stdout.trim();
}

/** 分叉仓:main 前进一次,task 有自己的提交(互不冲突)。 */
async function makeDivergedRepo(): Promise<{ dir: string; runner: GitRunner }> {
  const dir = await makeTempDir('dsh-kanban-harvest-pipe-diverged-');
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
  await commitFile(runner, dir, 'c.txt', 'main 新文件\n', 'feat: main 加 c');
  return { dir, runner };
}

/** 冲突仓:main 与 task 改同一文件同一行(当前检出 main)。 */
async function makeConflictRepo(): Promise<{ dir: string; runner: GitRunner }> {
  const dir = await makeTempDir('dsh-kanban-harvest-pipe-conflict-');
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

/** 需变基仓:task 从 scratch 线分叉(base 不再是 main 祖先 → baseAdvanced=false)。 */
async function makeRebaseNeededRepo(): Promise<{
  dir: string;
  runner: GitRunner;
  baseHash: string;
}> {
  const dir = await makeTempDir('dsh-kanban-harvest-pipe-rebaseneed-');
  const runner = createGitRunner();
  await initRepo(runner, dir);
  await commitFile(
    runner,
    dir,
    'a.txt',
    'line1\nline2\nline3\n',
    'chore: 基线',
  );
  await runner.captureOrThrow(['checkout', '-b', 'scratch'], { cwd: dir });
  const baseHash = await commitFile(
    runner,
    dir,
    'scratch.txt',
    'scratch\n',
    'chore: scratch base',
  );
  await runner.captureOrThrow(['checkout', '-b', 'task'], { cwd: dir });
  await commitFile(runner, dir, 'b.txt', 'task 新文件\n', 'feat: task 加 b');
  await runner.captureOrThrow(['checkout', 'main'], { cwd: dir });
  await commitFile(runner, dir, 'c.txt', 'main 新文件\n', 'feat: main 加 c');
  return { dir, runner, baseHash };
}

/** 变基冲突仓:base 已分叉且 task 与 main 改同一行(rebase 会冲突)。 */
async function makeRebaseConflictRepo(): Promise<{
  dir: string;
  runner: GitRunner;
  baseHash: string;
}> {
  const dir = await makeTempDir('dsh-kanban-harvest-pipe-rebaseconflict-');
  const runner = createGitRunner();
  await initRepo(runner, dir);
  await commitFile(
    runner,
    dir,
    'a.txt',
    'line1\nline2\nline3\n',
    'chore: 基线',
  );
  await runner.captureOrThrow(['checkout', '-b', 'scratch'], { cwd: dir });
  const baseHash = await commitFile(
    runner,
    dir,
    'scratch.txt',
    'scratch\n',
    'chore: scratch base',
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
  return { dir, runner, baseHash };
}

/** 已推送仓:task 有 upstream 且 upstream 与本地 tip 不等。 */
async function makePushedRepo(): Promise<{
  dir: string;
  originDir: string;
  runner: GitRunner;
}> {
  const dir = await makeTempDir('dsh-kanban-harvest-pipe-pushed-');
  const originDir = await makeTempDir('dsh-kanban-harvest-pipe-pushed-origin-');
  const runner = createGitRunner();
  await initRepo(runner, dir);
  await commitFile(runner, dir, 'a.txt', 'line1\n', 'chore: 基线');
  await runner.captureOrThrow(['checkout', '-b', 'task'], { cwd: dir });
  await commitFile(runner, dir, 'b.txt', 'task 新文件\n', 'feat: task 加 b');
  await runner.captureOrThrow(['init', '--bare'], { cwd: originDir });
  await runner.captureOrThrow(
    ['remote', 'add', 'origin', toPosixPath(originDir)],
    { cwd: dir },
  );
  await runner.captureOrThrow(['push', '-u', 'origin', 'task'], { cwd: dir });
  // 本地再追一个提交(未推送):local tip ≠ upstream tip。
  await commitFile(
    runner,
    dir,
    'b2.txt',
    'task 本地追加\n',
    'feat: task 加 b2(未推送)',
  );
  await runner.captureOrThrow(['checkout', 'main'], { cwd: dir });
  await commitFile(runner, dir, 'c.txt', 'main 新文件\n', 'feat: main 加 c');
  return { dir, originDir, runner };
}

/** 一次 git 调用记录。 */
interface TraceEntry {
  readonly args: readonly string[];
  readonly start: number;
  readonly end: number;
}

/** 带调用轨迹与并发计数的 runner(真实执行,可选拦截指定命令)。 */
interface TracingRunner extends GitRunner {
  readonly trace: readonly TraceEntry[];
  readonly maxConcurrent: number;
}

/** 包装真实 runner:记录每次调用、统计最大并发数、可选拦截命令返回假结果。 */
function instrumentedRunner(
  inner: GitRunner,
  intercept?: (args: readonly string[]) => GitCaptureResult | undefined,
): TracingRunner {
  const trace: TraceEntry[] = [];
  let running = 0;
  let maxConcurrent = 0;
  const capture = async (
    args: readonly string[],
    options?: GitCaptureOptions,
  ): Promise<GitCaptureResult> => {
    const start = Date.now();
    running += 1;
    maxConcurrent = Math.max(maxConcurrent, running);
    let result: GitCaptureResult;
    try {
      const faked = intercept?.(args);
      result = faked !== undefined ? faked : await inner.capture(args, options);
    } finally {
      running -= 1;
    }
    trace.push({ args, start, end: Date.now() });
    return result;
  };
  return {
    capture,
    captureOrThrow: (args, options) => inner.captureOrThrow(args, options),
    version: () => inner.version(),
    requireVersionAtLeast: (min) => inner.requireVersionAtLeast(min),
    trace,
    get maxConcurrent(): number {
      return maxConcurrent;
    },
  };
}

describe('dsh-kanban-mode harvest:pipeline 只读规划', () => {
  it('plan 产出规划且不落盘不建检出', async () => {
    const { dir, runner } = await makeDivergedRepo();
    try {
      const pipeline = createHarvestPipeline({ runner });
      const result = await pipeline.plan({
        taskId: 't1',
        repo: dir,
        branch: 'task',
      });
      expect(result.result).toBe('planned');
      expect(result.mode).toBe('plan');
      expect(result.targetBranch).toBe('main');
      expect(result.commits.map((c) => c.subject)).toEqual(['feat: task 加 b']);
      expect(result.worktreePath).toBe(officialWorktreePath(dir, 'task'));
      // 只读:官方池目录未被创建。
      expect(await exists(officialWorktreePath(dir, 'task'))).toBe(false);
      const list = await runner.captureOrThrow(
        ['worktree', 'list', '--porcelain'],
        { cwd: dir },
      );
      expect(list.stdout).not.toContain(
        toPosixPath(officialWorktreePath(dir, 'task')),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('plan 无领先提交返回 noop', async () => {
    const dir = await makeTempDir('dsh-kanban-harvest-pipe-plannoop-');
    const runner = createGitRunner();
    try {
      await initRepo(runner, dir);
      await commitFile(runner, dir, 'a.txt', 'line1\n', 'chore: 基线');
      await runner.captureOrThrow(['checkout', '-b', 'task'], { cwd: dir });
      await runner.captureOrThrow(['checkout', 'main'], { cwd: dir });
      await commitFile(
        runner,
        dir,
        'b.txt',
        'main 新文件\n',
        'feat: main 加 b',
      );
      const pipeline = createHarvestPipeline({ runner });
      const result = await pipeline.plan({
        taskId: 't1',
        repo: dir,
        branch: 'task',
      });
      expect(result.result).toBe('noop');
      expect(result.reason ?? '').toContain('无可收割');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('plan 主区脏时拒绝并列出脏文件', async () => {
    const { dir, runner } = await makeDivergedRepo();
    try {
      await writeFile(path.join(dir, 'dirty.txt'), '脏文件\n', 'utf8');
      const pipeline = createHarvestPipeline({ runner });
      const result = await pipeline.plan({
        taskId: 't1',
        repo: dir,
        branch: 'task',
      });
      expect(result.result).toBe('rejected');
      expect(result.dirtyFiles).toContain('dirty.txt');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('plan 任务状态非 done 时拒绝', async () => {
    const { dir, runner } = await makeDivergedRepo();
    try {
      const pipeline = createHarvestPipeline({ runner });
      const result = await pipeline.plan({
        taskId: 't1',
        repo: dir,
        branch: 'task',
        status: 'in_progress',
      });
      expect(result.result).toBe('rejected');
      expect(result.reason ?? '').toContain('不是 done');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('plan 用 merge-tree 预检出冲突文件(低版本 git 跳过预演)', async () => {
    const { dir, runner } = await makeConflictRepo();
    try {
      const pipeline = createHarvestPipeline({ runner });
      const result = await pipeline.plan({
        taskId: 't1',
        repo: dir,
        branch: 'task',
      });
      expect(result.result).toBe('planned');
      const version = await runner.version();
      if (versionAtLeast(version, MIN_MERGE_TREE_VERSION)) {
        expect(result.conflict?.files).toContain('a.txt');
      } else {
        expect(result.conflict).toBeUndefined();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('dsh-kanban-mode harvest:pipeline 收割执行', () => {
  it('变基成功后收尾合并(merged)', async () => {
    const { dir, runner, baseHash } = await makeRebaseNeededRepo();
    try {
      const pipeline = createHarvestPipeline({ runner });
      const result = await pipeline.apply({
        taskId: 't1',
        repo: dir,
        branch: 'task',
        baseCommit: baseHash,
      });
      expect(result.result).toBe('merged');
      expect(result.strategy).toBe('merge');
      expect(result.baseAdvanced).toBe(false);
      expect(result.mergeCommit).toBeDefined();
      expect(result.conflict).toBeUndefined();
      expect(result.actions.join('\n')).toContain('rebase');
      // 主区拿到两侧内容。
      expect(await readFile(path.join(dir, 'b.txt'), 'utf8')).toContain('task');
      expect(await readFile(path.join(dir, 'c.txt'), 'utf8')).toContain('main');
      // 分支与检出都已清理。
      expect(await branchListHas(runner, dir, 'task')).toBe(false);
      expect(await exists(officialWorktreePath(dir, 'task'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('base 前进检测抛错时按未前进处理：不穿透异常且不破坏结果契约', async () => {
    const { dir, runner } = await makeDivergedRepo();
    try {
      const baseCommit = (
        await runner.captureOrThrow(['rev-parse', 'main'], { cwd: dir })
      ).stdout.trim();
      const real = createGitInspector(runner);
      const pipeline = createHarvestPipeline({
        runner,
        inspector: {
          ...real,
          baseAdvanced: async () => {
            throw new Error('base 提交已被回收');
          },
        },
      });
      const result = await pipeline.apply({
        taskId: 't1',
        repo: dir,
        branch: 'task',
        baseCommit,
      });
      // 检测失败不能变成未结构化异常：结果仍须落在 §5 的 result 枚举里。
      expect(['merged', 'conflict', 'rejected', 'noop', 'failed']).toContain(
        result.result,
      );
      expect(result.baseAdvanced).toBeNull();
      expect(result.notes.join('\n')).toContain('base 前进检测失败');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('plan 路径的 base 前进检测抛错时同样按未前进处理：规划不穿透异常', async () => {
    const { dir, runner } = await makeDivergedRepo();
    try {
      const baseCommit = (
        await runner.captureOrThrow(['rev-parse', 'main'], { cwd: dir })
      ).stdout.trim();
      const real = createGitInspector(runner);
      const pipeline = createHarvestPipeline({
        runner,
        inspector: {
          ...real,
          baseAdvanced: async () => {
            throw new Error('base 提交已被回收');
          },
        },
      });
      const result = await pipeline.plan({
        taskId: 't1',
        repo: dir,
        branch: 'task',
        baseCommit,
      });
      expect(result.result).toBe('planned');
      expect(result.baseAdvanced).toBeNull();
      expect(result.notes.join('\n')).toContain('base 前进检测失败');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('合并预检能力探测抛错时跳过预演：不穿透异常且不破坏结果契约', async () => {
    const { dir, runner } = await makeDivergedRepo();
    try {
      const real = createGitInspector(runner);
      const pipeline = createHarvestPipeline({
        runner,
        inspector: {
          ...real,
          capabilities: async () => {
            throw new Error('git 版本输出不可解析');
          },
        },
      });
      const plan = await pipeline.plan({
        taskId: 't1',
        repo: dir,
        branch: 'task',
      });
      expect(plan.result).toBe('planned');
      expect(plan.notes.join('\n')).toContain('合并预检能力探测失败');

      const applied = await pipeline.apply({
        taskId: 't1',
        repo: dir,
        branch: 'task',
      });
      expect(['merged', 'conflict', 'rejected', 'noop', 'failed']).toContain(
        applied.result,
      );
      expect(applied.notes.join('\n')).toContain('合并预检能力探测失败');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('普通收割以 --no-ff 合并收尾(merged)', async () => {
    const { dir, runner } = await makeDivergedRepo();
    try {
      const pipeline = createHarvestPipeline({ runner });
      const result = await pipeline.apply({
        taskId: 't1',
        repo: dir,
        branch: 'task',
      });
      expect(result.result).toBe('merged');
      expect(result.strategy).toBe('merge');
      expect(result.mergeCommit).toBeDefined();
      expect(result.baseAdvanced).toBeNull();
      expect(await readFile(path.join(dir, 'b.txt'), 'utf8')).toContain('task');
      expect(await branchListHas(runner, dir, 'task')).toBe(false);
      expect(await exists(officialWorktreePath(dir, 'task'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('merge 冲突保留现场返回 conflict,重复 apply 幂等,解决后续跑完成', async () => {
    const { dir, runner } = await makeConflictRepo();
    try {
      const pipeline = createHarvestPipeline({ runner });

      // 第一次:冲突,保留现场。
      const first = await pipeline.apply({
        taskId: 't1',
        repo: dir,
        branch: 'task',
      });
      expect(first.result).toBe('conflict');
      expect(first.conflict?.kind).toBe('merge');
      expect(first.conflict?.side).toBe('main');
      expect(first.conflict?.files).toContain('a.txt');
      expect(first.conflict?.resumeCommand).toEqual(['commit', '--no-edit']);
      expect(first.conflict?.suggestions.length).toBeGreaterThan(0);
      // 现场保留:主区 merge 进行中 + 冲突标记仍在文件里。
      expect((await detectInProgressState(runner, dir)).kind).toBe('merge');
      expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toContain(
        '<<<<<<<',
      );

      // 第二次:未解决 → 仍是 conflict(幂等,现场不变)。
      const second = await pipeline.apply({
        taskId: 't1',
        repo: dir,
        branch: 'task',
      });
      expect(second.result).toBe('conflict');
      expect(second.conflict?.files).toEqual(first.conflict?.files);
      expect((await detectInProgressState(runner, dir)).kind).toBe('merge');

      // 解决冲突并标记后再次 apply:续跑收尾 → merged。
      await writeFile(
        path.join(dir, 'a.txt'),
        'resolved-line1\nline2\nline3\n',
        'utf8',
      );
      await runner.captureOrThrow(['add', 'a.txt'], { cwd: dir });
      const third = await pipeline.apply({
        taskId: 't1',
        repo: dir,
        branch: 'task',
      });
      expect(third.result).toBe('merged');
      expect(third.mergeCommit).toBeDefined();
      expect(third.strategy).toBe('merge');
      // 收尾干净:无进行中合并,工作区干净。
      expect((await detectInProgressState(runner, dir)).inProgress).toBe(false);
      const status = await runner.captureOrThrow(['status', '--porcelain'], {
        cwd: dir,
      });
      expect(status.stdout.trim()).toBe('');
      expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toContain(
        'resolved-line1',
      );
      expect(await branchListHas(runner, dir, 'task')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rebase 冲突保留检出现场,解决后续跑完成', async () => {
    const { dir, runner, baseHash } = await makeRebaseConflictRepo();
    try {
      const pipeline = createHarvestPipeline({ runner });
      const first = await pipeline.apply({
        taskId: 't1',
        repo: dir,
        branch: 'task',
        baseCommit: baseHash,
      });
      expect(first.result).toBe('conflict');
      expect(first.conflict?.kind).toBe('rebase');
      expect(first.conflict?.side).toBe('worktree');
      const worktreePath = first.conflict?.worktreePath ?? '';
      expect(worktreePath).toBe(officialWorktreePath(dir, 'task'));
      // 现场保留:检出内 rebase 进行中。
      expect((await detectInProgressState(runner, worktreePath)).kind).toBe(
        'rebase',
      );

      // 幂等:未解决时再次 apply 仍是 conflict。
      const second = await pipeline.apply({
        taskId: 't1',
        repo: dir,
        branch: 'task',
        baseCommit: baseHash,
      });
      expect(second.result).toBe('conflict');
      expect(second.conflict?.kind).toBe('rebase');

      // 在检出内解决并 git add 后续跑 → merged。
      await writeFile(
        path.join(worktreePath, 'a.txt'),
        'resolved-line1\nline2\nline3\n',
        'utf8',
      );
      await runner.captureOrThrow(['add', 'a.txt'], { cwd: worktreePath });
      const third = await pipeline.apply({
        taskId: 't1',
        repo: dir,
        branch: 'task',
        baseCommit: baseHash,
      });
      expect(third.result).toBe('merged');
      expect(third.strategy).toBe('merge');
      expect(third.mergeCommit).toBeDefined();
      expect(await branchListHas(runner, dir, 'task')).toBe(false);
      expect(await exists(officialWorktreePath(dir, 'task'))).toBe(false);
      expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toContain(
        'resolved-line1',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 90_000); // 本用例连续三次完整 apply(冲突/续跑/收尾),真实 git 慢,单独放宽。

  it('主区脏时拒绝收割并列出脏文件(rejected)', async () => {
    const { dir, runner } = await makeDivergedRepo();
    try {
      await writeFile(path.join(dir, 'dirty.txt'), '脏文件\n', 'utf8');
      const pipeline = createHarvestPipeline({ runner });
      const result = await pipeline.apply({
        taskId: 't1',
        repo: dir,
        branch: 'task',
      });
      expect(result.result).toBe('rejected');
      expect(result.reason ?? '').toContain('主区不干净');
      expect(result.dirtyFiles).toContain('dirty.txt');
      // 拒绝即不动现场:分支与检出都还在。
      expect(await branchListHas(runner, dir, 'task')).toBe(true);
      expect(await exists(officialWorktreePath(dir, 'task'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('任务分支已推送时拒绝变基并降级为 --no-ff 合并', async () => {
    const { dir, originDir, runner } = await makePushedRepo();
    try {
      const tipBefore = await shortHash(runner, dir, 'task');
      const pipeline = createHarvestPipeline({ runner });
      const result = await pipeline.apply({
        taskId: 't1',
        repo: dir,
        branch: 'task',
        deleteBranch: false,
      });
      expect(result.result).toBe('merged');
      expect(result.degraded).toBe(true);
      expect(result.strategy).toBe('merge');
      expect(result.notes.join('\n')).toContain('已推送');
      expect(result.actions.join('\n')).toContain('跳过变基');
      // 未发生变基:任务分支 tip 不变。
      expect(await shortHash(runner, dir, 'task')).toBe(tipBefore);
      // 主区拿到任务分支(含未推送的那个提交)与 main 自己的内容。
      expect(await exists(path.join(dir, 'b.txt'))).toBe(true);
      expect(await exists(path.join(dir, 'b2.txt'))).toBe(true);
      expect(await exists(path.join(dir, 'c.txt'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(originDir, { recursive: true, force: true });
    }
  });

  it('任务分支没有领先提交时返回 noop', async () => {
    const dir = await makeTempDir('dsh-kanban-harvest-pipe-applynoop-');
    const runner = createGitRunner();
    try {
      await initRepo(runner, dir);
      await commitFile(runner, dir, 'a.txt', 'line1\n', 'chore: 基线');
      await runner.captureOrThrow(['checkout', '-b', 'task'], { cwd: dir });
      await runner.captureOrThrow(['checkout', 'main'], { cwd: dir });
      await commitFile(
        runner,
        dir,
        'b.txt',
        'main 新文件\n',
        'feat: main 加 b',
      );
      const pipeline = createHarvestPipeline({ runner });
      const result = await pipeline.apply({
        taskId: 't1',
        repo: dir,
        branch: 'task',
      });
      expect(result.result).toBe('noop');
      expect(result.reason ?? '').toContain('无可收割');
      expect(await branchListHas(runner, dir, 'task')).toBe(true);
      expect(await exists(officialWorktreePath(dir, 'task'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('非冲突合并失败时返回 failed,尝试 abort 且不留脏态', async () => {
    const { dir, runner } = await makeDivergedRepo();
    try {
      const traced = instrumentedRunner(runner, (args) =>
        args[0] === 'merge' && args[1] === '--no-ff'
          ? {
              ok: false,
              exitCode: 128,
              stdout: '',
              stderr: 'fatal: 模拟的非冲突合并失败',
              truncated: false,
              timedOut: false,
            }
          : undefined,
      );
      const pipeline = createHarvestPipeline({ runner: traced });
      const result = await pipeline.apply({
        taskId: 't1',
        repo: dir,
        branch: 'task',
      });
      expect(result.result).toBe('failed');
      expect(result.reason ?? '').toContain('合并失败');
      // 走过 abort 兜底。
      expect(
        traced.trace.some(
          (entry) => entry.args[0] === 'merge' && entry.args[1] === '--abort',
        ),
      ).toBe(true);
      // 零脏态:无进行中合并,工作区无用户脏文件(官方池 .agents/ 是管线自管
      // 目录,不算脏),分支仍在(未合并不删)。
      expect((await detectInProgressState(runner, dir)).inProgress).toBe(false);
      const status = await runner.captureOrThrow(['status', '--porcelain'], {
        cwd: dir,
      });
      const userDirt = status.stdout
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('?? .agents'));
      expect(userDirt).toEqual([]);
      expect(await branchListHas(runner, dir, 'task')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('无关历史分支导致审查/合并失败时返回 failed 且不留脏态', async () => {
    const { dir, runner } = await makeDivergedRepo();
    const other = await makeTempDir('dsh-kanban-harvest-pipe-unrelated-src-');
    try {
      const otherRunner = createGitRunner();
      await initRepo(otherRunner, other);
      await commitFile(
        otherRunner,
        other,
        'z.txt',
        'unrelated\n',
        'feat: 无关历史提交',
      );
      await runner.captureOrThrow(['fetch', toPosixPath(other), 'HEAD'], {
        cwd: dir,
      });
      await runner.captureOrThrow(['branch', 'unrelated', 'FETCH_HEAD'], {
        cwd: dir,
      });
      const pipeline = createHarvestPipeline({ runner });
      const result = await pipeline.apply({
        taskId: 't1',
        repo: dir,
        branch: 'unrelated',
      });
      expect(result.result).toBe('failed');
      expect(result.reason ?? '').toContain('失败');
      expect((await detectInProgressState(runner, dir)).inProgress).toBe(false);
      const status = await runner.captureOrThrow(['status', '--porcelain'], {
        cwd: dir,
      });
      expect(status.stdout.trim()).toBe('');
      expect(await branchListHas(runner, dir, 'task')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe('dsh-kanban-mode harvest:pipeline 丢弃模式', () => {
  it('discard 先留痕再删检出删分支,返回 deleted', async () => {
    const { dir, runner } = await makeDivergedRepo();
    try {
      const worktreePath = officialWorktreePath(dir, 'task');
      await runner.captureOrThrow(['worktree', 'add', worktreePath, 'task'], {
        cwd: dir,
      });
      // 脏检出:丢弃语义下也要删。
      await writeFile(path.join(worktreePath, 'junk.txt'), '垃圾\n', 'utf8');
      // 留痕的 branchTip 是完整哈希(rev-parse 原样输出)。
      const tipBefore = (
        await runner.captureOrThrow(['rev-parse', 'task'], { cwd: dir })
      ).stdout.trim();

      const traced = instrumentedRunner(runner);
      const pipeline = createHarvestPipeline({ runner: traced });
      const result = await pipeline.discard({
        taskId: 't1',
        repo: dir,
        branch: 'task',
        worktreePath,
      });
      expect(result.result).toBe('deleted');
      expect(result.branchDeleted).toBe(true);
      expect(result.worktreeRemoved).toBe(true);
      // 留痕素材:分支名 + tip + 脏文件清单。
      expect(result.trace.branch).toBe('task');
      expect(result.trace.branchTip).toBe(tipBefore);
      expect(result.trace.dirtyFiles).toContain('junk.txt');
      expect(result.trace.worktreePath).toBe(worktreePath);
      // 检出与分支都没了。
      expect(await exists(worktreePath)).toBe(false);
      expect(await branchListHas(runner, dir, 'task')).toBe(false);
      // 留痕先于删除:status / rev-parse 出现在 worktree remove 之前。
      const statusIdx = traced.trace.findIndex(
        (entry) => entry.args[0] === 'status',
      );
      const removeIdx = traced.trace.findIndex(
        (entry) => entry.args[0] === 'worktree',
      );
      const tipIdx = traced.trace.findIndex(
        (entry) => entry.args[0] === 'rev-parse' && entry.args.includes('task'),
      );
      expect(statusIdx).toBeGreaterThanOrEqual(0);
      expect(removeIdx).toBeGreaterThan(statusIdx);
      expect(tipIdx).toBeGreaterThanOrEqual(0);
      expect(tipIdx).toBeLessThan(removeIdx);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('discard 幂等:检出与分支都不存在时返回 noop', async () => {
    const { dir, runner } = await makeDivergedRepo();
    try {
      const worktreePath = officialWorktreePath(dir, 'task');
      await runner.captureOrThrow(['worktree', 'add', worktreePath, 'task'], {
        cwd: dir,
      });
      const pipeline = createHarvestPipeline({ runner });
      const first = await pipeline.discard({
        taskId: 't1',
        repo: dir,
        branch: 'task',
        worktreePath,
      });
      expect(first.result).toBe('deleted');
      const second = await pipeline.discard({
        taskId: 't1',
        repo: dir,
        branch: 'task',
        worktreePath,
      });
      expect(second.result).toBe('noop');
      expect(second.branchDeleted).toBe(false);
      expect(second.worktreeRemoved).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('discard 未给分支信息时只清检出并如实标注 partial', async () => {
    const { dir, runner } = await makeDivergedRepo();
    try {
      const worktreePath = officialWorktreePath(dir, 'task');
      await runner.captureOrThrow(['worktree', 'add', worktreePath, 'task'], {
        cwd: dir,
      });
      const pipeline = createHarvestPipeline({ runner });
      const result = await pipeline.discard({
        taskId: 't1',
        repo: dir,
        worktreePath,
      });
      expect(result.result).toBe('partial');
      expect(result.worktreeRemoved).toBe(true);
      expect(result.branchDeleted).toBe(false);
      expect(result.trace.branch).toBeUndefined();
      expect(result.notes.join('\n')).toContain('未提供分支信息');
      expect(await exists(worktreePath)).toBe(false);
      // 分支未被触碰。
      expect(await branchListHas(runner, dir, 'task')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('discard 仓库无效时返回 rejected', async () => {
    const { dir, runner } = await makeDivergedRepo();
    try {
      const pipeline = createHarvestPipeline({ runner });
      const result = await pipeline.discard({
        taskId: 't1',
        repo: path.join(dir, '不存在的仓'),
      });
      expect(result.result).toBe('rejected');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('dsh-kanban-mode harvest:pipeline 仓库级互斥', () => {
  it('同仓并发 apply 串行执行(最大并发数为 1)', async () => {
    const { dir, runner } = await makeDivergedRepo();
    try {
      await runner.captureOrThrow(['checkout', '-b', 'task2'], { cwd: dir });
      await commitFile(
        runner,
        dir,
        'e.txt',
        'task2 新文件\n',
        'feat: task2 加 e',
      );
      await runner.captureOrThrow(['checkout', 'main'], { cwd: dir });

      const traced = instrumentedRunner(runner);
      const pipeline = createHarvestPipeline({ runner: traced });
      const [first, second] = await Promise.all([
        pipeline.apply({ taskId: 't1', repo: dir, branch: 'task' }),
        pipeline.apply({ taskId: 't2', repo: dir, branch: 'task2' }),
      ]);
      expect(traced.maxConcurrent).toBe(1);
      expect([first.result, second.result].sort()).toEqual([
        'merged',
        'merged',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('apply 与 discard 共享同一把仓库锁', async () => {
    const { dir, runner } = await makeDivergedRepo();
    try {
      const worktreePath = officialWorktreePath(dir, 'task');
      await runner.captureOrThrow(['worktree', 'add', worktreePath, 'task'], {
        cwd: dir,
      });
      const traced = instrumentedRunner(runner);
      const pipeline = createHarvestPipeline({ runner: traced });
      const [applied, discarded] = await Promise.all([
        pipeline.apply({ taskId: 't1', repo: dir, branch: 'task' }),
        pipeline.discard({
          taskId: 't2',
          repo: dir,
          branch: 'task',
          worktreePath,
        }),
      ]);
      expect(traced.maxConcurrent).toBe(1);
      expect(['merged', 'rejected', 'noop', 'failed']).toContain(
        applied.result,
      );
      expect(['deleted', 'partial', 'noop']).toContain(discarded.result);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('dsh-kanban-mode harvest:pipeline 工具函数', () => {
  it('officialWorktreePath 落在官方池并按分支命名', () => {
    expect(officialWorktreePath('E:/repo', 'task')).toBe(
      path.join('E:/repo', '.agents', 'worktrees', 'task'),
    );
    expect(officialWorktreePath('E:/repo', 'feat/x')).toBe(
      path.join('E:/repo', '.agents', 'worktrees', 'feat/x'),
    );
  });
});
