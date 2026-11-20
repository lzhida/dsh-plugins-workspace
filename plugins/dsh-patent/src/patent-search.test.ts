import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildPatentSearchReport,
  computeDateTier,
  fetchGooglePatents,
  fieldsFromJsonObject,
  hasLiteralOverlap,
  normalizeDate,
  normalizePatentRecord,
  normalizePublicationNumber,
} from './patent-search.ts';

describe('patent-search 公布号与日期归一', () => {
  it('归一各局公布号:CN/US/EP/WO 的分隔符与种类码', () => {
    expect(normalizePublicationNumber('CN 122824595 A').number).toBe(
      'CN122824595A',
    );
    expect(normalizePublicationNumber('CN122824595A').number).toBe(
      'CN122824595A',
    );
    expect(normalizePublicationNumber('US 11,074,495 B2').number).toBe(
      'US11074495B2',
    );
    expect(normalizePublicationNumber('EP 1 000 000 A1').number).toBe(
      'EP1000000A1',
    );
    expect(normalizePublicationNumber('WO 2021/000001 A1').number).toBe(
      'WO2021000001A1',
    );
  });

  it('归一公布号带出所属局与种类码', () => {
    const cn = normalizePublicationNumber('CN122824595A');
    expect(cn.kind).toBe('CN');
    expect(cn.kindCode).toBe('A');
    expect(cn.matched).toBe(true);
    const us = normalizePublicationNumber('US11074495B2');
    expect(us.kind).toBe('US');
    expect(us.kindCode).toBe('B');
  });

  it('非公布号文本不硬拼,仅去空白大写并标未命中', () => {
    const parsed = normalizePublicationNumber('某方法及装置');
    expect(parsed.matched).toBe(false);
    expect(parsed.kind).toBe('OTHER');
    expect(parsed.number).toBe('某方法及装置');
  });

  it('归一多种日期写法并拒绝非法值', () => {
    expect(normalizeDate('2024-05-06')).toBe('2024-05-06');
    expect(normalizeDate('2024/5/6')).toBe('2024-05-06');
    expect(normalizeDate('2024.05.06')).toBe('2024-05-06');
    expect(normalizeDate('2024年5月6日')).toBe('2024-05-06');
    expect(normalizeDate('20240506')).toBe('2024-05-06');
    expect(normalizeDate('not a date')).toBeNull();
    expect(normalizeDate('2024-13-40')).toBeNull();
    expect(normalizeDate(null)).toBeNull();
  });
});

describe('patent-search 记录抽取与归一', () => {
  it('从 provider JSON 抽取字段(键名变体归一)', () => {
    const fields = fieldsFromJsonObject({
      publication_number: 'CN120915859A',
      title: '一种协议解析方法',
      assignee: '某科技有限公司',
      filing_date: '2023-04-12',
      publication_date: '2023-07-18',
      cpc: 'H04L12/24',
    });
    expect(fields.publicationNumber).toBe('CN120915859A');
    expect(fields.applicant).toBe('某科技有限公司');
    expect(fields.applicationDate).toBe('2023-04-12');
    expect(fields.ipc).toEqual(['H04L12/24']);
  });

  it('归正 JSON 记录为结构化记录', () => {
    const record = normalizePatentRecord({
      publication_number: 'CN122824595A',
      title: '一种设备端界面生成方法',
      applicant: '某设备公司',
      filing_date: '2024-01-08',
      publication_date: '2024-04-09',
      abstract: '本发明公开了一种界面生成方法。',
    });
    expect(record.publicationNumber).toBe('CN122824595A');
    expect(record.publicationKind).toBe('CN');
    expect(record.applicationDate).toBe('2024-01-08');
    expect(record.publicationDate).toBe('2024-04-09');
    expect(record.abstract).toContain('界面生成');
  });

  it('从自由文本抽取字段并归一公布号', () => {
    const record = normalizePatentRecord(
      [
        '公布号：CN 111767240 B',
        '发明名称：一种上位机配置文件生成方法',
        '申请人：某上位机公司',
        '申请日：2020-03-05',
        '公开日：2021-11-23',
        'IPC：H04L29/08',
      ].join('\n'),
    );
    expect(record.publicationNumber).toBe('CN111767240B');
    expect(record.title).toBe('一种上位机配置文件生成方法');
    expect(record.applicant).toBe('某上位机公司');
    expect(record.applicationDate).toBe('2020-03-05');
    expect(record.publicationDate).toBe('2021-11-23');
    expect(record.ipc).toEqual(['H04L29/08']);
  });

  it('记录缺少名称与分类时标字面提示待模型复核', () => {
    const record = normalizePatentRecord({
      publication_number: 'CN100000001A',
    });
    expect(record.semanticNotes.length).toBeGreaterThan(0);
    expect(record.semanticNotes[0]).toContain('复核');
  });

  it('记录与检索词无字面交集时标语义干扰提示', () => {
    const record = normalizePatentRecord(
      { publication_number: 'CN100000002A', title: '一种波形匹配装置' },
      { query: '配置文件驱动协议解析' },
    );
    expect(record.semanticNotes.join()).toContain('语义干扰');
  });

  it('字面交集判定:中文双字窗口与英文词', () => {
    expect(hasLiteralOverlap('协议解析', '一种协议解析方法')).toBe(true);
    expect(hasLiteralOverlap('white list', 'white list filter')).toBe(true);
    expect(hasLiteralOverlap('协议解析', '一种波形匹配装置')).toBe(false);
  });
});

