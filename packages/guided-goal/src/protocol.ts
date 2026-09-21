import {
  createUserMessage,
  type ContentBlock,
  type UserMessage,
} from '@deepseek-ai/dsh-llm';

/** 构造一条 source 为用户的文本消息(steer 的载体)。 */
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

const QUICK_CREATE_PROTOCOL = [
  '[guided-goal] 用户希望以快速方式创建持久 goal:仅提供一句话草稿,不进行任何访谈。',
  '请严格按以下协议执行:',
  '1. 不要向用户提出任何澄清问题;基于草稿与对工作区的必要只读勘察(Grep/读文件,不得修改任何文件),自行推断五个字段:成功标准(必须可判定)、验证方式(确切命令或动作)、迭代上限(见第 3 条)、范围边界(允许/禁止触碰的路径)、停止条件(何时停下交还人工)。',
  '2. 任何由推断得出、草稿未明确的字段,在最终回复中显式标注"假设:…",便于用户事后纠正。',
  '3. 迭代上限(max_goal_rounds)按以下优先级确定,且最终回复须说明取值依据:',
  '   a. 用户显式指定:优先采用,不做调整;',
  '   b. 用户显式"不限轮次":仅在用户明确要求时允许,create_goal 不传 max_goal_rounds,须在回复中提醒消耗风险;',
  '   c. 模型按工作量估算(此时禁止选择"不限轮次",必须给有限值):小型改动(文案/单文件小修)2-3 轮;中型(单功能/多文件)5 轮;大型(跨模块/架构性)8-10 轮。',
  '4. 合成 objective(结构:## Objective / ## Success criteria / ## Verification / ## Boundaries / ## Stop conditions)后立即调用 create_goal。',
  '5. 唯一例外:草稿语义过于模糊无法安全推断(目标对象不存在、意图自相矛盾)时,不要编造——停下说明缺失并请求用户补充。',
].join('\n');

/** 快速创建的轮次来源:用户指定数字 / 用户显式不限 / 模型按工作量估算。 */
export type QuickRounds =
  | { kind: 'fixed'; rounds: number }
  | { kind: 'unlimited' }
  | { kind: 'estimate' };

/** 解析 quick-goal 输入:支持 "N | 草稿"、"不限 | 草稿" 与裸草稿三种形态。 */
export function parseQuickInput(raw: string): {
  rounds: QuickRounds;
  draft: string;
} {
  const text = raw.trim();
  const pipe = text.indexOf('|');
  if (pipe > 0) {
    const head = text.slice(0, pipe).trim();
    const draft = text.slice(pipe + 1).trim();
    if (/^(不限|无限|∞)$/.test(head))
      return { rounds: { kind: 'unlimited' }, draft };
    const n = Number(head);
    if (head.length > 0 && Number.isInteger(n) && n > 0) {
      return { rounds: { kind: 'fixed', rounds: n }, draft };
    }
  }
  return { rounds: { kind: 'estimate' }, draft: text };
}

const ROUNDS_HINT: Record<QuickRounds['kind'], string> = {
  fixed: '迭代上限:用户显式指定,优先采用,不做调整。',
  unlimited:
    '迭代上限:用户显式要求不限轮次——仅此情况允许不传 max_goal_rounds,并在回复中提醒 token 消耗风险。',
  estimate:
    '迭代上限:用户未指定,由你按工作量估算并说明依据;此时禁止选择"不限轮次",必须给出有限值(档位:小型 2-3 轮 / 中型 5 轮 / 大型 8-10 轮)。',
};

/** 快速创建消息:模型零提问自填五字段直接创建。 */
export function buildQuickCreateMessage(
  draft: string,
  rounds: QuickRounds,
): UserMessage {
  return userText(
    `${QUICK_CREATE_PROTOCOL}\n\n${ROUNDS_HINT[rounds.kind]}\n\n用户草稿意图:\n${draft}`,
  );
}
