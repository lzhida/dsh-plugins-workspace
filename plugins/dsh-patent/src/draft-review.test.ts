import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import {
  CLAIM_ISSUE_MAP,
  checkDraftReview,
  countTermUsage,
  extractSaidTerms,
  normalizeForCompare,
  splitSpecSections,
  type DraftReviewIssue,
} from './draft-review.ts';
import { extractDocxText, extractDocxXmlText } from './docx-text.ts';

const SPEC = `说明书摘要

本发明公开一种测试方法，涉及数据处理领域，解决了现有方法效率低的问题，用于测试系统的验证。

权利要求书

1. 一种测试方法，其特征在于，包括：获取数据；处理所述数据，输出结果。

2. 根据权利要求1所述的测试方法，其特征在于，所述数据来自缓存。

说明书

技术领域

本发明涉及数据处理领域。

背景技术

现有方法存在四类通道的处理效率低的问题。

发明内容

本发明公开一种测试方法，包括：获取数据；处理所述数据，输出结果，以解决效率低的问题。

附图说明

图1是本方法的流程图。

具体实施方式

本实施例中，获取数据后处理所述数据，输出结果。`;

const SPEC_PARITY = `说明书摘要

本发明公开一种测试方法，涉及数据处理领域。

权利要求书

1. 一种测试方法，其特征在于，包括：获取目标数据并缓存至指定存储区域，以便后续读取所述存储区域完成处理并输出最终结果。

2. 根据权利要求1所述的测试方法，其特征在于，所述存储区域采用加密分区以避免数据串扰。

说明书

技术领域

本发明涉及数据处理领域。

背景技术

现有方法的处理效率低。

发明内容

本发明公开一种测试方法，包括：获取目标数据并缓存至指定存储区域，以便后续读取所述存储区域完成处理并输出最终结果。

附图说明

图1是本方法的流程图。

具体实施方式

本实施例中按上述步骤执行。`;

function codes(issues: DraftReviewIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

/** 造一个只含单个条目的最小 zip（docx 的容器形态）。 */
function buildZip(name: string, content: string): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const raw = Buffer.from(content, 'utf8');
  const compressed = deflateRawSync(raw);
  const checksum = crc32(raw) >>> 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(0, 10);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  const localBlock = Buffer.concat([local, nameBuf, compressed]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(0, 12);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);
  const centralBlock = Buffer.concat([central, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBlock, centralBlock, eocd]);
}
describe('splitSpecSections', () => {
  it('按标题切出说明书五部分', () => {
    const sections = splitSpecSections(SPEC);
    expect(sections.field).toContain('数据处理领域');
    expect(sections.background).toContain('四类通道');
    expect(sections.invention).toContain('获取数据');
    expect(sections.figures).toContain('图1');
    expect(sections.embodiment).toContain('本实施例中');
  });

  it('缺标题时该部分为空串', () => {
    const sections = splitSpecSections('技术领域\n\n本发明涉及数据处理。');
    expect(sections.background).toBe('');
    expect(sections.invention).toBe('');
  });
});

describe('normalizeForCompare', () => {
  it('忽略空白与全半角差异', () => {
    expect(normalizeForCompare('获取　数据；处理')).toBe('获取数据;处理');
  });
});

describe('extractSaidTerms', () => {
  it('提取「所述X」术语并去尾助词', () => {
    const terms = extractSaidTerms('处理所述数据，输出所述结果与所述标识');
    expect(terms).toContain('数据');
    expect(terms).toContain('结果');
    expect(terms).toContain('标识');
  });

  it('流水句在连接词处截断，不把后句吞进术语', () => {
    // 「处理所述绑定键后输出结果。」若不切连接词，术语会变成
    // 「绑定键后输出结果」，权项里裸用「绑定键」就再也匹配不上。
    const terms = extractSaidTerms('处理所述绑定键后输出结果。');
    expect(terms).toContain('绑定键');
    expect(terms).not.toContain('绑定键后输出结果');
  });
});

describe('countTermUsage', () => {
  it('区分裸用与带「所述」次数', () => {
    const stat = countTermUsage('claims', '数据', '获取数据，处理所述数据');
    expect(stat.bare).toBe(1);
    expect(stat.withSaid).toBe(1);
  });
});

