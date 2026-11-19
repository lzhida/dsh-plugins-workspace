import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildCaseIndex } from './case-index.ts';
import { checkClaimsAbDiff } from './claims-ab-diff.ts';
import {
  checkFigureManifest,
  extractFigureSection,
  figureNumberFromName,
} from './figure-manifest.ts';

/**
 * 复审要求的回归用例：集中钉住上一轮审查点出的误报/漏报路径。
 */
describe('进阶分析工具复审回归', () => {
  it('承接度落在并入窗口时不再自相矛盾（回写承接权号并撤回丢弃诊断）', () => {
    const publicText = [
      '1. 一种数据传输方法，其特征在于，接收待处理的数据并校验数据格式，所述校验结果写入本地转义表并同步至服务端。',
      '2. 根据权利要求1所述的方法，其特征在于，所述校验结果写入本地转义表并同步至服务端，并在服务端失败时回滚本地记录。',
    ].join('\n');
    const grantedText = [
      '1. 一种数据传输方法，其特征在于，接收待处理的数据并校验数据格式，所述校验结果写入本地转义表并同步至服务端，并对同步失败的条目重试。',
    ].join('\n');

    const report = checkClaimsAbDiff({ publicText, grantedText });
    const pair = report.pairs.find((p) => p.aNumber === 2);

    expect(pair).toBeTruthy();
    expect(pair?.bNumber).toBe(1);
    expect(pair?.modes).toContain('merged-into-independent');
    expect(
      pair?.detail.some((d) => d.includes('未在授权文本中找到承接该特征')),
    ).toBe(false);
    expect(
      report.issues.some(
        (i) => i.code === 'AB_CLAIM_DROPPED' && i.aNumber === 2,
      ),
    ).toBe(false);
  });

  it('权项书用 markdown 标题时非权项逐字核对不误报', () => {
    const body = [
      '## 说明书摘要',
      '本发明公开一种数据传输方法，用于校验数据格式并同步校验结果。',
      '## 权利要求书',
      '1. 一种数据传输方法，其特征在于，接收待处理的数据并校验数据格式。',
      '## 说明书',
      '技术领域：本发明涉及数据传输。',
      '背景技术：现有技术缺少格式校验。',
    ].join('\n');
    const grantedBody = body.replace(
      '1. 一种数据传输方法，其特征在于，接收待处理的数据并校验数据格式。',
      '1. 一种数据传输方法，其特征在于，接收待处理的数据并校验数据格式，所述校验结果写入本地转义表。',
    );

    const report = checkClaimsAbDiff({
      publicText:
        '1. 一种数据传输方法，其特征在于，接收待处理的数据并校验数据格式。',
      grantedText:
        '1. 一种数据传输方法，其特征在于，接收待处理的数据并校验数据格式，所述校验结果写入本地转义表。',
      publicDocument: body,
      grantedDocument: grantedBody,
    });

    expect(report.issues.some((i) => i.code === 'AB_NON_CLAIM_CHANGED')).toBe(
      false,
    );
  });

  it('旧称是新称前缀时图面已用新称不判图文分裂', () => {
    const report = checkFigureManifest({
      disclosure: '## 七、附图要求\n图1是结构示意图。',
      document: '如图1所示。',
      figureText: [{ figure: 1, text: '本图示出导线组件的连接关系。' }],
      termRenames: [{ old: '导线', new: '导线组件' }],
    });

    expect(report.issues.some((i) => i.code === 'FIG_TEXT_TERM_SPLIT')).toBe(
      false,
    );
  });

  it('文件名里的版本号不当图号，纯数字文件名仍兜底', () => {
    expect(figureNumberFromName('backup_09.png')).toBeNull();
    expect(figureNumberFromName('scan-2024-final.png')).toBeNull();
    expect(figureNumberFromName('fig3.png')).toBe(3);
    expect(figureNumberFromName('图2.png')).toBe(2);
    expect(figureNumberFromName('9.png')).toBe(9);
  });

  it('正文提到附图不会被当成附图清单小节', () => {
    const section = extractFigureSection(
      [
        '## 技术方案',
        '本发明结合附图1所示的整体结构展开。',
        '图3是现有技术的示意图。',
      ].join('\n'),
    );

    expect(section).not.toContain('图3是现有技术的示意图');
  });

  it('只提供部分图的标记时，未提供标记的图不报缺标记', () => {
    const report = checkFigureManifest({
      disclosure: [
        '## 七、附图要求',
        '图1是整体流程图。',
        '图2是结构示意图。',
        '本发明标注附图标记（100/110/120）。',
      ].join('\n'),
      document: '如图1所示。',
      figureMarks: [{ figure: 2, marks: ['100', '110', '120'] }],
    });

    expect(
      report.issues.some(
        (i) => i.code === 'FIG_MARK_MISSING' && i.figure === 1,
      ),
    ).toBe(false);
  });

  it('旁挂元数据损坏时给出警告而不是静默回落', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-case-'));
    try {
      writeFileSync(
        join(dir, 'a.md'),
        [
          '# 某交底书',
          '## 一、背景技术',
          '本领域已有若干方案，其不足在于没有统一的格式校验与结果同步机制，部署成本较高。',
          '## 二、背景技术的技术问题',
          '因此需要一个能够把校验结果写入本地转义表并同步至服务端的机制，以降低多端不一致的风险。',
          '## 三、本案的详细阐述',
          '本方案通过统一入口接收待处理的数据，完成格式校验后写入本地转义表，并在网络可用时同步至服务端。',
        ].join('\n'),
        'utf8',
      );
      writeFileSync(join(dir, 'a.md.case.json'), '{ broken json', 'utf8');

      const report = buildCaseIndex(dir);

      expect(report.issues.some((i) => i.code === 'CASE_SIDECAR_INVALID')).toBe(
        true,
      );
      expect(report.cases.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
