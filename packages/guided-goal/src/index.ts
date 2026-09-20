import type { Context } from '@deepseek-ai/cordis';
// 引入包内类型即激活其 cordis Context declaration merging(ctx.commands / ctx.agents)
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-commands';
import { buildClarifyMessage } from './protocol.ts';
import { mountRoutes } from './router.ts';

export const name = 'guided-goal';
export const inject = ['commands', 'agents', 'webServer'];

/**
 * guided-goal:基于 dsh 官方 goal 域的 omp guided-goal 等价插件。
 *
 * - `/guided-goal <草稿>` 命令:把澄清协议 + 草稿 steer 进会话,模型逐项澄清
 *   五字段后调用官方 create_goal(创建动作与权限完全复用官方 tool-goal)。
 * - Web 设置面板(见 client/index.js):表单填完五字段,经 loopback API
 *   注入"直接创建"指令,同样由官方 create_goal 落地。
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

  ctx.effect(
    () => mountRoutes(ctx.webServer, ctx.agents),
    'guided-goal: routes',
  );
}