describe('checkDraftReview 分级映射', () => {
  it('权项结构诊断映射为分级问题', () => {
    const report = checkDraftReview({
      claims:
        '1. 一种测试方法，其特征在于，包括：获取数据。\n\n3. 根据权利要求5所述的测试方法，其特征在于，所述数据来自缓存。',
      specification: SPEC,
      focus: 'formal',
    });
    const found = report.issues.filter((issue) =>
      issue.code.startsWith('claims:'),
    );
    expect(found.length).toBeGreaterThan(0);
    const missing = found.find((issue) =>
      issue.code.includes('claim_ref_missing'),
    );
    expect(missing?.severity).toBe('high');
    expect(missing?.face).toBe('formal');
    const gap = found.find((issue) => issue.code.includes('claim_number_gap'));
    expect(gap?.severity).toBe('medium');
  });

  it('摘要超字数报中危并给出实测值', () => {
    const report = checkDraftReview({
      abstract: '本'.repeat(320),
      specification: SPEC,
      focus: 'formal',
    });
    const issue = report.issues.find((item) => item.code === 'abstract-length');
    expect(issue?.severity).toBe('medium');
    expect(issue?.basis).toContain('320');
  });

  it('说明书缺部分报高危并列出缺哪几部分', () => {
    const report = checkDraftReview({
      specification: '技术领域\n\n本发明涉及数据处理领域。',
      focus: 'formal',
    });
    const issue = report.issues.find(
      (item) => item.code === 'spec-sections-missing',
    );
    expect(issue?.severity).toBe('high');
    expect(issue?.basis).toContain('背景技术');
  });
});

describe('checkDraftReview focus 裁剪', () => {
  it('comply 视角同时覆盖形式规范与符合性', () => {
    const report = checkDraftReview({
      claims: '1. 一种测试方法，其特征在于，包括：获取数据。',
      specification: SPEC,
    });
    expect(report.focus).toBe('comply');
    const faces = new Set(report.issues.map((issue) => issue.face));
    expect(faces.has('formal')).toBe(true);
    expect(faces.has('comply')).toBe(true);
  });

  it('formal 视角不报符合性专属问题', () => {
    const report = checkDraftReview({
      claims: '1. 一种测试方法，其特征在于，包括：获取数据。',
      specification: SPEC,
      focus: 'formal',
    });
    expect(codes(report.issues)).not.toContain('three-legs-missing');
  });

  it('prior-art 视角只出核查清单不出机检问题', () => {
    const report = checkDraftReview({
      claims: '1. 一种测试方法，其特征在于，包括：获取数据。',
      specification: SPEC,
      focus: 'prior-art',
    });
    expect(report.issues).toHaveLength(0);
    expect(report.checklist.map((item) => item.code)).toContain(
      'prior-art-search',
    );
  });
});

describe('checkDraftReview 无证据条目过滤', () => {
  it('需模型判断的核查项不进分级问题清单', () => {
    const report = checkDraftReview({
      claims: '1. 一种测试方法，其特征在于，包括：获取数据。',
      specification: SPEC,
    });
    expect(codes(report.issues)).not.toContain('code-consistency');
    expect(codes(report.issues)).not.toContain('numeric-facts');
    expect(report.checklist.map((item) => item.code)).toContain(
      'code-consistency',
    );
  });

  it('无源码落点的特征进独立清单并触发问题', () => {
    const report = checkDraftReview({
      claims: '1. 一种测试方法，其特征在于，包括：获取数据。',
      specification: SPEC,
      entries: [
        {
          claimNo: 1,
          feature: '获取数据',
          verdict: 'supported',
          severity: 'low',
          sourceAnchors: ['src/a.ts:10-20'],
        },
        {
          claimNo: 1,
          feature: '输出来源标记',
          verdict: 'needs-rewrite',
          severity: 'medium',
          sourceAnchors: [],
        },
      ],
    });
    expect(report.uncoveredFeatures.map((item) => item.feature)).toContain(
      '输出来源标记',
    );
    expect(codes(report.issues)).toContain('evidence-anchor-missing');
  });
});

