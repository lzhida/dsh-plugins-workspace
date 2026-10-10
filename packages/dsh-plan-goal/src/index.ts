import type { Context } from '@deepseek-ai/cordis';
// 引入包内类型即激活其 cordis Context declaration merging(ctx.commands /
// ctx.tools / ctx.planMode 的类型投影);运行时由宿主提供,仅 import type
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-plan-mode';
import type {} from '@deepseek-ai/dsh-tools';
import Schema from '@deepseek-ai/schemastery';
import { createPlanGoalGuard, probePlanMode } from './guard.ts';
import { buildPlanGoalMessage } from './protocol.ts';

export const name = 'dsh-plan-goal';
export const inject = ['commands', 'tools'];

/**
 * dsh-plan-goal:plan mode × goal 的缝合(stitch-in)插件,不融合两侧:
 *
 * - `/plan-goal <draft>`:一条命令完成「开计划模式 → 注入协议 →
 *   exit_plan_mode 审阅 → 批准后同轮 create_goal」。协议要求先调研后设计,
 *   计划文档内嵌五字段 goal 块(Objective / Success criteria / Verification /
 *   Boundaries / Stop conditions),批准前 create_goal 被 guard 拒绝。
 * - create_goal 防抢跑闸:plan-active / pending 期间拒绝 create_goal,把
 *   「跳过 plan review 直接进入 goal 轮」的路径封死(唯一放行路径是批准后
 *   同轮创建);fail-open——plan-mode 缺失或探测异常时放行,不绑架宿主。
 *
 * planMode 不进 inject(PTC 惯例,避免 hostage plugins):使用时结构化探测,
 * 缺失时命令返回可操作错误、guard 退化为 no-op,插件照常加载。
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
      'Plan-first goal creation: research first, embed a five-field goal block (objective / success criteria / verification / boundaries / stop conditions) in the plan, and create_goal in the same turn after the plan is approved',
      '计划式创建 goal:先调研,把五字段块(目标/成功标准/验证方式/边界/停止条件)内嵌进计划,经审阅批准后同轮 create_goal',
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
      '@deepseek-ai/dsh-plan-mode is not mounted; plan-goal requires it',
      '请先挂载 @deepseek-ai/dsh-plan-mode',
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
        handler: ({ agent, rawInput }) => {
          const input = rawInput.trim();
          if (input.length === 0) {
            return { kind: 'error', text: t.planGoalUsage };
          }
          const planMode = probePlanMode(ctx);
          if (!planMode) {
            return { kind: 'error', text: t.planModeMissing };
          }
          // set 必须先于 steer:计划模式选择先进入 pending,保证下一个请求
          // 的组装携带 plan:policy 引导段,协议消息才能与之一并生效。
          planMode.set(agent, true);
          agent.steer(buildPlanGoalMessage(input, language));
          return { kind: 'success', text: t.planGoalSuccess };
        },
      });
    }
    if (config.guard !== false) {
      // 同上:guard disposer 自动附着,单调拒绝语义由宿主管线保证
      ctx.tools.guard(createPlanGoalGuard(ctx, t.denyReason));
    }
    // effect 契约要求返回 disposer;注销已由 register/guard 自附着的 effect 负责。
    return () => {};
  }, 'plan-goal: command and guard registration');
}
