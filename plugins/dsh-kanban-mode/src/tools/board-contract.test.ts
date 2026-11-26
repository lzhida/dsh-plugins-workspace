import { describe, expect, it } from 'vitest';

import {
  BOARD_SERVICE_UNAVAILABLE_MESSAGE,
  judgeDependencies,
  requireBoardService,
  resolveBoardService,
  TOOL_ERR,
  type BoardTaskRecord,
} from './board-contract.ts';

/** 构造一张最小板任务记录（只填本卡读取的字段）。 */
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

describe('dsh-kanban-mode tools 契约：依赖判定口径', () => {
  it('前置同项目、未删除且 in_review 时判定满足', () => {
    const tasks = [
      makeTask({ id: 't-pre', status: 'in_review' }),
      makeTask({ id: 't-a', blockedBy: ['t-pre'] }),
    ];
    const result = judgeDependencies(tasks, tasks[1]!);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 't-pre',
      title: '卡A',
      status: 'in_review',
      satisfied: true,
    });
  });

  it('前置 done 与 in_review 同为满足态（done 场景）', () => {
    const tasks = [
      makeTask({ id: 't-pre', status: 'done' }),
      makeTask({ id: 't-a', blockedBy: ['t-pre'] }),
    ];
    expect(judgeDependencies(tasks, tasks[1]!)[0]!.satisfied).toBe(true);
  });

  it('跨项目前置永不满足（同项目是满足的必要条件）', () => {
    const tasks = [
      makeTask({ id: 't-pre', status: 'done', workspaceId: 'ws-2' }),
      makeTask({ id: 't-a', blockedBy: ['t-pre'] }),
    ];
    const view = judgeDependencies(tasks, tasks[1]!)[0]!;
    expect(view.satisfied).toBe(false);
    expect(view.status).toBe('done');
    expect(view.title).toBe('卡A');
  });

  it('前置已软删（trashedAt）时永不满足', () => {
    const tasks = [
      makeTask({ id: 't-pre', status: 'done', trashedAt: 1000 }),
      makeTask({ id: 't-a', blockedBy: ['t-pre'] }),
    ];
    expect(judgeDependencies(tasks, tasks[1]!)[0]!.satisfied).toBe(false);
  });

  it('前置缺失时按 missing 上报且不满足（title 回退为 id）', () => {
    const tasks = [makeTask({ id: 't-a', blockedBy: ['t-ghost'] })];
    const view = judgeDependencies(tasks, tasks[0]!)[0]!;
    expect(view.satisfied).toBe(false);
    expect(view.status).toBe('missing');
    expect(view.title).toBe('t-ghost');
  });

  it('前置为非终态（backlog/todo/in_progress/canceled/archived）时不满足', () => {
    for (const status of [
      'backlog',
      'todo',
      'in_progress',
      'canceled',
      'archived',
    ] as const) {
      const tasks = [
        makeTask({ id: 't-pre', status }),
        makeTask({ id: 't-a', blockedBy: ['t-pre'] }),
      ];
      const view = judgeDependencies(tasks, tasks[1]!)[0]!;
      expect(view.satisfied, `status=${status}`).toBe(false);
    }
  });

  it('无 blockedBy 的卡返回空前置列表', () => {
    const tasks = [makeTask({ id: 't-a' })];
    expect(judgeDependencies(tasks, tasks[0]!)).toEqual([]);
  });

  it('记录面判定不受依赖总开关影响（0.10.1：门禁面停用时台账里的 blockedBy 照判）', () => {
    // 上游 0.10.1 起依赖总开关（dependenciesEnabled）只影响板服务的读面与
    // 门禁面（dependencies() 返回 []、dependencyBlock() 返回 undefined、
    // 建卡/改卡传 blockedBy 被静默丢弃）；judgeDependencies 吃台账原始记录、
    // 不接开关参数——总开关无论开（本仓 vendored 缺省）还是关（用户显式
    // 关闭），对同一份记录的判定结果必须一致。这是「记录面 vs 门禁面」
    // 口径差异的回归锚（门禁面结论以板服务 dependencyBlock 为准）。
    const prereq = makeTask({ id: 't-pre', status: 'todo' });
    const downstream = makeTask({ id: 't-a', blockedBy: ['t-pre'] });
    const withRecords = [prereq, downstream];
    const withoutRecords = [prereq, makeTask({ id: 't-a', blockedBy: [] })];
    const judged = judgeDependencies(withRecords, downstream)[0]!;
    expect(judged.satisfied).toBe(false);
    expect(judged.status).toBe('todo');
    // 判定只认记录：blockedBy 记录为空（如开关关闭期间被丢弃后清理过）就是
    // 空前置列表，函数不引入任何板设置语义。
    expect(judgeDependencies(withoutRecords, withoutRecords[1]!)).toEqual([]);
  });

  it('与上游 shared/dependencies.ts 口径逐维对齐（等价场景矩阵比对预期）', () => {
    // 上游真源 plugins/dsh-taskboard/src/shared/dependencies.ts 的
    // dependencyState 语义：satisfied = 前置存在 ∧ 同项目 ∧ 未软删 ∧
    // status ∈ {in_review, done}。下表每行构造等价场景并比对由该语义
    // 手工推导的预期值（kanban-mode 零跨包 import，故以矩阵断言对齐）。
    const matrix: readonly {
      name: string;
      prerequisite: BoardTaskRecord | undefined;
      expected: { satisfied: boolean; status: string };
    }[] = [
      {
        name: '同项目+in_review+未删',
        prerequisite: makeTask({ id: 't-pre', status: 'in_review' }),
        expected: { satisfied: true, status: 'in_review' },
      },
      {
        name: '同项目+done+未删',
        prerequisite: makeTask({ id: 't-pre', status: 'done' }),
        expected: { satisfied: true, status: 'done' },
      },
      {
        name: '同项目+todo+未删',
        prerequisite: makeTask({ id: 't-pre', status: 'todo' }),
        expected: { satisfied: false, status: 'todo' },
      },
      {
        name: '同项目+done+已删',
        prerequisite: makeTask({ id: 't-pre', status: 'done', trashedAt: 1 }),
        expected: { satisfied: false, status: 'done' },
      },
      {
        name: '跨项目+done+未删',
        prerequisite: makeTask({
          id: 't-pre',
          status: 'done',
          workspaceId: 'ws-other',
        }),
        expected: { satisfied: false, status: 'done' },
      },
      {
        name: '前置不存在',
        prerequisite: undefined,
        expected: { satisfied: false, status: 'missing' },
      },
    ];
    for (const row of matrix) {
      const tasks = row.prerequisite
        ? [row.prerequisite, makeTask({ id: 't-a', blockedBy: ['t-pre'] })]
        : [makeTask({ id: 't-a', blockedBy: ['t-pre'] })];
      const view = judgeDependencies(tasks, tasks[tasks.length - 1]!)[0]!;
      expect(
        { satisfied: view.satisfied, status: view.status },
        row.name,
      ).toEqual(row.expected);
    }
  });
});

describe('dsh-kanban-mode tools 契约：板服务软读取', () => {
  it('resolveBoardService 惰性软读取 ctx.get 返回的服务', () => {
    const service = { snapshot: () => ({ tasks: [] }) };
    const resolved = resolveBoardService({ get: () => service });
    expect(resolved).toBe(service);
  });

  it('服务缺失（undefined / null / 无 get）时返回 undefined 不抛错', () => {
    expect(resolveBoardService({ get: () => undefined })).toBeUndefined();
    expect(resolveBoardService({ get: () => null })).toBeUndefined();
    expect(resolveBoardService({})).toBeUndefined();
  });

  it('requireBoardService 缺失时抛可操作错误（稳定码 + 指引文案）', () => {
    expect(() => requireBoardService({ get: () => undefined })).toThrowError(
      `Error: ${TOOL_ERR.serviceUnavailable}: ${BOARD_SERVICE_UNAVAILABLE_MESSAGE}`,
    );
    try {
      requireBoardService({});
      expect.unreachable('应当抛错');
    } catch (error) {
      expect(String(error)).toContain(
        'dsh-taskboard 服务不可用：请安装并启用 @zhidal/dsh-taskboard 插件后重试',
      );
    }
  });
});
