/**
 * 设置页「验证接口」同源路由（决策工具系列 6/11）。
 *
 * 宿主半区把 `POST /dsh-decision/verify` 注册进宿主 webServer（kind 'exact'），
 * 浏览器端 client 只走同源 fetch（无跨域、无独立端口）。handler：
 * - 请求体 `{ baseUrl?, apiKey?, model?, timeoutMs? }`（全部可选；缺省字段
 *   回落已保存配置）——用于「先验证草稿、再保存」的体验；
 * - 调 systemone client 的探测验证（`verifySystemOne`，phase 'verify'）；
 * - 响应 `{ ok, model, latencyMs, reason? }`；**绝不回显 apiKey，也绝不把
 *   请求体写进日志**（契约 §1.1 敏感字段纪律）。
 * - 验证成功且「草稿 == 已保存配置」时顺带刷新进程内验证快照（等效于
 *   `runtime.verifyNow()` 的副作用，但不重复出网）。
 *
 * 安全栅栏（V2 审阅 M1）：
 * 1. **content-type 栅栏**：跨站简单请求（如 text/plain）无法设置
 *    application/json，浏览器也不会为它发预检——据此挡掉「诱使本机宿主把
 *    真实 apiKey 以 Bearer 头发往攻击者 baseUrl」的跨站表单/图片类攻击
 *    （先例：dsh-taskboard/src/host/routes.ts 的 CSRF fence）。
 * 2. **Origin 同源校验**：带 Origin 头的请求必须与 Host 同源。
 * 3. **跨主机不继承凭据**：草稿 baseUrl 与已保存 baseUrl 不同主机时，
 *    **不继承**已保存的 apiKey（必须随草稿显式提供），避免把真实密钥发往
 *    任意第三方地址。
 *
 * @module dsh-decision/web/verify-route
 */

import { fingerprintOf } from '../runtime/guard.ts';
import { verifySystemOne, type VerifyResult } from '../systemone/client.ts';
import {
  normalizeBaseUrl,
  type ResolvedToolsConfig,
} from '../config/decision-tools.ts';

/** 同源验证路由路径（client 侧 fetch 目标，与 PLUGIN 常量保持一致）。 */
export const VERIFY_ROUTE_PATH = '/dsh-decision/verify';

/** 宿主 webServer 服务的最小类型面（真实契约见宿主 dsh-host-webserver）。 */
export type VerifyRoute = {
  kind: 'exact' | 'prefix';
  path: string;
  handler: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => void | Promise<void>;
};

/** 宿主 webServer 形状（本插件只用到 register）。 */
export type WebServerLike = {
  register(route: VerifyRoute): () => void;
};

/** 验证路由依赖（复用统一调用层的读配置与验证快照刷新）。 */
export interface VerifyRouteDeps {
  readConfig: () => ResolvedToolsConfig;
  /** 验证成功且草稿与已保存配置一致时刷新快照（services 提供）。 */
  markVerified: () => void;
  /** 显式 fetch 注入（单测用；缺省全局 fetch）。 */
  fetchImpl?: typeof fetch;
}

/** 请求体里允许出现的草稿字段（其余字段一律忽略）。 */
export interface VerifyDraftInput {
  baseUrl?: unknown;
  apiKey?: unknown;
  model?: unknown;
  timeoutMs?: unknown;
}

const MAX_BODY_BYTES = 64 * 1024;

/** 归一后的草稿叠加结果（含「baseUrl 非法」这类可判定失败）。 */
export interface MergedDraft {
  config: ResolvedToolsConfig;
  /** 草稿显式给了非法 baseUrl（非 http(s) URL）。 */
  invalidBaseUrl: boolean;
  /** 草稿 baseUrl 与已保存 baseUrl 不同主机（凭据不继承）。 */
  crossHost: boolean;
}

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** 取 URL 的 host（解析失败回空串）。 */
export function hostOf(url: string): string {
  if (url === '') return '';
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 把请求体草稿叠加到已保存配置。
 *
 * 归一口径与配置面一致（`normalizeBaseUrl` + trim）——否则 baseUrl 带尾斜杠
 * 时「验证成功却不刷新验证快照」，工具继续报 model-verify-failed（V2 审阅 M2）。
 *
 * 跨主机不继承 apiKey（安全栅栏 3）。
 */
export function mergeDraftConfig(
  saved: ResolvedToolsConfig,
  draft: VerifyDraftInput,
): MergedDraft {
  const rawBaseUrl = trimmed(draft.baseUrl);
  const invalidBaseUrl =
    rawBaseUrl !== undefined && normalizeBaseUrl(rawBaseUrl) === '';
  const baseUrl =
    rawBaseUrl === undefined
      ? saved.systemoneBaseUrl
      : normalizeBaseUrl(rawBaseUrl);
  const draftHost = hostOf(baseUrl);
  const savedHost = hostOf(saved.systemoneBaseUrl);
  const crossHost =
    draftHost !== '' && savedHost !== '' && draftHost !== savedHost;
  const explicitKey = trimmed(draft.apiKey);
  // 跨主机时必须显式给 key；同主机（或尚未保存过）才回落已保存值。
  const apiKey = explicitKey ?? (crossHost ? '' : saved.systemoneApiKey);
  const model = trimmed(draft.model) ?? saved.systemoneModel;
  const rawTimeout = draft.timeoutMs;
  const timeoutMs =
    typeof rawTimeout === 'number' &&
    Number.isFinite(rawTimeout) &&
    rawTimeout >= 1_000 &&
    rawTimeout <= 300_000
      ? rawTimeout
      : saved.systemoneTimeoutMs;
  return {
    config: {
      ...saved,
      systemoneBaseUrl: baseUrl,
      systemoneApiKey: apiKey,
      systemoneModel: model,
      systemoneTimeoutMs: timeoutMs,
    },
    invalidBaseUrl,
    crossHost,
  };
}

/** 读取并解析 POST JSON 请求体（超限/非 JSON 返回 undefined，不抛异常）。 */
async function readJsonBody(
  req: import('node:http').IncomingMessage,
): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; reason: 'too-large' | 'not-json' }
> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const part = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += part.length;
    if (total > MAX_BODY_BYTES) return { ok: false, reason: 'too-large' };
    chunks.push(part);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { ok: false, reason: 'not-json' };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'not-json' };
  }
}

