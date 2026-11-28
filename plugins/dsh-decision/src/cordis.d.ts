/**
 * 宿主提问服务（`ctx.userQuestions`）的类型增强。
 *
 * 宿主插件 `@deepseek-ai/dsh-user-questions` 会声明同名成员（必需类型
 * `UserQuestionService`）。这里用**可选**的本地最小类型面，原因：
 * - 本包不 import 宿主该包，避免把精确版本写进依赖、改动 pnpm-lock.yaml；
 * - 本包的 tsconfig 只编译 src，不引入宿主包类型，因此不会与宿主的增强
 *   声明发生同名属性类型冲突。
 *
 * 运行时由宿主注入该服务；缺失时 ask-gate 抛可操作错误而不是静默降级。
 */

import type { UserQuestionsLike } from './core/user-questions.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 宿主提问服务；未注入时 ask-gate 无法接管提问。 */
    userQuestions?: UserQuestionsLike;
    /**
     * 动态注入依赖就绪的子 fiber（宿主运行时由 cordis 提供；依赖服务
     * 缺失时子 fiber 保持 PENDING、回调不执行）。6/11 起用于把
     * `webServer` 上的同源验证路由挂进插件生命周期。
     */
    inject(deps: readonly string[], callback: (ctx: Context) => void): unknown;
  }
}

export {};
