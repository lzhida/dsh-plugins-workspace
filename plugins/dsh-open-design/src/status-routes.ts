/**
 * 宿主半区同源 HTTP 路由：`/dsh-open-design/*`。
 *
 * 客户端面板（client/src，系列 3+）经同源 fetch 取数；本模块把 runtime
 * 已有能力（status/redetect/上游工具调用）暴露为只读 JSON 路由。范式照
 * dsh-fanqie-novel：单个 prefix 路由内按 pathname+method 分发，统一
 * catch 降级为结构化 JSON（绝不 500 崩盘），webServer 经 cordis.patch.yml
 * 行级 inject 声明（apply 执行时 HTTP 服务必已就绪）。
 *
 * 路由表：
 * - `GET  /dsh-open-design/status`    → DiagnosticReport（env 值脱敏后）
 * - `GET  /dsh-open-design/projects`  → 上游 list_projects 透传
 * - `GET  /dsh-open-design/focus`     → 上游 get_active_context 透传
 *   （系列 3/6 面板「当前焦点」节的数据源）
 * - `GET  /dsh-open-design/skills`    → 上游 list_skills（?q= 过滤 +
 *   ?limit= 截断 + ?offset= 分页 + description 裁剪；上游单次 200KB+/300+
 *   条，服务端先过滤再返回，避免整包灌进浏览器；返回带 nextOffset 供
 *   「加载更多」）
 * - `GET  /dsh-open-design/plugins`   → 上游 list_plugins（目录浏览
 *   「工作流插件」子视图；条目形状兼容数组或 {plugins|items}）
 * - `GET  /dsh-open-design/runs?runId=<id>` → 上游 get_run 单查
 * - `POST /dsh-open-design/runs`      → 上游 start_run（body {prompt,
 *   project?, skill?, agent?, plugin?}；requestId 由本层生成 UUID——上游
 *   要求同一逻辑 run 重试必须复用同一 requestId，面板「重新发起」是新 run
 *   故新 id。plugin 是上游 start_run schema 的可选工作流插件 id，实测
 *   tools/list 确认存在）
 * - `POST /dsh-open-design/runs/cancel` → 上游 cancel_run（body {runId}；
 *   上游语义是「请求取消」，终态以 get_run 为准）
 * - `GET  /dsh-open-design/agents`    → 上游 list_agents（运行表单的
 *   agent 下拉数据源；失败由统一 catch 降级 502）
 * - `POST /dsh-open-design/redetect`  → 重探测 + 重连，返回新 status 快照
 *   （只认 POST，其余方法 405）
 *
 * 脱敏红线：env 是通用容器，凭据类键名（/key|password|secret|token/i）
 * 的值一律 '<redacted>'；其余键（OD_* 路径、pipe 端点等排障必需项）保留。
 *
 * @module dsh-open-design/status-routes
 */

import { randomUUID } from 'node:crypto';

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { DiagnosticReport } from './diag-tools.ts';

/** 路由前缀（client/src/constants.ts 与本文件共用同一常量值，由测试互锚）。 */
export const ROUTE_PREFIX = '/dsh-open-design';

/** POST 请求体大小上限（面板表单场景远用不到，防呆即可）。 */
export const MAX_BODY_BYTES = 64 * 1024;

/** skills 默认返回条数上限（?limit= 可调，硬上限 MAX_SKILL_LIMIT）。 */
export const DEFAULT_SKILL_LIMIT = 50;
export const MAX_SKILL_LIMIT = 200;
/** description 超长截断长度（裁剪 200KB+ 返回体的主要手段）。 */
export const SKILL_DESCRIPTION_MAX = 240;

/** 凭据类 env 键名模式（与宿主 mcp-client 的 ambient 清洗同口径）。 */
const SENSITIVE_ENV_KEY = /key|password|secret|token/i;

