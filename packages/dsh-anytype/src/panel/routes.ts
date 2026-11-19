/**
 * 左侧栏面板的**只读**数据通道（host 半区）。
 *
 * ## 通道形态
 *
 * 沿用 dsh-taskboard 已实证的形态：宿主 `webServer` 服务注册一个 prefix
 * 路由，本文件在 prefix 下按路径分发两个只读 GET 端点：
 *
 * - `GET /dsh-anytype/panel/status` → 连接状态 + 空间列表 + 最近笔记；
 * - `GET /dsh-anytype/panel/queue`  → wiki 待审（draft）队列。
 *
 * 响应是统一 JSON 信封（`{ok:true,value}` / `{ok:false,error}`），
 * `content-type: application/json; charset=utf-8` + `cache-control: no-store`。
 *
 * ## 边界（v1 只读）
 *
 * - **只读**：本文件不含任何写入调用（不 approve / reject / 写笔记）；
 * - **密钥不回显**：apiKey 只以 `apiKeyConfigured: boolean` 出现，值永不过线；
 * - **不 import 工具层**：过滤语法与属性键解析在本文件内自持（工具层是
 *   工具语义，面板是只读视图面，两者松耦合）；
 * - **失败即降级**：任何上游异常都转成 `error` 字段，HTTP 仍 200，
 *   面板据此显示「不可用」而不是白屏。
 *
 * ## 类型面
 *
 * `webServer` 的类型用**本包内的最小结构**声明（见 `WebServerLike`），
 * 不引第三方包类型——引依赖会改动 lock 文件，本仓约定禁止。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AnytypeClient } from '../core/index.ts';
import { WIKI_PROPERTY_KEY } from '../wiki/schema.ts';
import { WikiStore } from '../wiki/store.ts';

/** 面板路由前缀（与 client 半区 fetch 路径一致）。 */
export const PANEL_ROUTE_PREFIX = '/dsh-anytype/panel';

/** status 端点路径（prefix 之后的段）。 */
export const PANEL_STATUS_PATH = '/status';

/** queue 端点路径（prefix 之后的段）。 */
export const PANEL_QUEUE_PATH = '/queue';

/** 宿主 webServer 服务的最小结构面（只用到 register）。 */
export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (
      req: IncomingMessage,
      res: ServerResponse,
    ) => void | Promise<void>;
  }): () => void;
}

/** 面板数据依赖（由插件行①组装：连接服务 + wiki 存储）。 */
export interface PanelDeps {
  /** 现读配置的 Anytype 客户端（探测 / 列空间用）。 */
  client: AnytypeClient;
  /** 笔记存储（列空间 / 查待审用）。 */
  store: WikiStore;
  /** 当前 baseUrl（面板显示用，不含密钥）。 */
  baseUrl: () => string;
  /** apiKey 是否已配置（只报布尔，绝不回显值）。 */
  apiKeyConfigured: () => boolean;
}

/** 面板查询参数（可选空间 id）。 */
export interface PanelQuery {
  /** 指定空间；缺省取空间列表的第一个。 */
  spaceId?: string;
  /** 最近笔记条数上限。 */
  limit?: number;
}

/** 连接状态（面板第一节）。 */
export interface PanelConnection {
  /** 是否配置了 apiKey（布尔，不回显值）。 */
  apiKeyConfigured: boolean;
  /** API 地址。 */
  baseUrl: string;
  /** 桌面端是否可达（whoami 有响应）。 */
  reachable: boolean;
  /** 是否已认证（whoami 2xx）。 */
  authenticated: boolean;
  /** 探测耗时（毫秒）。 */
  latencyMs: number;
  /** 探测错误信息（可达但未认证 / 网络不可达）。 */
  error: string | null;
}

/** 空间摘要。 */
export interface PanelSpace {
  id: string;
  name: string;
}

/** 笔记摘要（待审队列与最近笔记共用）。 */
export interface PanelNote {
  id: string;
  name: string;
  status: string;
  source: string | null;
  updatedAt: string | null;
}

