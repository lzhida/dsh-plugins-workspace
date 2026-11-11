import type { JsonValue } from './json.ts';
import {
  VictauriError,
  VictauriHttpError,
  VictauriTimeoutError,
} from './errors.ts';
import type { VictauriInstance } from './discovery.ts';
import { scanInstances, sortCandidates } from './discovery.ts';

/**
 * victauri REST 直连客户端(主通道)。
 *
 * 对接 victauri 插件随 Tauri app 启动的 HTTP 服务:
 * - `/health`:无认证 liveness 探活
 * - `/info`:带认证的实例信息(连接探活用它——能同时验证端口与 token 配对)
 * - `GET /api/tools`:工具列表(条目 {name, description},无 inputSchema)
 * - `POST /api/tools/{tool_name}`:执行工具;成功响应为 {result: <工具返回>},
 *   callTool 解包后返回工具返回本身;工具级失败为 HTTP 200 + 顶层 {"error"},
 *   callTool 归一为结构化 tool-error(S-1)
 */
export class VictauriClient implements VictauriClientLike {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  /**
   * 该客户端绑定的上游端口。
   *
   * 只有「按实例/按端口构造」才知道端口；直接 `new VictauriClient({baseUrl})`
   * 时为 null（baseUrl 可能不是 127.0.0.1:port 形态，不做脆弱解析）。
   */
  readonly port: number | null;

  constructor(options: VictauriClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.port = options.port ?? null;
  }

  /** 从 discovery 实例构造(端口拼 URL、token 直取)。 */
  static fromInstance(
    instance: VictauriInstance,
    options: { timeoutMs?: number } = {},
  ): VictauriClient {
    return new VictauriClient({
      baseUrl: `http://127.0.0.1:${String(instance.port)}`,
      token: instance.token,
      timeoutMs: options.timeoutMs,
      port: instance.port,
    });
  }

  /**
   * 按「端口 + token」显式构造独立客户端实例。
   *
   * 多活体场景（插件自身需要同时对接多个应用，或体检工具要逐个探活）需要
   * **每个应用一份独立实例**：连接状态、token、超时互不干扰。与 connectAuto 的
   * 共享连接（src/index.ts 的 clientPromise 缓存）并存、互不影响。
   *
   * @param port - 上游 victauri 服务端口（127.0.0.1）
   * @param token - 该实例的 Bearer token（来自 discovery 的 token 文件）
   */
  static forPort(
    port: number,
    token: string,
    options: { timeoutMs?: number } = {},
  ): VictauriClient {
    return new VictauriClient({
      baseUrl: `http://127.0.0.1:${String(port)}`,
      token,
      timeoutMs: options.timeoutMs,
      port,
    });
  }

