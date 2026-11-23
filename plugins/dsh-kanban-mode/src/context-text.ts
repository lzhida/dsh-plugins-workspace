/**
 * 看板模式工作法（八段）的纯文本渲染。
 *
 * 本模块只做一件事：把「看板模式」的工作纪律渲染成一段可注入系统提示的纯文本。
 * 它不读全局状态、不 import 宿主运行时包、没有任何副作用，因此可以被单测
 * 直接断言段落齐全。
 *
 * @module dsh-kanban-mode/context-text
 */

/** 看板模式工作法的八段标题（顺序即注入顺序，也是单测的形状锁）。 */
export const CONTEXT_SECTION_TITLES = [
  '总纪律',
  '拆卡',
  '前置',
  '并行',
  '定时',
  '验收',
  'Git 收尾与变更请求',
  '收割',
] as const;

/** 八段标题之一。 */
export type ContextSectionTitle = (typeof CONTEXT_SECTION_TITLES)[number];

/** 工作法单段：一组并列的纪律条目。 */
export interface ContextSection {
  /** 段落标题。 */
  readonly title: ContextSectionTitle;
  /** 该段的纪律条目。 */
  readonly bullets: readonly string[];
}

/** 看板上下文的小节标题（渲染时作为首行）。 */
export const CONTEXT_TITLE = '【看板模式工作法】';

/**
 * 八段的固定内容。顺序与 {@link CONTEXT_SECTION_TITLES} 一一对应。
 *
 * 内容口径来自 DSH 任务看板（taskboard）的执行纪律：
 * 先查板 → 先读后动 → 先认领 → 版本冲突只重试一次 → 验收交接 → 完成须用户确认；
 * 「收割」段的口径来自仓库根 docs/harvest-design.md（§5–§10 定稿设计）。
 */
