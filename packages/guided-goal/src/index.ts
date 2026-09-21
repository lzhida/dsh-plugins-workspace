import type { Context } from '@deepseek-ai/cordis';
// 引入包内类型即激活其 cordis Context declaration merging(ctx.commands / ctx.settings)
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-settings';
import Schema from '@deepseek-ai/schemastery';
import {
  buildClarifyMessage,
  buildQuickCreateMessage,
  parseQuickInput,
} from './protocol.ts';

export const name = 'guided-goal';
export const inject = ['commands', 'settings'];

/**
 * guided-goal:基于 dsh 官方 goal 域的 omp guided-goal 等价插件。
 *
 * 双命令,均为纯会话命令(steer 协议消息,创建复用官方 create_goal,
 * 不绕过 authority):
 * - `/guided-goal <draft>`:访谈式——模型逐项澄清五字段(Objective /
 *   Success criteria / Verification / Boundaries / Stop conditions)后创建。
 * - `/quick-goal <[N | unlimited |] one-line goal>`:快速式——模型零提问
 *   自行推断五字段(假设显式标注)直接创建;语义无法安全推断时停下请求补充。
 *
 * 配置(Settings → Guided Goal,官方 settings 体系持久化):
 * - enabled:开关,关闭时两命令从补全列表注销
 * - language:命令文案语言(auto=浏览器自适应双语 / zh / en)
 */

export interface GuidedGoalConfig {
  enabled: boolean;
  language: 'auto' | 'zh' | 'en';
}

const CONFIG_SCHEMA = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('Enable commands / 启用命令'),
  language: Schema.union(['auto', 'zh', 'en'])
    .default('auto')
    .description('Command text language / 命令文案语言'),
});

type ConfigLanguage = GuidedGoalConfig['language'];

interface CommandTexts {
  guidedDescription: string;
  quickDescription: string;
  guidedHint: string;
  quickHint: string;
  guidedUsage: string;
  guidedSuccess: string;
  quickUsage: string;
  quickSuccess: string;
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
    guidedHint: '<draft>',
    quickHint: '<[N | unlimited |] one-line goal>',
    guidedDescription: both(
      'Guided goal creation: clarify success criteria / verification / round cap / boundaries / stop conditions, then create_goal',
      '引导式创建 goal:逐项澄清五字段后 create_goal',
    ),
    quickDescription: both(
      'Quick goal creation: no interview — infer all five fields from one line (assumptions marked) and create_goal',
      '快速创建 goal:零访谈自填五字段(假设标注)直接 create_goal',
    ),
    guidedUsage: both(
      'Usage: /guided-goal <draft>',
      '用法:/guided-goal <草稿目标>',
    ),
    guidedSuccess: both(
      'Guided goal creation started: answer the clarifying questions one by one; the goal will be created once all fields are confirmed',
      '已启动引导式 goal 创建:请逐项回答澄清问题,全部确认后将自动创建 goal',
    ),
    quickUsage: both(
      'Usage: /quick-goal <[N | unlimited |] one-line goal>; prefix "8 |" caps at 8 rounds, "unlimited |" removes the cap',
      '用法:/quick-goal <一句话目标>;前缀 "8 |" 指定 8 轮上限,"不限 |" 显式不限轮次',
    ),
    quickSuccess: both(
      'Quick goal creation started: fields will be inferred without interview (assumptions marked in the reply)',
      '已按快速模式创建 goal:模型将自行推断五字段(假设会在回复中标注)并直接创建,不进行访谈',
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
    const sync = (config: GuidedGoalConfig): void => {
      for (const dispose of commandDisposers) dispose();
      commandDisposers = [];
      if (!config.enabled) return;
      const t = commandTexts(config.language);
      commandDisposers.push(
        ctx.commands.register({
          name: 'guided-goal',
          description: t.guidedDescription,
          input: { hint: t.guidedHint },
          handler: ({ agent, rawInput }) => {
            const draft = rawInput.trim();
            if (draft.length === 0) {
              return { kind: 'error', text: t.guidedUsage };
            }
            agent.steer(buildClarifyMessage(draft));
            return { kind: 'success', text: t.guidedSuccess };
          },
        }),
        ctx.commands.register({
          name: 'quick-goal',
          description: t.quickDescription,
          input: { hint: t.quickHint },
          handler: ({ agent, rawInput }) => {
            const { rounds, draft } = parseQuickInput(rawInput);
            if (draft.length === 0) {
              return { kind: 'error', text: t.quickUsage };
            }
            agent.steer(buildQuickCreateMessage(draft, rounds));
            return { kind: 'success', text: t.quickSuccess };
          },
        }),
      );
    };

    sync(scope.get());
    const stopWatch = scope.watch((next) => sync(next));
    return () => {
      stopWatch();
      for (const dispose of commandDisposers) dispose();
      commandDisposers = [];
    };
  }, 'guided-goal: settings-driven commands');
}
