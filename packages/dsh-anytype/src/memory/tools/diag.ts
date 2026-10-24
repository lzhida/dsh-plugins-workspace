/**
 * diag 组：memory_doctor——把「能不能用、够不够用」变成实测结论。
 *
 * 诊断四件事：
 * 1. **连通性与权限**：whoami + 可见空间（401/403 各有各的处置建议）；
 * 2. **schema 现状**：类型与属性清单（v2 的单属性 GET 在本机 404，只能 list）；
 * 3. **能力探测**：filter 机制、relation 过滤语义、content_hash 属性是否就位；
 * 4. **中文召回自检**：写入一条一次性中文探针 → 用 Anytype 全文搜索验证
 *    中文短语能否命中 → 归档探针（DELETE 只对本 key 创建的对象有效，而
 *    探针正是本插件创建的）。
 *
 * 为什么需要第 4 项：Anytype 桌面端的全文检索实现与分词策略随版本变化，
 * 而本插件的中文用户场景完全依赖它。与其猜测，不如每次 setup 后用一次
 * 真实写入把结论测出来（探针用完即删，不留痕）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '../../core/index.ts';

import {
  andFilter,
  inFilter,
  outputSpec,
  propertyKey,
  resolveSpaceId,
  SCOPE_PARAM,
} from './shared.ts';
import type { MemoryToolDeps } from './shared.ts';

/**
 * 探针短语（每次带随机**常用中文**后缀，避免与真实内容撞词）。
 *
 * 两个实测约束（活体 2026-10-24）：
 * 1. 后缀必须是中文：混合「中文 + 随机 ASCII」的词元可能被分词器切成不同
 *    片段，导致「明明写了却搜不到」的假阴性；
 * 2. 后缀必须用**常用词**：用生僻词（观澜/蓑笠/孤舟…）做探针时，探针
 *    对象**已进索引**（ASCII 标记同对象可命中）但中文短语搜不到——说明
 *    Anytype 的中文分词对未登录词/生僻词不可靠。故探针用常用词，才能
 *    反映「普通中文记忆能否被召回」这一真实场景。
 */
function probePhrase(): string {
  const pool = '记忆检索测试验证索引写入召回缓存笔记空间插件数据标签来源';
  const pick = (): string =>
    pool[Math.floor(Math.random() * pool.length)] +
    pool[Math.floor(Math.random() * pool.length)];
  return `记忆探针${pick()}`;
}

