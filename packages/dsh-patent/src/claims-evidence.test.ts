import { describe, expect, it } from 'vitest';

import {
  checkClaimsEvidence,
  type EvidenceEntryInput,
} from './claims-evidence.ts';
import { buildPatentTools } from './tools.ts';
import type { DisclosureDefaults } from './config.ts';

/** 权项 fixture:1 独立,2 从属 1,3 从属「1 或 2」。 */
const CLAIMS = [
  '1. 一种数据写入方法,其特征在于,包括:对接收的配置数据进行校验;将校验通过的配置数据写入目标存储。',
  '2. 根据权利要求1所述的数据写入方法,其特征在于,所述校验包括对数据长度进行校验。',
  '3. 根据权利要求1或2所述的数据写入方法,其特征在于,还包括写入完成后回读比对。',
].join('\n');

/** 标准七部分交底书骨架(供 document 参数)。 */
const DOCUMENT = [
  '## 一、背景技术',
  '## 二、背景技术的技术问题',
  '## 三、本案的详细阐述',
  '## 四、第三项的技术方案中有无可以替代的地方',
  '## 五、第三项的技术手段产生了什么技术效果',
  '## 六、本案需要保护的要点',
  '## 七、附图要求',
].join('\n');

/** 证据记录 fixture(合法基线,逐字段覆盖)。 */
function entry(over: Partial<EvidenceEntryInput> = {}): EvidenceEntryInput {
  return {
    claimNo: 1,
    feature: '对接收的配置数据进行校验',
    docRef: '三、第 1 段',
    sourceAnchors: ['src/write.ts:10-20'],
    verdict: 'supported',
    severity: 'low',
    ...over,
  };
}

const defaults: DisclosureDefaults = {
  internalNo: '',
  applicant: '',
  contactName: '',
  contactPhone: '',
  contactEmail: '',
};