  /**
   * 无认证 liveness 探活:端口上有 victauri 服务即 true(不验证 token)。
   *
   * 接线决策:**不接入插件工具面**(有意为之,非悬空项)。理由——
   * ① 连接建立路径(`connectAuto` → `info()`)已做带认证探活,失败以
   *    `no-instance` / `no-live-instance` 结构化错误返回,比布尔更可诊断;
   * ② `victauri_tools_list` 调用成功本身即证明服务在线,再暴露一个探针只会
   *    多一次往返与一个工具位;
   * ③ 保留为 client 公开 API(单测覆盖),供外部调用方按需使用。
   */
  async health(): Promise<boolean> {
    try {
      const response = await this.request('/health', 'GET');
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * 带认证探活兼取实例信息:验证端口可达与 token 配对。
   * @param timeoutMsOverride - 本次请求的超时覆盖毫秒(探活要短预算:
   *   体检工具逐个实例探活等不起默认的 30s,见 src/tools/doctor.ts)。
   * @returns /info 的 JSON 体(如 {name,port,protocol,version,...})
   * @throws VictauriHttpError 非 2xx(含 401=token 不配对)
   * @throws VictauriError('tool-error') 响应不是 JSON 对象
   */
  async info(timeoutMsOverride?: number): Promise<Record<string, JsonValue>> {
    const body = await this.getJson('/info', 'info', timeoutMsOverride);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new VictauriError('tool-error', 'info: expected JSON object');
    }
    return body;
  }

  /**
   * 工具列表:条目形状 {name, description}(0.8.8~0.10.2 实测无 inputSchema;
   * 未来若服务端补 schema,该字段会原样透传在条目里)。
   */
  async listTools(): Promise<VictauriToolInfo[]> {
    const body = await this.getJson('/api/tools', 'listTools');
    if (!Array.isArray(body)) {
      throw new VictauriError(
        'tool-error',
        `listTools: expected array response, got ${typeof body}`,
      );
    }
    return body.filter(isToolInfo);
  }

  /**
   * 执行工具并解包 {result} 包裹。
   * @param timeoutMsOverride - 本次请求的超时覆盖毫秒（per-tool 预算，
   *   由工具层经 resolveRequestBudgetMs 解析后传入）；缺省沿用构造超时。
   * @throws VictauriHttpError HTTP 非 2xx(kind 按 status 细分,见 errors.ts)
   * @throws VictauriError('tool-error') 响应不是 {result: ...} 形状,
   *   或 HTTP 200 + 顶层 {"error": ...} 的工具级失败信封(S-1)
   */
  async callTool(
    toolName: string,
    args: Record<string, JsonValue> = {},
    timeoutMsOverride?: number,
  ): Promise<JsonValue> {
    const path = `/api/tools/${encodeURIComponent(toolName)}`;
    const response = await this.request(path, 'POST', args, timeoutMsOverride);
    const bodyText = await response.text();
    if (!response.ok) {
      throw new VictauriHttpError(
        response.status,
        bodyText.slice(0, 500),
        `callTool(${toolName})`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText) as unknown;
    } catch {
      throw new VictauriError(
        'tool-error',
        `callTool(${toolName}): response is not valid JSON`,
      );
    }
    if (typeof parsed === 'object' && parsed !== null && 'result' in parsed) {
      const wrapped = parsed as { result: unknown };
      return normalizeJson(wrapped.result);
    }
    // S-1(backlog-A):上游工具级失败信封是 HTTP 200 + 顶层 {"error": <值>}
    // (rest.rs to_rest_json 口径),没有 result 键——归一为结构化 tool-error,
    // 不再当数据透出给模型。error 非 string 时用 JSON 摘要(截 500 字符)。
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      'error' in parsed &&
      !('result' in parsed)
    ) {
      const errValue = (parsed as { error: unknown }).error;
      const summary =
        typeof errValue === 'string'
          ? errValue
          : (JSON.stringify(errValue) ?? String(errValue)).slice(0, 500);
      throw new VictauriError(
        'tool-error',
        `callTool(${toolName}): upstream tool-level failure: ${summary}`,
      );
    }
    // 兼容:某些版本/端点可能直接返回工具结果(无 result 包裹)
    return normalizeJson(parsed);
  }

  /** GET + Bearer + JSON 解析(带超时与结构化错误)。 */
  private async getJson(
    path: string,
    context: string,
    timeoutMsOverride?: number,
  ): Promise<Record<string, JsonValue> | JsonValue[]> {
    const response = await this.request(
      path,
      'GET',
      undefined,
      timeoutMsOverride,
    );
    const bodyText = await response.text();
    if (!response.ok) {
      throw new VictauriHttpError(
        response.status,
        bodyText.slice(0, 500),
        context,
      );
    }
    try {
      return JSON.parse(bodyText) as Record<string, JsonValue> | JsonValue[];
    } catch {
      throw new VictauriError(
        'tool-error',
        `${context}: response is not valid JSON`,
      );
    }
  }

