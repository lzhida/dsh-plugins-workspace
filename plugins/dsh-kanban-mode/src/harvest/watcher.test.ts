/**
 * watcher.ts 测试：验收联动 watcher（done 自动合并 / canceled 自动丢弃）。
 *
 * 两类用例：
 * - 假板服务 + 假管线 + 假 runner：感知（基线 / 进入事件 / 幂等 / 串行）、
 *   留痕与建卡、降级与异常路径——纯内存，快且确定。
 * - 真实 git 临时仓（os.tmpdir() 下 mkdtemp + finally 清理）：done 直合路径
 *   （合并 + 删检出 + 删分支 -d）与 canceled 丢弃路径（先留痕 tip/脏文件 →
 *   删检出 → 删分支 -D），验证真实副作用与「留痕先于删除」的顺序。
 *
 * @module dsh-kanban-mode/harvest/watcher.test
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 真实 git 仓（worktree add / rebase / merge / branch -d）在 Windows 上可能接近
// vitest 默认 5s 上限，统一放宽到 60s：单跑该文件约 21s，全仓并行负载下可超 30s，
// 避免慢盘/高负载环境的假失败。
vi.setConfig({ testTimeout: 60_000 });

import { createGitRunner } from './git-runner.ts';
import type {
  GitCaptureOptions,
  GitCaptureResult,
  GitRunner,
  GitVersion,
} from './git-runner.ts';
import { officialWorktreePath } from './pipeline.ts';
import type {
  DiscardRequest,
  DiscardResult,
  HarvestPipeline,
  HarvestRequest,
  HarvestResult,
} from './pipeline.ts';
import type { WorkspaceRegistryFace } from './task-target.ts';
import {
  createHarvestWatcher,
  resolveWatchEnabled,
  resolveWatchIntervalMs,
} from './watcher.ts';
import type { HarvestWatcherContext } from './watcher.ts';
import type {
  BoardAddTaskCommentInput,
  BoardAddTaskCommentResult,
  BoardCreateTaskInput,
  BoardDependencyView,
  BoardLedger,
  BoardServiceContract,
  BoardTaskRecord,
  BoardTaskSummary,
} from '../tools/board-contract.ts';

/* ------------------------------------------------------------------ 假实现 */

/** 事件轨迹：记录留痕 / 建卡 / 丢弃的先后顺序。 */
type Trace = string[];

/** 假板服务：可换台账、可收评论、可建卡；不碰真实 dsh-taskboard。 */
class FakeBoard implements BoardServiceContract {
  tasks: BoardTaskRecord[] = [];
  revision = 1;
  readonly comments: BoardAddTaskCommentInput[] = [];
  readonly created: BoardCreateTaskInput[] = [];
  readonly trace: Trace;
  addTaskComment?: (
    input: BoardAddTaskCommentInput,
  ) => Promise<BoardAddTaskCommentResult>;

  constructor(
    options: { tasks?: readonly BoardTaskRecord[]; revision?: number },
    trace: Trace,
  ) {
    this.tasks = [...(options.tasks ?? [])];
    this.revision = options.revision ?? 1;
    this.trace = trace;
  }

  /** 挂上评论写通道（降级用例故意不挂）。 */
  enableComments(): void {
    this.addTaskComment = async (
      input: BoardAddTaskCommentInput,
    ): Promise<BoardAddTaskCommentResult> => {
      this.comments.push(input);
      this.trace.push(`comment:${input.taskId}`);
      return { ok: true, taskId: input.taskId };
    };
  }

  snapshot(): BoardLedger {
    return {
      tasks: this.tasks.map((task) => ({ ...task })),
      revision: this.revision,
    };
  }

  getTask(id: string): BoardTaskRecord | undefined {
    return this.tasks.find((task) => task.id === id);
  }

  listTasks(): BoardTaskSummary[] {
    return this.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      workspaceId: task.workspaceId,
      status: task.status,
      blocked: false,
      version: task.version,
    }));
  }

  dependencies(): BoardDependencyView[] {
    return [];
  }

  dependencyBlock(): string | undefined {
    return undefined;
  }

  async createTask(input: BoardCreateTaskInput): Promise<BoardTaskSummary> {
    this.created.push(input);
    this.trace.push(`create:${input.title}`);
    return {
      id: `harvest-card-${this.created.length}`,
      title: input.title,
      workspaceId: input.workspaceId,
      status: 'todo',
      blocked: false,
      version: 1,
    };
  }
}

/** 假管线：记录调用轨迹，可替换 apply / discard 的返回。 */
class FakePipeline implements HarvestPipeline {
  readonly applyCalls: HarvestRequest[] = [];
  readonly discardCalls: DiscardRequest[] = [];
  readonly trace: Trace;
  applyHandler: (request: HarvestRequest) => Promise<HarvestResult>;
  discardHandler: (request: DiscardRequest) => Promise<DiscardResult>;

  constructor(
    trace: Trace,
    applyHandler?: (request: HarvestRequest) => Promise<HarvestResult>,
    discardHandler?: (request: DiscardRequest) => Promise<DiscardResult>,
  ) {
    this.trace = trace;
    this.applyHandler =
      applyHandler ?? (async (request) => mergedResult(request));
    this.discardHandler =
      discardHandler ?? (async (request) => deletedResult(request));
  }

