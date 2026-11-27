/**
 * 官方计划模式 / 目标模式服务的软依赖适配层（看板增强系列 2/6）。
 *
 * DSH 官方的会话创建 API **没有**任何 mode 参数（官方
 * @deepseek-ai/dsh-api-session-controller 的 ApiSessionCreateRequest 只有
 * sessionId?/cwd/agentPreset?/reusable；@deepseek-ai/dsh-agent 的
 * CreateAgentOptions 也没有 mode），因此「计划模式 / 目标模式」只能这样接：
 *
 * 1. 官方计划模式 = 每个 Agent 的持久日志状态 `plan/mode{active}`，入口是
 *    `@deepseek-ai/dsh-plan-mode` 提供的 `planMode` 服务（服务名见其
 *    src/index.ts:191 `super(ctx, 'planMode')`）：
 *    `planMode.set(agent, true)`（src/index.ts:432-452）。无 open turn 时
 *    立即落 `plan/mode` 事件并返回 'committed'（:447-451）；有 open turn 时
 *    挂 pending，等下一次 in-turn pre-step 生效（:437-440）。
 *    **该服务只挂在每会话 preset realm 内**（宿主面 patch 显式禁用 plan-mode
 *    行，预设用 `cordis:group` + `isolate: { planMode: true }` 挂载），宿主上下文
 *    与 agent.ctx 都读不到它（5/6 e2e 实测）。但官方计划状态的**真身是会话投影**
 *    ——`planProjectionDefinition.apply` 折叠 `plan/mode` 事件、控制器读的是
 *    `planProjectionHandle.stateOf(session)`（:395-400），而 `set()` 在无开环回合
 *    时做的正是 `session.append('plan/mode', { active })`（:446）。故本模块的
 *    plan 路径做成**双轨**：服务读得到就走 `planMode.set(agent, true)`；读不到就
 *    直接写同一条 `plan/mode` 事件（appendPlanModeEvent）——投影折叠后 realm 内
 *    控制器同样转 active，plan:policy 提示段与 exit_plan_mode 条件工具随之生效。
 * 2. 官方目标模式 = 持久 Goal 对象 + armed activation，由 goal-round-driver
 *    自动续跑，入口是 `@deepseek-ai/dsh-goal` 提供的 `goals` 服务（服务名见其
 *    src/index.ts:251 `super(ctx, 'goals')`）：
 *    `goals.create(agent, { objective })`（src/index.ts:307-323），返回的
 *    GoalView.phase 为 'active'（:319），activation 为 'armed'（:322）。
 *    该服务的 assertLive（src/index.ts:473-475）要求传入的必须是 registry 里
 *    **同一个 live agent 实例**——所以调用必须紧跟在 agents.create resolve
 *    之后，不能延后到消息注入阶段。
 *
 * 本模块只声明官方服务的**结构类型**并做软读取——不 import 官方包（宿主半区
 * 禁止运行时 @deepseek-ai 引用，见 package-contract.test.ts）；服务缺席或调用
 * 抛错时返回可见的降级说明，由调用方写进执行记录（execution.taskModeNote），
 * 绝不静默失败，也绝不阻塞任务执行。
 */

import type { TaskMode } from '../shared/protocol.ts';

/** 官方 planMode 服务的最小结构面：本插件只用 set。 */
export interface OfficialPlanModeService {
  /**
   * 选择是否进入计划模式。
   * @param agent - 目标 live agent（必须是 registry 里的同一实例）。
   * @param active - true 进入计划模式。
   * @returns 'committed'（已落日志）| 'queued'（等下一次 pre-step）|
   *   'cancelled' | 'noop'。
   */
  set(
    agent: object,
    active: boolean,
  ): 'committed' | 'queued' | 'cancelled' | 'noop';
}

