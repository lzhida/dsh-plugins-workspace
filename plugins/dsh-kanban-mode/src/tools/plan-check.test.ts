import { describe, expect, it } from 'vitest';

import {
  buildPlanCheckTool,
  buildPlanCheckValue,
  PLAN_CHECK_DISCLAIMER,
  type PlanCheckValue,
} from './plan-check.ts';

/** 四段齐全的 description（多卡含「系列全景」）。 */
function fullDescription(extra = true): string {
  return [
    ...(extra ? ['系列全景：两卡接力交付导出能力。'] : []),
    '目标与成功标准：导出成功率不低于 99%。',
    '范围：后端导出接口与前端按钮。',
    '实施要点：先骨架后接线。',
    '边界情况与已知风险：大文件导出可能超时。',
  ].join('\n');
}

/** 四段齐全的 prompt。 */
function fullPrompt(): string {
  return [
    '先读后动：先读板与相关代码。',
    '执行位置：仓库根目录。',
    '依赖与门禁：blockedBy 未满足则停下。',
    '交接纪律：自验后交报告移 in_review。',
  ].join('\n');
}

/** 构造一份五类全过的两卡系列方案。 */
function validPlan(): Record<string, unknown> {
  return {
    series: { theme: '导出优化', total: 2 },
    cards: [
      {
        title: '导出优化系列 1/2：搭建导出服务骨架',
        description: fullDescription(),
        prompt: fullPrompt(),
        checklist: ['导出接口对三种格式各返回 200', '接口单测通过'],
        blockedBy: [],
      },
      {
        title: '导出优化系列 2/2：前端按钮接入新接口',
        description: fullDescription(),
        prompt: fullPrompt(),
        checklist: ['按钮点击触发导出', '失败提示可见'],
        blockedBy: [0],
      },
    ],
  };
}

/** 取某类校验结果。 */
function resultOf(value: PlanCheckValue, check: string) {
  const item = value.results.find((entry) => entry.check === check);
  expect(item, check).toBeDefined();
  return item!;
}