  async plan(request: HarvestRequest): Promise<HarvestResult> {
    return { ...mergedResult(request), mode: 'plan', result: 'planned' };
  }

  async apply(request: HarvestRequest): Promise<HarvestResult> {
    this.applyCalls.push(request);
    this.trace.push('apply');
    return this.applyHandler(request);
  }

  async discard(request: DiscardRequest): Promise<DiscardResult> {
    this.discardCalls.push(request);
    this.trace.push('discard');
    return this.discardHandler(request);
  }
}

/** 假 git 执行器：按命令返回预置结果，记录调用（用于校验只读采集口径）。 */
class FakeRunner implements GitRunner {
  readonly calls: { args: readonly string[]; cwd?: string }[] = [];
  readonly responses = new Map<string, GitCaptureResult>();

  async capture(
    args: readonly string[],
    options?: GitCaptureOptions,
  ): Promise<GitCaptureResult> {
    this.calls.push({ args, cwd: options?.cwd });
    const hit = this.responses.get(args.join(' '));
    if (hit !== undefined) return hit;
    return {
      ok: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
    };
  }

  async captureOrThrow(
    args: readonly string[],
    options?: GitCaptureOptions,
  ): Promise<GitCaptureResult> {
    const result = await this.capture(args, options);
    if (!result.ok) throw new Error(`git 失败：${args.join(' ')}`);
    return result;
  }

  async version(): Promise<GitVersion> {
    return { major: 2, minor: 40, patch: 0, raw: 'git version 2.40.0' };
  }

  async requireVersionAtLeast(min: GitVersion): Promise<GitVersion> {
    return min;
  }
}

/* -------------------------------------------------------------- 结果构造器 */

/** 合并成功的收割结果。 */
function mergedResult(request: HarvestRequest): HarvestResult {
  return {
    taskId: request.taskId,
    repo: request.repo,
    branch: request.branch,
    worktreePath: officialWorktreePath(request.repo, request.branch),
    targetBranch: 'main',
    mode: 'apply',
    result: 'merged',
    baseAdvanced: true,
    commits: [{ hash: 'abc1234', subject: 'feat: 任务提交' }],
    diffStat: '1 file changed, 1 insertion(+)',
    changedFiles: ['b.txt'],
    actions: ['已合并到 main', '已安全删除分支:task'],
    notes: [],
    mergeCommit: 'abc1234',
  };
}

/** 冲突的收割结果（保留现场）。 */
function conflictResult(request: HarvestRequest): HarvestResult {
  return {
    ...mergedResult(request),
    result: 'conflict',
    mergeCommit: undefined,
    diffStat: undefined,
    reason: '变基冲突:需要人工解决',
    conflict: {
      kind: 'rebase',
      side: 'worktree',
      files: ['a.txt'],
      suggestions: ['手动解决 a.txt 后继续变基'],
      worktreePath: officialWorktreePath(request.repo, request.branch),
      resumeCommand: ['git rebase --continue'],
    },
  };
}

/** 主区脏被拒的收割结果。 */
function dirtyRejectedResult(request: HarvestRequest): HarvestResult {
  return {
    ...mergedResult(request),
    result: 'rejected',
    mergeCommit: undefined,
    diffStat: undefined,
    reason: '主区不干净,拒绝收割:dirty.txt',
    dirtyFiles: ['dirty.txt'],
  };
}

/** 丢弃成功的结果。 */
function deletedResult(request: DiscardRequest): DiscardResult {
  return {
    taskId: request.taskId,
    repo: request.repo,
    result: 'deleted',
    branchDeleted: true,
    worktreeRemoved: true,
    trace: {
      ...(request.branch !== undefined ? { branch: request.branch } : {}),
      branchTip: 'deadbeef',
      dirtyFiles: ['dirty.txt'],
      ...(request.worktreePath !== undefined
        ? { worktreePath: request.worktreePath }
        : {}),
    },
    actions: ['已删除检出', '已强制删除分支'],
    notes: [],
  };
}

/* ------------------------------------------------------------------ 辅助件 */

/**
 * 造一张板任务记录。
 *
 * description / prompt 允许带上：窄契约（BoardTaskRecord）没声明这两个字段，
 * 但上游记录里确实带着——防递归判定要读它们。
 */
type FakeTaskInput = Partial<BoardTaskRecord> & {
  id: string;
  description?: string;
  prompt?: string;
};

function makeTask(overrides: FakeTaskInput): BoardTaskRecord {
  return {
    title: '任务卡',
    workspaceId: 'ws-1',
    status: 'in_progress',
    execution: {},
    version: 1,
    ...overrides,
  };
}

/** 造一个项目注册表（workspaceId → 仓库绝对路径）。 */
function makeRegistry(paths: Record<string, string>): WorkspaceRegistryFace {
  return {
    get(id: string) {
      const repoPath = paths[id];
      return repoPath === undefined ? undefined : { id, path: repoPath };
    },
  };
}

/** 造一个宿主上下文（板服务 + 项目注册表都从这里软读取）。 */
function makeContext(services: Record<string, unknown>): HarvestWatcherContext {
  return { get: (name: string) => services[name] };
}

/** 目录是否存在。 */
async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** 一次性临时目录（建在 os.tmpdir()，Windows 上严禁硬编码 /tmp/）。 */
async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/* -------------------------------------------------------------------- 用例 */

