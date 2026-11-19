/**
 * `@zhidal/dsh-decision` —— 决策域通用组合包。
 *
 * ## 包结构
 *
 * 决策域按「决策点」切插件行，每个决策点一个入口文件，命名 `<决策点>-gate`：
 *
 * - `src/entries/ask-gate.ts` = 插件行 **ask-gate**：接管模型侧提问工具
 *   `ask_user_question`（决策门控系列 1/4：空壳直通，门控判定留给 2/4）。
 * - `src/core/` = 与具体决策点无关的共用件：配置面（`config.ts`）与宿主
 *   `userQuestions` 的本地最小类型面（`user-questions.ts`）。
 * - `src/services/` = 决策点的执行层（ask-gate 的直通提问在
 *   `services/ask-gate.ts`；门控判定将在此之前插入）。
 *
 * ## 插件契约导出
 *
 * loader 依赖三符号：`name` / `apply` / `inject`；`Config` 经 re-export
 * 让宿主设置面板渲染本插件的可编辑字段（不 re-export 会整块丢弃）。
 */

export {
  apply,
  ASK_USER_QUESTION_DESCRIPTION,
  ASK_USER_QUESTION_OUTPUT,
  ASK_USER_QUESTION_PARAMETERS,
  ASK_USER_QUESTION_TOOL,
  inject,
  name,
} from './entries/ask-gate.ts';

export { Config, resolveConfig } from './core/config.ts';
export type { ResolvedConfig, SchemaDescription } from './core/config.ts';

export type {
  UserQuestionAnswer,
  UserQuestionAnswerItem,
  UserQuestionOption,
  UserQuestionRequest,
  UserQuestionRequestItem,
  UserQuestionsLike,
} from './core/user-questions.ts';

export {
  askThroughUserQuestions,
  toAskGateAnswerItem,
  toUserQuestionItem,
} from './services/ask-gate.ts';
export type {
  AskGateAnswer,
  AskGateAnswerItem,
  AskGateOption,
  AskGateQuestion,
} from './services/ask-gate.ts';
