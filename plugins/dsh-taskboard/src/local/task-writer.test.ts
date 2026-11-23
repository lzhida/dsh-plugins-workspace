/**
 * 建卡 / 改卡写手的契约测试。
 *
 * 覆盖：参数归一化的默认值与非法值报错、前置任务四类报错的**逐字原文**、
 * ifVersion 乐观锁冲突，以及建卡（新增）/ 改卡（替换）两种 blockedBy 语义。
 */

import { describe, expect, it } from 'vitest';
import { createFakeStore } from './fake-store.ts';
import { createTask, updateTask, type TaskWriterDeps } from './task-writer.ts';
import type { Actor } from '../shared/protocol.ts';

/** 固定时钟，保证断言可复现。 */
const NOW = 1_700_000_000_000;

/** 记录者。 */
const actor: Actor = { kind: 'agent', sessionId: 'sess-1' };

/** 构造写手依赖（台账 + 固定时钟 + 看板设置）。 */
function writerFor(store: ReturnType<typeof createFakeStore>): TaskWriterDeps {
  return {
    store,
    now: () => NOW,
    settings: () => store.snapshot().settings,
  };
}

describe('dsh-taskboard 写手（建卡 / 改卡）', () => {
  describe('建卡参数归一化', () => {
    it('缺省参数落到归一化后的默认值：状态 todo、执行方式 claim、隔离强制 worktree、权限 workspace-write', async () => {
      const store = createFakeStore();
      const summary = await createTask(
        { title: '  摸鱼摸鱼  ', workspaceId: 'ws-1', urgency: 'normal' },
        actor,
        writerFor(store),
      );
      const task = store.get(summary.id);

      expect(summary.status).toBe('todo');
      expect(summary.urgency).toBe('normal');
      expect(summary.version).toBe(1);
      expect(summary.executionMode).toBe('claim');
      expect(task?.title).toBe('摸鱼摸鱼');
      expect(task?.description).toBe('');
      expect(task?.isolation).toBe('worktree');
      expect(task?.permission).toBe('workspace-write');
      expect(task?.presetId).toBeUndefined();
      expect(task?.checklist).toBeUndefined();
      expect(task?.blocked).toBe(false);
      expect(task?.createdBy).toEqual(actor);
      expect(task?.updatedAt).toBe(NOW);
    });

    it('按看板设置固化默认权限与预设 id（隔离不随之变化：一律强制 worktree）', async () => {
      const store = createFakeStore({
        settings: {
          defaultIsolation: 'none',
          defaultPermission: 'danger-full-access',
          defaultPresetId: 'preset-a',
        },
      });
      const summary = await createTask(
        { title: '继承看板默认', workspaceId: 'ws-1', urgency: 'relaxed' },
        actor,
        writerFor(store),
      );
      const task = store.get(summary.id);

      expect(task?.isolation).toBe('worktree');
      expect(summary.isolationForced).toBe(true);
      expect(task?.permission).toBe('danger-full-access');
      expect(task?.presetId).toBe('preset-a');
    });

    it('显式参数覆盖看板默认值（隔离除外：强制 worktree 并注明）', async () => {
      const store = createFakeStore({
        settings: {
          defaultIsolation: 'worktree',
          defaultPermission: 'read-only',
          defaultPresetId: 'preset-a',
        },
      });
      const summary = await createTask(
        {
          title: '显式覆盖',
          workspaceId: 'ws-1',
          urgency: 'urgent',
          isolation: 'none',
          permission: 'workspace-write',
          presetId: '  ',
        },
        actor,
        writerFor(store),
      );
      const task = store.get(summary.id);

      expect(task?.isolation).toBe('worktree');
      expect(summary.isolationForced).toBe(true);
      expect(summary.isolationNote).toContain('已强制 worktree');
      expect(task?.permission).toBe('workspace-write');
      expect(task?.presetId).toBeUndefined();
    });

    it('校验清单去掉空行并逐条生成条目', async () => {
      const store = createFakeStore();
      const summary = await createTask(
        {
          title: '带清单',
          workspaceId: 'ws-1',
          urgency: 'normal',
          checklist: ['  第一条  ', '', '   ', '第二条'],
        },
        actor,
        writerFor(store),
      );
      const task = store.get(summary.id);

      expect(task?.checklist?.length).toBe(2);
      expect(task?.checklist?.map((item) => item.text)).toEqual([
        '第一条',
        '第二条',
      ]);
      expect(task?.checklist?.every((item) => item.checked === false)).toBe(
        true,
      );
    });

    it('拒绝空标题', async () => {
      const store = createFakeStore();
      await expect(
        createTask(
          { title: '   ', workspaceId: 'ws-1', urgency: 'normal' },
          actor,
          writerFor(store),
        ),
      ).rejects.toThrow('title must be 1..200 characters');
    });

    it('拒绝非法紧急度', async () => {
      const store = createFakeStore();
      await expect(
        createTask(
          { title: '卡', workspaceId: 'ws-1', urgency: 'high' },
          actor,
          writerFor(store),
        ),
      ).rejects.toThrow('urgency must be one of: urgent, normal, relaxed');
    });

    it('拒绝非法状态', async () => {
      const store = createFakeStore();
      await expect(
        createTask(
          {
            title: '卡',
            workspaceId: 'ws-1',
            urgency: 'normal',
            status: 'xyz',
          },
          actor,
          writerFor(store),
        ),
      ).rejects.toThrow(
        'status must be one of: backlog, todo, in_progress, in_review, done, canceled, archived',
      );
    });

    it('拒绝以非 backlog / todo 状态建卡', async () => {
      const store = createFakeStore();
      await expect(
        createTask(
          {
            title: '卡',
            workspaceId: 'ws-1',
            urgency: 'normal',
            status: 'done',
          },
          actor,
          writerFor(store),
        ),
      ).rejects.toThrow(
        'a new task must start as backlog or todo (in_progress requires claiming the task)',
      );
    });

    it('拒绝非法隔离方式', async () => {
      const store = createFakeStore();
      await expect(
        createTask(
          {
            title: '卡',
            workspaceId: 'ws-1',
            urgency: 'normal',
            isolation: 'container',
          },
          actor,
          writerFor(store),
        ),
      ).rejects.toThrow("isolation must be 'worktree' or 'none'");
    });

    it('拒绝非法权限', async () => {
      const store = createFakeStore();
      await expect(
        createTask(
          {
            title: '卡',
            workspaceId: 'ws-1',
            urgency: 'normal',
            permission: 'sudo',
          },
          actor,
          writerFor(store),
        ),
      ).rejects.toThrow(
        "permission must be 'workspace-write', 'read-only', or 'danger-full-access'",
      );
    });

    it('拒绝非法执行方式', async () => {
      const store = createFakeStore();
      await expect(
        createTask(
          {
            title: '卡',
            workspaceId: 'ws-1',
            urgency: 'normal',
            execution: { mode: 'cron' },
          },
          actor,
          writerFor(store),
        ),
      ).rejects.toThrow("execution.mode must be 'claim' or 'scheduled'");
    });

    it('解析不到工作区时报 not_found（详情由调用方注入）', async () => {
      const store = createFakeStore();
      const deps = writerFor(store);
      await expect(
        createTask(
          { title: '卡', workspaceId: 'ghost', urgency: 'normal' },
          actor,
          {
            ...deps,
            resolveWorkspace: async () => undefined,
            unknownWorkspaceDetail: async (raw) =>
              `unknown workspaceId "${raw}" (expected a project id or its directory path)`,
          },
        ),
      ).rejects.toThrow(
        'unknown workspaceId "ghost" (expected a project id or its directory path)',
      );
    });
  });

  describe('前置任务校验（报错原文逐字）', () => {
    it('拒绝自引用', async () => {
      const store = createFakeStore();
      const created = await createTask(
        { title: '本体', workspaceId: 'ws-1', urgency: 'normal' },
        actor,
        writerFor(store),
      );
      await expect(
        updateTask(
          {
            id: created.id,
            ifVersion: created.version,
            blockedBy: [created.id],
          },
          actor,
          writerFor(store),
        ),
      ).rejects.toThrow('dependency cannot reference itself');
    });

    it('拒绝不存在的前置任务', async () => {
      const store = createFakeStore();
      await expect(
        createTask(
          {
            title: '卡',
            workspaceId: 'ws-1',
            urgency: 'normal',
            blockedBy: ['t-missing'],
          },
          actor,
          writerFor(store),
        ),
      ).rejects.toThrow('dependency not found: t-missing');
    });

    it('拒绝跨项目的前置任务', async () => {
      const store = createFakeStore();
      const prior = await createTask(
        { title: '别的项目', workspaceId: 'ws-other', urgency: 'normal' },
        actor,
        writerFor(store),
      );
      await expect(
        createTask(
          {
            title: '卡',
            workspaceId: 'ws-1',
            urgency: 'normal',
            blockedBy: [prior.id],
          },
          actor,
          writerFor(store),
        ),
      ).rejects.toThrow(
        `dependency must belong to the same project: ${prior.id}`,
      );
    });

    it('拒绝循环前置任务', async () => {
      const store = createFakeStore();
      const first = await createTask(
        { title: '甲', workspaceId: 'ws-1', urgency: 'normal' },
        actor,
        writerFor(store),
      );
      const second = await createTask(
        {
          title: '乙',
          workspaceId: 'ws-1',
          urgency: 'normal',
          blockedBy: [first.id],
        },
        actor,
        writerFor(store),
      );
      await expect(
        updateTask(
          {
            id: first.id,
            ifVersion: first.version,
            blockedBy: [second.id],
          },
          actor,
          writerFor(store),
        ),
      ).rejects.toThrow(`dependency cycle involving ${second.id}`);
    });

    it('建卡时 blockedBy 是新增语义：挂上前置并落盘', async () => {
      const store = createFakeStore();
      const prior = await createTask(
        { title: '前置', workspaceId: 'ws-1', urgency: 'normal' },
        actor,
        writerFor(store),
      );
      const created = await createTask(
        {
          title: '后继',
          workspaceId: 'ws-1',
          urgency: 'normal',
          blockedBy: [prior.id],
        },
        actor,
        writerFor(store),
      );
      expect(store.get(created.id)?.blockedBy).toEqual([prior.id]);
    });
  });

  describe('改卡', () => {
    it('缺少 ifVersion 时报版本冲突', async () => {
      const store = createFakeStore();
      const created = await createTask(
        { title: '卡', workspaceId: 'ws-1', urgency: 'normal' },
        actor,
        writerFor(store),
      );
      await expect(
        updateTask({ id: created.id, title: '改名' }, actor, writerFor(store)),
      ).rejects.toThrow('this write requires ifVersion; read the task first');
    });

    it('ifVersion 与当前版本不符时报版本冲突', async () => {
      const store = createFakeStore();
      const created = await createTask(
        { title: '卡', workspaceId: 'ws-1', urgency: 'normal' },
        actor,
        writerFor(store),
      );
      await expect(
        updateTask(
          { id: created.id, ifVersion: 99, title: '改名' },
          actor,
          writerFor(store),
        ),
      ).rejects.toThrow(
        'stale version 99 (current 1); re-read the task and retry once',
      );
    });

    it('改卡成功后版本递增且字段被逐项 patch', async () => {
      const store = createFakeStore();
      const created = await createTask(
        { title: '卡', workspaceId: 'ws-1', urgency: 'normal' },
        actor,
        writerFor(store),
      );
      const updated = await updateTask(
        {
          id: created.id,
          ifVersion: created.version,
          title: '  新标题  ',
          description: '  说明  ',
          urgency: 'urgent',
          blocked: true,
          permission: 'read-only',
          waitingForHuman: true,
          waitingReason: ' 等人工确认 ',
        },
        actor,
        writerFor(store),
      );
      const task = store.get(created.id);

      expect(updated.version).toBe(2);
      expect(task?.title).toBe('新标题');
      expect(task?.description).toBe('说明');
      expect(task?.urgency).toBe('urgent');
      expect(task?.blocked).toBe(true);
      expect(task?.permission).toBe('read-only');
      expect(task?.waitingForHuman).toBe(true);
      expect(task?.waitingReason).toBe('等人工确认');
      expect(task?.updatedBy).toEqual(actor);
    });

    it('改卡时 blockedBy 是替换语义：整体替换已有前置', async () => {
      const store = createFakeStore();
      const first = await createTask(
        { title: '前置一', workspaceId: 'ws-1', urgency: 'normal' },
        actor,
        writerFor(store),
      );
      const second = await createTask(
        { title: '前置二', workspaceId: 'ws-1', urgency: 'normal' },
        actor,
        writerFor(store),
      );
      const target = await createTask(
        {
          title: '目标',
          workspaceId: 'ws-1',
          urgency: 'normal',
          blockedBy: [first.id],
        },
        actor,
        writerFor(store),
      );

      await updateTask(
        { id: target.id, ifVersion: target.version, blockedBy: [second.id] },
        actor,
        writerFor(store),
      );
      expect(store.get(target.id)?.blockedBy).toEqual([second.id]);
    });

    it('已归档任务不可改', async () => {
      const store = createFakeStore();
      const created = await createTask(
        { title: '卡', workspaceId: 'ws-1', urgency: 'normal' },
        actor,
        writerFor(store),
      );
      await store.mutate('task-updated', (ledger) => {
        const task = ledger.tasks.find((item) => item.id === created.id)!;
        task.status = 'archived';
        return [task];
      });
      await expect(
        updateTask(
          { id: created.id, ifVersion: created.version, title: '改名' },
          actor,
          writerFor(store),
        ),
      ).rejects.toThrow('archived tasks are immutable');
    });

    it('目标任务不存在时报 not_found', async () => {
      const store = createFakeStore();
      await expect(
        updateTask(
          { id: 't-ghost', ifVersion: 1, title: '改名' },
          actor,
          writerFor(store),
        ),
      ).rejects.toThrow('no task t-ghost');
    });
  });

  describe('写路径走事件流', () => {
    it('建卡与改卡分别发出 task-created / task-updated 事件', async () => {
      const store = createFakeStore();
      const created = await createTask(
        { title: '卡', workspaceId: 'ws-1', urgency: 'normal' },
        actor,
        writerFor(store),
      );
      await updateTask(
        { id: created.id, ifVersion: created.version, title: '改名' },
        actor,
        writerFor(store),
      );

      expect(store.events.map((event) => event.kind)).toEqual([
        'task-created',
        'task-updated',
      ]);
      expect(store.events[1]?.ids).toEqual([created.id]);
    });

    it('依赖校验失败时不落盘（事件流不留痕）', async () => {
      const store = createFakeStore();
      await expect(
        createTask(
          {
            title: '卡',
            workspaceId: 'ws-1',
            urgency: 'normal',
            blockedBy: ['t-missing'],
          },
          actor,
          writerFor(store),
        ),
      ).rejects.toThrow('dependency not found: t-missing');
      expect(store.events).toHaveLength(0);
      expect(store.snapshot().tasks).toHaveLength(0);
    });
  });
});
