import {
  createUserMessage,
  type ContentBlock,
  type UserMessage,
} from '@deepseek-ai/dsh-llm';

/** 引导式 goal 的五个结构化字段(key 与 Web 表单/测试共用)。 */
export interface GoalFields {
  objective: string;
  successCriteria: string;
  verification?: string;
  boundaries?: string;
  stopConditions?: string;
  maxGoalRounds?: string;
}

/** 用户视角的字段元数据。 */
export const GOAL_FIELD_DEFS: ReadonlyArray<{
  key: keyof GoalFields;
  label: string;
  required: boolean;
}> = [
  { key: 'objective', label: '目标', required: true },
  { key: 'successCriteria', label: '成功标准', required: true },
  { key: 'verification', label: '验证方式', required: false },
  { key: 'boundaries', label: '范围边界', required: false },
  { key: 'stopConditions', label: '停止条件', required: false },
  { key: 'maxGoalRounds', label: '轮次上限', required: false },
];

/** 把五字段合成 goal objective 的固定 markdown 结构(与 goal 域约定一致)。 */
export function composeObjective(fields: GoalFields): string {
  const section = (title: string, value: string | undefined): string =>
    `## ${title}\n${value && value.trim().length > 0 ? value.trim() : '未指定'}`;
  return [
    section('Objective', fields.objective),
    section('Success criteria', fields.successCriteria),
    section('Verification', fields.verification),
    section('Boundaries', fields.boundaries),
    section('Stop conditions', fields.stopConditions),
  ].join('\n\n');
}

/** 构造一条 source 为用户的文本消息(steer/followup 的载体)。 */
export function userText(text: string): UserMessage {
  // ContentBlock 判别联合的 text 变体:结构由 dsh-llm 契约定义
  const textBlock: ContentBlock = { type: 'text', text };
  return createUserMessage({
    source: { kind: 'user' },
    content: [textBlock],
  });
}

const CLARIFY_PROTOCOL = [
  '[guided-goal] 用户希望以引导方式创建一个持久 goal(每会话一个,由 dsh goal 域管理)。',
  '请严格按以下协议执行:',
  '1. 依次澄清五个字段:成功标准(必须可判定,拒绝"做得好/完成"等主观表述)、验证方式(确切命令或动作)、迭代上限(最多几轮尝试)、范围边界(允许/禁止触碰的路径)、停止条件(何时停下交还人工)。',
  '2. 一次只问一个最高价值的问题;草稿中已明确给出的字段不要重复问。',
  '3. 全部字段明确后,把五字段合成完整 objective(结构:## Objective / ## Success criteria / ## Verification / ## Boundaries / ## Stop conditions),调用 create_goal 创建;若用户给出了轮次上限,一并传入 max_goal_rounds。',
  '4. 用户放弃则不创建 goal。不要在字段未明确时抢跑创建。',
].join('\n');

/** 澄清链入口消息:命令把草稿交给模型,由模型多轮追问后创建。 */
export function buildClarifyMessage(draft: string): UserMessage {
  return userText(`${CLARIFY_PROTOCOL}\n\n用户草稿意图:\n${draft.trim()}`);
}

const DIRECT_CREATE_PROTOCOL = [
  '[guided-goal] 用户已通过 Web 表单提供完整的 goal 定义,字段已确认,请直接创建,不要再追问。',
  '调用 create_goal,objective 使用以下内容;若下方给出了轮次上限,同时传入 max_goal_rounds。',
].join('\n');

/** 表单直建消息:五字段已由用户在 UI 中确认。 */
export function buildDirectCreateMessage(fields: GoalFields): UserMessage {
  const rounds = fields.maxGoalRounds?.trim();
  const suffix = rounds && rounds.length > 0 ? `\n\n轮次上限:${rounds}` : '';
  return userText(
    `${DIRECT_CREATE_PROTOCOL}\n\n${composeObjective(fields)}${suffix}`,
  );
}
