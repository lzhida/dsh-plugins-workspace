/**
 * /dsh-open-in-zed routes on the shared DSH webserver: open a REGISTERED
 * workspace directory in the Zed editor, report launcher status, and list
 * the registry the open action accepts.
 *
 * Security posture: the open action only resolves targets through the
 * workspace registry — an arbitrary filesystem path is never spawned, so a
 * crafted request cannot point zed at e.g. C:\Windows. Envelope and error
 * mapping follow the dsh-taskboard route conventions.
 *
 * @module dsh-open-in-zed/host/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
// Type-only: pulls the webServer Context merge (ctx.webServer).
import type {} from '@deepseek-ai/dsh-host-webserver';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import {
  defaultSpawnRunner,
  openInZed,
  probeZed,
  ZED_ERROR_CODES,
  ZedError,
  type SpawnRunner,
  type ZedLaunch,
} from './zed.ts';

/** Route prefix on the shared DSH webserver (same origin as the GUI). */
export const ROUTE_PREFIX = '/dsh-open-in-zed';

/** Max accepted JSON body bytes: the payload is three short strings. */
const MAX_BODY_BYTES = 64 * 1024;

/** One registry workspace row (own fields only — registry getters are prototype-bound). */
export type WorkspaceRow = {
  id: string;
  path: string;
  title: string;
};

/** The narrow registry face routes and tools need (tests script this). */
export interface WorkspaceRegistryFace {
  get(id: string): WorkspaceRow | undefined;
  list(): WorkspaceRow[];
  resolveByPath(path: string): Promise<WorkspaceRow | undefined>;
}

/**
 * Adapt the real registry to the narrow face: Workspace entities expose
 * path/title as prototype getters, which JSON.stringify skips (own
 * enumerable properties only), so rows are mapped explicitly.
 * @param registry - the host workspaceRegistry service.
 * @returns the plain-object face.
 */
export function registryFace(
  registry: WorkspaceRegistry,
): WorkspaceRegistryFace {
  return {
    get: (id) => {
      const ws = registry.get(id as never);
      return ws === undefined
        ? undefined
        : { id: ws.id, path: ws.path, title: ws.title };
    },
    list: () =>
      registry
        .list()
        .map((ws) => ({ id: ws.id, path: ws.path, title: ws.title })),
    resolveByPath: async (path) => {
      const ws = await registry.resolveByPath(path as never);
      return ws === undefined
        ? undefined
        : { id: ws.id, path: ws.path, title: ws.title };
    },
  };
}

/** Stable HTTP error codes (superset of the transport mapping below). */
export type ApiErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'forbidden'
  | 'zed-not-found'
  | 'zed-timeout'
  | 'zed-spawn-failed'
  | 'internal';

/** Success envelope (dsh-taskboard convention). */
export type ApiOk<T> = { ok: true; value: T };

/** Failure envelope. */
export type ApiFail = {
  ok: false;
  error: { code: ApiErrorCode; message: string };
};

/** The envelope either way. */
export type ApiResult<T> = ApiOk<T> | ApiFail;

/** Route-level failure carrying its HTTP status. */
export class RouteError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;

  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.name = 'RouteError';
    this.status = status;
    this.code = code;
  }
}

/** Open request body. */
export interface OpenRequestBody {
  /** Registry workspace id (preferred target form). */
  workspaceId?: string;
  /** Absolute path that must own a registered workspace. */
  path?: string;
  /** Ask zed for a fresh window. */
  newWindow?: boolean;
}

/** The resolved open target. */
export interface OpenTarget {
  workspace: WorkspaceRow;
}

/**
 * Resolve the open request to a registered workspace.
 *
 * Precedence: a non-empty `workspaceId` wins; otherwise `path` must resolve
 * through the registry. A path with NO registered workspace is `forbidden`
 * (not `not_found`): the address is valid but policy refuses to open it.
 * @param body - Parsed request body.
 * @param registry - The narrow registry face.
 * @returns the target workspace.
 * @throws RouteError invalid_input / not_found / forbidden.
 */
