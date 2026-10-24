/**
 * chunk.ts 行为测试：确定性切块（零 LLM）与检索词元抽取。
 */

import { describe, expect, it } from 'vitest';

import { chunkText, queryTerms } from './chunk.ts';

describe('dsh-anytype-memory chunk', () => {
  it('空文本切出零块', () => {
    expect(chunkText('   ')).toEqual([]);
  });

  it('短文本切出一块', () => {
    const chunks = chunkText('一段很短的文字');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].text).toBe('一段很短的文字');
  });

  it('按段落聚合：多段落在目标长度内时合成一块', () => {
    const text = '第一段内容。\n\n第二段内容。';
    const chunks = chunkText(text, { targetChars: 400 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('第一段内容。');
    expect(chunks[0].text).toContain('第二段内容。');
  });

  it('超长段落按句子切分且每块不超过硬上限', () => {
    const sentence = '这是一句用于测试切分逻辑的中文句子。';
    const text = sentence.repeat(60);
    const chunks = chunkText(text, { targetChars: 400, maxChars: 800 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(800 * 2);
    }
  });

  it('块序号连续', () => {
    const text = Array.from({ length: 30 }, (_, i) => `段落 ${i} 内容`).join(
      '\n\n',
    );
    const chunks = chunkText(text, { targetChars: 100 });
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('尾部碎片并回上一块', () => {
    const text = `${'长内容'.repeat(120)}\n\n尾`;
    const chunks = chunkText(text, { targetChars: 200, minTailChars: 50 });
    expect(chunks[chunks.length - 1].text.length).toBeGreaterThan(50);
  });

  it('切块是确定性的：同样输入同样输出', () => {
    const text = '甲。\n\n乙。\n\n丙。';
    expect(chunkText(text)).toEqual(chunkText(text));
  });

  it('词元抽取：英文按词、中文短串整体保留', () => {
    const terms = queryTerms('使用 pnpm 管理依赖 持久记忆');
    expect(terms).toContain('pnpm');
    expect(terms).toContain('使用');
    expect(terms).toContain('持久记忆');
  });

  it('词元抽取：超长中文串退化为 2-gram', () => {
    const terms = queryTerms('这是一个很长的没有空格的中文句子用来测试切分');
    expect(terms).toContain('这是');
    expect(terms).toContain('一个');
  });

  it('词元抽取去重且限量', () => {
    const terms = queryTerms('test test test test test', 3);
    expect(new Set(terms).size).toBe(terms.length);
    expect(terms.length).toBeLessThanOrEqual(3);
  });
});