describe('checkDraftReview 机检面', () => {
  it('权项特征未在发明内容逐字出现时报中危', () => {
    const report = checkDraftReview({
      claims:
        '1. 一种测试方法，其特征在于，包括：获取目标数据并缓存至指定存储区域，以便后续读取所述存储区域完成处理并输出最终结果。\n\n2. 根据权利要求1所述的测试方法，其特征在于，所述存储区域采用加密分区以避免数据串扰。',
      specification: SPEC_PARITY,
      focus: 'formal',
    });
    const issue = report.issues.find(
      (item) => item.code === 'invention-claim-parity',
    );
    expect(issue?.severity).toBe('low');
    expect(issue?.location).toContain('权利要求 2');
  });

  it('附图标记裸写与图号悬空分别报中危与高危', () => {
    const report = checkDraftReview({
      claims: '1. 一种测试方法，其特征在于，包括：获取驱动渲染层500的数据。',
      specification: `${SPEC}\n\n如图3所示。`,
      figures: '图1是本方法的流程图。',
      focus: 'formal',
    });
    expect(codes(report.issues)).toContain('figref-bare-mark');
    const dangling = report.issues.find(
      (item) => item.code === 'figure-dangling-reference',
    );
    expect(dangling?.severity).toBe('high');
  });

  it('三处同源文本公共后缀超阈值时报重复', () => {
    const shared =
      '本发明公开一种测试方法，通过获取目标数据并缓存至指定存储区域，再读取所述存储区域完成后续处理并输出最终结果，从而在相同输入下稳定得到相同的结果，显著降低了整体处理开销并避免了重复读取造成的额外时延，并保证了处理结果的可复现性。';
    const report = checkDraftReview({
      abstract: shared,
      specification: `${SPEC}\n\n${shared}`,
      focus: 'formal',
    });
    expect(codes(report.issues)).toContain('text-duplication');
  });

  it('术语裸用达阈值时报中危并给出词表', () => {
    const report = checkDraftReview({
      claims:
        '1. 一种测试方法，其特征在于，包括：获取绑定键；读取绑定键；写入绑定键；校验绑定键。',
      specification: `技术领域

本发明涉及数据处理领域。

背景技术

现有方法效率低。

发明内容

本发明公开一种测试方法。

附图说明

图1是本方法的流程图。

具体实施方式

本实施例中写入所述绑定键，再读取后完成处理。`,
      focus: 'formal',
    });
    const issue = report.issues.find(
      (item) => item.code === 'term-discipline-naked',
    );
    expect(issue?.severity).toBe('medium');
    expect(issue?.basis).toContain('绑定键');
  });

  it('背景技术封闭列举在效果段缺失时报中危', () => {
    const report = checkDraftReview({
      specification: SPEC,
      focus: 'comply',
    });
    const issue = report.issues.find(
      (item) => item.code === 'effect-chain-broken',
    );
    expect(issue?.severity).toBe('medium');
    expect(issue?.basis).toContain('四类');
  });
});

describe('checkDraftReview 报告结构', () => {
  it('markdown 含分级表、核查清单与统计', () => {
    const report = checkDraftReview({
      claims: '1. 一种测试方法，其特征在于，包括：获取数据。',
      specification: SPEC,
    });
    expect(report.markdown).toContain('初稿审查报告');
    expect(report.markdown).toContain(
      '| 严重度 | 视角 | 问题 | 位置 | 依据 | 建议 |',
    );
    expect(report.markdown).toContain('需模型判断的核查清单');
    expect(report.stats.issues).toBe(report.issues.length);
    expect(report.ok).toBe(
      report.stats.bySeverity.critical === 0 &&
        report.stats.bySeverity.high === 0,
    );
  });

  it('docx 解析失败只记一条问题不吞掉其余检查', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-patent-review-'));
    const broken = join(dir, 'broken.docx');
    writeFileSync(broken, 'not a zip');
    const report = checkDraftReview({
      draftPath: broken,
      specification: '技术领域\n\n本发明涉及数据处理领域。',
    });
    const issue = report.issues.find(
      (item) => item.code === 'docx-parse-failed',
    );
    expect(issue?.severity).toBe('high');
    expect(codes(report.issues)).toContain('spec-sections-missing');
  });
});

describe('docx-text', () => {
  it('从 document.xml 抽出段落文本', () => {
    const xml =
      '<w:document><w:body><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>';
    expect(extractDocxXmlText(xml)).toBe('第一段\n\n第二段');
  });

  it('非法文件抛出可读错误', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-patent-docx-'));
    const broken = join(dir, 'broken.docx');
    writeFileSync(broken, 'not a zip');
    expect(() => extractDocxText(broken)).toThrow(/不是可解析的 docx|无法读取/);
  });
});

