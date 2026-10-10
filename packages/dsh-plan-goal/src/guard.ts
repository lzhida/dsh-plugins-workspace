import type { Context } from '@deepseek-ai/cordis';
// 类型引入激活声明合并:ctx.sessionProjections 的类型投影,以及
// SessionProjectionMap 的 'plan' 键(dsh-plan-mode 并入的裁剪视图)
import type {} from '@deepseek-ai/dsh-plan-mode';
import type {} from '@deepseek-ai/dsh-session-projection';
import type { ToolGuard } from '@deepseek-ai/dsh-tools';

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
 * 状态读取走顶层非隔离的 session projection('plan' 键,plan-mode 注册的
 * 裁剪视图 {active, pending}),而不是 planMode 服务——后者被 agent preset
 * 的 planning isolate 组隔离,profile 层插件无论属性访问还是 ctx.get 都
 * 无法触达(会抛 cannot get property ... without inject 或得到 undefined)。
 * 投影键缺席(plan-mode 未挂载)与读取异常一律放行(fail-open):guard 是
 * 保险丝而非主防御,模型侧 authority 判定独立生效。
 *
 * 只拦 create_goal,不拦 update_goal:创建是唯一"武装全新未评审工作"的
 * 转移;resume/steer 路径有直接人类输入兜底。
 *
 * @param ctx cordis Context(宿主在插件作用域内提供,inject 已声明
 *   sessionProjections)
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
    const agent = execution.agent;
    if (agent === undefined) return undefined;
    try {
      const view = ctx.sessionProjections.snapshot(agent.session, ['plan'])
        .values.plan;
      if (view?.active === true || view?.pending === true) return denyReason;
      return undefined;
    } catch {
      // fail-open:投影注册表缺失/'plan' 键未注册(计划域未挂载)/读失败
      return undefined;
    }
  };
}