/** status 端点载荷。 */
export interface PanelStatus {
  connection: PanelConnection;
  spaces: PanelSpace[];
  recentNotes: PanelNote[];
  /** 本次快照时间（ISO 8601）。 */
  checkedAt: string;
  /** 采集过程中的降级信息（任一段失败时给出，面板显示为提示行）。 */
  warning: string | null;
}

/** queue 端点载荷。 */
export interface PanelQueue {
  spaceId: string | null;
  pending: PanelNote[];
  total: number | null;
  hasMore: boolean;
  checkedAt: string;
  warning: string | null;
}

/** 取属性真实 key（语义名 → 期望 key → 服务端实际 key）。 */
function propertyKey(
  keys: Record<string, string>,
  semantic: keyof typeof WIKI_PROPERTY_KEY,
): string {
  const expected = WIKI_PROPERTY_KEY[semantic];
  return keys[expected] ?? expected;
}

/** 紧凑 filter 片段：`key IN ("a", "b")`。 */
function inFilter(key: string, values: readonly string[]): string {
  if (values.length === 0) return '';
  const list = values.map((v) => `"${v.replace(/"/g, '\\"')}"`).join(', ');
  return `${key} IN (${list})`;
}

/** 属性值取文本（标量 / 数组首元素）。 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === 'string');
    return typeof first === 'string' ? first : '';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

/** 列出空间（失败返回空数组）。 */
async function listSpaces(
  deps: PanelDeps,
): Promise<{ spaces: PanelSpace[]; warning: string | null }> {
  try {
    const rows = await deps.store.listSpaces();
    return {
      spaces: rows.map((row) => ({ id: row.id, name: row.name })),
      warning: null,
    };
  } catch (err) {
    return {
      spaces: [],
      warning: `spaces unavailable: ${errorText(err)}`,
    };
  }
}

/** 采集 status 载荷（连接 + 空间 + 最近笔记）。 */
export async function buildPanelStatus(
  deps: PanelDeps,
  query: PanelQuery = {},
): Promise<PanelStatus> {
  const limit = Math.min(Math.max(Number(query.limit ?? 5) || 5, 1), 50);
  const started = Date.now();
  let reachable = false;
  let authenticated = false;
  let probeError: string | null;
  try {
    const probe = await deps.client.probeDesktop();
    reachable = probe.reachable;
    authenticated = probe.authenticated;
    probeError = probe.error ?? null;
  } catch (err) {
    probeError = errorText(err);
  }
  const connection: PanelConnection = {
    apiKeyConfigured: deps.apiKeyConfigured(),
    baseUrl: deps.baseUrl(),
    reachable,
    authenticated,
    latencyMs: Date.now() - started,
    error: probeError,
  };

  const { spaces, warning: spaceWarning } = await listSpaces(deps);
  const spaceId = query.spaceId ?? spaces[0]?.id;
  let recentNotes: PanelNote[] = [];
  let warning = spaceWarning;
  if (spaceId !== undefined && spaceId.length > 0) {
    try {
      const keys = await deps.store.resolveKeys(spaceId);
      const statusKey = propertyKey(keys, 'status');
      const result = await deps.store.search({
        spaceId,
        query: '',
        fields: [
          statusKey,
          propertyKey(keys, 'source'),
          propertyKey(keys, 'updatedAt'),
        ],
        sorts: [
          { property: propertyKey(keys, 'updatedAt'), direction: 'desc' },
        ],
        limit,
      });
      recentNotes = result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: textOf(row.properties?.[statusKey]) || 'draft',
        source: textOf(row.properties?.[propertyKey(keys, 'source')]) || null,
        updatedAt:
          textOf(row.properties?.[propertyKey(keys, 'updatedAt')]) || null,
      }));
    } catch (err) {
      warning = `notes unavailable: ${errorText(err)}`;
    }
  }
  return {
    connection,
    spaces,
    recentNotes,
    checkedAt: new Date().toISOString(),
    warning,
  };
}

