/**
 * embedding.ts 行为测试：base64(Float32) 编解码往返、向量校验、余弦相似度。
 */

import { describe, expect, it } from 'vitest';

import {
  cosineSimilarity,
  decodeVector,
  encodeVector,
  validateVector,
} from './embedding.ts';

describe('dsh-anytype-memory embedding', () => {
  it('编解码往返保持数值（float32 精度内）', () => {
    const vector = [0.5, -0.25, 1, 0];
    const decoded = decodeVector(encodeVector(vector));
    expect(decoded).not.toBeNull();
    expect(decoded).toHaveLength(4);
    for (let i = 0; i < vector.length; i += 1) {
      expect(decoded?.[i]).toBeCloseTo(vector[i], 6);
    }
  });

  it('编码结果体积与维度成正比（768 维约 4KB base64）', () => {
    const vector = new Array(768).fill(0.1);
    const encoded = encodeVector(vector);
    expect(encoded.length).toBeGreaterThan(3000);
    expect(encoded.length).toBeLessThan(5000);
  });

  it('解码非法输入返回 null 而不是抛错', () => {
    expect(decodeVector('')).toBeNull();
    expect(decodeVector(undefined)).toBeNull();
    expect(decodeVector('not-base64!!')).toBeNull();
  });

  it('校验拒绝非数组、空数组、非有限数与超维向量', () => {
    expect(validateVector([1, 2]).ok).toBe(true);
    expect(validateVector('x' as unknown as number[]).ok).toBe(false);
    expect(validateVector([]).ok).toBe(false);
    expect(validateVector([1, Number.NaN]).ok).toBe(false);
    expect(validateVector([Number.POSITIVE_INFINITY]).ok).toBe(false);
    expect(validateVector(new Array(5000).fill(0)).ok).toBe(false);
  });

  it('余弦：同向量为 1，正交为 0，反向为 -1', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });

  it('余弦：维度不符或零向量返回 0（不产出无意义分数）', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });
});
