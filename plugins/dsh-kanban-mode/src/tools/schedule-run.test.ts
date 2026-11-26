import { describe, expect, it, vi } from 'vitest';

import {
  BOARD_SERVICE_UNAVAILABLE_MESSAGE,
  type BoardCreateTaskInput,
  type BoardServiceContract,
  type BoardTaskRecord,
} from './board-contract.ts';
import {
  buildSchedulePrompt,
  buildScheduleRunTool,
  buildScheduleRunValue,
  buildScheduleDescription,
  SCHEDULE_PRESET_ID,
  SCHEDULE_RUN_TOOL_DESCRIPTION,
} from './schedule-run.ts';

/** 构造一张目标卡记录。 */
function makeTarget(overrides: Partial<BoardTaskRecord>): BoardTaskRecord {
  return {
    id: 't-target',
    title: '目标卡',
    workspaceId: 'ws-1',
    status: 'todo',
    execution: { mode: 'claim' },
    version: 3,
    ...overrides,
  };
}

/** fake 板服务：createTask 记录输入并生成完整记录供回读。 */
function fakeBoardWithCreate(tasks: BoardTaskRecord[]): {
  board: BoardServiceContract;
  createTask: ReturnType<typeof vi.fn>;
} {
  const all = [...tasks];
  const createTask = vi.fn(async (input: BoardCreateTaskInput) => {
    const execution: BoardTaskRecord['execution'] = {
      mode: input.execution?.mode ?? 'claim',
      ...(typeof input.execution?.cron === 'string'
        ? { cron: input.execution.cron }
        : {}),
      ...(typeof input.execution?.runAt === 'number'
        ? { runAt: input.execution.runAt }
        : {}),
    };
    const created: BoardTaskRecord = {
      id: 't-new',
      title: input.title,
      workspaceId: input.workspaceId,
      status: 'todo',
      execution,
      ...(input.presetId !== undefined ? { presetId: input.presetId } : {}),
      ...(input.blockedBy !== undefined
        ? { blockedBy: [...input.blockedBy] }
        : {}),
      version: 1,
    };
    all.push(created);
    // 模拟上游 TaskSummary：不携带 execution/presetId/blockedBy 完整形状。
    return {
      id: 't-new',
      title: input.title,
      workspaceId: input.workspaceId,
      status: 'todo',
      blocked: false,
      version: 1,
    };
  });
  const board: BoardServiceContract = {
    snapshot: () => ({ tasks: all }),
    getTask: (id) => all.find((task) => task.id === id),
    listTasks: () => [],
    dependencies: () => [],
    dependencyBlock: () => undefined,
    createTask: createTask as unknown as BoardServiceContract['createTask'],
  };
  return { board, createTask };
}

const CRON_ARGS = { targetTaskId: 't-target', cron: '30 3 * * *' } as const;

