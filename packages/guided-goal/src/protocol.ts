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
  '6. 用户放弃则不创建 goal。不要在字段未明确时抢跑创建。',
].join('\n');

const CLARIFY_PROTOCOL_EN = [
  '[guided-goal] The user wants to create a persistent goal in guided mode (one per session, managed by the dsh goal domain).',
  'Follow this protocol strictly:',
  '1. Clarify five fields in order: success criteria (must be decidable; reject vague phrasing like "works well/done"), verification (exact commands or actions), round cap (max attempts), boundaries (allowed/forbidden paths), stop conditions (when to stop and hand back to the human).',
  '2. Ask exactly one highest-value question at a time; do not re-ask fields already clear from the draft.',
  '3. Once all fields are clear, compose the full objective (structure: ## Objective / ## Success criteria / ## Verification / ## Boundaries / ## Stop conditions) and call create_goal; if the user gave a round cap, pass it as max_goal_rounds.',
  "4. After calling create_goal, end this turn immediately: output the five-field summary and the list of assumptions awaiting confirmation; do not start executing the goal's work (the goal runs autonomously in later rounds).",
  '5. The composed goal\'s Stop conditions must include a mandatory "completion summary" requirement: when the goal finishes, the final reply must give the modified-file list, per-item verification results (each Verification item pass/fail), and leftover issues or unhandled items.',
  '6. If the user gives up, do not create the goal. Never jump ahead to creation while fields remain unclear.',
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

const QUICK_CREATE_PROTOCOL_ZH = [
  '[guided-goal] 用户希望以快速方式创建持久 goal:仅提供一句话草稿,不进行任何访谈。',
  '请严格按以下协议执行:',
  '1. 不要向用户提出任何澄清问题;基于草稿与对工作区的必要只读勘察(Grep/读文件,不得修改任何文件),自行推断五个字段:成功标准(必须可判定)、验证方式(确切命令或动作)、迭代上限(见第 3 条)、范围边界(允许/禁止触碰的路径)、停止条件(何时停下交还人工)。',
  '2. 任何由推断得出、草稿未明确的字段,在最终回复中显式标注"假设:…",便于用户事后纠正。',
  '3. 迭代上限(max_goal_rounds)按以下优先级确定,且最终回复须说明取值依据:',
  '   a. 用户显式指定:优先采用,不做调整;',
  '   b. 用户显式"不限轮次":仅在用户明确要求时允许,create_goal 不传 max_goal_rounds,须在回复中提醒消耗风险;',
  '   c. 模型按工作量估算(此时禁止选择"不限轮次",必须给有限值):小型改动(文案/单文件小修)2-3 轮;中型(单功能/多文件)5 轮;大型(跨模块/架构性)8-10 轮。',
  '4. 合成 objective(结构:## Objective / ## Success criteria / ## Verification / ## Boundaries / ## Stop conditions)后立即调用 create_goal。',
  '5. 调用 create_goal 后本回合立即结束:输出五字段摘要与「假设:…」清单,不要开始执行 goal 的工作(goal 会在后续轮次自主执行)。',
  '6. 合成的 goal 中,Stop conditions 必须包含「完成后输出总结」要求:goal 执行结束时,最终回复须给出修改文件清单、逐条验证结果对照(Verification 每项通过/失败)、遗留问题与未处理项。',
  '7. 唯一例外:草稿语义过于模糊无法安全推断(目标对象不存在、意图自相矛盾)时,不要编造——停下说明缺失并请求用户补充。',
].join('\n');

const QUICK_CREATE_PROTOCOL_EN = [
  '[guided-goal] The user wants to create a persistent goal in quick mode: only a one-line draft, no interview.',
  'Follow this protocol strictly:',
  '1. Do not ask the user any clarifying questions; based on the draft and necessary read-only reconnaissance of the workspace (Grep/read files; do not modify anything), infer the five fields yourself: success criteria (must be decidable), verification (exact commands or actions), round cap (see rule 3), boundaries (allowed/forbidden paths), stop conditions (when to stop and hand back to the human).',
  '2. For any field inferred rather than stated in the draft, mark it explicitly as "Assumption: ..." in the final reply so the user can correct it later.',
  '3. Determine the round cap (max_goal_rounds) by this precedence, and explain the choice in the final reply:',
  '   a. Explicitly specified by the user: adopt as-is, no adjustment;',
  '   b. User explicitly asked for unlimited rounds: only then may create_goal omit max_goal_rounds; warn about token consumption in the reply;',
  '   c. Otherwise estimate by workload (unlimited is forbidden in this case; a finite value is required): small change (copy/single-file fix) 2-3 rounds; medium (single feature/multi-file) 5 rounds; large (cross-module/architectural) 8-10 rounds.',
  '4. Compose the objective (structure: ## Objective / ## Success criteria / ## Verification / ## Boundaries / ## Stop conditions) and call create_goal immediately.',
  '5. After calling create_goal, end this turn immediately: output the five-field summary and the "Assumption: ..." list; do not start executing the goal\'s work (the goal runs autonomously in later rounds).',
  '6. The composed goal\'s Stop conditions must include a mandatory "completion summary" requirement: when the goal finishes, the final reply must give the modified-file list, per-item verification results (each Verification item pass/fail), and leftover issues or unhandled items.',
  '7. Sole exception: if the draft is too vague to infer safely (target does not exist, or intent is self-contradictory), do not fabricate — stop, explain what is missing, and ask the user to supply it.',
].join('\n');

function quickProtocol(language: ProtocolLanguage): string {
  return language === 'en'
    ? QUICK_CREATE_PROTOCOL_EN
    : QUICK_CREATE_PROTOCOL_ZH;
}

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
    if (/^(unlimited|不限|无限|∞)$/i.test(head))
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
  language: ProtocolLanguage = 'auto',
): UserMessage {
  const roundsHint =
    language === 'en'
      ? QUICK_ROUNDS_HINT_EN[rounds.kind]
      : ROUNDS_HINT[rounds.kind];
  const tail =
    language === 'en'
      ? `User draft intent:\n${draft}`
      : `用户草稿意图:\n${draft}`;
  return userText(`${quickProtocol(language)}\n\n${roundsHint}\n\n${tail}`);
}

const QUICK_ROUNDS_HINT_EN: Record<QuickRounds['kind'], string> = {
  fixed:
    'Round cap: explicitly specified by the user; adopt as-is, no adjustment.',
  unlimited:
    'Round cap: the user explicitly asked for unlimited rounds — only in this case may max_goal_rounds be omitted; warn about token consumption in the reply.',
  estimate:
    'Round cap: not specified by the user; you must estimate by workload and explain the basis. Choosing unlimited is forbidden in this case; a finite value is required (tiers: small 2-3 rounds / medium 5 rounds / large 8-10 rounds).',
};
