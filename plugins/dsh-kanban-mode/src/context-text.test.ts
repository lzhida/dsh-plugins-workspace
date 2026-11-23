import { describe, expect, it } from 'vitest';

import {
  buildContext,
  CONTEXT_SECTIONS,
  CONTEXT_SECTION_TITLES,
  CONTEXT_TITLE,
} from './context-text.ts';

describe('dsh-kanban-mode 看板工作法文案', () => {
  it('七段标题齐全且顺序固定', () => {
    expect([...CONTEXT_SECTION_TITLES]).toEqual([
      '总纪律',
      '拆卡',
      '前置',
      '并行',
      '定时',
      '验收',
      'Git 收尾与变更请求',
    ]);
    expect(CONTEXT_SECTIONS).toHaveLength(CONTEXT_SECTION_TITLES.length);
    expect(CONTEXT_SECTIONS.map((section) => section.title)).toEqual([
      ...CONTEXT_SECTION_TITLES,
    ]);
  });

  it('渲染文本包含全部段落标题', () => {
    const text = buildContext();
    expect(text).toContain(CONTEXT_TITLE);
    for (const title of CONTEXT_SECTION_TITLES) {
      expect(text).toContain(`## ${title}`);
    }
  });

  it('七段的关键纪律都写进文案', () => {
    const text = buildContext();
    expect(text).toContain('先查板');
    expect(text).toContain('先读后动');
    expect(text).toContain('先认领');
    expect(text).toContain('版本冲突');
    expect(text).toContain('backlog');
    expect(text).toContain('blockedBy');
    expect(text).toContain('自验');
    expect(text).toContain('execution_report');
    expect(text).toContain('待验收');
    expect(text).toContain('由用户确认');
  });

  it('每段都至少有一条具体条目', () => {
    for (const section of CONTEXT_SECTIONS) {
      expect(section.bullets.length).toBeGreaterThan(0);
      for (const bullet of section.bullets) {
        expect(bullet.length).toBeGreaterThan(0);
      }
    }
  });

  it('并行段对官方进程外子代理只做可选提示', () => {
    const parallel = CONTEXT_SECTIONS.find(
      (section) => section.title === '并行',
    );
    if (parallel === undefined) {
      throw new Error('并行段缺失');
    }
    const optionalBullet = parallel.bullets.find((bullet) =>
      bullet.includes('subagent_codex'),
    );
    expect(optionalBullet).toBeDefined();
    const text = optionalBullet as string;
    // 提示是可选增强：写明工具名、one-shot 语义边界与「未安装零影响」。
    expect(text).toContain('可选');
    expect(text).toContain('subagent_claude_code');
    expect(text).toContain('one-shot');
    expect(text).toContain('未安装');
    // 不得把安装官方插件写成并行工作法的前提。
    expect(text).not.toContain('必须安装');
    expect(text).toContain('不受任何影响');
  });

  it('Git 收尾段对官方 forge 只做条件增强且锁定 PR URL 回写', () => {
    const gitSection = CONTEXT_SECTIONS.find(
      (section) => section.title === 'Git 收尾与变更请求',
    );
    if (gitSection === undefined) {
      throw new Error('Git 收尾与变更请求段缺失');
    }
    const text = gitSection.bullets.join('\n');
    // 条件增强口径：只有启用了「变更请求与工作树」才生效，未启用不阻塞。
    expect(text).toContain('变更请求与工作树');
    expect(text).toContain('未启用时按仓库常规 git 纪律');
    expect(text).toContain('不阻塞');
    // 启用 forge 时的硬要求：PR URL 必须回写看板（execution_report + 评论）。
    expect(text).toContain('PR URL');
    expect(text).toContain('execution_report');
    expect(text).toContain('读取已绑定变更请求的工具');
    // 不得把启用 forge 写成必须；GitHub-only 与无双向绑定如实声明。
    expect(text).not.toContain('必须启用');
    expect(text).not.toContain('必须安装');
    expect(text).toContain('GitHub');
    expect(text).toContain('双向绑定');
  });
});
