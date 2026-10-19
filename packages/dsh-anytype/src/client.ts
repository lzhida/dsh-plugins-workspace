/**
 * Anytype 本地 API 的 HTTP 客户端（双后端感知）。
 *
 * 后端模型：桌面端（31009，主账户实时库）与 anytype-cli（31012，独立 bot
 * 账户数据面）是两台不同的服务器、两套互不通用的 key——客户端负责按配置
 * 选择/回退，并在每个成功结果上标注 `backend`，让调用方与模型始终知道
 * 自己在对哪个数据面操作。
 *
 * 职责（工具层的全部 HTTP 语义都收敛在这里）：
 * - 后端解析：`auto` = desktop 优先，**仅网络层不可达（fetch 拒绝）** 且 CLI
 *   已配置（cliKey 非空）时才切 cli；401/403 等鉴权失败原样上抛（换后端
 *   等于换账户数据面，绝不静默）；显式 `desktop`/`cli` 模式只用单后端；
 * - 头部：`Authorization: Bearer <key>` + `Anytype-Version`（写请求自动补
 *   `Content-Type: application/json`，乐观锁经 `expectedEtag` 映射 `If-Match`）；
 * - 取消与超时：`AbortSignal.any` 组合「调用方信号 + 配置超时」；
 * - 不可达干预钩子：首个候选网络不可达时调用 `onUnreachable(backend)`
 *   （index.ts 接线 autoStart 拉起器），每后端 60s 冷却防重复拉起；钩子
 *   返回 true 则对该后端重试一次；
 * - 错误归一：非 2xx → `AnytypeError`（status + code/message/issues/hints
 *   可操作文本）；连接失败 NETWORK；未配置 key → CONFIG_MISSING_KEY；
 * - 成功结果：`{status, data, etag?, backend}`——etag 取自响应头供乐观锁；
 * - 截断：`toToolValue` 超限替换为 `data_preview`，undefined 属性整键省略
 *   （registry 无损 JSON 校验）。
 */

/** 单个后端端点。 */
export interface BackendEndpoint {
  name: 'desktop' | 'cli';
  url: string;
  key: string;
}

/** 客户端运行时配置（由调用方每次请求前从 volatile 配置现读）。 */
export interface ClientConfig {
  apiVersion: string;
  timeoutMs: number;
  backendMode: 'auto' | 'desktop' | 'cli';
  desktop: { url: string; key: string };
  cli: { url: string; key: string };
}

/**
 * 后端网络不可达时的干预钩子（autoStart 接线点）。
 * 返回 true 表示干预后该后端可能已恢复，客户端将重试一次。
 */
export type UnreachableHook = (backend: 'desktop' | 'cli') => Promise<boolean>;

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
  /** 实际服务本请求的后端。 */
  backend: 'desktop' | 'cli';
};

/** 工具层最终返回值（已按 maxResponseChars 截断）。 */
export type AnytypeToolValue = {
  status: number;
  data?: JsonValue;
  etag?: string;
  backend?: 'desktop' | 'cli';
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
  const full: AnytypeToolValue = omitUndefined({
    status: result.status,
    data: result.data,
    etag: result.etag,
    backend: result.backend,
  });
  const text = JSON.stringify(full, null, 2);
  if (text.length <= maxChars) return full;
  const preview = `${text.slice(0, maxChars)}…(+${text.length - maxChars} chars truncated; re-query with narrower filters/pagination if needed)`;
  return {
    ...omitUndefined({
      status: result.status,
      etag: result.etag,
      backend: result.backend,
    }),
    truncated: true,
    data_preview: preview,
  };
}

/** 浅层省略 undefined 值的属性（无损 JSON 安全）。 */
function omitUndefined<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

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

/** 不可达干预的每后端冷却时间（毫秒）。 */
const INTERVENTION_COOLDOWN_MS = 60_000;

/** 单后端探测结果（anytype_status 工具用）。 */
export interface BackendProbeResult {
  name: 'desktop' | 'cli';
  url: string;
  /** key 已配置。 */
  configured: boolean;
  /** 网络可达（收到任意 HTTP 响应）。 */
  reachable: boolean;
  /** whoami 鉴权通过（2xx）。 */
  authenticated: boolean;
  error?: string;
}

/**
 * Anytype 双后端客户端。
 *
 * `resolveConfig` 每次请求前调用——volatile 配置（key/超时/后端模式等）在
 * 设置面板保存后即刻生效，无需重载插件。
 */
