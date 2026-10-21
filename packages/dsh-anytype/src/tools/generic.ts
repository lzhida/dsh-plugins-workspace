/**
 * 逃生舱组：anytype_request。
 *
 * 兜底覆盖其余端点（chats / messages / files / widgets / queries /
 * discussion / validate 等），保证「完整」：专用工具没暴露的能力
 * （如文件上传、聊天消息、widget 布局）都经这里直达。
 *
 * 已知文件面/流式限制（已写入工具描述）：multipart 上传不可发
 * （POST /v2/files 仅 JSON url 形态可达）、GET files content 二进制
 * 按文本损坏、/messages/stream 为 SSE 会挂至超时。
 *
 * 安全白名单（execute 内强制）：
 * - 只允许 `/v2/` 前缀（v1 旧 API 不在封装范围）；
 * - 拒绝 `/v2/auth/` 密钥管理端点（challenge/api_keys 轮换是用户在
 *   Anytype 应用内的人事操作，不属于 agent 职责；whoami 已有专门工具）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import type { JsonValue, QueryValue } from '../client.ts';
import {
  DRY_RUN_PARAM,
  IDEMPOTENCY_KEY_PARAM,
  outputSpec,
  runRequest,
  type ToolDeps,
} from './shared.ts';

/**
 * 校验逃生舱路径白名单；不通过时抛可操作错误。
 *
 * @param path - 请求路径（必须以 `/v2/` 开头且不得进入 `/v2/auth/`）。
 */
export function assertAllowedPath(path: string): void {
  if (!path.startsWith('/v2/')) {
    throw new Error(
      `Blocked path "${path}": this plugin only forwards /v2/ API paths.`,
    );
  }
  if (path === '/v2/auth' || path.startsWith('/v2/auth/')) {
    throw new Error(
      `Blocked path "${path}": auth/key-management endpoints are not exposed to agents. Use anytype_whoami for key info; create/revoke keys in the Anytype app yourself.`,
    );
  }
}

/** query 对象（JSON 值）→ 客户端 query 记录（null/undefined 跳过，其余 String()）。 */
function normalizeQuery(
  query: Record<string, JsonValue> | undefined,
): Record<string, QueryValue> | undefined {
  if (query === undefined) return undefined;
  const out: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    out[key] = String(value);
  }
  return out;
}

/** 构建逃生舱组工具。 */
export function buildGenericTools(deps: ToolDeps) {
  return [
    defineTool({
      name: 'anytype_request',
      description:
        'Generic Anytype v2 API passthrough for endpoints without a dedicated tool: chats & messages, file upload/download, widgets, queries, object discussion, validate, etc. Only /v2/ paths are allowed; /v2/auth/* is blocked. method+path are required; pass query as an object and body as a JSON value (schema from anytype_get_schema). Known limits: POST /v2/files only works in its JSON url form (multipart/form-data bodies cannot be sent); GET /v2/files/{id}/content returns binary data decoded as corrupted text; /messages/stream is SSE and hangs until the request times out. Write calls may add ?dry_run=true to the query to preview without committing, and idempotency_key to make a retry safe.',
      parameters: {
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
          required: true,
          description: 'HTTP method.',
        },
        path: {
          type: 'string',
          required: true,
          description:
            'API path starting with /v2/, e.g. /v2/spaces/{space_id}/chats.',
        },
        query: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional query parameters as an object.',
        },
        dry_run: {
          ...DRY_RUN_PARAM,
          description: `${DRY_RUN_PARAM.description} Only for endpoints that accept it (resource mutations); read endpoints and POST /v2/validate ignore or refuse it.`,
        },
        body: {
          type: 'json',
          description:
            'Optional request body (JSON value; sent as application/json).',
        },
        expected_etag: {
          type: 'string',
          description:
            'ETag from a previous read; sent as If-Match. Not for chats: chat/message concurrency uses order-id/last_state_id, not ETags.',
        },
        idempotency_key: IDEMPOTENCY_KEY_PARAM,
      },
      output: outputSpec(),
      async execute(args, exec) {
        assertAllowedPath(args.path);
        const query = normalizeQuery(args.query);
        return runRequest(deps, exec, args.method, args.path, {
          query:
            query === undefined && args.dry_run === undefined
              ? undefined
              : { ...query, dry_run: args.dry_run },
          body: args.body,
          expectedEtag: args.expected_etag,
          idempotencyKey: args.idempotency_key,
        });
      },
    }),
  ];
}
