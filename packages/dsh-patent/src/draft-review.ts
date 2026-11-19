/**
 * 初稿审查主检查面（纯函数，无网络；docx 由 draftPath 入参时经
 * docx-text.ts 读盘解析）。
 *
 * 定位：**出清单与证据，不代替代理师判断**。可机检面直接给分级问题
 * （位置 / 问题 / 依据 / 建议）；需模型判断的面（源码符合性、数值口径、
 * 图面语义、创造性）只出「核查清单 + 证据格式约束」，由模型读码读图后
 * 自行下结论——工具不硬断言。
 *
 * 与同包其它工具的分工：
 * - `patent_claims_check`（claims.ts）：权项结构校验，本卡复用其诊断码；
 * - `claims_evidence_check`（claims-evidence.ts）：权项↔源码对账，本卡
 *   消费其退守防线与未覆盖清单；
 * - `disclosure_check`（disclosure-check.ts）：交底书七部分体检，本卡复用
 *   其段落切分、同源文本与术语变体检测。
 *
 * 判据来源：实战审查产物的实测阈值（摘要 ≤300 字、公共后缀 ≥100 字、
 * 成对重复 ≥40 字等），详见 README「初稿审查」段。
 */

import { checkClaims, parseClaims } from './claims.ts';
import {
  checkClaimsEvidence,
  type EvidenceEntryInput,
} from './claims-evidence.ts';
import {
  checkDuplicateText,
  checkSectionPairDuplicates,
  checkTermVariants,
  countEffectiveChars,
  extractParagraphBlocks,
} from './disclosure-check.ts';
import { extractDocxText, looksLikeDocxPath } from './docx-text.ts';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** 源码清单的最大枚举文件数（避免误传大目录时失控）。 */
export const SOURCE_INVENTORY_LIMIT = 200;
/** 源码清单的最大递归深度。 */
export const SOURCE_INVENTORY_MAX_DEPTH = 3;
/** 源码清单跳过的目录名。 */
const SOURCE_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.next',
  '.turbo',
  '__pycache__',
]);

/** 读取纯文本文件（.md/.txt 等；docx 走既有解析器）。 */
function readTextFile(path: string): string {
  if (looksLikeDocxPath(path)) {
    return extractDocxText(path);
  }
  return readFileSync(path, 'utf8');
}

/**
 * 列出源码根目录下的文件（相对路径）。
 *
 * 工具侧只列清单、不读码、不判定命中——命中与否由模型逐条读源码后
 * 通过 `entries` 回填给 `claims_evidence_check`。
 */
export function listSourceFiles(
  root: string,
  limit = SOURCE_INVENTORY_LIMIT,
): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > SOURCE_INVENTORY_MAX_DEPTH || out.length >= limit) {
      return;
    }
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (out.length >= limit) {
        return;
      }
      const full = join(dir, name);
      let stats: ReturnType<typeof statSync>;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        if (SOURCE_SKIP_DIRS.has(name)) {
          continue;
        }
        walk(full, depth + 1);
        continue;
      }
      if (!stats.isFile()) {
        continue;
      }
      out.push(relative(root, full).split(sep).join('/'));
    }
  };
  try {
    if (!statSync(root).isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }
  walk(root, 0);
  return out.sort();
}

/** 审查视角（focus 裁剪维度）。 */
export const REVIEW_FACES = [
  'comply',
  'formal',
  'prior-art',
  'strategy',
] as const;
export type ReviewFace = (typeof REVIEW_FACES)[number];

/** 问题严重度分级（对齐审查实践的五档）。 */
export const DRAFT_SEVERITIES = [
  'critical',
  'high',
  'medium',
  'low',
  'suggestion',
] as const;
export type DraftSeverity = (typeof DRAFT_SEVERITIES)[number];

/** 严重度的中文标签。 */
export const SEVERITY_LABEL: Record<DraftSeverity, string> = {
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
  suggestion: '建议',
};

/** 视角的中文标签。 */
export const FACE_LABEL: Record<ReviewFace, string> = {
  comply: '符合性',
  formal: '形式规范',
  'prior-art': '检索与创造性',
  strategy: '布局与退守',
};

/** 单条分级问题（机检面产物）。 */
export type DraftReviewIssue = {
  /** 稳定诊断码。 */
  code: string;
  /** 所属视角。 */
  face: ReviewFace;
  /** 严重度。 */
  severity: DraftSeverity;
  /** 问题一句话概括。 */
  title: string;
  /** 位置（哪一段/哪一项权利要求）。 */
  location: string;
  /** 依据（实测值或原文片段）。 */
  basis: string;
  /** 建议（怎么改）。 */
  suggestion: string;
};

/** 需模型判断的核查项（不出结论，只给核查什么 + 证据格式）。 */
export type DraftReviewChecklistItem = {
  code: string;
  face: ReviewFace;
  title: string;
  why: string;
  evidenceFormat: string;
};

/** 「所述X」纪律统计（权项区 / 说明书区各一份）。 */
export type DraftReviewTermStat = {
  region: 'claims' | 'spec';
  term: string;
  /** 裸用次数（不含「所述X」形态）。 */
  bare: number;
  /** 带「所述」的次数。 */
  withSaid: number;
};

/** 审查输入。 */
export type DraftReviewInput = {
  /** 说明书摘要文本。 */
  abstract?: string;
  /** 权利要求书文本。 */
  claims?: string;
  /** 说明书正文（含五部分）。 */
  specification?: string;
  /** 附图说明文本。 */
  figures?: string;
  /** 交底书文本（可选，用于保真度对账）。 */
  disclosure?: string;
  /** 交底书文件路径（可选；与 disclosure 二选一，传入则读入并参与全文重复度交叉比对）。 */
  disclosurePath?: string;
  /** 初稿 docx 路径（可选；传入则按标题切分到上面各区）。 */
  draftPath?: string;
  /** 视角裁剪；缺省 comply（= 形式规范 + 符合性）。 */
  focus?: ReviewFace;
  /** 2/5 `claims_evidence_check` 的证据记录（可选）。 */
  entries?: EvidenceEntryInput[];
  /**
   * 源码根目录（可选）。工具侧不读码、不替模型断言，只列出入参范围内的
   * 源码文件清单，供模型逐条比对「权项特征 ↔ 源码落点」，并作为
   * 「无源码落点特征清单」的定位范围。
   */
  sourceRoot?: string;
};

