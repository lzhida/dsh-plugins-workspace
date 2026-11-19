/**
 * 权项-说明书-源码三方对账引擎(纯函数,无 IO)。
 *
 * 工具与模型的分工(刻意收窄):源码核对需要模型实际读码,工具不读源码,
 * 只做「证据格式约束 + 覆盖完整性 + 结构化对账」——模型把逐特征的证据记录
 * (权项位置 / 特征原文 / 说明书位置 / 源码锚点 / 判定 / 建议)喂进来,工具
 * 负责:①证据强制(每条判定必须挂源码 文件:行号,挂不上证据的判定不得
 * 通过——与 patent-draft-review skill 的收敛纪律一致);②权项覆盖完整性
 * (每条权利要求至少一条记录);③载体归属矛盾检测(同一特征在权项与说明
 * 书被归到不同载体的告警);④退守防线评估(引用基准并列分支 + 从属链失实
 * 污染);⑤结构化对账矩阵(JSON + markdown);⑥从权项文本抽取六类维度的
 * 待核对清单(常量/路径/枚举/函数名/层级序/分支数)——清单是「该查什么」的
 * 线索,不是结论。
 *
 * 判定四态(对齐审查实战的对照表口径):
 * - supported    可主张——源码有真实实现,权项文字与代码行为一致;
 * - needs-rewrite 需改写——有实现但措辞与代码有出入,按建议改后可主张;
 * - unsupported  不可主张——源码无该实现或行为相反,主张即自曝破绽;
 * - uncovered    未覆盖——源码有实现但权项未记载(保护缺口,应补从属权)。
 */

import { parseClaims, type Claim } from './claims.ts';

/** 判定四态。 */
export const EVIDENCE_VERDICTS = [
  'supported',
  'needs-rewrite',
  'unsupported',
  'uncovered',
] as const;
export type EvidenceVerdict = (typeof EVIDENCE_VERDICTS)[number];

/** 严重度分级(沿用 patent-draft-review skill 的五级口径)。 */
export const EVIDENCE_SEVERITIES = [
  'critical',
  'high',
  'medium',
  'low',
  'suggestion',
] as const;
export type EvidenceSeverity = (typeof EVIDENCE_SEVERITIES)[number];

const SEVERITY_RANK: Record<EvidenceSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  suggestion: 0,
};

/** 模型提交的单条证据记录(宽松输入,逐条校验)。 */
export type EvidenceEntryInput = {
  claimNo?: unknown;
  feature?: unknown;
  docRef?: unknown;
  sourceAnchors?: unknown;
  verdict?: unknown;
  severity?: unknown;
  claimCarrier?: unknown;
  docCarrier?: unknown;
  suggestion?: unknown;
};

/** 通过校验的证据记录。 */
export type EvidenceEntry = {
  /** 关联权利要求编号;null = 不挂具体权项(通常是「未覆盖」源码资产)。 */
  claimNo: number | null;
  /** 特征原文(权项文字,或未覆盖时的源码资产描述)。 */
  feature: string;
  /** 说明书位置(如「三、第 2 段」);缺失为 null。 */
  docRef: string | null;
  /** 源码锚点(文件:行号,可带范围);证据强制,恒非空。 */
  sourceAnchors: string[];
  verdict: EvidenceVerdict;
  severity: EvidenceSeverity;
  /** 权项侧载体归属(如「协议描述文件」);缺失为 null。 */
  claimCarrier: string | null;
  /** 说明书侧载体归属;与 claimCarrier 不一致即矛盾告警。 */
  docCarrier: string | null;
  /** 改写/补权建议;缺失为 null。 */
  suggestion: string | null;
};

/** 对账诊断(结构与证据问题)。 */
export type ClaimsEvidenceIssue = {
  code: string;
  severity: 'error' | 'warning';
  /** 关联权利要求编号;全局问题为 null。 */
  claimNo: number | null;
  message: string;
};

/** 每条权利要求的判定汇总。 */
export type MatrixRow = {
  claimNo: number;
  total: number;
  supported: number;
  needsRewrite: number;
  unsupported: number;
};

/** 退守防线风险:一条从属链上存在失实/待改写特征。 */
export type FallbackRisk = {
  /** 链路(从属权项 → … → 独立权项)。 */
  chain: number[];
  /** 链上携带 unsupported / needs-rewrite 记录的权项。 */
  poisonedBy: number[];
  verdicts: EvidenceVerdict[];
};

