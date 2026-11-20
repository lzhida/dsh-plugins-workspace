/**
 * 权项特征 ↔ 源码锚点映射台账（出海维权取证底稿）。
 *
 * 与 claims_evidence_check（2/5）的关系：**判定核心完全复用**——四态
 * 判定、证据强制（无 文件:行号 锚点不得通过）、载体矛盾、严重度一致
 * 与从属链失实传导都由 2/5 的 checkClaimsEvidence 得出；本模块只做
 * **呈现与再组织**：把同一批判定重排成维权取证视角的台账。
 *
 * 边界（卡面要求）：
 * - 本模块不做 FTO / 侵权比对分析、不做对比文件检索、不代拟权项文字；
 *   结论由律师判断。
 * - 源码锚点会随代码演进而漂移：输出标注锚点生成时间并提示复核。
 * - 「我方是否实施」自检是**技术事实核对结果**，不是法律意见，输出中
 *   显著标注。
 */

import {
  checkClaimsEvidence,
  VERDICT_LABEL,
  type ClaimsEvidenceIssue,
  type ClaimsEvidenceReport,
  type EvidenceEntry,
  type EvidenceSeverity,
  type EvidenceVerdict,
} from './claims-evidence.ts';
import { parseClaims } from './claims.ts';
import { listSourceFiles, readTextFile } from './draft-review.ts';

/** 单一载体但锚点横跨多个文件时的「资产规模与权项表述不匹配」提示阈值。 */
export const DUAL_CARRIER_MIN_FILES = 5;

/** 台账行（一个权项技术特征一行）。 */
export type CodeMapRow = {
  /** 权项编号；未挂权项的源码资产为 null。 */
  claimNo: number | null;
  /** 权项位置：如「权利要求 1 · 步骤 3」；未逐字命中则退到整条权项。 */
  claimPosition: string;
  /** 特征原文。 */
  feature: string;
  /** 说明书位置（docRef）；缺失为 null。 */
  docRef: string | null;
  /** 源码锚点（文件:行号）。 */
  sourceAnchors: string[];
  /** 锚点涉及的文件（去重）。 */
  anchorFiles: string[];
  /** 四态判定。 */
  verdict: EvidenceVerdict;
  /** 四态中文标签（复用 2/5）。 */
  verdictLabel: string;
  /** 严重度。 */
  severity: EvidenceSeverity;
  /** 建议（模型给出）；缺失为 null。 */
  suggestion: string | null;
  /** 我方自有实现是否覆盖该特征；未标注为 null。 */
  implementedByUs: boolean | null;
  /** 是否为组合特征（多要素组合）。 */
  combination: boolean;
  /** 组合特征的检索风险评估；未评估为 null。 */
  searchRisk: 'low' | 'medium' | 'high' | null;
};

/** 风险专章（不可主张 / 未覆盖各一章）。 */
export type CodeMapRiskChapter = {
  code: 'UNSUPPORTED' | 'UNCOVERED';
  title: string;
  intro: string;
  rows: CodeMapRow[];
};

/** 代码侧资产台账条目：源码有实现、权项无保护点。 */
export type CodeMapAssetEntry = {
  feature: string;
  sourceAnchors: string[];
  /** 建议的权项落点形态（工具不代拟权项文字）。 */
  suggestedPlacement: string;
};

/** 「我方是否实施该权项」自检行。 */
export type CodeMapSelfCheckRow = {
  claimNo: number | null;
  feature: string;
  /** 已覆盖 true / 未覆盖 false / 未标注 null。 */
  covered: boolean | null;
  /** 暴露面说明；未覆盖时非 null。 */
  exposure: string | null;
};

/** 答辩锚点（组合特征 + 检索未见直接对应）。 */
export type CodeMapAnswerAnchor = {
  claimNo: number | null;
  feature: string;
  searchRisk: 'low' | 'medium' | 'high' | null;
  /** 检索风险评估位说明。 */
  assessment: string;
  sourceAnchors: string[];
};

/** 双载体特征提示行。 */
export type CodeMapDualCarrier = {
  claimNo: number | null;
  feature: string;
  /**
   * 提示类别:
   * - multi-carrier:同一特征在多处主张(载体表述重复);
   * - scale-mismatch:单条锚点横跨多个文件(资产规模与权项表述不匹配);
   * - carrier-mismatch:权项载体与说明书载体不一致(由 2/5 的
   *   CARRIER_MISMATCH 诊断给出,此处保留类型以备后续直接呈现)。
   */
  kind: 'carrier-mismatch' | 'multi-carrier' | 'scale-mismatch';
  carriers: string[];
  anchorFileCount: number;
  note: string;
};

