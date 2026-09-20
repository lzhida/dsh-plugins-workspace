import type { Context } from '@deepseek-ai/cordis';

export const name = 'hello-plugin';

export function greet(who: string): string {
  return `hello, ${who}!`;
}

export function apply(ctx: Context): void {
  console.log(`[${name}] plugin loaded`);
  ctx.effect(() => {
    const timer = setInterval(() => {
      console.log(`[${name}] ${greet('dsh')}`);
    }, 5000);
    return () => clearInterval(timer);
  });
}
