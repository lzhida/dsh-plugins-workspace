/**
 * 宿主半区只读路由（/dsh-open-design/*）契约测试。
 *
 * 覆盖：状态字段完整性、env 脱敏、上游透传、上游失败降级（不 500）、
 * skills 服务端过滤与体积裁剪、runs 参数校验、redetect 方法约束、
 * 未知路由 404、路由注销 disposer。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type { DiagnosticReport } from './diag-tools.ts';
import {
  DEFAULT_SKILL_LIMIT,
  registerStatusRoutes,
  ROUTE_PREFIX,
  sanitizeEnv,
  SKILL_DESCRIPTION_MAX,
  trimSkills,
  type StatusRouteDeps,
  type WebRouteLike,
} from './status-routes.ts';

interface FakeResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  writeHead(status: number, headers: Record<string, string>): FakeResponse;
  end(text: string): void;
}

function createResponse(): FakeResponse {
  const response: FakeResponse = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      response.statusCode = status;
      response.headers = headers;
      return response;
    },
    end(text) {
      response.body = text;
    },
  };
  return response;
}

function createRequest(
  url: string,
  method = 'GET',
  body?: string,
): IncomingMessage {
  const req = { url, method } as Record<string, unknown>;
  if (body !== undefined) {
    const encoded = Buffer.from(body, 'utf8');
    Object.defineProperty(req, Symbol.asyncIterator, {
      value: async function* () {
        yield encoded;
      },
    });
  }
  return req as unknown as IncomingMessage;
}

/** POST 请求（带 JSON body）并返回解析后的响应。 */
async function requestWithBody(
  harness: Harness,
  url: string,
  body: unknown,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  return requestRawBody(harness, url, JSON.stringify(body));
}

/** POST 请求（body 原样发送，不做 JSON 序列化——用于非法 JSON/空体用例）。 */
async function requestRawBody(
  harness: Harness,
  url: string,
  rawBody: string,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const route = harness.routes[0];
  const response = createResponse();
  await route.handler(
    createRequest(url, 'POST', rawBody),
    response as unknown as ServerResponse,
  );
  return {
    status: response.statusCode,
    payload: JSON.parse(response.body) as Record<string, unknown>,
  };
}

function createReport(env: Record<string, string> = {}): DiagnosticReport {
  return {
    autoDetect: true,
    serverName: 'open-design',
    source: 'custom',
    command: 'E:\\Programs\\Open Design\\Open Design.exe',
    args: ['daemon-cli.mjs', 'mcp'],
    env,
    cwd: '',
    startupTimeoutMs: 120000,
    toolCallTimeoutMs: 60000,
    detectionMethod: 'pipe',
    installed: true,
    stamp: {
      channel: 'stable',
      namespace: 'release-stable-win',
      source: 'packaged',
      mode: 'runtime',
      app: 'daemon',
    },
    endpoint: '\\\\.\\pipe\\open-design-sidecar-abcdef',
    installDir: 'E:\\Programs\\Open Design',
    dataDir: 'C:\\Users\\test\\AppData\\Roaming\\Open Design\\data',
    daemonCliPath: 'E:\\Programs\\Open Design\\daemon-cli.mjs',
    connectionState: 'connected',
    failedAttempts: 0,
    maxAttempts: 10,
    lastError: null,
    upstreamToolCount: 22,
    upstreamSkippedTools: [],
    diagnosticToolCount: 2,
    configFile: 'C:\\Users\\test\\.dsh\\plugins\\dsh-open-design\\config.json',
  };
}

interface Harness {
  deps: StatusRouteDeps;
  calls: Array<{ name: string; args: Record<string, unknown> | undefined }>;
  dispose: () => void;
  routes: WebRouteLike[];
}

function createHarness(
  options: {
    report?: DiagnosticReport;
    upstream?: Record<string, unknown>;
    upstreamError?: Error;
  } = {},
): Harness {
  const calls: Array<{
    name: string;
    args: Record<string, unknown> | undefined;
  }> = [];
  const routes: WebRouteLike[] = [];
  const report = options.report ?? createReport();
  const deps: StatusRouteDeps = {
    status: () => report,
    redetect: async () => report,
    call: async (name, args) => {
      calls.push({ name, args });
      if (options.upstreamError) throw options.upstreamError;
      return options.upstream?.[name] ?? {};
    },
  };
  const dispose = registerStatusRoutes((route) => {
    routes.push(route);
    return () => {
      routes.length = 0;
    };
  }, deps);
  return { deps, calls, dispose, routes };
}

