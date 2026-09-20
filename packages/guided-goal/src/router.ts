import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import { buildDirectCreateMessage, type GoalFields } from './protocol.ts';

/** 路由前缀(loopback-only,与 dsh web UI 同源)。 */
export const ROUTE_SESSIONS = '/api/guided-goal/sessions';
export const ROUTE_CREATE = '/api/guided-goal/create';
/** 变更请求必须携带的自定义头(第三方页面无法伪造,防 CSRF)。 */
export const MUTATION_HEADER = 'x-dsh-guided-goal';
const MAX_BODY_BYTES = 16 * 1024;

/** 最小会话代理接口:真实 Agent 与测试替身均结构兼容。 */
export interface AgentLike {
  readonly id: string;
  readonly session: unknown;
  steer(message: unknown): void;
}

/** 会话列表条目:仅承载展示信息。 */
export interface SessionInfo {
  readonly id: string;
  readonly session: unknown;
}

/** 最小 agent 注册表接口:真实 AgentRegistry 与测试替身均结构兼容。 */
export interface AgentRegistryLike {
  get(id: string): AgentLike | undefined;
  list(): readonly SessionInfo[];
}

/** 最小路由注册面:真实 WebServer 与测试替身均结构兼容。 */
export interface RouteRegistryLike {
  register(route: WebRoute): () => void;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function isLoopback(host: string | undefined): boolean {
  if (host === undefined || host === '') return false;
  const lower = host.toLowerCase();
  const hostname =
    lower.startsWith('[') && lower.endsWith(']')
      ? lower.slice(1, -1)
      : (lower.split(':')[0] ?? '');
  return (
    hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
  );
}

function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true; // 同源 GET 可能不带 Origin
  try {
    return isLoopback(new URL(origin).hostname);
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function guard(req: IncomingMessage): string | undefined {
  const address = req.socket.remoteAddress ?? '';
  const loopback =
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1';
  if (!loopback) return 'forbidden';
  if (!isLoopback(req.headers.host)) return 'bad-origin';
  if (!originAllowed(req.headers.origin)) return 'bad-origin';
  return undefined;
}

function extractTitle(agent: SessionInfo): string | undefined {
  const session: unknown = agent.session;
  if (typeof session !== 'object' || session === null || !('title' in session))
    return undefined;
  const title: unknown = session['title'];
  return typeof title === 'string' && title.length > 0 ? title : undefined;
}

/** 表单输入的原始形状:字段全可选;此断言仅建立字段存在性,值校验在下方逐一进行。 */
interface RawFields {
  objective?: unknown;
  successCriteria?: unknown;
  verification?: unknown;
  boundaries?: unknown;
  stopConditions?: unknown;
  maxGoalRounds?: unknown;
}

/** 解析并校验表单字段;返回结构化字段或错误文案。 */
export function validateFields(
  input: unknown,
): { fields: GoalFields } | { error: string } {
  if (typeof input !== 'object' || input === null)
    return { error: 'fields is required' };
  const raw = input as RawFields;
  const str = (value: unknown): string | undefined => {
    return typeof value === 'string' ? value : undefined;
  };
  const objective = str(raw.objective)?.trim() ?? '';
  const successCriteria = str(raw.successCriteria)?.trim() ?? '';
  if (objective.length === 0) return { error: 'objective 必填' };
  if (successCriteria.length === 0) return { error: 'successCriteria 必填' };
  const maxGoalRounds = str(raw.maxGoalRounds)?.trim();
  if (
    maxGoalRounds !== undefined &&
    maxGoalRounds !== '' &&
    !/^\d+$/.test(maxGoalRounds)
  ) {
    return { error: 'maxGoalRounds 必须是正整数' };
  }
  return {
    fields: {
      objective,
      successCriteria,
      verification: str(raw.verification)?.trim() || undefined,
      boundaries: str(raw.boundaries)?.trim() || undefined,
      stopConditions: str(raw.stopConditions)?.trim() || undefined,
      maxGoalRounds: maxGoalRounds || undefined,
    },
  };
}

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
  agents: AgentRegistryLike,
): Promise<void> {
  const denied = guard(req);
  if (denied !== undefined) {
    sendJson(res, 403, { ok: false, error: denied });
    return;
  }
  if (req.headers[MUTATION_HEADER] !== '1') {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const sessionId = url.searchParams.get('sessionId');
  if (sessionId === null || sessionId === '') {
    sendJson(res, 400, { ok: false, error: 'sessionId is required' });
    return;
  }
  let body: unknown;
  try {
    body = await readBody(req);
  } catch (error) {
    sendJson(res, 400, {
      ok: false,
      error: error instanceof Error ? error.message : 'bad body',
    });
    return;
  }
  if (typeof body !== 'object' || body === null || !('fields' in body)) {
    sendJson(res, 400, { ok: false, error: 'fields is required' });
    return;
  }
  const validated = validateFields(body['fields']);
  if ('error' in validated) {
    sendJson(res, 400, { ok: false, error: validated.error });
    return;
  }
  const agent = agents.get(sessionId);
  if (agent === undefined) {
    sendJson(res, 404, { ok: false, error: 'session not live' });
    return;
  }
  agent.steer(buildDirectCreateMessage(validated.fields));
  sendJson(res, 200, {
    ok: true,
    message: '已向会话注入创建指令,模型将直接创建 goal',
  });
}

function handleSessions(
  req: IncomingMessage,
  res: ServerResponse,
  agents: AgentRegistryLike,
): void {
  const denied = guard(req);
  if (denied !== undefined) {
    sendJson(res, 403, { ok: false, error: denied });
    return;
  }
  const sessions = agents.list().map((agent) => ({
    id: agent.id,
    title: extractTitle(agent) ?? agent.id,
  }));
  sendJson(res, 200, { ok: true, sessions });
}

/**
 * 挂载 guided-goal 的 loopback 路由;返回反注册 disposer。
 * GET  /api/guided-goal/sessions — 列出活跃会话
 * POST /api/guided-goal/create   — 向指定会话注入"直接创建 goal"指令
 */
export function mountRoutes(
  webServer: RouteRegistryLike,
  agents: AgentRegistryLike,
): () => void {
  const route = (
    path: string,
    handler: (
      req: IncomingMessage,
      res: ServerResponse,
    ) => void | Promise<void>,
  ): WebRoute => ({ kind: 'exact', path, handler });
  const disposeSessions = webServer.register(
    route(ROUTE_SESSIONS, (req, res) => handleSessions(req, res, agents)),
  );
  const disposeCreate = webServer.register(
    route(ROUTE_CREATE, (req, res) => handleCreate(req, res, agents)),
  );
  return () => {
    disposeSessions();
    disposeCreate();
  };
}