/** 审查报告。 */
export type DraftReviewReport = {
  /** 实际生效的视角。 */
  focus: ReviewFace;
  /** 分级问题清单（按严重度、视角排序）。 */
  issues: DraftReviewIssue[];
  /** 需模型判断的核查清单。 */
  checklist: DraftReviewChecklistItem[];
  /** 「所述X」纪律统计（裸用 Top-N）。 */
  termStats: DraftReviewTermStat[];
  /** 无源码落点的特征清单（权项写了但没给源码锚点）。 */
  uncoveredFeatures: { feature: string; claimNo: number | null }[];
  /** 源码根目录下的文件清单（仅当传入 sourceRoot；工具不读码、不判定命中）。 */
  sourceInventory: string[];
  /** 退守防线评估（来自 2/5；无证据记录时为 null）。 */
  fallback: {
    branches: { claimNo: number; referencedBy: number[] }[];
    risks: {
      chain: number[];
      poisonedBy: number[];
      verdicts: string[];
    }[];
  } | null;
  /** 统计。 */
  stats: {
    issues: number;
    byFace: Record<ReviewFace, number>;
    bySeverity: Record<DraftSeverity, number>;
    checklist: number;
  };
  /** markdown 报告（可直接作为审查意见清单）。 */
  markdown: string;
  /** 是否无 critical/high 级问题。 */
  ok: boolean;
};

/** 摘要字数上限（CNIPA 说明书摘要不超过 300 字）。 */
export const ABSTRACT_CHAR_LIMIT = 300;
/** 三处同源文本的公共后缀阈值。 */
export const TRIPLE_DUPLICATE_FLOOR = 100;
/** 发明内容 ↔ 实施方式成对重复阈值。 */
export const PAIR_DUPLICATE_FLOOR = 40;
/** 术语裸用告警阈值（裸用次数）。 */
export const TERM_BARE_FLOOR = 3;

/** 说明书五部分的标题关键词。 */
const SPEC_SECTION_HEADS: { key: string; label: string; patterns: RegExp[] }[] =
  [
    { key: 'field', label: '技术领域', patterns: [/技术领域/] },
    { key: 'background', label: '背景技术', patterns: [/背景技术/] },
    {
      key: 'invention',
      label: '发明内容',
      patterns: [/发明内容/],
    },
    { key: 'figures', label: '附图说明', patterns: [/附图说明/] },
    {
      key: 'embodiment',
      label: '具体实施方式',
      patterns: [/具体实施方式/, /具体实施例/],
    },
  ];

/** 绝对化措辞（低危但审查员常点名）。 */
const ABSOLUTE_WORDS = [
  '杜绝',
  '保证',
  '完全',
  '零改动',
  '绝不会',
  '无法适用于',
];

/** 程序型权利要求载体关键词。 */
const PROGRAM_LEGS = /处理器|存储器|存储介质|计算机程序|计算机可读/;

/**
 * 封闭列举（「N 类/N 种」）模式。
 *
 * 「四类通道」「三种方式」是典型的封闭枚举写法，量词后接名词很常见；
 * 但「一种」「一类」多为泛指，故只收二类及以上与数字枚举。
 */
const CLOSED_ENUM = /([一二三四五六七八九十]{1,3}|\d{1,2})\s*(类|种)/g;

/** 「一类/一种」多为泛指，不算封闭列举。 */
const GENERIC_ENUM = new Set(['一类', '一种']);

/** 部件名 + 三位数字（附图标记裸写检测）。 */
const BARE_COMPONENT_MARK =
  /(层|模块|单元|部件|装置|接口|电路|结构|容器|引擎)([0-9]{3})(?![)）])/g;

/** 引号内的发明名称。 */
const NAME_IN_QUOTES = /[「『"《]([^」』"》]{2,40})[」』"》]/;

/** 归一化：去空白、全角转半角、统一常见标点，用于逐字比对。 */
export function normalizeForCompare(text: string): string {
  return text
    .replace(/[\s\u3000]+/g, '')
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[「」『』]/g, '"')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[，]/g, ',')
    .replace(/[。]/g, '.')
    .replace(/[；]/g, ';')
    .replace(/[：]/g, ':')
    .replace(/[、]/g, ',');
}

/** 切出说明书五部分（按标题行切，缺标题返回空串）。 */
export function splitSpecSections(
  specification: string,
): Record<string, string> {
  const lines = specification.split(/\r?\n/);
  const result: Record<string, string> = {};
  for (const section of SPEC_SECTION_HEADS) {
    const start = lines.findIndex((line) =>
      section.patterns.some((pattern) => pattern.test(line)),
    );
    if (start < 0) {
      result[section.key] = '';
      continue;
    }
    const end = lines.findIndex((line, index) => {
      if (index <= start) return false;
      return SPEC_SECTION_HEADS.some(
        (other) =>
          other.key !== section.key &&
          other.patterns.some((pattern) => pattern.test(line)),
      );
    });
    result[section.key] = lines
      .slice(start + 1, end < 0 ? lines.length : end)
      .join('\n');
  }
  return result;
}

/**
 * 提取「所述X」术语表（逐「所述」扫描，遇下一「所述」即停，再在连接词/助词
 * 处截断取名词主体）。
 *
 * 截断必须切连接词：「处理所述绑定键后输出结果。」若只按标点切，术语会变成
 * 「绑定键后输出结果」，权项里裸用「绑定键」就再也匹配不上（术语纪律机检面
 * 静默失效）。实现与 disclosure-check.ts 的同名逻辑保持一致。
 */