/** 等待索引追上（Anytype 全文索引是最终一致的：刚写的对象可能搜不到）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 构建 diag 组工具。 */
export function buildDiagTools(deps: MemoryToolDeps) {
  return [
    defineTool({
      name: 'memory_doctor',
      description:
        'Diagnose the Anytype memory space: connectivity and permissions, visible spaces, the current type/property inventory, whether filtering and relation filtering work on this build, and — most importantly — whether Chinese full-text recall actually matches (it writes a disposable Chinese probe, searches for it, then archives the probe). Run it after memory_setup, or whenever recall returns nothing.',
      parameters: {
        space_id: SCOPE_PARAM,
        probe_chinese: {
          type: 'boolean',
          description:
            'true = run the Chinese recall self-test (writes and archives one probe object). Default true.',
        },
      },
      output: outputSpec(),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const warnings: string[] = [];
        const spaceId = await resolveSpaceId(deps, args.space_id);
        const keys = await deps.store.resolveKeys(spaceId, exec.signal);

        // 1) 连通性与空间
        const spaces = await deps.store.listSpaces(exec.signal);
        const types = await deps.store.listTypes(spaceId, exec.signal);
        const properties = await deps.store.listProperties(
          spaceId,
          exec.signal,
        );
        const memoryType = types.find((t) => t.key === 'memory');
        const memoryFields = memoryType
          ? await deps.store.getTypeFields(spaceId, 'memory', exec.signal)
          : [];

        // 2) 能力探测：filter 机制 + relation 过滤语义
        let filterWorks = false;
        let relationFilterWorks = false;
        let relationFilterRows = 0;
        try {
          const probe = await deps.store.search({
            spaceId,
            query: '',
            filter: inFilter(propertyKey(keys, 'kind'), ['fact']),
            fields: [propertyKey(keys, 'kind')],
            limit: 1,
            signal: exec.signal,
          });
          filterWorks = true;
          if (probe.total !== undefined) {
            // filter 生效（total 与不带 filter 的差异无法在一次请求内判定，
            // 这里只确认服务端接受并执行了该 filter）。
          }
        } catch (err) {
          warnings.push(`filter probe failed: ${(err as Error).message}`);
        }
        try {
          // 用**真实存在**的记忆对象 id 试 relation 过滤，区分「服务端不接受
          // 该 filter」与「接受但匹配不到对象」两种情况（活体实测：接受但匹配
          // 不到，故关系臂只能退化为「投影 links/backlinks 给 agent」）。
          const sample = await deps.store.search({
            spaceId,
            query: '',
            filter: inFilter(propertyKey(keys, 'kind'), ['fact']),
            limit: 1,
            signal: exec.signal,
          });
          const seedId = sample.rows[0]?.id ?? '';
          const probe = await deps.store.search({
            spaceId,
            query: '',
            filter: inFilter(propertyKey(keys, 'memory_relates_to'), [
              seedId || 'none',
            ]),
            limit: 5,
            signal: exec.signal,
          });
          relationFilterWorks = probe.total !== undefined;
          relationFilterRows = probe.total ?? 0;
          if (seedId.length > 0 && relationFilterRows === 0) {
            warnings.push(
              'relation filter is accepted by the server but returns no rows for a real object id — the relation arm therefore reports neighbours via the links/backlinks projection instead of filtering by id.',
            );
          }
        } catch (err) {
          warnings.push(
            `relation filter probe failed (relations may not be filterable on this build): ${(err as Error).message}`,
          );
        }

        // 3) 中文召回自检（写探针 → 搜 → 归档探针）
        //
        // **双探针设计**：同一个探针对象里放两段唯一的检索词——
        // 一段中文（`记忆探针XX`）、一段 ASCII（`zhprobe-<随机>`）。
        // 只靠中文探针无法区分两种失败：
        //   - 中文没命中、ASCII 命中 → **中文分词/索引问题**（不是索引滞后）；
        //   - 两个都没命中 → **索引滞后**（对象还没进全文索引）。
        // 实测（活体）：刚写的对象约 3~6s 后才可被全文检索命中，且偶发更久。
        let chinese: Record<string, JsonValue> = { checked: false };
        if (args.probe_chinese !== false) {
          const phrase = probePhrase();
          const marker = `zhprobe-${Math.random().toString(36).slice(2, 8)}`;
          let probeId = '';
          try {
            const created = await deps.store.createMemory(
              spaceId,
              {
                kind: 'fact',
                name: phrase,
                body: `${phrase}：Anytype 中文全文检索自检探针，勿作记忆使用。 ${marker}`,
                contentHash: `probe-${marker}`,
                status: 'draft',
              },
              false,
              exec.signal,
            );
            probeId = created.objectId;
          } catch (err) {
            warnings.push(
              `could not write the Chinese probe object: ${(err as Error).message}`,
            );
          }
          if (probeId.length > 0) {
            try {
              // 全文索引是**最终一致**的：刚写的对象可能立刻搜不到。
              // 故轮询几次，把「索引滞后」与「中文根本没被索引」区分开。
              let matched = false;
              let markerMatched = false;
              let attempts = 0;
              const startedAt = Date.now();
              for (let attempt = 1; attempt <= 8; attempt += 1) {
                attempts = attempt;
                const hit = await deps.store.search({
                  spaceId,
                  query: phrase,
                  limit: 5,
                  signal: exec.signal,
                });
                if (hit.rows.some((r) => r.id === probeId)) {
                  matched = true;
                  break;
                }
                const markerHit = await deps.store.search({
                  spaceId,
                  query: marker,
                  limit: 5,
                  signal: exec.signal,
                });
                if (markerHit.rows.some((r) => r.id === probeId)) {
                  markerMatched = true;
                  break;
                }
                await sleep(1500);
              }
              const elapsed = Date.now() - startedAt;
              const verdict = matched
                ? 'chinese_recall_ok'
                : markerMatched
                  ? 'chinese_tokenization_issue'
                  : 'index_lag_or_unindexed';
              chinese = {
                checked: true,
                probe_object_id: probeId,
                matched,
                marker_matched: markerMatched,
                verdict,
                attempts,
                latency_ms: elapsed,
                note: matched
                  ? `Anytype full-text recall matches Chinese phrases on this build (after ${attempts} attempt(s), ${elapsed}ms — the index is eventually consistent).`
                  : markerMatched
                    ? `The probe object was indexed (ASCII marker found) but the Chinese phrase was NOT matched — Chinese tokenization is unreliable on this build. Use tags, structural filters (memory_list) or the vector arm instead of Chinese keywords.`
                    : `Neither the Chinese phrase nor the ASCII marker was matched after ${attempts} attempt(s) over ${elapsed}ms — the full-text index had not caught up yet. Re-run memory_doctor after a few seconds to confirm.`,
              };
            } catch (err) {
              warnings.push(
                `Chinese recall probe failed: ${(err as Error).message}`,
              );
            } finally {
              try {
                await deps.store.deleteObject(
                  spaceId,
                  probeId,
                  false,
                  exec.signal,
                );
                chinese = { ...chinese, probe_archived: true };
              } catch (err) {
                warnings.push(
                  `could not archive the probe object ${probeId}: ${(err as Error).message} (it stays in the space; delete it in Anytype).`,
                );
              }
            }
          }
        }

        return {
          api: {
            reachable: true,
            authenticated: true,
            base_url: deps.store.client.baseUrl,
          },
          space_id: spaceId,
          visible_spaces: spaces.map((s) => ({ id: s.id, name: s.name })),
          schema: {
            types: types.map((t) => ({
              key: t.key,
              name: t.name,
              property_count: t.propertyKeys.length,
            })),
            property_count: properties.length,
            memory_type_present: memoryType !== undefined,
            memory_type_properties: memoryFields,
          },
          capabilities: {
            filter_works: filterWorks,
            relation_filter_works: relationFilterWorks,
            relation_filter_rows: relationFilterRows,
            content_hash_property_present: properties.some(
              (p) => p.key === propertyKey(keys, 'contentHash'),
            ),
          },
          chinese_recall: chinese,
          warnings: [
            ...warnings,
            'API v2 is pre-release: capabilities can change without a version bump — re-run memory_doctor after upgrading Anytype.',
          ],
        };
      },
    }),
  ];
}

/** 过滤器拼装（导出给单测复用）。 */
export const diagFilter = andFilter;