/** 官方 Goal 视图的最小结构面（本插件只读这几个字段）。 */
export interface OfficialGoalView {
  /** 目标 id（官方形如 `goal-<uuid>`）。 */
  id: string;
  /** 目标陈述。 */
  objective: string;
  /** 持久阶段：'active' 表示正在推进。 */
  phase: 'active' | 'paused' | 'blocked' | 'complete';
  /** 进程内续跑许可（'armed' 才会被 goal-round-driver 自动续跑）。 */
  activation?: 'armed' | 'disarmed';
}

/** 官方 goals 服务的最小结构面：本插件只用 create。 */
export interface OfficialGoalsService {
  /**
   * 创建并 arm 一个目标。
   * @param agent - 目标 live agent（assertLive 约束：同一 live 实例）。
   * @param request - objective 与可选的轮次上限。
   * @returns 新建的 Goal 视图（phase='active'）。
   */
  create(
    agent: object,
    request: { objective: string; maxGoalRounds?: number },
  ): OfficialGoalView;
}

/**
 * 从 live agent 面上取「会话 realm」上下文（软依赖适配，绝不抛错）。
 *
 * 5/6 e2e 定位的官方拓扑（rc.5）：@deepseek-ai/dsh-web-app 的宿主面 patch
 * 显式 `disabled: true` 了 plan-mode / command-goal / tool-goal 行，注释写明
 * 「Presets own the human command and model-facing tool」——官方 standard
 * 预设在每会话组合里用 `cordis:group` + `isolate: { planMode: true }` 挂载
 * plan-mode（realm 内服务，宿主上下文永远读不到）；goals 域服务则留在宿主面。
 * ReactLoopAgent 的 `ctx`（dsh-agent-loop src/agent.ts:122 public readonly
 * ctx = createScope(loopCtx, this).ctx）继承会话 realm 的 isolate 链，是
 * realm 内服务唯一可靠的读取口。宿主面服务（goals）经同一根 store 的
 * isolate 链解析，agent.ctx 同样读得到；读取不到或形状不符返回 undefined，
 * 调用方再回落宿主上下文。
 */
export function agentRealmCtx(agent: unknown): unknown {
  if (agent === undefined || agent === null || typeof agent !== 'object') {
    return undefined;
  }
  const ctx = (agent as { ctx?: unknown }).ctx;
  if (ctx === undefined || ctx === null || typeof ctx !== 'object') {
    return undefined;
  }
  const reflect = (ctx as { reflect?: unknown }).reflect;
  if (
    reflect === undefined ||
    reflect === null ||
    typeof reflect !== 'object' ||
    typeof (reflect as { get?: unknown }).get !== 'function'
  ) {
    return undefined;
  }
  return ctx;
}

/**
 * 软读取官方 planMode 服务：在 cordis 作用域上 `reflect.get('planMode', false)`
 * （免 inject 的 store 读取），服务缺席、形状不匹配或读取抛错一律返回
 * undefined（调用方降级，绝不抛出）。planMode 挂在每会话 preset realm 内，
 * 优先传 `agentRealmCtx(agent)`，宿主上下文仅作 goals 等宿主面服务的回落。
 */
export function readPlanModeService(
  scope: unknown,
): OfficialPlanModeService | undefined {
  return readService<OfficialPlanModeService>(scope, 'planMode', 'set');
}

/**
 * 软读取官方 goals 服务：在 cordis 作用域上 `reflect.get('goals', false)`
 * （免 inject 的 store 读取），服务缺席、形状不匹配或读取抛错一律返回
 * undefined（调用方降级，绝不抛出）。goals 挂在宿主面（官方拓扑），宿主
 * 上下文可读；传 `agentRealmCtx(agent)` 经共享根 store 同样可读。
 */
export function readGoalsService(
  scope: unknown,
): OfficialGoalsService | undefined {
  return readService<OfficialGoalsService>(scope, 'goals', 'create');
}