/** 源码核对维度(工具只给清单与证据格式约束,不替模型读码断言)。 */
export const CHECKLIST_DIMENSIONS = [
  'constant',
  'path',
  'enum',
  'function',
  'hierarchy',
  'branch',
] as const;

export type ChecklistDimension = (typeof CHECKLIST_DIMENSIONS)[number];

/** 一条待核对清单项(按维度聚合,列出线索样本与相关权项)。 */
export type ChecklistItem = {
  dimension: ChecklistDimension;
  /** 维度中文名。 */
  label: string;
  /** 命中该维度的权项号。 */
  claimNos: number[];
  /** 线索样本(最多 8 条)。 */
  samples: string[];
  /** 核对指引。 */
  hint: string;
};

/** 对账报告。 */
export type ClaimsEvidenceReport = {
  /** 结构与证据问题(证据缺失/覆盖缺口/载体矛盾/严重度不一致)。 */
  issues: ClaimsEvidenceIssue[];
  /** 待核对清单:按六类维度从权项文本抽出的源码核对线索(工具不读码,清单供模型逐项核查)。 */
  checklist: ChecklistItem[];
  /** 通过校验的记录(按权项升序,权项外记录排最后)。 */
  entries: EvidenceEntry[];
  /** 每条权项的判定汇总(只列有记录的权项)。 */
  matrix: MatrixRow[];
  /** 未覆盖清单(verdict=uncovered):源码有实现但权项未记载。 */
  uncovered: EvidenceEntry[];
  /** 退守防线评估。 */
  fallback: {
    /** 引用基准形成并列分支的权项(被 ≥2 项引用)。 */
    branches: { claimNo: number; referencedBy: number[] }[];
    /** 从属链失实污染风险。 */
    risks: FallbackRisk[];
  };
  stats: {
    /** 解析出的权利要求数。 */
    claims: number;
    /** 通过校验的记录数。 */
    entries: number;
    /** 因证据/格式问题被拒的记录数。 */
    rejected: number;
    /** 未覆盖资产数。 */
    uncoveredCount: number;
  };
  ok: boolean;
  /** markdown 对账矩阵(可直接作为修改清单)。 */
  markdown: string;
};

/** 源码锚点格式:必须以「:行号」或「:起-止」结尾(如 command.ts:1010-1020)。 */
const ANCHOR_RE = /:\d+(?:[-–]\d+)?$/;

/** 判定四态的中文标签与图标(对齐审查对照表口径)。 */
const VERDICT_LABEL: Record<EvidenceVerdict, string> = {
  supported: '✅ 可主张',
  'needs-rewrite': '⚠️ 需改写',
  unsupported: '❌ 不可主张',
  uncovered: '⬜ 未覆盖',
};

/** 各维度的核对指引(工具不读码,清单只提示「该查什么」)。 */
const DIMENSION_META: Record<
  ChecklistDimension,
  { label: string; hint: string }
> = {
  constant: {
    label: '常量',
    hint: '核对每个常量/阈值在源码中的定义与取值是否与权项一致(挂定义处 文件:行号)。',
  },
  path: {
    label: '路径',
    hint: '核对每个文件/目录/配置路径在源码中确实存在且可访问。',
  },
  enum: {
    label: '枚举',
    hint: '核对枚举/取值集合的成员是否与权项列举一致(有无遗漏或新增成员)。',
  },
  function: {
    label: '函数名',
    hint: '核对每个函数/接口名在源码中的真实签名与调用关系。',
  },
  hierarchy: {
    label: '层级序',
    hint: '核对层级/步骤顺序约束在实现中是否真实存在(不得臆造层序)。',
  },
  branch: {
    label: '分支数',
    hint: '核对分支/条件/阈值数量与触发条件是否与实现一致。',
  },
};

/** 每个维度最多列出的线索样本数。 */
const CHECKLIST_SAMPLE_LIMIT = 8;