/** 宿主 webServer.register 接受的路由形状（dsh-host-webserver WebRoute）。 */
export interface WebRouteLike {
  kind: 'prefix';
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

/** 路由层依赖的最小 runtime 面（由 OpenDesignRuntime 提供）。 */
export interface StatusRouteDeps {
  /** 当前状态快照（status 工具与 GET /status 同一来源）。 */
  status(): DiagnosticReport;
  /** 重探测 + 重连（POST /redetect）。 */
  redetect(): Promise<DiagnosticReport>;
  /** 经现有 MCP 连接调用上游工具（不另起子进程）。 */
  call(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

export function registerStatusRoutes(
  register: (route: WebRouteLike) => (() => void) | void,
  deps: StatusRouteDeps,
): () => void {
  const handler = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = (req.method ?? 'GET').toUpperCase();

      if (pathname_is(url.pathname, 'status') && method === 'GET') {
        json(res, 200, sanitizeReport(deps.status()));
        return;
      }
      if (pathname_is(url.pathname, 'redetect')) {
        if (method !== 'POST') {
          json(res, 405, { error: 'redetect 只接受 POST' });
          return;
        }
        json(res, 200, sanitizeReport(await deps.redetect()));
        return;
      }
      if (pathname_is(url.pathname, 'projects') && method === 'GET') {
        json(
          res,
          200,
          unwrapToolResult(
            await upstreamOrThrow(
              deps,
              'list_projects',
              {},
              UPSTREAM_TIMEOUTS.projects,
            ),
          ),
        );
        return;
      }
      if (pathname_is(url.pathname, 'focus') && method === 'GET') {
        json(
          res,
          200,
          unwrapToolResult(
            await upstreamOrThrow(
              deps,
              'get_active_context',
              {},
              UPSTREAM_TIMEOUTS.focus,
            ),
          ),
        );
        return;
      }
      if (pathname_is(url.pathname, 'skills') && method === 'GET') {
        const q = url.searchParams.get('q') ?? '';
        const limit = parseLimit(url.searchParams.get('limit'));
        const offset = parseOffset(url.searchParams.get('offset'));
        const payload = unwrapToolResult(
          await upstreamOrThrow(
            deps,
            'list_skills',
            {},
            UPSTREAM_TIMEOUTS.skills,
          ),
        );
        json(res, 200, trimSkills(payload, q, limit, offset));
        return;
      }
      if (pathname_is(url.pathname, 'plugins') && method === 'GET') {
        const limit = parseLimit(url.searchParams.get('limit'));
        const payload = unwrapToolResult(
          await upstreamOrThrow(
            deps,
            'list_plugins',
            {},
            UPSTREAM_TIMEOUTS.plugins,
          ),
        );
        json(res, 200, trimPlugins(payload, limit));
        return;
      }
      if (pathname_is(url.pathname, 'runs') && method === 'GET') {
        const runId = url.searchParams.get('runId') ?? '';
        if (runId === '') {
          json(res, 400, { error: 'runs 需要 ?runId=<id>' });
          return;
        }
        json(
          res,
          200,
          unwrapToolResult(
            await upstreamOrThrow(
              deps,
              'get_run',
              { runId },
              UPSTREAM_TIMEOUTS.run,
            ),
          ),
        );
        return;
      }
      if (pathname_is(url.pathname, 'runs') && method === 'POST') {
        json(res, 200, await startRun(deps, req));
        return;
      }
      if (pathname_is(url.pathname, 'runs/cancel') && method === 'POST') {
        json(res, 200, await cancelRun(deps, req));
        return;
      }
      if (pathname_is(url.pathname, 'agents') && method === 'GET') {
        json(
          res,
          200,
          unwrapToolResult(
            await upstreamOrThrow(
              deps,
              'list_agents',
              {},
              UPSTREAM_TIMEOUTS.agents,
            ),
          ),
        );
        return;
      }
      json(res, 404, { error: `未知路由：${url.pathname}` });
    } catch (err) {
      // 业务校验错误按其状态码返回；上游不可用 / 连接失败：结构化降级
      // （带连接状态），绝不 500 崩盘。
      const message = err instanceof Error ? err.message : String(err);
      const statusCode = err instanceof HttpError ? err.statusCode : 502;
      let connectionState = 'unknown';
      try {
        connectionState = deps.status().connectionState;
      } catch {
        // status 自身失败不掩盖原始错误。
      }
      json(res, statusCode, { error: message, connectionState });
    }
  };
  const dispose = register({ kind: 'prefix', path: ROUTE_PREFIX, handler });
  return typeof dispose === 'function' ? dispose : () => {};
}

function pathname_is(actual: string, tail: string): boolean {
  return actual === `${ROUTE_PREFIX}/${tail}`;
}

/** 读取并解析 POST JSON 请求体（超出 MAX_BODY_BYTES 直接判 400）。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as unknown as AsyncIterable<Buffer>) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += bytes.length;
    if (total > MAX_BODY_BYTES) {
      throw new HttpError(400, '请求体过大');
    }
    chunks.push(bytes);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') {
    throw new HttpError(400, '请求体必须是非空 JSON');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

/** 带 HTTP 状态码的业务错误（统一 catch 按此状态码降级，其余按 502）。 */
class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

interface StartRunInput {
  prompt?: unknown;
  project?: unknown;
  skill?: unknown;
  agent?: unknown;
  plugin?: unknown;
}

/** 发起生成：校验表单字段并生成 requestId 后调上游 start_run。 */
async function startRun(
  deps: StatusRouteDeps,
  req: IncomingMessage,
): Promise<unknown> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
  const input = (body ?? {}) as StartRunInput;
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (prompt === '') {
    throw new HttpError(400, 'prompt 不能为空');
  }
  // requestId 本层生成（上游要求：同一逻辑 run 重试复用同一 id；面板
  // 「重新发起」语义上是新 run，故每次 POST 生成新 id）。
  const args: Record<string, unknown> = {
    requestId: randomUUID(),
    prompt,
  };
  if (typeof input.project === 'string' && input.project.trim() !== '') {
    args.project = input.project.trim();
  }
  if (typeof input.skill === 'string' && input.skill.trim() !== '') {
    args.skill = input.skill.trim();
  }
  if (typeof input.agent === 'string' && input.agent.trim() !== '') {
    args.agent = input.agent.trim();
  }
  if (typeof input.plugin === 'string' && input.plugin.trim() !== '') {
    args.plugin = input.plugin.trim();
  }
  return unwrapToolResult(
    await upstreamOrThrow(deps, 'start_run', args, UPSTREAM_TIMEOUTS.startRun),
  );
}

