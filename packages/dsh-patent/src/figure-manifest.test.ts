import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkFigureManifest,
  detectImageEncoding,
  extractFigureSection,
  figureNumberFromName,
  parseDeclaredMarks,
  parseFigureList,
} from './figure-manifest.ts';

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

const DISCLOSURE = [
  '# 数据传输方法交底书',
  '',
  '## 一、背景技术',
  '',
  '现有技术背景文字。',
  '',
  '## 七、附图要求',
  '',
  '图1是方法流程示意图；',
  '图2是系统框架示意图。',
  '',
  '各方框标注附图标记（100/110/120/200）。',
].join('\n');

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'patent-fig-'));
  tempDirs.push(dir);
  return dir;
}

function writeImage(path: string, head: Buffer): void {
  writeFileSync(path, Buffer.concat([head, Buffer.alloc(64, 0)]));
}

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

describe('figure-manifest 附图清单解析', () => {
  it('从交底书第七部分抽出图号与描述', () => {
    const section = extractFigureSection(DISCLOSURE);
    expect(section).toContain('图1是方法流程示意图');
    expect(section).not.toContain('背景技术');
    const list = parseFigureList(section);
    expect([...list.keys()]).toEqual([1, 2]);
    expect(list.get(1)).toContain('方法流程示意图');
  });

  it('抽出交底书声明的附图标记', () => {
    expect(parseDeclaredMarks(DISCLOSURE)).toEqual([
      '100',
      '110',
      '120',
      '200',
    ]);
  });

  it('从文件名提取图号', () => {
    expect(figureNumberFromName('fig1-bw.png')).toBe(1);
    expect(figureNumberFromName('image2.png')).toBe(2);
    expect(figureNumberFromName('附图3.png')).toBe(3);
    expect(figureNumberFromName('notes.txt')).toBeNull();
  });
});

describe('figure-manifest 一致性检查', () => {
  it('交底书声明了图但没有对应图文件时给出提示', () => {
    const report = checkFigureManifest({ disclosure: DISCLOSURE });
    expect(report.items.length).toBe(2);
    expect(report.issues.some((i) => i.code === 'FIG_FILE_MISSING')).toBe(true);
    expect(report.stats.declared).toBe(2);
  });

  it('图文件不在清单里时报多余', () => {
    const report = checkFigureManifest({
      disclosure: DISCLOSURE,
      figureFiles: [{ path: 'fig9.png' }],
    });
    expect(report.issues.some((i) => i.code === 'FIG_FILE_EXTRA')).toBe(true);
  });

  it('正文引用了清单外的图号时报悬空引用', () => {
    const report = checkFigureManifest({
      disclosure: DISCLOSURE,
      document: '本方法流程如图1所示，整体框架见图3。',
    });
    expect(report.issues.some((i) => i.code === 'FIG_REF_DANGLING')).toBe(true);
    expect(report.stats.dangling).toBe(1);
  });

  it('正文引用缺少就近指引时给出低危提示', () => {
    const report = checkFigureManifest({
      disclosure: DISCLOSURE,
      document: '本方法涉及图 2 的处理链条安排。',
    });
    const issue = report.issues.find(
      (i) => i.code === 'FIG_REF_NO_NEARBY_GUIDE',
    );
    expect(issue).toBeTruthy();
    expect(issue?.figure).toBe(2);
  });

  it('就近指引齐备时不报缺指引', () => {
    const report = checkFigureManifest({
      disclosure: DISCLOSURE,
      document: '本方法流程如图1所示，整体框架如图2所示。',
    });
    expect(
      report.issues.some((i) => i.code === 'FIG_REF_NO_NEARBY_GUIDE'),
    ).toBe(false);
  });

  it('附图标记不齐备时逐图提示缺哪些标记', () => {
    const report = checkFigureManifest({
      disclosure: DISCLOSURE,
      figureMarks: [{ figure: 1, marks: ['100', '110'] }],
    });
    const issue = report.issues.find((i) => i.code === 'FIG_MARK_MISSING');
    expect(issue).toBeTruthy();
    expect(issue?.figure).toBe(1);
    expect(issue?.message).toContain('120');
    expect(report.items[0].missingMarks).toContain('200');
  });

  it('图面文本仍用旧术语时报图文分裂', () => {
    const report = checkFigureManifest({
      disclosure: DISCLOSURE,
      figureText: [{ figure: 2, text: '描述文件驱动渲染层' }],
      termRenames: [{ old: '描述文件驱动渲染层', new: '驱动渲染层' }],
    });
    const issue = report.issues.find((i) => i.code === 'FIG_TEXT_TERM_SPLIT');
    expect(issue).toBeTruthy();
    expect(issue?.figure).toBe(2);
    expect(report.stats.splitTerms).toBe(1);
  });

  it('图面元素缺说明书规则条目时报交叉核对提示', () => {
    const report = checkFigureManifest({
      disclosure: DISCLOSURE,
      figureElements: [{ figure: 1, branches: ['接收数据', '校验格式'] }],
      specRules: [{ keyword: '电子围栏完整性校验' }, { keyword: '校验格式' }],
    });
    const issue = report.issues.find(
      (i) => i.code === 'FIG_ELEMENT_MISSING_RULE',
    );
    expect(issue).toBeTruthy();
    expect(issue?.message).toContain('电子围栏完整性校验');
  });

  it('以文件头字节判定真实编码，与扩展名不符时报错', () => {
    const dir = makeTempDir();
    const pngNamedJpg = join(dir, 'fig1.jpg');
    writeImage(pngNamedJpg, PNG_HEAD);
    const report = checkFigureManifest({
      disclosure: DISCLOSURE,
      figureFiles: [{ path: pngNamedJpg }],
    });
    const issue = report.issues.find((i) => i.code === 'FIG_ENCODING_MISMATCH');
    expect(issue).toBeTruthy();
    expect(issue?.message).toContain('png');
    expect(report.ok).toBe(false);
  });

  it('扩展名与文件头一致时不报编码问题', () => {
    const dir = makeTempDir();
    const file = join(dir, 'fig2.png');
    writeImage(file, PNG_HEAD);
    const report = checkFigureManifest({
      disclosure: DISCLOSURE,
      figureFiles: [{ path: file }],
    });
    expect(report.issues.some((i) => i.code === 'FIG_ENCODING_MISMATCH')).toBe(
      false,
    );
    expect(report.stats.encodingChecked).toBe(1);
  });

  it('按字节判定 jpeg 与 png', () => {
    const dir = makeTempDir();
    const jpg = join(dir, 'a.jpg');
    const png = join(dir, 'b.png');
    writeImage(jpg, JPEG_HEAD);
    writeImage(png, PNG_HEAD);
    expect(detectImageEncoding(jpg).encoding).toBe('jpeg');
    expect(detectImageEncoding(png).encoding).toBe('png');
    expect(detectImageEncoding(join(dir, 'nope.png')).detected).toBe(false);
  });

  it('交底书没有附图清单时报缺清单', () => {
    const report = checkFigureManifest({
      disclosure: '# 只有背景\n\n## 一、背景技术\n\n文字。',
    });
    expect(report.issues.some((i) => i.code === 'FIG_LIST_MISSING')).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('报告含待模型逐图核对的清单', () => {
    const report = checkFigureManifest({ disclosure: DISCLOSURE });
    expect(report.checklist.length).toBe(2);
    expect(report.markdown).toContain('待模型逐图核对清单');
    expect(report.markdown).toContain('附图清单与图号一致性报告');
  });
});