/**
 * 软读取一个官方服务：形状必须带指定方法名。
 *
 * 读取口是 `ctx.reflect.get(name, strict)`（cordis ReflectService：「Read a
 * service from the store without the inject requirement」）：Context 是
 * Proxy，裸属性读取 `ctx[name]` 走 inject 校验（未声明 inject 抛
 * `cannot get property "<name>" without inject`）；`ctx.get(name)` 存在但
 * 等价 `reflect.get(name, true)`——strict=true 要求提供方 fiber 处于
 * active 状态，`strict=false` 只查 store，读取时机无妨。
 *
 * **服务真的缺席时这里同样返回 undefined**——2/6→5/6 的 e2e 降级根因不是
 * 读取 API，而是官方拓扑：宿主面 patch 禁用了 plan-mode 等行，服务只挂在
 * 每会话 preset realm（见 agentRealmCtx 的文档），宿主上下文永远读不到。
 */
function readService<T>(
  scope: unknown,
  name: string,
  method: string,
): T | undefined {
  if (scope === undefined || scope === null) return undefined;
  const face = scope as {
    reflect?: { get?(name: string, strict?: boolean): unknown };
  };
  try {
    const service = face.reflect?.get?.(name, false);
    if (
      service !== undefined &&
      service !== null &&
      typeof (service as Record<string, unknown>)[method] === 'function'
    ) {
      return service as T;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 目标模式的 objective 取值（看板增强系列 2/6 的实现决策）。
 *
 * 取 **卡片标题 + 卡片描述**：
 * - 标题是「一句话说清要做什么」，是目标的第一句陈述；
 * - 描述补充范围与验收口径，仍是「要达成什么」而不是「怎么做」；
 * - 刻意**不**把执行 Prompt 拼进来——Prompt 是本次执行的指令集，已经由首条
 *   用户消息（标题+描述+Prompt）投递进会话日志，后续 goal 轮次仍能看到它；
 *   若再塞进 objective，goal-round-driver 的每轮续跑都会重复这份长指令，反而
 *   让「目标」失焦。
 */
export function goalObjectiveOf(task: {
  title: string;
  description?: string;
}): string {
  const title = task.title.trim();
  const description = (task.description ?? '').trim();
  if (description.length === 0) return title;
  return `${title}\n${description}`;
}

/** 一次模式应用的结果。 */
export interface TaskModeApplication {
  /** 实际生效的模式（降级时恒为 'normal'）。 */
  applied: TaskMode;
  /** 降级说明（仅降级时存在；调用方写进 execution.taskModeNote）。 */
  note?: string;
  /** 官方调用结果的可读证据（仅成功时存在；便于验收取证）。 */
  evidence?: string;
}

/** 官方计划模式服务缺席**且**无法写入 plan/mode 事件**时的降级说明。 */
export const PLAN_MODE_UNAVAILABLE_NOTE =
  '官方计划模式服务不可用（当前预设组合未提供 plan-mode 服务，且会话不接受 plan/mode 事件），本次以普通模式执行';

/** 官方目标模式服务缺席时的降级说明。 */
export const GOAL_MODE_UNAVAILABLE_NOTE =
  '官方目标模式服务不可用（当前宿主或预设未提供 goals 服务），本次以普通模式执行';

/**
 * 写入官方的 `plan/mode` 会话事件（计划模式的**兜底激活路径**）。
 *
 * 官方计划模式的**状态本身就是一个会话投影**：`planProjectionDefinition.apply`
 * 折叠 `plan/mode` 事件（plan-mode src/index.ts:135-167），控制器读的是
 * `planProjectionHandle.stateOf(session)`（:395-400），而 `set()` 在没有开环回合
 * 时做的正是 `session.append('plan/mode', { active })`（:446）。因此宿主直接写
 * 这条事件与调用 `planMode.set(agent, true)` **等效**：投影折叠出 active=true 后，
 * 预设 realm 内的控制器 `loggedActive()` 随之转真——`plan:policy` 提示段
 * （:197-204）与条件工具 exit_plan_mode（:375）随之生效。
 *
 * 这条路径不依赖 realm 内的服务句柄，是宿主面唯一可用的激活方式（5/6 e2e 实测：
 * planMode 服务挂在每会话 preset realm 内，宿主 ctx 与 agent.ctx 都读不到）。
 *
 * @param session - 官方 Session 对象（结构断言，不 import 官方包）。
 * @param active - true 进入计划模式，false 退出。
 * @returns 是否成功写入（失败由调用方降级，绝不抛错）。
 */
export function appendPlanModeEvent(
  session: unknown,
  active: boolean,
): boolean {
  if (
    session === undefined ||
    session === null ||
    typeof session !== 'object'
  ) {
    return false;
  }
  const append = (session as { append?: unknown }).append;
  if (typeof append !== 'function') return false;
  try {
    (append as (type: string, data: unknown) => unknown).call(
      session,
      'plan/mode',
      { active },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 按任务模式调用官方能力；**绝不抛错**。
 *
 * - `normal`：完全不碰官方模式服务（普通卡不触发任何官方模式调用）；
 * - `plan`：优先 `planMode.set(agent, true)`；服务不可达时退回写官方
 *   `plan/mode` 会话事件（见 appendPlanModeEvent——官方状态机以该事件为准，
 *   两者等效）；
 * - `goal`：`goals.create(agent, { objective })`。
 *
 * 服务缺席或调用抛错 → 返回降级说明（note），由调用方写入执行记录并以普通
 * 模式继续执行；绝不静默失败。
 */
export function applyTaskMode(options: {
  /** 卡片声明的模式。 */
  mode: TaskMode;
  /** 目标 live agent（必须与 registry 里的实例一致）。 */
  agent: object;
  /** 官方 planMode 服务（缺席即走事件兜底路径）。 */
  planMode?: OfficialPlanModeService | undefined;
  /** 官方 goals 服务（缺席即降级）。 */
  goals?: OfficialGoalsService | undefined;
  /** 目标 live agent 的会话对象（plan 事件兜底路径要往它身上写 plan/mode）。 */
  session?: unknown;
  /** 目标模式的 objective（由 goalObjectiveOf 产出）。 */
  objective: string;
}): TaskModeApplication {
  const { mode, agent } = options;
  if (mode === 'normal') return { applied: 'normal' };
  if (mode === 'plan') {
    const planMode = options.planMode;
    if (planMode !== undefined) {
      try {
        const outcome = planMode.set(agent, true);
        return { applied: 'plan', evidence: `planMode.set → ${outcome}` };
      } catch (error) {
        // 服务在场却调用失败：仍可退回事件路径——官方状态机以 plan/mode 事件为准。
        if (appendPlanModeEvent(options.session, true)) {
          return {
            applied: 'plan',
            evidence: 'plan/mode 事件（会话投影折叠）',
          };
        }
        return {
          applied: 'normal',
          note: `官方计划模式服务调用失败（${detailOf(error)}），本次以普通模式执行`,
        };
      }
    }
    // 服务不可达（plan-mode 挂在每会话 preset realm 内，宿主面读不到）：
    // 直接写官方 plan/mode 事件——投影折叠后 realm 内控制器同样转 active。
    if (appendPlanModeEvent(options.session, true)) {
      return { applied: 'plan', evidence: 'plan/mode 事件（会话投影折叠）' };
    }
    return { applied: 'normal', note: PLAN_MODE_UNAVAILABLE_NOTE };
  }
  const goals = options.goals;
  if (goals === undefined) {
    return { applied: 'normal', note: GOAL_MODE_UNAVAILABLE_NOTE };
  }
  try {
    const view = goals.create(agent, { objective: options.objective });
    return {
      applied: 'goal',
      evidence: `goals.create → goal ${view.id} phase=${view.phase}${
        view.activation === undefined ? '' : ` activation=${view.activation}`
      }`,
    };
  } catch (error) {
    const detail = detailOf(error);
    const reason = detail.includes('already exists')
      ? '该会话已有未完成目标'
      : detail;
    return {
      applied: 'normal',
      note: `官方目标模式服务调用失败（${reason}），本次以普通模式执行`,
    };
  }
}

/** 提取一条可读的失败详情（官方错误多半是带文本的 Error）。 */
function detailOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
