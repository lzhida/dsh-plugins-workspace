/**
 * 工具二 kanban_plan_check（只读）：对一份结构化拆卡方案做五类机械校验。
 *
 * 校验口径与内嵌 skill（kanban-task-create）的建卡纪律一致：
 *   ① 系列命名 `<主题>系列 n/N：<祈使短句>`（主题 2~10 字全组逐字一致、
 *      n 从 1 起连续无跳号、N = 总卡数、冒号后有动作短语；多卡强制，
 *      单卡不适用）；
 *   ② description 四段「目标与成功标准 / 范围 / 实施要点 / 边界情况与
 *      已知风险」齐全（多卡另要求「系列全景」行）；
 *   ③ prompt 四段「先读后动 / 执行位置 / 依赖与门禁 / 交接纪律」齐全；
 *   ④ checklist 可观察：非空、每条 ≤200 字符、无重复；纯评价词告警
 *      （不硬拒）；
 *   ⑤ 依赖图：blockedBy 下标合法、无环（DFS）、可拓扑排序；「下游卡引用
 *      更晚下标卡」告警（建卡拓扑序违规提示，不硬拒）。
 *
 * 机械校验不代替人判断：结果必须附声明，确认需求与拆分仍须用户点头。
 *
 * @module dsh-kanban-mode/tools/plan-check
 */

import { TOOL_ERR } from './board-contract.ts';
import { defineTool } from './define-tool.ts';

/** 工具名。 */
export const PLAN_CHECK_TOOL_NAME = 'kanban_plan_check';

/** 工具描述。 */
export const PLAN_CHECK_TOOL_DESCRIPTION =
  '对一份结构化拆卡方案（cards 数组 + 可选 series）做五类机械校验：系列命名模板、description 四段、prompt 四段、checklist 可观察性、依赖图合法性与拓扑序。只读工具，不建卡；输出 pass/fail 与可操作的失败原因。建系列卡前先跑一遍，避免建卡后被上游拒收；机械校验不代替人判断。';

/** 单卡方案形状（字段校验前的宽松视图）。 */
export interface PlanCardInput {
  readonly title?: unknown;
  readonly description?: unknown;
  readonly prompt?: unknown;
  readonly checklist?: unknown;
  readonly blockedBy?: unknown;
}

/** 方案形状（字段校验前的宽松视图）。 */
export interface PlanInput {
  readonly series?: { readonly theme?: unknown; readonly total?: unknown };
  readonly cards?: unknown;
}

/** 一类校验的结果。 */
export interface PlanCheckItem {
  /** 校验名（①…⑤）。 */
  readonly check: string;
  readonly pass: boolean;
  /** 通过说明或失败的可操作原因。 */
  readonly detail: string;
}

/** 工具返回值。 */
export interface PlanCheckValue {
  readonly results: PlanCheckItem[];
  /** 告警（不硬拒）：纯评价词条目、拓扑序违规等。 */
  readonly warnings: string[];
  readonly cardCount: number;
  readonly disclaimer: string;
}

/** 机械校验免责声明（每次输出必附）。 */
export const PLAN_CHECK_DISCLAIMER =
  '机械校验不代替人判断：确认需求与拆分仍须用户点头';

/** checklist 单条长度上限（照上游 MAX_CHECKLIST_TEXT=200）。 */
const CHECKLIST_TEXT_CAP = 200;

/** description 四段关键词（照内嵌 skill 口径）。 */
const DESCRIPTION_SECTIONS = [
  '目标与成功标准',
  '范围',
  '实施要点',
  '边界情况与已知风险',
] as const;

/** prompt 四段关键词（照内嵌 skill 口径）。 */
const PROMPT_SECTIONS = [
  '先读后动',
  '执行位置',
  '依赖与门禁',
  '交接纪律',
] as const;

/** 纯评价词黑名单（整条命中 → 告警不硬拒）。 */
const EVALUATIVE_PHRASES: ReadonlySet<string> = new Set([
  '做好',
  '完善',
  '优化',
  '改进',
  '处理',
  '搞定',
  '弄好',
  '提升',
  '加强',
  '落实',
]);

/** 系列命名模板：`<主题>系列 n/N：<祈使短句>`（中文全角冒号）。 */
const SERIES_TITLE_PATTERN = /^(.+?)系列\s*(\d+)\/(\d+)：\s*(.*)$/;