describe('checkClaimsEvidence 权项源码对账', () => {
  it('四态判定各归其位:矩阵汇总、未覆盖清单与统计', () => {
    const report = checkClaimsEvidence({
      claims: CLAIMS,
      entries: [
        entry(),
        entry({
          feature: '按行写入',
          verdict: 'needs-rewrite',
          severity: 'medium',
        }),
        entry({
          feature: '写入前压缩',
          verdict: 'unsupported',
          severity: 'critical',
        }),
        entry({
          claimNo: null,
          feature: 'CRC 校验重算比对',
          verdict: 'uncovered',
          severity: 'medium',
        }),
      ],
      document: DOCUMENT,
    });
    expect(report.ok).toBe(true);
    expect(report.stats).toEqual({
      claims: 3,
      entries: 4,
      rejected: 0,
      uncoveredCount: 1,
    });
    expect(report.matrix).toEqual([
      { claimNo: 1, total: 3, supported: 1, needsRewrite: 1, unsupported: 1 },
    ]);
    expect(report.uncovered).toHaveLength(1);
    expect(report.uncovered[0]!.feature).toBe('CRC 校验重算比对');
  });

  it('证据强制:无源码锚点或锚点无行号的判定一律拒绝且不进矩阵', () => {
    const report = checkClaimsEvidence({
      claims: CLAIMS,
      entries: [
        entry({ feature: '甲', sourceAnchors: [] }),
        entry({ feature: '乙', sourceAnchors: undefined }),
        entry({ feature: '丙', sourceAnchors: ['src/a.ts 无行号'] }),
        entry({ feature: '丁', sourceAnchors: ['src/b.ts:5-8'] }),
      ],
    });
    expect(report.stats.rejected).toBe(3);
    expect(report.stats.entries).toBe(1);
    expect(report.entries.map((e) => e.feature)).toEqual(['丁']);
    const missing = report.issues.filter((i) => i.code === 'EVIDENCE_MISSING');
    expect(missing).toHaveLength(3);
    expect(missing.every((i) => i.severity === 'error')).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('记录缺特征或判定/严重度非法时报 ENTRY_INVALID 并拒绝该条', () => {
    const report = checkClaimsEvidence({
      claims: CLAIMS,
      entries: [
        entry({ feature: '  ' }),
        entry({ verdict: 'maybe' }),
        entry({ severity: 'urgent' }),
      ],
    });
    expect(report.stats.rejected).toBe(3);
    expect(
      report.issues.filter((i) => i.code === 'ENTRY_INVALID'),
    ).toHaveLength(3);
  });

  it('载体归属矛盾:权项与说明书把同一特征归到不同载体即告警,归一后一致不告警', () => {
    const report = checkClaimsEvidence({
      claims: CLAIMS,
      entries: [
        entry({
          claimCarrier: '协议描述文件',
          docCarrier: '命令实现',
        }),
        entry({
          feature: '另一特征',
          claimCarrier: '所述的命令实现',
          docCarrier: '命令实现',
        }),
      ],
    });
    const mismatch = report.issues.filter((i) => i.code === 'CARRIER_MISMATCH');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]!.claimNo).toBe(1);
    expect(mismatch[0]!.message).toContain('协议描述文件');
    expect(mismatch[0]!.message).toContain('命令实现');
  });

  it('不可主张但严重度偏低时提示 SEVERITY_MISMATCH,critical 不提示', () => {
    const report = checkClaimsEvidence({
      claims: CLAIMS,
      entries: [
        entry({
          feature: '低危不可主张',
          verdict: 'unsupported',
          severity: 'low',
        }),
        entry({
          feature: '高危不可主张',
          verdict: 'unsupported',
          severity: 'critical',
        }),
      ],
    });
    const mismatch = report.issues.filter(
      (i) => i.code === 'SEVERITY_MISMATCH',
    );
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]!.message).toContain('低危不可主张');
  });

  it('覆盖完整性:每条权利要求至少一条证据记录,缺失即告警', () => {
    const report = checkClaimsEvidence({
      claims: CLAIMS,
      entries: [entry()],
    });
    const gaps = report.issues.filter((i) => i.code === 'CLAIM_NO_EVIDENCE');
    expect(gaps.map((i) => i.claimNo).sort()).toEqual([2, 3]);
  });

  it('退守防线:从属链被失实特征污染即报风险,并列引用基准单列分支', () => {
    const report = checkClaimsEvidence({
      claims: CLAIMS,
      entries: [
        entry({
          feature: '基准特征失实',
          verdict: 'unsupported',
          severity: 'critical',
        }),
        entry({
          claimNo: 2,
          feature: '长度校验',
          verdict: 'supported',
          severity: 'low',
        }),
      ],
    });
    expect(report.fallback.branches).toEqual([
      { claimNo: 1, referencedBy: [2, 3] },
    ]);
    expect(report.fallback.risks).toHaveLength(2);
    const chains = report.fallback.risks.map((r) => r.chain);
    expect(chains).toContainEqual([2, 1]);
    expect(chains).toContainEqual([3, 2, 1]);
    for (const risk of report.fallback.risks) {
      expect(risk.poisonedBy).toEqual([1]);
      expect(risk.verdicts).toEqual(['unsupported']);
    }
  });

  it('文档结构提醒:缺七部分标题即警告,完整骨架不告警', () => {
    const bare = checkClaimsEvidence({
      claims: CLAIMS,
      entries: [entry()],
      document: '第一部分 背景\n正文内容若干。',
    });
    expect(bare.issues.some((i) => i.code === 'DOCUMENT_STRUCTURE')).toBe(true);
    const full = checkClaimsEvidence({
      claims: CLAIMS,
      entries: [entry()],
      document: DOCUMENT,
    });
    expect(full.issues.some((i) => i.code === 'DOCUMENT_STRUCTURE')).toBe(
      false,
    );
  });

  it('entries 非数组报 ENTRIES_INVALID,markdown 含矩阵表头与未覆盖资产节', () => {
    const bad = checkClaimsEvidence({ claims: CLAIMS, entries: 'not-array' });
    expect(bad.issues.some((i) => i.code === 'ENTRIES_INVALID')).toBe(true);
    expect(bad.ok).toBe(false);

    const report = checkClaimsEvidence({
      claims: CLAIMS,
      entries: [
        entry({ verdict: 'unsupported', severity: 'critical' }),
        entry({
          claimNo: null,
          feature: 'CRC 校验重算比对',
          verdict: 'uncovered',
          severity: 'medium',
        }),
      ],
    });
    expect(report.markdown).toContain('| 权项 | 特征 |');
    expect(report.markdown).toContain('❌ 不可主张');
    expect(report.markdown).toContain('⬜ 未覆盖');
    expect(report.markdown).toContain('未覆盖资产');
  });
});

describe('claims_evidence_check 工具注册', () => {
  it('注册为第四个专利工具并可直接执行', async () => {
    const tools = buildPatentTools(() => defaults);
    const tool = tools.find((t) => t.name === 'claims_evidence_check');
    expect(tool).toBeDefined();
    // defineTool 的 execute 类型签名是 (args, exec) 两参;本工具不读 exec。
    const report = (await tool!.execute(
      {
        claims: CLAIMS,
        entries: [entry()],
        document: DOCUMENT,
      },
      {} as never,
    )) as { ok: boolean; stats: { claims: number; entries: number } };
    expect(report.ok).toBe(true);
    expect(report.stats.claims).toBe(3);
    expect(report.stats.entries).toBe(1);
  });
});