/** 请求取消：转发 cancel_run（上游语义=「已请求取消」，终态以 get_run 为准）。 */
async function cancelRun(
  deps: StatusRouteDeps,
  req: IncomingMessage,
): Promise<unknown> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
  const runId =
    body !== null && typeof body === 'object'
      ? (body as Record<string, unknown>).runId
      : undefined;
  if (typeof runId !== 'string' || runId.trim() === '') {
    throw new HttpError(400, 'runId 不能为空');
  }
  return unwrapToolResult(
    await upstreamOrThrow(
      deps,
      'cancel_run',
      { runId: runId.trim() },
      UPSTREAM_TIMEOUTS.cancelRun,
    ),
  );
}

/**
 * 上游调用超时（毫秒）。
 *
 * 本层先于宿主连接层（toolCallTimeoutMs，默认 60s）收敛，让面板拿到可区分
 * 的 504「上游超时」而不是笼统 502——上游 agent 类调用（本机 Open Design
 * 的 list_agents/start_run）在 agent 运行时未就绪时可能长时间挂起。
 */
export const UPSTREAM_TIMEOUTS = {
  projects: 15_000,
  focus: 15_000,
  skills: 20_000,
  plugins: 20_000,
  agents: 20_000,
  run: 15_000,
  startRun: 45_000,
  cancelRun: 20_000,
} as const;

