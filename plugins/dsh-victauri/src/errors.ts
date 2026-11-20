/** victauri 桥的结构化错误:kind 可判别,细节字段可编程消费。 */
export class VictauriError extends Error {
  readonly kind: VictauriErrorKind;

  constructor(kind: VictauriErrorKind, message: string) {
    super(`[${kind}] ${message}`);
    this.name = 'VictauriError';
    this.kind = kind;
  }
}

/**
 * REST 桥接错误信封的**封闭词汇表**（11 值，只此一处定义）。
 *
 * 语义域：本表只描述「REST 桥接调用 victauri 时」的失败原因，会出现在工具返回的
 * `{error:{kind,message,hint,status?}}` 信封里（见 src/tools/standalone/bridge.ts）。
 *
 * 其中 4 个值由 HTTP 状态码机械推导（VictauriHttpError 构造器内 kindForStatus）：
 * `invalid-params`(400) / `auth`(401,403) / `not-found`(404) / `rate-limited`(429)；
 * `http-error` 收窄为其余状态码（5xx/405 等）与网络层 fetch 失败。
 *
 * 与另外两套词汇表**相互独立、不可互相比较**（名字相近但含义不同）：
 * - `src/tools/cli-status.ts` 的 `CliStatusError.kind`
 *   （not_found / cli-error / timeout）——**CLI 探测域**自有词汇表，
 *   描述「victauri CLI 是否装好、能否跑起来」；
 * - `src/tools/tools-list.ts` 的 warning `kind`
 *   （not_exposed / missing_on_server）——**工具发现域**自有词汇表，
 *   描述「某个上游工具是否被本插件暴露 / 服务端是否存在」。
 *
 * 例：cli 探测域的 `not_found` 表示「CLI 没找到」，与本表的 `no-instance`
 * （找不到活的 victauri 实例）不是一回事，不可按名字等价理解。
 *
 * 兜底值：非 VictauriError 的异常在信封里归一为 `unknown`
 * （见 src/tools/standalone/bridge.ts 的 toErrorValue），`unknown` 是**兜底值、
 * 不属于本封闭表**，也不代表任何一种已定义的失败原因。
 */
export type VictauriErrorKind =
  /** discovery 目录不存在或无候选实例 */
  | 'no-instance'
  /** 实例目录缺 token/port 文件或 metadata.json 损坏 */
  | 'instance-incomplete'
  /** 所有候选实例探活失败(端口不通/token 不配对) */
  | 'no-live-instance'
  /** HTTP 400:上游参数校验失败(serde 反序列化拒绝,多为参数名/类型不符) */
  | 'invalid-params'
  /** HTTP 401/403:token 不配对或授权不足 */
  | 'auth'
  /** HTTP 404:端点或工具不存在(多为插件与服务端版本差异) */
  | 'not-found'
  /** HTTP 429:上游限流 */
  | 'rate-limited'
  /** 其余 HTTP 非 2xx(5xx/405 等)与网络层失败(fetch 连接拒绝/DNS 等),带 status */
  | 'http-error'
  /** 请求超时 */
  | 'timeout'
  /** 工具被拒:上游工具级失败信封(HTTP 200 + 顶层 {"error"})或响应不符合协议形状 */
  | 'tool-error'
  /** victauri CLI spawn 失败(可执行文件不存在等) */
  | 'cli-error';

/** unknown 收窄:是否为 victauri 结构化错误。 */
export function isVictauriError(err: unknown): err is VictauriError {
  return err instanceof VictauriError;
}

/**
 * M-1(backlog-A):按 HTTP 状态码细分 kind 的机械映射。
 * 400→invalid-params、401/403→auth、404→not-found、429→rate-limited,
 * 其余(5xx/405 等)保持 http-error。与重发现矩阵(src/index.ts 的
 * shouldResetClient)协同:复位判定只看 status,不依赖本映射结果。
 */
function kindForStatus(status: number): VictauriErrorKind {
  if (status === 400) return 'invalid-params';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limited';
  return 'http-error';
}

/** HTTP 非 2xx 错误:携带状态码与响应体摘要;kind 由 status 机械推导。 */
export class VictauriHttpError extends VictauriError {
  readonly status: number;
  readonly bodyPreview: string;

  constructor(status: number, bodyPreview: string, context: string) {
    super(
      kindForStatus(status),
      `${context} failed with HTTP ${status}${bodyPreview ? `: ${bodyPreview}` : ''}`,
    );
    this.name = 'VictauriHttpError';
    this.status = status;
    this.bodyPreview = bodyPreview;
  }
}

/** 请求超时错误:携带目标 URL 与超时毫秒。 */
export class VictauriTimeoutError extends VictauriError {
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super('timeout', `request to ${url} timed out after ${timeoutMs}ms`);
    this.name = 'VictauriTimeoutError';
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}
