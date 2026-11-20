/**
 * 申请文件（五书）骨架生成（纯函数）。
 *
 * 面向专利代理师的第二工作面：把交底书（disclosure）或代理师已写好的片段
 * 组织成中国专利申请文件的五部分骨架——
 *   扉页（摘要 + 摘要附图）/ 权 利 要 求 书 / 说 明 书 / 附 图。
 *
 * 事实依据（docs/patent-reference-notes.md）：
 *   - 电子公布文本固定顺序：扉页（含 (57) 摘要与摘要附图）→ 权利要求书 →
 *     说明书 → 说明书附图；**没有独立的"说明书摘要"页**——摘要只印在扉页
 *     (57) 栏，骨架按此形态排版并在诊断里提示。
 *   - 说明书段号：`[0001]` 半角方括号 + 4 位零填充，跨小节连续到文末；
 *     粒度跟随自然段（步骤行可不带新段号）。
 *   - 权利要求编号：`1.` 阿拉伯数字 + 点。
 *   - 摘要：单段无段号，约 230-320 字。
 *   - 页码双轨：页眉左公布号｜中部分名｜右 "N/M 页"（部分内页码）；页脚全文
 *     连续页码，扉页 = 1（自身不印），权利要求书从 2 起接续。
 *
 * 设计纪律：工具**不臆造权利要求与说明书正文**——没有来源就留〔待补〕占位
 * 并记诊断；权利要求书校验直接复用 claims.ts 的 checkClaims（与
 * patent_claims_check 工具同一套逻辑）。
 */

import { checkClaims } from './claims.ts';
import type { ClaimIssue } from './claims.ts';

/** 申请文件的组成部分（摘要与摘要附图同处扉页 (57) 栏，不单独成部分）。 */
export type ApplicationPart = 'abstract' | 'claims' | 'description' | 'figures';

/** 五书各部分的排版标题（部分名用 CNIPA 公布文本的字间空格式）。 */
export const PART_TITLES: Record<ApplicationPart, string> = {
  abstract: '摘 要',
  claims: '权 利 要 求 书',
  description: '说 明 书',
  figures: '附 图',
};

/** 摘要字数区间（真实公布文本约 230-320 字）。 */
export const ABSTRACT_CHAR_MIN = 230;
export const ABSTRACT_CHAR_MAX = 320;

/** 每页行数估算（用于给出部分内页码；正式排版以代理师为准）。 */
export const LINES_PER_PAGE = 30;

/** 步骤行识别：带步骤编号的行不单独起新段号（跟随自然段粒度）。 */
const STEP_LINE =
  /^\s*(?:（\d+）|\(\d+\)|步骤\s*[S一二三四五六七八九十\d]+\s*[、.,，]?|S\d+(?:\s*[、.,，]|\s|$))/;

/** 已有段号前缀（重复编号防御：编号前先剥掉，避免出现 [0001] [0001]）。 */
const EXISTING_NUMBER = /^\s*\[\d{4}\]\s*/;

/** 交底书七部分标题（与 disclosure-check.ts 的 DISCLOSURE_SECTIONS 对齐）。 */
export const DISCLOSURE_SECTION_TITLES = [
  '一、背景技术',
  '二、背景技术的技术问题',
  '三、本案的详细阐述',
  '四、第三项的技术方案中有无可以替代的地方',
  '五、第三项的技术手段产生了什么技术效果',
  '六、本案需要保护的要点',
  '七、附图要求',
] as const;

/** 生成参数。 */
export type ScaffoldOptions = {
  /** 页眉左侧的申请公布号（未知时留占位）。 */
  publicationNumber?: string | null;
  /** 发明名称（扉页 (54) 栏）。 */
  caseName?: string | null;
  /** 申请人（扉页 (71) 栏）。 */
  applicant?: string | null;
  /** 专利代理师（扉页 (74) 栏）。 */
  attorney?: string | null;
  /** 摘要附图（默认图1）。 */
  abstractFigure?: string | null;
};

/** 生成入参。 */
export type ScaffoldInput = {
  /** 交底书 markdown（可选，提供素材）。 */
  disclosure?: string | null;
  /** 权利要求书文本（优先；带 `1.` 编号）。 */
  claims?: string | null;
  /** 说明书正文（优先；缺失时从交底书搬运并留占位）。 */
  description?: string | null;
  /** 摘要文本（优先；缺失时从交底书搬运）。 */
  abstract?: string | null;
  /** 附图说明（优先；缺失时从交底书第七部分搬运）。 */
  figures?: string | null;
  /** 其它生成参数。 */
  options?: ScaffoldOptions;
};

