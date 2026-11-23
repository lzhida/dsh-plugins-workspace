import { describe, expect, it, vi } from 'vitest';

import {
  BOARD_SERVICE_UNAVAILABLE_MESSAGE,
  type BoardServiceContract,
  type BoardTaskRecord,
} from './board-contract.ts';
import {
  buildReadyCardsTool,
  buildReadyCardsValue,
  CONCURRENCY_NOTE,
  type ReadyCardsValue,
} from './ready-cards.ts';

/** 构造一张最小板任务记录。 */
function makeTask(overrides: Partial<BoardTaskRecord>): BoardTaskRecord {
  return {
    id: 't-a',
    title: '卡A',
    workspaceId: 'ws-1',
    status: 'todo',
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
      throw new Error('ready_cards 是只读工具，不应建卡');
    },
  };
}

describe('dsh-kanban-mode tools：kanban_ready_cards 盘点', () => {
  it('无前置的 todo 卡进入 ready', () => {
    const value = buildReadyCardsValue(fakeBoard([makeTask({})]), {});
    expect(value.ready).toEqual([{ id: 't-a', title: '卡A' }]);
    expect(value.blocked).toEqual([]);
  });

  it('前置 in_review 视为已满足，卡进入 ready', () => {
    const tasks = [
      makeTask({ id: 't-pre', status: 'in_review' }),
      makeTask({ id: 't-a', blockedBy: ['t-pre'] }),
    ];
    const value = buildReadyCardsValue(fakeBoard(tasks), {});
    expect(value.ready.map((card) => card.id)).toContain('t-a');
    expect(value.blocked).toEqual([]);
  });

  it('前置 done 视为已满足，卡进入 ready（done 前置本身不参与盘点）', () => {
    const tasks = [
      makeTask({ id: 't-pre', status: 'done' }),
      makeTask({ id: 't-a', blockedBy: ['t-pre'] }),
    ];
    const value = buildReadyCardsValue(fakeBoard(tasks), {});
    expect(value.ready.map((card) => card.id)).toEqual(['t-a']);
    expect(value.blocked).toEqual([]);
  });

  it('前置未满足的 todo 卡进入 blocked 并附 unmet 前置明细（todo 前置自身 ready）', () => {
    const tasks = [
      makeTask({ id: 't-pre', title: '前置卡', status: 'todo' }),
      makeTask({ id: 't-a', blockedBy: ['t-pre'] }),
    ];
    const value = buildReadyCardsValue(fakeBoard(tasks), {});
    expect(value.ready).toEqual([{ id: 't-pre', title: '前置卡' }]);
    expect(value.blocked).toEqual([
      {
        id: 't-a',
        title: '卡A',
        unmet: [{ id: 't-pre', title: '前置卡', status: 'todo' }],
      },
    ]);
  });

  it('跨项目前置永不满足（即使前置已 done）', () => {
    const tasks = [
      makeTask({ id: 't-pre', status: 'done', workspaceId: 'ws-2' }),
      makeTask({ id: 't-a', blockedBy: ['t-pre'] }),
    ];
    const value = buildReadyCardsValue(fakeBoard(tasks), {});
    expect(value.ready).toEqual([]);
    expect(value.blocked[0]!.unmet[0]).toEqual({
      id: 't-pre',
      title: '卡A',
      status: 'done',
    });
  });

  it('waitingForHuman 的卡被排除，其未满足前置挡住下游卡进 blocked', () => {
    const tasks = [
      makeTask({ id: 't-wait', waitingForHuman: true }),
      makeTask({ id: 't-a', blockedBy: ['t-wait'] }),
    ];
    const value = buildReadyCardsValue(fakeBoard(tasks), {});
    // t-wait：waiting 卡本身既不进 ready 也不进 blocked。
    // t-a：前置（todo + waiting）按上游口径未满足，下游卡照常进 blocked。
    expect(value.ready).toEqual([]);
    expect(value.blocked).toEqual([
      {
        id: 't-a',
        title: '卡A',
        unmet: [{ id: 't-wait', title: '卡A', status: 'todo' }],
      },
    ]);
    expect(value.excludedCount).toBe(1);
  });

  it('已被认领（claimedBy）的卡被排除', () => {
    const tasks = [makeTask({ id: 't-a', claimedBy: 'agent-1' })];
    const value = buildReadyCardsValue(fakeBoard(tasks), {});
    expect(value.ready).toEqual([]);
    expect(value.excludedCount).toBe(1);
  });

  it('已删除与非 todo 状态的卡不参与盘点', () => {
    const tasks = [
      makeTask({ id: 't-del', trashedAt: 1 }),
      makeTask({ id: 't-run', status: 'in_progress' }),
      makeTask({ id: 't-done', status: 'done' }),
    ];
    const value = buildReadyCardsValue(fakeBoard(tasks), {});
    expect(value.ready).toEqual([]);
    expect(value.blocked).toEqual([]);
    expect(value.todoCount).toBe(0);
  });

  it('workspaceId 过滤只盘点单一项目', () => {
    const tasks = [
      makeTask({ id: 't-1', workspaceId: 'ws-1' }),
      makeTask({ id: 't-2', workspaceId: 'ws-2' }),
    ];
    const scoped = buildReadyCardsValue(fakeBoard(tasks), {
      workspaceId: 'ws-1',
    });
    expect(scoped.workspaceId).toBe('ws-1');
    expect(scoped.ready.map((card) => card.id)).toEqual(['t-1']);
  });

  it('concurrencyNote 为固定口径（maxConcurrent 默认 3 + 每分钟 tick）', () => {
    const value = buildReadyCardsValue(fakeBoard([]), {});
    expect(value.concurrencyNote).toBe(CONCURRENCY_NOTE);
    expect(value.concurrencyNote).toContain('maxConcurrent 默认 3');
    expect(value.concurrencyNote).toContain('每分钟 tick');
  });
});

