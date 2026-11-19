import { describe, expect, it } from 'vitest';

import {
  ABSTRACT_CHAR_MAX,
  ABSTRACT_CHAR_MIN,
  assignParagraphNumbers,
  buildApplicationScaffold,
  extractDisclosureSection,
  PART_TITLES,
} from './application-scaffold.ts';

const DISCLOSURE = `\
## 一、背景技术

现有传输方案在弱网下重传整包，效率低。

## 二、背景技术的技术问题

1. 整包重传导致的成本高。

## 三、本案的详细阐述

接收待处理的数据并校验数据格式；
记录校验结果并回执。

## 四、第三项的技术方案中有无可以替代的地方

可替换校验组件。

## 五、第三项的技术手段产生了什么技术效果

减少重传量。

## 六、本案需要保护的要点

1. 一种数据传输系统，其特征在于，包括：接收待处理的数据并校验数据格式，并记录校验结果。
2. 根据权利要求 1 所述的数据传输系统，其特征在于，所述校验包括格式与长度校验。

## 七、附图要求

图1是本发明的方法流程示意图。
`;

const CLAIMS = `\
1. 一种数据传输系统，其特征在于，包括：
接收待处理的数据并校验数据格式，并记录校验结果。
2. 根据权利要求 1 所述的数据传输系统，其特征在于，所述校验包括格式与长度校验。
`;

function codes(
  input: Parameters<typeof buildApplicationScaffold>[0],
): string[] {
  return buildApplicationScaffold(input).issues.map((issue) => issue.code);
}

