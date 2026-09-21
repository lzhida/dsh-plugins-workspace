import {
  createUserMessage,
  type ContentBlock,
  type UserMessage,
} from '@deepseek-ai/dsh-llm';

/** 协议语言:auto 走中文兜底(与 index.ts 的 ConfigLanguage 同形)。 */
type ProtocolLanguage = 'auto' | 'zh' | 'en';

/** 构造一条 source 为用户的文本消息(steer 的载体)。 */
export function userText(text: string): UserMessage {
  // ContentBlock 判别联合的 text 变体:结构由 dsh-llm 契约定义
  const textBlock: ContentBlock = { type: 'text', text };
  return createUserMessage({
    source: { kind: 'user' },
    content: [textBlock],
  });
}

const CLARIFY_PROTOCOL_ZH = [
  '[guided-goal] 用户希望以引导方式创建一个持久 goal(每会话一个,由 dsh goal 域管理)。',
  '请严格按以下协议执行:',
  '1. 依次澄清五个字段:成功标准(必须可判定,拒绝"做得好/完成"等主观表述)、验证方式(确切命令或动作)、迭代上限(最多几轮尝试)、范围边界(允许/禁止触碰的路径)、停止条件(何时停下交还人工)。',
  '2. 一次只问一个最高价值的问题;草稿中已明确给出的字段不要重复问。',
  '3. 全部字段明确后,把五字段合成完整 objective(结构:## Objective / ## Success criteria / ## Verification / ## Boundaries / ## Stop conditions),调用 create_goal 创建;若用户给出了轮次上限,一并传入 max_goal_rounds。',
  '4. 调用 create_goal 后本回合立即结束:输出五字段摘要与待用户确认的假设清单,不要开始执行 goal 的工作(goal 会在后续轮次自主执行)。',
  '5. 合成的 goal 中,Stop conditions 必须包含「完成后输出总结」要求:goal 执行结束时,最终回复须给出修改文件清单、逐条验证结果对照(Verification 每项通过/失败)、遗留问题与未处理项。',
  '6. 唯一可跳过访谈的情形:草稿已足够明确(目标对象、成功标准、范围均可直接判定)或用户明确表示不愿被访谈时,你可以跳过澄清直接合成 objective 并调用 create_goal;所有由推断得出、草稿未明确的字段,在最终回复中显式标注「假设:…」;轮次上限按工作量估算:小型改动(文案/单文件小修)2-3 轮,中型(单功能/多文件)5 轮,大型(跨模块/架构性)8-10 轮,并在回复中说明取值依据。除此之外一律访谈。',
  '7. 用户放弃则不创建 goal。不要在字段未明确时抢跑创建。',
].join('\n');

const CLARIFY_PROTOCOL_EN = [
  '[guided-goal] The user wants to create a persistent goal in guided mode (one per session, managed by the dsh goal domain).',
  'Follow this protocol strictly:',
  '1. Clarify five fields in order: success criteria (must be decidable; reject vague phrasing like "works well/done"), verification (exact commands or actions), round cap (max attempts), boundaries (allowed/forbidden paths), stop conditions (when to stop and hand back to the human).',
  '2. Ask exactly one highest-value question at a time; do not re-ask fields already clear from the draft.',
  '3. Once all fields are clear, compose the full objective (structure: ## Objective / ## Success criteria / ## Verification / ## Boundaries / ## Stop conditions) and call create_goal; if the user gave a round cap, pass it as max_goal_rounds.',
  "4. After calling create_goal, end this turn immediately: output the five-field summary and the list of assumptions awaiting confirmation; do not start executing the goal's work (the goal runs autonomously in later rounds).",
  '5. The composed goal\'s Stop conditions must include a mandatory "completion summary" requirement: when the goal finishes, the final reply must give the modified-file list, per-item verification results (each Verification item pass/fail), and leftover issues or unhandled items.',
  '6. Sole case for skipping the interview: when the draft is already sufficiently specific (target, success criteria, and scope are all directly decidable) or the user clearly declines to be interviewed, you may skip clarification, compose the objective, and call create_goal directly; mark every inferred field explicitly as "Assumption: ..." in the final reply; estimate the round cap by workload: small change (copy/single-file fix) 2-3 rounds, medium (single feature/multi-file) 5 rounds, large (cross-module/architectural) 8-10 rounds, and explain the basis in the reply. Otherwise always interview.',
  '7. If the user gives up, do not create the goal. Never jump ahead to creation while fields remain unclear.',
].join('\n');

function clarifyProtocol(language: ProtocolLanguage): string {
  return language === 'en' ? CLARIFY_PROTOCOL_EN : CLARIFY_PROTOCOL_ZH;
}

/** 澄清链入口消息:命令把草稿交给模型,由模型多轮追问后创建。 */
export function buildClarifyMessage(
  draft: string,
  language: ProtocolLanguage = 'auto',
): UserMessage {
  const tail =
    language === 'en'
      ? `User draft intent:\n${draft.trim()}`
      : `用户草稿意图:\n${draft.trim()}`;
  return userText(`${clarifyProtocol(language)}\n\n${tail}`);
}