/** 从一条权项文本抽取各维度的线索样本(启发式,只给线索不给结论)。 */
function claimChecklistHints(text: string): {
  dimension: ChecklistDimension;
  samples: string[];
}[] {
  const hints: { dimension: ChecklistDimension; samples: string[] }[] = [];
  const push = (dimension: ChecklistDimension, samples: string[]) => {
    if (samples.length > 0) hints.push({ dimension, samples });
  };
  push('constant', [...new Set(text.match(/[A-Z][A-Z0-9_]{2,}/g) ?? [])]);
  push('path', [
    ...new Set([
      ...(text.match(/[A-Za-z0-9_.-]*\/[A-Za-z0-9_./-]+/g) ?? []),
      ...(text.match(
        /\b[\w.-]+\.(?:ts|tsx|js|jsx|py|json|ya?ml|md|sql|go|rs|java|c|h|cpp|sh)\b/g,
      ) ?? []),
    ]),
  ]);
  push('function', [
    ...new Set(
      (text.match(/\b[A-Za-z_][\w.]*\s*\(/g) ?? []).map((sample) =>
        sample.replace(/\s*\($/, '').trim(),
      ),
    ),
  ]);
  if (
    /(枚举|取值(?:集合|范围)?|状态(?:机|值)|标志位|类型码|字段值)/.test(text)
  ) {
    push('enum', ['(权项含枚举/取值集合表述)']);
  }
  if (
    /(层级|层次|第[一二三四五六七八九十0-9](?:层|阶段|步)|步骤[一二三四五六七八九十0-9]|父(?:级|节点)|子(?:模块|节点)|嵌套)/.test(
      text,
    )
  ) {
    push('hierarchy', ['(权项含层级/步骤顺序表述)']);
  }
  if (/(分支|判据|阈值|超过|低于|大于|小于|选择|判断|条件为)/.test(text)) {
    push('branch', ['(权项含分支/条件/阈值表述)']);
  }
  return hints;
}

/**
 * 从权项文本抽取六类维度的待核对清单(常量/路径/枚举/函数名/层级序/分支数)。
 *
 * 这是「工具给清单、模型读码」分工的那一半:清单只是线索,不代表任何判定;
 * 模型按线索逐项读源码后,才把带 文件:行号 锚点的证据记录喂回来。
 */
export function extractChecklist(claims: Claim[]): ChecklistItem[] {
  const buckets = new Map<
    ChecklistDimension,
    { claimNos: number[]; samples: string[] }
  >();
  for (const claim of claims) {
    for (const hint of claimChecklistHints(claim.text)) {
      const bucket = buckets.get(hint.dimension) ?? {
        claimNos: [],
        samples: [],
      };
      if (!bucket.claimNos.includes(claim.number)) {
        bucket.claimNos.push(claim.number);
      }
      for (const sample of hint.samples) {
        if (bucket.samples.length >= CHECKLIST_SAMPLE_LIMIT) break;
        if (!bucket.samples.includes(sample)) bucket.samples.push(sample);
      }
      buckets.set(hint.dimension, bucket);
    }
  }
  return CHECKLIST_DIMENSIONS.filter((dimension) => buckets.has(dimension)).map(
    (dimension) => {
      const bucket = buckets.get(dimension)!;
      return {
        dimension,
        label: DIMENSION_META[dimension].label,
        claimNos: bucket.claimNos,
        samples: bucket.samples,
        hint: DIMENSION_META[dimension].hint,
      };
    },
  );
}

/** 归一化载体名:去空白、去「所述的/所述/该」前缀、去尾「的」。 */
function normalizeCarrier(value: string): string {
  return value
    .replace(/\s+/g, '')
    .replace(/^(?:所述的|所述|该)/, '')
    .replace(/的$/, '');
}

/** 七部分标题关键词(宽松匹配,兼容 markdown 标题与 docx 提取的裸文本)。 */
const SECTION_KEYWORDS = [
  '一、背景技术',
  '二、背景技术的技术问题',
  '三、',
  '四、',
  '五、',
  '六、',
  '七、',
] as const;

/**
 * 宽松七部分结构检测:逐行找「一、背景技术」…「七、」关键词(带不带
 * markdown井号都认)。只用于提醒「输入不是标准七部分交底书」,不参与判定。
 */
function missingSections(document: string): string[] {
  const lines = document
    .split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s*/, '').trim());
  return SECTION_KEYWORDS.filter((keyword) => {
    // 纯序号关键词(「三、」)须前缀匹配避免误命中正文;全称关键词包含即可。
    const hit =
      keyword.length <= 2
        ? lines.some((line) => line.startsWith(keyword))
        : lines.some((line) => line.includes(keyword));
    return !hit;
  });
}

