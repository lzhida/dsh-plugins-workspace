/**
 * Anytype v2 本地 API 的最小 HTTP 客户端。
 *
 * 职责（工具层的全部 HTTP 语义都收敛在这里）：
 * - 头部：`Authorization: Bearer <key>` + `Anytype-Version`（写请求自动补
 *   `Content-Type: application/json`，乐观锁经 `expectedEtag` 映射 `If-Match`，
 *   防重经 `idempotencyKey` 映射 `Idempotency-Key`）；
 * - 取消与超时：`AbortSignal.any` 组合「调用方信号（exec.signal）+ 配置超时」，
 *   Node 22 原生支持；
 * - 错误归一：非 2xx 响应体（`{code, message, issues, hints}`）解析为
 *   `AnytypeError`，message 为可直接展示的可操作文本；连接失败给出
 *   「Anytype 应用未运行？」类提示；未配置 apiKey 报配置错误；
 * - 成功结果：`{status, data, etag}`——`etag` 取自响应头，供写工具做
 *   `If-Match` 乐观锁闭环；
 * - 截断：`toToolValue(result, maxChars)` 把超限结果替换为带 `data_preview`
 *   的合法 JSON（截断在 execute 完成而非 render，保持 render 纯函数可回放）。
 */

/** 客户端运行时选项（由调用方每次请求前从 volatile 配置现读）。 */
export interface AnytypeClientOptions {
  baseUrl: string;
  apiKey: string;
  apiVersion: string;
  timeoutMs: number;
}

/** Anytype API 错误响应体的已知字段（其余字段原样保留在 raw 中）。 */
export interface ApiErrorBody {
  code?: string;
  message?: string;
  issues?: unknown;
  hints?: unknown;
  [key: string]: unknown;
}

/** JSON.parse 产出的无损 JSON 值（本地定义，避免引入未声明的传递依赖）。 */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** 成功请求的归一结果（type alias：与 Record<string, JsonValue> 结构兼容）。 */
export type AnytypeResult = {
  status: number;
  /** 解析后的响应体（JSON 或文本；204/空体为 null）。 */
  data: JsonValue;
  /** 响应 `ETag` 头（用于写操作的 If-Match 乐观锁）。 */
  etag?: string;
};

/** 工具层最终返回值（已按 maxResponseChars 截断）。 */
export type AnytypeToolValue = {
  status: number;
  data?: JsonValue;
  etag?: string;
  /** true = 响应超限，`data` 已替换为 `data_preview` 文本。 */
  truncated?: boolean;
  /** 截断时携带的序列化预览。 */
  data_preview?: string;
};

/** 归一化的 API/网络/配置错误。 */
export class AnytypeError extends Error {
  /** HTTP 状态码；0 = 网络/配置层失败（未触达 API 或未发出）。 */
  readonly status: number;
  /** 结构化错误体（API 错误原样；网络/配置错误为合成值）。 */
  readonly body: ApiErrorBody;

  /**
   * @param message - 可直接展示给模型/用户的文本（含可操作提示）。
   * @param status - HTTP 状态码；0 = 网络/配置层失败（未触达 API 或未发出）。
   * @param body - 结构化错误体（API 错误原样；网络/配置错误为合成值）。
   */
  constructor(message: string, status: number, body: ApiErrorBody) {
    super(message);
    this.name = 'AnytypeError';
    this.status = status;
    this.body = body;
  }
}

/** fetch 注入点（测试用 mock；默认全局 fetch）。 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** query 参数取值；undefined/null 的键跳过。 */
export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  /** 附加查询参数（序列化为 URLSearchParams）。 */
  query?: Record<string, QueryValue>;
  /** 请求体（对象 → JSON.stringify；字符串原样发送）。 */
  body?: unknown;
  /** 乐观锁：非空时映射为 `If-Match` 头。 */
  expectedEtag?: string;
  /**
   * 防重键：非空时映射为 `Idempotency-Key` 头。
   *
   * 语义（服务端实测 2026-10-21）：服务端按「key + 请求体」绑定——同 key
   * 同 body 重复提交重放已存响应（逐字节一致），同 key 换 body 返 409
   * `idempotency_conflict`。因此**重试必须复用同一个 key**，换请求内容才换
   * 新 key。
   *
   * 覆盖面：v2 spec 只在部分端点声明该头（spaces / chats / widgets /
   * discussion / validate），但服务端对 objects / types / properties /
   * collections 等 mutation 同样强制执行——故此处统一透传，由调用方决定
   * 是否给 key。
   */
  idempotencyKey?: string;
  /** 调用方取消信号（工具执行即 exec.signal）。 */
  signal?: AbortSignal;
}