describe('dsh-kanban-mode tools：kanban_ready_cards 并行波次', () => {
  it('三卡链式依赖分出三个波次（第 1 波=当前 ready）', () => {
    const tasks = [
      makeTask({ id: 't-a' }),
      makeTask({ id: 't-b', blockedBy: ['t-a'] }),
      makeTask({ id: 't-c', blockedBy: ['t-b'] }),
    ];
    const value = buildReadyCardsValue(fakeBoard(tasks), {});
    expect(value.parallelBatches).toEqual([
      { wave: 1, taskIds: ['t-a'] },
      { wave: 2, taskIds: ['t-b'] },
      { wave: 3, taskIds: ['t-c'] },
    ]);
  });

  it('同层前置已满足的卡并入同一（第 1）波次', () => {
    const tasks = [
      makeTask({ id: 't-pre', status: 'in_review' }),
      makeTask({ id: 't-b1', blockedBy: ['t-pre'] }),
      makeTask({ id: 't-b2', blockedBy: ['t-pre'] }),
    ];
    const value = buildReadyCardsValue(fakeBoard(tasks), {});
    // in_review 前置视为已满足，且已终态的 t-pre 本身不参与盘点/波次。
    expect(value.parallelBatches).toEqual([
      { wave: 1, taskIds: ['t-b1', 't-b2'] },
    ]);
  });

  it('被死锁前置（跨项目 done）卡住的卡不进任何波次', () => {
    const tasks = [
      makeTask({ id: 't-pre', status: 'done', workspaceId: 'ws-2' }),
      makeTask({ id: 't-a', blockedBy: ['t-pre'] }),
      makeTask({ id: 't-free' }),
    ];
    const value = buildReadyCardsValue(fakeBoard(tasks), {});
    expect(value.parallelBatches).toEqual([{ wave: 1, taskIds: ['t-free'] }]);
    expect(value.blocked.map((card) => card.id)).toEqual(['t-a']);
  });

  it('前置缺失（missing）的卡不进波次但出现在 blocked', () => {
    const tasks = [makeTask({ id: 't-a', blockedBy: ['t-ghost'] })];
    const value = buildReadyCardsValue(fakeBoard(tasks), {});
    expect(value.parallelBatches).toEqual([]);
    expect(value.blocked[0]!.unmet[0]!.status).toBe('missing');
  });
});

describe('dsh-kanban-mode tools：kanban_ready_cards 工具面', () => {
  it('execute 经软读取板服务返回结构化盘点', async () => {
    const tasks = [makeTask({})];
    const tool = buildReadyCardsTool({
      get: () => fakeBoard(tasks),
    });
    const value = (await tool.execute({}, undefined)) as ReadyCardsValue;
    expect(value.ready.map((card) => card.id)).toEqual(['t-a']);
  });

  it('板服务缺失时抛可操作错误（稳定码 + 安装指引）', async () => {
    const tool = buildReadyCardsTool({ get: () => undefined });
    await expect(tool.execute({}, undefined)).rejects.toThrowError(
      `Error: board_service_unavailable: ${BOARD_SERVICE_UNAVAILABLE_MESSAGE}`,
    );
  });

  it('工具定义形状对齐 vendored sdk 契约且只读描述', () => {
    const tool = buildReadyCardsTool({});
    expect(tool.name).toBe('kanban_ready_cards');
    expect(tool.description).toContain('只读');
    expect(tool.parameters).toMatchObject({ type: 'object' });
    expect(tool.output.schema).toEqual({});
    const rendered = tool.output.render(
      {},
      buildReadyCardsValue(fakeBoard([makeTask({})]), {}),
    );
    expect(rendered[0]!.type).toBe('text');
    expect(rendered[0]!.text).toContain('t-a');
    expect(rendered[0]!.text).toContain('卡A');
  });

  it('参数预校验拒绝非字符串 workspaceId（invalid arguments 形状）', async () => {
    const tool = buildReadyCardsTool({ get: () => fakeBoard([]) });
    await expect(
      tool.execute({ workspaceId: 42 as unknown as string }, undefined),
    ).rejects.toThrowError('Error: invalid arguments:');
  });

  it('只读工具的 fake 服务上 createTask 不被调用', async () => {
    const board = fakeBoard([makeTask({})]);
    const spy = vi.spyOn(board, 'createTask');
    const tool = buildReadyCardsTool({ get: () => board });
    await tool.execute({}, undefined);
    expect(spy).not.toHaveBeenCalled();
  });
});
