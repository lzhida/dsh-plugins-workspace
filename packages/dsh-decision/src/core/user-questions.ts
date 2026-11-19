/**
 * 宿主 `ctx.userQuestions` 的**本地最小类型面**。
 *
 * 为什么不用宿主的 `@deepseek-ai/dsh-user-questions` 类型：引入该包会把
 * 精确版本写进 package.json 依赖并改动 pnpm-lock.yaml（本仓硬约束：不改
 * lock 文件）。这里只声明我们真正调用的那一小段结构，运行时由宿主注入。
 *
 * 宿主实际语义（2026-11-20 核对 @deepseek-ai/dsh-user-questions 0.2.1-rc.2）：
 * - `ask()` 会先校验：signal 已中止 → ASK_ABORTED；问题为空 → EMPTY_QUESTIONS；
 *   传入 agent 但不是活体 → CALLER_NOT_LIVE；agent 不在 agents.roots() 内
 *   （即被别的活体 agent 持有的子代理）→ DELEGATED_CALLER；
 * - 校验通过后走 waterfall 事件 `user-questions/request`，由客户端把用户
 *   答案回灌，宿主再把 answer 交还调用方。
 * 这些错误码与文案由宿主抛出，本包一律**原样透传**，不吞不改。
 */

/** 选项（与出厂 ask_user_question 的 options 元素同构）。 */
export interface UserQuestionOption {
  label: string;
  description?: string;
}

/** 请求里的单个问题（服务侧词汇用驼峰 multiSelect）。 */
export interface UserQuestionRequestItem {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: UserQuestionOption[];
  multiSelect?: boolean;
}

/** 请求整体。 */
export interface UserQuestionRequest {
  questions: UserQuestionRequestItem[];
  agent?: unknown;
  signal?: AbortSignal;
}

/** 答案里的单条。 */
export interface UserQuestionAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}

/** 答案整体。 */
export interface UserQuestionAnswer {
  answers: UserQuestionAnswerItem[];
}

/** `ctx.userQuestions` 的本地最小结构面。 */
export interface UserQuestionsLike {
  ask(request: UserQuestionRequest): Promise<UserQuestionAnswer>;
}
