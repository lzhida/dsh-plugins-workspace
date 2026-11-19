/**
 * 专利数据库检索接入——结构化归一 + 日期档位判定。
 *
 * 设计口径（2026-11-20 调研定稿，见任务卡 t-mvpan3c7-08ifus 评论）：
 * - 插件不内置依赖某个专利库的直连（CNIPA 无公开 API；PatentsView / EPO OPS
 *   都必须用户自带凭据；Google Patents 的 XHR 端点非官方、形状可能变）。
 *   本模块的核心是「把任一 provider 取回的原文或 JSON 归一成结构化记录 +
 *   补齐日期维度 + 算最小机械档位」，provider 侧留给用户或模型侧的网络工具。
 * - 零凭据兜底可选：Google Patents XHR 直连（默认关闭，非官方接口可能变更
 *   或限流，失败只降级为诊断不抛错）。
 * - 日期档位只是纯日期比较的最小机械判定，不构成法律判断；答辩锚点台账与
 *   复杂档位规则归后续卡。
 * - 「语义干扰排除」只做字面辅助：标出可疑记录交模型/人工复核，工具不断言
 *   语义无关。
 */

/** 公布号所属局。 */
export type PublicationKind = 'CN' | 'US' | 'EP' | 'WO' | 'JP' | 'KR' | 'OTHER';

/** 公布号种类码：A=申请公布、B=授权公告、U=实用新型、S=外观设计。 */
export type PublicationKindCode = 'A' | 'B' | 'U' | 'S' | 'T' | '';

/** 归一后的公布号。 */
export type NormalizedPublicationNumber = {
  /** 归一后的公布号，如 CN122824595A。 */
  number: string;
  /** 所属局。 */
  kind: PublicationKind;
  /** 种类码。 */
  kindCode: PublicationKindCode;
  /** 原文本。 */
  raw: string;
  /** 是否命中已知公布号格式（未命中则 number 仅做去空白大写处理）。 */
  matched: boolean;
};

/** 一条对比文件记录（归一后）。 */
export type PatentRecord = {
  publicationNumber: string;
  publicationKind: PublicationKind;
  publicationKindCode: PublicationKindCode;
  /** 公布号是否匹配已知局格式；false 表示原样保留、格式可疑。 */
  publicationNumberMatched: boolean;
  title: string | null;
  applicant: string | null;
  /** 申请日 YYYY-MM-DD。 */
  applicationDate: string | null;
  /** 公开日 YYYY-MM-DD。 */
  publicationDate: string | null;
  /** 优先权日 YYYY-MM-DD。 */
  priorityDate: string | null;
  ipc: string[];
  abstract: string | null;
  /** 权利要求首项原文（用于背景技术引用与特征比对）。 */
  firstClaim: string | null;
  /** 数据来源标记（provider 名 / pasted / google-patents-xhr）。 */
  source: string;
  /** 字面层面的语义干扰提示，工具不替模型断言语义无关。 */
  semanticNotes: string[];
};

/** 日期档位。 */
export type DateTier = 'prior-art' | 'needs-review' | 'later' | 'unknown';

/** 档位判定所需的三段输入 + 判定结果。 */
export type DateTierResult = {
  /** 对比文件申请日。 */
  recordApplicationDate: string | null;
  /** 对比文件公开日。 */
  recordPublicationDate: string | null;
  /** 本申请申请日。 */
  applicantFilingDate: string | null;
  /** 档位判定结果。 */
  tier: DateTier;
  /** 档位中文说明。 */
  label: string;
  /** 判定依据（引用了哪两个日期）。 */
  basis: string;
};

/** 单条诊断。 */
export type PatentSearchIssue = {
  code: string;
  severity: 'error' | 'warning';
  message: string;
};

