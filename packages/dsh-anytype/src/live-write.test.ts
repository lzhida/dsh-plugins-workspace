/**
 * 活体写路径冒烟测试（真实 Anytype 桌面端 API）。
 *
 * **默认跳过**——需要真实 API key 与在线的 Anytype 桌面端：
 * ```sh
 * ANYTYPE_LIVE_KEY=<key> ANYTYPE_LIVE_SPACE=<space_id> \
 *   pnpm exec vitest run packages/dsh-anytype/src/live-write.test.ts
 * ```
 * 未设 `ANYTYPE_LIVE_KEY` 时整文件跳过（`describe.skipIf`），故 CI 与
 * `pnpm test` 全量跑不会因缺 key 而红。
 *
 * 覆盖「写路径安全」的两条核心契约（全部用 dry_run 预演，零副作用）：
 * 1. `dry_run=true` 预演返回 200 且响应带 `dry_run: true`，且**不落库**；
 * 2. `Idempotency-Key` 按「key + 请求体」绑定——同 key 同 body 重放已存
 *    响应，同 key 换 body 返 409 `idempotency_conflict`。
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

/** 读某资源的总数（用于断言「零副作用」）。 */
async function totalOf(client: AnytypeClient, path: string): Promise<number> {
  const res = await client.request('GET', path, {
    query: { limit: 100 },
    signal: stubExec().signal,
  });
  return (res.data as { total: number }).total;
}

describe.skipIf(!LIVE_KEY || !LIVE_SPACE)(
  'dsh-anytype 活体写路径（dry_run / Idempotency-Key）',
  () => {
    it('dry_run 预演返回 200 + dry_run 标记，且不落库', async () => {
      const { client, tools } = liveDeps();
      const before = await totalOf(client, `/v2/spaces/${LIVE_SPACE}/objects`);

      const value = (await tools.get('anytype_create_object')!.execute(
        {
          space_id: LIVE_SPACE,
          type: 'page',
          name: `live-dryrun-${Date.now()}`,
          dry_run: true,
        },
        stubExec(),
      )) as { status: number; data: Record<string, unknown> };

      expect(value.status).toBe(200);
      expect(value.data.dry_run).toBe(true);
      expect(await totalOf(client, `/v2/spaces/${LIVE_SPACE}/objects`)).toBe(
        before,
      );
    });

    it('Idempotency-Key：同 key 同 body 重放、换 body 409 idempotency_conflict', async () => {
      const { client, tools } = liveDeps();
      const before = await totalOf(client, `/v2/spaces/${LIVE_SPACE}/objects`);
      const key = `live-idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const args = {
        space_id: LIVE_SPACE,
        type: 'page',
        name: `live-idem-${Date.now()}`,
        dry_run: true,
        idempotency_key: key,
      };

      const first = (await tools
        .get('anytype_create_object')!
        .execute(args, stubExec())) as {
        status: number;
        data: Record<string, unknown>;
      };
      const replay = (await tools
        .get('anytype_create_object')!
        .execute(args, stubExec())) as {
        status: number;
        data: Record<string, unknown>;
      };
      expect(first.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(replay.data).toEqual(first.data);

      let conflict: { status: number; body: { code?: string } } | null = null;
      try {
        await tools
          .get('anytype_create_object')!
          .execute({ ...args, name: `${args.name}-different` }, stubExec());
      } catch (err) {
        conflict = err as { status: number; body: { code?: string } };
      }
      expect(conflict?.status).toBe(409);
      expect(conflict?.body?.code).toBe('idempotency_conflict');

      expect(await totalOf(client, `/v2/spaces/${LIVE_SPACE}/objects`)).toBe(
        before,
      );
    });
  },
);
