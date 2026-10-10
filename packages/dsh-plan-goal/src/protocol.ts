import {
  createUserMessage,
  type ContentBlock,
  type ContextFormed,
  type UserMessage,
} from '@deepseek-ai/dsh-llm';

/**
 * 插件自有消息来源:经 declaration merging 并入 MessageSourceMap。协议
 * 消息由插件生产,role 仍用 user 承载(聊天 API 只有四种角色),归属由
 * source 表达——UI 对未知 kind 回退渲染,不再显示为用户发言。
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plan-goal': {
      kind: 'plan-goal';
    } & ContextFormed;
  }
}

/** 协议语言:auto 走中文兜底(与 index.ts 的 ConfigLanguage 同形)。 */
export type ProtocolLanguage = 'auto' | 'zh' | 'en';

/** 构造一条 plan-goal 来源、user 角色承载的文本消息(steer 的载体)。 */
export function userText(text: string): UserMessage {
  // ContentBlock 判别联合的 text 变体:结构由 dsh-llm 契约定义
  const textBlock: ContentBlock = { type: 'text', text };
  return createUserMessage({
    source: { kind: 'plan-goal', form: 'instructions' },
    content: [textBlock],
  });
}

const PROTOCOL_ZH = [
  '[plan-goal] 用户希望以「先规划后执行」方式创建一个持久 goal(每会话一个,由 dsh goal 域管理):先在计划模式下完成调研与方案设计,计划经用户批准后,在同一轮内创建 goal。',
  '请严格按以下协议执行:',
  '1. 先调研后设计:先用只读手段完成必要调研(读代码、查证事实),再基于真实仓库事实设计方案;不确定的结论显式标注 [INFERENCE],不得虚构验证命令。',
  '2. 把计划文档写成 markdown 并以 # 标题开头,文档内嵌五字段 goal 块(作为 ## 小节):',
  '   ## Objective —— 目标陈述,一句话说清要达成什么;',
  '   ## Success criteria —— 成功标准,必须可判定,拒绝「做得好/完成」这类主观表述;',
  '   ## Verification —— 确切的验证命令或动作,逐条来自真实仓库事实(以实际构建体系为准),禁止臆造;',
  '   ## Boundaries —— 范围边界:允许触碰与禁止触碰的路径/模块;',
  '   ## Stop conditions —— 停止条件,必须包含完成总结要求:goal 结束时,最终回复须给出修改文件清单、Verification 逐项通过/失败对照、遗留问题与未处理项。',
  '3. 计划完成后调用 exit_plan_mode 提交计划,进入用户审阅(plan review):用户选择「Keep planning」并附反馈时,按反馈修订计划并重新提交 exit_plan_mode;批准不可跳过——这是本流程存在的核心目的。',
  '4. 硬规则:计划批准之前 create_goal 会被 guard 拒绝,不要尝试;唯一合法路径是 exit_plan_mode → 用户批准 → 同轮 create_goal。',
  '5. 用户批准后(收到 Plan approved 的工具结果),在同一轮内:把五字段块合成完整 objective,按工作量给出 max_goal_rounds(小型改动 2-3 轮,中型 5 轮,大型 8-10 轮,并说明取值依据),调用 create_goal。',
  '6. 调用 create_goal 后本回合立即结束:输出五字段摘要与假设清单(Assumptions:…),不要开始执行 goal 的工作(goal 会在后续轮次自主执行)。',
  '7. 用户放弃则不创建 goal,并提示可用 /plan off 退出计划模式。',
].join('\n');

const PROTOCOL_EN = [
  '[plan-goal] The user wants to create a persistent goal in plan-first mode (one per session, managed by the dsh goal domain): research and design a plan under plan mode, and only after the user approves that plan, create the goal in the same turn.',
  'Follow this protocol strictly:',
  '1. Research before design: use read-only means to gather the necessary facts (read code, verify claims), then design from real repository facts; mark uncertain conclusions explicitly as [INFERENCE] and never fabricate verification commands.',
  '2. Write the plan as markdown starting with a # heading, embedding a five-field goal block (as ## sections):',
  '   ## Objective — the goal statement in one sentence;',
  '   ## Success criteria — must be decidable; reject vague phrasing like "works well/done";',
  '   ## Verification — exact verification commands or actions, each grounded in real repository facts (follow the actual build system); never invent them;',
  '   ## Boundaries — allowed and forbidden paths/modules;',
  '   ## Stop conditions — must include a mandatory completion-summary requirement: when the goal finishes, the final reply must give the modified-file list, per-item Verification pass/fail results, and leftover issues or unhandled items.',
  '3. Submit the plan via exit_plan_mode for plan review: if the user chooses "Keep planning" with feedback, revise the plan accordingly and present it again via exit_plan_mode; approval cannot be skipped — that is the core purpose of this flow.',
  '4. Hard rule: before approval, create_goal is denied by a guard — do not attempt it; the only valid path is exit_plan_mode → user approval → create_goal in the same turn.',
  '5. After approval (the Plan approved tool result), still in the same turn: compose the five fields into a complete objective, pick max_goal_rounds by workload (small change 2-3 rounds, medium 5 rounds, large 8-10 rounds, and explain the basis), and call create_goal.',
  "6. After calling create_goal, end this turn immediately: output the five-field summary and the list of assumptions (Assumptions: ...); do not start executing the goal's work (the goal runs autonomously in later rounds).",
  '7. If the user gives up, do not create the goal, and suggest /plan off to leave plan mode.',
].join('\n');

function protocol(language: ProtocolLanguage): string {
  return language === 'en' ? PROTOCOL_EN : PROTOCOL_ZH;
}

/** 计划链入口消息:命令把草稿交给模型,由模型调研、出计划、经批准后创建。 */
export function buildPlanGoalMessage(
  draft: string,
  language: ProtocolLanguage = 'auto',
): UserMessage {
  const tail =
    language === 'en'
      ? `User draft intent:\n${draft.trim()}`
      : `用户草稿意图:\n${draft.trim()}`;
  return userText(`${protocol(language)}\n\n${tail}`);
}
