/**
 * taskMode 全链路测试（看板增强系列 2/6）。
 *
 * 覆盖四层契约：
 * 1. shared/protocol.ts——TaskMode 缺省 / 校验 / 旧卡回落；
 * 2. local/official-modes.ts——applyTaskMode 三模式语义、降级留痕、
 *    goalObjectiveOf 取值与官方服务软读取；
 * 3. local/task-writer.ts——建卡 / 改卡归一化的单一真源；
 * 4. host/tools.ts + host/execution.ts——工具参数贯通、执行期官方调用的
 *    时机（同一 live agent、首条消息前）、normal 卡零官方访问、降级留痕
 *    与 scheduled 会话复用键的模式隔离。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TASK_MODE,
  TASK_MODES,
  normalizeTaskMode,
  taskModeOf,
  type TaskLedger,
} from '../shared/protocol.ts';
import { ExecutionService } from '../host/execution.ts';
import type { TaskStore } from '../host/store.ts';
import { registerTaskboardTools } from '../host/tools.ts';
import { createFakeStore, type FakeStore } from './fake-store.ts';
import {
  GOAL_MODE_UNAVAILABLE_NOTE,
  PLAN_MODE_UNAVAILABLE_NOTE,
  agentRealmCtx,
  appendPlanModeEvent,
  applyTaskMode,
  goalObjectiveOf,
  readGoalsService,
  readPlanModeService,
  type OfficialGoalView,
  type OfficialGoalsService,
  type OfficialPlanModeService,
} from './official-modes.ts';
import {
  createTask,
  resolveTaskMode,
  updateTask,
  type CreateTaskInput,
} from './task-writer.ts';

/** 固定时钟，保证断言可复现。 */
const NOW = 1_700_000_000_000;
/** 测试项目。 */
const WS_ID = 'ws-mode';
/** 测试项目路径。 */
const WS_PATH = 'E:/fake/mode-ws';
/** 非法值的逐字错误文案（协议层与写手层必须一致）。 */
const EXACT_ERROR = 'taskMode must be one of: normal, goal, plan';
/** 用户执行者。 */
const USER = { kind: 'user' } as const;

/** 写手层 deps（fake store 即 LedgerStore）。 */
function writerDeps(base: FakeStore) {
  return {
    store: base,
    now: () => NOW,
    settings: () => base.snapshot().settings,
  };
}

/** 造一张卡，返回任务 id。 */
async function makeCard(
  base: FakeStore,
  input: Partial<CreateTaskInput> = {},
): Promise<string> {
  const created = await createTask(
    {
      title: 'taskMode 测试卡',
      workspaceId: WS_ID,
      urgency: 'normal',
      status: 'todo',
      ...input,
    },
    USER,
    writerDeps(base),
  );
  return created.id;
}

/** 官方 Goal 视图假件。 */
function fakeGoalView(objective: string): OfficialGoalView {
  return { id: 'goal-test-1', objective, phase: 'active', activation: 'armed' };
}

/** planMode.set 的可选返回值。 */
type PlanOutcome = 'committed' | 'queued' | 'cancelled' | 'noop';

/** planMode 假件：service + 独立 spy（便于断言调用参数）。 */
function makePlanMode(outcome: PlanOutcome = 'committed') {
  const set = vi.fn((agent: object, active: boolean): PlanOutcome => {
    void agent;
    void active;
    return outcome;
  });
  const service: OfficialPlanModeService = { set };
  return { service, set };
}

/** goals 假件：service + 独立 spy。 */
function makeGoals() {
  const create = vi.fn(
    (agent: object, request: { objective: string }): OfficialGoalView => {
      void agent;
      return fakeGoalView(request.objective);
    },
  );
  const service: OfficialGoalsService = { create };
  return { service, create };
}

/** planMode 假件（抛错版）。 */
function makeThrowingPlanMode(message: string) {
  const set = vi.fn((agent: object, active: boolean): PlanOutcome => {
    void agent;
    void active;
    throw new Error(message);
  });
  const service: OfficialPlanModeService = { set };
  return { service, set };
}

/** goals 假件（抛错版）。 */
function makeThrowingGoals(message: string) {
  const create = vi.fn(
    (agent: object, request: { objective: string }): OfficialGoalView => {
      void agent;
      void request;
      throw new Error(message);
    },
  );
  const service: OfficialGoalsService = { create };
  return { service, create };
}