describe('dsh-kanban-mode harvest:watcher 感知与队列', () => {
  it('首轮只建基线：历史已 done 的卡不会被收割', async () => {
    const trace: Trace = [];
    const board = new FakeBoard(
      { tasks: [makeTask({ id: 't-old', status: 'done', branch: 'task' })] },
      trace,
    );
    board.enableComments();
    const pipeline = new FakePipeline(trace);
    const watcher = createHarvestWatcher({
      context: makeContext({
        'dsh-taskboard': board,
        workspaceRegistry: makeRegistry({ 'ws-1': '/repo' }),
      }),
      pipeline,
      runner: new FakeRunner(),
      env: {},
      log: () => {},
      warn: () => {},
    });

    await watcher.poll();

    expect(pipeline.applyCalls).toHaveLength(0);
    expect(board.comments).toHaveLength(0);
  });

  it('台账首轮为空、次轮全量：历史存量 done 卡不触发收割也不留痕', async () => {
    const trace: Trace = [];
    // 首轮快照为空：台账还在异步加载（8MB 级台账，冷启动时真实发生）。
    const board = new FakeBoard({ tasks: [], revision: 1 }, trace);
    board.enableComments();
    const pipeline = new FakePipeline(trace);
    const watcher = createHarvestWatcher({
      context: makeContext({
        'dsh-taskboard': board,
        workspaceRegistry: makeRegistry({ 'ws-1': '/repo' }),
      }),
      pipeline,
      runner: new FakeRunner(),
      env: {},
      log: () => {},
      warn: () => {},
    });

    await watcher.poll();
    // 次轮全量台账到达：存量 done / canceled 卡只是「第一次被看见」，
    // 不是「刚刚进入 done / canceled」，不得触发收割、更不得写看板评论。
    board.tasks = [
      makeTask({ id: 't-old', status: 'done', branch: 'task' }),
      makeTask({ id: 't-old2', status: 'canceled', branch: 'task2' }),
    ];
    board.revision = 2;
    await watcher.poll();

    expect(pipeline.applyCalls).toHaveLength(0);
    expect(pipeline.discardCalls).toHaveLength(0);
    expect(board.comments).toHaveLength(0);
  });

  it('快照瞬时不完整不抹已知状态：随后进入 done 仍能识别为跃迁', async () => {
    const trace: Trace = [];
    const board = new FakeBoard(
      {
        tasks: [makeTask({ id: 't-1', status: 'in_progress', branch: 'task' })],
      },
      trace,
    );
    board.enableComments();
    const pipeline = new FakePipeline(trace);
    const watcher = createHarvestWatcher({
      context: makeContext({
        'dsh-taskboard': board,
        workspaceRegistry: makeRegistry({ 'ws-1': '/repo' }),
      }),
      pipeline,
      runner: new FakeRunner(),
      env: {},
      log: () => {},
      warn: () => {},
    });

    await watcher.poll();
    // 中间一轮快照瞬时不完整（台账加载中 / 分片）：不得抹掉已知状态。
    board.tasks = [];
    board.revision = 2;
    await watcher.poll();
    // 恢复全量后进入 done——必须仍能识别为跃迁并收割。
    board.tasks = [makeTask({ id: 't-1', status: 'done', branch: 'task' })];
    board.revision = 3;
    await watcher.poll();

    expect(pipeline.applyCalls).toHaveLength(1);
    expect(pipeline.applyCalls[0]).toMatchObject({ taskId: 't-1' });
    expect(board.comments).toHaveLength(1);
  });

  it('项目未在本实例注册：静默跳过，不往用户看板刷评论', async () => {
    const trace: Trace = [];
    const board = new FakeBoard(
      {
        tasks: [makeTask({ id: 't-1', status: 'in_progress', branch: 'task' })],
      },
      trace,
    );
    board.enableComments();
    const pipeline = new FakePipeline(trace);
    const watcher = createHarvestWatcher({
      context: makeContext({
        'dsh-taskboard': board,
        // 该卡所属项目没在本实例注册（别的机器 / 别的项目）。
        workspaceRegistry: makeRegistry({}),
      }),
      pipeline,
      runner: new FakeRunner(),
      env: {},
      log: () => {},
      warn: () => {},
    });

    await watcher.poll();
    board.tasks = [makeTask({ id: 't-1', status: 'done', branch: 'task' })];
    board.revision = 2;
    await watcher.poll();

    expect(pipeline.applyCalls).toHaveLength(0);
    expect(board.comments).toHaveLength(0);
  });

  it('状态进入 done 时触发收割并经板服务留痕', async () => {
    const trace: Trace = [];
    const board = new FakeBoard(
      {
        tasks: [makeTask({ id: 't-1', status: 'in_progress', branch: 'task' })],
      },
      trace,
    );
    board.enableComments();
    const pipeline = new FakePipeline(trace);
    const watcher = createHarvestWatcher({
      context: makeContext({
        'dsh-taskboard': board,
        workspaceRegistry: makeRegistry({ 'ws-1': '/repo' }),
      }),
      pipeline,
      runner: new FakeRunner(),
      env: {},
      log: () => {},
      warn: () => {},
    });

    await watcher.poll();
    board.tasks = [makeTask({ id: 't-1', status: 'done', branch: 'task' })];
    board.revision = 2;
    await watcher.poll();

    expect(pipeline.applyCalls).toHaveLength(1);
    expect(pipeline.applyCalls[0]).toMatchObject({
      taskId: 't-1',
      repo: '/repo',
      branch: 'task',
      status: 'done',
      deleteBranch: true,
      keepWorktree: false,
    });
    expect(board.comments).toHaveLength(1);
    const body = board.comments[0].body;
    expect(body).toContain('abc1234');
    expect(body).toContain('1 file changed');
    expect(body).toContain('merged');
    expect(body).toContain('改动文件：1 个');
    expect(board.comments[0].idempotencyKey).toContain('harvest-done:t-1:');
  });

  it('同一张卡的重复 done 事件只处理一次', async () => {
    const trace: Trace = [];
    const board = new FakeBoard(
      {
        tasks: [makeTask({ id: 't-1', status: 'in_progress', branch: 'task' })],
      },
      trace,
    );
    board.enableComments();
    const pipeline = new FakePipeline(trace);
    const watcher = createHarvestWatcher({
      context: makeContext({
        'dsh-taskboard': board,
        workspaceRegistry: makeRegistry({ 'ws-1': '/repo' }),
      }),
      pipeline,
      runner: new FakeRunner(),
      env: {},
      log: () => {},
      warn: () => {},
    });

    await watcher.poll();
    board.tasks = [makeTask({ id: 't-1', status: 'done', branch: 'task' })];
    board.revision = 2;
    await watcher.poll();
    // 重复事件：台账又动了一版，但状态没再变。
    board.revision = 3;
    await watcher.poll();

    expect(pipeline.applyCalls).toHaveLength(1);
    expect(board.comments).toHaveLength(1);
  });

  it('卡退回后再验收：第二轮跃迁仍会再次收割并留痕', async () => {
    const trace: Trace = [];
    const board = new FakeBoard(
      {
        tasks: [makeTask({ id: 't-1', status: 'in_progress', branch: 'task' })],
      },
      trace,
    );
    board.enableComments();
    const pipeline = new FakePipeline(trace);
    const watcher = createHarvestWatcher({
      context: makeContext({
        'dsh-taskboard': board,
        workspaceRegistry: makeRegistry({ 'ws-1': '/repo' }),
      }),
      pipeline,
      runner: new FakeRunner(),
      env: {},
      log: () => {},
      warn: () => {},
    });

    await watcher.poll();
    // 第一轮：进入 done → 收割 + 留痕。
    board.tasks = [makeTask({ id: 't-1', status: 'done', branch: 'task' })];
    board.revision = 2;
    await watcher.poll();
    expect(pipeline.applyCalls).toHaveLength(1);
    expect(board.comments).toHaveLength(1);

    // 验收被退回（done → todo）：离开 done/canceled 后必须清掉去重记录。
    board.tasks = [makeTask({ id: 't-1', status: 'todo', branch: 'task' })];
    board.revision = 3;
    await watcher.poll();
    expect(pipeline.applyCalls).toHaveLength(1);

    // 第二轮：再次进入 done → 必须再次收割并再次留痕。
    board.tasks = [makeTask({ id: 't-1', status: 'done', branch: 'task' })];
    board.revision = 4;
    await watcher.poll();
    expect(pipeline.applyCalls).toHaveLength(2);
    expect(board.comments).toHaveLength(2);
  });

  it('队列串行：多张卡同时进入 done 不并发跑 git', async () => {
    const trace: Trace = [];
    const board = new FakeBoard(
      {
        tasks: [
          makeTask({ id: 't-1', status: 'in_progress', branch: 'task' }),
          makeTask({ id: 't-2', status: 'in_progress', branch: 'task2' }),
        ],
      },
      trace,
    );
    board.enableComments();
    let running = 0;
    let maxConcurrent = 0;
    const pipeline = new FakePipeline(trace, async (request) => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return mergedResult(request);
    });
    const watcher = createHarvestWatcher({
      context: makeContext({
        'dsh-taskboard': board,
        workspaceRegistry: makeRegistry({ 'ws-1': '/repo' }),
      }),
      pipeline,
      runner: new FakeRunner(),
      env: {},
      log: () => {},
      warn: () => {},
    });

    await watcher.poll();
    board.tasks = [
      makeTask({ id: 't-1', status: 'done', branch: 'task' }),
      makeTask({ id: 't-2', status: 'done', branch: 'task2' }),
    ];
    board.revision = 2;
    await watcher.poll();

    expect(pipeline.applyCalls).toHaveLength(2);
    expect(maxConcurrent).toBe(1);
    expect(pipeline.applyCalls.map((call) => call.taskId)).toEqual([
      't-1',
      't-2',
    ]);
  });

  it('板服务缺席时静默降级：不抛穿且只告警一次', async () => {
    const warns: string[] = [];
    const watcher = createHarvestWatcher({
      context: makeContext({}),
      pipeline: new FakePipeline([]),
      runner: new FakeRunner(),
      env: {},
      log: () => {},
      warn: (message) => warns.push(message),
    });

    await watcher.poll();
    await watcher.poll();

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('dsh-taskboard');
  });

  it('板服务缺少评论写通道时降级：留痕跳过但管线照跑', async () => {
    const trace: Trace = [];
    // 故意不挂 addTaskComment（旧版板服务）。
    const board = new FakeBoard(
      {
        tasks: [makeTask({ id: 't-1', status: 'in_progress', branch: 'task' })],
      },
      trace,
    );
    const pipeline = new FakePipeline(trace);
    const warns: string[] = [];
    const watcher = createHarvestWatcher({
      context: makeContext({
        'dsh-taskboard': board,
        workspaceRegistry: makeRegistry({ 'ws-1': '/repo' }),
      }),
      pipeline,
      runner: new FakeRunner(),
      env: {},
      log: () => {},
      warn: (message) => warns.push(message),
    });

    await watcher.poll();
    board.tasks = [makeTask({ id: 't-1', status: 'done', branch: 'task' })];
    board.revision = 2;
    await watcher.poll();

    expect(pipeline.applyCalls).toHaveLength(1);
    expect(board.comments).toHaveLength(0);
    expect(warns.some((line) => line.includes('addTaskComment'))).toBe(true);
  });

  it('项目不在本实例注册时静默跳过（不刷用户看板）且不动 git', async () => {
    const trace: Trace = [];
    const board = new FakeBoard(
      {
        tasks: [makeTask({ id: 't-1', status: 'in_progress', branch: 'task' })],
      },
      trace,
    );
    board.enableComments();
    const pipeline = new FakePipeline(trace);
    const watcher = createHarvestWatcher({
      // workspaceRegistry 里没有 ws-1 → 解析不出仓库目录（别的项目/别的机器）。
      context: makeContext({
        'dsh-taskboard': board,
        workspaceRegistry: makeRegistry({}),
      }),
      pipeline,
      runner: new FakeRunner(),
      env: {},
      log: () => {},
      warn: () => {},
    });

    await watcher.poll();
    board.tasks = [makeTask({ id: 't-1', status: 'done', branch: 'task' })];
    board.revision = 2;
    await watcher.poll();

    expect(pipeline.applyCalls).toHaveLength(0);
    // 台账是多项目共享的：别的项目的卡不该在本实例的用户看板上刷屏。
    expect(board.comments).toHaveLength(0);
  });

  it('本实例的项目但卡没有任务分支：留痕说明原因且不动 git', async () => {
    const trace: Trace = [];
    const board = new FakeBoard(
      {
        tasks: [
          makeTask({ id: 't-1', status: 'in_progress', isolation: 'none' }),
        ],
      },
      trace,
    );
    board.enableComments();
    const pipeline = new FakePipeline(trace);
    const watcher = createHarvestWatcher({
      context: makeContext({
        'dsh-taskboard': board,
        workspaceRegistry: makeRegistry({ 'ws-1': '/repo' }),
      }),
      pipeline,
      runner: new FakeRunner(),
      env: {},
      log: () => {},
      warn: () => {},
    });

    await watcher.poll();
    board.tasks = [makeTask({ id: 't-1', status: 'done', isolation: 'none' })];
    board.revision = 2;
    await watcher.poll();

    expect(pipeline.applyCalls).toHaveLength(0);
    expect(board.comments).toHaveLength(1);
    expect(board.comments[0].body).toContain('目标解析失败');
    expect(board.comments[0].body).toContain('该卡没有任务分支');
  });

  it('冲突时自动建收割执行卡并内置 git -C 纪律', async () => {
    const trace: Trace = [];
    const board = new FakeBoard(
      {
        tasks: [
          makeTask({
            id: 't-1',
            status: 'in_progress',
            branch: 'task',
            title: '做点事',
          }),
        ],
      },
      trace,
    );
    board.enableComments();
    const pipeline = new FakePipeline(trace, async (request) =>
      conflictResult(request),
    );
    const watcher = createHarvestWatcher({
      context: makeContext({
        'dsh-taskboard': board,
        workspaceRegistry: makeRegistry({ 'ws-1': '/repo' }),
      }),
      pipeline,
      runner: new FakeRunner(),
      env: {},
      log: () => {},
      warn: () => {},
    });

    await watcher.poll();
    board.tasks = [
      makeTask({ id: 't-1', status: 'done', branch: 'task', title: '做点事' }),
    ];
    board.revision = 2;
    await watcher.poll();

    expect(board.created).toHaveLength(1);
    const created = board.created[0];
    expect(created.title).toBe('收割执行：做点事');
    expect(created.workspaceId).toBe('ws-1');
    expect(created.presetId).toBe('kanban-mode');
    expect(created.urgency).toBe('normal');
    expect(created.blockedBy).toEqual(['t-1']);
    expect(created.execution).toEqual({ mode: 'claim' });
    expect(created.description ?? '').toContain('[taskboard_harvest]');
    expect(created.prompt ?? '').toContain('git -C "/repo"');
    expect(created.prompt ?? '').toContain('taskboard_harvest');
    // 冲突路径不得动 git 的合并动作（只建卡）。
    expect(board.comments[0].body).toContain('自动收割未完成');
  });

  it('主区脏被拒时同样建收割执行卡', async () => {
    const trace: Trace = [];
    const board = new FakeBoard(
      {
        tasks: [makeTask({ id: 't-1', status: 'in_progress', branch: 'task' })],
      },
      trace,
    );
    board.enableComments();
    const pipeline = new FakePipeline(trace, async (request) =>
      dirtyRejectedResult(request),
    );
    const watcher = createHarvestWatcher({
      context: makeContext({
        'dsh-taskboard': board,
        workspaceRegistry: makeRegistry({ 'ws-1': '/repo' }),
      }),
      pipeline,
      runner: new FakeRunner(),
      env: {},
      log: () => {},
      warn: () => {},
    });

    await watcher.poll();
    board.tasks = [makeTask({ id: 't-1', status: 'done', branch: 'task' })];
    board.revision = 2;
    await watcher.poll();

    expect(board.created).toHaveLength(1);
    expect(board.created[0].title.startsWith('收割执行：')).toBe(true);
  });

  it('收割执行卡自身进入 done 时不递归建卡', async () => {
    const trace: Trace = [];
    const board = new FakeBoard(
      {
        tasks: [
          makeTask({
            id: 'h-1',
            status: 'in_progress',
            title: '收割执行：做点事',
            description: '[taskboard_harvest] 自动收割未完成',
          }),
        ],
      },
      trace,
    );
    board.enableComments();
    const pipeline = new FakePipeline(trace);
    const watcher = createHarvestWatcher({
      context: makeContext({
        'dsh-taskboard': board,
        workspaceRegistry: makeRegistry({ 'ws-1': '/repo' }),
      }),
      pipeline,
      runner: new FakeRunner(),
      env: {},
      log: () => {},
      warn: () => {},
    });

    await watcher.poll();
    board.tasks = [
      makeTask({
        id: 'h-1',
        status: 'done',
        title: '收割执行：做点事',
        description: '[taskboard_harvest] 自动收割未完成',
      }),
    ];
    board.revision = 2;
    await watcher.poll();

    expect(board.created).toHaveLength(0);
    expect(pipeline.applyCalls).toHaveLength(0);
  });

  it('管线抛异常时留痕说明且不阻塞后续卡', async () => {
    const trace: Trace = [];
    const board = new FakeBoard(
      {
        tasks: [
          makeTask({ id: 't-1', status: 'in_progress', branch: 'task' }),
          makeTask({ id: 't-2', status: 'in_progress', branch: 'task2' }),
        ],
      },
      trace,
    );
    board.enableComments();
    const pipeline = new FakePipeline(trace, async (request) => {
      if (request.taskId === 't-1') throw new Error('管线炸了');
      return mergedResult(request);
    });
    const watcher = createHarvestWatcher({
      context: makeContext({
        'dsh-taskboard': board,
        workspaceRegistry: makeRegistry({ 'ws-1': '/repo' }),
      }),
      pipeline,
      runner: new FakeRunner(),
      env: {},
      log: () => {},
      warn: () => {},
    });

    await watcher.poll();
    board.tasks = [
      makeTask({ id: 't-1', status: 'done', branch: 'task' }),
      makeTask({ id: 't-2', status: 'done', branch: 'task2' }),
    ];
    board.revision = 2;
    await watcher.poll();

    expect(pipeline.applyCalls).toHaveLength(2);
    expect(board.comments.some((item) => item.body.includes('管线炸了'))).toBe(
      true,
    );
  });
});

