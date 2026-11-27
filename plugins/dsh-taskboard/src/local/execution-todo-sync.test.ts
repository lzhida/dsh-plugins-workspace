/**
 * 服务层契约测试：会话任务清单 ↔ 卡片验收清单（看板增强系列 3/6）。
 *
 * 覆盖 execution.ts 的两个接缝（用白盒方式播种内部跟踪表，避免为单测拉起完整执行流）：
 * - injectChecklistTodos：首个 pre-step 把卡片验收清单注入为官方 todos（幂等；
 *   plan 模式跳过；空清单跳过；失败不标记、下个 pre-step 重试）。
 * - writeBackCompletedChecklist：宿主监听会话 todo/write 事件，把 completed 且
 *   能匹配上 DoD 条目的项幂等勾选回卡片清单（先精确匹配、再字符 bigram 近似匹配
 *   兜底 agent 改写原文的情形；只推进、绝不取消勾选；无变化不写盘；未跟踪会话不动作）。
 */

import { describe, expect, it } from 'vitest';
import { ExecutionService } from '../host/execution.ts';
import type { TaskStore } from '../host/store.ts';
import { createBoardService } from './board-service.ts';
import { createFakeStore, type FakeStore } from './fake-store.ts';
import { TODO_WRITE_BACK_NOTE, type PreStepAgentFace } from './todo-sync.ts';
import type { TaskRecord } from '../shared/protocol.ts';

const NOW = 1_700_000_000_000;

/** 白盒播种内部跟踪表（sessionId → taskId）。 */
function trackSession(
  service: ExecutionService,
  sessionId: string,
  taskId: string,
): void {
  const internals = service as unknown as {
    checklistSync: Map<string, string>;
  };
  internals.checklistSync.set(sessionId, taskId);
}

/** 断言会话清单未注入（append 记录器为空）。 */
function appendsOf(
  recorder: Array<{ type: string; data: unknown }>,
): Array<{ type: string; data: unknown }> {
  return recorder.filter((entry) => entry.type === 'todo/write');
}

function recorderFace(
  recorder: Array<{ type: string; data: unknown }>,
  sessionId = 'sess-1',
): PreStepAgentFace {
  return {
    id: sessionId,
    session: {
      append: (type, data) => {
        recorder.push({ type, data });
      },
    },
  };
}

interface Harness {
  fake: FakeStore;
  service: ExecutionService;
  sessionEvents: Array<
    (sessionId: string, event: { type: string; data?: unknown }) => void
  >;
  dispose(): void;
}

