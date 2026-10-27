/**
 * 技术交底书合规检查（纯函数，无 IO）。
 *
 * 检查维度（对齐 docs/template-spec.md 的结构）：七部分齐全性、头部字段
 * 占位提醒、第三部分公开充分度启发式、残留占位符扫描、技术问题主次结构。
 * 检查对象是 buildDisclosure 产出的内容 markdown（三条交付路径通用）。
 */

/** 单项合规诊断。 */
export type DisclosureCheckIssue = {
  /** 所属部分（全局为 'document'，头部为 'header'）。 */
  section: string;
  /** error = 结构缺失；warning = 提示用户注意/自行修改。 */
  severity: 'error' | 'warning';
  code: string;
  message: string;
};

/** 合规检查报告。 */
export type DisclosureCheckReport = {
  issues: DisclosureCheckIssue[];
  /** 是否无 error 级诊断。 */
  ok: boolean;
  stats: {
    /** 第三部分（详细阐述）有效字数。 */
    solutionChars: number;
    /** 检到的部分数。 */
    sectionCount: number;
  };
};

/** 七部分标题（行级精确匹配）。 */
export const DISCLOSURE_SECTIONS = [
  '## 一、背景技术',
  '## 二、背景技术的技术问题',
  '## 三、本案的详细阐述',
  '## 四、第三项的技术方案中有无可以替代的地方',
  '## 五、第三项的技术手段产生了什么技术效果',
  '## 六、本案需要保护的要点',
  '## 七、附图要求',
] as const;

/** 第三部分公开充分度的启发式字数下限（低于则提示公开不充分风险）。 */
export const SOLUTION_CHAR_FLOOR = 200;

/** 统计有效字数：剔除〔…〕占位与 markdown 标记/空白。 */
export function countEffectiveChars(text: string): number {
  return text.replace(/〔[^〕]*〕/g, '').replace(/[#>*`|\-\s]/g, '').length;
}

/** 提取某部分标题到下一个二级标题之间的正文行（### 子标题属于部分内正文）。 */
function extractSectionBody(lines: string[], title: string): string[] {
  const start = lines.findIndex((line) => line.trim() === title);
  if (start < 0) return [];
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) break;
    body.push(lines[i]!);
  }
  return body;
}

/** 主入口。 */
export function checkDisclosure(document: string): DisclosureCheckReport {
  const issues: DisclosureCheckIssue[] = [];
  const lines = document.split(/\r?\n/);

  // 1. 七部分齐全性（结构 error）
  let sectionCount = 0;
  for (const title of DISCLOSURE_SECTIONS) {
    if (lines.some((line) => line.trim() === title)) {
      sectionCount += 1;
    } else {
      issues.push({
        section: 'document',
        severity: 'error',
        code: 'SECTION_MISSING',
        message: `缺少部分「${title.replace(/^## /, '')}」：交底书应七部分齐全。`,
      });
    }
  }

  // 2. 头部字段占位提醒（warning：公司信息由用户自行修改）
  const headerBody = lines
    .slice(0, lines.findIndex((l) => l.startsWith('## ')) + 1)
    .join('\n');
  const headerPlaceholders = [...headerBody.matchAll(/〔([^〕]+)〕/g)].map(
    (m) => m[1]!,
  );
  for (const field of headerPlaceholders) {
    issues.push({
      section: 'header',
      severity: 'warning',
      code: 'HEADER_PLACEHOLDER',
      message: `头部字段「${field}」为占位，请在插件设置（disclosureDefaults）或输入中提供后重新生成，或交付前自行修改。`,
    });
  }

  // 3. 第三部分公开充分度（启发式 warning）
  const solutionBody = extractSectionBody(lines, '## 三、本案的详细阐述').join(
    '\n',
  );
  const solutionChars = countEffectiveChars(solutionBody);
  if (
    sectionCount > 0 &&
    solutionChars > 0 &&
    solutionChars < SOLUTION_CHAR_FLOOR
  ) {
    issues.push({
      section: '三',
      severity: 'warning',
      code: 'SOLUTION_SHALLOW',
      message: `第三部分仅 ${solutionChars} 字：完整公开的标准是同领域技术人员看过就能实施，建议补充结构/步骤/参数/数据流细节（可结合附图标记）。`,
    });
  }

  // 4. 技术问题主次结构（warning）
  const problemsBody = extractSectionBody(
    lines,
    '## 二、背景技术的技术问题',
  ).join('\n');
  const problemsChars = countEffectiveChars(problemsBody);
  if (problemsChars > 0 && !problemsBody.includes('最主要')) {
    issues.push({
      section: '二',
      severity: 'warning',
      code: 'PROBLEM_NO_PRIORITY',
      message:
        '第二部分未区分「最主要、最关键的技术问题」与次要问题；建议按模板结构分主次列出，便于代理师把握发明高度。',
    });
  }

  // 5. 残留占位符（warning：不含头部的〔…〕——头部已单列）
  const bodyText = lines
    .slice(lines.findIndex((l) => l.startsWith('## ')))
    .join('\n');
  const leftPlaceholders = [
    ...bodyText.matchAll(/〔(待填写|请填写|发明\/实用新型|是\/否)[^〕]*〕/g),
  ].length;
  if (leftPlaceholders > 0) {
    issues.push({
      section: 'document',
      severity: 'warning',
      code: 'PLACEHOLDER_LEFT',
      message: `正文仍有 ${leftPlaceholders} 处〔…〕占位未填写：交付前请补全或与发明人确认。`,
    });
  }

  return {
    issues,
    ok: !issues.some((i) => i.severity === 'error'),
    stats: { solutionChars, sectionCount },
  };
}