describe('dsh-kanban-mode harvest:watcher 丢弃路径', () => {
  it('canceled 时先留痕分支 tip 与脏文件，再执行 discard', async () => {
    const dir = await makeTempDir('dsh-kanban-harvest-watch-fake-cancel-');
    try {
      // 检出目录必须真实存在——只读采集会先探测它（不存在就如实标注「无脏文件清单」）。
      const worktree = officialWorktreePath(dir, 'task');
      await mkdir(worktree, { recursive: true });
      const trace: Trace = [];
      const board = new FakeBoard(
        {
          tasks: [
            makeTask({ id: 't-1', status: 'in_progress', branch: 'task' }),
          ],
        },
        trace,
      );
      board.enableComments();
      const pipeline = new FakePipeline(trace);
      const runner = new FakeRunner();
      runner.responses.set('rev-parse task', {
        ok: true,
        exitCode: 0,
        stdout: 'cafebabe\n',
        stderr: '',
        truncated: false,
        timedOut: false,
      });
      runner.responses.set('status --porcelain', {
        ok: true,
        exitCode: 0,
        stdout: '?? dirty.txt\n M a.txt\n',
        stderr: '',
        truncated: false,
        timedOut: false,
      });
      const watcher = createHarvestWatcher({
        context: makeContext({
          'dsh-taskboard': board,
          workspaceRegistry: makeRegistry({ 'ws-1': dir }),
        }),
        pipeline,
        runner,
        env: {},
        log: () => {},
        warn: () => {},
      });

      await watcher.poll();
      board.tasks = [
        makeTask({ id: 't-1', status: 'canceled', branch: 'task' }),
      ];
      board.revision = 2;
      await watcher.poll();

      expect(pipeline.discardCalls).toHaveLength(1);
      expect(pipeline.discardCalls[0]).toMatchObject({
        taskId: 't-1',
        repo: dir,
        branch: 'task',
      });
      // 顺序红线：留痕评论必须早于 discard 动作。
      expect(trace.indexOf('comment:t-1')).toBeLessThan(
        trace.indexOf('discard'),
      );
      const traceBody = board.comments[0].body;
      expect(traceBody).toContain('cafebabe');
      expect(traceBody).toContain('dirty.txt');
      expect(traceBody).toContain('a.txt');
      // 只读采集用的是既有封装（参数数组），不是手写命令串。
      expect(runner.calls.map((call) => call.args.join(' '))).toContain(
        'rev-parse task',
      );
      expect(runner.calls.map((call) => call.args.join(' '))).toContain(
        'status --porcelain',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('canceled 且分支/检出缺席时走 noop 仍留痕', async () => {
    const trace: Trace = [];
    const board = new FakeBoard(
      {
        tasks: [
          makeTask({ id: 't-1', status: 'in_progress', isolation: 'none' }),
        ],
      },
      trace,
    );
    board.enableComments();
    const pipeline = new FakePipeline(trace, undefined, async (request) => ({
      ...deletedResult(request),
      result: 'noop',
      branchDeleted: false,
      worktreeRemoved: false,
      trace: { dirtyFiles: [] },
    }));
    const watcher = createHarvestWatcher({
      context: makeContext({
        'dsh-taskboard': board,
        workspaceRegistry: makeRegistry({ 'ws-1': '/repo' }),
      }),
      pipeline,
      runner: new FakeRunner(),
      env: {},
      log: () => {},
      warn: () => {},
    });

    await watcher.poll();
    board.tasks = [
      makeTask({ id: 't-1', status: 'canceled', isolation: 'none' }),
    ];
    board.revision = 2;
    await watcher.poll();

    expect(pipeline.discardCalls).toHaveLength(1);
    expect(pipeline.discardCalls[0].branch).toBeUndefined();
    expect(board.comments.length).toBeGreaterThanOrEqual(1);
    expect(board.comments[0].body).toContain('丢弃留痕');
  });
});

describe('dsh-kanban-mode harvest:watcher 环境开关', () => {
  it('轮询间隔：显式参数 > 环境变量 > 默认 800', () => {
    expect(resolveWatchIntervalMs(120, {})).toBe(120);
    expect(resolveWatchIntervalMs(undefined, {})).toBe(800);
    expect(
      resolveWatchIntervalMs(undefined, {
        DSH_HARVEST_WATCH_INTERVAL_MS: '250',
      }),
    ).toBe(250);
    expect(
      resolveWatchIntervalMs(undefined, {
        DSH_HARVEST_WATCH_INTERVAL_MS: '乱填',
      }),
    ).toBe(800);
    expect(
      resolveWatchIntervalMs(undefined, {
        DSH_HARVEST_WATCH_INTERVAL_MS: '-1',
      }),
    ).toBe(800);
  });

  it('开关：off / 0 / false 关闭，其余开启', () => {
    expect(resolveWatchEnabled({})).toBe(true);
    expect(resolveWatchEnabled({ DSH_HARVEST_WATCH: 'off' })).toBe(false);
    expect(resolveWatchEnabled({ DSH_HARVEST_WATCH: '0' })).toBe(false);
    expect(resolveWatchEnabled({ DSH_HARVEST_WATCH: 'false' })).toBe(false);
    expect(resolveWatchEnabled({ DSH_HARVEST_WATCH: 'on' })).toBe(true);
  });

  it('开关关闭时 start 不排轮询、手动 poll 也不动作', async () => {
    const warns: string[] = [];
    const trace: Trace = [];
    const board = new FakeBoard(
      { tasks: [makeTask({ id: 't-1', status: 'done', branch: 'task' })] },
      trace,
    );
    board.enableComments();
    const pipeline = new FakePipeline(trace);
    const watcher = createHarvestWatcher({
      context: makeContext({
        'dsh-taskboard': board,
        workspaceRegistry: makeRegistry({ 'ws-1': '/repo' }),
      }),
      pipeline,
      runner: new FakeRunner(),
      env: { DSH_HARVEST_WATCH: 'off' },
      log: () => {},
      warn: (message) => warns.push(message),
    });

    watcher.start();
    watcher.stop();
    await watcher.poll();

    expect(warns).toHaveLength(0);
    expect(pipeline.applyCalls).toHaveLength(0);
    expect(board.comments).toHaveLength(0);
  });
});

describe('dsh-kanban-mode harvest:watcher 真实 git 端到端', () => {
  it('done 无冲突：合并 + 删检出 + 删分支 + 留痕', async () => {
    const dir = await makeTempDir('dsh-kanban-harvest-watch-done-');
    const runner = createGitRunner();
    try {
      await runner.captureOrThrow(['init', '-b', 'main'], { cwd: dir });
      await runner.captureOrThrow(
        ['config', 'user.email', 'watch-test@example.com'],
        { cwd: dir },
      );
      await runner.captureOrThrow(['config', 'user.name', 'watch-test'], {
        cwd: dir,
      });
      await runner.captureOrThrow(['config', 'commit.gpgsign', 'false'], {
        cwd: dir,
      });
      await writeFile(path.join(dir, 'a.txt'), 'base\n', 'utf8');
      await runner.captureOrThrow(['add', '-A'], { cwd: dir });
      await runner.captureOrThrow(['commit', '-m', 'chore: 基线'], {
        cwd: dir,
      });
      await runner.captureOrThrow(['checkout', '-b', 'task'], { cwd: dir });
      await writeFile(path.join(dir, 'b.txt'), 'task\n', 'utf8');
      await runner.captureOrThrow(['add', '-A'], { cwd: dir });
      await runner.captureOrThrow(['commit', '-m', 'feat: 任务提交'], {
        cwd: dir,
      });
      await runner.captureOrThrow(['checkout', 'main'], { cwd: dir });
      await writeFile(path.join(dir, 'c.txt'), 'main\n', 'utf8');
      await runner.captureOrThrow(['add', '-A'], { cwd: dir });
      await runner.captureOrThrow(['commit', '-m', 'feat: 主区提交'], {
        cwd: dir,
      });

      const trace: Trace = [];
      const board = new FakeBoard(
        {
          tasks: [
            makeTask({ id: 't-real', status: 'in_progress', branch: 'task' }),
          ],
        },
        trace,
      );
      board.enableComments();
      const watcher = createHarvestWatcher({
        context: makeContext({
          'dsh-taskboard': board,
          workspaceRegistry: makeRegistry({ 'ws-1': dir }),
        }),
        runner,
        env: {},
        log: () => {},
        warn: () => {},
      });

      await watcher.poll();
      board.tasks = [
        makeTask({ id: 't-real', status: 'done', branch: 'task' }),
      ];
      board.revision = 2;
      await watcher.poll();

      // 合并进了 main。
      const log = await runner.captureOrThrow(['log', '--oneline', 'main'], {
        cwd: dir,
      });
      expect(log.stdout).toContain('feat: 任务提交');
      // 分支已安全删除（-d）。
      const branch = await runner.capture(['rev-parse', 'task'], { cwd: dir });
      expect(branch.ok).toBe(false);
      // 检出已删除。
      expect(await exists(officialWorktreePath(dir, 'task'))).toBe(false);
      // 留痕含合并提交与差异摘要。
      expect(board.comments).toHaveLength(1);
      expect(board.comments[0].body).toContain('merged');
      expect(board.comments[0].body).toContain('合并提交');
      expect(board.comments[0].body).toContain('差异摘要');
      expect(board.created).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('canceled：先留痕 tip 与脏文件清单，再删检出与分支', async () => {
    const dir = await makeTempDir('dsh-kanban-harvest-watch-cancel-');
    const runner = createGitRunner();
    try {
      await runner.captureOrThrow(['init', '-b', 'main'], { cwd: dir });
      await runner.captureOrThrow(
        ['config', 'user.email', 'watch-test@example.com'],
        { cwd: dir },
      );
      await runner.captureOrThrow(['config', 'user.name', 'watch-test'], {
        cwd: dir,
      });
      await runner.captureOrThrow(['config', 'commit.gpgsign', 'false'], {
        cwd: dir,
      });
      await writeFile(path.join(dir, 'a.txt'), 'base\n', 'utf8');
      await runner.captureOrThrow(['add', '-A'], { cwd: dir });
      await runner.captureOrThrow(['commit', '-m', 'chore: 基线'], {
        cwd: dir,
      });
      await runner.captureOrThrow(['checkout', '-b', 'task'], { cwd: dir });
      await writeFile(path.join(dir, 'b.txt'), 'task\n', 'utf8');
      await runner.captureOrThrow(['add', '-A'], { cwd: dir });
      await runner.captureOrThrow(['commit', '-m', 'feat: 任务提交'], {
        cwd: dir,
      });
      await runner.captureOrThrow(['checkout', 'main'], { cwd: dir });

      const worktree = officialWorktreePath(dir, 'task');
      await runner.captureOrThrow(['worktree', 'add', worktree, 'task'], {
        cwd: dir,
      });
      // 检出里留两处脏改动（未跟踪 + 已改）。
      await writeFile(path.join(worktree, 'dirty.txt'), '脏文件\n', 'utf8');
      await writeFile(path.join(worktree, 'b.txt'), '改了\n', 'utf8');
      const tip = await runner.captureOrThrow(['rev-parse', 'task'], {
        cwd: dir,
      });
      const tipHash = tip.stdout.trim();

      const trace: Trace = [];
      const board = new FakeBoard(
        {
          tasks: [
            makeTask({ id: 't-cancel', status: 'in_progress', branch: 'task' }),
          ],
        },
        trace,
      );
      board.enableComments();
      const watcher = createHarvestWatcher({
        context: makeContext({
          'dsh-taskboard': board,
          workspaceRegistry: makeRegistry({ 'ws-1': dir }),
        }),
        runner,
        env: {},
        log: () => {},
        warn: () => {},
      });

      await watcher.poll();
      board.tasks = [
        makeTask({ id: 't-cancel', status: 'canceled', branch: 'task' }),
      ];
      board.revision = 2;
      await watcher.poll();

      // 留痕在删除之前：第一条评论带着删除前的 tip 与脏文件清单。
      const traceBody = board.comments[0].body;
      expect(traceBody).toContain(tipHash);
      expect(traceBody).toContain('dirty.txt');
      expect(traceBody).toContain('b.txt');
      // 检出已删（脏也删）、分支已强删（-D）。
      expect(await exists(worktree)).toBe(false);
      const branch = await runner.capture(['rev-parse', 'task'], { cwd: dir });
      expect(branch.ok).toBe(false);
      // 丢弃结果另有留痕。
      expect(board.comments.length).toBeGreaterThanOrEqual(2);
      expect(board.comments[1].body).toContain('丢弃完成');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