/** 检索报告。 */
export type PatentSearchReport = {
  /** 本申请申请日（若有）。 */
  applicantFilingDate: string | null;
  /** 归一后的记录。 */
  records: PatentRecord[];
  /** 每条记录的档位判定。 */
  tiers: DateTierResult[];
  /** 诊断。 */
  issues: PatentSearchIssue[];
  /** 统计。 */
  stats: {
    records: number;
    priorArt: number;
    needsReview: number;
    later: number;
    unknown: number;
    semanticFlags: number;
  };
  /** 检索指引（未拿到原文时告诉模型去哪里查、怎么贴回来）。 */
  guidance: string[];
  /** 渲染好的 markdown。 */
  markdown: string;
  ok: boolean;
};

/** 检索指引模板：当只给查询词/公布号而没有原文时输出。 */
export const SEARCH_GUIDANCE: string[] = [
  '① 精确公布号查询：CNIPA 无公开 API，可走 EPO OPS（https://ops.epo.org/3.2/rest-services，需自带 OAuth2 Consumer Key/Secret）或 WIPO PATENTSCOPE（https://patentscope.wipo.int）；',
  '② 美国专利：USPTO PatentsView Search API（https://search.patentsview.org/api/v1/patent，需自带 X-Api-Key）或 Google Patents（https://patents.google.com）；',
  '③ 零凭据兜底：Google Patents 站点内部端点 https://patents.google.com/xhr/query?url=<编码后的查询串>，非官方接口，可能变更或限流，本工具仅作可选尽力而为的兜底；',
  '④ 取回原文或 JSON 后贴给本工具（raw / records 入参），工具负责归一字段、补齐申请日与公开日、计算日期档位；',
  '⑤ 期望字段：公布号、名称、申请人、申请日、公开日、优先权日、IPC/CPC、摘要、权利要求首项。',
];

/** 已知公布号前缀 → 所属局。 */
const KIND_BY_PREFIX: Record<string, PublicationKind> = {
  CN: 'CN',
  US: 'US',
  EP: 'EP',
  WO: 'WO',
  JP: 'JP',
  KR: 'KR',
};

/**
 * 公布号格式：`[局] 数字 [种类码]`，数字部分允许空格/连字符/斜杠分隔，
 * 允许后缀数字（如 US 11,074,495 B2 的 2）。
 */
const PUBLICATION_RE =
  /(?<prefix>[A-Za-z]{2})\s*[-/ ]?\s*(?<number>\d[\d\s,/-]{4,20})\s*(?<kind>[ABUSTS])?\s*(?<kindSeq>\d{0,2})/;

/**
 * 归一公布号：去掉号码中的分隔符与空格，拼接局前缀与种类码。
 *
 * 例：`CN 122824595 A` → `CN122824595A`；`US 11,074,495 B2` → `US11074495B2`；
 * `EP 1 000 000 A1` → `EP1000000A1`；`WO 2021/000001 A1` → `WO2021000001A1`。
 */
export function normalizePublicationNumber(
  raw: string,
): NormalizedPublicationNumber {
  const text = String(raw ?? '').trim();
  const upper = text.toUpperCase();
  // 美国外观设计专利号形如 `USD 987,111 S`：三字母前缀 USD（US 局 + D 号），
  // 常规两字母前缀正则会把其中的 "SD" 误当前缀，先特判。
  const usDesign = /^USD[\s,/-]*/.exec(upper);
  if (usDesign) {
    const tail = upper.slice(usDesign[0].length).replace(/[\s,/-]/g, '');
    if (/^\d/.test(tail)) {
      return {
        number: `USD${tail}`,
        kind: 'US',
        kindCode: '',
        raw: text,
        matched: true,
      };
    }
  }
  const match = PUBLICATION_RE.exec(upper);
  if (!match?.groups) {
    return {
      number: upper.replace(/\s+/g, ''),
      kind: 'OTHER',
      kindCode: '',
      raw: text,
      matched: false,
    };
  }
  const prefix = match.groups.prefix ?? '';
  const digits = (match.groups.number ?? '').replace(/[\s,/-]/g, '');
  const kindCode = (match.groups.kind ?? '') as PublicationKindCode;
  const kindSeq = match.groups.kindSeq ?? '';
  // 加固：无种类码且数字过短（如英文散文里的 "US 2024 election"）不算命中。
  if (!kindCode && digits.length < 5) {
    return {
      number: upper.replace(/\s+/g, ''),
      kind: 'OTHER',
      kindCode: '',
      raw: text,
      matched: false,
    };
  }
  return {
    number: `${prefix}${digits}${kindCode}${kindSeq}`,
    kind: KIND_BY_PREFIX[prefix] ?? 'OTHER',
    kindCode,
    raw: text,
    matched: true,
  };
}

