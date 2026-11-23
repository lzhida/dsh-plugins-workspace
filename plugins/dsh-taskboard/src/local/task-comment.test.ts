/**
 * 板服务评论写通道（验收联动系列 2/4）的契约测试。
 *
 * 覆盖：addTaskComment 走 store.mutate('comment-added') 事件流、系统评论与
 * 用户评论可区分（threadId 来源标记 + '[系统] ' 前缀）、幂等键去重、失败
 * 折叠为结构化 ok/error、板服务实例经 ctx.provide('dsh-taskboard') 自动
 * 携带（index.ts 源接线契约——板服务接口加方法即随 provide 暴露）。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createBoardService } from './board-service.ts';
import { createFakeStore, type FakeStore } from './fake-store.ts';
import {
  SYSTEM_COMMENT_BODY_PREFIX,
  SYSTEM_COMMENT_SOURCE,
  addTaskComment,
  isSystemComment,
  type AddTaskCommentResult,
  type TaskWriterDeps,
} from './task-writer.ts';

const NOW = 1_700_000_000_000;

function writerFor(store: FakeStore): TaskWriterDeps {
  return { store, now: () => NOW, settings: () => store.snapshot().settings };
}

function sourceOf(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}

/** 断言成功并取出成功分支（供窄化用）。 */
function okOf(
  result: AddTaskCommentResult,
): Extract<AddTaskCommentResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(
      `expected ok, got ${result.error.code}: ${result.error.message}`,
    );
  }
  return result;
}

/** 断言失败并取出结构化错误（供窄化用）。 */
function errOf(result: AddTaskCommentResult): {
  code: string;
  message: string;
} {
  if (result.ok) throw new Error('expected failure, got ok');
  return result.error;
}