/** 主题字数范围（照内嵌 skill 口径：2~10 字）。 */
const THEME_MIN_CODE_POINTS = 2;
const THEME_MAX_CODE_POINTS = 10;

/** 把 unknown 压成窄化后的方案形状；结构非法时抛可操作错误。 */
function narrowPlan(raw: unknown): {
  series: PlanInput['series'];
  cards: PlanCardInput[];
} {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(
      `Error: ${TOOL_ERR.invalidInput}: plan 必须是对象（{ series?, cards: [...] }）`,
    );
  }
  const plan = raw as PlanInput;
  if (!Array.isArray(plan.cards) || plan.cards.length === 0) {
    throw new Error(
      `Error: ${TOOL_ERR.invalidInput}: plan.cards 必须是非空数组（每项 { title, description, prompt, checklist, blockedBy }）`,
    );
  }
  return { series: plan.series, cards: plan.cards as PlanCardInput[] };
}

/** 按码点数计字符串长度（中文按字数）。 */
function codePoints(text: string): number {
  return Array.from(text).length;
}

/** 校验①：系列命名模板（多卡强制，单卡不适用）。 */
function checkSeriesNaming(
  cards: readonly PlanCardInput[],
  series: PlanInput['series'],
): PlanCheckItem {
  const total = cards.length;
  if (total === 1) {
    return {
      check: '①系列命名',
      pass: true,
      detail:
        '单卡方案不适用系列命名模板（<主题>系列 n/N：<祈使短句> 仅多卡强制）',
    };
  }
  const failures: string[] = [];
  const parsed: Array<{
    index: number;
    theme: string;
    n: number;
    nTotal: number;
    action: string;
  }> = [];
  cards.forEach((card, index) => {
    const title = typeof card.title === 'string' ? card.title : '';
    const match = SERIES_TITLE_PATTERN.exec(title);
    if (match === null) {
      failures.push(
        `第 ${index} 卡 title「${title}」不匹配模板「<主题>系列 n/N：<祈使短句>」（中文全角冒号）`,
      );
      return;
    }
    const theme = match[1] ?? '';
    const n = Number.parseInt(match[2] ?? '', 10);
    const nTotal = Number.parseInt(match[3] ?? '', 10);
    const action = (match[4] ?? '').trim();
    const themeLength = codePoints(theme);
    if (
      themeLength < THEME_MIN_CODE_POINTS ||
      themeLength > THEME_MAX_CODE_POINTS
    ) {
      failures.push(
        `第 ${index} 卡主题「${theme}」为 ${themeLength} 字，须 2~10 字`,
      );
    }
    if (!(action.length > 0)) {
      failures.push(`第 ${index} 卡冒号后缺少动作短语（祈使短句）`);
    }
    parsed.push({ index, theme, n, nTotal, action });
  });
  const themes = new Set(parsed.map((item) => item.theme));
  if (themes.size > 1) {
    failures.push(
      `全组主题须逐字一致，实际出现 ${themes.size} 种：${[...themes].join('、')}`,
    );
  }
  const badTotals = parsed.filter((item) => item.nTotal !== total);
  if (badTotals.length > 0) {
    failures.push(
      `N（分母）须等于总卡数 ${total}，以下卡的 N 不符：${badTotals
        .map((item) => `第 ${item.index} 卡 N=${item.nTotal}`)
        .join('、')}`,
    );
  }
  const numbers = parsed.map((item) => item.n).sort((a, b) => a - b);
  const expected = Array.from({ length: total }, (_, i) => i + 1);
  const broken =
    numbers.length !== total ||
    numbers.some((value, i) => value !== expected[i]);
  if (broken) {
    failures.push(
      `n 须从 1 起连续无跳号（期望 ${expected.join(', ')}，实际 ${numbers.join(', ')}）`,
    );
  }
  if (
    series !== undefined &&
    series.total !== undefined &&
    series.total !== total
  ) {
    failures.push(
      `series.total=${String(series.total)} 与 cards.length=${total} 不一致`,
    );
  }
  return {
    check: '①系列命名',
    pass: failures.length === 0,
    detail:
      failures.length === 0
        ? `${total} 张卡命名符合「<主题>系列 n/N：<祈使短句>」`
        : failures.join('；'),
  };
}

