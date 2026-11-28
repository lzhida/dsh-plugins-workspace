import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCaseIndex,
  extractCaseSections,
  extractCaseTitle,
  inferCaseStatus,
  looksLikeDisclosure,
  sectionOrderOf,
  slugifyCaseId,
} from './case-index.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'patent-case-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

const FULL_DISCLOSURE = [
  '# 数据传输方法交底书',
  '',
  '## 一、背景技术',
  '',
  '现有技术通常需要人工搬运数据，效率低且容易出错，缺少统一的校验与记录手段，异常也难以定位到具体环节。',
  '',
  '## 二、背景技术的技术问题',
  '',
  '需要解决数据校验与结果记录脱节、处理链条不可追溯的技术问题，使每一步处理结果都能被复核与回放。',
  '',
  '## 三、本发明的详细阐述',
  '',
  '本发明提供一种数据传输方法，接收待处理的数据并校验数据格式，记录校验结果并写入本地转义表。',
  '',
  '## 四、可替代之处',
  '',
  '校验结果也可以写入远端存储，替换本地转义表；转义表的存放位置亦可由调用方指定或由服务端下发。',
  '',
  '## 五、有益效果',
  '',
  '本发明具备的有益效果是：处理链条可追溯，异常可定位，跨设备处理结果保持一致且可回放。',
  '',
  '## 六、请求保护的技术要点',
  '',
  '1. 一种数据传输方法，其特征在于，接收待处理的数据并校验数据格式。',
  '2. 根据权利要求1所述的方法，其特征在于，记录校验结果。',
  '',
  '## 七、附图要求',
  '',
  '图1是方法流程示意图。',
].join('\n');

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响断言 */
      }
    }
  }
});

describe('case-index 纯函数', () => {
  it('按七部分标题识别交底书', () => {
    expect(looksLikeDisclosure(FULL_DISCLOSURE)).toBe(true);
    expect(looksLikeDisclosure('# 普通说明\n\n一些文字。')).toBe(false);
  });

  it('从路径生成案件标识', () => {
    expect(slugifyCaseId('cases/甲案/交底书.md')).toBe('cases-甲案-交底书');
  });

  it('抽取中文序号用于宽松匹配', () => {
    expect(sectionOrderOf('三、本案的详细阐述')).toBe(3);
    expect(sectionOrderOf('七、附图要求')).toBe(7);
    expect(sectionOrderOf('无序号')).toBeNull();
  });

  it('抽取标题', () => {
    expect(extractCaseTitle(FULL_DISCLOSURE, 'fallback')).toBe(
      '数据传输方法交底书',
    );
    expect(extractCaseTitle('# 无标题正文', 'fallback')).toBe('无标题正文');
    expect(
      extractCaseTitle('正文首行不是标题\n\n# 后面的标题', 'fallback'),
    ).toBe('fallback');
  });

  it('按序号匹配七部分并统计填充情况', () => {
    const sections = extractCaseSections(FULL_DISCLOSURE);
    expect(sections.length).toBe(7);
    // 措辞与模板不同的三/四/五部分也能按序号对上。
    expect(sections.find((s) => s.title.startsWith('三、'))?.filled).toBe(true);
    expect(sections.find((s) => s.title.startsWith('六、'))?.filled).toBe(true);
  });

  it('由关键部分完整度推断状态', () => {
    const sections = extractCaseSections(FULL_DISCLOSURE);
    expect(inferCaseStatus(sections)).toBe('ready');
    const partial = sections.map((s) => ({ ...s, filled: false }));
    expect(inferCaseStatus(partial)).toBe('empty');
  });
});

describe('buildCaseIndex 案件索引', () => {
  it('扫描工作区列出交底书案件并给出状态', () => {
    const dir = makeTempDir();
    writeFile(join(dir, '甲案.md'), FULL_DISCLOSURE);
    writeFile(join(dir, '乙案.md'), FULL_DISCLOSURE);
    writeFile(join(dir, '说明.md'), '# 普通说明\n\n不是交底书。');
    const report = buildCaseIndex(dir);
    expect(report.cases.length).toBe(2);
    expect(report.stats.total).toBe(2);
    expect(report.stats.ready).toBe(2);
    // 排序必须是跨平台确定序（UTF-16 码元序，不用 localeCompare）：CI 默认 locale
    // 与本机不同，中文文件名按 locale 排序会得到不同顺序。码元序：乙(U+4E59) < 甲(U+7532)。
    expect(report.cases.map((c) => c.path.split(/[\\/]/).pop())).toEqual([
      '乙案.md',
      '甲案.md',
    ]);
    const jia = report.cases.find((c) => c.path.endsWith('甲案.md'));
    expect(jia?.statusSource).toBe('inferred');
  });

  it('旁挂元数据优先于推断状态', () => {
    const dir = makeTempDir();
    writeFile(join(dir, '甲案.md'), FULL_DISCLOSURE);
    writeFile(
      join(dir, '甲案.md.case.json'),
      JSON.stringify({
        caseId: 'CASE-001',
        title: '甲案（代理稿）',
        status: 'filed',
        notes: '已递交',
      }),
    );
    const report = buildCaseIndex(dir);
    expect(report.cases[0].caseId).toBe('CASE-001');
    expect(report.cases[0].title).toBe('甲案（代理稿）');
    expect(report.cases[0].status).toBe('filed');
    expect(report.cases[0].statusSource).toBe('sidecar');
    expect(report.cases[0].notes).toBe('已递交');
    expect(report.stats.withSidecar).toBe(1);
  });

  it('没有交底书时给出提示', () => {
    const dir = makeTempDir();
    const report = buildCaseIndex(dir);
    expect(report.cases.length).toBe(0);
    expect(report.issues.some((i) => i.code === 'CASE_NONE_FOUND')).toBe(true);
  });

  it('markdown 含案件清单与七部分填充', () => {
    const dir = makeTempDir();
    writeFile(join(dir, '甲案.md'), FULL_DISCLOSURE);
    const report = buildCaseIndex(dir);
    expect(report.markdown).toContain('交底书案件索引');
    expect(report.markdown).toContain('案件清单');
    expect(report.markdown).toContain('七部分填充');
  });
});
