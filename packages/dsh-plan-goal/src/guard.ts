import type { Context } from '@deepseek-ai/cordis';
import type { ToolGuard } from '@deepseek-ai/dsh-tools';

/**
 * planMode 服务的最小结构形状:运行时探测用,不依赖声明合并的非可选
 * Context.planMode 类型——plan-mode 未组合进宿主时该能力整体缺席,guard
 * 必须照常放行(fail-open),而不是被类型骗成"一定存在"。
 */
interface PlanModeProbe {
  get(agent: unknown): { active: boolean; pending?: boolean };
  set(agent: unknown, active: boolean): unknown;
}

/**
 * 运行时结构化探测 planMode 服务:缺失返回 undefined,不抛错。命令与
 * guard 共用——plan-mode 未组合进宿主时命令给出可操作错误、guard 放行,
 * 插件自身不因 plan-mode 缺席而 PENDING 或崩溃。
 */
export function probePlanMode(ctx: Context): PlanModeProbe | undefined {
  return (ctx as { planMode?: PlanModeProbe }).planMode;
}

/**
 * create_goal 防抢跑闸(anti-rush guard):
 *
 * plan-active / pending 期间拒绝 create_goal,封死"跳过 plan review 直接
 * 进入 goal 轮"的路径。唯一放行路径是 exit_plan_mode → 用户批准 → 同轮
 * create_goal——批准的翻转在下一被接受的 in-turn pre-step 落盘且先于模型
 * 下一次请求,因此批准后同轮的 create_goal 可正常通过;而批准前一旦漏过,
 * goal-round-driver 会在 agent idle 时自动武装续行,无法回滚,这就是闸门
 * 必须硬拦的原因。
 *
 * fail-open 语义:探测出现任何异常(服务缺失、get 抛错)一律放行——guard
 * 是保险丝而非主防御,模型侧 authority 判定独立生效;且本插件不把
 * planMode 声明进 inject,不绑架未安装 plan-mode 的宿主。
 *
 * 只拦 create_goal,不拦 update_goal:创建是唯一"武装全新未评审工作"的
 * 转移;resume/steer 路径有直接人类输入兜底。
 *
 * @param ctx cordis Context(宿主在插件作用域内提供)
 * @param denyReason 拒绝理由,须可执行(告诉模型正确的解锁路径)
 * @returns 宿主 tools.guard 契约的单调守卫:返回 string 即拒绝,undefined 放行
 */
export function createPlanGoalGuard(
  ctx: Context,
  denyReason: string,
): ToolGuard {
  return (execution) => {
    // 只拦 create_goal;update_goal 等其余工具不经过本闸门
    if (execution.name !== 'create_goal') return undefined;
    // 无调用 agent(无会话上下文)时无从读取计划状态,放行
    const agent: unknown = execution.agent;
    if (agent === undefined) return undefined;
    try {
      const view = probePlanMode(ctx)?.get(agent);
      if (view?.active === true || view?.pending === true) return denyReason;
      return undefined;
    } catch {
      // fail-open:plan-mode 缺失/投影未就绪/get 抛错时不阻塞工具调用
      return undefined;
    }
  };
}
