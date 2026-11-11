/**
 * per-tool 请求预算（批二 2/4）测试：解析矩阵、目录声明锁定、桥第三参透传、
 * 客户端覆盖真服务器验证（覆盖>配置 / 覆盖<延时超时 / 无覆盖默认 30s 回归）。
 */
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import { VictauriClient, DEFAULT_TIMEOUT_MS } from '../../client.ts';
import { VictauriTimeoutError } from '../../errors.ts';
import { REST_TOOL_SPECS } from './catalog.ts';
import { COMPOUND_TOOL_SPECS } from '../compound/catalog.ts';
import { createRestBridgeTool } from './bridge.ts';
import {
  TOOL_BUDGET_MAX_MS,
  WAIT_FOR_BUDGET_MARGIN_MS,
  resolveRequestBudgetMs,
} from './timeout.ts';

/** 记录第三次参(budget)的 mock client。 */
function mockClient(): {
  client: VictauriClient;
  calls: Array<{
    name: string;
    args: Record<string, unknown>;
    budget: number | undefined;
  }>;
} {
  const calls: Array<{
    name: string;
    args: Record<string, unknown>;
    budget: number | undefined;
  }> = [];
  const client = {
    callTool: async (
      name: string,
      args: Record<string, unknown>,
      budget: number | undefined,
    ) => {
      calls.push({ name, args, budget });
      return { ok: true };
    },
  } as unknown as VictauriClient;
  return { client, calls };
}

/** 按名取 spec(standalone 与 compound 双表)。 */
const specOf = (name: string) =>
  (REST_TOOL_SPECS as typeof COMPOUND_TOOL_SPECS)
    .concat(COMPOUND_TOOL_SPECS)
    .find((spec) => spec.name === name)!;

describe('resolveRequestBudgetMs 解析矩阵', () => {
  it('常量口径:上限 120s、wait_for 余量 5s', () => {
    expect(TOOL_BUDGET_MAX_MS).toBe(120_000);
    expect(WAIT_FOR_BUDGET_MARGIN_MS).toBe(5_000);
  });

  it('wait_for 动态预算 = timeout_ms + 5s 余量', () => {
    expect(resolveRequestBudgetMs('wait_for', { timeout_ms: 10_000 })).toBe(
      15_000,
    );
  });

  it('wait_for 超上限夹到 TOOL_BUDGET_MAX_MS', () => {
    expect(resolveRequestBudgetMs('wait_for', { timeout_ms: 500_000 })).toBe(
      120_000,
    );
  });

  it('wait_for 无/非法 timeout_ms 时忽略,落到声明或 undefined', () => {
    expect(resolveRequestBudgetMs('wait_for', {})).toBeUndefined();
    expect(
      resolveRequestBudgetMs('wait_for', { timeout_ms: -5 }),
    ).toBeUndefined();
    expect(
      resolveRequestBudgetMs('wait_for', { timeout_ms: '10s' as never }),
    ).toBeUndefined();
  });

  it('spec 声明预算生效并夹上限;非法声明忽略', () => {
    expect(resolveRequestBudgetMs('trace', {}, 90_000)).toBe(90_000);
    expect(resolveRequestBudgetMs('trace', {}, 500_000)).toBe(120_000);
    expect(resolveRequestBudgetMs('trace', {}, 0)).toBeUndefined();
    expect(resolveRequestBudgetMs('trace', {}, Number.NaN)).toBeUndefined();
  });

  it('未声明工具无覆盖:undefined(沿用客户端配置/默认链)', () => {
    expect(resolveRequestBudgetMs('find_elements', {})).toBeUndefined();
    expect(resolveRequestBudgetMs('app_info', {})).toBeUndefined();
  });

  it('T-3 锁定:invoke_command.timeout_ms 不改变本通道预算(与 wait_for 对照)', () => {
    // invoke_command 的 timeout_ms 是服务端整次调用预算(0.9.0+),透传给服务端;
    // 本通道 REST 预算与之脱钩——resolveRequestBudgetMs 不读 invoke_command 的 timeout_ms
    expect(
      resolveRequestBudgetMs('invoke_command', { timeout_ms: 120_000 }),
    ).toBeUndefined();
    // 对照:wait_for 的同名参数会动态换算为本通道预算(timeout_ms+5s 夹 120s 上限)
    expect(resolveRequestBudgetMs('wait_for', { timeout_ms: 120_000 })).toBe(
      120_000,
    );
  });

  it('优先级锁定:wait_for 动态预算 > spec 声明', () => {
    expect(
      resolveRequestBudgetMs('wait_for', { timeout_ms: 10_000 }, 90_000),
    ).toBe(15_000);
  });
});