/**
 * 归一日期：支持 `YYYY-MM-DD` / `YYYY/MM/DD` / `YYYY.MM.DD` / `YYYY年M月D日`
 * / 8 位 `YYYYMMDD`，输出 `YYYY-MM-DD`；无法识别返回 null。
 */
export function normalizeDate(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  let y: string | null = null;
  let m: string | null = null;
  let d: string | null = null;
  const cn = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(text);
  if (cn) {
    y = cn[1];
    m = cn[2];
    d = cn[3];
  } else {
    const sep = /(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})/.exec(text);
    if (sep) {
      y = sep[1];
      m = sep[2];
      d = sep[3];
    } else {
      const compact = /(?:^|\D)(\d{4})(\d{2})(\d{2})(?:\D|$)/.exec(text);
      if (compact) {
        y = compact[1];
        m = compact[2];
        d = compact[3];
      }
    }
  }
  if (!y || !m || !d) return null;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (year < 1800 || year > 2200) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  // 日历回验：拒绝 2024-02-30 这类格式合法但日历不存在的日期。
  const probe = new Date(year, month - 1, day);
  if (
    probe.getFullYear() !== year ||
    probe.getMonth() !== month - 1 ||
    probe.getDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 归一前的原始字段取值（来自 JSON 或文本抽取）。 */
export type RawPatentFields = {
  publicationNumber?: string | null;
  title?: string | null;
  applicant?: string | null;
  applicationDate?: string | null;
  publicationDate?: string | null;
  priorityDate?: string | null;
  ipc?: string[] | string | null;
  abstract?: string | null;
  firstClaim?: string | null;
  source?: string | null;
};

const JSON_KEY_MAP: Record<string, keyof RawPatentFields> = {
  publication_number: 'publicationNumber',
  publicationnumber: 'publicationNumber',
  publication_number_normalized: 'publicationNumber',
  patentnumber: 'publicationNumber',
  patent_number: 'publicationNumber',
  patent_publication_number: 'publicationNumber',
  number: 'publicationNumber',
  doc_number: 'publicationNumber',
  title: 'title',
  publication_title: 'title',
  patent_title: 'title',
  name: 'title',
  applicant: 'applicant',
  applicant_name: 'applicant',
  assignee: 'applicant',
  applicant_organization: 'applicant',
  申请人: 'applicant',
  filing_date: 'applicationDate',
  filingdate: 'applicationDate',
  application_date: 'applicationDate',
  applicationdate: 'applicationDate',
  earliest_application_date: 'applicationDate',
  申请日: 'applicationDate',
  publication_date: 'publicationDate',
  publicationdate: 'publicationDate',
  // PatentsView 的 patent_date 是授权日，作公开日的近似来源。
  patent_date: 'publicationDate',
  公开日: 'publicationDate',
  priority_date: 'priorityDate',
  prioritydate: 'priorityDate',
  优先权日: 'priorityDate',
  ipc: 'ipc',
  cpc: 'ipc',
  classification: 'ipc',
  分类号: 'ipc',
  abstract: 'abstract',
  publication_abstract: 'abstract',
  patent_abstract: 'abstract',
  摘要: 'abstract',
  first_claim: 'firstClaim',
  firstclaim: 'firstClaim',
  claim1: 'firstClaim',
  权利要求1: 'firstClaim',
};

const TEXT_LABELS: Record<keyof RawPatentFields, RegExp> = {
  publicationNumber:
    /(?:公布号|公开号|申请公布号|专利号|公开公告号|publication\s*(?:no|number)|document\s*number)\s*[:：]\s*(.+)/i,
  title: /(?:发明名称|名称|标题|title)\s*[:：]\s*(.+)/i,
  applicant: /(?:申请人|专利权人|申请主体|applicant|assignee)\s*[:：]\s*(.+)/i,
  applicationDate:
    /(?:申请日|filing\s*date|application\s*date)\s*[:：]\s*(.+)/i,
  publicationDate:
    /(?:公开日|公告日|公开日|publication\s*date)\s*[:：]\s*(.+)/i,
  priorityDate: /(?:优先权日|priority\s*date)\s*[:：]\s*(.+)/i,
  ipc: /(?:IPC(?:\/CPC)?|分类号|分类)\s*[:：]\s*(.+)/i,
  abstract:
    /(?:摘要|abstract)\s*[:：]\s*([\s\S]+?)(?=\n\s*(?:权利要求|申请人|申请日|公开日|优先权日|IPC|分类号|发明人)\s*[:：]|$)/i,
  firstClaim:
    /(?:权利要求\s*1|what\s+is\s+claimed(?:\s*is)?\s*:?)\s*[:：]?\s*([\s\S]+?)(?=\n\s*(?:权利要求\s*(?:[2-9]|\d{2,})|权利要求\s*1\s*[.、]|$))/i,
  source: /(?:来源|source)\s*[:：]\s*(.+)/i,
};

/** 从 JSON 对象抽取归一前的字段（键名按 JSON_KEY_MAP 归一）。 */
export function fieldsFromJsonObject(
  value: Record<string, unknown>,
): RawPatentFields {
  const out: RawPatentFields = {};
  for (const [key, raw] of Object.entries(value)) {
    const target = JSON_KEY_MAP[key.toLowerCase().trim()];
    if (!target) continue;
    if (target === 'ipc') {
      const list = Array.isArray(raw)
        ? raw.map((item) => String(item))
        : String(raw ?? '')
            .split(/[,;、\s]+/)
            .filter(Boolean);
      out.ipc = list;
      continue;
    }
    if (raw === null || raw === undefined) continue;
    (out as Record<string, unknown>)[target] = String(raw);
  }
  return out;
}

/** 从自由文本抽取归一前的字段。 */
export function fieldsFromText(text: string): RawPatentFields {
  const out: RawPatentFields = {};
  for (const [key, re] of Object.entries(TEXT_LABELS) as [
    keyof RawPatentFields,
    RegExp,
  ][]) {
    const match = re.exec(text);
    if (match?.[1]) out[key] = match[1].trim();
  }
  return out;
}

/** 判定两个字符串是否存在实词级别的字面交集（中文按 2 字窗口，英文按词）。 */
export function hasLiteralOverlap(a: string, b: string): boolean {
  const tokens = (text: string): string[] => {
    const clean = text.toLowerCase();
    const words = clean.match(/[a-z0-9]{2,}/g) ?? [];
    const cjk = clean.replace(/[^一-龥]/g, '');
    const grams: string[] = [];
    for (let i = 0; i + 2 <= cjk.length; i += 1)
      grams.push(cjk.slice(i, i + 2));
    return [...words, ...grams];
  };
  const left = new Set(tokens(a));
  return tokens(b).some((token) => left.has(token));
}

/**
 * 归一一条记录：接受 JSON 对象、JSON 字符串或自由文本。
 */
export function normalizePatentRecord(
  raw: unknown,
  options: { source?: string; query?: string | null } = {},
): PatentRecord {
  const source = options.source ?? 'pasted';
  let fields: RawPatentFields = {};
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        const target = Array.isArray(parsed) ? parsed[0] : parsed;
        if (target && typeof target === 'object') {
          fields = fieldsFromJsonObject(target as Record<string, unknown>);
        }
      } catch {
        fields = fieldsFromText(trimmed);
      }
    } else {
      fields = fieldsFromText(trimmed);
    }
  } else if (raw && typeof raw === 'object') {
    fields = fieldsFromJsonObject(raw as Record<string, unknown>);
  }

  const pubRaw = fields.publicationNumber ?? '';
  const pub = normalizePublicationNumber(pubRaw);
  const ipc = Array.isArray(fields.ipc)
    ? fields.ipc
    : String(fields.ipc ?? '')
        .split(/[,;、\s]+/)
        .filter(Boolean);
  const semanticNotes: string[] = [];
  const title = fields.title?.trim() || null;
  const abstract = fields.abstract?.trim() || null;
  if (!title && !abstract && ipc.length === 0) {
    semanticNotes.push(
      '记录只有片段文本、缺少名称与分类，无法做字面比对，需模型读全文复核',
    );
  } else if (options.query) {
    const corpus = `${title ?? ''} ${abstract ?? ''}`;
    if (corpus.trim() && !hasLiteralOverlap(options.query, corpus)) {
      semanticNotes.push(
        '与检索词无字面交集，可能是语义干扰项或术语差异，请人工/模型复核',
      );
    }
  }
  return {
    publicationNumber: pub.number,
    publicationKind: pub.kind,
    publicationKindCode: pub.kindCode,
    publicationNumberMatched: pub.matched,
    title,
    applicant: fields.applicant?.trim() || null,
    applicationDate: normalizeDate(fields.applicationDate),
    publicationDate: normalizeDate(fields.publicationDate),
    priorityDate: normalizeDate(fields.priorityDate),
    ipc,
    abstract,
    firstClaim: fields.firstClaim?.trim() || null,
    source: fields.source?.trim() || source,
    semanticNotes,
  };
}