describe('dsh-taskboard 板服务评论写通道', () => {
  it('写入系统评论：threadId 来源标记 + [系统] 前缀，与用户评论可区分', async () => {
    const store = createFakeStore();
    const service = createBoardService({ store, now: () => NOW });
    const created = await service.createTask({
      title: '摸鱼',
      workspaceId: 'ws-1',
    });

    const written = okOf(
      await service.addTaskComment({ taskId: created.id, body: '分支已合并' }),
    );

    const comment = service.getTask(created.id)!.comments[0]!;
    expect(comment.body).toBe(`${SYSTEM_COMMENT_BODY_PREFIX}分支已合并`);
    expect(comment.threadId).toBe(SYSTEM_COMMENT_SOURCE);
    expect(comment.createdAt).toBe(NOW);
    expect(isSystemComment(comment)).toBe(true);
    expect(written.comment.id).toBe(comment.id);

    // 用户评论无 threadId → 非系统评论；自定义来源标记要显式传入才命中。
    const userLike = { ...comment, body: '用户留言', threadId: undefined };
    expect(isSystemComment(userLike)).toBe(false);
    const custom = okOf(
      await service.addTaskComment({
        taskId: created.id,
        body: '收割留痕',
        source: 'kanban-harvest',
      }),
    );
    expect(custom.comment.threadId).toBe('kanban-harvest');
    expect(isSystemComment(custom.comment)).toBe(false);
    expect(isSystemComment(custom.comment, 'kanban-harvest')).toBe(true);

    // 正文已带系统前缀时不重复叠加；纯空白来源标记回退默认。
    const prefixed = okOf(
      await service.addTaskComment({
        taskId: created.id,
        body: '[系统] 已带前缀',
        source: '   ',
      }),
    );
    expect(prefixed.comment.body).toBe('[系统] 已带前缀');
    expect(prefixed.comment.threadId).toBe(SYSTEM_COMMENT_SOURCE);
  });

  it("写路径走 store.mutate('comment-added') 事件流并推进任务版本", async () => {
    const store = createFakeStore();
    const service = createBoardService({ store });
    const created = await service.createTask({
      title: '摸鱼',
      workspaceId: 'ws-1',
    });

    const written = okOf(
      await service.addTaskComment({ taskId: created.id, body: '留痕' }),
    );

    expect(store.events.map((event) => event.kind)).toEqual([
      'task-created',
      'comment-added',
    ]);
    expect(store.events[1]?.ids).toEqual([created.id]);
    expect(written.duplicate).toBe(false);
    expect(written.taskVersion).toBe(2);
    expect(service.getTask(created.id)?.version).toBe(2);
  });

  it('幂等：同幂等键重复写入不产生重复评论、不推进版本', async () => {
    const store = createFakeStore();
    const service = createBoardService({ store });
    const created = await service.createTask({
      title: '摸鱼',
      workspaceId: 'ws-1',
    });
    const key = `merge:${created.id}:abc123`;

    const first = okOf(
      await service.addTaskComment({
        taskId: created.id,
        body: '第一次留痕',
        idempotencyKey: key,
      }),
    );
    // 同键重放：即使正文不同也只认幂等键，不重复留痕。
    const replay = okOf(
      await service.addTaskComment({
        taskId: created.id,
        body: '故意不同的正文',
        idempotencyKey: key,
      }),
    );

    expect(service.getTask(created.id)?.comments).toHaveLength(1);
    expect(replay.duplicate).toBe(true);
    expect(replay.comment.id).toBe(first.comment.id);
    expect(replay.taskVersion).toBe(first.taskVersion);
    expect(service.getTask(created.id)?.version).toBe(2);
    // 事件流只落地一次 comment-added（重放在 mutator 内放弃写入被拦截）。
    expect(
      store.events.filter((event) => event.kind === 'comment-added'),
    ).toHaveLength(1);

    // 不同幂等键是不同留痕，正常追加并推进版本。
    const other = okOf(
      await service.addTaskComment({
        taskId: created.id,
        body: '另一次留痕',
        idempotencyKey: `merge:${created.id}:def456`,
      }),
    );
    expect(other.duplicate).toBe(false);
    expect(service.getTask(created.id)?.comments).toHaveLength(2);
    expect(service.getTask(created.id)?.version).toBe(3);
  });

  it('失败折叠为结构化 ok/error：任务不存在、正文非法、已归档', async () => {
    const store = createFakeStore();
    const service = createBoardService({ store });
    const created = await service.createTask({
      title: '摸鱼',
      workspaceId: 'ws-1',
    });

    const missing = errOf(
      await service.addTaskComment({ taskId: 't-none', body: '留痕' }),
    );
    expect(missing.code).toBe('not_found');
    expect(missing.message).toBe('no task t-none');

    const blank = errOf(
      await service.addTaskComment({ taskId: created.id, body: '   ' }),
    );
    expect(blank.code).toBe('invalid_input');
    expect(blank.message).toBe('comment body must be 1..4000 characters');

    // 已归档任务不可写（与上游 taskboard_comment 同口径）。
    await store.mutate('task-updated', (ledger) => {
      const task = ledger.tasks.find((item) => item.id === created.id)!;
      task.status = 'archived';
      return [task];
    });
    const archived = errOf(
      await service.addTaskComment({ taskId: created.id, body: '留痕' }),
    );
    expect(archived.code).toBe('invalid_transition');
    expect(archived.message).toBe('archived tasks are immutable');
    // 失败路径不留痕、不推进版本。
    expect(service.getTask(created.id)?.comments).toHaveLength(0);
    expect(service.getTask(created.id)?.version).toBe(1);
  });

  it('台账写失败不抛穿调用方，折叠为 taskboard_not_ready', async () => {
    const store = createFakeStore();
    const service = createBoardService({ store });
    const created = await service.createTask({
      title: '摸鱼',
      workspaceId: 'ws-1',
    });
    const boom: TaskWriterDeps = {
      ...writerFor(store),
      store: {
        snapshot: () => store.snapshot(),
        get: (id) => store.get(id),
        mutate: async () => {
          throw new Error('disk on fire');
        },
      },
    };

    const result = await addTaskComment(
      { taskId: created.id, body: '留痕' },
      boom,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('taskboard_not_ready');
      expect(result.error.message).toBe('disk on fire');
    }
    expect(service.getTask(created.id)?.comments).toHaveLength(0);
  });

  it("板服务实例经 ctx.provide('dsh-taskboard') 暴露（index.ts 源接线契约）", () => {
    const indexSource = sourceOf('../index.ts');
    expect(indexSource).toContain(
      'const boardService = createBoardService({ store, now })',
    );
    expect(indexSource).toContain("ctx.provide('dsh-taskboard', boardService)");
  });
});
