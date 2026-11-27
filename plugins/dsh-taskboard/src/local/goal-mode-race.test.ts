/**
 * 服务层契约测试：目标模式与看板启动时序（看板增强系列 5/6 e2e 修正）。
 *
 * 缺陷背景（kanban-e2e 隔离实例实测）：官方目标模式在 `goals.create` 成功后
 * 由 goal-round-driver 起第 1 回合，live agent 的 status 随之从 idle 变 running。
 * 看板启动流程随后有一道「会话正忙 → 判失败并 dispose」的护栏（execution.ts 的
 * busy 判定），它把「我们自己刚开的这一回合」误认成「插队到别人正在跑的会话」
 * → 目标卡 execution=failed、error='scheduled session is busy'，刚起的回合被 abort
 * （turn/end reason=aborted/disposed）。
 *
 * 关键时序（实测校正）：goal-round-driver 的第 1 回合是**异步**起的——
 * `goals.create` 返回那一刻 agent.status 仍是 idle，直到若干 await 之后（写台账
 * 等真实 I/O）才变 running。所以修正必须按 busy 判定点**当时**的 status 复核，
 * 只看模式应用后的瞬时快照会漏判（本仓第一版修正就漏了，e2e 复测仍报 busy）。
 *
 * 本文件锁死修正后的语义：
 * - 目标模式由本次运行自己开回合（idle → running，同步或异步起跑）→ 不判 busy，
 *   正常派发；
 * - 会话在派发前就已经是 running（别人的会话）→ 仍判 busy 失败（旧语义保留）；
 * - 目标服务缺席降级为普通模式时 → 不受该修正影响，仍照常派发。
 */

import { describe, expect, it } from 'vitest';
import { ExecutionService } from '../host/execution.ts';
import type { TaskStore } from '../host/store.ts';
import { createBoardService } from './board-service.ts';
import { createFakeStore, type FakeStore } from './fake-store.ts';
import type { TaskRecord } from '../shared/protocol.ts';

const NOW = 1_700_000_000_000;

/** 让出到宏任务队列（模拟真实落盘 I/O 让异步事件有机会跑）。 */
const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

interface FakeAgent {
  id: string;
  status: 'idle' | 'running';
  injected: unknown[];
  followed: unknown[];
  followup(message: unknown): void;
  inject(message: unknown): void;
  whenIdle(): Promise<void>;
}

interface Harness {
  fake: FakeStore;
  service: ExecutionService;
  agent: FakeAgent;
  dispose(): void;
}

/**
 * 最小 ExecutionDeps：FakeStore + 假 agent + 假官方 goals 服务。
 * @param options.initialStatus - agent 的初始状态（模拟会话在派发前就已忙）。
 * @param options.goalService - 是否提供官方 goals 服务。
 * @param options.goalStart - 官方第 1 回合的起跑时机：'sync' = goals.create 内同步
 *   起跑（status 立刻变 running）；'async' = goals.create 返回后由下一次宏任务
 *   起跑（实测时序：模式应用瞬间仍是 idle）。
 */
function harness(
  options: {
    initialStatus?: 'idle' | 'running';
    goalService?: boolean;
    goalStart?: 'sync' | 'async';
  } = {},
): Harness {
  const fake = createFakeStore();
  const store = {
    ...fake,
    read: async <T>(
      fn: (ledger: ReturnType<FakeStore['snapshot']>) => T,
    ): Promise<T> => {
      await tick();
      return fn(fake.snapshot());
    },
    mutate: async (kind: never, mutator: never) => {
      await tick();
      return (fake.mutate as unknown as (k: never, m: never) => unknown)(
        kind,
        mutator,
      );
    },
    location: () => 'fake-ledger.json',
  } as unknown as TaskStore;
  const agent: FakeAgent = {
    id: 'sess-goal',
    status: options.initialStatus ?? 'idle',
    injected: [],
    followed: [],
    followup(message: unknown): void {
      agent.followed.push(message);
    },
    inject(message: unknown): void {
      agent.injected.push(message);
    },
    whenIdle(): Promise<void> {
      return Promise.resolve();
    },
  };
  const goalStart = options.goalStart ?? 'async';
  const service = new ExecutionService({
    store,
    agents: {
      create: async () => ({
        agent: agent as never,
        dispose: async () => {
          /* noop */
        },
      }),
    } as never,
    workspaces: {
      get: () => ({ id: 'ws-1', path: 'E:/tmp/ws-1' }),
      attach: async () => {
        /* noop */
      },
    },
    events: { onSessionEvent: () => () => undefined },
    now: () => NOW,
    // 官方 goals 服务：create 成功后由 goal-round-driver 起第 1 回合
    //（status idle → running）。
    goals:
      options.goalService === false
        ? undefined
        : () => ({
            create: () => {
              if (goalStart === 'sync') agent.status = 'running';
              else
                setTimeout(() => {
                  agent.status = 'running';
                }, 0);
              return {
                id: 'goal-1',
                objective: 'objective',
                phase: 'active' as const,
                activation: 'armed' as const,
              };
            },
          }),
  });
  return { fake, service, agent, dispose: () => service.dispose() };
}