/** 校验②/③共用：段落关键词齐全检查。 */
function checkSections(
  cards: readonly PlanCardInput[],
  field: 'description' | 'prompt',
  keywords: readonly string[],
  extraMultiCardKeyword?: string,
): PlanCheckItem {
  const label = field === 'description' ? '②description 四段' : '③prompt 四段';
  const failures: string[] = [];
  cards.forEach((card, index) => {
    const text = typeof card[field] === 'string' ? (card[field] as string) : '';
    const missing = keywords.filter((word) => !text.includes(word));
    if (missing.length > 0) {
      failures.push(
        `第 ${index} 卡 ${field} 缺少段落标记：${missing.join('、')}`,
      );
    }
    if (
      extraMultiCardKeyword !== undefined &&
      cards.length > 1 &&
      !text.includes(extraMultiCardKeyword)
    ) {
      failures.push(
        `第 ${index} 卡 ${field} 缺少「${extraMultiCardKeyword}」行（系列多卡必填）`,
      );
    }
  });
  return {
    check: label,
    pass: failures.length === 0,
    detail:
      failures.length === 0
        ? `${cards.length} 张卡的 ${field} 段落标记齐全（${keywords.join(' / ')}${extraMultiCardKeyword !== undefined && cards.length > 1 ? ` + ${extraMultiCardKeyword}` : ''}）`
        : failures.join('；'),
  };
}

/** 校验④：checklist 可观察性（纯评价词只告警不硬拒）。 */
function checkChecklist(cards: readonly PlanCardInput[]): {
  item: PlanCheckItem;
  warnings: string[];
} {
  const failures: string[] = [];
  const warnings: string[] = [];
  cards.forEach((card, index) => {
    const raw = card.checklist;
    if (!Array.isArray(raw) || raw.length === 0) {
      failures.push(`第 ${index} 卡 checklist 为空（至少一条可勾验的验收项）`);
      return;
    }
    const seen = new Set<string>();
    raw.forEach((entry, itemIndex) => {
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        failures.push(
          `第 ${index} 卡 checklist 第 ${itemIndex} 条为空或非字符串`,
        );
        return;
      }
      const text = entry.trim();
      if (codePoints(text) > CHECKLIST_TEXT_CAP) {
        failures.push(
          `第 ${index} 卡 checklist 第 ${itemIndex} 条 ${codePoints(text)} 字符，超过上限 ${CHECKLIST_TEXT_CAP}`,
        );
      }
      if (seen.has(text)) {
        failures.push(`第 ${index} 卡 checklist 存在重复条目：「${text}」`);
      }
      seen.add(text);
      const bare = text.replace(/(?:了|一下|好)$/u, '');
      if (EVALUATIVE_PHRASES.has(text) || EVALUATIVE_PHRASES.has(bare)) {
        warnings.push(
          `第 ${index} 卡 checklist 第 ${itemIndex} 条「${text}」疑似纯评价词（无宾语/无验收动作）：建议改为可观察的完成判据；此为告警不硬拒`,
        );
      }
    });
  });
  return {
    item: {
      check: '④checklist 可观察',
      pass: failures.length === 0,
      detail:
        failures.length === 0
          ? `${cards.length} 张卡的 checklist 非空、无重复、每条 ≤${CHECKLIST_TEXT_CAP} 字符`
          : failures.join('；'),
    },
    warnings,
  };
}