export class AnytypeClient {
  /** 配置现读入口（volatile 每请求解包）。 */
  private readonly resolveConfig: () => ClientConfig;
  /** fetch 注入点（测试 mock；默认全局 fetch）。 */
  private readonly fetchImpl: FetchLike;
  /** 不可达干预钩子（autoStart 接线；可选）。 */
  private readonly onUnreachable?: UnreachableHook;
  /** 每后端上次干预时间戳（冷却门控）。 */
  private readonly interventions = new Map<string, number>();

  constructor(
    resolveConfig: () => ClientConfig,
    fetchImpl: FetchLike = fetch,
    onUnreachable?: UnreachableHook,
  ) {
    this.resolveConfig = resolveConfig;
    this.fetchImpl = fetchImpl;
    this.onUnreachable = onUnreachable;
  }

  /** 按后端模式排出候选（auto 跳过未配置的 key）。 */
  private resolveCandidates(cfg: ClientConfig): BackendEndpoint[] {
    const desktop: BackendEndpoint = {
      name: 'desktop',
      url: cfg.desktop.url,
      key: cfg.desktop.key,
    };
    const cli: BackendEndpoint = {
      name: 'cli',
      url: cfg.cli.url,
      key: cfg.cli.key,
    };
    if (cfg.backendMode === 'desktop') return [desktop];
    if (cfg.backendMode === 'cli') return [cli];
    const candidates: BackendEndpoint[] = [];
    if (desktop.key.length > 0) candidates.push(desktop);
    if (cli.key.length > 0) candidates.push(cli);
    return candidates;
  }