/**
 * 执行期测试台：内存台账 + 记录型 agents/workspaces 假件 + 可观察的官方
 * 服务软读取计数。
 */
function harness(
  options: {
    planMode?: OfficialPlanModeService;
    goals?: OfficialGoalsService;
    /** 5/6 e2e 修正：给 live agent 挂一个假会话（plan/mode 事件兜底路径用）。 */
    session?: unknown;
  } = {},
) {
  const base = createFakeStore();
  // ExecutionService 只用 get/snapshot/mutate/read/location；fake-store 没有
  // read/location，这里补齐后按 TaskStore 侧写（mutate 的 kind 运行时不区分
  // 事件名）。
  const store = {
    ...base,
    read: async <T>(fn: (ledger: TaskLedger) => T): Promise<T> =>
      fn(base.snapshot()),
    location: () => 'memory://fake-ledger',
  } as unknown as TaskStore & FakeStore;

  const injected: unknown[] = [];
  const followups: unknown[] = [];
  let lastAgent: object | undefined;
  const agents = {
    create: vi.fn(async (createOptions: { sessionId: string }) => {
      const agent = {
        id: createOptions.sessionId,
        status: 'idle' as const,
        followup: (message: unknown) => {
          followups.push(message);
        },
        inject: (message: unknown) => {
          injected.push(message);
        },
        whenIdle: () => Promise.resolve(),
        ...(options.session !== undefined ? { session: options.session } : {}),
      };
      lastAgent = agent;
      return { agent, dispose: () => Promise.resolve() };
    }),
  };

  // 5/6 修正后的 getter 契约：读取口收到 live agent（执行层把
  // agents.create 返回的实例传进来）。这里记录实参供「同 live 实例」断言。
  const planReadArgs: unknown[] = [];
  const goalReadArgs: unknown[] = [];
  const planReads = vi.fn(
    (agent?: object): OfficialPlanModeService | undefined => {
      planReadArgs.push(agent);
      return options.planMode;
    },
  );
  const goalReads = vi.fn(
    (agent?: object): OfficialGoalsService | undefined => {
      goalReadArgs.push(agent);
      return options.goals;
    },
  );

  const service = new ExecutionService({
    store,
    agents,
    workspaces: {
      get: (id: string) =>
        id === WS_ID ? { id: WS_ID, path: WS_PATH } : undefined,
      attach: () => Promise.resolve(),
    },
    events: { onSessionEvent: () => () => {} },
    now: () => NOW,
    settlementRetryDelaysMs: [],
    planMode: planReads,
    goals: goalReads,
  });
  return {
    service,
    base,
    injected,
    followups,
    agents,
    planReads,
    goalReads,
    planReadArgs,
    goalReadArgs,
    /** agents.create 最近一次返回的 live agent 实例（同 live 断言用）。 */
    lastAgent: () => lastAgent,
    taskOf: (id: string) =>
      base.snapshot().tasks.find((task) => task.id === id),
  };
}

/** 跑一张卡并断言启动成功（结算在后台，不阻塞断言）。 */
async function runCard(
  h: ReturnType<typeof harness>,
  taskId: string,
  trigger: 'manual' | 'scheduled' = 'manual',
): Promise<void> {
  const result = await h.service.run(taskId, trigger);
  expect(result.ok).toBe(true);
}

/** 首条 framing 的文本（inject 的第一条消息）。 */
function framingText(h: ReturnType<typeof harness>): string {
  const message = h.injected[0] as
    { content?: Array<{ text?: string }> } | undefined;
  return message?.content?.[0]?.text ?? '';
}