/** DFS 检测依赖环，返回环节点下标（无环返回 undefined）。 */
function findCycle(cards: readonly PlanCardInput[]): number[] | undefined {
  const graph = cards.map((card) => {
    const blockedBy = Array.isArray(card.blockedBy) ? card.blockedBy : [];
    return blockedBy.filter(
      (entry) => typeof entry === 'number' && Number.isInteger(entry),
    ) as number[];
  });
  const state = new Array<number>(cards.length).fill(0);
  const stack: number[] = [];
  const visit = (node: number): number[] | undefined => {
    if (state[node] === 1) {
      const start = stack.indexOf(node);
      return stack.slice(start === -1 ? 0 : start).concat(node);
    }
    if (state[node] === 2) return undefined;
    state[node] = 1;
    stack.push(node);
    for (const next of graph[node] ?? []) {
      const cycle = visit(next);
      if (cycle !== undefined) return cycle;
    }
    stack.pop();
    state[node] = 2;
    return undefined;
  };
  for (let index = 0; index < cards.length; index += 1) {
    const cycle = visit(index);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

/** 校验⑤：依赖图（下标合法 + 无环 + 可拓扑；下游引用更晚下标只告警）。 */
function checkDependencyGraph(cards: readonly PlanCardInput[]): {
  item: PlanCheckItem;
  warnings: string[];
} {
  const total = cards.length;
  const failures: string[] = [];
  const warnings: string[] = [];
  const edges: number[][] = [];
  cards.forEach((card, index) => {
    const raw = card.blockedBy;
    const list = Array.isArray(raw) ? raw : [];
    const valid: number[] = [];
    for (const entry of list) {
      if (typeof entry !== 'number' || !Number.isInteger(entry)) {
        failures.push(
          `第 ${index} 卡 blockedBy 含非整数下标：${String(entry)}`,
        );
      } else if (entry < 0 || entry >= total) {
        failures.push(
          `第 ${index} 卡 blockedBy 下标 ${entry} 越界（合法范围 0~${total - 1}）`,
        );
      } else if (entry === index) {
        failures.push(`第 ${index} 卡 blockedBy 引用自己（自环）`);
      } else {
        valid.push(entry);
      }
    }
    edges.push(valid);
  });
  if (failures.length === 0) {
    const cycle = findCycle(cards);
    if (cycle !== undefined) {
      failures.push(
        `依赖图成环（blockedBy 拓扑不可排序）：${cycle.map((i) => `第 ${i} 卡`).join(' → ')}`,
      );
    }
  }
  if (failures.length === 0) {
    cards.forEach((_card, index) => {
      for (const dep of edges[index] ?? []) {
        if (dep > index) {
          warnings.push(
            `第 ${index} 卡引用了更晚下标的第 ${dep} 卡：建卡应按拓扑序（前置先建、下标更小），否则建卡时上游依赖校验会拒绝`,
          );
        }
      }
    });
  }
  return {
    item: {
      check: '⑤依赖图',
      pass: failures.length === 0,
      detail:
        failures.length === 0
          ? `${total} 张卡的 blockedBy 下标合法、无环、可拓扑排序`
          : failures.join('；'),
    },
    warnings,
  };
}

/**
 * 五类机械校验（纯函数，单测直接覆盖）。
 */
export function buildPlanCheckValue(raw: unknown): PlanCheckValue {
  const { series, cards } = narrowPlan(raw);
  const checklist = checkChecklist(cards);
  const dependency = checkDependencyGraph(cards);
  const results: PlanCheckItem[] = [
    checkSeriesNaming(cards, series),
    checkSections(cards, 'description', DESCRIPTION_SECTIONS, '系列全景'),
    checkSections(cards, 'prompt', PROMPT_SECTIONS),
    checklist.item,
    dependency.item,
  ];
  return {
    results,
    warnings: [...checklist.warnings, ...dependency.warnings],
    cardCount: cards.length,
    disclaimer: PLAN_CHECK_DISCLAIMER,
  };
}

/** render：逐类输出 pass/fail 与原因，末尾附免责声明。 */
function renderPlanCheck(value: PlanCheckValue): string[] {
  const lines: string[] = [`拆卡方案机械校验（${value.cardCount} 张卡）：`];
  for (const item of value.results) {
    lines.push(
      `- ${item.check}：${item.pass ? 'PASS' : 'FAIL'} —— ${item.detail}`,
    );
  }
  if (value.warnings.length === 0) {
    lines.push('- 告警：无');
  } else {
    lines.push(`- 告警（${value.warnings.length} 条，不硬拒）：`);
    for (const warning of value.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  const failed = value.results.filter((item) => !item.pass);
  lines.push(
    failed.length === 0
      ? '- 结论：五类机械校验全部通过；可按此方案建卡（建议按拓扑序建卡）'
      : `- 结论：${failed.length} 类校验未通过，先修正上述失败原因再建卡`,
  );
  lines.push(`- ${value.disclaimer}`);
  return lines;
}

/** 构造 kanban_plan_check 工具定义。 */
export function buildPlanCheckTool(): ReturnType<
  typeof defineTool<{ plan: unknown }, PlanCheckValue>
> {
  return defineTool<{ plan: unknown }, PlanCheckValue>({
    name: PLAN_CHECK_TOOL_NAME,
    description: PLAN_CHECK_TOOL_DESCRIPTION,
    parameters: {
      plan: {
        type: 'json',
        description:
          '结构化拆卡方案：{ series?: { theme, total }, cards: [{ title, description, prompt, checklist: string[], blockedBy: number[] }] }；blockedBy 引用 cards 数组下标',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [
        { type: 'text', text: renderPlanCheck(value).join('\n') },
      ],
    },
    async execute(args) {
      return buildPlanCheckValue(args.plan);
    },
  });
}
