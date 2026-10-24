/**
 * 搜索组：anytype_search（全局/空间二合一）+ anytype_list_objects。
 *
 * - `POST /v2/search`（全局）与 `POST /v2/spaces/{space_id}/search`（空间内）
 *   共享同一个 SearchRequestDoc 请求体——一个工具按是否传 `space_id` 二合一，
 *   少一个面板条目；
 * - `GET /v2/spaces/{space_id}/objects` —— 按分页直接列对象（不涉全文检索）。
 *
 * 请求体字段（活体规范 `GET /v2/schemas/search` 自述，Anytype-Version
 * 2025-11-08 / 2026-10-21 活体核对）：
 * - `query`（必填）、`type`、`sorts`、`filters`（结构化过滤数组）；
 * - `filter`（字符串，≤4096 **字节**）——紧凑过滤语法，EBNF 见
 *   `GET /v2/schemas/filters`（`anytype_get_schema(kind='filters')`）；
 * - `fields`（字符串数组）——**属性投影**（见下方「fields 的真实语义」）。
 *
 * `filter` 与 `filters` **互斥**（规范为二选一）：同时传服务端返 400
 * `ambiguous_input`。本工具层提前拦下并给出可操作错误，省一次往返。
 *
 * ## fields 的真实语义（2026-10-21 活体实测，纠正「响应裁剪」的直觉）
 *
 * **不传 `fields` 时，搜索响应行只有骨架**（`id` / `name` / `type`，全局搜索
 * 另加 `space_id`），**不带 `properties` 映射**——服务端默认就不回属性。
 * 传 `fields` 反而是**要求服务端把列出的属性投影进 `properties`**：
 *
 * | 请求 | 行形状 |
 * | --- | --- |
 * | 不传 fields | `{id, name, type}`（无 properties） |
 * | `fields:["name"]` | `{id, name, type, properties:{name}}` |
 * | `fields:["name","due_date"]` | `{id, name, type, properties:{name, due_date?}}` |
 *
 * 所以 `fields` 是**「投影哪些属性回来」**（加内容），不是「裁掉多余属性」
 * （减内容）——与 `anytype_list_objects` 的 `fields`（GET query，逗号分隔
 * 字符串）语义一致：**显式点名要哪些属性**。响应体因此**变大**而非变小：
 * 20 行空间搜索实测 2298 字节（无 fields）→ 3156 字节（fields=["name"]）。
 *
 * 对截断的影响因此是**双向**的：`fields` 让 agent 能用一次窄查询拿到
 * 需要的属性而不必全量拉取（减少往返），但它本身**不减小**单次响应体积；
 * 真正压体积靠 `filter`（收窄结果集）+ `limit`（分页）。
 *
 * 另注（活体实测）：`fields` 的键必须在**该 type 的已知属性集**内——
 * 传了 `type` 时按该 type 的键集校验（`type=task` 时 `description` 不合法），
 * 不传 `type` 时按空间全集校验（140 个键）。未知键服务端返 400
 * `unknown property keys` 并附「did you mean」提示。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import {
  enc,
  outputSpec,
  runRequest,
  type ToolDeps,
} from '@lzhida/dsh-anytype-core';

/**
 * 判定「是否真的给了过滤条件」。
 *
 * 服务端对**空串** `filter` 的处理是「忽略」（`filter:""` + `filters:[...]`
 * 实测正常返回并按 filters 生效）；但 `filters:null` 会 400。故这里把
 * `null`/`undefined`/空数组一律视作「未提供」，避免把无效负载发给服务端。
 */
function hasFilterValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * 组装搜索请求体：过滤通道二选一 + 可选属性投影。
 *
 * 互斥规则（活体实测）：同传 `filter` 与 `filters` 服务端返 400
 * `ambiguous_input`（"provide filter or filters, not both"）。本层提前拦，
 * 给出指明二选一的可操作错误。
 *
 * @param args - 工具入参（fields/filter/filters/sorts/type）。
 * @returns POST body。
 * @throws {Error} filter 与 filters 同传时抛可操作错误。
 */
