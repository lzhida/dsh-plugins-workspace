/**
 * dsh-taskboard 行为契约测试。
 *
 * 覆盖:
 * - 插件契约(name / inject / 加载日志);
 * - 工具注册的最小 stub(cordis 假体);
 * - 10 个 taskboard_* 工具的关键路径(CRUD、状态机、协议闸);
 * - 错误路径(VERSION_CONFLICT / TASK_HELD / CROSS_PROJECT_FORBIDDEN /
 *   DONE_FORBIDDEN / ILLEGAL_TRANSITION / CHECKLIST_NOTE_REQUIRED /
 *   INVALID_INPUT);
 * - 序列化与原子写(file 模式:tmp + rename,损坏文件 quarantine)。
 *
 * 风格遵循 dsh-plugin-dev skill 的 stubCtx 模式。
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';

import { apply, inject, name } from './index.ts';
import { PROTOCOL_SECTION_NAME, PROTOCOL_SECTION_ORDER } from './protocol.ts';
import {
  TaskStore,
  defaultLedgerPath,
  isLegalTransition,
  newTaskId,
} from './store.ts';
import { createTaskboardTools } from './tools.ts';
import {
  DEFAULT_SETTINGS,
  TaskboardError,
  formatTaskboardError,
  type Task,
} from './types.ts';

// ── 测试工具 ─────────────────────────────────────────────────────────

/** 固定 now,便于断言时间戳。 */
let clock = 1_700_000_000_000;
const now = (): number => clock;