/** 响应体组装（只回显 model/latency/reason，敏感字段一律不出）。 */
export function verifyResponseOf(
  result: VerifyResult,
): Record<string, unknown> {
  if (result.ok) {
    return {
      ok: true,
      model: result.model ?? null,
      latencyMs: result.latencyMs,
    };
  }
  return {
    ok: false,
    model: null,
    latencyMs: result.latencyMs,
    reason: `${result.error.code}: ${result.error.message}`,
  };
}

/** Origin 与 Host 是否同源（无 Origin 头视为同源：CLI/curl 场景）。 */
export function isSameOrigin(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (origin === undefined || origin === '') return true;
  if (origin === 'null') return false;
  if (host === undefined || host === '') return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/** 构造同源验证路由 handler（闭包持有依赖；不写任何请求体日志）。 */
export function createVerifyRouteHandler(
  deps: VerifyRouteDeps,
): VerifyRoute['handler'] {
  return async (req, res) => {
    const send = (status: number, payload: Record<string, unknown>): void => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(payload));
    };
    if (req.method !== 'POST') {
      send(405, { ok: false, reason: 'method not allowed' });
      return;
    }
    // CSRF 栅栏：跨站简单请求无法设置 application/json（先例 dsh-taskboard）。
    const contentType = String(req.headers['content-type'] ?? '');
    if (!contentType.toLowerCase().startsWith('application/json')) {
      send(415, {
        ok: false,
        reason: 'invalid-arguments: content-type 必须是 application/json',
      });
      return;
    }
    // 同源校验：带 Origin 头时必须与 Host 同源。
    const origin = req.headers.origin;
    if (!isSameOrigin(origin, req.headers.host)) {
      send(403, { ok: false, reason: 'invalid-arguments: 跨源请求被拒绝' });
      return;
    }
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
      send(parsed.reason === 'too-large' ? 413 : 400, {
        ok: false,
        reason:
          parsed.reason === 'too-large'
            ? 'invalid-arguments: 请求体超过 64KB 上限'
            : 'invalid-arguments: 请求体不是 JSON 对象',
      });
      return;
    }
    const saved = deps.readConfig();
    const merged = mergeDraftConfig(saved, parsed.body);
    if (merged.invalidBaseUrl) {
      send(200, {
        ok: false,
        model: null,
        latencyMs: 0,
        reason: 'invalid-arguments: baseUrl 必须是 http(s) URL',
      });
      return;
    }
    const config = merged.config;
    if (
      config.systemoneBaseUrl === '' ||
      config.systemoneApiKey === '' ||
      config.systemoneModel === ''
    ) {
      send(200, {
        ok: false,
        model: null,
        latencyMs: 0,
        reason:
          'model-not-configured: 决策模型未配置完整（baseUrl / API key / model 任一为空）',
      });
      return;
    }
    const result = await verifySystemOne({
      http: {
        baseUrl: config.systemoneBaseUrl,
        apiKey: config.systemoneApiKey,
        model: config.systemoneModel,
        timeoutMs: config.systemoneTimeoutMs,
      },
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    if (result.ok && fingerprintOf(saved) === fingerprintOf(config)) {
      deps.markVerified();
    }
    send(200, verifyResponseOf(result));
  };
}

/** 组装完整路由对象（entry 注册用）。 */
export function createVerifyRoute(
  handler: VerifyRoute['handler'],
): VerifyRoute {
  return { kind: 'exact', path: VERIFY_ROUTE_PATH, handler };
}