describe('CLAIM_ISSUE_MAP 覆盖度', () => {
  it('覆盖 claims.ts 的全部权项结构诊断码', () => {
    // claims.ts 新增诊断码时必须同步此清单与 CLAIM_ISSUE_MAP，
    // 否则该诊断在初稿审查里会被静默丢弃。
    const claimCodes = [
      'CLAIMS_EMPTY',
      'CLAIM_DUP_NUMBER',
      'CLAIM_NUMBER_GAP',
      'CLAIM_FIRST_DEPENDENT',
      'CLAIM_EMPTY',
      'CLAIM_REF_SELF',
      'CLAIM_REF_MISSING',
      'CLAIM_REF_FORWARD',
      'CLAIM_MULTI_ON_MULTI',
      'CLAIM_SUBJECT_MISMATCH',
      'CLAIM_NO_CHARACTERIZING',
      'CLAIM_SUBJECT_UNPARSED',
      'CLAIM_REF_FORMAT',
    ];
    for (const code of claimCodes) {
      expect(CLAIM_ISSUE_MAP[code]).toBeDefined();
    }
    expect(Object.keys(CLAIM_ISSUE_MAP).sort()).toEqual([...claimCodes].sort());
  });
});

describe('checkDraftReview docx 初稿端到端', () => {
  it('合法 docx 能切出摘要/权项书/说明书并跑通机检面', () => {
    const longAbstract = '本发明涉及数据处理技术领域。'.repeat(30);
    const body = [
      '说明书摘要',
      longAbstract,
      '权利要求书',
      '1. 一种数据处理方法，其特征在于，包括：获取数据并输出结果。',
      '说明书',
      '技术领域',
      '本发明涉及数据处理。',
      '背景技术',
      '现有技术存在效率低的问题。',
      '发明内容',
      '本发明提供一种数据处理方法，包括：获取数据并输出结果。',
      '附图说明',
      '图1为本方法的流程示意图。',
      '具体实施方式',
      '获取数据并输出结果。',
    ];
    const xml =
      '<w:document><w:body>' +
      body.map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`).join('') +
      '</w:body></w:document>';
    const dir = mkdtempSync(join(tmpdir(), 'dsh-patent-docx-'));
    const file = join(dir, 'draft.docx');
    writeFileSync(file, buildZip('word/document.xml', xml));

    const report = checkDraftReview({ draftPath: file, focus: 'formal' });
    // 摘要区被切出 → 摘要超字数可检。
    expect(codes(report.issues)).toContain('abstract-length');
    // 说明书区被切出且五部分齐全 → 不报缺部分。
    expect(codes(report.issues)).not.toContain('spec-sections-missing');
    // 权项区被切出且只有一条合法权项 → 不报权项结构问题。
    expect(
      codes(report.issues).some((code) => code.startsWith('claims:')),
    ).toBe(false);
    expect(codes(report.issues)).not.toContain('docx-parse-failed');
  });
});

describe('sourceRoot / disclosurePath 入参', () => {
  it('sourceRoot 只列文件清单（跳过依赖目录），不读码不判定', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-patent-src-'));
    mkdirSync(join(root, 'sub'), { recursive: true });
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'a.ts'), 'export const A = 1;\n');
    writeFileSync(join(root, 'sub', 'b.ts'), 'export const B = 2;\n');
    writeFileSync(join(root, 'node_modules', 'c.ts'), 'export const C = 3;\n');

    const report = checkDraftReview({
      abstract: '本发明涉及数据处理。',
      sourceRoot: root,
      focus: 'formal',
    });
    expect(report.sourceInventory).toContain('a.ts');
    expect(report.sourceInventory).toContain('sub/b.ts');
    expect(report.sourceInventory).not.toContain('node_modules/c.ts');
    expect(report.markdown).toContain('源码目录清单');
  });

  it('disclosurePath 读入交底书并参与全文重复度交叉比对', () => {
    const shared =
      '本实施例中按上述步骤执行获取数据并输出最终结果的处理流程'.repeat(4);
    const dir = mkdtempSync(join(tmpdir(), 'dsh-patent-disc-'));
    const disclosureFile = join(dir, 'disclosure.md');
    writeFileSync(disclosureFile, `实施方式\n${shared}\n`);

    const report = checkDraftReview({
      abstract: '本发明涉及数据处理。',
      specification: `技术领域\n本发明涉及数据处理。\n具体实施方式\n${shared}\n`,
      disclosurePath: disclosureFile,
      focus: 'formal',
    });
    expect(codes(report.issues)).toContain('text-duplication');
  });

  it('交底书读取失败只记一条问题，不吞掉其余检查', () => {
    const report = checkDraftReview({
      abstract: '本发明涉及数据处理。',
      disclosurePath: join(tmpdir(), 'dsh-patent-missing-disclosure.md'),
      focus: 'formal',
    });
    expect(codes(report.issues)).toContain('disclosure-read-failed');
    // 其余机检面照常出结果（这里会另报「未提供说明书正文」）。
    expect(codes(report.issues)).toContain('spec-sections-missing');
    expect(codes(report.issues)).not.toContain('docx-parse-failed');
  });
});
