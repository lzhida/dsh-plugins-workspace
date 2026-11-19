import { checkClaims, parseClaims } from './claims.ts';

/**
 * A/B 双文本（公开文本 → 授权文本）权利要求差异分析。
 *
 * 口径来自 docs/patent-reference-notes.md「A/B 修改模式（公开 → 授权）」：
 * - 权利要求合并收紧：部分从权内容并入独权（独权变长）、剩余从权重编号且
 *   引用基准统一改为直接引用权 1、介质权引用范围跟随新编号；
 * - 说明书、附图、发明名称、摘要逐字不变；总页数变化仅来自权利要求书。
 *
 * 本模块只做**机械比对与归类**，不判断改写是否成立（法律结论留给代理师）。
 */

/** 差异模式。 */
export type AbDiffMode =
  /** 从权内容并入独权。 */
  | 'merged-into-independent'
  /** 从权重新编号。 */
  | 'renumbered-dependent'
  /** 引用基准迁移（统一改为引用权 1，或引用范围随新编号调整）。 */
  | 'reference-base-shift'
  /** 未见差异。 */
  | 'unchanged';

/** 单条权项配对结果。 */
export type AbClaimPair = {
  /** 公开文本中的编号；未匹配为 null。 */
  aNumber: number | null;
  /** 授权文本中的编号；未匹配为 null。 */
  bNumber: number | null;
  aDependent: boolean;
  bDependent: boolean;
  modes: AbDiffMode[];
  detail: string[];
};

/** 差异行（每行一个模式，便于直接做修改清单）。 */
export type AbDiffRow = {
  mode: AbDiffMode;
  aNumber: number | null;
  bNumber: number | null;
  title: string;
  detail: string;
};

/** 诊断。 */
export type AbDiffIssue = {
  code: string;
  severity: 'error' | 'warning';
  aNumber: number | null;
  bNumber: number | null;
  message: string;
};

/** 报告。 */
export type AbDiffReport = {
  pairs: AbClaimPair[];
  rows: AbDiffRow[];
  issues: AbDiffIssue[];
  stats: {
    publicClaims: number;
    grantedClaims: number;
    merged: number;
    renumbered: number;
    baseShifted: number;
    unchanged: number;
  };
  ok: boolean;
  markdown: string;
};

/** 入参。 */
export type AbDiffInput = {
  /** 公开文本（至少含权利要求书部分）。 */
  publicText?: string;
  /** 授权文本（至少含权利要求书部分）。 */
  grantedText?: string;
  /** 可选：公开文本全文，用于核对「说明书/附图/发明名称/摘要逐字不变」。 */
  publicDocument?: string;
  /** 可选：授权文本全文，同上。 */
  grantedDocument?: string;
};

/** 特征重合阈值：公开权项有这么大比例的字符出现在授权权项里即视为承接。 */
export const AB_OVERLAP_MIN_RATIO = 0.6;
/** 并入独权判定阈值：公开从权特征出现在授权独权中的比例下限。 */
export const AB_MERGE_MIN_RATIO = 0.45;

const MODE_LABEL: Record<AbDiffMode, string> = {
  'merged-into-independent': '并入独权',
  'renumbered-dependent': '从权重编号',
  'reference-base-shift': '引用基准迁移',
  unchanged: '未见差异',
};

/** 归一：去空白与标点，只留可比较的实义字符。 */
function normalizeForCompare(text: string): string {
  return text
    .replace(/[\s\u3000]/g, '')
    .replace(/[，。、；：,.;:()（）「」“”"'\-—]/g, '');
}

/** 最长公共子串长度（动态规划）。 */
function longestCommonSubstring(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  const prev = new Array<number>(b.length + 1).fill(0);
  const curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = 0;
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        if (curr[j] > best) best = curr[j];
      } else {
        curr[j] = 0;
      }
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }
  return best;
}

/** 公开权项正文在某个授权权项正文中的承接比例。 */
function overlapRatio(aText: string, bText: string): number {
  const a = normalizeForCompare(aText);
  if (!a) return 0;
  return longestCommonSubstring(a, normalizeForCompare(bText)) / a.length;
}

/** 抽取可比较的「权项特征段」：去掉「其特征在于」之前的主题引导。 */
function featureSegment(text: string): string {
  const marker = text.indexOf('其特征在于');
  if (marker >= 0) return text.slice(marker + '其特征在于'.length);
  return text;
}