describe('源码核对清单(工具给清单、模型读码)', () => {
  const CLAIMS_WITH_TECH = [
    '1. 一种数据写入方法,其特征在于,包括:读取 config/limits.json 中的 MAX_RETRY 常量;调用 writeBlock() 将数据写入存储;当写入长度超过阈值时执行回读比对。',
    '2. 根据权利要求1所述的数据写入方法,其特征在于,所述校验包括按枚举 WRITE_MODE 的取值分支处理。',
    '3. 根据权利要求1所述的数据写入方法,其特征在于,包括第一层校验与第二层校验两个阶段。',
  ].join('\n');

  it('从权项文本抽取六类维度的待核对线索', () => {
    const report = checkClaimsEvidence({
      claims: CLAIMS_WITH_TECH,
      entries: [entry()],
    });
    const dims = report.checklist.map((item) => item.dimension);
    expect(dims).toContain('constant');
    expect(dims).toContain('path');
    expect(dims).toContain('function');
    expect(dims).toContain('enum');
    expect(dims).toContain('hierarchy');
    expect(dims).toContain('branch');
    const constant = report.checklist.find((i) => i.dimension === 'constant')!;
    expect(constant.samples).toContain('MAX_RETRY');
    expect(constant.claimNos).toContain(1);
    const path = report.checklist.find((i) => i.dimension === 'path')!;
    expect(path.samples).toContain('config/limits.json');
    const fn = report.checklist.find((i) => i.dimension === 'function')!;
    expect(fn.samples).toContain('writeBlock');
  });

  it('markdown 顶部给出待核对清单段', () => {
    const report = checkClaimsEvidence({
      claims: CLAIMS_WITH_TECH,
      entries: [entry()],
    });
    expect(report.markdown).toContain('待核对清单');
    expect(report.markdown).toContain('MAX_RETRY');
  });

  it('权项无技术线索时清单为空(不臆造核对项)', () => {
    const report = checkClaimsEvidence({ claims: CLAIMS, entries: [entry()] });
    expect(report.checklist).toEqual([]);
  });
});

describe('边界与健壮性', () => {
  it('verdict 非法与锚点缺失并存时优先报结构错误(ENTRY_INVALID)', () => {
    const report = checkClaimsEvidence({
      claims: CLAIMS,
      entries: [entry({ verdict: 'bogus' as never, sourceAnchors: undefined })],
    });
    expect(report.stats.rejected).toBe(1);
    expect(report.issues.some((i) => i.code === 'ENTRY_INVALID')).toBe(true);
  });

  it('全角冒号锚点不被当作文件:行号(拒绝)', () => {
    const report = checkClaimsEvidence({
      claims: CLAIMS,
      entries: [entry({ sourceAnchors: ['src/a.ts：10'] })],
    });
    expect(report.stats.rejected).toBe(1);
    expect(report.issues.some((i) => i.code === 'EVIDENCE_MISSING')).toBe(true);
  });

  it('环形引用不导致死循环(退守防线按环截断)', () => {
    const cyclic = [
      '1. 根据权利要求2所述的方法,其特征在于,包括步骤a。',
      '2. 根据权利要求1所述的方法,其特征在于,包括步骤b。',
    ].join('\n');
    const report = checkClaimsEvidence({
      claims: cyclic,
      entries: [entry({ claimNo: 1 }), entry({ claimNo: 2, feature: '步骤b' })],
    });
    expect(report.stats.claims).toBe(2);
    expect(report.fallback.risks).toEqual([]);
  });

  it('markdown 表格单元格里的竖线被转义(不破坏列)', () => {
    const report = checkClaimsEvidence({
      claims: CLAIMS,
      entries: [
        entry({
          feature: '配置项 a|b',
          docRef: '三、段落 x|y',
          suggestion: '改为 a 或 b',
        }),
      ],
    });
    expect(report.markdown).toContain('配置项 a\\|b');
    expect(report.markdown).toContain('三、段落 x\\|y');
  });

  it('权项为空时给出 CLAIMS_EMPTY 提醒(不静默通过)', () => {
    const report = checkClaimsEvidence({ claims: '', entries: [] });
    expect(report.issues.some((i) => i.code === 'CLAIMS_EMPTY')).toBe(true);
    expect(report.stats.claims).toBe(0);
  });
});
