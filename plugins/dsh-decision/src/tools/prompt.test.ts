import { describe, expect, it } from 'vitest';

import {
  buildJudgementPrompt,
  estimatePromptTokens,
  stringifyDetail,
} from './prompt.ts';

describe('决策工具 prompt 组装', () => {
  it('buildJudgementPrompt 按 PURPOSE→CONSTRAINTS→ACTIONS→DETAIL 固定顺序输出', () => {
    const text = buildJudgementPrompt({
      purpose: 'PURPOSE-BODY',
      constraints: ['C-ONE', 'C-TWO'],
      actions: ['A-ONE'],
      detail: 'DETAIL-BODY',
    });

    const at = (needle: string) => text.indexOf(needle);
    expect(at('PURPOSE:')).toBeGreaterThanOrEqual(0);
    expect(at('CONSTRAINTS:')).toBeGreaterThan(at('PURPOSE:'));
    expect(at('ACTIONS:')).toBeGreaterThan(at('CONSTRAINTS:'));
    expect(at('DETAIL:')).toBeGreaterThan(at('ACTIONS:'));
    expect(at('DETAIL-BODY')).toBeGreaterThan(at('DETAIL:'));
    // 约束与动作都带 `- ` 列表前缀
    expect(text).toContain('- C-ONE');
    expect(text).toContain('- A-ONE');
  });

  it('buildJudgementPrompt 的 detail 只出现一次（关键事实不重复）', () => {
    const marker = 'UNIQUE-DETAIL-MARKER-9f3a';
    const text = buildJudgementPrompt({
      purpose: 'p',
      constraints: ['c'],
      actions: ['a'],
      detail: marker,
    });
    const occurrences = text.split(marker).length - 1;
    expect(occurrences).toBe(1);
  });

  it('stringifyDetail 字符串原样、对象 JSON 序列化、不可序列化给占位符', () => {
    expect(stringifyDetail('plain')).toBe('plain');
    expect(stringifyDetail({ k: 1, s: 'x' })).toBe('{"k":1,"s":"x"}');

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(stringifyDetail(cyclic as never)).toBe('[unserializable detail]');
  });

  it('estimatePromptTokens 按 4 字符≈1 token 向上取整', () => {
    expect(estimatePromptTokens('')).toBe(0);
    expect(estimatePromptTokens('abcd')).toBe(1);
    expect(estimatePromptTokens('abcde')).toBe(2);
    expect(estimatePromptTokens('x'.repeat(400))).toBe(100);
  });
});