function buildSearchBody(args: {
  query: string;
  type?: string;
  sorts?: unknown;
  filters?: unknown;
  filter?: string;
  fields?: string[];
}): Record<string, unknown> {
  const body: Record<string, unknown> = { query: args.query };
  if (args.type !== undefined) body.type = args.type;
  if (args.sorts !== undefined) body.sorts = args.sorts;

  const hasFilter = hasFilterValue(args.filter);
  const hasFilters = hasFilterValue(args.filters);
  if (hasFilter && hasFilters) {
    throw new Error(
      'Provide EITHER filter (compact filter string) OR filters (structured array) — they are two mutually exclusive filter channels; the API rejects both with 400 ambiguous_input. Pick one: filter for the compact syntax (grammar: anytype_get_schema kind=filters), filters for the structured array.',
    );
  }
  if (hasFilter) body.filter = args.filter;
  if (hasFilters) body.filters = args.filters;

  // 属性投影：点名要回哪些属性（不传时响应行只有 id/name/type 骨架）。
  if (args.fields !== undefined) body.fields = args.fields;
  return body;
}

/** 构建搜索组工具。 */
export function buildSearchTools(deps: ToolDeps) {
  return [
    defineTool({
      name: 'anytype_search',
      description:
        'Full-text search over object names and indexed content across all spaces, or inside one space when space_id is given. By default each row carries only id/name/type (plus space_id for the global search) — use ids with anytype_get_object for full content. fields names the property keys to project back per row (e.g. ["name","due_date"]); filter is a compact filter string (max 4096 bytes, grammar on anytype_get_schema kind=filters) that narrows the result set; filter and filters are mutually exclusive, pass one. Use filter plus limit to keep responses small instead of fetching everything and re-querying.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'Full-text query.',
        },
        space_id: {
          type: 'string',
          description:
            'Restrict the search to this space; omit to search all granted spaces.',
        },
        type: {
          type: 'string',
          description: 'Optional type key filter (e.g. page, task).',
        },
        limit: {
          type: 'integer',
          description: 'Page size (API default 25, max 1000).',
        },
        offset: {
          type: 'integer',
          description: 'Pagination offset (API default 0).',
        },
        sorts: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description:
            'Optional sort clauses; schema from anytype_get_schema (kind search).',
        },
        filters: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description:
            'Optional property filters as a structured array; schema from anytype_get_schema (kind filters). Mutually exclusive with filter — pass one of the two.',
        },
        filter: {
          type: 'string',
          description:
            "Optional compact filter string (max 4096 bytes) to narrow by property, e.g. 'done = false AND due_date < currentWeek()'. Grammar: anytype_get_schema (kind filters). Mutually exclusive with filters — pass one of the two.",
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional property keys to project into each row\'s properties map (e.g. ["name","due_date"], max 25). Without fields a row carries only id/name/type (plus space_id for the global search) and no properties at all; with fields the listed properties come back under row.properties. Keys must be known property keys of the type in play (an unknown key is rejected with 400) — list them with anytype_list_properties. Note this ADDS properties to the response, it does not strip them: use filter and limit to keep the result set small.',
        },
      },
      output: outputSpec(),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const body = buildSearchBody(args);
        const path =
          args.space_id === undefined
            ? '/v2/search'
            : `/v2/spaces/${enc(args.space_id)}/search`;
        return runRequest(deps, exec, 'POST', path, {
          body,
          query: { limit: args.limit, offset: args.offset },
        });
      },
    }),
    defineTool({
      name: 'anytype_list_objects',
      description:
        'List objects in one space with pagination (no full-text matching). Prefer anytype_search to find objects by content.',
      parameters: {
        space_id: {
          type: 'string',
          required: true,
          description: 'Target space id.',
        },
        limit: {
          type: 'integer',
          description: 'Page size (API default 25, max 1000).',
        },
        offset: {
          type: 'integer',
          description: 'Pagination offset (API default 0).',
        },
        fields: {
          type: 'string',
          description:
            'Optional comma-separated field list to trim the response (e.g. "id,name,snippet").',
        },
      },
      output: outputSpec(),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return runRequest(
          deps,
          exec,
          'GET',
          `/v2/spaces/${enc(args.space_id)}/objects`,
          {
            query: {
              limit: args.limit,
              offset: args.offset,
              fields: args.fields,
            },
          },
        );
      },
    }),
  ];
}
