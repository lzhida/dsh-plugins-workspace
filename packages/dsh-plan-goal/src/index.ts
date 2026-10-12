import type { Context } from '@deepseek-ai/cordis';
// 引入包内类型即激活其 cordis Context declaration merging(ctx.commands /
// ctx.tools 的类型投影);运行时由宿主提供,仅 import type
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-tools';
import Schema from '@deepseek-ai/schemastery';
import { checkConsistency } from './consistency.ts';
import { createPlanGoalGuard } from './guard.ts';
import { buildPlanGoalMessage } from './protocol.ts';

export const name = 'dsh-plan-goal';
export const inject = ['commands', 'tools', 'sessionProjections'];

/**
 * dsh-plan-goal:plan mode × goal 的缝合(stitch-in)插件,不融合两侧:
 *
 * - `/plan-goal <draft>`:一条命令完成「开计划模式 → 注入协议 →
 *   exit_plan_mode 审阅 → 批准后同轮 create_goal」。协议要求先调研后设计,
 *   计划文档内嵌五字段 goal 块(Objective / Success criteria / Verification /
 *   Boundaries / Stop conditions),批准前 create_goal 被 guard 拒绝。
 * - create_goal 防抢跑闸:plan-active / pending 期间拒绝 create_goal,把
 *   「跳过 plan review 直接进入 goal 轮」的路径封死(唯一放行路径是批准后
 *   同轮创建);状态经顶层非隔离的 session projection('plan' 键)读取,
 *   键缺席(plan-mode 未挂载)或读失败时放行,不绑架宿主。
 *
 * planMode 服务本身被 agent preset 的 planning isolate 组隔离,profile 层
 * 插件无法直接触达;因此开计划模式走 ctx.commands.find(agent, 'plan') 转调
 * plan-mode 自身注册的 /plan 命令(其 handler 闭包持有服务),读状态走
 * session projection——两条路径都是宿主公开 API。sessionProjections 声明
 * 进 inject(dsh 读取方的官方要求;该服务在 dsh-base bundle 恒在)。
 *
 * 内容闸(warn-only):guard 是时序闸,批准后 objective 若丢失了已审计划的
 * ## 字段结构,由 tools/result 监听做标题级一致性比对并 logger.warn——
 * 只报偏离不阻断,语义级忠实性仍由人审环节把关。
 *
 * 配置(dsh 静态 Config 声明):`Config` 导出名声明 schema,cordis/loader
 * 投影成设置表单;apply 第二参收到已校验普通值。三项均非 volatile,变更时
 * loader 重载本插件、apply 重跑即完成同步——无需 watch、无需订阅。
 */

export interface PlanGoalConfig {
  /** /plan-goal 命令开关(guard 不受其影响) */
  enabled: boolean;
  /** create_goal 防抢跑闸开关(命令不受其影响) */
  guard: boolean;
  /** 命令文案语言:auto=跟随 dsh 语言偏好,zh/en=固定单语言 */
  language: 'auto' | 'zh' | 'en';
}

/**
 * 插件配置 schema(以 loader 约定的 `Config` 导出名声明,投影成设置表单;
 * 插件行经 patch 插入时不带 config,靠此处 default 兜底:enabled=true /
 * guard=true / language='auto')。
 */
export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('Enable /plan-goal command / 启用计划式目标命令'),
  guard: Schema.boolean()
    .default(true)
    .description(
      'Deny create_goal while plan mode is active / 计划期间拒绝 create_goal',
    ),
  language: Schema.union(['auto', 'zh', 'en'])
    .default('auto')
    .description(
      'Command text language: auto follows dsh preference / 命令文案语言',
    ),
});

type ConfigLanguage = PlanGoalConfig['language'];

/** describe() 描述符的最小形状:只关心 value 里的语言偏好字段。 */
type SettingsDescribeShape = Array<{ value?: unknown }>;

/**
 * 解析命令文案语言:配置非 auto 直接采用;auto 时扫描任一 settings
 * descriptor 的 value.preference(zh/en)。settings 服务缺失、describe
 * 不可调用或抛错均回退 auto(双语)。
 */
export function resolveLanguage(
  ctx: Context,
  configured: ConfigLanguage,
): ConfigLanguage {
  if (configured !== 'auto') return configured;
  try {
    const describe = (
      ctx as unknown as {
        settings?: { describe?: () => SettingsDescribeShape };
      }
    ).settings?.describe;
    for (const descriptor of describe?.() ?? []) {
      const preference = (
        descriptor.value as { preference?: unknown } | undefined
      )?.preference;
      if (preference === 'zh' || preference === 'en') return preference;
    }
  } catch {
    // describe 缺失/抛错:回退双语兜底
  }
  return 'auto';
}

interface CommandTexts {
  planGoalDescription: string;
  planGoalHint: string;
  planGoalUsage: string;
  planGoalSuccess: string;
  planModeMissing: string;
  denyReason: string;
}

