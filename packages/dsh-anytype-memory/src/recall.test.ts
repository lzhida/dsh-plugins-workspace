/**
 * recall.ts 行为测试：RRF、乘性旁证权重、状态过滤与 token 预算截断。
 */

import { describe, expect, it } from 'vitest';

import {
  applyTokenBudget,
  estimateTokens,
  finalScore,
  fuseCandidates,
  proofBoost,
  recencyBoost,
  rrfScore,
  scaleBoost,
  type RecallCandidate,
} from './recall.ts';

/** 造一个候选（默认给足旁证，便于单点断言）。 */
function candidate(overrides: Partial<RecallCandidate> = {}): RecallCandidate {
  return {
    objectId: 'm1',
    name: '记忆标题',
    excerpt: '正文摘要',
    kind: 'fact',
    status: 'approved',
    origin: 'agent',
    confidence: 8,
    importance: 5,
    proofCount: 2,
    createdAt: new Date('2026-10-01T00:00:00Z').toISOString(),
    ranks: { lexical: 1 },
    ...overrides,
  };
}

describe('dsh-anytype-memory recall', () => {
  it('RRF 只吃名次：单臂第一名的得分高于第二名', () => {
    expect(rrfScore({ lexical: 1 })).toBeGreaterThan(rrfScore({ lexical: 2 }));
  });

  it('RRF 多臂叠加：命中两臂的候选得分更高', () => {
    const one = rrfScore({ lexical: 3 });
    const two = rrfScore({ lexical: 3, vector: 3 });
    expect(two).toBeGreaterThan(one);
  });

  it('RRF 忽略非法名次（0 与负数）', () => {
    expect(rrfScore({ lexical: 0 })).toBe(0);
    expect(rrfScore({ lexical: -1 })).toBe(0);
  });

  it('新鲜度随时间衰减并有 0.1 下限', () => {
    const now = Date.parse('2026-10-23T00:00:00Z');
    const fresh = recencyBoost('2026-10-22T00:00:00Z', now);
    const old = recencyBoost('2020-01-01T00:00:00Z', now);
    expect(fresh).toBeGreaterThan(old);
    expect(old).toBeCloseTo(0.1, 5);
  });

  it('缺失时间戳时新鲜度取中性值', () => {
    expect(recencyBoost(undefined, Date.now())).toBe(0.5);
  });

  it('置信度归一化到 [0.1,1]，缺失取中性', () => {
    expect(scaleBoost(10)).toBeCloseTo(1, 5);
    expect(scaleBoost(1)).toBeCloseTo(0.19, 5);
    expect(scaleBoost(undefined)).toBe(0.5);
  });

  it('佐证计数越多乘子越高，上限为 1', () => {
    expect(proofBoost(0)).toBe(0.5);
    expect(proofBoost(3)).toBeCloseTo(1, 5);
    expect(proofBoost(99)).toBeCloseTo(1, 5);
  });

  it('最终分是乘性：低相关但高置信不越过高相关的普通候选', () => {
    const now = Date.parse('2026-10-23T00:00:00Z');
    const highRelevant = finalScore(candidate({ ranks: { lexical: 1 } }), {
      now,
    });
    const lowRelevant = finalScore(
      candidate({
        objectId: 'm2',
        ranks: { lexical: 40 },
        confidence: 10,
        proofCount: 9,
      }),
      { now },
    );
    expect(highRelevant.score).toBeGreaterThan(lowRelevant.score);
  });

  it('融合默认过滤 archived 与 superseded，draft 默认可见', () => {
    const fused = fuseCandidates([
      candidate({ objectId: 'a', status: 'archived' }),
      candidate({ objectId: 'b', status: 'superseded' }),
      candidate({ objectId: 'c', status: 'draft' }),
      candidate({ objectId: 'd', status: 'approved' }),
    ]);
    expect(fused.map((f) => f.objectId).sort()).toEqual(['c', 'd']);
  });

  it('融合可显式排除 draft', () => {
    const fused = fuseCandidates(
      [candidate({ objectId: 'a', status: 'draft' })],
      { includeDraft: false },
    );
    expect(fused).toHaveLength(0);
  });

  it('融合记录命中了哪些臂并按分数降序', () => {
    const fused = fuseCandidates([
      candidate({ objectId: 'a', ranks: { lexical: 5 } }),
      candidate({ objectId: 'b', ranks: { lexical: 1, vector: 2 } }),
    ]);
    expect(fused[0].objectId).toBe('b');
    expect(fused[0].armsHit.sort()).toEqual(['lexical', 'vector']);
  });

  it('被排除的臂不参与融合', () => {
    const fused = fuseCandidates(
      [candidate({ objectId: 'a', ranks: { lexical: 1, vector: 2 } })],
      { arms: ['lexical'] },
    );
    expect(fused[0].armsHit).toEqual(['lexical']);
  });

  it('token 估算对中文按字计、对 ASCII 按四字计', () => {
    expect(estimateTokens('中文字')).toBe(3);
    expect(estimateTokens('abcd')).toBe(1);
  });

  it('预算不足时截断并报告丢弃条数，且至少保留第一条', () => {
    const items = [
      { excerpt: '中文正文内容', id: 'a' },
      { excerpt: '中文正文内容', id: 'b' },
      { excerpt: '中文正文内容', id: 'c' },
    ];
    const result = applyTokenBudget(items, 7);
    expect(result.items).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.omittedCount).toBe(2);
  });

  it('预算充足时全部保留且不标截断', () => {
    const result = applyTokenBudget([{ excerpt: '短' }], 4096);
    expect(result.items).toHaveLength(1);
    expect(result.truncated).toBe(false);
    expect(result.omittedCount).toBe(0);
  });
});
