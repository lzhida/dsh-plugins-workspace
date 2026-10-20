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

/**
 * 目录快照的最小形状：stale 判定 / 显示名解析的输入。
 *
 * `unverifiedProviders` 收录目录查询**失败**的 provider id（宿主
 * buildModelCatalog 把 listModels 抛错的 provider 放进 failures 而非
 * groups）——这些 provider 的队列条目**无法验证**，绝不能据此判失效，
 * 否则 provider 瞬时故障（如网络抖动、API key 失效）会把健康的队列条目
 * 全部误标。null/undefined 整体表示目录不可用（未加载/加载失败），所有
 * 函数对其保守回退：不标失效、不剔除、显示名回退路由键。
 */
export interface CatalogSnapshotLike {
  groups: GroupLike[];
  /** 目录查询失败的 provider id 集（其中的条目不参与 stale 判定）。 */
  unverifiedProviders?: ReadonlySet<string>;
}

/** 单条队列项的稳定 key。 */
export function routeKey(route: Route): string {
  return route.provider + '/' + route.model;
}

/**
 * 从目录解析模型的实时显示名。
 * 命中（provider 分组存在且组内有该 model id）→ 返回目录 `name`；
 * 未命中或目录不可用 → 返回 undefined（调用方回退自身快照/路由键）。
 */
export function catalogModelName(
  catalog: CatalogSnapshotLike | null | undefined,
  provider: string,
  model: string,
): string | undefined {
  const group = (catalog?.groups ?? []).find((g) => g.id === provider);
  return group?.models.find((m) => m.id === model)?.name;
}

/**
 * 队列条目的实时显示标签（分支 A：显示名跟随目录）。
 * 目录命中 → 目录 `name`（用户在 dsh 侧重命名后即时生效，不依赖保存时
 * 快照）；未命中/目录不可用 → 回退 `provider/model` 路由键（条目目录
 * 缺失时的稳定可读形态）。
 */
export function queueEntryLabel(
  catalog: CatalogSnapshotLike | null | undefined,
  route: Route,
): string {
  const name = catalogModelName(catalog, route.provider, route.model);
  return typeof name === 'string' && name.length > 0 ? name : routeKey(route);
}

/**
 * 队列条目是否已失效（分支 B：stale 判定）。
 *
 * 失效 = 目录**可用**且条目的 provider/model 路由不在目录中（模型被删除
 * 或 id 变更）。保守性规则：
 * - `catalog` 缺失（目录未加载/加载失败）→ false（不误标）；
 * - 条目 provider 在 `unverifiedProviders` 中（该 provider 的目录查询
 *   失败）→ false（无法验证 ≠ 不存在）。
 */
export function isStaleRoute(
  catalog: CatalogSnapshotLike | null | undefined,
  route: Route,
): boolean {
  if (!catalog) return false;
  if (catalog.unverifiedProviders?.has(route.provider)) return false;
  const group = catalog.groups.find((g) => g.id === route.provider);
  if (!group) return true; // provider 整组不在目录（且非查询失败）→ 失效
  return !group.models.some((m) => m.id === route.model);
}

/**
 * 队列中全部失效条目的 key 集合。目录不可用（null/undefined）→ 空集。
 * UI 以此渲染失效徽标；空集即"无可标记项"。
 */
export function staleRouteKeys(
  catalog: CatalogSnapshotLike | null | undefined,
  queue: readonly Route[],
): Set<string> {
  const keys = new Set<string>();
  if (!catalog) return keys;
  for (const route of queue) {
    if (isStaleRoute(catalog, route)) keys.add(routeKey(route));
  }
  return keys;
}

/**
 * 剔除队列中的失效条目（保序）。目录不可用 → 原样返回（同一数组引用，
 * 便于调用方短路）；无可剔除项 → 返回原数组引用。供一键清理与保存路径
 * （写入载荷剔除失效项）共用。
 */
export function pruneStaleRoutes(
  catalog: CatalogSnapshotLike | null | undefined,
  queue: readonly Route[],
): Route[] {
  if (!catalog) return queue as Route[];
  const kept = queue.filter((route) => !isStaleRoute(catalog, route));
  return kept.length === queue.length ? (queue as Route[]) : kept;
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