/**
 * 计算日期档位（最小机械判定，不构成法律判断）：
 * - 对比文件申请日早于本申请申请日 → `prior-art`（可作有效对比文件）；
 * - 公开日早于但申请日不早于 → `needs-review`（需另判）；
 * - 申请日与公开日均不早于 → `later`（不可作对比文件）；
 * - 缺少必要日期 → `unknown`。
 */
export function computeDateTier(
  record: { applicationDate?: string | null; publicationDate?: string | null },
  applicantFilingDate: string | null,
): DateTierResult {
  const applicant = normalizeDate(applicantFilingDate);
  const application = normalizeDate(record.applicationDate);
  const publication = normalizeDate(record.publicationDate);
  const base = {
    recordApplicationDate: application,
    recordPublicationDate: publication,
    applicantFilingDate: applicant,
  };
  if (!applicant) {
    return {
      ...base,
      tier: 'unknown',
      label: '档位未知',
      basis: '未提供本申请申请日，无法比较先后',
    };
  }
  if (application && application < applicant) {
    return {
      ...base,
      tier: 'prior-art',
      label: '可作有效对比文件',
      basis: `对比文件申请日 ${application} 早于本申请申请日 ${applicant}`,
    };
  }
  if (publication && publication < applicant) {
    return {
      ...base,
      tier: 'needs-review',
      label: '需另判',
      basis: `对比文件公开日 ${publication} 早于本申请申请日 ${applicant}，但申请日 ${
        application ?? '缺失'
      } 未早于，尚不能直接作为有效对比文件`,
    };
  }
  if (application && publication) {
    return {
      ...base,
      tier: 'later',
      label: '不可作对比文件',
      basis: `对比文件申请日 ${application} 与公开日 ${publication} 均不早于本申请申请日 ${applicant}`,
    };
  }
  return {
    ...base,
    tier: 'unknown',
    label: '档位未知',
    basis: '对比文件缺少申请日或公开日，无法比较先后',
  };
}

