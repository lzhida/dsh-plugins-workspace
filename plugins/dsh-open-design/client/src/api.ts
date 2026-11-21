/**
 * 面板数据通道：宿主 webServer 只读路由（系列 2/6）的同源 fetch 封装。
 *
 * 端点常量与 src/status-routes.ts 的路由表一一对应；前缀 ROUTE_PREFIX 与
 * src/status-routes.ts、client/src/constants.ts 三方一致（status-routes
 * 测试互锚断言）。取数失败的降级由调用方（面板容器）按节处理。
 *
 * @module dsh-open-design/client/api
 */

import { ROUTE_PREFIX } from './constants.ts';

/** 状态快照端点。 */
export const STATUS_ENDPOINT = `${ROUTE_PREFIX}/status`;

/** 项目列表端点。 */
export const PROJECTS_ENDPOINT = `${ROUTE_PREFIX}/projects`;

/** 当前焦点端点。 */
export const FOCUS_ENDPOINT = `${ROUTE_PREFIX}/focus`;

/** 重新检测端点（POST）。 */
export const REDETECT_ENDPOINT = `${ROUTE_PREFIX}/redetect`;

/** 运行查询端点（GET ?runId=）。 */
export const RUNS_ENDPOINT = `${ROUTE_PREFIX}/runs`;

/** 运行取消端点（POST {runId}）。 */
export const RUN_CANCEL_ENDPOINT = `${ROUTE_PREFIX}/runs/cancel`;

/** 可用 agent 列表端点。 */
export const AGENTS_ENDPOINT = `${ROUTE_PREFIX}/agents`;

/** 技能检索端点（GET ?q=&limit=&offset=）。 */
export const SKILLS_ENDPOINT = `${ROUTE_PREFIX}/skills`;

/** 工作流插件列表端点。 */
export const PLUGINS_ENDPOINT = `${ROUTE_PREFIX}/plugins`;

/** sidecar 部署戳（与 src/config.ts 的 SidecarStamp 同构）。 */
export interface SidecarStamp {
  channel: string;
  namespace: string;
  source: string;
  mode: string;
  app: string;
}

/** 诊断快照（与 src/diag-tools.ts 的 DiagnosticReport 一一对应）。 */
export interface DiagnosticReport {
  autoDetect: boolean;
  serverName: string;
  source: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  startupTimeoutMs: number;
  toolCallTimeoutMs: number;
  detectionMethod: 'pipe' | 'powershell' | 'none';
  installed: boolean;
  stamp: SidecarStamp | null;
  endpoint: string;
  installDir: string;
  dataDir: string;
  daemonCliPath: string;
  connectionState: string;
  failedAttempts: number;
  maxAttempts: number;
  lastError: string | null;
  upstreamToolCount: number;
  upstreamSkippedTools: string[];
  diagnosticToolCount: number;
  configFile: string;
}

/** 当前焦点载荷（上游 get_active_context 的业务对象）。 */
export interface FocusPayload {
  active: boolean;
  hint?: string;
  [key: string]: unknown;
}

/** 项目摘要（上游 list_projects 的条目子集）。 */
export interface ProjectSummary {
  id: string;
  name: string;
  status?: { value?: string } | null;
  updatedAt?: string | null;
}

/** 项目列表载荷（/projects 解包后的业务对象）。 */
export interface ProjectsPayload {
  projects?: ProjectSummary[];
  [key: string]: unknown;
}

/** 上游运行状态机（get_run 的 status 字段取值）。 */
export type RunStatus =
  'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

/** 运行载荷（start_run / get_run 的业务对象子集，字段以 /runs 为准）。 */
export interface RunPayload {
  runId?: string;
  status?: RunStatus | string;
  error?: unknown;
  previewUrl?: string;
  agentMessage?: string;
  [key: string]: unknown;
}

/** 可用 agent 摘要（上游 list_agents 条目子集）。 */
export interface AgentSummary {
  id: string;
  name?: string;
  version?: string;
  models?: string[];
  modelsCount?: number;
  [key: string]: unknown;
}

/** agent 列表载荷。 */
export interface AgentsPayload {
  agents?: AgentSummary[];
  [key: string]: unknown;
}

/** 技能摘要（/skills 裁剪后的条目）。 */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  triggers: string[];
}

/** 技能检索载荷（服务端已过滤+截断，nextOffset 供「加载更多」）。 */
export interface SkillsPayload {
  total: number;
  matched: number;
  returned: number;
  truncated: boolean;
  nextOffset: number | null;
  items: SkillSummary[];
}

/** 工作流插件条目（上游 list_plugins 字段随版本浮动，开放对象）。 */
export interface PluginSummary {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

/** 工作流插件列表载荷（/plugins 裁剪后）。 */
export interface PluginsPayload {
  total: number;
  returned: number;
  truncated: boolean;
  items: PluginSummary[];
}

/** 发起生成的表单入参（requestId 由宿主侧生成，前端不传）。 */
export interface StartRunInput {
  prompt: string;
  project?: string;
  skill?: string;
  agent?: string;
  plugin?: string;
}

/**
 * 各端点取数超时（毫秒）：写操作与上游较慢的调用单独放宽。
 *
 * 取值 = 宿主路由的上游超时（src/status-routes.ts 的 UPSTREAM_TIMEOUTS）
 * + 5s 余量，保证先收到后端可区分的 504「上游超时」，而不是浏览器侧的
 * signal timed out。
 */
export const TIMEOUTS = {
  status: 10_000,
  projects: 20_000,
  focus: 20_000,
  skills: 25_000,
  plugins: 25_000,
  agents: 25_000,
  run: 20_000,
  startRun: 60_000,
  cancelRun: 25_000,
  redetect: 120_000,
} as const;

/** 带 HTTP 状态码的请求错误（面板据此区分「上游超时」与「上游不可用」）。 */
export class PanelRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'PanelRequestError';
    this.status = status;
  }
}