async function request(
  harness: Harness,
  url: string,
  method = 'GET',
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const route = harness.routes[0];
  const response = createResponse();
  await route.handler(
    createRequest(url, method),
    response as unknown as ServerResponse,
  );
  return {
    status: response.statusCode,
    payload: JSON.parse(response.body) as Record<string, unknown>,
  };
}

describe('dsh-open-design 宿主路由', () => {
  it('注册为 prefix 路由且前缀与客户端常量一致', () => {
    const harness = createHarness();
    expect(harness.routes).toHaveLength(1);
    expect(harness.routes[0].kind).toBe('prefix');
    expect(harness.routes[0].path).toBe(ROUTE_PREFIX);
    expect(ROUTE_PREFIX).toBe('/dsh-open-design');
  });

  it('路由注销后释放注册项', () => {
    const harness = createHarness();
    harness.dispose();
    expect(harness.routes).toHaveLength(0);
  });

  it('GET /status 返回完整状态快照且字段齐全', async () => {
    const harness = createHarness();
    const { status, payload } = await request(
      harness,
      `${ROUTE_PREFIX}/status`,
    );
    expect(status).toBe(200);
    expect(payload.serverName).toBe('open-design');
    expect(payload.connectionState).toBe('connected');
    expect(payload.upstreamToolCount).toBe(22);
    expect(payload.diagnosticToolCount).toBe(2);
    expect(payload.stamp).toMatchObject({ app: 'daemon', mode: 'runtime' });
  });

  it('GET /status 对凭据类 env 键值脱敏、路径类键保留', async () => {
    const harness = createHarness({
      report: createReport({
        OD_DATA_DIR: 'C:\\Users\\test\\AppData',
        API_KEY: 'super-secret-value',
        MY_TOKEN: 'tok-123',
        ELECTRON_RUN_AS_NODE: '1',
      }),
    });
    const { payload } = await request(harness, `${ROUTE_PREFIX}/status`);
    const env = payload.env as Record<string, string>;
    expect(env.API_KEY).toBe('<redacted>');
    expect(env.MY_TOKEN).toBe('<redacted>');
    expect(env.OD_DATA_DIR).toBe('C:\\Users\\test\\AppData');
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(JSON.stringify(payload)).not.toContain('super-secret-value');
  });

  it('GET /projects 透传上游结果且经现有连接调用', async () => {
    const harness = createHarness({
      upstream: { list_projects: { projects: [{ id: 'p1', name: 'demo' }] } },
    });
    const { status, payload } = await request(
      harness,
      `${ROUTE_PREFIX}/projects`,
    );
    expect(status).toBe(200);
    expect(payload).toEqual({ projects: [{ id: 'p1', name: 'demo' }] });
    expect(harness.calls).toEqual([{ name: 'list_projects', args: {} }]);
  });

  it('GET /focus 透传上游 get_active_context 结果', async () => {
    const harness = createHarness({
      upstream: {
        get_active_context: { active: false, hint: 'no active project' },
      },
    });
    const { status, payload } = await request(harness, `${ROUTE_PREFIX}/focus`);
    expect(status).toBe(200);
    expect(payload).toEqual({ active: false, hint: 'no active project' });
    expect(harness.calls).toEqual([{ name: 'get_active_context', args: {} }]);
  });

  it('GET /focus 上游不可用时同样降级 502', async () => {
    const harness = createHarness({
      upstreamError: new Error('MCP 连接不可用'),
    });
    const { status, payload } = await request(harness, `${ROUTE_PREFIX}/focus`);
    expect(status).toBe(502);
    expect(payload.error).toContain('MCP 连接不可用');
  });

  it('上游返回 MCP CallToolResult 时解包 structuredContent', async () => {
    const harness = createHarness({
      upstream: {
        list_projects: {
          content: [{ type: 'text', text: '{"projects":["a"]}' }],
          structuredContent: { projects: ['structured'] },
        },
      },
    });
    const { payload } = await request(harness, `${ROUTE_PREFIX}/projects`);
    expect(payload).toEqual({ projects: ['structured'] });
  });

  it('上游只有 text 块时解析 JSON 并返回业务对象', async () => {
    const harness = createHarness({
      upstream: {
        list_projects: {
          content: [
            { type: 'text', text: '{"projects":[{"id":"p1","name":"demo"}]}' },
          ],
        },
      },
    });
    const { payload } = await request(harness, `${ROUTE_PREFIX}/projects`);
    expect(payload).toEqual({ projects: [{ id: 'p1', name: 'demo' }] });
  });

  it('text 块不是 JSON 时原样返回文本', async () => {
    const harness = createHarness({
      upstream: {
        list_projects: { content: [{ type: 'text', text: 'plain text' }] },
      },
    });
    const { payload } = await request(harness, `${ROUTE_PREFIX}/projects`);
    expect(payload).toBe('plain text');
  });

  it('上游不可用时降级为 502 结构化错误而非 500', async () => {
    const harness = createHarness({
      upstreamError: new Error('MCP 连接不可用'),
    });
    const { status, payload } = await request(
      harness,
      `${ROUTE_PREFIX}/projects`,
    );
    expect(status).toBe(502);
    expect(payload.error).toContain('MCP 连接不可用');
    expect(payload.connectionState).toBe('connected');
  });

  it('GET /skills 按 q 过滤、按 limit 截断并裁剪 description', async () => {
    const long = 'x'.repeat(SKILL_DESCRIPTION_MAX + 50);
    const harness = createHarness({
      upstream: {
        list_skills: [
          { id: 'a', name: 'alpha', description: long, triggers: ['draw'] },
          { id: 'b', name: 'beta', description: 'b', triggers: ['write'] },
          { id: 'c', name: 'gamma', description: 'c', triggers: [] },
        ],
      },
    });
    const { status, payload } = await request(
      harness,
      `${ROUTE_PREFIX}/skills?q=al&limit=1`,
    );
    expect(status).toBe(200);
    expect(payload.total).toBe(3);
    expect(payload.matched).toBe(1);
    expect(payload.returned).toBe(1);
    expect(payload.truncated).toBe(false);
    const items = payload.items as Array<{ id: string; description: string }>;
    expect(items[0].id).toBe('a');
    expect(items[0].description.length).toBe(SKILL_DESCRIPTION_MAX + 1);
  });

  it('GET /skills 兼容 {skills:[...]} 上游形状并按默认 limit 截断', () => {
    const many = Array.from(
      { length: DEFAULT_SKILL_LIMIT + 10 },
      (_, index) => ({
        id: `s${index}`,
        name: `skill-${index}`,
        description: 'd',
        triggers: [],
      }),
    );
    const result = trimSkills({ skills: many }, '', DEFAULT_SKILL_LIMIT);
    expect(result.total).toBe(DEFAULT_SKILL_LIMIT + 10);
    expect(result.returned).toBe(DEFAULT_SKILL_LIMIT);
    expect(result.truncated).toBe(true);
  });

  it('GET /skills 命中 triggers 关键词', () => {
    const result = trimSkills(
      [{ id: 'x', name: 'n', description: 'd', triggers: ['poster'] }],
      'poster',
      10,
    );
    expect(result.matched).toBe(1);
  });

  it('GET /runs 缺 runId 返回 400', async () => {
    const harness = createHarness();
    const { status, payload } = await request(harness, `${ROUTE_PREFIX}/runs`);
    expect(status).toBe(400);
    expect(payload.error).toContain('runId');
  });

  it('GET /runs?runId= 透传单次运行', async () => {
    const harness = createHarness({
      upstream: { get_run: { id: 'r1', state: 'done' } },
    });
    const { status, payload } = await request(
      harness,
      `${ROUTE_PREFIX}/runs?runId=r1`,
    );
    expect(status).toBe(200);
    expect(payload).toEqual({ id: 'r1', state: 'done' });
    expect(harness.calls[0]).toEqual({
      name: 'get_run',
      args: { runId: 'r1' },
    });
  });

  it('POST /redetect 触发重探测并返回快照，GET 拒绝', async () => {
    const harness = createHarness();
    const ok = await request(harness, `${ROUTE_PREFIX}/redetect`, 'POST');
    expect(ok.status).toBe(200);
    expect(ok.payload.connectionState).toBe('connected');
    const rejected = await request(harness, `${ROUTE_PREFIX}/redetect`, 'GET');
    expect(rejected.status).toBe(405);
  });

  it('未知路由返回 404', async () => {
    const harness = createHarness();
    const { status, payload } = await request(harness, `${ROUTE_PREFIX}/nope`);
    expect(status).toBe(404);
    expect(payload.error).toContain('未知路由');
  });

  it('客户端与服务端路由前缀常量保持一致', async () => {
    const clientConstants = await readFile(
      new URL('../client/src/constants.ts', import.meta.url),
      'utf8',
    );
    expect(clientConstants).toContain(`ROUTE_PREFIX = '${ROUTE_PREFIX}'`);
  });

  it('sanitizeEnv 只打码凭据类键名', () => {
    expect(sanitizeEnv({ API_KEY: 'k', OD_DATA_DIR: 'd' })).toEqual({
      API_KEY: '<redacted>',
      OD_DATA_DIR: 'd',
    });
  });

  describe('运行监视路由（系列 4/6）', () => {
    it('POST /runs 发起生成：生成 requestId 并透传 prompt/project/skill/agent/plugin', async () => {
      const harness = createHarness({
        upstream: { start_run: { runId: 'run-1', status: 'queued' } },
      });
      const { status, payload } = await requestWithBody(
        harness,
        `${ROUTE_PREFIX}/runs`,
        {
          prompt: '  做一张落地页  ',
          project: 'demo',
          skill: 'skill-1',
          agent: 'agent-1',
          plugin: '  brand-kit  ',
        },
      );
      expect(status).toBe(200);
      expect(payload.runId).toBe('run-1');
      expect(harness.calls).toHaveLength(1);
      const call = harness.calls[0];
      expect(call.name).toBe('start_run');
      expect(call.args?.prompt).toBe('做一张落地页');
      expect(call.args?.project).toBe('demo');
      expect(call.args?.skill).toBe('skill-1');
      expect(call.args?.agent).toBe('agent-1');
      expect(call.args?.plugin).toBe('brand-kit');
      // requestId 由本层生成（UUID），非空且稳定透传。
      expect(typeof call.args?.requestId).toBe('string');
      expect(String(call.args?.requestId)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('POST /runs 的 plugin 为空白串时不透传该字段', async () => {
      const harness = createHarness({
        upstream: { start_run: { runId: 'run-2', status: 'queued' } },
      });
      const { status } = await requestWithBody(
        harness,
        `${ROUTE_PREFIX}/runs`,
        {
          prompt: 'x',
          plugin: '   ',
        },
      );
      expect(status).toBe(200);
      expect(harness.calls[0].args).not.toHaveProperty('plugin');
    });

    it('POST /runs prompt 为空时 400 且不调上游', async () => {
      const harness = createHarness();
      const { status, payload } = await requestWithBody(
        harness,
        `${ROUTE_PREFIX}/runs`,
        {
          prompt: '   ',
        },
      );
      expect(status).toBe(400);
      expect(payload.error).toContain('prompt');
      expect(harness.calls).toHaveLength(0);
    });

    it('POST /runs 上游失败时降级 502 并带连接状态', async () => {
      const harness = createHarness({
        upstreamError: new Error('daemon 未运行'),
      });
      const { status, payload } = await requestWithBody(
        harness,
        `${ROUTE_PREFIX}/runs`,
        {
          prompt: 'x',
        },
      );
      expect(status).toBe(502);
      expect(payload.error).toContain('daemon 未运行');
      expect(payload.connectionState).toBe('connected');
    });

    it('POST /runs 请求体超过大小上限时 400 且不调上游', async () => {
      const harness = createHarness({
        upstream: { start_run: { runId: 'run-x' } },
      });
      const { status, payload } = await requestWithBody(
        harness,
        `${ROUTE_PREFIX}/runs`,
        { prompt: 'x'.repeat(64 * 1024) },
      );
      expect(status).toBe(400);
      expect(payload.error).toContain('请求体');
      expect(harness.calls).toHaveLength(0);
    });

    it('POST /runs 请求体不是合法 JSON 时 400 且不调上游', async () => {
      const harness = createHarness();
      const { status, payload } = await requestRawBody(
        harness,
        `${ROUTE_PREFIX}/runs`,
        '{not-json',
      );
      expect(status).toBe(400);
      expect(payload.error).toContain('JSON');
      expect(harness.calls).toHaveLength(0);
    });

    it('POST /runs 空 body 直接 400（视为非法请求体）', async () => {
      const harness = createHarness();
      const { status, payload } = await requestRawBody(
        harness,
        `${ROUTE_PREFIX}/runs`,
        '',
      );
      expect(status).toBe(400);
      expect(payload.error).toContain('JSON');
      expect(harness.calls).toHaveLength(0);
    });

    it('POST /runs/cancel 转发 cancel_run 并要求 runId', async () => {
      const harness = createHarness({
        upstream: { cancel_run: { runId: 'run-1', cancelRequested: true } },
      });
      const ok = await requestWithBody(harness, `${ROUTE_PREFIX}/runs/cancel`, {
        runId: 'run-1',
      });
      expect(ok.status).toBe(200);
      expect(ok.payload.cancelRequested).toBe(true);
      expect(harness.calls[0].name).toBe('cancel_run');
      expect(harness.calls[0].args?.runId).toBe('run-1');

      const missing = await requestWithBody(
        harness,
        `${ROUTE_PREFIX}/runs/cancel`,
        {},
      );
      expect(missing.status).toBe(400);
      expect(missing.payload.error).toContain('runId');
    });

    it('GET /agents 透传 list_agents 结果', async () => {
      const harness = createHarness({
        upstream: {
          list_agents: { agents: [{ id: 'a1', name: 'Codex' }] },
        },
      });
      const { status, payload } = await request(
        harness,
        `${ROUTE_PREFIX}/agents`,
      );
      expect(status).toBe(200);
      expect(harness.calls[0].name).toBe('list_agents');
      expect((payload.agents as unknown[]).length).toBe(1);
    });
  });

  describe('目录浏览路由（系列 5/6）', () => {
    const manySkills = Array.from({ length: 7 }, (_, i) => ({
      id: `skill-${i}`,
      name: `技能 ${i}`,
      description: `第 ${i} 条描述`,
      triggers: [`t${i}`],
    }));

    it('GET /skills 支持 offset 分页并返回 nextOffset', async () => {
      const harness = createHarness({
        upstream: { list_skills: { skills: manySkills } },
      });
      const page1 = await request(
        harness,
        `${ROUTE_PREFIX}/skills?limit=3&offset=0`,
      );
      expect(page1.status).toBe(200);
      expect(page1.payload.returned).toBe(3);
      expect(page1.payload.nextOffset).toBe(3);
      expect(page1.payload.truncated).toBe(true);
      const page2 = await request(
        harness,
        `${ROUTE_PREFIX}/skills?limit=3&offset=3`,
      );
      expect(page2.payload.returned).toBe(3);
      expect(page2.payload.nextOffset).toBe(6);
      const page3 = await request(
        harness,
        `${ROUTE_PREFIX}/skills?limit=3&offset=6`,
      );
      expect(page3.payload.returned).toBe(1);
      expect(page3.payload.nextOffset).toBe(null);
      expect(page3.payload.truncated).toBe(false);
    });

    it('GET /skills 的 offset 与 q 组合时在匹配集内分页', async () => {
      const harness = createHarness({
        upstream: { list_skills: { skills: manySkills } },
      });
      const page = await request(
        harness,
        `${ROUTE_PREFIX}/skills?q=技能&limit=2&offset=2`,
      );
      expect(page.payload.matched).toBe(7);
      expect(page.payload.returned).toBe(2);
      expect((page.payload.items as unknown[])[0]).toMatchObject({
        id: 'skill-2',
      });
    });

    it('GET /plugins 调用 list_plugins 并裁剪返回', async () => {
      const harness = createHarness({
        upstream: {
          list_plugins: {
            plugins: [
              { id: 'p1', name: 'motion-design' },
              { id: 'p2', name: 'brand-kit' },
              { id: 'p3', name: 'layout-pro' },
            ],
          },
        },
      });
      const { status, payload } = await request(
        harness,
        `${ROUTE_PREFIX}/plugins?limit=2`,
      );
      expect(status).toBe(200);
      expect(harness.calls[0].name).toBe('list_plugins');
      expect(payload.total).toBe(3);
      expect(payload.returned).toBe(2);
      expect(payload.truncated).toBe(true);
      expect((payload.items as Array<Record<string, unknown>>)[0]).toEqual({
        id: 'p1',
        name: 'motion-design',
      });
    });

    it('GET /plugins 兼容裸数组形状', async () => {
      const harness = createHarness({
        upstream: { list_plugins: [{ id: 'solo' }] },
      });
      const { payload } = await request(harness, `${ROUTE_PREFIX}/plugins`);
      expect(payload.total).toBe(1);
      expect(payload.returned).toBe(1);
    });

    it('GET /plugins 兼容 {items:[...]} 形状且丢弃非对象脏条目', async () => {
      const harness = createHarness({
        upstream: {
          list_plugins: {
            items: [{ id: 'p1' }, 'oops', null, 42, { id: 'p2' }],
          },
        },
      });
      const { status, payload } = await request(
        harness,
        `${ROUTE_PREFIX}/plugins`,
      );
      expect(status).toBe(200);
      expect(payload.total).toBe(2);
      expect(payload.returned).toBe(2);
      expect(payload.truncated).toBe(false);
      expect(payload.items).toEqual([{ id: 'p1' }, { id: 'p2' }]);
    });

    it('GET /plugins 上游不可用时降级 502', async () => {
      const harness = createHarness({
        upstreamError: new Error('连接已断开'),
      });
      const { status, payload } = await request(
        harness,
        `${ROUTE_PREFIX}/plugins`,
      );
      expect(status).toBe(502);
      expect(payload.connectionState).toBe('connected');
    });
  });
});