/** 检索入参。 */
export type PatentSearchInput = {
  /** 查询词（用于字面干扰提示与检索指引）。 */
  query?: string | null;
  /** 精确公布号。 */
  publicationNumber?: string | null;
  /** 粘贴的原文或 JSON（多条用空行或换行分隔，或用 JSON 数组）。 */
  raw?: string | null;
  /** 结构化记录。 */
  records?: unknown[] | null;
  /** 本申请申请日（用于日期档位判定）。 */
  applicantFilingDate?: string | null;
  /** 数据来源标记。 */
  source?: string | null;
};

/**
 * 生成检索报告：归一记录 → 逐条算档位 → 汇总诊断与 markdown。
 */
export function buildPatentSearchReport(
  input: PatentSearchInput,
  extraIssues: PatentSearchIssue[] = [],
): PatentSearchReport {
  const issues: PatentSearchIssue[] = [...extraIssues];
  const applicantFilingDate = normalizeDate(input.applicantFilingDate);
  const query = input.query?.trim() || null;
  const source = input.source?.trim() || 'pasted';

  const rawItems: unknown[] = [];
  if (Array.isArray(input.records)) rawItems.push(...input.records);
  const rawText = input.raw?.trim();
  if (rawText) {
    if (rawText.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(rawText);
        if (Array.isArray(parsed)) rawItems.push(...parsed);
        else rawItems.push(parsed);
      } catch {
        issues.push({
          code: 'RAW_JSON_INVALID',
          severity: 'warning',
          message: 'raw 以 JSON 数组开头但解析失败，已按自由文本处理',
        });
        rawItems.push(rawText);
      }
    } else {
      rawItems.push(
        ...rawText.split(/\n\s*\n+/).filter((chunk) => chunk.trim()),
      );
    }
  }
  if (!rawItems.length && input.publicationNumber) {
    rawItems.push({
      publicationNumber: input.publicationNumber,
      title: null,
      applicant: null,
    });
  }
  if (!rawItems.length) {
    issues.push({
      code: 'NO_INPUT',
      severity: 'warning',
      message: '未提供任何检索结果（raw / records 均为空），仅输出检索指引',
    });
  }

  const records: PatentRecord[] = [];
  for (const item of rawItems) {
    const record = normalizePatentRecord(item, { source, query });
    if (!record.publicationNumber) {
      issues.push({
        code: 'PUBLICATION_NUMBER_MISSING',
        severity: 'warning',
        message: '一条记录未解析出公布号，已保留其余字段但无法定位',
      });
    }
    records.push(record);
  }

  const tiers = records.map((record) =>
    computeDateTier(record, applicantFilingDate),
  );
  const stats = {
    records: records.length,
    priorArt: tiers.filter((tier) => tier.tier === 'prior-art').length,
    needsReview: tiers.filter((tier) => tier.tier === 'needs-review').length,
    later: tiers.filter((tier) => tier.tier === 'later').length,
    unknown: tiers.filter((tier) => tier.tier === 'unknown').length,
    semanticFlags: records.filter((record) => record.semanticNotes.length > 0)
      .length,
  };
  const guidance = rawItems.length ? [] : [...SEARCH_GUIDANCE];

  const markdown = renderPatentSearchMarkdown(
    records,
    tiers,
    stats,
    guidance,
    issues,
  );
  return {
    applicantFilingDate,
    records,
    tiers,
    issues,
    stats,
    guidance,
    markdown,
    ok: !issues.some((issue) => issue.severity === 'error'),
  };
}

