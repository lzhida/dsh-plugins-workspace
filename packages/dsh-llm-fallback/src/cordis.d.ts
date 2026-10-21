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
      payload: {
        turn: number;
        step: number;
        signal: AbortSignal;
        /**
         * 主体 agent(官方类型 dsh-agent runtime-types.d.ts 的
         * 'agent/request' 声明 `agent: Agent`)。本插件只读 `session.id`
         * 作 step 状态键的会话段(会话隔离);标可选以防御非 agent 作用域
         * dispatch 或旧宿主。
         */
        agent?: { session: { id?: string } };
      },
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
        /**
         * 主体 agent(dsh-agent fused dispatcher 注入 `{ ...payload, agent }`;
         * 官方类型 dsh-agent runtime-types.d.ts 的 'agent/request-error' 声明
         * `agent: Agent`)。`agent.session` 是 append-only 会话日志,插件用它
         * 写官方 `llm/retry` / `llm/retry-started` 轨迹事件。标可选以防御
         * 非 agent 作用域 dispatch 或旧宿主。
         */
        agent?: {
          session: {
            /** 会话标识(源 durable header;step 状态键会话段取自它)。 */
            id?: string;
            append(type: 'llm/retry', data: unknown): unknown;
            append(type: 'llm/retry-started', data: unknown): unknown;
          };
        };
      },
      next: () => Promise<{ kind: 'retry' } | undefined | void>,
    ): Promise<{ kind: 'retry' } | undefined | void>;
  }
}

export {};