async function createCard(
  fake: FakeStore,
  taskMode: 'normal' | 'goal',
): Promise<TaskRecord> {
  const board = createBoardService({ store: fake, now: () => NOW });
  const created = await board.createTask({
    title: '目标模式时序验证卡',
    workspaceId: 'ws-1',
    taskMode,
  });
  const task = fake.get(created.id);
  if (task === undefined) throw new Error('created task missing from ledger');
  return task;
}

describe('dsh-taskboard 目标模式启动时序（5/6）', () => {
  it('目标模式：官方 goals.create 内同步起回合（idle→running）时不再判 busy，正常派发', async () => {
    const h = harness({ goalStart: 'sync' });
    try {
      const task = await createCard(h.fake, 'goal');
      const result = await h.service.run(task.id, 'manual');
      expect(result).toMatchObject({ ok: true });
      const execution = h.fake.get(task.id)?.executions[0];
      expect(execution?.outcome).not.toBe('failed');
      expect(execution?.error).toBeUndefined();
      expect(execution?.taskMode).toBe('goal');
      // 首条 framing 与卡片正文都已投进会话。
      expect(h.agent.injected.length).toBeGreaterThan(0);
      expect(h.agent.followed.length).toBeGreaterThan(0);
    } finally {
      h.dispose();
    }
  });

  it('目标模式：第 1 回合异步起跑（模式应用瞬间仍 idle，判定点才 running）时不再判 busy', async () => {
    const h = harness({ goalStart: 'async' });
    try {
      const task = await createCard(h.fake, 'goal');
      const result = await h.service.run(task.id, 'manual');
      expect(result).toMatchObject({ ok: true });
      const execution = h.fake.get(task.id)?.executions[0];
      expect(execution?.outcome).not.toBe('failed');
      expect(execution?.error).toBeUndefined();
      expect(execution?.taskMode).toBe('goal');
      expect(h.agent.status).toBe('running');
    } finally {
      h.dispose();
    }
  });

  it('会话在派发前就已忙（别人的会话）时仍判 busy 失败——旧护栏语义保留', async () => {
    const h = harness({ initialStatus: 'running' });
    try {
      const task = await createCard(h.fake, 'normal');
      const result = await h.service.run(task.id, 'manual');
      expect(result).toEqual({ ok: false, error: 'scheduled session is busy' });
      const execution = h.fake.get(task.id)?.executions[0];
      expect(execution?.outcome).toBe('failed');
      expect(execution?.error).toBe('scheduled session is busy');
    } finally {
      h.dispose();
    }
  });

  it('目标模式下会话在模式应用前就已忙（别人在跑）时仍判 busy——不被目标模式豁免', async () => {
    const h = harness({ initialStatus: 'running', goalStart: 'async' });
    try {
      const task = await createCard(h.fake, 'goal');
      const result = await h.service.run(task.id, 'manual');
      expect(result).toEqual({ ok: false, error: 'scheduled session is busy' });
      const execution = h.fake.get(task.id)?.executions[0];
      expect(execution?.outcome).toBe('failed');
      expect(execution?.error).toBe('scheduled session is busy');
    } finally {
      h.dispose();
    }
  });

  it('目标服务缺席降级为普通模式时照常派发，不受 busy 修正影响', async () => {
    const h = harness({ goalService: false });
    try {
      const task = await createCard(h.fake, 'goal');
      const result = await h.service.run(task.id, 'manual');
      expect(result).toMatchObject({ ok: true });
      const execution = h.fake.get(task.id)?.executions[0];
      expect(execution?.taskMode).toBe('normal');
      expect(execution?.taskModeNote).toContain('官方目标模式服务不可用');
    } finally {
      h.dispose();
    }
  });
});
