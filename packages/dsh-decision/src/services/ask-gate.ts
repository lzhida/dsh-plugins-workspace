/**
 * ask-gate 的服务层：**直通宿主提问通道**。
 *
 * 1/4 阶段门控逻辑尚未落地（本卡不做门控判定与决策模型调用），因此这里
 * 只做一件事：把工具面的 questions/answers 形状，与宿主
 * `ctx.userQuestions.ask()` 的请求/答案形状互相映射，并原样透传宿主的
 * 错误语义（ASK_ABORTED / EMPTY_QUESTIONS / CALLER_NOT_LIVE /
 * DELEGATED_CALLER / BAD_INTENT / NO_PROVIDER）。
 *
 * 关键约束：映射**只换名**（multi_select → multiSelect），不改内容、
 * 不裁字段、不吞异常。后续 2/4、3/4 落门控逻辑时，在本层之前插入判定，
 * 直通路径保持不变。
 */

import type {
  UserQuestionAnswerItem,
  UserQuestionRequestItem,
  UserQuestionsLike,
} from '../core/user-questions.ts';

/** 工具面的选项（与出厂 ask_user_question schema 兼容）。 */
export interface AskGateOption {
  label: string;
  description?: string;
}

/** 工具面的问题（与出厂 ask_user_question schema 兼容：snake_case）。 */
export interface AskGateQuestion {
  id: string;
  question: string;
  header?: string;
  options?: AskGateOption[];
  multi_select?: boolean;
}

/** 工具面的答案项。 */
export interface AskGateAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}

/** 工具面的答案整体（与出厂 output schema 同构）。 */
export interface AskGateAnswer {
  answers: AskGateAnswerItem[];
}

/** 工具面问题 → 宿主请求项（只换名，不裁字段）。 */
export function toUserQuestionItem(
  question: AskGateQuestion,
): UserQuestionRequestItem {
  return {
    id: question.id,
    question: question.question,
    ...(question.header !== undefined ? { header: question.header } : {}),
    ...(question.options !== undefined ? { options: question.options } : {}),
    ...(question.multi_select !== undefined
      ? { multiSelect: question.multi_select }
      : {}),
  };
}

/** 宿主答案项 → 工具面答案项（只换名，不裁字段）。 */
export function toAskGateAnswerItem(
  answer: UserQuestionAnswerItem,
): AskGateAnswerItem {
  return {
    id: answer.id,
    selected: [...answer.selected],
    ...(answer.custom !== undefined ? { custom: answer.custom } : {}),
  };
}

/** 直通提问：把问题交给宿主 userQuestions 服务，取回答案。 */
export async function askThroughUserQuestions(
  userQuestions: UserQuestionsLike,
  questions: AskGateQuestion[],
  exec: { agent?: unknown; signal?: AbortSignal },
): Promise<AskGateAnswer> {
  const result = await userQuestions.ask({
    questions: questions.map((question) => toUserQuestionItem(question)),
    ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
    ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
  });
  return {
    answers: result.answers.map((answer) => toAskGateAnswerItem(answer)),
  };
}