/** 映射台账报告。 */
export type ClaimsCodeMapReport = {
  /** 锚点生成时间（ISO 字符串）；取证前请复核。 */
  generatedAt: string;
  /** 免责声明（技术事实核对，非法律意见）。 */
  disclaimer: string;
  /** 全部映射行（按权项编号升序，未挂权项在后）。 */
  rows: CodeMapRow[];
  /** 四态分区。 */
  sections: {
    supported: CodeMapRow[];
    needsRewrite: CodeMapRow[];
    unsupported: CodeMapRow[];
    uncovered: CodeMapRow[];
  };
  /** 两张风险专章。 */
  risks: {
    counterExposure: CodeMapRiskChapter;
    protectionGap: CodeMapRiskChapter;
  };
  /** 代码侧资产台账。 */
  assetLedger: CodeMapAssetEntry[];
  /** 答辩锚点。 */
  answerAnchors: CodeMapAnswerAnchor[];
  /** 组合特征但不可作答辩锚点的行（判定非 supported）。 */
  answerAnchorBlocked: CodeMapRow[];
  /** 「我方是否实施」自检。 */
  selfCheck: CodeMapSelfCheckRow[];
  /** 双载体特征提示。 */
  dualCarrier: CodeMapDualCarrier[];
  /** 从属链失实传导（复用 2/5 的退守防线评估）。 */
  fallbackRisks: ClaimsEvidenceReport['fallback']['risks'];
  /** 源码根目录下的文件清单（只列清单，工具不读码）。 */
  sourceInventory: string[];
  /** 2/5 的诊断与本模块追加的诊断。 */
  issues: ClaimsEvidenceIssue[];
  stats: {
    claims: number;
    rows: number;
    rejected: number;
    supported: number;
    needsRewrite: number;
    unsupported: number;
    uncovered: number;
    sourceFiles: number;
  };
  ok: boolean;
  markdown: string;
};

