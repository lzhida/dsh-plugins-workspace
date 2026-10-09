/**
 * Ambient declaration:扩展 `@deepseek-ai/cordis` 的 Context.Events,
 * 增加 dsh-agent-loop 暴露的两个 waterfall 事件。
 *
 * 为什么是独立 .d.ts 文件而不是 inline `declare module`:
 * - TypeScript 的 declaration merging 受 tsconfig include 规则约束;
 *   当外部项目(如 dsh desktop)加载本插件时,host 的 tsconfig 只能"看到"
 *   host 自己 include 的 .d.ts 文件,看不到本仓库 .ts 源码文件内的 augmentation;
 * - 通过本插件 package.json 的 `types` 字段指向这个 .d.ts 文件,
 *   dsh desktop 在加载 plugin 时,TypeScript 编译器会沿着 main 的导入链找到
 *   这个 ambient 类型,augmentation 跨包生效;
 * - 这样 `ctx.on('agent/request', listener)` 就能在 host 的 tsconfig 下编译通过,
 *   避免 dsh: warning: ... failed to import 错误。
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/request'(
      payload: { turn: number; step: number; signal: AbortSignal },
      next: () => Promise<{
        provider: string;
        model: string;
        reasoningEffort?: unknown;
        maxTokens?: number;
      }>,
    ): Promise<{
      provider: string;
      model: string;
      reasoningEffort?: unknown;
      maxTokens?: number;
    }>;
    'agent/request-error'(
      payload: {
        turn: number;
        step: number;
        provider: string;
        failure: {
          readonly message: string;
          readonly code: string;
          readonly status?: number;
          readonly providerRetryAfterMs?: number;
          readonly requestId?: string;
        };
        retryPolicy?: unknown;
        signal: AbortSignal;
      },
      next: () => Promise<{ kind: 'retry' } | undefined | void>,
    ): Promise<{ kind: 'retry' } | undefined | void>;
  }
}

export {};
