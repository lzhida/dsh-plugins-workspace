/**
 * lint 组：wiki_lint——失效链接 / 孤立页巡检（只产出建议，不改数据）。
 *
 * ## 实现路径（活体实测 2026-10-30，含一次修正）
 *
 * Anytype 对象文档的 GET 响应**不含** `links`/`backlinks`（计算属性），也
 * 没有 per-object 的反查端点；但 `POST /search` 的 `fields` 投影可以拿到：
 * `properties.links` = 出链目标 id 数组，`properties.backlinks` = 入链来源
 * id 数组。**注意**：带 `type` 过滤时 fields 白名单 = 该类型字段表可见键，
 * `links`/`backlinks` 会被 400 拒收；只有**全空间查询**（不带 type）才放行
 * 这两个计算键——故此处不带 type 分页扫描，客户端按 `row.type` 过滤出
 * wiki 笔记后再建链接图。
 *
 * ## 判定规则
 *
 * - **失效链接**：某笔记的 `links` 里出现「不在本空间未归档对象集合」的
 *   目标 id（归档/删除/跨空间/跨类型目标都会落到这一类）。
 * - **孤立页**：`backlinks` 为空的笔记（没有任何其它笔记链到它）。
 *
 * 只报告、不修复：链接修复属内容决策（改哪篇、怎么链），交给 wiki_write
 * 或人工。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import type { JsonValue } from '../../core/index.ts';

import { WIKI_TYPE_KEY } from '../schema.ts';
import type { SearchRow } from '../store.ts';
import {
  listOf,
  outputSpec,
  propertyKey,
  resolveSpaceId,
  textOf,
  type WikiToolDeps,
} from './shared.ts';

/** 单页条数（服务端单请求上限内）。 */
const PAGE_SIZE = 1000;

/** 输出里逐条列举的明细上限（超过只给计数）。 */
const DETAIL_CAP = 50;

/** 构建 lint 组工具。 */
export function buildLintTools(deps: WikiToolDeps) {
  return [
    defineTool({
      name: 'wiki_lint',
      isConcurrencySafe: () => true,
      description:
        'Audit the wiki graph (read-only, never modifies notes): broken links (a note points to an object id that no longer exists unarchived in this space — archived, deleted, or in another space/type) and orphan pages (no other note links to them). Suggestions only — apply fixes via wiki_write or wiki_review.',
      parameters: {
        max_pages: {
          type: 'number',
          description:
            'Max search pages to scan (1000 notes per page; default 10 = 10k notes, max 50).',
        },
        space_id: {
          type: 'string',
          description:
            'Anytype space id. Omit to use the configured wiki space.',
        },
      },
      output: outputSpec(),
      async execute(args, exec): Promise<Record<string, JsonValue>> {
        const spaceId = await resolveSpaceId(deps, String(args.space_id ?? ''));
        const keys = await deps.store.resolveKeys(spaceId, exec?.signal);
        const statusKey = propertyKey(keys, 'status');
        const maxPages = Math.min(
          Math.max(Number(args.max_pages ?? 10) || 10, 1),
          50,
        );

        // 分页扫描：**不带 type**（带 type 时 fields 白名单 = 类型字段表
        // 键，links/backlinks 会被 400 拒收），行内按 type 过滤 wiki 笔记。
        const rows = new Map<string, SearchRow>();
        let scanned = 0;
        let offset = 0;
        let pages = 0;
        let hasMore = true;
        while (hasMore && pages < maxPages) {
          const result = await deps.store.search({
            spaceId,
            query: '',
            fields: ['name', statusKey, 'links', 'backlinks'],
            limit: PAGE_SIZE,
            offset,
            signal: exec?.signal,
          });
          for (const row of result.rows) {
            scanned += 1;
            if (row.type === WIKI_TYPE_KEY) rows.set(row.id, row);
          }
          pages += 1;
          offset += result.rows.length;
          hasMore = result.hasMore === true && result.rows.length > 0;
        }

        const liveIds = new Set(rows.keys());
        const broken: Array<Record<string, JsonValue>> = [];
        const orphans: Array<Record<string, JsonValue>> = [];
        let brokenTotal = 0;
        let orphanTotal = 0;

        for (const row of rows.values()) {
          const links = listOf(row.properties?.links);
          for (const target of links) {
            if (liveIds.has(target)) continue;
            brokenTotal += 1;
            if (broken.length < DETAIL_CAP) {
              broken.push({
                from_id: row.id,
                from_name: row.name,
                target_id: target,
              });
            }
          }
          if (listOf(row.properties?.backlinks).length === 0) {
            orphanTotal += 1;
            if (orphans.length < DETAIL_CAP) {
              orphans.push({
                object_id: row.id,
                name: row.name,
                status: textOf(row.properties?.[statusKey]),
              });
            }
          }
        }

        return {
          space_id: spaceId,
          checked: rows.size,
          scanned_objects: scanned,
          scanned_pages: pages,
          truncated: hasMore,
          counts: { broken_links: brokenTotal, orphan_pages: orphanTotal },
          broken_links: broken as JsonValue,
          orphan_pages: orphans as JsonValue,
          detail_cap: DETAIL_CAP,
          hint: 'wiki_lint never modifies notes. Fix broken links by rewriting the linking note (wiki_write); archive stale orphans via wiki_review. Broken targets include objects archived, deleted, or living outside this wiki space.',
        };
      },
    }),
  ];
}