/**
 * 把 AnytypeResult 转成工具层返回值：超限时 data 替换为预览，
 * 保证模型看到的始终是体积可控的合法 JSON。
 *
 * 注意：registry 对成功值做「无损 JSON」校验——值为 undefined 的属性
 * （如无 ETag 响应上的 `etag`）必须整键省略，不能以 `etag: undefined`
 * 形态存在。
 */
export function toToolValue(
  result: AnytypeResult,
  maxChars: number,
): AnytypeToolValue {
  const full: AnytypeToolValue =
    result.etag === undefined
      ? { status: result.status, data: result.data }
      : { status: result.status, data: result.data, etag: result.etag };
  const text = JSON.stringify(full, null, 2);
  if (text.length <= maxChars) return full;
  const preview = `${text.slice(0, maxChars)}…(+${text.length - maxChars} chars truncated; re-query with narrower filters/pagination if needed)`;
  const truncatedBase: AnytypeToolValue =
    result.etag === undefined
      ? { status: result.status }
      : { status: result.status, etag: result.etag };
  return {
    ...truncatedBase,
    truncated: true,
    data_preview: preview,
  };
}

/** Anytype 工具的统一输出 schema 形状（object，开放属性）。 */
export const TOOL_OUTPUT_SPEC = {
  type: 'object',
  additionalProperties: true,
} as const;

/** 把工具值渲染成单段文本内容（纯函数，接受任意已验证值）。 */
export function renderValue(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** 序列化 API 错误为可展示文本（含 hints/issues 与可操作建议）。 */
function formatErrorText(status: number, body: ApiErrorBody): string {
  const code = typeof body.code === 'string' ? body.code : 'UNKNOWN';
  const message =
    typeof body.message === 'string' ? body.message : 'request failed';
  const parts = [`Anytype API ${status} ${code}: ${message}`];
  if (body.issues !== undefined) {
    parts.push(`issues: ${JSON.stringify(body.issues)}`);
  }
  if (body.hints !== undefined) {
    parts.push(`hints: ${JSON.stringify(body.hints)}`);
  }
  return parts.join('; ');
}

/** 单个工具组通用：拼 URL（query 序列化、跳过 undefined/null 键）。 */
export function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, QueryValue>,
): string {
  if (!path.startsWith('/')) {
    throw new AnytypeError(`Invalid path "${path}": must start with "/"`, 0, {
      code: 'INVALID_ARGS',
    });
  }
  let qs = '';
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      params.set(key, String(value));
    }
    const encoded = params.toString();
    if (encoded.length > 0) qs = `?${encoded}`;
  }
  return `${baseUrl}${path}${qs}`;
}

/**
 * Anytype v2 API 客户端。
 *
 * `resolveOptions` 每次请求前调用——volatile 配置（apiKey/超时等）在设置面板
 * 保存后即刻生效，无需重载插件。
 */
export class AnytypeClient {
  /** 选项现读入口（volatile 配置每次请求前解包）。 */
  private readonly resolveOptions: () => AnytypeClientOptions;
  /** fetch 注入点（测试 mock；默认全局 fetch）。 */
  private readonly fetchImpl: FetchLike;

  constructor(
    resolveOptions: () => AnytypeClientOptions,
    fetchImpl: FetchLike = fetch,
  ) {
    this.resolveOptions = resolveOptions;
    this.fetchImpl = fetchImpl;
  }

