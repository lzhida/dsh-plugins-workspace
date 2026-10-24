/**
 * dsh-anytype-core 公共出口。
 *
 * 本包是 dsh-anytype 系列的共享底座，收敛两件东西：
 * - `client.ts`：Anytype v2 本地 API 的 HTTP 语义（头部、取消与超时、
 *   错误归一、ETag / Idempotency-Key / If-Match 三件安全原语、结果截断）；
 * - `shared.ts`：工具层公共设施（依赖注入形状、统一执行路径、统一输出
 *   声明、共享参数常量）。
 *
 * 消费方（`dsh-anytype` / `dsh-anytype-memory`）只从这里取工具层基建，
 * 各自保留自己的设置 schema 与业务语义。
 */

// ── 客户端 ────────────────────────────────────────────────────────────
export { AnytypeClient, AnytypeError } from './client.ts';
export {
  buildUrl,
  renderValue,
  toToolValue,
  TOOL_OUTPUT_SPEC,
} from './client.ts';
export type {
  AnytypeClientOptions,
  AnytypeResult,
  AnytypeToolValue,
  ApiErrorBody,
  FetchLike,
  JsonValue,
  QueryValue,
  RequestOptions,
} from './client.ts';

// ── 工具层公共设施 ────────────────────────────────────────────────────
export {
  DRY_RUN_PARAM,
  enc,
  IDEMPOTENCY_KEY_PARAM,
  outputSpec,
  pickPatchBody,
  runRequest,
} from './shared.ts';
export type { ToolConfigView, ToolDeps, ToolRunContextLike } from './shared.ts';

// ── volatile 配置支持 ─────────────────────────────────────────────────
export {
  desc,
  isVolatileLike,
  setDescription,
  unwrapVolatile,
  volatileField,
} from './volatile.ts';
export type { SchemaDescription } from './volatile.ts';
