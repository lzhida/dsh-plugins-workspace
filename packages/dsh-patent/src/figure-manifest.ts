import { closeSync, openSync, readSync } from 'node:fs';
import { basename, extname } from 'node:path';

/**
 * 附图清单管理与图号引用一致性检查（文件与清单层面）。
 *
 * 边界：本模块只管「附图清单与图文件层面」；初稿文件内部的附图说明与正文
 * 一致性由 draft_review_check 承担，两者不重复。
 *
 * 分工：工具读文件头字节、读清单与正文、核对结构；**图面内容（标记、文本、
 * 元素）由模型读图后以结构化入参提供**，工具只做齐备性与一致性核对。
 */

/** 图文件（调用方给出路径，工具只读文件头字节）。 */
export type FigureFileInput = {
  /** 图文件路径。 */
  path: string;
};

/** 模型读图得到的附图标记清单。 */
export type FigureMarksInput = {
  figure: number;
  marks: string[];
};

/** 模型读图得到的图面文本（OCR 或人工转写）。 */
export type FigureTextInput = {
  figure: number;
  text: string;
};

/** 模型读图得到的图面元素。 */
export type FigureElementsInput = {
  figure: number;
  branches?: string[];
  directions?: string[];
  layers?: string[];
};

/** 说明书规则条目（模型提供核心关键词，便于机械比对）。 */
export type SpecRuleInput = {
  keyword: string;
  text?: string;
  directions?: string[];
};

/** 正文术语改名对照（旧名 → 新名）。 */
export type TermRenameInput = {
  old: string;
  new: string;
};

/** 入参。 */
export type FigureManifestInput = {
  /** 交底书全文（附图清单取自第七部分「附图要求」）。 */
  disclosure?: string;
  /** 说明书/初稿正文（用于图号引用与就近指引检查）。 */
  document?: string;
  /** 图文件清单。 */
  figureFiles?: FigureFileInput[];
  /** 模型读图得到的附图标记。 */
  figureMarks?: FigureMarksInput[];
  /** 模型读图得到的图面文本。 */
  figureText?: FigureTextInput[];
  /** 模型读图得到的图面元素。 */
  figureElements?: FigureElementsInput[];
  /** 说明书规则条目。 */
  specRules?: SpecRuleInput[];
  /** 正文术语改名对照。 */
  termRenames?: TermRenameInput[];
};

/** 附图清单条目。 */
export type FigureManifestItem = {
  figure: number;
  /** 交底书里的图描述句。 */
  title: string;
  /** 交底书是否声明了该图。 */
  declared: boolean;
  /** 命中的图文件名。 */
  files: string[];
  /** 声明要求的附图标记。 */
  declaredMarks: string[];
  /** 模型读图得到的标记。 */
  observedMarks: string[];
  /** 缺失的标记。 */
  missingMarks: string[];
};

/** 诊断。 */
export type FigureManifestIssue = {
  code: string;
  severity: 'error' | 'warning';
  figure: number | null;
  message: string;
};

/** 待模型逐图核对的清单项。 */
export type FigureChecklistItem = {
  code: string;
  figure: number | null;
  title: string;
  why: string;
  evidenceFormat: string;
};

/** 报告。 */
export type FigureManifestReport = {
  items: FigureManifestItem[];
  issues: FigureManifestIssue[];
  checklist: FigureChecklistItem[];
  stats: {
    declared: number;
    files: number;
    referenced: number;
    dangling: number;
    splitTerms: number;
    encodingChecked: number;
  };
  ok: boolean;
  markdown: string;
};

/** 就近指引窗口（字符）。 */
export const FIG_NEARBY_GUIDE_WINDOW = 60;

/** 附图标记声明抽取：形如「标注附图标记（100/110/120）」。 */
const MARK_DECLARATION =
  /(?:附图标记|部件标记|标记)[（(]?\s*((?:\d{2,4}\s*[/、,，]\s*)*\d{2,4})\s*[）)]?/;

/** 图号引用与就近指引。 */
const FIG_REFERENCE = /图\s*([0-9]{1,3})/g;
const NEARBY_GUIDE =
  /(如图\s*[0-9]{1,3}\s*所示|见图\s*[0-9]{1,3}|参见图\s*[0-9]{1,3}|图\s*[0-9]{1,3}\s*所示|图\s*[0-9]{1,3}\s*中)/;

