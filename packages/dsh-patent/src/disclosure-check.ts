/**
 * 技术交底书合规检查（纯函数，无 IO）。
 *
 * 检查维度（对齐 docs/template-spec.md 的结构）：七部分齐全性、头部字段
 * 占位提醒、第三部分公开充分度启发式、残留占位符扫描、技术问题主次结构、
 * 同源文本重复度、部分间成对复用、「所述」术语变体（一词多义信号）。
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

/**
 * 全文同源文本检测阈值：两段文本的最长公共后缀达到该字数即报
 * （摘要 / 发明内容效果段 / 实施方式末尾三处同源是真实初稿暴露的形态）。
 */
export const DUPLICATE_COMMON_SUFFIX_FLOOR = 100;

/**
 * 部分间成对复用检测阈值：第三部分（实施方式）与第五部分（技术效果）
 * 对应段落的公共后缀达到该字数即报（初稿实测形态：发明内容 8 段
 * 「本方案…」与实施方式 8 段「在本实施例中…」逐字复用）。
 */
export const SECTION_PAIR_SUFFIX_FLOOR = 40;

/** 术语变体检测中参与比对的术语最小长度（过滤「方法/系统」类通用短词）。 */
export const TERM_VARIANT_MIN_LEN = 3;

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

/**
 * 把正文切成「段落块」：按空行分段；剔除标题行、剥掉行首 markdown 列表
 * 标记与〔…〕占位，合并空白；过短的块（通用短语/孤立编号）不参与比对。
 */