describe('patent-search 日期档位判定', () => {
  it('对比文件申请日早于本申请申请日 → 可作有效对比文件', () => {
    const tier = computeDateTier(
      { applicationDate: '2023-01-05', publicationDate: '2023-04-11' },
      '2024-06-01',
    );
    expect(tier.tier).toBe('prior-art');
    expect(tier.label).toBe('可作有效对比文件');
    expect(tier.basis).toContain('2023-01-05');
  });

  it('对比文件申请日与公开日均晚于本申请申请日 → 不可作对比文件', () => {
    const tier = computeDateTier(
      { applicationDate: '2025-02-01', publicationDate: '2025-05-06' },
      '2024-06-01',
    );
    expect(tier.tier).toBe('later');
    expect(tier.label).toBe('不可作对比文件');
  });

  it('仅公开日早于本申请申请日 → 需另判', () => {
    const tier = computeDateTier(
      { applicationDate: '2025-02-01', publicationDate: '2024-01-06' },
      '2024-06-01',
    );
    expect(tier.tier).toBe('needs-review');
    expect(tier.label).toBe('需另判');
  });

  it('未提供本申请申请日或对比文件缺日期 → 档位未知', () => {
    expect(computeDateTier({ applicationDate: '2023-01-05' }, null).tier).toBe(
      'unknown',
    );
    expect(
      computeDateTier(
        { applicationDate: null, publicationDate: null },
        '2024-06-01',
      ).tier,
    ).toBe('unknown');
  });

  it('档位结果带出判定所需三段输入', () => {
    const tier = computeDateTier(
      { applicationDate: '2023-01-05', publicationDate: '2023-04-11' },
      '2024-06-01',
    );
    expect(tier.recordApplicationDate).toBe('2023-01-05');
    expect(tier.recordPublicationDate).toBe('2023-04-11');
    expect(tier.applicantFilingDate).toBe('2024-06-01');
    expect(tier.tier).toBe('prior-art');
  });
});

describe('patent-search 检索报告', () => {
  it('汇总多条记录与档位并渲染 markdown', () => {
    const report = buildPatentSearchReport({
      applicantFilingDate: '2024-06-01',
      raw: [
        '公布号：CN122824595A',
        '发明名称：一种界面生成方法',
        '申请日：2023-01-05',
        '公开日：2023-04-11',
        '',
        '公布号：CN999999999A',
        '发明名称：另一种方法',
        '申请日：2025-02-01',
        '公开日：2025-05-06',
      ].join('\n'),
    });
    expect(report.stats.records).toBe(2);
    expect(report.stats.priorArt).toBe(1);
    expect(report.stats.later).toBe(1);
    expect(report.tiers[0]?.tier).toBe('prior-art');
    expect(report.tiers[1]?.tier).toBe('later');
    expect(report.markdown).toContain('| 公布号 |');
    expect(report.markdown).toContain('可作有效对比文件');
    expect(report.ok).toBe(true);
  });

  it('接受 JSON 数组 raw 并保留 provider 字段', () => {
    const report = buildPatentSearchReport({
      applicantFilingDate: '2024-06-01',
      raw: JSON.stringify([
        {
          publication_number: 'CN120915859A',
          title: '一种协议解析方法',
          filing_date: '2022-03-01',
          publication_date: '2022-06-02',
        },
      ]),
    });
    expect(report.records[0]?.publicationNumber).toBe('CN120915859A');
    expect(report.tiers[0]?.tier).toBe('prior-art');
  });

  it('未提供检索结果时输出检索指引并记诊断', () => {
    const report = buildPatentSearchReport({ query: '协议解析' });
    expect(report.records).toHaveLength(0);
    expect(report.guidance.length).toBeGreaterThan(0);
    expect(report.guidance.join()).toContain('PatentsView');
    expect(report.issues.some((issue) => issue.code === 'NO_INPUT')).toBe(true);
    expect(report.markdown).toContain('检索指引');
  });

  it('只给精确公布号时生成待取回记录并提示补齐', () => {
    const report = buildPatentSearchReport({
      publicationNumber: 'CN122824595A',
      applicantFilingDate: '2024-06-01',
    });
    expect(report.records[0]?.publicationNumber).toBe('CN122824595A');
    expect(report.records[0]?.applicationDate).toBeNull();
    expect(report.tiers[0]?.tier).toBe('unknown');
  });

  it('记录缺公布号时记诊断但保留其余字段', () => {
    const report = buildPatentSearchReport({
      raw: JSON.stringify([{ title: '缺号记录', filing_date: '2020-01-01' }]),
    });
    expect(
      report.issues.some(
        (issue) => issue.code === 'PUBLICATION_NUMBER_MISSING',
      ),
    ).toBe(true);
    expect(report.records[0]?.title).toBe('缺号记录');
    expect(report.records[0]?.applicationDate).toBe('2020-01-01');
  });
});