/** 归一化：去掉空白与标点，用于特征定位。 */
function normalizeForLocate(text: string): string {
  return text
    .replace(/[\s\u3000]/g, '')
    .replace(
      /[，,。.、；;：:！!？?（）()【】\u005B\u005D「」《》〈〉"'“”‘’\-—_]/g,
      '',
    );
}

/** 权项正文按分号切步骤（映射粒度：技术特征可拆到分号级步骤）。 */
function splitClaimSteps(text: string): string[] {
  return text
    .split(/[;；]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * 定位特征在权项中的位置；未逐字命中返回 null。
 *
 * 优先精确包含（步骤文本包含特征原文）；精确未命中时退到宽松匹配
 * （特征原文包含步骤文本，可能是特征是步骤的缩写），宽松命中会带
 * `heuristic` 标记，由呈现层加「(启发式定位)」弱标注——避免长特征被
 * 短前置步骤抢先命中后被当成逐字定位。
 */
function locateFeature(
  claimText: string,
  feature: string,
): { step: number; total: number; heuristic: boolean } | null {
  const steps = splitClaimSteps(claimText);
  if (steps.length === 0) return null;
  const needle = normalizeForLocate(feature);
  if (needle.length === 0) return null;
  for (let i = 0; i < steps.length; i++) {
    const hay = normalizeForLocate(steps[i]!);
    if (hay.length === 0) continue;
    if (hay.includes(needle)) {
      return { step: i + 1, total: steps.length, heuristic: false };
    }
  }
  for (let i = 0; i < steps.length; i++) {
    const hay = normalizeForLocate(steps[i]!);
    if (hay.length === 0) continue;
    if (needle.includes(hay)) {
      return { step: i + 1, total: steps.length, heuristic: true };
    }
  }
  return null;
}

/** 锚点里的文件名（去掉 :行号 后缀）。 */
function anchorFile(anchor: string): string {
  const idx = anchor.lastIndexOf(':');
  return idx > 0 ? anchor.slice(0, idx) : anchor;
}

/** 组装台账行。 */
function toRow(
  entry: EvidenceEntry,
  claimText: string | undefined,
): CodeMapRow {
  const anchorFiles = [...new Set(entry.sourceAnchors.map(anchorFile))];
  let claimPosition: string;
  if (entry.claimNo === null) {
    claimPosition = '未挂权项（源码资产）';
  } else if (claimText === undefined) {
    claimPosition = `权利要求 ${entry.claimNo}`;
  } else {
    const located = locateFeature(claimText, entry.feature);
    claimPosition =
      located === null
        ? `权利要求 ${entry.claimNo}（特征原文未逐字落在权项内）`
        : located.heuristic
          ? `权利要求 ${entry.claimNo} · 步骤 ${located.step}/${located.total}（启发式定位）`
          : `权利要求 ${entry.claimNo} · 步骤 ${located.step}/${located.total}`;
  }
  return {
    claimNo: entry.claimNo,
    claimPosition,
    feature: entry.feature,
    docRef: entry.docRef,
    sourceAnchors: entry.sourceAnchors,
    anchorFiles,
    verdict: entry.verdict,
    verdictLabel: VERDICT_LABEL[entry.verdict],
    severity: entry.severity,
    suggestion: entry.suggestion,
    implementedByUs: entry.implementedByUs,
    combination: entry.combination,
    searchRisk: entry.searchRisk,
  };
}

/** 单元格转义（markdown 表格）。 */
function cell(text: string | null): string {
  if (text === null) return '—';
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** 建议的权项落点形态（工具不代拟权项文字）。 */
const DEFAULT_PLACEMENT =
  '建议补充为独立或从属权利要求中的技术特征（工具不代拟权项文字，由律师定稿）';

/** 组装「我方是否实施」自检行。 */
function toSelfCheck(row: CodeMapRow): CodeMapSelfCheckRow {
  if (row.implementedByUs === true) {
    return {
      claimNo: row.claimNo,
      feature: row.feature,
      covered: true,
      exposure: null,
    };
  }
  if (row.implementedByUs === false) {
    return {
      claimNo: row.claimNo,
      feature: row.feature,
      covered: false,
      exposure:
        '我方自有实现未覆盖该特征：主张该特征在维权中缺少实施证据，存在无效宣告与反制暴露面',
    };
  }
  return {
    claimNo: row.claimNo,
    feature: row.feature,
    covered: null,
    exposure: null,
  };
}

/** 检索风险评估位说明。 */
function assessmentText(risk: 'low' | 'medium' | 'high' | null): string {
  if (risk === 'low') return '检索风险低（未见直接对应，适合作答辩锚点）';
  if (risk === 'medium') return '检索风险中（需人工确认区别技术特征）';
  if (risk === 'high') return '检索风险高（现有技术易命中，不宜作答辩锚点）';
  return '待评估（模型未给出检索风险，需检索后回填）';
}

/** 双载体特征提示。 */
function collectDualCarrier(rows: CodeMapRow[]): CodeMapDualCarrier[] {
  const out: CodeMapDualCarrier[] = [];
  // 同一特征在多个载体上被主张（方法权 / 设备权 / 介质权并列）。
  const byFeature = new Map<string, CodeMapRow[]>();
  for (const row of rows) {
    const key = normalizeForLocate(row.feature);
    if (key.length === 0) continue;
    const list = byFeature.get(key) ?? [];
    list.push(row);
    byFeature.set(key, list);
  }
  for (const group of byFeature.values()) {
    if (group.length < 2) continue;
    const carriers = [
      ...new Set(
        group.flatMap((row) =>
          row.docRef === null ? [] : [`说明书:${row.docRef}`],
        ),
      ),
    ];
    const fileCount = new Set(group.flatMap((row) => row.anchorFiles)).size;
    out.push({
      claimNo: group[0]?.claimNo ?? null,
      feature: group[0]?.feature ?? '',
      kind: 'multi-carrier',
      carriers,
      anchorFileCount: fileCount,
      note: '同一技术特征在多处被主张（双载体并列）：若其中仅部分载体有源码落点，另一载体上的主张在维权中缺少实施证据，可能构成自曝',
    });
  }
  return out;
}

/** 渲染 markdown 台账（对齐出海维权证据链对照表的形态）。 */
function renderMarkdown(report: Omit<ClaimsCodeMapReport, 'markdown'>): string {
  const lines: string[] = [];
  lines.push('# 出海维权证据链对照表（权项特征 ↔ 源码落点）', '');
  lines.push(
    '> 用途：为出海维权取证整理「权项技术特征 ↔ 源码落点」对照底稿。四态判定（可主张 / 需改写 / 不可主张 / 未覆盖）复用 claims_evidence_check 的判定核心，本工具只做呈现与再组织。',
  );
  lines.push(
    '> 边界：本表不做 FTO / 侵权比对分析、不做对比文件检索、不代拟权项文字；结论由律师判断。',
  );
  lines.push('');
  lines.push(
    `- 锚点生成时间：${report.generatedAt}（源码锚点随代码演进而漂移，取证前请逐条复核）`,
  );
  lines.push(`- ${report.disclaimer}`, '');

  if (report.sourceInventory.length > 0) {
    lines.push('### 源码目录清单（供模型逐条读码核对，工具不判定命中）', '');
    for (const file of report.sourceInventory) {
      lines.push(`- \`${file}\``);
    }
    lines.push('');
  }

  const section = (title: string, rows: CodeMapRow[]): void => {
    lines.push(`## ${title}`, '');
    if (rows.length === 0) {
      lines.push('（无）', '');
      return;
    }
    lines.push(
      '| 权项位置 | 特征原文 | 源码锚点 | 状态 | 严重度 | 建议 |',
      '|---|---|---|---|---|---|',
    );
    for (const row of rows) {
      lines.push(
        `| ${cell(row.claimPosition)} | ${cell(row.feature)} | ${row.sourceAnchors
          .map((a) => `\`${a}\``)
          .join(
            '<br>',
          )} | ${row.verdictLabel} | ${row.severity} | ${cell(row.suggestion)} |`,
      );
    }
    lines.push('');
  };

  lines.push('## 一、四态分区', '');
  section('1.1 ✅ 可主张', report.sections.supported);
  section('1.2 ⚠️ 需改写', report.sections.needsRewrite);
  section('1.3 ❌ 不可主张', report.sections.unsupported);
  section('1.4 ⬜ 未覆盖', report.sections.uncovered);

  lines.push('## 二、风险专章', '');
  lines.push(
    `### 2.1 风险一：不可主张（主张即自曝）`,
    '',
    report.risks.counterExposure.intro,
    '',
  );
  for (const row of report.risks.counterExposure.rows) {
    lines.push(
      `- ${row.claimPosition}｜${row.feature}｜${row.sourceAnchors.map((a) => `\`${a}\``).join('`、`')}`,
    );
  }
  if (report.risks.counterExposure.rows.length === 0) {
    lines.push('- （无）');
  }
  lines.push(
    '',
    `### 2.2 风险二：未覆盖（保护缺口）`,
    '',
    report.risks.protectionGap.intro,
    '',
  );
  lines.push('| 源码资产 | 源码落点 | 现状 |');
  lines.push('|---|---|---|');
  for (const row of report.risks.protectionGap.rows) {
    lines.push(
      `| ${cell(row.feature)} | ${row.sourceAnchors.map((a) => `\`${a}\``).join('<br>')} | ${cell(row.suggestion)} |`,
    );
  }
  if (report.risks.protectionGap.rows.length === 0) {
    lines.push('| （无） | — | — |');
  }
  lines.push('');

  lines.push('## 三、答辩锚点（组合特征 · 检索风险评估位）', '');
  if (report.answerAnchors.length === 0) {
    lines.push('（无可主张的组合特征）', '');
  } else {
    lines.push('| 权项位置 | 特征原文 | 检索风险 | 代码落点强度 |');
    lines.push('|---|---|---|---|');
    for (const anchor of report.answerAnchors) {
      const strength =
        anchor.sourceAnchors.length >= 2 ? '多点落点' : '单点落点';
      lines.push(
        `| ${cell(anchor.claimNo === null ? '未挂权项' : `权利要求 ${anchor.claimNo}`)} | ${cell(anchor.feature)} | ${cell(anchor.assessment)} | ${strength} |`,
      );
    }
    lines.push('');
  }
  if (report.answerAnchorBlocked.length > 0) {
    lines.push('以下组合特征判定非「可主张」，不可作答辩锚点：', '');
    for (const row of report.answerAnchorBlocked) {
      lines.push(`- ${row.claimPosition}｜${row.feature}｜${row.verdictLabel}`);
    }
    lines.push('');
  }

  lines.push('## 四、代码侧资产台账（源码有 · 权项无保护点）', '');
  if (report.assetLedger.length === 0) {
    lines.push('（无）', '');
  } else {
    lines.push('| 源码资产 | 源码落点 | 建议的权项落点形态 |');
    lines.push('|---|---|---|');
    for (const asset of report.assetLedger) {
      lines.push(
        `| ${cell(asset.feature)} | ${asset.sourceAnchors.map((a) => `\`${a}\``).join('<br>')} | ${cell(asset.suggestedPlacement)} |`,
      );
    }
    lines.push('');
  }

  lines.push('## 五、双载体特征提示', '');
  if (report.dualCarrier.length === 0) {
    lines.push('（无）', '');
  } else {
    for (const item of report.dualCarrier) {
      lines.push(
        `- [${item.kind}] ${item.feature}｜载体 ${item.carriers.length > 0 ? item.carriers.join('、') : '（未标注）'}｜锚点文件 ${item.anchorFileCount} 个——${item.note}`,
      );
    }
    lines.push('');
  }

  lines.push('## 六、我方是否实施该权项（技术事实核对，非法律意见）', '');
  lines.push('| 权项位置 | 特征原文 | 我方实现 | 暴露面 |');
  lines.push('|---|---|---|---|');
  for (const row of report.selfCheck) {
    const covered =
      row.covered === true
        ? '已覆盖'
        : row.covered === false
          ? '未覆盖'
          : '未标注';
    lines.push(
      `| ${cell(row.claimNo === null ? '未挂权项' : `权利要求 ${row.claimNo}`)} | ${cell(row.feature)} | ${covered} | ${cell(row.exposure)} |`,
    );
  }
  lines.push('');

  if (report.fallbackRisks.length > 0) {
    lines.push('## 七、从属链失实传导（退守防线）', '');
    for (const risk of report.fallbackRisks) {
      lines.push(
        `- 引用闭包 ${risk.chain.join('/')}（编号降序；多项从属时为引用闭包而非单一路径）：被权 ${risk.poisonedBy.join('、权 ')} 的 ${risk.verdicts.join('/')} 特征污染，退守时该特征同样不成立`,
      );
    }
    lines.push('');
  }

  if (report.issues.length > 0) {
    lines.push('## 八、诊断', '');
    for (const issue of report.issues) {
      lines.push(
        `- [${issue.severity}] ${issue.claimNo === null ? '全局' : `权 ${issue.claimNo}`} ${issue.code}: ${issue.message}`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 主入口：把 2/5 的对账判定重排成维权取证台账。
 *
 * @param input.claims 权项正文（与 claims_evidence_check 同格式）。
 * @param input.claimsPath 权项文件路径（.md/.txt/.docx）；与 claims 二选一。
 * @param input.entries 证据记录（与 claims_evidence_check 同结构，另可选
 *   implementedByUs / combination / searchRisk 三个事实标注）。
 * @param input.sourceRoot 源码根目录；只列清单，工具不读码。
 * @param input.document 说明书正文（可选，用于结构提醒与载体对照）。
 * @param input.generatedAt 锚点生成时间（默认取当前时间）。
 */
export function checkClaimsCodeMap(input: {
  claims?: string;
  claimsPath?: string;
  entries?: unknown;
  sourceRoot?: string;
  document?: string;
  generatedAt?: string;
}): ClaimsCodeMapReport {
  const extraIssues: ClaimsEvidenceIssue[] = [];
  let claimsText = (input.claims ?? '').trim();
  if (claimsText.length === 0 && input.claimsPath) {
    try {
      claimsText = readTextFile(input.claimsPath).trim();
    } catch (error) {
      extraIssues.push({
        code: 'CLAIMS_FILE_UNREADABLE',
        severity: 'error',
        claimNo: null,
        message: `读取权项文件失败（${input.claimsPath}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  } else if (claimsText.length > 0 && input.claimsPath) {
    extraIssues.push({
      code: 'CLAIMS_SOURCE_AMBIGUOUS',
      severity: 'warning',
      claimNo: null,
      message:
        '同时传入 claims 与 claimsPath,本次以 claims 文本为准,claimsPath 被忽略;请只保留其一。',
    });
  }

  const evidence = checkClaimsEvidence({
    claims: claimsText,
    entries: input.entries,
    document: input.document,
  });

  const claims = parseClaims(claimsText);
  const claimTextOf = new Map<number, string>();
  for (const claim of claims) claimTextOf.set(claim.number, claim.text);

  const rows = evidence.entries
    .map((entry) =>
      toRow(
        entry,
        entry.claimNo === null ? undefined : claimTextOf.get(entry.claimNo),
      ),
    )
    .sort((a, b) => {
      if (a.claimNo === null && b.claimNo === null) return 0;
      if (a.claimNo === null) return 1;
      if (b.claimNo === null) return -1;
      return a.claimNo - b.claimNo;
    });

  const sections = {
    supported: rows.filter((row) => row.verdict === 'supported'),
    needsRewrite: rows.filter((row) => row.verdict === 'needs-rewrite'),
    unsupported: rows.filter((row) => row.verdict === 'unsupported'),
    uncovered: rows.filter((row) => row.verdict === 'uncovered'),
  };

  const assetLedger: CodeMapAssetEntry[] = sections.uncovered.map((row) => ({
    feature: row.feature,
    sourceAnchors: row.sourceAnchors,
    suggestedPlacement: row.suggestion ?? DEFAULT_PLACEMENT,
  }));

  const answerAnchors: CodeMapAnswerAnchor[] = [];
  const answerAnchorBlocked: CodeMapRow[] = [];
  for (const row of rows) {
    if (!row.combination) continue;
    if (row.verdict === 'supported') {
      answerAnchors.push({
        claimNo: row.claimNo,
        feature: row.feature,
        searchRisk: row.searchRisk,
        assessment: assessmentText(row.searchRisk),
        sourceAnchors: row.sourceAnchors,
      });
    } else {
      answerAnchorBlocked.push(row);
    }
  }

  const selfCheck = rows.map(toSelfCheck);

  const dualCarrier = collectDualCarrier(rows);
  for (const row of rows) {
    if (row.anchorFiles.length >= DUAL_CARRIER_MIN_FILES) {
      dualCarrier.push({
        claimNo: row.claimNo,
        feature: row.feature,
        kind: 'scale-mismatch',
        carriers: row.docRef === null ? [] : [`说明书:${row.docRef}`],
        anchorFileCount: row.anchorFiles.length,
        note: `资产规模与权项表述不匹配：该特征横跨 ${row.anchorFiles.length} 个源码文件，权项侧载体表述未必覆盖这些资产，维权时易被指保护范围与实际实现不匹配`,
      });
    }
  }

  const sourceRootProvided =
    input.sourceRoot !== undefined && input.sourceRoot.trim().length > 0;
  const sourceInventory = sourceRootProvided
    ? listSourceFiles(input.sourceRoot as string)
    : [];
  if (sourceRootProvided && sourceInventory.length === 0) {
    extraIssues.push({
      code: 'SOURCE_ROOT_EMPTY',
      severity: 'warning',
      claimNo: null,
      message: `源码根目录（${input.sourceRoot}）下未列出任何文件：请确认路径存在、是否为空目录或全部落在依赖目录（node_modules/.git/dist 等被跳过）。本表未据此断言任何特征「未覆盖」。`,
    });
  }

  const base = {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    disclaimer:
      '本表为技术事实核对结果（权项文字 ↔ 源码锚点），不是法律意见；FTO / 侵权比对 / 权利要求修改由律师判断。',
    rows,
    sections,
    risks: {
      counterExposure: {
        code: 'UNSUPPORTED' as const,
        title: '不可主张（主张即自曝）',
        intro:
          '以下特征在源码中无落点或行为相反：一旦写入权项并在维权中主张，等于自曝破绽，请优先改写或删除。',
        rows: sections.unsupported,
      },
      protectionGap: {
        code: 'UNCOVERED' as const,
        title: '未覆盖（保护缺口）',
        intro:
          '以下资产源码已实现但权项未记载：白白流失的资产，建议补从属权（工具只给落点形态建议，不代拟权项文字）。',
        rows: sections.uncovered,
      },
    },
    assetLedger,
    answerAnchors,
    answerAnchorBlocked,
    selfCheck,
    dualCarrier,
    fallbackRisks: evidence.fallback.risks,
    sourceInventory,
    issues: [...evidence.issues, ...extraIssues],
    stats: {
      claims: evidence.stats.claims,
      rows: rows.length,
      rejected: evidence.stats.rejected,
      supported: sections.supported.length,
      needsRewrite: sections.needsRewrite.length,
      unsupported: sections.unsupported.length,
      uncovered: sections.uncovered.length,
      sourceFiles: sourceInventory.length,
    },
    ok: ![...evidence.issues, ...extraIssues].some(
      (issue) => issue.severity === 'error',
    ),
  };
  return { ...base, markdown: renderMarkdown(base) };
}
