/**
 * harvest.ts 测试：taskboard_harvest 工具契约（参数 schema / 输出结构 /
 * 降级文案）与一条真实 git 的 plan 端到端链路。
 *
 * 替身策略：板服务与工作区注册表用本包内 fake（不跨包 import）；管线用注入的
 * 假管线断言「请求形状」（工具只做编排，git 语义由 src/harvest/pipeline.ts
 * 负责，其自带真实 git 用例）。最后一条用例走真实管线 + 真实 git 临时仓，
 * 证明工具接线确实能把卡驱到「planned」。
 *
 * @module dsh-kanban-mode/tools/harvest.test
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 真实 git 仓(init + log + diff)在 Windows 上单用例可能接近 vitest 默认 5s
// 上限，统一放宽到 30s，避免慢盘环境下的假失败。
vi.setConfig({ testTimeout: 30_000 });

import {
  BOARD_SERVICE_UNAVAILABLE_MESSAGE,
  type BoardServiceContract,
  type BoardTaskRecord,
} from './board-contract.ts';
import {
  buildHarvestTool,
  ERR_WORKSPACE_REGISTRY,
  HARVEST_TOOL_NAME,
  WORKSPACE_REGISTRY_UNAVAILABLE_MESSAGE,
  type HarvestArgs,
  type HarvestValue,
} from './harvest.ts';
import { createGitRunner } from '../harvest/git-runner.ts';
import type { GitRunner } from '../harvest/git-runner.ts';
import type {
  HarvestMode,
  HarvestPipeline,
  HarvestRequest,
  HarvestResult,
} from '../harvest/pipeline.ts';
import type { WorkspaceRegistryFace } from '../harvest/task-target.ts';

/** 假项目目录（工具只透传给管线，不做 git 动作）。 */
const FAKE_REPO = 'E:/projects/demo';

/** 构造一张最小板任务记录。 */
function makeTask(overrides: Partial<BoardTaskRecord> = {}): BoardTaskRecord {
  return {
    id: 't-a',
    title: '卡A',
    workspaceId: 'ws-1',
    status: 'done',
    execution: { mode: 'claim' },
    version: 1,
    ...overrides,
  };
}

/** 本包内 fake BoardService 替身（不跨包 import）。 */
function fakeBoard(tasks: BoardTaskRecord[]): BoardServiceContract {
  return {
    snapshot: () => ({ tasks }),
    getTask: (id) => tasks.find((task) => task.id === id),
    listTasks: () => [],
    dependencies: () => [],
    dependencyBlock: () => undefined,
    createTask: async () => {
      throw new Error('harvest 工具不应建卡');
    },
  };
}

/** 假宿主工作区注册表。 */
function fakeRegistry(pathValue = FAKE_REPO): WorkspaceRegistryFace {
  return {
    get: (id) => ({ id, path: pathValue }),
  };
}

/** 管线调用记录（断言工具交给管线的请求形状）。 */
interface PipelineCall {
  readonly method: 'plan' | 'apply';
  readonly request: HarvestRequest;
}

/** 假管线：记录调用并返回固定结果。 */
function fakePipeline(
  result: HarvestResult,
  calls: PipelineCall[],
): HarvestPipeline {
  return {
    plan: async (request) => {
      calls.push({ method: 'plan', request });
      return result;
    },
    apply: async (request) => {
      calls.push({ method: 'apply', request });
      return result;
    },
    discard: async () => {
      throw new Error('harvest 工具不调用 discard');
    },
  };
}

/** 构造一条最小管线结果。 */
function makeResult(overrides: Partial<HarvestResult> = {}): HarvestResult {
  return {
    taskId: 't-a',
    repo: FAKE_REPO,
    branch: 'task/feat',
    worktreePath: `${FAKE_REPO}/.agents/worktrees/task/feat`,
    targetBranch: 'main',
    mode: 'plan',
    result: 'planned',
    baseAdvanced: null,
    commits: [{ hash: 'abc1234', subject: 'feat: 加一个功能' }],
    changedFiles: ['src/a.ts'],
    actions: ['计划审查提交 1 条'],
    notes: ['未提供 baseCommit:不检查 base 前进,直接合并'],
    ...overrides,
  };
}

/** 造一个「板服务 + 工作区注册表」齐备的最小 ctx（registry 传 null 表示缺该服务）。 */
function makeCtx(
  tasks: BoardTaskRecord[],
  registry: WorkspaceRegistryFace | null = fakeRegistry(),
): {
  get: (name: string) => unknown;
} {
  return {
    get: (name: string) => {
      if (name === 'dsh-taskboard') return fakeBoard(tasks);
      if (name === 'workspaceRegistry') {
        return registry === null ? undefined : registry;
      }
      return undefined;
    },
  };
}

