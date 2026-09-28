import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboard, normalizeRange } from './aggregate.ts';
import { resolveDshHome } from './discover.ts';
import { readUsageLedger } from './ledger.ts';
import { defaultStorePath, loadStore, syncSessions } from './store.ts';
import type { StoreFile } from './types.ts';

export interface ServerOptions {
  port: number;
  host?: string;
  dshHome?: string;
}

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendFile(res: http.ServerResponse, filePath: string): void {
  try {
    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type':
        MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

/** 从 store 构建仪表盘数据；store 为空时先做一次同步。 */
export function dashboardFromStore(
  dshHome: string,
  range: string,
  syncIfEmpty: boolean,
): {
  store: StoreFile;
  synced: boolean;
  payload: unknown;
} {
  let synced = false;
  let store = loadStore(defaultStorePath(dshHome));
  if (syncIfEmpty && Object.keys(store.sessions).length === 0) {
    store = syncSessions({ dshHome }).store;
    synced = true;
  }
  const sessions = Object.values(store.sessions);
  const payload = buildDashboard(sessions, {
    range: normalizeRange(range),
    ledgerRows: readUsageLedger(dshHome),
  });
  return { store, synced, payload };
}

/** 启动统计面板 HTTP 服务，返回 server 实例（已监听）。 */
export function startServer(options: ServerOptions): http.Server {
  const dshHome = resolveDshHome(options.dshHome);
  const server = http.createServer((req, res) => {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );
    const pathname = url.pathname;
    try {
      if (pathname === '/api/health') {
        sendJson(res, 200, { ok: true, dshHome });
        return;
      }
      if (pathname === '/api/sync') {
        const { result } = syncSessions({ dshHome });
        sendJson(res, 200, result);
        return;
      }
      if (pathname === '/api/stats') {
        const range = url.searchParams.get('range');
        const { payload } = dashboardFromStore(dshHome, range ?? '30d', true);
        sendJson(res, 200, payload);
        return;
      }
      if (pathname === '/' || pathname === '/index.html') {
        sendFile(res, path.join(WEB_DIR, 'index.html'));
        return;
      }
      if (pathname === '/styles.css') {
        sendFile(res, path.join(WEB_DIR, 'styles.css'));
        return;
      }
      if (pathname === '/app.js') {
        sendFile(res, path.join(WEB_DIR, 'app.js'));
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  server.listen(options.port, options.host ?? '127.0.0.1');
  return server;
}