/** 按 language 配置生成命令文案与 guard 拒绝理由:auto=双语,zh/en=单语言。 */
export function commandTexts(language: ConfigLanguage): CommandTexts {
  const both = (enText: string, zhText: string): string =>
    language === 'zh'
      ? zhText
      : language === 'en'
        ? enText
        : `${enText} · ${zhText}`;
  return {
    planGoalHint: '[<draft>]',
    planGoalDescription: both(
      'Plan-first goal creation for large or ambiguous tasks: research first, embed a five-field goal block (objective / success criteria / verification / boundaries / stop conditions) in the plan, and create_goal in the same turn after the plan is approved. For small tasks use /guided-goal; for plain planning without a goal use /plan',
      '计划式创建 goal,适用于大型或含糊任务:先调研,把五字段块(目标/成功标准/验证方式/边界/停止条件)内嵌进计划,经审阅批准后同轮 create_goal。小任务请用 /guided-goal;纯规划(不建 goal)直接用 /plan',
    ),
    planGoalUsage: both(
      'Usage: /plan-goal [<draft>]',
      '用法:/plan-goal [<草稿目标>]',
    ),
    planGoalSuccess: both(
      'Plan-goal started: research first, embed the five-field goal block in the plan and submit it via exit_plan_mode; create_goal unlocks after approval. Give up with /plan off.',
      '已启动 plan-goal 流程:先调研,把五字段 goal 块内嵌进计划并经 exit_plan_mode 提交审阅;批准后同轮 create_goal 解锁。放弃可用 /plan off。',
    ),
    planModeMissing: both(
      "This session's agent preset provides no /plan command (plan-mode is not mounted with the preset, e.g. minimal); switch to the standard preset and retry",
      '当前会话的 agent preset 未提供 /plan 命令(plan-mode 未随 preset 挂载,如 minimal);请切换到 standard 等 preset 后重试',
    ),
    denyReason: both(
      'create_goal is denied while plan mode is active or pending: present or revise the plan via exit_plan_mode first; create_goal unlocks after approval',
      '计划模式激活期间禁止创建 goal：请先经 exit_plan_mode 提交/修订计划，批准后 create_goal 解锁',
    ),
  };
}

export function apply(
  ctx: Context,
  config: Partial<PlanGoalConfig> = {},
): void {
  console.log(`[${name}] plugin loaded`);

  ctx.effect(() => {
    const language = resolveLanguage(ctx, config.language ?? 'auto');
    const t = commandTexts(language);
    if (config.enabled !== false) {
      // register 的 disposer 经 layers.effect 自动附着到插件作用域,卸载即
      // 注销;非 volatile 配置变更时 loader 重载本插件,重跑本 effect 完成同步。
      ctx.commands.register({
        name: 'plan-goal',
        description: t.planGoalDescription,
        input: { hint: t.planGoalHint },
        handler: async ({ agent, rawInput }) => {
          const input = rawInput.trim();
          if (input.length === 0) {
            return { kind: 'error', text: t.planGoalUsage };
          }
          // 开计划模式必须经 plan-mode 自身注册的 /plan 命令:planMode 服务
          // 在 agent preset 的 isolate 组内,profile 层直接调用会抛
          // cannot get property ... without inject。转调其 handler 等价于
          // 用户运行 /plan——由它完成 set(agent, true)(无消息则不 steer)。
          // find 的 agent 参数用于解析 agent 级命令影子;找不到即 plan-mode
          // 未挂载(如 minimal preset),给出可操作错误。
          const planCommand = ctx.commands.find(agent, 'plan');
          if (!planCommand) {
            return { kind: 'error', text: t.planModeMissing };
          }
          // CommandId 等字段 plan-mode 的 handler 不读取,以最小形状转调;
          // dispatcher 契约允许 handler 返回 Promise,这里 await 兜住两种形态。
          const outcome = await planCommand.handler({
            commandId: 'plan-goal:/plan',
            agent,
            rawInput: '',
            attachments: [],
            signal: new AbortController().signal,
          } as unknown as Parameters<typeof planCommand.handler>[0]);
          if (outcome.kind !== 'success') {
            return outcome;
          }
          // set 先于 steer:计划模式选择先进入 pending,保证下一个请求的组装
          // 携带 plan:policy 引导段,协议消息才能与之一并生效。
          agent.steer(buildPlanGoalMessage(input, language));
          return { kind: 'success', text: t.planGoalSuccess };
        },
      });
    }
    if (config.guard !== false) {
      // 同上:guard disposer 自动附着,单调拒绝语义由宿主管线保证
      ctx.tools.guard(createPlanGoalGuard(ctx, t.denyReason));
    }
    // 一致性告警(warn-only 内容闸):guard 只管"何时能建",不管"建得对不
    // 对"——这里补可发现的偏离。exit_plan_mode 成功(计划获人审批准)时缓存
    // 计划文本;create_goal 成功后取缓存(取后即删)比对 objective 是否保留
    // 计划的 ## 标题结构,缺失走 logger.warn。无缓存(guided-goal/手动流程)
    // 静默跳过,不误报。监听注册在插件 effect 内,随 fiber 卸载注销;回调
    // 每次工具调用都会进入,仅做名字与 isError 的 O(1) 过滤。
    const reviewedPlans = new WeakMap<object, string>();
    ctx.on('tools/result', (exec, result) => {
      if (result.isError) return;
      const agent = exec.agent;
      if (agent === undefined) return;
      const session = agent.session as object;
      if (exec.name === 'exit_plan_mode') {
        const plan = (exec.arguments as { plan?: unknown }).plan;
        if (typeof plan === 'string' && plan.length > 0) {
          reviewedPlans.set(session, plan);
        }
        return;
      }
      if (exec.name !== 'create_goal') return;
      const plan = reviewedPlans.get(session);
      if (plan === undefined) return;
      reviewedPlans.delete(session);
      const objective = (exec.arguments as { objective?: unknown }).objective;
      if (typeof objective !== 'string') return;
      const { missing } = checkConsistency(plan, objective);
      if (missing.length > 0) {
        ctx.logger.warn(
          '[plan-goal] objective missing approved plan headings: %s',
          missing.join(' | '),
        );
      }
    });
    // effect 契约要求返回 disposer;注销已由 register/guard/on 自附着的 effect 负责。
    return () => {};
  }, 'plan-goal: command and guard registration');
}
