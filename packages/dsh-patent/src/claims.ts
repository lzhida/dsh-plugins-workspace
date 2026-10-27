/**
 * 权利要求书结构校验（纯函数，无 IO）。
 *
 * 规则依据：《专利法实施细则》与《专利审查指南》对权利要求书的结构性要求
 * （编号连续、从属引用在先、多项从属不得作为另一多项从属的基础、引用主题
 * 一致、独立权利要求的前序+特征两分式撰写）。诊断码稳定，供模型自查循环。
 */

/** 单条权利要求的解析结果。 */
export type Claim = {
  /** 权利要求编号（原文编号，通常 1 起）。 */
  number: number;
  /** 正文（去掉行首编号后的文本，保留内部换行）。 */
  text: string;
  /** 是否从属权利要求（存在有效的「根据权利要求N所述的」引用）。 */
  isDependent: boolean;
  /** 引用的权利要求编号（已展开「1至3」/「1或2」等范围）。 */
  references: number[];
  /** 主题名称（去掉「一种」前缀后的技术主题，如「车载充电方法」）；提取失败为 null。 */
  subjectName: string | null;
  /** 是否含「其特征在于」。 */
  hasCharacterizingPart: boolean;
};

/** 结构诊断。 */
export type ClaimIssue = {
  /** 关联权利要求编号；全局问题为 null。 */
  claim: number | null;
  /** error = 结构硬伤（会被审查指出）；warning = 撰写惯例提示。 */
  severity: 'error' | 'warning';
  /** 稳定诊断码。 */
  code: string;
  /** 中文诊断说明。 */
  message: string;
};

/** 校验报告。 */
export type ClaimsReport = {
  /** 解析出的全部权利要求（按编号升序）。 */
  claims: Claim[];
  /** 全部诊断（按 claim、severity 排序）。 */
  issues: ClaimIssue[];
  /** 统计：总数 / 独立 / 从属 / 多项从属（引用 ≥2 项）。 */
  stats: {
    total: number;
    independent: number;
    dependent: number;
    multiDependent: number;
  };
  /** 是否无 error 级诊断。 */
  ok: boolean;
};

/** 行首编号：`1.`、`1、`、`1．`（允许全角句点与顿号）。 */
const CLAIM_HEAD = /^\s*(\d{1,3})\s*[.、．]\s*/;

/** 「根据/依照/按照 权利要求X…所述的」引用主体（捕获编号片段）。 */
const REFERENCE =
  /(?:根据|依照|按照)\s*权利要求\s*([\d至到~、,，\s或]+?)(?:中任一项|中的任一项|任一项|任一|之一)?\s*所述的/g;

