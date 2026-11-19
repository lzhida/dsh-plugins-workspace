import { describe, expect, it } from 'vitest';

import { checkClaimsAbDiff } from './claims-ab-diff.ts';

const PUBLIC_CLAIMS = [
  '1. 一种数据传输方法，其特征在于，接收待处理的数据并校验数据格式，记录校验结果。',
  '2. 根据权利要求1所述的方法，其特征在于，将校验结果写入本地转义表。',
  '3. 根据权利要求2所述的方法，其特征在于，上传所述转义表至服务端。',
].join('\n');

const GRANTED_MERGED = [
  '1. 一种数据传输方法，其特征在于，接收待处理的数据并校验数据格式，记录校验结果，将校验结果写入本地转义表。',
  '2. 根据权利要求1所述的方法，其特征在于，上传所述转义表至服务端。',
].join('\n');

const GRANTED_RENUMBERED = [
  '1. 一种数据传输方法，其特征在于，接收待处理的数据并校验数据格式，记录校验结果。',
  '2. 根据权利要求1所述的方法，其特征在于，上传所述转义表至服务端。',
].join('\n');

describe('checkClaimsAbDiff A/B 权利要求差异', () => {
  it('从权特征并入独权时归类为并入独权', () => {
    const report = checkClaimsAbDiff({
      publicText: PUBLIC_CLAIMS,
      grantedText: GRANTED_MERGED,
    });
    expect(report.stats.publicClaims).toBe(3);
    expect(report.stats.grantedClaims).toBe(2);
    const merged = report.rows.filter(
      (r) => r.mode === 'merged-into-independent',
    );
    expect(merged.length).toBeGreaterThanOrEqual(1);
    expect(merged[0].aNumber).toBe(2);
    expect(merged[0].detail).toContain('并入');
  });

  it('从权换号并改引用基准时同时归类为重编号与引用基准迁移', () => {
    const report = checkClaimsAbDiff({
      publicText: PUBLIC_CLAIMS,
      grantedText: GRANTED_RENUMBERED,
    });
    const renumbered = report.rows.filter(
      (r) => r.mode === 'renumbered-dependent',
    );
    const shifted = report.rows.filter(
      (r) => r.mode === 'reference-base-shift',
    );
    expect(renumbered.length).toBeGreaterThanOrEqual(1);
    expect(renumbered[0].aNumber).toBe(3);
    expect(renumbered[0].bNumber).toBe(2);
    expect(shifted.length).toBeGreaterThanOrEqual(1);
    expect(shifted[0].aNumber).toBe(3);
  });

  it('两份文本一致时不产出差异行', () => {
    const report = checkClaimsAbDiff({
      publicText: PUBLIC_CLAIMS,
      grantedText: PUBLIC_CLAIMS,
    });
    expect(report.rows.length).toBe(0);
    expect(report.stats.unchanged).toBe(3);
    expect(report.ok).toBe(true);
  });

  it('缺少任一文本时报输入缺失并给出可读错误', () => {
    const report = checkClaimsAbDiff({ publicText: PUBLIC_CLAIMS });
    expect(report.ok).toBe(false);
    expect(report.issues[0].code).toBe('AB_INPUT_MISSING');
    expect(report.markdown).toContain('缺少公开文本或授权文本');
  });

  it('公开权项在授权文本无承接时报权项遗失', () => {
    const report = checkClaimsAbDiff({
      publicText: PUBLIC_CLAIMS,
      grantedText: '1. 一种其它方法，其特征在于，与数据校验无关的处理步骤。',
    });
    expect(report.issues.some((i) => i.code === 'AB_CLAIM_DROPPED')).toBe(true);
    expect(report.issues.some((i) => i.code === 'AB_CLAIM_ADDED')).toBe(true);
  });

  it('非权项部分不一致时报提示（说明书与附图通常逐字不变）', () => {
    const report = checkClaimsAbDiff({
      publicText: PUBLIC_CLAIMS,
      grantedText: PUBLIC_CLAIMS,
      publicDocument:
        '发明名称：一种数据传输方法\n\n说明书\n本发明涉及数据传输。',
      grantedDocument:
        '发明名称：一种数据传输方法\n\n说明书\n本发明涉及高速数据传输。',
    });
    expect(report.issues.some((i) => i.code === 'AB_NON_CLAIM_CHANGED')).toBe(
      true,
    );
  });

  it('授权文本自身的结构诊断沿用 checkClaims 口径', () => {
    const report = checkClaimsAbDiff({
      publicText: PUBLIC_CLAIMS,
      grantedText:
        '1. 一种方法，其特征在于，特征。\n2. 根据权利要求9所述的方法，其特征在于，另一特征。',
    });
    expect(
      report.issues.some((i) =>
        i.code.startsWith('AB_SOURCE_CLAIM_REF_MISSING'),
      ),
    ).toBe(true);
  });

  it('markdown 报告含差异清单与统计', () => {
    const report = checkClaimsAbDiff({
      publicText: PUBLIC_CLAIMS,
      grantedText: GRANTED_MERGED,
    });
    expect(report.markdown).toContain('A/B 权利要求差异报告');
    expect(report.markdown).toContain('## 一、差异清单');
    expect(report.markdown).toContain('并入独权');
  });
});
