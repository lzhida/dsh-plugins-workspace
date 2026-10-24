/**
 * 工具层公共设施：依赖注入形状、统一执行路径与统一输出声明。
 *
 * 每个工具都遵循同一约定：
 * - execute 里先 `deps.config()` 现读 volatile 配置（设置面板保存即生效），
 *   再经 `deps.client` 发请求（取消信号 `exec.signal` 透传给客户端）；
 * - 成功值统一为 `{status, data, etag?}`（超限时 `truncated` + `data_preview`），
 *   由 `runRequest` 产出、`outputSpec` 渲染；
 * - 失败直接抛 `AnytypeError`（message 即可操作文本），registry 以 isError 呈现；
 * - 只读工具声明 `isConcurrencySafe: true`，可与其他读工具并行调度；
 * - 写工具统一带 `dry_run`（预演）与 `idempotency_key`（防重）两个可选参数，
 *   语义见 `DRY_RUN_PARAM` / `IDEMPOTENCY_KEY_PARAM` 与 README「写路径安全」段。
 */

import type {
  AnytypeClient,
  AnytypeToolValue,
  RequestOptions,
} from './client.ts';
import { renderValue, toToolValue } from './client.ts';

/**
 * 工具执行上下文的**最小结构视图**。
 *
 * 宿主 `@deepseek-ai/dsh-tools` 的 `ToolRunContext` 内含品牌类型
 * （branded `MessageId` 等）。若本包直接 `import type` 它，pnpm 下
 * 「本包一份 dsh-tools + 消费插件另一份 dsh-tools」会得到两个不同的
 * 类型身份，真实上下文传进来即报不可赋值。
 *
 * 工具层实际只用到取消信号，故此处只声明结构化的最小视图——真实
 * `ToolRunContext` 可直接传入（结构化兼容，绕开品牌类型身份）。
 */
export interface ToolRunContextLike {
  /** 调用方取消信号（透传给 fetch）。 */
  readonly signal: AbortSignal;
}

/**
 * 工具层所需的**最小配置视图**。
 *
 * 本包不含任何插件的设置 schema（那属于各插件自身），只约定工具层真正
 * 读取的字段。各插件把自己的 volatile 配置投影成这个视图即可：
 * - `dsh-anytype`：`{baseUrl, apiKey, apiVersion, timeoutMs: requestTimeoutMs,
 *   maxResponseChars}`；
 * - `dsh-anytype-memory`：同构。
 */
export interface ToolConfigView {
  /** Anytype 本地 API 地址（无尾斜杠）。 */
  baseUrl: string;
  /** Bearer 密钥（空串 = 未配置）。 */
  apiKey: string;
  /** `Anytype-Version` 请求头取值。 */
  apiVersion: string;
  /** 单请求超时（毫秒）——与客户端选项 `timeoutMs` 同义，取插件命名习惯。 */
  requestTimeoutMs: number;
  /** 工具结果文本截断上限（字符数）。 */
  maxResponseChars: number;
}

/**
 * `dry_run` 参数的共享描述（预演语义）。
 *
 * 规范语义：写操作加 `?dry_run=true` 只校验并回报结果、不落库；创建类
 * 预演返 200（提交返 201），更新/删除类预演与提交同为 200——靠响应体的
 * `dry_run: true` 布尔字段区分（实测 2026-10-21，Anytype 活体）。
 */
export const DRY_RUN_PARAM: { type: 'boolean'; description: string } = {
  type: 'boolean',
  description:
    "true = preview only: the request is validated and reported but NOT committed (nothing is created, updated or deleted). A previewed create returns 200 where a real create returns 201; previewed updates and deletes also return 200, so read the response body's dry_run flag to tell a preview from a commit.",
};

/**
 * `idempotency_key` 参数的共享描述（防重语义）。
 *
 * 规范语义：服务端按「key + 请求体」绑定——同 key 同 body 重复提交重放已存
 * 响应（不会重复创建），同 key 换 body 返 409 `idempotency_conflict`。
 * 因此**重试同一请求必须复用同一个 key**，换了请求内容才换新 key。
 */
export const IDEMPOTENCY_KEY_PARAM: { type: 'string'; description: string } = {
  type: 'string',
  description:
    'Optional idempotency key (any unique string, e.g. a uuid). The server binds it to the request body: retrying the SAME request with the SAME key replays the stored response instead of creating a duplicate, while reusing a key with a DIFFERENT body returns 409 idempotency_conflict. Generate a fresh key per distinct request and reuse it verbatim when retrying the same one.',
};

/** 工具构建依赖（由各插件的 index.ts 在 apply 闭包里组装）。 */
export interface ToolDeps {
  /** HTTP 客户端（resolveOptions 每请求现读配置）。 */
  client: AnytypeClient;
  /** volatile 配置现读入口（返回最小配置视图）。 */
  config: () => ToolConfigView;
}

/**
 * 工具执行公共路径：发请求 → 按配置截断 → 工具返回值。
 * 取消信号由调用方（registry）经 exec.signal 传入并透传到 fetch。
 */
export async function runRequest(
  deps: ToolDeps,
  exec: ToolRunContextLike,
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<AnytypeToolValue> {
  const cfg = deps.config();
  const result = await deps.client.request(method, path, {
    ...opts,
    signal: exec.signal,
  });
  return toToolValue(result, cfg.maxResponseChars);
}

/** 统一输出声明：开放 object schema + 纯 JSON 文本渲染（可回放）。 */
export function outputSpec(): {
  schema: { type: 'object'; additionalProperties: true };
  render: (
    args: unknown,
    value: unknown,
  ) => Array<{ type: 'text'; text: string }>;
} {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
  };
}

/** 路径参数编码（ID/key 虽通常是安全字符，仍统一编码防注入）。 */
export function enc(value: string): string {
  return encodeURIComponent(value);
}

/**
 * 从「扁平字段 或 ops 信封」两类互斥形态构造 PATCH 请求体；
 * 两者都缺失时抛可操作错误。
 */
export function pickPatchBody(
  flat: Record<string, unknown>,
  ops: unknown,
): Record<string, unknown> {
  const hasFlat = Object.values(flat).some((v) => v !== undefined);
  if (Array.isArray(ops) && ops.length > 0) {
    if (hasFlat) {
      throw new Error(
        'Provide EITHER flat fields OR an ops array — they are two mutually exclusive request forms.',
      );
    }
    return { ops };
  }
  if (hasFlat) return flat;
  throw new Error(
    'Nothing to update: provide at least one field (or an ops array). Read the object first; op schemas come from anytype_get_op_schema.',
  );
}
