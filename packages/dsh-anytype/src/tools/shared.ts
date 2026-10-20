/**
 * 工具层公共设施：依赖注入形状、统一执行路径与统一输出声明。
 *
 * 每个工具都遵循同一约定：
 * - execute 里先 `deps.config()` 现读 volatile 配置（设置面板保存即生效），
 *   再经 `deps.client` 发请求（取消信号 `exec.signal` 透传给客户端）；
 * - 成功值统一为 `{status, data, etag?}`（超限时 `truncated` + `data_preview`），
 *   由 `runRequest` 产出、`outputSpec` 渲染；
 * - 失败直接抛 `AnytypeError`（message 即可操作文本），registry 以 isError 呈现；
 * - 只读工具声明 `isConcurrencySafe: true`，可与其他读工具并行调度。
 */

import type { ToolRunContext } from '@deepseek-ai/dsh-tools';

import type {
  AnytypeClient,
  AnytypeToolValue,
  RequestOptions,
} from '../client.ts';
import { renderValue, toToolValue } from '../client.ts';
import type { ResolvedConfig, ToolGroup } from '../config.ts';

/** 工具构建依赖（由 index.ts 在 apply 闭包里组装）。 */
export interface ToolDeps {
  /** HTTP 客户端（resolveOptions 每请求现读配置）。 */
  client: AnytypeClient;
  /** volatile 配置现读入口。 */
  config: () => ResolvedConfig;
}

/** 工具归属组（disabledGroups 过滤的粒度）。 */
export interface GroupedDefinition {
  group: ToolGroup;
}

/**
 * 工具执行公共路径：发请求 → 按配置截断 → 工具返回值。
 * 取消信号由调用方（registry）经 exec.signal 传入并透传到 fetch。
 */
export async function runRequest(
  deps: ToolDeps,
  exec: ToolRunContext,
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