/** 判断 B 的从权引用集合是否与 A 不同。 */
function refsChanged(a: number[], b: number[]): boolean {
  if (a.length === 0 && b.length === 0) return false;
  const sa = [...a].sort((x, y) => x - y).join(',');
  const sb = [...b].sort((x, y) => x - y).join(',');
  return sa !== sb;
}

/** 权项书标题行：容忍 markdown 井号与字间空格（CNIPA 形态「权 利 要 求 书」）。 */
const CLAIMS_HEAD = /^#*\s*权\s*利\s*要\s*求\s*书/;

/** 权项书之后的下一部分标题行。 */
const NEXT_HEAD =
  /^#*\s*(说\s*明\s*书|附\s*图|技\s*术\s*领\s*域|背\s*景\s*技\s*术|发\s*明\s*内\s*容|具\s*体\s*实\s*施\s*方\s*式)/;

/** 抽取非权项部分文本，用于「逐字不变」核对。 */
function nonClaimText(document: string): string {
  const lines = document.split(/\r?\n/);
  const kept: string[] = [];
  let inClaims = false;
  for (const line of lines) {
    const head = line.trim();
    if (CLAIMS_HEAD.test(head)) {
      inClaims = true;
      continue;
    }
    if (inClaims) {
      if (NEXT_HEAD.test(head)) {
        inClaims = false;
      } else {
        continue;
      }
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * 比对公开文本与授权文本的权利要求，输出差异行。
 *
 * 三类模式：
 * 1. 并入独权——公开文本的某条从权特征出现在授权文本的独立权中；
 * 2. 从权重编号——公开从权在授权文本中换号；
 * 3. 引用基准迁移——授权从权的引用集合与公开从权不同（常见为统一改为引用权 1）。
 */
export function checkClaimsAbDiff(input: AbDiffInput): AbDiffReport {
  const issues: AbDiffIssue[] = [];
  const publicText = input.publicText?.trim() ?? '';
  const grantedText = input.grantedText?.trim() ?? '';

  if (!publicText || !grantedText) {
    issues.push({
      code: 'AB_INPUT_MISSING',
      severity: 'error',
      aNumber: null,
      bNumber: null,
      message:
        '需要同时提供公开文本与授权文本（至少含权利要求书部分）才能做差异比对。',
    });
    return {
      pairs: [],
      rows: [],
      issues,
      stats: {
        publicClaims: 0,
        grantedClaims: 0,
        merged: 0,
        renumbered: 0,
        baseShifted: 0,
        unchanged: 0,
      },
      ok: false,
      markdown: renderAbDiffMarkdown(null),
    };
  }

  const aClaims = parseClaims(publicText);
  const bClaims = parseClaims(grantedText);

  if (aClaims.length === 0) {
    issues.push({
      code: 'AB_PUBLIC_CLAIMS_EMPTY',
      severity: 'error',
      aNumber: null,
      bNumber: null,
      message:
        '公开文本未解析出任何权利要求（行首编号应为「1.」「1、」「1．」）。',
    });
  }
  if (bClaims.length === 0) {
    issues.push({
      code: 'AB_GRANTED_CLAIMS_EMPTY',
      severity: 'error',
      aNumber: null,
      bNumber: null,
      message:
        '授权文本未解析出任何权利要求（行首编号应为「1.」「1、」「1．」）。',
    });
  }

  const pairs: AbClaimPair[] = [];
  const usedB = new Set<number>();
  const bIndependent = bClaims.filter((c) => !c.isDependent);
  const bDependent = bClaims.filter((c) => c.isDependent);

  for (const a of aClaims) {
    // 找承接度最高的授权权项。
    let best: { claim: (typeof bClaims)[number]; ratio: number } | null = null;
    for (const b of bClaims) {
      const ratio = overlapRatio(
        featureSegment(a.text),
        featureSegment(b.text),
      );
      if (!best || ratio > best.ratio) best = { claim: b, ratio };
    }
    const pair: AbClaimPair = {
      aNumber: a.number,
      bNumber: null,
      aDependent: a.isDependent,
      bDependent: false,
      modes: [],
      detail: [],
    };

    if (!best || best.ratio < AB_OVERLAP_MIN_RATIO) {
      pair.modes.push('unchanged');
      pair.detail.push(
        '未在授权文本中找到承接该特征的权项（可能是被删减或合并进其它段落）。',
      );
      issues.push({
        code: 'AB_CLAIM_DROPPED',
        severity: 'warning',
        aNumber: a.number,
        bNumber: null,
        message: `公开权利要求 ${a.number} 在授权文本中未找到承接权项。`,
      });
      pairs.push(pair);
      continue;
    }

    const b = best.claim;
    usedB.add(b.number);
    pair.bNumber = b.number;
    pair.bDependent = b.isDependent;

    if (a.isDependent && !b.isDependent) {
      pair.modes.push('merged-into-independent');
      pair.detail.push(
        `公开从权 ${a.number} 的特征已并入授权独立权 ${b.number}（承接度 ${(best.ratio * 100).toFixed(0)}%）。`,
      );
    } else if (a.isDependent && b.isDependent) {
      if (a.number !== b.number) {
        pair.modes.push('renumbered-dependent');
        pair.detail.push(`从权 ${a.number} 在授权文本中重编号为 ${b.number}。`);
      }
      if (refsChanged(a.references, b.references)) {
        pair.modes.push('reference-base-shift');
        pair.detail.push(
          `引用基准由 [${a.references.join(', ') || '—'}] 改为 [${b.references.join(', ') || '—'}]。`,
        );
      }
    } else if (!a.isDependent && !b.isDependent) {
      const grew =
        featureSegment(b.text).length > featureSegment(a.text).length;
      pair.detail.push(
        grew
          ? `独立权 ${a.number} → ${b.number} 文本变长（吸收了从权内容）。`
          : `独立权 ${a.number} → ${b.number} 承接度 ${(best.ratio * 100).toFixed(0)}%。`,
      );
    }

    if (pair.modes.length === 0) pair.modes.push('unchanged');
    pairs.push(pair);
  }

  // 公开从权并入独权：若某条从权特征整体出现在授权独立权里也算并入。
  for (const a of aClaims) {
    if (!a.isDependent) continue;
    const pair = pairs.find((p) => p.aNumber === a.number);
    if (!pair || pair.modes.includes('merged-into-independent')) continue;
    for (const indep of bIndependent) {
      const ratio = overlapRatio(
        featureSegment(a.text),
        featureSegment(indep.text),
      );
      if (ratio >= AB_MERGE_MIN_RATIO) {
        pair.modes = pair.modes.filter((m) => m !== 'unchanged');
        pair.modes.push('merged-into-independent');
        // 第二遍命中即并入成立：撤回第一遍「未找到承接」的判定与诊断，
        // 并补回承接权项编号，避免同一行同时出现两种互斥结论。
        pair.detail = pair.detail.filter(
          (d) => !d.includes('未在授权文本中找到承接该特征'),
        );
        pair.detail.push(
          `公开从权 ${a.number} 的特征在授权独立权 ${indep.number} 中出现（承接度 ${(ratio * 100).toFixed(0)}%）。`,
        );
        pair.bNumber = indep.number;
        pair.bDependent = false;
        const droppedIdx = issues.findIndex(
          (it) => it.code === 'AB_CLAIM_DROPPED' && it.aNumber === a.number,
        );
        if (droppedIdx >= 0) issues.splice(droppedIdx, 1);
        usedB.add(indep.number);
        break;
      }
    }
  }

  // 授权文本新增权项（无对应公开权项）。
  for (const b of bClaims) {
    if (usedB.has(b.number)) continue;
    if (bDependent.some((d) => d.references.includes(b.number))) continue;
    issues.push({
      code: 'AB_CLAIM_ADDED',
      severity: 'warning',
      aNumber: null,
      bNumber: b.number,
      message: `授权文本权利要求 ${b.number} 未找到对应的公开权项（可能是新增独立权）。`,
    });
  }

  // 授权文本自身的结构诊断沿用 checkClaims，避免两套口径。
  const grantedReport = checkClaims(grantedText);
  for (const issue of grantedReport.issues) {
    issues.push({
      code: `AB_SOURCE_${issue.code}`,
      severity: issue.severity,
      aNumber: null,
      bNumber: issue.claim,
      message: issue.message,
    });
  }

  // 「说明书/附图/发明名称/摘要逐字不变」核对（可选）。
  if (input.publicDocument?.trim() && input.grantedDocument?.trim()) {
    const aText = normalizeForCompare(nonClaimText(input.publicDocument));
    const bText = normalizeForCompare(nonClaimText(input.grantedDocument));
    if (aText !== bText) {
      issues.push({
        code: 'AB_NON_CLAIM_CHANGED',
        severity: 'warning',
        aNumber: null,
        bNumber: null,
        message:
          '公开与授权文本的非权项部分（说明书/附图/发明名称/摘要）不一致：A/B 模式通常逐字不变，出现差异需人工确认。',
      });
    }
  }

  const rows: AbDiffRow[] = [];
  for (const pair of pairs) {
    for (const mode of pair.modes) {
      if (mode === 'unchanged') continue;
      rows.push({
        mode,
        aNumber: pair.aNumber,
        bNumber: pair.bNumber,
        title: MODE_LABEL[mode],
        detail: pair.detail.join(' '),
      });
    }
  }

  const stats = {
    publicClaims: aClaims.length,
    grantedClaims: bClaims.length,
    merged: rows.filter((r) => r.mode === 'merged-into-independent').length,
    renumbered: rows.filter((r) => r.mode === 'renumbered-dependent').length,
    baseShifted: rows.filter((r) => r.mode === 'reference-base-shift').length,
    unchanged: pairs.filter(
      (p) => p.modes.length === 1 && p.modes[0] === 'unchanged',
    ).length,
  };

  return {
    pairs,
    rows,
    issues,
    stats,
    ok: !issues.some((i) => i.severity === 'error'),
    markdown: renderAbDiffMarkdown({ pairs, rows, issues, stats }),
  };
}

/** Markdown 渲染。 */
export function renderAbDiffMarkdown(
  report: {
    pairs: AbClaimPair[];
    rows: AbDiffRow[];
    issues: AbDiffIssue[];
    stats: AbDiffReport['stats'];
  } | null,
): string {
  if (!report)
    return '# A/B 权利要求差异\n\n未执行比对：缺少公开文本或授权文本。\n';
  const lines: string[] = [];
  lines.push('# A/B 权利要求差异报告（公开 → 授权）');
  lines.push('');
  lines.push(
    '> 机械比对结果，仅供代理师核对；是否成立由代理师判断。口径：部分从权并入独权、从权重编号且引用基准统一改为引用权 1、说明书与附图逐字不变。',
  );
  lines.push('');
  lines.push('## 一、差异清单');
  lines.push('');
  if (report.rows.length === 0) {
    lines.push('未检出三类差异模式。');
  } else {
    lines.push('| 模式 | 公开权项 | 授权权项 | 说明 |');
    lines.push('| --- | --- | --- | --- |');
    for (const row of report.rows) {
      lines.push(
        `| ${row.title} | ${row.aNumber ?? '—'} | ${row.bNumber ?? '—'} | ${row.detail} |`,
      );
    }
  }
  lines.push('');
  lines.push('## 二、配对总览');
  lines.push('');
  lines.push('| 公开权项 | 授权权项 | 模式 | 说明 |');
  lines.push('| --- | --- | --- | --- |');
  for (const pair of report.pairs) {
    lines.push(
      `| ${pair.aNumber ?? '—'} | ${pair.bNumber ?? '—'} | ${pair.modes.map((m) => MODE_LABEL[m]).join('、')} | ${pair.detail.join(' ')} |`,
    );
  }
  lines.push('');
  lines.push('## 三、诊断');
  lines.push('');
  if (report.issues.length === 0) {
    lines.push('无诊断。');
  } else {
    for (const issue of report.issues) {
      lines.push(`- [${issue.severity}] ${issue.code}：${issue.message}`);
    }
  }
  lines.push('');
  lines.push('## 四、统计');
  lines.push('');
  lines.push(
    `- 公开权项 ${report.stats.publicClaims} 条 / 授权权项 ${report.stats.grantedClaims} 条`,
  );
  lines.push(
    `- 并入独权 ${report.stats.merged} 处、从权重编号 ${report.stats.renumbered} 处、引用基准迁移 ${report.stats.baseShifted} 处`,
  );
  return lines.join('\n');
}
