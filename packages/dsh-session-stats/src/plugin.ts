import type { Context } from '@deepseek-ai/cordis';
import { buildDashboard, normalizeRange } from './aggregate.ts';
import { resolveDshHome } from './discover.ts';
import { readUsageLedger } from './ledger.ts';
import { syncSessions } from './store.ts';

/**
 * dsh-session-stats 宿主插件:把会话统计 API 挂到 dsh 自身 Web 服务的共享
 * `/api` 通道上(经 client-connection 的鉴权与信任围栏),浏览器同源直访,
 * 不再需要独立端口。
 *
 * 路由:
 * - GET  /api/session-stats?range=7d|30d|90d|all → 仪表盘全量数据
 * - POST /api/session-stats/sync                → 增量同步并返回结果
 */

export const name = 'dsh-session-stats';

export const inject = ['connection'];

/** 本插件用到的 connection 服务最小面(完整类型由 dsh-client-connection 提供)。 */
interface HostConnectionMinimal {
  fetch: {
    register(route: {
      path: string;
      methods: readonly ('GET' | 'HEAD' | 'POST')[];
      requestBody: 'buffered' | 'streaming';
      fetch: (request: Request) => Promise<Response>;
    }): Promise<() => Promise<void>>;
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function dashboardPayload(dshHome: string, url: URL): unknown {
  const range = normalizeRange(url.searchParams.get('range'));
  const { store } = syncSessions({ dshHome });
  return buildDashboard(Object.values(store.sessions), {
    range,
    ledgerRows: readUsageLedger(dshHome),
  });
}

export function apply(ctx: Context): void {
  console.log(`[dsh-session-stats] plugin loaded`);
  const dshHome = resolveDshHome(process.env['DSH_HOME']);
  const connection = (ctx as Context & { connection?: HostConnectionMinimal })
    .connection;
  if (!connection) {
    console.error('[dsh-session-stats] connection 服务不可用,统计 API 未挂载');
    return;
  }
  console.log(
    `[dsh-session-stats] API mounted at /api/session-stats (home: ${dshHome})`,
  );
  ctx.effect(() => {
    const registered = connection.fetch.register({
      path: '/api/session-stats',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => {
        try {
          return Promise.resolve(
            json(dashboardPayload(dshHome, new URL(request.url))),
          );
        } catch (error) {
          return Promise.resolve(
            json(
              {
                error: error instanceof Error ? error.message : String(error),
              },
              500,
            ),
          );
        }
      },
    });
    return () => void registered.then((dispose) => dispose());
  }, 'session-stats: GET /api/session-stats');
  ctx.effect(() => {
    const registered = connection.fetch.register({
      path: '/api/session-stats/sync',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: () => {
        try {
          const { result } = syncSessions({ dshHome });
          return Promise.resolve(json(result));
        } catch (error) {
          return Promise.resolve(
            json(
              {
                error: error instanceof Error ? error.message : String(error),
              },
              500,
            ),
          );
        }
      },
    });
    return () => void registered.then((dispose) => dispose());
  }, 'session-stats: POST /api/session-stats/sync');
}
