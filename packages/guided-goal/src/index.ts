import type { Context } from '@deepseek-ai/cordis';
// 引入包内类型即激活其 cordis Context declaration merging(ctx.commands)
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-commands';
import { buildClarifyMessage } from './protocol.ts';

export const name = 'guided-goal';
export const inject = ['commands'];

/**
 * guided-goal:基于 dsh 官方 goal 域的 omp guided-goal 等价插件。
 *
 * 纯会话命令插件:`/guided-goal <草稿>` 把澄清协议 + 草稿 steer 进当前会话,
 * 模型逐项澄清五字段(Objective / Success criteria / Verification /
 * Boundaries / Stop conditions)后调用官方 create_goal——创建动作与权限
 * 完全复用官方 tool-goal,本插件不绕过 authority。
 */
export function apply(ctx: Context): void {
  console.log(`[${name}] plugin loaded`);

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'guided-goal',
        description:
          '引导式创建持久 goal:先逐项澄清成功标准/验证/上限/边界/停止条件,再 create_goal',
        input: { hint: '<草稿目标>' },
        handler: ({ agent, rawInput }) => {
          const draft = rawInput.trim();
          if (draft.length === 0) {
            return { kind: 'error', text: '用法:/guided-goal <草稿目标>' };
          }
          agent.steer(buildClarifyMessage(draft));
          return {
            kind: 'success',
            text: '已启动引导式 goal 创建:请在会话中逐项回答澄清问题,全部确认后将自动创建 goal',
          };
        },
      }),
    'guided-goal: command',
  );
}