/** 最小 ExecutionDeps：真实 FakeStore + 事件监听捕获；不拉起任何 agent。 */
function harness(): Harness {
  const fake = createFakeStore();
  const listeners: Array<
    (sessionId: string, event: { type: string; data?: unknown }) => void
  > = [];
  const store = {
    ...fake,
    read: async <T>(
      fn: (ledger: ReturnType<FakeStore['snapshot']>) => T,
    ): Promise<T> => fn(fake.snapshot()),
    location: () => 'fake-ledger.json',
  } as unknown as TaskStore;
  const service = new ExecutionService({
    store,
    agents: {} as never,
    workspaces: { get: () => undefined, attach: async () => undefined },
    events: {
      onSessionEvent: (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    },
    now: () => NOW,
  });
  return {
    fake,
    service,
    sessionEvents: listeners,
    dispose: () => service.dispose(),
  };
}

async function createCard(
  fake: FakeStore,
  input: { taskMode?: 'normal' | 'goal' | 'plan'; checklist?: string[] } = {},
): Promise<TaskRecord> {
  const board = createBoardService({ store: fake, now: () => NOW });
  const created = await board.createTask({
    title: '清单同步验证卡',
    workspaceId: 'ws-1',
    ...(input.taskMode !== undefined ? { taskMode: input.taskMode } : {}),
    ...(input.checklist !== undefined ? { checklist: input.checklist } : {}),
  });
  const task = fake.get(created.id);
  if (task === undefined) throw new Error('created task missing from ledger');
  return task;
}

describe('dsh-taskboard 会话清单与卡片清单同步（3/6）', () => {
  it('注入：首个 pre-step 把卡片验收清单映射为官方 todos（已勾选→completed，其余→pending）', async () => {
    const h = harness();
    try {
      const task = await createCard(h.fake, {
        checklist: ['读卡并核对', '写实现'],
      });
      trackSession(h.service, 'sess-1', task.id);
      const recorder: Array<{ type: string; data: unknown }> = [];
      await h.service.injectChecklistTodos(recorderFace(recorder));
      const writes = appendsOf(recorder);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toEqual({
        type: 'todo/write',
        data: {
          todos: [
            { content: '读卡并核对', status: 'pending' },
            { content: '写实现', status: 'pending' },
          ],
        },
      });
    } finally {
      h.dispose();
    }
  });

  it('注入幂等：同一会话只注入一次', async () => {
    const h = harness();
    try {
      const task = await createCard(h.fake, { checklist: ['读卡并核对'] });
      trackSession(h.service, 'sess-1', task.id);
      const recorder: Array<{ type: string; data: unknown }> = [];
      await h.service.injectChecklistTodos(recorderFace(recorder));
      await h.service.injectChecklistTodos(recorderFace(recorder));
      expect(appendsOf(recorder)).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });

  it('注入跳过：plan 模式不强推会话清单（但标记为已处理，不再重试）', async () => {
    const h = harness();
    try {
      const task = await createCard(h.fake, {
        taskMode: 'plan',
        checklist: ['先出方案'],
      });
      trackSession(h.service, 'sess-2', task.id);
      const recorder: Array<{ type: string; data: unknown }> = [];
      await h.service.injectChecklistTodos(recorderFace(recorder, 'sess-2'));
      expect(appendsOf(recorder)).toHaveLength(0);
      // 已标记跳过：再触发也不注入（不重试）。
      await h.service.injectChecklistTodos(recorderFace(recorder, 'sess-2'));
      expect(appendsOf(recorder)).toHaveLength(0);
    } finally {
      h.dispose();
    }
  });

  it('注入跳过：plan 卡降级为普通执行（官方服务缺席）时也不注入（e2e 矛盾回归）', async () => {
    const h = harness();
    try {
      const task = await createCard(h.fake, {
        taskMode: 'plan',
        checklist: ['先出方案'],
      });
      // 白盒播种一条「已降级」的运行中执行：官方 plan-mode 服务缺席时 2/6 会把
      // execution.taskMode 写成 normal 并附降级注记——但 framing 仍按任务声明的
      // plan 口径告知 agent 不要用 todo_write，宿主若照旧注入就自相矛盾
      // （kanban-e2e 隔离实例实测踩中，故注入判定以任务声明为准）。
      await h.fake.mutate('task-updated', (draft) => {
        const target = draft.tasks.find((t) => t.id === task.id);
        if (target === undefined) return undefined;
        target.executions.push({
          id: 'e-degraded',
          sessionId: 'sess-degraded',
          trigger: 'manual',
          outcome: 'running',
          isolation: 'worktree',
          taskMode: 'normal',
          taskModeNote:
            '官方计划模式服务不可用（未安装或未启用官方 plan-mode 插件），本次以普通模式执行',
        });
        return [target];
      });
      trackSession(h.service, 'sess-degraded', task.id);
      const recorder: Array<{ type: string; data: unknown }> = [];
      await h.service.injectChecklistTodos(
        recorderFace(recorder, 'sess-degraded'),
      );
      expect(appendsOf(recorder)).toHaveLength(0);
    } finally {
      h.dispose();
    }
  });

  it('注入跳过：无清单卡片不注入', async () => {
    const h = harness();
    try {
      const task = await createCard(h.fake);
      trackSession(h.service, 'sess-3', task.id);
      const recorder: Array<{ type: string; data: unknown }> = [];
      await h.service.injectChecklistTodos(recorderFace(recorder, 'sess-3'));
      expect(appendsOf(recorder)).toHaveLength(0);
    } finally {
      h.dispose();
    }
  });

  it('注入跳过：未跟踪会话（非看板执行会话）完全不动作', async () => {
    const h = harness();
    try {
      await createCard(h.fake, { checklist: ['读卡并核对'] });
      const recorder: Array<{ type: string; data: unknown }> = [];
      await h.service.injectChecklistTodos(
        recorderFace(recorder, 'sess-other'),
      );
      expect(appendsOf(recorder)).toHaveLength(0);
    } finally {
      h.dispose();
    }
  });

  it('回写：completed 且文本精确匹配的 DoD 项被勾选并带证据 note、版本 +1', async () => {
    const h = harness();
    try {
      const task = await createCard(h.fake, {
        checklist: ['读卡并核对', '写实现'],
      });
      trackSession(h.service, 'sess-1', task.id);
      expect(h.sessionEvents).toHaveLength(1);
      await h.sessionEvents[0]!('sess-1', {
        type: 'todo/write',
        data: {
          todos: [
            { content: '读卡并核对', status: 'completed' },
            { content: '写实现', status: 'in_progress' },
          ],
        },
      });
      const updated = h.fake.get(task.id);
      expect(updated?.version).toBe((task.version ?? 0) + 1);
      expect(updated?.checklist?.[0]).toMatchObject({
        checked: true,
        checkedBy: 'sess-1',
        note: TODO_WRITE_BACK_NOTE,
      });
      expect(updated?.checklist?.[1]).toMatchObject({ checked: false });
      expect(updated?.updatedAt).toBe(NOW);
    } finally {
      h.dispose();
    }
  });

  it('回写：agent 改写 DoD 原文后写回 todo，近似匹配仍勾选回卡片清单（e2e 缺陷回归）', async () => {
    const h = harness();
    try {
      // e2e 真实缺陷：宿主注入「已确认会话任务清单已注入官方 todo 投影（可在清单中看到 3 项）」，
      // agent 完成后改写成「确认会话任务清单已注入官方 todo 投影（3 项）」再写回——
      // 纯精确匹配漏掉该情形，自动回写零命中（卡片勾选全是 agent 手动补的）。
      const task = await createCard(h.fake, {
        checklist: [
          '已确认会话任务清单已注入官方 todo 投影（可在清单中看到 3 项）',
        ],
      });
      trackSession(h.service, 'sess-1', task.id);
      await h.sessionEvents[0]!('sess-1', {
        type: 'todo/write',
        data: {
          todos: [
            {
              content: '确认会话任务清单已注入官方 todo 投影（3 项）',
              status: 'completed',
            },
          ],
        },
      });
      const updated = h.fake.get(task.id);
      expect(updated?.checklist?.[0]).toMatchObject({
        checked: true,
        checkedBy: 'sess-1',
        note: TODO_WRITE_BACK_NOTE,
      });
      expect(updated?.version).toBe((task.version ?? 0) + 1);
    } finally {
      h.dispose();
    }
  });

  it('回写幂等：同一事件重复到达不产生第二次写盘（版本不再变化）', async () => {
    const h = harness();
    try {
      const task = await createCard(h.fake, { checklist: ['读卡并核对'] });
      trackSession(h.service, 'sess-1', task.id);
      const payload = {
        type: 'todo/write',
        data: { todos: [{ content: '读卡并核对', status: 'completed' }] },
      };
      await h.sessionEvents[0]!('sess-1', payload);
      const once = h.fake.get(task.id);
      await h.sessionEvents[0]!('sess-1', payload);
      const twice = h.fake.get(task.id);
      expect(twice?.version).toBe(once?.version);
    } finally {
      h.dispose();
    }
  });

  it('回写只推进：pending/in_progress 或未匹配文本绝不取消勾选、绝不误勾', async () => {
    const h = harness();
    try {
      const task = await createCard(h.fake, {
        checklist: ['读卡并核对', '写实现'],
      });
      trackSession(h.service, 'sess-1', task.id);
      await h.sessionEvents[0]!('sess-1', {
        type: 'todo/write',
        data: {
          todos: [
            { content: '读卡并核对', status: 'pending' },
            { content: '别的会话自己的工作分解', status: 'completed' },
          ],
        },
      });
      const untouched = h.fake.get(task.id);
      expect(untouched?.version).toBe(task.version);
      expect(untouched?.checklist?.every((i) => !i.checked)).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it('回写忽略：未跟踪会话与形状不符的 todo/write 载荷', async () => {
    const h = harness();
    try {
      const task = await createCard(h.fake, { checklist: ['读卡并核对'] });
      trackSession(h.service, 'sess-1', task.id);
      await h.sessionEvents[0]!('sess-other', {
        type: 'todo/write',
        data: { todos: [{ content: '读卡并核对', status: 'completed' }] },
      });
      await h.sessionEvents[0]!('sess-1', {
        type: 'todo/write',
        data: { todos: 'not-an-array' },
      });
      await h.sessionEvents[0]!('sess-1', { type: 'turn/start', data: {} });
      const untouched = h.fake.get(task.id);
      expect(untouched?.version).toBe(task.version);
      expect(untouched?.checklist?.[0]?.checked).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it('热重载补登记：按执行 id 反查任务后清单同步仍能注入（retrackChecklistSync）', async () => {
    const h = harness();
    try {
      const task = await createCard(h.fake, { checklist: ['读卡并核对'] });
      // 台账里存在一条被别代实例启动、本代接管前未登记的运行记录。
      await h.fake.mutate('task-updated', (draft) => {
        const target = draft.tasks.find((t) => t.id === task.id);
        if (target === undefined) return undefined;
        target.executions.push({
          id: 'e-hot',
          sessionId: 'sess-hot',
          trigger: 'manual',
          outcome: 'running',
          isolation: 'worktree',
        });
        return [target];
      });
      const internals = h.service as unknown as {
        retrackChecklistSync(id: string, sessionId: string): Promise<void>;
        checklistSync: Map<string, string>;
      };
      await internals.retrackChecklistSync('e-hot', 'sess-hot');
      expect(internals.checklistSync.get('sess-hot')).toBe(task.id);
      const recorder: Array<{ type: string; data: unknown }> = [];
      await h.service.injectChecklistTodos(recorderFace(recorder, 'sess-hot'));
      expect(appendsOf(recorder)).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });

  it('结算清理：终态写入后同一会话的回写不再写盘（checklistSync/todoInitialized 已清）', async () => {
    const h = harness();
    try {
      const task = await createCard(h.fake, { checklist: ['读卡并核对'] });
      trackSession(h.service, 'sess-1', task.id);
      const recorder: Array<{ type: string; data: unknown }> = [];
      await h.service.injectChecklistTodos(recorderFace(recorder));
      await h.fake.mutate('task-updated', (draft) => {
        const target = draft.tasks.find((t) => t.id === task.id);
        if (target === undefined) return undefined;
        target.executions.push({
          id: 'e-live',
          sessionId: 'sess-1',
          trigger: 'manual',
          outcome: 'running',
          isolation: 'worktree',
        });
        return [target];
      });
      const internals = h.service as unknown as {
        runs: Map<string, unknown>;
        writeSettlement(
          id: string,
          entry: unknown,
          pending: unknown,
        ): Promise<boolean>;
        checklistSync: Map<string, string>;
        todoInitialized: Set<string>;
      };
      const entry = {
        sessionId: 'sess-1',
        taskId: task.id,
        dispose: async () => undefined,
        stopping: Promise.resolve(),
      };
      internals.runs.set('e-live', entry);
      const settled = await internals.writeSettlement('e-live', entry, {
        outcome: 'succeeded',
        endedAt: NOW,
        attempts: 1,
        evidenceReady: true,
        evidence: {},
      });
      expect(settled).toBe(true);
      expect(internals.checklistSync.has('sess-1')).toBe(false);
      expect(internals.todoInitialized.has('sess-1')).toBe(false);
      const before = h.fake.get(task.id);
      await h.sessionEvents[0]!('sess-1', {
        type: 'todo/write',
        data: {
          todos: [{ content: '读卡并核对', status: 'completed' }],
        },
      });
      const after = h.fake.get(task.id);
      expect(after?.version).toBe(before?.version);
      expect(after?.checklist?.[0]?.checked).toBe(false);
    } finally {
      h.dispose();
    }
  });
});