describe('dsh-kanban-mode tools：taskboard_harvest 工具面', () => {
  it('工具名与参数契约对齐设计文档 §5', () => {
    const tool = buildHarvestTool({});
    expect(tool.name).toBe(HARVEST_TOOL_NAME);
    expect(tool.name).toBe('taskboard_harvest');
    expect(tool.description).toContain('done');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        mode: { type: 'string', enum: ['plan', 'apply'] },
        targetBranch: { type: 'string' },
        deleteBranch: { type: 'boolean' },
        keepWorktree: { type: 'boolean' },
      },
      required: ['taskId'],
    });
    expect(tool.output.schema).toEqual({});
  });

  it('板服务缺失时抛可操作错误（稳定码 + 安装指引）', async () => {
    const tool = buildHarvestTool({ get: () => undefined });
    await expect(
      tool.execute({ taskId: 't-a' }, undefined),
    ).rejects.toThrowError(
      `Error: board_service_unavailable: ${BOARD_SERVICE_UNAVAILABLE_MESSAGE}`,
    );
  });

  it('工作区注册表缺失时抛可操作错误（无法解析项目目录）', async () => {
    const tool = buildHarvestTool(makeCtx([makeTask()], null));
    await expect(
      tool.execute({ taskId: 't-a' }, undefined),
    ).rejects.toThrowError(
      `Error: ${ERR_WORKSPACE_REGISTRY}: ${WORKSPACE_REGISTRY_UNAVAILABLE_MESSAGE}`,
    );
  });

  it('卡不存在时抛 not_found 结构化错误', async () => {
    const tool = buildHarvestTool(makeCtx([]));
    await expect(
      tool.execute({ taskId: 't-ghost' }, undefined),
    ).rejects.toThrowError('Error: not_found: no task t-ghost');
  });

  it('卡没有任务分支时抛出目标解析的可操作原因', async () => {
    const tool = buildHarvestTool(
      makeCtx([makeTask({ branch: undefined, isolation: 'none' })]),
    );
    await expect(
      tool.execute({ taskId: 't-a' }, undefined),
    ).rejects.toThrowError(
      'Error: invalid_input: 该卡没有任务分支（isolation=none），无可收割的分支',
    );
  });

  it('plan 模式只调管线 plan，并按 §5 缺省透传参数', async () => {
    const calls: PipelineCall[] = [];
    const tool = buildHarvestTool(
      makeCtx([makeTask({ branch: 'task/feat' })]),
      {
        createPipeline: () => fakePipeline(makeResult(), calls),
      },
    );
    await tool.execute({ taskId: 't-a' }, undefined);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('plan');
    expect(calls[0]!.request).toEqual({
      taskId: 't-a',
      repo: FAKE_REPO,
      branch: 'task/feat',
      mode: 'plan',
      deleteBranch: true,
      keepWorktree: false,
      status: 'done',
    });
  });

  it('apply 模式调管线 apply，并透传显式参数', async () => {
    const calls: PipelineCall[] = [];
    const tool = buildHarvestTool(
      makeCtx([makeTask({ branch: 'task/feat' })]),
      {
        createPipeline: () => fakePipeline(makeResult(), calls),
      },
    );
    await tool.execute(
      {
        taskId: 't-a',
        mode: 'apply',
        targetBranch: 'release',
        deleteBranch: false,
        keepWorktree: true,
      },
      undefined,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('apply');
    expect(calls[0]!.request).toMatchObject({
      mode: 'apply',
      targetBranch: 'release',
      deleteBranch: false,
      keepWorktree: true,
    });
  });

  it('baseCommit 取自最新带分支的执行记录并交给管线', async () => {
    const calls: PipelineCall[] = [];
    const tool = buildHarvestTool(
      makeCtx([
        makeTask({
          executions: [
            { isolation: 'none' },
            {
              isolation: 'worktree',
              branch: 'task/feat',
              baseCommit: 'base1234',
            },
          ],
        }),
      ]),
      { createPipeline: () => fakePipeline(makeResult(), calls) },
    );
    await tool.execute({ taskId: 't-a' }, undefined);
    expect(calls[0]!.request.branch).toBe('task/feat');
    expect(calls[0]!.request.baseCommit).toBe('base1234');
  });

  it('输出结构化 JSON 含 result 与 conflict.files，render 文本给出冲突文件清单', async () => {
    const calls: PipelineCall[] = [];
    const conflict = {
      kind: 'merge' as const,
      side: 'main' as const,
      files: ['src/a.ts', 'src/b.ts'],
      suggestions: ['人工解决 src/a.ts 后再次 apply'],
      worktreePath: `${FAKE_REPO}/.agents/worktrees/task/feat`,
      resumeCommand: ['git', '-C', FAKE_REPO, 'status'],
    };
    const tool = buildHarvestTool(
      makeCtx([makeTask({ branch: 'task/feat' })]),
      {
        createPipeline: () =>
          fakePipeline(
            makeResult({
              mode: 'apply',
              result: 'conflict',
              conflict,
              actions: ['合并 --no-ff task/feat'],
              notes: ['冲突现场已保留'],
            }),
            calls,
          ),
      },
    );
    const value = (await tool.execute(
      { taskId: 't-a', mode: 'apply' },
      undefined,
    )) as HarvestValue;
    expect(value.result).toBe('conflict');
    expect(value.conflict?.files).toEqual(['src/a.ts', 'src/b.ts']);
    const rendered = tool.output.render(
      { taskId: 't-a', mode: 'apply' },
      value,
    );
    expect(rendered[0]!.type).toBe('text');
    expect(rendered[0]!.text).toContain('src/a.ts');
    expect(rendered[0]!.text).toContain('src/b.ts');
    expect(rendered[0]!.text).toContain('冲突');
    expect(rendered[0]!.text).toContain('合并 --no-ff task/feat');
    expect(rendered[0]!.text).toContain('冲突现场已保留');
  });

  it('参数预校验拒绝缺 taskId 与非法 mode（invalid arguments 形状）', async () => {
    const tool = buildHarvestTool(makeCtx([makeTask()]));
    await expect(
      tool.execute({} as HarvestArgs, undefined),
    ).rejects.toThrowError('Error: invalid arguments:');
    await expect(
      tool.execute(
        { taskId: 't-a', mode: 'destroy' as unknown as HarvestMode },
        undefined,
      ),
    ).rejects.toThrowError('Error: invalid arguments:');
  });
});