/** 交底书附图要求小节标题。 */
const FIGURE_SECTION_TITLES = [
  '七、附图要求',
  '七、附图说明',
  '附图要求',
  '附图说明',
];

/** 读取文件头字节判定真实编码。 */
export type DetectedEncoding = {
  encoding: string;
  detected: boolean;
  /** 头部字节（十六进制），供人工复核。 */
  head: string;
};

/**
 * 按文件头字节判定图像真实编码。
 *
 * 以字节为准可避免「读取工具返回的规范化副本」造成的 JPEG/PNG 误判。
 */
export function detectImageEncoding(path: string): DetectedEncoding {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(16);
    const read = readSync(fd, buf, 0, 16, 0);
    const head = buf.subarray(0, Math.max(read, 0));
    const hex = [...head].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const startsWith = (...bytes: number[]): boolean =>
      bytes.every((b, i) => head[i] === b);
    if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
      return { encoding: 'png', detected: true, head: hex };
    }
    if (startsWith(0xff, 0xd8, 0xff))
      return { encoding: 'jpeg', detected: true, head: hex };
    if (startsWith(0x47, 0x49, 0x46, 0x38))
      return { encoding: 'gif', detected: true, head: hex };
    if (startsWith(0x42, 0x4d))
      return { encoding: 'bmp', detected: true, head: hex };
    if (startsWith(0x49, 0x49, 0x2a, 0x00))
      return { encoding: 'tiff', detected: true, head: hex };
    if (startsWith(0x4d, 0x4d, 0x00, 0x2a))
      return { encoding: 'tiff', detected: true, head: hex };
    if (
      startsWith(0x52, 0x49, 0x46, 0x46) &&
      head[8] === 0x57 &&
      head[9] === 0x45 &&
      head[10] === 0x42 &&
      head[11] === 0x50
    ) {
      return { encoding: 'webp', detected: true, head: hex };
    }
    return { encoding: 'unknown', detected: false, head: hex };
  } catch {
    return { encoding: 'unknown', detected: false, head: '' };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* 关闭失败不影响结论 */
      }
    }
  }
}

/** 扩展名 → 期望编码。 */
export function expectedEncodingFromName(name: string): string | null {
  const ext = extname(name).toLowerCase();
  if (ext === '.png') return 'png';
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg';
  if (ext === '.gif') return 'gif';
  if (ext === '.bmp') return 'bmp';
  if (ext === '.webp') return 'webp';
  if (ext === '.tif' || ext === '.tiff') return 'tiff';
  return null;
}

/** 从文件名中提取图号（fig1-bw / image2 / 图3 / 附图4）。 */
export function figureNumberFromName(name: string): number | null {
  const match = /(?:fig|image|img|图|附图)\s*([0-9]{1,3})/i.exec(name);
  if (match) return Number(match[1]);
  // 裸数字只在「去掉扩展名后整段就是数字」时兜底：像 scan-2024-final.png
  // 这类文件名里的数字是版本号而非图号，前缀规则未命中时不应猜号。
  const stem = basename(name, extname(name));
  return /^\d{1,3}$/.test(stem) ? Number(stem) : null;
}

