/**
 * 活体搜索裁剪冒烟测试（真实 Anytype 桌面端 API）。
 *
 * **默认跳过**——需要真实 API key 与在线的 Anytype 桌面端：
 * ```sh
 * ANYTYPE_LIVE_KEY=<key> ANYTYPE_LIVE_SPACE=<space_id> \
 *   pnpm exec vitest run packages/dsh-anytype/src/live-search.test.ts
 * ```
 * 未设 `ANYTYPE_LIVE_KEY` / `ANYTYPE_LIVE_SPACE` 时整文件跳过
 * （`describe.skipIf`），故 CI 与 `pnpm test` 全量跑不会因缺 key 而红。
 *
 * 覆盖「属性投影 + 过滤语法」两条核心契约（只读，零副作用）：
 * 1. 默认行只有 id/name/type 骨架；`fields` 把点名的属性投影进
 *    `row.properties`（**加**属性，不是裁掉属性）；
 * 2. `filter`（紧凑语法）能真正收窄结果集。
 *
 * 参考：Anytype-Version 2025-11-08，2026-10-21 活体核对
 * （`GET /v2/schemas/search` 与 `GET /v2/schemas/filters`）。
 */

import { AnytypeClient } from '@lzhida/dsh-anytype-core';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { describe, expect, it } from 'vitest';

import { resolveConfig } from './config.ts';
import { buildGroupedTools } from './tools/index.ts';

const LIVE_KEY = process.env.ANYTYPE_LIVE_KEY;
const LIVE_SPACE = process.env.ANYTYPE_LIVE_SPACE ?? '';
const LIVE_BASE = process.env.ANYTYPE_LIVE_BASE ?? 'http://127.0.0.1:31009';

/** 空执行上下文（只关心 signal 透传）。 */
function stubExec(): ToolRunContext {
  return { signal: new AbortController().signal } as unknown as ToolRunContext;
}

/** 组装指向活体后端的客户端与工具表。 */
function liveDeps() {
  const client = new AnytypeClient(() => ({
    baseUrl: LIVE_BASE,
    apiKey: LIVE_KEY ?? '',
    apiVersion: '2025-11-08',
    timeoutMs: 15000,
  }));
  const deps = { client, config: () => resolveConfig(undefined) };
  const tools = new Map(
    [...buildGroupedTools(deps).values()].flat().map((t) => [t.name, t]),
  );
  return { client, tools };
}

/** 搜索响应行（宽松形状——只取用得到的字段）。 */
interface SearchRow {
  id?: string;
  name?: string;
  type?: string;
  properties?: Record<string, unknown>;
}

interface SearchResult {
  status: number;
  data?: {
    data?: SearchRow[];
    total?: number;
    has_more?: boolean;
  };
}

/** 执行一次 anytype_search 并返回解析后的响应。 */
async function search(
  tools: Map<string, { execute: (a: unknown, e: ToolRunContext) => unknown }>,
  args: Record<string, unknown>,
): Promise<SearchResult> {
  return (await tools
    .get('anytype_search')!
    .execute(args, stubExec())) as SearchResult;
}

describe.skipIf(!LIVE_KEY || !LIVE_SPACE)(
  'dsh-anytype 活体搜索裁剪（fields / filter）',
  () => {
    it('不传 fields 时行只有 id/name/type 骨架（无 properties）', async () => {
      const { tools } = liveDeps();
      const result = await search(tools, {
        space_id: LIVE_SPACE,
        query: '',
        limit: 5,
      });
      expect(result.status).toBe(200);
      const rows = result.data?.data ?? [];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.id).toBeTruthy();
        expect(row.name).toBeTruthy();
        expect(row.type).toBeTruthy();
        // 默认不带属性映射
        expect(row.properties).toBeUndefined();
      }
    });

    it('fields 把点名的属性投影进 row.properties', async () => {
      const { tools } = liveDeps();
      const result = await search(tools, {
        space_id: LIVE_SPACE,
        query: '',
        fields: ['name'],
        limit: 5,
      });
      expect(result.status).toBe(200);
      const rows = result.data?.data ?? [];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        // 行骨架不受 fields 影响
        expect(row.id).toBeTruthy();
        expect(row.name).toBeTruthy();
        // properties 映射只含被点名的键
        expect(Object.keys(row.properties ?? {})).toEqual(['name']);
      }
    });

    it('filter（紧凑语法）收窄结果集', async () => {
      const { tools } = liveDeps();
      const all = await search(tools, {
        space_id: LIVE_SPACE,
        query: '',
        limit: 1000,
      });
      const narrowed = await search(tools, {
        space_id: LIVE_SPACE,
        query: '',
        filter: 'type = "task"',
        limit: 1000,
      });
      expect(all.status).toBe(200);
      expect(narrowed.status).toBe(200);
      const allTotal = all.data?.total ?? 0;
      const narrowedTotal = narrowed.data?.total ?? 0;
      expect(narrowedTotal).toBeLessThan(allTotal);
      // 命中行全部是 task
      for (const row of narrowed.data?.data ?? []) {
        expect(row.type).toBe('task');
      }
    });

    it('filter 与 filters 同传在工具层被拒（不打到服务端）', async () => {
      const { tools } = liveDeps();
      await expect(
        tools.get('anytype_search')!.execute(
          {
            space_id: LIVE_SPACE,
            query: '',
            filter: 'type = "task"',
            filters: [{ property: 'type', condition: 'equal', value: 'task' }],
          },
          stubExec(),
        ),
      ).rejects.toThrow(/mutually exclusive/);
    });
  },
);
