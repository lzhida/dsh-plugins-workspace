import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import {
  DISCLOSURE_SECTIONS,
  countEffectiveChars,
} from './disclosure-check.ts';

/**
 * 多案例（多份交底书）工作区组织与索引。
 *
 * 只读扫描：列出工作区内的交底书案件、给出状态跟踪（sidecar 元数据优先，
 * 缺省按七部分完整度推断），不做任何写入。
 */

/** 单个案件的旁挂元数据（`<文件名>.case.json`）。 */
export type CaseSidecar = {
  caseId?: string;
  title?: string;
  status?: string;
  notes?: string;
};

/** 交底书某一部分的填充情况。 */
export type CaseSection = {
  title: string;
  chars: number;
  filled: boolean;
};

/** 案件条目。 */
export type CaseEntry = {
  caseId: string;
  title: string;
  /** 相对扫描根目录的路径。 */
  path: string;
  status: string;
  statusSource: 'sidecar' | 'inferred';
  updatedAt: string;
  sections: CaseSection[];
  notes?: string;
};

/** 诊断。 */
export type CaseIndexIssue = {
  code: string;
  severity: 'error' | 'warning';
  path: string;
  message: string;
};

/** 报告。 */
export type CaseIndexReport = {
  cases: CaseEntry[];
  issues: CaseIndexIssue[];
  stats: {
    total: number;
    ready: number;
    draft: number;
    empty: number;
    withSidecar: number;
  };
  ok: boolean;
  markdown: string;
};

/** 扫描最大深度。 */
export const CASE_SCAN_MAX_DEPTH = 3;
/** 跳过的目录。 */
export const CASE_SKIP_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.next',
  '.turbo',
  '__pycache__',
  '.agents',
];
/** 部分正文达到该字符数即视为已填写。 */
export const CASE_SECTION_CHAR_FLOOR = 40;

/** 候选 markdown 至少要有这么多字才可能是交底书。 */
export const CASE_MIN_DOC_CHARS = 120;

/**
 * 判定一个 markdown 是否像交底书。
 *
 * 只列出一、二、三几个小节标题、正文又很短的，多半是写作指南或模板说明，
 * 不是案件；要求命中至少两个部分标题并有一定正文长度，避免索引里混进
 * 幽灵条目。
 */
export function looksLikeDisclosure(text: string): boolean {
  const headings = [
    /一[、.．]\s*背景技术/,
    /二[、.．]\s*背景技术的技术问题/,
    /三[、.．]/,
    /四[、.．]/,
    /五[、.．]/,
    /六[、.．]/,
    /七[、.．]/,
  ].filter((re) => re.test(text)).length;
  return headings >= 2 && text.length >= CASE_MIN_DOC_CHARS;
}