describe('dsh-kanban-mode tools：kanban_plan_check 全过基线', () => {
  it('五类全过的方案逐类 PASS', () => {
    const value = buildPlanCheckValue(validPlan());
    expect(value.results.map((item) => item.pass)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(value.cardCount).toBe(2);
    expect(value.disclaimer).toBe(PLAN_CHECK_DISCLAIMER);
  });

  it('输出必附「机械校验不代替人判断」声明', () => {
    const tool = buildPlanCheckTool();
    const rendered = tool.output.render(
      { plan: undefined },
      buildPlanCheckValue(validPlan()),
    );
    expect(rendered[0]!.text).toContain('机械校验不代替人判断');
  });

  it('plan 结构非法时抛可操作错误（invalid_input）', async () => {
    const tool = buildPlanCheckTool();
    await expect(
      tool.execute({ plan: 'not-an-object' }, undefined),
    ).rejects.toThrowError('Error: invalid_input: plan 必须是对象');
    await expect(
      tool.execute({ plan: { cards: [] } }, undefined),
    ).rejects.toThrowError('Error: invalid_input: plan.cards 必须是非空数组');
  });
});

describe('dsh-kanban-mode tools：kanban_plan_check ①系列命名', () => {
  it('单卡方案①不适用（PASS 并注明）', () => {
    const plan = validPlan();
    const single = {
      cards: [(plan.cards as Record<string, unknown>[])[0]],
    };
    const value = buildPlanCheckValue(single);
    const item = resultOf(value, '①系列命名');
    expect(item.pass).toBe(true);
    expect(item.detail).toContain('不适用');
  });

  it('跳号（1/3、3/3）判 FAIL 并指出期望序列', () => {
    const plan = validPlan() as {
      cards: Array<Record<string, unknown>>;
    };
    (plan.cards[0] as { title: string }).title =
      '导出优化系列 1/3：搭建导出服务骨架';
    (plan.cards[1] as { title: string }).title =
      '导出优化系列 3/3：前端按钮接入新接口';
    const item = resultOf(buildPlanCheckValue(plan), '①系列命名');
    expect(item.pass).toBe(false);
    expect(item.detail).toContain('n 须从 1 起连续无跳号');
  });

  it('全组主题不一致判 FAIL', () => {
    const plan = validPlan() as { cards: Array<Record<string, unknown>> };
    (plan.cards[1] as { title: string }).title =
      '导入重构系列 2/2：前端按钮接入新接口';
    const item = resultOf(buildPlanCheckValue(plan), '①系列命名');
    expect(item.pass).toBe(false);
    expect(item.detail).toContain('主题须逐字一致');
  });

  it('N 与总卡数不符判 FAIL', () => {
    const plan = validPlan() as { cards: Array<Record<string, unknown>> };
    (plan.cards[0] as { title: string }).title =
      '导出优化系列 1/5：搭建导出服务骨架';
    (plan.cards[1] as { title: string }).title =
      '导出优化系列 2/5：前端按钮接入新接口';
    const item = resultOf(buildPlanCheckValue(plan), '①系列命名');
    expect(item.pass).toBe(false);
    expect(item.detail).toContain('N（分母）须等于总卡数 2');
  });

  it('冒号后缺动作短语判 FAIL', () => {
    const plan = validPlan() as { cards: Array<Record<string, unknown>> };
    (plan.cards[0] as { title: string }).title = '导出优化系列 1/2：';
    const item = resultOf(buildPlanCheckValue(plan), '①系列命名');
    expect(item.pass).toBe(false);
    expect(item.detail).toContain('缺少动作短语');
  });
});

describe('dsh-kanban-mode tools：kanban_plan_check ②③段落', () => {
  it('description 缺「边界情况与已知风险」判 FAIL', () => {
    const plan = validPlan() as { cards: Array<Record<string, unknown>> };
    (plan.cards[1] as { description: string }).description =
      fullDescription().replace(
        '\n边界情况与已知风险：大文件导出可能超时。',
        '',
      );
    const item = resultOf(buildPlanCheckValue(plan), '②description 四段');
    expect(item.pass).toBe(false);
    expect(item.detail).toContain('边界情况与已知风险');
  });

  it('多卡 description 缺「系列全景」行判 FAIL', () => {
    const plan = validPlan() as { cards: Array<Record<string, unknown>> };
    (plan.cards[0] as { description: string }).description =
      fullDescription(false);
    const item = resultOf(buildPlanCheckValue(plan), '②description 四段');
    expect(item.pass).toBe(false);
    expect(item.detail).toContain('系列全景');
  });

  it('prompt 缺「依赖与门禁」判 FAIL', () => {
    const plan = validPlan() as { cards: Array<Record<string, unknown>> };
    (plan.cards[0] as { prompt: string }).prompt = fullPrompt().replace(
      '依赖与门禁：blockedBy 未满足则停下。\n',
      '',
    );
    const item = resultOf(buildPlanCheckValue(plan), '③prompt 四段');
    expect(item.pass).toBe(false);
    expect(item.detail).toContain('依赖与门禁');
  });
});

describe('dsh-kanban-mode tools：kanban_plan_check ④checklist', () => {
  it('空 checklist 判 FAIL', () => {
    const plan = validPlan() as { cards: Array<Record<string, unknown>> };
    (plan.cards[0] as { checklist: string[] }).checklist = [];
    const item = resultOf(buildPlanCheckValue(plan), '④checklist 可观察');
    expect(item.pass).toBe(false);
    expect(item.detail).toContain('checklist 为空');
  });

  it('重复条目判 FAIL', () => {
    const plan = validPlan() as { cards: Array<Record<string, unknown>> };
    (plan.cards[0] as { checklist: string[] }).checklist = [
      '同一句话',
      '同一句话',
    ];
    const item = resultOf(buildPlanCheckValue(plan), '④checklist 可观察');
    expect(item.pass).toBe(false);
    expect(item.detail).toContain('重复');
  });

  it('超 200 字符条目判 FAIL', () => {
    const plan = validPlan() as { cards: Array<Record<string, unknown>> };
    (plan.cards[0] as { checklist: string[] }).checklist = ['长'.repeat(201)];
    const item = resultOf(buildPlanCheckValue(plan), '④checklist 可观察');
    expect(item.pass).toBe(false);
    expect(item.detail).toContain('超过上限 200');
  });

  it('纯评价词条目只告警不硬拒（pass 保持 true）', () => {
    const plan = validPlan() as { cards: Array<Record<string, unknown>> };
    (plan.cards[0] as { checklist: string[] }).checklist = ['做好'];
    const value = buildPlanCheckValue(plan);
    expect(resultOf(value, '④checklist 可观察').pass).toBe(true);
    expect(value.warnings.some((w) => w.includes('做好'))).toBe(true);
    expect(value.warnings.some((w) => w.includes('纯评价词'))).toBe(true);
  });
});

describe('dsh-kanban-mode tools：kanban_plan_check ⑤依赖图', () => {
  it('blockedBy 成环判 FAIL 并列出环路径', () => {
    const plan = validPlan() as { cards: Array<Record<string, unknown>> };
    (plan.cards[0] as { blockedBy: number[] }).blockedBy = [1];
    (plan.cards[1] as { blockedBy: number[] }).blockedBy = [0];
    const item = resultOf(buildPlanCheckValue(plan), '⑤依赖图');
    expect(item.pass).toBe(false);
    expect(item.detail).toContain('成环');
  });

  it('下标越界与自引用判 FAIL', () => {
    const plan = validPlan() as { cards: Array<Record<string, unknown>> };
    (plan.cards[0] as { blockedBy: number[] }).blockedBy = [0, 5];
    const item = resultOf(buildPlanCheckValue(plan), '⑤依赖图');
    expect(item.pass).toBe(false);
    expect(item.detail).toContain('自环');
    expect(item.detail).toContain('越界');
  });

  it('下游卡引用更晚下标只告警不硬拒（pass 保持 true）', () => {
    const plan = {
      cards: [
        {
          title: '卡一',
          description: '',
          prompt: '',
          checklist: ['a'],
          blockedBy: [],
        },
        {
          title: '卡二',
          description: '',
          prompt: '',
          checklist: ['b'],
          blockedBy: [2],
        },
        {
          title: '卡三',
          description: '',
          prompt: '',
          checklist: ['c'],
          blockedBy: [],
        },
      ],
    };
    const value = buildPlanCheckValue(plan);
    expect(resultOf(value, '⑤依赖图').pass).toBe(true);
    expect(
      value.warnings.some(
        (w) => w.includes('更晚下标') && w.includes('拓扑序'),
      ),
    ).toBe(true);
  });
});

describe('dsh-kanban-mode tools：kanban_plan_check 工具面', () => {
  it('工具定义形状对齐 vendored sdk 契约', () => {
    const tool = buildPlanCheckTool();
    expect(tool.name).toBe('kanban_plan_check');
    expect(tool.description).toContain('只读');
    expect(tool.parameters).toMatchObject({ type: 'object' });
    expect(tool.output.schema).toEqual({});
  });

  it('render 输出逐类 PASS/FAIL 与免责声明', () => {
    const tool = buildPlanCheckTool();
    const good = tool.output.render(
      { plan: undefined },
      buildPlanCheckValue(validPlan()),
    );
    expect(good[0]!.text).toContain('PASS');
    expect(good[0]!.text).toContain(PLAN_CHECK_DISCLAIMER);
    const bad = buildPlanCheckValue({ cards: [{ title: 'x' }] });
    const rendered = tool.output.render({ plan: undefined }, bad);
    expect(rendered[0]!.text).toContain('FAIL');
  });
});