/** 渲染 markdown 表格。 */
export function renderPatentSearchMarkdown(
  records: PatentRecord[],
  tiers: DateTierResult[],
  stats: PatentSearchReport['stats'],
  guidance: string[],
  issues: PatentSearchIssue[],
): string {
  const lines: string[] = [];
  lines.push('# 专利检索结构化结果');
  lines.push('');
  lines.push(
    '> 判定口径：日期档位为**纯日期比较的最小机械判定**，不构成法律判断；「可作有效对比文件」仅指日期先后关系成立。',
  );
  lines.push('');
  lines.push(
    `统计：记录 ${stats.records} 条｜可作有效对比文件 ${stats.priorArt}｜需另判 ${stats.needsReview}｜不可作对比文件 ${stats.later}｜档位未知 ${stats.unknown}｜字面提示 ${stats.semanticFlags}`,
  );
  lines.push('');
  if (records.length) {
    lines.push(
      '| 公布号 | 名称 | 申请人 | 申请日 | 公开日 | 档位 | 判定依据 | 提示 |',
    );
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    records.forEach((record, index) => {
      const tier = tiers[index];
      const cells = [
        (record.publicationNumber || '—') +
          (record.publicationNumberMatched ? '' : '（格式可疑）'),
        record.title ?? '—',
        record.applicant ?? '—',
        record.applicationDate ?? '—',
        record.publicationDate ?? '—',
        tier ? `${tier.label}（${tier.tier}）` : '—',
        tier?.basis ?? '—',
        record.semanticNotes.length ? record.semanticNotes.join('；') : '—',
      ].map((cell) => cell.replace(/\|/g, '\\|').replace(/\n+/g, ' '));
      lines.push(`| ${cells.join(' | ')} |`);
    });
    lines.push('');
  }
  if (guidance.length) {
    lines.push('## 检索指引');
    lines.push('');
    for (const item of guidance) lines.push(item);
    lines.push('');
  }
  if (issues.length) {
    lines.push('## 诊断');
    lines.push('');
    for (const issue of issues) {
      lines.push(`- [${issue.severity}] ${issue.code}：${issue.message}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Google Patents XHR 兜底查询的返回形状。 */
export type OnlineSearchResult = {
  ok: boolean;
  url: string;
  records: PatentRecord[];
  error: string | null;
};

/**
 * 零凭据兜底：Google Patents 站点内部 JSON 端点（非官方，可能变更或限流）。
 * 失败只降级为诊断，不抛错。
 */
export async function fetchGooglePatents(
  query: string,
  options: { num?: number; timeoutMs?: number } = {},
): Promise<OnlineSearchResult> {
  const num = Math.min(Math.max(options.num ?? 5, 1), 20);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const inner = new URLSearchParams({ q: query, num: String(num) });
  const url = `https://patents.google.com/xhr/query?url=${encodeURIComponent(inner.toString())}`;
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent':
          'Mozilla/5.0 (compatible; dsh-patent; +https://github.com/lzhida/dsh-plugins-workspace)',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { ok: false, url, records: [], error: `HTTP ${response.status}` };
    }
    const payload = (await response.json()) as {
      results?: {
        cluster?: {
          result?: {
            patent?: Record<string, unknown>;
          }[];
        }[];
      };
    };
    const items =
      payload.results?.cluster?.flatMap((cluster) => cluster.result ?? []) ??
      [];
    const records = items
      .map((item) => item.patent)
      .filter((patent): patent is Record<string, unknown> => Boolean(patent))
      .map((patent) =>
        normalizePatentRecord(
          {
            publicationNumber: String(patent.publication_number ?? ''),
            title: String(patent.title ?? ''),
            applicant: String(patent.assignee ?? ''),
            applicationDate: String(patent.filing_date ?? ''),
            publicationDate: String(patent.publication_date ?? ''),
            priorityDate: String(patent.priority_date ?? ''),
            source: 'google-patents-xhr',
          },
          { source: 'google-patents-xhr', query },
        ),
      );
    return { ok: true, url, records, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, url, records: [], error: message };
  }
}
