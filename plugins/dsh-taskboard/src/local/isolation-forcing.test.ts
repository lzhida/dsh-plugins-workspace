/**
 * 建卡强制隔离（验收联动系列 1/4）的三入口契约测试。
 *
 * 建卡入口共三条，且**各自独立归一化** isolation：
 * - 工具入口：`host/tools.ts` 的 `taskboard_create.execute` → `local/task-writer.ts`
 *   的 `createTask`（参数整体透传，入口自身不归一化隔离）；
 * - 板服务入口：`local/board-service.ts` 的 `createTask` → `local/task-writer.ts`
 *   的 `createTask`；
 * - GUI 入口：`host/routes.ts` 的 `POST /dsh-taskboard/tasks`（上游文件里独立实现
 *   归一化，故必须显式接入同一真源 `resolveIsolation`）。
 *
 * 三条入口都必须落到 worktree：显式 `none` 被强制覆盖，且建卡结果带
 * 「已强制 worktree」注明。
 *
 * GUI 入口依赖宿主 HTTP 层，无法在本层单测，故以「同源纯函数 + 接线契约断言」
 * 覆盖；HTTP 级回归由验收联动系列 4/4 的全链路 e2e 承担。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createBoardService } from './board-service.ts';
import { createFakeStore } from './fake-store.ts';
import {
  FORCED_ISOLATION,
  createTask,
  resolveIsolation,
  type TaskWriterDeps,
} from './task-writer.ts';
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

/** 读取上游文件源码（接线契约断言用）。 */
function sourceOf(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

describe('dsh-taskboard 建卡强制隔离（三条入口）', () => {
  it('工具入口：taskboard_create 透传的 isolation=none 被强制覆盖为 worktree 并注明', async () => {
    const store = createFakeStore({ settings: { defaultIsolation: 'none' } });

    const summary = await createTask(
      {
        title: '工具建卡',
        workspaceId: 'ws-1',
        urgency: 'normal',
        isolation: 'none',
      },
      actor,
      writerFor(store),
    );

    expect(store.get(summary.id)?.isolation).toBe('worktree');
    expect(summary.isolationForced).toBe(true);
    expect(summary.isolationNote).toContain('已强制 worktree');
    // 工具入口自身不归一化隔离（整体透传给写手）
    expect(sourceOf('../host/tools.ts')).toContain(
      'await createTask(args, actor, {',
    );
  });

  it('板服务入口：createTask 的 isolation=none 被强制覆盖为 worktree 并注明', async () => {
    const store = createFakeStore();
    const service = createBoardService({ store, now: () => NOW });

    const created = await service.createTask({
      title: '板服务建卡',
      workspaceId: 'ws-1',
      isolation: 'none',
    });

    expect(service.getTask(created.id)?.isolation).toBe('worktree');
    const noted = created as {
      isolationForced?: boolean;
      isolationNote?: string;
    };
    expect(noted.isolationForced).toBe(true);
    expect(noted.isolationNote).toContain('已强制 worktree');
  });

  it('GUI 入口：建卡归一化接入 resolveIsolation 真源（接线契约）', () => {
    const source = sourceOf('../host/routes.ts');
    const start = source.indexOf('POST /tasks (create)');
    const end = source.indexOf('POST /tasks/:id/{action}');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const block = source.slice(start, end);
    // 建卡块必须走真源，且不得再自行决定 isolation
    expect(block).toContain('resolveIsolation(');
    expect(block).not.toMatch(/const isolation\s*=\s*isolationRaw/);
    // 真源来自本地层（与工具 / 板服务入口同源）
    expect(source).toContain("from '../local/task-writer.ts'");
  });
});

describe('dsh-taskboard 建卡隔离归一化真源', () => {
  it('显式 worktree 原样生效且不算强制覆盖', () => {
    expect(resolveIsolation('worktree', 'none')).toEqual({
      isolation: 'worktree',
      forced: false,
    });
  });

  it('显式 none 强制改为 worktree 并注明原值来源', () => {
    const resolved = resolveIsolation('none', 'worktree');
    expect(resolved.isolation).toBe(FORCED_ISOLATION);
    expect(resolved.forced).toBe(true);
    expect(resolved.note).toContain('显式请求 none');
  });

  it('未指定且看板默认为 none 时强制改为 worktree 并注明', () => {
    const resolved = resolveIsolation(undefined, 'none');
    expect(resolved.isolation).toBe('worktree');
    expect(resolved.forced).toBe(true);
    expect(resolved.note).toContain('看板默认隔离为 none');
  });

  it('未指定且看板默认即为 worktree 时原样生效', () => {
    expect(resolveIsolation(undefined, 'worktree')).toEqual({
      isolation: 'worktree',
      forced: false,
    });
  });

  it('非法隔离值仍按上游口径报错（校验不被绕过）', () => {
    expect(() => resolveIsolation('container', 'none')).toThrow(
      "isolation must be 'worktree' or 'none'",
    );
  });
});
