/**
 * 板服务（宿主服务名 `dsh-taskboard`）的契约测试。
 *
 * 覆盖：只读视图与过滤、依赖判定口径（复用 shared/dependencies.ts）、建卡 / 改卡
 * 写路径走 store.mutate 事件流，以及 ifVersion 乐观锁冲突。
 */

import { describe, expect, it } from 'vitest';
import { createFakeStore } from './fake-store.ts';
import { createBoardService } from './board-service.ts';

describe('dsh-taskboard 板服务', () => {
  it('提供只读视图：快照、单卡查询与任务列表', async () => {
    const store = createFakeStore();
    const service = createBoardService({ store, now: () => 1_700_000_000_000 });

    const created = await service.createTask({
      title: '摸鱼',
      workspaceId: 'ws-1',
    });

    expect(service.snapshot().tasks).toHaveLength(1);
    expect(service.getTask(created.id)?.title).toBe('摸鱼');
    expect(service.listTasks().map((task) => task.id)).toEqual([created.id]);
  });

  it('建卡缺省紧急度取 normal、记录者取 system', async () => {
    const store = createFakeStore();
    const service = createBoardService({ store });

    const created = await service.createTask({
      title: '摸鱼',
      workspaceId: 'ws-1',
    });

    expect(created.urgency).toBe('normal');
    expect(service.getTask(created.id)?.createdBy).toEqual({ kind: 'system' });
  });

  it('建卡 / 改卡走 store.mutate 事件流', async () => {
    const store = createFakeStore();
    const service = createBoardService({ store });

    const created = await service.createTask({
      title: '摸鱼',
      workspaceId: 'ws-1',
    });
    await service.updateTask({
      id: created.id,
      ifVersion: created.version,
      title: '继续摸',
    });

    expect(store.events.map((event) => event.kind)).toEqual([
      'task-created',
      'task-updated',
    ]);
    expect(service.getTask(created.id)?.title).toBe('继续摸');
    expect(service.getTask(created.id)?.version).toBe(2);
  });

  it('列表按项目 / 状态 / 紧急度过滤', async () => {
    const store = createFakeStore();
    const service = createBoardService({ store });

    await service.createTask({ title: '甲', workspaceId: 'ws-1' });
    await service.createTask({
      title: '乙',
      workspaceId: 'ws-2',
      urgency: 'urgent',
    });

    expect(service.listTasks({ workspaceId: 'ws-1' })).toHaveLength(1);
    expect(service.listTasks({ workspaceId: 'ws-2' })[0]?.title).toBe('乙');
    expect(service.listTasks({ urgency: 'urgent' })).toHaveLength(1);
    expect(service.listTasks({ status: 'todo' })).toHaveLength(2);
    expect(service.listTasks({ status: 'done' })).toHaveLength(0);
  });

  it('依赖判定复用 shared/dependencies.ts 的满足口径', async () => {
    const store = createFakeStore();
    const service = createBoardService({ store });

    const prior = await service.createTask({
      title: '前置',
      workspaceId: 'ws-1',
    });
    const target = await service.createTask({
      title: '后继',
      workspaceId: 'ws-1',
      blockedBy: [prior.id],
    });

    // 前置尚未进入 in_review / done：不满足，且被阻塞。
    expect(service.dependencies(target.id)).toEqual([
      {
        id: prior.id,
        title: '前置',
        status: 'todo',
        satisfied: false,
      },
    ]);
    expect(service.dependencyBlock(target.id)).toContain('dependency_blocked:');
    expect(service.dependencyBlock(target.id)).toContain('前置');
    expect(service.listTasks({ blockedOnly: true }).map((t) => t.id)).toEqual([
      target.id,
    ]);

    // 前置进入 in_review：满足。
    await store.mutate('task-updated', (ledger) => {
      const task = ledger.tasks.find((item) => item.id === prior.id)!;
      task.status = 'in_review';
      return [task];
    });

    expect(service.dependencies(target.id)[0]?.satisfied).toBe(true);
    expect(service.dependencyBlock(target.id)).toBeUndefined();
    expect(service.listTasks({ blockedOnly: true })).toHaveLength(0);
  });

  it('依赖门禁按看板设置开关', () => {
    const store = createFakeStore();
    const service = createBoardService({ store });
    expect(service.dependencyGateEnabled('agent')).toBe(true);
    expect(service.dependencyGateEnabled('review')).toBe(true);

    store.setSettings({ dependencyGates: { agent: false } });
    expect(service.dependencyGateEnabled('agent')).toBe(false);
    expect(service.dependencyGateEnabled('review')).toBe(true);
  });

  it('改卡缺少 ifVersion 抛版本冲突', async () => {
    const store = createFakeStore();
    const service = createBoardService({ store });
    const created = await service.createTask({
      title: '摸鱼',
      workspaceId: 'ws-1',
    });

    await expect(
      service.updateTask({ id: created.id, title: '继续摸' }),
    ).rejects.toThrow('this write requires ifVersion; read the task first');
  });

  it('改卡 ifVersion 与当前版本不符抛版本冲突', async () => {
    const store = createFakeStore();
    const service = createBoardService({ store });
    const created = await service.createTask({
      title: '摸鱼',
      workspaceId: 'ws-1',
    });

    await expect(
      service.updateTask({ id: created.id, ifVersion: 42, title: '继续摸' }),
    ).rejects.toThrow(
      'stale version 42 (current 1); re-read the task and retry once',
    );
  });

  it('改卡时前置任务为替换语义', async () => {
    const store = createFakeStore();
    const service = createBoardService({ store });

    const first = await service.createTask({
      title: '前置一',
      workspaceId: 'ws-1',
    });
    const second = await service.createTask({
      title: '前置二',
      workspaceId: 'ws-1',
    });
    const target = await service.createTask({
      title: '目标',
      workspaceId: 'ws-1',
      blockedBy: [first.id],
    });

    await service.updateTask({
      id: target.id,
      ifVersion: target.version,
      blockedBy: [second.id],
    });

    expect(service.getTask(target.id)?.blockedBy).toEqual([second.id]);
  });
});
