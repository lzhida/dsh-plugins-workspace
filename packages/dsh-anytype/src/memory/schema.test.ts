/**
 * schema.ts 行为测试：词表、bootstrap 计划与真实属性 key 解析。
 */

import { describe, expect, it } from 'vitest';

import {
  EDGE_RELATIONS,
  MEMORY_KINDS,
  MEMORY_PROPERTIES,
  MEMORY_STATUSES,
  MEMORY_TYPE_KEY,
  SCOPE_PROPERTIES,
  SCOPE_TYPE_KEY,
  planBootstrap,
  resolvePropertyKeys,
} from './schema.ts';

describe('dsh-anytype-memory schema', () => {
  it('词表稳定：kind 与状态与受控边不重复', () => {
    expect(new Set(MEMORY_KINDS).size).toBe(MEMORY_KINDS.length);
    expect(new Set(MEMORY_STATUSES).size).toBe(MEMORY_STATUSES.length);
    expect(new Set(EDGE_RELATIONS).size).toBe(EDGE_RELATIONS.length);
  });

  it('受控边恰好五条且不含自由链接语义', () => {
    expect([...EDGE_RELATIONS]).toEqual([
      'relates_to',
      'derived_from',
      'contradicts',
      'supersedes',
      'mentions',
    ]);
  });

  it('属性字典覆盖记忆语义关键字段', () => {
    const keys = MEMORY_PROPERTIES.map((p) => p.key);
    for (const key of [
      'memory_kind',
      'memory_status',
      'memory_origin',
      'memory_scope',
      'memory_source',
      'memory_valid_from',
      'memory_valid_to',
      'memory_confidence',
      'memory_importance',
      'memory_proof_count',
      'memory_access_count',
      'memory_content_hash',
      'memory_embedding',
      'memory_embedding_model',
      'memory_embedding_dim',
    ]) {
      expect(keys).toContain(key);
    }
  });

  it('属性 key 不重复；受控 select 属性都带选项词表（tag 是开放词表，无固定选项）', () => {
    const keys = MEMORY_PROPERTIES.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const spec of MEMORY_PROPERTIES) {
      if (spec.key === 'tag') continue;
      if (spec.format === 'select' || spec.format === 'multi_select') {
        expect(spec.options?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it('作用域类型与记忆类型是不同的 key', () => {
    expect(MEMORY_TYPE_KEY).toBe('memory');
    expect(SCOPE_TYPE_KEY).toBe('memory_scope');
    expect(SCOPE_PROPERTIES.map((p) => p.key)).toEqual([
      'scope_kind',
      'scope_key',
    ]);
  });

  it('空空间的 bootstrap 计划：建两个类型并铸造全部属性', () => {
    const plan = planBootstrap([], []);
    expect(plan.createTypes.map((t) => t.key)).toEqual([
      'memory',
      'memory_scope',
    ]);
    expect(plan.createProperties.length).toBe(
      MEMORY_PROPERTIES.length + SCOPE_PROPERTIES.length,
    );
    expect(plan.typePropertyDefinitions['memory'].length).toBe(
      MEMORY_PROPERTIES.length,
    );
  });

  it('已存在的空间不再重复创建类型，只补缺失属性', () => {
    const plan = planBootstrap(
      ['memory', 'memory_scope'],
      ['memory_kind', 'memory_status'],
    );
    expect(plan.createTypes).toHaveLength(0);
    expect(plan.existingTypes).toEqual(['memory', 'memory_scope']);
    expect(plan.createProperties.some((p) => p.key === 'memory_kind')).toBe(
      false,
    );
    expect(
      plan.createProperties.some((p) => p.key === 'memory_content_hash'),
    ).toBe(true);
  });

  it('类型新建时携带的字段表带显示名与格式', () => {
    const plan = planBootstrap([], []);
    const defs = plan.typePropertyDefinitions['memory'];
    const kindDef = defs.find((d) => d.name === 'Memory kind');
    expect(kindDef?.format).toBe('select');
    expect(Array.isArray(kindDef?.options)).toBe(true);
  });

  it('真实 key 按显示名解析，解析不到时退回期望 key', () => {
    const resolved = resolvePropertyKeys(
      [
        { key: 'memory_content_hash', name: 'Memory content hash' },
        { key: 'memory_kind', name: 'Memory kind' },
      ],
      MEMORY_PROPERTIES,
    );
    expect(resolved.memory_content_hash).toBe('memory_content_hash');
    expect(resolved.memory_kind).toBe('memory_kind');
    expect(resolved.memory_embedding_model).toBe('memory_embedding_model');
  });

  it('真实 key 与期望不同（服务端派生漂移）时以服务端为准', () => {
    const resolved = resolvePropertyKeys(
      [{ key: 'memorycontenthash', name: 'Memory content hash' }],
      MEMORY_PROPERTIES,
    );
    expect(resolved.memory_content_hash).toBe('memorycontenthash');
  });
});
