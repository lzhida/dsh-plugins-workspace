import { describe, expect, it } from 'vitest';

import {
  buildContext,
  CONTEXT_SECTIONS,
  CONTEXT_SECTION_TITLES,
  CONTEXT_TITLE,
} from './context-text.ts';

describe('dsh-kanban-mode 看板工作法文案', () => {
  it('八段标题齐全且顺序固定', () => {
    expect([...CONTEXT_SECTION_TITLES]).toEqual([
      '总纪律',
      '拆卡',
      '前置',
      '并行',
      '定时',
      '验收',
      'Git 收尾与变更请求',
      '收割',
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

  it('八段的关键纪律都写进文案', () => {
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

  it('收割段写明 done 门禁：in_review 不算已满足', () => {
    const harvest = CONTEXT_SECTIONS.find(
      (section) => section.title === '收割',
    );
    if (harvest === undefined) {
      throw new Error('收割段缺失');
    }
    const text = harvest.bullets.join('\n');
    // 硬门禁：必须显式确认前置 status==='done'，否则停手。
    expect(text).toContain("status==='done'");
    expect(text).toContain('taskboard_get');
    expect(text).toContain('停手');
    // 依赖门禁把 in_review 也算满足——必须写明这一坑。
    expect(text).toContain('in_review');
    expect(text).toContain('前置已满足');
  });

  it('收割段写明冲突先列结构化清单再问人，且分叉与二轮上限齐全', () => {
    const harvest = CONTEXT_SECTIONS.find(
      (section) => section.title === '收割',
    );
    if (harvest === undefined) {
      throw new Error('收割段缺失');
    }
    const text = harvest.bullets.join('\n');
    // 清单来源与问询动作。
    expect(text).toContain('conflict.files');
    expect(text).toContain('suggestions');
    expect(text).toContain('ask_user_question');
    expect(text).toContain('AI 解决');
    expect(text).toContain('手动解决');
    // 两条分叉路径。
    expect(text).toContain('git add');
    expect(text).toContain('mode=apply');
    expect(text).toContain('abort');
    expect(text).toContain('手动收割指引');
    // 二次冲突上限。
    expect(text).toContain('二次冲突');
    expect(text).toContain('最多再问一轮');
  });

  it('收割段写明三条红线：永不 push / 不改写已推送历史 / 主区脏不擅动', () => {
    const harvest = CONTEXT_SECTIONS.find(
      (section) => section.title === '收割',
    );
    if (harvest === undefined) {
      throw new Error('收割段缺失');
    }
    const text = harvest.bullets.join('\n');
    expect(text).toContain('永不 push');
    expect(text).toContain('不改写已推送历史');
    expect(text).toContain('拒绝变基');
    expect(text).toContain('merge --no-ff');
    expect(text).toContain('主区脏不擅动');
    expect(text).toContain('脏文件');
    expect(text).not.toContain('自动 stash');
    expect(text).not.toContain('自动 clean');
  });

  it('收割段给出可复制的收割卡模板与目标分支口径', () => {
    const harvest = CONTEXT_SECTIONS.find(
      (section) => section.title === '收割',
    );
    if (harvest === undefined) {
      throw new Error('收割段缺失');
    }
    const text = harvest.bullets.join('\n');
    // 卡片模板四段。
    expect(text).toContain('blockedBy=');
    expect(text).toContain('presetId=kanban-mode');
    expect(text).toContain('claim');
    expect(text).toContain('cron');
    expect(text).toContain('prompt');
    // 目标分支语义。
    expect(text).toContain('主区当前分支');
    expect(text).toContain('targetBranch');
    expect(text).toContain('≠ 任务分支');
  });
});
