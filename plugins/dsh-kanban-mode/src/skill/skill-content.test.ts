import { describe, expect, it } from 'vitest';

import {
  SKILL_CONTENT,
  SKILL_DESCRIPTION,
  SKILL_NAME,
} from './skill-content.ts';

describe('dsh-kanban-mode 内嵌建卡 skill 正文', () => {
  it('注册名是 kanban-task-create', () => {
    expect(SKILL_NAME).toBe('kanban-task-create');
  });

  it('描述写明何时使用（含 taskboard_create 与建卡触发词）', () => {
    expect(SKILL_DESCRIPTION.length).toBeGreaterThan(0);
    expect(SKILL_DESCRIPTION).toContain('taskboard_create');
    expect(SKILL_DESCRIPTION).toContain('建卡');
  });

  it('开头带内联声明：在看板模式下取代用户级副本的建卡职责', () => {
    expect(SKILL_CONTENT).toContain('在看板模式下取代用户级副本的建卡职责');
    expect(SKILL_CONTENT).toContain('@zhidal/dsh-kanban-mode');
    expect(SKILL_CONTENT).toContain('docs/skill-vs-user-skill.md');
  });

  it('保留七步骨架章节（§0-§7）', () => {
    const sections = [
      '## 0. 环境门禁',
      '## 1. 需求澄清',
      '## 2. 看板侦察',
      '## 3. 复杂度评估与任务拆分',
      '## 4. Plan 式起草',
      '## 5. 用户确认',
      '## 6. 落卡',
      '## 7. 回报',
    ];
    for (const section of sections) {
      expect(SKILL_CONTENT).toContain(section);
    }
  });

  it('§0 门禁：无 taskboard_* 工具即停的语义保留', () => {
    expect(SKILL_CONTENT).toContain('taskboard_*');
    expect(SKILL_CONTENT).toContain('立即停止');
    expect(SKILL_CONTENT).toContain('不模拟建卡');
  });

  it('保留插件版本探测与降级口径（blockedBy ⇒ ≥0.10.0，否则文字兜底）', () => {
    expect(SKILL_CONTENT).toContain('插件版本探测');
    expect(SKILL_CONTENT).toContain('blockedBy');
    expect(SKILL_CONTENT).toContain('插件 ≥ 0.10.0');
    expect(SKILL_CONTENT).toContain('文字兜底');
  });

  it('保留系列命名模板与拆分表先确认纪律', () => {
    expect(SKILL_CONTENT).toContain('<主题>系列 n/N：<祈使短句>');
    expect(SKILL_CONTENT).toContain('拆分表未经确认不建任何卡');
    expect(SKILL_CONTENT).toContain('一个可独立验收的功能点');
  });

  it('保留四条 blockedBy 报错原文与解引用报错', () => {
    expect(SKILL_CONTENT).toContain('dependency cannot reference itself');
    expect(SKILL_CONTENT).toContain('dependency not found: <id>');
    expect(SKILL_CONTENT).toContain(
      'dependency must belong to the same project: <id>',
    );
    expect(SKILL_CONTENT).toContain('dependency cycle involving <id>');
    expect(SKILL_CONTENT).toContain('task is referenced by');
  });

  it('保留依赖门禁口径（in_review/done 解锁、替换语义、拓扑序）', () => {
    expect(SKILL_CONTENT).toContain('in_progress');
    expect(SKILL_CONTENT).toContain('in_review');
    expect(SKILL_CONTENT).toContain('替换语义');
    expect(SKILL_CONTENT).toContain('按拓扑序建卡');
  });

  it('保留 prompt 四段模板关键词（先读后动/执行位置/依赖与门禁/交接纪律）', () => {
    for (const keyword of ['先读后动', '执行位置', '依赖与门禁', '交接纪律']) {
      expect(SKILL_CONTENT).toContain(keyword);
    }
  });

  it('保留确认与落卡纪律：exit_plan_mode / taskboard_list / backlog', () => {
    expect(SKILL_CONTENT).toContain('exit_plan_mode');
    expect(SKILL_CONTENT).toContain('taskboard_list');
    expect(SKILL_CONTENT).toContain('backlog');
    expect(SKILL_CONTENT).toContain('完成由用户确认');
    expect(SKILL_CONTENT).toContain('建卡 ≠ 授权执行');
  });

  it('建卡字段取舍：默认字段一律省略、绝不代设', () => {
    expect(SKILL_CONTENT).toContain('presetId');
    expect(SKILL_CONTENT).toContain('一律**省略**');
    expect(SKILL_CONTENT).toContain('绝不代设');
    expect(SKILL_CONTENT).toContain('isolation');
  });

  it('保留深度调研规范章节（4.5-4.11）与自检 / 坑清单 / 硬约束', () => {
    for (const heading of [
      '### 4.5.1',
      '### 4.5.5',
      '## 4.6',
      '## 4.7',
      '## 4.8',
      '## 4.9',
      '## 4.10',
      '## 4.11',
      '## Pitfalls',
      '## Verification',
      '## 硬约束汇总',
    ]) {
      expect(SKILL_CONTENT).toContain(heading);
    }
  });

  it('硬约束汇总不少于 18 条', () => {
    const hardSection = SKILL_CONTENT.slice(
      SKILL_CONTENT.indexOf('## 硬约束汇总'),
    );
    const items = hardSection.match(/^\d+\. /gm) ?? [];
    expect(items.length).toBeGreaterThanOrEqual(18);
  });

  it('Git 收尾与变更请求按条件式口径写入（PR URL 回写硬要求）', () => {
    // 条件式口径：未启用官方 forge 不阻塞，启用才要求开 PR。
    expect(SKILL_CONTENT).toContain('变更请求与工作树');
    expect(SKILL_CONTENT).toContain('按仓库常规 git 纪律');
    expect(SKILL_CONTENT).toContain('不阻塞');
    // 启用 forge 时的硬要求：PR URL 必须回写看板，否则验收链断点。
    expect(SKILL_CONTENT).toContain('PR URL');
    expect(SKILL_CONTENT).toContain('execution_report 与任务评论');
    expect(SKILL_CONTENT).toContain('读取已绑定变更请求的工具');
    // 措辞红线：不得把启用 forge 写成建卡或执行的前提。
    expect(SKILL_CONTENT).toContain('条件式');
    expect(SKILL_CONTENT).toContain('不得把启用 forge 写成');
  });

  it('不夹带用户本机路径与用户级 skill 目录隔离表述', () => {
    expect(SKILL_CONTENT).not.toContain('C:\\Users');
    expect(SKILL_CONTENT).not.toContain('~/.dsh');
    expect(SKILL_CONTENT).not.toContain('~/.agents');
    expect(SKILL_CONTENT).not.toContain('user-dsh');
  });

  it('正文规模与原版同量级（500-620 行）', () => {
    const lines = SKILL_CONTENT.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(500);
    expect(lines.length).toBeLessThanOrEqual(620);
  });
});