/** 面板错误分类（用于挑选可读的提示文案）。 */
export type PanelErrorKind =
  'upstream-timeout' | 'upstream-unavailable' | 'unknown';

/**
 * 把取数错误归类：上游超时（504 或浏览器侧 signal timed out）/
 * 上游不可用（502）/ 其它（原文展示）。
 */
export function classifyPanelError(error: unknown): PanelErrorKind {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof PanelRequestError ? error.status : 0;
  if (status === 504 || /超时|timed out|timeout/i.test(message)) {
    return 'upstream-timeout';
  }
  if (status === 502 || /上游|连接|connection/i.test(message)) {
    return 'upstream-unavailable';
  }
  return 'unknown';
}

/** 取 JSON（非 2xx 时读 body.error 抛 PanelRequestError；超时降级见 anytype 先例）。 */
export async function fetchJson<T>(
  path: string,
  init?: RequestInit,
  timeoutMs: number = TIMEOUTS.status,
): Promise<T> {
  const hasTimeout =
    typeof AbortSignal !== 'undefined' &&
    typeof AbortSignal.timeout === 'function';
  const response = await fetch(
    path,
    hasTimeout ? { ...init, signal: AbortSignal.timeout(timeoutMs) } : init,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: unknown;
    } | null;
    const message =
      typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
    throw new PanelRequestError(message, response.status);
  }
  return (await response.json()) as T;
}

/** 面板取数面（注入点：测试可替换）。 */
export interface PanelApi {
  status(): Promise<DiagnosticReport>;
  projects(): Promise<ProjectsPayload>;
  focus(): Promise<FocusPayload>;
  redetect(): Promise<DiagnosticReport>;
  /** 运行状态查询（GET ?runId=）。 */
  run(runId: string): Promise<RunPayload>;
  /** 发起生成（POST /runs）。 */
  startRun(input: StartRunInput): Promise<RunPayload>;
  /** 请求取消（POST /runs/cancel）。 */
  cancelRun(runId: string): Promise<RunPayload>;
  /** 可用 agent 列表。 */
  agents(): Promise<AgentsPayload>;
  /** 技能检索（服务端已过滤截断；offset 供「加载更多」分页）。 */
  skills(
    query: string,
    limit?: number,
    offset?: number,
  ): Promise<SkillsPayload>;
  /** 工作流插件列表。 */
  plugins(limit?: number): Promise<PluginsPayload>;
}

/**
 * 默认实现：同源 fetch 宿主只读路由。
 *
 * 超时约定：客户端超时 = 宿主路由的上游超时（UPSTREAM_TIMEOUTS）+ 5s 余量，
 * 保证先收到后端可区分的 504「上游超时」，而不是浏览器侧笼统的 signal
 * timed out；redetect 不经上游调用，沿用自身预算。
 */
export const panelApi: PanelApi = {
  status: () =>
    fetchJson<DiagnosticReport>(STATUS_ENDPOINT, undefined, TIMEOUTS.status),
  projects: () =>
    fetchJson<ProjectsPayload>(PROJECTS_ENDPOINT, undefined, TIMEOUTS.projects),
  focus: () =>
    fetchJson<FocusPayload>(FOCUS_ENDPOINT, undefined, TIMEOUTS.focus),
  redetect: () =>
    fetchJson<DiagnosticReport>(
      REDETECT_ENDPOINT,
      { method: 'POST' },
      TIMEOUTS.redetect,
    ),
  run: (runId) =>
    fetchJson<RunPayload>(
      `${RUNS_ENDPOINT}?runId=${encodeURIComponent(runId)}`,
      undefined,
      TIMEOUTS.run,
    ),
  startRun: (input) =>
    fetchJson<RunPayload>(
      RUNS_ENDPOINT,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
      TIMEOUTS.startRun,
    ),
  cancelRun: (runId) =>
    fetchJson<RunPayload>(
      RUN_CANCEL_ENDPOINT,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId }),
      },
      TIMEOUTS.cancelRun,
    ),
  agents: () =>
    fetchJson<AgentsPayload>(AGENTS_ENDPOINT, undefined, TIMEOUTS.agents),
  skills: (query, limit = 20, offset = 0) =>
    fetchJson<SkillsPayload>(
      `${SKILLS_ENDPOINT}?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`,
      undefined,
      TIMEOUTS.skills,
    ),
  plugins: (limit = 50) =>
    fetchJson<PluginsPayload>(
      `${PLUGINS_ENDPOINT}?limit=${limit}`,
      undefined,
      TIMEOUTS.plugins,
    ),
};