describe('dsh-kanban-mode tools：kanban_schedule_run 生成卡契约', () => {
  it('写路径只走 boardService.createTask，且 presetId 写死 kanban-mode', async () => {
    const { board, createTask } = fakeBoardWithCreate([makeTarget({})]);
    const value = await buildScheduleRunValue(board, { ...CRON_ARGS });
    expect(createTask).toHaveBeenCalledTimes(1);
    const input = createTask.mock.calls[0]![0] as BoardCreateTaskInput;
    expect(input.presetId).toBe('kanban-mode');
    expect(input.presetId).toBe(SCHEDULE_PRESET_ID);
    expect(value.presetId).toBe('kanban-mode');
  });

  it('blockedBy 锁定目标卡、status=todo、urgency=normal、checklist 留空', async () => {
    const { board, createTask } = fakeBoardWithCreate([makeTarget({})]);
    await buildScheduleRunValue(board, { ...CRON_ARGS });
    const input = createTask.mock.calls[0]![0] as BoardCreateTaskInput;
    expect(input.blockedBy).toEqual(['t-target']);
    expect(input.status).toBe('todo');
    expect(input.urgency).toBe('normal');
    expect(input.checklist).toBeUndefined();
  });

  it('cron 路径产出 execution={mode:scheduled, cron}', async () => {
    const { board, createTask } = fakeBoardWithCreate([makeTarget({})]);
    const value = await buildScheduleRunValue(board, { ...CRON_ARGS });
    const input = createTask.mock.calls[0]![0] as BoardCreateTaskInput;
    expect(input.execution).toEqual({ mode: 'scheduled', cron: '30 3 * * *' });
    expect(value.execution).toEqual({ mode: 'scheduled', cron: '30 3 * * *' });
  });

  it('runAt 路径产出 execution={mode:scheduled, runAt}（epoch ms 与 ISO 均透传）', async () => {
    const { board, createTask } = fakeBoardWithCreate([makeTarget({})]);
    await buildScheduleRunValue(board, {
      targetTaskId: 't-target',
      runAt: 1_700_000_000_000,
    });
    expect(
      (createTask.mock.calls[0]![0] as BoardCreateTaskInput).execution,
    ).toEqual({ mode: 'scheduled', runAt: 1_700_000_000_000 });
    await buildScheduleRunValue(board, {
      targetTaskId: 't-target',
      runAt: '2030-01-01T09:00:00+08:00',
    });
    expect(
      (createTask.mock.calls[1]![0] as BoardCreateTaskInput).execution,
    ).toEqual({ mode: 'scheduled', runAt: '2030-01-01T09:00:00+08:00' });
  });

  it('prompt 内置纪律：前置未满足则立即停止 + 不得自行移到 done', async () => {
    const { board, createTask } = fakeBoardWithCreate([makeTarget({})]);
    await buildScheduleRunValue(board, { ...CRON_ARGS });
    const input = createTask.mock.calls[0]![0] as BoardCreateTaskInput;
    const prompt = input.prompt ?? '';
    expect(prompt).toContain('前置未满足');
    expect(prompt).toContain('立即停止');
    expect(prompt).toContain('taskboard_comment_add');
    expect(prompt).toContain('不得强行执行');
    expect(prompt).toContain('不得自行移到 done');
    expect(prompt).toContain('kanban_ready_cards');
    expect(prompt).toContain('taskboard_execution_report');
    expect(prompt).toContain('in_review');
    expect(prompt).toContain('t-target');
    expect(prompt.length).toBeLessThanOrEqual(8000);
    expect(buildSchedulePrompt('t-x')).toContain('taskboard_get');
  });

  it('description 写明定时执行卡职责、无人值守用途与已知限制', async () => {
    const { board, createTask } = fakeBoardWithCreate([makeTarget({})]);
    await buildScheduleRunValue(board, { ...CRON_ARGS });
    const description =
      (createTask.mock.calls[0]![0] as BoardCreateTaskInput).description ?? '';
    expect(description).toContain('看板模式定时执行卡');
    expect(description).toContain('t-target');
    expect(description).toContain('无人值守');
    expect(description).toContain('不补跑');
    expect(description).toContain('建议优先使用周期 cron');
  });

  it('工具描述与生成卡描述声明依赖总开关前提（0.10.1 两态口径）', async () => {
    // 工具描述：blockedBy 锁定只在总开关开启时生效，关闭期间静默不生效。
    expect(SCHEDULE_RUN_TOOL_DESCRIPTION).toContain('依赖总开关');
    expect(SCHEDULE_RUN_TOOL_DESCRIPTION).toContain('静默不生效');
    expect(SCHEDULE_RUN_TOOL_DESCRIPTION).toContain('0.10.1');
    // 生成卡 description：如实声明「关闭期间锁定不生效，prompt 纪律兜底」。
    const description = buildScheduleDescription('t-target');
    expect(description).toContain('依赖总开关');
    expect(description).toContain('唯一兜底');
    const { board, createTask } = fakeBoardWithCreate([makeTarget({})]);
    await buildScheduleRunValue(board, { ...CRON_ARGS });
    expect(
      (createTask.mock.calls[0]![0] as BoardCreateTaskInput).description,
    ).toContain('依赖总开关');
  });

  it('title 缺省为「定时执行：<目标卡 title>」，显式 title 优先生效', async () => {
    const { board, createTask } = fakeBoardWithCreate([makeTarget({})]);
    const value = await buildScheduleRunValue(board, { ...CRON_ARGS });
    expect((createTask.mock.calls[0]![0] as BoardCreateTaskInput).title).toBe(
      '定时执行：目标卡',
    );
    expect(value.title).toBe('定时执行：目标卡');
    await buildScheduleRunValue(board, { ...CRON_ARGS, title: '自定义标题' });
    expect((createTask.mock.calls[1]![0] as BoardCreateTaskInput).title).toBe(
      '自定义标题',
    );
  });

  it('note 附加说明写进 description', async () => {
    const description = buildScheduleDescription('t-target', '只在凌晨跑');
    expect(description).toContain('附加说明：只在凌晨跑');
    const { board, createTask } = fakeBoardWithCreate([makeTarget({})]);
    await buildScheduleRunValue(board, { ...CRON_ARGS, note: '只在凌晨跑' });
    expect(
      (createTask.mock.calls[0]![0] as BoardCreateTaskInput).description,
    ).toContain('只在凌晨跑');
  });

  it('workspaceId 缺省取目标卡所属项目', async () => {
    const { board, createTask } = fakeBoardWithCreate([
      makeTarget({ workspaceId: 'ws-project' }),
    ]);
    await buildScheduleRunValue(board, { ...CRON_ARGS });
    expect(
      (createTask.mock.calls[0]![0] as BoardCreateTaskInput).workspaceId,
    ).toBe('ws-project');
  });
});

