/**
 * 运行时契约测试：探测 → 合并配置 → 持久化 → 连接 → 工具桥接。
 *
 * 全部用假实现替换真实探测（PowerShell）与真实 MCP 连接（子进程），
 * 保证单测不碰宿主环境。
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult, Tool } from '@modelcontextprotocol/client';

import type { ConnectionOptions, McpConnection } from './connection.ts';
import type { DetectedEnvironment } from './config.ts';
import { OpenDesignRuntime } from './runtime.ts';

const DETECTED: DetectedEnvironment = {
  method: 'pipe',
  stamp: {
    channel: 'stable',
    namespace: 'release-stable-win',
    source: 'packaged',
    mode: 'runtime',
    app: 'daemon',
  },
  endpoint: '\\\\.\\pipe\\open-design-sidecar-6eec4ea0e7395b977771b1af7124c1b9',
  installDir: 'E:\\Programs\\Open Design',
  dataDir:
    'C:\\Users\\tester\\AppData\\Roaming\\Open Design\\namespaces\\release-stable-win\\data',
  daemonCliPath:
    'E:\\Programs\\Open Design\\resources\\app\\prebundled\\daemon\\daemon-cli.mjs',
};

interface StubCtx {
  ctx: Context;
  tools: ToolDefinition[];
}

/** 最小 cordis 上下文假体：effect 立即执行，工具注册进数组。 */
function stubCtx(): StubCtx {
  const tools: ToolDefinition[] = [];
  const ctx = {
    effect: (fn: () => (() => void) | void) => {
      fn();
    },
    tools: {
      register: (tool: ToolDefinition) => {
        tools.push(tool);
        return () => {};
      },
    },
  } as unknown as Context;
  return { ctx, tools };
}

/** 假 MCP 连接：记录调用、返回固定工具清单。 */
function fakeConnection(
  tools: Array<{ name: string; description?: string }> = [],
): McpConnection & { closed: boolean } {
  const connection = {
    closed: false,
    listTools: vi.fn(async (): Promise<Tool[]> =>
      tools.map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined
          ? {}
          : { description: tool.description }),
        inputSchema: { type: 'object' as const, properties: {} },
      })),
    ),
    callTool: vi.fn(async (name: string): Promise<CallToolResult> => ({
      content: [{ type: 'text' as const, text: `called ${name}` }],
    })),
    close: vi.fn(async () => {
      connection.closed = true;
    }),
    reconfigure: vi.fn(async () => {}),
    status: {
      state: 'connected' as const,
      failedAttempts: 0,
      maxAttempts: 10,
    },
  };
  return connection;
}

async function tempConfigDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dsh-open-design-'));
}