/** 单条诊断。 */
export type ScaffoldIssue = {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  /** 关联的权利要求编号（权项书校验诊断才有）。 */
  claimNo?: number;
};

/** 单个部分的产出。 */
export type ScaffoldPart = {
  part: ApplicationPart;
  title: string;
  content: string;
  /** 全文连续页码起点（扉页 = 1）。 */
  pageFrom: number;
  /** 全文连续页码终点。 */
  pageTo: number;
  /** 部分内页数（估算）。 */
  pageCount: number;
};

/** 段号管理结果。 */
export type ParagraphNumbering = {
  lines: string[];
  /** 已分配的段号个数。 */
  count: number;
  /** 首个段号（无正文时为 null）。 */
  first: string | null;
  /** 末个段号（无正文时为 null）。 */
  last: string | null;
};

/** 权利要求书校验结果（复用 checkClaims）。 */
export type ScaffoldClaimsCheck = {
  ok: boolean;
  total: number;
  independent: number;
  dependent: number;
  multiDependent: number;
  issues: ClaimIssue[];
};

/** 生成报告。 */
export type ScaffoldReport = {
  parts: ScaffoldPart[];
  /** 说明书段号管理结果。 */
  numbering: ParagraphNumbering;
  /** 权利要求书校验结果（无权项书或未定稿时为 null）。 */
  claimsCheck: ScaffoldClaimsCheck | null;
  /** 全部诊断。 */
  issues: ScaffoldIssue[];
  /** 是否无 error 级诊断。 */
  ok: boolean;
  /** 完整 markdown（五书 + 页眉页脚示意）。 */
  markdown: string;
};

/**
 * 抽取交底书的某一部分正文（按标题行到下一个标题行）。
 * 标题按「去掉 # 前缀后 startsWith」匹配，容忍「## 四、…」等措辞差异。
 */
export function extractDisclosureSection(
  disclosure: string,
  title: string,
): string | null {
  const lines = disclosure.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    line
      .replace(/^#+\s*/, '')
      .trim()
      .startsWith(title),
  );
  if (start < 0) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^#{1,3}\s/.test(line.trim())) break;
    body.push(line);
  }
  return body.join('\n').trim() || null;
}

/**
 * 段号管理：给正文自然段依次加 `[0001]` 式段号，跨小节连续到文末；
 * 步骤行（（1）/ 步骤S1/ S1、 等）不单独起新段号。
 */
export function assignParagraphNumbers(lines: string[]): ParagraphNumbering {
  const out: string[] = [];
  let count = 0;
  let first: string | null = null;
  let last: string | null = null;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) {
      out.push('');
      continue;
    }
    // 已有段号的正文先剥掉旧号，由本工具重新连续编号（避免双重编号）。
    const line = trimmed.replace(EXISTING_NUMBER, '');
    if (STEP_LINE.test(line)) {
      // 步骤行不另起段号，段号跟随所属自然段。
      out.push(line);
      continue;
    }
    count += 1;
    const tag = `[${String(count).padStart(4, '0')}]`;
    first ??= tag;
    last = tag;
    out.push(`${tag} ${line}`);
  }
  return { lines: out, count, first, last };
}

/**
 * 页眉行：`公布号 | 部分名 | N/M 页`。
 *
 * N/M 是**部分内**页码（不是全文页码）；骨架只输出每部分首页的页眉示意，
 * 正式排版时由排版环节逐页重复。
 */
export function pageHeader(
  publicationNumber: string | null | undefined,
  partName: string,
  page: number,
  pageCount: number,
): string {
  const left = publicationNumber?.trim() || '〔申请公布号待定〕';
  return `${left} | ${partName} | ${page}/${pageCount} 页`;
}

/** 页脚行：全文连续页码（扉页自身不印页脚）。 */
export function pageFooter(page: number): string {
  return `— ${page} —`;
}

/** 估算某部分占用的页数（按行数估算，正式排版以代理师为准）。 */
export function estimatePages(content: string): number {
  const lines = content.split(/\r?\n/).filter((line) => line.trim()).length;
  return Math.max(1, Math.ceil(lines / LINES_PER_PAGE));
}

/** 去掉 markdown 标题标记与列表符号，保留原有编号（权项书编号要保留）。 */
function plainLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^#{1,6}\s*/, '')
        .replace(/^[-*+]\s+/, '')
        .trimEnd(),
    )
    .filter((line) => line.trim());
}

/** 统计有效字数（去空白）。 */
function effectiveChars(text: string): number {
  return text.replace(/\s+/g, '').length;
}

/**
 * 生成申请文件五书骨架。
 *
 * 不臆造：没有来源的部分留〔待补〕占位并记诊断；权利要求书校验直接复用
 * claims.ts 的 checkClaims（与 patent_claims_check 工具同一套逻辑）。
 */