describe('application_scaffold 五书骨架', () => {
  it('段号跨小节连续分配，步骤行不另起段号', () => {
    const numbering = assignParagraphNumbers([
      '技术领域',
      '本发明涉及数据传输。',
      '（1）接收待处理的数据并校验数据格式；',
      '记录校验结果并回执。',
      '',
      '附图说明',
      '图1是方法流程示意图。',
    ]);
    expect(numbering.count).toBe(5);
    expect(numbering.first).toBe('[0001]');
    expect(numbering.last).toBe('[0005]');
    expect(numbering.lines[0]).toBe('[0001] 技术领域');
    // 步骤行不另起段号：它保留原样，段号仍跟随上一自然段。
    expect(numbering.lines[2]).toBe('（1）接收待处理的数据并校验数据格式；');
    expect(numbering.lines[3]).toBe('[0003] 记录校验结果并回执。');
    // 跨小节连续：附图说明段拿到 [0004]、[0005]。
    expect(numbering.lines[6]).toBe('[0005] 图1是方法流程示意图。');
  });

  it('正文已带段号时先剥旧号，不产生双重编号', () => {
    const numbering = assignParagraphNumbers([
      '[0007] 技术领域',
      '[0008] 本发明涉及数据传输。',
    ]);
    expect(numbering.count).toBe(2);
    expect(numbering.first).toBe('[0001]');
    expect(numbering.lines[0]).toBe('[0001] 技术领域');
    expect(numbering.lines[1]).toBe('[0002] 本发明涉及数据传输。');
  });

  it('按标题抽取交底书某一部分的正文', () => {
    const section = extractDisclosureSection(DISCLOSURE, '七、附图要求');
    expect(section).toContain('图1是本发明的方法流程示意图。');
    expect(section).not.toContain('现有传输方案');
    expect(extractDisclosureSection(DISCLOSURE, '不存在的小节')).toBeNull();
  });

  it('生成五书各部分并按真实标题命名，摘要附图只在扉页栏出现一次', () => {
    const report = buildApplicationScaffold({
      disclosure: DISCLOSURE,
      claims: CLAIMS,
      abstract:
        '本发明公开一种数据传输系统，通过只对校验失败的数据局部重传减少弱网环境下的重传量，进而降低传输成本并提升处理效率。',
      figures: '图1是本发明的方法流程示意图。',
    });
    expect(report.parts.map((part) => part.part)).toEqual([
      'abstract',
      'claims',
      'description',
      'figures',
    ]);
    expect(report.parts[1]?.title).toBe(PART_TITLES.claims);
    expect(report.parts[1]?.content).toContain('1. 一种数据传输系统');
    expect(report.parts[3]?.content).toContain('图1');
    // 摘要附图只在扉页 (57) 栏出现一次，不再单独成部分。
    const abstractFigureCount = report.markdown.split('摘 要 附 图').length - 1;
    expect(abstractFigureCount).toBe(1);
  });

  it('页码双轨：扉页为 1 且不印页脚，权利要求书从 2 起接续', () => {
    const report = buildApplicationScaffold({
      disclosure: DISCLOSURE,
      claims: CLAIMS,
      abstract: '摘要正文。',
      figures: '图1是示意图。',
    });
    const front = report.parts.find((part) => part.part === 'abstract');
    const claimsPart = report.parts.find((part) => part.part === 'claims');
    expect(front?.pageFrom).toBe(1);
    expect(front?.pageTo).toBe(1);
    expect(claimsPart?.pageFrom).toBe(2);
    // 扉页不印页脚；权项书印全文连续页码。
    expect(report.markdown).toContain('— 2 —');
    const frontBlock = report.markdown.split('---')[0] ?? '';
    expect(frontBlock).not.toContain('— 1 —');
  });

  it('权项书校验复用 patent_claims_check 的同一套诊断码与严重度', () => {
    const report = buildApplicationScaffold({
      claims: `\
1. 一种数据传输系统，其特征在于，包括：接收数据。
2. 根据权利要求 5 所述的数据传输系统，其特征在于，所述接收包括校验。
`,
    });
    expect(report.claimsCheck).not.toBeNull();
    expect(report.claimsCheck?.ok).toBe(false);
    expect(report.claimsCheck?.total).toBe(2);
    expect(report.claimsCheck?.independent).toBe(1);
    expect(report.claimsCheck?.dependent).toBe(1);
    const errorCodes = report.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.code);
    expect(errorCodes).toContain('CLAIM_REF_MISSING');
    expect(report.ok).toBe(false);
  });

  it('权项书的 warning 级诊断同样转发（与 patent_claims_check 可见性一致）', () => {
    const report = buildApplicationScaffold({
      claims: '1. 一种数据传输系统，包括：接收数据并校验数据格式。',
    });
    const warnings = report.issues.filter(
      (issue) => issue.severity === 'warning',
    );
    expect(warnings.map((issue) => issue.code)).toContain(
      'CLAIM_NO_CHARACTERIZING',
    );
    // warning 不升级为 error：权项书本身没有 error 级诊断。
    const claimErrors = report.issues
      .filter(
        (issue) => issue.severity === 'error' && issue.code.startsWith('CLAIM'),
      )
      .map((issue) => issue.code);
    expect(claimErrors).toEqual([]);
    // 诊断带权利要求编号，便于定位。
    const noCharacterizing = warnings.find(
      (issue) => issue.code === 'CLAIM_NO_CHARACTERIZING',
    );
    expect(noCharacterizing?.claimNo).toBe(1);
  });

  it('多项从属不得作为另一多项从属的基础（沿用 checkClaims 的诊断）', () => {
    const report = buildApplicationScaffold({
      claims: `\
1. 一种数据传输系统，其特征在于，包括：接收数据。
2. 根据权利要求 1 或 3 所述的数据传输系统，其特征在于，所述接收包括校验。
3. 根据权利要求 1 或 2 所述的数据传输系统，其特征在于，所述校验包括格式校验。
`,
    });
    expect(report.claimsCheck?.ok).toBe(false);
    expect(report.claimsCheck?.multiDependent).toBe(2);
    const errorCodes = report.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.code);
    expect(errorCodes).toContain('CLAIM_MULTI_ON_MULTI');
  });

  it('摘要超出 230-320 字区间时给出诊断（过长与过短都报）', () => {
    const long = '本'.repeat(ABSTRACT_CHAR_MAX + 30);
    expect(
      codes({ abstract: long }).includes('ABSTRACT_LENGTH_OUT_OF_RANGE'),
    ).toBe(true);
    const short = '本'.repeat(ABSTRACT_CHAR_MIN - 30);
    expect(
      codes({ abstract: short }).includes('ABSTRACT_LENGTH_OUT_OF_RANGE'),
    ).toBe(true);
  });

  it('无任何来源时留占位并记诊断，不臆造正文', () => {
    const report = buildApplicationScaffold({});
    expect(report.ok).toBe(false);
    const errorCodes = report.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.code);
    expect(errorCodes).toContain('NO_CLAIMS_SOURCE');
    expect(errorCodes).toContain('NO_ABSTRACT');
    expect(errorCodes).toContain('NO_DESCRIPTION_SOURCE');
    const claimsPart = report.parts.find((part) => part.part === 'claims');
    expect(claimsPart?.content).toContain('〔待补');
  });

  it('从交底书搬运说明书并施加连续段号；权项书摘录标记为未定稿', () => {
    const report = buildApplicationScaffold({ disclosure: DISCLOSURE });
    expect(
      report.issues.some((issue) => issue.code === 'CLAIMS_NOT_FINALIZED'),
    ).toBe(true);
    // 摘录的要点不是权项书，不做校验。
    expect(report.claimsCheck).toBeNull();
    expect(report.numbering.count).toBeGreaterThan(0);
    expect(report.numbering.first).toBe('[0001]');
    const description = report.parts.find(
      (part) => part.part === 'description',
    );
    expect(description?.content).toContain('[0001] 技术领域');
    expect(description?.content).toContain('具体实施方式');
  });

  it('markdown 输出页眉格式与各部分正文', () => {
    const report = buildApplicationScaffold({
      disclosure: DISCLOSURE,
      claims: CLAIMS,
      abstract: '摘要正文。',
      figures: '图1是示意图。',
      options: { publicationNumber: 'CN123456789A' },
    });
    expect(report.markdown).toContain('CN123456789A | 权 利 要 求 书 | 1/1 页');
    expect(report.markdown).toContain('权 利 要 求 书');
    expect(report.markdown).toContain('说 明 书');
  });
});