/** 校验并归一单条证据记录;返回 [entry, issue|null]。 */
function normalizeEntry(
  raw: EvidenceEntryInput,
  index: number,
): [EvidenceEntry | null, ClaimsEvidenceIssue | null] {
  const label = `entries[${index}]`;
  const feature = typeof raw.feature === 'string' ? raw.feature.trim() : '';
  if (feature.length === 0) {
    return [
      null,
      {
        code: 'ENTRY_INVALID',
        severity: 'error',
        claimNo: null,
        message: `${label}.feature 缺失或非文本:每条记录必须给出特征原文(权项文字或源码资产描述)。`,
      },
    ];
  }
  const verdict = EVIDENCE_VERDICTS.find((v) => v === raw.verdict);
  if (!verdict) {
    return [
      null,
      {
        code: 'ENTRY_INVALID',
        severity: 'error',
        claimNo: null,
        message: `${label}.verdict 非法(「${String(raw.verdict)}」):只能是 ${EVIDENCE_VERDICTS.join(' / ')}。`,
      },
    ];
  }
  const severity = EVIDENCE_SEVERITIES.find((s) => s === raw.severity);
  if (!severity) {
    return [
      null,
      {
        code: 'ENTRY_INVALID',
        severity: 'error',
        claimNo: null,
        message: `${label}.severity 非法:只能是 ${EVIDENCE_SEVERITIES.join(' / ')}。`,
      },
    ];
  }
  // 证据强制:无源码 文件:行号 的判定不得通过(收敛纪律)。
  const anchors = Array.isArray(raw.sourceAnchors)
    ? raw.sourceAnchors.filter((a): a is string => typeof a === 'string')
    : [];
  if (anchors.length === 0) {
    return [
      null,
      {
        code: 'EVIDENCE_MISSING',
        severity: 'error',
        claimNo: null,
        message: `${label}(「${feature.slice(0, 24)}…」)未携带源码锚点:证据强制——挂不上 文件:行号 的判定不得输出,请先读码取证。`,
      },
    ];
  }
  const bad = anchors.filter((a) => !ANCHOR_RE.test(a.trim()));
  if (bad.length > 0) {
    return [
      null,
      {
        code: 'EVIDENCE_MISSING',
        severity: 'error',
        claimNo: null,
        message: `${label} 的源码锚点格式非法(${bad.join('、')}):必须形如 文件:行号 或 文件:起-止(如 command.ts:1010-1020)。`,
      },
    ];
  }
  const claimNo =
    typeof raw.claimNo === 'number' &&
    Number.isInteger(raw.claimNo) &&
    raw.claimNo > 0
      ? raw.claimNo
      : null;
  const docRef =
    typeof raw.docRef === 'string' && raw.docRef.trim().length > 0
      ? raw.docRef.trim()
      : null;
  const claimCarrier =
    typeof raw.claimCarrier === 'string' && raw.claimCarrier.trim().length > 0
      ? raw.claimCarrier.trim()
      : null;
  const docCarrier =
    typeof raw.docCarrier === 'string' && raw.docCarrier.trim().length > 0
      ? raw.docCarrier.trim()
      : null;
  const suggestion =
    typeof raw.suggestion === 'string' && raw.suggestion.trim().length > 0
      ? raw.suggestion.trim()
      : null;
  return [
    {
      claimNo,
      feature,
      docRef,
      sourceAnchors: anchors.map((a) => a.trim()),
      verdict,
      severity,
      claimCarrier,
      docCarrier,
      suggestion,
    },
    null,
  ];
}