/** 从交底书文本抽取附图清单小节。 */
export function extractFigureSection(disclosure: string): string {
  const lines = disclosure.split(/\r?\n/);
  const kept: string[] = [];
  let capturing = false;
  for (const line of lines) {
    const head = line.trim();
    const stripped = head.replace(/^#+\s*/, '');
    const isHashed = /^#{1,6}\s/.test(head);
    const isTitle =
      FIGURE_SECTION_TITLES.some((title) => stripped.startsWith(title)) ||
      /^七[、.．]/.test(stripped) ||
      // 「附图」二字只有作为标题行时才算小节起点：正文里出现
      // 「结合附图1所示」不应把正文吞进附图清单。
      (isHashed && /附图/.test(stripped));
    if (isTitle) {
      capturing = true;
      continue;
    }
    if (capturing && /^#{1,6}\s/.test(head)) break;
    if (capturing) kept.push(line);
  }
  return kept.join('\n');
}

/** 从附图清单小节抽取图号与描述句。 */
export function parseFigureList(section: string): Map<number, string> {
  const map = new Map<number, string>();
  const lines = section.split(/\r?\n/);
  for (const line of lines) {
    const match = /图\s*([0-9]{1,3})\s*[是为]([^。；;]*)/.exec(line);
    if (!match) continue;
    const figure = Number(match[1]);
    const title = `图${figure}是${match[2].trim()}`;
    if (!map.has(figure)) map.set(figure, title);
  }
  return map;
}

/** 从交底书抽取声明要求的附图标记。 */
export function parseDeclaredMarks(disclosure: string): string[] {
  const match = MARK_DECLARATION.exec(disclosure);
  if (!match) return [];
  return [
    ...new Set(
      match[1]
        .split(/[/、,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

/** 主入口：附图清单与图号引用一致性检查。 */
export function checkFigureManifest(
  input: FigureManifestInput,
): FigureManifestReport {
  const issues: FigureManifestIssue[] = [];
  const disclosure = input.disclosure?.trim() ?? '';
  const document = input.document?.trim() ?? '';
  const section = extractFigureSection(disclosure);
  const declaredMap = parseFigureList(section);
  const declaredMarks = parseDeclaredMarks(disclosure);
  const figureFiles = input.figureFiles ?? [];

  if (declaredMap.size === 0) {
    issues.push({
      code: 'FIG_LIST_MISSING',
      severity: 'error',
      figure: null,
      message:
        '交底书第七部分未抽到附图清单（形如「图1是……的流程示意图」），无法做图号一致性核对。',
    });
  }

  // 图文件 ↔ 清单图号
  const fileByFigure = new Map<number, string[]>();
  for (const file of figureFiles) {
    const figure = figureNumberFromName(file.path);
    if (figure === null) {
      issues.push({
        code: 'FIG_FILE_UNNAMED',
        severity: 'warning',
        figure: null,
        message: `图文件 ${file.path} 的文件名里没有可识别的图号（未匹配 fig/image/图/附图 + 数字）。`,
      });
      continue;
    }
    const list = fileByFigure.get(figure) ?? [];
    list.push(file.path);
    fileByFigure.set(figure, list);
  }

  for (const figure of declaredMap.keys()) {
    if (!fileByFigure.has(figure)) {
      issues.push({
        code: 'FIG_FILE_MISSING',
        severity: 'warning',
        figure,
        message: `交底书声明了图 ${figure}，但图文件清单里没有对应文件。`,
      });
    }
  }
  for (const [figure, files] of fileByFigure) {
    if (!declaredMap.has(figure)) {
      issues.push({
        code: 'FIG_FILE_EXTRA',
        severity: 'warning',
        figure,
        message: `图文件 ${files.join('、')} 对应图 ${figure}，但交底书附图清单里没有该图号。`,
      });
    }
  }

  // 正文图号引用
  const referenced = new Set<number>();
  const dangling = new Set<number>();
  if (document) {
    const re = new RegExp(FIG_REFERENCE.source, 'g');
    let match = re.exec(document);
    while (match) {
      const figure = Number(match[1]);
      referenced.add(figure);
      if (!declaredMap.has(figure)) dangling.add(figure);
      const start = Math.max(0, match.index - FIG_NEARBY_GUIDE_WINDOW);
      const window = document.slice(
        start,
        match.index + FIG_NEARBY_GUIDE_WINDOW,
      );
      if (!NEARBY_GUIDE.test(window)) {
        issues.push({
          code: 'FIG_REF_NO_NEARBY_GUIDE',
          severity: 'warning',
          figure,
          message: `正文引用「图${figure}」附近没有就近指引（如「如图${figure}所示」），属低危可检项。`,
        });
      }
      match = re.exec(document);
    }
  }
  for (const figure of dangling) {
    issues.push({
      code: 'FIG_REF_DANGLING',
      severity: 'error',
      figure,
      message: `正文引用了图 ${figure}，但附图清单里没有该图号（悬空引用）。`,
    });
  }
  for (const figure of declaredMap.keys()) {
    if (!referenced.has(figure)) {
      issues.push({
        code: 'FIG_REF_UNUSED',
        severity: 'warning',
        figure,
        message: `附图清单里的图 ${figure} 未在正文中被引用。`,
      });
    }
  }

  // 附图标记齐备性（模型读图结果 vs 交底书声明）
  const marksByFigure = new Map<number, string[]>();
  for (const entry of input.figureMarks ?? []) {
    marksByFigure.set(
      entry.figure,
      entry.marks.map((m) => m.trim()).filter(Boolean),
    );
  }

  // 图面文本 ↔ 正文术语版本一致性
  const renames = input.termRenames ?? [];
  let splitTerms = 0;
  for (const entry of input.figureText ?? []) {
    const text = entry.text ?? '';
    for (const rename of renames) {
      if (!rename.old || !rename.new || rename.old === rename.new) continue;
      // 图面文本仍出现正文已废弃的旧术语 → 图文分裂（正文改名未重绘）。
      // 旧称是新称前缀时（如 导线 → 导线组件），图面若已用新称就不算残留。
      const newContainsOld = rename.new.includes(rename.old);
      const stillOld = newContainsOld
        ? text.includes(rename.old) && !text.includes(rename.new)
        : text.includes(rename.old);
      if (stillOld) {
        splitTerms += 1;
        issues.push({
          code: 'FIG_TEXT_TERM_SPLIT',
          severity: 'error',
          figure: entry.figure,
          message: `图 ${entry.figure} 的图面文本仍用旧术语「${rename.old}」，正文已改为「${rename.new}」；沿用图零改动会造成图文分裂。`,
        });
      }
    }
  }

  // 图面元素 ↔ 说明书规则条目交叉核对
  const elementsByFigure = new Map<number, FigureElementsInput>();
  for (const entry of input.figureElements ?? []) {
    elementsByFigure.set(entry.figure, entry);
  }
  for (const rule of input.specRules ?? []) {
    const keyword = rule.keyword?.trim();
    if (!keyword) continue;
    let found = false;
    for (const element of elementsByFigure.values()) {
      const branches = element.branches ?? [];
      if (branches.some((b) => b.includes(keyword) || keyword.includes(b))) {
        found = true;
        break;
      }
      const layers = element.layers ?? [];
      if (layers.some((l) => l.includes(keyword) || keyword.includes(l))) {
        found = true;
        break;
      }
    }
    if (!found) {
      issues.push({
        code: 'FIG_ELEMENT_MISSING_RULE',
        severity: 'warning',
        figure: null,
        message: `说明书规则条目「${keyword}」在模型读到的图面分支/层级里没有对应项（图文可能共同缺项，或图面未同步）。`,
      });
    }
    if (rule.directions?.length) {
      const observed = [...elementsByFigure.values()].flatMap(
        (e) => e.directions ?? [],
      );
      const hit = rule.directions.some((d) =>
        observed.some((o) => o.includes(d) || d.includes(o)),
      );
      if (!hit) {
        issues.push({
          code: 'FIG_ELEMENT_DIRECTION_MISSING',
          severity: 'warning',
          figure: null,
          message: `说明书规则条目「${keyword}」描述了方向「${rule.directions.join('/')}」，但图面连线上没有观察到对应方向。`,
        });
      }
    }
  }

  // 文件头字节判真实编码
  let encodingChecked = 0;
  for (const file of figureFiles) {
    const detected = detectImageEncoding(file.path);
    const expected = expectedEncodingFromName(file.path);
    if (!detected.detected) {
      issues.push({
        code: 'FIG_ENCODING_UNKNOWN',
        severity: 'warning',
        figure: null,
        message: `无法按文件头字节判定 ${file.path} 的真实编码（头部：${detected.head || '空'}）。`,
      });
      continue;
    }
    encodingChecked += 1;
    if (expected && expected !== detected.encoding) {
      issues.push({
        code: 'FIG_ENCODING_MISMATCH',
        severity: 'error',
        figure: null,
        message: `${file.path} 的文件头字节判定为 ${detected.encoding}，与扩展名期望的 ${expected} 不一致（头部：${detected.head}）。`,
      });
    }
  }

  // 清单条目汇总
  const allFigures = new Set<number>([
    ...declaredMap.keys(),
    ...fileByFigure.keys(),
    ...marksByFigure.keys(),
  ]);
  // 标记齐备性只在「模型已提供标记清单的图」上核对（未提供标记的图不判缺）：交底书的标记声明是
  // 全局一处声明，若模型只给了部分图的标记，其余图缺标记可能只是本就没有
  // 部件标记，逐图硬判会误报；作用域不全时降级为提示。
  const markedFigures = new Set(marksByFigure.keys());
  const markScopeKnown = markedFigures.size >= allFigures.size;
  if (!markScopeKnown && declaredMarks.length > 0) {
    issues.push({
      code: 'FIG_MARK_SCOPE_UNKNOWN',
      severity: 'warning',
      figure: null,
      message: `模型只提供了 ${markedFigures.size} 张图的标记清单（共 ${allFigures.size} 张图），标记齐备性仅对已提供标记的图核对；未提供标记的图可能本就没有部件标记。`,
    });
  }
  const items: FigureManifestItem[] = [...allFigures]
    .sort((a, b) => a - b)
    .map((figure) => {
      const observed = marksByFigure.get(figure) ?? [];
      const missing = declaredMarks.filter((m) => !observed.includes(m));
      if (
        declaredMarks.length > 0 &&
        observed.length > 0 &&
        missing.length > 0
      ) {
        issues.push({
          code: 'FIG_MARK_MISSING',
          severity: 'warning',
          figure,
          message: `图 ${figure} 缺少交底书声明的附图标记：${missing.join('、')}。`,
        });
      }
      return {
        figure,
        title:
          declaredMap.get(figure) ?? `图 ${figure}（未在交底书附图清单中声明）`,
        declared: declaredMap.has(figure),
        files: fileByFigure.get(figure) ?? [],
        declaredMarks,
        observedMarks: observed,
        missingMarks: missing,
      };
    });

  const checklist: FigureChecklistItem[] = items.map((item) => ({
    code: 'figure-read-check',
    figure: item.figure,
    title: `图 ${item.figure} 逐图核对`,
    why: '图面内容（标记、文本、分支）需模型读图确认，工具只做结构与一致性核对。',
    evidenceFormat:
      '按图给出：附图标记集合 / 图面文本 / 分支与层级 / 连线方向；并标注文件路径与图号。',
  }));

  const stats = {
    declared: declaredMap.size,
    files: figureFiles.length,
    referenced: referenced.size,
    dangling: dangling.size,
    splitTerms,
    encodingChecked,
  };

  return {
    items,
    issues,
    checklist,
    stats,
    ok: !issues.some((i) => i.severity === 'error'),
    markdown: renderFigureManifestMarkdown({ items, issues, checklist, stats }),
  };
}

/** Markdown 渲染。 */
export function renderFigureManifestMarkdown(report: {
  items: FigureManifestItem[];
  issues: FigureManifestIssue[];
  checklist: FigureChecklistItem[];
  stats: FigureManifestReport['stats'];
}): string {
  const lines: string[] = [];
  lines.push('# 附图清单与图号一致性报告');
  lines.push('');
  lines.push(
    '> 只覆盖「附图清单与文件层面」；初稿文件内部的附图说明与正文一致性由 draft_review_check 承担。',
  );
  lines.push('');
  lines.push('## 一、附图清单');
  lines.push('');
  lines.push('| 图号 | 交底书描述 | 声明 | 图文件 | 缺失标记 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const item of report.items) {
    lines.push(
      `| 图 ${item.figure} | ${item.title} | ${item.declared ? '是' : '否'} | ${item.files.join('、') || '—'} | ${item.missingMarks.join('、') || '—'} |`,
    );
  }
  lines.push('');
  lines.push('## 二、诊断');
  lines.push('');
  if (report.issues.length === 0) {
    lines.push('无诊断。');
  } else {
    for (const issue of report.issues) {
      lines.push(
        `- [${issue.severity}] ${issue.code}${issue.figure === null ? '' : `（图 ${issue.figure}）`}：${issue.message}`,
      );
    }
  }
  lines.push('');
  lines.push('## 三、待模型逐图核对清单');
  lines.push('');
  for (const item of report.checklist) {
    lines.push(`- ${item.title}：${item.why}`);
  }
  lines.push('');
  lines.push('## 四、统计');
  lines.push('');
  lines.push(
    `- 声明图 ${report.stats.declared} 张 / 图文件 ${report.stats.files} 个 / 正文引用 ${report.stats.referenced} 张 / 悬空引用 ${report.stats.dangling} 张 / 图文分裂 ${report.stats.splitTerms} 处 / 已按字节判定编码 ${report.stats.encodingChecked} 个`,
  );
  return lines.join('\n');
}
