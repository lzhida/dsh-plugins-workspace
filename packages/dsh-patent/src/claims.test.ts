import { describe, expect, it } from 'vitest';

import { checkClaims, parseClaims } from './claims.ts';

describe('dsh-patent', () => {
  describe('parseClaims', () => {
    it('解析编号、从属关系、范围引用与主题名称', () => {
      const input = [
        '1.一种车载充电桩在线升级方法，其特征在于，包括以下步骤：',
        '获取充电桩的当前固件版本；',
        '根据所述当前固件版本下载升级包。',
        '2.根据权利要求1所述的车载充电桩在线升级方法，其特征在于，所述下载升级包包括：',
        '校验升级包的签名。',
        '3.根据权利要求1至2中任一项所述的车载充电桩在线升级方法，其特征在于：',
        '所述签名采用国密算法。',
      ].join('\n');

      const claims = parseClaims(input);
      expect(claims).toHaveLength(3);
      expect(claims[0]?.number).toBe(1);
      expect(claims[0]?.isDependent).toBe(false);
      expect(claims[0]?.subjectName).toBe('车载充电桩在线升级方法');
      expect(claims[0]?.hasCharacterizingPart).toBe(true);
      expect(claims[1]?.isDependent).toBe(true);
      expect(claims[1]?.references).toEqual([1]);
      expect(claims[1]?.subjectName).toBe('车载充电桩在线升级方法');
      expect(claims[2]?.references).toEqual([1, 2]);
    });

    it('容忍全角编号与条内换行', () => {
      const input =
        '1．一种无线通信方法，其特征在于：\n执行安全验证；\n\n2、根据权利要求1所述的无线通信方法，其特征在于：执行多维验证。';
      const claims = parseClaims(input);
      expect(claims.map((c) => c.number)).toEqual([1, 2]);
      expect(claims[0]?.hasCharacterizingPart).toBe(true);
    });
  });

  describe('checkClaims 结构规则', () => {
    const goodTree = [
      '1.一种数据传输方法，其特征在于，包括：接收数据帧；校验所述数据帧的校验位。',
      '2.根据权利要求1所述的数据传输方法，其特征在于，所述校验位为CRC校验位。',
      '3.根据权利要求1或2所述的数据传输方法，其特征在于，所述数据帧为以太网帧。',
      '4.一种数据传输系统，其特征在于，包括：接收模块，用于接收数据帧。',
    ].join('\n');

    it('合法权利要求树：无 error，统计正确', () => {
      const report = checkClaims(goodTree);
      expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.stats).toEqual({
        total: 4,
        independent: 2,
        dependent: 2,
        multiDependent: 1,
      });
    });

    it('编号跳号报 CLAIM_NUMBER_GAP', () => {
      const report = checkClaims(
        [
          '1.一种方法A，其特征在于：执行步骤a。',
          '3.根据权利要求1所述的方法A，其特征在于：所述步骤a为加密。',
        ].join('\n'),
      );
      expect(report.issues.some((i) => i.code === 'CLAIM_NUMBER_GAP')).toBe(
        true,
      );
      expect(report.ok).toBe(false);
    });

    it('重复编号报 CLAIM_DUP_NUMBER', () => {
      const report = checkClaims(
        [
          '1.一种方法A，其特征在于：执行步骤a。',
          '1.一种系统B，其特征在于：包括模块b。',
        ].join('\n'),
      );
      expect(report.issues.some((i) => i.code === 'CLAIM_DUP_NUMBER')).toBe(
        true,
      );
    });

    it('引用在后的权利要求报 CLAIM_REF_FORWARD', () => {
      const report = checkClaims(
        [
          '1.一种方法A，其特征在于：执行步骤a。',
          '2.一种方法B，其特征在于：执行步骤b。',
          '3.根据权利要求4所述的方法A，其特征在于：所述步骤b为加密。',
          '4.一种方法D，其特征在于：执行步骤d。',
        ].join('\n'),
      );
      expect(
        report.issues.some(
          (i) => i.code === 'CLAIM_REF_FORWARD' && i.claim === 3,
        ),
      ).toBe(true);
    });

    it('引用不存在的权利要求报 CLAIM_REF_MISSING（且与在后引用并存）', () => {
      const report = checkClaims(
        [
          '1.一种方法A，其特征在于：执行步骤a。',
          '2.根据权利要求5所述的方法A，其特征在于：所述步骤a为加密。',
        ].join('\n'),
      );
      expect(report.issues.some((i) => i.code === 'CLAIM_REF_MISSING')).toBe(
        true,
      );
      expect(report.issues.some((i) => i.code === 'CLAIM_REF_FORWARD')).toBe(
        true,
      );
    });

    it('多项从属引用多项从属报 CLAIM_MULTI_ON_MULTI', () => {
      const report = checkClaims(
        [
          '1.一种方法A，其特征在于：执行步骤a。',
          '2.根据权利要求1所述的方法A，其特征在于：所述步骤a为加密。',
          '3.根据权利要求1或2所述的方法A，其特征在于：所述加密为对称加密。',
          '4.根据权利要求1至3中任一项所述的方法A，其特征在于：所述对称加密为SM4。',
        ].join('\n'),
      );
      const multi = report.issues.filter(
        (i) => i.code === 'CLAIM_MULTI_ON_MULTI',
      );
      expect(multi.length).toBeGreaterThan(0);
      expect(multi[0]?.claim).toBe(4);
      expect(report.ok).toBe(false);
    });

    it('从属主题名称与被引用项不一致报 CLAIM_SUBJECT_MISMATCH', () => {
      const report = checkClaims(
        [
          '1.一种数据传输方法，其特征在于：接收数据帧。',
          '2.根据权利要求1所述的数据传输系统，其特征在于：所述数据帧为以太网帧。',
        ].join('\n'),
      );
      expect(
        report.issues.some((i) => i.code === 'CLAIM_SUBJECT_MISMATCH'),
      ).toBe(true);
    });

    it('独立权利要求缺「其特征在于」报 warning 且不阻断 ok', () => {
      const report = checkClaims('1.一种数据传输方法，包括：接收数据帧。');
      const issue = report.issues.find(
        (i) => i.code === 'CLAIM_NO_CHARACTERIZING',
      );
      expect(issue?.severity).toBe('warning');
      expect(report.ok).toBe(true);
    });

    it('第 1 项为从属报 CLAIM_FIRST_DEPENDENT', () => {
      const report = checkClaims(
        [
          '1.根据权利要求2所述的方法A，其特征在于：所述步骤a为加密。',
          '2.一种方法A，其特征在于：执行步骤a。',
        ].join('\n'),
      );
      expect(
        report.issues.some((i) => i.code === 'CLAIM_FIRST_DEPENDENT'),
      ).toBe(true);
    });

    it('空输入报 CLAIMS_EMPTY', () => {
      const report = checkClaims('   \n  ');
      expect(report.issues.some((i) => i.code === 'CLAIMS_EMPTY')).toBe(true);
      expect(report.ok).toBe(false);
    });

    it('含「权利要求N」但无规范引用句式报 CLAIM_REF_FORMAT', () => {
      const report = checkClaims(
        '1.一种方法A，其特征在于：执行权利要求1中定义的步骤a。',
      );
      expect(report.issues.some((i) => i.code === 'CLAIM_REF_FORMAT')).toBe(
        true,
      );
    });
  });
});