export const CONTEXT_SECTIONS: readonly ContextSection[] = [
  {
    title: '总纪律',
    bullets: [
      '先查板：开工第一步先 taskboard_list 查本项目看板，有可认领的 todo 卡先按纪律认领，再读代码。',
      '先读后动：动卡前先 taskboard_get 读完整描述并读评论；评论视为最新需求，若要求等待/暂缓就停下汇报，不改状态。',
      '先认领再干活：把卡从 todo 迁到 in_progress（带 ifVersion）成功之后，才开始读代码与分析实现。',
      '认领失败即停：版本冲突、项目边界不符、已被他人持有，一律停止并报告，绝不循环重试或接管他人任务。',
      '版本冲突只重试一次：ifVersion 冲突时重新读卡，仅当状态仍可认领且需求未变时用新版本号重试一次，再失败即停止报告。',
      '验收交接：实现并自验后提交结构化执行报告（摘要 / 改动文件 / 自验 / 风险），评论里归档补充细节，再把卡迁到 in_review。',
      '完成须用户确认：永不把卡迁到 done——done 是用户的确认动作；验收清单全勾也不等于完成；blocked=无法继续，canceled=不再继续。',
      'backlog=未授权：backlog 里的卡不算批准执行，被指派也不是授权，除非用户明确要求。',
    ],
  },
  {
    title: '拆卡',
    bullets: [
      '复杂需求先拆成多卡再动手，一张卡 = 一个可独立验收的功能点。',
      '拆分表先给用户确认：先用 ask_user_question 或纯文本给出「卡标题 / 目标 / 验收标准 / 前置依赖」拆分表。',
      '用户确认后才落卡：确认之前不 taskboard_create，避免把没拍板的拆分直接写进看板。',
    ],
  },
  {
    title: '前置',
    bullets: [
      '有真实先后依赖时，用 blockedBy 把前置卡 id 落成机器门禁。',
      '只是建议顺序（本就并行、或只是先做更顺手）只写文字说明，不设 blockedBy 门禁。',
      '门禁只对同项目的前置卡生效，跨项目不设门禁。',
    ],
  },
  {
    title: '并行',
    bullets: [
      '无前置关系的卡可以并行推进，多张卡各自认领、各自自验。',
      '被前置阻塞的卡必须等前置完成：前置未完成时立即停止，不得抢跑。',
      '并行推进时每张卡各自记录进度与证据，不要把多张卡的结论混在一张卡里。',
      '可选增强：宿主安装官方 dsh-subagent-codex / dsh-subagent-claude-code 插件后，会话多出 subagent_codex / subagent_claude_code 两个一次性并行工位——它们是 one-shot 委派（每次新进程、无续接），只适合无共享上下文的独立小任务；未安装这两个插件时工具不存在，并行工作法不受任何影响，不安装也完全可以。',
    ],
  },
  {
    title: '定时',
    bullets: [
      '定时卡用于无人值守执行、套餐非高峰期、套餐重置后的时间窗口。',
      '定时卡默认使用看板模式执行（execution 取 scheduled + cron/一次性 runAt）。',
      '定时卡同样受总纪律约束：到点先查板、先认领，再执行；不自行置完成。',
    ],
  },
  {
    title: '验收',
    bullets: [
      '自验：先跑该卡的验收命令（测试 / 构建 / 类型检查），拿到真实输出再谈完成。',
      'execution_report：提交结构化执行报告（摘要 / 改动文件 / 自验方式 / 产物 / 剩余风险）。',
      '评论归档：在评论里补齐关键细节，便于后续复查与交接。',
      '置待验收：把卡迁到 in_review，等待用户确认。',
      '任务永不自行置完成，完成由用户确认。',
    ],
  },
  {
    title: 'Git 收尾与变更请求',
    bullets: [
      '条件增强，不是默认要求：只有宿主启用了官方 forge 的「变更请求与工作树」能力（安装并启用 @deepseek-ai/dsh-experimental-forge-bundle）时，后续两条才生效；未启用时按仓库常规 git 纪律收尾（分支与提交在工作目录内完成，push 交用户），不阻塞、不算未完成。',
      '启用 forge 时的硬要求：执行会话完成改动后开 PR（面板自动收集 gh pr create 与分支 push 更新的 PR），并且必须把 PR URL 写进 execution_report 与任务评论——模型目前没有读取已绑定变更请求的工具，PR URL 不回写看板，验收链即断点。',
      '启用 forge 时的验收衔接：验收人按回写的 PR URL / diff 审查，通过后仍按「待验收 → 用户确认完成」走；PR 合并与分支清理属 git 收尾，交用户执行。',
      '官方边界如实声明：forge 仅支持 GitHub/github.com 一个 provider（无 GitLab）；任务卡与变更请求之间没有官方双向绑定，靠 PR URL 回写搭桥。',
    ],
  },
  {
    title: '收割',
    bullets: [
      "收割（把任务分支合回目标分支）只在前置任务 status==='done' 之后执行：依赖门禁把 in_review 也算「前置已满足」，所以收割前必须 taskboard_get 显式确认被收割卡的 status 确为 done，否则停手并报告，不得抢跑。",
      '目标分支默认 = 收割时主区当前分支；需要指定时传 targetBranch（必须是本地已有分支，且 ≠ 任务分支，否则工具直接拒绝）。',
      '变基优先：默认在任务检出内 rebase 目标分支，再在主区 merge --no-ff；任务分支已有 upstream 且已推送 → 拒绝变基（不改写已推送历史），降级为 --no-ff 合并并置 degraded=true，notes 写明「拒绝变基」。',
      '主区脏不擅动：主区有未提交改动 → 工具拒绝收割并报脏文件清单，绝不替人 stash / clean / reset。',
      '全程本地操作、永不 push；push 与一切远端操作一律交用户。',
      '冲突先给结构化清单再问人：从 taskboard_harvest 输出的 conflict.files（冲突文件清单）与 suggestions（冲突类型 + 两侧摘要）先列清单，再用 ask_user_question 问「AI 解决 / 手动解决」——不许跳过清单直接动手。',
      'AI 解决：在任务检出内逐文件解决（编辑 + git add）→ 再调 taskboard_harvest(mode=apply) 续跑（工具检测到进行中的 rebase / merge 会走 --continue 收尾）。',
      '手动解决：工具保留冲突现场（rebase / merge 进行中，不 abort、不清理），并输出「手动收割指引」（分支名、目标分支、检出路径、建议命令序列）；人在检出内解决后 git add，再跑一次 apply 续跑。',
      '二次冲突最多再问一轮：AI 解决后仍冲突 → 至多再问一轮，仍冲突就停手交人。',
      "收割卡模板（agent 直接抄）：blockedBy=[被收割的任务卡 id]、presetId=kanban-mode、execution 用 claim（人认领）或 cron（定时）、prompt 显式写「先 taskboard_get 确认前置 status==='done'，否则停手」并调用 taskboard_harvest(mode=apply)。",
    ],
  },
];

/**
 * 渲染看板上下文纯文本。
 * @returns 标题 + 八段小节构成的纯文本（末尾无多余空行）。
 */
export function buildContext(): string {
  const lines: string[] = [CONTEXT_TITLE, ''];
  for (const section of CONTEXT_SECTIONS) {
    lines.push(`## ${section.title}`);
    for (const bullet of section.bullets) {
      lines.push(`- ${bullet}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
