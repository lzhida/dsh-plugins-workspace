import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildReleaseNotes,
  buildTagMessage,
  extractChangelogSection,
  readChangelogSection,
} from './changelog.ts';

/** 与仓库 packages/dsh-llm-fallback/CHANGELOG.md 相同结构的 changesets 输出。 */
const CHANGELOG = `# @zhidal/dsh-llm-fallback

## 0.5.0

### Minor Changes

- 5740972: 新增失败候选冷却跳过(cooldown),平衡回退优先级与切换效率
- af8cf8f: 回退时机配置 fallbackWhen 移除,改为数值化的每候选重试次数

### Patch Changes

- b823795: npm 包元数据修正
- 76eb0e1: 默认白名单新增失败码 UNSUPPORTED_REASONING_EFFORT

## 0.4.0

### Minor Changes

- 02c0bf5: 轨迹透明化:跨 provider 回退不再是黑盒
`;

describe('extractChangelogSection', () => {
  it('提取 changesets 标准形态(## {version})的完整段落,不含后续版本', () => {
    const section = extractChangelogSection(CHANGELOG, '0.5.0');
    expect(section).not.toBeNull();
    expect(section).toContain('### Minor Changes');
    expect(section).toContain('新增失败候选冷却跳过');
    expect(section).toContain('UNSUPPORTED_REASONING_EFFORT');
    // 不吞掉下一个版本标题
    expect(section).not.toContain('## 0.4.0');
    expect(section).not.toContain('轨迹透明化');
  });

  it('多版本内容切分正确:提取旧版本段落取到下一个标题为止', () => {
    const section = extractChangelogSection(CHANGELOG, '0.4.0');
    expect(section).toContain('轨迹透明化');
    expect(section).not.toContain('冷却跳过');
    expect(section).not.toContain('# @zhidal/dsh-llm-fallback');
  });

  it('容错变体标题:## [0.5.0] / ## v0.5.0 / 尾部日期注释', () => {
    const bracket = '# pkg\n\n## [0.5.0]\n\n- fix a\n';
    expect(extractChangelogSection(bracket, '0.5.0')).toContain('- fix a');
    const vPrefix = '# pkg\n\n## v0.5.0\n\n- fix b\n';
    expect(extractChangelogSection(vPrefix, '0.5.0')).toContain('- fix b');
    const dated = '# pkg\n\n## 0.5.0 (2026-10-14)\n\n- fix c\n';
    expect(extractChangelogSection(dated, '0.5.0')).toContain('- fix c');
  });

  it('版本号中的正则元字符按字面匹配(不做模式解释)', () => {
    const content = '# pkg\n\n## 1.0.0-beta.1+build.5\n\n- entry\n';
    // 原样搜索 "1.0.0-beta.1+build.5" 应命中;若转义缺失,+. 会被解释为模式
    expect(extractChangelogSection(content, '1.0.0-beta.1+build.5')).toContain(
      '- entry',
    );
  });

  it('该版本不存在 / 段落为空 → null', () => {
    expect(extractChangelogSection(CHANGELOG, '9.9.9')).toBeNull();
    expect(extractChangelogSection('', '0.5.0')).toBeNull();
    // 标题存在但内容为空(紧邻下一个标题)→ null
    expect(
      extractChangelogSection('# pkg\n\n## 0.5.0\n## 0.4.0\n- x\n', '0.5.0'),
    ).toBeNull();
  });
});

describe('readChangelogSection', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makePkgDir(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'dsh-changelog-test-'));
    dirs.push(root);
    const pkgDir = join(root, 'packages', 'dsh-demo');
    mkdirSync(pkgDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(pkgDir, name), content, 'utf8');
    }
    return root;
  }

  it('读取包目录下 CHANGELOG.md 的对应版本段', () => {
    const root = makePkgDir({ 'CHANGELOG.md': CHANGELOG });
    expect(readChangelogSection(root, 'packages/dsh-demo', '0.5.0')).toContain(
      '冷却跳过',
    );
  });

  it('CHANGELOG.md 不存在 → null(降级,不抛错)', () => {
    const root = makePkgDir({ 'package.json': '{}' });
    expect(readChangelogSection(root, 'packages/dsh-demo', '0.5.0')).toBeNull();
  });
});

describe('buildTagMessage', () => {
  it('有段落:首行 subject + 空行 + CHANGELOG 段落', () => {
    expect(buildTagMessage('@zhidal/dsh-x', '0.5.0', '- feat a\n- fix b')).toBe(
      '@zhidal/dsh-x v0.5.0\n\n- feat a\n- fix b',
    );
  });

  it('无段落:降级为纯 subject(与历史行为一致)', () => {
    expect(buildTagMessage('@zhidal/dsh-x', '0.5.0', null)).toBe(
      '@zhidal/dsh-x v0.5.0',
    );
  });
});

describe('buildReleaseNotes', () => {
  it('有段落:notes = 段落原文', () => {
    expect(buildReleaseNotes('@zhidal/dsh-x', '0.5.0', '- feat a')).toBe(
      '- feat a',
    );
  });

  it('无段落:兜底文案明确标注内容缺失(不留空 Release)', () => {
    const notes = buildReleaseNotes('@zhidal/dsh-x', '0.5.0', null);
    expect(notes).toContain('@zhidal/dsh-x v0.5.0');
    expect(notes).toContain('0.5.0 的更新段落');
  });
});