/** 案件标识：路径去扩展名后转短横线。 */
export function slugifyCaseId(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\.[^./]+$/, '')
    .replace(/[^0-9A-Za-z一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/** 读取标题：优先一级标题，其次首个二级标题。 */
export function extractCaseTitle(text: string, fallback: string): string {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const head = line.trim();
    if (!head) continue;
    if (/^#\s+/.test(head)) return head.replace(/^#\s+/, '').trim();
    if (/^#{2}\s+/.test(head)) return head.replace(/^#{2}\s+/, '').trim();
    break;
  }
  return fallback;
}

/** 从标题行抽取中文序号（如「三、」→ 3）。 */
export function sectionOrderOf(title: string): number | null {
  const match = /([一二三四五六七八九十]+)\s*[、.．]/.exec(title);
  if (!match) return null;
  const map: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  const value = map[match[1]];
  return value ?? null;
}

/** 抽取七部分的填充情况（按标题序号匹配，措辞可与模板不同）。 */
export function extractCaseSections(text: string): CaseSection[] {
  const lines = text.split(/\r?\n/);
  const sections: CaseSection[] = [];
  for (const title of DISCLOSURE_SECTIONS) {
    const label = title.replace(/^##\s*/, '');
    const order = sectionOrderOf(label);
    const start = lines.findIndex((line) => {
      const head = line.trim().replace(/^#+\s*/, '');
      if (!/^#{1,6}\s/.test(line.trim())) return false;
      if (head === label || head.startsWith(label)) return true;
      const headOrder = sectionOrderOf(head);
      return order !== null && headOrder === order;
    });
    if (start < 0) {
      sections.push({ title: label, chars: 0, filled: false });
      continue;
    }
    const body: string[] = [];
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^#{1,6}\s/.test(lines[i].trim())) break;
      body.push(lines[i]);
    }
    const chars = countEffectiveChars(body.join('\n'));
    sections.push({
      title: label,
      chars,
      filled: chars >= CASE_SECTION_CHAR_FLOOR,
    });
  }
  return sections;
}

/** 关键部分序号（附图要求天然较短，不计入关键部分判定）。 */
export const CASE_KEY_SECTION_ORDERS = [1, 2, 3, 4, 5, 6];

/** 由关键部分完整度推断状态。 */
export function inferCaseStatus(sections: CaseSection[]): string {
  const key = sections.filter((section) => {
    const order = sectionOrderOf(section.title);
    return order !== null && CASE_KEY_SECTION_ORDERS.includes(order);
  });
  const target = key.length > 0 ? key : sections;
  const filled = target.filter((s) => s.filled).length;
  if (filled === 0) return 'empty';
  if (filled >= target.length) return 'ready';
  return 'draft';
}

/** 递归收集 markdown 文件（受深度与跳过目录约束）。 */
export function collectMarkdownFiles(
  root: string,
  maxDepth = CASE_SCAN_MAX_DEPTH,
): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (CASE_SKIP_DIRS.includes(name)) continue;
      const full = join(dir, name);
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(full, depth + 1);
      } else if (name.toLowerCase().endsWith('.md')) {
        out.push(full);
      }
    }
  };
  walk(root, 0);
  return out;
}

/** 主入口：建立案件索引与状态跟踪。 */
export function buildCaseIndex(root: string): CaseIndexReport {
  const issues: CaseIndexIssue[] = [];
  const cases: CaseEntry[] = [];
  const files = collectMarkdownFiles(root);

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      issues.push({
        code: 'CASE_READ_FAILED',
        severity: 'warning',
        path: file,
        message: `读取失败：${file}`,
      });
      continue;
    }
    if (!looksLikeDisclosure(text)) continue;

    const rel = relative(root, file).split(sep).join('/');
    let sidecar: CaseSidecar | null;
    try {
      const raw = readFileSync(`${file}.case.json`, 'utf8');
      sidecar = JSON.parse(raw) as CaseSidecar;
    } catch (error) {
      sidecar = null;
      // ENOENT = 本来就没有旁挂元数据，属正常；解析失败 = 文件损坏，要报出来。
      if ((error as { code?: string }).code !== 'ENOENT') {
        issues.push({
          code: 'CASE_SIDECAR_INVALID',
          severity: 'warning',
          path: `${file}.case.json`,
          message: `旁挂元数据解析失败，已按交底书正文推断状态：${file}.case.json`,
        });
      }
    }

    const sections = extractCaseSections(text);
    const fallbackTitle = rel.replace(/\.md$/i, '');
    const title =
      sidecar?.title?.trim() || extractCaseTitle(text, fallbackTitle);
    const status = sidecar?.status?.trim() || inferCaseStatus(sections);
    let updatedAt: string;
    try {
      updatedAt = statSync(file).mtime.toISOString();
    } catch {
      updatedAt = '';
    }

    cases.push({
      caseId: sidecar?.caseId?.trim() || slugifyCaseId(rel),
      title,
      path: rel,
      status,
      statusSource: sidecar?.status?.trim() ? 'sidecar' : 'inferred',
      updatedAt,
      sections,
      ...(sidecar?.notes ? { notes: sidecar.notes } : {}),
    });
  }

  cases.sort((a, b) => a.path.localeCompare(b.path));

  if (cases.length === 0) {
    issues.push({
      code: 'CASE_NONE_FOUND',
      severity: 'warning',
      path: root,
      message:
        '未在工作区内找到交底书（需同时含「一、背景技术」「二、背景技术的技术问题」与「三、」三处小节标题）。',
    });
  }

  const stats = {
    total: cases.length,
    ready: cases.filter((c) => c.status === 'ready').length,
    draft: cases.filter((c) => c.status === 'draft').length,
    empty: cases.filter((c) => c.status === 'empty').length,
    withSidecar: cases.filter((c) => c.statusSource === 'sidecar').length,
  };

  return {
    cases,
    issues,
    stats,
    ok: !issues.some((i) => i.severity === 'error'),
    markdown: renderCaseIndexMarkdown({ cases, issues, stats }),
  };
}

/** Markdown 渲染。 */
export function renderCaseIndexMarkdown(report: {
  cases: CaseEntry[];
  issues: CaseIndexIssue[];
  stats: CaseIndexReport['stats'];
}): string {
  const lines: string[] = [];
  lines.push('# 交底书案件索引');
  lines.push('');
  lines.push(
    '> 状态优先取旁挂元数据 `<文件名>.case.json`（字段：caseId/title/status/notes）；没有旁挂文件时按七部分完整度推断（ready/draft/empty）。',
  );
  lines.push('');
  lines.push('## 一、案件清单');
  lines.push('');
  if (report.cases.length === 0) {
    lines.push('未找到交底书。');
  } else {
    lines.push(
      '| 案件号 | 标题 | 路径 | 状态 | 状态来源 | 七部分完成 | 更新时间 |',
    );
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const item of report.cases) {
      const filled = item.sections.filter((s) => s.filled).length;
      lines.push(
        `| ${item.caseId} | ${item.title} | ${item.path} | ${item.status} | ${item.statusSource === 'sidecar' ? '旁挂文件' : '推断'} | ${filled}/${item.sections.length} | ${item.updatedAt} |`,
      );
    }
  }
  lines.push('');
  lines.push('## 二、各案七部分填充');
  lines.push('');
  for (const item of report.cases) {
    lines.push(`### ${item.caseId} · ${item.title}`);
    lines.push('');
    for (const section of item.sections) {
      lines.push(
        `- ${section.title}：${section.filled ? '已填写' : '待填写'}（${section.chars} 字）`,
      );
    }
    if (item.notes) lines.push(`- 备注：${item.notes}`);
    lines.push('');
  }
  lines.push('## 三、诊断');
  lines.push('');
  if (report.issues.length === 0) {
    lines.push('无诊断。');
  } else {
    for (const issue of report.issues) {
      lines.push(
        `- [${issue.severity}] ${issue.code}（${issue.path}）：${issue.message}`,
      );
    }
  }
  lines.push('');
  lines.push('## 四、统计');
  lines.push('');
  lines.push(
    `- 案件 ${report.stats.total} 份（ready ${report.stats.ready} / draft ${report.stats.draft} / empty ${report.stats.empty}），其中 ${report.stats.withSidecar} 份带旁挂元数据`,
  );
  return lines.join('\n');
}