export function extractSaidTerms(text: string): string[] {
  const terms = new Set<string>();
  const CHAR_RE = /[^\s，,。；；、（）()【】]/;
  for (const m of text.matchAll(/所述/g)) {
    let raw = '';
    let i = (m.index ?? 0) + 2;
    while (raw.length < 12 && i < text.length) {
      const ch = text[i]!;
      if (!CHAR_RE.test(ch)) break;
      if (ch === '所' && text[i + 1] === '述') break;
      raw += ch;
      i += 1;
    }
    const head =
      raw.split(/(?:并|与|和|或|及|时|前|后|中|内|上|下|之|的)/)[0] ?? '';
    const cleaned = head.replace(/[的中内后上下之与和或及时前]*$/, '');
    if (cleaned.length >= 2) terms.add(cleaned);
  }
  return [...terms];
}

/** 统计区域内某术语的裸用与带「所述」次数。 */
export function countTermUsage(
  region: 'claims' | 'spec',
  term: string,
  text: string,
): DraftReviewTermStat {
  const total = text.split(term).length - 1;
  const withSaid = text.split(`所述${term}`).length - 1;
  return { region, term, bare: Math.max(0, total - withSaid), withSaid };
}

/** 取「发明名称」候选（摘要或说明书中书名号/引号内的短标题）。 */
function extractName(text: string): string | null {
  const match = text.match(NAME_IN_QUOTES);
  return match ? match[1]!.trim() : null;
}

/**
 * 从 docx 全文按标题切出摘要 / 权利要求书 / 说明书 / 附图说明。
 *
 * CNIPA 初稿的常见排布是：说明书摘要 → 权利要求书 → 说明书（技术领域 …
 * 具体实施方式）→（部分稿件把附图说明单列在说明书之后）。因此：
 * - 说明书正文 = 「说明书」标题行之后到文末，不再按「附图说明」切（否则说明书
 *   正文会被并进权项段、附图段吃掉具体实施方式）；
 * - 附图说明 = 从说明书正文里切出的「附图说明」小节（splitSpecSections 负责），
 *   没有该小节时为空串。
 */
