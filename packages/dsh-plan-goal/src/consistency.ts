/**
 * objective–plan 一致性告警的纯函数内核(零宿主依赖,直接单测)。
 *
 * 职责边界:只做 `##` 级标题的包含比对——已审计划内嵌五字段块(Objective /
 * Success criteria / Verification / Boundaries / Stop conditions),批准后
 * 同轮合成的 objective 应保留这些字段结构;缺失即提示"偏离了已审计划"。
 * 语义级比对(措辞是否忠实)超出插件能力,不做也不假装做了。
 */

/** 提取文本中的 `## ` 级标题(去除行首空白,按出现顺序,保留原文)。 */
export function extractHeadings(text: string): string[] {
  const headings: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s{0,3}##\s+(.+?)\s*$/u.exec(line);
    if (match) headings.push(match[1].trim());
  }
  return headings;
}

export interface ConsistencyFinding {
  /** 已审计划中存在、但 objective 缺失的 `##` 标题。 */
  missing: string[];
}

/**
 * 比对已审计划与最终 objective:计划中的每个 `##` 标题都应在 objective
 * 出现。空文本/无标题按"无约束"处理(不产生 missing)。
 */
export function checkConsistency(
  plan: string,
  objective: string,
): ConsistencyFinding {
  const objectiveHeadings = new Set(extractHeadings(objective));
  const missing = extractHeadings(plan).filter(
    (heading) => !objectiveHeadings.has(heading),
  );
  return { missing };
}