describe('dsh-open-design 运行时', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('启动时探测一次，并把连接参数写进插件配置文件', async () => {
    const configDir = await tempConfigDir();
    const detect = vi.fn(async () => DETECTED);
    const connection = fakeConnection();
    const { ctx } = stubCtx();
    const runtime = new OpenDesignRuntime(
      ctx,
      {},
      {
        detect,
        connect: async () => connection,
        configDir,
      },
    );

    await runtime.start();

    expect(detect).toHaveBeenCalledTimes(1);
    const document = JSON.parse(
      await readFile(join(configDir, 'config.json'), 'utf8'),
    ) as {
      schemaVersion: number;
      connection: {
        command: string;
        args: string[];
        env: Record<string, string>;
      };
    };
    expect(document.schemaVersion).toBe(1);
    expect(document.connection.command).toBe(
      'E:\\Programs\\Open Design\\Open Design.exe',
    );
    expect(document.connection.args).toEqual([DETECTED.daemonCliPath, 'mcp']);
    expect(document.connection.env.OD_SIDECAR_CLIENT_ENDPOINT).toBe(
      DETECTED.endpoint,
    );
    expect(document.connection.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('autoDetect=false 时不探测，直接采用手填的连接参数', async () => {
    const configDir = await tempConfigDir();
    const detect = vi.fn(async () => DETECTED);
    const open = vi.fn<(options: ConnectionOptions) => Promise<McpConnection>>(
      async () => fakeConnection(),
    );
    const { ctx } = stubCtx();
    const runtime = new OpenDesignRuntime(
      ctx,
      {
        autoDetect: false,
        command: 'C:\\custom\\od.exe',
        args: ['mcp'],
        env: { OD_DATA_DIR: 'D:\\data' },
      },
      { detect, connect: open, configDir },
    );

    await runtime.start();

    expect(detect).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toMatchObject({
      command: 'C:\\custom\\od.exe',
      args: ['mcp'],
      env: { OD_DATA_DIR: 'D:\\data' },
    });
  });

  it('配置卡的显式值覆盖探测结果', async () => {
    const configDir = await tempConfigDir();
    const open = vi.fn<(options: ConnectionOptions) => Promise<McpConnection>>(
      async () => fakeConnection(),
    );
    const { ctx } = stubCtx();
    const runtime = new OpenDesignRuntime(
      ctx,
      { command: 'C:\\custom\\od.exe' },
      { detect: async () => DETECTED, connect: open, configDir },
    );

    await runtime.start();

    expect(open.mock.calls[0][0].command).toBe('C:\\custom\\od.exe');
  });

  it('上游工具被注册成 mcp__<server>__<tool> 命名空间工具', async () => {
    const configDir = await tempConfigDir();
    const { ctx, tools } = stubCtx();
    const runtime = new OpenDesignRuntime(
      ctx,
      {},
      {
        detect: async () => DETECTED,
        connect: async () =>
          fakeConnection([
            { name: 'list_projects', description: '列出项目' },
            { name: 'get_file' },
          ]),
        configDir,
      },
    );

    await runtime.start();

    const names = tools.map((tool) => tool.name);
    expect(names).toContain('mcp__open-design__list_projects');
    expect(names).toContain('mcp__open-design__get_file');
  });

  it('redetect 重新探测并刷新工具清单', async () => {
    const configDir = await tempConfigDir();
    const detect = vi.fn(async () => DETECTED);
    const connection = fakeConnection([{ name: 'list_projects' }]);
    const { ctx } = stubCtx();
    const runtime = new OpenDesignRuntime(
      ctx,
      {},
      {
        detect,
        connect: async () => connection,
        configDir,
      },
    );

    await runtime.start();
    const report = await runtime.redetect();

    expect(detect).toHaveBeenCalledTimes(2);
    expect(report.detectionMethod).toBe('pipe');
    expect(report.upstreamToolCount).toBe(1);
  });

  it('status 汇报生效配置、探测结果与连接状态', async () => {
    const configDir = await tempConfigDir();
    const { ctx } = stubCtx();
    const runtime = new OpenDesignRuntime(
      ctx,
      {},
      {
        detect: async () => DETECTED,
        connect: async () => fakeConnection([{ name: 'list_projects' }]),
        configDir,
      },
    );

    await runtime.start();
    const report = runtime.status();

    expect(report.command).toBe('E:\\Programs\\Open Design\\Open Design.exe');
    expect(report.endpoint).toBe(DETECTED.endpoint);
    expect(report.installed).toBe(true);
    expect(report.connectionState).toBe('connected');
    expect(report.upstreamToolCount).toBe(1);
    expect(report.diagnosticToolCount).toBe(2);
    expect(report.configFile).toBe(join(configDir, 'config.json'));
  });

  it('探测失败时降级为 method=none，不抛错也不连接', async () => {
    const configDir = await tempConfigDir();
    const open = vi.fn<(options: ConnectionOptions) => Promise<McpConnection>>(
      async () => fakeConnection(),
    );
    const { ctx } = stubCtx();
    const runtime = new OpenDesignRuntime(
      ctx,
      {},
      {
        detect: async () => ({
          method: 'none' as const,
          stamp: null,
          endpoint: '',
          installDir: '',
          dataDir: '',
          daemonCliPath: '',
        }),
        connect: open,
        configDir,
      },
    );

    await runtime.start();

    expect(open).not.toHaveBeenCalled();
    expect(runtime.status().detectionMethod).toBe('none');
    expect(runtime.status().installed).toBe(false);
  });

  it('dispose 关闭连接并注销上游工具', async () => {
    const configDir = await tempConfigDir();
    const connection = fakeConnection([{ name: 'list_projects' }]);
    const { ctx, tools } = stubCtx();
    const runtime = new OpenDesignRuntime(
      ctx,
      {},
      {
        detect: async () => DETECTED,
        connect: async () => connection,
        configDir,
      },
    );

    await runtime.start();
    await runtime.dispose();

    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(runtime.status().connectionState).toBe('closed');
    // dispose 之后，已注册的上游工具调用应明确报「连接不可用」。
    const bridged = tools.find(
      (tool) => tool.name === 'mcp__open-design__list_projects',
    );
    expect(bridged).toBeDefined();
    await expect(bridged?.execute({}, {} as never)).rejects.toThrow(
      'MCP 连接不可用',
    );
  });

  it('配置卡改动经懒刷新在下次工具调用前生效', async () => {
    const configDir = await tempConfigDir();
    const connection = fakeConnection([{ name: 'list_projects' }]);
    const card: Record<string, unknown> = {};
    const { ctx, tools } = stubCtx();
    const runtime = new OpenDesignRuntime(ctx, card, {
      detect: async () => DETECTED,
      connect: async () => connection,
      configDir,
    });

    await runtime.start();
    expect(connection.reconfigure).not.toHaveBeenCalled();

    // 模拟宿主对 volatile 配置卡的原地更新：改 command 与超时。
    card.command = 'C:\\custom\\od.exe';
    card.toolCallTimeoutMs = 5000;

    // 触发一次上游调用以驱动懒刷新。
    const bridged = tools.find(
      (tool) => tool.name === 'mcp__open-design__list_projects',
    );
    expect(bridged).toBeDefined();
    await bridged?.execute({}, {} as never);

    expect(connection.reconfigure).toHaveBeenCalledTimes(1);
    expect(vi.mocked(connection.reconfigure).mock.calls[0][0]).toMatchObject({
      command: 'C:\\custom\\od.exe',
      toolCallTimeoutMs: 5000,
    });
    // 生效配置已落盘（overrides 记录了显式覆盖）。
    const document = JSON.parse(
      await readFile(join(configDir, 'config.json'), 'utf8'),
    ) as { overrides: { command?: string } };
    expect(document.overrides.command).toBe('C:\\custom\\od.exe');
  });

  it('跨会话：新会话把卡改回默认值时清除上一会话的覆盖意图', async () => {
    const configDir = await tempConfigDir();
    const { ctx } = stubCtx();
    // 会话 A：显式 command=X → overrides 与基线一并落盘。
    const sessionA = new OpenDesignRuntime(
      ctx,
      { command: 'C:\\custom\\od.exe' },
      {
        detect: async () => DETECTED,
        connect: async () => fakeConnection([{ name: 'list_projects' }]),
        configDir,
      },
    );
    await sessionA.start();
    const afterA = JSON.parse(
      await readFile(join(configDir, 'config.json'), 'utf8'),
    ) as { overrides: { command?: string }; baseline: { command?: string } };
    expect(afterA.overrides.command).toBe('C:\\custom\\od.exe');
    expect(afterA.baseline.command).toBe('C:\\custom\\od.exe');
    await sessionA.dispose();

    // 会话 B：volatile 配置卡重置为默认（{}）→ 覆盖意图应被清除并回落探测值。
    const openB = vi.fn<(options: ConnectionOptions) => Promise<McpConnection>>(
      async () => fakeConnection([{ name: 'list_projects' }]),
    );
    const sessionB = new OpenDesignRuntime(
      ctx,
      {},
      { detect: async () => DETECTED, connect: openB, configDir },
    );
    await sessionB.start();

    expect(openB.mock.calls[0]?.[0]?.command).toBe(
      'E:\\Programs\\Open Design\\Open Design.exe',
    );
    const afterB = JSON.parse(
      await readFile(join(configDir, 'config.json'), 'utf8'),
    ) as { overrides: { command?: string } };
    expect(afterB.overrides.command).toBeUndefined();
    await sessionB.dispose();
  });

  it('跨会话：卡面与持久化基线一致时保留覆盖意图', async () => {
    const configDir = await tempConfigDir();
    const { ctx } = stubCtx();
    // 会话 A：显式 command=X。
    const sessionA = new OpenDesignRuntime(
      ctx,
      { command: 'C:\\custom\\od.exe' },
      {
        detect: async () => DETECTED,
        connect: async () => fakeConnection([{ name: 'list_projects' }]),
        configDir,
      },
    );
    await sessionA.start();
    await sessionA.dispose();

    // 会话 B：卡面仍是同一个显式值 → 意图保留，连接参数不变。
    const openB = vi.fn<(options: ConnectionOptions) => Promise<McpConnection>>(
      async () => fakeConnection([{ name: 'list_projects' }]),
    );
    const sessionB = new OpenDesignRuntime(
      ctx,
      { command: 'C:\\custom\\od.exe' },
      { detect: async () => DETECTED, connect: openB, configDir },
    );
    await sessionB.start();

    expect(openB.mock.calls[0]?.[0]?.command).toBe('C:\\custom\\od.exe');
    const afterB = JSON.parse(
      await readFile(join(configDir, 'config.json'), 'utf8'),
    ) as { overrides: { command?: string } };
    expect(afterB.overrides.command).toBe('C:\\custom\\od.exe');
    await sessionB.dispose();
  });
});
