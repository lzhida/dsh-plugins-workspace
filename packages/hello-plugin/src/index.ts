import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'hello-plugin';
export const inject = ['tools'];

export function greet(who: string): string {
  return `hello, ${who}!`;
}

export function apply(ctx: Context): void {
  console.log(`[${name}] plugin loaded`);

  ctx.tools.register(
    defineTool({
      name: 'hello-greet',
      description: 'hello-plugin 的问候工具',
      parameters: {
        who: { type: 'string', required: true, description: '问候对象' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        return greet(args.who);
      },
    }),
  );

  ctx.effect(() => {
    const timer = setInterval(() => {
      console.log(`[${name}] ${greet('dsh')}`);
    }, 5000);
    return () => clearInterval(timer);
  });
}