  /**
   * 发起一次 API 调用：按候选顺序尝试，仅网络层失败（NETWORK）才切换下一
   * 候选；首候选失败时触发干预钩子（autoStart，带冷却），恢复则原地重试。
   *
   * @param method - HTTP 方法（GET/POST/PATCH/PUT/DELETE）。
   * @param path - 以 `/` 开头的 API 路径（如 `/v2/spaces`）。
   * @returns 归一结果 `{status, data, etag?, backend}`。
   * @throws {AnytypeError} 配置缺失（CONFIG_MISSING_KEY）、干预后仍全部候选
   *   网络失败（NETWORK，聚合信息）、调用方取消（ABORTED）、超时（TIMEOUT）、
   *   以及一切非 2xx 响应（携带解析后的错误体；不触发后端切换）。
   */
  async request(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<AnytypeResult> {
    const cfg = this.resolveConfig();
    const candidates = this.resolveCandidates(cfg);
    if (candidates.length === 0) {
      throw new AnytypeError(
        'dsh-anytype: no backend API key is configured. Set the desktop key (Anytype App Settings → API Keys) and/or the CLI bot key (`anytype auth apikey create`) in Settings → Plugins → dsh-anytype.',
        0,
        { code: 'CONFIG_MISSING_KEY' },
      );
    }

    const failures: string[] = [];
    for (const candidate of candidates) {
      const outcome = await this.tryCandidate(
        candidate,
        cfg,
        method,
        path,
        opts,
      );
      if (outcome.result !== undefined) return outcome.result;
      const networkError = outcome.error;
      if (networkError === undefined) throw outcome.fatal;
      failures.push(networkError.message);

      // 干预钩子（autoStart）：仅网络失败、冷却期内一次，恢复后原地重试
      if (
        this.onUnreachable !== undefined &&
        this.interventionAllowed(candidate.name)
      ) {
        this.interventions.set(candidate.name, Date.now());
        let recovered: boolean;
        try {
          recovered = await this.onUnreachable(candidate.name);
        } catch {
          recovered = false;
        }
        if (recovered) {
          const retry = await this.tryCandidate(
            candidate,
            cfg,
            method,
            path,
            opts,
          );
          if (retry.result !== undefined) return retry.result;
          if (retry.error === undefined) throw retry.fatal;
          failures.push(
            `${candidate.name} after auto-start: ${retry.error.message}`,
          );
        }
      }
    }

    throw new AnytypeError(
      `Cannot reach any configured Anytype backend (${candidates.map((c) => `${c.name} @ ${c.url}`).join(', ')}). ${failures.join(' | ')} Start the Anytype desktop app (port 31009) or the CLI service (\`anytype service start\`, port 31012).`,
      0,
      { code: 'NETWORK' },
    );
  }

  /** 干预冷却判定。 */
  private interventionAllowed(name: string): boolean {
    const last = this.interventions.get(name);
    return last === undefined || Date.now() - last >= INTERVENTION_COOLDOWN_MS;
  }

  /**
   * 对单个候选执行请求。返回三态：
   * - `{result}`：成功；
   * - `{error}`：网络层失败（NETWORK），调用方决定是否切换候选；
   * - `{fatal}`：其余一切错误（配置/鉴权/超时/取消/非 2xx），立即上抛。
   */
  private async tryCandidate(
    candidate: BackendEndpoint,
    cfg: ClientConfig,
    method: string,
    path: string,
    opts: RequestOptions,
  ): Promise<{
    result?: AnytypeResult;
    error?: AnytypeError;
    fatal?: AnytypeError;
  }> {
    try {
      const result = await this.requestOne(candidate, cfg, method, path, opts);
      return { result };
    } catch (err) {
      if (err instanceof AnytypeError && err.body.code === 'NETWORK') {
        return { error: err };
      }
      return { fatal: err as AnytypeError };
    }
  }

  /** 对单个后端发起一次请求并归一结果（不涉及后端选择）。 */
  private async requestOne(
    backend: BackendEndpoint,
    cfg: ClientConfig,
    method: string,
    path: string,
    opts: RequestOptions,
  ): Promise<AnytypeResult> {
    if (backend.key.length === 0) {
      throw new AnytypeError(
        `dsh-anytype: the ${backend.name} backend has no API key configured. Set it in Settings → Plugins → dsh-anytype.`,
        0,
        { code: 'CONFIG_MISSING_KEY' },
      );
    }
    const url = buildUrl(backend.url, path, opts.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${backend.key}`,
      'Anytype-Version': cfg.apiVersion,
      Accept: 'application/json',
    };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (opts.expectedEtag !== undefined && opts.expectedEtag.length > 0) {
      headers['If-Match'] = opts.expectedEtag;
    }

    const signals: AbortSignal[] = [AbortSignal.timeout(cfg.timeoutMs)];
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
          `Anytype request timed out after ${cfg.timeoutMs}ms (${backend.name}: ${backend.url}${path}).`,
          0,
          { code: 'TIMEOUT' },
        );
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new AnytypeError(
        `Cannot reach the Anytype ${backend.name} backend at ${backend.url}${path}: ${reason}. Is this backend running? (desktop app → port 31009; CLI → \`anytype service start\`, port 31012)`,
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
    const result: AnytypeResult = {
      status: response.status,
      data,
      backend: backend.name,
    };
    if (etag !== undefined) result.etag = etag;
    return result;
  }

  /**
   * 实时探测两个后端（anytype_status 工具用；不走候选回退、无缓存）。
   * `effective` = 按当前模式与候选顺序首个「已配置且可达」的后端。
   */
  async probeAll(signal?: AbortSignal): Promise<{
    desktop: BackendProbeResult;
    cli: BackendProbeResult;
    effective: 'desktop' | 'cli' | 'none';
  }> {
    const cfg = this.resolveConfig();
    const desktopEndpoint: BackendEndpoint = {
      name: 'desktop',
      url: cfg.desktop.url,
      key: cfg.desktop.key,
    };
    const cliEndpoint: BackendEndpoint = {
      name: 'cli',
      url: cfg.cli.url,
      key: cfg.cli.key,
    };
    const desktop = await this.probeOne(desktopEndpoint, signal);
    const cli = await this.probeOne(cliEndpoint, signal);
    const order =
      cfg.backendMode === 'cli'
        ? [cliEndpoint, desktopEndpoint]
        : [desktopEndpoint, cliEndpoint];
    let effective: 'desktop' | 'cli' | 'none' = 'none';
    for (const endpoint of order) {
      const probe = endpoint.name === 'desktop' ? desktop : cli;
      if (probe.configured && probe.reachable) {
        effective = endpoint.name;
        break;
      }
    }
    return { desktop, cli, effective };
  }

  /** 单后端探测：whoami，2s 超时；收到任意 HTTP 响应即 reachable。 */
  private async probeOne(
    backend: BackendEndpoint,
    signal?: AbortSignal,
  ): Promise<BackendProbeResult> {
    const base: BackendProbeResult = {
      name: backend.name,
      url: backend.url,
      configured: backend.key.length > 0,
      reachable: false,
      authenticated: false,
    };
    if (!base.configured) return base;
    const signals: AbortSignal[] = [AbortSignal.timeout(2000)];
    if (signal) signals.push(signal);
    try {
      const response = await this.fetchImpl(
        buildUrl(backend.url, '/v2/auth/whoami'),
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${backend.key}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.any(signals),
        },
      );
      base.reachable = true;
      base.authenticated = response.ok;
      if (!response.ok) {
        base.error = `whoami responded ${response.status}`;
      }
      // 消费响应体，避免连接泄漏
      await response.text();
    } catch (err) {
      if (signal?.aborted) {
        base.error = 'probe aborted';
        return base;
      }
      base.error =
        err instanceof Error ? err.message.slice(0, 160) : String(err);
    }
    return base;
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
