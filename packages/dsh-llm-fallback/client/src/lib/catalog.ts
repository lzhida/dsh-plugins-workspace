/**
 * 模型目录与回退队列的纯函数（无 React 依赖，供组件与测试直接使用）。
 *
 * @module dsh-llm-fallback/client/lib/catalog
 */

import type { CatalogGroup, CatalogModel } from '../types.ts';

/** 回退队列单条候选（provider/model 路由）。 */
export interface Route {
  provider: string;
  model: string;
}

/** 目录条目的最小形状（sameQueue 之外的函数用到）。 */
export type GroupLike = Pick<CatalogGroup, 'id'> & {
  models: Array<Pick<CatalogModel, 'id'> & { name?: string }>;
};

/** 单条队列项的稳定 key。 */
export function routeKey(route: Route): string {
  return route.provider + '/' + route.model;
}

/** 队列是否一致（顺序敏感）。 */
export function sameQueue(a: Route[], b: Route[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].provider !== b[i].provider || a[i].model !== b[i].model) {
      return false;
    }
  }
  return true;
}

/**
 * 搜索过滤谓词：provider 分组名 / 模型 id / 显示名，大小写不敏感子串匹配。
 * 空搜索词（或纯空白）视为不过滤，返回 true。
 */
export function modelMatches(
  group: GroupLike,
  model: GroupLike['models'][number],
  query: string,
): boolean {
  const q = String(query ?? '')
    .trim()
    .toLowerCase();
  if (!q) return true;
  return (
    String(group.id ?? '')
      .toLowerCase()
      .indexOf(q) !== -1 ||
    String(model.id ?? '')
      .toLowerCase()
      .indexOf(q) !== -1 ||
    String(model.name ?? '')
      .toLowerCase()
      .indexOf(q) !== -1
  );
}

/** 目录分组 × 搜索词 → 仍有命中的分组（组内模型已过滤；全部无命中返回 []）。 */
export function filteredCatalogGroups(
  groups: GroupLike[] | null | undefined,
  query: string,
): GroupLike[] {
  return (groups ?? [])
    .map((group) => ({
      id: group.id,
      models: group.models.filter((model) => modelMatches(group, model, query)),
    }))
    .filter((group) => group.models.length > 0);
}