function splitDocxDraft(text: string): {
  abstract: string;
  claims: string;
  specification: string;
  figures: string;
} {
  const lines = text.split(/\r?\n/);
  const indexOfHeading = (patterns: RegExp[]) =>
    lines.findIndex((line) => patterns.some((pattern) => pattern.test(line)));
  const claimsAt = indexOfHeading([
    /^\s*权\s*利\s*要\s*求\s*书\s*$/,
    /权利要求书/,
  ]);
  const abstractAt = indexOfHeading([
    /说\s*明\s*书\s*摘\s*要/,
    /^\s*摘\s*要\s*$/,
  ]);
  const specAt = indexOfHeading([
    /^\s*说\s*明\s*书\s*$/,
    /^\s*说\s*明\s*书\s*[（(]/,
  ]);
  const slice = (from: number, to: number) =>
    from < 0 || to < 0 ? '' : lines.slice(from, to).join('\n');
  const claimsEnd = specAt > claimsAt && specAt > 0 ? specAt : lines.length;
  const specification = specAt >= 0 ? lines.slice(specAt + 1).join('\n') : '';
  const sections = splitSpecSections(specification);
  return {
    abstract: slice(abstractAt + 1, claimsAt >= 0 ? claimsAt : specAt),
    claims: slice(claimsAt + 1, claimsEnd),
    specification,
    figures: sections['figures'] ?? '',
  };
}

/**
 * 权项结构诊断 → 初稿审查问题的映射（复用 claims.ts 的诊断码）。
 *
 * 导出供测试钉住覆盖面：claims.ts 新增诊断码时，这里必须同步补映射，
 * 否则该诊断在初稿审查里会被静默丢弃。
 */
export const CLAIM_ISSUE_MAP: Record<
  string,
  { severity: DraftSeverity; title: string; suggestion: string }
> = {
  CLAIMS_EMPTY: {
    severity: 'high',
    title: '权利要求书为空',
    suggestion: '补充权利要求书后重新审查。',
  },
  CLAIM_DUP_NUMBER: {
    severity: 'medium',
    title: '权利要求编号重复',
    suggestion: '核对编号，确保每项权利要求编号唯一。',
  },
  CLAIM_NUMBER_GAP: {
    severity: 'medium',
    title: '权利要求编号不连续',
    suggestion: '按 1 起连续编号，避免审查员要求补正。',
  },
  CLAIM_FIRST_DEPENDENT: {
    severity: 'high',
    title: '首项权利要求为从属项',
    suggestion: '第 1 项应为独立权利要求。',
  },
  CLAIM_EMPTY: {
    severity: 'high',
    title: '存在空权利要求',
    suggestion: '补齐该项权利要求正文。',
  },
  CLAIM_REF_SELF: {
    severity: 'high',
    title: '权利要求自引用',
    suggestion: '删除自引用，改为引用在先权利要求。',
  },
  CLAIM_REF_MISSING: {
    severity: 'high',
    title: '引用了不存在的权利要求',
    suggestion: '核对被引用编号是否存在。',
  },
  CLAIM_REF_FORWARD: {
    severity: 'high',
    title: '引用了在后权利要求',
    suggestion: '从属权利要求只能引用在先权利要求。',
  },
  CLAIM_MULTI_ON_MULTI: {
    severity: 'high',
    title: '多项从属引用了多项从属项',
    suggestion: '改为引用单项从属权利要求或独立权利要求。',
  },
  CLAIM_SUBJECT_MISMATCH: {
    severity: 'high',
    title: '引用主题不一致',
    suggestion: '核对从属项引用对象的类型与主题是否一致。',
  },
  CLAIM_NO_CHARACTERIZING: {
    severity: 'medium',
    title: '权利要求缺少「其特征在于」两分式撰写',
    suggestion: '按「前序部分 + 其特征在于 + 特征部分」重写。',
  },
  CLAIM_SUBJECT_UNPARSED: {
    severity: 'low',
    title: '权利要求主题名无法解析',
    suggestion: '确认主题名格式与全文一致（建议「一种XXX方法/系统」）。',
  },
  CLAIM_REF_FORMAT: {
    severity: 'low',
    title: '权利要求引用格式不规范',
    suggestion: '统一为「根据权利要求N所述的…」句式。',
  },
};

/** 查重工具的诊断码 → 初稿审查问题。 */
function fromDisclosureIssue(
  issue: { code: string; message: string; severity: 'error' | 'warning' },
  face: ReviewFace,
  location: string,
): DraftReviewIssue | null {
  if (issue.code === 'DUPLICATE_TEXT') {
    return {
      code: 'text-duplication',
      face,
      severity: 'medium',
      title: '存在同源文本复制',
      location,
      basis: issue.message,
      suggestion: '改写差异化，避免把冗余带进申请文件。',
    };
  }
  if (issue.code === 'SECTION_DUPLICATE') {
    return {
      code: 'invention-embodiment-duplicate',
      face,
      severity: 'low',
      title: '发明内容与具体实施方式存在成对重复段落',
      location,
      basis: issue.message,
      suggestion: '实施方式只保留与结构/参数/步骤差异相关的表述，不整段重抄。',
    };
  }
  if (issue.code === 'TERM_VARIANT_PAIR') {
    return {
      code: 'term-variant',
      face,
      severity: 'medium',
      title: '同一事物存在多种称呼',
      location,
      basis: issue.message,
      suggestion: '统一术语，或在首次出现处声明「以下简称X」并全文一致使用。',
    };
  }
  return null;
}

/** 视角 → 生效的面集合（comply = 形式规范 + 符合性）。 */
function facesFor(focus: ReviewFace): ReviewFace[] {
  return focus === 'comply' ? ['formal', 'comply'] : [focus];
}

/** 主入口：初稿审查。 */
export function checkDraftReview(input: DraftReviewInput): DraftReviewReport {
  const focus = input.focus ?? 'comply';
  const faces = facesFor(focus);
  const enabled = (face: ReviewFace) => faces.includes(face);
  const issues: DraftReviewIssue[] = [];
  const checklist: DraftReviewChecklistItem[] = [];
  const termStats: DraftReviewTermStat[] = [];

  let abstractText = input.abstract ?? '';
  let claimsText = input.claims ?? '';
  let specificationText = input.specification ?? '';
  let figuresText = input.figures ?? '';

  // docx 初稿：按标题切分；解析失败只记一条问题，不吞掉其余检查。
  if (input.draftPath && looksLikeDocxPath(input.draftPath)) {
    try {
      const parts = splitDocxDraft(extractDocxText(input.draftPath));
      abstractText = abstractText || parts.abstract;
      claimsText = claimsText || parts.claims;
      specificationText = specificationText || parts.specification;
      figuresText = figuresText || parts.figures;
    } catch (error) {
      // 解析失败按当前 focus 归面：prior-art 只出清单时不应冒出 formal 问题。
      if (enabled('formal')) {
        issues.push({
          code: 'docx-parse-failed',
          face: 'formal',
          severity: 'high',
          title: 'docx 初稿解析失败',
          location: input.draftPath,
          basis: error instanceof Error ? error.message : String(error),
          suggestion:
            '改用 office skill 或捆绑 python-docx 提取文本后，把文本分段传入。',
        });
      }
    }
  }

  // 交底书文件路径：读入后参与全文重复度交叉比对（保真度对账）。
  let disclosureText = input.disclosure ?? '';
  if (!disclosureText.trim() && input.disclosurePath) {
    try {
      disclosureText = readTextFile(input.disclosurePath);
    } catch (error) {
      if (enabled('formal')) {
        issues.push({
          code: 'disclosure-read-failed',
          face: 'formal',
          severity: 'medium',
          title: '交底书读取失败',
          location: input.disclosurePath,
          basis: error instanceof Error ? error.message : String(error),
          suggestion: '核对路径，或直接把交底书文本作为 disclosure 传入。',
        });
      }
    }
  }

  // 源码根目录：只列清单供模型逐条比对，工具不读码、不替模型断言。
  const sourceInventory = input.sourceRoot
    ? listSourceFiles(input.sourceRoot)
    : [];

  const fullText = [
    abstractText,
    claimsText,
    specificationText,
    figuresText,
    disclosureText,
  ]
    .filter(Boolean)
    .join('\n\n');

  if (!fullText.trim()) {
    issues.push({
      code: 'no-input',
      face: focus,
      severity: 'low',
      title: '没有可审查的初稿内容',
      location: '输入',
      basis: '摘要 / 权项书 / 说明书 / 附图 / docx 路径都没有提供有效文本。',
      suggestion:
        '传入初稿 docx 路径，或把摘要、权项书、说明书、附图文本分别传入。',
    });
  }

  // 权项结构（formal 面）：复用 claims.ts 的诊断码。
  const claimsReport = claimsText ? checkClaims(claimsText) : null;
  if (enabled('formal') && claimsReport) {
    for (const issue of claimsReport.issues) {
      const mapped = CLAIM_ISSUE_MAP[issue.code];
      if (!mapped) continue;
      issues.push({
        code: `claims:${issue.code.toLowerCase()}`,
        face: 'formal',
        severity: mapped.severity,
        title: mapped.title,
        location: issue.claim ? `权利要求 ${issue.claim}` : '权利要求书',
        basis: issue.message,
        suggestion: mapped.suggestion,
      });
    }
  }

  // 说明书五部分（formal 面）：说明书整体缺失也要报，不能静默跳过。
  const sections = splitSpecSections(specificationText);
  if (enabled('formal')) {
    const missing = SPEC_SECTION_HEADS.filter(
      (section) => !sections[section.key],
    );
    if (missing.length > 0) {
      issues.push({
        code: 'spec-sections-missing',
        face: 'formal',
        severity: specificationText ? 'high' : 'medium',
        title: specificationText ? '说明书缺少必要部分' : '未提供说明书正文',
        location: '说明书',
        basis: specificationText
          ? `缺少：${missing.map((s) => s.label).join('、')}`
          : '未提供说明书文本，五部分（技术领域/背景技术/发明内容/附图说明/具体实施方式）全部无法核对。',
        suggestion: '按技术领域/背景技术/发明内容/附图说明/具体实施方式补齐。',
      });
    }
  }

  // 摘要形式要件（formal 面）。
  if (enabled('formal') && abstractText) {
    const chars = countEffectiveChars(abstractText);
    if (chars > ABSTRACT_CHAR_LIMIT) {
      issues.push({
        code: 'abstract-length',
        face: 'formal',
        severity: 'medium',
        title: '摘要超出字数上限',
        location: '说明书摘要',
        basis: `有效字数 ${chars} 字，超过 ${ABSTRACT_CHAR_LIMIT} 字上限`,
        suggestion: '删减到 300 字以内，只保留技术领域、问题、方案要点与用途。',
      });
    }
    const abstractName = extractName(abstractText);
    const specName = extractName(specificationText);
    if (abstractName && specName && abstractName !== specName) {
      issues.push({
        code: 'abstract-name-mismatch',
        face: 'formal',
        severity: 'medium',
        title: '摘要中的发明名称与说明书不一致',
        location: '说明书摘要',
        basis: `摘要「${abstractName}」≠ 说明书「${specName}」`,
        suggestion: '两处名称逐字统一（含「及系统」等后缀）。',
      });
    }
  }

  // 引用写法（formal 面）。
  if (enabled('formal') && claimsText) {
    const tilde = claimsText.match(/权利要求\s*\d+\s*[~～]\s*\d+/g);
    if (tilde) {
      issues.push({
        code: 'claim-ref-range-tilde',
        face: 'formal',
        severity: 'medium',
        title: '权利要求区间引用使用了「~」',
        location: '权利要求书',
        basis: `命中：${[...new Set(tilde)].join('、')}`,
        suggestion: '统一改为「权利要求N至M中任一项」。',
      });
    }
    if (/所述的一种/.test(claimsText)) {
      issues.push({
        code: 'claim-ref-ones',
        face: 'formal',
        severity: 'low',
        title: '引用措辞中出现「所述的一种」',
        location: '权利要求书',
        basis: '命中「所述的一种」',
        suggestion: '引用时删除「一种」，统一为「所述XXX」。',
      });
    }
    const hasRu = /如权利要求\s*\d/.test(claimsText);
    const hasGen = /根据权利要求\s*\d/.test(claimsText);
    if (hasRu && hasGen) {
      issues.push({
        code: 'claim-ref-wording-mixed',
        face: 'formal',
        severity: 'low',
        title: '引用措辞不统一（同时出现「如权利要求」与「根据权利要求」）',
        location: '权利要求书',
        basis: '两种措辞并存',
        suggestion: '全文统一为一种引用措辞。',
      });
    }
    const separators = new Set<string>();
    for (const match of claimsText.matchAll(/其特征在于\s*([:：,，])/g)) {
      separators.add(normalizeForCompare(match[1]!));
    }
    if (separators.size > 1) {
      issues.push({
        code: 'preamble-separator-mixed',
        face: 'formal',
        severity: 'low',
        title: '「其特征在于」后的分隔符不统一',
        location: '权利要求书',
        basis: `出现 ${separators.size} 种分隔符：${[...separators].join(' ')}`,
        suggestion: '全文统一用一种分隔符。',
      });
    }
  }

  // 附图标记体例（formal 面）。
  if (enabled('formal') && fullText) {
    const bare = new Set<string>();
    for (const match of fullText.matchAll(BARE_COMPONENT_MARK)) {
      bare.add(`${match[1]}${match[2]}`);
    }
    if (bare.size > 0) {
      issues.push({
        code: 'figref-bare-mark',
        face: 'formal',
        severity: 'medium',
        title: '附图标记存在裸写（未带括号）',
        location: '权利要求书 / 说明书',
        basis: `裸写标记：${[...bare].slice(0, 8).join('、')}`,
        suggestion:
          '按体例统一加括号（如「（驱动渲染层500）」），同一部件全文一致。',
      });
    }
    const withParen = /（图\s*\d+\s*）/g;
    const withoutParen = /[^（(]图\s*\d+\s*[^）)]/g;
    if (
      [...fullText.matchAll(withParen)].length > 0 &&
      [...fullText.matchAll(withoutParen)].length > 0
    ) {
      issues.push({
        code: 'figref-style-mixed',
        face: 'formal',
        severity: 'low',
        title: '附图标记体例混用（带括号与不带括号并存）',
        location: '全文',
        basis: '同时存在「（图1）」与「图1」两种形态',
        suggestion: '权利要求中的附图标记统一带括号，说明书正文按体例统一。',
      });
    }
  }

  // 附图一致性（formal 面）：悬空图号引用 + 图号不连续 + 缺就近指引。
  if (enabled('formal') && fullText) {
    const declared = new Set<number>();
    for (const match of figuresText.matchAll(/图\s*(\d+)/g)) {
      declared.add(Number(match[1]));
    }
    const referenced = new Set<number>();
    for (const match of fullText.matchAll(/图\s*(\d+)/g)) {
      referenced.add(Number(match[1]));
    }
    const dangling = [...referenced].filter((n) => !declared.has(n));
    if (declared.size > 0 && dangling.length > 0) {
      issues.push({
        code: 'figure-dangling-reference',
        face: 'formal',
        severity: 'high',
        title: '正文引用了附图说明中不存在的图号',
        location: '说明书正文 / 附图说明',
        basis: `悬空图号：${dangling.join('、')}`,
        suggestion: '补齐对应附图说明条目，或修正正文引用。',
      });
    }
    if (declared.size > 0) {
      const sorted = [...declared].sort((a, b) => a - b);
      const expected = Array.from(
        { length: sorted[sorted.length - 1]! - sorted[0]! + 1 },
        (_, index) => sorted[0]! + index,
      );
      const missing = expected.filter((n) => !declared.has(n));
      if (missing.length > 0) {
        issues.push({
          code: 'figure-number-gap',
          face: 'formal',
          severity: 'medium',
          title: '附图说明图号不连续',
          location: '附图说明',
          basis: `缺号：${missing.join('、')}`,
          suggestion: '图号连续编号，缺号补图或改号。',
        });
      }
      const noGuide = [...declared].filter((n) => {
        const guide = new RegExp(
          `如\\s*图\\s*${n}(?!\\d)|图\\s*${n}(?!\\d)\\s*所示`,
        );
        return !guide.test(fullText);
      });
      if (noGuide.length > 0) {
        issues.push({
          code: 'figure-no-guidance',
          face: 'formal',
          severity: 'low',
          title: '部分附图在正文缺少就近指引',
          location: '说明书正文',
          basis: `无「如图N」/「图N所示」指引：${noGuide.join('、')}`,
          suggestion: '在对应步骤附近补「如图N所示」指引。',
        });
      }
    }
  }

  // 发明内容 ↔ 权项逐字一致（formal 面）。
  if (enabled('formal') && claimsText && sections.invention) {
    const invention = normalizeForCompare(sections.invention);
    const claims = parseClaims(claimsText);
    for (const claim of claims) {
      const feature = normalizeForCompare(claim.text.replace(/其特征在于/, ''));
      if (feature.length < 12) continue;
      const segments = feature
        .split(/[,;.]/)
        .filter((segment) => segment.length >= 12)
        .sort((a, b) => b.length - a.length);
      const probe = segments[0] ?? feature;
      if (!invention.includes(probe)) {
        issues.push({
          code: 'invention-claim-parity',
          face: 'formal',
          // 逐字比对只是启发式：权项对发明内容做合法概括改写时也会命中，
          // 因此只作低危提示，真正的实质相同与否交人工/模型判断。
          severity: 'low',
          title: '权项特征未在发明内容中逐字出现',
          location: `权利要求 ${claim.number}`,
          basis: `发明内容中未找到：「${probe.slice(0, 24)}…」`,
          suggestion:
            '发明内容与权项逐字对应（审查员按字面比对）；不一致处要么改权项，要么补发明内容。',
        });
      }
    }
  }

  // 同源文本与成对重复（formal 面）。
  if (enabled('formal') && fullText) {
    const blocks = extractParagraphBlocks(fullText);
    for (const issue of checkDuplicateText(blocks, TRIPLE_DUPLICATE_FLOOR)) {
      const mapped = fromDisclosureIssue(issue, 'formal', '全文');
      if (mapped) issues.push(mapped);
    }
    if (sections.invention && sections.embodiment) {
      const fromLines = sections.invention.split(/\r?\n/);
      const toLines = sections.embodiment.split(/\r?\n/);
      for (const issue of checkSectionPairDuplicates(
        fromLines,
        toLines,
        '发明内容',
        '具体实施方式',
        PAIR_DUPLICATE_FLOOR,
      )) {
        const mapped = fromDisclosureIssue(
          issue,
          'formal',
          '发明内容 / 具体实施方式',
        );
        if (mapped) issues.push(mapped);
      }
    }
    for (const issue of checkTermVariants(fullText)) {
      const mapped = fromDisclosureIssue(issue, 'formal', '全文');
      if (mapped) issues.push(mapped);
    }
  }

  // 「所述X」纪律统计（formal 面）。
  if (enabled('formal') && fullText) {
    const terms = extractSaidTerms(fullText);
    const stats: DraftReviewTermStat[] = [];
    for (const region of ['claims', 'spec'] as const) {
      const regionText = region === 'claims' ? claimsText : specificationText;
      if (!regionText) continue;
      for (const term of terms) {
        const stat = countTermUsage(region, term, regionText);
        if (stat.bare > 0) stats.push(stat);
      }
    }
    stats.sort((a, b) => b.bare - a.bare);
    termStats.push(...stats.slice(0, 10));
    const naked = stats.filter(
      (stat) => stat.bare >= TERM_BARE_FLOOR && stat.withSaid === 0,
    );
    if (naked.length > 0) {
      issues.push({
        code: 'term-discipline-naked',
        face: 'formal',
        severity: 'medium',
        title: '术语裸用（该区域内未以「所述X」引入）',
        location: naked[0]!.region === 'claims' ? '权利要求书' : '说明书',
        basis: naked
          .slice(0, 5)
          .map((stat) => `${stat.term}×${stat.bare}`)
          .join('、'),
        suggestion:
          '首次出现处加「所述X」，其后保持一致——裸用会让权项保护范围不清。',
      });
    }
  }

  // 文字质量：绝对化措辞（formal 面）。
  if (enabled('formal') && fullText) {
    const hits = ABSOLUTE_WORDS.filter((word) => fullText.includes(word));
    if (hits.length > 0) {
      issues.push({
        code: 'text-absolute-wording',
        face: 'formal',
        severity: 'low',
        title: '存在绝对化措辞',
        location: '全文',
        basis: `命中：${hits.join('、')}`,
        suggestion: '改为可验证的限定表述（避免「杜绝/完全/保证」类措辞）。',
      });
    }
  }

  // 三腿权（comply 面）。
  if (enabled('comply') && claimsText && !PROGRAM_LEGS.test(fullText)) {
    issues.push({
      code: 'three-legs-missing',
      face: 'comply',
      // 这是策略提示而非形式缺陷（是否需要程序型权取决于方案本身），只作低危。
      severity: 'low',
      title: '全文未见程序型权利要求载体',
      location: '权利要求书',
      basis: '「处理器/存储器/存储介质/计算机程序」全文零命中',
      suggestion:
        '如方案由软件实现，补充计算机程序产品权与存储介质权，避免只能保护方法。',
    });
  }

  // 背景技术封闭列举 → 效果段闭环（comply 面）。
  if (enabled('comply') && sections.background) {
    const enums = new Set<string>();
    for (const match of sections.background.matchAll(CLOSED_ENUM)) {
      const item = `${match[1]}${match[2]}`;
      if (GENERIC_ENUM.has(item)) continue;
      enums.add(item);
    }
    const effectText = `${sections.invention}\n${sections.embodiment}`;
    const broken = [...enums].filter((item) => !effectText.includes(item));
    if (broken.length > 0) {
      issues.push({
        code: 'effect-chain-broken',
        face: 'comply',
        severity: 'medium',
        title: '背景技术列举的封闭枚举在效果段无对应',
        location: '背景技术 / 发明内容 / 具体实施方式',
        basis: `未在效果段出现：${broken.join('、')}`,
        suggestion:
          '问题—手段—效果三段闭环：效果段须回应背景技术点名的每一项。',
      });
    }
  }

  // 权项↔源码对账（消费 2/5 结果）：退守防线 + 无源码落点特征。
  let fallback: DraftReviewReport['fallback'] = null;
  const uncoveredFeatures: DraftReviewReport['uncoveredFeatures'] = [];
  if (input.entries && input.entries.length > 0) {
    const evidence = checkClaimsEvidence({
      claims: claimsText,
      entries: input.entries,
      document: specificationText,
    });
    fallback = {
      branches: evidence.fallback.branches.map((branch) => ({
        claimNo: branch.claimNo,
        referencedBy: branch.referencedBy,
      })),
      risks: evidence.fallback.risks.map((risk) => ({
        chain: risk.chain,
        poisonedBy: risk.poisonedBy,
        verdicts: [...risk.verdicts],
      })),
    };
    // 被 2/5 拒收的证据记录（判定非法 / 锚点格式错）不能静默丢弃，否则
    // 模型会以为「没报 = 通过」；转成低危问题提醒重新提交。
    for (const issue of evidence.issues) {
      if (issue.code !== 'EVIDENCE_MISSING' && issue.code !== 'ENTRY_INVALID') {
        continue;
      }
      issues.push({
        code: `evidence:${issue.code.toLowerCase()}`,
        face: 'comply',
        severity: 'low',
        title: '对账证据记录被拒收',
        location:
          issue.claimNo === null ? '对账记录' : `权利要求 ${issue.claimNo}`,
        basis: issue.message,
        suggestion:
          '按 claims_evidence_check 的证据格式重新提交该条记录（特征 + 源码 文件:行号 锚点 + 四态判定）。',
      });
    }
    const seenFeature = new Set<string>();
    const pushUncovered = (feature: string, claimNo: number | null): void => {
      const key = `${claimNo ?? 'x'}|${feature}`;
      if (seenFeature.has(key)) return;
      seenFeature.add(key);
      uncoveredFeatures.push({ feature, claimNo });
    };
    // 2/5 的证据强制会把「无锚点」的判定整条拒收（不构成判定结论）；
    // 这里从原始记录里单独收集，作为「待补证据的待办」列出。
    for (const raw of input.entries) {
      const entry = raw as {
        feature?: unknown;
        claimNo?: unknown;
        sourceAnchors?: unknown;
      };
      const feature = typeof entry.feature === 'string' ? entry.feature : '';
      if (!feature) continue;
      const anchors = Array.isArray(entry.sourceAnchors)
        ? entry.sourceAnchors
        : [];
      if (anchors.length === 0) {
        pushUncovered(
          feature,
          typeof entry.claimNo === 'number' ? entry.claimNo : null,
        );
      }
    }
    for (const entry of evidence.entries) {
      if (entry.sourceAnchors.length === 0) {
        pushUncovered(entry.feature, entry.claimNo);
      }
    }
    for (const entry of evidence.uncovered) {
      pushUncovered(entry.feature, entry.claimNo);
    }
    if (enabled('strategy')) {
      for (const risk of evidence.fallback.risks) {
        issues.push({
          code: 'fallback-risk',
          face: 'strategy',
          severity: 'medium',
          title: '从属链存在失实污染风险',
          location: `权利要求 ${risk.chain.join(' → ')}`,
          basis: `链上失实特征位于权利要求 ${risk.poisonedBy.join('、')}，判定：${risk.verdicts.join('、')}`,
          suggestion:
            '重排从属链，让最稳特征居首、被引基准形成并列分支，必要时改引独立权项。',
        });
      }
      if (evidence.fallback.branches.length === 0) {
        issues.push({
          code: 'fallback-single-branch',
          face: 'strategy',
          severity: 'low',
          title: '从属链为单链，无并列退守分支',
          location: '权利要求书',
          basis: '未被 ≥2 项引用的基准权项',
          suggestion:
            '构造并列从属分支（多个权项引同一基准），单一基准失守时全线受累。',
        });
      }
    }
    if (enabled('comply') && uncoveredFeatures.length > 0) {
      issues.push({
        code: 'evidence-anchor-missing',
        face: 'comply',
        severity: 'medium',
        title: '存在无源码落点的权项特征',
        location: '权利要求书',
        basis: uncoveredFeatures
          .slice(0, 5)
          .map(
            (item) =>
              `${item.claimNo ? `权${item.claimNo}` : '未编号'}「${item.feature}」`,
          )
          .join('、'),
        suggestion:
          '逐特征补源码锚点（文件:行号）；无落点的特征要么改写，要么删除。',
      });
    }
  }

  // 需模型判断的核查清单。
  if (enabled('comply')) {
    checklist.push(
      {
        code: 'code-consistency',
        face: 'comply',
        title: '权项特征与源码的逐条符合性',
        why: '权项写了但源码无落点或行为相反，主张即自曝破绽——这是本次审查的最高严重度问题。',
        evidenceFormat:
          '用 claims_evidence_check 提交逐特征记录（feature + 源码 文件:行号 锚点 + 四态判定），由工具强制证据纪律。',
      },
      {
        code: 'numeric-facts',
        face: 'comply',
        title: '数值与计数口径核对',
        why: '正文写「四类通道/至多3次/N 个槽位」而源码是另一种口径，是审查员与法院都抓的硬伤。',
        evidenceFormat:
          '每处数值断言挂源码常量定义处 文件:行号，并注明是总量还是单次量。',
      },
      {
        code: 'unclear-term',
        face: 'comply',
        title: '自造词与未定义术语',
        why: '权项里出现说明书未定义的生造词，说明书无法支持该特征。',
        evidenceFormat:
          '术语 + 出现位置（权项 N / 说明书段落）+ 说明书中是否有定义句式（X是指/X为…/X包括…）。',
      },
      {
        code: 'effect-chain-semantic',
        face: 'comply',
        title: '问题—手段—效果语义闭环',
        why: '背景技术点名的每一个问题，效果段都要有对应答复；机检只能查关键词，语义断裂需模型判读。',
        evidenceFormat:
          '背景技术问题点 + 对应手段位置 + 效果段答复位置（三段都要给位置）。',
      },
    );
  }
  if (enabled('formal')) {
    checklist.push(
      {
        code: 'figure-semantic',
        face: 'formal',
        title: '图面语义完整性（分支与正文步骤互证）',
        why: '图缺分支、连线方向与正文数据流相反，附图与说明书互相矛盾。',
        evidenceFormat:
          '图号 + 图内分支/标注（模型读图）+ 正文对应步骤位置 + 不一致描述。',
      },
      {
        code: 'support-check',
        face: 'formal',
        title: '说明书对权项的支持性',
        why: '权项特征在说明书中找不到依据，违反充分公开要求。',
        evidenceFormat:
          '权项 N + 特征原文 + 说明书支持位置（段落/条目），找不到则标「未找到」。',
      },
    );
  }
  if (enabled('prior-art')) {
    checklist.push(
      {
        code: 'prior-art-search',
        face: 'prior-art',
        title: '最接近现有技术检索与区别特征',
        why: '检索与创造性判断无法静态机检，须由模型检索并给对比文件。',
        evidenceFormat:
          '对比文件号 + 公开日 + 与本方案的区别特征 + 权项中的承载位置。',
      },
      {
        code: 'prior-art-inventiveness',
        face: 'prior-art',
        title: '非显而易见性（技术效果能否弥补常规组合）',
        why: '常规手段的简单叠加不产生创造性，需评估效果链。',
        evidenceFormat:
          '最接近现有技术 + 实际解决的技术问题 + 预料不到的效果 + 依据位置。',
      },
      {
        code: 'background-disclosure-state',
        face: 'prior-art',
        title: '背景技术自认的公开状态',
        why: '背景技术自认「改进前已有X」——已公开则强化新颖性分界，未公开则可能误导检索。',
        evidenceFormat:
          '自认句原文 + 位置 + 是否已公开（附公开依据或标「未核实」）。',
      },
    );
  }
  if (enabled('strategy')) {
    checklist.push({
      code: 'layout-review',
      face: 'strategy',
      title: '布局与退守防线优劣',
      why: '独权承载是否覆盖核心改进、最稳特征是否埋在链尾，机检只能给拓扑，优劣要模型判。',
      evidenceFormat:
        '权项拓扑描述 + 核心改进词在权项中的出现位置 + 建议的引用重排方案。',
    });
  }

  // 排序：严重度优先，同级按视角顺序。
  const severityOrder: Record<DraftSeverity, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    suggestion: 4,
  };
  issues.sort((a, b) => {
    const bySeverity = severityOrder[a.severity] - severityOrder[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return REVIEW_FACES.indexOf(a.face) - REVIEW_FACES.indexOf(b.face);
  });

  const byFace: Record<ReviewFace, number> = {
    comply: 0,
    formal: 0,
    'prior-art': 0,
    strategy: 0,
  };
  const bySeverity: Record<DraftSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    suggestion: 0,
  };
  for (const issue of issues) {
    byFace[issue.face] += 1;
    bySeverity[issue.severity] += 1;
  }

  const report: DraftReviewReport = {
    focus,
    issues,
    checklist,
    termStats,
    uncoveredFeatures,
    sourceInventory,
    fallback,
    stats: {
      issues: issues.length,
      byFace,
      bySeverity,
      checklist: checklist.length,
    },
    markdown: '',
    ok: bySeverity.critical === 0 && bySeverity.high === 0,
  };
  report.markdown = renderMarkdown(report);
  return report;
}