function extractParagraphBlocks(text: string, minChars = 8): string[] {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((block) =>
      block
        .split(/\r?\n/)
        .filter((line) => !/^#{1,6}\s/.test(line.trim()))
        .map((line) =>
          line
            .replace(/^[-*]\s+/, '')
            .replace(/^\d+[.、．]\s+/, '')
            .replace(/〔[^〕]*〕/g, '')
            .replace(/[#>*`]/g, '')
            .trim(),
        )
        .join('')
        .replace(/\s+/g, ''),
    )
    .filter((block) => block.length >= minChars);
}

/** 两段文本的最长公共后缀长度（从末尾逐字向前比较）。 */
export function longestCommonSuffix(a: string, b: string): number {
  let i = 0;
  const limit = Math.min(a.length, b.length);
  while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}

/**
 * 全文同源文本检测：任意两段的公共后缀 ≥ floor 即报一对。
 * 预筛（末尾 24 字相同）避免 O(n²) 全量逐字比较。
 */
function checkDuplicateText(
  blocks: string[],
  floor: number,
): DisclosureCheckIssue[] {
  const issues: DisclosureCheckIssue[] = [];
  const preview = (block: string) =>
    block.length > 16 ? `${block.slice(0, 16)}…` : block;
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const tailA = blocks[i]!.slice(-24);
      if (tailA !== blocks[j]!.slice(-24)) continue;
      const shared = longestCommonSuffix(blocks[i]!, blocks[j]!);
      if (shared >= floor) {
        issues.push({
          section: 'document',
          severity: 'warning',
          code: 'DUPLICATE_TEXT',
          message: `两段文本存在 ${shared} 字逐字相同的公共后缀（「${preview(blocks[i]!)}」与「${preview(blocks[j]!)}」结尾相同），疑似同源文本复制；请改写差异化，避免把冗余带进申请文件。`,
        });
      }
    }
  }
  return issues;
}

/**
 * 部分间成对复用检测：fromPart 与 toPart 的段落两两比较，公共后缀
 * ≥ floor 即报一对（发明内容 ↔ 实施方式逐字复用的初稿形态）。
 */
function checkSectionPairDuplicates(
  fromLines: string[],
  toLines: string[],
  fromLabel: string,
  toLabel: string,
  floor: number,
): DisclosureCheckIssue[] {
  const from = extractParagraphBlocks(fromLines.join('\n'));
  const to = extractParagraphBlocks(toLines.join('\n'));
  const issues: DisclosureCheckIssue[] = [];
  for (const a of from) {
    for (const b of to) {
      if (a.slice(-12) !== b.slice(-12)) continue;
      const shared = longestCommonSuffix(a, b);
      if (shared >= floor) {
        issues.push({
          section: toLabel,
          severity: 'warning',
          code: 'SECTION_DUPLICATE',
          message: `${fromLabel}与${toLabel}存在成对重复段落（公共后缀 ${shared} 字：「${b.length > 16 ? `${b.slice(0, 16)}…` : b}」结尾相同），疑似同一方案在两个部分逐字复用；建议${toLabel}只保留与结构/参数/步骤差异相关的表述并引用前文，不要整段重抄。`,
        });
      }
    }
  }
  return issues;
}

/**
 * 术语变体检测：从「所述X」引用里提取术语，互为真子串且短方达到最小
 * 长度的对即报（「转义表 ⊂ 互逆转义表」「描述文件 ⊂ 协议描述文件」
 * 一类名称并存是初稿暴露的一词多义信号）。
 */
function checkTermVariants(document: string): DisclosureCheckIssue[] {
  const terms = new Set<string>();
  // 逐个「所述」位置手动扫描：贪婪 matchAll 会吞掉紧邻的下一个「所述」
  // （「所述协议描述文件与所述描述文件」→ 第一个 match 吃到第二个的头部），
  // 这里遇到下一个「所述」即停，再在连接词/助词处截断取名词主体。
  const CHAR_RE = /[^\s，,。；；、（）()【】]/;
  for (const m of document.matchAll(/所述/g)) {
    let raw = '';
    let i = (m.index ?? 0) + 2;
    while (raw.length < 12 && i < document.length) {
      const ch = document[i]!;
      if (!CHAR_RE.test(ch)) break;
      if (ch === '所' && document[i + 1] === '述') break;
      raw += ch;
      i += 1;
    }
    const head =
      raw.split(/(?:并|与|和|或|及|时|前|后|中|内|上|下|之|的)/)[0] ?? '';
    const term = head.replace(/[的中内后上下之与和或及]*$/, '');
    if (term.length >= 2) terms.add(term);
  }
  const list = [...terms].sort((a, b) => a.length - b.length);
  const issues: DisclosureCheckIssue[] = [];
  const reported = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    for (let j = list.length - 1; j > i; j--) {
      const short = list[i]!;
      const long = list[j]!;
      if (short.length < TERM_VARIANT_MIN_LEN) continue;
      if (short === long || !long.includes(short)) continue;
      const key = `${short}|${long}`;
      if (reported.has(key)) continue;
      reported.add(key);
      issues.push({
        section: 'document',
        severity: 'warning',
        code: 'TERM_VARIANT_PAIR',
        message: `术语「${short}」与「${long}」互为包含，疑似同一事物的不同称呼并存（一词多义风险）；请统一术语，并在首次出现处给出全称与定义，权利要求语境下的自造缩写尤其需要先定义后使用。`,
      });
      if (issues.length >= 20) return issues;
    }
  }
  return issues;
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

  // 3. 第三部分公开充分度（启发式 warning）：0 字 = 全占位/纯标题骨架，
  // 1..floor-1 字 = 内容偏薄——两类都要提示，只是措辞不同。
  const solutionBody = extractSectionBody(lines, '## 三、本案的详细阐述').join(
    '\n',
  );
  const solutionChars = countEffectiveChars(solutionBody);
  if (sectionCount > 0 && solutionChars < SOLUTION_CHAR_FLOOR) {
    const detail =
      solutionChars === 0
        ? '该部分目前没有有效正文（全占位或仅子标题骨架）'
        : `该部分仅 ${solutionChars} 字`;
    issues.push({
      section: '三',
      severity: 'warning',
      code: 'SOLUTION_SHALLOW',
      message: `${detail}：完整公开的标准是同领域技术人员看过就能实施，建议补充结构/步骤/参数/数据流细节（可结合附图标记）。`,
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
  const bodyStart = lines.findIndex((l) => l.startsWith('## '));
  const bodyText = lines.slice(bodyStart < 0 ? 0 : bodyStart).join('\n');
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

  // 6. 同源文本重复度（全文任意两段，公共后缀 ≥ 100 字）
  issues.push(
    ...checkDuplicateText(
      extractParagraphBlocks(document),
      DUPLICATE_COMMON_SUFFIX_FLOOR,
    ),
  );

  // 7. 部分间成对复用（第三部分 ↔ 第五部分，公共后缀 ≥ 40 字）
  issues.push(
    ...checkSectionPairDuplicates(
      extractSectionBody(lines, '## 三、本案的详细阐述'),
      extractSectionBody(lines, '## 五、第三项的技术手段产生了什么技术效果'),
      '第三部分',
      '第五部分',
      SECTION_PAIR_SUFFIX_FLOOR,
    ),
  );

  // 8. 术语变体（「所述X」互为包含的一词多义信号）
  issues.push(...checkTermVariants(document));

  return {
    issues,
    ok: !issues.some((i) => i.severity === 'error'),
    stats: { solutionChars, sectionCount },
  };
}
