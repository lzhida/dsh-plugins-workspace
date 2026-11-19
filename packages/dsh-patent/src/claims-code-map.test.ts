import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  checkClaimsCodeMap,
  DUAL_CARRIER_MIN_FILES,
} from './claims-code-map.ts';
import type { EvidenceEntryInput } from './claims-evidence.ts';

/** 权项正文：一个独立权项（两个分号级步骤）+ 一个从属权项。 */
const CLAIMS = [
  '1. 一种数据处理方法，其特征在于，包括：',
  '步骤一，接收待处理的数据并校验数据格式；',
  '步骤二，将校验通过的数据写入本地转义表并记录写入时间；',
  '步骤三，读取所述转义表并比对源端标识与目标端标识。',
  '2. 根据权利要求1所述的方法，其特征在于，所述转义表存储于本地存储介质。',
].join('\n');

/** 证据记录 fixture：默认带合法锚点，调用方可覆盖。 */
function entry(over: Partial<EvidenceEntryInput> = {}): EvidenceEntryInput {
  return {
    claimNo: 1,
    feature: '将校验通过的数据写入本地转义表',
    sourceAnchors: ['src/store.ts:20-30'],
    verdict: 'supported',
    severity: 'low',
    ...over,
  };
}

describe('checkClaimsCodeMap 权项-源码映射台账', () => {
  it('四态各一例:分区互不串味且行带齐位置/锚点/状态/建议', () => {
    const report = checkClaimsCodeMap({
      claims: CLAIMS,
      entries: [
        entry({
          feature: '将校验通过的数据写入本地转义表',
          verdict: 'supported',
          severity: 'low',
          suggestion: '保持现状',
        }),
        entry({
          feature: '记录写入时间',
          verdict: 'needs-rewrite',
          severity: 'medium',
          suggestion: '措辞改为「记录写入时刻」以贴合实现',
        }),
        entry({
          feature: '读取所述转义表并比对源端标识与目标端标识',
          verdict: 'unsupported',
          severity: 'critical',
          sourceAnchors: ['src/store.ts:88-92'],
          suggestion: '源码无此比对逻辑，删除该特征',
        }),
        entry({
          claimNo: null,
          feature: '源端标识的十六进制规范化',
          verdict: 'uncovered',
          severity: 'medium',
          sourceAnchors: ['src/normalize.ts:14-22'],
          suggestion: '建议补为从属权特征',
        }),
      ],
      generatedAt: '2026-11-20T00:00:00.000Z',
    });

    expect(report.sections.supported).toHaveLength(1);
    expect(report.sections.needsRewrite).toHaveLength(1);
    expect(report.sections.unsupported).toHaveLength(1);
    expect(report.sections.uncovered).toHaveLength(1);
    expect(report.sections.supported[0]?.verdictLabel).toBe('✅ 可主张');

    // 每条映射含权项位置、特征原文、源码锚点、状态、建议。
    const supported = report.sections.supported[0]!;
    expect(supported.claimPosition).toBe('权利要求 1 · 步骤 2/3');
    expect(supported.feature).toBe('将校验通过的数据写入本地转义表');
    expect(supported.sourceAnchors).toEqual(['src/store.ts:20-30']);
    expect(supported.anchorFiles).toEqual(['src/store.ts']);
    expect(supported.verdict).toBe('supported');
    expect(supported.severity).toBe('low');
    expect(supported.suggestion).toBe('保持现状');

    // 未挂权项的源码资产位置标注为「未挂权项（源码资产）」。
    expect(report.sections.uncovered[0]?.claimPosition).toBe(
      '未挂权项（源码资产）',
    );
    expect(report.stats.rows).toBe(4);
    expect(report.stats.unsupported).toBe(1);
    expect(report.stats.uncovered).toBe(1);
  });

  it('守卫:无源码锚点的判定不得进入台账(不得标为可主张)', () => {
    const report = checkClaimsCodeMap({
      claims: CLAIMS,
      entries: [
        entry({
          feature: '将校验通过的数据写入本地转义表',
          verdict: 'supported',
          sourceAnchors: [],
        }),
      ],
    });

    expect(report.sections.supported).toHaveLength(0);
    expect(report.rows).toHaveLength(0);
    expect(report.stats.rejected).toBe(1);
    expect(
      report.issues.some((issue) => issue.code === 'EVIDENCE_MISSING'),
    ).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('守卫:锚点无行号同样不得通过(证据强制)', () => {
    const report = checkClaimsCodeMap({
      claims: CLAIMS,
      entries: [
        entry({
          verdict: 'supported',
          sourceAnchors: ['src/store.ts'],
        }),
      ],
    });
    expect(report.sections.supported).toHaveLength(0);
    expect(report.stats.rejected).toBe(1);
    expect(
      report.issues.some((issue) => issue.code === 'EVIDENCE_MISSING'),
    ).toBe(true);
  });

  it('风险专章:不可主张与未覆盖各成一章', () => {
    const report = checkClaimsCodeMap({
      claims: CLAIMS,
      entries: [
        entry({
          feature: '读取所述转义表并比对源端标识与目标端标识',
          verdict: 'unsupported',
          severity: 'critical',
          sourceAnchors: ['src/store.ts:88-92'],
        }),
        entry({
          claimNo: null,
          feature: '源端标识的十六进制规范化',
          verdict: 'uncovered',
          severity: 'medium',
          sourceAnchors: ['src/normalize.ts:14-22'],
          suggestion: '建议补为从属权特征',
        }),
      ],
    });

    expect(report.risks.counterExposure.code).toBe('UNSUPPORTED');
    expect(report.risks.counterExposure.rows).toHaveLength(1);
    expect(report.risks.counterExposure.rows[0]?.feature).toBe(
      '读取所述转义表并比对源端标识与目标端标识',
    );
    expect(report.risks.protectionGap.code).toBe('UNCOVERED');
    expect(report.risks.protectionGap.rows).toHaveLength(1);

    // 代码侧资产台账:源码有、权项无保护点。
    expect(report.assetLedger).toHaveLength(1);
    expect(report.assetLedger[0]?.feature).toBe('源端标识的十六进制规范化');
    expect(report.assetLedger[0]?.sourceAnchors).toEqual([
      'src/normalize.ts:14-22',
    ]);
    expect(report.assetLedger[0]?.suggestedPlacement).toBe(
      '建议补为从属权特征',
    );
  });

  it('代码侧资产台账:无建议时给默认落点形态建议(工具不代拟权项文字)', () => {
    const report = checkClaimsCodeMap({
      claims: CLAIMS,
      entries: [
        entry({
          claimNo: null,
          feature: '源端标识的十六进制规范化',
          verdict: 'uncovered',
          severity: 'medium',
          sourceAnchors: ['src/normalize.ts:14-22'],
        }),
      ],
    });
    expect(report.assetLedger[0]?.suggestedPlacement).toContain(
      '工具不代拟权项文字',
    );
  });

  it('答辩锚点:可主张的组合特征进入锚点区并带检索风险评估位', () => {
    const report = checkClaimsCodeMap({
      claims: CLAIMS,
      entries: [
        entry({
          feature: '将校验通过的数据写入本地转义表',
          verdict: 'supported',
          severity: 'low',
          combination: true,
          searchRisk: 'low',
        }),
        entry({
          feature: '记录写入时间',
          verdict: 'needs-rewrite',
          severity: 'medium',
          combination: true,
          searchRisk: 'high',
        }),
      ],
    });

    expect(report.answerAnchors).toHaveLength(1);
    expect(report.answerAnchors[0]?.feature).toBe(
      '将校验通过的数据写入本地转义表',
    );
    expect(report.answerAnchors[0]?.searchRisk).toBe('low');
    expect(report.answerAnchors[0]?.assessment).toContain('检索风险低');

    // 判定非 supported 的组合特征不可作答辩锚点。
    expect(report.answerAnchorBlocked).toHaveLength(1);
    expect(report.answerAnchorBlocked[0]?.feature).toBe('记录写入时间');
  });

  it('我方是否实施自检:未覆盖标为潜在无效宣告/反制暴露面', () => {
    const report = checkClaimsCodeMap({
      claims: CLAIMS,
      entries: [
        entry({
          feature: '将校验通过的数据写入本地转义表',
          verdict: 'supported',
          severity: 'low',
          implementedByUs: true,
        }),
        entry({
          feature: '记录写入时间',
          verdict: 'supported',
          severity: 'low',
          implementedByUs: false,
        }),
        entry({
          feature: '读取所述转义表并比对源端标识与目标端标识',
          verdict: 'supported',
          severity: 'low',
        }),
      ],
    });

    expect(report.selfCheck).toHaveLength(3);
    expect(report.selfCheck[0]?.covered).toBe(true);
    expect(report.selfCheck[0]?.exposure).toBeNull();
    expect(report.selfCheck[1]?.covered).toBe(false);
    expect(report.selfCheck[1]?.exposure).toContain('无效宣告');
    expect(report.selfCheck[2]?.covered).toBeNull();
    expect(report.selfCheck[2]?.exposure).toBeNull();
  });

  it('双载体提示:同一特征多处主张给出并列提示', () => {
    const report = checkClaimsCodeMap({
      claims: CLAIMS,
      entries: [
        entry({
          feature: '将校验通过的数据写入本地转义表',
          verdict: 'supported',
          severity: 'low',
          docRef: '说明书第三部分',
        }),
        entry({
          claimNo: 2,
          feature: '将校验通过的数据写入本地转义表',
          verdict: 'supported',
          severity: 'low',
          docRef: '说明书第五部分',
        }),
      ],
    });

    const multi = report.dualCarrier.filter(
      (item) => item.kind === 'multi-carrier',
    );
    expect(multi).toHaveLength(1);
    expect(multi[0]?.carriers.length).toBe(2);
  });

  it('双载体提示:资产规模与权项表述不匹配(锚点横跨多文件)', () => {
    const anchors = Array.from(
      { length: DUAL_CARRIER_MIN_FILES },
      (_, i) => `src/mod-${i}.ts:${10 + i}`,
    );
    const report = checkClaimsCodeMap({
      claims: CLAIMS,
      entries: [
        entry({
          feature: '将校验通过的数据写入本地转义表',
          verdict: 'supported',
          severity: 'low',
          sourceAnchors: anchors,
        }),
      ],
    });
    const scale = report.dualCarrier.filter(
      (item) => item.kind === 'scale-mismatch',
    );
    expect(scale).toHaveLength(1);
    expect(scale[0]?.anchorFileCount).toBe(DUAL_CARRIER_MIN_FILES);
  });

  it('markdown:含四态分区、两张风险专章、锚点时间戳与免责声明', () => {
    const report = checkClaimsCodeMap({
      claims: CLAIMS,
      entries: [
        entry({
          feature: '读取所述转义表并比对源端标识与目标端标识',
          verdict: 'unsupported',
          severity: 'critical',
          sourceAnchors: ['src/store.ts:88-92'],
        }),
        entry({
          claimNo: null,
          feature: '源端标识的十六进制规范化',
          verdict: 'uncovered',
          severity: 'medium',
          sourceAnchors: ['src/normalize.ts:14-22'],
        }),
      ],
      generatedAt: '2026-11-20T00:00:00.000Z',
    });

    expect(report.markdown).toContain('出海维权证据链对照表');
    expect(report.markdown).toContain('四态分区');
    expect(report.markdown).toContain('不可主张（主张即自曝）');
    expect(report.markdown).toContain('未覆盖（保护缺口）');
    expect(report.markdown).toContain('答辩锚点');
    expect(report.markdown).toContain('代码侧资产台账');
    expect(report.markdown).toContain('我方是否实施该权项');
    expect(report.markdown).toContain('2026-11-20T00:00:00.000Z');
    expect(report.markdown).toContain('不是法律意见');
    expect(report.markdown).toContain('锚点随代码演进而漂移');
  });

  it('权项文件不可读时记诊断而非静默通过', () => {
    const report = checkClaimsCodeMap({
      claimsPath: '不存在的文件.md',
      entries: [],
    });
    expect(
      report.issues.some((issue) => issue.code === 'CLAIMS_FILE_UNREADABLE'),
    ).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('claimsPath 可读时取其中的权项正文并完成定位', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-patent-codemap-'));
    const file = join(dir, 'claims.md');
    writeFileSync(file, CLAIMS, 'utf8');
    try {
      const report = checkClaimsCodeMap({
        claimsPath: file,
        entries: [
          entry({
            feature: '将校验通过的数据写入本地转义表',
            verdict: 'supported',
            severity: 'low',
          }),
        ],
      });
      expect(report.stats.claims).toBe(2);
      expect(report.rows[0]?.claimPosition).toContain('权利要求 1');
      expect(
        report.issues.some((issue) => issue.code === 'CLAIMS_FILE_UNREADABLE'),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('同时传入 claims 与 claimsPath 时记歧义警告(以 claims 为准)', () => {
    const report = checkClaimsCodeMap({
      claims: CLAIMS,
      claimsPath: '任意路径.md',
      entries: [],
    });
    const issue = report.issues.find(
      (item) => item.code === 'CLAIMS_SOURCE_AMBIGUOUS',
    );
    expect(issue?.severity).toBe('warning');
    expect(report.ok).toBe(true);
  });

  it('sourceRoot 给出清单;目录不存在时记警告而非静默为空', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-patent-codemap-src-'));
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n', 'utf8');
    try {
      const ok = checkClaimsCodeMap({
        claims: CLAIMS,
        entries: [],
        sourceRoot: dir,
      });
      expect(ok.sourceInventory.length).toBeGreaterThan(0);
      expect(
        ok.issues.some((issue) => issue.code === 'SOURCE_ROOT_EMPTY'),
      ).toBe(false);

      const missing = checkClaimsCodeMap({
        claims: CLAIMS,
        entries: [],
        sourceRoot: join(dir, 'not-here'),
      });
      expect(
        missing.issues.some((issue) => issue.code === 'SOURCE_ROOT_EMPTY'),
      ).toBe(true);
      expect(missing.sourceInventory).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('定位:特征原文长于步骤文本时标为启发式定位而非逐字命中', () => {
    const claims = [
      '1. 一种数据处理方法，其特征在于，包括：',
      '接收待处理的数据并校验数据格式；',
      '记录校验结果。',
    ].join('\n');
    const report = checkClaimsCodeMap({
      claims,
      entries: [
        entry({
          feature: '接收待处理的数据并校验数据格式并记录校验结果',
          verdict: 'supported',
          severity: 'low',
        }),
      ],
    });
    // 特征原文包含步骤文本但更长 → 宽松命中,须标「启发式定位」。
    expect(report.rows[0]?.claimPosition).toContain('启发式定位');
  });

  it('markdown:含从属链失实传导节与源码目录清单节', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-patent-codemap-md-'));
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n', 'utf8');
    try {
      const report = checkClaimsCodeMap({
        claims: CLAIMS,
        entries: [
          entry({
            claimNo: 1,
            feature: '读取所述转义表并比对源端标识与目标端标识',
            verdict: 'unsupported',
            severity: 'critical',
            sourceAnchors: ['src/store.ts:88-92'],
          }),
          entry({
            claimNo: 2,
            feature: '将校验通过的数据写入本地转义表',
            verdict: 'supported',
            severity: 'low',
          }),
        ],
        sourceRoot: dir,
      });
      // 权 2 从属于权 1,权 1 有不可主张特征 → 退守防线传导。
      expect(report.fallbackRisks.length).toBeGreaterThan(0);
      expect(report.markdown).toContain('从属链失实传导');
      expect(report.markdown).toContain('源码目录清单');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