  /**
   * 发起一次 API 调用并归一结果。
   *
   * @param method - HTTP 方法（GET/POST/PATCH/PUT/DELETE）。
   * @param path - 以 `/` 开头的 API 路径（如 `/v2/spaces`）。
   * @returns 归一结果 `{status, data, etag}`。
   * @throws {AnytypeError} 配置缺失（status 0）、网络失败（status 0）、
   *   调用方取消（status 0, code ABORTED）、超时（status 0, code TIMEOUT）、
   *   以及一切非 2xx 响应（携带解析后的错误体）。
   */
  async request(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<AnytypeResult> {
    const options = this.resolveOptions();
    if (options.apiKey.length === 0) {
      throw new AnytypeError(
        'dsh-anytype: apiKey is not configured. Set it in Settings → Plugins → dsh-anytype (Anytype App Settings → API Keys → Create new).',
        0,
        { code: 'CONFIG_MISSING_KEY' },
      );
    }
    const url = buildUrl(options.baseUrl, path, opts.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.apiKey}`,
      'Anytype-Version': options.apiVersion,
      Accept: 'application/json',
    };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (opts.expectedEtag !== undefined && opts.expectedEtag.length > 0) {
      headers['If-Match'] = opts.expectedEtag;
    }
    if (opts.idempotencyKey !== undefined && opts.idempotencyKey.length > 0) {
      headers['Idempotency-Key'] = opts.idempotencyKey;
    }

    const signals: AbortSignal[] = [AbortSignal.timeout(options.timeoutMs)];
    if (opts.signal) signals.push(opts.signal);
    const composed = AbortSignal.any(signals);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        signal: composed,
        body:
          opts.body === undefined
            ? undefined
            : typeof opts.body === 'string'
              ? opts.body
              : JSON.stringify(opts.body),
      });
    } catch (err) {
      // 区分「调用方主动取消」与「超时」与「连接失败」
      if (opts.signal?.aborted) {
        throw new AnytypeError('Anytype request aborted by caller.', 0, {
          code: 'ABORTED',
        });
      }
      if (
        err instanceof Error &&
        (err.name === 'TimeoutError' || err.name === 'AbortError')
      ) {
        throw new AnytypeError(
          `Anytype request timed out after ${options.timeoutMs}ms (${options.baseUrl}${path}).`,
          0,
          { code: 'TIMEOUT' },
        );
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new AnytypeError(
        `Cannot reach Anytype API at ${options.baseUrl}${path}: ${reason}. Is the Anytype desktop app running with the local API enabled?`,
        0,
        { code: 'NETWORK', message: reason },
      );
    }

    const etag = response.headers.get('etag') ?? undefined;
    const data = await parseBody(response);
    if (!response.ok) {
      const body = isRecord(data)
        ? (data as ApiErrorBody)
        : { message: typeof data === 'string' ? data : response.statusText };
      throw new AnytypeError(
        formatErrorText(response.status, body),
        response.status,
        body,
      );
    }
    const result: AnytypeResult = { status: response.status, data };
    if (etag !== undefined) result.etag = etag;
    return result;
  }

  /**
   * 桌面端诊断探测（anytype_status 工具用）：GET /v2/auth/whoami，
   * 2s 超时；收到任意 HTTP 响应即可达，2xx 为已认证。不走候选回退。
   */
  async probeDesktop(signal?: AbortSignal): Promise<{
    configured: boolean;
    reachable: boolean;
    authenticated: boolean;
    error?: string;
  }> {
    const options = this.resolveOptions();
    const result = {
      configured: options.apiKey.length > 0,
      reachable: false,
      authenticated: false,
      error: undefined as string | undefined,
    };
    if (!result.configured) return result;
    const signals: AbortSignal[] = [AbortSignal.timeout(2000)];
    if (signal) signals.push(signal);
    try {
      const response = await this.fetchImpl(
        buildUrl(options.baseUrl, '/v2/auth/whoami'),
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.any(signals),
        },
      );
      result.reachable = true;
      result.authenticated = response.ok;
      if (!response.ok) {
        result.error = `whoami responded ${response.status}`;
      }
      await response.text();
    } catch (err) {
      if (signal?.aborted) {
        result.error = 'probe aborted';
        return result;
      }
      result.error =
        err instanceof Error ? err.message.slice(0, 160) : String(err);
    }
    return result;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 解析响应体：JSON 优先，回退纯文本；204/空体为 null。 */
async function parseBody(response: Response): Promise<JsonValue> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (text.length === 0) return null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      return text;
    }
  }
  // 未声明 JSON 但形如 JSON 的响应（个别端点可能漏头）尝试一次解析
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      return text;
    }
  }
  return text;
}