describe('dsh-taskboard taskMode（看板增强系列 2/6）', () => {
  describe('protocol 协议层', () => {
    it('未指定时缺省为 normal', () => {
      expect(normalizeTaskMode(undefined)).toBe('normal');
      expect(normalizeTaskMode(null)).toBe(DEFAULT_TASK_MODE);
    });

    it('合法值原样生效', () => {
      for (const mode of TASK_MODES) {
        expect(normalizeTaskMode(mode)).toBe(mode);
      }
    });

    it('非法值逐字报错且绝不静默降级', () => {
      expect(() => normalizeTaskMode('once')).toThrowError(EXACT_ERROR);
      expect(() => normalizeTaskMode('')).toThrowError(EXACT_ERROR);
      expect(() => normalizeTaskMode(123)).toThrowError(EXACT_ERROR);
      expect(() => normalizeTaskMode({})).toThrowError(EXACT_ERROR);
    });

    it('旧卡缺字段经 taskModeOf 回落 normal', () => {
      expect(taskModeOf({})).toBe('normal');
      expect(taskModeOf({ taskMode: 'plan' })).toBe('plan');
    });
  });

  describe('official-modes 官方模式适配层', () => {
    it('normal 模式完全不触碰官方服务', () => {
      const plan = makePlanMode();
      const goal = makeGoals();
      const result = applyTaskMode({
        mode: 'normal',
        agent: {},
        planMode: plan.service,
        goals: goal.service,
        objective: '任意',
      });
      expect(result).toEqual({ applied: 'normal' });
      expect(plan.set).not.toHaveBeenCalled();
      expect(goal.create).not.toHaveBeenCalled();
    });

    it('plan 模式调用 planMode.set(agent, true)', () => {
      const agent = { tag: 'live-agent' };
      const plan = makePlanMode();
      const result = applyTaskMode({
        mode: 'plan',
        agent,
        planMode: plan.service,
        objective: 'obj',
      });
      expect(result.applied).toBe('plan');
      expect(result.note).toBeUndefined();
      expect(result.evidence).toContain('planMode.set → committed');
      expect(plan.set).toHaveBeenCalledOnce();
      expect(plan.set).toHaveBeenCalledWith(agent, true);
    });

    it('goal 模式调用 goals.create(agent, { objective })', () => {
      const agent = { tag: 'live-agent' };
      const goal = makeGoals();
      const result = applyTaskMode({
        mode: 'goal',
        agent,
        goals: goal.service,
        objective: '目标陈述',
      });
      expect(result.applied).toBe('goal');
      expect(result.note).toBeUndefined();
      expect(result.evidence).toContain('goal goal-test-1');
      expect(goal.create).toHaveBeenCalledOnce();
      expect(goal.create).toHaveBeenCalledWith(agent, {
        objective: '目标陈述',
      });
    });

    it('plan 服务缺失时降级 normal 并注明', () => {
      const result = applyTaskMode({ mode: 'plan', agent: {}, objective: 'o' });
      expect(result.applied).toBe('normal');
      expect(result.note).toBe(PLAN_MODE_UNAVAILABLE_NOTE);
    });

    it('plan 服务抛错时降级 normal 并注明失败原因', () => {
      const plan = makeThrowingPlanMode('boom');
      const result = applyTaskMode({
        mode: 'plan',
        agent: {},
        planMode: plan.service,
        objective: 'o',
      });
      expect(result.applied).toBe('normal');
      expect(result.note).toBe(
        '官方计划模式服务调用失败（boom），本次以普通模式执行',
      );
    });

    it('plan 服务缺席时改写 plan/mode 事件激活计划模式（e2e 拓扑：服务在 preset realm 内读不到）', () => {
      const append = vi.fn();
      const result = applyTaskMode({
        mode: 'plan',
        agent: {},
        session: { append },
        objective: 'o',
      });
      expect(result.applied).toBe('plan');
      expect(result.note).toBeUndefined();
      expect(result.evidence).toContain('plan/mode');
      expect(append).toHaveBeenCalledOnce();
      expect(append).toHaveBeenCalledWith('plan/mode', { active: true });
    });

    it('plan 服务抛错但事件写入成功时仍激活计划模式', () => {
      const plan = makeThrowingPlanMode('boom');
      const append = vi.fn();
      const result = applyTaskMode({
        mode: 'plan',
        agent: {},
        planMode: plan.service,
        session: { append },
        objective: 'o',
      });
      expect(result.applied).toBe('plan');
      expect(result.note).toBeUndefined();
      expect(append).toHaveBeenCalledOnce();
    });

    it('plan 服务缺席且会话写不了事件时降级 normal 并注明', () => {
      const result = applyTaskMode({
        mode: 'plan',
        agent: {},
        session: {
          append: () => {
            throw new Error('session closed');
          },
        },
        objective: 'o',
      });
      expect(result.applied).toBe('normal');
      expect(result.note).toBe(PLAN_MODE_UNAVAILABLE_NOTE);
    });

    it('appendPlanModeEvent 只在会话可写事件时返回 true', () => {
      expect(appendPlanModeEvent(undefined, true)).toBe(false);
      expect(appendPlanModeEvent(null, true)).toBe(false);
      expect(appendPlanModeEvent({}, true)).toBe(false);
      expect(appendPlanModeEvent({ append: 'nope' }, true)).toBe(false);
      expect(
        appendPlanModeEvent(
          {
            append: () => {
              throw new Error('session closed');
            },
          },
          true,
        ),
      ).toBe(false);
      const append = vi.fn();
      expect(appendPlanModeEvent({ append }, true)).toBe(true);
      expect(append).toHaveBeenCalledWith('plan/mode', { active: true });
    });

    it('goal 服务缺失时降级 normal 并注明', () => {
      const result = applyTaskMode({ mode: 'goal', agent: {}, objective: 'o' });
      expect(result.applied).toBe('normal');
      expect(result.note).toBe(GOAL_MODE_UNAVAILABLE_NOTE);
    });

    it('goal 服务抛 already exists 时注明已有未完成目标', () => {
      const goal = makeThrowingGoals(
        'goal "goal-x" already exists with phase "active"',
      );
      const result = applyTaskMode({
        mode: 'goal',
        agent: {},
        goals: goal.service,
        objective: 'o',
      });
      expect(result.applied).toBe('normal');
      expect(result.note).toBe(
        '官方目标模式服务调用失败（该会话已有未完成目标），本次以普通模式执行',
      );
    });

    it('goalObjectiveOf 取标题+描述且不含 prompt', () => {
      expect(goalObjectiveOf({ title: '标题' })).toBe('标题');
      expect(goalObjectiveOf({ title: ' 标题 ', description: ' 描述 ' })).toBe(
        '标题\n描述',
      );
      // 函数签名根本不收 prompt——目标里没有执行指令的入口。
      const onlyTitleAndDescription: Parameters<typeof goalObjectiveOf>[0] = {
        title: '标题',
        description: '描述',
      };
      expect(goalObjectiveOf(onlyTitleAndDescription)).not.toContain('prompt');
    });

    it('readPlanModeService 软读取：缺失/形状不符/抛错都返回 undefined', () => {
      expect(readPlanModeService(undefined)).toBeUndefined();
      expect(readPlanModeService(null)).toBeUndefined();
      expect(readPlanModeService({})).toBeUndefined();
      expect(readPlanModeService({ reflect: {} })).toBeUndefined();
      expect(
        readPlanModeService({ reflect: { get: () => ({}) } }),
      ).toBeUndefined();
      expect(
        readPlanModeService({
          reflect: {
            get: () => {
              throw new Error('read exploded');
            },
          },
        }),
      ).toBeUndefined();
      // 读取口只认 reflect.get：2/6 初版裸 `ctx.get(name)` 形态（即使存在
      // 也等价 strict=true，且真根因是宿主面禁用 + preset realm 拓扑）必须
      // 读不到服务——软读取契约只走免 inject 的 store 读取。
      const service: OfficialPlanModeService = { set: () => 'committed' };
      expect(readPlanModeService({ get: () => service })).toBeUndefined();
      const seen: Array<[string, boolean | undefined]> = [];
      expect(
        readPlanModeService({
          reflect: {
            get: (name: string, strict?: boolean) => {
              seen.push([name, strict]);
              return service;
            },
          },
        }),
      ).toBe(service);
      expect(seen).toEqual([['planMode', false]]);
    });

    it('readGoalsService 软读取同上', () => {
      expect(readGoalsService(undefined)).toBeUndefined();
      expect(readGoalsService({ reflect: { get: () => 42 } })).toBeUndefined();
      const service: OfficialGoalsService = {
        create: () => fakeGoalView('o'),
      };
      expect(
        readGoalsService({
          reflect: { get: (name: string) => (name === 'goals' ? service : 42) },
        }),
      ).toBe(service);
    });

    it('agentRealmCtx：带合法 ctx 的 agent 原样透传，缺席/形状不符返回 undefined', () => {
      const realm = { reflect: { get: () => undefined } };
      expect(agentRealmCtx({ ctx: realm })).toBe(realm);
      // 无 ctx（rc.1 旧宿主或测试假件）→ undefined，接线侧回落宿主上下文。
      expect(agentRealmCtx({})).toBeUndefined();
      expect(agentRealmCtx({ ctx: undefined })).toBeUndefined();
      expect(agentRealmCtx({ ctx: null })).toBeUndefined();
      expect(agentRealmCtx({ ctx: 'not-a-context' })).toBeUndefined();
      expect(agentRealmCtx({ ctx: {} })).toBeUndefined();
      expect(agentRealmCtx({ ctx: { reflect: {} } })).toBeUndefined();
      expect(agentRealmCtx({ ctx: { reflect: null } })).toBeUndefined();
      expect(agentRealmCtx({ ctx: { reflect: { get: 42 } } })).toBeUndefined();
      // 非 agent 输入一律 undefined（绝不抛错）。
      expect(agentRealmCtx(undefined)).toBeUndefined();
      expect(agentRealmCtx(null)).toBeUndefined();
      expect(agentRealmCtx('agent')).toBeUndefined();
      expect(agentRealmCtx(42)).toBeUndefined();
    });
  });

  describe('task-writer 写手层', () => {
    it('建卡缺省写入 normal 且摘要携带', async () => {
      const base = createFakeStore();
      const summary = await createTask(
        { title: '缺省模式', workspaceId: WS_ID, urgency: 'normal' },
        USER,
        writerDeps(base),
      );
      expect(summary.taskMode).toBe('normal');
      expect(base.get(summary.id)?.taskMode).toBe('normal');
    });

    it('建卡接受 goal / plan 并落盘', async () => {
      for (const mode of ['goal', 'plan'] as const) {
        const base = createFakeStore();
        const summary = await createTask(
          {
            title: `${mode}卡`,
            workspaceId: WS_ID,
            urgency: 'normal',
            taskMode: mode,
          },
          USER,
          writerDeps(base),
        );
        expect(summary.taskMode).toBe(mode);
        expect(base.get(summary.id)?.taskMode).toBe(mode);
      }
    });

    it('建卡非法值逐字报错', async () => {
      const base = createFakeStore();
      await expect(
        createTask(
          {
            title: '写错模式',
            workspaceId: WS_ID,
            urgency: 'normal',
            taskMode: 'hyper',
          },
          USER,
          writerDeps(base),
        ),
      ).rejects.toThrowError(EXACT_ERROR);
    });

    it('改卡仅在提供 taskMode 时覆盖', async () => {
      const base = createFakeStore();
      const id = await makeCard(base, { taskMode: 'plan' });
      // 省略 → 保持原值。
      const kept = await updateTask(
        { id, ifVersion: 1 },
        USER,
        writerDeps(base),
      );
      expect(kept.taskMode).toBe('plan');
      // 提供 → 覆盖。
      const changed = await updateTask(
        { id, ifVersion: kept.version, taskMode: 'normal' },
        USER,
        writerDeps(base),
      );
      expect(changed.taskMode).toBe('normal');
    });

    it('改卡非法值逐字报错', async () => {
      const base = createFakeStore();
      const id = await makeCard(base);
      await expect(
        updateTask(
          { id, ifVersion: 1, taskMode: 'scheduled' },
          USER,
          writerDeps(base),
        ),
      ).rejects.toThrowError(EXACT_ERROR);
    });

    it('resolveTaskMode 与协议层同源', () => {
      expect(resolveTaskMode(undefined)).toBe('normal');
      expect(resolveTaskMode('goal')).toBe('goal');
      expect(() => resolveTaskMode('once')).toThrowError(EXACT_ERROR);
    });
  });

  describe('host/tools 工具层', () => {
    /** 注册全部工具并捕获定义，便于直接调用 execute。 */
    function toolHarness(base: FakeStore) {
      const registered: Array<{
        name: string;
        execute: (args: unknown, exec: unknown) => Promise<unknown>;
      }> = [];
      const disposers = registerTaskboardTools(
        {
          tools: {
            register: (tool: { name: string }) =>
              registered.push(
                tool as {
                  name: string;
                  execute: (args: unknown, exec: unknown) => Promise<unknown>;
                },
              ),
          },
        },
        {
          store: base as unknown as TaskStore,
          now: () => NOW,
          workspaces: {
            get: (id: string) =>
              id === WS_ID
                ? { id: WS_ID, path: WS_PATH, title: WS_ID }
                : undefined,
            list: () => [{ id: WS_ID, path: WS_PATH, title: WS_ID }],
            resolveByPath: async () => undefined,
          },
        },
      );
      const byName = (name: string) =>
        registered.find((tool) => tool.name === name)!;
      return { base, byName, disposers };
    }

    const CALLER = { agent: { id: 'caller-1' } };

    it('taskboard_create 接受 taskMode 并落盘', async () => {
      const { base, byName } = toolHarness(createFakeStore());
      const result = (await byName('taskboard_create').execute(
        {
          title: '工具建卡',
          workspaceId: WS_ID,
          urgency: 'normal',
          taskMode: 'plan',
        },
        CALLER,
      )) as { task: { id: string; taskMode?: string } };
      expect(result.task.taskMode).toBe('plan');
      expect(base.get(result.task.id)?.taskMode).toBe('plan');
    });

    it('taskboard_update 接受 taskMode 并覆盖', async () => {
      const { base, byName } = toolHarness(createFakeStore());
      const id = await makeCard(base, { taskMode: 'plan' });
      const result = (await byName('taskboard_update').execute(
        { id, ifVersion: 1, taskMode: 'goal' },
        CALLER,
      )) as { task: { taskMode?: string; version: number } };
      expect(result.task.taskMode).toBe('goal');
      expect(base.get(id)?.taskMode).toBe('goal');
    });

    it('taskboard_create 非法 taskMode 被写手层拒绝', async () => {
      const { byName } = toolHarness(createFakeStore());
      await expect(
        byName('taskboard_create').execute(
          {
            title: '写错模式',
            workspaceId: WS_ID,
            urgency: 'normal',
            taskMode: 'claim',
          },
          CALLER,
        ),
      ).rejects.toThrowError(EXACT_ERROR);
    });
  });

  describe('host/execution 执行期', () => {
    it('normal 卡完全不软读也不调用官方模式服务', async () => {
      const plan = makePlanMode();
      const goal = makeGoals();
      const h = harness({ planMode: plan.service, goals: goal.service });
      const id = await makeCard(h.base);
      await runCard(h, id);

      expect(h.planReads).not.toHaveBeenCalled();
      expect(h.goalReads).not.toHaveBeenCalled();
      const execution = h.taskOf(id)!.executions[0]!;
      expect(execution.taskMode).toBe('normal');
      expect(execution.taskModeNote).toBeUndefined();
    });

    it('plan 卡对 agents.create 的同一 live agent 调 planMode.set(agent, true)', async () => {
      const plan = makePlanMode();
      const goal = makeGoals();
      const h = harness({ planMode: plan.service, goals: goal.service });
      const id = await makeCard(h.base, { taskMode: 'plan' });
      await runCard(h, id);

      expect(h.planReads).toHaveBeenCalledOnce();
      // 5/6 修正后的读取拓扑：读取口必须收到 agents.create 的同一 live agent
      // （服务软读走 agent 的会话 realm ctx）。
      expect(h.planReadArgs[0]).toBe(h.lastAgent());
      expect(plan.set).toHaveBeenCalledOnce();
      const [calledAgent, active] = plan.set.mock.calls[0]!;
      expect(active).toBe(true);
      // 硬时序：官方调用拿到的必须是 agents.create 返回的同一 live 实例。
      expect(calledAgent).toBe(h.lastAgent());
      const execution = h.taskOf(id)!.executions[0]!;
      expect(execution.taskMode).toBe('plan');
      expect(execution.taskModeNote).toBeUndefined();
      expect(goal.create).not.toHaveBeenCalled();
    });

    it('goal 卡对同一 live agent 调 goals.create 且 objective=标题+描述', async () => {
      const goal = makeGoals();
      const h = harness({ goals: goal.service });
      const id = await makeCard(h.base, {
        taskMode: 'goal',
        description: '把三种执行模式接进看板',
        prompt: '这份执行指令不该进 objective',
      });
      await runCard(h, id);

      expect(h.goalReads).toHaveBeenCalledOnce();
      expect(h.goalReadArgs[0]).toBe(h.lastAgent());
      expect(goal.create).toHaveBeenCalledOnce();
      const [calledAgent, request] = goal.create.mock.calls[0]!;
      expect(calledAgent).toBe(h.lastAgent());
      expect(request.objective).toBe(`taskMode 测试卡\n把三种执行模式接进看板`);
      expect(request.objective).not.toContain('执行指令');
      const execution = h.taskOf(id)!.executions[0]!;
      expect(execution.taskMode).toBe('goal');
      expect(execution.taskModeNote).toBeUndefined();
    });

    it('plan 服务缺失时降级 normal、写 taskModeNote 并继续执行', async () => {
      const h = harness({}); // planMode 软读取恒 undefined
      const id = await makeCard(h.base, { taskMode: 'plan' });
      await runCard(h, id);

      expect(h.planReads).toHaveBeenCalledOnce();
      const execution = h.taskOf(id)!.executions[0]!;
      expect(execution.taskMode).toBe('normal');
      expect(execution.taskModeNote).toBe(PLAN_MODE_UNAVAILABLE_NOTE);
      // 降级绝不静默：framing 里带 ⚠ 说明。
      expect(framingText(h)).toContain(PLAN_MODE_UNAVAILABLE_NOTE);
      expect(h.injected.length).toBe(1);
      expect(h.followups.length).toBe(1);
    });

    it('plan 服务抛错时降级并写明原因', async () => {
      const plan = makeThrowingPlanMode('registry exploded');
      const h = harness({ planMode: plan.service });
      const id = await makeCard(h.base, { taskMode: 'plan' });
      await runCard(h, id);

      const execution = h.taskOf(id)!.executions[0]!;
      expect(execution.taskMode).toBe('normal');
      expect(execution.taskModeNote).toBe(
        '官方计划模式服务调用失败（registry exploded），本次以普通模式执行',
      );
      expect(framingText(h)).toContain('registry exploded');
    });

    it('plan 卡在服务缺席时改写官方 plan/mode 事件激活计划模式（e2e 回归）', async () => {
      const append = vi.fn();
      const h = harness({ session: { append } }); // planMode 软读取恒 undefined
      const id = await makeCard(h.base, { taskMode: 'plan' });
      await runCard(h, id);

      expect(h.planReads).toHaveBeenCalledOnce();
      expect(append).toHaveBeenCalledOnce();
      expect(append).toHaveBeenCalledWith('plan/mode', { active: true });
      const execution = h.taskOf(id)!.executions[0]!;
      expect(execution.taskMode).toBe('plan');
      expect(execution.taskModeNote).toBeUndefined();
    });

    it('goal 服务缺失时降级并继续执行', async () => {
      const h = harness({}); // goals 软读取恒 undefined
      const id = await makeCard(h.base, { taskMode: 'goal' });
      await runCard(h, id);

      expect(h.goalReads).toHaveBeenCalledOnce();
      const execution = h.taskOf(id)!.executions[0]!;
      expect(execution.taskMode).toBe('normal');
      expect(execution.taskModeNote).toBe(GOAL_MODE_UNAVAILABLE_NOTE);
      expect(h.injected.length).toBe(1);
    });

    it('scheduled 会话复用键随 taskMode 变化', async () => {
      const h = harness({});
      const normalId = await makeCard(h.base, {
        title: '普通定时卡',
        execution: { mode: 'scheduled', cron: '0 9 * * *' },
      });
      const planId = await makeCard(h.base, {
        title: '计划定时卡',
        taskMode: 'plan',
        execution: { mode: 'scheduled', cron: '0 9 * * *' },
      });
      await runCard(h, normalId, 'scheduled');
      await runCard(h, planId, 'scheduled');

      const normalKey = h.taskOf(normalId)!.executions[0]!.sessionReuseKey;
      const planKey = h.taskOf(planId)!.executions[0]!.sessionReuseKey;
      expect(normalKey).toBeDefined();
      expect(planKey).toBeDefined();
      // 模式是 key 的组成部分：模式不同 → 会话绝不复用。
      expect(normalKey).toContain('"normal"');
      expect(planKey).toContain('"plan"');
      expect(normalKey).not.toBe(planKey);
    });
  });
});