/** markdown 渲染：分级问题清单 + 核查清单 + 术语统计。 */
export function renderMarkdown(report: DraftReviewReport): string {
  const lines: string[] = [];
  lines.push(`# 初稿审查报告（视角：${FACE_LABEL[report.focus]}）`);
  lines.push('');
  lines.push(
    `共 ${report.stats.issues} 条分级问题（严重 ${report.stats.bySeverity.critical} / 高 ${report.stats.bySeverity.high} / 中 ${report.stats.bySeverity.medium} / 低 ${report.stats.bySeverity.low} / 建议 ${report.stats.bySeverity.suggestion}），${report.stats.checklist} 条需模型判断的核查项。`,
  );
  lines.push('');
  if (report.issues.length === 0) {
    lines.push('机检面未发现问题；仍需完成下方核查清单。');
  } else {
    lines.push('| 严重度 | 视角 | 问题 | 位置 | 依据 | 建议 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const issue of report.issues) {
      const cell = (value: string) =>
        value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      lines.push(
        `| ${SEVERITY_LABEL[issue.severity]} | ${FACE_LABEL[issue.face]} | ${cell(issue.title)} | ${cell(issue.location)} | ${cell(issue.basis)} | ${cell(issue.suggestion)} |`,
      );
    }
  }
  lines.push('');
  if (report.checklist.length > 0) {
    lines.push('## 需模型判断的核查清单');
    lines.push('');
    for (const item of report.checklist) {
      lines.push(
        `- **${item.title}**（${FACE_LABEL[item.face]}）：${item.why} 证据格式：${item.evidenceFormat}`,
      );
    }
    lines.push('');
  }
  if (report.termStats.length > 0) {
    lines.push('## 「所述X」纪律统计（裸用 Top-N）');
    lines.push('');
    lines.push('| 区域 | 术语 | 裸用 | 带「所述」 |');
    lines.push('| --- | --- | --- | --- |');
    for (const stat of report.termStats) {
      lines.push(
        `| ${stat.region === 'claims' ? '权利要求书' : '说明书'} | ${stat.term} | ${stat.bare} | ${stat.withSaid} |`,
      );
    }
    lines.push('');
  }
  if (report.uncoveredFeatures.length > 0) {
    lines.push('## 无源码落点的权项特征');
    lines.push('');
    for (const item of report.uncoveredFeatures) {
      lines.push(
        `- ${item.claimNo ? `权利要求 ${item.claimNo}` : '未编号'}：${item.feature}`,
      );
    }
    lines.push('');
  }
  if (report.sourceInventory.length > 0) {
    lines.push('## 源码目录清单（供模型逐条读码核对，工具不判定命中）');
    lines.push('');
    for (const file of report.sourceInventory) {
      lines.push(`- ${file}`);
    }
    lines.push('');
  }
  if (report.fallback && report.fallback.risks.length > 0) {
    lines.push('## 退守防线风险');
    lines.push('');
    for (const risk of report.fallback.risks) {
      lines.push(
        `- 链 ${risk.chain.join(' → ')}：失实特征位于权利要求 ${risk.poisonedBy.join('、')}`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
