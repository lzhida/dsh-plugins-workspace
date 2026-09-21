import type { Context } from '@deepseek-ai/cordis';
// 引入包内类型即激活其 cordis Context declaration merging(ctx.commands / ctx.settings)
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-settings';
import Schema from '@deepseek-ai/schemastery';
import { buildClarifyMessage } from './protocol.ts';

export const name = 'dsh-guided-goal';
export const inject = ['commands', 'settings'];

/**
 * dsh-guided-goal:基于 dsh 官方 goal 域的 omp guided-goal 等价插件。
 *
 * 双命令,均为纯会话命令(steer 协议消息,创建复用官方 create_goal,
 * 不绕过 authority):
 * - `/guided-goal <draft>`:访谈式——模型逐项澄清五字段(Objective /
 *   Success criteria / Verification / Boundaries / Stop conditions)后创建。

 *   自行推断五字段(假设显式标注)直接创建;语义无法安全推断时停下请求补充。
 *
 * 配置(Settings → Guided Goal,官方 settings 体系持久化):
 * - enabled:开关,关闭时两命令从补全列表注销
 *
 * 文案语言跟随 dsh 全局语言设置(Settings → Language,settings 'locale'
 * namespace 的 preference 字段):zh/en 单语言,未设置时双语兜底——
 * 通过订阅 settings/updated 事件在运行时切换。
 */

export interface GuidedGoalConfig {
  /** /guided-goal 命令开关 */
  enabled: boolean;
}

const CONFIG_SCHEMA = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('Enable /guided-goal command / 启用引导式目标命令'),
});

type ConfigLanguage = 'auto' | 'zh' | 'en';

/** 读取 dsh 全局语言偏好(Settings → Language):zh/en,未设置时 auto(双语)。 */
export function resolveLanguage(ctx: Context): ConfigLanguage {
  let doc: unknown;
  try {
    doc = ctx.settings.get('locale');
  } catch {
    return 'auto';
  }
  const preference = (doc as { preference?: string } | undefined)?.preference;
  if (preference === 'zh' || preference === 'en') return preference;
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

export function apply(ctx: Context): void {
  console.log(`[${name}] plugin loaded`);

  ctx.effect(() => {
    const scope = ctx.settings.register<'guided-goal', GuidedGoalConfig>(
      'guided-goal',
      CONFIG_SCHEMA,
    );

    let commandDisposers: Array<() => void> = [];
    const sync = (config: GuidedGoalConfig, language: ConfigLanguage): void => {
      for (const dispose of commandDisposers) dispose();
      commandDisposers = [];
      const t = commandTexts(language);
      if (config.enabled !== false) {
        commandDisposers.push(
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
          }),
        );
      }
    };

    sync(scope.get(), resolveLanguage(ctx));
    const stopWatch = scope.watch((next) => sync(next, resolveLanguage(ctx)));
    // 全局语言变更(Settings → Language → locale ns)时同步命令文案
    const stopLocaleWatch = ctx.on('settings/updated', (ns) => {
      if (ns === 'locale') sync(scope.get(), resolveLanguage(ctx));
    });
    return () => {
      stopWatch();
      stopLocaleWatch();
      for (const dispose of commandDisposers) dispose();
      commandDisposers = [];
    };
  }, 'guided-goal: settings-driven commands');
}