describe('dsh-kanban-mode tools：kanban_schedule_run 校验', () => {
  it('cron 与 runAt 都提供时拒绝（invalid_input）', async () => {
    const { board } = fakeBoardWithCreate([makeTarget({})]);
    await expect(
      buildScheduleRunValue(board, {
        targetTaskId: 't-target',
        cron: '0 9 * * *',
        runAt: 1_700_000_000_000,
      }),
    ).rejects.toThrowError('Error: invalid_input: cron 与 runAt 恰好提供一个');
  });

  it('cron 与 runAt 都缺失时拒绝（invalid_input）', async () => {
    const { board } = fakeBoardWithCreate([makeTarget({})]);
    await expect(
      buildScheduleRunValue(board, { targetTaskId: 't-target' }),
    ).rejects.toThrowError('Error: invalid_input: cron 与 runAt 恰好提供一个');
  });

  it('目标卡缺失时报 not_found 并回显 id', async () => {
    const { board } = fakeBoardWithCreate([]);
    await expect(
      buildScheduleRunValue(board, {
        targetTaskId: 't-ghost',
        cron: '0 9 * * *',
      }),
    ).rejects.toThrowError('Error: not_found: 目标卡不存在：t-ghost');
  });

  it('workspaceId 与目标卡项目不一致时拒绝（workspace_mismatch）', async () => {
    const { board } = fakeBoardWithCreate([
      makeTarget({ workspaceId: 'ws-1' }),
    ]);
    await expect(
      buildScheduleRunValue(board, {
        ...CRON_ARGS,
        workspaceId: 'ws-other',
      }),
    ).rejects.toThrowError('Error: workspace_mismatch:');
    await expect(
      buildScheduleRunValue(board, {
        ...CRON_ARGS,
        workspaceId: 'ws-other',
      }),
    ).rejects.toThrowError('blockedBy 前置必须同项目');
  });

  it('板服务缺失时抛可操作错误（稳定码 + 安装指引）', async () => {
    const tool = buildScheduleRunTool({ get: () => undefined });
    await expect(
      tool.execute({ ...CRON_ARGS }, undefined),
    ).rejects.toThrowError(
      `Error: board_service_unavailable: ${BOARD_SERVICE_UNAVAILABLE_MESSAGE}`,
    );
  });
});

describe('dsh-kanban-mode tools：kanban_schedule_run 工具面', () => {
  it('execute 返回生成卡的 {id,title,status,execution,presetId,blockedBy}', async () => {
    const { board } = fakeBoardWithCreate([makeTarget({})]);
    const tool = buildScheduleRunTool({ get: () => board });
    const value = await tool.execute({ ...CRON_ARGS }, undefined);
    expect(value).toMatchObject({
      id: 't-new',
      title: '定时执行：目标卡',
      status: 'todo',
      presetId: 'kanban-mode',
      blockedBy: ['t-target'],
    });
    expect((value as { execution: { cron?: string } }).execution.cron).toBe(
      '30 3 * * *',
    );
  });

  it('工具定义形状对齐 vendored sdk 契约并标注写操作', () => {
    const tool = buildScheduleRunTool({});
    expect(tool.name).toBe('kanban_schedule_run');
    expect(tool.description).toContain('写操作');
    const parameters = tool.parameters as {
      required?: string[];
      properties: Record<string, unknown>;
    };
    expect(parameters.required).toEqual(['targetTaskId']);
    expect(Object.keys(parameters.properties)).toEqual([
      'targetTaskId',
      'cron',
      'runAt',
      'title',
      'note',
      'workspaceId',
    ]);
    expect(tool.output.schema).toEqual({});
  });

  it('参数预校验拒绝缺失的 targetTaskId', async () => {
    const tool = buildScheduleRunTool({ get: () => undefined });
    await expect(
      tool.execute({ cron: '0 9 * * *' } as never, undefined),
    ).rejects.toThrowError('Error: invalid arguments:');
  });

  it('render 输出生成卡关键事实', async () => {
    const { board } = fakeBoardWithCreate([makeTarget({})]);
    const tool = buildScheduleRunTool({ get: () => board });
    const value = await tool.execute({ ...CRON_ARGS }, undefined);
    const rendered = tool.output.render({ ...CRON_ARGS }, value as never);
    expect(rendered[0]!.text).toContain('t-new');
    expect(rendered[0]!.text).toContain('kanban-mode');
    expect(rendered[0]!.text).toContain('cron=30 3 * * *');
  });
});
