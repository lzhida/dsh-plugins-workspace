import type { Context } from '@deepseek-ai/cordis';
// 引入包内类型即激活其 cordis Context declaration merging(ctx.commands)
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-commands';
import {
  buildClarifyMessage,
  buildQuickCreateMessage,
  parseQuickInput,
} from './protocol.ts';

export const name = 'guided-goal';
export const inject = ['commands'];

/**
 * guided-goal:基于 dsh 官方 goal 域的 omp guided-goal 等价插件。
 *
 * 双命令,均为纯会话命令(steer 协议消息,创建复用官方 create_goal,
 * 不绕过 authority):
 * - `/guided-goal <草稿>`:访谈式——模型逐项澄清五字段(Objective /
 *   Success criteria / Verification / Boundaries / Stop conditions)后创建。
 * - `/quick-goal <一句话>`:快速式——模型零提问自行推断五字段
 *   (假设显式标注)直接创建;语义无法安全推断时停下请求补充。
 */
export function apply(ctx: Context): void {
  console.log(`[${name}] plugin loaded`);

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'guided-goal',
        description:
          'Guided goal creation: clarify success criteria / verification / round cap / boundaries / stop conditions, then create_goal · 引导式创建 goal:逐项澄清五字段后 create_goal',
        input: { hint: '<draft>' },
        handler: ({ agent, rawInput }) => {
          const draft = rawInput.trim();
          if (draft.length === 0) {
            return {
              kind: 'error',
              text: 'Usage: /guided-goal <draft> · 用法:/guided-goal <草稿目标>',
            };
          }
          agent.steer(buildClarifyMessage(draft));
          return {
            kind: 'success',
            text: 'Guided goal creation started: answer the clarifying questions one by one; the goal will be created once all fields are confirmed · 已启动引导式 goal 创建:请逐项回答澄清问题,全部确认后将自动创建 goal',
          };
        },
      }),
    'guided-goal: command',
  );

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'quick-goal',
        description:
          'Quick goal creation: no interview — infer all five fields from one line (assumptions marked) and create_goal · 快速创建 goal:零访谈自填五字段(假设标注)直接 create_goal',
        input: { hint: '<[N | unlimited |] one-line goal>' },
        handler: ({ agent, rawInput }) => {
          const { rounds, draft } = parseQuickInput(rawInput);
          if (draft.length === 0) {
            return {
              kind: 'error',
              text: 'Usage: /quick-goal <[N | unlimited |] one-line goal>; prefix "8 |" caps at 8 rounds, "unlimited |" removes the cap · 用法:/quick-goal <一句话目标>;前缀 "8 |" 指定 8 轮上限,"不限 |" 显式不限轮次',
            };
          }
          agent.steer(buildQuickCreateMessage(draft, rounds));
          return {
            kind: 'success',
            text: 'Quick goal creation started: fields will be inferred without interview (assumptions marked in the reply) · 已按快速模式创建 goal:模型将自行推断五字段(假设会在回复中标注)并直接创建,不进行访谈',
          };
        },
      }),
    'guided-goal: quick command',
  );
}