/** 从权利要求文本中解析全部条目（编号乱序也容忍，按升序返回）。 */
export function parseClaims(input: string): Claim[] {
  const lines = input.split(/\r?\n/);
  const found: { number: number; body: string[] }[] = [];
  let current: { number: number; body: string[] } | undefined;

  for (const line of lines) {
    const head = CLAIM_HEAD.exec(line);
    if (head) {
      if (current) found.push(current);
      current = { number: Number(head[1]), body: [line.slice(head[0].length)] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) found.push(current);

  return found
    .map(({ number, body }) => {
      const text = body.join('\n').trim();
      const references = extractReferences(text);
      return {
        number,
        text,
        isDependent: references.length > 0,
        references,
        subjectName: extractSubjectName(text, references.length > 0),
        hasCharacterizingPart: text.includes('其特征在于'),
      };
    })
    .sort((a, b) => a.number - b.number);
}

/** 展开引用片段里的编号：`1至3` → 1,2,3；`1或2` → 1,2；`1、2` → 1,2。 */
function extractReferences(text: string): number[] {
  const out = new Set<number>();
  REFERENCE.lastIndex = 0;
  for (const match of text.matchAll(REFERENCE)) {
    const fragment = match[1];
    if (!fragment) continue;
    // 范围「X至Y / X~Y / X-Y」
    const range = /^(\d+)\s*(?:[至到~－-])\s*(\d+)$/.exec(fragment.trim());
    if (range) {
      const [lo, hi] = [Number(range[1]), Number(range[2])];
      for (let n = lo; n <= hi && n - lo < 50; n++) out.add(n);
      continue;
    }
    // 列表：数字与其间分隔符（或/、/,/，/空白）
    for (const num of fragment.matchAll(/\d+/g)) out.add(Number(num[0]));
  }
  return [...out].sort((a, b) => a - b);
}

/** 提取主题名称：独立取「一种X」的 X；从属取「所述的X」的 X。 */
function extractSubjectName(text: string, dependent: boolean): string | null {
  const head = text.split(/[，,：:；;（(]/)[0] ?? '';
  const trimmed = head.trim();
  const m = dependent
    ? /(?:所述的|所述)(.+)$/.exec(trimmed)
    : /^一?种(.+)$/.exec(trimmed);
  const raw = m?.[1]?.trim();
  if (!raw) return null;
  // 去掉尾随的「的方法/的系统」以外的编号噪声（如「1所述的一种X方法」重复前缀）
  const cleaned = raw.replace(/^一?种/, '').replace(/\s+/g, '');
  return cleaned.length > 0 ? cleaned : null;
}

/** 主校验入口：解析 + 全部结构规则。 */
export function checkClaims(input: string): ClaimsReport {
  const claims = parseClaims(input);
  const issues: ClaimIssue[] = [];
  const byNumber = new Map(claims.map((c) => [c.number, c]));

  // 解析层：空输入 / 空条目
  if (claims.length === 0) {
    issues.push({
      claim: null,
      severity: 'error',
      code: 'CLAIMS_EMPTY',
      message: '未解析到任何权利要求：每条权利要求应以「N.」编号行开头。',
    });
  }

  // 编号连续性与重复
  const numbers = claims.map((c) => c.number);
  const duplicated = numbers.filter((n, i) => numbers.indexOf(n) !== i);
  for (const n of new Set(duplicated)) {
    issues.push({
      claim: n,
      severity: 'error',
      code: 'CLAIM_DUP_NUMBER',
      message: `权利要求编号 ${n} 出现多次。`,
    });
  }
  const unique = [...new Set(numbers)].sort((a, b) => a - b);
  for (let i = 1; i < unique.length; i++) {
    if (unique[i] !== unique[i - 1] + 1) {
      issues.push({
        claim: unique[i],
        severity: 'error',
        code: 'CLAIM_NUMBER_GAP',
        message: `编号不连续：${unique[i - 1]} 之后应为 ${unique[i - 1] + 1}，实际是 ${unique[i]}。`,
      });
    }
  }

  // 第 1 项应为独立权利要求
  const first = claims.find((c) => c.number === unique[0]);
  if (first?.isDependent) {
    issues.push({
      claim: first.number,
      severity: 'error',
      code: 'CLAIM_FIRST_DEPENDENT',
      message: '第 1 项权利要求应为独立权利要求，不得引用其他权利要求。',
    });
  }

  for (const claim of claims) {
    // 空条目
    if (claim.text.length === 0) {
      issues.push({
        claim: claim.number,
        severity: 'error',
        code: 'CLAIM_EMPTY',
        message: `权利要求 ${claim.number} 内容为空。`,
      });
      continue;
    }

    if (claim.isDependent) {
      // 引用有效性（三项检查独立：不存在+在后可并存）
      for (const ref of claim.references) {
        if (ref === claim.number) {
          issues.push({
            claim: claim.number,
            severity: 'error',
            code: 'CLAIM_REF_SELF',
            message: `权利要求 ${claim.number} 引用了自身。`,
          });
        }
        if (!byNumber.has(ref)) {
          issues.push({
            claim: claim.number,
            severity: 'error',
            code: 'CLAIM_REF_MISSING',
            message: `权利要求 ${claim.number} 引用的权利要求 ${ref} 不存在。`,
          });
        }
        if (ref > claim.number) {
          issues.push({
            claim: claim.number,
            severity: 'error',
            code: 'CLAIM_REF_FORWARD',
            message: `权利要求 ${claim.number}（从属）引用了在后的权利要求 ${ref}；从属权利要求只能引用在前的权利要求。`,
          });
        }
      }

      // 多项从属不得引用多项从属（细则：多项从属权利要求不得作为另一多项从属的基础）
      if (claim.references.length >= 2) {
        for (const ref of claim.references) {
          const target = byNumber.get(ref);
          if (target && target.references.length >= 2) {
            issues.push({
              claim: claim.number,
              severity: 'error',
              code: 'CLAIM_MULTI_ON_MULTI',
              message: `多项从属权利要求 ${claim.number} 引用了另一多项从属权利要求 ${ref}；多项从属不得作为另一多项从属的基础，应改写为两项单项从属。`,
            });
          }
        }
      }

      // 引用主题一致性
      if (claim.subjectName) {
        const primary = byNumber.get(claim.references[0]);
        if (primary?.subjectName && primary.subjectName !== claim.subjectName) {
          issues.push({
            claim: claim.number,
            severity: 'warning',
            code: 'CLAIM_SUBJECT_MISMATCH',
            message: `权利要求 ${claim.number} 的主题名称「${claim.subjectName}」与被引用的权利要求 ${primary.number} 主题「${primary.subjectName}」不一致；从属权利要求的主题名称应与其引用的权利要求主题一致。`,
          });
        }
      }
    } else {
      // 独立权利要求：两分式撰写（前序 + 特征部分）
      if (!claim.hasCharacterizingPart) {
        issues.push({
          claim: claim.number,
          severity: 'warning',
          code: 'CLAIM_NO_CHARACTERIZING',
          message: `独立权利要求 ${claim.number} 未出现「其特征在于」；中国实践要求独立权利要求以前序部分+特征部分两分式撰写（不适用的除外）。`,
        });
      }
      if (!claim.subjectName) {
        issues.push({
          claim: claim.number,
          severity: 'warning',
          code: 'CLAIM_SUBJECT_UNPARSED',
          message: `权利要求 ${claim.number} 未按「一种…」开头给出主题名称，请核对首句格式。`,
        });
      }
    }

    // 悬空引用提示：文本含「权利要求N」但未被识别为规范引用句式
    //（不用 \b：中文字符在 JS 正则里不是 \w，\b 语义在此失效）
    if (!claim.isDependent && /权利要求\s*\d/.test(claim.text)) {
      issues.push({
        claim: claim.number,
        severity: 'warning',
        code: 'CLAIM_REF_FORMAT',
        message: `权利要求 ${claim.number} 含「权利要求N」字样但不是「根据权利要求N所述的」规范引用句式，请核对。`,
      });
    }
  }

  const independent = claims.filter((c) => !c.isDependent).length;
  const multiDependent = claims.filter((c) => c.references.length >= 2).length;
  return {
    claims,
    issues: issues.sort(
      (a, b) =>
        (a.claim ?? -1) - (b.claim ?? -1) ||
        (a.severity === 'error' ? -1 : 1) - (b.severity === 'error' ? -1 : 1),
    ),
    stats: {
      total: claims.length,
      independent,
      dependent: claims.length - independent,
      multiDependent,
    },
    ok: !issues.some((i) => i.severity === 'error'),
  };
}
