/**
 * dedup.ts 行为测试：归一化、content_hash 稳定性与作用域隔离、filter 构造。
 */

import { describe, expect, it } from 'vitest';

import {
  contentHash,
  contentHashFilter,
  liveConflicts,
  normalizeContent,
} from './dedup.ts';

describe('dsh-anytype-memory dedup', () => {
  it('归一化折叠空白并去首尾', () => {
    expect(normalizeContent('  你好   世界 \n')).toBe('你好 世界');
  });

  it('归一化对全角空格与多行段一律折叠', () => {
    expect(normalizeContent('a　 b\n\nc')).toBe('a b c');
  });

  it('同一内容不同排版得到同一个哈希', () => {
    const a = contentHash('space#', 'fact', '用户偏好 pnpm');
    const b = contentHash('space#', 'fact', '  用户偏好   pnpm\n');
    expect(a).toBe(b);
  });

  it('不同作用域的同内容哈希不同（不跨作用域去重）', () => {
    expect(contentHash('spaceA#', 'fact', 'x')).not.toBe(
      contentHash('spaceB#', 'fact', 'x'),
    );
  });

  it('不同种类的同内容哈希不同', () => {
    expect(contentHash('space#', 'fact', 'x')).not.toBe(
      contentHash('space#', 'decision', 'x'),
    );
  });

  it('哈希是 64 位十六进制', () => {
    expect(contentHash('s', 'fact', 'x')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('filter 片段用引号包裹并转义内部引号', () => {
    expect(contentHashFilter('content_hash', 'abc')).toBe(
      'content_hash = "abc"',
    );
    expect(contentHashFilter('content_hash', 'a"b')).toBe(
      'content_hash = "a\\"b"',
    );
  });

  it('冲突候选过滤掉已归档与已取代的条目', () => {
    const candidates = [
      { objectId: 'a', kind: 'fact', status: 'draft', excerpt: 'x' },
      { objectId: 'b', kind: 'fact', status: 'archived', excerpt: 'y' },
      { objectId: 'c', kind: 'fact', status: 'superseded', excerpt: 'z' },
      { objectId: 'd', kind: 'fact', status: 'disputed', excerpt: 'w' },
    ];
    expect(liveConflicts(candidates).map((c) => c.objectId)).toEqual([
      'a',
      'd',
    ]);
  });
});