describe('dsh-kanban-mode tools：taskboard_harvest 真实 git 端到端', () => {
  it('plan 模式经真实管线给出待收割提交与改动文件（只读，不改 git 状态）', async () => {
    const runner: GitRunner = createGitRunner();
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-kanban-harvest-tool-'));
    try {
      await runner.captureOrThrow(['init', '-b', 'main'], { cwd: dir });
      await runner.captureOrThrow(
        ['config', 'user.email', 'harvest-tool-test@example.com'],
        { cwd: dir },
      );
      await runner.captureOrThrow(
        ['config', 'user.name', 'harvest-tool-test'],
        {
          cwd: dir,
        },
      );
      await runner.captureOrThrow(['config', 'commit.gpgsign', 'false'], {
        cwd: dir,
      });
      await writeFile(path.join(dir, 'a.txt'), 'base\n', 'utf8');
      await runner.captureOrThrow(['add', '-A'], { cwd: dir });
      await runner.captureOrThrow(['commit', '-m', 'chore: 基线'], {
        cwd: dir,
      });
      await runner.captureOrThrow(['checkout', '-b', 'task/feat'], {
        cwd: dir,
      });
      await writeFile(path.join(dir, 'b.txt'), 'feat\n', 'utf8');
      await runner.captureOrThrow(['add', '-A'], { cwd: dir });
      await runner.captureOrThrow(['commit', '-m', 'feat: 新增 b.txt'], {
        cwd: dir,
      });
      await runner.captureOrThrow(['checkout', 'main'], { cwd: dir });

      const board = fakeBoard([
        makeTask({ id: 't-e2e', status: 'done', branch: 'task/feat' }),
      ]);
      const tool = buildHarvestTool({
        get: (name: string) =>
          name === 'dsh-taskboard'
            ? board
            : { get: (id: string) => ({ id, path: dir }) },
      });
      const value = (await tool.execute(
        { taskId: 't-e2e' },
        undefined,
      )) as HarvestValue;
      expect(value.result).toBe('planned');
      expect(value.targetBranch).toBe('main');
      expect(value.commits.map((commit) => commit.subject)).toContain(
        'feat: 新增 b.txt',
      );
      expect(value.changedFiles).toContain('b.txt');
      // plan 是只读的：主区仍在 main，任务分支仍在。
      const branch = await runner.captureOrThrow(['branch', '--list'], {
        cwd: dir,
      });
      expect(branch.stdout).toContain('task/feat');
      expect(branch.stdout).toContain('main');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