/** 渲染 markdown 对账矩阵(含未覆盖清单与风险汇总)。 */
function renderMarkdown(
  report: Omit<ClaimsEvidenceReport, 'markdown'>,
): string {
  const lines: string[] = [];
  if (report.checklist.length > 0) {
    lines.push('## 待核对清单(工具不读码,请按清单逐项读源码核对)', '');
    for (const item of report.checklist) {
      lines.push(
        `- **${item.label}**(权 ${item.claimNos.join('、')})${
          item.samples.length > 0 ? `:\`${item.samples.join('`、`')}\`` : ''
        }——${item.hint}`,
      );
    }
    lines.push('');
  }
  lines.push(
    '## 权项-说明书-源码对账矩阵',
    '',
    '| 权项 | 特征 | 说明书位置 | 源码锚点 | 判定 | 严重度 | 建议 |',
    '|---|---|---|---|---|---|---|',
  );
  for (const entry of report.entries) {
    lines.push(
      `| ${entry.claimNo ?? '—'} | ${entry.feature.replace(/\|/g, '\\|')} | ${(entry.docRef ?? '—').replace(/\|/g, '\\|')} | ${entry.sourceAnchors.map((a) => `\`${a}\``).join('<br>')} | ${VERDICT_LABEL[entry.verdict]} | ${entry.severity} | ${entry.suggestion?.replace(/\|/g, '\\|') ?? '—'} |`,
    );
  }
  if (report.uncovered.length > 0) {
    lines.push('', '## 未覆盖资产(保护缺口,建议补从属权)', '');
    for (const entry of report.uncovered) {
      lines.push(
        `- ${entry.feature}(\`${entry.sourceAnchors.join('`、`')}\`)${entry.suggestion ? `——${entry.suggestion}` : ''}`,
      );
    }
  }
  if (report.fallback.risks.length > 0) {
    lines.push('', '## 退守防线风险(纸上可退、实战不可守的从属链)', '');
    for (const risk of report.fallback.risks) {
      lines.push(
        `- 引用闭包 ${risk.chain.join('/')}(编号降序;多项从属时为引用闭包而非单一路径):被权 ${risk.poisonedBy.join('、权 ')} 的 ${risk.verdicts.join('/')} 特征污染,退守时该特征同样不成立`,
      );
    }
  }
  return lines.join('\n');
}