beforeEach(() => {
  clock = 1_700_000_000_000;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** cordis Context 最小假体:effect 立即执行,systemPrompt.section 记录。 */
function stubCtx(): {
  ctx: Context;
  sections: Array<{ name: string; order: number; text: string }>;
  registered: Array<{ name: string }>;
  cleanups: Array<() => void>;
} {
  const sections: Array<{ name: string; order: number; text: string }> = [];
  const registered: Array<{ name: string }> = [];
  const cleanups: Array<() => void> = [];
  const ctx = {
    effect(fn: () => (() => void) | void): void {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
    systemPrompt: {
      section(s: { name: string; order: number; text: string }): () => void {
        sections.push(s);
        return () => {};
      },
    },
    tools: {
      register(def: { name: string }): () => void {
        registered.push({ name: def.name });
        return () => {};
      },
    },
  } as unknown as Context;
  return { ctx, sections, registered, cleanups };
}

/** 默认 agent 调用上下文:workspace-1 / author=session-1。 */
const CTX_AGENT_A = {
  workspaceId: 'workspace-1',
  author: 'session-A',
  authorKind: 'agent' as const,
  now: now(),
};

const CTX_AGENT_B = {
  workspaceId: 'workspace-1',
  author: 'session-B',
  authorKind: 'agent' as const,
  now: now(),
};

const CTX_USER = {
  workspaceId: 'workspace-1',
  author: 'user-1',
  authorKind: 'user' as const,
  now: now(),
};

const CTX_OTHER_PROJECT = {
  workspaceId: 'workspace-2',
  author: 'session-X',
  authorKind: 'agent' as const,
  now: now(),
};

/** 工具测试上下文:固定 workspace + author。 */
const TOOL_CTX = {
  workspaceId: 'workspace-1',
  author: 'session-A',
  authorKind: 'agent' as const,
  now: now(),
};

// ── 插件契约 ─────────────────────────────────────────────────────────

describe('dsh-taskboard 契约', () => {
  it('导出插件名(loader 依赖)', () => {
    expect(name).toBe('dsh-taskboard');
  });

  it('inject 声明依赖 tools + systemPrompt', () => {
    expect(inject).toEqual(['tools', 'systemPrompt']);
  });

  it('装载时输出 [dsh-taskboard] plugin loaded(e2e 契约)', async () => {
    const logSpy = vi.mocked(console.log);
    const { ctx } = stubCtx();
    await apply(ctx);
    expect(logSpy).toHaveBeenCalledWith(`[${name}] plugin loaded`);
  });

  it('注册一个名为 tool:taskboard 的 system-prompt section,order 锁定', async () => {
    const { ctx, sections } = stubCtx();
    await apply(ctx);
    const s = sections.find((x) => x.name === PROTOCOL_SECTION_NAME);
    expect(s).toBeDefined();
    expect(s!.order).toBe(PROTOCOL_SECTION_ORDER);
    // 关键约束文本
    expect(s!.text).toContain('DONE_FORBIDDEN');
    expect(s!.text).toContain('TASK_HELD');
    expect(s!.text).toContain('VERSION_CONFLICT');
    expect(s!.text).toContain('CHECKLIST_NOTE_REQUIRED');
    expect(s!.text).toContain('in_progress');
    expect(s!.text).toContain('in_review');
  });

  it('system-prompt section 文本不含未解析变量(rc.2 renderPrompt 严格化)', async () => {
    // dsh 0.2.0-rc.2 的 renderPrompt 对未注册的 {{var}} 引用会拒绝渲染。
    // 我们静态定义文本,不应出现任何 {{...}} 形引用,以免 host 加载时报错。
    const { ctx, sections } = stubCtx();
    await apply(ctx);
    const s = sections.find((x) => x.name === PROTOCOL_SECTION_NAME);
    expect(s).toBeDefined();
    expect(s!.text).not.toMatch(/\{\{/);
    expect(s!.text).not.toMatch(/\}\}/);
  });

  it('注册全部 10 个 taskboard_* 工具', async () => {
    const { ctx, registered } = stubCtx();
    await apply(ctx);
    const names = registered.map((r) => r.name).sort();
    expect(names).toEqual([
      'taskboard_checklist',
      'taskboard_comment_add',
      'taskboard_comments',
      'taskboard_create',
      'taskboard_delete',
      'taskboard_execution_report',
      'taskboard_get',
      'taskboard_list',
      'taskboard_move',
      'taskboard_update',
    ]);
  });
});

// ── Store 单元 ───────────────────────────────────────────────────────

describe('TaskStore 基础', () => {
  it('默认 settings 含 maxConcurrent=3、defaultUrgency=normal、defaultExecutionMode=claim', async () => {
    const store = new TaskStore();
    await store.load();
    expect(store.settings()).toEqual(DEFAULT_SETTINGS);
  });

  it('create 生成 t- 前缀的 id', async () => {
    const store = new TaskStore();
    await store.load();
    const t = await store.create(
      { ...CTX_AGENT_A, now: now() },
      {
        workspaceId: 'ws',
        title: 'hello',
      },
    );
    expect(t.id).toMatch(/^t-[a-f0-9]{6}$/);
  });

  it('newTaskId 生成不同 id', () => {
    const ids = new Set([newTaskId(), newTaskId(), newTaskId(), newTaskId()]);
    expect(ids.size).toBe(4);
  });
});

describe('TaskStore 状态机(isLegalTransition)', () => {
  it('允许的合法转移:backlog→todo / todo→in_progress / in_progress→in_review / in_review→done', () => {
    expect(isLegalTransition('backlog', 'todo')).toBe(true);
    expect(isLegalTransition('todo', 'in_progress')).toBe(true);
    expect(isLegalTransition('in_progress', 'in_review')).toBe(true);
    expect(isLegalTransition('in_review', 'done')).toBe(true);
  });

  it('禁止的非法转移:todo→done 跳级 / in_progress→done / done→in_progress 之外', () => {
    expect(isLegalTransition('todo', 'done')).toBe(false);
    expect(isLegalTransition('in_progress', 'done')).toBe(false);
    expect(isLegalTransition('done', 'todo')).toBe(false);
  });

  it('同状态转移幂等允许', () => {
    expect(isLegalTransition('todo', 'todo')).toBe(true);
    expect(isLegalTransition('in_progress', 'in_progress')).toBe(true);
  });
});

describe('TaskStore CRUD', () => {
  it('create → list → get 完整路径', async () => {
    const store = new TaskStore();
    await store.load();
    const t = await store.create(
      { ...CTX_AGENT_A, now: now() },
      {
        workspaceId: 'workspace-1',
        title: 'T1',
        checklist: [{ text: 'a' }, { text: 'b' }],
      },
    );
    expect(t.title).toBe('T1');
    expect(t.status).toBe('todo');
    expect(t.checklist).toHaveLength(2);

    const listed = store.list({ workspaceId: 'workspace-1' });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(t.id);

    const got = store.get(t.id);
    expect(got?.title).toBe('T1');
  });

  it('update 修改字段后 version 自增', async () => {
    const store = new TaskStore();
    await store.load();
    const t = await store.create(
      { ...CTX_AGENT_A, now: now() },
      { workspaceId: 'workspace-1', title: 'old' },
    );
    const next = await store.update(
      { ...CTX_AGENT_A, now: now() },
      t.id,
      t.version,
      { title: 'new' },
    );
    expect(next.title).toBe('new');
    expect(next.version).toBe(t.version + 1);
  });

  it('update 接受正确的 ifVersion 拒绝过期版本(VERSION_CONFLICT)', async () => {
    const store = new TaskStore();
    await store.load();
    const t = await store.create(
      { ...CTX_AGENT_A, now: now() },
      { workspaceId: 'workspace-1', title: 'a' },
    );
    const stale = t.version; // 未变
    await store.update({ ...CTX_AGENT_A, now: now() }, t.id, t.version, {
      title: 'b',
    });
    // 用旧版本再 update → VERSION_CONFLICT
    await expect(
      store.update({ ...CTX_AGENT_A, now: now() }, t.id, stale, { title: 'c' }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('跨项目 update 拒绝(CROSS_PROJECT_FORBIDDEN)', async () => {
    const store = new TaskStore();
    await store.load();
    const t = await store.create(
      { ...CTX_AGENT_A, now: now() },
      { workspaceId: 'workspace-1', title: 'a' },
    );
    await expect(
      store.update({ ...CTX_OTHER_PROJECT, now: now() }, t.id, t.version, {
        title: 'hijack',
      }),
    ).rejects.toMatchObject({ code: 'CROSS_PROJECT_FORBIDDEN' });
  });
});

// ── 协议闸(done / held / cross-project) ──────────────────────────────

describe('TaskStore 协议闸', () => {
  it('agent 永远到不了 done(DONE_FORBIDDEN)', async () => {
    const store = new TaskStore();
    await store.load();
    const t = await store.create(
      { ...CTX_AGENT_A, now: now() },
      { workspaceId: 'workspace-1', title: 'a' },
    );
    // 合法路径:todo→in_progress→in_review
    const inProgress = await store.move(
      { ...CTX_AGENT_A, now: now() },
      t.id,
      'in_progress',
      t.version,
    );
    const inReview = await store.move(
      { ...CTX_AGENT_A, now: now() },
      t.id,
      'in_review',
      inProgress.version,
    );
    expect(inReview.status).toBe('in_review');
    // 关键闸:即使是 in_review→done 也被代码拒绝
    await expect(
      store.move(
        { ...CTX_AGENT_A, now: now() },
        t.id,
        'done',
        inReview.version,
      ),
    ).rejects.toMatchObject({ code: 'DONE_FORBIDDEN' });
  });

  it('即使用户调用 move 到 done 也被拒绝(验收权只属于人)', async () => {
    const store = new TaskStore();
    await store.load();
    const t = await store.create(
      { ...CTX_AGENT_A, now: now() },
      { workspaceId: 'workspace-1', title: 'a' },
    );
    const inReview = await store.move(
      { ...CTX_AGENT_A, now: now() },
      t.id,
      'in_progress',
      t.version,
    );
    const inReview2 = await store.move(
      { ...CTX_AGENT_A, now: now() },
      t.id,
      'in_review',
      inReview.version,
    );
    await expect(
      store.move({ ...CTX_USER, now: now() }, t.id, 'done', inReview2.version),
    ).rejects.toMatchObject({ code: 'DONE_FORBIDDEN' });
  });

  it('被持有任务不可抢(TASK_HELD)', async () => {
    const store = new TaskStore();
    await store.load();
    const t = await store.create(
      { ...CTX_AGENT_A, now: now() },
      { workspaceId: 'workspace-1', title: 'a' },
    );
    // session-A 认领
    const claimed = await store.move(
      { ...CTX_AGENT_A, now: now() },
      t.id,
      'in_progress',
      t.version,
    );
    expect(claimed.claimSessionId).toBe('session-A');
    // session-B 抢:todo→in_progress 已经是别人;但当前是 in_progress,要看 todo→in_progress 的闸
    // 先让 session-B 拿一张 todo 任务的版本(用 B 自己的视角读到 version)
    const t2 = await store.create(
      { ...CTX_AGENT_A, now: now() },
      { workspaceId: 'workspace-1', title: 'b' },
    );
    const claimed2 = await store.move(
      { ...CTX_AGENT_A, now: now() },
      t2.id,
      'in_progress',
      t2.version,
    );
    // session-B 试图再认领 t2
    await expect(
      store.move(
        { ...CTX_AGENT_B, now: now() },
        t2.id,
        'in_progress',
        claimed2.version,
      ),
    ).rejects.toMatchObject({ code: 'TASK_HELD' });
  });

  it('跨项目不可操作(CROSS_PROJECT_FORBIDDEN)', async () => {
    const store = new TaskStore();
    await store.load();
    const t = await store.create(
      { ...CTX_AGENT_A, now: now() },
      { workspaceId: 'workspace-1', title: 'a' },
    );
    await expect(
      store.move(
        { ...CTX_OTHER_PROJECT, now: now() },
        t.id,
        'in_progress',
        t.version,
      ),
    ).rejects.toMatchObject({ code: 'CROSS_PROJECT_FORBIDDEN' });
  });

  it('非法状态转移(ILLEGAL_TRANSITION)', async () => {
    const store = new TaskStore();
    await store.load();
    const t = await store.create(
      { ...CTX_AGENT_A, now: now() },
      { workspaceId: 'workspace-1', title: 'a' },
    );
    // todo→done(跳级)
    await expect(
      store.move({ ...CTX_AGENT_A, now: now() }, t.id, 'done', t.version),
    ).rejects.toMatchObject({ code: 'DONE_FORBIDDEN' });
    // 试 todo→in_review(跳级)
    await expect(
      store.move({ ...CTX_AGENT_A, now: now() }, t.id, 'in_review', t.version),
    ).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
  });

  it('todo→in_progress 自动写入 claimSessionId;in_progress→todo 释放', async () => {
    const store = new TaskStore();
    await store.load();
    const t = await store.create(
      { ...CTX_AGENT_A, now: now() },
      { workspaceId: 'workspace-1', title: 'a' },
    );
    const claimed = await store.move(
      { ...CTX_AGENT_A, now: now() },
      t.id,
      'in_progress',
      t.version,
    );
    expect(claimed.claimSessionId).toBe('session-A');
    const released = await store.move(
      { ...CTX_AGENT_A, now: now() },
      t.id,
      'todo',
      claimed.version,
    );
    expect(released.claimSessionId).toBeUndefined();
  });
});

// ── Checklist 协议 ──────────────────────────────────────────────────

describe('TaskStore checklist', () => {
  it('add 追加条目并校验 ≤30 上限(CHECKLIST_LIMIT_EXCEEDED)', async () => {
    const store = new TaskStore();
    await store.load();
    const init: { text: string }[] = Array.from({ length: 30 }, (_, i) => ({
      text: `a${i}`,
    }));
    const t = await store.create(
      { ...CTX_AGENT_A, now: now() },
      { workspaceId: 'workspace-1', title: 'a', checklist: init },
    );
    await expect(
      store.checklist({ ...CTX_AGENT_A, now: now() }, t.id, t.version, 'add', {
        text: 'overflow',
      }),
    ).rejects.toMatchObject({ code: 'CHECKLIST_LIMIT_EXCEEDED' });
  });

  it('check 必须附 note,空 note 被拒绝(CHECKLIST_NOTE_REQUIRED)', async () => {
    const store = new TaskStore();
    await store.load();
    const t = await store.create(
      { ...CTX_AGENT_A, now: now() },
      {
        workspaceId: 'workspace-1',
        title: 'a',
        checklist: [{ text: 'item' }],
      },
    );
    const itemId = t.checklist[0]!.id;
    await expect(
      store.checklist(
        { ...CTX_AGENT_A, now: now() },
        t.id,
        t.version,
        'check',
        { itemId, note: '' },
      ),
    ).rejects.toMatchObject({ code: 'CHECKLIST_NOTE_REQUIRED' });
  });

  it('check 附 note 成功,uncheck 清除证据', async () => {
    const store = new TaskStore();
    await store.load();
    const t = await store.create(
      { ...CTX_AGENT_A, now: now() },
      {
        workspaceId: 'workspace-1',
        title: 'a',
        checklist: [{ text: 'item' }],
      },
    );
    const itemId = t.checklist[0]!.id;
    const checked = await store.checklist(
      { ...CTX_AGENT_A, now: now() },
      t.id,
      t.version,
      'check',
      { itemId, note: 'pnpm test 通过' },
    );
    expect(checked.item?.checked).toBe(true);
    expect(checked.item?.note).toBe('pnpm test 通过');
    expect(checked.item?.checkedBy).toBe('session-A');

    const unchecked = await store.checklist(
      { ...CTX_AGENT_A, now: now() },
      t.id,
      checked.task.version,
      'uncheck',
      { itemId },
    );
    expect(unchecked.item?.checked).toBe(false);
    expect(unchecked.item?.note).toBeUndefined();
  });

  it('checklist 跨项目拒绝', async () => {
    const store = new TaskStore();
    await store.load();
    const t = await store.create(
      { ...CTX_AGENT_A, now: now() },
      {
        workspaceId: 'workspace-1',
        title: 'a',
        checklist: [{ text: 'item' }],
      },
    );
    const itemId = t.checklist[0]!.id;
    await expect(
      store.checklist(
        { ...CTX_OTHER_PROJECT, now: now() },
        t.id,
        t.version,
        'check',
        { itemId, note: 'x' },
      ),
    ).rejects.toMatchObject({ code: 'CROSS_PROJECT_FORBIDDEN' });
  });
});

// ── 评论 + 执行报告 ──────────────────────────────────────────────────

describe('TaskStore 评论 + 执行报告', () => {
  it('addComment 流式追加,不冲突 ifVersion', async () => {
    const store = new TaskStore();
    await store.load();
    const t = await store.create(
      { ...CTX_AGENT_A, now: now() },
      { workspaceId: 'workspace-1', title: 'a' },
    );
    const c1 = await store.addComment(
      { ...CTX_AGENT_A, now: now() },
      t.id,
      'first',
    );
    const c2 = await store.addComment(
      { ...CTX_AGENT_A, now: now() + 1 },
      t.id,
      'second',
    );
    expect(c1.body).toBe('first');
    expect(c2.body).toBe('second');
    expect(store.commentsFor(t.id)).toHaveLength(2);
  });

  it('submitReport 挂到 execution 记录;summary 空抛 REPORT_INCOMPLETE', async () => {
    const store = new TaskStore();
    await store.load();
    const t = await store.create(
      { ...CTX_AGENT_A, now: now() },
      { workspaceId: 'workspace-1', title: 'a' },
    );
    const { execution } = await store.submitReport(
      { ...CTX_AGENT_A, now: now() },
      t.id,
      'exec-1',
      {
        summary: '完成',
        changedFiles: ['src/x.ts'],
        checks: ['pnpm test'],
        artifacts: [],
        risk: '',
      },
    );
    expect(execution.report?.summary).toBe('完成');
    expect(execution.report?.changedFiles).toEqual(['src/x.ts']);

    await expect(
      store.submitReport({ ...CTX_AGENT_A, now: now() + 1 }, t.id, 'exec-2', {
        summary: '',
        changedFiles: [],
        checks: [],
        artifacts: [],
      }),
    ).rejects.toMatchObject({ code: 'REPORT_INCOMPLETE' });
  });
});

// ── 软删除 + 文件持久化 ──────────────────────────────────────────────

describe('TaskStore 软删除 + 文件持久化', () => {
  it('trash 设置 trashedAt,默认 list 不再返回', async () => {
    const store = new TaskStore();
    await store.load();
    const t = await store.create(
      { ...CTX_AGENT_A, now: now() },
      { workspaceId: 'workspace-1', title: 'a' },
    );
    const trashed = await store.trash(
      { ...CTX_AGENT_A, now: now() },
      t.id,
      t.version,
    );
    expect(trashed.trashedAt).toBeDefined();
    expect(store.list({ workspaceId: 'workspace-1' })).toHaveLength(0);
    expect(
      store.list({ workspaceId: 'workspace-1', includeTrashed: true }),
    ).toHaveLength(1);
  });

  it('内存模式 + 文件模式:CRUD 落盘后可重新 load 读取', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-taskboard-'));
    try {
      const file = defaultLedgerPath(dir);
      const s1 = new TaskStore({ file, now });
      await s1.load();
      const t = await s1.create(
        { ...CTX_AGENT_A, now: now() },
        { workspaceId: 'workspace-1', title: '持久化测试' },
      );
      await s1.flush();

      // 重新 load
      const s2 = new TaskStore({ file, now });
      await s2.load();
      const got = s2.get(t.id);
      expect(got?.title).toBe('持久化测试');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('损坏的台账文件不阻塞启动(quarantine + 空台账)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-taskboard-'));
    try {
      const file = defaultLedgerPath(dir);
      await writeFile(file, '{not a valid json', 'utf8');
      const store = new TaskStore({ file, now });
      await store.load(); // 不抛
      expect(
        store.list({ workspaceId: 'any', includeTrashed: true }),
      ).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('原子写:写期间半截文件不会留下(tmp + rename)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-taskboard-'));
    try {
      const file = defaultLedgerPath(dir);
      const store = new TaskStore({ file, now });
      await store.load();
      await store.create(
        { ...CTX_AGENT_A, now: now() },
        { workspaceId: 'workspace-1', title: 'a' },
      );
      // 此时文件应该完整 JSON
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as { tasks: Task[] };
      expect(parsed.tasks).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('损坏台账的 quarantine 副本命名带 pid+uuid(并发 / 重复损坏不冲突)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-taskboard-'));
    try {
      const file = defaultLedgerPath(dir);
      // 写入损坏文件 → load → 落 quarantine1
      await writeFile(file, '{not a valid json', 'utf8');
      const s1 = new TaskStore({ file, now });
      await s1.load();
      // 立刻再次写为损坏并 load → 落 quarantine2;两个 quarantine 名称应不同
      await writeFile(file, '{not a valid json either', 'utf8');
      const s2 = new TaskStore({ file, now });
      await s2.load();

      const entries = await readdir(dir);
      const quarantines = entries.filter((n) => n.includes('.corrupt.'));
      expect(quarantines.length).toBeGreaterThanOrEqual(2);
      // 命名格式:`dsh-taskboard.json.corrupt.<pid>.<ms>.<uuid>`
      for (const name of quarantines) {
        expect(name).toMatch(/\.corrupt\.\d+\.\d+\.[a-f0-9-]{36}$/);
      }
      // 文件名应两两不同
      expect(new Set(quarantines).size).toBe(quarantines.length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── 工具层 ──────────────────────────────────────────────────────────

describe('taskboard_* 工具层', () => {
  /** 构造一个最小测试用 tool 解析器(绕过 ctx 抽取,直接传 ctx)。 */
  function makeTools() {
    const store = new TaskStore();
    // 测试用 workspace='ws-1' 与创建任务保持一致(否则跨项目闸误判)
    return {
      store,
      ...createTaskboardTools({
        store,
        resolveContext: () => ({ ...TOOL_CTX, workspaceId: 'ws-1' }),
      }),
    };
  }

  it('create + list + get 走通:10 个工具都注册', () => {
    const t = makeTools();
    const names = Object.keys(t.tools).sort();
    expect(names).toHaveLength(10);
  });

  it('taskboard_create 走工具路径:成功文本含任务 id', async () => {
    const t = makeTools();
    const created = (await t.tools.taskboard_create.execute(
      {
        workspaceId: 'ws-1',
        title: 'T',
        urgency: 'urgent',
        checklist: ['a', 'b'],
      },
      {} as never,
    )) as { text: string; id: string; version: number };
    expect(created.id).toMatch(/^t-/);
    expect(created.version).toBe(1);
    expect(created.text).toContain('T');
  });

  it('taskboard_create 缺 workspaceId 抛 INVALID_INPUT(由 schema 校验)', async () => {
    const t = makeTools();
    // dsh-tools 的 schema 校验先于 execute 体内,抛错文本不带 [CODE] 前缀
    await expect(
      t.tools.taskboard_create.execute({ title: 'a' } as never, {} as never),
    ).rejects.toThrow(/workspaceId|INVALID_INPUT/);
  });

  it('taskboard_move 到 done 永远被拒(在工具层 schema 拦截,enum 不含 done)', async () => {
    const t = makeTools();
    const created = (await t.tools.taskboard_create.execute(
      { workspaceId: 'ws-1', title: 'a' },
      {} as never,
    )) as { id: string; version: number };
    const inProgress = (await t.tools.taskboard_move.execute(
      { id: created.id, to: 'in_progress', ifVersion: created.version },
      {} as never,
    )) as { version: number };
    const inReview = (await t.tools.taskboard_move.execute(
      { id: created.id, to: 'in_review', ifVersion: inProgress.version },
      {} as never,
    )) as { version: number };
    // 工具层 to 参数的 enum 不含 done → 触发 schema 校验错误
    // (代码闸 store.move 也是兜底:即使 enum 漏掉,to=done 仍抛 DONE_FORBIDDEN)
    await expect(
      t.tools.taskboard_move.execute(
        { id: created.id, to: 'done', ifVersion: inReview.version },
        {} as never,
      ),
    ).rejects.toThrow(/must be one of|to/);
  });

  it('taskboard_checklist.check 空 note 抛 CHECKLIST_NOTE_REQUIRED', async () => {
    const t = makeTools();
    const created = (await t.tools.taskboard_create.execute(
      { workspaceId: 'ws-1', title: 'a', checklist: ['item'] },
      {} as never,
    )) as { id: string; version: number };
    const got = (await t.tools.taskboard_get.execute(
      { id: created.id },
      {} as never,
    )) as { text: string };
    // 提取 itemId:文本里 [ ] item 前面没有 id;我们用 store 反查
    const task = t.store.get(created.id);
    const itemId = task!.checklist[0]!.id;
    expect(got.text).toContain('item');
    await expect(
      t.tools.taskboard_checklist.execute(
        {
          id: created.id,
          ifVersion: created.version,
          action: 'check',
          itemId,
          note: '',
        },
        {} as never,
      ),
    ).rejects.toThrow(/CHECKLIST_NOTE_REQUIRED/);
  });

  it('taskboard_checklist.check 带 note 成功,文本含 evidence(item 文本展示)', async () => {
    const t = makeTools();
    const created = (await t.tools.taskboard_create.execute(
      { workspaceId: 'ws-1', title: 'a', checklist: ['item'] },
      {} as never,
    )) as { id: string; version: number };
    const task = t.store.get(created.id)!;
    const itemId = task.checklist[0]!.id;
    const result = (await t.tools.taskboard_checklist.execute(
      {
        id: created.id,
        ifVersion: created.version,
        action: 'check',
        itemId,
        note: 'pnpm test 通过',
      },
      {} as never,
    )) as { text: string; version: number };
    expect(result.text).toContain('已勾选');
    expect(result.text).toContain('item');
    // note 是证据(留在 store 内部,UI 在 detail 面板展示),工具文本不外泄以免长文污染模型上下文
    const task2 = t.store.get(created.id)!;
    expect(task2.checklist[0]?.note).toBe('pnpm test 通过');
  });

  it('taskboard_move 跨项目拒绝', async () => {
    const t = makeTools();
    const created = (await t.tools.taskboard_create.execute(
      { workspaceId: 'ws-1', title: 'a' },
      {} as never,
    )) as { id: string; version: number };
    // 替换 resolveContext 为 OTHER_PROJECT
    const t2 = createTaskboardTools({
      store: t.store,
      resolveContext: () => ({ ...TOOL_CTX, workspaceId: 'ws-2' }),
    });
    await expect(
      t2.tools.taskboard_move.execute(
        { id: created.id, to: 'in_progress', ifVersion: created.version },
        {} as never,
      ),
    ).rejects.toThrow(/CROSS_PROJECT_FORBIDDEN/);
  });

  it('taskboard_move → in_review 调用 exec.concludeTurn(rc.2 turn 终结)', async () => {
    const t = makeTools();
    const created = (await t.tools.taskboard_create.execute(
      { workspaceId: 'ws-1', title: 'a' },
      {} as never,
    )) as { id: string; version: number };
    const inProgress = (await t.tools.taskboard_move.execute(
      { id: created.id, to: 'in_progress', ifVersion: created.version },
      {} as never,
    )) as { version: number };

    // 模拟 dsh 0.2.0-rc.2 的 ToolRunContext,concludeTurn 是 method。
    const calls: string[] = [];
    const exec = {
      concludeTurn: () => {
        calls.push('concludeTurn');
      },
    } as unknown as Parameters<typeof t.tools.taskboard_move.execute>[1];

    await t.tools.taskboard_move.execute(
      { id: created.id, to: 'in_review', ifVersion: inProgress.version },
      exec,
    );
    expect(calls).toEqual(['concludeTurn']);
  });

  it('taskboard_move → in_progress 不调用 exec.concludeTurn(只 in_review 终结 turn)', async () => {
    const t = makeTools();
    const created = (await t.tools.taskboard_create.execute(
      { workspaceId: 'ws-1', title: 'a' },
      {} as never,
    )) as { id: string; version: number };

    const calls: string[] = [];
    const exec = {
      concludeTurn: () => {
        calls.push('concludeTurn');
      },
    } as unknown as Parameters<typeof t.tools.taskboard_move.execute>[1];

    await t.tools.taskboard_move.execute(
      { id: created.id, to: 'in_progress', ifVersion: created.version },
      exec,
    );
    expect(calls).toEqual([]);
  });

  it('taskboard_move 在 rc.1 形态的 ToolRunContext 上(无 concludeTurn)不抛错', async () => {
    // 兼容:rc.1 没有 concludeTurn,本工具不应在 typeof 检查下崩。
    const t = makeTools();
    const created = (await t.tools.taskboard_create.execute(
      { workspaceId: 'ws-1', title: 'a' },
      {} as never,
    )) as { id: string; version: number };
    const inProgress = (await t.tools.taskboard_move.execute(
      { id: created.id, to: 'in_progress', ifVersion: created.version },
      {} as never,
    )) as { version: number };

    // rc.1 风格 stub:没有 concludeTurn 字段
    const legacyExec = {} as unknown as Parameters<
      typeof t.tools.taskboard_move.execute
    >[1];
    await expect(
      t.tools.taskboard_move.execute(
        { id: created.id, to: 'in_review', ifVersion: inProgress.version },
        legacyExec,
      ),
    ).resolves.toBeDefined();
  });

  it('taskboard_execution_report 提交后 store 内可读', async () => {
    const t = makeTools();
    const created = (await t.tools.taskboard_create.execute(
      { workspaceId: 'ws-1', title: 'a' },
      {} as never,
    )) as { id: string; version: number };
    const result = (await t.tools.taskboard_execution_report.execute(
      {
        id: created.id,
        executionId: 'exec-1',
        summary: '完成 x.ts 修改并通过测试',
        changedFiles: ['src/x.ts'],
        checks: ['pnpm test'],
        artifacts: ['docs/note.md'],
        risk: '尚未跑 e2e',
      },
      {} as never,
    )) as { text: string };
    expect(result.text).toContain('Summary');
    expect(result.text).toContain('src/x.ts');
    expect(result.text).toContain('pnpm test');
    expect(result.text).toContain('Risk');
    const recs = t.store.executionsFor(created.id);
    expect(recs).toHaveLength(1);
    expect(recs[0]?.report?.summary).toContain('完成');
  });

  it('taskboard_list 过滤 status / urgency', async () => {
    const t = makeTools();
    await t.tools.taskboard_create.execute(
      { workspaceId: 'ws-1', title: 'urgent-1', urgency: 'urgent' },
      {} as never,
    );
    await t.tools.taskboard_create.execute(
      { workspaceId: 'ws-1', title: 'normal-1', urgency: 'normal' },
      {} as never,
    );
    const listed = (await t.tools.taskboard_list.execute(
      { workspaceId: 'ws-1', urgency: 'urgent' },
      {} as never,
    )) as { count: number; text: string };
    expect(listed.count).toBe(1);
    expect(listed.text).toContain('urgent-1');
    expect(listed.text).not.toContain('normal-1');
  });
});

// ── 错误格式化 ──────────────────────────────────────────────────────

describe('formatTaskboardError', () => {
  it('TaskboardError 输出 [CODE] message + meta JSON', () => {
    const err = new TaskboardError('VERSION_CONFLICT', '版本不匹配', {
      expected: 1,
      actual: 2,
    });
    const text = formatTaskboardError(err);
    expect(text).toContain('[VERSION_CONFLICT]');
    expect(text).toContain('版本不匹配');
    expect(text).toContain('"expected": 1');
  });

  it('非 TaskboardError 走 [INVALID_INPUT] 兜底', () => {
    expect(formatTaskboardError(new Error('boom'))).toBe(
      '[INVALID_INPUT] Error: boom',
    );
  });
});
