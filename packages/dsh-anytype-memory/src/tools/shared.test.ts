/**
 * tools/shared.ts 行为测试：语义名 → 属性 key 的映射。
 *
 * 这条映射是活体调试中最易漂移的一环（工具层说 'kind'、存储层查
 * 'memory_kind'、服务端再派生一次）——单元测试必须把它钉住。
 */

import { describe, expect, it } from 'vitest';

import { MEMORY_PROPERTY_KEY } from '../schema.ts';
import { propertyKey } from './shared.ts';

describe('dsh-anytype-memory propertyKey', () => {
  it('语义名映射到插件属性 key（带 Memory 前缀）', () => {
    const keys: Record<string, string> = {};
    expect(propertyKey(keys, 'kind')).toBe('memory_kind');
    expect(propertyKey(keys, 'status')).toBe('memory_status');
    expect(propertyKey(keys, 'contentHash')).toBe('memory_content_hash');
  });

  it('snake_case 与 camelCase 语义名等价', () => {
    expect(propertyKey({}, 'proof_count')).toBe('memory_proof_count');
    expect(propertyKey({}, 'proofCount')).toBe('memory_proof_count');
    expect(propertyKey({}, 'embedding_model')).toBe('memory_embedding_model');
  });

  it('受控边语义名映射到受控边属性 key', () => {
    expect(propertyKey({}, 'relates_to')).toBe('memory_relates_to');
    expect(propertyKey({}, 'supersedes')).toBe('memory_supersedes');
  });

  it('复用内置的 tag 属性（不加前缀）', () => {
    expect(propertyKey({}, 'tag')).toBe('tag');
    expect(MEMORY_PROPERTY_KEY.tag).toBe('tag');
  });

  it('命中服务端真实 key（bootstrap 读回的映射优先）', () => {
    const keys = { memory_kind: 'kind_derived_by_server' };
    expect(propertyKey(keys, 'kind')).toBe('kind_derived_by_server');
  });

  it('未知语义名原样返回（不猜）', () => {
    expect(propertyKey({}, 'unknown_field')).toBe('unknown_field');
  });
});