/** 主入口:解析权项 + 归一证据 + 四类检查 + 对账矩阵。 */
export function checkClaimsEvidence(input: {
  claims: string;
  entries: unknown;
  document?: string;
}): ClaimsEvidenceReport {
  const issues: ClaimsEvidenceIssue[] = [];
  const claims = parseClaims(input.claims);

  // 0. 权项解析为空:多为「忘传权项 / 编号格式不对」,静默通过会掩盖输入错误。
  if (claims.length === 0) {
    issues.push({
      code: 'CLAIMS_EMPTY',
      severity: 'warning',
      claimNo: null,
      message:
        '未从 claims 解析出任何权利要求:请确认权项按「N. …」逐行编号传入,否则对账矩阵与覆盖检查会静默为空。',
    });
  }

  // 1. 证据记录归一(逐条校验,非法条目拒绝并计数)。
  const rawEntries = Array.isArray(input.entries)
    ? (input.entries as EvidenceEntryInput[])
    : [];
  if (!Array.isArray(input.entries)) {
    issues.push({
      code: 'ENTRIES_INVALID',
      severity: 'error',
      claimNo: null,
      message:
        'entries 必须是证据记录数组(每条:claimNo/feature/docRef/sourceAnchors/verdict/severity/…)。',
    });
  }
  const entries: EvidenceEntry[] = [];
  let rejected = 0;
  for (let i = 0; i < rawEntries.length; i++) {
    const [entry, issue] = normalizeEntry(rawEntries[i]!, i);
    if (entry) entries.push(entry);
    else {
      rejected += 1;
      if (issue) issues.push(issue);
    }
  }

  // 2. 说明书七部分结构提醒(宽松;docx 提取文本同样适用)。
  if (typeof input.document === 'string' && input.document.length > 0) {
    const missing = missingSections(input.document);
    if (missing.length > 0) {
      issues.push({
        code: 'DOCUMENT_STRUCTURE',
        severity: 'warning',
        claimNo: null,
        message: `输入文档未检出标准七部分标题(${missing.join('、')}):若为 docx 提取文本请确认标题未被拆行,否则 docRef 定位将不可靠。`,
      });
    }
  }

  // 3. 载体归属矛盾:同一特征在权项与说明书归到不同载体(初稿三说矛盾的形态)。
  for (const entry of entries) {
    if (entry.claimCarrier && entry.docCarrier) {
      if (
        normalizeCarrier(entry.claimCarrier) !==
        normalizeCarrier(entry.docCarrier)
      ) {
        issues.push({
          code: 'CARRIER_MISMATCH',
          severity: 'warning',
          claimNo: entry.claimNo,
          message: `特征「${entry.feature.slice(0, 24)}…」的载体归属矛盾:权项侧记为「${entry.claimCarrier}」,说明书侧记为「${entry.docCarrier}」——同一技术特征被归到不同载体是立论失实的核心形态,请核对源码事实并统一表述。`,
        });
      }
    }
  }

  // 4. 严重度一致性:「不可主张」是维权反制风险,不得低于 high。
  for (const entry of entries) {
    if (
      entry.verdict === 'unsupported' &&
      SEVERITY_RANK[entry.severity] < SEVERITY_RANK.high
    ) {
      issues.push({
        code: 'SEVERITY_MISMATCH',
        severity: 'warning',
        claimNo: entry.claimNo,
        message: `特征「${entry.feature.slice(0, 24)}…」判定为不可主张但严重度仅 ${entry.severity}:源码无落点或行为相反的主张即自曝破绽,严重度应不低于 high(叙事支柱类应为 critical)。`,
      });
    }
  }

  // 5. 覆盖完整性:每条权利要求至少一条记录(无记录=尚未核对,不是「无风险」)。
  for (const claim of claims) {
    const hits = entries.filter((entry) => entry.claimNo === claim.number);
    if (hits.length === 0) {
      issues.push({
        code: 'CLAIM_NO_EVIDENCE',
        severity: 'warning',
        claimNo: claim.number,
        message: `权利要求 ${claim.number} 无任何证据记录:尚未核对不等于没有风险,请读码补齐该权项的特征判定。`,
      });
    }
  }

  // 6. 按权项汇总判定矩阵(有记录的权项,升序)。
  const byClaim = new Map<number, EvidenceEntry[]>();
  for (const entry of entries) {
    if (entry.claimNo === null) continue;
    const list = byClaim.get(entry.claimNo) ?? [];
    list.push(entry);
    byClaim.set(entry.claimNo, list);
  }
  const matrix: MatrixRow[] = [...byClaim.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([claimNo, list]) => ({
      claimNo,
      total: list.length,
      supported: list.filter((e) => e.verdict === 'supported').length,
      needsRewrite: list.filter((e) => e.verdict === 'needs-rewrite').length,
      unsupported: list.filter((e) => e.verdict === 'unsupported').length,
    }));

  // 7. 未覆盖清单(verdict=uncovered)。约定:uncovered 记录应挂 claimNo=null
  //    (挂到具体权项下会同时计入该权项的覆盖与矩阵统计,口径以矩阵为准)。
  const uncovered = entries.filter((entry) => entry.verdict === 'uncovered');

  // 8. 退守防线评估:引用基准并列分支 + 从属链失实污染。
  const referencedBy = new Map<number, number[]>();
  for (const claim of claims) {
    for (const ref of claim.references) {
      const list = referencedBy.get(ref) ?? [];
      list.push(claim.number);
      referencedBy.set(ref, list);
    }
  }
  const branches = [...referencedBy.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([claimNo, list]) => ({
      claimNo,
      referencedBy: [...new Set(list)].sort((a, b) => a - b),
    }));
  const risks: FallbackRisk[] = [];
  for (const claim of claims) {
    if (claim.references.length === 0) continue;
    // 沿引用向上收集祖先链(BFS;visited 防环)。
    const chain: number[] = [];
    const visited = new Set<number>();
    let frontier = [claim.number];
    while (frontier.length > 0) {
      const next: number[] = [];
      for (const no of frontier) {
        if (visited.has(no)) continue;
        visited.add(no);
        chain.push(no);
        const target = claims.find((c) => c.number === no);
        for (const ref of target?.references ?? []) next.push(ref);
      }
      frontier = next;
    }
    const sources = new Set<EvidenceVerdict>();
    const poisonedBy: number[] = [];
    for (const no of chain) {
      const hits = (byClaim.get(no) ?? []).filter(
        (e) => e.verdict === 'unsupported' || e.verdict === 'needs-rewrite',
      );
      if (hits.length > 0) poisonedBy.push(no);
      for (const e of hits) sources.add(e.verdict);
    }
    if (poisonedBy.length > 0) {
      risks.push({
        // 链按「从属 → 独立」呈现(编号降序)。
        chain: [...chain].sort((a, b) => b - a),
        poisonedBy: poisonedBy.sort((a, b) => a - b),
        verdicts: [...sources],
      });
    }
  }

  const base = {
    issues,
    checklist: extractChecklist(claims),
    entries,
    matrix,
    uncovered,
    fallback: { branches, risks },
    stats: {
      claims: claims.length,
      entries: entries.length,
      rejected,
      uncoveredCount: uncovered.length,
    },
    ok: !issues.some((issue) => issue.severity === 'error'),
  };
  return { ...base, markdown: renderMarkdown(base) };
}
