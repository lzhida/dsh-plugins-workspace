import type { Context } from '@deepseek-ai/cordis';
// 引入包内类型即激活其 cordis Context declaration merging(ctx.commands)
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-commands';
import Schema from '@deepseek-ai/schemastery';
import { buildClarifyMessage } from './protocol.ts';

export const name = 'dsh-guided-goal';
export const inject = ['commands'];

/**
 * dsh-guided-goal:基于 dsh 官方 goal 域的 omp guided-goal 等价插件。
 *
 * 单命令,纯会话命令(steer 协议消息,创建复用官方 create_goal,
 * 不绕过 authority):
 * - `/guided-goal <draft>`:访谈式——模型逐项澄清五字段(Objective /
 *   Success criteria / Verification / Boundaries / Stop conditions)后创建;
 *   草稿已足够明确时模型可跳过访谈,自行推断五字段(假设显式标注)直接
 *   创建;语义无法安全推断时停下请求补充。
 *
 * 配置(dsh 0.1.7 静态 Config 声明):插件以 `Config` 导出名声明 schema
 * (cordis/loader 约定),loader 投影成设置表单;apply 第二参收到已校验
 * 普通值。enabled/language 均非 volatile,变更时 loader 重载本插件、
 * apply 重跑即完成同步——无需 watch、无需订阅 settings/updated。
 *
 * 文案语言:language 配置为 zh/en 时固定单语言;auto 时尝试从
 * ctx.settings.describe() 的任一 descriptor value.preference 读取 dsh
 * 全局语言偏好(Settings → Language),读不到回退双语。
 */

export interface GuidedGoalConfig {
  /** /guided-goal 命令开关 */
  enabled: boolean;
  /** 命令文案语言:auto=跟随 dsh 语言偏好,zh/en=固定单语言 */
  language: 'auto' | 'zh' | 'en';
}

/**
 * 插件配置 schema(以 loader 约定的 `Config` 导出名声明,投影成设置表单;
 * 插件行经 patch 插入时不带 config,靠此处 default 兜底:enabled=true /
 * language='auto')。
 */
export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('Enable /guided-goal command / 启用引导式目标命令'),
  language: Schema.union(['auto', 'zh', 'en'])
    .default('auto')
    .description(
      'Command text language: auto follows dsh preference / 命令文案语言',
    ),
});

type ConfigLanguage = GuidedGoalConfig['language'];

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
  guidedDescription: string;
  guidedHint: string;
  guidedUsage: string;
  guidedSuccess: string;
}

/** 按 language 配置生成命令文案:auto=双语,zh/en=单语言。 */
export function commandTexts(language: ConfigLanguage): CommandTexts {
  const both = (enText: string, zhText: string): string =>
    language === 'zh'
      ? zhText
      : language === 'en'
        ? enText
        : `${enText} · ${zhText}`;
  return {
    guidedHint: '[<draft>]',
    guidedDescription: both(
      'Guided goal creation: clarify success criteria / verification / round cap / boundaries / stop conditions first, then create_goal; when the draft is already sufficiently specific, the model may skip the interview and create directly',
      '引导式创建 goal:先逐项澄清成功标准 / 验证方式 / 轮次上限 / 边界 / 停止条件再 create_goal;草稿已足够明确时模型可跳过访谈直接创建',
    ),
    guidedUsage: both(
      'Usage: /guided-goal [<draft>]',
      '用法:/guided-goal [<草稿目标>]',
    ),
    guidedSuccess: both(
      'Guided goal creation started: answer the clarifying questions one by one; the goal will be created once all fields are confirmed',
      '已启动引导式 goal 创建:请逐项回答澄清问题,全部确认后将自动创建 goal',
    ),
  };
}

export function apply(
  ctx: Context,
  config: Partial<GuidedGoalConfig> = {},
): void {
  console.log(`[${name}] plugin loaded`);

  ctx.effect(() => {
    const language = resolveLanguage(ctx, config.language ?? 'auto');
    const t = commandTexts(language);
    if (config.enabled === false) return () => {};
    // register 的 disposer 经 layers.effect 自动附着到插件作用域,卸载即
    // 注销;非 volatile 配置变更时 loader 重载本插件,重跑本 effect 完成同步。
    ctx.commands.register({
      name: 'guided-goal',
      description: t.guidedDescription,
      input: { hint: t.guidedHint },
      handler: ({ agent, rawInput }) => {
        const input = rawInput.trim();
        if (input.length === 0) {
          return { kind: 'error', text: t.guidedUsage };
        }
        agent.steer(buildClarifyMessage(input, language));
        return { kind: 'success', text: t.guidedSuccess };
      },
    });
    // effect 契约要求返回 disposer;注销已由 register 自附着的 effect 负责。
    return () => {};
  }, 'guided-goal: command registration');
}