  /**
   * 底层 fetch:统一 Bearer/Content-Type/超时(AbortController)。
   * timeoutMsOverride 缺省时用构造超时;单一计时器,不与 HTTP 层叠加双计时。
   */
  private async request(
    path: string,
    method: 'GET' | 'POST',
    jsonBody?: Record<string, JsonValue>,
    timeoutMsOverride?: number,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const budget = timeoutMsOverride ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      return await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(jsonBody !== undefined
            ? { 'Content-Type': 'application/json' }
            : {}),
        },
        ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new VictauriTimeoutError(url, budget);
      }
      throw new VictauriError(
        'http-error',
        `${method} ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 默认工具执行超时:victauri 侧 eval_timeout_secs=30,取同量级。 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 连接客户端的最小公开面:getClient 消费方（standalone/compound 桥、工具发现）
 * 依赖此形状而非具体类——S-2 重发现包装层（src/index.ts 的
 * ReconnectingVictauriClient）与本体同形、可互换注入。
 */
export interface VictauriClientLike {
  callTool(
    toolName: string,
    args?: Record<string, JsonValue>,
    timeoutMsOverride?: number,
  ): Promise<JsonValue>;
  info(timeoutMsOverride?: number): Promise<Record<string, JsonValue>>;
  listTools(): Promise<VictauriToolInfo[]>;
  health(): Promise<boolean>;
}

/** 客户端构造选项。 */
export interface VictauriClientOptions {
  /** 服务基址,如 http://127.0.0.1:7373 */
  baseUrl: string;
  /** Bearer token */
  token: string;
  /** 请求超时毫秒;默认 DEFAULT_TIMEOUT_MS */
  timeoutMs?: number;
  /** 已知上游端口(按实例/按端口构造时给出;缺省 null) */
  port?: number;
}

/** GET /api/tools 的单条工具信息(name/description 必有,其余透传)。 */
export interface VictauriToolInfo {
  name: string;
  description: string;
  [key: string]: JsonValue;
}

/** 条目守卫:name+description 均为 string 才算工具条目。 */
function isToolInfo(value: JsonValue): value is VictauriToolInfo {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, JsonValue>;
  return typeof record['name'] === 'string';
}

/** 未知工具返回体归一化为 JsonValue(undefined→null,dsh 契约禁止 undefined)。 */
function normalizeJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  return value as JsonValue;
}

/**
 * 自动连接:扫描 discovery 候选,按 started_at 降序逐个带认证探活,
 * 返回第一个 /info 成功的客户端(端口可达 + token 配对同时成立)。
 * @throws VictauriError('no-instance') 无候选
 * @throws VictauriError('no-live-instance') 有候选但全部探活失败
 */
export async function connectAuto(
  options: ConnectAutoOptions = {},
): Promise<{ client: VictauriClient; instance: VictauriInstance }> {
  const candidates = sortCandidates(
    scanInstances({
      rootDir: options.rootDir,
      identifier: options.identifier,
    }),
  );
  if (candidates.length === 0) {
    throw new VictauriError(
      'no-instance',
      options.identifier !== undefined
        ? `no victauri instance for identifier '${options.identifier}'`
        : 'no victauri instance found in discovery roots',
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const failures: string[] = [];
  for (const candidate of candidates) {
    const client = VictauriClient.fromInstance(candidate, { timeoutMs });
    try {
      await client.info();
      return { client, instance: candidate };
    } catch (err) {
      failures.push(
        `pid ${String(candidate.pid)} port ${String(candidate.port)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  throw new VictauriError(
    'no-live-instance',
    `all ${String(candidates.length)} discovery candidates failed: ${failures.join('; ')}`,
  );
}

/** connectAuto 选项。 */
export interface ConnectAutoOptions {
  /** discovery 根目录覆盖(测试注入) */
  rootDir?: string | string[];
  /** 按 bundle id 过滤(对应 bridge --app 语义) */
  identifier?: string;
  /** 探活/后续请求超时毫秒 */
  timeoutMs?: number;
}