export async function resolveOpenTarget(
  body: OpenRequestBody,
  registry: WorkspaceRegistryFace,
): Promise<OpenTarget> {
  const workspaceId =
    typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
  if (workspaceId.length > 0) {
    const ws = registry.get(workspaceId);
    if (ws === undefined) {
      throw new RouteError(
        404,
        'not_found',
        `未知的工作区 id: ${workspaceId.slice(0, 80)}`,
      );
    }
    return { workspace: ws };
  }

  const path = typeof body.path === 'string' ? body.path : '';
  if (path.length === 0) {
    throw new RouteError(
      400,
      'invalid_input',
      '需要 workspaceId 或 path 之一。',
    );
  }
  const ws = await registry.resolveByPath(path);
  if (ws === undefined) {
    throw new RouteError(
      403,
      'forbidden',
      '路径不是已注册的工作区目录，已拒绝打开（仅允许已注册工作区）。',
    );
  }
  return { workspace: ws };
}

/** Write one JSON response and close it. */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Read a request body as JSON, enforcing the byte cap. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) {
      throw new RouteError(413, 'invalid_input', '请求体过大。');
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new RouteError(400, 'invalid_input', '请求体不是合法 JSON。');
  }
}

/** Map a ZedError (or anything else) to the HTTP failure response payload. */
function failureOf(error: unknown): { status: number; fail: ApiFail } {
  if (error instanceof RouteError) {
    return {
      status: error.status,
      fail: { ok: false, error: { code: error.code, message: error.message } },
    };
  }
  if (error instanceof ZedError) {
    const status =
      error.code === ZED_ERROR_CODES.timeout
        ? 504
        : error.code === ZED_ERROR_CODES.invalidTarget
          ? 400
          : 500;
    return {
      status,
      fail: {
        ok: false,
        error: {
          code: error.code as ApiErrorCode,
          message: error.message,
        },
      },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: 500,
    fail: { ok: false, error: { code: 'internal', message } },
  };
}

/** Options for {@link registerOpenInZedRoutes}. */
export interface OpenInZedRoutesOptions {
  registry: WorkspaceRegistryFace;
  /** Injected exec layer; defaults to the real zed runner. */
  runner?: SpawnRunner;
  /** Explicit bin override (testing); production reads the env itself. */
  bin?: string;
}

/**
 * Register the /dsh-open-in-zed routes on the shared webserver.
 * @param ctx - context exposing `webServer`.
 * @param options - registry face plus injected runner.
 * @returns the combined disposer removing all routes.
 */
export function registerOpenInZedRoutes(
  ctx: Context,
  options: OpenInZedRoutesOptions,
): () => void {
  const { registry } = options;

  const statusHandler = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET') {
      sendJson(res, 405, {
        ok: false,
        error: { code: 'invalid_input', message: '仅支持 GET。' },
      } satisfies ApiFail);
      return;
    }
    void probeZed(
      options.runner ?? defaultSpawnRunner(),
      options.bin !== undefined ? { bin: options.bin } : undefined,
    ).then(
      (value) =>
        sendJson(res, 200, { ok: true, value } satisfies ApiOk<unknown>),
      (error: unknown) => {
        const { status, fail } = failureOf(error);
        sendJson(res, status, fail);
      },
    );
  };

  const workspacesHandler = (
    req: IncomingMessage,
    res: ServerResponse,
  ): void => {
    if (req.method !== 'GET') {
      sendJson(res, 405, {
        ok: false,
        error: { code: 'invalid_input', message: '仅支持 GET。' },
      } satisfies ApiFail);
      return;
    }
    sendJson(res, 200, {
      ok: true,
      value: registry.list(),
    } satisfies ApiOk<WorkspaceRow[]>);
  };

  const openHandler = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'POST') {
      sendJson(res, 405, {
        ok: false,
        error: { code: 'invalid_input', message: '仅支持 POST。' },
      } satisfies ApiFail);
      return;
    }
    void (async (): Promise<void> => {
      const body = (await readJson(req)) as OpenRequestBody;
      const { workspace } = await resolveOpenTarget(body, registry);
      const launch: ZedLaunch = await openInZed(
        workspace.path,
        body.newWindow === true ? { newWindow: true } : undefined,
        options.runner,
      );
      sendJson(res, 200, {
        ok: true,
        value: {
          workspace: { id: workspace.id, title: workspace.title },
          path: launch.path,
          command: launch.command,
        },
      } satisfies ApiOk<unknown>);
    })().catch((error: unknown) => {
      const { status, fail } = failureOf(error);
      sendJson(res, status, fail);
    });
  };

  const disposers = [
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/status`,
      handler: statusHandler,
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/workspaces`,
      handler: workspacesHandler,
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/open`,
      handler: openHandler,
    }),
  ];
  return () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
}