async function upstreamOrThrow(
  deps: StatusRouteDeps,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      deps.call(name, args),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new HttpError(504, `上游 ${name} 超时（${timeoutMs}ms）`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 解包上游 MCP 工具结果为业务数据。
 *
 * 上游 callTool 返回的是 MCP CallToolResult（{content:[{type:'text',
 * text:'<json>'}], structuredContent?}），前端要的是业务对象——优先取
 * structuredContent，其次解析首个 text 块的 JSON，都不可用时原样返回。
 */
export function unwrapToolResult(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') return payload;
  const record = payload as Record<string, unknown>;
  if (
    record.structuredContent !== undefined &&
    record.structuredContent !== null
  ) {
    return record.structuredContent;
  }
  const content = record.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue;
      const text = (block as Record<string, unknown>).text;
      if (
        (block as Record<string, unknown>).type !== 'text' ||
        typeof text !== 'string'
      ) {
        continue;
      }
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
  return payload;
}

/** env 值脱敏：凭据类键名只回 '<redacted>'，其余键保留（排障必需）。 */
export function sanitizeEnv(
  env: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = SENSITIVE_ENV_KEY.test(key) ? '<redacted>' : value;
  }
  return out;
}

/** 状态快照脱敏（当前只有 env 需要过滤；新增敏感字段时在此收口）。 */
export function sanitizeReport(report: DiagnosticReport): DiagnosticReport {
  return { ...report, env: sanitizeEnv(report.env) };
}

export interface SkillTrimResult {
  total: number;
  matched: number;
  returned: number;
  truncated: boolean;
  /** 还有更多匹配页时的下一页起始 offset（无更多页为 null）。 */
  nextOffset: number | null;
  items: Array<{
    id: string;
    name: string;
    description: string;
    triggers: string[];
  }>;
}

/** 服务端 skills 裁剪：兼容数组或 {skills|items:[...]} 两种上游形状。 */
export function trimSkills(
  payload: unknown,
  q: string,
  limit: number,
  offset = 0,
): SkillTrimResult {
  const raw = extractSkillArray(payload);
  const query = q.trim().toLowerCase();
  const matched =
    query === '' ? raw : raw.filter((item) => skillMatches(item, query));
  const sliced = matched.slice(offset, offset + limit);
  const hasMore = offset + sliced.length < matched.length;
  return {
    total: raw.length,
    matched: matched.length,
    returned: sliced.length,
    truncated: hasMore,
    nextOffset: hasMore ? offset + sliced.length : null,
    items: sliced.map(trimSkillItem),
  };
}

export interface PluginTrimResult {
  total: number;
  returned: number;
  truncated: boolean;
  items: Array<Record<string, unknown>>;
}

/** 服务端 plugins 裁剪：形状兼容（条目字段不裁剪，仅限量）。 */
export function trimPlugins(payload: unknown, limit: number): PluginTrimResult {
  const clean = extractPluginArray(payload).filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === 'object',
  );
  const sliced = clean.slice(0, limit);
  return {
    total: clean.length,
    returned: sliced.length,
    truncated: clean.length > sliced.length,
    items: sliced,
  };
}

/** 从上游载荷里取插件数组（兼容数组 / {plugins} / {items} 三种形状）。 */
function extractPluginArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.plugins)) return record.plugins;
    if (Array.isArray(record.items)) return record.items;
  }
  return [];
}

function extractSkillArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.skills)) return record.skills;
    if (Array.isArray(record.items)) return record.items;
  }
  return [];
}

function skillMatches(item: unknown, query: string): boolean {
  const record = item as Record<string, unknown> | null;
  if (record === null || typeof record !== 'object') return false;
  const haystack: string[] = [];
  if (typeof record.name === 'string') haystack.push(record.name);
  if (typeof record.description === 'string') haystack.push(record.description);
  if (Array.isArray(record.triggers)) {
    for (const trigger of record.triggers) {
      if (typeof trigger === 'string') haystack.push(trigger);
    }
  }
  return haystack.some((text) => text.toLowerCase().includes(query));
}

function trimSkillItem(item: unknown): {
  id: string;
  name: string;
  description: string;
  triggers: string[];
} {
  const record = (item ?? {}) as Record<string, unknown>;
  const description =
    typeof record.description === 'string' ? record.description : '';
  return {
    id: typeof record.id === 'string' ? record.id : '',
    name: typeof record.name === 'string' ? record.name : '',
    description:
      description.length > SKILL_DESCRIPTION_MAX
        ? `${description.slice(0, SKILL_DESCRIPTION_MAX)}…`
        : description,
    triggers: Array.isArray(record.triggers)
      ? record.triggers.filter((t): t is string => typeof t === 'string')
      : [],
  };
}

function parseLimit(raw: string | null): number {
  if (raw === null || raw === '') return DEFAULT_SKILL_LIMIT;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_SKILL_LIMIT;
  return Math.min(value, MAX_SKILL_LIMIT);
}

function parseOffset(raw: string | null): number {
  if (raw === null || raw === '') return 0;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}