describe('目录声明锁定(DoD: 显式预算 + 未声明保持默认)', () => {
  it('trace 与 introspect 声明 90s 预算;eval_js 声明 45s 预算(M-5)', () => {
    expect(specOf('trace').requestBudgetMs).toBe(90_000);
    expect(specOf('introspect').requestBudgetMs).toBe(90_000);
    // M-5(批十三 2/2):上游 eval_js 无 per-call 超时参数(0.10.3 webview_params.rs:7-13),
    // 超时是 app 级配置(默认 30s,可配至 300s);45s 预算给默认档留余量,
    // 不追 300s 上限(TOOL_BUDGET_MAX_MS=120s 也夹不住 300s 的追平意图)。
    expect(specOf('eval_js').requestBudgetMs).toBe(45_000);
    // M-5 解析矩阵:eval_js 走 spec 声明档(无动态参数参与)
    expect(resolveRequestBudgetMs('eval_js', {}, 45_000)).toBe(45_000);
    expect(resolveRequestBudgetMs('eval_js', { code: '1' })).toBeUndefined();
  });

  it('wait_for 不做静态声明(纯动态);全部声明值 ≤ 上限', () => {
    expect(specOf('wait_for').requestBudgetMs).toBeUndefined();
    const all = REST_TOOL_SPECS.concat(COMPOUND_TOOL_SPECS);
    for (const spec of all) {
      const declared = spec.requestBudgetMs;
      if (declared !== undefined) {
        expect(
          declared,
          `${spec.name}.requestBudgetMs 超上限`,
        ).toBeLessThanOrEqual(TOOL_BUDGET_MAX_MS);
      }
    }
    // 声明者口径:仅 eval_js(M-5)/trace/introspect(漂移即本断言失败,提醒更新文档)
    const declarers = all
      .filter((spec) => spec.requestBudgetMs !== undefined)
      .map((spec) => spec.name)
      .sort();
    expect(declarers).toEqual(['eval_js', 'introspect', 'trace']);
  });
});

describe('桥集成:预算作为 callTool 第三参透传', () => {
  it('wait_for 按 timeout_ms 动态解析第三参', async () => {
    const { client, calls } = mockClient();
    const tool = createRestBridgeTool(specOf('wait_for'), {
      getClient: async () => client,
    });
    await tool.execute(
      { condition: 'text', value: 'ok', timeout_ms: 10_000 },
      {} as never,
    );
    expect(calls[0]?.name).toBe('wait_for');
    expect(calls[0]?.budget).toBe(15_000);
  });

  it('trace 用 spec 声明预算;未声明工具第三参为 undefined', async () => {
    const { client, calls } = mockClient();
    const trace = createRestBridgeTool(specOf('trace'), {
      getClient: async () => client,
    });
    await trace.execute({ action: 'frames' }, {} as never);
    expect(calls[0]?.budget).toBe(90_000);

    const appInfo = createRestBridgeTool(specOf('app_info'), {
      getClient: async () => client,
    });
    await appInfo.execute({}, {} as never);
    expect(calls[1]?.name).toBe('app_info');
    expect(calls[1]?.budget).toBeUndefined();
  });

  it('eval_js 用 spec 声明预算 45s(第三参集成,M-5/V2 低-9)', async () => {
    const { client, calls } = mockClient();
    const evalTool = createRestBridgeTool(specOf('eval_js'), {
      getClient: async () => client,
    });
    await evalTool.execute({ code: '1' }, {} as never);
    expect(calls[0]?.name).toBe('eval_js');
    expect(calls[0]?.budget).toBe(45_000);
  });
});

describe('client 超时覆盖(真 HTTP mock server)', () => {
  /** 可编程 mock victauri 服务(同 client.test.ts 口径)。 */
  async function startServer(delayMs: number): Promise<{
    server: Server;
    url: string;
  }> {
    const server = createServer(
      (_req: IncomingMessage, res: ServerResponse) => {
        void Promise.resolve().then(async () => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"result":1}');
        });
      },
    );
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const addr = server.address() as AddressInfo;
    return { server, url: `http://127.0.0.1:${String(addr.port)}` };
  }

  it('覆盖优先于构造配置:timeoutMs=80 但 override=1000 时 400ms 响应成功', async () => {
    const { server, url } = await startServer(400);
    const client = new VictauriClient({
      baseUrl: url,
      token: 'tok',
      timeoutMs: 80,
    });
    const value = await client.callTool('slow', {}, 1_000);
    expect(value).toBe(1);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('覆盖小于响应延时:抛 VictauriTimeoutError 且携带生效预算', async () => {
    const { server, url } = await startServer(400);
    const client = new VictauriClient({ baseUrl: url, token: 'tok' });
    try {
      await client.callTool('slow', {}, 80);
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(VictauriTimeoutError);
      expect((err as VictauriTimeoutError).kind).toBe('timeout');
      expect((err as VictauriTimeoutError).timeoutMs).toBe(80);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('无覆盖回归:默认 30s 预算兜底(400ms 响应不被掐断)', async () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
    const { server, url } = await startServer(400);
    const client = new VictauriClient({ baseUrl: url, token: 'tok' });
    const value = await client.callTool('fast');
    expect(value).toBe(1);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
