import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  matchCompletedTodos,
  normalizeTodoText,
  onAgentPreStep,
  todoTextSimilarity,
  todosFromChecklist,
  todosFromEventData,
  type PreStepAgentFace,
} from './todo-sync.ts';
import type { ChecklistItem } from '../shared/protocol.ts';

function item(text: string, checked: boolean): ChecklistItem {
  return { id: `k-${text}`, text, checked };
}

describe('dsh-taskboard todo-sync', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('todosFromEventData 解析合法载荷并原样保留内容', () => {
    const todos = todosFromEventData({
      todos: [
        { content: '读卡', status: 'completed' },
        { content: '写码', status: 'in_progress' },
        { content: '自验', status: 'pending' },
      ],
    });
    expect(todos).toEqual([
      { content: '读卡', status: 'completed' },
      { content: '写码', status: 'in_progress' },
      { content: '自验', status: 'pending' },
    ]);
  });

  it('todosFromEventData 拒绝非对象载荷、缺 todos、空表与超长表', () => {
    expect(todosFromEventData(undefined)).toBeUndefined();
    expect(todosFromEventData(null)).toBeUndefined();
    expect(todosFromEventData('todo/write')).toBeUndefined();
    expect(todosFromEventData({})).toBeUndefined();
    expect(todosFromEventData({ todos: [] })).toBeUndefined();
    expect(
      todosFromEventData({
        todos: Array.from({ length: 101 }, () => ({
          content: 'x',
          status: 'pending',
        })),
      }),
    ).toBeUndefined();
  });

  it('todosFromEventData 拒绝形状不符的条目', () => {
    expect(
      todosFromEventData({ todos: [{ content: 1, status: 'pending' }] }),
    ).toBeUndefined();
    expect(todosFromEventData({ todos: [{ content: 'x' }] })).toBeUndefined();
    expect(
      todosFromEventData({ todos: [{ content: 'x', status: 'done' }] }),
    ).toBeUndefined();
    expect(
      todosFromEventData({ todos: [{ content: '   ', status: 'pending' }] }),
    ).toBeUndefined();
    expect(todosFromEventData({ todos: ['x'] })).toBeUndefined();
    expect(
      todosFromEventData({ todos: [{ content: 'x', status: 'pending' }, 42] }),
    ).toBeUndefined();
  });

  it('todosFromChecklist 把已勾选项映射为 completed、其余为 pending', () => {
    const todos = todosFromChecklist([item('读卡', true), item('写码', false)]);
    expect(todos).toEqual([
      { content: '读卡', status: 'completed' },
      { content: '写码', status: 'pending' },
    ]);
  });

  it('todosFromChecklist 空清单映射为空 todos（宿主侧跳过注入）', () => {
    expect(todosFromChecklist([])).toEqual([]);
  });

  it('normalizeTodoText 折叠空白、去掉语气前缀与句末标点', () => {
    expect(normalizeTodoText('  已读卡并核对。  ')).toBe('读卡并核对');
    expect(normalizeTodoText('读 卡')).toBe('读 卡');
    expect(normalizeTodoText('Todo 投影（3 项）')).toBe('todo 投影（3 项）');
    // 否定词「未」不剥离：否定句不得与肯定条目近似勾上。
    expect(normalizeTodoText('未完成 X')).toBe('未完成 x');
  });

  it('todoTextSimilarity：完全一致=1、无关文本≈0、改写文本显著高于阈值', () => {
    expect(todoTextSimilarity('读卡并核对', '读卡并核对')).toBe(1);
    expect(todoTextSimilarity('读卡并核对', '写实现')).toBe(0);
    expect(
      todoTextSimilarity('读卡并核对', '别的会话自己的工作分解'),
    ).toBeLessThan(0.3);
    // e2e 实测：agent 把 DoD 原文改写后写回 todo，相似度 0.84（高于 0.6 阈值）。
    const rewritten = todoTextSimilarity(
      '已确认会话任务清单已注入官方 todo 投影（可在清单中看到 3 项）',
      '确认会话任务清单已注入官方 todo 投影（3 项）',
    );
    expect(rewritten).toBeGreaterThan(0.6);
    expect(rewritten).toBeLessThan(1);
  });

  it('matchCompletedTodos：精确匹配命中对应 DoD 条目', () => {
    const items = [item('读卡并核对', false), item('写实现', false)];
    const matched = matchCompletedTodos(
      [{ content: '读卡并核对', status: 'completed' }],
      items,
    );
    expect([...matched]).toEqual(['k-读卡并核对']);
  });

  it('matchCompletedTodos：agent 改写文本后仍能近似匹配回原 DoD 条目', () => {
    const items = [
      item(
        '已确认会话任务清单已注入官方 todo 投影（可在清单中看到 3 项）',
        false,
      ),
      item('已用 todo_write 把其中一项标记为 completed', false),
    ];
    const matched = matchCompletedTodos(
      [
        {
          content: '确认会话任务清单已注入官方 todo 投影（3 项）',
          status: 'completed',
        },
      ],
      items,
    );
    expect([...matched]).toEqual([
      'k-已确认会话任务清单已注入官方 todo 投影（可在清单中看到 3 项）',
    ]);
  });

  it('matchCompletedTodos：无关注释不误勾、pending 条目不回写', () => {
    const items = [item('读卡并核对', false), item('写实现', false)];
    const matched = matchCompletedTodos(
      [
        { content: '读卡并核对', status: 'pending' },
        { content: '别的会话自己的工作分解', status: 'completed' },
      ],
      items,
    );
    expect(matched.size).toBe(0);
  });

  it('matchCompletedTodos：一对一——一条 todo 最多勾一个 DoD 条目', () => {
    const items = [
      item('读卡并核对', false),
      item('读卡并核对（补充）', false),
    ];
    const matched = matchCompletedTodos(
      [{ content: '读卡并核对', status: 'completed' }],
      items,
    );
    expect(matched.size).toBe(1);
    expect([...matched]).toEqual(['k-读卡并核对']);
  });

  it('matchCompletedTodos：歧义退避——两个候选都过阈值且差距过小则宁可不匹配', () => {
    // 未勾条目对两条 completed todo 的相似度都 ≥ 0.6，
    // 但最优/次优差距 < 0.1（0.867 vs 0.813，gap 0.054）——判为歧义，
    // 返回空集（宁可不回写，也不能勾错条目）。
    const target = '回写完成后同步勾选卡片清单对应条目';
    const items = [item(target, false)];
    const matched = matchCompletedTodos(
      [
        { content: '回写完成后同步勾选卡片清单条目', status: 'completed' },
        { content: '回写完成后同步勾选卡片清单全部条目', status: 'completed' },
      ],
      items,
    );
    expect(matched.size).toBe(0);
  });

  it('matchCompletedTodos：已勾选项不再参与匹配、重复事件不重复命中', () => {
    const items = [item('读卡并核对', true)];
    expect(
      matchCompletedTodos(
        [{ content: '读卡并核对', status: 'completed' }],
        items,
      ).size,
    ).toBe(0);
  });

  it('PreStepAgentFace 类型兼容最小 agent 面（编译期契约，运行时冒烟）', () => {
    const face: PreStepAgentFace = { session: { append: () => undefined } };
    expect(face.session?.append('todo/write', { todos: [] })).toBeUndefined();
  });

  it('onAgentPreStep：作用域没有 on 能力时返回空操作（软降级不抛错）', () => {
    const dispose = onAgentPreStep(undefined, async () => undefined);
    expect(typeof dispose).toBe('function');
    expect(() => dispose()).not.toThrow();
  });

  it('onAgentPreStep：注入先于 next 执行，且 next 的结果被原样返回', async () => {
    const order: string[] = [];
    let captured:
      | ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>)
      | undefined;
    const scope = {
      on: (_name: string, listener: typeof captured) => {
        captured = listener;
        return () => undefined;
      },
    };
    const dispose = onAgentPreStep(scope, async () => {
      order.push('inject');
    });
    const result = await captured?.({ agent: { id: 'sess-1' } }, async () => {
      order.push('next');
      return 'decision';
    });
    expect(order).toEqual(['inject', 'next']);
    expect(result).toBe('decision');
    expect(() => dispose()).not.toThrow();
  });

  it('onAgentPreStep：handler 抛错也照常调用 next（瀑布链不断）', async () => {
    let captured:
      | ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>)
      | undefined;
    const scope = {
      on: (_name: string, listener: typeof captured) => {
        captured = listener;
        return () => undefined;
      },
    };
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    onAgentPreStep(scope, async () => {
      throw new Error('boom');
    });
    const result = await captured?.(
      { agent: { id: 'sess-1' } },
      async () => 'decision',
    );
    expect(result).toBe('decision');
    expect(error).toHaveBeenCalled();
  });

  it('onAgentPreStep：载荷里没有 agent 面时直接透传 next', async () => {
    let captured:
      | ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>)
      | undefined;
    const scope = {
      on: (_name: string, listener: typeof captured) => {
        captured = listener;
        return () => undefined;
      },
    };
    let called = false;
    onAgentPreStep(scope, async () => {
      called = true;
    });
    const result = await captured?.({}, async () => 'decision');
    expect(called).toBe(false);
    expect(result).toBe('decision');
  });
});
