/**
 * schema.ts 纯函数测试：bootstrap 计划幂等、key 解析、裁决映射。
 */

import { describe, expect, it } from 'vitest';

import {
  planWikiBootstrap,
  resolveWikiPropertyKeys,
  REVIEW_DECISION_TO_STATUS,
  WIKI_PROPERTIES,
  WIKI_PROPERTY_KEY,
  WIKI_STATUSES,
  WIKI_TYPE_KEY,
  WIKI_TYPE_SPEC,
} from './schema.ts';

describe('dsh-anytype-wiki schema', () => {
  it('空空间计划：建 wiki_note 类型 + 全部属性字段表（含 status 选项）', () => {
    const plan = planWikiBootstrap([], []);
    expect(plan.createTypes.map((t) => t.key)).toEqual([WIKI_TYPE_KEY]);
    const defs = plan.typePropertyDefinitions[WIKI_TYPE_KEY] ?? [];
    expect(defs).toHaveLength(WIKI_PROPERTIES.length);
    const statusDef = defs.find((d) => d.name === 'Wiki status');
    expect(statusDef).toBeDefined();
    expect(statusDef?.format).toBe('select');
    expect(statusDef?.options).toEqual([
      { name: 'draft' },
      { name: 'approved' },
      { name: 'archived' },
    ]);
    // 属性缺失 → 显式带 key 的补建计划
    expect(plan.createProperties.map((p) => p.key)).toEqual(
      WIKI_PROPERTIES.map((p) => p.key),
    );
  });

  it('幂等计划：类型与属性齐全时什么都不建', () => {
    const plan = planWikiBootstrap(
      [WIKI_TYPE_KEY, 'memo'],
      WIKI_PROPERTIES.map((p) => p.key),
    );
    expect(plan.createTypes).toHaveLength(0);
    expect(plan.createProperties).toHaveLength(0);
    expect(plan.typePropertyDefinitions[WIKI_TYPE_KEY]).toBeUndefined();
  });

  it('部分缺失计划：只补缺失的属性', () => {
    const plan = planWikiBootstrap(
      [WIKI_TYPE_KEY],
      ['wiki_status', 'wiki_source'],
    );
    expect(plan.createTypes).toHaveLength(0);
    expect(plan.createProperties.map((p) => p.key)).toEqual([
      'wiki_created_at',
      'wiki_updated_at',
      'wiki_reviewed_by',
      'wiki_reviewed_at',
      'tag',
    ]);
  });

  it('类型布局必须是 basic（note 布局会吞标题）', () => {
    expect(WIKI_TYPE_SPEC.layout).toBe('basic');
  });

  it('插件自有属性 key 一律 wiki_ 前缀（tag 复用内置）', () => {
    for (const [semantic, key] of Object.entries(WIKI_PROPERTY_KEY)) {
      if (semantic === 'tag') {
        expect(key).toBe('tag');
      } else {
        expect(key.startsWith('wiki_'), `${semantic} → ${key}`).toBe(true);
      }
    }
    expect(WIKI_STATUSES).toEqual(['draft', 'approved', 'archived']);
  });

  it('resolveWikiPropertyKeys：按显示名解析真实 key，未命中退回期望 key', () => {
    const resolved = resolveWikiPropertyKeys(
      [
        { key: 'served_status', name: 'Wiki status' },
        { key: 'unrelated', name: 'Something else' },
      ],
      WIKI_PROPERTIES,
    );
    expect(resolved.wiki_status).toBe('served_status');
    // 显示名匹配不到 → 退回期望 key（bootstrap 后正常空间总会命中）
    expect(resolved.wiki_source).toBe('wiki_source');
  });

  it('裁决映射：approve→approved，reject/archive→archived', () => {
    expect(REVIEW_DECISION_TO_STATUS.approve).toBe('approved');
    expect(REVIEW_DECISION_TO_STATUS.reject).toBe('archived');
    expect(REVIEW_DECISION_TO_STATUS.archive).toBe('archived');
  });
});