describe('patent-search 复审加固（USD 号 / 可疑号标记 / 日历回验）', () => {
  it('美国外观设计专利号 USD 前缀不被改写', () => {
    const parsed = normalizePublicationNumber('USD 987,111 S');
    expect(parsed.matched).toBe(true);
    expect(parsed.number).toBe('USD987111S');
    expect(parsed.kind).toBe('US');
    expect(normalizePublicationNumber('USD123456S').number).toBe('USD123456S');
  });

  it('英文散文中的短号码片段不判为公布号', () => {
    const parsed = normalizePublicationNumber('In the US 2024 election');
    expect(parsed.matched).toBe(false);
    expect(parsed.kind).toBe('OTHER');
  });

  it('记录透出公布号格式可信度,markdown 给可疑号加标记', () => {
    const report = buildPatentSearchReport({
      raw: ['公布号：US 2024 election', '发明名称：可疑号记录'].join('\n'),
    });
    expect(report.records[0]?.publicationNumberMatched).toBe(false);
    expect(report.markdown).toContain('格式可疑');
    const ok = buildPatentSearchReport({
      raw: '公布号：CN122824595A\n发明名称：正常记录',
    });
    expect(ok.records[0]?.publicationNumberMatched).toBe(true);
    expect(ok.markdown).not.toContain('格式可疑');
  });

  it('权利要求 1 后直接跟权利要求 10 时也能截断首项', () => {
    const record = normalizePatentRecord(
      [
        '权利要求1. 一种数据处理方法，其特征在于，包括步骤A。',
        '权利要求10. 根据权利要求1所述的方法。',
      ].join('\n'),
    );
    expect(record.firstClaim).toContain('步骤A');
    expect(record.firstClaim).not.toContain('权利要求10');
  });

  it('拒绝日历不存在的日期（如 2024-02-30）', () => {
    expect(normalizeDate('2024-02-30')).toBeNull();
    expect(normalizeDate('2024-02-29')).toBe('2024-02-29');
    expect(normalizeDate('2023-02-29')).toBeNull();
  });

  it('provider 键名变体补齐:camelCase 与 patent_* 键', () => {
    const fields = fieldsFromJsonObject({
      patent_publication_number: 'CN120915859A',
      patent_title: '一种协议解析方法',
      patent_abstract: '本发明公开了一种协议解析方法。',
      filingDate: '2022-03-01',
      patent_date: '2022-06-02',
      priorityDate: '2021-12-01',
    });
    expect(fields.publicationNumber).toBe('CN120915859A');
    expect(fields.abstract).toContain('协议解析');
    expect(fields.applicationDate).toBe('2022-03-01');
    expect(fields.publicationDate).toBe('2022-06-02');
    expect(fields.priorityDate).toBe('2021-12-01');
  });

  it('raw 以 [ 开头但解析失败时回退文本抽取并保留可用字段', () => {
    const record = normalizePatentRecord(
      '[ 公布号：CN111767240B\n发明名称：回退抽取记录',
    );
    expect(record.publicationNumber).toBe('CN111767240B');
    expect(record.title).toBe('回退抽取记录');
  });
});

describe('patent-search Google Patents 兜底（模拟网络）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('兜底成功时解析 cluster 结果并归一记录', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          results: {
            cluster: [
              {
                result: [
                  {
                    patent: {
                      publication_number: 'CN120915859A',
                      title: '一种协议解析方法',
                      assignee: '某公司',
                      filing_date: '2022-03-01',
                      publication_date: '2022-06-02',
                    },
                  },
                ],
              },
            ],
          },
        }),
      })),
    );
    const online = await fetchGooglePatents('协议解析');
    expect(online.ok).toBe(true);
    expect(online.records).toHaveLength(1);
    expect(online.records[0]?.publicationNumber).toBe('CN120915859A');
    expect(online.records[0]?.source).toBe('google-patents-xhr');
  });

  it('兜底失败只降级为诊断不抛错', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 429 })),
    );
    const online = await fetchGooglePatents('协议解析');
    expect(online.ok).toBe(false);
    expect(online.error).toContain('429');
    expect(online.records).toHaveLength(0);
  });

  it('fetch 抛异常时同样降级为错误结果', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const online = await fetchGooglePatents('协议解析');
    expect(online.ok).toBe(false);
    expect(online.error).toContain('network down');
  });
});