/** 采集 queue 载荷（待审 draft 队列）。 */
export async function buildPanelQueue(
  deps: PanelDeps,
  query: PanelQuery = {},
): Promise<PanelQueue> {
  const limit = Math.min(Math.max(Number(query.limit ?? 20) || 20, 1), 100);
  const { spaces, warning: spaceWarning } = await listSpaces(deps);
  const spaceId = query.spaceId ?? spaces[0]?.id;
  if (spaceId === undefined || spaceId.length === 0) {
    return {
      spaceId: null,
      pending: [],
      total: null,
      hasMore: false,
      checkedAt: new Date().toISOString(),
      warning: spaceWarning ?? 'no space available',
    };
  }
  try {
    const keys = await deps.store.resolveKeys(spaceId);
    const statusKey = propertyKey(keys, 'status');
    const result = await deps.store.search({
      spaceId,
      query: '',
      filter: inFilter(statusKey, ['draft']),
      fields: [
        statusKey,
        propertyKey(keys, 'source'),
        propertyKey(keys, 'updatedAt'),
      ],
      sorts: [{ property: propertyKey(keys, 'updatedAt'), direction: 'desc' }],
      limit,
    });
    return {
      spaceId,
      pending: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: textOf(row.properties?.[statusKey]) || 'draft',
        source: textOf(row.properties?.[propertyKey(keys, 'source')]) || null,
        updatedAt:
          textOf(row.properties?.[propertyKey(keys, 'updatedAt')]) || null,
      })),
      total: result.total ?? null,
      hasMore: result.hasMore === true,
      checkedAt: new Date().toISOString(),
      warning: null,
    };
  } catch (err) {
    return {
      spaceId,
      pending: [],
      total: null,
      hasMore: false,
      checkedAt: new Date().toISOString(),
      warning: `queue unavailable: ${errorText(err)}`,
    };
  }
}

/** JSON 信封写入（统一头 + 200 状态；失败也是 200 + ok:false）。 */
function writeJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** 错误文本（截断，避免把堆栈灌进面板）。 */
function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.slice(0, 200);
}

/** 面板 handler：prefix 内按路径分发两个只读 GET 端点。 */
export function createPanelHandler(
  deps: PanelDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    // 只读端点：非 GET 一律 405——面板不提供任何写操作。
    if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
      writeJson(res, 405, {
        ok: false,
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: 'panel endpoints are read-only (GET only)',
        },
      });
      return;
    }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const rest = path.startsWith(PANEL_ROUTE_PREFIX)
      ? path.slice(PANEL_ROUTE_PREFIX.length)
      : '';
    const spaceId = new URL(
      req.url ?? '/',
      'http://localhost',
    ).searchParams.get('space');
    const query: PanelQuery = {
      spaceId: spaceId !== null && spaceId.length > 0 ? spaceId : undefined,
    };
    if (rest === PANEL_STATUS_PATH) {
      const value = await buildPanelStatus(deps, query);
      writeJson(res, 200, { ok: true, value });
      return;
    }
    if (rest === PANEL_QUEUE_PATH) {
      const value = await buildPanelQueue(deps, query);
      writeJson(res, 200, { ok: true, value });
      return;
    }
    writeJson(res, 404, {
      ok: false,
      error: { code: 'NOT_FOUND', message: `unknown panel path: ${rest}` },
    });
  };
}

/**
 * 在宿主 webServer 上注册面板只读路由。
 *
 * @param webServer - 宿主 webServer 服务面。
 * @param deps - 面板数据依赖。
 * @returns 注销函数（随插件卸载执行）。
 */
export function registerPanelRoutes(
  webServer: WebServerLike,
  deps: PanelDeps,
): () => void {
  return webServer.register({
    kind: 'prefix',
    path: PANEL_ROUTE_PREFIX,
    handler: createPanelHandler(deps),
  });
}
