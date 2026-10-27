/**
 * catalog 纯函数单测：显示名实时解析（分支 A）、stale 判定与剔除
 * （分支 B）——覆盖目录不可用/查询失败 provider 的保守性规则。
 */
import { describe, expect, it } from 'vitest';
import {
  isStaleRoute,
  pruneStaleRoutes,
  queueEntryLabel,
  staleRouteKeys,
  type CatalogSnapshotLike,
} from './catalog.ts';
import type { Route } from './catalog.ts';

/** 测试目录：prov 组含 m1（有 name）与 m2（无 name 字段 → undefined）。 */
const CATALOG: CatalogSnapshotLike = {
  groups: [
    {
      id: 'prov',
      models: [{ id: 'm1', name: 'Model One' }, { id: 'm2' }],
    },
    { id: 'other', models: [{ id: 'x', name: 'X' }] },
  ],
};

describe('queueEntryLabel(分支 A:显示名实时化)', () => {
  it('目录命中 → 实时返回目录 name(不依赖保存时快照)', () => {
    expect(queueEntryLabel(CATALOG, { provider: 'prov', model: 'm1' })).toBe(
      'Model One',
    );
  });

  it('目录条目 name 为空串/缺失 → 回退 provider/model 路由键', () => {
    expect(queueEntryLabel(CATALOG, { provider: 'prov', model: 'm2' })).toBe(
      'prov/m2',
    );
  });

  it('条目不在目录 → 回退 provider/model(稳定可读形态)', () => {
    expect(queueEntryLabel(CATALOG, { provider: 'prov', model: 'ghost' })).toBe(
      'prov/ghost',
    );
    expect(queueEntryLabel(CATALOG, { provider: 'gone', model: 'm1' })).toBe(
      'gone/m1',
    );
  });

  it('目录不可用(null/undefined) → 一律回退路由键', () => {
    const route: Route = { provider: 'prov', model: 'm1' };
    expect(queueEntryLabel(null, route)).toBe('prov/m1');
    expect(queueEntryLabel(undefined, route)).toBe('prov/m1');
  });
});

describe('isStaleRoute / staleRouteKeys(分支 B:stale 判定)', () => {
  it('provider 组存在但模型 id 不在目录 → 失效(删除/id 变更场景)', () => {
    expect(isStaleRoute(CATALOG, { provider: 'prov', model: 'ghost' })).toBe(
      true,
    );
  });

  it('provider 整组不在目录(且非查询失败) → 失效(provider 删除场景)', () => {
    expect(isStaleRoute(CATALOG, { provider: 'gone', model: 'm1' })).toBe(true);
  });

  it('目录命中(仅显示名变化) → 不失效(分支 A 场景,键仍有效)', () => {
    expect(isStaleRoute(CATALOG, { provider: 'prov', model: 'm1' })).toBe(
      false,
    );
    expect(isStaleRoute(CATALOG, { provider: 'prov', model: 'm2' })).toBe(
      false,
    );
  });

  it('目录不可用(null/undefined) → 一律不失效(不误标)', () => {
    const route: Route = { provider: 'gone', model: 'm1' };
    expect(isStaleRoute(null, route)).toBe(false);
    expect(isStaleRoute(undefined, route)).toBe(false);
    expect(staleRouteKeys(null, [route])).toEqual(new Set());
  });

  it('provider 在查询失败集(unverified)中 → 不失效(无法验证 ≠ 不存在)', () => {
    const catalog: CatalogSnapshotLike = {
      groups: CATALOG.groups,
      unverifiedProviders: new Set(['gone', 'prov']),
    };
    // provider 整组不在 groups 但在 unverified → 保守不标
    expect(isStaleRoute(catalog, { provider: 'gone', model: 'm1' })).toBe(
      false,
    );
    // provider 在 groups 也在 unverified(瞬时故障) → 同样保守不标
    expect(isStaleRoute(catalog, { provider: 'prov', model: 'ghost' })).toBe(
      false,
    );
  });

  it('staleRouteKeys 返回失效条目的 routeKey 集合', () => {
    const queue: Route[] = [
      { provider: 'prov', model: 'm1' },
      { provider: 'prov', model: 'ghost' },
      { provider: 'gone', model: 'x' },
    ];
    expect(staleRouteKeys(CATALOG, queue)).toEqual(
      new Set(['prov/ghost', 'gone/x']),
    );
  });
});

describe('pruneStaleRoutes(分支 B:剔除)', () => {
  it('剔除失效条目且保持剩余顺序', () => {
    const queue: Route[] = [
      { provider: 'prov', model: 'ghost' },
      { provider: 'prov', model: 'm1' },
      { provider: 'gone', model: 'x' },
      { provider: 'other', model: 'x' },
    ];
    expect(pruneStaleRoutes(CATALOG, queue)).toEqual([
      { provider: 'prov', model: 'm1' },
      { provider: 'other', model: 'x' },
    ]);
  });

  it('无失效条目 → 返回原数组引用(调用方可短路)', () => {
    const queue: Route[] = [{ provider: 'prov', model: 'm1' }];
    expect(pruneStaleRoutes(CATALOG, queue)).toBe(queue);
  });

  it('目录不可用 → 原样返回(保存路径零行为变化)', () => {
    const queue: Route[] = [{ provider: 'gone', model: 'x' }];
    expect(pruneStaleRoutes(null, queue)).toBe(queue);
  });

  it('全部失效 → 返回空数组', () => {
    expect(
      pruneStaleRoutes(CATALOG, [{ provider: 'gone', model: 'x' }]),
    ).toEqual([]);
  });
});
