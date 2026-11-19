/**
 * ask-gate 的服务层：**直通宿主提问通道 + 门控决策辅助**。
 *
 * 两块职责：
 *
 * 1. 直通宿主提问通道：把工具面的 questions/answers 形状，与宿主
 *    `ctx.userQuestions.ask()` 的请求/答案形状互相映射，并原样透传宿主的
 *    错误语义（ASK_ABORTED / EMPTY_QUESTIONS / CALLER_NOT_LIVE /
 *    DELEGATED_CALLER / BAD_INTENT / NO_PROVIDER）。
 *    关键约束：映射**只换名**（multi_select → multiSelect），不改内容、
 *    不裁字段、不吞异常。
 * 2. 门控决策辅助（3/4）：构建决策 prompt、把关解析结果映射为工具面
 *    答案、构建落账 meta。门控判定本身在插件行（entries/ask-gate.ts）。
 */

import type {
  DecisionParseAnswer,
  DecisionParseResult,
} from '../core/decision.ts';
import type {
  UserQuestionAnswerItem,
  UserQuestionRequestItem,
  UserQuestionsLike,
} from '../core/user-questions.ts';

/** 工具面的选项（与出厂 ask_user_question schema 兼容）。 */
export type AskGateOption = {
  label: string;
  description?: string;
};

/** 工具面的问题（与出厂 ask_user_question schema 兼容：snake_case）。 */
export type AskGateQuestion = {
  id: string;
  question: string;
  header?: string;
  options?: AskGateOption[];
  multi_select?: boolean;
};

/** 工具面的答案项。 */
export type AskGateAnswerItem = {
  id: string;
  selected: string[];
  custom?: string;
};

/** 工具面的答案整体（与出厂 output schema 同构）。 */
export type AskGateAnswer = {
  answers: AskGateAnswerItem[];
};

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

// ── 门控判定辅助（3/4）：决策 prompt 构建 + 建议答案映射 + meta 落账 ──

/** 自动作答的答案条目来源标注前缀；agent 与用户据此识别自动作答。 */
export const DECISION_AUTO_ANSWER_PREFIX = '[decision auto-answer]';

/** 门控决策结果的落账 meta（随 tool/result 顶层 `presentationMeta` 返回）。 */
export type PresentationMeta = {
  /** 决策模型置信度（0~1；放行且未评估成功时为 0）。 */
  confidence: number;
  /** 本次门控决策：自动作答或放行真实提问。 */
  decision: 'auto-answered' | 'passed-through';
  /** 决策理由（模型 reason 或降级信号 kind）。 */
  rationale: string;
};

/**
 * 决策评估的 system prompt：固定纪律——只判定把握度并给出建议答案，
 * 不替用户编造偏好之外的内容；输出必须是单个 JSON 对象。
 */
export const DECISION_SYSTEM_PROMPT = [
  'You act as a proxy decision maker for a user who cannot answer right now.',
  'For the pending questions below, judge how confidently a reasonable default can be answered on their behalf.',
  'Rules:',
  '- Never invent answers or facts; only answer when a clear, low-risk default exists.',
  '- Output exactly one JSON object and nothing else:',
  '  {"confidence": <number 0-1>, "answers": [{"id": "<question id>", "selected": ["<option label>", ...], "custom": "<short text>"}], "reason": "<short reason>"}',
  '- confidence is your overall certainty across ALL questions; any uncertainty should lower it.',
  '- For each question, put chosen option labels in "selected" (respect multi_select), or free text in "custom".',
  '- If you cannot answer a question confidently, still include it with an empty "selected" and explain in "custom".',
].join('\n');

/** 由工具面问题构建决策评估的用户 prompt（确定性拼接，无模型花活）。 */
export function buildDecisionPrompt(questions: AskGateQuestion[]): string {
  const lines = questions.map((question, index) => {
    const options =
      question.options !== undefined && question.options.length > 0
        ? ` options: ${question.options
            .map((option) => JSON.stringify(option.label))
            .join(', ')}`
        : '';
    const multi = question.multi_select === true ? ' (multi-select)' : '';
    const descriptions =
      question.options !== undefined && question.options.length > 0
        ? question.options
            .filter((option) => option.description !== undefined)
            .map(
              (option) =>
                `${JSON.stringify(option.label)}: ${JSON.stringify(option.description)}`,
            )
            .join('; ')
        : '';
    return `${index + 1}. id=${JSON.stringify(question.id)} question=${JSON.stringify(
      question.question,
    )}${question.header !== undefined ? ` header=${JSON.stringify(question.header)}` : ''}${options}${descriptions !== '' ? ` descriptions: ${descriptions}` : ''}${multi}`;
  });
  return [
    'Pending questions for the user:',
    ...lines,
    '',
    'Evaluate and reply with the JSON object only.',
  ].join('\n');
}

/**
 * 把决策模型的解析结果映射为工具面答案。
 *
 * 只有当模型给出的建议答案**按 id 覆盖全部问题**时才可自动作答
 * （覆盖不全＝模型没接住每个问题，放行真实提问更安全）；多余的
 * id 视为模型幻觉、忽略。选项题里模型给的 label 若全不在白名单且
 * 没有自定义文字，同样视为没被回答（放行）。每条答案的 `custom` 恒带
 * {@link DECISION_AUTO_ANSWER_PREFIX} 前缀以便识别来源。
 *
 * @returns 覆盖不全时返回 undefined（调用方据此降级放行）。
 */
export function buildAutoAnswers(
  questions: AskGateQuestion[],
  parse: DecisionParseResult,
): AskGateAnswer | undefined {
  const suggestions = new Map<string, DecisionParseAnswer>();
  for (const answer of parse.answers ?? []) {
    suggestions.set(answer.id, answer);
  }
  if (questions.some((question) => !suggestions.has(question.id))) {
    return undefined;
  }
  const answers: AskGateAnswerItem[] = [];
  for (const question of questions) {
    const suggestion = suggestions.get(question.id);
    const selected = (suggestion?.selected ?? []).filter((label) =>
      (question.options ?? []).some((option) => option.label === label),
    );
    const custom = suggestion?.custom;
    // 选项题里模型给的 label 全是幻觉（过滤后为空）且没给自定义文字：
    // 说明这一问其实没被回答，按覆盖失败放行真实提问。
    if (
      selected.length === 0 &&
      (custom === undefined || custom === '') &&
      (question.options ?? []).length > 0
    ) {
      return undefined;
    }
    const detail =
      custom ??
      (selected.length > 0
        ? `choose ${selected.join(' / ')}`
        : (parse.reason ?? ''));
    answers.push({
      id: question.id,
      selected,
      custom: `${DECISION_AUTO_ANSWER_PREFIX} ${detail}`.trim(),
    });
  }
  return { answers };
}

/**
 * 由决策报告构建落账 meta（自动作答路径，以及「评估成功但低于阈值」的放行路径）。
 *
 * rationale 一律取模型给的 reason（模型没给就是空串）——评估本身跑通时，
 * 放行理由是「把握度不够」而不是任何技术故障信号。
 */
export function buildAutoMeta(
  parse: DecisionParseResult,
  decision: 'auto-answered' | 'passed-through',
): PresentationMeta {
  return {
    confidence: parse.confidence,
    decision,
    rationale: parse.reason ?? '',
  };
}

/** 降级放行路径的落账 meta：置信度 0，理由用降级信号 kind。 */
export function buildDegradedMeta(kind: string): PresentationMeta {
  return {
    confidence: 0,
    decision: 'passed-through',
    rationale: kind,
  };
}