export function buildApplicationScaffold(input: ScaffoldInput): ScaffoldReport {
  const options = input.options ?? {};
  const issues: ScaffoldIssue[] = [];
  const disclosure = input.disclosure?.trim() ?? '';

  // ── 权利要求书 ────────────────────────────────────────────────
  const claimsText = input.claims?.trim() ?? '';
  let claimsContent = claimsText;
  let claimsFinalized = claimsText.length > 0;
  if (!claimsContent && disclosure) {
    const points = extractDisclosureSection(
      disclosure,
      DISCLOSURE_SECTION_TITLES[5],
    );
    if (points) {
      const numbered = plainLines(points).filter((line) =>
        /^\d+[.、．]/.test(line.trim()),
      );
      if (numbered.length) {
        claimsContent = [
          '〔以下为交底书第六部分「本案需要保护的要点」原文摘录，须由专利代理师改写为权利要求书；工具不代拟权利要求文字〕',
          ...numbered,
        ].join('\n');
        issues.push({
          code: 'CLAIMS_NOT_FINALIZED',
          severity: 'warning',
          message:
            '权利要求书来自交底书要点原文摘录，未定稿；请代理师改写后再校验。',
        });
        claimsFinalized = false;
      }
    }
  }
  if (!claimsContent) {
    claimsContent = '〔待补：权利要求书（1. 独立权利要求 + 从属权利要求）〕';
    issues.push({
      code: 'NO_CLAIMS_SOURCE',
      severity: 'error',
      message: '未提供权利要求书，也未在交底书中找到可摘录的保护要点。',
    });
  }

  const claimsCheck: ScaffoldClaimsCheck | null = claimsFinalized
    ? (() => {
        const report = checkClaims(claimsContent);
        return {
          ok: report.ok,
          total: report.stats.total,
          independent: report.stats.independent,
          dependent: report.stats.dependent,
          multiDependent: report.stats.multiDependent,
          issues: report.issues,
        };
      })()
    : null;
  // 权项书诊断：与 patent_claims_check 同一套码、同一严重度、同一可见性——
  // error 与 warning 两级都转发，不加前缀、不改级别（避免同一份权项书在两个
  // 工具里看到不同结论）。
  if (claimsCheck) {
    for (const issue of claimsCheck.issues) {
      issues.push({
        code: issue.code,
        severity: issue.severity,
        message: `权利要求书${issue.claim ? `第 ${issue.claim} 项` : ''}：${issue.message}`,
        ...(issue.claim === undefined || issue.claim === null
          ? {}
          : { claimNo: issue.claim }),
      });
    }
  }

  // ── 说明书 ────────────────────────────────────────────────────
  const descriptionInput = input.description?.trim() ?? '';
  const sectionOf = (index: number): string | null =>
    disclosure
      ? extractDisclosureSection(disclosure, DISCLOSURE_SECTION_TITLES[index])
      : null;
  const background = sectionOf(0);
  const problem = sectionOf(1);
  const solution = sectionOf(2);
  const effects = sectionOf(4);
  const protection = sectionOf(5);
  const figuresSource = sectionOf(6);

  const descriptionBody: string[] = [];
  if (descriptionInput) {
    descriptionBody.push(...plainLines(descriptionInput));
  } else {
    descriptionBody.push('技术领域', '');
    descriptionBody.push('〔待补：本发明所属的技术领域（一句话）〕', '');
    descriptionBody.push('背景技术', '');
    descriptionBody.push(
      ...(background ? plainLines(background) : ['〔待补：背景技术〕']),
      '',
    );
    descriptionBody.push('发明内容', '');
    if (problem) {
      descriptionBody.push('（一）要解决的技术问题', '');
      descriptionBody.push(...plainLines(problem));
      descriptionBody.push('');
    }
    if (effects) {
      descriptionBody.push('（二）有益效果', '');
      descriptionBody.push(...plainLines(effects));
      descriptionBody.push('');
    }
    if (protection) {
      descriptionBody.push('（三）保护要点', '');
      descriptionBody.push(...plainLines(protection));
      descriptionBody.push('');
    }
    if (!problem && !effects && !protection) {
      descriptionBody.push(
        '〔待补：发明内容（技术问题 + 有益效果 + 保护要点）〕',
        '',
      );
      issues.push({
        code: 'NO_DESCRIPTION_SOURCE',
        severity: 'error',
        message:
          '未提供说明书正文，交底书里也未取到发明内容素材（技术问题 / 有益效果 / 保护要点）；说明书相应小节留占位。',
      });
    }
    descriptionBody.push('附图说明', '');
    descriptionBody.push(
      ...(figuresSource
        ? plainLines(figuresSource)
        : ['〔待补：附图说明（逐图独立段，图N是……的示意图）〕']),
      '',
    );
    descriptionBody.push('具体实施方式', '');
    descriptionBody.push(
      ...(solution
        ? plainLines(solution)
        : ['〔待补：具体实施方式（须达到可实施粒度）〕']),
      '',
    );
  }
  const numbering = assignParagraphNumbers(descriptionBody);
  const descriptionContent = numbering.lines.join('\n').trim();

  // ── 摘要 ──────────────────────────────────────────────────────
  const abstractInput = input.abstract?.trim() ?? '';
  let abstractContent = abstractInput;
  if (!abstractContent) {
    const invention = descriptionInput
      ? plainLines(descriptionInput).slice(0, 2).join(' ')
      : (problem ?? '').trim();
    if (invention) {
      abstractContent = invention;
      issues.push({
        code: 'ABSTRACT_DRAFTED_FROM_DISCLOSURE',
        severity: 'warning',
        message:
          '摘要由说明书正文或交底书技术问题段拼接而来（素材来源不代表摘要定稿），须由代理师改写为单段 230-320 字的独立文字。',
      });
    } else {
      abstractContent = '〔待补：摘要（单段无段号，约 230-320 字）〕';
      issues.push({
        code: 'NO_ABSTRACT',
        severity: 'error',
        message: '未提供摘要，也无素材可搬运。',
      });
    }
  }
  const abstractChars = effectiveChars(abstractContent);
  if (
    !abstractContent.startsWith('〔待补') &&
    (abstractChars < ABSTRACT_CHAR_MIN || abstractChars > ABSTRACT_CHAR_MAX)
  ) {
    issues.push({
      code: 'ABSTRACT_LENGTH_OUT_OF_RANGE',
      severity: 'warning',
      message: `摘要约 ${abstractChars} 字，超出真实公布文本常见的 ${ABSTRACT_CHAR_MIN}-${ABSTRACT_CHAR_MAX} 字区间，请复核。`,
    });
  }

  // ── 附图 / 摘要附图 ───────────────────────────────────────────
  const figuresInput = input.figures?.trim() ?? '';
  const figuresContent = figuresInput || figuresSource?.trim() || '';
  if (!figuresContent) {
    issues.push({
      code: 'FIGURE_LIST_MISSING',
      severity: 'warning',
      message: '缺少附图说明（逐图独立段：图N是……的示意图）。',
    });
  }
  const abstractFigure = options.abstractFigure?.trim() || '图1';

  // ── 页码双轨与排版 ────────────────────────────────────────────
  const publicationNumber = options.publicationNumber?.trim() || null;
  const frontContent = [
    `发明名称：${options.caseName?.trim() || '〔待补〕'}`,
    `申请人：${options.applicant?.trim() || '〔待补〕'}`,
    `专利代理师：${options.attorney?.trim() || '〔待补〕'}`,
    '',
    '摘 要',
    abstractContent,
    '',
    '摘 要 附 图',
    abstractFigure,
  ].join('\n');

  const parts: ScaffoldPart[] = [];
  let cursor = 1;
  const pushPart = (
    part: ApplicationPart,
    title: string,
    content: string,
  ): void => {
    const pageCount = estimatePages(content);
    parts.push({
      part,
      title,
      content,
      pageFrom: cursor,
      pageTo: cursor + pageCount - 1,
      pageCount,
    });
    cursor += pageCount;
  };

  // 扉页（含 (57) 摘要栏与摘要附图栏）是第一部分；摘要附图只在此栏出现一次，
  // 不再单独成部分（真实公布文本也没有独立的摘要附图页）。
  pushPart('abstract', '扉 页（摘要与摘要附图）', frontContent);
  pushPart('claims', PART_TITLES.claims, claimsContent);
  pushPart('description', PART_TITLES.description, descriptionContent);
  pushPart('figures', PART_TITLES.figures, figuresContent || '〔待补：附图〕');

  // 页码：扉页 = 1 且自身不印页脚；权利要求书从 2 起接续。
  const markdown = parts
    .map((part) => {
      const header = pageHeader(
        publicationNumber,
        part.title,
        1,
        part.pageCount,
      );
      const footer = part.pageFrom === 1 ? '' : pageFooter(part.pageFrom);
      const body = part.content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join('\n');
      return [header, '', body, '', footer]
        .join('\n')
        .replace(/\n{3,}/g, '\n\n');
    })
    .join('\n\n---\n\n');

  return {
    parts,
    numbering,
    claimsCheck,
    issues,
    ok: !issues.some((issue) => issue.severity === 'error'),
    markdown,
  };
}
